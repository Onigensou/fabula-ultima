/**
 * Smoke tests. Run: node test/smoke.mjs
 *
 * The important one is `analytic mean matches simulation` — it proves the Monte
 * Carlo is not quietly drifting from the cost table you edited.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadModel } from "../lib/model.mjs";
import { simulate, buildTimeline, suggestCuts } from "../lib/estimate.mjs";
import { pertMean } from "../lib/random.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const model = loadModel(path.join(ROOT, "model", "tile-costs.json"));

let failures = 0;
function check(name, cond, detail = "") {
  const ok = !!cond;
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
}

const S = { start: "20:30", target: "00:00", hardStop: "01:00" };

// 1 — determinism
{
  const plan = { session: S, segments: [{ name: "a", scene: "s1", tiles: { random_battle: 6, blank: 4 } }] };
  const a = simulate(model, plan, { runs: 2000, seed: 7 });
  const b = simulate(model, plan, { runs: 2000, seed: 7 });
  const c = simulate(model, plan, { runs: 2000, seed: 8 });
  check("same seed reproduces the report", a.totals.p50 === b.totals.p50);
  check("different seed moves the report", a.totals.p50 !== c.totals.p50);
}

// 2 — analytic mean matches simulation
{
  const plan = {
    session: S,
    segments: [
      { name: "a", scene: "s1", tiles: { random_battle: 8, skill_check: 2, treasure: 3, blank: 6 } },
      { name: "b", scene: "s2", tiles: { story: 1 } },
    ],
  };
  const tl = buildTimeline(model, plan);
  const meanTempo = pertMean(model.tempo.pert);
  const expected = tl.expectedContent * meanTempo;
  const r = simulate(model, plan, { runs: 40000, seed: 11 });
  const err = Math.abs(r.content.mean - expected) / expected;
  check("analytic mean matches simulation", err < 0.01,
        `expected ${expected.toFixed(1)}m, simulated ${r.content.mean.toFixed(1)}m (${(err * 100).toFixed(2)}% err)`);
}

// 3 — random battle trigger rate matches the pity steady state
{
  const plan = { session: S, segments: [{ name: "a", scene: "s1", tiles: { random_battle: 100 } }] };
  const r = simulate(model, plan, { runs: 4000, seed: 3 });
  const rate = r.battles.mean / 100;
  check("battle trigger rate ≈ pity steady state", Math.abs(rate - model.classes.battle.p) < 0.02,
        `${(rate * 100).toFixed(1)}% vs ${(model.classes.battle.p * 100).toFixed(1)}%`);
}

// 4 — explicit sequence is honoured in order
{
  const plan = { session: S, segments: [{ name: "a", scene: "s1", sequence: ["blank", "story", "blank"] }] };
  const { events } = buildTimeline(model, plan);
  const kinds = events.filter(e => e.kind !== "overhead").map(e => e.glyph);
  check("sequence preserves order", JSON.stringify(kinds) === JSON.stringify(["chain", "story", "chain"]),
        JSON.stringify(kinds));
}

// 5 — counts push story-class to the end of the segment
{
  const plan = { session: S, segments: [{ name: "a", scene: "s1", tiles: { story: 1, blank: 3 } }] };
  const { events } = buildTimeline(model, plan);
  const kinds = events.filter(e => e.kind !== "overhead").map(e => e.glyph);
  check("story-class lands last in a counted segment", kinds[kinds.length - 1] === "story", JSON.stringify(kinds));
}

// 6 — single segment does not crash break placement
{
  const plan = { session: S, segments: [{ name: "solo", scene: "s1", tiles: { random_battle: 20 } }] };
  const r = simulate(model, plan, { runs: 500, seed: 5 });
  check("single segment survives break placement", r.totals.p50 > 0);
}

// 7 — breaks can be forced off
{
  const plan = { session: S, overheads: { breaks: "none" }, segments: [
    { name: "a", scene: "s1", tiles: { random_battle: 10 } },
    { name: "b", scene: "s2", tiles: { random_battle: 10 } },
  ] };
  const r = simulate(model, plan, { runs: 500, seed: 5 });
  check("breaks: none suppresses breaks", r.nBreaks === 0 && !r.events.some(e => e.key === "break"));
}

// 8 — long session earns two breaks
{
  const segs = Array.from({ length: 6 }, (_, i) => ({ name: `s${i}`, scene: `s${i}`, tiles: { random_battle: 8 } }));
  const r = simulate(model, { session: S, segments: segs }, { runs: 300, seed: 5 });
  check("long session earns 2 breaks", r.nBreaks === 2, `got ${r.nBreaks}`);
}

// 9 — unknown tile type warns instead of silently pricing at zero
{
  const plan = { session: S, segments: [{ name: "a", scene: "s1", tiles: { flarglebarg: 2 } }] };
  const r = simulate(model, plan, { runs: 100, seed: 5 });
  check("unknown tile type warns", r.warnings.some(w => w.includes("flarglebarg")), r.warnings[0] ?? "(none)");
}

// 10 — rare_monster is priced as story-class (it infers UNKNOWN in DP itself)
{
  const plan = { session: S, segments: [{ name: "a", scene: "s1", tiles: { rare_monster: 1 } }] };
  const r = simulate(model, plan, { runs: 2000, seed: 5 });
  const row = r.events.find(e => e.glyph === "story");
  check("rare_monster priced as a story-class beat", !!row && row.meanDur > 30, `${row?.meanDur?.toFixed(1)}m`);
  check("rare_monster raises no unknown-type warning", r.warnings.length === 0);
}

// 11 — a plan inside budget produces no cut advice
{
  const plan = { session: S, segments: [{ name: "a", scene: "s1", tiles: { random_battle: 4, blank: 4 } }] };
  const r = simulate(model, plan, { runs: 2000, seed: 5 });
  const cuts = suggestCuts(model, plan, r);
  check("under-budget plan suggests no cuts", cuts.options.length === 0 && r.totals.p80 <= r.targetOffset);
}

// 12 — cut advice never proposes removing more tiles than exist
{
  const plan = { session: S, segments: [
    { name: "a", scene: "s1", tiles: { random_battle: 12, skill_check: 4, blank: 10 } },
    { name: "b", scene: "s2", tiles: { final: 1, story: 1 } },
  ] };
  const r = simulate(model, plan, { runs: 3000, seed: 5 });
  const cuts = suggestCuts(model, plan, r);
  check("cut advice stays within what is planned", cuts.options.every(o => o.cut <= o.n),
        cuts.options.map(o => `${o.cut}/${o.n} ${o.type}`).join(", "));
}

console.log(failures ? `\n${failures} failure(s)\n` : "\nall checks passed\n");
process.exit(failures ? 1 : 0);
