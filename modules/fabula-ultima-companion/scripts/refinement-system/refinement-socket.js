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

  async requestRefine({ itemUuid, actorUuid, refinerActorUuid = null }) {
    if (game.user.isGM) {
      return this.executeRefine({ itemUuid, actorUuid, refinerActorUuid, requesterUserId: game.user.id });
    }

    const refineId = foundry.utils.randomID();
    return new Promise((resolve) => {
      this._pending.set(refineId, resolve);

      game.socket.emit(REFINEMENT_CHANNEL, {
        type:    REFINE_MSG.REQ,
        payload: { refineId, itemUuid, actorUuid, refinerActorUuid, requesterUserId: game.user.id },
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

  async executeRefine({ itemUuid, actorUuid, refinerActorUuid = null, requesterUserId }) {
    try {
      const _resolve = (uuid) =>
        (typeof fromUuidSync === "function" ? fromUuidSync(uuid) : null) ?? fromUuid(uuid);

      const [item, actor, refinerActor] = await Promise.all([
        _resolve(itemUuid),
        _resolve(actorUuid),
        refinerActorUuid ? _resolve(refinerActorUuid) : Promise.resolve(null),
      ]);

      if (!item)  return { ok: false, reason: "item_not_found" };
      if (!actor) return { ok: false, reason: "actor_not_found" };

      const context = { refinerActor };

      const check = rfCanRefine(item, context);
      if (!check.allowed) {
        return { ok: false, reason: check.reason, result: rfBuildResult(item, "blocked", 0, context) };
      }

      const cost         = rfGetCost(item, context);
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

      const successRate = rfGetSuccessRate(item, context);
      const breakRate   = rfGetBreakRate(item, context);
      const outcome     = rfRollOutcome(successRate, breakRate);
      const result      = rfBuildResult(item, outcome, cost, context);

      const newCount = rfGetRefineCount(item) + 1;
      const updates  = { "system.props.refine_count": newCount };

      if (outcome === "success" || outcome === "break") {
        updates["system.props.refine_level"] = result.newRefineLevel;
        updates["name"]                      = result.displayName;

        const bonusDelta = (result.bonusAfter ?? 0) - (result.bonusBefore ?? 0);
        if (result.itemType === "weapon" && bonusDelta !== 0) {
          const currentBonus = Number(item.system?.props?.damage_bonus) || 0;
          updates["system.props.damage_bonus"] = currentBonus + bonusDelta;
        }
      }
      // "fail" → no level/name changes

      await item.update(updates);

      // Armor/shield refinement bonus is applied via a transferable Active Effect
      // on the item (keyed by flag) rather than a plain field, so it can be found-
      // or-created and kept in sync with the absolute bonus at the current level —
      // staying correct after breaks too.
      if (outcome === "success" || outcome === "break") {
        let aeKey = null;
        let bonusValue = 0;
        if (result.itemType === "armor") {
          aeKey      = "system.props.max_hp";
          bonusValue = rfComputeArmorBonus(result.newRefineLevel);
        } else if (result.itemType === "shield") {
          aeKey      = "system.props.damage_receiving_mod_physical";
          bonusValue = rfComputeShieldBonus(result.newRefineLevel);
        }

        if (aeKey) {
          const existingAe = item.effects?.find(
            e => e.flags?.["fabula-ultima-companion"]?.refinementBonus === true
          );

          if (result.newRefineLevel === 0) {
            if (existingAe) await existingAe.delete();
          } else {
            const changes = [{
              key:      aeKey,
              mode:     CONST.ACTIVE_EFFECT_MODES.ADD,
              value:    bonusValue,
              priority: 20,
            }];
            if (existingAe) {
              await existingAe.update({ changes });
            } else {
              await item.createEmbeddedDocuments("ActiveEffect", [{
                name:     "Refinement Bonus",
                transfer: true,
                flags:    { "fabula-ultima-companion": { refinementBonus: true } },
                changes,
              }]);
            }
          }
        }
      }

      await _rfPostChatCard(actor, result);

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

// ── Compact parchment chat card ────────────────────────────────────────────

function _rfEsc(v) {
  return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function _rfPostChatCard(actor, result) {
  const portrait = actor.prototypeToken?.texture?.src ?? actor.img ?? "";
  const oldName  = rfBuildDisplayName(result.baseName, result.oldRefineLevel);

  let outcomeClass, icon, bodyHtml;

  if (result.outcome === "success") {
    outcomeClass = "fu-rc-success";
    icon = "⚒️";
    bodyHtml = `
      <span class="fu-rc-from">${_rfEsc(oldName)}</span>
      <span class="fu-rc-sep">→</span>
      <span class="fu-rc-to fu-rc-to-success">${_rfEsc(result.displayName)}</span>`;
  } else if (result.outcome === "break") {
    outcomeClass = "fu-rc-break";
    icon = "💔";
    bodyHtml = `
      <span class="fu-rc-from">${_rfEsc(oldName)}</span>
      <span class="fu-rc-sep">→</span>
      <span class="fu-rc-to fu-rc-to-break">${_rfEsc(result.displayName)}</span>
      <span class="fu-rc-tag">broke</span>`;
  } else {
    outcomeClass = "fu-rc-fail";
    icon = "✗";
    bodyHtml = `
      <span class="fu-rc-from">${_rfEsc(oldName)}</span>
      <span class="fu-rc-sep">—</span>
      <span class="fu-rc-to fu-rc-to-fail">no change</span>`;
  }

  const html = `
    <div class="fu-refine-card ${outcomeClass}">
      <img class="fu-rc-portrait" src="${_rfEsc(portrait)}" alt="">
      <div class="fu-rc-body">
        <span class="fu-rc-icon">${icon}</span>
        ${bodyHtml}
      </div>
    </div>`;

  await ChatMessage.create({
    content: html,
    speaker: null,
    flags: { core: { cssClass: "fu-refine-msg" } },
  });
}
