/**
 * emote-chat-button.js
 * Fabula Ultima Companion - Emote System Chat Button
 * Foundry VTT v12
 *
 * Purpose:
 * - Add an "Emote Configuration" button beside the chat input bar
 * - Open the Emote config window when clicked
 *
 * Refactor note:
 * - This file NO LONGER performs self-layout
 * - Shared positioning is handled only by chat-button-final-layout.js
 *
 * Globals:
 *   globalThis.__ONI_EMOTE_CHAT_BUTTON__
 *
 * API:
 *   FUCompanion.api.EmoteChatButton
 */

(() => {
  const GLOBAL_KEY = "__ONI_EMOTE_CHAT_BUTTON__";
  if (globalThis[GLOBAL_KEY]?.installed) return;

  const MODULE_ID = "fabula-ultima-companion";
  const SYSTEM_ID = "emote";

  const CFG = {
    DEBUG: false,

    BUTTON_ID: "oni-chat-emote-config-btn",
    STYLE_ID: "oni-chat-emote-config-btn-style",

    SIZE_PX: 30,
    BASE_RIGHT_PX: 6,
    BASE_BOTTOM_PX: 6,

    ICON_URL: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Emotes%20Icon/Emote_Happy.png",

    SOUND_URL:
      "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_4.wav",
    VOLUME: 0.8,

    TITLE: "Emote Configuration",
    ARIA_LABEL: "Open Emote Configuration"
  };

  const state = {
    installed: true,
    ready: false
  };

  function getDebug() {
    const dbg = globalThis.__ONI_EMOTE_DEBUG__;
    if (dbg?.installed) return dbg;

    const noop = () => {};
    return {
      log: noop,
      info: noop,
      verbose: noop,
      warn: console.warn.bind(console),
      error: console.error.bind(console),
      group: noop,
      groupCollapsed: noop,
      table: noop,
      divider: noop,
      startTimer: noop,
      endTimer: () => null
    };
  }

  function getEmoteApi() {
    return globalThis.__ONI_EMOTE_API__
      ?? globalThis.FUCompanion?.api?.EmoteSystem
      ?? null;
  }

  function getLayoutManager() {
    return globalThis.__ONI_CHAT_BUTTON_FINAL_LAYOUT__ ?? null;
  }

  const DBG = getDebug();

  function debugLog(...args) {
    if (!CFG.DEBUG) return;
    console.log("[ONI EmoteChatBtn][DBG]", ...args);
  }

  function debugWarn(...args) {
    if (!CFG.DEBUG) return;
    console.warn("[ONI EmoteChatBtn][DBG]", ...args);
  }

  function injectCss() {
    if (document.getElementById(CFG.STYLE_ID)) {
      debugLog("CSS already present.");
      return;
    }

    const style = document.createElement("style");
    style.id = CFG.STYLE_ID;
    style.textContent = `
/* ========== ONI Chat Emote Config Button ========== */
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
  width: 20px;
  height: 20px;
  object-fit: contain;
  display: block;
  pointer-events: none;
}
`;
    document.head.appendChild(style);
    debugLog("Injected CSS.");
  }

  async function playClickSoundLocalOnly() {
    try {
      await AudioHelper.play(
        {
          src: CFG.SOUND_URL,
          volume: CFG.VOLUME,
          loop: false
        },
        false
      );
      debugLog("Played local click sound.");
    } catch (err) {
      DBG.warn("ChatButton", "Click sound failed to play", {
        error: err?.message ?? err
      });
    }
  }

  function getChatForm() {
    return document.querySelector("#chat-form");
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

  async function onClickOpenConfig() {
    const emoteApi = getEmoteApi();

    if (!emoteApi?.openConfig) {
      ui.notifications?.warn?.("Emote configuration is not available yet.");
      DBG.warn("ChatButton", "Emote config open failed because EmoteSystem API is unavailable");
      debugWarn("Click failed because EmoteSystem API was unavailable.");
      return;
    }

    try {
      await emoteApi.openConfig();
      await playClickSoundLocalOnly();

      DBG.verbose("ChatButton", "Opened Emote configuration from chat button", {
        userId: game.user?.id ?? null,
        userName: game.user?.name ?? null
      });

      debugLog("Opened Emote configuration.", {
        userId: game.user?.id ?? null,
        userName: game.user?.name ?? null
      });
    } catch (err) {
      DBG.error("ChatButton", "Failed to open Emote configuration", {
        error: err?.message ?? err
      });
      ui.notifications?.error?.("Failed to open Emote configuration. Check console.");
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
    btn.title = CFG.TITLE;
    btn.setAttribute("aria-label", CFG.ARIA_LABEL);

    const icon = document.createElement("img");
    icon.src = CFG.ICON_URL;
    icon.alt = "";
    icon.setAttribute("aria-hidden", "true");

    btn.appendChild(icon);
    btn.addEventListener("click", onClickOpenConfig);

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

    requestSharedLayout("emoteButtonInstallImmediate", 0);
    requestSharedLayout("emoteButtonInstallWarm50", 50);
    requestSharedLayout("emoteButtonInstallWarm150", 150);

    DBG.verbose("ChatButton", "Emote chat button ready", {
      userId: game.user?.id ?? null,
      userName: game.user?.name ?? null
    });

    debugLog("Button ready (shared-layout mode).", {
      userId: game.user?.id ?? null,
      userName: game.user?.name ?? null
    });

    return true;
  }

  function destroy() {
    try {
      document.getElementById(CFG.BUTTON_ID)?.remove();
    } catch (_) {}

    DBG.verbose("ChatButton", "Emote chat button destroyed");
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
    MODULE_ID,
    SYSTEM_ID,
    CFG,

    installOrReattach,
    requestSharedLayout,
    destroy,
    getSnapshot
  };

  globalThis[GLOBAL_KEY] = api;

  Hooks.once("ready", () => {
    try {
      globalThis.FUCompanion ??= {};
      globalThis.FUCompanion.api ??= {};
      globalThis.FUCompanion.api.EmoteChatButton = api;
    } catch (err) {
      console.warn("[Emote:ChatButton] Failed to attach API to FUCompanion.api", err);
    }

    installOrReattach();
    state.ready = true;

    DBG.verbose("Bootstrap", "emote-chat-button.js ready", {
      moduleId: MODULE_ID,
      systemId: SYSTEM_ID,
      snapshot: getSnapshot()
    });

    debugLog("Ready snapshot.", getSnapshot());
  });

  Hooks.on("renderSidebarTab", () => {
    installOrReattach();
  });

  Hooks.once("shutdown", () => {
    destroy();
  });
})();