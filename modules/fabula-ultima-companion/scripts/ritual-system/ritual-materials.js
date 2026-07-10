// ============================================================================
// Ritual System — the offered material.
//
// "In order to reduce this cost, the spellcaster may provide an especially rare
// or powerful ingredient" (core p. 120). The book halves the cost flat; we
// scale the reduction by the material's rarity instead (see RARITY_DISCOUNT).
//
// ── Which materials may be offered ──────────────────────────────────────────
// The performer's own inventory, plus the main party actor's shared inventory
// (the "EXFURSION Party" DB actor, resolved through db-resolver rather than by
// name). Materials sitting in ANOTHER character's private bag are not
// offerable — Blanche's Moonfish is Blanche's until she hands it over.
//
// ── Consumption ────────────────────────────────────────────────────────────
// The material is spent when the ritual is initiated, alongside the MP, and is
// not returned on a failed check. Anything else would make the discount free
// and let a player retry a cheap ritual forever. `item_quantity` is a CSB
// string field: decrement it, and delete the item when it hits zero.
// ============================================================================

import { RITUAL_TAG, RITUAL_MATERIAL, discountForRarity } from "./ritual-const.js";

/** Is this item a material? */
export function isMaterial(item) {
  return String(item?.system?.props?.[RITUAL_MATERIAL.TYPE_PROP] ?? "").toLowerCase()
    === RITUAL_MATERIAL.TYPE_VALUE;
}

/** CSB stores item_quantity as a string. */
export function quantityOf(item) {
  const n = Number(item?.system?.props?.[RITUAL_MATERIAL.QTY_PROP]);
  return Number.isFinite(n) ? n : 0;
}

export function rarityOf(item) {
  return String(item?.system?.props?.[RITUAL_MATERIAL.RARITY_PROP] ?? "Common");
}

/** The main party actor — the shared inventory. Resolved, never hardcoded. */
export async function resolvePartyActor() {
  try {
    const res = await globalThis.FUCompanion?.api?.getCurrentGameDb?.();
    return res?.db ?? null;
  } catch (e) {
    console.warn(RITUAL_TAG, "party actor resolve failed", e);
    return null;
  }
}

function entriesFrom(actor, source) {
  if (!actor) return [];
  return actor.items
    .filter((i) => isMaterial(i) && quantityOf(i) > 0)
    .map((i) => ({
      itemId: i.id,
      actorUuid: actor.uuid,
      actorName: actor.name,
      source,                       // "self" | "party"
      name: i.name,
      img: i.img,
      rarity: rarityOf(i),
      discount: discountForRarity(rarityOf(i)),
      quantity: quantityOf(i),
    }));
}

/**
 * Every material the performer may offer: their own bag plus the party's.
 *
 * The "(Empty)" placeholder material used by the steal/loot tables is filtered
 * out — it is a table slot, not a thing you can put on an altar.
 */
export async function gatherOfferableMaterials(performerActor) {
  const party = await resolvePartyActor();
  const own = entriesFrom(performerActor, "self");
  // Skip the party bag when the performer IS the party actor, or it lists twice.
  const shared = (party && party.id !== performerActor?.id) ? entriesFrom(party, "party") : [];

  return [...own, ...shared]
    .filter((m) => m.name !== "(Empty)")
    .sort((a, b) => (b.discount - a.discount) || a.name.localeCompare(b.name));
}

/** Re-read one offered material GM-side. Never trust the client's rarity. */
export async function resolveMaterial({ actorUuid, itemId } = {}) {
  if (!actorUuid || !itemId) return null;
  const actor = await fromUuid(actorUuid).catch(() => null);
  const owner = actor?.documentName === "Actor" ? actor : (actor?.actor ?? null);
  const item = owner?.items?.get(itemId) ?? null;
  if (!item || !isMaterial(item) || quantityOf(item) <= 0) return null;
  return {
    item, owner,
    name: item.name,
    rarity: rarityOf(item),
    discount: discountForRarity(rarityOf(item)),
    quantity: quantityOf(item),
  };
}

/**
 * Spend one unit of the material. GM-only — the performer may not own the
 * party actor. Deletes the item when the last unit is consumed.
 */
export async function consumeMaterial(resolved) {
  if (!resolved?.item) return false;
  const { item } = resolved;
  const left = quantityOf(item) - 1;
  try {
    if (left <= 0) await item.delete();
    else await item.update({ [`system.props.${RITUAL_MATERIAL.QTY_PROP}`]: String(left) });
    return true;
  } catch (e) {
    console.warn(RITUAL_TAG, "material consume failed", e);
    return false;
  }
}
