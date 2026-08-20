// ============================================================================
// Gacha System — Roll engine (GM authority)
// ----------------------------------------------------------------------------
// The only place a pull is decided. Runs exclusively on the primary GM, so a
// second signed-in GM never double-spends or double-grants, and every client —
// roller and spectator alike — renders one identical, already-decided result.
//
// Order of operations matters and is deliberate:
//   1. validate      (banner, size, requester)
//   2. SPEND         coupons, atomically, BEFORE any RNG
//   3. roll          the whole batch, applying both pity counters
//   4. grant         to the party actor, one write per distinct item
//   5. write pity    ONCE for the batch, not once per pull
//   6. broadcast     one reveal payload + one chat receipt
//
// Spending before rolling is what makes a batch all-or-nothing: there is no
// path that consumes currency and produces nothing, or vice versa.
// ============================================================================

import {
  GACHA, RARITY, PITY_FIVE, PITY_FOUR, PULL_SIZES, bestRarity, log, warn,
} from "./gacha-const.js";
import { getBanner, getPoolTable, resolveTableItems } from "./gacha-banners.js";
import {
  partyActor, readPool, resolveRates, readPity, writePity,
  spendCoupons, grantCoupons, couponCost, migrateLegacyPity,
} from "./gacha-state.js";

const isPrimaryGM = () => globalThis.FUCompanion?.isPrimaryGM?.() === true;

// ── Weighted pick over a RollTable's results ────────────────────────────────
// A local pick rather than table.draw(): draw() is async, can mutate the
// table's drawn-state, and would mean ten awaited document round-trips for a
// x10. Weight is the span of each result's range, which is exactly how Foundry
// resolves a table roll.

function pickFromTable(table) {
  const entries = resolveTableItems(table);
  if (!entries.length) return null;

  const results = table.results.contents;
  const weights = entries.map((e) => {
    const res = results.find(
      (r) => r.documentId === e.item.id || r.text === e.item.name
    );
    const [a, b] = res?.range ?? [0, 0];
    const span = Math.max(0, (b ?? 0) - (a ?? 0) + 1);
    return span > 0 ? span : 1;
  });

  const total = weights.reduce((s, w) => s + w, 0);
  let roll = Math.random() * total;
  for (let i = 0; i < entries.length; i++) {
    roll -= weights[i];
    if (roll < 0) return entries[i];
  }
  return entries[entries.length - 1];
}

// ── Rarity sequence ─────────────────────────────────────────────────────────

/**
 * Decide the rarity of every pull in a batch, carrying both pity counters.
 *
 * Counters count pulls SINCE the last hit, so they are incremented first and
 * compared against the threshold — that makes the 30th pull the guaranteed
 * 5-star and the 10th the guaranteed 4-star-or-better, rather than the 31st
 * and 11th.
 *
 * A 5-star also satisfies the 4-star floor, so it resets both.
 */
export function rollRarities(count, rates, pity) {
  let { five, four } = pity;
  const out = [];

  for (let i = 0; i < count; i++) {
    five += 1;
    four += 1;

    let rarity;
    if (five >= PITY_FIVE) {
      rarity = "five";                                   // hard pity
    } else if (four >= PITY_FOUR) {
      rarity = Math.random() < rates.five ? "five" : "four"; // 4-star floor
    } else {
      const r = Math.random();
      rarity = r < rates.five ? "five" : (r < rates.five + rates.four ? "four" : "three");
    }

    if (rarity === "five") { five = 0; four = 0; }
    else if (rarity === "four") { four = 0; }

    out.push(rarity);
  }

  return { rarities: out, pity: { five, four } };
}

// ── Main entry ──────────────────────────────────────────────────────────────

/**
 * Execute a wish batch. Primary GM only.
 * @returns {Promise<{ok:boolean, reason?:string, results?:Array, pool?:object}>}
 */
