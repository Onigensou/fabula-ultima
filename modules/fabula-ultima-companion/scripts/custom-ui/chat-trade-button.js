// ============================================================================
// ONI — Chat Sidebar "Trade" Button (Foundry VTT v12) — Module Script
// ----------------------------------------------------------------------------
// Adds an icon button to the bottom-right of the chat input bar.
// Click => calls window["oni.TradeStartTrade"].startTrade()
//
// Refactor note:
// - This file NO LONGER performs self-layout
// - Shared positioning is handled only by chat-button-final-layout.js
// ============================================================================

(() => {
  const GLOBAL_KEY = "__ONI_CHAT_TRADE_BUTTON__";
  if (globalThis[GLOBAL_KEY]?.installed) return;

  const CFG = {
    DEBUG: false,

    BUTTON_ID: "oni-chat-open-trade-btn",
    STYLE_ID: "oni-chat-open-trade-btn-style",

    IMG_URL:
      "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/Elsword/Lithia/GemblissPassive1.png",

    SIZE_PX: 30,
    BASE_RIGHT_PX: 6,
    BASE_BOTTOM_PX: 6
  };

  const state = {
    installed: true,
    ready: false
  };

  const LOG_TAG = "[ONI ChatTradeBtn]";
  const DBG_TAG = "[ONI ChatTradeBtn][DBG]";

  const log = (...args) => console.log(LOG_TAG, ...args);
  const debugLog = (...args) => {
    if (!CFG.DEBUG) return;
    console.log(DBG_TAG, ...args);
  };
  const debugWarn = (...args) => {
    if (!CFG.DEBUG) return;
    console.warn(DBG_TAG, ...args);
  };

  function getChatForm() {
    return document.querySelector("#chat-form");
  }

  function getLayoutManager() {
    return globalThis.__ONI_CHAT_BUTTON_FINAL_LAYOUT__ ?? null;
  }

  function requestSharedLayout(reason = "manual", delay = 0) {
    const manager = getLayoutManager();

    if (!manager) {
      debugWarn("Shared layout manager not found.", { reason, delay });
      return false;
    }

    if (typeof manager.requestLayout === "function") {
      debugLog("Requesting shared layout via requestLayout().", { reason, delay });
      return manager.requestLayout(reason, delay);
    }

    if (typeof manager.scheduleLayout === "function") {
      debugLog("Requesting shared layout via scheduleLayout().", { reason, delay });
      return manager.scheduleLayout(delay, { reason });
    }

    debugWarn("Shared layout manager found, but no request API was available.", {
      reason,
      delay,
      managerKeys: Object.keys(manager)
    });

    return false;
  }

  function injectCss() {
    if (document.getElementById(CFG.STYLE_ID)) {
      debugLog("CSS already present.");
      return;
    }

    const style = document.createElement("style");
    style.id = CFG.STYLE_ID;
    style.textContent = `
/* ========== ONI Chat Trade Button ========== */
#chat-form { position: relative; }

#${CFG.BUTTON_ID} {
  width: ${CFG.SIZE_PX}px;
  height: ${CFG.SIZE_PX}px;
  min-width: ${CFG.SIZE_PX}px;
  min-height: ${CFG.SIZE_PX}px;

  position: absolute;
  right: ${CFG.BASE_RIGHT_PX}px;
  bottom: ${CFG.BASE_BOTTOM_PX}px;
  z-index: 20;

  display: inline-flex;
  align-items: center;
  justify-content: center;

  padding: 0;
  margin: 0;

  border-radius: 6px;
  border: 1px solid rgba(255,255,255,0.18);
  background: rgba(0,0,0,0.35);
  box-shadow: 0 1px 2px rgba(0,0,0,0.35);
  cursor: pointer;
}

#${CFG.BUTTON_ID}:hover {
  filter: brightness(1.12);
  background: rgba(0,0,0,0.48);
}

#${CFG.BUTTON_ID}:active {
  transform: translateY(1px);
}

#${CFG.BUTTON_ID} img {
  width: 22px;
  height: 22px;
  display: block;
  pointer-events: none;
}
`;
    document.head.appendChild(style);
    debugLog("Injected CSS.");
  }

  async function onClickTrade() {
    const api = window["oni.TradeStartTrade"];

    if (!api?.startTrade) {
      ui.notifications?.error?.(
        "OniTrade: StartTrade API not found. Is the module enabled / scripts loaded?"
      );
      console.error("[ONI ChatTradeBtn] Missing window['oni.TradeStartTrade'].");
      debugWarn("Trade click failed because startTrade API was missing.");
      return;
    }

    const listenerInstalled = !!window.__OniTradeModule__?.installed;
    debugLog("Click: startTrade()", { listenerInstalled });

    try {
      await api.startTrade();
      debugLog("Trade UI opened successfully.");
    } catch (err) {
      console.error("[ONI ChatTradeBtn] startTrade failed:", err);
      ui.notifications?.error?.("OniTrade: startTrade failed. Check console.");
    }
  }

  function ensureButton() {
    const existing = document.getElementById(CFG.BUTTON_ID);
    if (existing) {
      debugLog("Button already exists.");
      return true;
    }

    const chatForm = getChatForm();
    if (!chatForm) {
      debugWarn("ensureButton() failed because #chat-form was not found.");
      return false;
    }

    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = CFG.BUTTON_ID;
    btn.title = "Item Trading";
    btn.setAttribute("aria-label", "Item Trading");

    const img = document.createElement("img");
    img.src = CFG.IMG_URL;
    img.alt = "Trade";

    btn.appendChild(img);
    btn.addEventListener("click", onClickTrade);

    chatForm.appendChild(btn);

    debugLog("Button created and appended.", {
      buttonId: CFG.BUTTON_ID,
      chatFormId: chatForm.id ?? null
    });

    return true;
  }

  function installOrReattach() {
    injectCss();

    const ok = ensureButton();
    if (!ok) {
      debugWarn("installOrReattach() aborted because button could not be ensured.");
      return false;
    }

    requestSharedLayout("tradeButtonInstallImmediate", 0);
    requestSharedLayout("tradeButtonInstallWarm50", 50);
    requestSharedLayout("tradeButtonInstallWarm150", 150);

    log("Button ready (shared-layout mode).");
    return true;
  }

  function destroy() {
    try {
      document.getElementById(CFG.BUTTON_ID)?.remove();
    } catch (_) {}

    debugLog("Button destroyed.");
  }

  function getSnapshot() {
    const btn = document.getElementById(CFG.BUTTON_ID);

    return {
      installed: true,
      ready: state.ready,
      buttonPresent: !!btn,
      buttonId: CFG.BUTTON_ID,
      userId: game.user?.id ?? null,
      userName: game.user?.name ?? null,
      buttonRight: btn?.style?.right ?? null,
      buttonBottom: btn?.style?.bottom ?? null,
      hasLayoutManager: !!getLayoutManager()
    };
  }

  const api = {
    installed: true,
    CFG,

    installOrReattach,
    requestSharedLayout,
    destroy,
    getSnapshot
  };

  globalThis[GLOBAL_KEY] = api;

  Hooks.once("ready", () => {
    log("Module script loaded on ready.");
    installOrReattach();
    state.ready = true;

    debugLog("Ready snapshot.", getSnapshot());
  });

  Hooks.on("renderSidebarTab", () => {
    installOrReattach();
  });

  Hooks.once("shutdown", () => {
    destroy();
  });
})();