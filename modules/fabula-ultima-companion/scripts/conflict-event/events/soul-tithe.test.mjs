// Bare-Node harness for Soul Tithe's pure rules.
//   node scripts/conflict-event/events/soul-tithe.test.mjs
import { callingSteal, resolveCalling, lockWound, returnedHp, fragmentMayCall, fragmentName, MAX_HP_FLOOR, planDestroy, REFUND, servantTear, servantStep, noxSubjectKeys, nextNoxZeroPower, grantNoxZeroPower, woundedFragmentHp } from "./soul-tithe.js";
import { getConflictEvent } from "../conflict-event-registry.js";
import { isPermanentSoulFragment } from "../../battle-director/battlefield-object.js";

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) pass++; else { fail++; console.error(`FAIL ${name}`); } }
const eq = (name, a, b) => ok(`${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`, JSON.stringify(a) === JSON.stringify(b));

// One full round end, in the event's order: Calling, then the lock.
function roundEnd(s, { mayCall = true } = {}) {
  let { max, hp, fHp, fMax } = s;
  if (mayCall && fHp > 0 && hp > 0) {
    const r = resolveCalling({ ownerMax: max, ownerHp: hp, fragmentHp: fHp, fragmentMax: fMax });
    ({ ownerMax: max, ownerHp: hp, fragmentHp: fHp, fragmentMax: fMax } = r);
  }
  const w = lockWound({ ownerMax: max, ownerHp: hp });
  return { max: max - w, hp, fHp: fHp + w, fMax: fMax + w };
}

// The lock
eq("lock: wounded", lockWound({ ownerMax: 120, ownerHp: 90 }), 30);
eq("lock: full HP", lockWound({ ownerMax: 120, ownerHp: 120 }), 0);
eq("lock: KO'd is skipped", lockWound({ ownerMax: 120, ownerHp: 0 }), 0);
eq("lock: 1 HP leaves the floor", lockWound({ ownerMax: 120, ownerHp: 1 }), 119);

// Calling: the settled numbers from the design talk
eq("steal = fragment current HP", callingSteal({ fragmentHp: 30, ownerMax: 90 }), 30);
eq("steal stops at the floor", callingSteal({ fragmentHp: 60, ownerMax: 60 }), 60 - MAX_HP_FLOOR);
eq("nothing left to steal", callingSteal({ fragmentHp: 60, ownerMax: 1 }), 0);
eq("adds the stolen amount, does not heal to full",
  resolveCalling({ ownerMax: 60, ownerHp: 60, fragmentHp: 10, fragmentMax: 60 }),
  { stolen: 10, ownerMax: 50, ownerHp: 50, fragmentHp: 20, fragmentMax: 70 });
eq("the stolen amount takes missing HP first",
  resolveCalling({ ownerMax: 90, ownerHp: 70, fragmentHp: 30, fragmentMax: 30 }).ownerHp, 60);

// Hina, 120 HP, one 30-damage hit, fragment ignored: 30 -> 60 -> 119, she ends 1/1.
let s = { max: 120, hp: 90, fHp: 0, fMax: 0 };
s = roundEnd(s, { mayCall: false });
eq("end of round 1", s, { max: 90, hp: 90, fHp: 30, fMax: 30 });
s = roundEnd(s);
eq("end of round 2", s, { max: 60, hp: 60, fHp: 60, fMax: 60 });
s = roundEnd(s);
eq("end of round 3", s, { max: 1, hp: 1, fHp: 119, fMax: 119 });
eq("the invariant: fragment Max is all that was stolen", s.fMax, 120 - s.max);
s = roundEnd(s);
eq("end of round 4: nothing left, nothing changes", s, { max: 1, hp: 1, fHp: 119, fMax: 119 });

// Wound and Calling overlap: the player loses the larger, not both.
let w = roundEnd({ max: 90, hp: 70, fHp: 30, fMax: 30 });
eq("wound 20 < Calling 30: loses 30", w, { max: 60, hp: 60, fHp: 60, fMax: 60 });
w = roundEnd({ max: 90, hp: 40, fHp: 30, fMax: 30 });
eq("wound 50 > Calling 30: loses 50", w, { max: 40, hp: 40, fHp: 80, fMax: 80 });
eq("the invariant holds with a wound", w.fMax, 120 - w.max);
w = roundEnd({ max: 90, hp: 70, fHp: 20, fMax: 30 });
eq("a chipped fragment steals less", w, { max: 70, hp: 70, fHp: 40, fMax: 50 });
eq("the invariant holds when chipped", w.fMax, 120 - w.max);

