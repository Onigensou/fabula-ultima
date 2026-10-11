/**
 * [ONI] Event System — Runtime UI
 * Foundry VTT v12
 *
 * File:
 * scripts/event-system/event-runtimeUI.js
 *
 * What this does:
 * - Handles only the runtime UI/UX for the Event System buttons:
 *   "!" over the party token (examine point) and a talk button over an NPC
 * - Creates the overlay layer
 * - Injects CSS styling
 * - Shows / hides the button with animation
 * - Repositions each button so it follows its token, docking beside any
 *   other overhead icon (shop, blacksmith) already sitting on that token
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
    console.debug(INSTALL_TAG, "Already installed; skipping.");
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

.${C.INTERACT_BUTTON_CLASS || "oni-event-btn"}.is-talk .mark {
  font-size: 17px;
  transform: none;
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
  // Dock
  // ------------------------------------------------------------
  // Other systems park their own overhead icon on a token (shop, blacksmith).
  // An event button on the same token joins that row instead of covering it:
  // same height, next free slot to the left.
  const DOCK_NEIGHBOUR_SELECTOR = ".fu-shop-btn, .fu-refine-prox-btn";
  const DOCK_STEP_PX = 44;

  function findDockNeighbours(tokenId) {
    const out = [];
    const id = String(tokenId || "");
    if (!id) return out;

    for (const el of document.querySelectorAll(DOCK_NEIGHBOUR_SELECTOR)) {
      if (el.dataset?.tokenId !== id) continue;
      if (el.classList.contains("is-hiding")) continue;

      const x = parseFloat(el.style.left);
      const y = parseFloat(el.style.top);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

      out.push({ x, y });
    }

    return out;
  }

  function resolveDockPosition(tokenId, nativeX, nativeY) {
    const neighbours = findDockNeighbours(tokenId);
    if (!neighbours.length) return { x: nativeX, y: nativeY };

    let leftmost = neighbours[0];
    for (const n of neighbours) {
      if (n.x < leftmost.x) leftmost = n;
    }

    return { x: leftmost.x - DOCK_STEP_PX, y: leftmost.y };
  }

  // ------------------------------------------------------------
  // One overhead button (examine "!" or NPC talk)
  // ------------------------------------------------------------
  class OverheadButton {
    constructor(ui, { kind, mark, title }) {
      this.ui = ui;
      this.kind = kind;
      this.defaultTitle = title;

      this.tileId = null;
      this.tokenId = null;

      this.desiredVisible = false;
      this.state = "hidden";
      this.hideTimer = null;
      this.opening = false;

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = ui.C.INTERACT_BUTTON_CLASS || "oni-event-btn";
      if (kind === "talk") btn.classList.add("is-talk");
      btn.title = title;
      btn.innerHTML = `<div class="mark">${mark}</div>`;

      btn.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();

        const tileId = this.tileId;
        if (!tileId) return;
        if (this.opening) return;

        this.opening = true;
        btn.disabled = true;

        try {
          await ui.onInteract(tileId);
        } finally {
          setTimeout(() => {
            this.opening = false;
            if (this.el) this.el.disabled = false;
          }, 350);
        }
      });

      ui.layer.appendChild(btn);
      this.el = btn;
    }

    destroy() {
      if (this.hideTimer) {
        clearTimeout(this.hideTimer);
        this.hideTimer = null;
      }
      this.el?.remove();
      this.el = null;
    }

    showFor(candidate, token, overrideXY = null) {
      if (!this.el || !token) return;

      this.tileId = candidate?.tileId ?? null;
      this.tokenId = token.id;
      this.desiredVisible = true;
      this.el.title = candidate?.tileName ? `${this.defaultTitle}: ${candidate.tileName}` : this.defaultTitle;

      this.place(token, overrideXY);
      this._show();
    }

    hide() {
      this.desiredVisible = false;
      this.tileId = null;
      this._hide();
    }

    tick() {
      if (!this.desiredVisible) return;
      if (!this.tokenId) return;

      const token = canvas?.tokens?.get?.(this.tokenId) || null;
      if (!token) return;

      const override = this.ui.getOverride(this.tokenId);
      this.place(token, override ? { x: override.x, y: override.y } : null);
    }

    place(token, overrideXY = null) {
      if (!this.el || !token) return;

      const center = getAuthoritativeTokenCenterPx(token, overrideXY);
      const screen = worldToScreen(center.x, center.y);

      // Keep the exact same raised positioning logic from the working version
      const verticalOffset = Math.max(54, Math.round((token.h / 2) + 63));
      const docked = resolveDockPosition(token.id, screen.x, screen.y - verticalOffset);

      this.el.style.left = `${docked.x}px`;
      this.el.style.top = `${docked.y}px`;
    }

    _show() {
      if (!this.el) return;
      if (this.state === "shown" || this.state === "showing") return;

      if (this.state === "hiding") {
        if (this.hideTimer) clearTimeout(this.hideTimer);
        this.hideTimer = null;
      }

      this.state = "showing";
      this.el.classList.remove("is-hiding");

      requestAnimationFrame(() => {
        if (!this.el) return;
        this.el.classList.add("is-visible");
        this.state = "shown";
      });
    }

    _hide() {
      if (!this.el) return;
      if (this.state === "hidden" || this.state === "hiding") return;

      this.state = "hiding";
      this.el.classList.remove("is-visible");
      this.el.classList.add("is-hiding");

      this.hideTimer = setTimeout(() => {
        if (this.desiredVisible) {
          this.el?.classList.remove("is-hiding");
          this.el?.classList.add("is-visible");
          this.state = "shown";
          this.hideTimer = null;
          return;
        }

        this.el?.classList.remove("is-hiding");
        this.state = "hidden";
        this.hideTimer = null;
      }, 160);
    }
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

      // examine = "!" over the party token; talk = over the NPC that speaks
      this.examine = null;
      this.talk = null;

      this._tickerFn = null;
    }

    start() {
      if (this.layer) return;

      ensureCSS();

      this.layer = document.createElement("div");
      this.layer.id = this.C.UI_LAYER_ID || "oni-event-ui-layer";
      document.body.appendChild(this.layer);

      this.examine = new OverheadButton(this, {
        kind: "examine",
        mark: this.C.INTERACT_BUTTON_TEXT || "!",
        title: "Interact"
      });
      this.talk = new OverheadButton(this, {
        kind: "talk",
        mark: this.C.TALK_BUTTON_TEXT || "💬",
        title: "Talk"
      });

      this._tickerFn = () => {
        this.examine?.tick();
        this.talk?.tick();
      };

      try {
        canvas.app.ticker.add(this._tickerFn, undefined, PIXI.UPDATE_PRIORITY.LOW);
      } catch (_) {}

      this.DBG.verboseLog(DEBUG_SCOPE, "Runtime UI started.");
    }

    stop() {
      try {
        if (this._tickerFn) canvas.app.ticker.remove(this._tickerFn);
      } catch (_) {}

      this.examine?.destroy();
      this.talk?.destroy();
      this.layer?.remove();

      this.examine = null;
      this.talk = null;
      this.layer = null;
      this._tickerFn = null;

      this.DBG.verboseLog(DEBUG_SCOPE, "Runtime UI stopped.");
    }

    // Examine point: the "!" rides on the party token.
    showForCandidate(candidate, partyToken, overrideXY = null) {
      this.examine?.showFor(candidate, partyToken, overrideXY);
    }

    hide() {
      this.examine?.hide();
    }

    // NPC talk: the button sits over the NPC that carries the event.
    showTalkForCandidate(candidate, npcToken) {
      this.talk?.showFor(candidate, npcToken, null);
    }

    hideTalk() {
      this.talk?.hide();
    }

    hideAll() {
      this.examine?.hide();
      this.talk?.hide();
    }

    placeForToken(token, overrideXY = null) {
      if (!token) return;
      if (this.examine?.desiredVisible && this.examine.tokenId === token.id) {
        this.examine.place(token, overrideXY);
      }
      this.talk?.tick();
    }
  }

  RuntimeUI.installed = true;

  // ------------------------------------------------------------
  // Publish API
  // ------------------------------------------------------------
  window.oni.EventSystem.RuntimeUI = RuntimeUI;

  console.debug(INSTALL_TAG, "Installed. API: window.oni.EventSystem.RuntimeUI");
})();
