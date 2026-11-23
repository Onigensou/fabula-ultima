// Run: node scripts/battle-director/free-action-lock-gate.test.mjs
// Stall hunt 2026-11-23, fixes A + B.
//   A: a free_action / chain that LOCKS a target the performer may not target (the party vs a Nox
//      Servant's permanent Soul Fragment) is not granted, and a chain does not pay its earlier steps.
//   B: TARGET filtering a pre-composed pick to ZERO targets bounces (no_eligible) instead of ok.
//   Plus: the sim re-declare guard retires a bounced pick (no loop).
// skill-effects / state-handlers need Foundry globals: a tolerant stub, only to let them LOAD.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const P = () => new Proxy(function () {}, {
  get: (t, k) => k === "then" ? undefined : k === Symbol.toPrimitive ? () => 0 : k === Symbol.iterator ? undefined : P(),
  apply: () => P(), construct: () => P(), set: () => true,
});
for (const k of ["PIXI", "canvas", "ui", "Hooks", "foundry", "Handlebars", "Dialog", "Application", "FormApplication", "ApplicationV2", "CONST", "document", "window", "localStorage"]) globalThis[k] = P();
globalThis.CONFIG = { statusEffects: [] };
globalThis.game = { combat: null, user: { isGM: true }, actors: { get: () => null } };

const NS = "fabula-ultima-companion";
const mk = (uuid, effects = [], disp, name = uuid) => ({ uuid, id: uuid, name, system: { props: { current_hp: 10, max_hp: 10 } }, effects: { contents: effects }, prototypeToken: { disposition: disp } });
const mark = (permanent) => ({ disabled: false, changes: [], flags: { [NS]: { soulFragmentMark: true, ...(permanent ? { soulPermanent: true } : {}) } } });
const tokenOf = (actor, disp) => ({ uuid: "T." + actor.uuid, name: actor.name, disposition: disp, actor, document: null });
const blanche = mk("A.blanche", [], 1, "Blanche");
const permFrag = mk("A.permfrag", [mark(true)], -1, "Zarg's Soul Fragment");
const normFrag = mk("A.normfrag", [mark(false)], -1, "Blanche's Soul Fragment");
const permTok = tokenOf(permFrag, -1), normTok = tokenOf(normFrag, -1);
globalThis.fromUuid = async (u) => ({ [permTok.uuid]: permTok, [normTok.uuid]: normTok }[u] ?? null);

const rd = (f) => readFileSync(new URL(f, import.meta.url), "utf8").split("\r\n").join("\n");
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log("  ok", name); };

const gate = await import("./free-action-lock-gate.js");
const { applyEffectRow } = await import("./skill-effects.js");

console.log("gate helper");
await t("party vs permanent fragment is untargetable; ordinary fragment is fine", () => {
  assert.equal(gate.isLockedTargetBlocked(permFrag, blanche), true);
  assert.equal(gate.isLockedTargetBlocked(normFrag, blanche), false);
  assert.equal(gate.isLockedTargetBlocked(permFrag, mk("A.nid", [], -1)), false, "Nidhogg side still may (Soul Devour)");
  assert.equal(gate.isLockedTargetBlocked(permFrag, permFrag), false, "self carve-out");
});
await t("first untargetable token / roster helpers", () => {
  assert.equal(gate.firstUntargetableToken([normTok, permTok], blanche), permTok);
  assert.equal(gate.firstUntargetableToken([normTok], blanche), null);
  const rows = [{ tokenUuid: permTok.uuid, actorDoc: permFrag, disposition: -1 }, { tokenUuid: normTok.uuid, actorDoc: normFrag, disposition: -1 }];
  const dc = { combatants: rows };
  assert.equal(gate.isLockedUuidBlockedInCombat(permTok.uuid, blanche, dc), true);
  assert.equal(gate.isLockedUuidBlockedInCombat(normTok.uuid, blanche, dc), false);
  assert.deepEqual(gate.targetableRows(rows, blanche, dc).map((r) => r.tokenUuid), [normTok.uuid]);
});
await t("fix B predicate", () => {
  assert.equal(gate.targetsFilteredToNothing({ isSelf: false, skipped: false, targets: [] }), true);
  assert.equal(gate.targetsFilteredToNothing({ isSelf: true, skipped: false, targets: [] }), false);
  assert.equal(gate.targetsFilteredToNothing({ isSelf: false, skipped: true, targets: [] }), false);
  assert.equal(gate.targetsFilteredToNothing({ isSelf: false, skipped: false, targets: [{}] }), false);
});

