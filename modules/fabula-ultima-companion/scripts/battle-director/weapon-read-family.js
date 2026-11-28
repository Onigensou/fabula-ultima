// Which weapon lane does an action read? Pure half of skill-effects.js
// resolveWeaponReadFamily (Rakshasa's Adaptive Defense, effect_kind "weapon_read").
// The caller looks the weapon item up (fromUuid) and passes its props here.
//
// Resolution order (docs/rakshasa-design-proposal.md §4.4):
//   1. the weapon item       a SHIELD is brawling (a shield is never a weapon, so a
//                            shield attack is always a virtual brawling profile);
//                            else the item's category
//   2. payload.weaponType    the only thing a VIRTUAL attack carries (Blanche's Twin
//                            Shields has no item, so step 1 finds nothing)
//   3. a Spell               arcane, the engine's own "spells count as Arcane" rule
//                            (action-profile.js weaponKey). The BD stamps BOTH skills
//                            and spells `ar.kind: "Skill"`, so `actionKind` alone never
//                            says "spell": the spell fact is `actionSkillType` (the
//                            casting item's skill_type), carried on every
//                            post-resolve payload.
// null = nothing resolves: the row fails CLOSED instead of charging some lane.

export const WEAPON_READ_FAMILIES = Object.freeze([
  "arcane", "bow", "brawling", "dagger", "firearm", "flail", "heavy",
  "spear", "sword", "thrown",
]);

const norm = (v) => {
  const s = String(v ?? "").trim().toLowerCase();
  return WEAPON_READ_FAMILIES.includes(s) ? s : null;
};

/**
 * @param {object} payload     the trigger payload (weaponType, actionKind, actionSkillType)
 * @param {object|null} itemProps  system.props of the payload's weapon item, if any
 */
export function weaponReadFamilyOf(payload, itemProps = null) {
  const p = itemProps ?? null;
  if (p) {
    if (String(p.item_type ?? "").toLowerCase() === "shield") return "brawling";
    const cat = norm(p.category ?? p.weapon_type ?? p.type);
    if (cat) return cat;
  }

  const fromPayload = norm(payload?.weaponType);
  if (fromPayload) return fromPayload;

  const kind = String(payload?.actionKind ?? "").trim().toLowerCase();
  const skillType = String(payload?.actionSkillType ?? "").trim().toLowerCase();
  if (kind === "spell" || skillType === "spell") return "arcane";

  return null;
}
