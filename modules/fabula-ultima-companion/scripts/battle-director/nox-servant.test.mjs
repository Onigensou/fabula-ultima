// Run: node nox-servant.test.mjs
import assert from "node:assert/strict";
globalThis.CONFIG = { statusEffects: [] };
globalThis.game = { combat: null, user: { isGM: true }, actors: { get: () => null } };
const { noxServantAeData, isNoxServant, NOX_FLAG, isTargetBlockedFor } = await import("./nox-servant.js");
const { hasUnconditionalTargetBlock, getTargetSideBlocks } = await import("./snapshot.js");

const NS = "fabula-ultima-companion";
const mk = (uuid, effects = [], disp) => ({ uuid, name: uuid, effects: { contents: effects }, prototypeToken: { disposition: disp } });
const servantAE = () => ({ ...noxServantAeData(), disabled: false });
const servant = (disp = 1) => mk("A.servant", [servantAE()], disp);
const charm = { name: "Charm", disabled: false, changes: [{ key: "allegiance_override", value: "ally:enemy" }] };

// AE shape
const d = noxServantAeData();
assert.equal(d.flags[NS][NOX_FLAG], true);
assert.equal(d.flags[NS].directorPermanent, true);
assert.equal(d.flags[NS].conflictScoped, true);
assert.equal(d.flags[NS].directorAppliedBy, undefined);
assert.equal(d.system?.tags, undefined);
assert.ok(d.img.startsWith("icons/svg/"));
assert.deepEqual(d.changes.map((c) => [c.key, c.mode, c.value]), [["cannot_be_targeted_by", 5, "opponent"], ["hp_floor", 5, "1"]]);
assert.equal(isNoxServant(servant()), true);
assert.equal(isNoxServant({ actor: servant() }), true);
assert.equal(isNoxServant(mk("x", [{ ...servantAE(), disabled: true }])), false);
assert.equal(isNoxServant(mk("x")), false);

// `opponent` is ignored by the unconditional (ally pool) block
assert.equal(hasUnconditionalTargetBlock(servant()), false);
assert.ok(getTargetSideBlocks(servant()).some((b) => b.ranges.has("opponent")));

const o = (a, t) => ({ attackerDisp: a, targetDisp: t });
const S = servant();
assert.equal(isTargetBlockedFor(S, mk("A.pc", [], 1), o(1, 1)), false, "ally ok");
assert.equal(isTargetBlockedFor(S, mk("A.mon", [], -1), o(-1, 1)), true, "opponent blocked");
assert.equal(isTargetBlockedFor(S, mk("A.neu", [], 0), o(0, 1)), false, "neutral");
assert.equal(isTargetBlockedFor(S, S, o(1, 1)), false, "self");
assert.equal(isTargetBlockedFor(mk("A.plain"), mk("A.mon", [], -1), o(-1, 1)), false, "no block");
// charmed party member: natural ally, charmed side enemy
assert.equal(isTargetBlockedFor(S, mk("A.pc2", [charm], 1), o(1, 1)), true, "charmed (charmed side)");
// charmed monster: natural opponent, still blocked
assert.equal(isTargetBlockedFor(S, mk("A.mon2", [charm], -1), o(-1, 1)), true, "charmed (natural side)");
// no performer
assert.equal(isTargetBlockedFor(S, null, o(undefined, 1)), true, "no performer");
assert.equal(isTargetBlockedFor(mk("A.plain"), null), false, "no performer, no block");
// monster dominated onto the party (disposition now friendly)
assert.equal(isTargetBlockedFor(S, mk("A.dom", [], 1), o(1, 1)), false, "dominated onto party");

// makeNoxServant: HP write rules + failure reporting
{
  const { makeNoxServant } = await import("./nox-servant.js");
  const _w = console.warn; console.warn = () => {};   // settleRevive import warns in bare Node
  const mkActor = ({ max = 30, hp = 0, effects = [], failUpdate = false } = {}) => {
    const a = {
      uuid: "A.x", name: "x", _effects: [...effects], writes: [],
      system: { props: { max_hp: max, current_hp: hp } },
      get effects() { return { contents: a._effects }; },
      async createEmbeddedDocuments(_t, docs) { for (const dd of docs) a._effects.push(dd); },
      async update(u) { if (failUpdate) throw new Error("nope"); a.writes.push(u); },
    };
    return a;
  };
  let a = mkActor();
  let r = await makeNoxServant(a);
  assert.equal(r.ok, true); assert.equal(r.already, false);
  assert.deepEqual(a.writes, [{ "system.props.current_hp": 30 }], "fresh conversion heals to Max");
  a = mkActor({ effects: [servantAE()], hp: 7 });
  r = await makeNoxServant(a);
  assert.equal(r.ok, true); assert.equal(r.already, true);
  assert.deepEqual(a.writes, [], "already a Servant: no HP write");
  r = await makeNoxServant(mkActor({ max: NaN }));
  assert.equal(r.ok, false, "no finite max: fails");
  r = await makeNoxServant(mkActor({ failUpdate: true }));
  assert.equal(r.ok, false, "HP write throws: fails");
  assert.match(r.reason, /HP write failed/);
  // display: one short line, no statuses (like the Soul-Torn AE)
  assert.ok(noxServantAeData().description.length < 90);
  assert.equal(noxServantAeData().statuses, undefined);
  console.warn = _w;
}
console.log("nox-servant tests OK");
