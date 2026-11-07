// Soul Tithe's rules against known numbers, on real documents. The event's handlers run with a
// hand-built roster instead of a live battle, so every number below is exact.
const NS = "fabula-ultima-companion";
const { getConflictEvent } = await import("/modules/fabula-ultima-companion/scripts/conflict-event/conflict-event-registry.js");
await import("/modules/fabula-ultima-companion/scripts/conflict-event/conflict-event-api.js");
const { crisisThreshold } = await import("/modules/fabula-ultima-companion/scripts/battle-director/crisis-reactor.js");
const { captureSubjectSnapshot } = await import("/modules/fabula-ultima-companion/scripts/battle-director/snapshot.js");
const ev = getConflictEvent("soul-tithe");
if (!ev) return { error: "event not registered" };

const asserts = [];
const eq = (name, got, want) => asserts.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });
const num = (v) => Math.floor(Number(v)) || 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const hina = game.actors.getName("Hina");
const keren = game.actors.getName("Keren");
const kalinaLike = game.actors.getName("Blanche"); // stands in as a summon below
const phantasmLike = game.actors.getName("Zarg"); // rankless, so only the token flag can exclude it
// The design table below is Hina at 120 Max HP. Play moves her real Max (food, gear), so pin it.
const maxPin = 120 - num(hina.system.props.max_hp);
if (maxPin) { await hina.createEmbeddedDocuments("ActiveEffect", [{ name: "Rig: Max HP pin", changes: [{ key: "max_hp", mode: 2, value: String(maxPin) }], flags: { [NS]: { directorPermanent: true } } }]); await sleep(500); }
const templateBefore = JSON.stringify(game.actors.find((a) => a.flags?.[NS]?.conflictObject === "soul-fragment").system.props.max_hp);
const base = { hina: num(hina.system.props.max_hp), keren: num(keren.system.props.max_hp) };

const combatants = [
  { side: "party", actorDoc: hina, tokenDoc: null },
  { side: "party", actorDoc: keren, tokenDoc: null },
  { side: "party", actorDoc: kalinaLike, tokenDoc: { flags: { [NS]: { isSummon: true } } } },
  // The flag skill-effects.js stamps on a real phantasm.
  { side: "party", actorDoc: phantasmLike, tokenDoc: { flags: { [NS]: { isPhantasm: true } } } },
];
const dCombat = {
  round: 1, ended: false, combatants, scene: canvas.scene,
  addCombatant(o) { const c = { ...o }; combatants.push(c); return c; },
};
const ctx = {
  director: { ctx: {}, dCombat }, dCombat, scene: canvas.scene, eventId: "soul-tithe",
  combatants: async () => [], allCombatants: async () => [],
  log: () => {}, warn: (...a) => asserts.push({ name: "event warned", ok: false, got: a.map(String).join(" ").slice(0, 200) }),
};
const roundEnd = async () => { await ev.onRoundEnd(ctx); dCombat.round += 1; };
const frag = (a) => combatants.find((c) => c.tokenDoc?.flags?.[NS]?.soulFragmentOwner === a.uuid) ?? null;
const live = (a) => ({ hp: num(a.system.props.current_hp), max: num(a.system.props.max_hp) });
const fl = (a) => { const f = frag(a); return f ? { hp: num(f.actorDoc.system.props.current_hp), max: num(f.actorDoc.system.props.max_hp) } : null; };
const stolen = (a) => num(a.effects.find((e) => e.flags?.[NS]?.soulTorn)?.flags?.[NS]?.soulStolen);

await hina.update({ "system.props.current_hp": base.hina });
await keren.update({ "system.props.current_hp": base.keren });
const blancheStart = live(kalinaLike);
await kalinaLike.update({ "system.props.current_hp": blancheStart.max - 10 });
const zargStart = live(phantasmLike);
await phantasmLike.update({ "system.props.current_hp": zargStart.max - 10 });