console.log("fix A: applyEffectRow (real skill-effects)");
const freeRow = { effect_kind: "free_action", effect_label: "cp_free", action_ref: "skill", allowed_skill_refs: "Muleta", target_ref: "trigger_subject" };
const spendRow = { effect_kind: "consume_charge", effect_label: "cp_spend", charge_key: "counterpass", count: "1", on_empty: "abort", target_ref: "self" };
const chainRow = { effect_kind: "chain", effect_label: "cp_do", chain_steps: "cp_spend,cp_free" };
const ctxFor = (subject) => ({
  reactorActor: blanche, reactorToken: { uuid: "T.blanche", actor: blanche }, dCombat: null,
  payload: { subjectTokenUuid: subject.uuid },
  skill: { name: "Counter Pass", uuid: "I.cp", system: { props: { effect_table: { 0: chainRow, 1: spendRow, 2: freeRow } } } },
});
await t("free_action locked on a permanent fragment: NOT granted", async () => {
  const r = await applyEffectRow(freeRow, ctxFor(permTok));
  assert.equal(r.ok, true); assert.equal(r.skipped, "locked-target-untargetable");
});
await t("free_action locked on an ordinary fragment: not refused by the gate (control)", async () => {
  let r; try { r = await applyEffectRow(freeRow, ctxFor(normTok)); } catch { r = { thrown: true }; }
  assert.notEqual(r?.skipped, "locked-target-untargetable");
});
await t("Counter Pass chain: nothing is spent when the lock is untargetable (cp_spend not run)", async () => {
  const ctx = ctxFor(permTok);
  const r = await applyEffectRow(chainRow, ctx);
  assert.equal(r.ok, true); assert.equal(r.skipped, "locked-target-untargetable");
  assert.deepEqual(r.applied, [], "no step ran, so cp_spend was not paid");
});
await t("chain preflight does not skip on a targetable lock (control)", async () => {
  let r; try { r = await applyEffectRow(chainRow, ctxFor(normTok)); } catch { r = { thrown: true }; }
  assert.notEqual(r?.skipped, "locked-target-untargetable");
});

