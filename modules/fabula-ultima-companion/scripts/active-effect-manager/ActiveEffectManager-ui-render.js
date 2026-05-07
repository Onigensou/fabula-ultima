// ============================================================================
// ActiveEffectManager-ui-render.js
// Foundry VTT V12 — Fabula Ultima Companion
//
// Purpose:
// - Render helper module for the modular Active Effect Manager UI.
// - Owns only HTML generation.
// - Does NOT load targets.
// - Does NOT apply effects.
// - Does NOT bind events.
// - Does NOT inject CSS.
//
// Public API:
//   FUCompanion.api.activeEffectManager.uiParts.render.renderMainContent(state)
//   FUCompanion.api.activeEffectManager.uiParts.render.effectListHtml(state)
//   FUCompanion.api.activeEffectManager.uiParts.render.targetCardsHtml(state)
//   FUCompanion.api.activeEffectManager.uiParts.render.selectedEffectsHtml(state)
//
// Load order:
// - Load after ActiveEffectManager-ui-targets.js.
// - Load before ActiveEffectManager-ui-core.js.
// ============================================================================

(() => {
  const MODULE_ID = "fabula-ultima-companion";
  const TAG = "[ONI][ActiveEffectManager:UI:Render]";
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

    parts.render = api;

    // Friendly alias for console testing.
    root.uiRender = api;

    try {
      const mod = game.modules?.get?.(MODULE_ID);

      if (mod) {
        mod.api = mod.api || {};
        mod.api.activeEffectManager = mod.api.activeEffectManager || {};
        mod.api.activeEffectManager.uiParts =
          mod.api.activeEffectManager.uiParts || {};

        mod.api.activeEffectManager.uiParts.render = api;
        mod.api.activeEffectManager.uiRender = api;
      }
    } catch (e) {
      warn("Could not expose render API on module object.", e);
    }
  }

  function getTargetsApi() {
    return globalThis.FUCompanion?.api?.activeEffectManager?.uiParts?.targets ?? null;
  }

  // --------------------------------------------------------------------------
  // Small helpers
  // --------------------------------------------------------------------------

  function safeString(value, fallback = "") {
    const s = String(value ?? "").trim();
    return s.length ? s : fallback;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function asArray(value) {
    if (Array.isArray(value)) return value;
    if (value == null) return [];
    if (value instanceof Set) return Array.from(value);
    return [value];
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

  function randomId(prefix = "aem") {
    const id =
      foundry?.utils?.randomID?.(8) ??
      Math.random().toString(36).slice(2, 10);

    return `${prefix}-${id}`;
  }

  function shortSource(entry = {}) {
    return [entry.sourceType, entry.sourceName]
      .filter(Boolean)
      .join(" • ");
  }

  function getService(options, key) {
    return options?.services?.[key] ?? null;
  }

  function getModeValue(options) {
    const serviceModeValue = getService(options, "modeValue");
    return typeof serviceModeValue === "function"
      ? serviceModeValue
      : modeValue;
  }

  function targetIconMediaHtml(row = {}) {
    const targets = getTargetsApi();

    if (typeof targets?.targetIconMediaHtml === "function") {
      return targets.targetIconMediaHtml(row);
    }

    const src = row.img || "icons/svg/mystery-man.svg";
    const safeSrc = escapeHtml(src);
    const safeName = escapeHtml(row.actorName || "Target");

    return `
      <img
        class="aem-target-img aem-target-image"
        src="${safeSrc}"
        title="${safeName}"
        alt=""
        draggable="false"
      >
    `;
  }

  // --------------------------------------------------------------------------
  // Shared HTML helpers
  // --------------------------------------------------------------------------

  function categoryButtonHtml(category, label, state) {
    const active = state.categoryFilter === category ? "active" : "";

    return `
      <button
        type="button"
        class="${active}"
        data-aem-action="set-category"
        data-category="${escapeHtml(category)}"
      >${escapeHtml(label)}</button>
    `;
  }

  function modeOptionsHtml(selected = modeValue("ADD"), options = {}) {
    const getMode = getModeValue(options);

    const modes = [
      ["CUSTOM", getMode("CUSTOM")],
      ["MULTIPLY", getMode("MULTIPLY")],
      ["ADD", getMode("ADD")],
      ["DOWNGRADE", getMode("DOWNGRADE")],
      ["UPGRADE", getMode("UPGRADE")],
      ["OVERRIDE", getMode("OVERRIDE")]
    ];

    return modes.map(([label, value]) => {
      const sel = Number(selected) === Number(value) ? "selected" : "";
      return `<option value="${Number(value)}" ${sel}>${escapeHtml(label)} (${Number(value)})</option>`;
    }).join("");
  }

  // --------------------------------------------------------------------------
  // Target panel
  // --------------------------------------------------------------------------

  function targetCardsHtml(state) {
    const rows = asArray(state.targetRows);

    if (!rows.length) {
      return `<div class="aem-empty">No available targets found.</div>`;
    }

    return rows.map(row => {
      const checked = row.selected ? "checked" : "";
      const selected = row.selected ? "selected" : "";

      // For selected scene tokens, row.note is the token name.
      // This helps distinguish enemies using the same actor art.
      const tokenName = safeString(row.note, row.actorName || "Target");
      const actorName = safeString(row.actorName, tokenName);
      const source = safeString(row.source, "");

      const tooltipSub = tokenName !== actorName
        ? actorName
        : source;

      const titleText = tooltipSub
        ? `${tokenName} — ${tooltipSub}`
        : tokenName;

      return `
        <label
          class="aem-target-card ${selected}"
          data-aem-target-card
          data-target-actor-uuid="${escapeHtml(row.actorUuid)}"
          title="${escapeHtml(titleText)}"
          aria-label="${escapeHtml(titleText)}"
        >
          <input
            type="checkbox"
            name="targetActorUuids"
            value="${escapeHtml(row.actorUuid)}"
            ${checked}
          >

          <div class="aem-target-img-wrap">
            ${targetIconMediaHtml(row)}
          </div>

          <span class="aem-target-tooltip">
            ${escapeHtml(tokenName)}
            ${tooltipSub ? `<small>${escapeHtml(tooltipSub)}</small>` : ""}
          </span>
        </label>
      `;
    }).join("");
  }

  function targetPanelHtml(state) {
    const selectedCount = asArray(state.targetActorUuids).filter(Boolean).length;

    return `
      <div class="aem-card">
        <h3>Targets</h3>

        <div class="aem-target-summary">
          <b data-aem-selected-target-count>${selectedCount}</b>
          target<span data-aem-selected-target-plural>${selectedCount === 1 ? "" : "s"}</span> selected.
          <br>${escapeHtml(state.targetSourceLabel || "Target list loaded automatically.")}
        </div>

        <div class="aem-target-grid" data-aem-target-grid>
          ${targetCardsHtml(state)}
        </div>

        <div class="aem-mini">
          Select one or more token icons. Selected scene token actors are included automatically when the window opens.
          If you change token selection later, close and reopen this UI to refresh the list.
        </div>
      </div>
    `;
  }

  // --------------------------------------------------------------------------
  // Effect registry
  // --------------------------------------------------------------------------

  function effectMatchesSearch(entry = {}, query = "") {
    const q = String(query ?? "").trim().toLowerCase();
    if (!q) return true;

    const text = [
      entry.name,
      entry.category,
      entry.sourceType,
      entry.sourceName,
      ...(entry.tags ?? []),
      ...(entry.statuses ?? [])
    ].join(" ").toLowerCase();

    return text.includes(q);
  }

  function getFilteredRegistryRows(state) {
    const q = String(state.search ?? "").trim().toLowerCase();
    const cat = state.categoryFilter;

    let rows = asArray(state.registryEntries);

    if (cat && cat !== "All") {
      rows = rows.filter(entry => entry.category === cat);
    }

    if (q) {
      rows = rows.filter(entry => effectMatchesSearch(entry, q));
    }

    return rows.slice(0, 120);
  }

  function effectListHtml(state) {
    const rows = getFilteredRegistryRows(state);

    if (!rows.length) {
      return `<div class="aem-empty">No effects found.</div>`;
    }

    return rows.map(entry => {
      const img = entry.img || entry.icon || "icons/svg/aura.svg";
      const category = entry.category || "Other";
      const source = shortSource(entry);

      return `
        <div
          class="aem-effect-row"
          data-aem-action="add-registry-effect"
          data-aem-registry-row="1"
          data-registry-id="${escapeHtml(entry.registryId)}"
          title="Left-click to add. Right-click to remove one queued copy."
        >
          <img class="aem-icon" src="${escapeHtml(img)}">
          <div>
            <div class="aem-effect-name">${escapeHtml(entry.name)}</div>
            <div class="aem-effect-meta">
              ${escapeHtml(category)}${source ? " • " + escapeHtml(source) : ""}
            </div>
          </div>
        </div>
      `;
    }).join("");
  }

  function registryPanelHtml(state) {
    return `
      <div class="aem-card">
        <h3>Effect Registry</h3>

        <label>Search</label>
        <input
          type="text"
          name="effectSearch"
          value="${escapeHtml(state.search)}"
          placeholder="Search effect name, source, tag..."
        >

        <div class="aem-category-tabs">
          ${categoryButtonHtml("All", "All", state)}
          ${categoryButtonHtml("Buff", "Buff", state)}
          ${categoryButtonHtml("Debuff", "Debuff", state)}
          ${categoryButtonHtml("Other", "Other", state)}
        </div>

        <div class="aem-effect-list" data-aem-effect-list>
          ${effectListHtml(state)}
        </div>

        <div class="aem-builder-launch">
          <button type="button" data-aem-action="open-custom-builder">
            Open Custom Effect Builder
          </button>
        </div>

        <div class="aem-mini" style="margin-top:6px;">
          Left-click an effect to queue it. Right-click an effect to remove one queued copy.
        </div>
      </div>
    `;
  }

  // --------------------------------------------------------------------------
  // Selected effect queue
  // --------------------------------------------------------------------------

  function selectedEffectsHtml(state) {
    const selectedEffects = asArray(state.selectedEffects);

    if (!selectedEffects.length) {
      return `<div class="aem-empty">No selected effects yet.</div>`;
    }

    return selectedEffects.map(sel => {
      const img = sel.img || "icons/svg/aura.svg";
      const kind = sel.kind === "custom" ? "Custom" : "Preset";

      return `
        <span
          class="aem-pill"
          title="${escapeHtml(kind)} — right-click to remove"
          data-aem-selected-effect="1"
          data-selected-id="${escapeHtml(sel.id)}"
        >
          <img src="${escapeHtml(img)}">
          <b>${escapeHtml(sel.name)}</b>
          <small>${escapeHtml(sel.category || "Other")}</small>
          <button
            type="button"
            data-aem-action="remove-selected-effect"
            data-selected-id="${escapeHtml(sel.id)}"
          >×</button>
        </span>
      `;
    }).join("");
  }

  function selectedEffectsPanelHtml(state) {
    return `
      <div class="aem-card">
        <h3>Selected Effects</h3>

        <div class="aem-selected-list" data-aem-selected-list>
          ${selectedEffectsHtml(state)}
        </div>

        <div class="aem-actions" style="margin-top:6px;">
          <button type="button" data-aem-action="apply-selected">Apply Selected</button>
          <button type="button" data-aem-action="clear-selected-effects">Clear Effects</button>
        </div>
      </div>
    `;
  }

  // --------------------------------------------------------------------------
  // Apply options
  // --------------------------------------------------------------------------

  function renderApplyOptionsDetails(state) {
    return `
      <div class="aem-card aem-apply-compact">
        <details class="aem-apply-details">
          <summary>Apply Options</summary>

          <div class="aem-apply-details-body">
            <div class="aem-apply-grid">
              <div>
                <div class="aem-inline-label">Duplicate</div>
                <select name="duplicateMode">
                  <option value="skip" ${state.duplicateMode === "skip" ? "selected" : ""}>Skip existing</option>
                  <option value="replace" ${state.duplicateMode === "replace" ? "selected" : ""}>Replace existing</option>
                  <option value="stack" ${state.duplicateMode === "stack" ? "selected" : ""}>Stack duplicate</option>
                  <option value="remove" ${state.duplicateMode === "remove" ? "selected" : ""}>Remove instead</option>
                  <option value="ask" ${state.duplicateMode === "ask" ? "selected" : ""}>Ask each time</option>
                </select>
              </div>

              <div>
                <div class="aem-inline-label">Duration</div>
                <div class="aem-duration-mini">
                  <input
                    type="number"
                    name="durationRounds"
                    value="${escapeHtml(state.durationRounds)}"
                    title="Rounds"
                    placeholder="Rounds"
                  >
                  <input
                    type="number"
                    name="durationTurns"
                    value="${escapeHtml(state.durationTurns)}"
                    title="Turns"
                    placeholder="Turns"
                  >
                </div>
              </div>
            </div>

            <div class="aem-toggle-row">
              <label class="aem-toggle-pill">
                <input
                  type="checkbox"
                  name="overrideDuration"
                  ${state.overrideDuration ? "checked" : ""}
                >
                Override Duration
              </label>

              <label class="aem-toggle-pill">
                <input
                  type="checkbox"
                  name="silent"
                  ${state.silent ? "checked" : ""}
                >
                Silent
              </label>
            </div>

            <div class="aem-apply-details-note">
              These are advanced options. Default behavior is usually fine for normal use.
            </div>
          </div>
        </details>
      </div>
    `;
  }

  // --------------------------------------------------------------------------
  // Debug panel
  // --------------------------------------------------------------------------

  function debugPanelHtml(state) {
    return `
      <div class="aem-card">
        <details class="aem-debug">
          <summary>Debug</summary>

          <div class="aem-debug-inner">
            <div class="aem-actions-3">
              <button type="button" data-aem-action="refresh-registry">Refresh</button>
              <button type="button" data-aem-action="refresh-registry-compendiums">Refresh + Compendiums</button>
              <button type="button" data-aem-action="debug-registry">Debug</button>
            </div>

            <label style="margin-top:8px;">Output</label>
            <textarea
              class="aem-output"
              readonly
              data-aem-output
            >${escapeHtml(state.outputText || "")}</textarea>
          </div>
        </details>
      </div>
    `;
  }

  // --------------------------------------------------------------------------
  // Optional custom builder render helpers
  // These are not used by the main core yet, but keeping them here makes the
  // next native-builder extraction easier.
  // --------------------------------------------------------------------------

  function fieldDatalistHtml(entries = []) {
    return `
      <datalist id="aem-field-key-list-builder">
        ${asArray(entries).map(entry => {
          const label = `${entry.label || entry.key} — ${entry.category || "Other"} — ${entry.valueKind || "unknown"}`;

          return `
            <option
              value="${escapeHtml(entry.activeEffectKey || entry.key)}"
              label="${escapeHtml(label)}"
            ></option>
          `;
        }).join("")}
      </datalist>
    `;
  }

  function modifierRowsHtml(rows = [], options = {}) {
    const getMode = getModeValue(options);

    const safeRows = asArray(rows).length
      ? asArray(rows)
      : [{
          id: randomId("mod"),
          key: "",
          mode: getMode("ADD"),
          value: "1",
          priority: 20
        }];

    return safeRows.map(row => `
      <div class="aem-mod-row" data-mod-row-id="${escapeHtml(row.id)}">
        <div>
          <label>Key</label>
          <input
            type="text"
            name="customChangeKey"
            list="aem-field-key-list-builder"
            value="${escapeHtml(row.key)}"
            data-row-field="key"
            placeholder="damage_receiving_mod_all"
          >
        </div>

        <div>
          <label>Mode</label>
          <select name="customChangeMode" data-row-field="mode">
            ${modeOptionsHtml(row.mode, options)}
          </select>
        </div>

        <div>
          <label>Value</label>
          <input
            type="text"
            name="customChangeValue"
            value="${escapeHtml(row.value)}"
            data-row-field="value"
            placeholder="1"
          >
        </div>

        <div>
          <label>Priority</label>
          <input
            type="number"
            name="customChangePriority"
            value="${escapeHtml(row.priority)}"
            data-row-field="priority"
          >
        </div>

        <button
          type="button"
          title="Remove row"
          data-aem-builder-action="remove-modifier-row"
          data-row-id="${escapeHtml(row.id)}"
        >×</button>
      </div>
    `).join("");
  }

  // --------------------------------------------------------------------------
  // Main layout
  // --------------------------------------------------------------------------

  function renderMainContent(state, options = {}) {
    return `
      <div class="oni-aem">
        <div class="aem-grid-main">
          <div>
            ${targetPanelHtml(state)}
            ${selectedEffectsPanelHtml(state)}
            ${renderApplyOptionsDetails(state)}
          </div>

          <div>
            ${registryPanelHtml(state)}
          </div>
        </div>

        ${debugPanelHtml(state)}
      </div>
    `;
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  const api = {
    version: "0.1.0",

    renderMainContent,

    targetPanelHtml,
    targetCardsHtml,

    registryPanelHtml,
    effectListHtml,
    getFilteredRegistryRows,
    effectMatchesSearch,

    selectedEffectsPanelHtml,
    selectedEffectsHtml,

    renderApplyOptionsDetails,
    debugPanelHtml,

    categoryButtonHtml,
    modeOptionsHtml,

    fieldDatalistHtml,
    modifierRowsHtml,

    _internal: {
      safeString,
      escapeHtml,
      asArray,
      modeValue,
      randomId,
      shortSource,
      targetIconMediaHtml
    }
  };

  exposeApi(api);

  Hooks.once("ready", () => {
    exposeApi(api);

    log("Ready. Active Effect Manager UI Render module installed.", {
      api: "FUCompanion.api.activeEffectManager.uiParts.render"
    });
  });
})();