// A. The design table: 120 HP, one 30-damage hit, the fragment ignored.
let updates = 0;
const hook = Hooks.on("updateActor", (a) => { if (a.id === hina.id) updates++; });
await hina.update({ "system.props.current_hp": 90 });
updates = 0;
await roundEnd();
eq("A1 round 1: Hina locks to 90/90", live(hina), { hp: 90, max: 90 });
eq("A1 round 1: fragment 30/30", fl(hina), { hp: 30, max: 30 });
eq("A1 the lock notifies updateActor (the HUD's Max and Crisis read it)", updates > 0, true);
const f0 = frag(hina);
eq("A1 name", f0.tokenDoc.name, "Hina's Soul Fragment");
eq("A1 actor name", f0.actorDoc.name, "Hina's Soul Fragment");
eq("A1 token faces the party (mirrored)", f0.tokenDoc.texture.scaleX < 0, true);
eq("A1 token wears the owner's art", f0.tokenDoc.texture.src.includes("Hina"), true);
eq("A1 no turns pinned", f0.tokenDoc.flags[NS].turnsPerRound, 0);
eq("A1 sprite is the owner's, not a crystal", /crystal/i.test(String(f0.actorDoc.system.props.sprite_battle)), false);
eq("A1 study text is no longer a crystal's", /storm|earth/i.test(String(f0.actorDoc.system.props.study_text)), false);
await roundEnd();
eq("A2 round 2: 60/60", live(hina), { hp: 60, max: 60 });
eq("A2 round 2: fragment 60/60", fl(hina), { hp: 60, max: 60 });
await roundEnd();
eq("A3 round 3: 1/1", live(hina), { hp: 1, max: 1 });
eq("A3 round 3: fragment 119/119", fl(hina), { hp: 119, max: 119 });
await roundEnd();
eq("A4 round 4: nothing left to take", [live(hina), fl(hina)], [{ hp: 1, max: 1 }, { hp: 119, max: 119 }]);
f0.actorDoc.prepareData();
eq("A5 fragment HP survives a re-derive", fl(hina), { hp: 119, max: 119 });
eq("A5 the template actor was not touched", JSON.stringify(game.actors.find((a) => a.flags?.[NS]?.conflictObject === "soul-fragment").system.props.max_hp), templateBefore);
const ks = captureSubjectSnapshot(f0.actorDoc);
eq("A6 a fragment has no Crisis threshold", crisisThreshold(f0.actorDoc), null);
eq("A6 TARGET_WAS_IN_CRISIS reads no", !!ks?.inCrisis, false);

// B. Destroying it returns both.
await f0.actorDoc.update({ "system.props.current_hp": 0 });
await ev.onObjectDestroyed(ctx, { actor: f0.actorDoc, tokenDoc: f0.tokenDoc, firedKeys: new Set() });
eq("B1 Max and HP come back in one go", live(hina), { hp: base.hina, max: base.hina });
eq("B1 no Soul-Torn left", stolen(hina), 0);
await ev.onObjectDestroyed(ctx, { actor: f0.actorDoc, tokenDoc: f0.tokenDoc, firedKeys: new Set() });
eq("B2 a second report refunds nothing", live(hina), { hp: base.hina, max: base.hina });
await roundEnd();
eq("B3 the dead fragment leaves the scene", canvas.scene.tokens.get(f0.tokenDoc.id) ?? null, null);

// C. Chip damage sticks.
const removeFromRoster = (c) => { const i = combatants.indexOf(c); if (i >= 0) combatants.splice(i, 1); };
removeFromRoster(f0);
await keren.update({ "system.props.current_hp": base.keren - 40 });
await roundEnd();
const kf = frag(keren);
eq("C1 a fresh fragment holds the wound", fl(keren), { hp: 40, max: 40 });
await kf.actorDoc.update({ "system.props.current_hp": 10 });
await roundEnd();
eq("C2 chipped to 10, it steals 10 and ends 20/50", fl(keren), { hp: 20, max: 50 });
eq("C2 Keren lost 10 more", live(keren), { hp: base.keren - 50, max: base.keren - 50 });

