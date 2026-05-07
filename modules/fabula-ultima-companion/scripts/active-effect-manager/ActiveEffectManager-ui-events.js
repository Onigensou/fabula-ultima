// ============================================================================
// ActiveEffectManager-ui-events.js
// Foundry VTT V12 — Fabula Ultima Companion
//
// Purpose:
// - Event binding helper module for the modular Active Effect Manager UI.
// - Owns only user interaction routing:
//     1. search input
//     2. target selection
//     3. category tabs
//     4. queue / unqueue effects
//     5. right-click removal
//     6. refresh / debug buttons
//     7. custom builder launch
//     8. apply selected effects
//
// Public API:
//   FUCompanion.api.activeEffectManager.uiParts.events.bindMainDialogEvents(...)
//
// Load order:
// - Load after ActiveEffectManager-ui-dom.js.
// - Load before ActiveEffectManager-ui-core.js.
// ============================================================================

(() => {
  const MODULE_ID = "fabula-ultima-companion";
  const TAG = "[ONI][ActiveEffectManager:UI:Events]";
  const DEBUG = true;

  const log = (...a) => DEBUG && console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);
  const err = (...a) => console.error(TAG, ...a);

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
    const root = ensureApiRoot();
    const parts = ensureUiPartsRoot();

    parts.events = api;

    // Friendly alias for console testing.
    root.uiEvents = api;

    try {
      const mod = game.modules?.get?.(MODULE_ID);

      if (mod) {
        mod.api = mod.api || {};
        mod.api.activeEffectManager = mod.api.activeEffectManager || {};
        mod.api.activeEffectManager.uiParts =
          mod.api.activeEffectManager.uiParts || {};

        mod.api.activeEffectManager.uiParts.events = api;
        mod.api.activeEffectManager.uiEvents = api;
      }
    } catch (e) {
      warn("Could not expose Events API on module object.", e);
    }
  }

  function getParts() {
    return globalThis.FUCompanion?.api?.activeEffectManager?.uiParts ?? {};
  }

  function getStateApi() {
    return getParts()?.state ?? null;
  }

  function getDomApi() {
    return getParts()?.dom ?? null;
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

  // --------------------------------------------------------------------------
  // Small helpers
  // --------------------------------------------------------------------------

  function safeString(value, fallback = "") {
    const s = String(value ?? "").trim();
    return s.length ? s : fallback;
  }

  function compactError(e) {
    return String(e?.message ?? e);
  }

  function asArray(value) {
    if (Array.isArray(value)) return value;
    if (value == null) return [];
    if (value instanceof Set) return Array.from(value);
    return [value];
  }

  function getService(ctx, key) {
    return ctx?.services?.[key] ?? null;
  }

  function callService(ctx, key, ...args) {
    const fn = getService(ctx, key);
    if (typeof fn !== "function") return undefined;
    return fn(...args);
  }

  function readCommonStateFromDom(ctx) {
    const fn = getService(ctx, "readCommonStateFromDom");
    const stateApi = getStateApi();

    if (typeof fn === "function") {
      return fn(ctx.root, ctx.state);
    }

    if (typeof stateApi?.readCommonStateFromDom === "function") {
      return stateApi.readCommonStateFromDom(ctx.root, ctx.state, {
        services: ctx.services
      });
    }

    return ctx.state;
  }

  function updateOutput(ctx, data) {
    const dom = getDomApi();

    if (typeof dom?.updateOutput === "function") {
      return dom.updateOutput(ctx.root, ctx.state, data);
    }

    return callService(ctx, "updateOutput", ctx.root, ctx.state, data);
  }

  function rerender(ctx) {
    const dom = getDomApi();

    if (typeof dom?.rerender === "function") {
      return dom.rerender(ctx.root, ctx.state, {
        services: ctx.services
      });
    }

    return callService(ctx, "rerender", ctx.root, ctx.state);
  }

  function rerenderEffectListOnly(ctx) {
    const dom = getDomApi();

    if (typeof dom?.rerenderEffectListOnly === "function") {
      return dom.rerenderEffectListOnly(ctx.root, ctx.state, {
        services: ctx.services
      });
    }

    return rerender(ctx);
  }

  function rerenderSelectedEffectsOnly(ctx) {
    const dom = getDomApi();

    if (typeof dom?.rerenderSelectedEffectsOnly === "function") {
      return dom.rerenderSelectedEffectsOnly(ctx.root, ctx.state, {
        services: ctx.services
      });
    }

    return rerender(ctx);
  }

  function updateTargetSelectionDom(ctx) {
    const dom = getDomApi();

    if (typeof dom?.updateTargetSelectionDom === "function") {
      return dom.updateTargetSelectionDom(ctx.root, ctx.state);
    }

    return callService(ctx, "updateTargetSelectionDom", ctx.root, ctx.state);
  }

  function refreshFieldsQuietly(ctx) {
    const fn = getService(ctx, "refreshFieldsQuietly");

    if (typeof fn === "function") {
      return fn(ctx.state);
    }

    const refreshFields = getService(ctx, "refreshFields");

    if (typeof refreshFields === "function") {
      refreshFields(ctx.state).catch(e => {
        warn("Quiet field refresh failed.", e);
      });
    }
  }

  function findRegistryEntry(ctx, registryId) {
    const fn = getService(ctx, "findRegistryEntry");

    if (typeof fn === "function") {
      return fn(ctx.state, registryId);
    }

    return asArray(ctx.state?.registryEntries)
      .find(e => String(e.registryId) === String(registryId)) ?? null;
  }

  function addSelectedRegistryEffect(ctx, entry) {
    const fn = getService(ctx, "addSelectedRegistryEffect");

    if (typeof fn === "function") {
      return fn(ctx.state, entry);
    }

    if (!entry) return null;

    const stateApi = getStateApi();

    if (typeof stateApi?.addSelectedEffect === "function") {
      return stateApi.addSelectedEffect(ctx.state, {
        kind: "registry",
        registryId: entry.registryId,
        name: entry.name,
        img: entry.img || entry.icon || "icons/svg/aura.svg",
        category: entry.category || "Other"
      });
    }

    ctx.state.selectedEffects ??= [];
    ctx.state.selectedEffects.push({
      id: `selected-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: "registry",
      registryId: entry.registryId,
      name: entry.name,
      img: entry.img || entry.icon || "icons/svg/aura.svg",
      category: entry.category || "Other"
    });

    return true;
  }

  function removeSelectedRegistryEffect(ctx, entry) {
    const fn = getService(ctx, "removeSelectedRegistryEffect");

    if (typeof fn === "function") {
      return fn(ctx.state, entry);
    }

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

    for (let i = ctx.state.selectedEffects.length - 1; i >= 0; i--) {
      const selected = ctx.state.selectedEffects[i];

      if (
        selected.kind === "registry" &&
        String(selected.registryId ?? "") === registryId
      ) {
        index = i;
        break;
      }
    }

    if (index < 0) {
      for (let i = ctx.state.selectedEffects.length - 1; i >= 0; i--) {
        const selected = ctx.state.selectedEffects[i];

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

    const [removed] = ctx.state.selectedEffects.splice(index, 1);

    return {
      ok: true,
      removed
    };
  }

  function removeSelectedEffectById(ctx, selectedId) {
    const stateApi = getStateApi();

    if (typeof stateApi?.removeSelectedEffectById === "function") {
      return stateApi.removeSelectedEffectById(ctx.state, selectedId);
    }

    const id = safeString(selectedId);
    const before = asArray(ctx.state.selectedEffects);
    const removed = before.find(e => String(e.id) === id) ?? null;

    ctx.state.selectedEffects = before.filter(e => String(e.id) !== id);

    return removed;
  }

  function clearSelectedEffects(ctx) {
    const stateApi = getStateApi();

    if (typeof stateApi?.clearSelectedEffects === "function") {
      return stateApi.clearSelectedEffects(ctx.state);
    }

    ctx.state.selectedEffects = [];
    return ctx.state;
  }

  function setCategoryFilter(ctx, category) {
    const stateApi = getStateApi();

    if (typeof stateApi?.setCategoryFilter === "function") {
      return stateApi.setCategoryFilter(ctx.state, category);
    }

    ctx.state.categoryFilter = safeString(category, "All");
    return ctx.state;
  }

  function setBusy(el, busy = true) {
    if (!el) return;

    try {
      el.disabled = !!busy;
      el.classList?.toggle?.("busy", !!busy);
      el.setAttribute?.("aria-busy", busy ? "true" : "false");
    } catch (_e) {}
  }

  // --------------------------------------------------------------------------
  // Visual-only DOM updates
  // --------------------------------------------------------------------------

  function updateCategoryTabsDom(ctx) {
    const current = safeString(ctx.state.categoryFilter, "All");

    for (const btn of ctx.root.querySelectorAll?.('[data-aem-action="set-category"]') ?? []) {
      const category = safeString(btn.dataset.category, "All");
      btn.classList.toggle("active", category === current);
    }

    return {
      ok: true,
      category: current
    };
  }

  function showInfo(message) {
    try {
      ui.notifications?.info?.(message);
    } catch (_e) {}
  }

  function showWarn(message) {
    try {
      ui.notifications?.warn?.(message);
    } catch (_e) {}
  }

  // --------------------------------------------------------------------------
  // Input / change handlers
  // --------------------------------------------------------------------------

  function handleInput(ev, ctx) {
    const target = ev.target;
    if (!target) return;

    readCommonStateFromDom(ctx);

    if (target.name === "effectSearch") {
      rerenderEffectListOnly(ctx);
    }
  }

  async function handleChange(ev, ctx) {
    const target = ev.target;
    if (!target) return;

    readCommonStateFromDom(ctx);

    if (target.name === "targetActorUuids") {
      updateTargetSelectionDom(ctx);
      refreshFieldsQuietly(ctx);
      return;
    }

    // Apply options changed. No rerender needed.
    if (
      target.name === "duplicateMode" ||
      target.name === "durationRounds" ||
      target.name === "durationTurns" ||
      target.name === "overrideDuration" ||
      target.name === "silent"
    ) {
      return;
    }
  }

  // --------------------------------------------------------------------------
  // Right-click handlers
  // --------------------------------------------------------------------------

  function handleContextMenu(ev, ctx) {
    const selectedBadge = ev.target.closest?.("[data-aem-selected-effect]");
    const registryRow = ev.target.closest?.("[data-aem-registry-row]");

    if (!selectedBadge && !registryRow) return;

    ev.preventDefault();
    ev.stopPropagation();

    readCommonStateFromDom(ctx);

    if (selectedBadge) {
      const id = selectedBadge.dataset.selectedId;
      const removed = removeSelectedEffectById(ctx, id);

      if (!removed) {
        showInfo("That effect is no longer queued.");
      }

      rerenderSelectedEffectsOnly(ctx);
      return;
    }

    const entry = findRegistryEntry(ctx, registryRow.dataset.registryId);
    const result = removeSelectedRegistryEffect(ctx, entry);

    if (!result?.ok) {
      showInfo(`${entry?.name ?? "Effect"} is not currently queued.`);
      return;
    }

    rerenderSelectedEffectsOnly(ctx);
  }

  // --------------------------------------------------------------------------
  // Click action handlers
  // --------------------------------------------------------------------------

  async function handleSetCategory(btn, ctx) {
    setCategoryFilter(ctx, btn.dataset.category || "All");
    updateCategoryTabsDom(ctx);
    rerenderEffectListOnly(ctx);
  }

  async function handleRefreshRegistry(_btn, ctx, { includeCompendiums = false } = {}) {
    const refreshRegistry = getService(ctx, "refreshRegistry");

    if (typeof refreshRegistry !== "function") {
      updateOutput(ctx, {
        ok: false,
        reason: "refresh_registry_service_missing"
      });
      return;
    }

    const result = await refreshRegistry(ctx.state, {
      includeCompendiums
    });

    updateOutput(ctx, result);
    rerenderEffectListOnly(ctx);
  }

  async function handleDebugRegistry(_btn, ctx) {
    const registry = getRegistryApi();

    const report =
      registry?.getLastReport?.() ??
      registry?.report ??
      {
        ok: false,
        reason: "registry_api_not_found"
      };

    console.groupCollapsed(`${TAG} Registry Debug`);
    console.log(report);
    console.groupEnd();

    updateOutput(ctx, report);
  }

  async function handleAddRegistryEffect(btn, ctx) {
    const entry = findRegistryEntry(ctx, btn.dataset.registryId);

    if (!entry) {
      showWarn("Could not find that registry effect. Try Refresh.");
      updateOutput(ctx, {
        ok: false,
        reason: "registry_entry_not_found",
        registryId: btn.dataset.registryId
      });
      return;
    }

    addSelectedRegistryEffect(ctx, entry);
    rerenderSelectedEffectsOnly(ctx);
  }

  async function handleRemoveSelectedEffect(btn, ctx) {
    const id = btn.dataset.selectedId;
    removeSelectedEffectById(ctx, id);
    rerenderSelectedEffectsOnly(ctx);
  }

  async function handleClearSelectedEffects(_btn, ctx) {
    clearSelectedEffects(ctx);
    rerenderSelectedEffectsOnly(ctx);
  }

  async function handleOpenCustomBuilder(_btn, ctx) {
    const openCustomBuilderDialog = getService(ctx, "openCustomBuilderDialog");

    if (typeof openCustomBuilderDialog !== "function") {
      updateOutput(ctx, {
        ok: false,
        reason: "open_custom_builder_service_missing"
      });

      showWarn("Active Effect Manager: custom builder service missing.");
      return;
    }

    await openCustomBuilderDialog(ctx.state, ctx.root);
  }

  async function handleApplySelected(_btn, ctx) {
    const applySelected = getService(ctx, "applySelected");

    if (typeof applySelected !== "function") {
      updateOutput(ctx, {
        ok: false,
        reason: "apply_selected_service_missing"
      });

      showWarn("Active Effect Manager: apply service missing.");
      return;
    }

    await applySelected(ctx.root, ctx.state);
  }

  async function handleClick(ev, ctx) {
    const btn = ev.target.closest?.("[data-aem-action]");
    if (!btn) return;

    ev.preventDefault();
    ev.stopPropagation();

    const action = btn.dataset.aemAction;

    try {
      setBusy(btn, true);
      readCommonStateFromDom(ctx);

      if (action === "set-category") {
        await handleSetCategory(btn, ctx);
        return;
      }

      if (action === "refresh-registry") {
        await handleRefreshRegistry(btn, ctx, {
          includeCompendiums: false
        });
        return;
      }

      if (action === "refresh-registry-compendiums") {
        await handleRefreshRegistry(btn, ctx, {
          includeCompendiums: true
        });
        return;
      }

      if (action === "debug-registry") {
        await handleDebugRegistry(btn, ctx);
        return;
      }

      if (action === "add-registry-effect") {
        await handleAddRegistryEffect(btn, ctx);
        return;
      }

      if (action === "remove-selected-effect") {
        await handleRemoveSelectedEffect(btn, ctx);
        return;
      }

      if (action === "clear-selected-effects") {
        await handleClearSelectedEffects(btn, ctx);
        return;
      }

      if (action === "open-custom-builder") {
        await handleOpenCustomBuilder(btn, ctx);
        return;
      }

      if (action === "apply-selected") {
        await handleApplySelected(btn, ctx);
        return;
      }

      updateOutput(ctx, {
        ok: false,
        reason: "unknown_ui_action",
        action
      });
    } catch (e) {
      err("UI action failed.", {
        action,
        error: e
      });

      updateOutput(ctx, {
        ok: false,
        action,
        error: compactError(e)
      });

      showWarn("Active Effect Manager: action failed. Check console.");
    } finally {
      // If a rerender removed the button from DOM, this safely does nothing useful.
      if (btn?.isConnected) setBusy(btn, false);
    }
  }

  // --------------------------------------------------------------------------
  // Main binder
  // --------------------------------------------------------------------------

  function bindMainDialogEvents(input = {}) {
    const root = input.root;
    const holder = input.holder ?? root?.querySelector?.("[data-aem-root-holder]");
    const state = input.state;

    if (!root || !holder || !state) {
      warn("bindMainDialogEvents missing root/holder/state.", {
        hasRoot: !!root,
        hasHolder: !!holder,
        hasState: !!state
      });

      return {
        ok: false,
        reason: "missing_root_holder_or_state"
      };
    }

    if (holder.__oniAemEventsBound) {
      return {
        ok: true,
        skipped: true,
        reason: "already_bound"
      };
    }

    const ctx = {
      root,
      holder,
      state,
      core: input.core ?? null,
      parts: input.parts ?? getParts(),
      services: input.services ?? {}
    };

    holder.__oniAemEventsBound = true;
    holder.__oniAemEventsContext = ctx;

    holder.addEventListener("input", ev => handleInput(ev, ctx));
    holder.addEventListener("change", ev => {
      handleChange(ev, ctx).catch(e => {
        err("Change handler failed.", e);

        updateOutput(ctx, {
          ok: false,
          reason: "change_handler_failed",
          error: compactError(e)
        });
      });
    });

    holder.addEventListener("contextmenu", ev => handleContextMenu(ev, ctx));
    holder.addEventListener("click", ev => {
      handleClick(ev, ctx).catch(e => {
        err("Click handler failed.", e);

        updateOutput(ctx, {
          ok: false,
          reason: "click_handler_failed",
          error: compactError(e)
        });
      });
    });

    log("Bound main dialog events.", {
      holder,
      selectedTargets: state.targetActorUuids?.length ?? 0,
      selectedEffects: state.selectedEffects?.length ?? 0
    });

    return {
      ok: true,
      bound: true
    };
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  const api = {
    version: "0.1.0",

    bindMainDialogEvents,

    handleInput,
    handleChange,
    handleContextMenu,
    handleClick,

    updateCategoryTabsDom,

    _internal: {
      safeString,
      compactError,
      asArray,
      getParts,
      getStateApi,
      getDomApi,
      getRegistryApi,
      readCommonStateFromDom,
      updateOutput,
      rerender,
      rerenderEffectListOnly,
      rerenderSelectedEffectsOnly,
      updateTargetSelectionDom,
      findRegistryEntry,
      addSelectedRegistryEffect,
      removeSelectedRegistryEffect,
      removeSelectedEffectById,
      clearSelectedEffects,
      setCategoryFilter
    }
  };

  exposeApi(api);

  Hooks.once("ready", () => {
    exposeApi(api);

    log("Ready. Active Effect Manager UI Events module installed.", {
      api: "FUCompanion.api.activeEffectManager.uiParts.events"
    });
  });
})();