// Lock wound on an overflowed fragment (Soul Confluence): the overflow survives.
eq("lock: 300/100 + wound 20 keeps the overflow", woundedFragmentHp({ hp: 300, oldMax: 100, wound: 20, max: 120 }), 320);
eq("lock: ordinary wound still capped at the new Max", woundedFragmentHp({ hp: 30, oldMax: 30, wound: 30, max: 60 }), 60);
eq("lock: a chipped fragment adds the wound", woundedFragmentHp({ hp: 10, oldMax: 30, wound: 20, max: 50 }), 30);
eq("lock: Calling on an overflow still steals up to owner Max-1", resolveCalling({ ownerMax: 200, ownerHp: 200, fragmentHp: 300, fragmentMax: 100 }).stolen, 199);
eq("lock: 300/100 vs a 500-Max owner", resolveCalling({ ownerMax: 500, ownerHp: 500, fragmentHp: 300, fragmentMax: 100 }),
  { stolen: 300, ownerMax: 200, ownerHp: 200, fragmentHp: 600, fragmentMax: 400 });

// Destroying it
eq("return: Max and HP both come back", returnedHp({ ownerHp: 1, ownerMax: 120, stolen: 119 }), 120);
eq("return: a fresh wound stays a wound", returnedHp({ ownerHp: 50, ownerMax: 120, stolen: 40 }), 90);
eq("return: capped at Max", returnedHp({ ownerHp: 110, ownerMax: 120, stolen: 40 }), 120);
eq("return: a KO'd owner stays down", returnedHp({ ownerHp: 0, ownerMax: 120, stolen: 40 }), 0);

// Timing
ok("a new fragment does not Call", !fragmentMayCall({ spawnRound: 3, calledRound: 0, round: 3 }));
ok("it Calls the round after", fragmentMayCall({ spawnRound: 3, calledRound: 0, round: 4 }));
ok("once a round, even after an F5", !fragmentMayCall({ spawnRound: 3, calledRound: 4, round: 4 }));
eq("name", fragmentName("Hina"), "Hina's Soul Fragment");

// destroy: show=none skips the show only; the refund mode is untouched
eq("destroy default: show, full", planDestroy({}), { raw: "full", mode: "full", show: true });
eq("destroy refund=max_only keeps the show", planDestroy({ options: { refund: "max_only" } }), { raw: "max_only", mode: "max_only", show: true });
eq("destroy show=none: no show, same refund", planDestroy({ options: { refund: "max_only", show: "none" } }), { raw: "max_only", mode: "max_only", show: false });
eq("destroy show=none alone: full refund", planDestroy({ options: { show: " NONE " } }).mode, REFUND.FULL);
ok("destroy show=none alone: no show", planDestroy({ options: { show: "none" } }).show === false);
ok("destroy other show value keeps the show", planDestroy({ options: { show: "yes" } }).show === true);
ok("destroy show arg works like the option", planDestroy({ show: "none" }).show === false);
ok("destroy unknown refund still refused", planDestroy({ options: { refund: "bogus", show: "none" } }).mode === null);

// The row text -> options (skill-effects needs Foundry globals to load; stub them)
{
  globalThis.Hooks ??= { on() {}, once() {} };
  globalThis.PIXI ??= new Proxy(function () {}, { get: () => function () {} });
  const inert = () => new Proxy(function () {}, { get: () => inert });
  globalThis.document ??= inert();
  try {
    const { parseConflictActionText } = await import("../../battle-director/skill-effects.js");
    const p = parseConflictActionText("destroy refund=max_only show=none");
    eq("parse: action", p.action, "destroy");
    eq("parse: options.show", p.options.show, "none");
    eq("parse: options.refund", p.options.refund, "max_only");
    eq("parse: bare name", parseConflictActionText("destroy"), { action: "destroy", options: {} });
    eq("parse -> plan", planDestroy({ options: p.options }), { raw: "max_only", mode: "max_only", show: false });
  } catch (e) { ok(`parse test could not load skill-effects: ${e.message}`, false); }
}

