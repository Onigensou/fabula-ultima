// Bare-Node harness for Soul Confluence P1 (2026-11-24): planConfluence + the mergeFragments action.
//   node scripts/conflict-event/events/soul-tithe-confluence.test.mjs
globalThis.game = { user: { isGM: false } };   // emitBattlefieldObjectTrigger returns at once

const { planConfluence, servantStep, setServantPredicate } = await import("./soul-tithe.js");
const { getConflictEvent } = await import("../conflict-event-registry.js");

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) pass++; else { fail++; console.error(`FAIL ${name}`); } }
const eq = (name, a, b) => ok(`${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`, JSON.stringify(a) === JSON.stringify(b));

// ── planConfluence (pure) ───────────────────────────────────────────────────
eq("plan: highest HP receives, gain = the rest", planConfluence([{ id: "a", hp: 120, max: 120, slot: 0 }, { id: "b", hp: 90, max: 90, slot: 1 }, { id: "c", hp: 60, max: 60, slot: 2 }, { id: "d", hp: 40, max: 40, slot: 3 }]), { recipientId: "a", donorIds: ["b", "c", "d"], gain: 190 });
eq("plan: HP tie -> highest Max", planConfluence([{ id: "a", hp: 50, max: 60, slot: 0 }, { id: "b", hp: 50, max: 80, slot: 1 }])?.recipientId, "b");
eq("plan: HP and Max tie -> lowest party slot", planConfluence([{ id: "a", hp: 50, max: 60, slot: 2 }, { id: "b", hp: 50, max: 60, slot: 1 }, { id: "c", hp: 50, max: 60, slot: 3 }])?.recipientId, "b");
eq("plan: unknown slot sorts last", planConfluence([{ id: "a", hp: 50, max: 60, slot: -1 }, { id: "b", hp: 50, max: 60, slot: 3 }])?.recipientId, "b");
eq("plan: max beats slot", planConfluence([{ id: "a", hp: 50, max: 90, slot: 3 }, { id: "b", hp: 50, max: 60, slot: 0 }])?.recipientId, "a");
eq("plan: 1 fragment -> null", planConfluence([{ id: "a", hp: 50, max: 60, slot: 0 }]), null);
eq("plan: 0 HP fragments do not count", planConfluence([{ id: "a", hp: 50, max: 60, slot: 0 }, { id: "b", hp: 0, max: 60, slot: 1 }]), null);
eq("plan: empty", planConfluence([]), null);

const NS = "fabula-ultima-companion";
let nid = 0;
const rid = () => `id${++nid}`;
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
  const addTorn = async (player, stolen, eaten = 0) => {
    await player.actorDoc.createEmbeddedDocuments("ActiveEffect", [{
      name: "Soul-Torn", changes: [], flags: { [NS]: { soulTorn: true, soulStolen: stolen, ...(eaten ? { soulEaten: eaten } : {}) } },
    }]);
  };
  const addFragment = async (player, hp, max, calledRound, permanent = false) => {
    const actor = makeActor(`${player.actorDoc.name}Frag`, { max, hp, fragment: true });
    await actor.createEmbeddedDocuments("ActiveEffect", [{
      name: "Soul Fragment", flags: { [NS]: { soulFragmentMark: true, soulSpawnRound: 1, soulCalledRound: calledRound, soulReturned: false, ...(permanent ? { soulPermanent: true } : {}) } },
    }]);
    const c = { side: "enemy", actorDoc: actor, tokenDoc: token(actor, { soulFragmentOwner: player.actorDoc.uuid }) };
    dCombat.combatants.push(c);
    return c;
  };
  return { ctx, dCombat, scene, logs, addPlayer, addTorn, addFragment };
}
const torn = (p) => p.actorDoc.effects.find((e) => e.flags?.[NS]?.soulTorn)?.flags?.[NS] ?? null;
const mark = (f) => f.actorDoc.effects.find((e) => e.flags?.[NS]?.soulFragmentMark)?.flags?.[NS] ?? {};
const onField = (w, c) => w.dCombat.combatants.includes(c);