// D. Wound and Calling overlap.
await keren.update({ "system.props.current_hp": base.keren - 50 - 5 });
await roundEnd();
eq("D1 wound 5 < Calling 20: loses 20", live(keren), { hp: base.keren - 70, max: base.keren - 70 });
eq("D1 the invariant holds", fl(keren).max, base.keren - live(keren).max);

// E. A KO'd owner.
await keren.update({ "system.props.current_hp": 0 });
const before = fl(keren), maxBefore = live(keren).max;
await roundEnd();
eq("E1 no lock, no Calling while KO'd", [fl(keren), live(keren)], [before, { hp: 0, max: maxBefore }]);
await kf.actorDoc.update({ "system.props.current_hp": 0 });
await ev.onObjectDestroyed(ctx, { actor: kf.actorDoc, tokenDoc: kf.tokenDoc, firedKeys: new Set() });
eq("E2 Max returns, the owner stays down", live(keren), { hp: 0, max: base.keren });
removeFromRoster(kf);

// F. Summons are left alone.
eq("F1 the summon stand-in was not locked", live(kalinaLike), { hp: blancheStart.max - 10, max: blancheStart.max });
eq("F1 no fragment for it", frag(kalinaLike), null);
eq("F1 the phantasm stand-in was not locked", live(phantasmLike), { hp: zargStart.max - 10, max: zargStart.max });
eq("F1 no fragment for the phantasm", frag(phantasmLike), null);

// G. Battle end: Max back, current HP stays.
await hina.update({ "system.props.current_hp": 50 });
await roundEnd();
eq("G0 locked", live(hina), { hp: 50, max: 50 });
const gt = frag(hina)?.tokenDoc?.id ?? null;
await ev.onConflictEnd(ctx);
eq("G1 Max returns, current HP does not", live(hina), { hp: 50, max: base.hina });
eq("G2 no fragment tokens", canvas.scene.tokens.filter((t) => t.flags?.[NS]?.soulFragment).length, 0);
eq("G3 no Soul-Torn anywhere", game.actors.filter((a) => a.effects.some((e) => e.flags?.[NS]?.soulTorn)).map((a) => a.name), []);

// R and S start from the clean slate G left: only the party on the roster, nobody owing anything.
const purge = () => { for (let i = combatants.length - 1; i >= 0; i--) if (combatants[i].tokenDoc?.flags?.[NS]?.soulFragment) combatants.splice(i, 1); };
purge();
await hina.update({ "system.props.current_hp": base.hina }); // G left her wounded, and the next round end would lock her

// A refunded player who is still wounded locks again in the same beat, which is correct, so every
// case below starts clean and judges HP at that round's end.
const clean = async () => {
  await ev.onConflictEnd(ctx);
  purge();
  await keren.update({ "system.props.current_hp": base.keren });
  await sleep(50);
};

// R. An F5 inside a refund. Soul-Torn says the debt is still open, and the mark holds the HP to
// pay, so a re-run finishes it on the same number.
const openDebt = async () => {
  await keren.update({ "system.props.current_hp": num(keren.system.props.max_hp) - 20 });
  await roundEnd();
  const f = frag(keren);
  return { f, mark: f.actorDoc.effects.find((e) => e.flags?.[NS]?.soulFragmentMark), hp0: num(keren.system.props.current_hp) };
};
{
  // Stopped after the mark and the HP, before Soul-Torn came off.
  const { f, mark, hp0 } = await openDebt();
  await mark.update({ [`flags.${NS}.soulReturned`]: true, [`flags.${NS}.soulRefundFrom`]: hp0, [`flags.${NS}.soulRefundHp`]: hp0 + 20 });
  await keren.update({ "system.props.current_hp": hp0 + 20 });
  await f.actorDoc.update({ "system.props.current_hp": 0 });
  await roundEnd();
  eq("R1 HP paid, Soul-Torn left: it finishes and does not pay twice", live(keren), { hp: base.keren, max: base.keren });
  eq("R1 Soul-Torn is gone", stolen(keren), 0);
  eq("R1 its token is gone", canvas.scene.tokens.filter((t) => t.flags?.[NS]?.soulFragment).length, 0);
  purge();
}
{
  // Stopped right after the mark: nothing paid yet.
  const { f, mark, hp0 } = await openDebt();
  await mark.update({ [`flags.${NS}.soulReturned`]: true, [`flags.${NS}.soulRefundFrom`]: hp0, [`flags.${NS}.soulRefundHp`]: hp0 + 20 });
  await f.actorDoc.update({ "system.props.current_hp": 0 });
  await roundEnd();
  eq("R2 marked, nothing paid: it is paid in full", live(keren), { hp: base.keren, max: base.keren });
  eq("R2 Soul-Torn is gone", stolen(keren), 0);
  purge();
}