// The Nox Servant's permanent fragment (B7)
eq("servantTear full", servantTear({ ownerMax: 120, ownerHp: 120 }), { stolen: 119, ownerMax: 1, ownerHp: 1 });
eq("servantTear hurt", servantTear({ ownerMax: 60, ownerHp: 10 }), { stolen: 59, ownerMax: 1, ownerHp: 1 });
eq("servantTear KO'd stays 0", servantTear({ ownerMax: 60, ownerHp: 0 }), { stolen: 59, ownerMax: 1, ownerHp: 0 });
eq("servantTear at the floor", servantTear({ ownerMax: 1, ownerHp: 1 }), { stolen: 0, ownerMax: 1, ownerHp: 1 });
eq("servantTear missing", servantTear(), { stolen: 0, ownerMax: 0, ownerHp: 0 });
eq("servantTear negative max", servantTear({ ownerMax: -5, ownerHp: 3 }), { stolen: 0, ownerMax: 0, ownerHp: 0 });
for (const m of [1, 2, 30, 120, 999]) eq("servantTear = callingSteal " + m, servantTear({ ownerMax: m, ownerHp: m }).stolen, callingSteal({ fragmentHp: m, ownerMax: m }));
eq("a Max-1 Servant's Calling steals 0 (nominal doubling)",
  resolveCalling({ ownerMax: 1, ownerHp: 1, fragmentHp: 119, fragmentMax: 119 }),
  { stolen: 0, ownerMax: 1, ownerHp: 1, fragmentHp: 119, fragmentMax: 119 });
ok("re-torn fragment does not Call that round", !fragmentMayCall({ spawnRound: 4, calledRound: 0, round: 4 }));
ok("re-torn fragment Calls next round", fragmentMayCall({ spawnRound: 4, calledRound: 0, round: 5 }));
{ // devour (max_only: Max back, HP untouched) then the round-end re-tear
  const afterDevour = { max: 120, hp: 1 };
  const t = servantTear({ ownerMax: afterDevour.max, ownerHp: afterDevour.hp });
  eq("devour then re-tear: Max 1 / HP 1, fragment 119", { max: t.ownerMax, hp: t.ownerHp, frag: t.stolen }, { max: 1, hp: 1, frag: 119 });
}
// Round-end step decisions
eq("step: none standing -> tear", servantStep({ hasFragment: false, ownerMax: 120, ownerHp: 120 }), "tear");
eq("step: ordinary standing -> mark", servantStep({ hasFragment: true, fragmentPermanent: false, ownerMax: 90, ownerHp: 90 }), "mark");
eq("step: permanent standing -> keep", servantStep({ hasFragment: true, fragmentPermanent: true, ownerMax: 1, ownerHp: 1 }), "keep");
eq("step: KO'd owner waits", servantStep({ hasFragment: false, ownerMax: 120, ownerHp: 0 }), "wait");
eq("step: KO'd owner tears when tearDown (the trigger)", servantStep({ hasFragment: false, ownerMax: 120, ownerHp: 0, tearDown: true }), "tear");
eq("step: Max 1, no fragment -> wait", servantStep({ hasFragment: false, ownerMax: 1, ownerHp: 1 }), "wait");
// isPermanentSoulFragment (leaf reader)
const NS = "fabula-ultima-companion";
const mk = (f) => ({ effects: [{ flags: { [NS]: f } }] });
ok("permanent mark -> true", isPermanentSoulFragment(mk({ soulFragmentMark: true, soulPermanent: true })));
ok("ordinary mark -> false", !isPermanentSoulFragment(mk({ soulFragmentMark: true })));
ok("flag without mark -> false", !isPermanentSoulFragment(mk({ soulPermanent: true })));
ok("Foundry collection shape", isPermanentSoulFragment({ effects: { contents: [{ flags: { [NS]: { soulFragmentMark: true, soulPermanent: true } } }] } }));
ok("null / no effects -> false", !isPermanentSoulFragment(null) && !isPermanentSoulFragment({}));


// noxServant action: subject resolution + failure reporting (returns false => the chain stops)
{
  const k1 = noxSubjectKeys({ tokens: [{ id: "T1" }, { document: { id: "T2" } }], effectCtx: { payload: { subjectActorUuid: "Actor.a" } } });
  ok("keys: tokens win, no actor fallback", k1.ids.has("T1") && k1.ids.has("T2") && k1.actorUuids.size === 0);
  const k2 = noxSubjectKeys({ tokens: [], effectCtx: { payload: { subjectActorUuid: "Actor.a", subjectTokenUuid: null } } });
  ok("keys: empty tokens -> subjectActorUuid", k2.ids.size === 0 && k2.actorUuids.has("Actor.a"));
  const k3 = noxSubjectKeys({});
  ok("keys: nothing -> empty", k3.ids.size === 0 && k3.actorUuids.size === 0);

  const act = getConflictEvent("soul-tithe")?.actions?.noxServant;
  ok("noxServant action registered", typeof act === "function");
  const mkCtx = (over = {}) => ({ dCombat: { round: 2, combatants: [], ended: false }, warn() {}, log() {}, ...over });
  ok("ended conflict -> false", (await act(mkCtx({ dCombat: { ended: true, combatants: [] } }), { tokens: [{ id: "T1" }] })) === false);
  ok("no dCombat -> false", (await act(mkCtx({ dCombat: null }), { tokens: [{ id: "T1" }] })) === false);
  ok("no subject at all -> false", (await act(mkCtx(), { tokens: [] })) === false);
  ok("empty token list, actor uuid names nobody in the party -> false", (await act(mkCtx(), { tokens: [], effectCtx: { payload: { subjectActorUuid: "Actor.zz" } } })) === false);
  const guest = { side: "party", actorDoc: { uuid: "Actor.g", flags: { "fabula-ultima-companion": { bdGuest: true } }, system: { props: {} } }, tokenDoc: { id: "TG" } };
  ok("a guest subject is not a player -> false", (await act(mkCtx({ dCombat: { round: 1, ended: false, combatants: [guest] } }), { tokens: [{ id: "TG" }] })) === false);
}