const ev = getConflictEvent("soul-tithe");
ok("mergeFragments registered", typeof ev?.actions?.mergeFragments === "function");
const run = (w, effectCtx = { payload: {} }) => ev.actions.mergeFragments(w.ctx, { options: { show: "none" }, effectCtx });
const owned = (p) => ({ max: p.actorDoc.system.props.max_hp, hp: p.actorDoc.system.props.current_hp });
const fhp = (f) => f.actorDoc.system.props.current_hp;

// Four fragments: 120/120 90/90 60/60 40/40; each owner (Max 300) is torn by exactly that.
async function fourWorld() {
  const w = makeWorld();
  const names = ["Hina", "Keren", "Blanche", "Zarg"], sizes = [120, 90, 60, 40];
  const P = names.map((n) => w.addPlayer(n, 300, 100));
  const F = [];
  for (let i = 0; i < 4; i++) { await w.addTorn(P[i], sizes[i]); F.push(await w.addFragment(P[i], sizes[i], sizes[i], 2)); }
  return { w, P, F };
}
const markAeOf = (f) => f.actorDoc.effects.find((e) => e.flags?.[NS]?.soulFragmentMark);

{
  const { w, P, F } = await fourWorld();
  const e = { payload: {} };
  eq("merge: done", await run(w, e), true);
  eq("merge: recipient holds the sum, Max unchanged (overflow kept)", { hp: fhp(F[0]), max: F[0].actorDoc.system.props.max_hp }, { hp: 310, max: 120 });
  ok("merge: donors gone, recipient stands", onField(w, F[0]) && !onField(w, F[1]) && !onField(w, F[2]) && !onField(w, F[3]));
  // Owner Max 300 is the BASE; Soul-Torn stolen 90/60/40 released (max_only) -> Max back, current HP untouched (100).
  eq("merge: donor owners get Max back, current HP unchanged", [P[1], P[2], P[3]].map(owned), [{ max: 300, hp: 100 }, { max: 300, hp: 100 }, { max: 300, hp: 100 }]);
  eq("merge: recipient's owner keeps the loss", owned(P[0]), { max: 180, hp: 100 });
  eq("merge: chain var", e.payload._chainVars.confluence_hp, 310);
  ok("merge: donors paid max_only (done), never full", [F[1], F[2], F[3]].every((f) => mark(f).soulRefundDone === true));
  ok("merge: B1 raised per donor", w.logs.filter((m) => String(m).includes("soul_fragment_destroyed")).length === 3);
  eq("idempotent: a re-run has one fragment left and does nothing", await run(w), false);
  eq("idempotent: recipient unchanged", fhp(F[0]), 310);
  // Round-end Calling on the overflowed recipient steals 310 capped at owner Max - 1 (180 - 1).
  w.dCombat.round = 4;
  setServantPredicate(() => false);
  await ev.onRoundEnd(w.ctx);
  eq("calling: owner Max 180 -> steals 179 (floor 1), fragment 310 + 179", { owner: owned(P[0]), frag: fhp(F[0]) }, { owner: { max: 1, hp: 1 }, frag: 489 });
}

// A Calling steals the FULL overflow when the owner can pay it
{
  const w = makeWorld();
  const a = w.addPlayer("Hina", 500, 400), b = w.addPlayer("Keren", 500, 400);
  await w.addTorn(a, 100); await w.addTorn(b, 100);
  const fa = await w.addFragment(a, 100, 100, 2);
  await w.addFragment(b, 100, 100, 2);
  await run(w);
  w.dCombat.round = 4;
  setServantPredicate(() => false);
  await ev.onRoundEnd(w.ctx);
  eq("calling: 200 held, owner Max 400, steals 200 (Max 200)", { owner: owned(a), frag: { hp: fhp(fa), max: fa.actorDoc.system.props.max_hp } }, { owner: { max: 200, hp: 200 }, frag: { hp: 400, max: 300 } });
}

// < 2 fragments: no-op, no writes
{
  const w = makeWorld();
  const a = w.addPlayer("Hina", 300, 100); await w.addTorn(a, 60);
  const f = await w.addFragment(a, 60, 60, 2);
  const e = { payload: {} };
  eq("one fragment: false", await run(w, e), false);
  ok("one fragment: untouched, no stamp", onField(w, f) && fhp(f) === 60 && mark(f).soulMergeRound === undefined && mark(f).soulMergeHp === undefined);
  eq("one fragment: var 0", e.payload._chainVars.confluence_hp, 0);
  eq("no fragment: false", await run(makeWorld()), false);
  const b = w.addPlayer("Keren", 300, 100); await w.addTorn(b, 30);
  await w.addFragment(b, 0, 30, 2);
  eq("a 0 HP fragment is not a donor", await run(w), false);
}