console.log("fix B: state-handlers wiring + re-declare guard");
await t("state-handlers imports the predicate and bounces with no_eligible before the ok:true return", () => {
  const src = rd("./state-handlers.js");
  const i = src.indexOf("targetsFilteredToNothing({ isSelf");
  assert.ok(i > 0, "bounce present");
  const tail = src.slice(i, i + 700);
  assert.ok(tail.includes("return noEligibleResult(director, attackerSnap)"));
  assert.ok(/function noEligibleResult/.test(src) && src.includes("reason: \"no_eligible\""));
  const okRet = src.slice(i).search(/ok: true, cancelled: false,\s+skipped: result\.skipped/) + i;
  assert.ok(okRet > i, "bounce sits BEFORE the zero-target ok return");
});
await t("every TARGET caller maps no_eligible to TARGET_BACK (the bounce is handled, never an ok:true empty set)", () => {
  const src = rd("./state-handlers.js");
  const calls = (src.match(/await resolveActionTargets\(/g) ?? []).length;
  const handled = (src.match(/reason === "no_eligible"/g) ?? []).length;
  assert.ok(handled >= calls - 1, `callers ${calls}, no_eligible handlers ${handled}`);
});
await t("re-declare guard: a bounced pick is retired, the next choice differs, then the free action is declined (bounded, no loop)", async () => {
  const { SimMode } = await import("./sim/sim-mode.js");
  const turnKey = "1:blanche:free:Counter Pass";
  // The brain is deterministic: ranked Muleta, then Descabello. Mirrors simFallbackBundle's loop body.
  const ranked = [{ command: "Skill", skillUuid: "muleta", _name: "Muleta" }, { command: "Skill", skillUuid: "descabello", _name: "Descabello" }];
  const decide = (blocked) => ranked.find((b) => !blocked.has(b._name.toLowerCase())) ?? null;
  const picks = [];
  for (let bounce = 0; bounce < 6; bounce++) {                  // each iteration = one DECLARE after a no_eligible bounce
    let chosen = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const b = decide(SimMode.blockedForTurn(turnKey));
      if (!b) break;
      const sig = `${b.command}:${b.skillUuid}`;
      if (SimMode.declaredThisTurn(turnKey, sig)) { SimMode.blockForTurn(turnKey, b._name); continue; }
      SimMode.recordDeclaration(turnKey, sig); chosen = b; break;
    }
    if (!chosen) break;
    picks.push(chosen._name);
  }
  // Muleta is declared once, bounces, is retired -> Descabello once -> nothing: 2 declarations, not 6.
  assert.ok(picks.length <= 2, `looped: ${picks}`);
});
await t("brain + autopilot use the shared gate (no duplicated rule)", () => {
  const brain = rd("./sim/player-brain.js");
  const ap = rd("./enemy-autopilot.js");
  assert.match(brain, /isLockedUuidBlockedInCombat\(lockedTargetTokenUuid/);
  assert.match(brain, /dCombat: director\?\.dCombat/);
  assert.match(ap, /isLockedUuidBlockedInCombat\(grant\.lockedTargetTokenUuid/);
  for (const [nm, s] of [["brain", brain], ["autopilot", ap]]) assert.ok(!/soulPermanent|isPermanentSoulFragment/.test(s), `${nm} must not restate the rule`);
});


console.log("review pass 2");
const sh = rd("./state-handlers.js");
const st = await import("./states.js");
const cs = await import("./continuation-stack.js");
await t("B1: FSM model on the REAL transition table - preset free action with zero eligible: <= 2 DECLARE visits, then the window moves on", async () => {
  const { STATES, TRANSITIONS } = st; const { INTENTS } = await import("./intents.js");
  const director = { ctx: {} };
  cs.pushFrame(director, { reason: "freeAction:cp_free", resumeAt: STATES.TURN_START, extra: { request: { sourceLabel: "x" } } });
  let state = STATES.DECLARE, declares = 0, steps = 0;
  const next = (intent) => { const r = TRANSITIONS[state][intent].next; return typeof r === "function" ? r(director.ctx) : r; };
  while (state !== STATES.TURN_START && steps++ < 50) {
    if (state === STATES.DECLARE) {
      declares++;
      const top = cs.peekTop(director.ctx);
      // model of Declare.onEnter's preset shortcut (source-asserted below)
      state = top?.extra?.presetBounced ? next(INTENTS.TIMEOUT) : next(INTENTS.DECLARE_COMMAND);
    } else if (state === STATES.TARGET) {
      director.ctx.freeActionForfeit = false;
      // model of noEligibleResult
      director.ctx.freeActionForfeit = true; cs.peekTop(director.ctx).extra.presetBounced = true;
      state = next(INTENTS.TARGET_BACK);
    } else if (state === STATES.FREE_ACTION_WINDOW) {
      director.ctx.freeActionForfeit = false; cs.popFrame(director); state = STATES.TURN_START;
    } else throw new Error("unexpected " + state);
  }
  assert.ok(declares <= 2, "DECLARE visits: " + declares); assert.equal(state, STATES.TURN_START);
  assert.equal(cs.stackDepth(director.ctx), 0, "frame popped");
});
await t("B1: outside a free-action frame TARGET_BACK still returns to DECLARE", async () => {
  const { STATES, TRANSITIONS } = st; const { INTENTS } = await import("./intents.js");
  assert.equal(TRANSITIONS[STATES.TARGET][INTENTS.TARGET_BACK].next({ freeActionForfeit: true }), STATES.DECLARE);
  const d = { ctx: {} }; cs.pushFrame(d, { reason: "freeAction:y", resumeAt: null });
  d.ctx.freeActionForfeit = true;
  assert.equal(TRANSITIONS[STATES.TARGET][INTENTS.TARGET_BACK].next(d.ctx), STATES.FREE_ACTION_WINDOW, "forfeit flag in a free frame -> FAW");
  d.ctx.freeActionForfeit = false;
  assert.equal(TRANSITIONS[STATES.TARGET][INTENTS.TARGET_BACK].next(d.ctx), STATES.DECLARE, "human cancel in a free frame is not a forfeit");
});
await t("B1 wiring: every no_eligible return goes through noEligibleResult; DECLARE refuses to re-stage a bounced preset; FAW logs + clears", () => {
  const a = sh.indexOf("async function resolveActionTargets"), b = sh.indexOf("// ─── TARGET ───", a);
  assert.equal((sh.slice(a, b).match(/reason: "no_eligible"/g) ?? []).length, 0, "no literal no_eligible return left in resolveActionTargets");
  assert.ok(sh.slice(a, b).split("noEligibleResult(director, attackerSnap)").length - 1 >= 4);
  const dc = sh.indexOf("peekTop(director.ctx)?.extra?.presetBounced");
  assert.ok(dc > 0 && sh.slice(dc, dc + 500).includes("INTENTS.TIMEOUT"), "DECLARE forfeits a bounced preset");
  assert.ok(sh.includes("FORFEITED (no eligible target)"));
});
await t("B1 policy: forfeit only with no real choice (preset / locked / AI); a HUMAN open-choice free action goes back to DECLARE", async () => {
  const { STATES, TRANSITIONS } = st; const { INTENTS } = await import("./intents.js");
  assert.equal(gate.shouldForfeitFreeAction({ grant: { preset: { command: "Skill" } }, aiPerformer: false }), true, "preset");
  assert.equal(gate.shouldForfeitFreeAction({ grant: { lockedTargetTokenUuid: "T.x" }, aiPerformer: false }), true, "locked");
  assert.equal(gate.shouldForfeitFreeAction({ grant: {}, aiPerformer: true }), true, "AI open-choice: its re-pick repeats the same lock; forfeit is the bound");
  assert.equal(gate.shouldForfeitFreeAction({ grant: {}, aiPerformer: false }), false, "human open choice (all enemies Covered)");
  assert.equal(gate.shouldForfeitFreeAction({}), false);
  // human open-choice: flag never set -> TARGET_BACK -> DECLARE even inside a free frame
  const d = { ctx: {} }; cs.pushFrame(d, { reason: "freeAction:h", resumeAt: null });
  assert.equal(TRANSITIONS[STATES.TARGET][INTENTS.TARGET_BACK].next(d.ctx), STATES.DECLARE);
  assert.ok(sh.includes("shouldForfeitFreeAction({ grant, aiPerformer"), "state-handlers delegates to the policy");
  assert.match(sh, /function noEligibleResult[\s\S]{0,200}freeActionHasNoRealChoice/);
});
await t("B1 real-play autopilot: decideFreeActionBundle re-returns the same lock, so the forfeit (not the autopilot) is what bounds it", () => {
  const ap = rd("./enemy-autopilot.js");
  assert.ok(ap.includes("isLockedUuidBlockedInCombat(grant.lockedTargetTokenUuid"));
  assert.ok(!/freeActionForfeit/.test(ap));
  assert.match(sh, /noEligibleResult/);   // autopilot compose goes through resolveActionTargets like every TARGET
});

const warns = []; globalThis.ui = { notifications: { warn: (m) => warns.push(m), info() {} } };
const chatMsgs = []; globalThis.ChatMessage = { create: async (d) => { chatMsgs.push(d); } };
globalThis.game = { combat: null, user: { isGM: true }, actors: { get: () => null }, users: { contents: [{ id: "uPlayer", isGM: false, active: true }] } };
blanche.testUserPermission = (u) => u.id === "uPlayer";
await t("B2: a refused chain leaves NO ctx._aeBatch", async () => {
  const ctx = ctxFor(permTok);
  const r = await applyEffectRow(chainRow, ctx);
  assert.equal(r.skipped, "locked-target-untargetable");
  assert.equal(ctx._aeBatch, undefined);
});
await t("Q1: free_action with target_ref that resolves to nothing (Nox Hound shape) is REFUSED, not granted unlocked", async () => {
  const ctx = ctxFor(permTok); ctx.payload = {};   // trigger_subject resolves nothing (Servant dropped / gone)
  const r = await applyEffectRow({ ...freeRow, effect_label: "oth_free" }, ctx);
  assert.equal(r.ok, true); assert.equal(r.skipped, "locked-target-untargetable");
});
await t("Q2: pre-flight leaves ctx.resolvedTargets untouched; a step with condition_formula is not pre-flighted", async () => {
  const ctx = ctxFor(permTok);
  await applyEffectRow(chainRow, ctx);
  assert.ok(!ctx.resolvedTargets || ctx.resolvedTargets.size === 0, "pre-flight cached onto the real ctx");
  const condFree = { ...freeRow, effect_label: "cp_free", condition_formula: "1 == 0" };
  const c2 = ctxFor(permTok);
  c2.skill.system.props.effect_table = { 0: chainRow, 1: spendRow, 2: condFree };
  let r; try { r = await applyEffectRow(chainRow, c2); } catch { r = { thrown: true }; }
  assert.ok(!(r?.skipped === "locked-target-untargetable" && r.applied?.length === 0), "conditional step must decide at run time");
  assert.equal(gate.isPayloadTargetRef("trigger_subject"), true);
  assert.equal(gate.isPayloadTargetRef("fc_held"), false, "named refs are not pre-resolved");
});
await t("Q3: refusal notifies (GM toast + whisper to the owning player), naming the target", async () => {
  warns.length = 0; chatMsgs.length = 0;
  await applyEffectRow(freeRow, ctxFor(permTok));
  assert.equal(warns.length, 1); assert.match(warns[0], /can't be targeted/); assert.match(warns[0], /Soul Fragment/);
  assert.equal(chatMsgs.length, 1); assert.deepEqual(chatMsgs[0].whisper, ["uPlayer"]);
  warns.length = 0; const r = await applyEffectRow(chainRow, ctxFor(permTok));
  assert.equal(r.ok, true); assert.equal(warns.length, 1, "chain refusal notifies once");
});
await t("re-gate B2: refusal never carries an effect_label (named by skill, else 'Free action')", async () => {
  warns.length = 0;
  const ctx = ctxFor(permTok); ctx.payload = {};
  await applyEffectRow({ ...freeRow, effect_label: "oth_chain" }, ctx);
  assert.equal(warns.length, 1); assert.ok(!warns[0].includes("oth_chain"), warns[0]); assert.match(warns[0], /Counter Pass/);
  warns.length = 0;
  const c2 = ctxFor(permTok); c2.payload = {}; c2.skill = { system: { props: {} } };
  await applyEffectRow({ ...freeRow, effect_label: "oth_chain" }, c2);
  assert.ok(!warns[0].includes("oth_chain") && /Free action/.test(warns[0]), warns[0]);
  assert.equal(gate.grantDisplayName({ effect_label: "pl_free_study" }, {}), "Free action");
  assert.equal(gate.grantDisplayName({ effect_label: "x", menu_label: "Study" }, {}), "Study");
  assert.ok(!gate.refusalMessage({ why: "unresolved" }, gate.grantDisplayName({ effect_label: "pl_free_study" }, {}), { name: "Hina" }).includes("pl_free"));
});
await t("re-gate Q: sim / harness -> no toast, no ChatMessage; live -> both", async () => {
  warns.length = 0; chatMsgs.length = 0;
  globalThis.__FU_HARNESS_HEADLESS__ = true;
  try { await applyEffectRow(freeRow, ctxFor(permTok)); await applyEffectRow(chainRow, ctxFor(permTok)); } finally { delete globalThis.__FU_HARNESS_HEADLESS__; }
  assert.equal(warns.length, 0); assert.equal(chatMsgs.length, 0);
  const { SimMode } = await import("./sim/sim-mode.js");
  const desc = Object.getOwnPropertyDescriptor(SimMode, "active"); Object.defineProperty(SimMode, "active", { configurable: true, get: () => true });
  try { await applyEffectRow(freeRow, ctxFor(permTok)); } finally { Object.defineProperty(SimMode, "active", desc); }
  assert.equal(warns.length, 0); assert.equal(chatMsgs.length, 0);
  const r = await gate.notifyGrantRefused(blanche, "x", { sim: true });
  assert.deepEqual(r, { toast: false, whisper: null });
});
await t("re-gate B1: AI-vs-human is decided by the declaration (autoDeclaredTurnKey), not the current turn", async () => {
  const src = rd("./state-handlers.js");
  const m = src.match(/function freeActionPerformerIsMachine[\s\S]*?\n}\n/);
  assert.ok(m, "helper present");
  assert.ok(!/isAiControlledTurn\(director\)\)\s*\|\|\s*isAutomatedSummonTurn\(director, attackerSnap\)\) }\);/.test(src), "old turn-based rule gone");
  const { SimMode } = await import("./sim/sim-mode.js");
  const key = (d, s) => `${d.dCombat.round}:${s.tokenUuid}`;
  const fn = new Function("SimMode", "summonTurnKey", m[0] + "; return freeActionPerformerIsMachine;")(SimMode, key);
  const snap = { tokenUuid: "T.pc" }, other = { tokenUuid: "T.enemy" };
  // human composes a free action on an ENEMY turn with autopilot ON: nothing was machine-declared
  assert.equal(fn({ dCombat: { round: 1 }, ctx: {} }, snap), false);
  assert.equal(gate.shouldForfeitFreeAction({ aiPerformer: false }), false, "zero eligible -> TARGET_BACK -> DECLARE, not forfeited");
  // machine-declared free action (either side's turn): forfeit
  assert.equal(fn({ dCombat: { round: 1 }, ctx: { autoDeclaredTurnKey: "1:T.pc" } }, snap), true);
  assert.equal(gate.shouldForfeitFreeAction({ aiPerformer: true }), true);
  // a key for someone else / another round does not count
  assert.equal(fn({ dCombat: { round: 1 }, ctx: { autoDeclaredTurnKey: "1:T.enemy" } }, snap), false);
  assert.equal(fn({ dCombat: { round: 2 }, ctx: { autoDeclaredTurnKey: "1:T.pc" } }, snap), false);
  void other;
  const desc = Object.getOwnPropertyDescriptor(SimMode, "active"); Object.defineProperty(SimMode, "active", { configurable: true, get: () => true });
  try { assert.equal(fn({ dCombat: { round: 1 }, ctx: {} }, snap), true, "sim stays AI"); } finally { Object.defineProperty(SimMode, "active", desc); }
});
await t("isTransientAE is exported", async () => {
  const m = await import("./skill-effects.js"); assert.equal(typeof m.isTransientAE, "function");
});

console.log(`free-action-lock-gate: ${n} ok`);
process.exit(0);
