/**
 * [ONI] Reaction System — Module Version (Foundry VTT v12)
 * ---------------------------------------------------------------------------
 * This file is safe to load automatically from a module (runs once per client).
 * Updated for merged same-token reaction windows.
 * ---------------------------------------------------------------------------
 */
// ============================================================================
// ONI ReactionButtonUI – Floating "Reaction" blade next to tokens (Foundry v12)
// ---------------------------------------------------------------------------
// PURPOSE
// -------
// This script ONLY handles the small floating "Reaction" button UI:
//
//   • Creates the #oni-reaction-root container and CSS
//   • Spawns / positions a "Reaction" blade next to a token
//   • Cleans up buttons when asked
//
// It exposes a small API on window["oni.ReactionButtonUI"]:
//
//   const ui = window["oni.ReactionButtonUI"];
//   ui.spawnButton(token, context, (ctxClicked) => { ... });
//   ui.removeButton(tokenId);
//   ui.clearAll();
//
// NOTES
// -----
// - It DOES NOT know anything about triggers, phases, or skill selection.
// - ReactionManager decides *when* to show a button and what happens when
//   it's clicked. This file just does the pretty floating UI.
// ============================================================================

Hooks.once("ready", () => {
  (() => {
    const KEY = "oni.ReactionButtonUI";

    if (window[KEY]) {
      console.log("[ReactionButtonUI] Already installed.");
      return;
    }

    const STYLE_ID = "oni-reaction-manager-style";

    const ReactionUI = {
      root: null,
      buttons: {}
    };

    function byIdOnCanvas(tokenId) {
      if (!tokenId) return null;
      return canvas?.tokens?.get(tokenId) ?? null;
    }

    function ensureReactionStyles() {
      if (document.getElementById(STYLE_ID)) return;

      const css = document.createElement("style");
      css.id = STYLE_ID;

      css.textContent = `
        #oni-reaction-root {
          position: fixed;
          left: 0;
          top: 0;
          z-index: var(--z-index-canvas, 0);
          pointer-events: none;
        }

        #oni-reaction-root .oni-reaction-item {
          position: absolute;
          pointer-events: auto;
          opacity: 0;
          transform: translateX(-16px);
          transition:
            opacity 180ms ease-out,
            transform 180ms ease-out;
        }

        #oni-reaction-root .oni-reaction-item.is-visible {
          opacity: 1;
          transform: translateX(0);
        }

        #oni-reaction-root .oni-reaction-item.is-leaving {
          opacity: 0;
          transform: translateX(-16px);
        }

        #oni-reaction-root .oni-reaction-blade {
          position: relative;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          padding: 8px 14px;
          color: var(--bd-ink, #3a3228);
          font-family: "Inter", "Segoe UI", system-ui, -apple-system, sans-serif;
          font-weight: 800;
          letter-spacing: .32px;
          text-transform: uppercase;
          white-space: nowrap;
          user-select: none;
          cursor: pointer;
          font-size: 12px;
          background: linear-gradient(180deg,
            var(--bd-parchment-top, #f6f1e6),
            var(--bd-parchment-bot, #ebe3d0)
          );
          border: 2px solid var(--bd-stroke, #7a6a55);
          border-radius: 12px;
          box-shadow:
            0 3px 0 var(--bd-shadow, rgba(41,33,24,.55)),
            0 0 0 1px var(--bd-highlight, rgba(255,255,255,.7)) inset;
          text-shadow: 0 1px 0 rgba(255,255,255,0.75);
        }

        #oni-reaction-root .oni-reaction-blade .label {
          padding-top: 1px;
        }

        #oni-reaction-root .oni-reaction-blade .count {
          display: none;
          min-width: 18px;
          height: 18px;
          padding: 0 5px;
          align-items: center;
          justify-content: center;
          border-radius: 999px;
          border: 1px solid rgba(122,106,85,.9);
          background: rgba(58,50,40,.08);
          box-shadow: 0 1px 0 rgba(255,255,255,.55) inset;
          font-size: 11px;
          line-height: 1;
        }

        #oni-reaction-root .oni-reaction-blade.has-multiple .count {
          display: inline-flex;
        }

        #oni-reaction-root .oni-reaction-blade:hover {
          filter: brightness(1.04);
          box-shadow:
            0 4px 0 rgba(41,33,24,.65),
            0 0 0 1px rgba(255,255,255,.8) inset;
          transform: translateY(-1px);
        }

        #oni-reaction-root .oni-reaction-blade:active {
          transform: translateY(0) scale(.97);
        }
      `;

      document.head.appendChild(css);
    }

    function ensureRoot() {
      if (ReactionUI.root && document.body.contains(ReactionUI.root)) {
        return ReactionUI.root;
      }

      const root = document.createElement("div");
      root.id = "oni-reaction-root";
      document.body.appendChild(root);

      ReactionUI.root = root;
      return root;
    }

    function tokenAnchorWorld(token) {
      const c = token.center ?? token.getCenter?.() ?? {
        x: token.x + token.w / 2,
        y: token.y + token.h / 2
      };

      const offsetX = -token.w * 0.37;
      const offsetY = -token.h * 1;

      return {
        x: c.x + offsetX,
        y: c.y + offsetY
      };
    }

    function worldToClient(x, y) {
      const wt = canvas.stage.worldTransform;
      const out = new PIXI.Point();

      wt.apply({ x, y }, out);

      const rect = canvas.app.view.getBoundingClientRect();

      return {
        x: rect.left + out.x,
        y: rect.top + out.y
      };
    }

    function updateButtonPosition(rec) {
      if (!rec) return;

      const token = byIdOnCanvas(rec.tokenId);
      if (!token || !ReactionUI.root) return;

      const world = tokenAnchorWorld(token);
      const client = worldToClient(world.x, world.y);

      const el = rec.wrap;
      if (!el) return;

      el.style.left = `${client.x}px`;
      el.style.top = `${client.y}px`;
    }

    function getTriggerCount(context) {
      if (!context || typeof context !== "object") return 1;

      const direct = Array.isArray(context.triggerKeys)
        ? context.triggerKeys.filter(Boolean)
        : [];

      if (direct.length) return new Set(direct).size;

      const byTrigger =
        context.phasePayloadByTrigger &&
        typeof context.phasePayloadByTrigger === "object"
          ? Object.keys(context.phasePayloadByTrigger).filter(Boolean)
          : [];

      if (byTrigger.length) return new Set(byTrigger).size;

      return context.triggerKey ? 1 : 1;
    }

    function getBladeTitle(context) {
      const count = getTriggerCount(context);
      if (count > 1) return `Reaction (${count} triggers)`;
      return "Reaction";
    }

    function applyContextToRecord(rec, context, onClick) {
      if (!rec) return;

      rec.context = context;
      rec.onClick = typeof onClick === "function" ? onClick : null;

      const blade = rec.blade;
      if (!blade) return;

      const count = getTriggerCount(context);
      const countEl = blade.querySelector(".count");

      blade.classList.toggle("has-multiple", count > 1);
      blade.title = getBladeTitle(context);
      blade.setAttribute("aria-label", blade.title);

      if (countEl) {
        countEl.textContent = String(count);
      }
    }

    function detachTrackingHooks(rec) {
      if (!rec) return;

      for (const h of rec.hooks ?? []) {
        try {
          Hooks.off(h.event, h.handler);
        } catch (_e) {}
      }

      rec.hooks = [];
    }

    function attachTrackingHooks(rec) {
      if (!rec) return;

      if (!Array.isArray(rec.hooks)) {
        rec.hooks = [];
      }

      const tokenId = rec.tokenId;

      const updateTokenHandler = (doc) => {
        if (doc.id !== tokenId) return;
        updateButtonPosition(rec);
      };

      const canvasPanHandler = () => {
        updateButtonPosition(rec);
      };

      Hooks.on("updateToken", updateTokenHandler);
      Hooks.on("canvasPan", canvasPanHandler);

      rec.hooks.push(
        { event: "updateToken", handler: updateTokenHandler },
        { event: "canvasPan", handler: canvasPanHandler }
      );
    }

function getContextActionKey(context) {
  return String(
    context?.latestPhasePayload?.actionCardId ??
    context?.latestPhasePayload?.actionId ??
    context?.phasePayload?.actionCardId ??
    context?.phasePayload?.actionId ??
    ""
  ).trim();
}

function getContextTriggerKey(context) {
  return String(
    context?.latestTriggerKey ??
    context?.triggerKey ??
    ""
  ).trim();
}

function getContextPhaseBucket(context) {
  return String(
    context?.phaseBucket ??
    ""
  ).trim();
}

function shouldPlayRespawnAnimation(rec, nextContext) {
  if (!rec) return false;

  const wrap = rec.wrap;

  // If the button was in the middle of leaving, the next update should visibly
  // re-enter. This is the main phase-change case.
  if (rec.leaving || wrap?.classList?.contains?.("is-leaving")) {
    return true;
  }

  const oldContext = rec.context ?? {};

  const oldBucket = getContextPhaseBucket(oldContext);
  const newBucket = getContextPhaseBucket(nextContext);

  if (oldBucket && newBucket && oldBucket !== newBucket) {
    return true;
  }

  const oldTrigger = getContextTriggerKey(oldContext);
  const newTrigger = getContextTriggerKey(nextContext);

  if (oldTrigger && newTrigger && oldTrigger !== newTrigger) {
    return true;
  }

  // Same bucket + same trigger, but a different action card/action event.
  // Example: another creature performs another action during action_phase.
  const oldActionKey = getContextActionKey(oldContext);
  const newActionKey = getContextActionKey(nextContext);

  if (oldActionKey && newActionKey && oldActionKey !== newActionKey) {
    return true;
  }

  return false;
}

function playRespawnAnimation(rec) {
  const wrap = rec?.wrap;
  if (!wrap?.isConnected) return;

  // TUNING KNOB:
  // How long the button stays in its "leaving" pose before entering again.
  const RESPAWN_GAP_MS = 130;

  if (rec.respawnTimer) {
    clearTimeout(rec.respawnTimer);
    rec.respawnTimer = null;
  }

  // Temporarily prevent clicking during the tiny transition swap.
  wrap.style.pointerEvents = "none";

  // Step 1: visibly leave.
  wrap.classList.remove("is-visible");
  wrap.classList.add("is-leaving");

  // Force browser to notice the class change.
  // eslint-disable-next-line no-unused-expressions
  wrap.offsetWidth;

  rec.respawnTimer = setTimeout(() => {
    rec.respawnTimer = null;

    if (!wrap.isConnected) return;

    // Step 2: reset to hidden enter pose.
    wrap.classList.remove("is-leaving");

    // Force reset before entering.
    // eslint-disable-next-line no-unused-expressions
    wrap.offsetWidth;

    // Step 3: enter again.
    requestAnimationFrame(() => {
      if (!wrap.isConnected) return;

      wrap.classList.add("is-visible");
      wrap.style.pointerEvents = "";
    });
  }, RESPAWN_GAP_MS);
}

function updateExistingButton(rec, context, onClick) {
  if (!rec) return;

  const shouldRespawn = shouldPlayRespawnAnimation(rec, context);

  // Revive this record safely.
  rec.leaving = false;

  // Cancel any old delayed removal from removeButton().
  if (rec.removeTimer) {
    clearTimeout(rec.removeTimer);
    rec.removeTimer = null;
  }

  if (rec.finishRemove && rec.wrap) {
    try {
      rec.wrap.removeEventListener("transitionend", rec.finishRemove);
    } catch (_e) {}

    rec.finishRemove = null;
  }

  applyContextToRecord(rec, context, onClick);
  updateButtonPosition(rec);

  if (!Array.isArray(rec.hooks)) {
    rec.hooks = [];
  }

  if (rec.hooks.length === 0) {
    attachTrackingHooks(rec);
  }

  const wrap = rec.wrap;
  if (!wrap?.isConnected) return;

  if (shouldRespawn) {
    playRespawnAnimation(rec);
  } else {
    wrap.classList.remove("is-leaving");
    wrap.classList.add("is-visible");
  }
}

    function spawnButton(token, context, onClick) {
      if (!token) return;

      ensureReactionStyles();

      const root = ensureRoot();
      const tokenId = token.id;

      const existing = ReactionUI.buttons[tokenId];

      if (existing) {
        updateExistingButton(existing, context, onClick);
        return;
      }

      const wrap = document.createElement("div");
      wrap.className = "oni-reaction-item";

      const blade = document.createElement("div");
      blade.className = "oni-reaction-blade";

      blade.innerHTML = `
        <span class="label">Reaction</span>
        <span class="count" aria-hidden="true">1</span>
      `;

      wrap.appendChild(blade);
      root.appendChild(wrap);

const rec = {
  wrap,
  blade,
  tokenId,
  hooks: [],
  context,
  onClick: typeof onClick === "function" ? onClick : null,
  leaving: false,
  removeTimer: null,
  finishRemove: null,
  removeSeq: 0,
  respawnTimer: null
};

      blade.addEventListener("click", (ev) => {
        ev.stopPropagation();

        if (typeof rec.onClick === "function") {
          try {
            rec.onClick(rec.context);
          } catch (err) {
            console.error("[ReactionButtonUI] Error in onClick handler:", err);
          }
        }
      });

      applyContextToRecord(rec, context, onClick);
      updateButtonPosition(rec);
      attachTrackingHooks(rec);

      requestAnimationFrame(() => {
        if (!wrap.isConnected) return;
        wrap.classList.add("is-visible");
      });

      ReactionUI.buttons[tokenId] = rec;
    }

    function removeButton(tokenId) {
      const rec = ReactionUI.buttons[tokenId];
      if (!rec) return;
      if (rec.leaving) return;

      rec.leaving = true;
      rec.removeSeq = (rec.removeSeq ?? 0) + 1;

      const seq = rec.removeSeq;

      detachTrackingHooks(rec);

      const el = rec.wrap;

      if (!el) {
        if (ReactionUI.buttons[tokenId] === rec) {
          delete ReactionUI.buttons[tokenId];
        }

        return;
      }

      el.classList.remove("is-visible");
      el.classList.add("is-leaving");

      let done = false;

      const finish = () => {
        // If this record was revived by updateExistingButton(), do not delete it.
        if (done || !rec.leaving || rec.removeSeq !== seq) return;

        done = true;

        try {
          el.removeEventListener("transitionend", finish);
        } catch (_e) {}

        try {
          el.remove();
        } catch (_e) {}

        rec.finishRemove = null;
        rec.removeTimer = null;

        if (ReactionUI.buttons[tokenId] === rec) {
          delete ReactionUI.buttons[tokenId];
        }
      };

      rec.finishRemove = finish;
      el.addEventListener("transitionend", finish);
      rec.removeTimer = setTimeout(finish, 250);
    }

    function clearAll() {
      for (const tokenId of Object.keys(ReactionUI.buttons)) {
        removeButton(tokenId);
      }
    }

    window[KEY] = {
      spawnButton,
      removeButton,
      clearAll
    };

    console.log("[ReactionButtonUI] Installed. Provides oni.ReactionButtonUI API.");
  })();
});