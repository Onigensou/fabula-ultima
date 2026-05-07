// ============================================================================
// ActiveEffectManager-ui-state.js
// Foundry VTT V12 — Fabula Ultima Companion
//
// Purpose:
// - State helper module for the modular Active Effect Manager UI.
// - Owns only:
//     1. createInitialState()
//     2. readCommonStateFromDom()
//     3. target selection syncing
//     4. selected-effect queue helpers
//     5. custom builder state defaults
//
// Public API:
//   FUCompanion.api.activeEffectManager.uiParts.state.createInitialState()
//   FUCompanion.api.activeEffectManager.uiParts.state.readCommonStateFromDom(root, state)
//   FUCompanion.api.activeEffectManager.uiParts.state.syncTargetRowsSelection(state)
//   FUCompanion.api.activeEffectManager.uiParts.state.setSelectedTargetsFromRows(state, rows)
//
// Load order:
// - Load before ActiveEffectManager-ui-core.js.
// ============================================================================

(() => {
  const MODULE_ID = "fabula-ultima-companion";
  const TAG = "[ONI][ActiveEffectManager:UI:State]";
  const DEBUG = true;

  const log = (...a) => DEBUG && console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);

  // --------------------------------------------------------------------------
  // Namespace helpers
  // --------------------------------------------------------------------------

  function ensureApiRoot() {
    globalThis.FUCompanion = globalThis.FUCompanion || {};
    globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
    globalThis.FUCompanion.api.activeEffectManager =
      globalThis.FUCompanion.api.activeEffectManager || {};

    return globalThis.FUCompanion.api.activeEffectManager;
  }

  function ensureUiPartsRoot() {
    const root = ensureApiRoot();
    root.uiParts = root.uiParts || {};
    return root.uiParts;
  }

  function exposeApi(api) {
    const parts = ensureUiPartsRoot();
    parts.state = api;

    try {
      const mod = game.modules?.get?.(MODULE_ID);
      if (mod) {
        mod.api = mod.api || {};
        mod.api.activeEffectManager = mod.api.activeEffectManager || {};
        mod.api.activeEffectManager.uiParts =
          mod.api.activeEffectManager.uiParts || {};
        mod.api.activeEffectManager.uiParts.state = api;
      }
    } catch (e) {
      warn("Could not expose state API on module object.", e);
    }
  }

  // --------------------------------------------------------------------------
  // Small helpers
  // --------------------------------------------------------------------------

  function getService(options, key) {
    return options?.services?.[key] ?? null;
  }

  function clone(value, fallback = null) {
    try {
      if (foundry?.utils?.deepClone) return foundry.utils.deepClone(value);
    } catch (_e) {}

    try {
      return structuredClone(value);
    } catch (_e) {}

    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_e) {}

    return fallback;
  }

  function safeString(value, fallback = "") {
    const s = String(value ?? "").trim();
    return s.length ? s : fallback;
  }

  function asArray(value) {
    if (Array.isArray(value)) return value;
    if (value == null) return [];
    if (value instanceof Set) return Array.from(value);
    return [value];
  }

  function randomId(prefix = "aem") {
    const id =
      foundry?.utils?.randomID?.(8) ??
      Math.random().toString(36).slice(2, 10);

    return `${prefix}-${id}`;
  }

  function modeValue(name) {
    const modes = CONST?.ACTIVE_EFFECT_MODES ?? {};

    const fallback = {
      CUSTOM: 0,
      MULTIPLY: 1,
      ADD: 2,
      DOWNGRADE: 3,
      UPGRADE: 4,
      OVERRIDE: 5
    };

    return modes[name] ?? fallback[name] ?? 0;
  }

  function numberOrFallback(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function boolFromDom(el, fallback = false) {
    if (!el) return fallback;
    return !!el.checked;
  }

  // --------------------------------------------------------------------------
  // Target selection state
  // --------------------------------------------------------------------------

  function mergeTargetRows(rows = []) {
    const byUuid = new Map();

    for (const row of asArray(rows)) {
      if (!row?.actorUuid) continue;

      const existing = byUuid.get(row.actorUuid);

      if (!existing) {
        byUuid.set(row.actorUuid, { ...row });
        continue;
      }

      existing.selected = existing.selected || row.selected;
      existing.img = existing.img || row.img;
      existing.note = existing.note || row.note;

      const sourceSet = new Set(
        String(`${existing.source || ""}|${row.source || ""}`)
          .split("|")
          .map(s => s.trim())
          .filter(Boolean)
      );

      existing.source = Array.from(sourceSet).join(" • ");
    }

    return Array.from(byUuid.values());
  }

  function syncTargetRowsSelection(state) {
    if (!state) return state;

    const selected = new Set(state.targetActorUuids ?? []);

    state.targetRows = (state.targetRows ?? []).map(row => ({
      ...row,
      selected: selected.has(row.actorUuid)
    }));

    return state;
  }

  function setSelectedTargetsFromRows(state, rows = []) {
    if (!state) return state;

    state.targetRows = mergeTargetRows(rows);

    state.targetActorUuids = state.targetRows
      .filter(row => row.selected)
      .map(row => row.actorUuid)
      .filter(Boolean);

    return state;
  }

  function setTargetActorUuids(state, actorUuids = []) {
    if (!state) return state;

    state.targetActorUuids = Array.from(
      new Set(
        asArray(actorUuids)
          .map(safeString)
          .filter(Boolean)
      )
    );

    syncTargetRowsSelection(state);

    return state;
  }

  function getSelectedTargetCount(state) {
    return asArray(state?.targetActorUuids).filter(Boolean).length;
  }

  function readTargetSelectionFromDom(root, state) {
    if (!root || !state) return state;

    const selected = Array.from(
      root.querySelectorAll?.('[name="targetActorUuids"]:checked') ?? []
    )
      .map(el => el.value)
      .filter(Boolean);

    setTargetActorUuids(state, selected);

    return state;
  }

  // --------------------------------------------------------------------------
  // Effect queue state
  // --------------------------------------------------------------------------

  function normalizeSelectedEffect(effect = {}) {
    const kind = safeString(effect.kind, effect.effectData ? "custom" : "registry");

    const effectData = effect.effectData ? clone(effect.effectData, {}) : null;

    return {
      id: safeString(effect.id, randomId("selected")),
      kind,

      registryId: effect.registryId ?? null,

      name: safeString(
        effect.name ??
        effectData?.name ??
        effectData?.label,
        kind === "custom" ? "Custom Active Effect" : "Active Effect"
      ),

      img: safeString(
        effect.img ??
        effect.icon ??
        effectData?.img ??
        effectData?.icon,
        "icons/svg/aura.svg"
      ),

      category: safeString(
        effect.category ??
        effectData?.flags?.[MODULE_ID]?.category ??
        effectData?.flags?.[MODULE_ID]?.activeEffectManager?.sourceCategory,
        "Other"
      ),

      effectData
    };
  }

  function setSelectedEffects(state, effects = []) {
    if (!state) return state;
    state.selectedEffects = asArray(effects).map(normalizeSelectedEffect);
    return state;
  }

  function addSelectedEffect(state, effect = {}) {
    if (!state) return null;

    const normalized = normalizeSelectedEffect(effect);
    state.selectedEffects = asArray(state.selectedEffects);
    state.selectedEffects.push(normalized);

    return normalized;
  }

  function removeSelectedEffectById(state, selectedId) {
    if (!state) return null;

    const id = safeString(selectedId);
    if (!id) return null;

    const before = asArray(state.selectedEffects);
    const removed = before.find(effect => String(effect.id) === id) ?? null;

    state.selectedEffects = before.filter(effect => String(effect.id) !== id);

    return removed;
  }

  function clearSelectedEffects(state) {
    if (!state) return state;
    state.selectedEffects = [];
    return state;
  }

  function getSelectedEffectCount(state) {
    return asArray(state?.selectedEffects).length;
  }

  // --------------------------------------------------------------------------
  // Apply option state
  // --------------------------------------------------------------------------

  function readApplyOptionsFromDom(root, state) {
    if (!root || !state) return state;

    state.duplicateMode =
      root.querySelector?.('[name="duplicateMode"]')?.value ??
      state.duplicateMode;

    state.overrideDuration = boolFromDom(
      root.querySelector?.('[name="overrideDuration"]'),
      state.overrideDuration
    );

    state.silent = boolFromDom(
      root.querySelector?.('[name="silent"]'),
      state.silent
    );

    state.durationRounds =
      root.querySelector?.('[name="durationRounds"]')?.value ??
      state.durationRounds;

    state.durationTurns =
      root.querySelector?.('[name="durationTurns"]')?.value ??
      state.durationTurns;

    return state;
  }

  function getGlobalDurationFromState(state) {
    if (!state?.overrideDuration) return null;

    const rounds = Number(state.durationRounds);
    const turns = Number(state.durationTurns);

    const duration = {};

    if (Number.isFinite(rounds)) duration.rounds = rounds;
    if (Number.isFinite(turns)) duration.turns = turns;

    return duration;
  }

  // --------------------------------------------------------------------------
  // Registry/search state
  // --------------------------------------------------------------------------

  function readRegistryFilterFromDom(root, state) {
    if (!root || !state) return state;

    state.search =
      root.querySelector?.('[name="effectSearch"]')?.value ??
      state.search;

    return state;
  }

  function setCategoryFilter(state, category = "All") {
    if (!state) return state;
    state.categoryFilter = safeString(category, "All");
    return state;
  }

  function setRegistryEntries(state, entries = []) {
    if (!state) return state;
    state.registryEntries = asArray(entries);
    return state;
  }

  function setFieldEntries(state, entries = []) {
    if (!state) return state;
    state.fieldEntries = asArray(entries);
    return state;
  }

  // --------------------------------------------------------------------------
  // Custom builder state
  // --------------------------------------------------------------------------

  function makeDefaultCustomRow(options = {}) {
    return {
      id: safeString(options.id, randomId("mod")),
      key: safeString(options.key),
      mode: numberOrFallback(options.mode, modeValue("ADD")),
      value: String(options.value ?? "1"),
      priority: numberOrFallback(options.priority, 20)
    };
  }

  function normalizeCustomRows(rows = []) {
    const sourceRows = asArray(rows).filter(Boolean);

    if (!sourceRows.length) {
      return [makeDefaultCustomRow()];
    }

    return sourceRows.map(row => makeDefaultCustomRow(row));
  }

  function ensureCustomRows(state) {
    if (!state) return state;
    state.customRows = normalizeCustomRows(state.customRows);
    return state;
  }

  function addCustomRow(state, row = {}) {
    if (!state) return null;

    state.customRows = normalizeCustomRows(state.customRows);
    const next = makeDefaultCustomRow(row);

    state.customRows.push(next);

    return next;
  }

  function removeCustomRow(state, rowId) {
    if (!state) return state;

    const id = safeString(rowId);
    state.customRows = normalizeCustomRows(state.customRows)
      .filter(row => String(row.id) !== id);

    if (!state.customRows.length) {
      state.customRows = [makeDefaultCustomRow()];
    }

    return state;
  }

  function readCustomBuilderStateFromDom(root, state) {
    if (!root || !state) return state;

    state.customName =
      root.querySelector?.('[name="customName"]')?.value ??
      state.customName;

    state.customCategory =
      root.querySelector?.('[name="customCategory"]')?.value ??
      state.customCategory;

    state.customIcon =
      root.querySelector?.('[name="customIcon"]')?.value ??
      state.customIcon;

    state.customStatuses =
      root.querySelector?.('[name="customStatuses"]')?.value ??
      state.customStatuses;

    state.customDescription =
      root.querySelector?.('[name="customDescription"]')?.value ??
      state.customDescription;

    const rows = [];

    for (const rowEl of root.querySelectorAll?.("[data-mod-row-id]") ?? []) {
      rows.push({
        id: rowEl.dataset.modRowId || randomId("mod"),
        key: rowEl.querySelector('[data-row-field="key"]')?.value ?? "",
        mode: numberOrFallback(
          rowEl.querySelector('[data-row-field="mode"]')?.value,
          modeValue("ADD")
        ),
        value: String(rowEl.querySelector('[data-row-field="value"]')?.value ?? "1"),
        priority: numberOrFallback(
          rowEl.querySelector('[data-row-field="priority"]')?.value,
          20
        )
      });
    }

    if (rows.length) state.customRows = normalizeCustomRows(rows);

    return state;
  }

  // --------------------------------------------------------------------------
  // Main state factory
  // --------------------------------------------------------------------------

  function createInitialState(options = {}) {
    const serviceRandomId = getService(options, "randomId");
    const serviceModeValue = getService(options, "modeValue");

    const makeId =
      typeof serviceRandomId === "function"
        ? serviceRandomId
        : randomId;

    const getMode =
      typeof serviceModeValue === "function"
        ? serviceModeValue
        : modeValue;

    return {
      // Target panel
      targetRows: [],
      targetActorUuids: [],
      targetSourceLabel: "",

      // Registry / field catalogue data
      registryEntries: [],
      fieldEntries: [],

      // Selected effect queue
      selectedEffects: [],

      // Effect registry filter UI
      categoryFilter: "All",
      search: "",

      // Apply options
      duplicateMode: "skip",
      overrideDuration: true,
      durationRounds: 3,
      durationTurns: 0,
      silent: false,

      // Custom builder defaults
      customName: "Custom Active Effect",
      customCategory: "Buff",
      customIcon: "icons/svg/aura.svg",
      customStatuses: "",
      customDescription: "",
      customRows: [{
        id: makeId("mod"),
        key: "",
        mode: getMode("ADD"),
        value: "1",
        priority: 20
      }],

      // Debug/output area
      outputText: ""
    };
  }

  function normalizeState(state, options = {}) {
    const base = createInitialState(options);
    const merged = {
      ...base,
      ...(state ?? {})
    };

    merged.targetRows = asArray(merged.targetRows);
    merged.targetActorUuids = asArray(merged.targetActorUuids)
      .map(safeString)
      .filter(Boolean);

    merged.registryEntries = asArray(merged.registryEntries);
    merged.fieldEntries = asArray(merged.fieldEntries);

    merged.selectedEffects = asArray(merged.selectedEffects)
      .map(normalizeSelectedEffect);

    merged.categoryFilter = safeString(merged.categoryFilter, "All");
    merged.search = safeString(merged.search);

    merged.duplicateMode = safeString(merged.duplicateMode, "skip");
    merged.overrideDuration = !!merged.overrideDuration;
    merged.silent = !!merged.silent;

    merged.durationRounds = merged.durationRounds ?? 3;
    merged.durationTurns = merged.durationTurns ?? 0;

    merged.customName = safeString(merged.customName, "Custom Active Effect");
    merged.customCategory = safeString(merged.customCategory, "Buff");
    merged.customIcon = safeString(merged.customIcon, "icons/svg/aura.svg");
    merged.customStatuses = safeString(merged.customStatuses);
    merged.customDescription = String(merged.customDescription ?? "");
    merged.customRows = normalizeCustomRows(merged.customRows);

    merged.outputText = String(merged.outputText ?? "");

    syncTargetRowsSelection(merged);

    return merged;
  }

  function readCommonStateFromDom(root, state, options = {}) {
    if (!root || !state) return state;

    readTargetSelectionFromDom(root, state);
    readApplyOptionsFromDom(root, state);
    readRegistryFilterFromDom(root, state);
    readCustomBuilderStateFromDom(root, state);

    return normalizeState(state, options);
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  const api = {
    version: "0.1.0",

    createInitialState,
    normalizeState,

    readCommonStateFromDom,
    readTargetSelectionFromDom,
    readApplyOptionsFromDom,
    readRegistryFilterFromDom,
    readCustomBuilderStateFromDom,

    syncTargetRowsSelection,
    setSelectedTargetsFromRows,
    setTargetActorUuids,
    getSelectedTargetCount,

    setSelectedEffects,
    addSelectedEffect,
    removeSelectedEffectById,
    clearSelectedEffects,
    getSelectedEffectCount,

    setCategoryFilter,
    setRegistryEntries,
    setFieldEntries,

    getGlobalDurationFromState,

    makeDefaultCustomRow,
    normalizeCustomRows,
    ensureCustomRows,
    addCustomRow,
    removeCustomRow,

    _internal: {
      clone,
      safeString,
      asArray,
      randomId,
      modeValue,
      mergeTargetRows
    }
  };

  exposeApi(api);

  Hooks.once("ready", () => {
    exposeApi(api);

    log("Ready. Active Effect Manager UI State module installed.", {
      api: "FUCompanion.api.activeEffectManager.uiParts.state"
    });
  });
})();