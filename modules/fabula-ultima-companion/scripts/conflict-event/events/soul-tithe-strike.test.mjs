// Bare-Node harness for Soul Strike (2026-11-27): step 1 rankFragments + planStrike (pure),
// step 2 the strikeFragment action + its F5 repair (finishStrikes, run by sweepDestroyed).
//   node scripts/conflict-event/events/soul-tithe-strike.test.mjs
globalThis.game = { user: { isGM: false } };   // emitBattlefieldObjectTrigger returns at once

const { rankFragments, planStrike, planConfluence, servantStep, setServantPredicate } = await import("./soul-tithe.js");
const { getConflictEvent } = await import("../conflict-event-registry.js");

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) pass++; else { fail++; console.error(`FAIL ${name}`); } }
const eq = (name, a, b) => ok(`${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`, JSON.stringify(a) === JSON.stringify(b));
const ids = (l) => rankFragments(l).map((f) => f.id);

// rankFragments
eq("rank: HP desc", ids([{ id: "a", hp: 50, max: 90, slot: 0 }, { id: "b", hp: 80, max: 60, slot: 1 }]), ["b", "a"]);
eq("rank: HP tie -> Max desc", ids([{ id: "a", hp: 50, max: 60, slot: 0 }, { id: "b", hp: 50, max: 80, slot: 1 }]), ["b", "a"]);
eq("rank: HP+Max tie -> slot asc", ids([{ id: "a", hp: 50, max: 60, slot: 2 }, { id: "b", hp: 50, max: 60, slot: 1 }, { id: "c", hp: 50, max: 60, slot: 3 }]), ["b", "a", "c"]);
eq("rank: missing slot last", ids([{ id: "a", hp: 50, max: 60, slot: -1 }, { id: "b", hp: 50, max: 60, slot: 3 }, { id: "c", hp: 50, max: 60 }]), ["b", "a", "c"]);
eq("rank: empty / null", [ids([]), ids(null)], [[], []]);
const src = [{ id: "a", hp: 1, max: 1, slot: 0 }, { id: "b", hp: 2, max: 1, slot: 1 }];
rankFragments(src);
eq("rank: does not mutate input", src.map((f) => f.id), ["a", "b"]);
eq("confluence still uses the same order", planConfluence([{ id: "a", hp: 50, max: 60, slot: 0 }, { id: "b", hp: 50, max: 80, slot: 1 }])?.recipientId, "b");

// planStrike
const big = [{ id: "a", hp: 310, max: 120, slot: 0 }, { id: "b", hp: 40, max: 40, slot: 1 }];
eq("strike: hit 310/120 destroys", planStrike({ list: big, hit: true }), { fragmentId: "a", amount: 310, loss: 310, newHp: 0, destroys: true });
eq("strike: pierce miss halves (ceil)", planStrike({ list: [{ id: "a", hp: 310, max: 120, slot: 0 }], pierceMiss: true }), { fragmentId: "a", amount: 310, loss: 155, newHp: 155, destroys: false });
eq("strike: odd pierce miss ceil", planStrike({ list: [{ id: "a", hp: 151, max: 120, slot: 0 }], pierceMiss: true }), { fragmentId: "a", amount: 151, loss: 76, newHp: 75, destroys: false });
eq("strike: 1 HP miss -> loss 1, destroys", planStrike({ list: [{ id: "a", hp: 1, max: 5, slot: 0 }], pierceMiss: true }), { fragmentId: "a", amount: 1, loss: 1, newHp: 0, destroys: true });
eq("strike: neither hit nor pierceMiss -> loss 0", planStrike({ list: big }), { fragmentId: "a", amount: 310, loss: 0, newHp: 310, destroys: false });
eq("strike: empty -> null", planStrike({ list: [] }), null);
eq("strike: no args -> null", planStrike(), null);
eq("strike: only dead -> null", planStrike({ list: [{ id: "a", hp: 0, max: 9, slot: 0 }], hit: true }), null);
eq("strike: picks top by rank (tie -> Max)", planStrike({ list: [{ id: "a", hp: 50, max: 60, slot: 0 }, { id: "b", hp: 50, max: 80, slot: 1 }], hit: true })?.fragmentId, "b");
eq("strike: hit on a fragment with low HP ignores dead ones", planStrike({ list: [{ id: "z", hp: 0, max: 99, slot: 0 }, { id: "a", hp: 30, max: 30, slot: 1 }], hit: true })?.fragmentId, "a");

