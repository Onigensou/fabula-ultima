// Conformance pass: does the OBSERVED effect match the AUTHORED description?
//
// The gate-flip sweep proves a reaction is REACHABLE. It does NOT prove the skill
// does what its text says — 37 of 88 "verified" rows had no observed effect at
// all. This is the other question, and it is where the real content bugs live:
// the Drain Spirit errata (text said HR+20, config still said 15) was exactly
// this shape, and so were Poison and Sneaker.
//
// Runs OFFLINE. The writes are already recorded in tools/party-verify/results/
// and the descriptions live in worlds/<world>/_authored-export/. No game needed.
//
// Deliberately three-way, and deliberately NOT an oracle. Prose is prose, so it
// claims MATCH only when a name in the text is positively confirmed by a write,
// MISMATCH only when something is provably wrong (e.g. no description at all),
// and REVIEW when a human has to read it. Anything else would be the same
// overclaiming this pass exists to correct.
import { readdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const RESULTS = resolve(HERE, "results");
const EXPORT = resolve(ROOT, "worlds/fabula-ultima-2/_authored-export/actors");
const ADJUDICATIONS = resolve(HERE, "adjudications.json");

// Human adjudications, keyed `<Who>|<Skill>#<row>`. The classifier below stays
// strict on purpose — it must never infer a pass from prose. This layer is the
// separate, honest thing: a decision a person actually made, with the evidence
// that settled it, so a settled row is not re-derived every session. It
// annotates the tally; it does not move it.
let ADJ = {};
try { ADJ = JSON.parse(readFileSync(ADJUDICATIONS, "utf8")); } catch { /* optional */ }
const ACTORS = {
  Hina: "dafTLBUscCDNgq8H", Keren: "gdJZ1L1kv5mjTTMr",
  Blanche: "uJFaNQCSvwwsr2AW", Zarg: "Z4CFy505cD3nzl1W",
};

const strip = (h) => String(h ?? "")
  .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

// Word-ish containment without building a regex from user data.
function mentions(text, needle) {
  const t = String(text ?? "").toLowerCase();
  const n = String(needle ?? "").toLowerCase().trim();
  if (!t || !n) return false;
  let from = 0;
  for (;;) {
    const i = t.indexOf(n, from);
    if (i < 0) return false;
    const before = i === 0 ? " " : t[i - 1];
    const after = i + n.length >= t.length ? " " : t[i + n.length];
    const word = (c) => /[a-z0-9_]/.test(c);
    if (!word(before) && !word(after)) return true;
    from = i + 1;
  }
}

const RANK = {
  STEP_FAILED: 7, GATE_PROVEN: 6, AVAILABLE_UNGATED: 5, REFUSED: 4,
  NOT_SCANNED: 3, INVERTED: 3, INCONCLUSIVE: 2, ERROR: 1, UNMEASURED: 0, TIMEOUT: 0,
};

// ── Evidence provenance ──────────────────────────────────────────────────────
// The VERDICT is legitimately cumulative: a gate proven on 08-19 is still proven,
// so rank-merging it across every run is correct. The WRITE EVIDENCE is not.
//
// Before `fe6e3f7f`, `firePreAcceptedCandidate` resolved while its chain still
// had async work queued; those writes landed after restore() and were captured
// by the NEXT candidate. A run from before that fix can attribute a write to a
// skill that never made it — and an observed write is precisely what makes a
// conformance verdict look conclusive, so inheriting one silently is the worst
// available failure. Rank-merge has no notion of age, so it did exactly that:
// `Windpiercer #0` was still being judged on the pre-fix capture that carried a
// stray `+AE[Lucky Seven Ready]` belonging to a different skill entirely.
//
// So: verdict rank-merges over everything; evidence comes from the NEWEST run
// that measured the row, and is refused outright if that run predates the fix.
const EVIDENCE_CUTOFF = "2026-08-21T17:00:00Z"; // fe6e3f7f — attribution settle

// Filenames are `<Who>-<ISO with : and . as ->.json`.
function runStamp(file) {
  const m = file.match(/-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.json$/);
  return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z` : "";
}

// The prober seeds its own `PV Charge <key>` AEs via preApply to satisfy charge
// gates (verify.mjs). They are the RIG's writes, never the skill's — judging a
// skill against them is judging the harness. Strip the TOKEN rather than the
// whole record: one capture can carry a real AE and a rig AE in the same string,
// and discarding it wholesale would throw away the real one too.
// `battle_log` / `battle_log_table` are SESSION RECORDINGS — written by play and
// by every sim run, never authored. world-export already strips them as
// VOLATILE_PROPS for exactly this reason: left in, one probe's log entry swamps
// the row's real evidence. Drop the whole record when that is all it carries.
const stripRig = (w) => String(w)
  .replace(/[+-]AE\[PV Charge [^\]]*\]/g, "")
  .replace(/[A-Za-z0-9 '"()-]*\{"system\.props\.battle_log(_table)?":.*$/, "");
const isEmptyWrite = (w) => !/[+-]AE\[|"system\.props\./.test(w);
const realWrites = (ws) => (ws ?? []).map(stripRig).filter((w) => !isEmptyWrite(w));

const best = new Map();     // verdict — cumulative, every run
const evid = new Map();     // writes  — newest post-cutoff run only
for (const f of readdirSync(RESULTS)) {
  if (!f.endsWith(".json")) continue;
  const stamp = runStamp(f);
  const j = JSON.parse(readFileSync(resolve(RESULTS, f), "utf8"));
  for (const r of j.report ?? []) {
    const k = `${j.who}|${r.name}#${r.row}`;
    const prev = best.get(k);
    if (!prev || (RANK[r.verdict] ?? 0) > (RANK[prev.verdict] ?? 0)) best.set(k, { ...r, who: j.who });
    if (stamp < EVIDENCE_CUTOFF) continue;
    const pe = evid.get(k);
    if (!pe || stamp > pe.stamp) evid.set(k, { stamp, file: f, writes: r.pos?.writes ?? [], verdict: r.verdict });
  }
}

