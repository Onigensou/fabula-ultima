// Army of the Damned S2: armyGrantPlan + the armyOfTheDamned action + revoke on his fall.
//   node scripts/conflict-event/events/soul-tithe-army.test.mjs
// Real DirectorCombat, stand-in fragment documents (no Foundry).
globalThis.Hooks = { on() {}, once() {}, callAll() {}, off() {} };
globalThis.canvas = { scene: null, tokens: { placeables: [] } };
globalThis.ui = { notifications: { warn() {}, info() {}, error() {} } };
globalThis.CONFIG = {};
globalThis.foundry = { utils: { randomID: () => "t-" + Math.random().toString(36).slice(2) } };
globalThis.game = { user: { isGM: false }, combat: null, items: [], scenes: { contents: [], current: null },
  modules: { get: () => ({ api: {} }) }, settings: { get: () => null, set: () => {} } };

const { armyGrantPlan, ARMY_PRIORITY, revokeArmyGrants } = await import("./soul-tithe.js");
const { getConflictEvent } = await import("../conflict-event-registry.js");
const { DirectorCombat, DirectorCombatant } = await import("../../battle-director/director-combat.js");

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.error(`FAIL ${n}`); } };
const eq = (n, a, b) => ok(`${n} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`, JSON.stringify(a) === JSON.stringify(b));
const NS = "fabula-ultima-companion";

// -- pure plan --
ok("priority constant", ARMY_PRIORITY === 10);
const L = [
  { id: "a", hp: 10, turnsRemaining: 0, grantedRound: null },
  { id: "b", hp: 0, turnsRemaining: 0, grantedRound: null },     // dead
  { id: "c", hp: 5, turnsRemaining: 1, grantedRound: null },        // already holds a turn
  { id: "d", hp: 5, turnsRemaining: 0, grantedRound: 3 },        // granted this round
  { id: "e", hp: 7, turnsRemaining: 0, grantedRound: 2 },        // older stamp
];
eq("plan: HP>0, no turn, not granted this round", armyGrantPlan(L, 3).grant, ["a", "e"]);
eq("plan: empty roster", armyGrantPlan([], 3).grant, []);
eq("plan: re-run after grant = empty", armyGrantPlan(L.map((f) => (["a", "e"].includes(f.id) ? { ...f, turnsRemaining: 1, grantedRound: 3 } : f)), 3).grant, []);
eq("plan: spent this round (grantedRound==round) = empty", armyGrantPlan([{ id: "a", hp: 9, turnsRemaining: 0, grantedRound: 3 }], 3).grant, []);
eq("plan: Free Round 0, never stamped (null) = grants", armyGrantPlan([{ id: "a", hp: 9, turnsRemaining: 0, grantedRound: null }], 0).grant, ["a"]);
eq("plan: round 0 already stamped 0 = empty", armyGrantPlan([{ id: "a", hp: 9, turnsRemaining: 0, grantedRound: 0 }], 0).grant, []);

// -- world --
let n = 0;
function makeActor(name, { hp, fragment = false, permanent = false, calledRound = 0 }) {
  const a = { name, uuid: `Actor.${name}`, flags: fragment ? { [NS]: { conflictObject: "soul-fragment" } } : {}, effects: [], _hp: hp,
    system: { props: { get current_hp() { return a._hp; }, max_hp: 50, npc_rank: "" } },
    appliedEffects: [],
    async update() {}, async createEmbeddedDocuments() {} };
  if (fragment) a.effects.push({ id: "m" + (++n), name: "Soul Fragment", flags: { [NS]: { soulFragmentMark: true, soulSpawnRound: 1, soulCalledRound: calledRound, soulReturned: false, ...(permanent ? { soulPermanent: true } : {}) } }, update: async () => {} });
  return a;
}
function makeWorld(round = 2) {
  const scene = { id: "sc", tokens: { contents: [], get(id) { return this.contents.find((t) => t.id === id) ?? null; } } };
  const dc = new DirectorCombat({ scene: { id: "S", name: "S" } });
  dc.engagement = "normal"; dc.firstSide = "enemy";
  const logs = [];
  const ctx = { dCombat: dc, scene, director: null, log: (m) => logs.push(m), warn: (m) => logs.push(`WARN ${m}`) };
  scene.deleteEmbeddedDocuments = async (_t, ids) => {
    scene.tokens.contents = scene.tokens.contents.filter((t) => !ids.includes(t.id));
    for (const c of [...dc.combatants]) if (ids.includes(c.tokenDoc?.id)) dc.removeCombatant(c);
  };
  const add = (name, side, actor, flags = {}, turns = 1) => {
    const td = { id: "tk" + (++n), actor, flags: { [NS]: flags }, parent: scene, texture: {}, getFlag: () => undefined };
    td.uuid = `Scene.sc.Token.${td.id}`;
    scene.tokens.contents.push(td);
    const c = Object.create(DirectorCombatant.prototype);
    Object.assign(c, { id: "c" + (++n), name, side, actorUuid: actor.uuid, tokenUuid: td.uuid, actorDoc: actor, tokenDoc: td,
      turnsPerRound: turns, turnsRemaining: turns, flags: {}, phaseLock: null, turnPriority: null });
    c.isDefeatedLive = () => Number(actor._hp) <= 0;
    dc.combatants.push(c);
    return c;
  };
  const frag = (name, hp, opts = {}) => add(name, "enemy", makeActor(name, { hp, fragment: true, ...opts }), { soulFragmentOwner: `Actor.owner-${name}` }, 0);
  const boss = add("Nidhogg", "enemy", makeActor("Nidhogg", { hp: 999 }));
  const other = add("Minion", "enemy", makeActor("Minion", { hp: 20 }));
  add("Hina", "party", makeActor("Hina", { hp: 80 }));
  dc.start(); dc.round = round;
  for (const c of dc.combatants) c.turnsRemaining = c.turnsPerRound;
  return { ctx, dc, scene, boss, other, frag, logs };
}
const ev = getConflictEvent("soul-tithe");
ok("registry: armyOfTheDamned is a function", typeof ev?.actions?.armyOfTheDamned === "function");
const effectCtxOf = (w) => ({ reactorToken: { id: w.boss.tokenDoc.id } });

