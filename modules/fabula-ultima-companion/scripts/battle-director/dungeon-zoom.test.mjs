// ============================================================================
// Dungeon zoom — regression harness.
//
//     node scripts/battle-director/dungeon-zoom.test.mjs
//
// Bare Node, no Foundry: only the pure half of dungeon-zoom.js is exercised.
// Fixtures are real maps measured from the world on 2026-11-08 (median link
// step, scene size) on a 1080p window with the chat sidebar open (1620x1027).
// ============================================================================

import { DEFAULTS, medianStep, solveDungeonZoom, applyZoomRule } from "./dungeon-zoom.js";

let pass = 0, fail = 0;
const near = (label, got, want, tol = 0.01) => {
  const ok = Math.abs(got - want) <= tol;
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${ok ? "" : `\n        got  ${got}\n        want ${want}`}`);
};
const ok = (label, cond) => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "  ok  " : "FAIL  "}${label}`);
};

const VIS = { w: 1620, h: 1027 };
const MAPS = {
  Valley_Map009: { step: 177, map: { w: 1883, h: 2116 } },
  Hideout_Map003: { step: 89, map: { w: 2088, h: 1911 } },
  Wyrmwood_Map005: { step: 86, map: { w: 510, h: 719 } },
  Valley_Map013: { step: 315, map: { w: 2017, h: 2973 } },
  Wyrmwood_Map003: { step: 157, map: { w: 1075, h: 868 } },
};
// Mechanics are tested at 3 tiles, where tiles, the map cap and the ceiling all
// come into play; the shipped default (1.5) has its own section at the end.
const T3 = { normalTiles: 3 };
const solve = (name, extra = {}) => solveDungeonZoom({ ...MAPS[name], visible: VIS, ...extra, tuning: { ...T3, ...(extra.tuning ?? {}) } });
const shareSeen = (scale, map, vis = VIS) => Math.min(1, vis.w / scale / map.w) * Math.min(1, vis.h / scale / map.h);

console.log("\n── medianStep");
{
  const pts = { a: { x: 0, y: 0 }, b: { x: 100, y: 0 }, c: { x: 100, y: 300 }, d: { x: 400, y: 300 } };
  const at = (id) => pts[id] ?? null;
  near("odd count → middle link", medianStep({ 1: { a: "a", b: "b" }, 2: { a: "b", b: "c" }, 3: { a: "c", b: "d" } }, at).step, 300);
  near("even count → mean of the middle two", medianStep({ 1: { a: "a", b: "b" }, 2: { a: "b", b: "c" } }, at).step, 200);
  const skip = medianStep({ 1: { a: "a", b: "b" }, 2: { a: "a", b: "zz" } }, at);
  ok("a link to a missing tile is skipped", skip.links === 1 && skip.step === 100);
  ok("no links → fallback step", medianStep({}, at).step === DEFAULTS.fallbackStep && medianStep(null, at).links === 0);
  ok("zero-length link ignored", medianStep({ 1: { a: "a", b: "a" } }, at).links === 0);
}

console.log("\n── normal zoom: tiles vs map cap");
{
  const h = solve("Hideout_Map003");                        // big, dense map: tiles win
  near("Hideout_Map003: 3 tiles → 1027/2/(3*89)", h.normal, 1027 / 2 / (3 * 89));
  near("  …shows exactly 3 steps above and below", (VIS.h / 2) / h.normal / 89, 3);

  const v = solve("Valley_Map009");                         // map cap wins
  ok("Valley_Map009: cap wins over 3 tiles (0.97)", v.normal > 1027 / 2 / (3 * 177));
  near("  …and shows 35% of the map", shareSeen(v.normal, MAPS.Valley_Map009.map), 0.35, 0.005);

  const w = solve("Wyrmwood_Map005");                       // tiny map: would be 3.6x
  near("Wyrmwood_Map005: clamped to max zoom", w.normal, DEFAULTS.maxZoom, 1e-9);
  near("  …Scan cannot zoom in past the max either", w.scanIn, DEFAULTS.maxZoom, 1e-9);
}

