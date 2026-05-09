/**
 * [ActionCard] Divination button — Foundry VTT v12
 * -----------------------------------------------------------------------------
 * Adds a "🔮 Divination" button to every Action card whose accuracy roll is
 * still rerollable (Action card state == "pending", not yet a Crit/Fumble,
 * not already invoked). Mirrors the Open-Check Divination button at
 * scripts/check-roller/checkRoller-divinationButtons.js.
 *
 * Authoring contract — see scripts/divination/divinationCore.js. The viewer
 * needs an owned actor carrying a charged Active Effect with:
 *   flags.fabula-ultima-companion.charges    > 0
 *   flags.fabula-ultima-companion.chargeKey  = "divination"
 *
 * On click:
 *   - Reroll both accuracy dice (1d{accuracy.dA} + 1d{accuracy.dB}).
 *   - Recompute accuracy.{total, hr, isCrit, isBunny, isFumble} per the FU
 *     accuracy rule (mirrors rollAccuracy() in ActionDataComputation.js,
 *     reading thresholds from the attacker actor's props).
 *   - Recompute meta.hrBonus + meta.baseValueStrForCard + advPayload.baseValue
 *     so HR-coupled damage display tracks the new HR.
 *   - Mark meta.invoked.divination = true (one-shot per card).
 *   - Spend one charge (via FUCompanion.api.charges; deletes AE at zero).
 *   - Write the action-card flag back (cross-permission via GMExecutor when
 *     the viewer doesn't own the message).
 *   - Re-render the card in place via FUCompanion.api.actionCardRenderer
 *     .updateExistingActionCard.
 *   - Emit `creature_check_outcome_flipped` for the reaction system.
 */