const desc = new Map();
for (const [who, id] of Object.entries(ACTORS)) {
  const a = JSON.parse(readFileSync(resolve(EXPORT, `${id}.json`), "utf8"));
  for (const it of a.items ?? []) desc.set(`${who}|${it.name}`, strip(it.system?.props?.description));
}

// "Actor{"system.props.x":N}+AE[Foo]-AE[Bar]"
function parseWrite(w) {
  const s = String(w);
  const aeAdd = [...s.matchAll(/\+AE\[([^\]]+)\]/g)].map((m) => m[1]);
  const aeDel = [...s.matchAll(/-AE\[([^\]]+)\]/g)].map((m) => m[1]);
  const props = {};
  const pm = s.match(/\{(.*)\}/);
  if (pm && pm[1].trim()) {
    for (const mm of pm[1].matchAll(/"system\.props\.([a-z_0-9]+)"\s*:\s*"?(-?\d+)"?/gi)) {
      props[mm[1]] = Number(mm[2]);
    }
  }
  return { aeAdd, aeDel, props };
}

// A row is judgeable only if a POST-CUTOFF run actually observed writes for it.
// Rows whose only writes come from a pre-cutoff run are reported separately as
// STALE — not judged, because their evidence is known-unreliable, and not
// dropped, because silently shrinking the denominator is its own overclaim.
// A verdict that means "never actually probed" is not a measurement, so it can
// neither confirm nor refute the older evidence — keep the two apart.
const UNMEASURED_VERDICTS = new Set(["NOT_SCANNED", "TIMEOUT", "UNMEASURED", "ERROR"]);

const stale = [];
const rows = [];
for (const [k, r] of best) {
  const e = evid.get(k);
  const writes = realWrites(e?.writes);
  if (writes.length) { rows.push({ ...r, writes, stamp: e.stamp, file: e.file }); continue; }
  const oldWrites = realWrites(r.pos?.writes);
  if (!oldWrites.length) continue;                       // nothing was ever observed — not a conformance row
  const reason = !e ? "no post-fix run measured this row at all"
    : UNMEASURED_VERDICTS.has(e.verdict)
      ? `the post-fix run only reached ${e.verdict} — the row was never re-probed, so the old writes are neither confirmed nor refuted`
      : `the post-fix run (${e.verdict}) observed NO writes — the pre-fix writes were misattributed to this row`;
  stale.push({ ...r, writes: oldWrites, reason });
}

