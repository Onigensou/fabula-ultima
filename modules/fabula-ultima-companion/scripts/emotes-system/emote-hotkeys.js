/**
 * emote-hotkeys.js
 * Fabula Ultima Companion - Emote System Hotkey Installer
 * Foundry VTT v12
 *
 * Purpose:
 * - Install Alt + 1~0 emote hotkeys on each client
 * - Ignore hotkeys while typing in inputs / textareas / editors
 * - Forward valid hotkey presses into the Emote System API
 *
 * Notes:
 * - This is CLIENT-SIDE behavior only
 * - It does not decide final authority rules itself
 * - Final permission / target resolution is handled by Emote API + Resolver
 *
 * Globals:
 *   globalThis.__ONI_EMOTE_HOTKEYS__
 *
 * API:
 *   FUCompanion.api.EmoteHotkeys
 */

(() => {
  const GLOBAL_KEY = "__ONI_EMOTE_HOTKEYS__";
  if (globalThis[GLOBAL_KEY]?.installed) return;

  const MODULE_ID = "fabula-ultima-companion";
  const SYSTEM_ID = "emote";

  const state = {
    installed: true,
    ready: false,
    listenerInstalled: false,
    keydownHandler: null,
    lastHandledAt: 0,
    lastHandledSlot: null
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

  function getData() {
    return globalThis.__ONI_EMOTE_DATA__
      ?? globalThis.FUCompanion?.api?.EmoteData
      ?? null;
  }

  function getEmoteApi() {
    return globalThis.__ONI_EMOTE_API__
      ?? globalThis.FUCompanion?.api?.EmoteSystem
      ?? null;
  }

  const DBG = getDebug();

  function cleanString(value) {
    return value == null ? "" : String(value).trim();
  }

  function hasText(value) {
    return cleanString(value).length > 0;
  }

  function nowMs() {
    return Date.now();
  }

  function normalizeSlotFromKeyboardEvent(event) {
    const data = getData();
    if (!data?.normalizeSlotKey) return null;

    const code = cleanString(event?.code);
    const key = cleanString(event?.key);

    // Prefer KeyboardEvent.code because it is layout-stable for digit row / numpad
    if (hasText(code)) {
      const fromCode = data.normalizeSlotKey(code);
      if (fromCode) return fromCode;
    }

    if (hasText(key)) {
      const fromKey = data.normalizeSlotKey(key);
      if (fromKey) return fromKey;
    }

    return null;
  }

  function isEditableElement(el) {
    if (!(el instanceof HTMLElement)) return false;

    if (el.isContentEditable) return true;

    const tag = cleanString(el.tagName).toUpperCase();
    if (["INPUT", "TEXTAREA", "SELECT", "OPTION", "BUTTON"].includes(tag)) return true;

    const role = cleanString(el.getAttribute?.("role"));
    if (role === "textbox" || role === "combobox") return true;

    return false;
  }

  function isTypingContext(event) {
    const path = typeof event?.composedPath === "function"
      ? event.composedPath()
      : [];

    for (const node of path) {
      if (node instanceof HTMLElement && isEditableElement(node)) {
        return true;
      }
    }

    const active = document.activeElement;
    if (active instanceof HTMLElement && isEditableElement(active)) {
      return true;
    }

    return false;
  }

  function shouldIgnoreHotkeyEvent(event) {
    if (!event) return true;

    // Need Alt, but do not allow Ctrl / Meta / Shift combos
    if (!event.altKey) return true;
    if (event.ctrlKey || event.metaKey || event.shiftKey) return true;

    if (event.repeat) return true;
    if (isTypingContext(event)) return true;

    const slot = normalizeSlotFromKeyboardEvent(event);
    if (!slot) return true;

    return false;
  }

  function buildHotkeyDebugRow(event, slot) {
    return {
      code: cleanString(event?.code),
      key: cleanString(event?.key),
      altKey: !!event?.altKey,
      ctrlKey: !!event?.ctrlKey,
      shiftKey: !!event?.shiftKey,
      metaKey: !!event?.metaKey,
      repeat: !!event?.repeat,
      slot: slot ?? null,
      userId: game.user?.id ?? null,
      userName: game.user?.name ?? null
    };
  }

  async function handleHotkeyPress(event) {
    const emoteApi = getEmoteApi();
    const data = getData();

    if (!emoteApi?.playHotkeySlot) {
      DBG.warn("Hotkeys", "Hotkey press ignored because EmoteSystem API is unavailable");
      return;
    }

    const slot = normalizeSlotFromKeyboardEvent(event);
    if (!slot) return;

    // Tiny dedupe guard for odd double-fire edge cases
    const stamp = nowMs();
    if (state.lastHandledSlot === slot && (stamp - state.lastHandledAt) < 60) {
      DBG.verbose("Hotkeys", "Skipped duplicate hotkey press", buildHotkeyDebugRow(event, slot));
      return;
    }

    state.lastHandledAt = stamp;
    state.lastHandledSlot = slot;

    event.preventDefault();
    event.stopPropagation();

    DBG.groupCollapsed("Hotkeys", "Detected emote hotkey press", buildHotkeyDebugRow(event, slot));

    try {
      const result = await emoteApi.playHotkeySlot(slot, {
        requestSource: "hotkey",
        meta: {
          keyboardCode: cleanString(event?.code),
          keyboardKey: cleanString(event?.key),
          fromHotkeyInstaller: true,
          slotLabel: data?.getSlotDisplayLabel?.(slot) ?? `Alt + ${slot}`
        }
      });

      DBG.groupCollapsed("Hotkeys", "Hotkey emote play result", {
        slot,
        ok: !!result?.ok,
        reason: result?.reason ?? null,
        transport: result?.transport ?? null,
        tokenId: result?.instruction?.tokenId ?? null,
        tokenName: result?.instruction?.tokenName ?? null,
        actorId: result?.instruction?.actorId ?? null,
        actorName: result?.instruction?.actorName ?? null,
        emoteUrl: result?.instruction?.emoteUrl ?? null
      });
    } catch (err) {
      DBG.error("Hotkeys", "Hotkey emote play threw an error", {
        slot,
        error: err?.message ?? err
      });
    }
  }

  function onKeyDown(event) {
    try {
      if (shouldIgnoreHotkeyEvent(event)) return;
      handleHotkeyPress(event);
    } catch (err) {
      DBG.error("Hotkeys", "Hotkey listener error", {
        error: err?.message ?? err
      });
    }
  }

  function installListener() {
    if (state.listenerInstalled) return true;

    state.keydownHandler = onKeyDown;
    document.addEventListener("keydown", state.keydownHandler, true);
    state.listenerInstalled = true;

    DBG.info("Hotkeys", "Installed Emote hotkey listener", {
      userId: game.user?.id ?? null,
      userName: game.user?.name ?? null
    });

    return true;
  }

  function uninstallListener() {
    if (!state.listenerInstalled || !state.keydownHandler) return false;

    document.removeEventListener("keydown", state.keydownHandler, true);
    state.keydownHandler = null;
    state.listenerInstalled = false;

    DBG.info("Hotkeys", "Removed Emote hotkey listener", {
      userId: game.user?.id ?? null,
      userName: game.user?.name ?? null
    });

    return true;
  }

  function isInstalled() {
    return !!state.listenerInstalled;
  }

  function getSnapshot() {
    return {
      installed: true,
      ready: state.ready,
      listenerInstalled: state.listenerInstalled,
      userId: game.user?.id ?? null,
      userName: game.user?.name ?? null,
      activeElementTag: document.activeElement?.tagName ?? null,
      lastHandledAt: state.lastHandledAt || null,
      lastHandledSlot: state.lastHandledSlot || null
    };
  }

  const api = {
    installed: true,
    MODULE_ID,
    SYSTEM_ID,

    normalizeSlotFromKeyboardEvent,
    isTypingContext,
    shouldIgnoreHotkeyEvent,

    installListener,
    uninstallListener,
    isInstalled,
    getSnapshot
  };

  globalThis[GLOBAL_KEY] = api;

  Hooks.once("ready", () => {
    try {
      globalThis.FUCompanion ??= {};
      globalThis.FUCompanion.api ??= {};
      globalThis.FUCompanion.api.EmoteHotkeys = api;
    } catch (err) {
      console.warn("[Emote:Hotkeys] Failed to attach API to FUCompanion.api", err);
    }

    installListener();
    state.ready = true;

    DBG.verbose("Bootstrap", "emote-hotkeys.js ready", {
      moduleId: MODULE_ID,
      systemId: SYSTEM_ID,
      snapshot: getSnapshot()
    });
  });
})();