(() => {
  const TAG = "[ONI][ActionCard:Divination]";
  const MODULE_NS = "fabula-ultima-companion";
  const FLAG_KEY  = "actionCard";

  if (!globalThis.ONI?.Divination) {
    console.error(`${TAG} ONI.Divination not loaded. divinationCore.js must run before this script.`);
    return;
  }

  if (globalThis.ONI.__ActionCardDivinationInstalled) {
    console.log(`${TAG} Already installed. (Re-run ignored)`);
    return;
  }

  const Div = globalThis.ONI.Divination;

  // ---------------------------------------------------------------------------
  // Tiny helpers
  // ---------------------------------------------------------------------------
  const safeStr = (v, fb = "") => (typeof v === "string" ? v : (v == null ? fb : String(v)));
  const safeNum = (v, fb = 0) => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : fb;
  };
  const esc = (s) => safeStr(s, "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
  const deepClone = (obj) => foundry.utils.deepClone(obj);

  // ---------------------------------------------------------------------------
  // Payload reading / gating
  // ---------------------------------------------------------------------------
  function getActionCardFlag(message) {
    try { return message?.getFlag?.(MODULE_NS, FLAG_KEY) ?? null; }
    catch (_) { return null; }
  }

  function getPayload(message) {
    return getActionCardFlag(message)?.payload ?? null;
  }

  function isActionCardMessage(message) {
    const p = getPayload(message);
    return !!(p && p.accuracy && p.meta);
  }

  function canShowButtons(payload) {
    if (!payload) return false;
    // Lock once "the action is performed" (damage applied / card resolved).
    const state = payload.meta?.actionCardState ?? "pending";
    if (state !== "pending") return false;
    if (payload.meta?.invoked?.divination) return false;
    if (Div.isLockedByCritOrFumble({
      isCrit:   payload.accuracy?.isCrit,
      isFumble: payload.accuracy?.isFumble
    })) return false;
    return true;
  }

  // ---------------------------------------------------------------------------
  // Cross-permission flag write
  // ---------------------------------------------------------------------------
  async function writeActionCardFlag(message, nextFlag) {
    const ownsMessage = game.user?.isGM || message?.user?.id === game.user?.id;
    if (ownsMessage) {
      await message.setFlag(MODULE_NS, FLAG_KEY, nextFlag);
      return;
    }

    const gmExec = globalThis?.FUCompanion?.api?.GMExecutor;
    if (!gmExec?.executeSnippet) {
      throw new Error("GMExecutor unavailable for cross-permission Action-card flag write.");
    }
    const scriptText = `
      const msg = game.messages.get(payload.msgId);
      if (!msg) return { ok: false, reason: "message_not_found" };
      await msg.setFlag(payload.scope, payload.key, payload.next);
      return { ok: true };
    `;
    const res = await gmExec.executeSnippet({
      scriptText,
      payload: {
        msgId: message.id,
        scope: MODULE_NS,
        key:   FLAG_KEY,
        next:  nextFlag
      }
    });
    if (!res?.ok) {
      throw new Error(`GMExecutor refused Action-card flag write: ${safeStr(res?.reason, "unknown")}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Attacker resolution (for Accuracy crit/fumble thresholds)
  // ---------------------------------------------------------------------------
  async function resolveAttackerActor(payload) {
    const candidates = [
      payload?.meta?.attackerUuid,
      payload?.attackerActorUuid,
      payload?.attackerUuid
    ].filter(Boolean);

    for (const uuid of candidates) {
      try {
        const doc = await fromUuid(uuid);
        if (!doc) continue;
        if (doc.documentName === "Actor") return doc;
        if (doc.actor) return doc.actor;
      } catch (_) {}
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Apply Divination to an Action card
  // ---------------------------------------------------------------------------
  async function applyDivination(message) {
    const flag = getActionCardFlag(message);
    if (!flag?.payload) return;

    const next = deepClone(flag);
    const payload = next.payload;

    if (!canShowButtons(payload)) {
      ui.notifications?.warn("Divination cannot be invoked on this card.");
      return;
    }

    const acc = payload.accuracy;
    const dA = safeNum(acc?.dA, 0);
    const dB = safeNum(acc?.dB, 0);
    if (dA <= 0 || dB <= 0) {
      ui.notifications?.error("Divination: invalid accuracy die sizes on this Action card.");
      return;
    }

    const owned = Div.findOwnedCaster();
    if (!owned) {
      ui.notifications?.warn("No owned actor with Divination charges remaining.");
      return;
    }
    const { actor: casterActor, effect } = owned;

    const before = Div.snapshotAccuracy(acc);

    const newA = (await (new Roll(`1d${dA}`)).evaluate()).total;
    const newB = (await (new Roll(`1d${dB}`)).evaluate()).total;

    // Preserve the original checkBonus so total is consistent across the
    // reroll. ActionDataComputation puts (rA + rB + bonus) into accuracy.total
    // but doesn't always store bonus separately, so derive when missing.
    const oldA = safeNum(acc?.rA?.total, 0);
    const oldB = safeNum(acc?.rB?.total, 0);
    const checkBonus = (acc?.checkBonus !== undefined && acc?.checkBonus !== null)
      ? safeNum(acc.checkBonus, 0)
      : (safeNum(acc?.total, 0) - (oldA + oldB));

    const attackerActor = await resolveAttackerActor(payload);
    const recomputed = Div.computeAccuracyResult(newA, newB, attackerActor, { checkBonus });

    acc.rA = { total: newA, result: String(newA) };
    acc.rB = { total: newB, result: String(newB) };
    acc.total    = recomputed.total;
    acc.hr       = recomputed.hr;
    acc.isCrit   = recomputed.isCrit;
    acc.isBunny  = recomputed.isBunny;
    acc.isFumble = recomputed.isFumble;
    if (acc.checkBonus === undefined || acc.checkBonus === null) acc.checkBonus = checkBonus;

    payload.accuracy = acc;

    // ---- HR-coupled damage display recompute (mirrors ActionDataComputation
    // ---- formulas at lines 954-961 / 1232-1238). For non-heal actions,
    // ---- baseValueStrForCard already includes HR; recover the no-HR base
    // ---- via subtraction, then re-add the new HR. For heal, baseValueStrForCard
    // ---- never contained HR.
    payload.meta = payload.meta || {};
    const declaresHealing = !!payload.meta.declaresHealing;
    const ignoreHR        = !!payload.meta.ignoreHR;
    const hasDamageSection = payload.meta.hasDamageSection !== false;

    const oldHrBonus = safeNum(payload.meta.hrBonus, 0);
    const oldBaseStr = safeStr(payload.meta.baseValueStrForCard, "");
    const oldBaseNum = oldBaseStr === "" ? 0 : safeNum(oldBaseStr, 0);

    const baseNoHR = declaresHealing
      ? oldBaseNum
      : (oldBaseNum - (ignoreHR ? 0 : oldHrBonus));

    const newHrBonus = (hasDamageSection && !declaresHealing && !ignoreHR && acc.hr)
      ? safeNum(acc.hr, 0)
      : 0;

    payload.meta.hrBonus = newHrBonus;
    if (oldBaseStr !== "") {
      payload.meta.baseValueStrForCard = declaresHealing
        ? String(baseNoHR)
        : String(baseNoHR + newHrBonus);
    }

    if (payload.advPayload && hasDamageSection) {
      payload.advPayload.baseValue = declaresHealing
        ? `+${baseNoHR}`
        : String(baseNoHR + newHrBonus);
    }

    // ---- Mark invoked + audit trail ------------------------------------------
    payload.meta.invoked = { ...(payload.meta.invoked ?? {}), divination: true };
    payload.meta.divinationBy = {
      actorId:   casterActor.id,
      actorUuid: casterActor.uuid,
      actorName: casterActor.name,
      userId:    game.user?.id ?? null,
      userName:  game.user?.name ?? null
    };

    // ---- Spend the charge first ----------------------------------------------
    // If the AE update fails, abort so the user isn't charged for nothing.
    const consumeRes = await Div.consumeOneCharge(effect);
    if (!consumeRes?.ok) {
      console.error(`${TAG} Failed to consume Divination charge; aborting.`, consumeRes);
      ui.notifications?.error("Divination: could not update Active Effect; reroll aborted.");
      return;
    }
    const remaining = consumeRes.after;

    // ---- Persist payload back into the message flag --------------------------
    next.payload = payload;
    if (next.actionCardState !== undefined) {
      next.actionCardState = payload.meta.actionCardState ?? next.actionCardState;
    }

    try {
      await writeActionCardFlag(message, next);
    } catch (e) {
      console.error(`${TAG} Action-card flag write failed; charge already spent.`, e);
      ui.notifications?.error("Divination: write failed (charge was spent).");
      return;
    }

    // ---- Re-render the card in place -----------------------------------------
    try {
      const renderer = globalThis?.FUCompanion?.api?.actionCardRenderer
                    ?? globalThis?.FUCompanion?.api?.createActionCardRenderer;
      if (renderer?.updateExistingActionCard) {
        await renderer.updateExistingActionCard({ payload, messageId: message.id });
      } else {
        console.warn(`${TAG} actionCardRenderer.updateExistingActionCard unavailable; viewers may see stale HTML until the next chat refresh.`);
      }
    } catch (e) {
      console.warn(`${TAG} Re-render failed (payload still saved).`, e);
    }

    // ---- Emit reaction trigger (gated on actual outcome change) --------------
    // Hina's Foresight Zero Trigger requires the rerolled outcome to differ
    // from the original. Outcome = per-target hit/miss; we read each target's
    // defense via the same logic as the runtime hit calculation. Per user
    // spec: "1 ZP per action, if at least 1 outcome is flipped."
    const after = Div.snapshotAccuracy(acc);
    const useMagic = Div.isAccuracyAgainstMagic(payload);
    const defenses = await Div.readTargetDefenses(payload.targets, useMagic);
    const flipped = Div.outcomeFlippedAccuracy(before, after, defenses);
    if (flipped) {
      Div.emitOutcomeFlipped({
        actor: casterActor,
        before,
        after,
        mechanism: "divination"
      });
    } else {
      console.log(`${TAG} Outcome unchanged; not emitting creature_check_outcome_flipped.`, {
        useMagic, defenses, before, after
      });
    }

    console.log(`${TAG} Applied`, {
      msgId: message.id,
      caster: casterActor.name,
      chargesRemaining: remaining,
      rolls: [newA, newB],
      newAccuracyTotal: acc.total,
      newCrit: acc.isCrit,
      newFumble: acc.isFumble
    });

    ui.notifications?.info(
      remaining > 0
        ? `Divination used. ${remaining} charge${remaining === 1 ? "" : "s"} remaining.`
        : "Divination used. Active Effect ended."
    );
  }

  // ---------------------------------------------------------------------------
  // UI: button injection / hydrate
  // ---------------------------------------------------------------------------
  const STYLE_ID = "oni-ac-divination-style";

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    // Only the hover filter — every other visual is inline-style on the
    // button so it matches the Invoke Trait/Bond buttons exactly (those
    // buttons are themselves built with inline styles in CreateActionCard.js).
    style.textContent = `
      .oni-ac-divination .oni-ac-btn-divine { cursor: pointer; }
      .oni-ac-divination .oni-ac-btn-divine:hover { filter: brightness(1.05); }
    `;
    document.head.appendChild(style);
  }

  // Match the inline-style shape of the Invoke Trait/Bond buttons
  // (CreateActionCard.js:1262-1272) but keep the purple palette.
  function buildButtonHtml(actorName, charges) {
    const label = `🔮 Divination (${esc(actorName)} – ${charges} left)`;
    const baseStyle = [
      "flex:0 0 auto",
      "position:relative",
      "overflow:hidden",
      "padding:.35rem .6rem",
      "border-radius:8px",
      "border:1px solid #5a3a8a",
      "background:linear-gradient(180deg, #c9a8e7, #8b5fbf)",
      "color:#fff",
      "font-weight:700",
      "text-shadow:0 1px 0 rgba(0,0,0,.3)"
    ].join(";");

    // Reuse the .fu-btns row layout so this row visually matches the
    // Invoke Trait/Bond row directly above it.
    return `
      <div class="oni-ac-divination fu-btns"
           style="display:flex; align-items:center; gap:.5rem; margin-top:.5rem; flex-wrap:wrap;">
        <button type="button"
                class="fu-btn oni-ac-btn-divine"
                data-oni-ac-divination-btn
                title="Reroll the accuracy check. Spends 1 Divination charge."
                style="${baseStyle}">
          <span>${label}</span>
        </button>
      </div>
    `;
  }

  // Anchor selection: place the button just below the row that holds
  // Invoke Bond, so the visual stack reads Confirm | Invoke Trait | Invoke
  // Bond → Divination. Fall back gracefully when those buttons are absent.
  function findInjectionAnchor(rootEl) {
    const bondBtn = rootEl.querySelector("[data-fu-bond]");
    if (bondBtn) return bondBtn.closest(".fu-btns") ?? bondBtn.parentElement;

    const traitBtn = rootEl.querySelector("[data-fu-trait]");
    if (traitBtn) return traitBtn.closest(".fu-btns") ?? traitBtn.parentElement;

    return rootEl.querySelector(".fu-card .fu-body")
        || rootEl.querySelector(".fu-card")
        || rootEl.querySelector(".message-content")
        || rootEl;
  }

  function injectForViewer(rootEl, message) {
    const existing = rootEl.querySelector(".oni-ac-divination");
    if (existing) existing.remove();

    const payload = getPayload(message);
    if (!canShowButtons(payload)) return;

    const owned = Div.findOwnedCaster();
    if (!owned) return;

    const anchor = findInjectionAnchor(rootEl);
    if (!anchor) return;

    const html = buildButtonHtml(owned.actor.name, owned.charges);
    // After the Invoke-row → reads as "just below" Invoke Bond.
    // Inside-fallback → append at the end of the body.
    if (anchor.classList?.contains?.("fu-btns")) {
      anchor.insertAdjacentHTML("afterend", html);
    } else {
      anchor.insertAdjacentHTML("beforeend", html);
    }
  }

  function getMessageFromClick(ev) {
    const $btn = $(ev.currentTarget);
    const $li  = $btn.closest("li.chat-message");
    const msgId = $li.attr("data-message-id") || "";
    return game.messages.get(msgId) || null;
  }

  // ---------------------------------------------------------------------------
  // Click handler
  // ---------------------------------------------------------------------------
  const onClickDivination = async (ev) => {
    try {
      ev.preventDefault();
      const msg = getMessageFromClick(ev);
      if (!msg || !isActionCardMessage(msg)) return;
      await applyDivination(msg);
    } catch (e) {
      console.warn(`${TAG} Divination click error`, e);
      ui.notifications?.error("Divination failed; see console.");
    }
  };

  // ---------------------------------------------------------------------------
  // Hooks: render + reactive re-injection on AE / payload change
  // ---------------------------------------------------------------------------
  ensureStyles();

  Hooks.on("renderChatMessage", (message, html) => {
    try {
      if (!isActionCardMessage(message)) return;
      const root = (html instanceof jQuery) ? html[0] : html;
      if (!root) return;
      injectForViewer(root, message);
    } catch (e) {
      console.warn(`${TAG} hydrate error`, e);
    }
  });

  function refreshAllVisibleCards() {
    document.querySelectorAll("li.chat-message").forEach((li) => {
      const msgId = li.getAttribute("data-message-id");
      if (!msgId) return;
      const msg = game.messages.get(msgId);
      if (!msg || !isActionCardMessage(msg)) return;
      injectForViewer(li, msg);
    });
  }

  function effectTouchesUs(effect) {
    const api = globalThis?.FUCompanion?.api?.charges;
    if (!api) return false;
    if (!api.isOwnedChargedEvent(effect)) return false;
    const info = api.read(effect);
    if (!info) return false;
    return !info.key || info.key === Div.CHARGE_KEY;
  }

  Hooks.on("createActiveEffect", (eff) => { if (effectTouchesUs(eff)) refreshAllVisibleCards(); });
  Hooks.on("updateActiveEffect", (eff) => { if (effectTouchesUs(eff)) refreshAllVisibleCards(); });
  Hooks.on("deleteActiveEffect", (eff) => { if (effectTouchesUs(eff)) refreshAllVisibleCards(); });

  // Also refresh when the action-card flag changes (e.g. state moves to
  // "resolved" after Apply Damage), so the button hides itself promptly.
  Hooks.on("updateChatMessage", (msg) => {
    try {
      if (!isActionCardMessage(msg)) return;
      const li = document.querySelector(`li.chat-message[data-message-id="${msg.id}"]`);
      if (li) injectForViewer(li, msg);
    } catch (_) {}
  });

  $(document).on("click.oni-ac-divination", "[data-oni-ac-divination-btn]", onClickDivination);

  globalThis.ONI.__ActionCardDivinationInstalled = true;
  console.log(`${TAG} Installed.`);
})();