{ // grant: standing + permanent, not dead
  const w = makeWorld(2);
  const f1 = w.frag("F1", 10), f2 = w.frag("F2", 12, { permanent: true }), f3 = w.frag("F3", 5), dead = w.frag("D", 0);
  const r = await ev.actions.armyOfTheDamned(w.ctx, { effectCtx: effectCtxOf(w) });
  ok("grant: returns true", r === true);
  ok("grant: normal and permanent got 1 turn", f1.turnsRemaining === 1 && f2.turnsRemaining === 1 && f3.turnsRemaining === 1);
  ok("grant: priority stamped", f1.turnPriority?.round === 2 && f1.turnPriority?.value === ARMY_PRIORITY);
  ok("grant: dead fragment gets none", !w.dc.combatants.includes(dead) || dead.turnsRemaining === 0);
  const elig = w.dc.eligibleOnSide("enemy");
  ok("grant: only fragments eligible (side-wide priority over Nidhogg + Minion)", elig.length >= 3 && elig.every((c) => c.turnPriority?.value === ARMY_PRIORITY));
  const again = await ev.actions.armyOfTheDamned(w.ctx, { effectCtx: effectCtxOf(w) });
  ok("re-run: false, nothing granted twice", again === false && f1.turnsRemaining === 1);
  f1.turnsRemaining = 0;
  ok("spent this round: no re-grant", (await ev.actions.armyOfTheDamned(w.ctx, { effectCtx: effectCtxOf(w) })) === false && f1.turnsRemaining === 0);
  const late = w.frag("Late", 9);
  ok("late-torn fragment (after Army) has no turn", late.turnsRemaining === 0 && !w.dc.eligibleOnSide("enemy").includes(late));
  f2.turnsRemaining = 1; f3.turnsRemaining = 1;
  f2.turnPriority = { round: 2, value: ARMY_PRIORITY }; f3.turnPriority = { round: 2, value: ARMY_PRIORITY };
  const k = revokeArmyGrants(w.ctx);
  ok("revoke: both unplayed grants taken back", k === 2 && f2.turnsRemaining === 0 && f3.turnsRemaining === 0 && f2.turnPriority === null);
  ok("revoke again: nothing left", revokeArmyGrants(w.ctx) === 0);
}
{ // revoke via the real destroyAllFragments (permanent survives, turn gone)
  const w = makeWorld(2);
  const perm = w.frag("P", 10, { permanent: true });
  await ev.actions.armyOfTheDamned(w.ctx, { effectCtx: effectCtxOf(w) });
  ok("pre: permanent holds the Army turn", perm.turnsRemaining === 1);
  await ev.actions.destroyAllFragments(w.ctx);
  ok("destroyAllFragments: permanent kept, Army turn revoked", w.dc.combatants.includes(perm) && perm.turnsRemaining === 0 && !w.dc.eligibleOnSide("enemy").includes(perm));
}
{ // phaseTier passthrough
  const w = makeWorld(2);
  const f = w.frag("F", 10);
  w.dc.speedTierOf = () => 1;
  await ev.actions.armyOfTheDamned(w.ctx, { effectCtx: effectCtxOf(w) });
  ok("phaseTier: fragment locked into Nidhogg's phase", f.phaseLock?.round === 2 && f.phaseLock?.tier === 1);
  const w2 = makeWorld(2); const f2 = w2.frag("F", 10);
  await ev.actions.armyOfTheDamned(w2.ctx, { effectCtx: {} });
  ok("no caster resolved: granted, no phase lock", f2.turnsRemaining === 1 && !f2.phaseLock);
  const w3 = makeWorld(2); const f3 = w3.frag("F", 10);
  await ev.actions.armyOfTheDamned(w3.ctx, { effectCtx: { casterToken: { document: { id: w3.boss.tokenDoc.id } } } });
  ok("casterToken fallback resolves", f3.turnsRemaining === 1);
}
{ // nothing to grant -> false
  const w = makeWorld(2);
  ok("no fragments: false", (await ev.actions.armyOfTheDamned(w.ctx, { effectCtx: effectCtxOf(w) })) === false);
}
{ // eaten fragment takes its granted turn with it
  const w = makeWorld(2);
  const a = w.frag("A", 30, { calledRound: 1 }), b = w.frag("B", 10, { calledRound: 1 });
  await ev.actions.armyOfTheDamned(w.ctx, { effectCtx: effectCtxOf(w) });
  const res = await ev.actions.consumeFragment(w.ctx, { tokens: [], row: { conflict_pick: "largest" }, effectCtx: { payload: {} } });
  ok("eaten: consumeFragment ran", res === true);
  ok("eaten: gone from the roster, no turn left", !w.dc.combatants.includes(a) && !w.dc.eligibleOnSide("enemy").includes(a));
  ok("eaten: the other still holds its turn", w.dc.combatants.includes(b) && b.turnsRemaining === 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
