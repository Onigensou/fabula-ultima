// Bare-Node harness for Soul Tithe's Fragment Eater (2026-11-19): the eaten ledger,
// consumeFragment and titheWound.
//   node scripts/conflict-event/events/soul-tithe-eater.test.mjs
// Pure rules first, then the two actions against small stand-in documents (no Foundry:
// every presentation / save import fails closed, which is the "nobody watches" path).
globalThis.game = { user: { isGM: false } };   // emitBattlefieldObjectTrigger returns at once

const {
  heldLoss, squareFragment, refundSplit, fragmentMayBeEaten, pickFragmentToEat, eatFragment,
  titheWoundAmount, resolveCalling, lockWound, returnedHp, FRAGMENT_DESTROYED_TRIGGER,
} = await import("./soul-tithe.js");
const { getConflictEvent } = await import("../conflict-event-registry.js");

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) pass++; else { fail++; console.error(`FAIL ${name}`); } }
const eq = (name, a, b) => ok(`${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`, JSON.stringify(a) === JSON.stringify(b));

// ── Pure rules ──────────────────────────────────────────────────────────────
eq("trigger name", FRAGMENT_DESTROYED_TRIGGER, "soul_fragment_destroyed");
eq("held = lost when nothing eaten", heldLoss({ stolen: 60, eaten: 0 }), 60);
eq("held = lost - eaten", heldLoss({ stolen: 80, eaten: 60 }), 20);
eq("held never negative", heldLoss({ stolen: 10, eaten: 60 }), 0);

// Re-square respects eaten
eq("re-square: in step, nothing to do", squareFragment({ hp: 20, max: 20, stolen: 80, eaten: 60 }), null);
eq("re-square: a fragment still holding the eaten part is cut back", squareFragment({ hp: 80, max: 80, stolen: 80, eaten: 60 }), { hp: 20, max: 20 });
eq("re-square: a chipped fragment keeps its damage", squareFragment({ hp: 10, max: 30, stolen: 80, eaten: 60 }), { hp: 1, max: 20 });
eq("re-square: grows with a missed write", squareFragment({ hp: 10, max: 20, stolen: 90, eaten: 60 }), { hp: 20, max: 30 });
eq("re-square: no eaten = the old rule", squareFragment({ hp: 30, max: 30, stolen: 40, eaten: 0 }), { hp: 40, max: 40 });
eq("re-square: a 0 HP fragment is left to the sweep", squareFragment({ hp: 0, max: 30, stolen: 40, eaten: 0 }), null);

// Refund with an eaten part
eq("refund: nothing eaten returns all", refundSplit({ stolen: 60, eaten: 0 }), { returned: 60, keep: 0 });
eq("refund: eaten part stays", refundSplit({ stolen: 80, eaten: 60 }), { returned: 20, keep: 60 });

// Eligibility + pick
ok("ineligible before its first Calling", !fragmentMayBeEaten({ hp: 30, calledRound: 0, returned: false }));
ok("eligible once it has Called", fragmentMayBeEaten({ hp: 30, calledRound: 2, returned: false }));
ok("a 0 HP fragment is not food", !fragmentMayBeEaten({ hp: 0, calledRound: 2 }));
ok("a paid-out fragment is not food", !fragmentMayBeEaten({ hp: 30, calledRound: 2, returned: true }));
const field = [
  { id: "a", ownerUuid: "Actor.hina", hp: 30, calledRound: 2 },
  { id: "b", ownerUuid: "Actor.zarg", hp: 90, calledRound: 0 },   // biggest, never Called
  { id: "c", ownerUuid: "Actor.geist", hp: 45, calledRound: 3 },
];
eq("largest eligible (skips the bigger one that never Called)", pickFragmentToEat(field, { pick: "largest" })?.id, "c");
eq("owner pick", pickFragmentToEat(field, { pick: "trigger_subject_owner", ownerUuids: ["Actor.hina"] })?.id, "a");
eq("owner pick: their fragment never Called -> nothing", pickFragmentToEat(field, { pick: "trigger_subject_owner", ownerUuids: ["Actor.zarg"] }), null);
eq("owner pick with no owners -> nothing", pickFragmentToEat(field, { pick: "trigger_subject_owner", ownerUuids: [] }), null);
eq("empty field -> nothing", pickFragmentToEat([], { pick: "largest" }), null);

// Eat is idempotent
eq("eat books the whole loss, consumed = current HP", eatFragment({ stolen: 60, eaten: 0, fragmentHp: 45 }), { eaten: 60, consumed: 45 });
eq("eat re-run lands the same", eatFragment({ stolen: 60, eaten: 60, fragmentHp: 45 }).eaten, 60);

