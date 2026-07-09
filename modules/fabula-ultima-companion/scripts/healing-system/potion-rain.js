// ============================================================================
// Out-of-Combat Healing — Potion Rain support.
//
// Potion Rain (a Passive skill) lets its owner spread a single-target *potion*
// across up to SL ADDITIONAL allies. When it affects more than one creature,
// each one recovers HALF the normal amount (rounded UP) — matching the skill's
// own declarative recipe (adjust_grant × 0.5, round "up").
//
// This module centralises the two facts the HUD and the GM apply handler both
// need, so they can never disagree:
//   1. Does the caster own Potion Rain, and at what SL.
//   2. Is a given item a "potion" — defined by the module-wide `skill_tags`
//      "potion" tag (the SAME definition the reaction engine reads via
//      SKILL_HAS_TAG_POTION); we reuse it rather than inventing a bespoke rule.
// ============================================================================

const POTION_RAIN_NAME = "potion rain";
const POTION_TAG = "potion";

// Tokenise a CSB `skill_tags` string the SAME way the reaction engine does
// (comma/space separated, case-insensitive) so "what counts as a potion" is a
// single shared definition that can't drift between systems.
export function itemTags(item) {
  return String(item?.system?.props?.skill_tags ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function itemHasTag(item, tag) {
  return itemTags(item).includes(String(tag ?? "").toLowerCase());
}

// Is this item a potion? Uses the shared `skill_tags: "potion"` definition.
export function isPotionItem(item) {
  return itemHasTag(item, POTION_TAG);
}

// Potion Rain ownership + SL for an actor. SL lives on the owned Passive skill
// named "Potion Rain" in `system.props.level` (fallback `max_level`, then
// `system.level`) — the fallback chain used elsewhere for skill level.
export function getPotionRain(actor) {
  const items = actor?.items?.contents ?? (Array.isArray(actor?.items) ? actor.items : []);
  for (const it of items) {
    if (String(it?.name ?? "").trim().toLowerCase() !== POTION_RAIN_NAME) continue;
    const p = it.system?.props ?? {};
    const sl = Number(p.level ?? p.max_level ?? it.system?.level ?? 0) || 0;
    return { has: true, sl: Math.max(0, sl), item: it };
  }
  return { has: false, sl: 0, item: null };
}

// Half-heal for a spread: round UP, per the skill's own recipe.
export function halveHeal(amount) {
  return Math.max(0, Math.ceil(Number(amount || 0) / 2));
}
