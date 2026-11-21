// node scripts/battle-director/target-insert-guard.test.mjs
import assert from "node:assert/strict";
globalThis.CONFIG ??= { statusEffects: [] };   // snapshot.js reads CONFIG while parsing blocks
const { canInsertTarget, isActionPerformer, insertionOpponentRule, dropBlockedInsertions, insertionTargetIsReactor, actionIsHarmful } = await import("./target-insert-guard.js");
//, isActionPerformer, insertionOpponentRule } from "./target-insert-guard.js";

let n = 0;
const t = (name, fn) => { fn(); n++; console.log("  ok", name); };
const actor = (uuid, name, value) => ({
  uuid, name,
  appliedEffects: value ? [{ name: "Out of Play", disabled: false, changes: [{ key: "cannot_be_targeted_by", mode: 5, value }] }] : [],
});
const ar = { attackerActorRef: "Actor.atk", attacker: { tokenUuid: "Tok.atk" } };

t("Guest (any block) is refused with a reason", () => {
  const r = canInsertTarget(actor("Actor.k", "Kalina", "any"), ar);
  assert.equal(r.ok, false); assert.match(r.reason, /Kalina/);
});
t("normal ally ok", () => assert.equal(canInsertTarget(actor("Actor.a", "Hina"), ar).ok, true));
t("melee-only block is not unconditional: ok", () => assert.equal(canInsertTarget(actor("Actor.g", "Guard", "melee"), ar).ok, true));
t("performer-self ok even with any (by actor uuid)", () => assert.equal(canInsertTarget(actor("Actor.atk", "Guest", "any"), ar).ok, true));
t("performer-self ok by token uuid", () => assert.equal(canInsertTarget(actor("Actor.x", "G", "any"), ar, { tokenUuid: "Tok.atk" }).ok, true));
t("missing performer still refuses a Guest", () => assert.equal(canInsertTarget(actor("Actor.k", "K", "any"), {}).ok, false));
t("missing actor refused (fail closed)", () => assert.equal(canInsertTarget(null, ar).ok, false));
t("isActionPerformer false without refs", () => assert.equal(isActionPerformer(actor("Actor.a", "A"), {}), false));

// ── B5: Nox Servant ──
const NS = "fabula-ultima-companion";
const servant = (uuid, name, disp = 1) => ({
  uuid, name, prototypeToken: { disposition: disp }, effects: [{ name: "Nox Servant", disabled: false, flags: { [NS]: { noxServant: true } },
    changes: [{ key: "cannot_be_targeted_by", mode: 5, value: "opponent" }] }],
  appliedEffects: [{ name: "Nox Servant", disabled: false, changes: [{ key: "cannot_be_targeted_by", mode: 5, value: "opponent" }] }],
});
const perf = (uuid, disp) => ({ uuid, name: uuid, prototypeToken: { disposition: disp }, effects: [], appliedEffects: [] });
const enemyPerf = perf("Actor.boss", -1), allyPerf = perf("Actor.pc", 1);
const harmful = { attackerActorRef: "Actor.boss", attacker: { disposition: -1 }, kind: "Attack" };
const allyHarm = { attackerActorRef: "Actor.pc", attacker: { disposition: 1 }, kind: "Attack" };
const allyHeal = { attackerActorRef: "Actor.pc", attacker: { disposition: 1 }, kind: "Skill", actionIntent: "aid" };
const oppSupport = { attackerActorRef: "Actor.boss", attacker: { disposition: -1 }, kind: "Skill", actionIntent: "aid" };
const S = servant("Actor.s", "Servant");

t("actionIsHarmful", () => {
  assert.equal(actionIsHarmful({ kind: "Attack" }), true);
  assert.equal(actionIsHarmful({ kind: "Skill", hasDamage: true }), true);
  assert.equal(actionIsHarmful({ kind: "Skill", hasDamage: true, actionIntent: "aid" }), false);
  assert.equal(actionIsHarmful({ kind: "Skill" }), false);
});
t("Servant vs opponent harmful: refused", () => assert.equal(canInsertTarget(S, harmful, { performerActor: enemyPerf }).ok, false));
t("Servant vs ally harmful: refused", () => assert.equal(canInsertTarget(S, allyHarm, { performerActor: allyPerf }).ok, false));
t("Servant, ally support: ok", () => assert.equal(canInsertTarget(S, allyHeal, { performerActor: allyPerf }).ok, true));
t("Servant, opponent support: refused", () => assert.equal(canInsertTarget(S, oppSupport, { performerActor: enemyPerf }).ok, false));
t("Servant, unknown performer: refused (fail closed)", () => assert.equal(canInsertTarget(S, { kind: "Skill", actionIntent: "aid" }).ok, false));
t("normal ally Protect vs harmful: ok", () => assert.equal(canInsertTarget(perf("Actor.h", 1), harmful, { performerActor: enemyPerf }).ok, true));
t("Servant's OWN harmful action reflected onto itself (Mirror): refused (rule before the performer carve-out)", () => {
  assert.equal(canInsertTarget(S, { attackerActorRef: "Actor.s", kind: "Attack" }).ok, false);
  assert.equal(canInsertTarget(S, { attackerActorRef: "Actor.s", attacker: { tokenUuid: "Tok.s" }, kind: "Skill", hasDamage: true }, { tokenUuid: "Tok.s" }).ok, false);
});
t("Servant performing its own SUPPORT action onto itself: ok", () => assert.equal(canInsertTarget(S, { attackerActorRef: "Actor.s", kind: "Skill", actionIntent: "aid" }).ok, true));
t("Kalina (any block) as performer keeps the carve-out", () => assert.equal(canInsertTarget(actor("Actor.atk", "Kalina", "any"), { ...ar, kind: "Attack" }).ok, true));
t("Kalina still refused", () => assert.equal(canInsertTarget(actor("Actor.k", "Kalina", "any"), allyHeal).ok, false));