// Soul Ripper's wound
eq("titheWound: amount", titheWoundAmount({ ownerMax: 120, ownerHp: 70, amount: 50 }), 50);
eq("titheWound: KO'd gets no lock", titheWoundAmount({ ownerMax: 120, ownerHp: 0, amount: 50 }), 0);
eq("titheWound: Max floor 1", titheWoundAmount({ ownerMax: 30, ownerHp: 10, amount: 50 }), 29);

// ── A whole story, rules only: Hina 120 ─────────────────────────────────────
// Round 1: hit for 30 -> lock 30 (fragment 30/30). Round 2: Calling 30 -> 60/60, she 60/60.
// Round 3 (mid): Soul Sever eats it at 60 -> eaten 60, no refund.
// Then a 20 wound -> new fragment of held+20 = 20/20 (NOT 80). Kill it: back 20 only (80/80
// with full HP... capped at Max). Battle end: Soul-Torn gone, Max 120.
{
  const base = 120;
  let stolen = 0, eaten = 0, hp = 90;
  stolen += lockWound({ ownerMax: base - stolen, ownerHp: hp });          // 30
  let frag = { hp: 30, max: 30 };
  const r = resolveCalling({ ownerMax: base - stolen, ownerHp: hp, fragmentHp: frag.hp, fragmentMax: frag.max });
  stolen += r.stolen; hp = r.ownerHp; frag = { hp: r.fragmentHp, max: heldLoss({ stolen, eaten }) };
  eq("story: after Calling", { stolen, hp, frag }, { stolen: 60, hp: 60, frag: { hp: 60, max: 60 } });
  const e = eatFragment({ stolen, eaten, fragmentHp: frag.hp });
  eaten = e.eaten; frag = null;
  eq("story: eaten, consumed 60, Max still 60", { eaten, consumed: e.consumed, max: base - stolen }, { eaten: 60, consumed: 60, max: 60 });
  hp -= 20;
  const w = lockWound({ ownerMax: base - stolen, ownerHp: hp });
  frag = { hp: heldLoss({ stolen, eaten }) + w, max: heldLoss({ stolen, eaten }) + w };
  stolen += w;
  eq("story: new fragment holds only the new wound", { frag, stolen, held: heldLoss({ stolen, eaten }) }, { frag: { hp: 20, max: 20 }, stolen: 80, held: 20 });
  eq("story: invariant fragment Max = loss - eaten", frag.max, stolen - eaten);
  const split = refundSplit({ stolen, eaten });
  const nextMax = base - stolen + split.returned;
  hp = returnedHp({ ownerHp: hp, ownerMax: nextMax, stolen: split.returned });
  stolen = split.keep;
  eq("story: kill pays back 20, eaten 60 stays", { max: base - stolen, hp, stolen }, { max: 60, hp: 60, stolen: 60 });
  eq("story: battle end deletes Soul-Torn -> full bar", base - 0, 120);
}

