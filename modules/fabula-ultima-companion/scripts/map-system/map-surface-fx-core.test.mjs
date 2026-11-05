// ============================================================================
// Map surface FX: config reader harness.
//
//     node scripts/map-system/map-surface-fx-core.test.mjs
//
// Bare Node, no Foundry. The load-bearing cases are the OFF ones: every scene
// without the switch, and any scene with Walk Parallax, must draw nothing.
// ============================================================================

import { readSurfaceConfig, ambientSwitchedOff, backdropKey, maskPathFor } from "./map-surface-fx-core.js";

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  fail++;
  console.error(`FAIL  ${label}\n        got  ${g}\n        want ${w}`);
};

const BG = "https://assets.forge-vtt.com/x/Game%20Map/Valley_Map032.png?v=2";
const scene = (general, surfaceFx, src = BG) => ({
  background: { src },
  flags: { "fabula-ultima-companion": { oniFabula: { general }, ...(surfaceFx === undefined ? {} : { surfaceFx }) } },
});
const GAS = { mode: "gas", crystals: [[350, 560, 70]], shimmerTile: "abc" };

// keys
eq("key strips path, query, extension", backdropKey(BG), "Valley_Map032");
eq("mask path", maskPathFor(BG), "modules/fabula-ultima-companion/assets/surface-fx/Valley_Map032.webp");
eq("no src -> no mask", maskPathFor(""), null);

// off cases
eq("legacy scene, no flags", readSurfaceConfig({ background: { src: BG }, flags: {} }), null);
eq("switch missing", readSurfaceConfig(scene({ sceneMode: "exploration" }, GAS)), null);
eq("switch false", readSurfaceConfig(scene({ surfaceFxEnabled: false }, GAS)), null);
eq("switch on, no surfaceFx", readSurfaceConfig(scene({ surfaceFxEnabled: true })), null);
eq("bad mode", readSurfaceConfig(scene({ surfaceFxEnabled: true }, { mode: "lava" })), null);
eq("parallax wins", readSurfaceConfig(scene({ surfaceFxEnabled: true, parallaxEnabled: true }, GAS)), null);
eq("dungeon mode scene", readSurfaceConfig(scene({ surfaceFxEnabled: true, sceneMode: "dungeon" }, GAS)), null);

// on: gas
const g = readSurfaceConfig(scene({ surfaceFxEnabled: true, sceneMode: "exploration" }, GAS));
eq("gas mode", g?.mode, "gas");
eq("gas layers default on", g?.layers, { churn: true, plume: true, rim: true, crystal: true, wisp: true });
eq("gas wisp default", g?.wisp, 0.16);
eq("crystals kept", g?.crystals, [[350, 560, 70]]);
eq("shimmer tile", g?.shimmerTile, "abc");
eq("shimmer defaults", g?.shimmer, { cx: 1024, cy: 820, squash: 1.9 });

// layer off, wisp off -> strength 0
const g2 = readSurfaceConfig(scene({ surfaceFxEnabled: true }, { ...GAS, layers: { plume: false, wisp: false } }));
eq("one layer off", g2?.layers.plume, false);
eq("wisp off -> 0", g2?.wisp, 0);

// water
const w = readSurfaceConfig(scene({ surfaceFxEnabled: true }, {
  mode: "water", darkness: 0.32, lights: [[42, 432, 150, 0.78, 0.58, 1, 1], [1, 2, 3]],
  crystals: Array.from({ length: 14 }, (_, i) => [i, i, 40]),
}, "x/Valley_Map019.png"));
eq("water layers", Object.keys(w?.layers ?? {}), ["water", "light", "crystal", "wisp"]);
eq("short light row dropped", w?.lights.length, 1);
eq("crystals capped at 10", w?.crystals.length, 10);
eq("darkness", w?.darkness, 0.32);
eq("water wisp default", w?.wisp, 0.12);
eq("water mask", w?.mask, "modules/fabula-ultima-companion/assets/surface-fx/Valley_Map019.webp");

// map-ambience switch: only scenes set up for surface FX obey it
eq("ambience: plain scene, unset", ambientSwitchedOff(scene({}, undefined)), false);
eq("ambience: Maelstrom saved with box unticked", ambientSwitchedOff(scene({ surfaceFxEnabled: false }, undefined)), false);
eq("ambience: surface scene, off", ambientSwitchedOff(scene({ surfaceFxEnabled: false }, GAS)), true);
eq("ambience: surface scene, unset", ambientSwitchedOff(scene({}, GAS)), true);
eq("ambience: surface scene, on", ambientSwitchedOff(scene({ surfaceFxEnabled: true }, GAS)), false);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
