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
import { listBanners, resolveTableItems, imgOf } from "./gacha-banners.js";
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
//
// Two different questions, deliberately answered from two different sources:
//
//   WHICH SETS are in play      → the sets named by the banner tables, so only
//                                 gacha-obtainable gear is swappable.
//   WHICH PIECES a set contains → every world item carrying that `set_name`.
//
// The second used to be read from the banner tables too, which quietly made a
// set piece invisible if it was not itself a table row. `set_name` + `isSet` is
// the canonical membership rule — the same one the Equipment Set engine uses
// (see getEquipmentSets in battle-director/set-bonus.js, which discovers set
// DEFINITIONS by set_name and leaves membership to that pairing).

const SLOT_PRIORITY = ["weapon", "armor", "shield", "accessory"];
const slotRank = (item) => {
  const i = SLOT_PRIORITY.indexOf(String(propsOf(item).item_type ?? "").trim().toLowerCase());
  return i === -1 ? SLOT_PRIORITY.length : i;
};

/** Set names reachable through some banner. */
function gachaSetNames() {
  const names = new Set();
  for (const banner of listBanners()) {
    for (const entry of resolveTableItems(banner.table)) {
      const p = propsOf(entry.item);
      if (p.isSet !== true) continue;
      const s = String(p.set_name ?? "").trim();
      if (s) names.add(s);
    }
  }
  return names;
}

/** set_name -> canonical world pieces, slot-sorted. */
function setUniverse() {
  const wanted = gachaSetNames();
  const bySet = new Map();

  for (const it of game.items ?? []) {
    const p = propsOf(it);
    if (p.isSet !== true) continue;
    const setName = String(p.set_name ?? "").trim();
    if (!setName || !wanted.has(setName)) continue;

    if (!bySet.has(setName)) bySet.set(setName, new Map());
    // Keyed by NAME: an owned copy is a clone with a different id, so name is
    // the only stable identity between a template and an inventory instance.
    bySet.get(setName).set(it.name, { item: it, name: it.name, img: it.img, uuid: it.uuid });
  }

  for (const [k, m] of bySet) {
    bySet.set(k, new Map([...m.entries()].sort((a, b) =>
      slotRank(a[1].item) - slotRank(b[1].item) || a[0].localeCompare(b[0]))));
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
      out.push({ ...entry, bannerName: banner.title, setName: String(propsOf(entry.item).set_name ?? "").trim() });
    }
  }

  return out.sort((a, b) => a.setName.localeCompare(b.setName) || a.name.localeCompare(b.name));
}

/**
 * The whole Gift Exchange board: every gacha set, every piece in it, and which
 * of those pieces the party actually holds.
 *
 * ALL sets are returned, not just ones the party has a piece of — an empty set
 * tab doubles as a "what could we work toward" view.
 *
 * @returns {Promise<Array<{setName, pieces, ownedCount}>>}
 *   pieces: [{ name, img, uuid, owned: null | {ownerActorUuid, ownerName,
 *              itemId, warnings, blocking} }]
 */
export async function listSetBoard() {
  const party = await partyActor();
  if (!party) return [];

  const universe = setUniverse();
  const holders = [party, ...partyMembers(party)];

  // name -> first held instance. First wins: two copies of one piece are still
  // one trade, and the swap only ever consumes a single document.
  const held = new Map();
  for (const holder of holders) {
    for (const item of holder.items ?? []) {
      const p = propsOf(item);
      if (p.isSet !== true || held.has(item.name)) continue;
      held.set(item.name, { holder, item });
    }
  }

  const board = [];
  for (const [setName, members] of universe) {
    const pieces = [...members.values()].map((e) => {
      const hit = held.get(e.name);
      return {
        name: e.name,
        img: imgOf(e),
        uuid: e.uuid,
        owned: hit
          ? {
              ownerActorUuid: hit.holder.uuid,
              ownerName: hit.holder.name,
              itemId: hit.item.id,
              ...inspectDestructive(hit.item),
            }
          : null,
      };
    });

    board.push({ setName, pieces, ownedCount: pieces.filter((p) => p.owned).length });
  }

  return board.sort((a, b) => b.ownedCount - a.ownedCount || a.setName.localeCompare(b.setName));
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
