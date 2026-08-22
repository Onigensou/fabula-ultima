// Union the per-row verdicts across every results file for an actor.
// A row PROVEN in any run stays proven; UNMEASURED never overrides a real
// result (a lost bridge chunk is an absence of evidence, not evidence).
import { readdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { liveRows } from "./roster.mjs";
import { RIG_BOUNDARY_REASONS } from "./probe-lib.js";
const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = resolve(HERE, "results");
const who = process.argv[2];
// STEP_FAILED ranks ABOVE the passes: a chain that failed is a real, reproducible
// finding and must not be outranked by an older run that scored the same row green.
const RANK = { STEP_FAILED: 7, GATE_PROVEN: 6, AVAILABLE_UNGATED: 5, REFUSED: 4, NOT_SCANNED: 3, INVERTED: 3, INCONCLUSIVE: 2, ERROR: 1, UNMEASURED: 0, TIMEOUT: 0 };
// A STEP_FAILED recorded before the engine propagated the CHILD step's reason
// could not tell a rig boundary from a real chain failure — every one printed a
// bare `step-failed:<label>`. Those verdicts were wrong in BOTH directions and,
// because STEP_FAILED deliberately outranks a pass, an old one would keep
// outranking the corrected run forever. Measured 2026-08-23: both
// `Birth of the Cruel` rows were carried as the top open finding for two
// sessions and are actually `no-combat` / `no-candidates` — rig boundaries.
//
// Same principle as conformance.mjs's EVIDENCE_CUTOFF: when the CLASSIFIER
// changes, verdicts it could not have produced correctly must not win a merge.
// Scoped to STEP_FAILED only — every other verdict still merges by rank.
// The instant step-reason propagation went LIVE IN THE PAGE — not when the source
// was edited. A static-import edit does nothing until the client is relaunched
// (the module map only rebuilds on a real navigation), so runs between the edit
// and the relaunch still recorded bare `step-failed:<label>`. First run carrying
// a reason: Zarg-2026-08-22T22-11-17Z (`step-failed:barrage_add:no-sink`).
const CLASSIFIER_CUTOFF = "2026-08-22T22:05:00Z";
const runStamp = (f) => {
  const m = f.match(/-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.json$/);
  return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z` : "";
};

const best = new Map();
const superseded = [];
const files = readdirSync(DIR).filter((f) => f.startsWith(who + "-")).sort();
for (const f of files) {
  const j = JSON.parse(readFileSync(resolve(DIR, f), "utf8"));
  for (const r of j.report) {
    const k = `${r.name}#${r.row}`;
    if (r.verdict === "STEP_FAILED") {
      // Decide FROM THE RECORD where possible: a reason-suffixed fireReason says
      // outright whether the rig or the content failed. Only a BARE
      // `step-failed:<label>` (pre-propagation, undecidable) falls back to the date.
      const fr = String(r.pos?.fireReason ?? "");
      const parts = fr.split(":");
      const reason = parts.length >= 3 ? parts.slice(2).join(":").trim() : "";
      const rigBoundary = reason && RIG_BOUNDARY_REASONS.has(reason);
      if (rigBoundary || (!reason && runStamp(f) < CLASSIFIER_CUTOFF)) {
        superseded.push(`${k} [${reason || "no reason recorded"}] (${f})`);
        continue;
      }
    }
    const prev = best.get(k);
    if (!prev || (RANK[r.verdict] ?? 0) > (RANK[prev.verdict] ?? 0)) best.set(k, { ...r, from: f });
  }
}
// Drop rows the world no longer has. Rank-merge is grow-only: a deleted row
// keeps its last verdict forever because no later run enumerates it to
// contradict. Gate on the live roster so the denominator tracks reality.
const live = liveRows();
const all = [...best.values()];
const phantom = live.size ? all.filter((r) => !live.has(`${who}|${r.name}#${r.row}`)) : [];
const rows = live.size ? all.filter((r) => live.has(`${who}|${r.name}#${r.row}`)) : all;
const tally = {};
for (const r of rows) tally[r.verdict] = (tally[r.verdict] ?? 0) + 1;
console.log(`${who}: ${files.length} run(s), ${rows.length} live row(s)`);
if (superseded.length) {
  console.log(`  ${superseded.length} STEP_FAILED verdict(s) ignored — a rig boundary, or recorded before step reasons existed (undecidable):`);
  for (const x of superseded) console.log(`    - ${x}`);
}
if (phantom.length) {
  console.log(`  ${phantom.length} phantom row(s) dropped — deleted from the world, verdict carried by stale files:`);
  for (const r of phantom) console.log(`    - ${r.name} #${r.row} [${r.verdict}] (last seen in ${r.from})`);
}
console.log(JSON.stringify(tally));
for (const r of rows.sort((a, b) => (RANK[b.verdict] - RANK[a.verdict]) || a.name.localeCompare(b.name))) {
  const w = r.pos?.writes?.length ? `  writes: ${r.pos.writes.join(" ; ").slice(0, 70)}` : "";
  const fr = r.pos?.fireReason ? `  [${r.pos.fireReason}]` : "";
  console.log(`  [${r.verdict}] ${r.name} #${r.row} (${r.trigger})${fr}${w}`);
  if (!["GATE_PROVEN", "AVAILABLE_UNGATED"].includes(r.verdict)) console.log(`        ${r.note}`);
}