// ── strikeFragment action (stand-in world, the soul-tithe-confluence.test.mjs pattern) ──
const NS = "fabula-ultima-companion";
let nid = 0;
const rid = () => `id${++nid}`;
// Every actor write, in order: { name, fragment, u }. The "never 0 HP" rule is asserted on these.
const WRITES = [];
function setPath(obj, path, v) {
  const ks = path.split(".");
  let o = obj;
  for (const k of ks.slice(0, -1)) o = (o[k] ??= {});
  o[ks[ks.length - 1]] = v;
}
function applyUpdate(doc, u) {
  for (const [k, v] of Object.entries(u)) { if (k.includes(".")) setPath(doc, k, v); else doc[k] = v; }
}
function makeActor(name, { max, hp, fragment = false }) {
  const a = {
    name, uuid: `Actor.${name}`, flags: fragment ? { [NS]: { conflictObject: "soul-fragment" } } : {},
    effects: [], _base: max, _hp: hp, _fragMax: max, img: null, prototypeToken: {},
    async update(u) {
      WRITES.push({ name, fragment, u: { ...u } });
      for (const [k, v] of Object.entries(u)) {
        if (k === "system.props.current_hp") a._hp = v;
        else if (k === "system.props.max_hp") a._fragMax = v;
        else if (k.includes(".")) setPath(a, k, v);
      }
    },
    async createEmbeddedDocuments(_t, list) {
      for (const d of list) {
        const ae = structuredClone(d);
        ae.id = rid();
        ae.update = async (u) => applyUpdate(ae, u);
        ae.delete = async () => { a.effects.splice(a.effects.indexOf(ae), 1); };
        a.effects.push(ae);
      }
    },
  };
  a.system = {
    props: {
      get current_hp() { return a._hp; },
      get max_hp() {
        if (fragment) return a._fragMax;
        const torn = a.effects.find((e) => e.flags?.[NS]?.soulTorn);
        return a._base - (Number(torn?.flags?.[NS]?.soulStolen) || 0);
      },
      npc_rank: "",
    },
  };
  return a;
}
function makeWorld() {
  const scene = { id: "sc", tokens: { contents: [], get(id) { return this.contents.find((t) => t.id === id) ?? null; } } };
  const dCombat = { round: 4, combatants: [] };
  scene.deleteEmbeddedDocuments = async (_t, ids) => {
    scene.tokens.contents = scene.tokens.contents.filter((t) => !ids.includes(t.id));
    dCombat.combatants = dCombat.combatants.filter((c) => !ids.includes(c.tokenDoc?.id));
  };
  const logs = [];
  const ctx = { dCombat, scene, director: null, log: (m) => logs.push(m), warn: (m) => logs.push(`WARN ${m}`) };
  const token = (actor, flags = {}) => {
    const td = { id: rid(), actor, flags: { [NS]: flags }, parent: scene, texture: {} };
    td.uuid = `Scene.sc.Token.${td.id}`;
    scene.tokens.contents.push(td);
    return td;
  };
  const addPlayer = (name, max, hp) => {
    const actor = makeActor(name, { max, hp });
    const c = { side: "party", actorDoc: actor, tokenDoc: token(actor) };
    dCombat.combatants.push(c);
    return c;
  };
  const addTorn = async (player, stolen) => {
    await player.actorDoc.createEmbeddedDocuments("ActiveEffect", [{
      name: "Soul-Torn", changes: [], flags: { [NS]: { soulTorn: true, soulStolen: stolen } },
    }]);
  };
  const addFragment = async (player, hp, max, permanent = false) => {
    const actor = makeActor(`${player.actorDoc.name}Frag`, { max, hp, fragment: true });
    await actor.createEmbeddedDocuments("ActiveEffect", [{
      name: "Soul Fragment", flags: { [NS]: { soulFragmentMark: true, soulSpawnRound: 1, soulCalledRound: 2, soulReturned: false, ...(permanent ? { soulPermanent: true } : {}) } },
    }]);
    const c = { side: "enemy", actorDoc: actor, tokenDoc: token(actor, { soulFragmentOwner: player.actorDoc.uuid }) };
    dCombat.combatants.push(c);
    return c;
  };
  return { ctx, dCombat, scene, logs, addPlayer, addTorn, addFragment };
}
const mark = (f) => f.actorDoc.effects.find((e) => e.flags?.[NS]?.soulFragmentMark)?.flags?.[NS] ?? {};
const markAeOf = (f) => f.actorDoc.effects.find((e) => e.flags?.[NS]?.soulFragmentMark);
const onField = (w, c) => w.dCombat.combatants.includes(c);
const owned = (p) => ({ max: p.actorDoc.system.props.max_hp, hp: p.actorDoc.system.props.current_hp });
const fhp = (f) => f.actorDoc.system.props.current_hp;
const announced = (w) => w.logs.filter((m) => String(m).includes("soul_fragment_destroyed")).length;
const hpWrites = (name) => WRITES.filter((x) => x.name === name && "system.props.current_hp" in x.u).map((x) => x.u["system.props.current_hp"]);
const noZeroFragmentWrite = () => WRITES.every((x) => !x.fragment || x.u["system.props.current_hp"] !== 0);
const stampClear = (f) => { const m = mark(f); return m.soulStrikeKill == null && m.soulStrikeHp == null && m.soulStrikeRound == null; };

