// ============================================================================
// ActiveEffectManager-button.js
// Foundry VTT V12 — Fabula Ultima Companion
//
// Purpose:
// - Installs a floating "Active Effect Manager" button (💫) on the client UI.
// - GM only.
// - Follows the same fixed-button style/format as Combat Button and Check Roller.
// - No fuzzy EXP detection.
// - No side rail.
// - Click -> opens FUCompanion.api.activeEffectManager.ui.open()
// ============================================================================

Hooks.once("ready", () => {
  (() => {
    const TAG = "[ONI][ActiveEffectManager:Button]";
    const STATE_KEY = "__ONI_ACTIVE_EFFECT_MANAGER_BUTTON_STATE__";

    // -------------------------------------------------------------------------
    // CONFIG
    // -------------------------------------------------------------------------
    const CFG = {
      moduleId: "fabula-ultima-companion",

      // GM-only button
      gmOnly: true,

      // Placement
      // Check Roller: bottom 38
      // Combat:       bottom 110
      // EXP Awarder:  expected above Combat
      // AEM:          above EXP Awarder
      offsetRightPx: 313,
      offsetBottomPx: 254,

      // Visual
      sizePx: 60,
      zIndex: 82,
      iconText: "💫",

      // Tooltip
      label: "Active Effect Manager",

      // Optional click sound
      clickSound: null,

      // No spam logs
      debug: false,
    };

    // -------------------------------------------------------------------------
    // DOM ids/classes
    // -------------------------------------------------------------------------
    const DOM = {
      ROOT_ID: "oni-aem-button-root",
      BTN_ID: "oni-aem-button",
      STYLE_ID: "oni-aem-button-style",

      // Old versions used these; remove them so they don't overlap anything.
      LEGACY_RAIL_ID: "oni-active-effect-manager-side-rail",
      LEGACY_BTN_ID: "oni-active-effect-manager-chat-button",
      LEGACY_STYLE_ID: "oni-active-effect-manager-button-style",
    };

    // -------------------------------------------------------------------------
    // Shared state
    // -------------------------------------------------------------------------
    const STATE = (globalThis[STATE_KEY] ??= {
      installed: false,
    });

    const debug = (...args) => {
      if (CFG.debug) console.log(TAG, ...args);
    };

    const cleanupUI = () => {
      try { document.getElementById(DOM.ROOT_ID)?.remove(); } catch (_) {}
      try { document.getElementById(DOM.STYLE_ID)?.remove(); } catch (_) {}

      // Clean old rail/button version.
      try { document.getElementById(DOM.LEGACY_RAIL_ID)?.remove(); } catch (_) {}
      try { document.getElementById(DOM.LEGACY_BTN_ID)?.remove(); } catch (_) {}
      try { document.getElementById(DOM.LEGACY_STYLE_ID)?.remove(); } catch (_) {}
    };

    // -------------------------------------------------------------------------
    // GM-only guard
    // -------------------------------------------------------------------------
    if (CFG.gmOnly && !game.user?.isGM) {
      cleanupUI();
      STATE.installed = false;
      return;
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------
    const getManagerRoot = () => {
      return globalThis.FUCompanion?.api?.activeEffectManager ?? null;
    };

    const openManagerUi = async () => {
      const root = getManagerRoot();

      const open =
        root?.ui?.open ??
        root?.openUI ??
        null;

      if (typeof open !== "function") {
        ui?.notifications?.warn?.("Active Effect Manager UI is not loaded yet.");
        console.warn(`${TAG} UI API missing. Expected FUCompanion.api.activeEffectManager.ui.open()`);
        return;
      }

      return open();
    };

    const ensureNamespace = () => {
      globalThis.FUCompanion = globalThis.FUCompanion || {};
      globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
      globalThis.FUCompanion.api.activeEffectManager =
        globalThis.FUCompanion.api.activeEffectManager || {};

      return globalThis.FUCompanion.api.activeEffectManager;
    };

    // -------------------------------------------------------------------------
    // Install CSS
    // -------------------------------------------------------------------------
    const ensureStyle = () => {
      let style = document.getElementById(DOM.STYLE_ID);
      if (style) return style;

      style = document.createElement("style");
      style.id = DOM.STYLE_ID;
      style.textContent = `
        /* [ActiveEffectManager] Floating Button */
        #${DOM.ROOT_ID} {
          position: fixed;
          right: ${CFG.offsetRightPx}px;
          bottom: ${CFG.offsetBottomPx}px;
          z-index: ${CFG.zIndex};
          pointer-events: none;
        }

        #${DOM.BTN_ID} {
          pointer-events: auto;
          width: ${CFG.sizePx}px;
          height: ${CFG.sizePx}px;
          border-radius: 999px;
          border: 1px solid rgba(255,255,255,0.22);
          background: rgba(18, 18, 22, 0.86);
          box-shadow:
            0 10px 24px rgba(0,0,0,0.35),
            0 2px 0 rgba(255,255,255,0.06) inset;
          display: grid;
          place-items: center;
          cursor: pointer;
          user-select: none;
          -webkit-user-select: none;
          transform: translateZ(0);
          transition: transform 120ms ease, background 120ms ease, border-color 120ms ease, opacity 120ms ease;
          position: relative;
        }

        #${DOM.BTN_ID}:hover {
          transform: translateY(-1px) scale(1.02);
          background: rgba(28, 28, 34, 0.92);
          border-color: rgba(255,255,255,0.32);
        }

        #${DOM.BTN_ID}:active {
          transform: translateY(0px) scale(0.99);
        }

        #${DOM.BTN_ID} .oni-aem-button-icon {
          font-size: 22px;
          line-height: 1;
          filter: drop-shadow(0 2px 2px rgba(0,0,0,0.45));
        }

        #${DOM.BTN_ID} .oni-aem-button-tip {
          position: absolute;
          right: 0;
          bottom: calc(100% + 10px);
          background: rgba(10,10,12,0.92);
          border: 1px solid rgba(255,255,255,0.18);
          border-radius: 10px;
          padding: 8px 10px;
          font-size: 12px;
          color: rgba(255,255,255,0.9);
          white-space: nowrap;
          opacity: 0;
          transform: translateY(4px);
          transition: opacity 120ms ease, transform 120ms ease;
          pointer-events: none;
          box-shadow: 0 10px 24px rgba(0,0,0,0.35);
        }

        #${DOM.BTN_ID}:hover .oni-aem-button-tip {
          opacity: 1;
          transform: translateY(0);
        }
      `;

      document.head.appendChild(style);
      return style;
    };

    // -------------------------------------------------------------------------
    // Install DOM
    // -------------------------------------------------------------------------
    const ensureRoot = () => {
      let root = document.getElementById(DOM.ROOT_ID);

      if (!root) {
        root = document.createElement("div");
        root.id = DOM.ROOT_ID;
        document.body.appendChild(root);
      }

      return root;
    };

    const buildButton = () => {
      const root = ensureRoot();
      root.innerHTML = "";

      const btn = document.createElement("div");
      btn.id = DOM.BTN_ID;
      btn.setAttribute("role", "button");
      btn.setAttribute("tabindex", "0");
      btn.setAttribute("aria-label", CFG.label);

      btn.innerHTML = `
        <div class="oni-aem-button-tip">${CFG.label}</div>
        <div class="oni-aem-button-icon">${CFG.iconText}</div>
      `;

      const onClick = async (ev) => {
        ev?.preventDefault?.();
        ev?.stopPropagation?.();

        if (CFG.clickSound) {
          try {
            AudioHelper.play({
              src: CFG.clickSound,
              volume: 0.6,
              autoplay: true,
              loop: false
            }, true);
          } catch (_) {}
        }

        try {
          await openManagerUi();
        } catch (e) {
          console.error(`${TAG} Button click error:`, e);
          ui?.notifications?.error?.("Active Effect Manager: An error occurred. Check console.");
        }
      };

      const onKeyDown = (ev) => {
        if (ev.key === "Enter" || ev.key === " ") onClick(ev);
      };

      btn.addEventListener("click", onClick);
      btn.addEventListener("keydown", onKeyDown);

      root.appendChild(btn);
      return btn;
    };

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------
    const installButton = () => {
      cleanupUI();
      ensureStyle();
      buildButton();
      STATE.installed = true;

      debug("Installed", {
        user: game.user?.name,
        right: CFG.offsetRightPx,
        bottom: CFG.offsetBottomPx
      });

      return true;
    };

    const removeButton = () => {
      cleanupUI();
      STATE.installed = false;
      return true;
    };

    const api = {
      version: "0.4.0",
      installButton,
      removeButton,
      open: openManagerUi,
      config: CFG,
      dom: DOM
    };

    const ns = ensureNamespace();
    ns.button = api;
    ns.installButton = installButton;

    try {
      const mod = game.modules?.get?.(CFG.moduleId);
      if (mod) {
        mod.api = mod.api || {};
        mod.api.activeEffectManager = mod.api.activeEffectManager || {};
        mod.api.activeEffectManager.button = api;
        mod.api.activeEffectManager.installButton = installButton;
      }
    } catch (e) {
      console.warn(`${TAG} Could not expose API on module object.`, e);
    }

    // -------------------------------------------------------------------------
    // Boot
    // -------------------------------------------------------------------------
    installButton();
  })();
});