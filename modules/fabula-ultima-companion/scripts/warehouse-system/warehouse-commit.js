// scripts/warehouse-system/warehouse-commit.js
import { WarehouseDebug } from "./warehouse-debug.js";
import { WarehouseAPI } from "./warehouse-api.js";
import { WarehouseGates } from "./warehouse-gates.js";

export class WarehouseCommit {
  static async commit(payload, appInstance = null) {
    const TAG = "COMMIT";

    // Ensure commit section exists (payload never drops data)
    payload.commit = payload.commit ?? {
      startedAt: null,
      finishedAt: null,
      ok: null,
      errors: [],
      results: {
        itemMoves: [],
        zenit: null
      }
    };

    payload.commit.startedAt = Date.now();
    payload.commit.finishedAt = null;
    payload.commit.ok = null;
    payload.commit.errors = [];
    payload.commit.results = { itemMoves: [], zenit: null };

    WarehouseDebug.log(payload, TAG, "Commit requested", {
      moves: payload.plan?.itemMoves?.length ?? 0,
      zenitPlan: payload.plan?.zenit ?? {}
    });

    // 1) Final gate check
    WarehouseGates.validate(payload);
    if (!payload.gates?.ok) {
      const errs = payload.gates?.errors ?? [];
      payload.commit.ok = false;
      payload.commit.errors.push(...errs);
      payload.commit.finishedAt = Date.now();

      WarehouseDebug.warn(payload, TAG, "Blocked by gates", { errors: errs });
      ui.notifications.error("Warehouse: Cannot confirm. Fix the errors first.");
      return payload.commit;
    }

    // 2) Resolve actors (source + storage)
    const actor = await fromUuid(payload.ctx.actorUuid);
    const storage = await fromUuid(payload.ctx.storageActorUuid);

    if (!actor || !storage) {
      const msg = "Commit failed: actor or storage could not be resolved.";
      payload.commit.ok = false;
      payload.commit.errors.push(msg);
      payload.commit.finishedAt = Date.now();
      WarehouseDebug.error(payload, TAG, msg, { actor: !!actor, storage: !!storage });
      ui.notifications.error("Warehouse: Actor/Storage missing.");
      return payload.commit;
    }

    // 3) Get ItemTransferCore
    const core = window["oni.ItemTransferCore"];
    if (!core) {
      const msg = "Commit failed: window['oni.ItemTransferCore'] not installed.";
      payload.commit.ok = false;
      payload.commit.errors.push(msg);
      payload.commit.finishedAt = Date.now();
      WarehouseDebug.error(payload, TAG, msg, {});
      ui.notifications.error("Warehouse: ItemTransferCore not found.");
      return payload.commit;
    }

    // Helper: pick mode based on direction
    const pickMode = (from, to) => {
      // actor -> storage === actorToActor
      // storage -> actor === actorToActor (just swapped)
      return "actorToActor";
    };

    // 4) Execute item moves in order
    const moves = Array.isArray(payload.plan?.itemMoves) ? payload.plan.itemMoves : [];

    for (const m of moves) {
      try {
        const mode = pickMode(m.from, m.to);

        const senderActorUuid = m.from === "actor" ? actor.uuid : storage.uuid;
        const receiverActorUuid = m.to === "actor" ? actor.uuid : storage.uuid;

        const transferPayload = {
          mode,
          itemUuid: m.itemUuid,
          quantity: Number(m.qty ?? 1),
          senderActorUuid,
          receiverActorUuid,
          requestedByUserId: payload.ctx.userId,

          // Warehouse UX: usually NO obtained-card spam for storage transfers
          showTransferCard: false
        };

        WarehouseDebug.log(payload, TAG, "ItemTransferCore.transfer()", transferPayload);

        const result = await core.transfer(transferPayload);

        payload.commit.results.itemMoves.push({
          plannedMoveId: m.id,
          ok: !!result?.ok,
          result
        });
      } catch (err) {
        const eMsg = String(err?.message ?? err);
        payload.commit.errors.push(eMsg);

        payload.commit.results.itemMoves.push({
          plannedMoveId: m.id,
          ok: false,
          error: eMsg
        });

        WarehouseDebug.error(payload, TAG, "Item move failed", {
          plannedMove: m,
          error: eMsg
        });
      }
    }

    // 5) Execute zenit transfer (deposit/withdraw)
    try {
      const zen = payload.plan?.zenit ?? {};
      const deposit = Math.max(0, Math.floor(Number(zen.depositToStorage ?? 0)));
      const withdraw = Math.max(0, Math.floor(Number(zen.withdrawFromStorage ?? 0)));

      // In your UI we treat these as mutually exclusive. If both happen, we can net them.
      const net = deposit - withdraw;

      if (net !== 0) {
        // net > 0 means actor -> storage
        const senderActorUuid = net > 0 ? actor.uuid : storage.uuid;
        const receiverActorUuid = net > 0 ? storage.uuid : actor.uuid;

        const amount = Math.abs(net);

        WarehouseDebug.log(payload, TAG, "ItemTransferCore.transferZenit()", {
          senderActorUuid,
          receiverActorUuid,
          amount
        });

        const zenitResult = await core.transferZenit({
          senderActorUuid,
          receiverActorUuid,
          amount,
          requestedByUserId: payload.ctx.userId
        });

        payload.commit.results.zenit = zenitResult;

        if (!zenitResult?.ok) {
          payload.commit.errors.push(`Zenit transfer failed: ${zenitResult?.reason ?? "unknown"}`);
        }
      } else {
        payload.commit.results.zenit = { ok: true, transferredAmount: 0, reason: "no_change" };
      }
    } catch (err) {
      const eMsg = String(err?.message ?? err);
      payload.commit.errors.push(eMsg);
      payload.commit.results.zenit = { ok: false, error: eMsg };
      WarehouseDebug.error(payload, TAG, "Zenit transfer failed", { error: eMsg });
    }

    // 6) Determine success
    const hasErrors = (payload.commit.errors?.length ?? 0) > 0;
    payload.commit.ok = !hasErrors;
    payload.commit.finishedAt = Date.now();

    // 7) If OK: clear plan + rebuild snapshot + rerender UI
    if (payload.commit.ok) {
      WarehouseDebug.log(payload, TAG, "Commit OK → clearing plan + rebuilding snapshot", {});
      payload.plan.itemMoves = [];
      payload.plan.zenit.depositToStorage = 0;
      payload.plan.zenit.withdrawFromStorage = 0;

      await WarehouseAPI.buildSnapshot(payload);
      WarehouseGates.validate(payload);

      appInstance?.render?.(true);

      ui.notifications.info("Warehouse: Transfers confirmed.");
    } else {
      WarehouseDebug.warn(payload, TAG, "Commit finished with errors", { errors: payload.commit.errors });
      ui.notifications.error("Warehouse: Some transfers failed. Check console.");
      appInstance?.render?.(true);
    }

    return payload.commit;
  }
}
