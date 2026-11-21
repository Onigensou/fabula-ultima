// node scripts/battle-director/massive-keyword.test.mjs
import assert from "node:assert/strict";
import {
  rowsHaveNegate, negateBlockedByMassive, rowsHaveBlockableNegate, negateRowIsCostFailure, phase0NegateVerdict, hasMassive, itemIsMassive, massiveShare, massiveDefenseBonus, massiveJoinRowKey, isMassiveJoinRowKey,
  massiveJoinTables, selectMassiveJoiners, buildMassiveJoinCandidate, isPlayerCharacterActor,
  applyNoxMassiveGate, stripNoxServantsFromMassive, stripNoxServantsFromMassiveCopy,
} from "./massive-keyword.js";

let n = 0;
const t = (name, fn) => { fn(); n++; console.log("  ok", name); };

t("keyword parse: comma / newline list, case-insensitive", () => {
  assert.equal(hasMassive("multi, Massive"), true);
  assert.equal(hasMassive("overflow\nmassive"), true);
  assert.equal(hasMassive("massiveness"), false);
  assert.equal(hasMassive(""), false);
  assert.equal(itemIsMassive({ system: { props: { action_keywords: "massive" } } }), true);
  assert.equal(itemIsMassive({ system: { props: {} } }), false);
});

t("share: 300 over 1 / 2 / 3 / 4 / 7 targets, rounded down", () => {
  assert.equal(massiveShare(300, 1), 300);
  assert.equal(massiveShare(300, 2), 150);
  assert.equal(massiveShare(300, 3), 100);
  assert.equal(massiveShare(300, 4), 75);
  assert.equal(massiveShare(300, 7), 42);
  assert.equal(massiveShare(300, 0), 300);   // never divides by zero
});

t("+1 DEF only on ORIGINAL targets, only once someone joined (flat, not per joiner)", () => {
  const a = { tokenUuid: "a" }, b = { tokenUuid: "b" };
  const j1 = { tokenUuid: "j1", addedVia: { massive: true } }, j2 = { tokenUuid: "j2", addedVia: { massive: true } };
  assert.equal(massiveDefenseBonus(a, [a, b]), 0);
  assert.equal(massiveDefenseBonus(a, [a, b, j1]), 1);
  assert.equal(massiveDefenseBonus(a, [a, j1, j2]), 1);
  assert.equal(massiveDefenseBonus(j1, [a, j1]), 0);
  // A Grappled splash is not a Massive joiner.
  assert.equal(massiveDefenseBonus(a, [a, { tokenUuid: "g", addedVia: { via: "Grappling" } }]), 0);
});

t("rowKey: one per reactor, recognised, tables built from it", () => {
  const k = massiveJoinRowKey("abc");
  assert.equal(isMassiveJoinRowKey(k), true);
  assert.equal(isMassiveJoinRowKey("0"), false);
  assert.notEqual(massiveJoinRowKey("abc"), massiveJoinRowKey("def"));
  const tb = massiveJoinTables(k);
  assert.equal(tb.reaction_config_table[k].reaction_passive_mode, "ask");
  assert.equal(tb.reaction_config_table[k].reaction_effect_ref, "massive_join");
  assert.deepEqual(Object.values(tb.effect_table)[0], { effect_label: "massive_join", effect_kind: "add_target", target_ref: "self" });
  assert.equal(massiveJoinTables("0"), null);
});

// ── who gets the card ───────────────────────────────────────────────────────
const pc = (id, side = "party", extra = {}) => ({
  tokenUuid: `Scene.s.Token.${id}`, side, defeated: false,
  actorDoc: { id, uuid: `Actor.${id}`, name: id, system: { props: { ...extra } } },
});
const boss = { ...pc("nid", "enemy", { npc_rank: "champion" }) };
const hina = pc("hina"), keren = pc("keren"), blanche = pc("blanche"), zarg = pc("zarg");
const guest = pc("kalina"); guest.isGuest = true;
const summon = pc("numen"); summon.isSummon = true;
const ally = pc("allyNpc", "party", { npc_rank: "soldier" });
const imp = pc("imp", "enemy", { npc_rank: "soldier" });
const isSummonCombatant = (c) => !!(c.isGuest || c.isSummon);
const all = [boss, hina, keren, blanche, zarg, guest, summon, ally, imp];
const tgt = (c) => ({ tokenUuid: c.tokenUuid, actorUuid: c.actorDoc.uuid });
const names = (cs) => cs.map((c) => c.actorDoc.id);

t("boss targets Hina: the other three PCs get a card; guests, summons, NPC allies, enemies, the caster do not", () => {
  const got = selectMassiveJoiners({ combatants: all, targets: [tgt(hina)], attackerActorUuid: boss.actorDoc.uuid, isSummonCombatant });
  assert.deepEqual(names(got), ["keren", "blanche", "zarg"]);
});

t("an already-targeted PC gets no card", () => {
  const got = selectMassiveJoiners({ combatants: all, targets: [tgt(hina), tgt(zarg)], attackerActorUuid: boss.actorDoc.uuid, isSummonCombatant });
  assert.deepEqual(names(got), ["keren", "blanche"]);
});

