"use strict";

/**
 * preflight/report — render suite results to the console, and (optionally) to a
 * self-contained HTML dashboard you can glance at before a session.
 */

const fs = require("node:fs");
const path = require("node:path");
const { SEVERITY_RANK } = require("./util");

const MARK = { FAIL: "✗", WARN: "!", INFO: "·" };

// results: [{ id, title, findings: [] }]
function tally(results) {
  const t = { FAIL: 0, WARN: 0, INFO: 0 };
  for (const r of results) for (const f of r.findings) t[f.severity]++;
  return t;
}

function renderConsole(results, world) {
  const t = tally(results);
  const lines = [];
  lines.push("");
  lines.push(`=== preflight checkup (${world.world}) ===`);
  lines.push(`scenes:${world.scenes.length}  actors:${world.actors.length}  items:${world.items.length}`);
  lines.push("");

  for (const r of results) {
    const sorted = [...r.findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
    const fails = r.findings.filter((f) => f.severity === "FAIL").length;
    const warns = r.findings.filter((f) => f.severity === "WARN").length;
    const status = fails ? "FAIL" : warns ? "WARN" : "ok";
    lines.push(`── [${status}] ${r.title}  (${r.findings.length ? `${fails} fail, ${warns} warn` : "clean"})`);
    for (const f of sorted) {
      lines.push(`     ${MARK[f.severity]} ${f.message}`);
    }
    lines.push("");
  }

  lines.push(`summary: ${t.FAIL} FAIL · ${t.WARN} WARN · ${t.INFO} INFO`);
  lines.push(t.FAIL
    ? "  ⚠ FAILures present — do NOT start the session until these are resolved."
    : t.WARN
      ? "  Review the warnings above; none are hard blockers."
      : "  ✓ All checks clean — good to run.");
  return lines.join("\n");
}

function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

function renderHtml(results, world) {
  const t = tally(results);
  const rows = results.map((r) => {
    const fails = r.findings.filter((f) => f.severity === "FAIL").length;
    const warns = r.findings.filter((f) => f.severity === "WARN").length;
    const cls = fails ? "fail" : warns ? "warn" : "ok";
    const items = [...r.findings]
      .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
      .map((f) => `<li class="sev-${f.severity}"><span class="tag">${f.severity}</span>${esc(f.message)}</li>`)
      .join("");
    return `<section class="suite ${cls}">
      <h2>${esc(r.title)} <small>${fails} fail · ${warns} warn</small></h2>
      <ul>${items || '<li class="sev-INFO clean">clean</li>'}</ul>
    </section>`;
  }).join("");

  const banner = t.FAIL ? "fail" : t.WARN ? "warn" : "ok";
  const bannerText = t.FAIL ? "NOT READY — failures present"
    : t.WARN ? "Review warnings" : "Ready to run";

  return `<!doctype html><meta charset="utf-8"><title>preflight — ${esc(world.world)}</title>
<style>
:root{color-scheme:light dark;--ok:#1a7f37;--warn:#9a6700;--fail:#cf222e;--bg:#fff;--fg:#1f2328;--card:#f6f8fa;--line:#d0d7de}
@media(prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--card:#161b22;--line:#30363d}}
body{font:15px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--fg);margin:0;padding:2rem;max-width:900px;margin-inline:auto}
.banner{padding:1rem 1.25rem;border-radius:10px;font-weight:700;font-size:1.1rem;margin-bottom:.5rem;color:#fff}
.banner.ok{background:var(--ok)}.banner.warn{background:var(--warn)}.banner.fail{background:var(--fail)}
.meta{color:#7d8590;margin-bottom:1.5rem}
.suite{background:var(--card);border:1px solid var(--line);border-left-width:5px;border-radius:8px;padding:.5rem 1rem;margin-bottom:1rem}
.suite.ok{border-left-color:var(--ok)}.suite.warn{border-left-color:var(--warn)}.suite.fail{border-left-color:var(--fail)}
h2{font-size:1rem;margin:.5rem 0}h2 small{font-weight:400;color:#7d8590}
ul{margin:.25rem 0 .75rem;padding-left:0;list-style:none}
li{padding:.35rem .5rem;border-radius:5px}
.tag{display:inline-block;min-width:3.2em;font-size:.7rem;font-weight:700;padding:.1em .4em;border-radius:4px;margin-right:.6em;text-align:center;color:#fff}
.sev-FAIL .tag{background:var(--fail)}.sev-WARN .tag{background:var(--warn)}.sev-INFO .tag{background:#57606a}
.sev-FAIL{background:color-mix(in srgb,var(--fail) 10%,transparent)}
.clean{color:#7d8590}
</style>
<div class="banner ${banner}">${bannerText}</div>
<div class="meta">world <b>${esc(world.world)}</b> · ${world.scenes.length} scenes · ${world.actors.length} actors · generated ${new Date().toLocaleString()}<br>
${t.FAIL} FAIL · ${t.WARN} WARN · ${t.INFO} INFO</div>
${rows}`;
}

function writeHtml(results, world, outPath) {
  const dest = outPath || path.join(__dirname, "..", "preflight-report.html");
  fs.writeFileSync(dest, renderHtml(results, world));
  return dest;
}

module.exports = { renderConsole, writeHtml, tally };
