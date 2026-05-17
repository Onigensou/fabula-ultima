/**
 * [ONI] Reaction System — Action-Card UI Lock
 * ---------------------------------------------------------------------------
 * Visually disables action-card buttons (Apply Damage, Invoke Trait/Bond,
 * Confirm, etc.) while a reaction window for that card is in flight, so the
 * GM (or whoever) can't progress the resolution until reactors have decided.
 *
 * Drive:
 *   • `flags.fabula-ultima-companion.actionCard.reactionsPending` (boolean).
 *   • CreateActionCard.js stamps `true` right after the card is posted.
 *   • reaction-window.js (GM-authoritative, per-card pending counter) clears
 *     it to `false` when every reactor sub-window for the card settles.
 *
 * Mechanism:
 *   • renderChatMessage → check the flag, apply or skip lock at render time.
 *   • updateChatMessage → toggle lock as the flag flips during runtime.
 *   • CSS adds `pointer-events: none` + a translucent banner.
 * ---------------------------------------------------------------------------
 */

(() => {
  const TAG = "[ReactionCardLock]";
  const MODULE_ID = "fabula-ultima-companion";
  const LOCK_CLASS = "fu-reactions-pending";
  const BANNER_CLASS = "fu-reactions-pending-banner";
  const STYLE_ID = "fu-reaction-card-lock-css";

  function getReactionsPending(message) {
    const flag = message?.getFlag?.(MODULE_ID, "actionCard");
    return !!(flag?.reactionsPending);
  }

  function findCardRoot(rootEl) {
    if (!rootEl) return null;
    // The action card root carries data-fu-action-card-id; the message LI
    // wraps it. Look inside the message DOM for any matching card.
    return rootEl.querySelector?.("[data-fu-action-card-id]") ?? null;
  }

  function getMessageLiById(messageId) {
    if (!messageId) return null;
    return document.querySelector(`li.chat-message[data-message-id="${CSS.escape(messageId)}"]`);
  }

  function applyLockToCard(cardEl, locked) {
    if (!cardEl) return;
    if (locked) {
      cardEl.classList.add(LOCK_CLASS);
      if (!cardEl.querySelector(`:scope > .${BANNER_CLASS}`)) {
        const banner = document.createElement("div");
        banner.className = BANNER_CLASS;
        banner.textContent = "⏳ Waiting for reactions…";
        cardEl.prepend(banner);
      }
    } else {
      cardEl.classList.remove(LOCK_CLASS);
      cardEl.querySelector(`:scope > .${BANNER_CLASS}`)?.remove();
    }
  }

  function applyLockToMessage(message, html) {
    const locked = getReactionsPending(message);
    const rootEl = html?.[0] ?? html ?? null;
    const cardEl = findCardRoot(rootEl);
    applyLockToCard(cardEl, locked);
  }

  function applyLockByMessageId(messageId, locked) {
    const li = getMessageLiById(messageId);
    if (!li) return;
    const cardEl = li.querySelector("[data-fu-action-card-id]");
    applyLockToCard(cardEl, locked);
  }

  // --- Hooks ----------------------------------------------------------------

  Hooks.on("renderChatMessage", (message, html) => {
    try { applyLockToMessage(message, html); }
    catch (e) { console.warn(TAG, "renderChatMessage handler threw:", e); }
  });

  Hooks.on("updateChatMessage", (message, changes /*, options, userId */) => {
    try {
      // Only react when the actionCard flag changed (cheap guard).
      const touched = changes?.flags?.[MODULE_ID]?.actionCard;
      if (touched === undefined) return;
      const locked = getReactionsPending(message);
      applyLockByMessageId(message.id, locked);
    } catch (e) {
      console.warn(TAG, "updateChatMessage handler threw:", e);
    }
  });

  // --- One-time CSS injection ----------------------------------------------

  Hooks.once("ready", () => {
    if (document.getElementById(STYLE_ID)) return;
    const css = `
      .${LOCK_CLASS} button,
      .${LOCK_CLASS} [role="button"],
      .${LOCK_CLASS} [data-fu-button],
      .${LOCK_CLASS} .fu-btn,
      .${LOCK_CLASS} .fu-btns * {
        pointer-events: none !important;
        opacity: 0.45 !important;
        cursor: not-allowed !important;
        filter: grayscale(0.4);
      }
      .${BANNER_CLASS} {
        background: linear-gradient(90deg, rgba(120, 80, 200, 0.18), rgba(120, 80, 200, 0.05));
        border-left: 3px solid #7850c8;
        color: #4a2f87;
        padding: 4px 10px;
        margin: 0 0 6px;
        font-size: 11px;
        font-style: italic;
        font-weight: 600;
        letter-spacing: .3px;
        border-top-left-radius: 6px;
        border-top-right-radius: 6px;
      }
    `;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = css;
    document.head.appendChild(style);
    console.debug(TAG, "Installed (CSS injected).");
  });
})();
