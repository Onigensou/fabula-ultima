// shared/hand-slots.js — is this weapon two-handed for THIS actor?
//
// `hand_slots` on a weapon is a string ("One-handed" / "Two-handed"); a weapon is two-handed when it contains "two"
// (any capitalisation) and it is not a shield. A skill can let its owner hold some weapon categories in one hand through
// an Active Effect change on the actor (data, no skill names in code), read the same way as weapon_category_alias
// (battle-director/weapon-alias.js): straight from the applied AEs' changes, so CSB never needs to know the key.
//   key   one_hand_categories     value  "arcane"   (a comma / space list of weapon categories; several AEs add up)
// First user: Book and Blade (Spell Fencer) — "You can equip two-handed arcane weapons in one hand."
const KEY = "one_hand_categories";

/** Weapon categories `actor` may hold in one hand even when two-handed (lowercase). */
export function oneHandCategories(actor) {
  const out = new Set();
  let effs = [];
  try { effs = Array.from(actor?.appliedEffects ?? actor?.effects?.contents ?? []); } catch { effs = []; }
  for (const ae of effs) {
    if (!ae || ae.disabled) continue;
    for (const ch of ae.changes ?? []) {
      if (ch?.key !== KEY) continue;
      for (const c of String(ch.value ?? "").toLowerCase().split(/[\s,;]+/)) if (c) out.add(c);
    }
  }
  return [...out];
}

/** True when the item's own data says two-handed (shields never are). */
export function isTwoHandedItem(item) {
  const p = item?.system?.props ?? {};
  if (String(p.item_type ?? "").toLowerCase() === "shield") return false;
  return String(p.hand_slots ?? "").toLowerCase().includes("two");
}

/** Two-handed for this actor: two-handed by data, unless the actor holds its category in one hand. */
export function isTwoHandedFor(actor, item) {
  if (!isTwoHandedItem(item)) return false;
  if (!actor) return true;
  const cat = String(item?.system?.props?.category ?? "").trim().toLowerCase();
  return !(cat && oneHandCategories(actor).includes(cat));
}
