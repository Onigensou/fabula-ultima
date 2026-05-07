/**
 * emote-store.js
 * Fabula Ultima Companion - Emote System Store
 * Foundry VTT v12
 *
 * Purpose:
 * - Persist each client's Emote hotkey configuration
 * - Keep all Emote config read/write helpers in one place
 * - Provide normalized access for future API / UI / hotkey scripts
 *
 * Storage:
 *   game.settings (client scope)
 *   key: emoteHotkeyConfig
 *
 * Notes:
 * - This store is CLIENT-SCOPED on purpose.
 * - Each client gets their own hotkey layout.
 * - Data persists across Foundry restarts until changed/replaced.
 *
 * Globals:
 *   globalThis.__ONI_EMOTE_STORE__
 *
 * API:
 *   FUCompanion.api.EmoteStore
 */

(() => {
  const GLOBAL_KEY = "__ONI_EMOTE_STORE__";
  if (globalThis[GLOBAL_KEY]?.installed) return;

  const MODULE_ID = "fabula-ultima-companion";
  const SYSTEM_ID = "emote";

  const SETTINGS = {
    HOTKEY_CONFIG: "emoteHotkeyConfig"
  };

  const STATE_VERSION = 1;

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

  function getEmoteData() {
    return globalThis.__ONI_EMOTE_DATA__
      ?? globalThis.FUCompanion?.api?.EmoteData
      ?? null;
  }

  const DBG = getDebug();

  function cleanString(value) {
    return value == null ? "" : String(value).trim();
  }

  function toNullableString(value) {
    const s = cleanString(value);
    return s.length ? s : null;
  }

  function deepClone(value) {
    try {
      return foundry.utils.deepClone(value);
    } catch {
      try {
        return JSON.parse(JSON.stringify(value));
      } catch {
        return value;
      }
    }
  }

  function mergeObjectSafe(original, update) {
    try {
      return foundry.utils.mergeObject(original, update, {
        inplace: false,
        insertKeys: true,
        insertValues: true,
        overwrite: true,
        recursive: true
      });
    } catch {
      return { ...(original ?? {}), ...(update ?? {}) };
    }
  }

  function getDefaultState() {
    const EmoteData = getEmoteData();
    const hotkeyMap = EmoteData?.getDefaultHotkeyMap
      ? EmoteData.getDefaultHotkeyMap()
      : {
          "1": "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Emotes%20Icon/RO/Exc.webm",
          "2": "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Emotes%20Icon/RO/Que.webm",
          "3": "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Emotes%20Icon/RO/Ang.webm",
          "4": "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Emotes%20Icon/RO/Love.webm",
          "5": "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Emotes%20Icon/RO/No1.webm",
          "6": "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Emotes%20Icon/RO/Heh.webm",
          "7": "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Emotes%20Icon/RO/Ggg.webm",
          "8": "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Emotes%20Icon/RO/gif.webm",
          "9": "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Emotes%20Icon/RO/Ok.webm",
          "0": "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Emotes%20Icon/RO/Omg.webm"
        };

    return {
      version: STATE_VERSION,
      hotkeyMap,
      updatedAt: null,
      updatedByUserId: null,
      updatedByUserName: null,
      updateReason: null
    };
  }

  function normalizeState(rawState) {
    const EmoteData = getEmoteData();
    const base = getDefaultState();
    const merged = mergeObjectSafe(base, rawState ?? {});

    return {
      version: Number(merged.version) || STATE_VERSION,
      hotkeyMap: EmoteData?.normalizeHotkeyMap
        ? EmoteData.normalizeHotkeyMap(merged.hotkeyMap)
        : deepClone(base.hotkeyMap),
      updatedAt: Number.isFinite(Number(merged.updatedAt)) ? Number(merged.updatedAt) : null,
      updatedByUserId: toNullableString(merged.updatedByUserId),
      updatedByUserName: toNullableString(merged.updatedByUserName),
      updateReason: toNullableString(merged.updateReason)
    };
  }

  function canUseSettings() {
    return !!game?.settings;
  }

  function getSettingKey() {
    return SETTINGS.HOTKEY_CONFIG;
  }

  function getRegisteredSettingConfig() {
    return {
      name: "Emote System Hotkey Configuration",
      hint: "Client-local saved Emote hotkey slot mapping.",
      scope: "client",
      config: false,
      type: Object,
      default: getDefaultState()
    };
  }

  async function getRawState() {
    if (!canUseSettings()) {
      DBG.warn("Store", "getRawState failed because game.settings is unavailable");
      return null;
    }

    try {
      return game.settings.get(MODULE_ID, getSettingKey()) ?? null;
    } catch (err) {
      DBG.warn("Store", "Failed to read Emote hotkey config setting", {
        settingKey: getSettingKey(),
        error: err?.message ?? err
      });
      return null;
    }
  }

  async function getState() {
    const raw = await getRawState();
    const normalized = normalizeState(raw);

    DBG.groupCollapsed("Store", "Loaded Emote store state", {
      userId: game.user?.id ?? null,
      userName: game.user?.name ?? null,
      state: normalized
    });

    return normalized;
  }

  async function writeState(patch = {}, { merge = true, reason = null } = {}) {
    if (!canUseSettings()) {
      DBG.warn("Store", "writeState failed because game.settings is unavailable", { patch });
      return { ok: false, reason: "settingsUnavailable", state: null };
    }

    const existing = await getState();
    const base = merge ? existing : getDefaultState();

    const next = normalizeState(
      mergeObjectSafe(base, {
        ...(patch ?? {}),
        updatedAt: Date.now(),
        updatedByUserId: game.user?.id ?? null,
        updatedByUserName: game.user?.name ?? null,
        updateReason: toNullableString(reason) ?? toNullableString(patch?.updateReason) ?? null
      })
    );

    try {
      await game.settings.set(MODULE_ID, getSettingKey(), next);

      DBG.groupCollapsed("Store", "Emote store state written", {
        userId: game.user?.id ?? null,
        userName: game.user?.name ?? null,
        reason: next.updateReason,
        previousState: existing,
        nextState: next
      });

      return { ok: true, reason: "written", state: next };
    } catch (err) {
      DBG.error("Store", "Failed to write Emote store state", {
        patch,
        error: err?.message ?? err
      });

      return { ok: false, reason: "writeFailed", state: null, error: err };
    }
  }

  async function getHotkeyMap() {
    const state = await getState();
    return deepClone(state.hotkeyMap);
  }

  async function setHotkeyMap(hotkeyMap, { reason = "setHotkeyMap" } = {}) {
    const EmoteData = getEmoteData();
    const normalizedMap = EmoteData?.normalizeHotkeyMap
      ? EmoteData.normalizeHotkeyMap(hotkeyMap)
      : getDefaultState().hotkeyMap;

    return await writeState(
      { hotkeyMap: normalizedMap },
      { merge: true, reason }
    );
  }

  async function setSlot(slot, emoteUrl, { reason = "setSlot" } = {}) {
    const EmoteData = getEmoteData();
    if (!EmoteData?.normalizeSlotKey) {
      DBG.warn("Store", "setSlot aborted because EmoteData API is unavailable", {
        slot,
        emoteUrl
      });
      return { ok: false, reason: "emoteDataUnavailable", state: null };
    }

    const normalizedSlot = EmoteData.normalizeSlotKey(slot);
    if (!normalizedSlot) {
      DBG.warn("Store", "setSlot aborted because slot was invalid", { slot, emoteUrl });
      return { ok: false, reason: "invalidSlot", state: null };
    }

    const current = await getState();
    const nextMap = deepClone(current.hotkeyMap);

    if (cleanString(emoteUrl) && EmoteData.isKnownEmoteUrl?.(emoteUrl)) {
      nextMap[normalizedSlot] = cleanString(emoteUrl);
    } else {
      // Invalid/blank input => restore that slot to default
      nextMap[normalizedSlot] = getDefaultState().hotkeyMap[normalizedSlot] ?? null;
    }

    return await writeState(
      { hotkeyMap: nextMap },
      { merge: true, reason: `${reason}:${normalizedSlot}` }
    );
  }

  async function getSlot(slot) {
    const EmoteData = getEmoteData();
    const normalizedSlot = EmoteData?.normalizeSlotKey?.(slot) ?? null;
    if (!normalizedSlot) return null;

    const state = await getState();
    return state.hotkeyMap?.[normalizedSlot] ?? null;
  }

  async function resetToDefault({ reason = "resetToDefault" } = {}) {
    return await writeState(getDefaultState(), {
      merge: false,
      reason
    });
  }

  async function clear({ reason = "clear" } = {}) {
    // For this system, "clear" just means reset to default state.
    return await resetToDefault({ reason });
  }

  async function getSlotRows() {
    const EmoteData = getEmoteData();
    const map = await getHotkeyMap();

    if (!EmoteData?.getSlotRowsFromMap) {
      return Object.entries(map).map(([slot, url]) => ({ slot, url }));
    }

    return EmoteData.getSlotRowsFromMap(map);
  }

  async function exportState() {
    return deepClone(await getState());
  }

  async function importState(rawState, { reason = "importState" } = {}) {
    const normalized = normalizeState(rawState);
    return await writeState(normalized, {
      merge: false,
      reason
    });
  }

  function getSnapshot() {
    return {
      installed: true,
      moduleId: MODULE_ID,
      systemId: SYSTEM_ID,
      settingKey: getSettingKey(),
      userId: game.user?.id ?? null,
      userName: game.user?.name ?? null
    };
  }

  const api = {
    installed: true,
    MODULE_ID,
    SYSTEM_ID,
    SETTINGS,
    STATE_VERSION,

    getDefaultState,
    normalizeState,

    getRawState,
    getState,
    writeState,

    getHotkeyMap,
    setHotkeyMap,

    getSlot,
    setSlot,
    getSlotRows,

    resetToDefault,
    clear,

    exportState,
    importState,

    getSnapshot
  };

  globalThis[GLOBAL_KEY] = api;

  Hooks.once("init", () => {
    try {
      game.settings.register(MODULE_ID, getSettingKey(), getRegisteredSettingConfig());
    } catch (err) {
      console.error("[Emote:Store] Failed to register setting", err);
    }
  });

  Hooks.once("ready", async () => {
    try {
      globalThis.FUCompanion ??= {};
      globalThis.FUCompanion.api ??= {};
      globalThis.FUCompanion.api.EmoteStore = api;
    } catch (err) {
      console.warn("[Emote:Store] Failed to attach API to FUCompanion.api", err);
    }

    // Warm-load once so bad / old data gets normalized automatically on first use.
    try {
      const state = await getState();
      DBG.verbose("Bootstrap", "emote-store.js ready", {
        moduleId: MODULE_ID,
        systemId: SYSTEM_ID,
        slotCount: Object.keys(state.hotkeyMap ?? {}).length,
        updatedAt: state.updatedAt
      });
    } catch (err) {
      DBG.warn("Bootstrap", "emote-store.js ready but initial state load failed", {
        error: err?.message ?? err
      });
    }
  });
})();