// Nox Servant's +1 Zero Power (granted by the action after a REAL conversion)
{
  eq("zp: 0 -> 1", nextNoxZeroPower(0, 1), 1);
  eq("zp: clamps at the hard cap 6", nextNoxZeroPower(6, 1), 6);
  eq("zp: 5 + 3 -> 6", nextNoxZeroPower(5, 3), 6);
  eq("zp: never lowers a total above the cap", nextNoxZeroPower(8, 1), 8);
  const writes = [];
  const nid = { system: { props: { zero_power_value: 2 } }, update: async (u) => { writes.push(u); } };
  globalThis.game = { user: { isGM: true } };
  eq("grant: 2 -> 3 written", await grantNoxZeroPower(nid, 1), 3);
  eq("grant: write shape", writes, [{ "system.props.zero_power_value": 3 }]);
  eq("grant: n=0 writes nothing", await grantNoxZeroPower(nid, 0), null);
  eq("grant: no reactor writes nothing", await grantNoxZeroPower(null, 1), null);
  globalThis.game = { user: { isGM: false } };
  eq("grant: non-GM writes nothing", await grantNoxZeroPower(nid, 1), null);
  eq("grant: only one write in total", writes.length, 1);
  // not converted (no subject / not a player) -> false and ZP untouched
  const act2 = getConflictEvent("soul-tithe")?.actions?.noxServant;
  globalThis.game = { user: { isGM: true } };
  const writes2 = [];
  const nid2 = { system: { props: { zero_power_value: 2 } }, update: async (u) => { writes2.push(u); } };
  const r = await act2({ dCombat: { round: 1, ended: false, combatants: [] }, warn() {}, log() {} }, { tokens: [{ id: "T9" }], effectCtx: { reactorActor: nid2 } });
  ok("not converted: false and no Zero Power written", r === false && writes2.length === 0);
}

// conflict_event_action row: no event / no handler -> ok:true skipped (a chain runs on); handler false -> ok:false
{
  const { applyEffectRow } = await import("../../battle-director/skill-effects.js");
  const { registerConflictEvent, clearConflictEvents } = await import("../conflict-event-registry.js");
  globalThis.game = { user: { isGM: true } };
  const row = { effect_kind: "conflict_event_action", effect_label: "x", target_ref: "self", conflict_action: "imp_mask" };
  const scene = { flags: { "fabula-ultima-companion": { oniFabula: { general: { sceneMode: "conflict", conflictEvent: "t-ev" } } } } };
  const dir = { ctx: {}, dCombat: { scene, started: true } };
  const ectx = { director: dir, reactorActor: null, payload: {}, dCombat: dir.dCombat, tokens: [], skill: null };
  const bare = { director: { ctx: {}, dCombat: { scene: {}, started: true } }, payload: {}, dCombat: { scene: {} } };
  const r0 = await applyEffectRow(row, bare);
  ok("no event in play -> ok:true skipped", r0?.ok === true && r0?.skipped === true);
  clearConflictEvents();
  registerConflictEvent({ id: "t-ev", label: "T", onConflictStart() {}, actions: { fails: async () => false, works: async () => true } }, { warn() {} });
  const r1 = await applyEffectRow({ ...row, conflict_action: "imp_mask" }, ectx);
  ok("event without that action -> ok:true skipped", r1?.ok === true && r1?.skipped === true);
  const r2 = await applyEffectRow({ ...row, conflict_action: "fails" }, ectx);
  ok("handler returned false -> ok:false", r2?.ok === false);
  const r3 = await applyEffectRow({ ...row, conflict_action: "works" }, ectx);
  ok("handler ran -> ok:true, applied", r3?.ok === true && r3?.applied?.[0] === "works");
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
