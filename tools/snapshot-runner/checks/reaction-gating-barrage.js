// End-to-end probe for the session report: Zarg performs a RANGED attack —
// Barrage must be offered normally, then dimmed "Paralyzed" once he is Paralyzed.
const se = await import("/modules/fabula-ultima-companion/scripts/battle-director/skill-effects.js");
const zarg = game.actors.getName("Zarg");
const para = game.items.getName("Debuff")?.effects.getName("Paralyzed")?.toObject();
const payload = { sourceActorUuid: zarg.uuid, actionKind: "Attack", weaponRange: "ranged", weaponType: "ranged" };
const scan = async () => (await se.findPassiveCandidates({ casterActor: zarg, trigger: "creature_performs_action", includeUnavailable: true, payload }))
  .filter((c) => c.carrierName === "Barrage")
  .map((c) => ({ available: c.available, kind: c.unavailableKind, reason: c.unavailableReason, mode: c.mode }));
const before = await scan();
delete para._id; para.disabled = false; para.transfer = false;
const [ae] = await zarg.createEmbeddedDocuments("ActiveEffect", [para]);
const during = await scan();
await zarg.deleteEmbeddedDocuments("ActiveEffect", [ae.id]);
const after = await scan();
return { before, during, after };
