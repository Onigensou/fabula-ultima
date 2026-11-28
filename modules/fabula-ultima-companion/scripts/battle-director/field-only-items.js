// scripts/battle-director/field-only-items.js
// "Out of battle only" consumables (to-do #13).
//
// Forget me Nut ("Reduce a Skill level by one and Recover 1 Skill Point") was
// offered as usable in the battle Item menu. An item now carries a sheet
// checkbox, system.props.out_of_battle_only (declared on the equippable item
// template by template-props-registry.js, so a template reload never prunes
// it). The battle Item menu shows such an item greyed out with the reason
// "Out of battle only": still listed, never usable. DECLARE refuses it too, so
// no other route (sim, scripted test, Copycat, a crafted intent) can spend it
// in battle. Field use (party menu, camp) is untouched.
//
// Read from the data prop only, never from the item's name.

export const OUT_OF_BATTLE_PROP = "out_of_battle_only";
export const OUT_OF_BATTLE_LABEL = "Out of battle only";

// A CSB checkbox stores a boolean; a hand edit or an import may leave a string.
export function isOutOfBattleOnly(props) {
  const v = props?.[OUT_OF_BATTLE_PROP];
  if (v === true || v === 1) return true;
  return /^(true|1|yes|on)$/i.test(String(v ?? "").trim());
}

// Same check on a document (an Item, or anything with system.props).
export function isOutOfBattleOnlyItem(item) {
  return isOutOfBattleOnly(item?.system?.props);
}
