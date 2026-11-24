// ============================================================================
// Party stash — its items never project effects onto the party actor.
//
// The central party actor (the "party database": EXFURSION Party, Zenit Crisis
// Party …) is a shared bag, not a creature. Gear sitting in it must not apply
// its transfer AEs to it: on 2026-11-21 a looted Gravedigger Shovel put
// "Cursed" on the party token, and Happy Feet granted the party actor
// "Frenetic Footwork SL +2". Fresh loot arrives with the world item's
// `disabled:false`, and the equip system only flips that on equip/unequip.
//
// Read by the ActiveEffect `isSuppressed` patch in stash-effect-suppress.js, so
// Foundry's own `active` / `appliedEffects` / `statuses` (token icons, stat
// changes, every reaction scan) drop these effects. Nothing is written: the
// item keeps its own `disabled` state and behaves normally again the moment it
// moves to a character. Dependency-free so node tests can import it.
// ============================================================================

/** The party database actor is the one carrying the roster fields. */
export function isPartyStashActor(actor) {
  const props = actor?.system?.props;
  return !!props && typeof props === "object" && "member_id_1" in props;
}

/** True for an effect that lives on an item held by the party stash actor. */
export function stashSuppressesEffect(effect) {
  const item = effect?.parent;
  if (!item || item.documentName !== "Item") return false;
  const actor = item.parent;
  if (!actor || actor.documentName !== "Actor") return false;
  return isPartyStashActor(actor);
}