const ev = getConflictEvent("soul-tithe");
ok("strikeFragment registered", typeof ev?.actions?.strikeFragment === "function");
// The registered event is frozen, so onObjectDestroyed cannot be spied on. It is entered only by
// the engine on a 0 HP fragment; "no 0 HP write" + "owner HP unchanged" (a FULL refund raises it)
// are the discriminators.
const card = (row) => ({ payload: {}, actionResult: { perTargetResults: row ? [row] : [] } });
const strike = (w, effectCtx) => ev.actions.strikeFragment(w.ctx, { options: { show: "none" }, effectCtx });
// The sweep alone, through a path that runs it and nothing else on a one-fragment field
// (mergeFragments: finishMerges + sweepDestroyed, then "nothing to merge").
const sweep = (w) => ev.actions.mergeFragments(w.ctx, { options: { show: "none" }, effectCtx: { payload: {} } });

// Hina: base 300, HP 100, torn 120 (fragment 120/120); Keren: base 300, HP 100, torn 40 (fragment 40/40).
async function twoWorld({ hinaHp = 120, hinaMax = 120, permanent = false } = {}) {
  const w = makeWorld();
  const hina = w.addPlayer("Hina", 300, 100), keren = w.addPlayer("Keren", 300, 100);
  await w.addTorn(hina, hinaMax); await w.addTorn(keren, 40);
  const fH = await w.addFragment(hina, hinaHp, hinaMax, permanent);
  const fK = await w.addFragment(keren, 40, 40);
  return { w, hina, keren, fH, fK };
}

