/**
 * [ONI] Event System — Runtime UI
 * Foundry VTT v12
 *
 * File:
 * scripts/event-system/event-runtimeUI.js
 *
 * What this does:
 * - Handles only the runtime UI/UX for the Event System "!" icon
 * - Creates the overlay layer
 * - Injects CSS styling
 * - Shows / hides the button with animation
 * - Repositions the button so it follows the party token
 *
 * Important:
 * - This script does NOT decide when events should run.
 * - The actual execution logic stays in event-executeCore.js
 * - Clicking the button calls the callback provided by the core.
 *
 * Exposes API to:
 *   window.oni.EventSystem.RuntimeUI
 *
 * Requires:
 * - event-constants.js
 * - event-debug.js
 */

(() => {
  const INSTALL_TAG = "[ONI][EventSystem][RuntimeUI]";

  // ------------------------------------------------------------
  // Global namespace + guard
  // ------------------------------------------------------------
  window.oni = window.oni || {};
  window.oni.EventSystem = window.oni.EventSystem || {};

  if (window.oni.EventSystem.RuntimeUI?.installed) {
    console.log(INSTALL_TAG, "Already installed; skipping.");
    return;
  }

  const C = window.oni.EventSystem.Constants;
  const D = window.oni.EventSystem.Debug;

  if (!C) {
    console.error(INSTALL_TAG, "Missing Constants. Load event-constants.js first.");
    return;
  }

  const DEBUG_SCOPE = "RuntimeUI";

  const FALLBACK_DEBUG = {
    log: (...args) => console.log(`[ONI][EventSystem][${DEBUG_SCOPE}]`, ...args),
    verboseLog: (...args) => console.log(`[ONI][EventSystem][${DEBUG_SCOPE}]`, ...args),
    warn: (...args) => console.warn(`[ONI][EventSystem][${DEBUG_SCOPE}]`, ...args),
    error: (...args) => console.error(`[ONI][EventSystem][${DEBUG_SCOPE}]`, ...args)
  };

  const DBG = D || FALLBACK_DEBUG;

  // ------------------------------------------------------------
  // Small helpers
  // ------------------------------------------------------------
  function worldToScreen(x, y) {
    const wt = canvas?.app?.stage?.worldTransform || canvas?.stage?.worldTransform;
    if (!wt) return { x, y };
    return {
      x: (x * wt.a) + wt.tx,
      y: (y * wt.d) + wt.ty
    };
  }

  function getAuthoritativeTokenCenterPx(token, overrideXY = null) {
    const doc = token?.document;
    const baseX = overrideXY?.x ?? doc?.x ?? token?.x ?? 0;
    const baseY = overrideXY?.y ?? doc?.y ?? token?.y ?? 0;
    const w = token?.w ?? 0;
    const h = token?.h ?? 0;
    return { x: baseX + (w / 2), y: baseY + (h / 2) };
  }

  // ------------------------------------------------------------
  // CSS
  // ------------------------------------------------------------
  const CSS_ID = C.STYLE_ID_RUNTIME || "oni-event-runtime-style";

  function ensureCSS() {
    if (document.getElementById(CSS_ID)) return;

    const style = document.createElement("style");
    style.id = CSS_ID;
    style.textContent = `
#${C.UI_LAYER_ID || "oni-event-ui-layer"} {
  position: fixed;
  left: 0;
  top: 0;
  width: 100vw;
  height: 100vh;
  pointer-events: none;
  z-index: 90;
}

.${C.INTERACT_BUTTON_CLASS || "oni-event-btn"} {
  position: absolute;
  pointer-events: auto;
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  background: rgba(255,255,255,0.95);
  border: 2px solid rgba(0,0,0,0.75);
  border-radius: 999px;
  box-shadow: 0 6px 10px rgba(0,0,0,0.35);
  cursor: pointer;
  user-select: none;
  transform: translate(-50%, -50%) scale(0.75);
  transform-origin: 50% 100%;
  opacity: 0;
  transition:
    transform 160ms ease-out,
    opacity 160ms ease-out;
}

.${C.INTERACT_BUTTON_CLASS || "oni-event-btn"} .mark {
  font-family: "Cinzel","Signika",var(--font-primary,"Signika"),system-ui,sans-serif;
  font-weight: 900;
  font-size: 20px;
  line-height: 1;
  color: rgba(20,16,10,0.95);
  transform: translateY(-1px);
}

.${C.INTERACT_BUTTON_CLASS || "oni-event-btn"}.is-visible {
  transform: translate(-50%, -50%) scale(1);
  opacity: 1;
}

.${C.INTERACT_BUTTON_CLASS || "oni-event-btn"}.is-hiding {
  transform: translate(-50%, -50%) scale(0.78);
  opacity: 0;
  transition:
    transform 140ms ease-in,
    opacity 140ms ease-in;
}

.${C.INTERACT_BUTTON_CLASS || "oni-event-btn"}:hover {
  transform: translate(-50%, -50%) scale(1.06);
}

.${C.INTERACT_BUTTON_CLASS || "oni-event-btn"}:active {
  transform: translate(-50%, -50%) scale(0.98);
}
    `;
    document.head.appendChild(style);
  }

  // ------------------------------------------------------------
  // Runtime UI class
  // ------------------------------------------------------------
  class RuntimeUI {
    constructor({
      constants = C,
      debug = DBG,
      getOverride = null,
      onInteract = null
    } = {}) {
      this.C = constants || C;
      this.DBG = debug || DBG;
      this.getOverride = typeof getOverride === "function" ? getOverride : (() => null);
      this.onInteract = typeof onInteract === "function" ? onInteract : (async () => {});

      this.layer = null;
      this.button = null;

      this.currentTileId = null;
      this.currentTokenId = null;

      this.desiredVisible = false;
      this.state = "hidden";
      this.hideTimer = null;
      this.opening = false;

      this._tickerFn = null;
    }

    start() {
      if (this.layer) return;

      ensureCSS();

      this.layer = document.createElement("div");
      this.layer.id = this.C.UI_LAYER_ID || "oni-event-ui-layer";
      document.body.appendChild(this.layer);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = this.C.INTERACT_BUTTON_CLASS || "oni-event-btn";
      btn.title = "Interact";
      btn.innerHTML = `<div class="mark">${this.C.INTERACT_BUTTON_TEXT || "!"}</div>`;

      btn.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();

        const tileId = this.currentTileId;
        if (!tileId) return;
        if (this.opening) return;

        this.opening = true;
        btn.disabled = true;

        try {
          await this.onInteract(tileId);
        } finally {
          setTimeout(() => {
            this.opening = false;
            if (this.button) this.button.disabled = false;
          }, 350);
        }
      });

      this.layer.appendChild(btn);
      this.button = btn;

      this._tickerFn = () => {
        if (!this.desiredVisible) return;
        if (!this.currentTokenId) return;

        const token = canvas?.tokens?.get?.(this.currentTokenId) || null;
        if (!token) return;

        const override = this.getOverride(this.currentTokenId);
        this.placeForToken(token, override ? { x: override.x, y: override.y } : null);
      };

      try {
        canvas.app.ticker.add(this._tickerFn, undefined, PIXI.UPDATE_PRIORITY.LOW);
      } catch (_) {}

      this.DBG.verboseLog(DEBUG_SCOPE, "Runtime UI started.");
    }

    stop() {
      if (this.hideTimer) {
        clearTimeout(this.hideTimer);
        this.hideTimer = null;
      }

      try {
        if (this._tickerFn) canvas.app.ticker.remove(this._tickerFn);
      } catch (_) {}

      this.button?.remove();
      this.layer?.remove();

      this.button = null;
      this.layer = null;
      this.currentTileId = null;
      this.currentTokenId = null;
      this.desiredVisible = false;
      this.state = "hidden";
      this.opening = false;
      this._tickerFn = null;

      this.DBG.verboseLog(DEBUG_SCOPE, "Runtime UI stopped.");
    }

    showForCandidate(candidate, partyToken, overrideXY = null) {
      if (!this.button || !partyToken) return;

      this.currentTileId = candidate?.tileId ?? null;
      this.currentTokenId = partyToken.id;
      this.desiredVisible = true;
      this.button.title = candidate?.tileName ? `Interact: ${candidate.tileName}` : "Interact";

      this.placeForToken(partyToken, overrideXY);
      this._show();
    }

    hide() {
      this.desiredVisible = false;
      this.currentTileId = null;
      this._hide();
    }

    _show() {
      if (!this.button) return;
      if (this.state === "shown" || this.state === "showing") return;

      if (this.state === "hiding") {
        if (this.hideTimer) clearTimeout(this.hideTimer);
        this.hideTimer = null;
      }

      this.state = "showing";
      this.button.classList.remove("is-hiding");

      requestAnimationFrame(() => {
        if (!this.button) return;
        this.button.classList.add("is-visible");
        this.state = "shown";
      });
    }

    _hide() {
      if (!this.button) return;
      if (this.state === "hidden" || this.state === "hiding") return;

      this.state = "hiding";
      this.button.classList.remove("is-visible");
      this.button.classList.add("is-hiding");

      this.hideTimer = setTimeout(() => {
        if (this.desiredVisible) {
          this.button?.classList.remove("is-hiding");
          this.button?.classList.add("is-visible");
          this.state = "shown";
          this.hideTimer = null;
          return;
        }

        this.button?.classList.remove("is-hiding");
        this.state = "hidden";
        this.hideTimer = null;
      }, 160);
    }

    placeForToken(token, overrideXY = null) {
      if (!this.button || !token) return;

      const center = getAuthoritativeTokenCenterPx(token, overrideXY);
      const screen = worldToScreen(center.x, center.y);

      // Keep the exact same raised positioning logic from the working version
      const verticalOffset = Math.max(54, Math.round((token.h / 2) + 63));
      const finalX = screen.x;
      const finalY = screen.y - verticalOffset;

      this.button.style.left = `${finalX}px`;
      this.button.style.top = `${finalY}px`;
    }
  }

  RuntimeUI.installed = true;

  // ------------------------------------------------------------
  // Publish API
  // ------------------------------------------------------------
  window.oni.EventSystem.RuntimeUI = RuntimeUI;

  console.log(INSTALL_TAG, "Installed. API: window.oni.EventSystem.RuntimeUI");
})();
