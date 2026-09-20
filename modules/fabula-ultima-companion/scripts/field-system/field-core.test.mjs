// Bare-Node tests for the pure field core. Run:
//   node modules/fabula-ultima-companion/scripts/field-system/field-core.test.mjs
import assert from "node:assert/strict";
import {
  FLAG_NS, WELLSPRINGS, sceneWellsprings, parseFieldEffectList, desiredSceneEffectNames,
  planSceneReconcile, scenePromotionPatch, stampSceneAE, hasMarkerEffect, buildStarterLibraryEffects, buildFieldTemplateSystem,
} from "./field-core.js";

const scene = (origin, sceneId, name, id) => ({ _id: id, name, flags: { [FLAG_NS]: { fieldOrigin: origin, fieldSceneId: sceneId } } });
let n = 0;
const t = (label, fn) => { fn(); n++; console.log("  ✓", label); };

t("no scene config → the five RAW wellsprings, Moon/Sun absent", () => {
  assert.deepEqual(sceneWellsprings(null), ["air", "earth", "fire", "bolt", "ice"]);
});
t("explicit chips win; unset falls to the element default", () => {
  assert.deepEqual(sceneWellsprings({ wellspring_fire: false, wellspring_dark: true }), ["air", "earth", "bolt", "ice", "dark"]);
  assert.deepEqual(sceneWellsprings({ wellspring_light: "true", wellspring_air: "" }), ["air", "earth", "fire", "bolt", "ice", "light"]);
});
t("fieldEffects list parses commas, newlines, blanks", () => {
  assert.deepEqual(parseFieldEffectList(" Rain,\nFog ;; \n"), ["Rain", "Fog"]);
  assert.deepEqual(parseFieldEffectList(["A", " ", "B"]), ["A", "B"]);
});
t("desired names = wellspring AEs + field effects, deduped case-insensitively", () => {
  const names = desiredSceneEffectNames({ wellspring_air: false, fieldEffects: "Rain, earth wellspring, Rain" });
  assert.deepEqual(names, ["Earth Wellspring", "Fire Wellspring", "Lightning Wellspring", "Water Wellspring", "Rain"]);
});
t("reconcile deletes ONLY scene-origin AEs; a wanted skill/GM copy is PROMOTED, an unwanted one is left alone", () => {
  const existing = [
    scene("scene", "S1", "Air Wellspring", "a"),
    scene("skill", null, "Rain", "b"),              // wanted, transient → promote to scene-owned
    scene("scene", "S0", "Fire Wellspring", "c"),   // stale scene → drop and re-create
    scene("gm", null, "Scorching Ground", "d"),     // not wanted, not ours → keep
  ];
  const plan = planSceneReconcile({ existing, desiredNames: ["Air Wellspring", "Rain", "Fire Wellspring"], sceneId: "S1" });
  assert.deepEqual(plan.deleteIds, ["c"]);
  assert.deepEqual(plan.createNames, ["Fire Wellspring"]);
  assert.deepEqual(plan.promoteIds, ["b"]);
});
t("reconcile drops a scene AE the scene no longer declares", () => {
  const plan = planSceneReconcile({ existing: [scene("scene", "S1", "Air Wellspring", "a")], desiredNames: [], sceneId: "S1" });
  assert.deepEqual(plan, { deleteIds: ["a"], createNames: [], promoteIds: [] });
});
t("promotion patch makes a transient copy scene-owned and drops its lifetime bookkeeping", () => {
  const p = scenePromotionPatch("S1");
  assert.equal(p[`flags.${FLAG_NS}.fieldOrigin`], "scene");
  assert.equal(p[`flags.${FLAG_NS}.fieldSceneId`], "S1");
  assert.equal(p[`flags.${FLAG_NS}.directorPermanent`], true);
  assert.ok(`flags.${FLAG_NS}.-=directorAppliedBy` in p);
  assert.ok(`flags.${FLAG_NS}.-=charges` in p);
});
t("stampSceneAE marks origin/scene, strips ids + CSB provenance, sets directorPermanent", () => {
  const out = stampSceneAE({ _id: "x", name: "Rain", flags: { "custom-system-builder": { isPredefined: true }, [FLAG_NS]: { foo: 1 } } }, "S1");
  assert.equal(out._id, undefined);
  assert.equal(out.flags["custom-system-builder"], undefined);
  assert.deepEqual(out.flags[FLAG_NS], { foo: 1, fieldOrigin: "scene", fieldSceneId: "S1", directorPermanent: true });
  assert.equal(out.transfer, false);
});
t("hasMarkerEffect matches name, tag and status id; ignores disabled", () => {
  const effs = [
    { name: "Scorching Ground", system: { tags: ["field", "hazard"] }, statuses: ["burning"] },
    { name: "Off", disabled: true, system: { tags: ["fog"] } },
  ];
  assert.equal(hasMarkerEffect(effs, "SCORCHING_GROUND"), true);
  assert.equal(hasMarkerEffect(effs, "hazard"), true);
  assert.equal(hasMarkerEffect(effs, "burning"), true);
  assert.equal(hasMarkerEffect(effs, "fog"), false);
});
t("starter library: one AE per wellspring with the FLAG-family change key; templates carry no directorPermanent", () => {
  const lib = buildStarterLibraryEffects();
  for (const w of WELLSPRINGS) {
    const ae = lib.find((e) => e.name === w.aeName);
    assert.ok(ae, w.aeName);
    assert.deepEqual(ae.changes.map((c) => c.key), [`flags.${FLAG_NS}.wellspring_${w.elem}`]);
  }
  for (const ae of lib) assert.equal(ae.flags[FLAG_NS].directorPermanent, undefined, ae.name);
  const hazards = lib.filter((e) => e.flags[FLAG_NS].reactionConfig);
  assert.ok(hazards.length >= 2);
  for (const h of hazards) {
    for (const row of Object.values(h.flags[FLAG_NS].reactionConfig.reaction_config_table)) {
      assert.ok(["force", "on"].includes(row.reaction_passive_mode), `${h.name}: Field rows must be force/on`);
      assert.equal(row.reaction_source, "all", `${h.name}: Field rows must be side-less`);
    }
  }
});
t("template system is a CSB _template shape with an activeEffectContainer body", () => {
  const sys = buildFieldTemplateSystem();
  assert.ok(sys.body.contents.some((c) => c.type === "activeEffectContainer"));
  assert.ok(Number.isInteger(sys.templateSystemUniqueVersion));
});

console.log(`field-core: ${n} test(s) passed`);
