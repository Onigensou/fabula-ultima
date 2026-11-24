// node scripts/battle-director/survey-unlinked-performer.test.mjs
// Copies of ONE actor on unlinked tokens (Soul Fragments: every fragment is a token of
// `soULFRagmeNT0001`) share the actor id. The target survey must resolve the performer to
// ITS token, never to a sibling copy, and an "All Enemies" action must not reach the caster
// or any same-side copy (fix-fragment-allenemies-self, 2026-11-24).
import assert from "node:assert/strict";

globalThis.Hooks ??= { once() {}, on() {}, off() {}, callAll() {} };
globalThis.game ??= { actors: { get: () => null }, settings: { get: () => null }, scenes: [], user: { isGM: true } };
globalThis.CONFIG ??= { statusEffects: [] };
globalThis.foundry ??= { utils: { getProperty: (o, p) => String(p).split(".").reduce((a, k) => a?.[k], o) } };
const { surveyActionTargets } = await import("./target-survey.js");

let n = 0; const failed = [];
const t = (name, fn) => {
  try { fn(); n++; console.log("  ok", name); }
  catch (e) { failed.push(name); console.log("  FAIL", name, "--", String(e?.message ?? e).split(/\r?\n/)[0]); }
};

// Minimal Foundry-shaped docs. An unlinked token's synthetic actor carries the base actor's
// id, its own uuid under the token, and `token` = its TokenDocument (Foundry: actor.isToken).
const SCENE = "Scene.s1";
function unit(name, { tokenId, actorId, disposition, linked = true, hp = 50 }) {
  const tokUuid = `${SCENE}.Token.${tokenId}`;
  const tokenDoc = { id: tokenId, uuid: tokUuid, disposition, actorLink: linked, actorId, name, texture: {} };
  const actorDoc = {
    id: actorId, name, uuid: linked ? `Actor.${actorId}` : `${tokUuid}.Actor.${actorId}`,
    isToken: !linked, token: linked ? null : tokenDoc,
    system: { props: { current_hp: hp, max_hp: hp } }, effects: [], appliedEffects: [], items: [], flags: {},
  };
  tokenDoc.actor = actorDoc;
  return { id: `c-${tokenId}`, tokenDoc, actorDoc, disposition, side: disposition > 0 ? "party" : "enemy" };
}
const FRAG = "soULFRagmeNT0001";
const roster = [
  unit("Hina", { tokenId: "tHina", actorId: "aHina", disposition: 1 }),
  unit("Keren", { tokenId: "tKeren", actorId: "aKeren", disposition: 1 }),
  unit("Nidhogg", { tokenId: "tNid", actorId: "aNid", disposition: -1 }),
  unit("Hina's Soul Fragment", { tokenId: "tFragA", actorId: FRAG, disposition: -1, linked: false }),
  unit("Zarg's Soul Fragment", { tokenId: "tFragB", actorId: FRAG, disposition: -1, linked: false }),
];
const dCombat = { round: 1, combatants: roster };
const [, , , fragA, fragB] = roster;
const skill = (skill_target, extra = {}) => ({ name: "Warning Shriek", system: { props: { skill_target, skill_type: "Spell", effect_table: {}, ...extra } } });
const names = (s) => s.eligible.map((e) => e.name).sort();

// What the AI provider passes (target-survey.js surveyTargets): actor + tokenDocument, no combatantId.
const providerPerformer = (c, { withToken = true } = {}) => ({
  actor: c.actorDoc, tokenDocument: withToken ? c.tokenDoc : null, actorId: c.actorDoc.id,
});

t("All Enemies from fragment B (actor + its token): only the opposing side", () => {
  const s = surveyActionTargets({ dCombat, performer: providerPerformer(fragB), performerActor: fragB.actorDoc, action: skill("All Enemies"), creatureMeans: "enemy" });
  assert.equal(s.ok, true);
  assert.deepEqual(names(s), ["Hina", "Keren"]);
});

t("All Enemies from fragment B given as its synthetic actor only (no tokenDocument): never the caster or a copy", () => {
  const s = surveyActionTargets({ dCombat, performer: providerPerformer(fragB, { withToken: false }), performerActor: fragB.actorDoc, action: skill("All Enemies"), creatureMeans: "enemy" });
  assert.equal(s.ok, true);
  assert.deepEqual(names(s), ["Hina", "Keren"]);
});

t("Self from fragment B (synthetic actor, no tokenDocument) resolves fragment B, not the first copy", () => {
  const s = surveyActionTargets({ dCombat, performer: providerPerformer(fragB, { withToken: false }), performerActor: fragB.actorDoc, action: skill("Self") });
  assert.equal(s.ok, true);
  assert.equal(s.eligible[0].combatantId, fragB.id);
  assert.equal(s.eligible[0].tokenUuid, fragB.tokenDoc.uuid);
});

t("All Allies from fragment B (no tokenDocument): the pool is its side (both copies + Nidhogg), never the party", () => {
  const s = surveyActionTargets({ dCombat, performer: providerPerformer(fragB, { withToken: false }), performerActor: fragB.actorDoc, action: skill("All Allies") });
  assert.equal(s.ok, true);
  assert.deepEqual(names(s), ["Hina's Soul Fragment", "Nidhogg", "Zarg's Soul Fragment"]);
});

t("a performer token NOT in the roster is refused, not matched to a sibling copy by actor id", () => {
  const ghost = unit("Blanche's Soul Fragment", { tokenId: "tGhost", actorId: FRAG, disposition: -1, linked: false });
  const s = surveyActionTargets({ dCombat, performer: providerPerformer(ghost), performerActor: ghost.actorDoc, action: skill("Self") });
  assert.equal(s.ok, false);
  assert.equal(s.reason, "performer-not-in-combat");
});

t("a LINKED actor without a token still resolves by actor id (the fallback is kept for it)", () => {
  const hina = roster[0];
  const s = surveyActionTargets({ dCombat, performer: { actor: hina.actorDoc, actorId: hina.actorDoc.id }, performerActor: hina.actorDoc, action: skill("Self") });
  assert.equal(s.ok, true);
  assert.equal(s.eligible[0].combatantId, hina.id);
});

t("an unlinked token NOT in the roster is refused even when only ONE copy of its actor is enrolled", () => {
  const one = { round: 1, combatants: roster.filter((c) => c !== fragB) };
  const s = surveyActionTargets({ dCombat: one, performer: providerPerformer(fragB), performerActor: fragB.actorDoc, action: skill("Self") });
  assert.equal(s.ok, false);
});

t("a LINKED actor whose named token missed still resolves by actor id (unchanged)", () => {
  const hina = roster[0];
  const s = surveyActionTargets({ dCombat, performer: { actor: hina.actorDoc, actorId: hina.actorDoc.id, tokenDocument: { id: "elsewhere", uuid: "Scene.s2.Token.elsewhere" } }, performerActor: hina.actorDoc, action: skill("Self") });
  assert.equal(s.ok, true);
  assert.equal(s.eligible[0].combatantId, hina.id);
});

t("an ambiguous actor-id-only performer (no token, no synthetic actor) matching several copies is refused", () => {
  const s = surveyActionTargets({ dCombat, performer: { actorId: FRAG }, action: skill("Self") });
  assert.equal(s.ok, false);
});

console.log(`${n} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
