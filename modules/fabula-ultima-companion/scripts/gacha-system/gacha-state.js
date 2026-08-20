// ============================================================================
// Gacha System — State
// ----------------------------------------------------------------------------
// Everything that reads or writes persistent gacha state lives here:
//   * the party-wide coupon / ticket pool (item_quantity on the PARTY actor)
//   * per-banner pity counters (party actor flags)
//   * pull-rate resolution (sheet props override the coded defaults)
//
// Reads are safe anywhere. WRITES ARE GM-ONLY and every one of them is called
// from gacha-engine.js behind an isPrimaryGM() gate — no exceptions, so a
// second signed-in GM can never double-apply a spend or a pity tick.
// ============================================================================

import {
  GACHA, COUPON_ITEM_UUID, COUPON_NAME, COUPON_FALLBACK_COST,
  TICKET_ITEM_UUID, TICKET_NAME, DEFAULT_RATES, warn,
} from "./gacha-const.js";

// ── Party actor ─────────────────────────────────────────────────────────────

/**
 * The database / party actor, as a WORLD document.
 *
 * Deliberately `db` and not `source`: the resolver's `source` may be a
 * per-scene token override, whose props do not persist off that scene. The
 * legacy Gacha Roller wrote pity to the override and silently lost it whenever
 * the party stood on a different map.
 */
export async function partyActor() {
  const res = await globalThis.FUCompanion?.api?.getCurrentGameDb?.();
  const actor = res?.db ?? null;
  if (!actor) warn("Could not resolve the party/database actor.");
  return actor;
}

/** Party member actors (member_id_1..N on the database actor). */
export function partyMembers(dbActor) {
  const props = dbActor?.system?.props ?? {};
  const out = [];
  for (let i = 1; i <= 8; i++) {
    const raw = String(props[`member_id_${i}`] ?? "").trim();
    if (!raw) continue;
    const id = raw.startsWith("Actor.") ? raw.slice(6) : raw;
    const a = game.actors?.get(id);
    if (a) out.push(a);
  }
  return out;
}

/** True when this client's assigned character is a party member. */
export function isPartyMemberClient(dbActor) {
  const mine = game.user?.character;
  if (!mine) return false;
  return partyMembers(dbActor).some((a) => a.id === mine.id);
}

// ── Currency pool ───────────────────────────────────────────────────────────
// The pool is one embedded item on the party actor. Single document, single
// write per spend — no summing across four inventories, no ambiguity about
// whose coupon was consumed, and nothing for two GMs to race on.

function findByName(actor, name) {
  return actor?.items?.find((i) => i.name === name) ?? null;
}

export const couponItemOf = (actor) => findByName(actor, COUPON_NAME);
export const ticketItemOf = (actor) => findByName(actor, TICKET_NAME);

const qtyOf = (item) => Math.max(0, Math.floor(Number(item?.system?.props?.item_quantity ?? 0)) || 0);

/** @returns {{coupons:number, tickets:number}} */
export function readPool(actor) {
  return { coupons: qtyOf(couponItemOf(actor)), tickets: qtyOf(ticketItemOf(actor)) };
}

/** Unit price of a coupon, read from the world template's own item_cost. */
export async function couponCost() {
  const tpl = await fromUuid(COUPON_ITEM_UUID).catch(() => null);
  const c = Number(tpl?.system?.props?.item_cost);
  return Number.isFinite(c) && c > 0 ? c : COUPON_FALLBACK_COST;
}

/**
 * Spend `n` coupons. GM-only.
 * Fails atomically — the caller checks this BEFORE rolling, so a batch can
 * never half-commit.
 */
export async function spendCoupons(actor, n) {
  const item = couponItemOf(actor);
  const have = qtyOf(item);
  if (!item) return { ok: false, reason: "no_coupon_item" };
  if (have < n) return { ok: false, reason: "insufficient_coupons", have, need: n };

  await item.update({ "system.props.item_quantity": have - n });
  return { ok: true, remaining: have - n };
}

