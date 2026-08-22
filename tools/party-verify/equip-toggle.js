// Temporarily equip gear so its linked _skill rows become probeable, then put it
// back EXACTLY as it was.
//
// `containerReactionInPlay` gates a gear-linked reaction on the container's
// isEquipped, so an unequipped item's rows report NOT_SCANNED — correct
// behaviour, but indistinguishable from "the skill is dead".
//
// ARGS: { who, items: [name...], apply: bool, restore: <saved state> }
// Always records the PRIOR state and returns it, so the caller can restore by
// exact item id even if the probe run dies in between.
const actor = game.actors.getName(ARGS.who);
if (!actor) return { err: "actor not found", who: ARGS.who };

if (ARGS.restore) {
  const done = [];
  for (const rec of ARGS.restore) {
    const it = actor.items.get(rec.id);
    if (!it) { done.push({ id: rec.id, missing: true }); continue; }
    const now = it.system?.props?.isEquipped === true;
    if (now !== rec.wasEquipped) {
      await it.update({ "system.props.isEquipped": rec.wasEquipped });
      done.push({ name: it.name, restoredTo: rec.wasEquipped });
    } else done.push({ name: it.name, alreadyCorrect: true });
  }
  return { restored: done,
    equippedNow: actor.items.filter(i => i.system?.props?.isEquipped === true).map(i => i.name) };
}

const saved = [];
for (const nm of ARGS.items) {
  // 🪤 Prefer the GEAR SHELL over a same-named linked `_skill`. Zarg's Skull Orb
  // is a shell (accessory `SopXXY9q83NQSm2x`) PLUS a linked _skill
  // (`quQU5EZb9TSIxJYp`) with the identical name; a bare name match hits the
  // skill, whose isEquipped means nothing, so the equip silently does nothing
  // and the rows still read NOT_SCANNED.
  const matches = actor.items.filter(i => i.name === nm);
  const it = matches.find(i => String(i.system?.props?.item_type ?? "").trim()) ?? matches[0];
  if (!it) { saved.push({ name: nm, missing: true }); continue; }
  saved.push({ id: it.id, name: it.name, wasEquipped: it.system?.props?.isEquipped === true,
               itemType: it.system?.props?.item_type });
}
if (!ARGS.apply) return { dryRun: true, saved };
const changed = [];
for (const rec of saved) {
  if (rec.missing || rec.wasEquipped) continue;
  const it = actor.items.get(rec.id);
  await it.update({ "system.props.isEquipped": true });
  changed.push(it.name);
}
return { saved, equipped: changed,
  equippedNow: actor.items.filter(i => i.system?.props?.isEquipped === true).map(i => i.name) };
