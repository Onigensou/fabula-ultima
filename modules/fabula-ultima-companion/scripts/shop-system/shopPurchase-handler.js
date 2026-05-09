// scripts/shop-system/shopPurchase-handler.js
//
// GM-mediated shop purchase.
//
// Socket routing is handled by ShopOpenBackend._onSocket (which is already
// a verified working listener). This class only:
//   • Player side: requestPurchase() — emits BUY_REQ, awaits BUY_RESULT.
//   • GM side:     executePurchase() — runs the actual transfer & Zenit math.
//   • Both sides:  onBuyResult()    — called by backend when BUY_RESULT arrives.
//
// Exposed via window.FUCompanion.shopPurchase after bootstrap installs it.

import { SHOPOPEN } from "./shopopen-const.js";

export class ShopPurchaseHandler {
  constructor() {
    this._pending = new Map(); // purchaseId -> resolve
  }

  // ──────────────────────────────────────────────────────────────
  // Player-side: request a purchase
  // ──────────────────────────────────────────────────────────────

  /**
   * Called by ShopWindowApp buy button.
   * If the user is GM, execute directly; otherwise emit BUY_REQ and wait.
   */
  async requestPurchase({ shopActorUuid, itemUuid, quantity, buyerActorUuid, requesterUserId }) {
    if (game.user.isGM) {
      return await this.executePurchase({ shopActorUuid, itemUuid, quantity, buyerActorUuid, requesterUserId });
    }

    const purchaseId = foundry.utils.randomID();
    return new Promise((resolve) => {
      this._pending.set(purchaseId, resolve);

      // Emit via all channels — backend on GM side will receive and process
      for (const ch of SHOPOPEN.CHANNELS) {
        try {
          game.socket.emit(ch, {
            type: SHOPOPEN.MSG.BUY_REQ,
            payload: { purchaseId, shopActorUuid, itemUuid, quantity, buyerActorUuid, requesterUserId }
          });
        } catch {}
      }

      // Timeout guard
      setTimeout(() => {
        if (!this._pending.has(purchaseId)) return;
        this._pending.delete(purchaseId);
        resolve({ ok: false, reason: "timeout" });
      }, 15_000);
    });
  }

  // ──────────────────────────────────────────────────────────────
  // GM-side: execute the purchase (called by backend._onSocket)
  // ──────────────────────────────────────────────────────────────

  async executePurchase({ shopActorUuid, itemUuid, quantity, buyerActorUuid, requesterUserId }) {
    try {
      console.log("[ShopPurchase] executePurchase →", { shopActorUuid, itemUuid, quantity, buyerActorUuid });

      const shopActor  = await fromUuid(shopActorUuid);
      const buyerActor = await fromUuid(buyerActorUuid);

      if (!shopActor)  return { ok: false, reason: "shop_not_found" };
      if (!buyerActor) return { ok: false, reason: "buyer_not_found" };

      // Embedded item UUID: "Actor.shopId.Item.itemId"
      const item = await fromUuid(itemUuid);
      if (!item || item.parent?.uuid !== shopActorUuid) {
        console.warn("[ShopPurchase] Item not found or parent mismatch", { itemUuid, shopActorUuid, parentUuid: item?.parent?.uuid });
        return { ok: false, reason: "item_not_found" };
      }

      const qty   = Math.max(1, Math.floor(Number(quantity) || 1));
      const stock = Math.max(0, Number(item.system?.props?.item_quantity ?? 0));

      if (stock <= 0)  return { ok: false, reason: "out_of_stock" };
      if (stock < qty) return { ok: false, reason: "insufficient_stock", available: stock };

      const costPer  = Math.max(0, Number(item.system?.props?.item_cost ?? 0));
      const total    = costPer * qty;
      const buyerZ   = Math.max(0, Number(buyerActor.system?.props?.zenit ?? 0));

      if (total > 0 && buyerZ < total) {
        return { ok: false, reason: "insufficient_funds", needed: total, have: buyerZ };
      }

      const tc = window["oni.ItemTransferCore"];
      if (!tc) return { ok: false, reason: "transfer_core_missing" };

      const xfer = await tc.transfer({
        mode:              "actorToActor",
        itemUuid:          item.uuid,
        quantity:          qty,
        senderActorUuid:   shopActor.uuid,
        receiverActorUuid: buyerActor.uuid,
        requestedByUserId: requesterUserId,
        showTransferCard:  true
      });

      if (!xfer.ok) return { ok: false, reason: "transfer_failed" };

      if (total > 0) {
        await tc.adjustZenit({ actorUuid: buyerActor.uuid, delta: -total, requestedByUserId: requesterUserId });
        await tc.adjustZenit({ actorUuid: shopActor.uuid,  delta:  total, requestedByUserId: requesterUserId });
      }

      console.log("[ShopPurchase] Success →", { qty, total, itemName: item.name });
      return { ok: true, quantity: qty, totalCost: total, itemName: item.name, buyerZenitAfter: buyerZ - total };

    } catch (e) {
      console.error("[ShopPurchase] executePurchase error:", e);
      return { ok: false, reason: "error", message: String(e?.message ?? e) };
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Resolve a pending promise when BUY_RESULT arrives (player side)
  // ──────────────────────────────────────────────────────────────

  onBuyResult(payload) {
    const { purchaseId, ...result } = payload ?? {};
    if (!purchaseId) return;
    const resolve = this._pending.get(purchaseId);
    if (!resolve) return;
    this._pending.delete(purchaseId);
    resolve(result);
  }
}
