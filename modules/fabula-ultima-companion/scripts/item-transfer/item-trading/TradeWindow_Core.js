// ============================================================================
// DEMO_TradeWindow_Core
// Core logic for shared Trade Window – Foundry VTT v12
//
//  - Manages trade sessions in scene flags.
//  - Handles socket communication and GM-as-server behaviour.
//  - Finalizes trades by calling ItemTransferCore.transfer() on the GM.
//  - Exposes a namespace on globalThis: __OniTradeWindow__
//
// The actual UI (Application class, DOM, drag & drop) lives in
// DEMO_TradeWindow_UI, which registers its App class into this namespace.
//
// UPDATED (Quantity support):
//  - addOfferItem now includes item.quantity
//  - offers stack by itemUuid when possible
//  - finalize uses offer.quantity instead of always 1
// ============================================================================

(() => {
  Hooks.once("ready", () => {

    const NS         = "__OniTradeWindow__";
    const FLAG_SCOPE = "world";
    const FLAG_KEY   = "oniTradeSessions";  // { [requestId]: sessionData }

    const MODULE_ID  = "fabula-ultima-companion";
    const CHANNEL    = `module.${MODULE_ID}`;

    const isGM  = () => game.user?.isGM;
    const scene = () => canvas?.scene;

    function getPrimaryActiveGM() {
      const gms = (game.users?.contents ?? []).filter((u) => u?.isGM && u?.active);
      return gms[0] ?? null;
    }

    function isPrimaryActiveGM() {
      const gm = getPrimaryActiveGM();
      return !!gm && game.user?.id === gm.id;
    }

    // Simple escaper for HTML
    const esc = (v) =>
      String(v ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

    function normalizePositiveInt(raw, fallback = 1) {
      let n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) n = fallback;
      return Math.max(1, Math.floor(n));
    }

    // Namespace on globalThis
    const GLOBAL = (globalThis[NS] = globalThis[NS] || {});
    GLOBAL.apps       = GLOBAL.apps || {};
    GLOBAL.AppClass   = GLOBAL.AppClass || null;  // set by UI script
    GLOBAL.readAllSessions = GLOBAL.readAllSessions || null;
    GLOBAL.requestOp       = GLOBAL.requestOp || null;
    GLOBAL.esc             = GLOBAL.esc || esc;

    console.log(
      "=== [OniTradeWindow_Core] Install on user",
      game.user.id,
      "isGM:",
      game.user.isGM,
      "primaryGM:",
      getPrimaryActiveGM()?.id ?? "none",
      "isPrimaryActiveGM:",
      isPrimaryActiveGM(),
      "==="
    );

    // ---------------------------------------------------------------------------
    // Helpers: read / mutate trade session flags (GM-only mutation later)
    // ---------------------------------------------------------------------------

    async function readAllSessions() {
      const sc = scene();
      if (!sc) return {};
      const all = await sc.getFlag(FLAG_SCOPE, FLAG_KEY);
      return all ?? {};
    }

    /**
     * GM-only helper: update a single session for the given requestId.
     * updater(current, allSessions) => nextSession or null (to delete).
     */
    async function updateSessionGM(requestId, updater) {
      const sc = scene();
      if (!sc) {
        console.error("[OniTradeWindow_Core] Cannot update session: no active scene.");
        return null;
      }

      if (!isGM()) {
        console.warn("[OniTradeWindow_Core] updateSessionGM called on non-GM; ignoring.", {
          requestId,
          localUserId: game.user?.id ?? null
        });
        return null;
      }

      if (!isPrimaryActiveGM()) {
        console.warn("[OniTradeWindow_Core] updateSessionGM called on secondary GM; ignoring.", {
          requestId,
          localUserId: game.user?.id ?? null,
          primaryGmUserId: getPrimaryActiveGM()?.id ?? null
        });
        return null;
      }

      let all = await sc.getFlag(FLAG_SCOPE, FLAG_KEY);
      if (!all || typeof all !== "object") all = {};

      const current = all[requestId] ?? null;
      const next = await updater(current, all);

      const clone = foundry.utils.duplicate(all);
      if (next == null) {
        delete clone[requestId];
      } else {
        clone[requestId] = next;
      }

      await sc.setFlag(FLAG_SCOPE, FLAG_KEY, clone);
      return next;
    }

    /**
     * Apply a trade window operation on the GM side.
     * payload shape:
     *   {
     *     requestId,
     *     op: "initSession" | "addOfferItem" | "setZenitOffer" | "confirm" | "cancel",
     *     side: "initiator" | "target", // for offer/confirm/cancel
     *     initiatorUserId, targetUserId,
     *     initiatorName, targetName,
     *     initiatorActorUuid?, targetActorUuid?,
     *     item?: { itemUuid, name, img, quantity? },
     *     amount?: number                // for setZenitOffer
     *   }
     */
    async function applyOpGM(payload) {
      if (!payload || typeof payload !== "object") return;
      const { requestId, op } = payload;
      if (!requestId || !op) return;

      if (!isGM()) {
        console.log("[OniTradeWindow_Core] applyOpGM reached on non-GM; ignoring.", {
          requestId,
          op
        });
        return;
      }

      if (!isPrimaryActiveGM()) {
        console.log("[OniTradeWindow_Core] applyOpGM reached on secondary GM; ignoring.", {
          requestId,
          op,
          localUserId: game.user?.id ?? null,
          primaryGmUserId: getPrimaryActiveGM()?.id ?? null
        });
        return;
      }

      console.log("[OniTradeWindow_Core] Primary GM applyOpGM:", payload);

      const nextSession = await updateSessionGM(requestId, (current) => {
        const {
          initiatorUserId,
          targetUserId,
          initiatorName,
          targetName,
          initiatorActorUuid,
          targetActorUuid,
          side,
          item,
          amount
        } = payload;

        let sess = current;

        // Ensure a base session object exists
        if (!sess) {
          sess = {
            requestId,
            initiatorUserId,
            targetUserId,
            initiatorName: initiatorName ?? "Initiator",
            targetName: targetName ?? "Target",
            initiatorActorUuid: initiatorActorUuid ?? null,
            targetActorUuid: targetActorUuid ?? null,
            confirmInitiator: false,
            confirmTarget: false,
            cancelled: false,
            cancelledBySide: null,
            settled: false,
            offerInitiator: [],
            offerTarget: [],
            // Zenit offers for each side
            zenitOfferInitiator: 0,
            zenitOfferTarget: 0
          };
        }

        const next = foundry.utils.duplicate(sess);

        // Make sure arrays exist
        if (!Array.isArray(next.offerInitiator)) next.offerInitiator = [];
        if (!Array.isArray(next.offerTarget))    next.offerTarget    = [];
        if (typeof next.zenitOfferInitiator !== "number") next.zenitOfferInitiator = 0;
        if (typeof next.zenitOfferTarget    !== "number") next.zenitOfferTarget    = 0;

        function stackOrPushOffer(list, cleanItem) {
          // Prefer stacking by itemUuid, fallback to name+img if needed.
          const idx = list.findIndex(o =>
            (o?.itemUuid && cleanItem.itemUuid && o.itemUuid === cleanItem.itemUuid) ||
            (!o?.itemUuid && !cleanItem.itemUuid && o?.name === cleanItem.name && o?.img === cleanItem.img)
          );

          if (idx >= 0) {
            const cur = Number(list[idx]?.quantity ?? 1);
            const add = Number(cleanItem.quantity ?? 1);
            const merged = normalizePositiveInt(cur, 1) + normalizePositiveInt(add, 1);
            list[idx].quantity = merged;
          } else {
            list.push(cleanItem);
          }
        }

        switch (op) {
          case "initSession":
            // Update actor UUIDs if provided
            if (initiatorActorUuid != null) next.initiatorActorUuid = initiatorActorUuid;
            if (targetActorUuid    != null) next.targetActorUuid    = targetActorUuid;
            break;

          case "addOfferItem": {
            if (!item || !item.itemUuid) {
              console.warn("[OniTradeWindow_Core] addOfferItem missing item.", payload);
              break;
            }

            const cleanItem = {
              itemUuid: item.itemUuid,
              name: item.name ?? "Item",
              img: item.img ?? null,
              quantity: normalizePositiveInt(item.quantity ?? 1, 1)
            };

            if (side === "initiator") {
              stackOrPushOffer(next.offerInitiator, cleanItem);
            } else if (side === "target") {
              stackOrPushOffer(next.offerTarget, cleanItem);
            }

            // Changing offered items should reset confirmations & settlement
            next.confirmInitiator = false;
            next.confirmTarget    = false;
            next.settled          = false;
            break;
          }

          case "setZenitOffer": {
            let amt = Number(amount);
            if (!Number.isFinite(amt) || amt < 0) amt = 0;
            amt = Math.floor(amt);

            if (side === "initiator") {
              next.zenitOfferInitiator = amt;
            } else if (side === "target") {
              next.zenitOfferTarget = amt;
            }

            // Changing Zenit offer should also reset confirmations & settlement
            next.confirmInitiator = false;
            next.confirmTarget    = false;
            next.settled          = false;
            break;
          }

          case "confirm":
            if (side === "initiator") next.confirmInitiator = true;
            if (side === "target")    next.confirmTarget    = true;
            break;

          case "cancel":
            next.cancelled = true;
            next.cancelledBySide = side ?? null;
            break;

          default:
            console.warn("[OniTradeWindow_Core] Unknown op:", op);
            break;
        }

        return next;
      });

      // After updating the session, see if we should finalize the trade
      if (op === "confirm" && nextSession) {
        await finalizeTradeIfReady(nextSession);
      }
    }

    /**
     * GM-only: if both sides confirmed and the trade is not yet settled/cancelled,
     * call ItemTransferCore.transfer() for each offered item, and also move Zenit.
     */
    async function finalizeTradeIfReady(sess) {
      if (!isGM()) return; // Safety: only GM should finalize
      if (!isPrimaryActiveGM()) return; // Safety: only primary active GM should finalize
      if (!sess) return;
      if (sess.cancelled) return;
      if (sess.settled)   return;
      if (!sess.confirmInitiator || !sess.confirmTarget) return;

      const ITC = window["oni.ItemTransferCore"];
      if (!ITC || typeof ITC.transfer !== "function") {
        ui.notifications?.error?.(
          "OniTrade: ItemTransferCore is not available on the GM client. Cannot finalize trade."
        );
        console.error("[OniTradeWindow_Core] ItemTransferCore missing.", { sess });
        return;
      }

      const {
        requestId,
        initiatorUserId,
        targetUserId,
        initiatorActorUuid,
        targetActorUuid
      } = sess;

      const offerInitiator = Array.isArray(sess.offerInitiator) ? sess.offerInitiator : [];
      const offerTarget    = Array.isArray(sess.offerTarget)    ? sess.offerTarget    : [];

      const zenitOfferInitiator = Math.max(0, Math.floor(Number(sess.zenitOfferInitiator ?? 0)));
      const zenitOfferTarget    = Math.max(0, Math.floor(Number(sess.zenitOfferTarget    ?? 0)));

      console.log("[OniTradeWindow_Core] Finalizing trade via ItemTransferCore.", {
        requestId,
        initiatorActorUuid,
        targetActorUuid,
        offerInitiator,
        offerTarget,
        zenitOfferInitiator,
        zenitOfferTarget,
        localUserId: game.user?.id ?? null,
        primaryGmUserId: getPrimaryActiveGM()?.id ?? null
      });

      const ops = [];

      function buildPayloadForSide(side, offer) {
        const itemUuid = offer?.itemUuid;
        if (!itemUuid) return null;

        const qty = normalizePositiveInt(offer?.quantity ?? 1, 1);

        const hasInitiatorActor = !!initiatorActorUuid;
        const hasTargetActor    = !!targetActorUuid;

        let mode = null;
        let senderActorUuid = null;
        let receiverActorUuid = null;
        let requestedByUserId = side === "initiator" ? initiatorUserId : targetUserId;

        if (side === "initiator") {
          // Initiator gives to target side
          if (hasInitiatorActor && hasTargetActor) {
            mode = "actorToActor";
            senderActorUuid   = initiatorActorUuid;
            receiverActorUuid = targetActorUuid;
          } else if (hasInitiatorActor && !hasTargetActor) {
            mode = "actorToGm";
            senderActorUuid   = initiatorActorUuid;
            receiverActorUuid = null;
          } else if (!hasInitiatorActor && hasTargetActor) {
            mode = "gmToActor";
            senderActorUuid   = null;
            receiverActorUuid = targetActorUuid;
          } else {
            console.warn(
              "[OniTradeWindow_Core] Cannot build payload: initiator has no actor and target has no actor.",
              sess
            );
            return null;
          }
        } else if (side === "target") {
          // Target gives to initiator side
          if (hasInitiatorActor && hasTargetActor) {
            mode = "actorToActor";
            senderActorUuid   = targetActorUuid;
            receiverActorUuid = initiatorActorUuid;
          } else if (!hasInitiatorActor && hasTargetActor) {
            mode = "actorToGm";
            senderActorUuid   = targetActorUuid;
            receiverActorUuid = null;
          } else if (hasInitiatorActor && !hasTargetActor) {
            mode = "gmToActor";
            senderActorUuid   = null;
            receiverActorUuid = initiatorActorUuid;
          } else {
            console.warn(
              "[OniTradeWindow_Core] Cannot build payload: both sides have no actor.",
              sess
            );
            return null;
          }
        }

        if (!mode) return null;

        return {
          mode,
          itemUuid,
          quantity: qty,
          senderActorUuid,
          receiverActorUuid,
          requestedByUserId
        };
      }

      // 1) Item transfers
      for (const offer of offerInitiator) {
        const p = buildPayloadForSide("initiator", offer);
        if (p) ops.push(p);
      }
      for (const offer of offerTarget) {
        const p = buildPayloadForSide("target", offer);
        if (p) ops.push(p);
      }

      // Perform item transfers sequentially
      for (const payload of ops) {
        try {
          console.log("[OniTradeWindow_Core] Calling ItemTransferCore.transfer:", payload);
          await ITC.transfer(payload);
        } catch (err) {
          console.error("[OniTradeWindow_Core] Error during ItemTransferCore.transfer.", {
            err,
            payload
          });
        }
      }

      // 2) Zenit transfers
      const hasZenitApi =
        typeof ITC.transferZenit === "function" &&
        typeof ITC.adjustZenit  === "function";

      if (!hasZenitApi && (zenitOfferInitiator > 0 || zenitOfferTarget > 0)) {
        console.warn(
          "[OniTradeWindow_Core] Zenit offers present, but transferZenit/adjustZenit API is missing."
        );
      }

      if (hasZenitApi && (zenitOfferInitiator > 0 || zenitOfferTarget > 0)) {
        const hasInitiatorActor = !!initiatorActorUuid;
        const hasTargetActor    = !!targetActorUuid;

        try {
          if (hasInitiatorActor && hasTargetActor) {
            if (zenitOfferInitiator > 0) {
              const payload = {
                senderActorUuid:   initiatorActorUuid,
                receiverActorUuid: targetActorUuid,
                amount:            zenitOfferInitiator,
                requestedByUserId: initiatorUserId
              };
              console.log("[OniTradeWindow_Core] Zenit transfer (initiator → target):", payload);
              const res = await ITC.transferZenit(payload);
              if (!res?.ok) {
                console.warn("[OniTradeWindow_Core] Zenit transfer (initiator → target) not ok.", res);
                ui.notifications?.warn?.(
                  "OniTrade: There was a problem transferring Zenit from the initiator side."
                );
              }
            }

            if (zenitOfferTarget > 0) {
              const payload = {
                senderActorUuid:   targetActorUuid,
                receiverActorUuid: initiatorActorUuid,
                amount:            zenitOfferTarget,
                requestedByUserId: targetUserId
              };
              console.log("[OniTradeWindow_Core] Zenit transfer (target → initiator):", payload);
              const res = await ITC.transferZenit(payload);
              if (!res?.ok) {
                console.warn("[OniTradeWindow_Core] Zenit transfer (target → initiator) not ok.", res);
                ui.notifications?.warn?.(
                  "OniTrade: There was a problem transferring Zenit from the target side."
                );
              }
            }
          } else if (hasInitiatorActor && !hasTargetActor) {
            const netDelta = (zenitOfferTarget || 0) - (zenitOfferInitiator || 0);
            if (netDelta !== 0) {
              const payload = {
                actorUuid:         initiatorActorUuid,
                delta:             netDelta,
                requestedByUserId: initiatorUserId
              };
              console.log("[OniTradeWindow_Core] Zenit adjust (initiator only):", payload);
              const res = await ITC.adjustZenit(payload);
              if (!res?.ok) console.warn("[OniTradeWindow_Core] Zenit adjust (initiator only) not ok.", res);
            }
          } else if (!hasInitiatorActor && hasTargetActor) {
            const netDelta = (zenitOfferInitiator || 0) - (zenitOfferTarget || 0);
            if (netDelta !== 0) {
              const payload = {
                actorUuid:         targetActorUuid,
                delta:             netDelta,
                requestedByUserId: targetUserId
              };
              console.log("[OniTradeWindow_Core] Zenit adjust (target only):", payload);
              const res = await ITC.adjustZenit(payload);
              if (!res?.ok) console.warn("[OniTradeWindow_Core] Zenit adjust (target only) not ok.", res);
            }
          } else {
            console.log("[OniTradeWindow_Core] Zenit offers present but neither side has an actor; skipping.");
          }
        } catch (err) {
          console.error("[OniTradeWindow_Core] Error during Zenit transfer/adjust.", {
            err,
            sess,
            zenitOfferInitiator,
            zenitOfferTarget
          });
        }
      }

      // Mark settled
      await updateSessionGM(sess.requestId, (current) => {
        if (!current) return null;
        const next = foundry.utils.duplicate(current);
        next.settled = true;
        return next;
      });

      ui.notifications?.info?.("OniTrade: Trade finalized. Items and Zenit have been transferred.");
    }

    /**
     * Request a trade window operation:
     *   - If primary GM: apply immediately.
     *   - If secondary GM or Player: emit a socket message for the primary GM to process.
     */
    async function requestOp(payload) {
      const sc = scene();
      if (!sc) {
        ui.notifications?.error?.("OniTrade: No active scene for Trade Window.");
        return;
      }

      if (!game.socket) {
        ui.notifications?.error?.("OniTrade: game.socket is not available (Trade Window).");
        return;
      }

      if (isGM() && isPrimaryActiveGM()) {
        await applyOpGM(payload);
        return;
      }

      console.log("[OniTradeWindow_Core] Non-primary client sending OniTrade_TradeWindowDelta:", {
        payload,
        localUserId: game.user?.id ?? null,
        isGM: !!game.user?.isGM,
        primaryGmUserId: getPrimaryActiveGM()?.id ?? null
      });

      game.socket.emit(CHANNEL, {
        type: "OniTrade_TradeWindowDelta",
        payload
      });
    }

    // Socket listener – only PRIMARY GM listens for OniTrade_TradeWindowDelta and mutates flags
    if (!GLOBAL.socketInstalled && game.socket) {
      const handler = async (data) => {
        if (!data || typeof data !== "object") return;
        if (data.type !== "OniTrade_TradeWindowDelta") return;

        console.log(
          "[OniTradeWindow_Core] SOCKET handler fired on user",
          game.user.id,
          "isGM:",
          game.user.isGM,
          "data:",
          data
        );

        if (!isGM()) {
          console.log("[OniTradeWindow_Core] This user is not GM; ignoring OniTrade_TradeWindowDelta.");
          return;
        }

        if (!isPrimaryActiveGM()) {
          console.log("[OniTradeWindow_Core] This GM is not the primary active GM; ignoring OniTrade_TradeWindowDelta.", {
            localUserId: game.user?.id ?? null,
            primaryGmUserId: getPrimaryActiveGM()?.id ?? null
          });
          return;
        }

        const payload = data.payload || {};
        await applyOpGM(payload);
      };

      game.socket.on(CHANNEL, handler);
      GLOBAL.socketInstalled = true;

      console.log("[OniTradeWindow_Core] Socket listener installed on", CHANNEL, "for user", game.user.id);
    }

    // Hook: re-render trade windows when scene flags change
    if (!GLOBAL.hookInstalled) {
      Hooks.on("updateScene", (scn, data) => {
        const currentScene = scene();
        if (!currentScene || scn.id !== currentScene.id) return;

        if (!data?.flags) return;
        if (!foundry.utils.hasProperty(data, `flags.${FLAG_SCOPE}.${FLAG_KEY}`)) return;

        console.log("[OniTradeWindow_Core] updateScene detected trade flag change; re-rendering.");

        for (const app of Object.values(GLOBAL.apps)) {
          if (app instanceof Application) app.render(false);
        }
      });

      GLOBAL.hookInstalled = true;
      console.log("[OniTradeWindow_Core] updateScene hook installed.");
    }

    // Public API: openTradeWindowForSession(payload)
    GLOBAL.openTradeWindowForSession = function (payload) {
      if (!payload || typeof payload !== "object") return;

      const {
        requestId,
        initiatorUserId,
        targetUserId,
        initiatorName,
        targetName,
        initiatorActorUuid,
        targetActorUuid
      } = payload;

      const localId = game.user.id;

      let localSide = null;
      if (localId === initiatorUserId) localSide = "initiator";
      if (localId === targetUserId)    localSide = "target";

      if (!localSide) {
        console.log("[OniTradeWindow_Core] openTradeWindowForSession: local user not a participant, skipping.", {
          localId, initiatorUserId, targetUserId
        });
        return;
      }

      const AppClass = GLOBAL.AppClass;
      if (!AppClass) {
        console.warn("[OniTradeWindow_Core] openTradeWindowForSession called, but AppClass is not registered yet.");
        return;
      }

      let app = GLOBAL.apps[requestId];
      if (app && app instanceof AppClass) {
        app.bringToTop();
        return;
      }

      app = new AppClass({
        requestId,
        initiatorUserId,
        targetUserId,
        initiatorName,
        targetName,
        initiatorActorUuid,
        targetActorUuid,
        localSide
      });

      GLOBAL.apps[requestId] = app;
      app.render(true);

      requestOp({
        requestId,
        op: "initSession",
        initiatorUserId,
        targetUserId,
        initiatorName,
        targetName,
        initiatorActorUuid,
        targetActorUuid
      });
    };

    GLOBAL.readAllSessions = readAllSessions;
    GLOBAL.requestOp       = requestOp;
    GLOBAL.esc             = esc;

    // Debug / status (does not change logic)
    GLOBAL.coreInstalled = true;
    GLOBAL.installed = true;

    console.log("[OniTradeWindow_Core] API installed at globalThis.__OniTradeWindow__.");
  });
})();