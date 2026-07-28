#!/usr/bin/env node
// ───────────────────────────────────────────────────────────────────────────
// report-digest — render the shared bug reports in reports/*.md.
//
// Primary job: the post-merge / post-checkout hooks call this with a git range
// so a pull ANNOUNCES any report the other side filed, fixed, or verified. The
// terminal output is also what a Claude session sees when it runs the pull, so
// the report gets picked up with no one having to remember it exists.
//
//   node tools/bug-report/bin/report-digest.js --range ORIG_HEAD..HEAD
//   node tools/bug-report/bin/report-digest.js --inbox [name]   # open + awaiting-verify
//   node tools/bug-report/bin/report-digest.js --list [--status open]
//   node tools/bug-report/bin/report-digest.js --show <id>
//
// NEVER fails a git operation: any unexpected error exits 0 silently. A broken
// digest must not be able to break a pull.
// ───────────────────────────────────────────────────────────────────────────
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const REPO = path.resolve(__dirname, "..", "..", "..");
const REPORTS_DIR = path.join(REPO, "reports");

const STATUS = {
  open:     { mark: "!", label: "OPEN" },
  fixed:    { mark: "+", label: "FIXED" },
  verified: { mark: "v", label: "VERIFIED" },
  wontfix:  { mark: "-", label: "WONTFIX" },
};

function git(args) {
  return execFileSync("git", args, { cwd: REPO, encoding: "utf8", maxBuffer: 1 << 24 }).trim();
}

// Minimal front-matter reader: flat `key: value` pairs between --- fences.
// Deliberately not a YAML parser — the schema is flat by design so that this
// stays dependency-free and cannot choke on an author's stray punctuation.
function parseReport(file) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return null; }
  const m = raw.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---/);
  const meta = { id: path.basename(file, ".md") };
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
      if (!kv) continue;
      meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
    }
  }
  meta._file = file;
  meta.status = String(meta.status || "open").toLowerCase();
  meta.severity = String(meta.severity || "minor").toLowerCase();
  return meta;
}

function allReports() {
  if (!fs.existsSync(REPORTS_DIR)) return [];
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "archive") walk(p); continue; }
      if (!e.name.endsWith(".md") || e.name.toLowerCase() === "readme.md") continue;
      const r = parseReport(p);
      if (r) out.push(r);
    }
  };
  walk(REPORTS_DIR);
  return out.sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

const SEV_ORDER = { blocker: 0, major: 1, minor: 2, cosmetic: 3 };
const bySeverity = (a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9);

function renderLine(r) {
  const st = STATUS[r.status] || { mark: "?", label: r.status.toUpperCase() };
  const head = `   ${st.mark} ${st.label.padEnd(8)} [${r.severity}] ${r.id}`;
  const lines = [head, `       ${r.title || "(no title)"}`];
  const bits = [];
  if (r.status === "open" && r.assignee) bits.push(`assigned: ${r.assignee}`);
  if (r.status === "fixed") {
    bits.push(r.fixed_in ? `fixed in ${r.fixed_in}` : "fixed");
    if (r.reporter) bits.push(`awaiting verify by ${r.reporter}`);
  }
  if (bits.length) lines.push(`       ${bits.join("  ·  ")}`);
  return lines.join("\n");
}

// Which report files did this range touch? Uses name-status so a DELETED report
// (archived by the other side) doesn't get read off disk and crash.
function changedInRange(range) {
  let out = "";
  try { out = git(["diff", "--name-status", range, "--", "reports/"]); } catch { return []; }
  const ids = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split(/\t/);
    const statusCode = parts[0][0];
    const file = parts[parts.length - 1];
    if (statusCode === "D") continue;
    if (!file.endsWith(".md") || /readme\.md$/i.test(file)) continue;
    ids.push(path.join(REPO, file));
  }
  return ids.map(parseReport).filter(Boolean);
}

function printBlock(title, reports, hint) {
  if (!reports.length) return false;
  console.log("");
  console.log(`${title} (${reports.length})`);
  for (const r of reports.sort(bySeverity)) console.log(renderLine(r));
  if (hint) console.log(`   -> ${hint}`);
  console.log("");
  return true;
}

function main() {
  const argv = process.argv.slice(2);
  const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };

  if (argv.includes("--range")) {
    const range = arg("--range");
    if (!range) return 0;
    // Nothing to say when the range is empty or touched no reports: stay SILENT
    // so a normal pull is not noisier than it was before.
    const reports = changedInRange(range).filter((r) => r.status !== "verified" || argv.includes("--all-status"));
    printBlock("[bug-report] reports changed in this pull", reports,
      `node tools/bug-report/bin/report-digest.js --show <id>`);
    return 0;
  }

  if (argv.includes("--show")) {
    const id = arg("--show");
    const r = allReports().find((x) => x.id === id || x.id.endsWith(id));
    if (!r) { console.error(`no report matching "${id}"`); return 1; }
    console.log(fs.readFileSync(r._file, "utf8"));
    return 0;
  }

  if (argv.includes("--inbox")) {
    const who = arg("--inbox");
    const all = allReports();
    const mine = (r, field) => !who || !r[field] || String(r[field]).toLowerCase() === String(who).toLowerCase();
    const open = all.filter((r) => r.status === "open" && mine(r, "assignee"));
    const toVerify = all.filter((r) => r.status === "fixed" && mine(r, "reporter"));
    const any = printBlock("[bug-report] open, assigned to you", open, "fix it, then set status: fixed + fixed_in: <sha>")
      | printBlock("[bug-report] fixed — awaiting your verify", toVerify, "re-run the repro, then set status: verified");
    if (!any) console.log("[bug-report] inbox clear.");
    return 0;
  }

  // default: --list
  const status = arg("--status");
  let all = allReports();
  if (status) all = all.filter((r) => r.status === status.toLowerCase());
  if (!all.length) { console.log("[bug-report] no reports."); return 0; }
  console.log(`[bug-report] ${all.length} report(s)${status ? ` (status: ${status})` : ""}`);
  for (const r of all.sort(bySeverity)) console.log(renderLine(r));
  return 0;
}

try { process.exit(main()); }
catch (e) {
  // Hooks call this. A digest bug must never break someone's pull.
  if (process.env.BUG_REPORT_DEBUG) console.error(e);
  process.exit(0);
}
