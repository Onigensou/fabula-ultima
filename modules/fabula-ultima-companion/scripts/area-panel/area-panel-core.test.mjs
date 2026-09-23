// ============================================================================
// Area Name Panel — gate harness.
//
//     node scripts/area-panel/area-panel-core.test.mjs
//
// Bare Node, no Foundry. Covers the pure half only: which scenes get a panel,
// what it says, and how repeat suppression behaves across a run of
// activations. The plaque itself is DOM + WAAPI and belongs in a live review.
//
// The load-bearing cases are the DEFAULTS: a legacy scene with no flags at all
// must stay silent, and a scene with only a name typed in must light up. Those
// two decide whether 90-odd existing scenes suddenly start announcing
// themselves at the table.
// ============================================================================

import {
  MODULE_ID, GLYPH, TUNING,
  readAreaConfig, shouldShowForScene, formatLabel,
} from "./area-panel-core.js";

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  fail++;
  console.error(`FAIL  ${label}\n        got  ${g}\n        want ${w}`);
};
const ok = (label, cond) => eq(label, !!cond, true);

/** Build a scene-shaped fixture carrying the general flag block. */
const scene = (general = {}, id = "scene1") => ({
  id,
  name: `Scene ${id}`,
  flags: { [MODULE_ID]: { oniFabula: { general } } },
});

const verdict = (general, lastAreaName = null) =>
  shouldShowForScene(scene(general), { lastAreaName });

// ── gate: the defaults ────────────────────────────────────────────────────

eq("no scene at all", shouldShowForScene(null).reason, "no-scene");
eq("legacy scene, no module flags", shouldShowForScene({ id: "x", flags: {} }).show, false);
eq("legacy scene reason", shouldShowForScene({ id: "x", flags: {} }).reason, "no-name");
eq("name only, checkbox never touched => ON", verdict({ areaName: "Ravenwood Hollow" }).show, true);
eq("blank name", verdict({ areaName: "" }).show, false);
eq("whitespace-only name", verdict({ areaName: "   " }).reason, "no-name");
eq("non-string name is ignored", verdict({ areaName: 42 }).reason, "no-name");

// ── gate: the explicit switches ───────────────────────────────────────────

eq("checkbox off", verdict({ areaName: "Ravenwood Hollow", areaPanelEnabled: false }).reason, "disabled");
eq("checkbox on", verdict({ areaName: "Ravenwood Hollow", areaPanelEnabled: true }).show, true);
eq("checkbox null => default on", verdict({ areaName: "Ravenwood Hollow", areaPanelEnabled: null }).show, true);
eq("title scene suppressed", verdict({ areaName: "Ravenwood Hollow", sceneMode: "title" }).reason, "suppressed-scene-mode");
eq("dungeon scene not suppressed", verdict({ areaName: "Ravenwood Hollow", sceneMode: "dungeon" }).show, true);

// ── gate: repeat suppression ──────────────────────────────────────────────

eq("second map of the same castle", verdict({ areaName: "Fafnir Castle" }, "Fafnir Castle").reason, "repeat");
eq("different area after it", verdict({ areaName: "Ravenwood Hollow" }, "Fafnir Castle").show, true);
eq("repeat is whitespace-insensitive", verdict({ areaName: "Fafnir Castle" }, "  Fafnir Castle  ").reason, "repeat");
eq("repeat is case-SENSITIVE (names are authored, not parsed)",
   verdict({ areaName: "fafnir castle" }, "Fafnir Castle").show, true);
eq("always-show beats suppression",
   verdict({ areaName: "Fafnir Castle", areaPanelAlwaysShow: true }, "Fafnir Castle").show, true);
eq("always-show reports itself", verdict({ areaName: "Fafnir Castle", areaPanelAlwaysShow: true }, "Fafnir Castle").reason, "always-show");
eq("always-show still obeys the checkbox",
   verdict({ areaName: "Fafnir Castle", areaPanelAlwaysShow: true, areaPanelEnabled: false }, "Fafnir Castle").reason, "disabled");
eq("always-show default is OFF", readAreaConfig(scene({ areaName: "X" })).alwaysShow, false);
eq("no last area yet", verdict({ areaName: "Fafnir Castle" }, null).show, true);
eq("empty last area", verdict({ areaName: "Fafnir Castle" }, "").show, true);

// ── a run of activations, the way a session walks them ────────────────────
// Castle map 1 → castle map 2 → an unnamed battle arena → castle map 3.
// The arena must NOT clear the memory: it is part of the castle, and coming
// back out of a fight should not re-announce where the party already is.

{
  const walk = [
    { general: { areaName: "Fafnir Castle" },   want: true,  why: "first entry announces" },
    { general: { areaName: "Fafnir Castle" },   want: false, why: "second map is silent" },
    { general: {},                              want: false, why: "unnamed arena is silent" },
    { general: { areaName: "Fafnir Castle" },   want: false, why: "back from the arena, still silent" },
    { general: { areaName: "Sky Terrace" },     want: true,  why: "a new area announces" },
    { general: { areaName: "Fafnir Castle" },   want: true,  why: "returning from elsewhere announces again" },
  ];

  let last = null;
  walk.forEach((step, i) => {
    const v = shouldShowForScene(scene(step.general, `walk${i}`), { lastAreaName: last });
    eq(`walk[${i}] ${step.why}`, v.show, step.want);
    // Mirrors area-panel.js: the memory is written for any scene that CLEARS
    // the gate, and is left untouched by scenes that do not.
    if (v.name) last = v.name;
  });
}

// ── label formatting ──────────────────────────────────────────────────────

eq("label is glyph + name", formatLabel("Ravenwood Hollow"), `${GLYPH} Ravenwood Hollow`);
eq("label trims", formatLabel("  Ravenwood Hollow  "), `${GLYPH} Ravenwood Hollow`);
eq("label collapses inner whitespace", formatLabel("Ravenwood\n  Hollow"), `${GLYPH} Ravenwood Hollow`);
eq("blank label is empty, not a lone glyph", formatLabel("   "), "");
eq("null label is empty", formatLabel(null), "");

{
  const long = "A".repeat(TUNING.MAX_LABEL_CHARS + 40);
  const out = formatLabel(long);
  ok("over-long label is clamped", out.length <= TUNING.MAX_LABEL_CHARS + 2 + 1);
  ok("over-long label ends in an ellipsis", out.endsWith("…"));
  eq("at-limit label is untouched",
     formatLabel("B".repeat(TUNING.MAX_LABEL_CHARS)), `${GLYPH} ${"B".repeat(TUNING.MAX_LABEL_CHARS)}`);
}

eq("verdict carries the formatted label",
   verdict({ areaName: " Ravenwood  Hollow " }).label, `${GLYPH} Ravenwood Hollow`);

// ── tuning sanity — these are the numbers the feel depends on ─────────────

ok("hold is the spec's 4s", TUNING.HOLD_MS === 4000);
ok("watchdog outlasts a canvas draw plus the 700ms reveal",
   TUNING.WATCHDOG_MS > TUNING.SETTLE_MS + 900);
ok("panel sits below the transition curtain", TUNING.Z_INDEX < 99999);
ok("panel sits above Foundry chrome", TUNING.Z_INDEX > 30);

console.log(`\n${fail ? "FAILED" : "OK"} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
