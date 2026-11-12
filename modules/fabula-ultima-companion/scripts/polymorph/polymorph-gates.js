// ============================================================================
// Polymorph — read-only gates for the Battle Director.
//
// Dependency-free on purpose: actor-shape.js, skill-picker.js and
// skill-effects.js import this, and none of them should pull in the socket /
// hook wiring of polymorph-core.js.
//
// While a creature is transformed it is "fully that creature" (user ruling
// 2026-11-12): it acts with the FORM's kit only — the monster's items, copied
// onto the bearer at transform time and flagged `polymorphItem`. Its own class
// skills, gear-granted skills and item-borne reactions are out of play until it
// reverts. AE-borne reactions are not gated here (statuses keep working).
// ============================================================================

const NS = "fabula-ultima-companion";

/** True while `actor` carries a Polymorph form. */
export function isPolymorphed(actor) {
  const s = actor?.flags?.[NS]?.polymorph;
  return !!(s && typeof s === "object" && s.formName);
}

/** True for an item copied from the form actor (removed again on revert). */
export function isFormItem(item) {
  return item?.flags?.[NS]?.polymorphItem === true;
}

/**
 * Is `item` usable / live on `actor` as far as Polymorph is concerned?
 * Not transformed → always true (no change to anything). Transformed → only the
 * form's own items.
 */
export function polymorphItemInPlay(item, actor) {
  const owner = actor ?? item?.parent ?? null;
  if (!isPolymorphed(owner)) return true;
  return isFormItem(item);
}

/**
 * Gear suspended (user ruling 2026-11-12): while transformed, every effect an
 * actor gets FROM ITS OWN ITEMS (equipment, quirks, class passives — the
 * item-transferred AEs) is out of play: no stat bonuses, no reactions. Effects
 * sitting on the actor itself (statuses, buffs cast on it, the Form effect) stay
 * live. The form's copied items keep theirs. Read by the ActiveEffect
 * `isSuppressed` patch in polymorph-core.js, so Foundry's own `active` /
 * `appliedEffects` (and every BD scan built on them) drop these effects.
 */
export function polymorphSuppressesEffect(effect) {
  const item = effect?.parent;
  if (!item || item.documentName !== "Item") return false;
  const actor = item.parent;
  if (!actor || actor.documentName !== "Actor") return false;
  return isPolymorphed(actor) && !isFormItem(item);
}