export async function executeWish({ bannerId, count, requesterUserId, onDecided }) {
  if (!isPrimaryGM()) return { ok: false, reason: "not_primary_gm" };

  const size = Number(count);
  if (!PULL_SIZES.includes(size)) return { ok: false, reason: "bad_pull_size" };

  const banner = getBanner(bannerId);
  if (!banner) return { ok: false, reason: "banner_not_found" };

  const actor = await partyActor();
  if (!actor) return { ok: false, reason: "party_actor_missing" };

  await migrateLegacyPity(actor, bannerId);

  // 2. Spend first — atomic, and the only place the batch can be refused.
  const spend = await spendCoupons(actor, size);
  if (!spend.ok) return { ok: false, ...spend };

  // 3. Roll.
  const rates = resolveRates(actor);
  const before = readPity(actor, bannerId);
  const { rarities, pity: after } = rollRarities(size, rates, before);

  const pools = {
    five:  banner.table,
    four:  getPoolTable("four"),
    three: getPoolTable("three"),
  };

  const results = [];
  for (const rarity of rarities) {
    const table = pools[rarity];
    const pick = table ? pickFromTable(table) : null;

    if (!pick) {
      warn(`No drawable entry for rarity "${rarity}" — substituting 3-star.`);
      const fb = pickFromTable(pools.three);
      if (!fb) continue;
      results.push({ rarity: "three", ...serialise(fb) });
      continue;
    }
    results.push({ rarity, ...serialise(pick) });
  }

  // 3b. The outcome is now DECIDED. Publish it before persisting it.
  //
  // Rolling is instant; writing is not — a x10 measured ~8.4s of grants, pity
  // and receipt on this world, and every one of those seconds was spent
  // showing the player grey stars. Everything below this line is durability,
  // not decision, so the reveal goes out first and the writes land behind the
  // ~2.3s of warm/hold/burst the animation is playing anyway.
  //
  // Safe because the only thing that MUST be atomic with the roll -- spending
  // the coupons -- already happened above.
  try { onDecided?.({ bannerId, bannerName: banner.name, results }); }
  catch (e) { warn("onDecided handler threw", e); }

  // 4. Grant — collapse duplicates so a x10 of the same 3-star is one write.
  await grantAll(actor, results);

  // 5. Pity, once.
  await writePity(actor, bannerId, after);

  // 6. ONE chat message for the whole batch — the durable receipt. The old
  // system spent 8 document updates per pull animating in chat; the animation
  // is now a local overlay and chat is left to do the one job it is good at.
  await postReceipt(banner.name, results, requesterUserId);

  const pool = readPool(actor);
  log(`Wish x${size} on "${banner.name}" →`, results.map((r) => `${RARITY[r.rarity].label} ${r.name}`));

  return { ok: true, bannerId, bannerName: banner.name, results, pool, requesterUserId };
}

async function postReceipt(bannerName, results, requesterUserId) {
  const user = game.users?.get(requesterUserId);
  const rows = results
    .map((r) => {
      const c = RARITY[r.rarity];
      return `<div style="display:flex;align-items:center;gap:8px;padding:3px 0">
        <img src="${r.img}" width="28" height="28" style="border:0;outline:0;flex:0 0 auto">
        <span style="flex:1">@UUID[${r.uuid}]{${r.name}}</span>
        <span style="color:${c.color};font-size:13px">${"★".repeat(c.stars)}</span>
      </div>`;
    })
    .join("");

  await ChatMessage.create({
    speaker: { alias: `${bannerName} — Wish ×${results.length}` },
    content: `<div>${rows}</div>
      <div style="opacity:.7;font-size:11px;margin-top:6px">
        Pulled by ${user?.name ?? "the party"} · sent to the party stash
      </div>`,
  });
}

function serialise(entry) {
  return { name: entry.name, img: entry.img, uuid: entry.uuid };
}

/** One transfer per distinct item, quantity collapsed. */
async function grantAll(actor, results) {
  const tc = window["oni.ItemTransferCore"];
  if (!tc) { warn("ItemTransferCore missing — items were NOT granted."); return; }

  const byUuid = new Map();
  for (const r of results) byUuid.set(r.uuid, (byUuid.get(r.uuid) ?? 0) + 1);

  for (const [itemUuid, quantity] of byUuid) {
    try {
      await tc.transfer({
        mode: "gmToActor",
        itemUuid,
        quantity,
        receiverActorUuid: actor.uuid,
        showTransferCard: false, // the reveal overlay IS the notification
      });
    } catch (e) {
      warn("Grant failed for", itemUuid, e);
    }
  }
}

// ── Coupon purchase ─────────────────────────────────────────────────────────

/**
 * Buy coupons into the PARTY pool using the BUYER's own Zenit.
 *
 * That split is the whole point of the unified economy: spending is personal,
 * the resulting currency is shared.
 */
export async function executeBuy({ buyerActorUuid, quantity, requesterUserId }) {
  if (!isPrimaryGM()) return { ok: false, reason: "not_primary_gm" };

  const n = Math.max(1, Math.floor(Number(quantity) || 1));
  const actor = await partyActor();
  if (!actor) return { ok: false, reason: "party_actor_missing" };

  const buyer = await fromUuid(buyerActorUuid).catch(() => null);
  if (!buyer) return { ok: false, reason: "buyer_not_found" };

  const unit  = await couponCost();
  const total = unit * n;
  const have  = Math.max(0, Number(buyer.system?.props?.zenit ?? 0));
  if (have < total) return { ok: false, reason: "insufficient_funds", needed: total, have };

  const tc = window["oni.ItemTransferCore"];
  if (!tc) return { ok: false, reason: "transfer_core_missing" };

  await tc.adjustZenit({ actorUuid: buyer.uuid, delta: -total, requestedByUserId: requesterUserId });

  const granted = await grantCoupons(actor, n);
  if (!granted.ok) {
    // Refund rather than leave the buyer short of both Zenit and coupons.
    await tc.adjustZenit({ actorUuid: buyer.uuid, delta: total, requestedByUserId: requesterUserId });
    return { ok: false, ...granted };
  }

  log(`${buyer.name} bought ${n} coupon(s) for ${total}z → party pool`);
  return { ok: true, quantity: n, totalCost: total, pool: readPool(actor) };
}
