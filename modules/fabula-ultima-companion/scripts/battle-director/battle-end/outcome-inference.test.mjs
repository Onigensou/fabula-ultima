import assert from "node:assert/strict";
import { detectOutcomeFromCombat, inferOutcomeFromCombatants } from "./outcome-inference.js";
import { classify } from "../sim/outcome-classify.js";

const F = "fabula-ultima-companion";
const mk = (side, down, flag) => ({
  side, isDefeatedLive: () => down,
  actorDoc: { flags: { [F]: flag ? { [flag]: true } : {} } },
});
let n = 0; const t = (name, fn) => { fn(); n++; console.log("ok", name); };

t("a: party down + boss down + fragment standing -> victory", () => {
  const dc = { combatants: [mk("party", true), mk("party", true), mk("enemy", true), mk("enemy", false, "bdObject")] };
  assert.equal(detectOutcomeFromCombat(dc), "victory");
});
t("b: PCs down + guest standing, enemies standing -> defeat", () => {
  const dc = { combatants: [mk("party", true), mk("party", false, "bdGuest"), mk("enemy", false)] };
  assert.equal(detectOutcomeFromCombat(dc), "defeat");
});
t("c: override wins", () => {
  const dc = { outcomeOverride: " Escaped ", combatants: [mk("party", true), mk("enemy", false)] };
  assert.equal(detectOutcomeFromCombat(dc), "escaped");
  assert.equal(detectOutcomeFromCombat({ outcomeOverride: "defeat", combatants: [mk("party", false), mk("enemy", true)] }), "defeat");
});
t("d: empty party -> victory; no dc -> victory", () => {
  assert.equal(detectOutcomeFromCombat({ combatants: [mk("enemy", false)] }), "victory");
  assert.equal(detectOutcomeFromCombat(null), "victory");
});
t("e: normal win / loss", () => {
  assert.equal(inferOutcomeFromCombatants([mk("party", false), mk("enemy", true)]), "victory");
  assert.equal(inferOutcomeFromCombatants([mk("party", true), mk("enemy", false)]), "defeat");
  assert.equal(inferOutcomeFromCombatants([mk("party", false), mk("enemy", false)]), "victory");
});

const sc = (side, defeated, x = {}) => ({ side, defeated, ...x });
t("classify: override honoured", () => {
  assert.equal(classify({ outcomeOverride: "defeat", combatants: [sc("party", false), sc("enemy", false)] }), "defeat");
});
t("classify: held-wipe win (PCs down, boss down, fragment up) -> victory", () => {
  assert.equal(classify({ combatants: [sc("party", true), sc("enemy", true), sc("enemy", false, { isObject: true })] }), "victory");
});
t("classify: TPK with guest -> defeat; ongoing -> inconclusive", () => {
  assert.equal(classify({ combatants: [sc("party", true), sc("party", false, { isGuest: true }), sc("enemy", false)] }), "defeat");
  assert.equal(classify({ combatants: [sc("party", false), sc("enemy", false)] }), "inconclusive");
  assert.equal(classify(null), "unknown");
});
console.log(n + " passed");
