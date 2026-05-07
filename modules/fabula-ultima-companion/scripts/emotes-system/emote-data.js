/**
 * emote-data.js
 * Fabula Ultima Companion - Emote System Data Catalog
 * Foundry VTT v12
 *
 * Purpose:
 * - Hold the shared emote catalog for the Emote System
 * - Define default Alt+1~0 slot assignments
 * - Define spare emotes available in the configuration UI
 * - Provide slot normalization / label helpers
 *
 * Globals:
 *   globalThis.__ONI_EMOTE_DATA__
 *
 * API:
 *   FUCompanion.api.EmoteData
 */

(() => {
  const GLOBAL_KEY = "__ONI_EMOTE_DATA__";
  if (globalThis[GLOBAL_KEY]?.installed) return;

  const MODULE_ID = "fabula-ultima-companion";
  const SYSTEM_ID = "emote";

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

  const DBG = getDebug();

  const ORDERED_SLOTS = Object.freeze(["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"]);

  // ---------------------------------------------------------------------------
  // Shared catalog
  // ---------------------------------------------------------------------------
  const EMOTE_CATALOG = Object.freeze([
    // Default assigned emotes
    {
      id: "Exc",
      label: "Exc",
      url: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Emotes%20Icon/RO/Exc.webm",
      kind: "default"
    },
    {
      id: "Que",
      label: "Que",
      url: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Emotes%20Icon/RO/Que.webm",
      kind: "default"
    },
    {
      id: "Ang",
      label: "Ang",
      url: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Emotes%20Icon/RO/Ang.webm",
      kind: "default"
    },
    {
      id: "Love",
      label: "Love",
      url: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Emotes%20Icon/RO/Love.webm",
      kind: "default"
    },
    {
      id: "No1",
      label: "No1",
      url: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Emotes%20Icon/RO/No1.webm",
      kind: "default"
    },
    {
      id: "Heh",
      label: "Heh",
      url: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Emotes%20Icon/RO/Heh.webm",
      kind: "default"
    },
    {
      id: "Ggg",
      label: "Ggg",
      url: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Emotes%20Icon/RO/Ggg.webm",
      kind: "default"
    },
    {
      id: "gif",
      label: "gif",
      url: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Emotes%20Icon/RO/gif.webm",
      kind: "default"
    },
    {
      id: "Ok",
      label: "Ok",
      url: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Emotes%20Icon/RO/Ok.webm",
      kind: "default"
    },
    {
      id: "Omg",
      label: "Omg",
      url: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Emotes%20Icon/RO/Omg.webm",
      kind: "default"
    },

    // Spare emotes
    {
      id: "Abs",
      label: "Abs",
      url: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Emotes%20Icon/RO/Abs.webm",
      kind: "spare"
    },
    {
      id: "Agh",
      label: "Agh",
      url: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Emotes%20Icon/RO/Agh.webm",
      kind: "spare"
    },
    {
      id: "Awsm",
      label: "Awsm",
      url: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Emotes%20Icon/RO/Awsm.webm",
      kind: "spare"
    },
    {
      id: "Ene",
      label: "Ene",
      url: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Emotes%20Icon/RO/Ene.webm",
      kind: "spare"
    },
    {
      id: "Fsh",
      label: "Fsh",
      url: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Emotes%20Icon/RO/Fsh.webm",
      kind: "spare"
    },
    {
      id: "Goo",
      label: "Goo",
      url: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Emotes%20Icon/RO/Goo.webm",
      kind: "spare"
    },
    {
      id: "Grat",
      label: "Grat",
      url: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Emotes%20Icon/RO/Grat.webm",
      kind: "spare"
    },
    {
      id: "Hep",
      label: "Hep",
      url: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Emotes%20Icon/RO/Hep.webm",
      kind: "spare"
    },
    {
      id: "Hlp",
      label: "Hlp",
      url: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Emotes%20Icon/RO/Hlp.webm",
      kind: "spare"
    },
    {
      id: "Hmm",
      label: "Hmm",
      url: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Emotes%20Icon/RO/Hmm.webm",
      kind: "spare"
    },
    {
      id: "Hoe",
      label: "Hoe",
      url: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Emotes%20Icon/RO/Hoe.webm",
      kind: "spare"
    },
    {
      id: "Money",
      label: "Money",
      url: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Emotes%20Icon/RO/Money.webm",
      kind: "spare"
    },
    {
      id: "Rice",
      label: "Rice",
      url: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Emotes%20Icon/RO/Rice.gif",
      kind: "spare"
    },
    {
      id: "Sob",
      label: "Sob",
      url: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Emotes%20Icon/RO/Sob.webm",
      kind: "spare"
    },
    {
      id: "Sweat",
      label: "Sweat",
      url: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Emotes%20Icon/RO/Sweat.webm",
      kind: "spare"
    }
  ]);

  const DEFAULT_HOTKEY_MAP = Object.freeze({
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
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
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

  function cleanString(value) {
    return value == null ? "" : String(value).trim();
  }

  function normalizeSlotKey(value) {
    if (value == null) return null;

    // Raw number
    if (typeof value === "number" && Number.isFinite(value)) {
      const n = String(value);
      return ORDERED_SLOTS.includes(n) ? n : null;
    }

    const raw = cleanString(value);
    if (!raw) return null;

    // Direct slot key
    if (ORDERED_SLOTS.includes(raw)) return raw;

    // KeyboardEvent.code style
    if (/^Digit[0-9]$/i.test(raw)) {
      const digit = raw.slice(-1);
      return ORDERED_SLOTS.includes(digit) ? digit : null;
    }

    // Numpad style
    if (/^Numpad[0-9]$/i.test(raw)) {
      const digit = raw.slice(-1);
      return ORDERED_SLOTS.includes(digit) ? digit : null;
    }

    // Alt + 1 style labels
    const match = raw.match(/([0-9])$/);
    if (match?.[1] && ORDERED_SLOTS.includes(match[1])) {
      return match[1];
    }

    return null;
  }

  function getOrderedSlots() {
    return [...ORDERED_SLOTS];
  }

  function getSlotDisplayLabel(slot) {
    const normalized = normalizeSlotKey(slot);
    if (!normalized) return "Alt + ?";
    return `Alt + ${normalized}`;
  }

  function getDefaultHotkeyMap() {
    return deepClone(DEFAULT_HOTKEY_MAP);
  }

  function getCatalog() {
    return deepClone(EMOTE_CATALOG);
  }

  function getCatalogByKind(kind = null) {
    const cleanKind = cleanString(kind).toLowerCase();
    if (!cleanKind) return getCatalog();

    return EMOTE_CATALOG
      .filter(entry => cleanString(entry.kind).toLowerCase() === cleanKind)
      .map(entry => deepClone(entry));
  }

  function getDefaultEmotes() {
    return getCatalogByKind("default");
  }

  function getSpareEmotes() {
    return getCatalogByKind("spare");
  }

  function findEmoteByUrl(url) {
    const cleanUrl = cleanString(url);
    if (!cleanUrl) return null;

    const found = EMOTE_CATALOG.find(entry => cleanString(entry.url) === cleanUrl);
    return found ? deepClone(found) : null;
  }

  function findEmoteById(id) {
    const cleanId = cleanString(id).toLowerCase();
    if (!cleanId) return null;

    const found = EMOTE_CATALOG.find(entry => cleanString(entry.id).toLowerCase() === cleanId);
    return found ? deepClone(found) : null;
  }

  function isKnownEmoteUrl(url) {
    return !!findEmoteByUrl(url);
  }

  function normalizeHotkeyMap(inputMap) {
    const base = getDefaultHotkeyMap();
    const src = inputMap && typeof inputMap === "object" ? inputMap : {};

    for (const slot of ORDERED_SLOTS) {
      const raw = src[slot];
      const clean = cleanString(raw);

      // Keep known emote URLs only. If invalid/blank, fall back to default.
      if (clean && isKnownEmoteUrl(clean)) {
        base[slot] = clean;
      }
    }

    return base;
  }

  function getEmoteLabelFromUrl(url, fallback = "Unknown") {
    const found = findEmoteByUrl(url);
    return found?.label ?? fallback;
  }

  function getConfigOptions() {
    return EMOTE_CATALOG.map(entry => ({
      id: entry.id,
      label: entry.label,
      url: entry.url,
      kind: entry.kind
    })).map(row => deepClone(row));
  }

  function getSlotRowsFromMap(hotkeyMap = null) {
    const map = normalizeHotkeyMap(hotkeyMap);

    return ORDERED_SLOTS.map(slot => {
      const url = map[slot] ?? null;
      const emote = findEmoteByUrl(url);

      return {
        slot,
        slotLabel: getSlotDisplayLabel(slot),
        url,
        emoteId: emote?.id ?? null,
        emoteLabel: emote?.label ?? "Unknown",
        emoteKind: emote?.kind ?? null
      };
    });
  }

  const api = {
    installed: true,
    MODULE_ID,
    SYSTEM_ID,

    ORDERED_SLOTS,
    EMOTE_CATALOG,
    DEFAULT_HOTKEY_MAP,

    normalizeSlotKey,
    getOrderedSlots,
    getSlotDisplayLabel,

    getDefaultHotkeyMap,
    normalizeHotkeyMap,

    getCatalog,
    getCatalogByKind,
    getDefaultEmotes,
    getSpareEmotes,
    getConfigOptions,

    findEmoteByUrl,
    findEmoteById,
    isKnownEmoteUrl,
    getEmoteLabelFromUrl,

    getSlotRowsFromMap
  };

  globalThis[GLOBAL_KEY] = api;

  Hooks.once("ready", () => {
    try {
      globalThis.FUCompanion ??= {};
      globalThis.FUCompanion.api ??= {};
      globalThis.FUCompanion.api.EmoteData = api;
    } catch (err) {
      console.warn("[Emote:Data] Failed to attach API to FUCompanion.api", err);
    }

    DBG.verbose("Bootstrap", "emote-data.js ready", {
      moduleId: MODULE_ID,
      systemId: SYSTEM_ID,
      catalogSize: EMOTE_CATALOG.length,
      defaultSlotCount: ORDERED_SLOTS.length
    });
  });
})();