console.log("\n── scan range");
for (const name of Object.keys(MAPS)) {
  const z = solve(name);
  ok(`${name}: scanOut ≤ normal ≤ scanIn ≤ max`, z.scanOut <= z.normal + 1e-9 && z.normal <= z.scanIn + 1e-9 && z.scanIn <= DEFAULTS.maxZoom + 1e-9);
  ok(`${name}: never more than 60% of the map in Scan`, shareSeen(z.scanOut, MAPS[name].map) <= DEFAULTS.scanCap + 0.005);
}
{
  const h = solve("Hideout_Map003");
  near("Hideout_Map003: Scan zooms out to 6 tiles", (VIS.h / 2) / h.scanOut / 89, 6);
  near("scan radius = 5 steps", h.scanRadius, 5 * 89);
}

console.log("\n── per-client: same tiles on any screen");
{
  const big = solveDungeonZoom({ ...MAPS.Hideout_Map003, visible: { w: 1920, h: 1200 }, tuning: T3 });
  const small = solveDungeonZoom({ ...MAPS.Hideout_Map003, visible: { w: 1066, h: 768 }, tuning: T3 });
  near("1920x1200 window: 3 steps", (1200 / 2) / big.normal / 89, 3);
  near("laptop window: 3 steps", (768 / 2) / small.normal / 89, 3);
  // A very tall window would need > max zoom for 3 steps: the ceiling wins and
  // it sees a little more, rather than going soft.
  const tall = solveDungeonZoom({ ...MAPS.Hideout_Map003, visible: { w: 2240, h: 1440 }, tuning: T3 });
  near("1440p window: held at max zoom", tall.normal, DEFAULTS.maxZoom, 1e-9);
}

console.log("\n── tuning + edge cases");
{
  const t = solve("Hideout_Map003", { tuning: { normalTiles: 2.5 } });
  near("normalTiles override", (VIS.h / 2) / t.normal / 89, 2.5);
  const m = solve("Hideout_Map003", { tuning: { maxZoom: 3 } });
  ok("maxZoom override raises the ceiling", solve("Wyrmwood_Map005", { tuning: { maxZoom: 3 } }).normal === 3 && m.normal < 3);
  const noMap = solveDungeonZoom({ step: 177, visible: VIS, map: {}, tuning: T3 });
  near("no map size → tiles only, no cap", noMap.normal, 1027 / 2 / (3 * 177));
  const badStep = solveDungeonZoom({ step: NaN, visible: VIS, map: {} });
  near("bad step → fallback step", badStep.step, DEFAULTS.fallbackStep, 1e-9);
}

console.log("\n── applyZoomRule");
{
  const L = { normal: 1.5, scanOut: 1.0, scanIn: 1.8 };
  ok("outside Scan: the wheel's 3.0 becomes normal", applyZoomRule(3.0, L, false) === 1.5);
  ok("outside Scan: the wheel's 0.4 becomes normal", applyZoomRule(0.4, L, false) === 1.5);
  ok("Scan: in range is kept", applyZoomRule(1.2, L, true) === 1.2);
  ok("Scan: too far out → scanOut", applyZoomRule(0.4, L, true) === 1.0);
  ok("Scan: too close → scanIn", applyZoomRule(3.0, L, true) === 1.8);
  ok("Scan: garbage → normal", applyZoomRule(undefined, L, true) === 1.5);
}

console.log("\n── shipped defaults (user-tuned 2026-11-08)");
{
  ok("normal = 1.5 tiles, rest as proposed", DEFAULTS.normalTiles === 1.5 && DEFAULTS.scanTiles === 6
    && DEFAULTS.normalCap === 0.35 && DEFAULTS.scanCap === 0.6 && DEFAULTS.scanPanTiles === 5 && DEFAULTS.maxZoom === 2.5);
  const d = (name) => solveDungeonZoom({ ...MAPS[name], visible: VIS });
  near("Hideout_Map003 (step 89): at the 2.5x ceiling", d("Hideout_Map003").normal, 2.5, 1e-9);
  near("Valley_Map013 (step 315): 1.5 steps", (VIS.h / 2) / d("Valley_Map013").normal / 315, 1.5);
  for (const name of Object.keys(MAPS)) {
    const z = d(name);
    if (name === "Wyrmwood_Map005") {
      // 510x719: the 60% map cap is already past the 2.5x ceiling — no Scan room.
      ok(`${name}: tiny map, Scan held at normal`, z.scanOut === z.normal);
    } else {
      ok(`${name}: Scan still zooms out further than normal`, z.scanOut < z.normal);
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