// Kill path (hit): max_only, announced once, never 0 HP
{
  WRITES.length = 0;
  const { w, hina, keren, fH, fK } = await twoWorld();
  const e = card({ tokenUuid: "Scene.sc.Token.pc", hit: true });
  eq("hit: done", await strike(w, e), true);
  ok("hit: thrown fragment gone, the other stands untouched", !onField(w, fH) && onField(w, fK) && fhp(fK) === 40);
  eq("hit: owner Max restored, current HP unchanged (max_only)", owned(hina), { max: 300, hp: 100 });
  eq("hit: the other owner unchanged", owned(keren), { max: 260, hp: 100 });
  eq("hit: strike_amount on the chain", e.payload._chainVars.strike_amount, 120);
  eq("hit: soul_fragment_destroyed raised once", announced(w), 1);
  ok("hit: refund done, never full", mark(fH).soulRefundDone === true && mark(fH).soulRefundHp === 100);
  ok("hit: fragment current_hp never written (no 0 write)", hpWrites("HinaFrag").length === 0 && noZeroFragmentWrite());
  ok("hit: log line", w.logs.some((m) => String(m).startsWith("strikeFragment: HinaFrag 120 -> 0 (hit)")));
}
// Overflowed fragment throws its whole HP and still pays only the Max back
{
  WRITES.length = 0;
  const { w, hina, fH } = await twoWorld({ hinaHp: 310, hinaMax: 120 });
  const e = card({ hit: true });
  eq("overflow hit: done", await strike(w, e), true);
  eq("overflow hit: amount 310", e.payload._chainVars.strike_amount, 310);
  ok("overflow hit: destroyed, owner Max back, HP unchanged", !onField(w, fH) && JSON.stringify(owned(hina)) === JSON.stringify({ max: 300, hp: 100 }));
  ok("overflow hit: no 0 write", noZeroFragmentWrite());
}
// Pierce miss: absolute set to floor(hp/2), stamps cleared, owner not refunded
{
  WRITES.length = 0;
  const { w, hina, fH, fK } = await twoWorld({ hinaHp: 151, hinaMax: 120 });
  const e = card({ hit: false, pierceMiss: true });
  eq("pierce miss: done", await strike(w, e), true);
  eq("pierce miss: 151 -> 75 (loss ceil 76), Max unchanged", { hp: fhp(fH), max: fH.actorDoc.system.props.max_hp }, { hp: 75, max: 120 });
  eq("pierce miss: one absolute HP write", hpWrites("HinaFrag"), [75]);
  ok("pierce miss: still standing, stamps cleared", onField(w, fH) && stampClear(fH));
  eq("pierce miss: owner not refunded", owned(hina), { max: 180, hp: 100 });
  ok("pierce miss: other fragment untouched, nothing announced", fhp(fK) === 40 && announced(w) === 0);
  ok("pierce miss: log line", w.logs.some((m) => String(m).startsWith("strikeFragment: HinaFrag 151 -> 75 (pierce-miss)")));
  // apply the stamped write twice = same HP: stamp as the action did, the sweep re-runs it
  // (one fragment on the field, so the sweep driver merges nothing)
  await w.scene.deleteEmbeddedDocuments("Token", [fK.tokenDoc.id]);
  await markAeOf(fH).update({ [`flags.${NS}.soulStrikeRound`]: 4, [`flags.${NS}.soulStrikeHp`]: 75, [`flags.${NS}.soulStrikeKill`]: false });
  await sweep(w);
  eq("partial replayed by the sweep: same HP", fhp(fH), 75);
  ok("partial replayed: stamps cleared", stampClear(fH));
}
// Pierce miss on a 1 HP fragment: loss 1 = a kill, max_only, no 0 write
{
  WRITES.length = 0;
  const w = makeWorld();
  const hina = w.addPlayer("Hina", 300, 100);
  await w.addTorn(hina, 120);
  const fH = await w.addFragment(hina, 1, 120);
  eq("1 HP miss: done", await strike(w, card({ pierceMiss: true })), true);
  ok("1 HP miss: destroyed max_only", !onField(w, fH) && JSON.stringify(owned(hina)) === JSON.stringify({ max: 300, hp: 100 }));
  ok("1 HP miss: no 0 write", noZeroFragmentWrite() && hpWrites("HinaFrag").length === 0);
}
// Permanent (Nox Servant) fragment: same path, re-torn at the round end
{
  WRITES.length = 0;
  const w = makeWorld();
  const hina = w.addPlayer("Hina", 120, 1);
  await w.addTorn(hina, 119);
  const fP = await w.addFragment(hina, 119, 119, true);
  eq("servant hit: done", await strike(w, card({ hit: true })), true);
  ok("servant hit: destroyed", !onField(w, fP));
  eq("servant hit: owner's Max back, HP unmoved", owned(hina), { max: 120, hp: 1 });
  ok("servant hit: no 0 write", noZeroFragmentWrite());
  eq("servant: round end re-tears it (no fragment standing)", servantStep({ hasFragment: false, fragmentPermanent: false, ownerMax: 120, ownerHp: 1 }), "tear");
}
// No result row -> false, nothing written
{
  const { w, fH } = await twoWorld();
  WRITES.length = 0;
  eq("no actionResult: false", await strike(w, { payload: {} }), false);
  eq("no effectCtx: false", await strike(w, null), false);
  eq("empty perTargetResults: false", await strike(w, card(null)), false);
  ok("no row: nothing written, no stamp", WRITES.length === 0 && fhp(fH) === 120 && stampClear(fH) && onField(w, fH));
}
// loss 0 (neither hit nor pierceMiss: shielded out) -> true, nothing written
{
  const { w, fH } = await twoWorld();
  WRITES.length = 0;
  const e = card({ hit: false });
  eq("loss 0: true", await strike(w, e), true);
  ok("loss 0: nothing written, no stamp", WRITES.length === 0 && fhp(fH) === 120 && stampClear(fH) && onField(w, fH));
  eq("loss 0: amount still on the chain", e.payload._chainVars.strike_amount, 120);
}
// No standing fragment -> false
{
  const w = makeWorld();
  w.addPlayer("Hina", 300, 100);
  eq("no fragment: false", await strike(w, card({ hit: true })), false);
}