// ── The actions, on stand-in documents ──────────────────────────────────────
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
  const addFragment = async (player, hp, max, calledRound) => {
    const actor = makeActor(`${player.actorDoc.name}Frag`, { max, hp, fragment: true });
    await actor.createEmbeddedDocuments("ActiveEffect", [{
      name: "Soul Fragment", flags: { [NS]: { soulFragmentMark: true, soulSpawnRound: 1, soulCalledRound: calledRound, soulReturned: false } },
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
ok("soul-tithe registered with the new actions", typeof ev?.actions?.consumeFragment === "function" && typeof ev?.actions?.titheWound === "function");

// consumeFragment: largest eligible, no refund, ledger, VAR, B1 stamp
{
  const w = makeWorld();
  const hina = w.addPlayer("Hina", 120, 60), zarg = w.addPlayer("Zarg", 100, 10);
  await w.addTorn(hina, 60); await w.addTorn(zarg, 90);
  const fH = await w.addFragment(hina, 45, 60, 3);
  const fZ = await w.addFragment(zarg, 90, 90, 0);   // biggest, never Called
  const effectCtx = { payload: {} };
  const res = await ev.actions.consumeFragment(w.ctx, { tokens: [], row: { conflict_pick: "largest" }, effectCtx });
  eq("consume: done", res, true);
  ok("consume: the Called one went, not the bigger new one", !onField(w, fH) && onField(w, fZ));
  eq("consume: VAR_CONSUMED_FRAGMENT_HP = its current HP", effectCtx.payload._chainVars.consumed_fragment_hp, 45);
  eq("consume: owner's loss stays (no refund)", { max: hina.actorDoc.system.props.max_hp, hp: hina.actorDoc.system.props.current_hp }, { max: 60, hp: 60 });
  eq("consume: ledger books the whole loss as eaten", { s: torn(hina).soulStolen, e: torn(hina).soulEaten }, { s: 60, e: 60 });
  ok("consume: B1 stamped once-only on the mark", mark(fH).soulDestroyedFired === true && mark(fH).soulRefundDone === true);
  // Bare Node cannot load defeat-reactor.js (it needs Foundry's PIXI/Hooks), so the
  // dispatch is reached and fails closed there: the eat still completes.
  ok("consume: B1 dispatch reached", w.logs.some((m) => String(m).includes("soul_fragment_destroyed")));

  // Nothing eligible: only the never-Called fragment remains.
  const e2 = { payload: {} };
  eq("consume: fails closed with nothing eligible", await ev.actions.consumeFragment(w.ctx, { tokens: [], row: { conflict_pick: "largest" }, effectCtx: e2 }), false);
  eq("consume: VAR is 0 on a miss", e2.payload._chainVars.consumed_fragment_hp, 0);
  ok("consume: the ineligible one is untouched", onField(w, fZ) && mark(fZ).soulReturned === false);

  // Its owner's later destroy refunds only what the new fragment held.
  const { refundSplit: rs } = await import("./soul-tithe.js");
  eq("consume: a later refund would keep the eaten 60", rs({ stolen: 80, eaten: torn(hina).soulEaten }), { returned: 20, keep: 60 });
}

// Beheading (B4): pick the KO'd owner's fragment through target_ref tokens
{
  const w = makeWorld();
  const geist = w.addPlayer("Geist", 100, 0);    // just beheaded: KO'd
  const hina = w.addPlayer("Hina", 120, 100);
  await w.addTorn(geist, 40); await w.addTorn(hina, 20);
  const fG = await w.addFragment(geist, 25, 40, 2);
  const fH = await w.addFragment(hina, 80, 20, 2);  // larger, someone else's
  const effectCtx = { payload: {} };
  const res = await ev.actions.consumeFragment(w.ctx, { tokens: [geist.tokenDoc], row: { conflict_pick: "trigger_subject_owner" }, effectCtx });
  eq("beheading: eats the KO'd owner's fragment", { res, gone: !onField(w, fG), other: onField(w, fH) }, { res: true, gone: true, other: true });
  eq("beheading: owner stays down, ledger booked", { hp: geist.actorDoc.system.props.current_hp, e: torn(geist).soulEaten }, { hp: 0, e: 40 });
  // Blank pick + a player token infers trigger_subject_owner.
  const w2 = makeWorld();
  const p = w2.addPlayer("Kalina", 90, 0); await w2.addTorn(p, 30);
  const f = await w2.addFragment(p, 30, 30, 0);   // never Called
  eq("beheading: a fragment that never Called stays", await ev.actions.consumeFragment(w2.ctx, { tokens: [p.tokenDoc], row: {}, effectCtx: { payload: {} } }), false);
  ok("beheading: still on the field", onField(w2, f));
}

// titheWound (B3) on a player with a fragment
{
  const w = makeWorld();
  const hina = w.addPlayer("Hina", 120, 70);   // hit for 50 just now
  await w.addTorn(hina, 30, 10);               // 10 of it was eaten earlier
  const f = await w.addFragment(hina, 15, 20, 2);
  eq("titheWound: done", await ev.actions.titheWound(w.ctx, { tokens: [hina.tokenDoc], amount: 50 }), true);
  eq("titheWound: Max drops by the wound at once", { max: hina.actorDoc.system.props.max_hp, hp: hina.actorDoc.system.props.current_hp }, { max: 40, hp: 40 });
  eq("titheWound: fragment grows by the wound, Max = loss - eaten", { hp: f.actorDoc.system.props.current_hp, max: f.actorDoc.system.props.max_hp }, { hp: 65, max: 70 });
  eq("titheWound: a KO'd player is skipped", await (async () => {
    const w2 = makeWorld(); const p = w2.addPlayer("Zarg", 100, 0); await w2.addTorn(p, 10);
    await w2.addFragment(p, 10, 10, 2);
    return [await ev.actions.titheWound(w2.ctx, { tokens: [p.tokenDoc], amount: 30 }), p.actorDoc.system.props.max_hp];
  })(), [false, 90]);
  eq("titheWound: zero amount does nothing", await ev.actions.titheWound(w.ctx, { tokens: [hina.tokenDoc], amount: 0 }), false);
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