{
  // The refund that ends in Crisis writes Max first. Stopped between: Soul-Torn gone, HP unpaid.
  await clean();
  await keren.update({ "system.props.current_hp": base.keren - 60 });
  await roundEnd();
  const f = frag(keren);
  const mark = f.actorDoc.effects.find((e) => e.flags?.[NS]?.soulFragmentMark);
  const lost = stolen(keren);
  await keren.update({ "system.props.current_hp": 5 });
  await mark.update({ [`flags.${NS}.soulReturned`]: true, [`flags.${NS}.soulRefundFrom`]: 5, [`flags.${NS}.soulRefundHp`]: 5 + lost });
  await keren.effects.find((e) => e.flags?.[NS]?.soulTorn).delete();
  await f.actorDoc.update({ "system.props.current_hp": 0 });
  await roundEnd();
  eq("R3 Soul-Torn gone, HP unpaid: the HP is still paid", live(keren).hp, 5 + lost);
  eq("R3 the refund says it is done", mark.flags?.[NS]?.soulRefundDone, true);
  purge();
}
{
  // The same stop, then the owner took a hit before the round ended. What happened since stands.
  await clean();
  const { f, mark, hp0 } = await openDebt();
  await mark.update({ [`flags.${NS}.soulReturned`]: true, [`flags.${NS}.soulRefundFrom`]: hp0, [`flags.${NS}.soulRefundHp`]: hp0 + 20 });
  await keren.update({ "system.props.current_hp": hp0 - 7 });
  await f.actorDoc.update({ "system.props.current_hp": 0 });
  await roundEnd();
  eq("R4 a later hit is not overwritten by the saved HP", live(keren).hp, hp0 - 7);
  purge();
}
{
  // The same stop, then a KO. The saved HP must not raise them.
  await clean();
  const { f, mark, hp0 } = await openDebt();
  await mark.update({ [`flags.${NS}.soulReturned`]: true, [`flags.${NS}.soulRefundFrom`]: hp0, [`flags.${NS}.soulRefundHp`]: hp0 + 20 });
  await keren.update({ "system.props.current_hp": 0 });
  await f.actorDoc.update({ "system.props.current_hp": 0 });
  await roundEnd();
  eq("R5 a later KO stays down, and Max still comes back", live(keren), { hp: 0, max: base.keren });
  eq("R5 Soul-Torn is gone", stolen(keren), 0);
  await clean();
}

// S. Max written, HP not: an F5 left the owner above their bar.
{
  await keren.update({ "system.props.current_hp": base.keren - 30 });
  await roundEnd();
  const f = frag(keren);
  const said = [], realWarn = ctx.warn;
  ctx.warn = (...w) => said.push(w.map(String).join(" "));
  await keren.update({ "system.props.current_hp": num(keren.system.props.max_hp) + 25 });
  await roundEnd();
  ctx.warn = realWarn;
  eq("S1 the owner is back inside their bar", num(keren.system.props.current_hp) <= num(keren.system.props.max_hp), true);
  eq("S1 it said so", said.some((w) => w.includes("above their Max")), true);
  eq("S1 the owner and the fragment still agree", num(f.actorDoc.system.props.max_hp), stolen(keren));
}
await ev.onConflictEnd(ctx);

Hooks.off("updateActor", hook);
await sleep(300);
const failed = asserts.filter((a) => !a.ok);
return { total: asserts.length, passed: asserts.length - failed.length, failed };