// ── F5: stamps an F5 left behind ────────────────────────────────────────────
// Kill stamp, fragment standing -> the sweep pays max_only (a FULL refund would raise HP to 220)
{
  WRITES.length = 0;
  const w = makeWorld();
  const hina = w.addPlayer("Hina", 300, 100);
  await w.addTorn(hina, 120);
  const fH = await w.addFragment(hina, 120, 120);
  await markAeOf(fH).update({ [`flags.${NS}.soulStrikeRound`]: 4, [`flags.${NS}.soulStrikeHp`]: 0, [`flags.${NS}.soulStrikeKill`]: true, [`flags.${NS}.soulStrikeAmount`]: 120 });
  await sweep(w);
  ok("F5 kill stamp: sweep destroys it", !onField(w, fH));
  eq("F5 kill stamp: max_only (HP unchanged, never full)", owned(hina), { max: 300, hp: 100 });
  ok("F5 kill stamp: announced once, no 0 write", announced(w) === 1 && noZeroFragmentWrite());
}
// Kill stamp at round end (onRoundEnd's sweep)
{
  const w = makeWorld();
  const hina = w.addPlayer("Hina", 300, 100);
  await w.addTorn(hina, 120);
  const fH = await w.addFragment(hina, 120, 120);
  await markAeOf(fH).update({ [`flags.${NS}.soulStrikeRound`]: 4, [`flags.${NS}.soulStrikeKill`]: true });
  setServantPredicate(() => false);
  await ev.onRoundEnd(w.ctx);
  ok("F5 kill stamp, round end: destroyed max_only", !onField(w, fH) && JSON.stringify(owned(hina)) === JSON.stringify({ max: 300, hp: 100 }));
}
// Kill stamp from an OLDER round still finishes max_only
{
  const w = makeWorld();
  const hina = w.addPlayer("Hina", 300, 100);
  await w.addTorn(hina, 120);
  const fH = await w.addFragment(hina, 120, 120);
  await markAeOf(fH).update({ [`flags.${NS}.soulStrikeRound`]: 2, [`flags.${NS}.soulStrikeKill`]: true });
  await sweep(w);
  ok("F5 old kill stamp: destroyed max_only", !onField(w, fH) && JSON.stringify(owned(hina)) === JSON.stringify({ max: 300, hp: 100 }));
}
// Kill stamp and the fragment at 0 HP (no HP event): max_only, not the 0 HP FULL path
{
  const w = makeWorld();
  const hina = w.addPlayer("Hina", 300, 100);
  await w.addTorn(hina, 120);
  const fH = await w.addFragment(hina, 0, 120);
  await markAeOf(fH).update({ [`flags.${NS}.soulStrikeRound`]: 4, [`flags.${NS}.soulStrikeKill`]: true });
  await sweep(w);
  ok("F5 kill stamp at 0 HP: max_only", !onField(w, fH) && JSON.stringify(owned(hina)) === JSON.stringify({ max: 300, hp: 100 }));
}
// Kill stamp, refund half-written (soulReturned + the max_only target, not done): resumes at the same target
{
  const w = makeWorld();
  const hina = w.addPlayer("Hina", 300, 100);
  await w.addTorn(hina, 120);
  const fH = await w.addFragment(hina, 120, 120);
  await markAeOf(fH).update({ [`flags.${NS}.soulStrikeRound`]: 4, [`flags.${NS}.soulStrikeKill`]: true, [`flags.${NS}.soulReturned`]: true, [`flags.${NS}.soulRefundFrom`]: 100, [`flags.${NS}.soulRefundHp`]: 100 });
  await sweep(w);
  ok("F5 mid-refund: finished, HP unchanged", !onField(w, fH) && JSON.stringify(owned(hina)) === JSON.stringify({ max: 300, hp: 100 }));
}
// Partial stamp, HP above the stamp (the set never landed) -> set to the stamp, not subtracted
{
  WRITES.length = 0;
  const w = makeWorld();
  const hina = w.addPlayer("Hina", 300, 100);
  await w.addTorn(hina, 120);
  const fH = await w.addFragment(hina, 151, 120);
  await markAeOf(fH).update({ [`flags.${NS}.soulStrikeRound`]: 4, [`flags.${NS}.soulStrikeHp`]: 75, [`flags.${NS}.soulStrikeKill`]: false });
  await sweep(w);
  eq("F5 partial: set to the stamp", fhp(fH), 75);
  ok("F5 partial: standing, stamps cleared, owner not refunded", onField(w, fH) && stampClear(fH) && owned(hina).max === 180 && owned(hina).hp === 100);
  await sweep(w);
  eq("F5 partial: a second sweep changes nothing", hpWrites("HinaFrag"), [75]);
}
// Partial stamp, HP below the stamp (hit since) -> left alone
{
  const w = makeWorld();
  const hina = w.addPlayer("Hina", 300, 100);
  await w.addTorn(hina, 120);
  const fH = await w.addFragment(hina, 60, 120);
  await markAeOf(fH).update({ [`flags.${NS}.soulStrikeRound`]: 4, [`flags.${NS}.soulStrikeHp`]: 75, [`flags.${NS}.soulStrikeKill`]: false });
  await sweep(w);
  ok("F5 partial, HP below stamp: unchanged, cleared", fhp(fH) === 60 && stampClear(fH));
}
// Partial stamp from an older round -> cleared, nothing written (no subtract, no refund)
{
  WRITES.length = 0;
  const w = makeWorld();
  const hina = w.addPlayer("Hina", 300, 100);
  await w.addTorn(hina, 120);
  const fH = await w.addFragment(hina, 151, 120);
  await markAeOf(fH).update({ [`flags.${NS}.soulStrikeRound`]: 2, [`flags.${NS}.soulStrikeHp`]: 75, [`flags.${NS}.soulStrikeKill`]: false });
  await sweep(w);
  ok("F5 old partial: HP untouched, stamps cleared, warned", fhp(fH) === 151 && stampClear(fH) && hpWrites("HinaFrag").length === 0 && w.logs.some((m) => String(m).startsWith("WARN strikeFragment")));
}
// The action's own resume: a same-round stamp means its earlier run; it is finished, not thrown again
{
  WRITES.length = 0;
  const { w, hina, keren, fH, fK } = await twoWorld({ hinaHp: 151, hinaMax: 120 });
  await markAeOf(fH).update({ [`flags.${NS}.soulStrikeRound`]: 4, [`flags.${NS}.soulStrikeHp`]: 75, [`flags.${NS}.soulStrikeKill`]: false, [`flags.${NS}.soulStrikeAmount`]: 151 });
  const e = card({ pierceMiss: true });
  eq("resume partial: true", await strike(w, e), true);
  eq("resume partial: HP = stamp, not halved again", fhp(fH), 75);
  ok("resume partial: other fragment untouched, amount from the stamp", fhp(fK) === 40 && e.payload._chainVars.strike_amount === 151);
  ok("resume partial: owners untouched", owned(hina).max === 180 && owned(keren).max === 260);
}
{
  const { w, hina, fH, fK } = await twoWorld();
  await markAeOf(fH).update({ [`flags.${NS}.soulStrikeRound`]: 4, [`flags.${NS}.soulStrikeKill`]: true, [`flags.${NS}.soulStrikeAmount`]: 120 });
  eq("resume kill: true", await strike(w, card({ hit: true })), true);
  ok("resume kill: thrown one destroyed max_only, the next fragment NOT thrown", !onField(w, fH) && onField(w, fK) && fhp(fK) === 40
    && JSON.stringify(owned(hina)) === JSON.stringify({ max: 300, hp: 100 }));
  eq("resume kill: announced once", announced(w), 1);
}
// An older-round stamp does not swallow a fresh throw
{
  const { w, fH, fK } = await twoWorld();
  await markAeOf(fK).update({ [`flags.${NS}.soulStrikeRound`]: 2, [`flags.${NS}.soulStrikeHp`]: 20, [`flags.${NS}.soulStrikeKill`]: false });
  eq("old stamp + new throw: true", await strike(w, card({ pierceMiss: true })), true);
  ok("old stamp + new throw: old one cleared untouched, top fragment halved", fhp(fK) === 40 && stampClear(fK) && fhp(fH) === 60);
}
ok("never a 0 HP write to any fragment across the F5 cases", noZeroFragmentWrite());

console.log(`soul-tithe-strike: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
