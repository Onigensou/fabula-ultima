// compare-battle — diff two checks/sim-battle.js results (e.g. the Staging World's vs the runner's).
//   node tools/snapshot-runner/bin/compare-battle.mjs <reference.json> <run.json>
// Each event stream is compared on its own (actions, resource writes, AE adds, AE removes):
// two engines can interleave hook callbacks differently without playing a different battle,
// so the merged order alone is not a verdict. Exit 1 when any stream differs.
import { readFileSync } from "node:fs";
const [refFile, runFile] = process.argv.slice(2);
if (!refFile || !runFile) { console.error("usage: compare-battle <reference.json> <run.json>"); process.exit(2); }
const L = (f) => JSON.parse(readFileSync(f, "utf8"));
const a = L(refFile), b = L(runFile);
const fmt = {
  act: (e) => `${e.by}: ${e.name} -> ${e.to.join("+")}${e.el ? ` [${e.el}]` : ""}`,
  res: (e) => `${e.who} ${e.key}=${e.v}`,
  "ae+": (e) => `${e.who} +${e.name}`,
  "ae-": (e) => `${e.who} -${e.name}`,
};
let bad = 0;
const head = (r) => JSON.stringify({ outcome: r.outcome, rounds: r.rounds, partyHpRemaining: r.partyHpRemaining, err: r.err ?? r.evalError ?? null, ms: r.ms });
console.log(`reference ${head(a)}\nthis run  ${head(b)}`);
if (a.outcome !== b.outcome || a.rounds !== b.rounds) bad++;
// Two runs that both died before the fight are "identical" streams of nothing. Not a verdict.
for (const [label, r] of [["reference", a], ["this run", b]]) {
  if (r.err || r.evalError || r.error || !(r.events ?? []).some((e) => e.k === "act")) { bad++; console.log(`✗ ${label} did not play a battle: ${String(r.err ?? r.evalError ?? r.error ?? "no actions recorded").split("\n")[0]}`); }
}
for (const [k, f] of Object.entries(fmt)) {
  const A = (a.events ?? []).filter((e) => e.k === k).map(f), B = (b.events ?? []).filter((e) => e.k === k).map(f);
  let i = 0; while (i < A.length && A[i] === B[i]) i++;
  const same = i === A.length && A.length === B.length;
  // Same events in another order. The end-of-battle sweep deletes every AE at once (concurrent
  // deletes, ~700 ms), so the order of its hooks is not the engine's choice. Reported, not failed.
  const bag = (x) => JSON.stringify([...x].sort());
  const reordered = !same && bag(A) === bag(B);
  if (!same && !reordered) bad++;
  console.log(`${same ? "=" : reordered ? "≈" : "≠"} ${k.padEnd(4)} ${A.length} vs ${B.length}${same ? "" : reordered ? `, same events, order differs from #${i}` : `, first difference at #${i}`}`);
  if (!same && !reordered) for (let j = i; j < Math.min(i + 4, Math.max(A.length, B.length)); j++) console.log(`     ${(A[j] ?? "-").padEnd(52)} | ${B[j] ?? "-"}`);
}
console.log(bad ? `✗ the battles differ (${bad} problem(s))` : "✓ same battle: every stream identical or (≈) the same events reordered");
process.exitCode = bad ? 1 : 0;
