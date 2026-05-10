// scripts/shop-system/shopSell-handler.js
//
// GM-mediated shop sell.
//
// Two actor UUIDs are kept separate:
//   sourceActorUuid — the actor the item lives on (player actor OR warehouse/DB actor)
//   zenitActorUuid  — the actor that receives the Zenit (always the linked player character)
//
// This means selling warehouse items still credits Zenit to the player, not the warehouse.

import { SHOPOPEN } from "./shopopen-const.js";

export class ShopSellHandler {
  constructor() {
    this._pending = new Map(); // sellId -> resolve
  }

  // ──────────────────────────────────────────────────────────────
  // Player-side: request a sell
  // ──────────────────────────────────────────────────────────────

  async requestSell({ shopActorUuid, sourceActorUuid, zenitActorUuid, itemUuid, quantity, requesterUserId }) {
    if (game.user.isGM) {
      return await this.executeSell({ shopActorUuid, sourceActorUuid, zenitActorUuid, itemUuid, quantity, requesterUserId });
    }

    const sellId = foundry.utils.randomID();
    return new Promise((resolve) => {
      this._pending.set(sellId, resolve);

      for (const ch of SHOPOPEN.CHANNELS) {
        try {
          game.socket.emit(ch, {
            type: SHOPOPEN.MSG.SELL_REQ,
            payload: { sellId, shopActorUuid, sourceActorUuid, zenitActorUuid, itemUuid, quantity, requesterUserId }
          });
        } catch {}
      }

      setTimeout(() => {
        if (!this._pending.has(sellId)) return;
        this._pending.delete(sellId);
        resolve({ ok: false, reason: "timeout" });
      }, 15_000);
    });
  }

  // ──────────────────────────────────────────────────────────────
  // GM-side: execute the sell
  // ──────────────────────────────────────────────────────────────

  async executeSell({ shopActorUuid, sourceActorUuid, zenitActorUuid, itemUuid, quantity, requesterUserId }) {
    try {
      console.log("[ShopSell] executeSell →", { shopActorUuid, sourceActorUuid, zenitActorUuid, itemUuid, quantity });

      const _resolve = (uuid) => (typeof fromUuidSync === "function" ? fromUuidSync(uuid) : null) ?? fromUuid(uuid);

      const [shopActor, sourceActor, zenitActor, item] = await Promise.all([
        _resolve(shopActorUuid),
        _resolve(sourceActorUuid),
        _resolve(zenitActorUuid),
        _resolve(itemUuid),
      ]);

      if (!shopActor)   return { ok: false, reason: "shop_not_found" };
      if (!sourceActor) return { ok: false, reason: "source_actor_not_found" };
      if (!zenitActor)  return { ok: false, reason: "seller_not_found" };
      if (!item || item.parent?.uuid !== sourceActorUuid) {
        console.warn("[ShopSell] Item not found or parent mismatch", {
          itemUuid, sourceActorUuid, parentUuid: item?.parent?.uuid
        });
        return { ok: false, reason: "item_not_found" };
      }

      const qty   = Math.max(1, Math.floor(Number(quantity) || 1));
      const stock = Math.max(0, Number(item.system?.props?.item_quantity ?? 1));

      if (stock < qty) return { ok: false, reason: "insufficient_stock", available: stock };

      // Sell price uses the linked player's (zenitActor's) sell multiplier
      const multRaw = Number(zenitActor.system?.props?.shop_sell_multiplier ?? 50);
      const mult    = (Number.isFinite(multRaw) && multRaw > 0) ? multRaw / 100 : 0.5;
      const costPer = Math.max(0, Number(item.system?.props?.item_cost ?? 0));
      const total   = Math.round(costPer * qty * mult);

      const tc = window["oni.ItemTransferCore"];
      if (!tc) return { ok: false, reason: "transfer_core_missing" };

      // Transfer item: source (actor or warehouse) → shop
      const xfer = await tc.transfer({
        mode:              "actorToActor",
        itemUuid:          item.uuid,
        quantity:          qty,
        senderActorUuid:   sourceActor.uuid,
        receiverActorUuid: shopActor.uuid,
        requestedByUserId: requesterUserId,
        showTransferCard:  false,
      });

      if (!xfer.ok) return { ok: false, reason: "transfer_failed" };

      // Zenit always goes to the linked player character (zenitActor)
      if (total > 0) {
        await tc.adjustZenit({ actorUuid: zenitActor.uuid, delta: +total, requestedByUserId: requesterUserId });
      }

      console.log("[ShopSell] Success →", { qty, total, itemName: item.name, zenitActor: zenitActor.name });
      return { ok: true, quantity: qty, totalEarned: total, itemName: item.name };

    } catch (e) {
      console.error("[ShopSell] executeSell error:", e);
      return { ok: false, reason: "server_error", message: String(e?.message ?? e) };
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Resolve a pending promise when SELL_RESULT arrives (player side)
  // ──────────────────────────────────────────────────────────────

  onSellResult(payload) {
    const { sellId, ...result } = payload ?? {};
    if (!sellId) return;
    const resolve = this._pending.get(sellId);
    if (!resolve) return;
    this._pending.delete(sellId);
    resolve(result);
  }
}