t("a defeated PC gets no card", () => {
  const down = { ...keren, defeated: true };
  const got = selectMassiveJoiners({ combatants: [boss, hina, down, blanche], targets: [tgt(hina)], attackerActorUuid: boss.actorDoc.uuid, isSummonCombatant });
  assert.deepEqual(names(got), ["blanche"]);
});

t("a KO'd PC (0 HP, defeated flag never set) gets no card", () => {
  const ko = pc("kerenKo", "party", { current_hp: 0 });
  const live = pc("blancheLive", "party", { current_hp: 12 });
  const got = selectMassiveJoiners({ combatants: [boss, hina, ko, live], targets: [tgt(hina)], attackerActorUuid: boss.actorDoc.uuid, isSummonCombatant });
  assert.deepEqual(names(got), ["blancheLive"]);
  const viaMethod = { ...pc("m"), isDefeatedLive: () => true };
  assert.deepEqual(names(selectMassiveJoiners({ combatants: [boss, hina, viaMethod], targets: [tgt(hina)], attackerActorUuid: boss.actorDoc.uuid, isSummonCombatant })), []);
});

t("a PC casting Massive at enemies: no card for the other PCs (not on the targets' side)", () => {
  const got = selectMassiveJoiners({ combatants: all, targets: [tgt(imp)], attackerActorUuid: hina.actorDoc.uuid, isSummonCombatant });
  assert.deepEqual(names(got), []);
});

t("isPlayerCharacterActor = no npc_rank", () => {
  assert.equal(isPlayerCharacterActor(hina.actorDoc), true);
  assert.equal(isPlayerCharacterActor(boss.actorDoc), false);
});

t("candidate: ask-mode, own rowKey, acting skill as carrier", () => {
  const c = buildMassiveJoinCandidate({ skill: { uuid: "Actor.nid.Item.wb", name: "Wailing Breath", img: "x.png" }, reactorActor: keren.actorDoc });
  assert.equal(c.mode, "ask");
  assert.equal(c.kind, "manual");
  assert.equal(c.carrierUuid, "Actor.nid.Item.wb");
  assert.equal(c.rowKey, massiveJoinRowKey("keren"));
  assert.equal(c.ref, "massive_join");
  assert.equal(c.usesAddTarget, true);
  assert.match(c.carrierName, /Wailing Breath/);
});

t("negate gate: Massive blocks a negate_action row, non-Massive does not", () => {
  const rows = [{ effect_kind: "apply_status" }, { effect_kind: " Negate_Action " }];
  assert.equal(rowsHaveNegate(rows), true);
  assert.equal(negateBlockedByMassive(true, rows), true);
  assert.equal(negateBlockedByMassive(false, rows), false);
  assert.equal(negateBlockedByMassive(true, [{ effect_kind: "apply_status" }]), false);
  assert.equal(negateBlockedByMassive(true, []), false);
  assert.equal(negateBlockedByMassive(true, undefined), false);
});

t("exempt marker: a cost-failure negate is not blocked by Massive", () => {
  const exempt = [{ effect_kind: "negate_action", negate_is_cost_failure: true }];
  assert.equal(negateRowIsCostFailure(exempt[0]), true);
  assert.equal(negateRowIsCostFailure({ negate_is_cost_failure: "true" }), true);
  assert.equal(negateRowIsCostFailure({ negate_is_cost_failure: false }), false);
  assert.equal(negateRowIsCostFailure({ negate_is_cost_failure: "" }), false);
  assert.equal(negateRowIsCostFailure({}), false);
  assert.equal(rowsHaveNegate(exempt), true);
  assert.equal(rowsHaveBlockableNegate(exempt), false);
  assert.equal(negateBlockedByMassive(true, exempt), false);
  // a plain negate next to an exempt one is still blocked
  assert.equal(negateBlockedByMassive(true, [...exempt, { effect_kind: "negate_action" }]), true);
});

t("phase 0 verdict: which accepted candidates survive", () => {
  const plain = [{ effect_kind: "negate_action" }];
  const exempt = [{ effect_kind: "negate_action", negate_is_cost_failure: true }];
  assert.equal(phase0NegateVerdict(true, plain), "refused");
  assert.equal(phase0NegateVerdict(false, plain), "negate");
  assert.equal(phase0NegateVerdict(true, exempt), "negate");
  assert.equal(phase0NegateVerdict(true, [{ effect_kind: "apply_status" }]), "none");
  assert.equal(phase0NegateVerdict(null, undefined), "none");
  // survivors = candidates not "refused" (mirrors card-mutations Phase 0 filtering)
  const cands = [{ id: "shadow", rows: plain }, { id: "pressure", rows: exempt }, { id: "other", rows: [] }];
  const survivors = cands.filter((c) => phase0NegateVerdict(true, c.rows) !== "refused").map((c) => c.id);
  assert.deepEqual(survivors, ["pressure", "other"]);
});