const protectTable = {
  0: { effect_label: "protect_redirect", effect_kind: "redirect_target", destination_ref: "protect_self", target_ref: "protect_incoming" },
  1: { effect_label: "protect_self", effect_kind: "targeting", candidate_source: "self" },
  2: { effect_label: "protect_incoming", effect_kind: "targeting", candidate_source: "action_targets" },
  3: { effect_label: "protect_react", effect_kind: "chain", chain_steps: "protect_redirect" },
};
const tormentTable = { 0: { effect_label: "torment", effect_kind: "redirect_target", destination_ref: "pick", target_ref: "x" }, 1: { effect_label: "pick", effect_kind: "targeting", candidate_source: "combat_ally" } };
const joinTable = { 0: { effect_label: "j", effect_kind: "add_target", target_ref: "self" } };
t("insertionTargetIsReactor", () => {
  assert.equal(insertionTargetIsReactor(protectTable[0], Object.values(protectTable)), true);
  assert.equal(insertionTargetIsReactor(tormentTable[0], Object.values(tormentTable)), false);
  assert.equal(insertionTargetIsReactor(joinTable[0], Object.values(joinTable)), true);
});
const tables = { P: protectTable, T: tormentTable, J: joinTable };
const deps = {
  readCandidateEffectTable: async (c) => tables[c.tbl],
  expandCandidateEffectChain: (tbl, ref) => {
    const rows = Object.values(tbl); const by = new Map(rows.map((r) => [r.effect_label, r])); const out = [];
    (function w(l) { const r = by.get(l); if (!r) return; if (r.effect_kind === "chain") r.chain_steps.split(",").map((x) => x.trim()).forEach(w); else out.push(r); })(ref);
    return out;
  },
};
const reactors = { "Actor.s": S, "Actor.h": perf("Actor.h", 1) };
globalThis.fromUuid = async (u) => reactors[u] ?? null;
const cands = () => [
  { tbl: "P", ref: "protect_react", reactorActorUuid: "Actor.s", carrierName: "SvProtect" },
  { tbl: "P", ref: "protect_react", reactorActorUuid: "Actor.h", carrierName: "HinaProtect" },
  { tbl: "T", ref: "torment", reactorActorUuid: "Actor.s", carrierName: "SvTorment" },
  { tbl: "J", ref: "j", reactorActorUuid: "Actor.s", carrierName: "SvJoin" },
];
const run = async (a, a2) => { const c = cands(); await dropBlockedInsertions({ ...a, ...(a2 ?? {}) }, c, deps); return c.map((x) => x.carrierName); };
await (async () => {
  // performer resolution via fromUuidSync
  globalThis.fromUuidSync = (u) => ({ "Actor.boss": enemyPerf, "Actor.pc": allyPerf })[u] ?? null;
  assert.deepEqual(await run(harmful), ["HinaProtect", "SvTorment"]); n++; console.log("  ok Servant Protect/join dropped vs opponent harmful; normal kept; pick-dest kept");
  assert.deepEqual(await run(allyHarm), ["HinaProtect", "SvTorment"]); n++; console.log("  ok Servant Protect dropped vs ally harmful");
  assert.deepEqual(await run(allyHeal), ["SvProtect", "HinaProtect", "SvTorment", "SvJoin"]); n++; console.log("  ok ally support: all kept");
  delete globalThis.fromUuidSync;
  assert.deepEqual(await run({ kind: "Skill", actionIntent: "aid" }), ["HinaProtect", "SvTorment"]); n++; console.log("  ok unknown performer: Servant offers dropped");
})();
console.log(`${n} passed`);
