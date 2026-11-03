// Carry limit — "you may only hold N copies of this item" (Life Charm, Magic Mirror).
//
// An item opts in with `flags.fabula-ultima-companion.carryLimit = N` (a flag, so a
// CSB template re-stamp cannot prune it and every copy carries it). The limit binds
// PARTY MEMBERS only — the database actor's active / reserve / away slots. The Party
// Bag (the database actor itself), shopkeepers and every other actor hold any number.
//
// Enforced at the two ItemTransferCore delivery modes (shop, roulette, trades,
// party-menu moves all go through them): what does not fit on the member goes to
// the Party Bag. The Party Menu also refuses the move up front (moveRefusal), so a
// player never sees a hand-over silently land somewhere else.
//
// ItemTransferCore is a classic script, so it reaches this through
// FUCompanion.api.carryLimit rather than an import.

import { getPartyRoster } from "../party-menu/party-menu-core.js";

const NS = "fabula-ultima-companion";
const GEAR_TEMPLATE = "ZoiV53VaLzeRsEps";

const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

/** The item's carry limit, or 0 when it has none. */
export function carryLimitOf(item) {
  const n = Math.floor(num(item?.flags?.[NS]?.carryLimit, 0));
  return n > 0 ? n : 0;
}

/** Copies of `item` (by name) the actor carries as inventory items — not sub-items. */
export function heldCount(actor, item) {
  const name = String(item?.name ?? "").trim().toLowerCase();
  if (!actor || !name) return 0;
  let n = 0;
  for (const it of actor.items?.contents ?? []) {
    if (String(it.system?.template ?? "") !== GEAR_TEMPLATE) continue;
    const holder = String(it.system?.container ?? "");
    if (holder && holder !== "-" && actor.items.get(holder)) continue;
    if (String(it.name ?? "").trim().toLowerCase() !== name) continue;
    n += Math.max(0, num(it.system?.props?.item_quantity, 1));
  }
  return n;
}

/** Is `actor` a party member the limit binds (not the bag, not a shopkeeper)? */
export function isLimitedHolder(actor, roster) {
  if (!actor || !roster) return false;
  if (roster.db && actor.id === roster.db.id) return false;
  return [...(roster.active ?? []), ...(roster.reserve ?? []), ...(roster.away ?? [])].some((a) => a?.id === actor.id);
}

/** How many more copies of `item` the actor may take; Infinity when unbound. */
export function carryRoom(actor, item, roster) {
  const limit = carryLimitOf(item);
  if (!limit || !isLimitedHolder(actor, roster)) return Infinity;
  return Math.max(0, limit - heldCount(actor, item));
}

/**
 * How a delivery of `qty` copies to `receiver` splits:
 * `{ keep, overflow, bag }`, or null when the limit does not apply.
 */
export async function planCarry({ item, receiver, qty }) {
  if (!carryLimitOf(item)) return null;
  const roster = await getPartyRoster();
  const room = carryRoom(receiver, item, roster);
  if (!Number.isFinite(room) || qty <= room) return null;
  return { keep: room, overflow: qty - room, bag: roster.db ?? null };
}

export function initCarryLimit() {
  globalThis.FUCompanion ??= {};
  globalThis.FUCompanion.api ??= {};
  globalThis.FUCompanion.api.carryLimit = { carryLimitOf, heldCount, carryRoom, planCarry, getPartyRoster };
}

Hooks.once("init", initCarryLimit);
