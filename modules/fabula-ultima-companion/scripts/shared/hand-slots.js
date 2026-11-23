// shared/hand-slots.js — is this weapon two-handed for THIS actor?
//
// `hand_slots` on a weapon is a string ("One-handed" / "Two-handed"); a weapon is two-handed when it contains "two"
// (any capitalisation) and it is not a shield. A skill can let its owner hold some weapon categories in one hand
// through an Active Effect on the actor (data, no skill names in code):
//   key   flags.fabula-ultima-companion.oneHandCategories
//   mode  5 (override)    value  "arcane"   (a comma / space list of weapon categories)
// First user: Book and Blade (Spell Fencer) — "You can equip two-handed arcane weapons in one hand."
const M = "fabula-ultima-companion";

/** Weapon categories `actor` may hold in one hand even when two-handed (lowercase). */
export function oneHandCategories(actor) {
  let raw = null;
  try { raw = actor?.getFlag?.(M, "oneHandCategories") ?? actor?.flags?.[M]?.oneHandCategories ?? null; } catch { raw = actor?.flags?.[M]?.oneHandCategories ?? null; }
  if (raw == null) return [];
  return String(raw).toLowerCase().split(/[\s,]+/).filter(Boolean);
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
