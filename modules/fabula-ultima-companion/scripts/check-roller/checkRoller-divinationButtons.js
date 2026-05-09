/**
 * [CheckRoller] DivinationButtons — Foundry VTT v12
 * -----------------------------------------------------------------------------
 * Adds a "Divination" + "Pass" pair of buttons to every CheckRoller card,
 * visible to any user that owns an actor carrying a charged Divination Active
 * Effect.
 *
 * Authoring contract (lives in `worlds/`):
 * - The Divination spell applies an ActiveEffect to the caster carrying the
 *   generic charges flags consumed by FUCompanion.api.charges:
 *     flags.fabula-ultima-companion.charges    = 2
 *     flags.fabula-ultima-companion.chargesMax = 2     (optional, display only)
 *     flags.fabula-ultima-companion.chargeKey  = "divination"
 *   Spell author handles the 10 MP cost via the normal skill/spell pipeline;
 *   this file only consumes the AE.
 *
 * Runtime behavior:
 * - Click "Divination": reroll both dice on the active check, recompute totals,
 *   consume one charge (deletes the AE when charges hit 0), and emit
 *   `creature_check_outcome_flipped` for the reaction system.
 *   Once-per-card via `payload.meta.invoked.divination`.
 * - Click "Pass": locally suppress the buttons for this (msgId, actorId) pair
 *   and replace them with a single "Passed (click to cancel)" button so the
 *   viewer can change their mind. Persisted in localStorage; never mutates
 *   the message.
 *
 * Cross-permission writes:
 * - Non-roller viewers can't `message.setFlag` directly; the reroll write goes
 *   through GMExecutor.executeSnippet. AE charge updates use the charges API,
 *   which routes through GMExecutor when needed.
 */