const out = [];
for (const r of rows) {
  const text = desc.get(`${r.who}|${r.name}`) ?? "";
  const parsed = r.writes.map(parseWrite);
  const addedAEs = [...new Set(parsed.flatMap((x) => x.aeAdd))];
  const removedAEs = [...new Set(parsed.flatMap((x) => x.aeDel))];
  const propEntries = parsed.flatMap((x) => Object.entries(x.props));
  const findings = [];

  if (!text) {
    findings.push({ verdict: "MISMATCH", detail: "(no description)", why: "the skill has NO description to conform to" });
  }
  for (const ae of addedAEs) {
    const named = mentions(text, ae);
    findings.push({
      verdict: named ? "MATCH" : "REVIEW", detail: `+AE[${ae}]`,
      why: named ? "named in the description"
                 : "applied but NOT named in the description — flavour text, or the wrong AE",
    });
  }
  for (const ae of removedAEs) {
    findings.push({ verdict: "REVIEW", detail: `-AE[${ae}]`, why: "removal — confirm the text calls for it" });
  }
  if (propEntries.length) {
    const nums = [...new Set((text.match(/\d+/g) ?? []).map(Number))];
    for (const [k, v] of propEntries) {
      const stated = nums.includes(Math.abs(v));
      findings.push({
        verdict: "REVIEW", detail: `${k} = ${v}`,
        why: stated ? `the text states ${v} — likely direct` :
             nums.length ? `text numbers are ${nums.slice(0, 8).join("/")} — value is derived, check the formula by hand`
                         : "text states no number",
      });
    }
  }
  out.push({ who: r.who, name: r.name, row: r.row, verdict: r.verdict, writes: r.writes, text, findings, stamp: r.stamp, adj: ADJ[`${r.who}|${r.name}#${r.row}`] ?? null });
}

const rowVerdict = (r) => r.findings.some((f) => f.verdict === "MISMATCH") ? "MISMATCH"
  : r.findings.length && r.findings.every((f) => f.verdict === "MATCH") ? "MATCH" : "REVIEW";

const tally = {};
for (const r of out) tally[rowVerdict(r)] = (tally[rowVerdict(r)] ?? 0) + 1;
console.log(`rows with an observed write: ${out.length}`);
console.log(JSON.stringify(tally));
for (const r of out.sort((a, b) => rowVerdict(a).localeCompare(rowVerdict(b)) || a.who.localeCompare(b.who) || a.name.localeCompare(b.name))) {
  console.log(`\n[${rowVerdict(r)}] ${r.who} / ${r.name} #${r.row}`);
  console.log(`   text : ${r.text ? r.text.slice(0, 200) : "(NONE)"}`);
  console.log(`   wrote: ${r.writes.join(" ; ").slice(0, 150)}`);
  for (const f of r.findings) console.log(`     ${f.verdict.padEnd(8)} ${f.detail} — ${f.why}`);
  if (r.adj) console.log(`   ADJUDICATED ${r.adj.verdict}${r.adj.fixed ? " (since FIXED)" : ""}: ${r.adj.why}`);
  if (r.adj?.fixed) console.log(`   FIXED: ${r.adj.fixed}`);
}

const openReview = out.filter((r) => rowVerdict(r) === "REVIEW" && !r.adj);
// A DEFECT whose adjudication carries a `fixed` note is HISTORY, not an open
// item — the scorecard read "DEFECT:1" for two weeks after Windpiercer's
// description was repaired, which is the one number a reader acts on.
const openDefects = out.filter((r) => r.adj?.verdict === "DEFECT" && !r.adj.fixed);
const adjTally = {};
for (const r of out) {
  if (!r.adj) continue;
  const k = r.adj.verdict === "DEFECT" && r.adj.fixed ? "DEFECT (fixed)" : r.adj.verdict;
  adjTally[k] = (adjTally[k] ?? 0) + 1;
}
console.log(`
=== adjudication ===`);
console.log(`  human-settled : ${JSON.stringify(adjTally)}`);
console.log(`  DEFECT still OPEN: ${openDefects.length}`);
for (const r of openDefects) console.log(`    - ${r.who} / ${r.name} #${r.row}`);
console.log(`  REVIEW still needing a human: ${openReview.length}`);
for (const r of openReview) console.log(`    - ${r.who} / ${r.name} #${r.row}`);

if (stale.length) {
  console.log(`
=== ${stale.length} row(s) NOT JUDGED — evidence is not trustworthy ===`);
  for (const r of stale) {
    console.log(`
[STALE] ${r.who} / ${r.name} #${r.row}  (${r.verdict})`);
    console.log(`   why  : ${r.reason}`);
    console.log(`   wrote: ${r.writes.join(" ; ").slice(0, 150)}`);
  }
}
