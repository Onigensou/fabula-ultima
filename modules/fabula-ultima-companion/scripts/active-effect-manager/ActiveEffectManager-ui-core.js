// ============================================================================
// ActiveEffectManager-ui-core.js
// Foundry VTT V12 — Fabula Ultima Companion
//
// Purpose:
// - Thin compatibility-safe UI shell for Active Effect Manager.
// - Owns only: public UI API, dialog lifecycle, boot/loading sequence, and
//   routing to smaller uiParts modules.
// - Keeps the existing public API used by ActiveEffectManager-button.js:
//     FUCompanion.api.activeEffectManager.ui.open()
//     FUCompanion.api.activeEffectManager.openUI()
//
// IMPORTANT MIGRATION NOTE:
// - This file is safe to add before the helper files are extracted.
// - If required uiParts are missing and the old monolithic UI was loaded before
//   this file, this core will fall back to the old UI instead of breaking the
//   floating button.
// - Once uiParts are extracted, this file becomes the real replacement for the
//   old ActiveEffectManager-ui.js.
// ============================================================================

(() => {
  const MODULE_ID = "fabula-ultima-companion";
  const TAG = "[ONI][ActiveEffectManager:UI:Core]";
  const DEBUG = true;

  const CORE_MARKER = "__oniAemUiCoreApi";

  const CFG = {
    fallbackToLegacyUi: true,
    dialogTitle: "Active Effect Manager",
    width: 980,
    height: "auto",
    resizable: true
  };

  let ACTIVE_DIALOG = null;
  let LEGACY_UI_API = null;

  const log = (...a) => DEBUG && console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);
  const err = (...a) => console.error(TAG, ...a);

  // --------------------------------------------------------------------------
  // Namespace / API helpers
  // --------------------------------------------------------------------------

  function ensureApiRoot() {
    globalThis.FUCompanion = globalThis.FUCompanion || {};
    globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
    globalThis.FUCompanion.api.activeEffectManager =
      globalThis.FUCompanion.api.activeEffectManager || {};

    return globalThis.FUCompanion.api.activeEffectManager;
  }

  function getManagerApi() {
    return globalThis.FUCompanion?.api?.activeEffectManager ?? null;
  }

  function getRegistryApi() {
    const root = globalThis.FUCompanion?.api ?? {};

    return (
      root.activeEffectManager?.registry ??
      root.activeEffectRegistry ??
      game.modules?.get?.(MODULE_ID)?.api?.activeEffectManager?.registry ??
      game.modules?.get?.(MODULE_ID)?.api?.activeEffectRegistry ??
      null
    );
  }

  function getFieldCatalogueApi() {
    const root = globalThis.FUCompanion?.api ?? {};

    return (
      root.activeEffectManager?.fieldCatalogue ??
      root.activeEffectManager?.fieldCatalog ??
      game.modules?.get?.(MODULE_ID)?.api?.activeEffectManager?.fieldCatalogue ??
      game.modules?.get?.(MODULE_ID)?.api?.activeEffectManager?.fieldCatalog ??
      null
    );
  }

  function getCustomBuilderApi() {
    return (
      globalThis.FUCompanion?.api?.activeEffectManager?.customBuilder ??
      globalThis.FUCompanion?.api?.activeEffectManager?.builder ??
      game.modules?.get?.(MODULE_ID)?.api?.activeEffectManager?.customBuilder ??
      game.modules?.get?.(MODULE_ID)?.api?.activeEffectManager?.builder ??
      null
    );
  }

  function exposeApi(api) {
    const root = ensureApiRoot();

    // Preserve an already-loaded monolithic UI as fallback before replacing it.
    if (!LEGACY_UI_API && root.ui && root.ui !== api && !root.ui?.[CORE_MARKER]) {
      LEGACY_UI_API = root.ui;
      log("Captured legacy UI API as fallback.", LEGACY_UI_API);
    }

    root.ui = api;
    root.uiCore = api;
    root.openUI = api.open;

    try {
      const mod = game.modules?.get?.(MODULE_ID);
      if (mod) {
        mod.api = mod.api || {};
        mod.api.activeEffectManager = mod.api.activeEffectManager || {};

        if (
          !LEGACY_UI_API &&
          mod.api.activeEffectManager.ui &&
          mod.api.activeEffectManager.ui !== api &&
          !mod.api.activeEffectManager.ui?.[CORE_MARKER]
        ) {
          LEGACY_UI_API = mod.api.activeEffectManager.ui;
          log("Captured legacy module UI API as fallback.", LEGACY_UI_API);
        }

        mod.api.activeEffectManager.ui = api;
        mod.api.activeEffectManager.uiCore = api;
        mod.api.activeEffectManager.openUI = api.open;
      }
    } catch (e) {
      warn("Could not expose UI Core API on module object.", e);
    }
  }

  // --------------------------------------------------------------------------
  // General helpers
  // --------------------------------------------------------------------------

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

  function compactError(e) {
    return String(e?.message ?? e);
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

  function normalizeHtmlRoot(htmlOrElement) {
    if (!htmlOrElement) return null;
    if (htmlOrElement instanceof HTMLElement) return htmlOrElement;
    if (htmlOrElement[0] instanceof HTMLElement) return htmlOrElement[0];
    if (htmlOrElement.element instanceof HTMLElement) return htmlOrElement.element;
    if (htmlOrElement.element?.[0] instanceof HTMLElement) return htmlOrElement.element[0];
    return null;
  }

  // --------------------------------------------------------------------------
  // uiParts lookup
  // --------------------------------------------------------------------------

  function getUiPartsRoot() {
    const root = ensureApiRoot();
    root.uiParts = root.uiParts || {};
    return root.uiParts;
  }

  function getPart(path) {
    const parts = getUiPartsRoot();

    try {
      return String(path)
        .split(".")
        .reduce((cur, key) => cur?.[key], parts);
    } catch (_e) {
      return undefined;
    }
  }

  function hasFunction(path) {
    return typeof getPart(path) === "function";
  }

  const REQUIRED_PARTS = [
    {
      path: "state.createInitialState",
      file: "ActiveEffectManager-ui-state.js",
      reason: "creates the dialog state object"
    },
    {
      path: "styles.injectStyle",
      file: "ActiveEffectManager-ui-styles.js",
      reason: "injects the manager CSS"
    },
    {
      path: "targets.reloadTargets",
      file: "ActiveEffectManager-ui-targets.js",
      reason: "loads party and selected-token targets"
    },
    {
      path: "render.renderMainContent",
      file: "ActiveEffectManager-ui-render.js",
      reason: "renders the main dialog HTML"
    },
    {
      path: "events.bindMainDialogEvents",
      file: "ActiveEffectManager-ui-events.js",
      reason: "handles search, category, target, queue, builder, and apply events"
    }
  ];

  function getMissingRequiredParts() {
    return REQUIRED_PARTS.filter(row => !hasFunction(row.path));
  }

  function makeMissingPartsReport() {
    const missing = getMissingRequiredParts();

    return {
      ok: missing.length === 0,
      reason: missing.length ? "missing_ui_parts" : null,
      missing: missing.map(row => ({
        path: row.path,
        file: row.file,
        reason: row.reason
      })),
      hint: missing.length
        ? "Load the helper files before ActiveEffectManager-ui-core.js, or keep the old ActiveEffectManager-ui.js loaded before this file so the legacy fallback can open."
        : "All required UI parts are present."
    };
  }

  function reportMissingPartsToUser(report) {
    const list = report.missing
      .map(row => `• ${row.file} -> uiParts.${row.path}`)
      .join("\n");

    warn("Cannot open modular UI yet. Missing uiParts:", report);

    ui.notifications?.warn?.(
      "Active Effect Manager UI Core is loaded, but helper files are missing. Check console."
    );

    console.groupCollapsed(`${TAG} Missing UI helper files`);
    console.warn(list);
    console.warn(report);
    console.groupEnd();
  }

  // --------------------------------------------------------------------------
  // Small built-in data/actions layer
  // --------------------------------------------------------------------------

  function isConfigStatusEffectEntry(entry = {}) {
    const sourceText = [
      entry.sourceType,
      entry.sourceName,
      entry.registryId,
      entry.effectUuid,
      entry.sourceUuid,
      entry.name
    ]
      .filter(Boolean)
      .map(String)
      .join(" ")
      .toLowerCase();

    return (
      sourceText.includes("config.statuseffects") ||
      sourceText.includes("config-status-effect")
    );
  }

  async function refreshRegistry(state, { includeCompendiums = false } = {}) {
    const registry = getRegistryApi();

    if (!registry) {
      state.registryEntries = [];
      return {
        ok: false,
        reason: "registry_api_not_found"
      };
    }

    const sampleActorUuid = state.targetActorUuids?.[0] ?? null;

    if (typeof registry.refresh === "function") {
      await registry.refresh({
        scanConfigStatusEffects: true,

        // Keep current polished UI behavior: show only official CONFIG rows.
        scanWorldItems: false,
        scanWorldActors: false,
        includeActorEffects: false,
        scanCompendiums: false,

        dedupe: true,
        sampleActorUuid
      });
    }

    const entries = typeof registry.getAll === "function"
      ? registry.getAll({ cloneResult: false })
      : [];

    const rawEntries = Array.isArray(entries) ? entries : [];
    state.registryEntries = rawEntries.filter(isConfigStatusEffectEntry);

    return {
      ok: true,
      source: "CONFIG.statusEffects only",
      count: state.registryEntries.length,
      rawCountBeforeFilter: rawEntries.length,
      includeCompendiumsRequested: !!includeCompendiums,
      note: includeCompendiums
        ? "This UI currently filters to CONFIG.statusEffects only, matching the previous polished UI behavior."
        : undefined
    };
  }

  async function refreshFields(state) {
    const catalogue = getFieldCatalogueApi();

    if (!catalogue) {
      state.fieldEntries = [];
      return {
        ok: false,
        reason: "field_catalogue_api_not_found"
      };
    }

    const actorUuid = state.targetActorUuids?.[0] ?? null;

    if (typeof catalogue.refresh === "function") {
      await catalogue.refresh({
        actorUuid,
        includeLegacyConditionKeys: false,
        includeReadOnly: false,
        suggestionsOnly: false
      });
    }

    const entries =
      typeof catalogue.getRecommended === "function"
        ? catalogue.getRecommended({ cloneResult: false })
        : typeof catalogue.getAll === "function"
          ? catalogue.getAll({ cloneResult: false })
          : [];

    state.fieldEntries = Array.isArray(entries) ? entries : [];

    return {
      ok: true,
      count: state.fieldEntries.length
    };
  }

  function findRegistryEntry(state, registryId) {
    return (state.registryEntries ?? [])
      .find(e => String(e.registryId) === String(registryId)) ?? null;
  }

  function addSelectedRegistryEffect(state, entry) {
    if (!entry) return;

    state.selectedEffects.push({
      id: randomId("selected"),
      kind: "registry",
      registryId: entry.registryId,
      name: entry.name,
      img: entry.img || entry.icon || "icons/svg/aura.svg",
      category: entry.category || "Other"
    });
  }

  function removeSelectedRegistryEffect(state, entry) {
    if (!entry) {
      return {
        ok: false,
        reason: "missing_registry_entry"
      };
    }

    const registryId = String(entry.registryId ?? "");
    const entryName = String(entry.name ?? "");
    const entryCategory = String(entry.category ?? "Other");

    let index = -1;

    for (let i = state.selectedEffects.length - 1; i >= 0; i--) {
      const selected = state.selectedEffects[i];

      if (
        selected.kind === "registry" &&
        String(selected.registryId ?? "") === registryId
      ) {
        index = i;
        break;
      }
    }

    if (index < 0) {
      for (let i = state.selectedEffects.length - 1; i >= 0; i--) {
        const selected = state.selectedEffects[i];

        if (
          String(selected.name ?? "") === entryName &&
          String(selected.category ?? "Other") === entryCategory
        ) {
          index = i;
          break;
        }
      }
    }

    if (index < 0) {
      return {
        ok: false,
        reason: "not_in_selected_effects",
        effectName: entryName
      };
    }

    const [removed] = state.selectedEffects.splice(index, 1);

    return {
      ok: true,
      removed
    };
  }

  function getGlobalDurationFromState(state) {
    if (!state.overrideDuration) return null;

    const rounds = Number(state.durationRounds);
    const turns = Number(state.durationTurns);

    const duration = {};
    if (Number.isFinite(rounds)) duration.rounds = rounds;
    if (Number.isFinite(turns)) duration.turns = turns;

    return duration;
  }

  async function applySelected(root, state) {
    const manager = getManagerApi();

    if (!manager?.applyEffects) {
      updateOutput(root, state, {
        ok: false,
        reason: "active_effect_manager_api_not_found"
      });
      return;
    }

    if (!state.targetActorUuids.length) {
      updateOutput(root, state, {
        ok: false,
        reason: "no_target_actors",
        hint: "Choose at least one target portrait first."
      });
      return;
    }

    if (!state.selectedEffects.length) {
      updateOutput(root, state, {
        ok: false,
        reason: "no_selected_effects",
        hint: "Add at least one effect first."
      });
      return;
    }

    const effects = state.selectedEffects.map(sel => {
      if (sel.kind === "registry") return sel.registryId;
      return { effectData: clone(sel.effectData, {}) };
    });

    const duration = getGlobalDurationFromState(state);

    const result = await manager.applyEffects({
      actorUuids: state.targetActorUuids,
      effects,
      duplicateMode: state.duplicateMode,
      duration,
      silent: state.silent,
      renderChat: true,
      playFx: true
    });

    updateOutput(root, state, result);
  }

  async function openCustomBuilderDialog(state, root) {
    const nativeBuilder = getPart("nativeBuilder.openForQueue") ?? getPart("nativeBuilder.open");

    if (typeof nativeBuilder === "function") {
      return await nativeBuilder({
        parentState: state,
        root,
        services: makeServices(),
        onAddEffect: (effectData, meta = {}) => {
          state.selectedEffects.push({
            id: randomId("selected"),
            kind: "custom",
            name: safeString(effectData?.name ?? effectData?.label, "Custom Active Effect"),
            img: safeString(effectData?.img ?? effectData?.icon, "icons/svg/aura.svg"),
            category: safeString(meta.category ?? effectData?.flags?.[MODULE_ID]?.category, "Other"),
            effectData: clone(effectData, {})
          });

          rerender(root, state);
        }
      });
    }

    const customBuilder = getCustomBuilderApi();

    if (typeof customBuilder?.open === "function") {
      const result = await customBuilder.open({
        actorUuids: state.targetActorUuids,
        duration: getGlobalDurationFromState(state) ?? {
          rounds: Number(state.durationRounds) || 3,
          turns: Number(state.durationTurns) || 0
        }
      });

      if (result?.effectData) {
        state.selectedEffects.push({
          id: randomId("selected"),
          kind: "custom",
          name: safeString(result.effectData.name ?? result.effectData.label, "Custom Active Effect"),
          img: safeString(result.effectData.img ?? result.effectData.icon, "icons/svg/aura.svg"),
          category: safeString(result.category, "Other"),
          effectData: clone(result.effectData, {})
        });

        rerender(root, state);
      }

      return result;
    }

    updateOutput(root, state, {
      ok: false,
      reason: "custom_builder_api_not_found",
      hint: "Load ActiveEffectManager-custom-builder.js or ActiveEffectManager-ui-native-builder.js."
    });

    ui.notifications?.warn?.("Active Effect Manager: custom builder API not found.");
    return null;
  }

  // --------------------------------------------------------------------------
  // DOM / render fallbacks
  // --------------------------------------------------------------------------

  function renderMainContent(state) {
    const fn = getPart("render.renderMainContent");
    if (typeof fn !== "function") {
      return `<div class="oni-aem"><p><b>Active Effect Manager UI Core</b></p><p>Missing render.renderMainContent helper.</p></div>`;
    }

    return fn(state, {
      services: makeServices()
    });
  }

  function updateOutput(root, state, data) {
    const fn = getPart("dom.updateOutput");
    if (typeof fn === "function") return fn(root, state, data);

    const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    state.outputText = text;

    const out = root?.querySelector?.("[data-aem-output]");
    if (out) out.value = text;
  }

  function rerender(root, state) {
    const fn = getPart("dom.rerender");
    if (typeof fn === "function") {
      return fn(root, state, {
        renderMainContent,
        services: makeServices()
      });
    }

    const holder = root?.querySelector?.("[data-aem-root-holder]");

    if (!holder) {
      warn("Could not rerender Active Effect Manager UI: root holder missing.");
      return;
    }

    holder.innerHTML = renderMainContent(state);
  }

  function rerenderEffectListOnly(root, state) {
    const fn = getPart("dom.rerenderEffectListOnly");
    if (typeof fn === "function") {
      return fn(root, state, {
        renderMainContent,
        services: makeServices()
      });
    }

    const effectListHtml = getPart("render.effectListHtml");
    const list = root?.querySelector?.("[data-aem-effect-list]");

    if (list && typeof effectListHtml === "function") {
      list.innerHTML = effectListHtml(state, { services: makeServices() });
      list.scrollTop = 0;
      return;
    }

    rerender(root, state);
  }

  function updateTargetSelectionDom(root, state) {
    const fn = getPart("dom.updateTargetSelectionDom");
    if (typeof fn === "function") return fn(root, state);

    const selected = new Set(state.targetActorUuids ?? []);

    for (const card of root.querySelectorAll?.("[data-aem-target-card]") ?? []) {
      const uuid = card.dataset.targetActorUuid;
      const isSelected = selected.has(uuid);

      card.classList.toggle("selected", isSelected);

      const input = card.querySelector('input[name="targetActorUuids"]');
      if (input) input.checked = isSelected;
    }

    const count = selected.size;

    const countEl = root.querySelector?.("[data-aem-selected-target-count]");
    if (countEl) countEl.textContent = String(count);

    const pluralEl = root.querySelector?.("[data-aem-selected-target-plural]");
    if (pluralEl) pluralEl.textContent = count === 1 ? "" : "s";
  }

  function readCommonStateFromDom(root, state) {
    const fn = getPart("state.readCommonStateFromDom");
    if (typeof fn === "function") return fn(root, state, { services: makeServices() });

    state.targetActorUuids = Array.from(root.querySelectorAll?.('[name="targetActorUuids"]:checked') ?? [])
      .map(el => el.value)
      .filter(Boolean);

    const sync = getPart("targets.syncTargetRowsSelection") ?? getPart("state.syncTargetRowsSelection");

    if (typeof sync === "function") {
      sync(state);
    } else {
      const selected = new Set(state.targetActorUuids ?? []);
      state.targetRows = (state.targetRows ?? []).map(row => ({
        ...row,
        selected: selected.has(row.actorUuid)
      }));
    }

    state.duplicateMode = root.querySelector?.('[name="duplicateMode"]')?.value ?? state.duplicateMode;
    state.overrideDuration = !!root.querySelector?.('[name="overrideDuration"]')?.checked;
    state.silent = !!root.querySelector?.('[name="silent"]')?.checked;

    state.durationRounds = root.querySelector?.('[name="durationRounds"]')?.value ?? state.durationRounds;
    state.durationTurns = root.querySelector?.('[name="durationTurns"]')?.value ?? state.durationTurns;

    state.search = root.querySelector?.('[name="effectSearch"]')?.value ?? state.search;
  }

  function refreshFieldsQuietly(state) {
    refreshFields(state).catch(e => {
      warn("Quiet field refresh after target change failed.", e);
    });
  }

  // --------------------------------------------------------------------------
  // Services passed to helper modules
  // --------------------------------------------------------------------------

  function makeServices() {
    return {
      MODULE_ID,
      TAG,
      DEBUG,

      clone,
      safeString,
      compactError,
      randomId,
      modeValue,
      normalizeHtmlRoot,

      getManagerApi,
      getRegistryApi,
      getFieldCatalogueApi,
      getCustomBuilderApi,

      refreshRegistry,
      refreshFields,
      refreshFieldsQuietly,
      findRegistryEntry,
      addSelectedRegistryEffect,
      removeSelectedRegistryEffect,
      getGlobalDurationFromState,
      applySelected,
      openCustomBuilderDialog,

      renderMainContent,
      rerender,
      rerenderEffectListOnly,
      updateTargetSelectionDom,
      readCommonStateFromDom,
      updateOutput,

      getUiPartsRoot,
      getPart
    };
  }

  // --------------------------------------------------------------------------
  // Built-in fallback event binder
  // --------------------------------------------------------------------------

  function bindFallbackMainDialogEvents({ root, holder, state }) {
    if (!root || !holder || holder.__oniAemCoreFallbackBound) return;
    holder.__oniAemCoreFallbackBound = true;

    holder.addEventListener("input", (ev) => {
      const target = ev.target;
      if (!target) return;

      readCommonStateFromDom(root, state);

      if (target.name === "effectSearch") {
        rerenderEffectListOnly(root, state);
      }
    });

    holder.addEventListener("change", async (ev) => {
      const target = ev.target;
      if (!target) return;

      readCommonStateFromDom(root, state);

      if (target.name === "targetActorUuids") {
        updateTargetSelectionDom(root, state);
        refreshFieldsQuietly(state);
      }
    });

    holder.addEventListener("contextmenu", (ev) => {
      const selectedBadge = ev.target.closest?.("[data-aem-selected-effect]");
      const registryRow = ev.target.closest?.("[data-aem-registry-row]");

      if (!selectedBadge && !registryRow) return;

      ev.preventDefault();
      ev.stopPropagation();

      readCommonStateFromDom(root, state);

      if (selectedBadge) {
        const id = selectedBadge.dataset.selectedId;
        state.selectedEffects = state.selectedEffects.filter(e => e.id !== id);
        rerender(root, state);
        return;
      }

      const entry = findRegistryEntry(state, registryRow.dataset.registryId);
      const result = removeSelectedRegistryEffect(state, entry);

      if (!result.ok) {
        ui.notifications?.info?.(`${entry?.name ?? "Effect"} is not currently queued.`);
        return;
      }

      rerender(root, state);
    });

    holder.addEventListener("click", async (ev) => {
      const btn = ev.target.closest?.("[data-aem-action]");
      if (!btn) return;

      ev.preventDefault();
      ev.stopPropagation();

      const action = btn.dataset.aemAction;

      try {
        btn.disabled = true;
        readCommonStateFromDom(root, state);

        if (action === "set-category") {
          state.categoryFilter = btn.dataset.category || "All";
          rerender(root, state);
          return;
        }

        if (action === "refresh-registry") {
          const result = await refreshRegistry(state, { includeCompendiums: false });
          updateOutput(root, state, result);
          rerender(root, state);
          return;
        }

        if (action === "refresh-registry-compendiums") {
          const result = await refreshRegistry(state, { includeCompendiums: true });
          updateOutput(root, state, result);
          rerender(root, state);
          return;
        }

        if (action === "debug-registry") {
          const registry = getRegistryApi();
          const report = registry?.getLastReport?.() ?? {
            ok: false,
            reason: "registry_api_not_found"
          };

          console.groupCollapsed(`${TAG} Registry Debug`);
          console.log(report);
          console.groupEnd();

          updateOutput(root, state, report);
          return;
        }

        if (action === "add-registry-effect") {
          const entry = findRegistryEntry(state, btn.dataset.registryId);
          addSelectedRegistryEffect(state, entry);
          rerender(root, state);
          return;
        }

        if (action === "remove-selected-effect") {
          const id = btn.dataset.selectedId;
          state.selectedEffects = state.selectedEffects.filter(e => e.id !== id);
          rerender(root, state);
          return;
        }

        if (action === "clear-selected-effects") {
          state.selectedEffects = [];
          rerender(root, state);
          return;
        }

        if (action === "open-custom-builder") {
          await openCustomBuilderDialog(state, root);
          return;
        }

        if (action === "apply-selected") {
          await applySelected(root, state);
          return;
        }
      } catch (e) {
        err("UI action failed.", {
          action,
          error: e
        });

        updateOutput(root, state, {
          ok: false,
          action,
          error: compactError(e)
        });
      } finally {
        btn.disabled = false;
      }
    });
  }

  // --------------------------------------------------------------------------
  // State boot
  // --------------------------------------------------------------------------

  function createInitialState() {
    const fn = getPart("state.createInitialState");

    if (typeof fn === "function") {
      return fn({
        services: makeServices()
      });
    }

    return {
      targetRows: [],
      targetActorUuids: [],
      targetSourceLabel: "",

      registryEntries: [],
      fieldEntries: [],

      selectedEffects: [],

      categoryFilter: "All",
      search: "",

      duplicateMode: "skip",
      overrideDuration: true,
      durationRounds: 3,
      durationTurns: 0,
      silent: false,

      customName: "Custom Active Effect",
      customCategory: "Buff",
      customIcon: "icons/svg/aura.svg",
      customStatuses: "",
      customDescription: "",
      customRows: [{
        id: randomId("mod"),
        key: "",
        mode: modeValue("ADD"),
        value: "1",
        priority: 20
      }],

      outputText: ""
    };
  }

  async function bootState(state) {
    const injectStyle = getPart("styles.injectStyle");

    if (typeof injectStyle === "function") {
      injectStyle({ services: makeServices() });
    }

    const reloadTargets = getPart("targets.reloadTargets");

    try {
      if (typeof reloadTargets === "function") {
        await reloadTargets(state, { services: makeServices() });
      }
    } catch (e) {
      warn("Initial target load failed.", e);
      state.targetSourceLabel = `Target load failed: ${compactError(e)}`;
    }

    try {
      await refreshRegistry(state, { includeCompendiums: false });
    } catch (e) {
      warn("Initial registry refresh failed.", e);
      state.outputText = JSON.stringify({
        registryRefreshFailed: compactError(e)
      }, null, 2);
    }

    try {
      await refreshFields(state);
    } catch (e) {
      warn("Initial field catalogue refresh failed.", e);
    }

    return state;
  }

  // --------------------------------------------------------------------------
  // Main open function
  // --------------------------------------------------------------------------

  async function open(options = {}) {
    if (!game.user?.isGM) {
      ui.notifications?.warn?.("Active Effect Manager UI is GM-only.");
      return null;
    }

    const missingReport = makeMissingPartsReport();

    if (!missingReport.ok) {
      if (CFG.fallbackToLegacyUi && LEGACY_UI_API?.open && LEGACY_UI_API !== api) {
        log("Missing modular uiParts. Falling back to legacy UI.", missingReport);
        return await LEGACY_UI_API.open(options);
      }

      reportMissingPartsToUser(missingReport);
      return null;
    }

    if (ACTIVE_DIALOG) {
      try {
        ACTIVE_DIALOG.bringToTop?.();
        return ACTIVE_DIALOG;
      } catch (_e) {}
    }

    const state = createInitialState();
    await bootState(state);

    const dialog = new Dialog({
      title: CFG.dialogTitle,
      content: `
        <div data-aem-root-holder>
          ${renderMainContent(state)}
        </div>
      `,
      buttons: {
        close: {
          label: "Close"
        }
      },
      default: "close",
      render: (html) => {
        const root = normalizeHtmlRoot(html);
        if (!root) return;

        const holder = root.querySelector("[data-aem-root-holder]");
        if (!holder) return;

        const eventBinder = getPart("events.bindMainDialogEvents");

        if (typeof eventBinder === "function") {
          eventBinder({
            root,
            holder,
            state,
            core: api,
            parts: getUiPartsRoot(),
            services: makeServices()
          });
        } else {
          bindFallbackMainDialogEvents({
            root,
            holder,
            state
          });
        }
      },
      close: () => {
        ACTIVE_DIALOG = null;
      }
    }, {
      width: CFG.width,
      height: CFG.height,
      resizable: CFG.resizable
    });

    ACTIVE_DIALOG = dialog;
    dialog.render(true);

    return dialog;
  }

  function reopen(options = {}) {
    try {
      ACTIVE_DIALOG?.close?.();
    } catch (_e) {}

    ACTIVE_DIALOG = null;
    return open(options);
  }

  async function reloadTargetsPublic(stateOrOptions = {}) {
    const reloadTargets = getPart("targets.reloadTargets");

    if (typeof reloadTargets !== "function") {
      return {
        ok: false,
        reason: "targets_reload_api_not_found",
        hint: "Load ActiveEffectManager-ui-targets.js."
      };
    }

    return await reloadTargets(stateOrOptions, {
      services: makeServices()
    });
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  const api = {
    [CORE_MARKER]: true,
    version: "0.5.0-core",

    open,
    reopen,
    getActiveDialog: () => ACTIVE_DIALOG,
    reloadTargets: reloadTargetsPublic,

    getMissingRequiredParts,
    makeMissingPartsReport,
    getLegacyUiApi: () => LEGACY_UI_API,

    config: CFG,

    services: makeServices,

    _internal: {
      createInitialState,
      bootState,
      bindFallbackMainDialogEvents,
      refreshRegistry,
      refreshFields,
      findRegistryEntry,
      addSelectedRegistryEffect,
      removeSelectedRegistryEffect,
      applySelected,
      openCustomBuilderDialog
    }
  };

  exposeApi(api);

  Hooks.once("ready", () => {
    exposeApi(api);

    const report = makeMissingPartsReport();

    log("Ready. Active Effect Manager UI Core installed.", {
      open: "FUCompanion.api.activeEffectManager.ui.open()",
      modularReady: report.ok,
      missing: report.missing?.map?.(m => m.file) ?? []
    });
  });
})();