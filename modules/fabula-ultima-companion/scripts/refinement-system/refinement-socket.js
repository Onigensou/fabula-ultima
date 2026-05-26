// scripts/refinement-system/refinement-socket.js

const REFINEMENT_CHANNEL = "module.fabula-ultima-companion";
const REFINE_MSG = {
  REQ:    "refine:req",
  RESULT: "refine:result",
};

class RefinementSocketHandler {
  constructor() {
    this._pending = new Map(); // refineId → resolve
    this._onSocket = this._onSocket.bind(this);
  }

  // ─────────────────────────────────────────────
  // Player-side: initiate a refinement request
  // ─────────────────────────────────────────────

  async requestRefine({ itemUuid, actorUuid }) {
    if (game.user.isGM) {
      return this.executeRefine({ itemUuid, actorUuid, requesterUserId: game.user.id });
    }

    const refineId = foundry.utils.randomID();
    return new Promise((resolve) => {
      this._pending.set(refineId, resolve);

      game.socket.emit(REFINEMENT_CHANNEL, {
        type:    REFINE_MSG.REQ,
        payload: { refineId, itemUuid, actorUuid, requesterUserId: game.user.id },
      });

      setTimeout(() => {
        if (!this._pending.has(refineId)) return;
        this._pending.delete(refineId);
        resolve({ ok: false, reason: "timeout" });
      }, 15_000);
    });
  }

  // ─────────────────────────────────────────────
  // GM-side: execute the refinement
  // ─────────────────────────────────────────────

  async executeRefine({ itemUuid, actorUuid, requesterUserId }) {
    try {
      const _resolve = (uuid) =>
        (typeof fromUuidSync === "function" ? fromUuidSync(uuid) : null) ?? fromUuid(uuid);

      const [item, actor] = await Promise.all([_resolve(itemUuid), _resolve(actorUuid)]);

      if (!item)  return { ok: false, reason: "item_not_found" };
      if (!actor) return { ok: false, reason: "actor_not_found" };

      const check = rfCanRefine(item);
      if (!check.allowed) {
        return { ok: false, reason: check.reason, result: rfBuildResult(item, false, 0) };
      }

      const cost         = rfGetCost();
      const currentZenit = Math.max(0, Number(actor.system?.props?.zenit ?? 0));

      if (currentZenit < cost) {
        return { ok: false, reason: `Not enough Zenit. Need ${cost}, have ${currentZenit}.` };
      }

      // Deduct zenit before rolling — cost is consumed regardless of outcome
      const tc = window["oni.ItemTransferCore"];
      if (tc?.adjustZenit) {
        await tc.adjustZenit({ actorUuid: actor.uuid, delta: -cost, requestedByUserId: requesterUserId });
      } else {
        await actor.update({ "system.props.zenit": currentZenit - cost });
      }

      const successRate = rfGetSuccessRate(item);
      const rolled      = rfRollAttempt(successRate);
      const result      = rfBuildResult(item, rolled, cost);

      const newCount = rfGetRefineCount(item) + 1;
      const updates  = { "system.props.refine_count": newCount };

      if (rolled) {
        updates["system.props.refine_level"] = result.newRefineLevel;
        updates["name"]                      = result.displayName;

        if (result.itemType === "weapon" && typeof result.bonusAfter === "number") {
          updates["system.props.damage_bonus"] = result.bonusAfter;
        }
        // armor/shield bonus updates go here once formulas are finalized
      }

      await item.update(updates);

      await ChatMessage.create({
        content: result.success
          ? `⚒️ <b>${result.displayName}</b> — refinement succeeded! (+${result.oldRefineLevel} → +${result.newRefineLevel}) [${successRate}% chance]`
          : `⚒️ <b>${result.baseName}</b> — refinement failed. Remains at +${result.oldRefineLevel}. [${successRate}% chance, ${cost}z consumed]`,
      });

      return { ok: true, result };
    } catch (e) {
      console.error("[Refinement] executeRefine error:", e);
      return { ok: false, reason: "error", message: String(e?.message ?? e) };
    }
  }

  // ─────────────────────────────────────────────
  // Both sides: resolve a pending promise on result
  // ─────────────────────────────────────────────

  onRefineResult(payload) {
    const { refineId, ...rest } = payload ?? {};
    if (!refineId) return;
    const resolve = this._pending.get(refineId);
    if (!resolve) return;
    this._pending.delete(refineId);
    resolve(rest);
  }

  // ─────────────────────────────────────────────
  // Socket message router
  // ─────────────────────────────────────────────

  _onSocket(msg) {
    try {
      if (!msg?.type) return;

      if (game.user.isGM && msg.type === REFINE_MSG.REQ) {
        // Only the first active GM executes to avoid duplicate writes
        const gms = (game.users?.contents ?? []).filter(u => u?.isGM && u?.active);
        if (gms[0]?.id !== game.user.id) return;

        const { refineId, ...rest } = msg.payload ?? {};
        this.executeRefine(rest)
          .then(r  => game.socket.emit(REFINEMENT_CHANNEL, { type: REFINE_MSG.RESULT, payload: { refineId, ...r } }))
          .catch(e => {
            console.error("[Refinement] socket handler error:", e);
            game.socket.emit(REFINEMENT_CHANNEL, { type: REFINE_MSG.RESULT, payload: { refineId, ok: false, reason: "server_error" } });
          });
        return;
      }

      if (msg.type === REFINE_MSG.RESULT) {
        this.onRefineResult(msg.payload ?? {});
      }
    } catch (e) {
      console.error("[Refinement] _onSocket error:", e);
    }
  }
}
