// Run: node scripts/battle-director/reactor-declarer-gate.test.mjs
// Counter Pass bug (real play 2026-11-28): a PC free action granted on an ENEMY turn was
// auto-picked by the enemy autopilot ("autopilot: Blanche free action → Skill "Muleta"
// [grant "Counter Pass"]") because DECLARE's gate asked about the CURRENT combatant.
// isAiControlledDeclarer answers for the REACTOR when a free-action grant is live.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const P = () => new Proxy(function () {}, {
  get: (t, k) => k === "then" ? undefined : k === Symbol.toPrimitive ? () => 0 : k === Symbol.iterator ? undefined : P(),
  apply: () => P(), construct: () => P(), set: () => true,
});
for (const k of ["PIXI", "canvas", "ui", "Hooks", "foundry", "Handlebars", "Dialog", "Application", "FormApplication", "ApplicationV2", "CONST", "document", "window", "localStorage"]) globalThis[k] = P();
globalThis.CONFIG = { statusEffects: [] };
globalThis.game = { combat: null, user: { isGM: true }, actors: { get: () => null } };

const { isAiControlledDeclarer, isAiControlledTurn } = await import("./enemy-autopilot.js");
const { freeActions } = await import("./free-actions.js");
const { SimMode } = await import("./sim/sim-mode.js");

let n = 0;
const t = (name, fn) => { fn(); n++; console.log("  ok", name); };

const row = (id, actorId, playerOwned) => ({
  id, tokenId: "tok-" + id, tokenDoc: { uuid: "T." + id },
  actorDoc: { uuid: "A." + actorId, hasPlayerOwner: playerOwned },
});
const blanche = row("blanche", "blanche", true), asura = row("asura", "asura", false);
const dirOn = (cur) => ({ dCombat: { currentCombatantId: cur.id, combatants: [blanche, asura] } });
const snapOf = (r, actorId) => ({ actorId, tokenUuid: r.tokenDoc.uuid, tokenId: r.tokenId, actorUuid: r.actorDoc.uuid });
const grant = { sourceLabel: "Counter Pass" };

t("PC reactor on an ENEMY turn → player decides (the bug)", () => {
  assert.equal(isAiControlledTurn(dirOn(asura)), true, "old gate said AI");
  assert.equal(isAiControlledDeclarer(dirOn(asura), snapOf(blanche, "blanche"), grant), false);
});
t("enemy reactor on a PC turn → AI decides (mirror case)", () => {
  assert.equal(isAiControlledDeclarer(dirOn(blanche), snapOf(asura, "asura"), grant), true);
});
t("no grant → unchanged current-combatant answer", () => {
  assert.equal(isAiControlledDeclarer(dirOn(asura), snapOf(asura, "asura"), null), true);
  assert.equal(isAiControlledDeclarer(dirOn(blanche), snapOf(blanche, "blanche"), null), false);
});
t("grant on own turn → same as today", () => {
  assert.equal(isAiControlledDeclarer(dirOn(blanche), snapOf(blanche, "blanche"), grant), false);
  assert.equal(isAiControlledDeclarer(dirOn(asura), snapOf(asura, "asura"), grant), true);
});
t("grant but reactor not in the roster → falls back to the current combatant", () => {
  assert.equal(isAiControlledDeclarer(dirOn(asura), { actorId: "ghost", tokenUuid: "T.ghost" }, grant), true);
});
t("matches by token id / actor uuid when the token uuid is missing", () => {
  assert.equal(isAiControlledDeclarer(dirOn(asura), { actorId: "blanche", tokenId: "tok-blanche" }, grant), false);
  assert.equal(isAiControlledDeclarer(dirOn(asura), { actorId: "blanche", actorUuid: "A.blanche" }, grant), false);
});
t("reads the live freeActions registry when no grant is passed", () => {
  // The registry's defeated / prevention checks need a live canvas actor; stub get() itself.
  const realGet = freeActions.get;
  freeActions.get = (id) => (id === "blanche" ? grant : null);
  try {
    assert.equal(isAiControlledDeclarer(dirOn(asura), snapOf(blanche, "blanche")), false);
  } finally { freeActions.get = realGet; }
  freeActions.get = () => null;
  try { assert.equal(isAiControlledDeclarer(dirOn(asura), snapOf(blanche, "blanche")), true, "no grant → current turn"); }
  finally { freeActions.get = realGet; }
});
t("registry stub restored", () => {
  assert.equal(typeof freeActions.get, "function");
});
t("sim: every declaration is the AI's", () => {
  const desc = Object.getOwnPropertyDescriptor(SimMode, "active");
  Object.defineProperty(SimMode, "active", { configurable: true, get: () => true });
  try { assert.equal(isAiControlledDeclarer(dirOn(asura), snapOf(blanche, "blanche"), grant), true); }
  finally { Object.defineProperty(SimMode, "active", desc); }
});
t("state-handlers: both DECLARE gates use the declarer helper", () => {
  const src = readFileSync(new URL("./state-handlers.js", import.meta.url), "utf8");
  assert.equal((src.match(/isAutopilotEnabled\(\) && isAiControlledDeclarer\(director, snap\)/g) ?? []).length, 2);
  assert.ok(!/isAutopilotEnabled\(\) && isAiControlledTurn\(director\)/.test(src), "old turn-based gate gone");
});

console.log(`reactor-declarer-gate: ${n} passed`);