// Ties: HP tie -> Max, then slot
{
  const w = makeWorld();
  const a = w.addPlayer("Hina", 300, 100), b = w.addPlayer("Keren", 300, 100), c = w.addPlayer("Zarg", 300, 100);
  for (const p of [a, b, c]) await w.addTorn(p, 50);
  const fa = await w.addFragment(a, 50, 50, 2), fb = await w.addFragment(b, 50, 50, 2), fc = await w.addFragment(c, 50, 50, 2);
  await run(w);
  ok("tie: slot order -> first party member receives", onField(w, fa) && !onField(w, fb) && !onField(w, fc) && fhp(fa) === 150);
}
{
  const w = makeWorld();
  const a = w.addPlayer("Hina", 300, 100), b = w.addPlayer("Keren", 300, 100);
  await w.addTorn(a, 50); await w.addTorn(b, 80);
  const fa = await w.addFragment(a, 50, 50, 2), fb = await w.addFragment(b, 50, 80, 2);
  await run(w);
  ok("tie: higher Max receives over the earlier slot", !onField(w, fa) && onField(w, fb) && fhp(fb) === 100);
}

// Permanent (Nox Servant) donor: destroyed like a devoured one; no fragment stands, so the Servant step re-tears it
{
  const w = makeWorld();
  const hina = w.addPlayer("Hina", 120, 1), zarg = w.addPlayer("Zarg", 300, 100);
  await w.addTorn(hina, 119); await w.addTorn(zarg, 40);
  const fP = await w.addFragment(hina, 30, 119, 2, true);
  const fZ = await w.addFragment(zarg, 80, 40, 2);
  await run(w);
  ok("permanent donor: destroyed, recipient took its HP", !onField(w, fP) && onField(w, fZ) && fhp(fZ) === 110);
  eq("permanent donor: owner's Max back, HP unmoved", owned(hina), { max: 120, hp: 1 });
  eq("permanent donor: round end re-tears it (step = tear, no fragment standing)", servantStep({ hasFragment: false, fragmentPermanent: false, ownerMax: 120, ownerHp: 1 }), "tear");
}

// F5 mid-merge: stamps written, donors still standing -> the next call finishes it, once
{
  const { w, P, F } = await fourWorld();
  await markAeOf(F[0]).update({ [`flags.${NS}.soulMergeHp`]: 310 });
  for (const d of [F[1], F[2], F[3]]) await markAeOf(d).update({ [`flags.${NS}.soulMergedInto`]: F[0].tokenDoc.id });
  eq("resume: finishes the merge", await run(w), true);
  eq("resume: recipient 310 exactly once", fhp(F[0]), 310);
  ok("resume: donors gone, refunded max_only", !onField(w, F[1]) && !onField(w, F[2]) && !onField(w, F[3]) && owned(P[1]).hp === 100);
  eq("resume: nothing more to merge", await run(w), false);
}
{
  // the round end finishes a half-done merge too, and never pays the donor in full
  const { w, P, F } = await fourWorld();
  await markAeOf(F[0]).update({ [`flags.${NS}.soulMergeHp`]: 310 });
  await markAeOf(F[1]).update({ [`flags.${NS}.soulMergedInto`]: F[0].tokenDoc.id });
  setServantPredicate(() => false);
  await ev.onRoundEnd(w.ctx);
  ok("round end: the stamped donor is destroyed max_only; unstamped ones stand", !onField(w, F[1]) && onField(w, F[2]) && owned(P[1]).hp === 100);
}


