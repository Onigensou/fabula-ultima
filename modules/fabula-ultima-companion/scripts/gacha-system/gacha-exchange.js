// ============================================================================
// Gacha System — Gift Exchange & Ticket Redemption
// ----------------------------------------------------------------------------
// Two separate features that share a screen, deliberately kept apart:
//
//   GIFT EXCHANGE (executeSwap)
//     Free, one-for-one, and bounded by the SET. Own any piece of a set and
//     you may trade it for any other piece of that same set. The set — never
//     the banner — is the boundary: "Oathsworn Paladin" and "Lovely Retainer"
//     share a banner table but never swap into each other.
//
//     This is the valve that stops set-farming being a slot machine. Without
//     it, hitting a 5-star you already own is a dead pull, and the whole
//     economy has to be tuned around that misery.
//
//   TICKET REDEMPTION (executeRedeem)
//     Spend one 5-Star Exchange Ticket for ANY 5-star on ANY banner. The
//     ticket is no longer a pity payout — it is a GM-granted event/holiday
//     reward, so it is deliberately unbounded where the swap is bounded.
//
// THE SWAPPED-IN ITEM IS DESTROYED. There is no vault, no undo, and nothing
// recovers refinement levels or installed orbment augments. Callers MUST show
// inspectDestructive()'s warnings and pass `confirmed` before a swap that
// would burn any of that.
//
// GM-only, both of them.
// ============================================================================

import { GACHA, TICKET_NAME, log, warn } from "./gacha-const.js";
import { listBanners, resolveTableItems } from "./gacha-banners.js";
import { partyActor, partyMembers, spendTicket, readPool } from "./gacha-state.js";
import { reconcileSetBonuses } from "../battle-director/set-bonus.js";

const isPrimaryGM = () => globalThis.FUCompanion?.isPrimaryGM?.() === true;

const propsOf = (item) => item?.system?.props ?? {};

// ── Destructive-state detection ─────────────────────────────────────────────

const isRefined = (item) => {
  const p = propsOf(item);
  return (Number(p.refine_level) || 0) > 0 || (Number(p.refine_count) || 0) > 0;
};

const installedAugments = (item) => {
  const slots = item?.getFlag?.(GACHA.FLAG_NS, "orbment")?.slots ?? [];
  return slots.filter((s) => s != null).length;
};

const isEquipped = (item) => propsOf(item).isEquipped === true;

/**
 * What this swap would irreversibly destroy.
 * @returns {{blocking:string[], warnings:string[]}}
 */
export function inspectDestructive(item) {
  const blocking = [];
  const warnings = [];

  if (isEquipped(item)) blocking.push("This item is currently equipped. Unequip it first.");

  const lvl = Number(propsOf(item).refine_level) || 0;
  if (isRefined(item)) {
    warnings.push(`Refinement will be lost permanently${lvl > 0 ? ` (currently +${lvl})` : ""}.`);
  }

  const augs = installedAugments(item);
  if (augs > 0) {
    warnings.push(`${augs} installed orbment augment${augs === 1 ? "" : "s"} will be destroyed with the item.`);
  }

  return { blocking, warnings };
}

// ── The gacha "set universe" ────────────────────────────────────────────────
// Built from the banner tables rather than scanning every world item, so only
// gacha-obtainable gear is swappable.

function setUniverse() {
  const bySet = new Map(); // set_name -> Map(itemId -> {item,name,img,uuid})

  for (const banner of listBanners()) {
    for (const entry of resolveTableItems(banner.table)) {
      const p = propsOf(entry.item);
      if (p.isSet !== true) continue;
      const setName = String(p.set_name ?? "").trim();
      if (!setName) continue;

      if (!bySet.has(setName)) bySet.set(setName, new Map());
      bySet.get(setName).set(entry.item.id, entry);
    }
  }

  return bySet;
}

/** Every 5-star across every banner — the ticket redemption catalogue. */
export function redeemCatalogue() {
  const out = [];
  const seen = new Set();

  for (const banner of listBanners()) {
    for (const entry of resolveTableItems(banner.table)) {
      if (seen.has(entry.item.id)) continue;
      seen.add(entry.item.id);
      out.push({ ...entry, bannerName: banner.name, setName: String(propsOf(entry.item).set_name ?? "").trim() });
    }
  }

  return out.sort((a, b) => a.setName.localeCompare(b.setName) || a.name.localeCompare(b.name));
}

/**
 * Every swappable piece the party holds, across the party stash AND each
 * member's inventory, with the alternatives it could become.
 */
