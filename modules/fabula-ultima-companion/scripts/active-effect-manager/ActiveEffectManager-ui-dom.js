// ============================================================================
// ActiveEffectManager-ui-dom.js
// Foundry VTT V12 — Fabula Ultima Companion
//
// Purpose:
// - DOM update helper module for the modular Active Effect Manager UI.
// - Owns only small UI refresh operations:
//     1. full content rerender
//     2. effect registry list-only rerender
//     3. selected target visual refresh without replacing token images/videos
//     4. selected effects list-only refresh
//     5. debug output update
//
// Public API:
//   FUCompanion.api.activeEffectManager.uiParts.dom.rerender(root, state)
//   FUCompanion.api.activeEffectManager.uiParts.dom.rerenderEffectListOnly(root, state)
//   FUCompanion.api.activeEffectManager.uiParts.dom.updateTargetSelectionDom(root, state)
//   FUCompanion.api.activeEffectManager.uiParts.dom.updateOutput(root, state, data)
//
// Load order:
// - Load after ActiveEffectManager-ui-render.js.
// - Load before ActiveEffectManager-ui-core.js.
// ============================================================================

(() => {
  const MODULE_ID = "fabula-ultima-companion";
  const TAG = "[ONI][ActiveEffectManager:UI:DOM]";
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
    const root = ensureApiRoot();
    const parts = ensureUiPartsRoot();

    parts.dom = api;

    // Friendly alias for console testing.
    root.uiDom = api;

    try {
      const mod = game.modules?.get?.(MODULE_ID);

      if (mod) {
        mod.api = mod.api || {};
        mod.api.activeEffectManager = mod.api.activeEffectManager || {};
        mod.api.activeEffectManager.uiParts =
          mod.api.activeEffectManager.uiParts || {};

        mod.api.activeEffectManager.uiParts.dom = api;
        mod.api.activeEffectManager.uiDom = api;
      }
    } catch (e) {
      warn("Could not expose DOM API on module object.", e);
    }
  }

  function getRenderApi() {
    return globalThis.FUCompanion?.api?.activeEffectManager?.uiParts?.render ?? null;
  }

  function getStateApi() {
    return globalThis.FUCompanion?.api?.activeEffectManager?.uiParts?.state ?? null;
  }

  // --------------------------------------------------------------------------
  // Small helpers
  // --------------------------------------------------------------------------

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

  function normalizeHtmlRoot(htmlOrElement) {
    if (!htmlOrElement) return null;
    if (htmlOrElement instanceof HTMLElement) return htmlOrElement;
    if (htmlOrElement[0] instanceof HTMLElement) return htmlOrElement[0];
    if (htmlOrElement.element instanceof HTMLElement) return htmlOrElement.element;
    if (htmlOrElement.element?.[0] instanceof HTMLElement) return htmlOrElement.element[0];
    return null;
  }

  function dataToText(data) {
    if (typeof data === "string") return data;

    try {
      return JSON.stringify(data, null, 2);
    } catch (_e) {
      return String(data ?? "");
    }
  }

  function getHolder(root) {
    return root?.querySelector?.("[data-aem-root-holder]") ?? null;
  }

  function getRenderMainContent(options = {}) {
    if (typeof options.renderMainContent === "function") {
      return options.renderMainContent;
    }

    const render = getRenderApi();

    if (typeof render?.renderMainContent === "function") {
      return render.renderMainContent;
    }

    return null;
  }

  // --------------------------------------------------------------------------
  // Full rerender
  // --------------------------------------------------------------------------

  function rerender(root, state, options = {}) {
    const holder = getHolder(root);

    if (!holder) {
      warn("Could not rerender Active Effect Manager UI: root holder missing.");
      return {
        ok: false,
        reason: "root_holder_missing"
      };
    }

    const renderMainContent = getRenderMainContent(options);

    if (typeof renderMainContent !== "function") {
      warn("Could not rerender Active Effect Manager UI: renderMainContent missing.");
      return {
        ok: false,
        reason: "render_main_content_missing"
      };
    }

    holder.innerHTML = renderMainContent(state, options);

    return {
      ok: true,
      mode: "full_rerender"
    };
  }

  // --------------------------------------------------------------------------
  // Output/debug area update
  // --------------------------------------------------------------------------

  function updateOutput(root, state, data) {
    const text = dataToText(data);

    if (state) {
      state.outputText = text;
    }

    const out = root?.querySelector?.("[data-aem-output]");

    if (out) {
      out.value = text;
    }

    return {
      ok: true,
      text
    };
  }

  function clearOutput(root, state) {
    return updateOutput(root, state, "");
  }

  // --------------------------------------------------------------------------
  // Effect registry list-only rerender
  // --------------------------------------------------------------------------

  function rerenderEffectListOnly(root, state, options = {}) {
    const list = root?.querySelector?.("[data-aem-effect-list]");

    if (!list) {
      return rerender(root, state, options);
    }

    const render = getRenderApi();
    const effectListHtml = options.effectListHtml ?? render?.effectListHtml;

    if (typeof effectListHtml !== "function") {
      return rerender(root, state, options);
    }

    list.innerHTML = effectListHtml(state, options);
    list.scrollTop = 0;

    return {
      ok: true,
      mode: "effect_list_only"
    };
  }

  // --------------------------------------------------------------------------
  // Selected effects list-only rerender
  // --------------------------------------------------------------------------

  function rerenderSelectedEffectsOnly(root, state, options = {}) {
    const list = root?.querySelector?.("[data-aem-selected-list]");

    if (!list) {
      return rerender(root, state, options);
    }

    const render = getRenderApi();
    const selectedEffectsHtml = options.selectedEffectsHtml ?? render?.selectedEffectsHtml;

    if (typeof selectedEffectsHtml !== "function") {
      return rerender(root, state, options);
    }

    list.innerHTML = selectedEffectsHtml(state, options);

    return {
      ok: true,
      mode: "selected_effects_only"
    };
  }

  // --------------------------------------------------------------------------
  // Target visual-only update
  // --------------------------------------------------------------------------
  // This is intentionally NOT a full rerender.
  // It only toggles selected classes/checkmarks and updates the counter.
  // That avoids blinking animated token portraits/videos.
  // --------------------------------------------------------------------------

  function updateTargetSelectionDom(root, state) {
    if (!root || !state) {
      return {
        ok: false,
        reason: "missing_root_or_state"
      };
    }

    const selected = new Set(asArray(state.targetActorUuids).filter(Boolean));

    for (const card of root.querySelectorAll?.("[data-aem-target-card]") ?? []) {
      const uuid = card.dataset.targetActorUuid;
      const isSelected = selected.has(uuid);

      card.classList.toggle("selected", isSelected);
      card.setAttribute("aria-pressed", isSelected ? "true" : "false");

      const input = card.querySelector('input[name="targetActorUuids"]');
      if (input) input.checked = isSelected;
    }

    updateTargetCountDom(root, selected.size);

    return {
      ok: true,
      mode: "target_selection_only",
      selectedCount: selected.size
    };
  }

  function updateTargetCountDom(root, count) {
    const n = Number(count) || 0;

    const countEl = root?.querySelector?.("[data-aem-selected-target-count]");
    if (countEl) countEl.textContent = String(n);

    const pluralEl = root?.querySelector?.("[data-aem-selected-target-plural]");
    if (pluralEl) pluralEl.textContent = n === 1 ? "" : "s";

    return {
      ok: true,
      count: n
    };
  }

  function updateTargetSourceLabelDom(root, state) {
    const summary = root?.querySelector?.(".aem-target-summary");
    if (!summary) {
      return {
        ok: false,
        reason: "target_summary_missing"
      };
    }

    const selectedCount = asArray(state?.targetActorUuids).filter(Boolean).length;
    const label = safeString(
      state?.targetSourceLabel,
      "Target list loaded automatically."
    );

    summary.innerHTML = `
      <b data-aem-selected-target-count>${selectedCount}</b>
      target<span data-aem-selected-target-plural>${selectedCount === 1 ? "" : "s"}</span> selected.
      <br>${escapeHtml(label)}
    `;

    return {
      ok: true,
      selectedCount
    };
  }

  // --------------------------------------------------------------------------
  // Target grid rerender
  // --------------------------------------------------------------------------
  // Use this only when the actual target rows changed.
  // For normal checkbox clicks, use updateTargetSelectionDom instead.
  // --------------------------------------------------------------------------

  function rerenderTargetGridOnly(root, state, options = {}) {
    const grid = root?.querySelector?.("[data-aem-target-grid]");

    if (!grid) {
      return rerender(root, state, options);
    }

    const render = getRenderApi();
    const targetCardsHtml = options.targetCardsHtml ?? render?.targetCardsHtml;

    if (typeof targetCardsHtml !== "function") {
      return rerender(root, state, options);
    }

    grid.innerHTML = targetCardsHtml(state, options);
    updateTargetCountDom(root, asArray(state?.targetActorUuids).filter(Boolean).length);

    return {
      ok: true,
      mode: "target_grid_only"
    };
  }

  // --------------------------------------------------------------------------
  // Form/DOM helpers
  // --------------------------------------------------------------------------

  function getCheckedTargetActorUuids(root) {
    return Array.from(
      root?.querySelectorAll?.('[name="targetActorUuids"]:checked') ?? []
    )
      .map(el => el.value)
      .filter(Boolean);
  }

  function syncStateFromTargetDom(root, state) {
    if (!state) {
      return {
        ok: false,
        reason: "missing_state"
      };
    }

    const stateApi = getStateApi();

    if (typeof stateApi?.setTargetActorUuids === "function") {
      stateApi.setTargetActorUuids(state, getCheckedTargetActorUuids(root));
    } else {
      state.targetActorUuids = getCheckedTargetActorUuids(root);

      const selected = new Set(state.targetActorUuids);
      state.targetRows = asArray(state.targetRows).map(row => ({
        ...row,
        selected: selected.has(row.actorUuid)
      }));
    }

    return {
      ok: true,
      targetActorUuids: state.targetActorUuids
    };
  }

  function focusSearch(root) {
    const input = root?.querySelector?.('[name="effectSearch"]');

    try {
      input?.focus?.();
      input?.select?.();
    } catch (_e) {}

    return !!input;
  }

  function scrollEffectListTop(root) {
    const list = root?.querySelector?.("[data-aem-effect-list]");
    if (list) list.scrollTop = 0;
    return !!list;
  }

  // --------------------------------------------------------------------------
  // Local escape helper for target summary label refresh
  // --------------------------------------------------------------------------

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  const api = {
    version: "0.1.0",

    normalizeHtmlRoot,

    rerender,
    updateOutput,
    clearOutput,

    rerenderEffectListOnly,
    rerenderSelectedEffectsOnly,

    updateTargetSelectionDom,
    updateTargetCountDom,
    updateTargetSourceLabelDom,
    rerenderTargetGridOnly,

    getCheckedTargetActorUuids,
    syncStateFromTargetDom,

    focusSearch,
    scrollEffectListTop,

    _internal: {
      safeString,
      asArray,
      dataToText,
      getHolder,
      getRenderApi,
      getStateApi,
      getRenderMainContent,
      escapeHtml
    }
  };

  exposeApi(api);

  Hooks.once("ready", () => {
    exposeApi(api);

    log("Ready. Active Effect Manager UI DOM module installed.", {
      api: "FUCompanion.api.activeEffectManager.uiParts.dom"
    });
  });
})();