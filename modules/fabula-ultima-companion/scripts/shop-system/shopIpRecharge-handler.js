// scripts/shop-system/shopIpRecharge-handler.js
//
// GM-mediated Inventory Point recharge — a town service, not an item.
//
// Core rulebook p.105 "Recharging Inventory Points": in a town, village or any
// place that sells gear, a character recharges IP at 10 zenit per point, and
// current IP never exceeds max IP. IP cannot be shared, so the points land on
// the buyer and nowhere else. (Replaces the legacy "General Goods" consumable,
// which only ever sat in the bag doing nothing.)
//
// Same shape as ShopPurchaseHandler:
//   • Player side: requestRecharge() — emits IP_RECHARGE_REQ, awaits the result.
//   • GM side:     executeRecharge() — re-checks everything, then writes.
//   • Both sides:  onRechargeResult() — called by backend when the result arrives.
//
// Exposed via window.FUCompanion.shopIpRecharge after bootstrap installs it.

import { SHOPOPEN, gp } from "./shopopen-const.js";

/** Current/max IP. Read inline rather than from item-resource.js so the shop
 *  does not pull the Battle Director module graph in with it. */
export function readIp(actor) {
  const cur = Math.max(0, Number(gp(actor, "system.props.current_ip", 0)) || 0);
  const max = Math.max(0, Number(gp(actor, "system.props.max_ip", 0)) || 0);
  return { current: cur, max, missing: Math.max(0, max - cur) };
}

/** The shop sells the service unless the GM flagged it off (e.g. a weapon smith). */
export function shopOffersIpRecharge(shopActor) {
  const { FLAG_SCOPE, OPT_OUT_FLAG } = SHOPOPEN.IP_RECHARGE;
  return gp(shopActor, `flags.${FLAG_SCOPE}.${OPT_OUT_FLAG}`, false) !== true;
}

/** Zenit for `points` IP. The buyer's shop_buy_multiplier applies, rounded on
 *  the total — identical to how a normal purchase is priced. */
export function rechargeCost(buyerActor, points) {
  const multRaw = Number(gp(buyerActor, "system.props.shop_buy_multiplier", 100));
  const mult    = (Number.isFinite(multRaw) && multRaw > 0) ? multRaw / 100 : 1;
  return Math.round(SHOPOPEN.IP_RECHARGE.PRICE_PER_IP * Math.max(0, points) * mult);
}

export class ShopIpRechargeHandler {
  constructor() {
    this._pending = new Map(); // rechargeId -> resolve
    // Zenit moves on every request, so a request id is honoured once even if
    // it reaches the GM twice.
    this._seen = new Set();
  }

  // ──────────────────────────────────────────────────────────────
  // Player-side: request a recharge
  // ──────────────────────────────────────────────────────────────

  async requestRecharge({ shopActorUuid, points, buyerActorUuid, requesterUserId }) {
    if (game.user.isGM) {
      return await this.executeRecharge({ shopActorUuid, points, buyerActorUuid, requesterUserId });
    }

    const rechargeId = foundry.utils.randomID();
    return new Promise((resolve) => {
      this._pending.set(rechargeId, resolve);

      for (const ch of SHOPOPEN.CHANNELS) {
        try {
          game.socket.emit(ch, {
            type: SHOPOPEN.MSG.IP_RECHARGE_REQ,
            payload: { rechargeId, shopActorUuid, points, buyerActorUuid, requesterUserId }
          });
        } catch {}
      }

      setTimeout(() => {
        if (!this._pending.has(rechargeId)) return;
        this._pending.delete(rechargeId);
        resolve({ ok: false, reason: "timeout" });
      }, 15_000);
    });
  }

  // ──────────────────────────────────────────────────────────────
  // GM-side: execute the recharge (called by backend._onSocket)
  // ──────────────────────────────────────────────────────────────

  async executeRecharge({ rechargeId, shopActorUuid, points, buyerActorUuid, requesterUserId }) {
    try {
      if (rechargeId) {
        if (this._seen.has(rechargeId)) return { ok: false, reason: "duplicate" };
        this._seen.add(rechargeId);
      }

      const _resolve = (uuid) => (typeof fromUuidSync === "function" ? fromUuidSync(uuid) : null) ?? fromUuid(uuid);
      const [shopActor, buyerActor] = await Promise.all([_resolve(shopActorUuid), _resolve(buyerActorUuid)]);

      if (!shopActor)  return { ok: false, reason: "shop_not_found" };
      if (!buyerActor) return { ok: false, reason: "buyer_not_found" };
      if (!shopOffersIpRecharge(shopActor)) return { ok: false, reason: "not_offered" };

      // Re-read on the GM: the window's numbers may be a few writes stale.
      const ip = readIp(buyerActor);
      if (ip.missing <= 0) return { ok: false, reason: "ip_full" };

      const want = Math.max(1, Math.floor(Number(points) || 1));
      const pts  = Math.min(want, ip.missing);
      const cost = rechargeCost(buyerActor, pts);
      const have = Math.max(0, Number(gp(buyerActor, "system.props.zenit", 0)) || 0);
      if (cost > 0 && have < cost) return { ok: false, reason: "insufficient_funds", needed: cost, have };

      const tc = window["oni.ItemTransferCore"];
      if (!tc) return { ok: false, reason: "transfer_core_missing" };

      // Charge first, then grant. If the IP write fails the buyer is refunded,
      // so a failure never costs zenit for nothing.
      if (cost > 0) await tc.adjustZenit({ actorUuid: buyerActor.uuid, delta: -cost, requestedByUserId: requesterUserId });
      try {
        await buyerActor.update({ "system.props.current_ip": ip.current + pts });
      } catch (e) {
        if (cost > 0) await tc.adjustZenit({ actorUuid: buyerActor.uuid, delta: cost, requestedByUserId: requesterUserId });
        throw e;
      }
      if (cost > 0) await tc.adjustZenit({ actorUuid: shopActor.uuid, delta: cost, requestedByUserId: requesterUserId });

      console.log("[ShopIpRecharge] Success →", { buyer: buyerActor.name, pts, cost });
      return {
        ok: true, points: pts, totalCost: cost,
        ipAfter: ip.current + pts, ipMax: ip.max, buyerZenitAfter: have - cost,
      };

    } catch (e) {
      console.error("[ShopIpRecharge] executeRecharge error:", e);
      return { ok: false, reason: "error", message: String(e?.message ?? e) };
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Resolve a pending promise when IP_RECHARGE_RESULT arrives (player side)
  // ──────────────────────────────────────────────────────────────

  onRechargeResult(payload) {
    const { rechargeId, ...result } = payload ?? {};
    if (!rechargeId) return;
    const resolve = this._pending.get(rechargeId);
    if (!resolve) return;
    this._pending.delete(rechargeId);
    resolve(result);
  }
}