/** Spend one exchange ticket. GM-only. */
export async function spendTicket(actor) {
  const item = ticketItemOf(actor);
  const have = qtyOf(item);
  if (!item || have < 1) return { ok: false, reason: "no_ticket" };

  await item.update({ "system.props.item_quantity": have - 1 });
  return { ok: true, remaining: have - 1 };
}

/**
 * Add `n` coupons to the pool, minting from the world template when the party
 * has none yet. GM-only.
 *
 * Minting rather than transferring is deliberate: coupons are currency, and
 * drawing them from Hako's finite shop stock would let the vendor run dry
 * mid-session.
 */
export async function grantCoupons(actor, n) {
  const existing = couponItemOf(actor);

  if (existing) {
    await existing.update({ "system.props.item_quantity": qtyOf(existing) + n });
    return { ok: true, total: qtyOf(existing) + n };
  }

  const tpl = await fromUuid(COUPON_ITEM_UUID).catch(() => null);
  if (!tpl) return { ok: false, reason: "coupon_template_missing" };

  const data = tpl.toObject();
  delete data._id;
  data.system.props.item_quantity = n;
  await actor.createEmbeddedDocuments("Item", [data]);
  return { ok: true, total: n };
}

// ── Rates ───────────────────────────────────────────────────────────────────

/**
 * Pull rates as fractions summing to 1.
 *
 * Sheet props (`gacha_rate_rare` / `_medium` / `_junk`, CSB strings) override
 * the coded defaults so the GM can retune live. Values may be authored as
 * percentages (85) or fractions (0.85); both are accepted, then normalised.
 */
export function resolveRates(actor) {
  const p = actor?.system?.props ?? {};
  const pick = (raw, fallback) => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return n > 1 ? n : n * 100;
  };

  const five  = pick(p.gacha_rate_rare,   DEFAULT_RATES.five);
  const four  = pick(p.gacha_rate_medium, DEFAULT_RATES.four);
  const three = pick(p.gacha_rate_junk,   DEFAULT_RATES.three);

  const total = five + four + three;
  if (total <= 0) return { five: 0.03, four: 0.12, three: 0.85 };

  return { five: five / total, four: four / total, three: three / total };
}

// ── Pity ────────────────────────────────────────────────────────────────────
// Per banner, two counters. The legacy system kept ONE global counter as a CSB
// string prop, which let a player bank pity on a cheap banner and cash it on an
// expensive one.

const pityRoot = (actor) => actor?.getFlag?.(GACHA.FLAG_NS, GACHA.FLAG_KEY)?.pity ?? {};

export function readPity(actor, bannerId) {
  const rec = pityRoot(actor)[bannerId] ?? {};
  return {
    five: Math.max(0, Number(rec.five ?? 0) || 0),
    four: Math.max(0, Number(rec.four ?? 0) || 0),
  };
}

/** GM-only. Written once per batch, not once per pull. */
export async function writePity(actor, bannerId, { five, four }) {
  await actor.setFlag(GACHA.FLAG_NS, GACHA.FLAG_KEY, {
    pity: { ...pityRoot(actor), [bannerId]: { five, four } },
  });
}

/**
 * One-time migration: fold the legacy global `system.props.gacha_pity` into the
 * banner that was selected when it was written.
 *
 * The old prop is left in place rather than cleared — it costs nothing and
 * keeps a rollback possible. A `migrated` marker stops it re-applying.
 */
export async function migrateLegacyPity(actor, bannerId) {
  const flags = actor?.getFlag?.(GACHA.FLAG_NS, GACHA.FLAG_KEY) ?? {};
  if (flags.migrated) return false;

  const legacy = Math.max(0, Number(actor?.system?.props?.gacha_pity ?? 0) || 0);

  await actor.setFlag(GACHA.FLAG_NS, GACHA.FLAG_KEY, {
    migrated: true,
    pity: legacy > 0 ? { ...(flags.pity ?? {}), [bannerId]: { five: legacy, four: 0 } } : (flags.pity ?? {}),
  });

  return legacy > 0;
}