(() => {
  const TAG = "[ONI][CheckRoller:Divination]";
  const MANAGER = globalThis.ONI?.CheckRoller;

  if (!MANAGER || !MANAGER.__isCheckRollerManager) {
    ui?.notifications?.error("Check Roller: Manager not found. Run [CheckRoller] Manager first.");
    console.error(`${TAG} Manager not found at ONI.CheckRoller`);
    return;
  }

  if (globalThis.ONI.__CheckRollerDivinationInstalled) {
    console.log(`${TAG} Already installed. (Re-run ignored)`);
    return;
  }

  if (!globalThis.ONI?.Divination) {
    console.error(`${TAG} ONI.Divination not loaded. divinationCore.js must run before this script.`);
    return;
  }

  const Div = globalThis.ONI.Divination;

  const { CONST } = MANAGER;
  const MODULE_SCOPE = "fabula-ultima-companion";
  const READ_SCOPES = Array.from(new Set([CONST.FLAG_SCOPE, MODULE_SCOPE].filter(Boolean)));
  const WRITE_SCOPE = game.modules?.has(CONST.FLAG_SCOPE) ? CONST.FLAG_SCOPE : MODULE_SCOPE;
  const PASS_LS_PREFIX = "oni.divinationPassed";

  // ---------------------------------------------------------------------------
  // Tiny helpers
  // ---------------------------------------------------------------------------
  const safeStr = (v, fb = "") => (typeof v === "string" ? v : (v == null ? fb : String(v)));
  const safeInt = (v, fb = 0) => {
    const n = typeof v === "number" ? v : parseInt(String(v ?? "").replace(/[^\d-]/g, ""), 10);
    return Number.isFinite(n) ? n : fb;
  };
  const esc = (s) => safeStr(s, "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
  const sumParts = (parts) => Array.isArray(parts)
    ? parts.reduce((a, p) => a + safeInt(p?.value, 0), 0)
    : 0;
  const deepClone = (obj) => foundry.utils.deepClone(obj);

  const getPayload = (message) => {
    for (const scope of READ_SCOPES) {
      try {
        const p = message?.getFlag(scope, CONST.FLAG_KEY_CARD);
        if (p) return p;
      } catch (_) {}
    }
    return null;
  };

  const isCheckRollerMessage = (message) => {
    const p = getPayload(message);
    return Boolean(p && p.kind === "fu_check");
  };

  // ---------------------------------------------------------------------------
  // Pass-state (per-viewer, per-card, per-actor) — local only
  // ---------------------------------------------------------------------------
  const passKey = (msgId, actorId) => `${PASS_LS_PREFIX}.${msgId}.${actorId}`;

  const hasPassed = (msgId, actorId) => {
    try { return window.localStorage?.getItem(passKey(msgId, actorId)) === "1"; }
    catch (_) { return false; }
  };

  const setPassed = (msgId, actorId, on) => {
    try {
      if (on) window.localStorage?.setItem(passKey(msgId, actorId), "1");
      else window.localStorage?.removeItem(passKey(msgId, actorId));
    } catch (_) {}
  };

  // ---------------------------------------------------------------------------
  // Cross-permission message-payload write
  // ---------------------------------------------------------------------------
  // The AE owner is rarely also the message's user; setFlag would fail with a
  // permission error. Route through GMExecutor when we don't own the message.
  async function writePayload(message, nextPayload) {
    const ownsMessage = game.user?.isGM || message?.user?.id === game.user?.id;
    if (ownsMessage) {
      await message.setFlag(WRITE_SCOPE, CONST.FLAG_KEY_CARD, nextPayload);
      return;
    }

    const gmExec = globalThis?.FUCompanion?.api?.GMExecutor;
    if (!gmExec?.executeSnippet) {
      throw new Error("GMExecutor unavailable for cross-permission Divination write.");
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
        scope: WRITE_SCOPE,
        key: CONST.FLAG_KEY_CARD,
        next: nextPayload
      }
    });
    if (!res?.ok) {
      throw new Error(`GMExecutor refused Divination write: ${safeStr(res?.reason, "unknown")}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Apply Divination to a CheckRoller message
  // ---------------------------------------------------------------------------
  async function applyDivination(message) {
    const payload = getPayload(message);
    if (!payload) return;

    payload.meta = payload.meta || {};
    payload.meta.invoked = payload.meta.invoked || { trait: false, bond: false };
    if (payload.meta.invoked.divination) {
      ui.notifications?.warn("Divination already used on this check.");
      return;
    }

    // RAW: a Critical or Fumble is a locked outcome and cannot be rerolled.
    if (Div.isLockedByCritOrFumble(payload.result)) {
      ui.notifications?.warn("Critical and Fumble results cannot be rerolled.");
      return;
    }

    const owned = Div.findOwnedCaster();
    if (!owned) {
      ui.notifications?.warn("No owned actor with Divination charges remaining.");
      return;
    }
    const { actor, effect } = owned;

    const check = payload.check || {};
    const dieA = safeInt(check?.dice?.A, 0);
    const dieB = safeInt(check?.dice?.B, 0);
    if (dieA <= 0 || dieB <= 0) {
      ui.notifications?.error("Divination: invalid die sizes on this check.");
      return;
    }

    const before = Div.snapshotCheckResult(payload.result);

    const newA = (await (new Roll(`1d${dieA}`)).evaluate()).total;
    const newB = (await (new Roll(`1d${dieB}`)).evaluate()).total;

    const next = deepClone(payload);
    next.meta = next.meta || {};
    next.meta.invoked = next.meta.invoked || { trait: false, bond: false };
    next.meta.invoked.divination = true;
    next.meta.divinationBy = {
      actorId: actor.id,
      actorUuid: actor.uuid,
      actorName: actor.name,
      userId: game.user?.id ?? null,
      userName: game.user?.name ?? null
    };

    next.result = next.result || {};
    next.result.rollA = newA;
    next.result.rollB = newB;
    next.result.hr = Math.max(newA, newB);
    next.result.base = newA + newB;

    const parts = next?.check?.modifier?.parts || [];
    const modTotal = sumParts(parts);
    next.result.modifierTotal = modTotal;
    next.result.total = next.result.base + modTotal;

    const cf = Div.computeOpenCheckResult(newA, newB);
    next.result.isCrit = cf.isCrit;
    next.result.isFumble = cf.isFumble;

    // Consume one charge first; if that fails, abort the reroll write so the
    // user isn't charged for nothing.
    const consumeRes = await Div.consumeOneCharge(effect);
    if (!consumeRes?.ok) {
      console.error(`${TAG} Failed to consume Divination charge; aborting.`, consumeRes);
      ui.notifications?.error("Divination: could not update Active Effect; reroll aborted.");
      return;
    }
    const remaining = consumeRes.after;

    try {
      await writePayload(message, next);
    } catch (e) {
      console.error(`${TAG} Reroll write failed; charge already spent.`, e);
      ui.notifications?.error("Divination: reroll failed to apply (charge was spent).");
      return;
    }

    // Re-render the card via the manager (mirrors invokeButtons.updateCard).
    if (typeof MANAGER.updateMessage === "function") {
      try { await MANAGER.updateMessage(message, { payload: next }); } catch (_) {}
    }

    console.log(`${TAG} Applied`, {
      msgId: message.id,
      actorName: actor.name,
      chargesRemaining: remaining,
      rolls: [newA, newB],
      newTotal: next.result.total
    });

    // Gate the reaction emit on actual outcome change (Hina's Foresight Zero
    // Trigger requires the rerolled outcome to differ from the original).
    // When DL isn't set, outcomeFlippedOpenCheck returns false — GM grants
    // Zero Power manually in that case (per design decision).
    const after = Div.snapshotCheckResult(next.result);
    const flipped = Div.outcomeFlippedOpenCheck(before, after, payload?.check?.dl);
    if (flipped) {
      Div.emitOutcomeFlipped({ actor, before, after, mechanism: "divination" });
    } else {
      console.log(`${TAG} Outcome unchanged; not emitting creature_check_outcome_flipped.`, {
        dl: payload?.check?.dl ?? null, before, after
      });
    }

    ui.notifications?.info(
      remaining > 0
        ? `Divination used. ${remaining} charge${remaining === 1 ? "" : "s"} remaining.`
        : "Divination used. Active Effect ended."
    );
  }

  // ---------------------------------------------------------------------------
  // Card injection / hydrate
  // ---------------------------------------------------------------------------
  const STYLE_ID = "oni-cr-divination-style";

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .oni-cr-divination {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 6px;
        margin-top: 6px;
      }
      .oni-cr-divination .oni-cr-btn-divine {
        background: linear-gradient(180deg, #c9a8e7, #8b5fbf);
        border: 2px solid #5a3a8a;
        color: #fff;
        font-weight: 700;
        text-shadow: 0 1px 0 rgba(0,0,0,.3);
      }
      .oni-cr-divination .oni-cr-btn-divine:hover { filter: brightness(1.05); }
      .oni-cr-divination .oni-cr-btn-pass {
        background: linear-gradient(180deg, #ddd, #b0b0b0);
        border: 2px solid #6b6b6b;
        color: #2a2a2a;
        font-weight: 600;
      }
      .oni-cr-divination .oni-cr-btn-pass:hover { filter: brightness(1.05); }
      .oni-cr-divination-passed {
        display: block;
        margin-top: 6px;
      }
      .oni-cr-divination-passed .oni-cr-btn-passed {
        width: 100%;
        background: linear-gradient(180deg, #f0e6d2, #d8c8a8);
        border: 2px dashed #8a6a3a;
        color: #4a3a1a;
        font-style: italic;
        font-weight: 600;
        opacity: 0.85;
      }
      .oni-cr-divination-passed .oni-cr-btn-passed:hover {
        opacity: 1;
        filter: brightness(1.03);
      }
    `;
    document.head.appendChild(style);
  }

  function buildLiveButtonsHtml(actorName, charges) {
    const label = `🔮 Divination (${esc(actorName)} – ${charges} left)`;
    return `
      <div class="oni-cr-divination" data-oni-divination-state="live">
        <button type="button"
                class="oni-cr-btn oni-cr-btn-divine"
                data-oni-cr-divination
                title="Reroll both dice. Spends 1 Divination charge.">
          <span class="oni-cr-btn-label">${label}</span>
        </button>
        <button type="button"
                class="oni-cr-btn oni-cr-btn-pass"
                data-oni-cr-divination-pass
                title="Skip Divination on this check (you can cancel later).">
          <span class="oni-cr-btn-label">Pass</span>
        </button>
      </div>
    `;
  }

  function buildPassedButtonHtml(actorName) {
    return `
      <div class="oni-cr-divination-passed" data-oni-divination-state="passed">
        <button type="button"
                class="oni-cr-btn oni-cr-btn-passed"
                data-oni-cr-divination-cancelpass
                title="You chose not to use Divination here. Click to undo.">
          <span class="oni-cr-btn-label">✋ Passed (${esc(actorName)}) — click to cancel</span>
        </button>
      </div>
    `;
  }

  function findInjectionAnchor(rootEl) {
    return rootEl.querySelector(".oni-cr-invoke")
      || rootEl.querySelector(".oni-cr-buttons")
      || rootEl.querySelector(".oni-cr-body")
      || rootEl.querySelector(".oni-cr-card");
  }

  // Idempotent: removes any prior injection before re-rendering.
  function injectForViewer(rootEl, message, payload) {
    const existing = rootEl.querySelector(".oni-cr-divination, .oni-cr-divination-passed");
    if (existing) existing.remove();

    if (payload?.meta?.invoked?.divination) return;

    // RAW: Crit/Fumble are locked outcomes — don't even offer the buttons.
    if (Div.isLockedByCritOrFumble(payload?.result)) return;

    const owned = Div.findOwnedCaster();
    if (!owned) return;

    const anchor = findInjectionAnchor(rootEl);
    if (!anchor) return;

    const actorId = owned.actor.id;
    const html = hasPassed(message.id, actorId)
      ? buildPassedButtonHtml(owned.actor.name)
      : buildLiveButtonsHtml(owned.actor.name, owned.charges);

    // Inject after the anchor unless the anchor is the card root itself.
    if (anchor.classList.contains("oni-cr-card")) {
      anchor.insertAdjacentHTML("beforeend", html);
    } else {
      anchor.insertAdjacentHTML("afterend", html);
    }
  }

  function getMessageFromClick(ev) {
    const $btn = $(ev.currentTarget);
    const $card = $btn.closest(".oni-cr-card");
    const midFromCard = $card.attr("data-oni-cr-msgid");
    const midFromLi = $btn.closest("li.chat-message").attr("data-message-id");
    const msgId = midFromCard || midFromLi || "";
    return game.messages.get(msgId) || null;
  }

  function rerenderDivinationBlock(rootEl, message) {
    const payload = getPayload(message);
    if (!payload) return;
    injectForViewer(rootEl, message, payload);
  }

  // ---------------------------------------------------------------------------
  // Click handlers
  // ---------------------------------------------------------------------------
  const onClickDivination = async (ev) => {
    try {
      ev.preventDefault();
      const msg = getMessageFromClick(ev);
      if (!msg || !isCheckRollerMessage(msg)) return;
      await applyDivination(msg);
    } catch (e) {
      console.warn(`${TAG} Divination click error`, e);
      ui.notifications?.error("Divination failed; see console.");
    }
  };

  const onClickPass = async (ev) => {
    try {
      ev.preventDefault();
      const msg = getMessageFromClick(ev);
      if (!msg) return;

      const owned = Div.findOwnedCaster();
      if (!owned) return;

      setPassed(msg.id, owned.actor.id, true);

      const root = ev.currentTarget.closest("li.chat-message") || document;
      rerenderDivinationBlock(root, msg);
    } catch (e) {
      console.warn(`${TAG} Pass click error`, e);
    }
  };

  const onClickCancelPass = async (ev) => {
    try {
      ev.preventDefault();
      const msg = getMessageFromClick(ev);
      if (!msg) return;

      const owned = Div.findOwnedCaster();
      if (!owned) return;

      setPassed(msg.id, owned.actor.id, false);

      const root = ev.currentTarget.closest("li.chat-message") || document;
      rerenderDivinationBlock(root, msg);
    } catch (e) {
      console.warn(`${TAG} Cancel-pass click error`, e);
    }
  };

  // ---------------------------------------------------------------------------
  // Hooks: render + reactive re-injection on AE / payload change
  // ---------------------------------------------------------------------------
  ensureStyles();

  Hooks.on("renderChatMessage", (message, html) => {
    try {
      if (!isCheckRollerMessage(message)) return;
      const root = (html instanceof jQuery) ? html[0] : html;
      if (!root) return;
      const payload = getPayload(message);
      if (!payload) return;
      injectForViewer(root, message, payload);
    } catch (e) {
      console.warn(`${TAG} hydrate error`, e);
    }
  });

  // When an AE on one of our actors changes (charges decrement, AE deleted),
  // re-inject all visible CheckRoller cards so the button updates / disappears.
  function refreshAllVisibleCards() {
    document.querySelectorAll("li.chat-message").forEach((li) => {
      const msgId = li.getAttribute("data-message-id");
      if (!msgId) return;
      const msg = game.messages.get(msgId);
      if (!msg || !isCheckRollerMessage(msg)) return;
      rerenderDivinationBlock(li, msg);
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

  // Delegated click handlers (survive re-render).
  $(document).on("click.oni-cr-divination", "[data-oni-cr-divination]", onClickDivination);
  $(document).on("click.oni-cr-divination", "[data-oni-cr-divination-pass]", onClickPass);
  $(document).on("click.oni-cr-divination", "[data-oni-cr-divination-cancelpass]", onClickCancelPass);

  globalThis.ONI.__CheckRollerDivinationInstalled = true;
  console.log(`${TAG} Installed.`);
})();