// ── Nox Servant exclusion ───────────────────────────────────────────────────
const nox = pc("nox");
const isNox = (a) => a?.id === "nox";
const joinArgs = { combatants: [boss, hina, keren, nox], targets: [tgt(hina)], attackerActorUuid: boss.actorDoc.uuid, isSummonCombatant };

t("nox: Servant gets no join card; normal ally does", () => {
  assert.deepEqual(names(selectMassiveJoiners({ ...joinArgs, isNoxServant: isNox })), ["keren"]);
});
t("nox control: no predicate / false predicate keeps the Servant", () => {
  assert.deepEqual(names(selectMassiveJoiners(joinArgs)), ["keren", "nox"]);
  assert.deepEqual(names(selectMassiveJoiners({ ...joinArgs, isNoxServant: () => false })), ["keren", "nox"]);
});
t("nox: a throwing predicate fails closed (no card, no throw)", () => {
  const got = selectMassiveJoiners({ ...joinArgs, isNoxServant: () => { throw new Error("x"); } });
  assert.deepEqual(names(got), []);
});
t("nox gate: Massive skill / weapon filters the Servant; non-Massive keeps both", () => {
  const pool = [{ id: "nox" }, { id: "hina" }];
  const o = { isNoxServant: isNox, actorOf: (e) => e };
  const ids = (l) => l.map((e) => e.id);
  assert.deepEqual(ids(applyNoxMassiveGate(pool, { ...o, action: { system: { props: { action_keywords: "massive" } } } })), ["hina"]);
  assert.deepEqual(ids(applyNoxMassiveGate(pool, { ...o, action: { system: { props: { action_keywords: "multi" } } } })), ["nox", "hina"]);
  assert.deepEqual(ids(applyNoxMassiveGate(pool, { ...o, weapon: { system: { props: { action_keywords: "massive" } } } })), ["hina"]);
  assert.deepEqual(ids(applyNoxMassiveGate(pool, { action: { system: { props: { action_keywords: "massive" } } } })), ["nox", "hina"]);
  assert.deepEqual(ids(applyNoxMassiveGate(pool, { ...o, isNoxServant: () => { throw new Error("x"); }, action: { system: { props: { action_keywords: "massive" } } } })), []);
});
t("nox strip: removes the Servant, keeps the rest; only-Servant leaves 0", () => {
  const isNoxT = (t) => t.tokenUuid === nox.tokenUuid;
  const ar = { targets: [{ ...tgt(nox), name: "nox" }, tgt(hina)], perTargetResults: [{ tokenUuid: nox.tokenUuid }, { tokenUuid: hina.tokenUuid }] };
  const r = stripNoxServantsFromMassive(ar, isNoxT);
  assert.deepEqual(r.removed, ["nox"]);
  assert.equal(r.remaining, 1);
  assert.equal(ar.targets.length, 1);
  assert.equal(ar.perTargetResults.length, 1);
  const only = { targets: [{ ...tgt(nox), name: "nox" }] };
  assert.equal(stripNoxServantsFromMassive(only, isNoxT).remaining, 0);
  const none = { targets: [tgt(hina)] };
  assert.deepEqual(stripNoxServantsFromMassive(none, isNoxT), { removed: [], remaining: 1 });
});

// CONFIRM backstop on a FROZEN actionResult (freezeActionResult deep-freezes ctx.actionResult).
const deepFreeze = (o) => { if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; };
t("nox strip COPY: frozen input is not mutated; copy drops the Servant; only-Servant => remaining 0 (CONFIRM aborts)", () => {
  const isNoxT = (t) => t.tokenUuid === nox.tokenUuid;
  const frozen = deepFreeze({ targets: [{ ...tgt(nox), name: "nox" }, tgt(hina)], perTargetResults: [{ tokenUuid: nox.tokenUuid }, { tokenUuid: hina.tokenUuid }], targetTokenUuids: [nox.tokenUuid, hina.tokenUuid] });
  assert.throws(() => stripNoxServantsFromMassive(frozen, isNoxT), TypeError);   // the old in-place strip cannot run on a frozen result
  const r = stripNoxServantsFromMassiveCopy(frozen, isNoxT);
  assert.deepEqual(r.removed, ["nox"]); assert.equal(r.remaining, 1);
  assert.equal(r.ar.targets.length, 1); assert.equal(r.ar.perTargetResults.length, 1); assert.deepEqual(r.ar.targetTokenUuids, [hina.tokenUuid]);
  assert.equal(frozen.targets.length, 2);                 // input untouched
  assert.notEqual(r.ar, frozen);
  const only = deepFreeze({ targets: [{ ...tgt(nox), name: "nox" }] });
  assert.equal(stripNoxServantsFromMassiveCopy(only, isNoxT).remaining, 0);
  const none = deepFreeze({ targets: [tgt(hina)] });
  const rn = stripNoxServantsFromMassiveCopy(none, isNoxT);
  assert.equal(rn.ar, none); assert.deepEqual(rn.removed, []);
});

console.log(`${n} passed`);
