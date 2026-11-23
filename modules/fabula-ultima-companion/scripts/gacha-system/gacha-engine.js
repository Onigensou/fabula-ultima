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
  GACHA, RARITY, PITY_FIVE, PITY_FOUR, PULL_SIZES, log, warn,
} from "./gacha-const.js";
import { getBanner, getPoolTable, resolveTableItems } from "./gacha-banners.js";
import {
  partyActor, readPool, resolveRates, readPity, writePity,
  spendCoupons, grantCoupons, couponCost, migrateLegacyPity,
  appendHistory, historyResults,
} from "./gacha-state.js";

const isPrimaryGM = () => globalThis.FUCompanion?.isPrimaryGM?.() === true;

// ── Weighted pick over a RollTable's results ────────────────────────────────
// A local pick rather than table.draw(): draw() is async, can mutate the
// table's drawn-state, and would mean ten awaited document round-trips for a
// x10. Weight is the span of each result's range, which is exactly how Foundry
// resolves a table roll.

function pickFromTable(table, only = null) {
  const entries = resolveTableItems(table).filter((e) => !only || only.has(e.uuid));
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

// ── 50/50 featured guarantee ────────────────────────────────────────────────

/**
 * Which set a 5-star lands on. A fair coin between the featured (main) set and
 * the filler set(s) — deliberately NOT the table weights, which would make a
 * 4-piece main set beat a 3-piece filler 57/43 and turn "50/50" into a lie.
 *
 * A 5-star that lands on the filler set arms `guaranteed`, which forces the
 * banner's next 5-star (rolled or hard pity) onto the featured set. Pure, so
 * the test harness can pin it.
 */
export function chooseFiveSide(guaranteed, rand = Math.random) {
  const featured = guaranteed === true || rand() < 0.5;
  return { featured, guaranteedAfter: !featured };
}

// ── Machine lock ────────────────────────────────────────────────────────────
// One reveal at a time: the machine is a shared object everyone is watching.
// Held from the moment a wish is accepted until the roller's reveal ends
// (REVEAL_END), with a timeout so a roller who disconnects mid-reveal cannot
// jam the machine for the rest of the session. GM memory only — a GM reload
// clears it, which is the right answer anyway.

const _machine = { byUserId: null, until: 0 };

export function machineState() {
  return Date.now() < _machine.until ? { busy: true, byUserId: _machine.byUserId } : { busy: false, byUserId: null };
}

export function releaseMachine(userId) {
  if (!_machine.byUserId || (userId && userId !== _machine.byUserId)) return false;
  _machine.byUserId = null;
  _machine.until = 0;
  return true;
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

  // 1b. One reveal at a time.
  const m = machineState();
  if (m.busy) return { ok: false, reason: "machine_busy", byUserId: m.byUserId };

  // 2. Spend first — atomic, and the only place the batch can be refused.
  const spend = await spendCoupons(actor, size);
  if (!spend.ok) return { ok: false, ...spend };

  _machine.byUserId = requesterUserId ?? null;
  _machine.until = Date.now() + GACHA.MACHINE_LOCK_MS;

  // 3. Roll.
  const rates = resolveRates(actor);
  const before = readPity(actor, bannerId);
  const { rarities, pity: after } = rollRarities(size, rates, before);

  const pools = {
    five:  banner.table,
    four:  getPoolTable("four"),
    three: getPoolTable("three"),
  };

  // The two halves of the 50/50. A banner with no filler set (or no main set)
  // has nothing to flip between, so its 5-stars draw from whatever it has and
  // the guarantee is left alone.
  const mainUuids   = new Set((banner.mainSet?.entries ?? []).map((e) => e.uuid));
  const fillerUuids = new Set(banner.fillerSets.flatMap((g) => g.entries).map((e) => e.uuid));
  const canFlip = mainUuids.size > 0 && fillerUuids.size > 0;
  let guaranteed = before.guaranteed;

  const results = [];
  for (const rarity of rarities) {
    const table = pools[rarity];
    let pick = null, featured = null;
    if (rarity === "five" && table && canFlip) {
      const side = chooseFiveSide(guaranteed);
      featured = side.featured;
      guaranteed = side.guaranteedAfter;
      pick = pickFromTable(table, featured ? mainUuids : fillerUuids);
    } else {
      pick = table ? pickFromTable(table) : null;
    }

    if (!pick) {
      warn(`No drawable entry for rarity "${rarity}" — substituting 3-star.`);
      const fb = pickFromTable(pools.three);
      if (!fb) continue;
      results.push({ rarity: "three", ...serialise(fb) });
      continue;
    }
    results.push({ rarity, ...serialise(pick), ...(featured === null ? {} : { featured }) });
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
  const requesterName = game.users?.get(requesterUserId)?.name ?? null;
  try { onDecided?.({ bannerId, bannerName: banner.title, results, requesterUserId, requesterName, guaranteed }); }
  catch (e) { warn("onDecided handler threw", e); }

  // 4. Grant — collapse duplicates so a x10 of the same 3-star is one write.
  await grantAll(actor, results);

  // 5. Pity, once.
  await writePity(actor, bannerId, { ...after, guaranteed });

  // 6. ONE chat message for the whole batch — the durable receipt. The old
  // system spent 8 document updates per pull animating in chat; the animation
  // is now a local overlay and chat is left to do the one job it is good at.
  await postReceipt(banner.title, results, requesterUserId);

  // 7. The party's Wish History.
  try {
    const { keep, threes } = historyResults(results);
    await appendHistory(actor, {
      at: Date.now(), kind: "wish", count: size,
      userId: requesterUserId ?? null, userName: requesterName,
      actorId: game.users?.get(requesterUserId)?.character?.id ?? null,
      bannerId, bannerName: banner.title, results: keep, threes,
    });
  } catch (e) { warn("History append failed", e); }

  const pool = readPool(actor);
  log(`Wish x${size} on "${banner.title}" →`, results.map((r) => `${RARITY[r.rarity].label} ${r.name}`));

  return { ok: true, bannerId, bannerName: banner.title, results, pool, requesterUserId, guaranteed };
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

  const split = splitCost(buyer, actor, total);
  if (!split.ok) return { ok: false, ...split };

  const tc = window["oni.ItemTransferCore"];
  if (!tc) return { ok: false, reason: "transfer_core_missing" };

  // Purse first, stash for the remainder. Sequential rather than parallel:
  // both legs can land on the same document when the buyer IS the party actor.
  if (split.fromBuyer > 0) {
    await tc.adjustZenit({ actorUuid: buyer.uuid, delta: -split.fromBuyer, requestedByUserId: requesterUserId });
  }
  if (split.fromStash > 0) {
    await tc.adjustZenit({ actorUuid: actor.uuid, delta: -split.fromStash, requestedByUserId: requesterUserId });
  }

  const granted = await grantCoupons(actor, n);
  if (!granted.ok) {
    // Refund both legs rather than leave them short of Zenit AND coupons.
    if (split.fromBuyer > 0) {
      await tc.adjustZenit({ actorUuid: buyer.uuid, delta: split.fromBuyer, requestedByUserId: requesterUserId });
    }
    if (split.fromStash > 0) {
      await tc.adjustZenit({ actorUuid: actor.uuid, delta: split.fromStash, requestedByUserId: requesterUserId });
    }
    return { ok: false, ...granted };
  }

  log(`${buyer.name} bought ${n} coupon(s) for ${total}z ` +
      `(${split.fromBuyer} purse + ${split.fromStash} stash) → party pool`);

  return {
    ok: true, quantity: n, totalCost: total,
    fromBuyer: split.fromBuyer, fromStash: split.fromStash,
    pool: readPool(actor),
    buyerZenitAfter: split.buyerHas - split.fromBuyer,
    stashZenitAfter: split.stashHas - split.fromStash,
  };
}

const zenitOf = (a) => Math.max(0, Number(a?.system?.props?.zenit ?? 0));

/**
 * Who pays what.
 *
 * The buyer's own purse is always drained first; only the shortfall comes out
 * of the party stash. Exported so the confirmation dialog can show the same
 * breakdown the engine will actually apply, rather than guessing at it.
 */
export function splitCost(buyer, party, total) {
  const buyerHas = zenitOf(buyer);
  const stashHas = zenitOf(party);

  const fromBuyer = Math.min(buyerHas, total);
  const fromStash = total - fromBuyer;

  if (fromStash > stashHas) {
    return { ok: false, reason: "insufficient_funds", needed: total, have: buyerHas + stashHas, buyerHas, stashHas };
  }
  return { ok: true, fromBuyer, fromStash, buyerHas, stashHas };
}