export async function listSwappable() {
  const party = await partyActor();
  if (!party) return [];

  const universe = setUniverse();
  const holders = [party, ...partyMembers(party)];
  const out = [];

  for (const holder of holders) {
    for (const item of holder.items ?? []) {
      const p = propsOf(item);
      if (p.isSet !== true) continue;

      const setName = String(p.set_name ?? "").trim();
      const set = universe.get(setName);
      if (!set) continue;

      const alternatives = [...set.values()]
        .filter((e) => e.item.name !== item.name)
        .map((e) => ({ name: e.name, img: e.img, uuid: e.uuid }));

      if (!alternatives.length) continue;

      out.push({
        ownerActorUuid: holder.uuid,
        ownerName: holder.name,
        itemId: item.id,
        name: item.name,
        img: item.img,
        setName,
        alternatives,
        ...inspectDestructive(item),
      });
    }
  }

  return out;
}

// ── Gift Exchange ───────────────────────────────────────────────────────────

export async function executeSwap({ ownerActorUuid, itemId, targetItemUuid, confirmed, requesterUserId }) {
  if (!isPrimaryGM()) return { ok: false, reason: "not_primary_gm" };

  const owner = await fromUuid(ownerActorUuid).catch(() => null);
  if (!owner) return { ok: false, reason: "owner_not_found" };

  const owned = owner.items?.get(itemId);
  if (!owned) return { ok: false, reason: "item_not_found" };

  const target = await fromUuid(targetItemUuid).catch(() => null);
  if (!target) return { ok: false, reason: "target_not_found" };

  // Set boundary — the one rule this feature must never bend.
  const ownedSet  = String(propsOf(owned).set_name ?? "").trim();
  const targetSet = String(propsOf(target).set_name ?? "").trim();
  if (!ownedSet || ownedSet !== targetSet) {
    return { ok: false, reason: "set_mismatch", ownedSet, targetSet };
  }
  if (owned.name === target.name) return { ok: false, reason: "same_piece" };

  const { blocking, warnings } = inspectDestructive(owned);
  if (blocking.length) return { ok: false, reason: "blocked", blocking };
  if (warnings.length && !confirmed) return { ok: false, reason: "needs_confirm", warnings };

  const tc = window["oni.ItemTransferCore"];
  if (!tc) return { ok: false, reason: "transfer_core_missing" };

  // Grant first, then destroy. If the grant fails the player keeps their piece
  // rather than losing it to a half-completed swap.
  const grant = await tc.transfer({
    mode: "gmToActor",
    itemUuid: target.uuid,
    quantity: 1,
    receiverActorUuid: owner.uuid,
    requestedByUserId: requesterUserId,
    showTransferCard: false,
  });
  if (!grant?.ok) return { ok: false, reason: "grant_failed" };

  await owned.delete();

  // The set-bonus engine keys off equipped pieces per set_name; a swap changes
  // that composition, so the projection has to be rebuilt or it goes stale.
  try { await reconcileSetBonuses(owner); }
  catch (e) { warn("reconcileSetBonuses failed after swap", e); }

  log(`Gift Exchange: ${owner.name} traded "${owned.name}" → "${target.name}" (set: ${ownedSet})`);
  return { ok: true, from: owned.name, to: target.name, setName: ownedSet, ownerName: owner.name };
}

// ── Ticket redemption ───────────────────────────────────────────────────────

export async function executeRedeem({ targetItemUuid, requesterUserId }) {
  if (!isPrimaryGM()) return { ok: false, reason: "not_primary_gm" };

  const party = await partyActor();
  if (!party) return { ok: false, reason: "party_actor_missing" };

  const target = await fromUuid(targetItemUuid).catch(() => null);
  if (!target) return { ok: false, reason: "target_not_found" };

  // Spend before granting — same all-or-nothing discipline as a wish.
  const spend = await spendTicket(party);
  if (!spend.ok) return { ok: false, ...spend };

  const tc = window["oni.ItemTransferCore"];
  if (!tc) return { ok: false, reason: "transfer_core_missing" };

  const grant = await tc.transfer({
    mode: "gmToActor",
    itemUuid: target.uuid,
    quantity: 1,
    receiverActorUuid: party.uuid,
    requestedByUserId: requesterUserId,
    showTransferCard: false,
  });
  if (!grant?.ok) return { ok: false, reason: "grant_failed" };

  log(`${TICKET_NAME} redeemed → "${target.name}"`);
  return { ok: true, itemName: target.name, pool: readPool(party) };
}