// ── Gate B2: stamp order, add-not-set, guards ───────────────────────────────
const stampDonors = async (F, idxs) => { for (const i of idxs) await markAeOf(F[i]).update({ [`flags.${NS}.soulMergedInto`]: F[0].tokenDoc.id }); };
const stampRec = (F, applied = false) => markAeOf(F[0]).update({ [`flags.${NS}.soulMergeHp`]: 310, [`flags.${NS}.soulMergeApplied`]: applied });
// F5 after k of 3 donor stamps (recipient not stamped): merge never began -> stamps cleared, nothing destroyed or written
for (const k of [0, 1, 2]) {
  const { w, P, F } = await fourWorld();
  await stampDonors(F, [1, 2, 3].slice(0, k));
  eq(`F5 after ${k} of 3 donor stamps: no HP written`, fhp(F[0]), 120);
  await run(w);
  // the resume clears the stray stamps, then a fresh merge runs once: recipient 120+90+60+40
  eq(`F5 after ${k} donor stamps: one clean merge, no duplicate HP`, fhp(F[0]), 310);
  ok(`F5 after ${k} donor stamps: donors gone once, owners paid max_only`, [1, 2, 3].every((i) => !onField(w, F[i])) && owned(P[1]).hp === 100);
}
{
  const { w, F } = await fourWorld();
  await stampDonors(F, [1, 2]);
  setServantPredicate(() => false);
  await ev.onRoundEnd(w.ctx);
  ok("round end, donors stamped without a recipient stamp: all stand, stamps cleared (no destroy)",
    [1, 2, 3].every((i) => onField(w, F[i])) && mark(F[1]).soulMergedInto == null && mark(F[2]).soulMergedInto == null);
}
// F5 after all stamps and the recipient stamp, before the HP write
{
  const { w, F } = await fourWorld();
  await stampDonors(F, [1, 2, 3]); await stampRec(F);
  await run(w);
  eq("recipient stamp, before HP write: added once", fhp(F[0]), 310);
  ok("recipient stamp, before HP write: stamps cleared", mark(F[0]).soulMergeHp == null && mark(F[0]).soulMergeApplied == null);
}
// F5 after the HP write and the applied record, before the destroys: no second add
{
  const { w, F } = await fourWorld();
  await stampDonors(F, [1, 2, 3]); await stampRec(F, true);
  await F[0].actorDoc.update({ "system.props.current_hp": 310 });
  await run(w);
  eq("applied already: not added again", fhp(F[0]), 310);
  ok("applied already: donors destroyed", [1, 2, 3].every((i) => !onField(w, F[i])));
}
// F5 after the HP write but before the applied record: the planned total is recognised
{
  const { w, F } = await fourWorld();
  await stampDonors(F, [1, 2, 3]); await stampRec(F, false);
  await F[0].actorDoc.update({ "system.props.current_hp": 310 });
  await run(w);
  eq("written, not recorded: not added again", fhp(F[0]), 310);
}
// Damage dealt to the recipient between the merge and the finish is kept
{
  const { w, F } = await fourWorld();
  await stampDonors(F, [1, 2, 3]); await stampRec(F);
  await F[0].actorDoc.update({ "system.props.current_hp": 100 });   // hit for 20 after the stamps
  await run(w);
  eq("damage between merge and finish is kept (100 + 190)", fhp(F[0]), 290);
}
// A recipient at 0 HP is not restored (round end sweeps it first), donors are not destroyed for nothing
{
  const { w, P, F } = await fourWorld();
  await stampDonors(F, [1, 2, 3]); await stampRec(F);
  await F[0].actorDoc.update({ "system.props.current_hp": 0 });
  setServantPredicate(() => false);
  await ev.onRoundEnd(w.ctx);
  ok("0 HP recipient: swept, not restored", !onField(w, F[0]) && fhp(F[0]) === 0);
  ok("0 HP recipient: donors survive with their stamps cleared", [1, 2, 3].every((i) => onField(w, F[i]) && mark(F[i]).soulMergedInto == null));
}
{
  const { w, F } = await fourWorld();
  await stampDonors(F, [1, 2, 3]); await stampRec(F);
  await F[0].actorDoc.update({ "system.props.current_hp": 0 });
  await run(w);   // the action's own resume, before any sweep: the guard alone
  ok("0 HP recipient via the action: no HP lifted", fhp(F[0]) === 0 || !onField(w, F[0]));
}
{
  const { w, F } = await fourWorld();
  await stampDonors(F, [1, 2, 3]); await stampRec(F);
  await markAeOf(F[0]).update({ [`flags.${NS}.soulReturned`]: true });
  setServantPredicate(() => false);
  await ev.onRoundEnd(w.ctx);
  eq("already returned recipient: not resurrected", fhp(F[0]) <= 120, true);
}

console.log(`soul-tithe-confluence: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
