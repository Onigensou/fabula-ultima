// ============================================================================
// Status classifier — tier and cue harness.
//
//     node scripts/battle-director/status-classifier.test.mjs
//
// Every battle surface (token icons, HUD pips, NPC strip, cues, pop text)
// trusts this one answer. A wrong tier hides a debuff from the player or puts
// a meal on an enemy's feet, and nothing at the table reports it.
// ============================================================================
import assert from "node:assert/strict";
import { classifyEffect, cueOf, conditionOf, baseSlug, isNpcActor, TIER } from "./status-classifier.js";

// CONFIG.statusEffects-like: opaque ids mapped to names, as in the live world.
const CFG = [
  { id: "cDgbFRi9TA68TvYr", name: "Burn" },
  { id: "x1", name: "Paralyze" },
  { id: "x2", name: "Hidden" },
  { id: "guard", name: "Guard" },
  { id: "permanent", name: "Permanent" },
];
const fx = (o) => ({ name: "", statuses: [], changes: [], duration: {}, system: { tags: [] }, flags: {}, ...o });
const cls = (o) => classifyEffect(fx(o), CFG);

let n = 0;
const t = (name, fn) => { fn(); n++; };

t("conditions are debuffs by name, by status id, and by alias", () => {
  assert.equal(cls({ name: "Burn" }), TIER.DEBUFF);
  assert.equal(cls({ name: "Something", statuses: ["cDgbFRi9TA68TvYr"] }), TIER.DEBUFF);
  assert.equal(cls({ name: "Paralyzed", statuses: ["x1"] }), TIER.DEBUFF);
  assert.equal(conditionOf(fx({ name: "Charmed" }), CFG), "charm");
  assert.equal(cls({ name: "Provoked (Capote)" }), TIER.DEBUFF);
});

t("tags win over everything below them", () => {
  assert.equal(cls({ name: "Breach (Exposed)", system: { tags: ["debuff"] } }), TIER.DEBUFF);
  assert.equal(cls({ name: "Mercy", system: { tags: ["buff", "dispellable"] } }), TIER.BUFF);
  assert.equal(cls({ name: "Brainwave Clock", system: { tags: ["resource"] } }), TIER.RESOURCE);
  assert.equal(cls({ name: "Burn", system: { tags: ["hidden"] } }), TIER.HIDDEN);
  assert.equal(cls({ name: "Burn", flags: { "fabula-ultima-companion": { hidden: true } } }), TIER.HIDDEN);
});

t("ready = tag or a name ending in Ready", () => {
  assert.equal(cls({ name: "Emergency Item Ready" }), TIER.READY);
  assert.equal(cls({ name: "Heart of Darkness Ready" }), TIER.READY);
  assert.equal(cls({ name: "Protect", system: { tags: ["ready"] } }), TIER.READY);
  assert.equal(cls({ name: "Already Gone" }), TIER.MARKER);     // "ready" must be the last word
});

t("guard is a buff; food and camp results are markers", () => {
  assert.equal(cls({ name: "Guard", statuses: ["guard"], duration: { rounds: 1 } }), TIER.BUFF);
  assert.equal(cls({ name: "Hearty Hot-Pot", system: { tags: ["food"] } }), TIER.MARKER);
  assert.equal(cls({ name: "Cartography" }), TIER.MARKER);
  assert.equal(cls({ name: "Cartography", statuses: ["permanent"] }), TIER.MARKER);
});

t("tactical states: dispellable spells and Flying/Hidden are buffs, Crisis a debuff, KO never a pip", () => {
  assert.equal(cls({ name: "Elemental Weapon (Fire)", system: { tags: ["dispellable"] } }), TIER.BUFF);
  assert.equal(cls({ name: "Flying" }), TIER.BUFF);
  assert.equal(cls({ name: "Hidden", statuses: ["x2"] }), TIER.BUFF);
  assert.equal(cls({ name: "Crisis" }), TIER.DEBUFF);
  assert.equal(cls({ name: "KO" }), TIER.HIDDEN);
});

t("untagged timed effects take the sign of their changes", () => {
  assert.equal(cls({ name: "Odd Curse", duration: { rounds: 2 }, changes: [{ value: "-2" }] }), TIER.DEBUFF);
  assert.equal(cls({ name: "Odd Boon", duration: { rounds: 2 }, changes: [{ value: "3" }] }), TIER.BUFF);
  assert.equal(cls({ name: "Odd Flag", duration: { turns: 1 } }), TIER.BUFF);
});

t("cues: only the registered statuses draw on the token", () => {
  assert.equal(cueOf(fx({ name: "Burn" }), CFG), "burn");
  assert.equal(cueOf(fx({ name: "Envenomed" }), CFG), "poison");
  assert.equal(cueOf(fx({ name: "x", statuses: ["x1"] }), CFG), "paralyze");
  assert.equal(cueOf(fx({ name: "Provoked (Thread the Horns)" }), CFG), "provoked");
  assert.equal(cueOf(fx({ name: "Berserk" }), CFG), null);
  assert.equal(cueOf(fx({ name: "Slow" }), CFG), null);
});

t("baseSlug strips the parenthesised source and maps aliases", () => {
  assert.equal(baseSlug("Provoked (Capote)"), "provoked");
  assert.equal(baseSlug("Paralyze"), "paralyzed");
  assert.equal(baseSlug("  Cursed "), "curse");
});

t("NPC = npc_rank OR species; a PC has neither", () => {
  assert.equal(isNpcActor({ system: { props: { npc_rank: "soldier" } } }), true);
  assert.equal(isNpcActor({ system: { props: { npc_rank: "", species: "Humanoid" } } }), true);
  assert.equal(isNpcActor({ system: { props: { npc_rank: "", species: "" } } }), false);
  assert.equal(isNpcActor({}), false);
});

console.log(`status-classifier: ${n} groups passed`);
