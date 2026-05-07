// ============================================================================
// ActiveEffectManager-custom-builder.js
// Foundry VTT V12 — Fabula Ultima Companion
//
// Purpose:
// - Central reusable builder for custom ActiveEffect data.
// - Builds marker effects and modifier effects.
// - Uses field catalogue suggestions when available.
// - Does NOT apply effects by default.
// - Does NOT touch legacy condition booleans like isSlow/isDazed.
// - Designed so future UI/scripts can call one shared builder instead of
//   duplicating custom ActiveEffect construction logic.
//
// Public API:
//   FUCompanion.api.activeEffectManager.customBuilder.buildMarkerEffect(input)
//   FUCompanion.api.activeEffectManager.customBuilder.buildModifierEffect(input)
//   FUCompanion.api.activeEffectManager.customBuilder.buildChangeRow(input)
//   FUCompanion.api.activeEffectManager.customBuilder.buildChangeFromField(key, overrides)
//   FUCompanion.api.activeEffectManager.customBuilder.validateEffectData(effectData)
//   FUCompanion.api.activeEffectManager.customBuilder.preview(effectData)
//   FUCompanion.api.activeEffectManager.customBuilder.open(options)
//
// Console examples:
//
// Marker only:
//   FUCompanion.api.activeEffectManager.customBuilder.buildMarkerEffect({
//     name: "Bleed",
//     category: "Debuff",
//     statuses: ["bleed"],
//     duration: { rounds: 3, turns: 0 }
//   });
//
// Modifier:
//   FUCompanion.api.activeEffectManager.customBuilder.buildModifierEffect({
//     name: "Defense Boost",
//     category: "Buff",
//     changes: [
//       { key: "defense", mode: CONST.ACTIVE_EFFECT_MODES.ADD, value: "2", priority: 20 }
//     ],
//     duration: { rounds: 3, turns: 0 }
//   });
//
// Build from field catalogue:
//   await FUCompanion.api.activeEffectManager.customBuilder.buildChangeFromField(
//     "damage_receiving_mod_all",
//     { value: "3" }
//   );
//
// Open standalone builder:
//   await FUCompanion.api.activeEffectManager.customBuilder.open();
// ============================================================================

(() => {
  const MODULE_ID = "fabula-ultima-companion";
  const TAG = "[ONI][ActiveEffectManager:CustomBuilder]";
  const DEBUG = true;

  const STYLE_ID = "oni-active-effect-manager-custom-builder-style";

  const log = (...a) => DEBUG && console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);
  const err = (...a) => console.error(TAG, ...a);

  const DEFAULT_MARKER_ICON = "icons/svg/aura.svg";

  const LEGACY_CONDITION_KEYS = new Set([
    "isSlow",
    "isDazed",
    "isWeak",
    "isShaken",
    "isEnraged",
    "isPoisoned",
    "isSwift",
    "isAwake",
    "isStrong",
    "isFocus",
    "isClarity",
    "isEnergized"
  ]);

  const DEFAULT_OPTIONS = {
    name: "Custom Active Effect",
    img: DEFAULT_MARKER_ICON,
    category: "Other",
    description: "",
    statuses: [],
    duration: {
      rounds: 3,
      turns: 0
    },
    disabled: false,
    transfer: false,
    origin: null,
    changes: []
  };

  // --------------------------------------------------------------------------
  // API root
  // --------------------------------------------------------------------------

  function ensureApiRoot() {
    globalThis.FUCompanion = globalThis.FUCompanion || {};
    globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
    globalThis.FUCompanion.api.activeEffectManager = globalThis.FUCompanion.api.activeEffectManager || {};
    return globalThis.FUCompanion.api.activeEffectManager;
  }

  function exposeApi(api) {
    const root = ensureApiRoot();
    root.customBuilder = api;
    root.builder = api;

    try {
      const mod = game.modules?.get?.(MODULE_ID);
      if (mod) {
        mod.api = mod.api || {};
        mod.api.activeEffectManager = mod.api.activeEffectManager || {};
        mod.api.activeEffectManager.customBuilder = api;
        mod.api.activeEffectManager.builder = api;
      }
    } catch (e) {
      warn("Could not expose custom builder API on module object.", e);
    }
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

  function getManagerApi() {
    return globalThis.FUCompanion?.api?.activeEffectManager ?? null;
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

  function uniq(values) {
    return Array.from(
      new Set(
        asArray(values)
          .filter(v => v != null && String(v).trim() !== "")
          .map(String)
      )
    );
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function randomId(prefix = "aem-builder") {
    const id =
      foundry?.utils?.randomID?.(8) ??
      Math.random().toString(36).slice(2, 10);

    return `${prefix}-${id}`;
  }

  function normalizeHtmlRoot(htmlOrElement) {
    if (!htmlOrElement) return null;
    if (htmlOrElement instanceof HTMLElement) return htmlOrElement;
    if (htmlOrElement[0] instanceof HTMLElement) return htmlOrElement[0];
    if (htmlOrElement.element instanceof HTMLElement) return htmlOrElement.element;
    if (htmlOrElement.element?.[0] instanceof HTMLElement) return htmlOrElement.element[0];
    return null;
  }

  function getModeValue(name) {
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

  function getModeName(value) {
    const n = Number(value);
    const modes = CONST?.ACTIVE_EFFECT_MODES ?? {};

    for (const [k, v] of Object.entries(modes)) {
      if (Number(v) === n) return k;
    }

    const fallback = {
      0: "CUSTOM",
      1: "MULTIPLY",
      2: "ADD",
      3: "DOWNGRADE",
      4: "UPGRADE",
      5: "OVERRIDE"
    };

    return fallback[n] ?? String(value);
  }

  function parseCommaList(value) {
    return String(value ?? "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);
  }

  function normalizeDuration(duration = {}) {
    if (!duration || typeof duration !== "object") return {};

    const out = clone(duration, {});

    for (const key of ["rounds", "turns", "seconds", "startRound", "startTurn"]) {
      if (out[key] === "" || out[key] == null) {
        delete out[key];
        continue;
      }

      const n = Number(out[key]);
      if (Number.isFinite(n)) out[key] = n;
    }

    return out;
  }

  function normalizeCategory(category) {
    const c = safeString(category, "Other");

    if (/^buff$/i.test(c)) return "Buff";
    if (/^debuff$/i.test(c)) return "Debuff";
    return "Other";
  }

  function deleteUnsafeCreateFields(effectData) {
    if (!effectData || typeof effectData !== "object") return effectData;

    delete effectData._id;
    delete effectData.id;
    delete effectData.folder;
    delete effectData.sort;
    delete effectData.ownership;
    delete effectData._stats;

    return effectData;
  }

  function mergeObject(target, source) {
    if (!source || typeof source !== "object") return clone(target, {});

    try {
      return foundry.utils.mergeObject(clone(target, {}), clone(source, {}), {
        inplace: false,
        recursive: true,
        insertKeys: true,
        insertValues: true,
        overwrite: true
      });
    } catch (_e) {
      return {
        ...(clone(target, {}) ?? {}),
        ...(clone(source, {}) ?? {})
      };
    }
  }

  function compactError(e) {
    return String(e?.message ?? e);
  }

  // --------------------------------------------------------------------------
  // Change row builders
  // --------------------------------------------------------------------------

  function isLegacyConditionKey(key) {
    return LEGACY_CONDITION_KEYS.has(String(key ?? ""));
  }

  function buildChangeRow(input = {}) {
    const key = safeString(input.key ?? input.activeEffectKey);

    if (!key) {
      return {
        ok: false,
        reason: "missing_key",
        change: null
      };
    }

    if (isLegacyConditionKey(key) && input.allowLegacyConditionKey !== true) {
      return {
        ok: false,
        reason: "legacy_condition_key_blocked",
        key,
        hint: "This system applies real ActiveEffect documents instead of legacy isSlow/isDazed-style booleans.",
        change: null
      };
    }

    const mode = Number(input.mode ?? getModeValue("ADD"));
    const priority = Number(input.priority ?? 20);

    const change = {
      key,
      mode: Number.isFinite(mode) ? mode : getModeValue("ADD"),
      value: String(input.value ?? ""),
      priority: Number.isFinite(priority) ? priority : 20
    };

    return {
      ok: true,
      change,
      modeName: getModeName(change.mode)
    };
  }

  function normalizeChangeRows(rows = [], options = {}) {
    const changes = [];
    const rejected = [];

    for (const row of asArray(rows)) {
      const result = buildChangeRow({
        ...row,
        allowLegacyConditionKey: options.allowLegacyConditionKey === true
      });

      if (result.ok) {
        changes.push(result.change);
      } else {
        rejected.push({
          input: clone(row, {}),
          reason: result.reason,
          hint: result.hint ?? null
        });
      }
    }

    return {
      ok: rejected.length === 0,
      changes,
      rejected
    };
  }

  async function buildChangeFromField(key, overrides = {}) {
    const catalogue = getFieldCatalogueApi();

    if (!catalogue) {
      return buildChangeRow({
        key,
        mode: overrides.mode ?? getModeValue("ADD"),
        value: overrides.value ?? "1",
        priority: overrides.priority ?? 20
      });
    }

    try {
      if (catalogue.buildChangePreview) {
        const preview = catalogue.buildChangePreview(key, overrides);

        if (preview?.ok && preview.change) {
          return {
            ok: true,
            change: preview.change,
            entry: preview.entry ?? null,
            modeName: preview.change.modeName ?? getModeName(preview.change.mode)
          };
        }
      }

      const entry = catalogue.getByKey?.(key, { cloneResult: false });

      if (entry) {
        const rec = entry.recommendedChange ?? {};

        return buildChangeRow({
          key: entry.activeEffectKey ?? entry.key,
          mode: overrides.mode ?? rec.mode ?? getModeValue("ADD"),
          value: overrides.value ?? rec.value ?? "1",
          priority: overrides.priority ?? rec.priority ?? 20
        });
      }
    } catch (e) {
      warn("buildChangeFromField failed through field catalogue, using fallback.", e);
    }

    return buildChangeRow({
      key,
      mode: overrides.mode ?? getModeValue("ADD"),
      value: overrides.value ?? "1",
      priority: overrides.priority ?? 20
    });
  }

  // --------------------------------------------------------------------------
  // Effect data builders
  // --------------------------------------------------------------------------

  function stampBuilderFlags(effectData, options = {}) {
    const category = normalizeCategory(options.category ?? effectData?.category);

    effectData.flags = effectData.flags || {};
    effectData.flags[MODULE_ID] = effectData.flags[MODULE_ID] || {};

    effectData.flags[MODULE_ID] = mergeObject(effectData.flags[MODULE_ID], {
      category,
      customActiveEffect: true,
      activeEffectManager: {
        managed: true,
        custom: true,
        sourceCategory: category,
        createdFromCustomBuilder: true,
        createdAt: nowIso(),
        builderVersion: api.version
      }
    });

    return effectData;
  }

  function buildBaseEffectData(input = {}) {
    const category = normalizeCategory(input.category ?? DEFAULT_OPTIONS.category);

    const name = safeString(input.name, DEFAULT_OPTIONS.name);
    const img = safeString(input.img ?? input.icon, DEFAULT_OPTIONS.img);

    const duration = normalizeDuration(input.duration ?? DEFAULT_OPTIONS.duration);

    const effectData = {
      name,
      label: name,
      img,
      icon: img,

      disabled: !!(input.disabled ?? DEFAULT_OPTIONS.disabled),
      transfer: !!(input.transfer ?? DEFAULT_OPTIONS.transfer),

      description: safeString(input.description, ""),

      changes: [],
      statuses: uniq(input.statuses ?? input.statusIds ?? []),

      duration,

      origin: input.origin ?? null,

      flags: clone(input.flags ?? {}, {})
    };

    stampBuilderFlags(effectData, {
      category
    });

    deleteUnsafeCreateFields(effectData);

    return effectData;
  }

  function buildMarkerEffect(input = {}) {
    const effectData = buildBaseEffectData({
      ...DEFAULT_OPTIONS,
      ...input,
      changes: []
    });

    effectData.changes = [];

    const validation = validateEffectData(effectData, {
      allowNoChanges: true
    });

    return {
      ok: validation.ok,
      type: "marker",
      category: normalizeCategory(input.category),
      effectData,
      validation
    };
  }

  function buildModifierEffect(input = {}) {
    const normalized = normalizeChangeRows(input.changes ?? input.modifierRows ?? [], {
      allowLegacyConditionKey: input.allowLegacyConditionKey === true
    });

    const effectData = buildBaseEffectData({
      ...DEFAULT_OPTIONS,
      ...input
    });

    effectData.changes = normalized.changes;

    const validation = validateEffectData(effectData, {
      allowNoChanges: false
    });

    return {
      ok: normalized.ok && validation.ok,
      type: "modifier",
      category: normalizeCategory(input.category),
      effectData,
      rejectedChanges: normalized.rejected,
      validation
    };
  }

  async function buildModifierEffectFromFields(input = {}) {
    const rows = [];

    for (const row of asArray(input.fields ?? input.rows ?? [])) {
      const key = safeString(row.key ?? row.activeEffectKey);
      if (!key) continue;

      const built = await buildChangeFromField(key, row);

      if (built.ok && built.change) {
        rows.push(built.change);
      }
    }

    return buildModifierEffect({
      ...input,
      changes: rows
    });
  }

  function buildEffect(input = {}) {
    const type = safeString(input.type ?? input.kind, "modifier").toLowerCase();

    if (type === "marker") return buildMarkerEffect(input);
    return buildModifierEffect(input);
  }

  // --------------------------------------------------------------------------
  // Validation / preview
  // --------------------------------------------------------------------------

  function validateEffectData(effectData = {}, options = {}) {
    const errors = [];
    const warnings = [];

    const name = safeString(effectData.name ?? effectData.label);
    if (!name) errors.push("Effect name is required.");

    const img = safeString(effectData.img ?? effectData.icon);
    if (!img) warnings.push("No icon/image provided. Foundry will still allow it, but UI may look plain.");

    if (!Array.isArray(effectData.changes)) {
      errors.push("effectData.changes must be an array.");
    }

    if (!Array.isArray(effectData.statuses)) {
      warnings.push("effectData.statuses should be an array. It will be normalized by the API.");
    }

    const changes = asArray(effectData.changes);

    if (!options.allowNoChanges && changes.length === 0) {
      errors.push("Modifier effect needs at least one change row. Use marker effect if you want an effect with no stat changes.");
    }

    for (const [i, change] of changes.entries()) {
      if (!safeString(change?.key)) {
        errors.push(`Change row ${i + 1} is missing a key.`);
      }

      if (isLegacyConditionKey(change?.key) && options.allowLegacyConditionKey !== true) {
        errors.push(`Change row ${i + 1} uses blocked legacy condition key: ${change.key}`);
      }

      const mode = Number(change?.mode);
      if (!Number.isFinite(mode)) {
        errors.push(`Change row ${i + 1} has invalid mode.`);
      }

      const priority = Number(change?.priority);
      if (!Number.isFinite(priority)) {
        warnings.push(`Change row ${i + 1} has invalid priority. The API may normalize it.`);
      }
    }

    return {
      ok: errors.length === 0,
      errors,
      warnings
    };
  }

  function makeCreateSnippet(effectData = {}) {
    return `// actor must be an Actor document.
const effectData = ${JSON.stringify(effectData, null, 2)};

await actor.createEmbeddedDocuments("ActiveEffect", [effectData]);`;
  }

  function makeManagerApplySnippet(effectData = {}, actorUuids = []) {
    return `await FUCompanion.api.activeEffectManager.applyEffects({
  actorUuids: ${JSON.stringify(actorUuids, null, 2)},
  effects: [{
    effectData: ${JSON.stringify(effectData, null, 2)}
  }],
  duplicateMode: "replace"
});`;
  }

  function preview(effectData = {}, options = {}) {
    const validation = validateEffectData(effectData, {
      allowNoChanges: options.allowNoChanges ?? true
    });

    const report = {
      ok: validation.ok,
      kind: "custom_active_effect_preview",
      validation,
      effectData: clone(effectData, {}),
      createEmbeddedDocumentsSnippet: makeCreateSnippet(effectData),
      managerApplySnippet: makeManagerApplySnippet(effectData, options.actorUuids ?? [])
    };

    console.groupCollapsed(`${TAG} Preview`);
    console.log(report);
    console.groupEnd();

    return report;
  }

  async function openNativeUnsavedSheet(effectData = {}, actorUuid = null) {
    const EffectClass = CONFIG?.ActiveEffect?.documentClass ?? globalThis.ActiveEffect;

    if (!EffectClass) {
      return {
        ok: false,
        reason: "active_effect_class_not_found"
      };
    }

    let actor = null;

    if (actorUuid) {
      try {
        const doc = await fromUuid(actorUuid);
        actor = doc?.documentName === "Actor" ? doc : doc?.actor ?? null;
      } catch (_e) {}
    }

    const effect = new EffectClass(clone(effectData, {}), {
      parent: actor ?? null
    });

    try {
      effect.sheet?.render?.(true);

      return {
        ok: true,
        actorUuid: actor?.uuid ?? null,
        effectName: effectData.name ?? effectData.label ?? null
      };
    } catch (e) {
      return {
        ok: false,
        reason: "sheet_render_failed",
        error: compactError(e)
      };
    }
  }

  // --------------------------------------------------------------------------
  // Standalone builder dialog
  // --------------------------------------------------------------------------

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .oni-aem-builder {
        color: #16130e;
        font-family: var(--font-primary);
      }

      .oni-aem-builder * {
        box-sizing: border-box;
      }

      .oni-aem-builder .card {
        background: rgba(255,255,255,.72);
        border: 1px solid rgba(60,45,25,.22);
        border-radius: 9px;
        padding: 8px;
        margin-bottom: 8px;
      }

      .oni-aem-builder h3 {
        margin: 0 0 7px;
        padding-bottom: 4px;
        border-bottom: 1px solid rgba(60,45,25,.22);
        font-size: 14px;
      }

      .oni-aem-builder label {
        display: block;
        margin-top: 5px;
        font-weight: 700;
        font-size: 12px;
      }

      .oni-aem-builder input,
      .oni-aem-builder select,
      .oni-aem-builder textarea {
        width: 100%;
      }

      .oni-aem-builder .grid2 {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }

      .oni-aem-builder .actions {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 6px;
      }

      .oni-aem-builder .actions3 {
        display: grid;
        grid-template-columns: 1fr 1fr 1fr;
        gap: 6px;
      }

      .oni-aem-builder .mod-row {
        display: grid;
        grid-template-columns: 1.3fr .75fr .75fr .55fr 28px;
        gap: 5px;
        align-items: end;
        margin-bottom: 5px;
      }

      .oni-aem-builder .output {
        width: 100%;
        min-height: 160px;
        font-family: monospace;
        font-size: 11px;
        color: #111;
        background: rgba(255,255,255,.9);
      }

      .oni-aem-builder .hint {
        font-size: 11px;
        opacity: .75;
        line-height: 1.25;
      }

      .oni-aem-builder .warning {
        background: rgba(120, 55, 0, .12);
        border: 1px solid rgba(120, 55, 0, .25);
        padding: 6px;
        border-radius: 7px;
        font-size: 11px;
      }
    `;

    document.head.appendChild(style);
  }

  function modeOptionsHtml(selected = getModeValue("ADD")) {
    const rows = [
      ["CUSTOM", getModeValue("CUSTOM")],
      ["MULTIPLY", getModeValue("MULTIPLY")],
      ["ADD", getModeValue("ADD")],
      ["DOWNGRADE", getModeValue("DOWNGRADE")],
      ["UPGRADE", getModeValue("UPGRADE")],
      ["OVERRIDE", getModeValue("OVERRIDE")]
    ];

    return rows.map(([label, value]) => {
      const sel = Number(selected) === Number(value) ? "selected" : "";
      return `<option value="${Number(value)}" ${sel}>${escapeHtml(label)} (${Number(value)})</option>`;
    }).join("");
  }

  function getActorOptionsHtml(selectedActorUuids = []) {
    const selected = new Set(selectedActorUuids);

    const actors = Array.from(game.actors ?? [])
      .filter(actor => {
        try {
          return game.user?.isGM || actor.testUserPermission?.(game.user, "OWNER");
        } catch (_e) {
          return false;
        }
      })
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));

    return actors.map(actor => {
      const sel = selected.has(actor.uuid) ? "selected" : "";
      return `<option value="${escapeHtml(actor.uuid)}" ${sel}>${escapeHtml(actor.name)} — ${escapeHtml(actor.uuid)}</option>`;
    }).join("");
  }

  function getSelectedTokenActorUuids() {
    return uniq(
      Array.from(canvas?.tokens?.controlled ?? [])
        .map(t => t.actor?.uuid)
        .filter(Boolean)
    );
  }

  function fieldDatalistHtml(fieldEntries = []) {
    return `
      <datalist id="aem-builder-field-list">
        ${fieldEntries.map(entry => {
          const key = entry.activeEffectKey ?? entry.key;
          const label = `${entry.label ?? key} — ${entry.category ?? "Other"} — ${entry.valueKind ?? "unknown"}`;
          return `<option value="${escapeHtml(key)}" label="${escapeHtml(label)}"></option>`;
        }).join("")}
      </datalist>
    `;
  }

  function modifierRowsHtml(rows = []) {
    return rows.map(row => `
      <div class="mod-row" data-builder-row-id="${escapeHtml(row.id)}">
        <div>
          <label>Key</label>
          <input type="text" list="aem-builder-field-list" data-row-field="key" value="${escapeHtml(row.key)}" placeholder="defense">
        </div>

        <div>
          <label>Mode</label>
          <select data-row-field="mode">
            ${modeOptionsHtml(row.mode)}
          </select>
        </div>

        <div>
          <label>Value</label>
          <input type="text" data-row-field="value" value="${escapeHtml(row.value)}" placeholder="1">
        </div>

        <div>
          <label>Priority</label>
          <input type="number" data-row-field="priority" value="${escapeHtml(row.priority)}">
        </div>

        <button type="button" data-builder-action="remove-row" data-row-id="${escapeHtml(row.id)}">×</button>
      </div>
    `).join("");
  }

  function renderDialogContent(state) {
    return `
      <div class="oni-aem-builder">
        ${fieldDatalistHtml(state.fieldEntries)}

        <div class="card">
          <h3>Target Actors</h3>
          <div class="actions">
            <button type="button" data-builder-action="use-selected-tokens">Use Selected Tokens</button>
            <button type="button" data-builder-action="refresh-fields">Refresh Field Suggestions</button>
          </div>

          <label>Actors</label>
          <select name="actorUuids" multiple>
            ${getActorOptionsHtml(state.actorUuids)}
          </select>

          <div class="hint">
            Targets are only used if you press Apply. Preview/build does not modify actors.
          </div>
        </div>

        <div class="card">
          <h3>Effect Identity</h3>

          <div class="grid2">
            <div>
              <label>Type</label>
              <select name="effectType">
                <option value="marker" ${state.effectType === "marker" ? "selected" : ""}>Marker Effect — no stat changes</option>
                <option value="modifier" ${state.effectType === "modifier" ? "selected" : ""}>Modifier Effect — has changes[]</option>
              </select>

              <label>Name</label>
              <input type="text" name="name" value="${escapeHtml(state.name)}">

              <label>Icon</label>
              <input type="text" name="img" value="${escapeHtml(state.img)}">
            </div>

            <div>
              <label>Category</label>
              <select name="category">
                <option value="Buff" ${state.category === "Buff" ? "selected" : ""}>Buff</option>
                <option value="Debuff" ${state.category === "Debuff" ? "selected" : ""}>Debuff</option>
                <option value="Other" ${state.category === "Other" ? "selected" : ""}>Other</option>
              </select>

              <label>Status IDs / Marker Tags</label>
              <input type="text" name="statuses" value="${escapeHtml(state.statuses)}" placeholder="comma-separated">

              <div class="grid2">
                <div>
                  <label>Rounds</label>
                  <input type="number" name="rounds" value="${escapeHtml(state.rounds)}">
                </div>
                <div>
                  <label>Turns</label>
                  <input type="number" name="turns" value="${escapeHtml(state.turns)}">
                </div>
              </div>
            </div>
          </div>

          <label>Description</label>
          <textarea name="description" rows="2">${escapeHtml(state.description)}</textarea>
        </div>

        <div class="card">
          <h3>Modifier Rows</h3>

          <div data-builder-rows>
            ${modifierRowsHtml(state.rows)}
          </div>

          <div class="actions3">
            <button type="button" data-builder-action="add-row">Add Row</button>
            <button type="button" data-builder-action="preview">Preview</button>
            <button type="button" data-builder-action="open-native-sheet">Open Native Sheet</button>
          </div>

          <div class="warning" style="margin-top:6px;">
            Legacy condition keys like <code>isSlow</code> and <code>isDazed</code> are blocked. Use real Active Effects for conditions.
          </div>
        </div>

        <div class="card">
          <h3>Actions</h3>
          <div class="actions">
            <button type="button" data-builder-action="apply">Apply to Selected Actors</button>
            <button type="button" data-builder-action="copy">Copy Output</button>
          </div>
        </div>

        <div class="card">
          <h3>Output</h3>
          <textarea class="output" readonly data-builder-output>${escapeHtml(state.outputText)}</textarea>
        </div>
      </div>
    `;
  }

  function readState(root, state) {
    state.actorUuids = Array.from(root.querySelector('[name="actorUuids"]')?.selectedOptions ?? [])
      .map(o => o.value)
      .filter(Boolean);

    state.effectType = root.querySelector('[name="effectType"]')?.value ?? state.effectType;
    state.name = root.querySelector('[name="name"]')?.value ?? state.name;
    state.img = root.querySelector('[name="img"]')?.value ?? state.img;
    state.category = root.querySelector('[name="category"]')?.value ?? state.category;
    state.statuses = root.querySelector('[name="statuses"]')?.value ?? state.statuses;
    state.rounds = root.querySelector('[name="rounds"]')?.value ?? state.rounds;
    state.turns = root.querySelector('[name="turns"]')?.value ?? state.turns;
    state.description = root.querySelector('[name="description"]')?.value ?? state.description;

    state.rows = Array.from(root.querySelectorAll("[data-builder-row-id]")).map(row => ({
      id: row.dataset.builderRowId || randomId("row"),
      key: row.querySelector('[data-row-field="key"]')?.value ?? "",
      mode: Number(row.querySelector('[data-row-field="mode"]')?.value ?? getModeValue("ADD")),
      value: row.querySelector('[data-row-field="value"]')?.value ?? "",
      priority: Number(row.querySelector('[data-row-field="priority"]')?.value ?? 20)
    }));
  }

  function buildFromDialogState(state) {
    const input = {
      name: state.name,
      img: state.img,
      category: state.category,
      statuses: parseCommaList(state.statuses),
      description: state.description,
      duration: {
        rounds: Number(state.rounds),
        turns: Number(state.turns)
      },
      changes: state.rows
    };

    if (state.effectType === "marker") {
      return buildMarkerEffect(input);
    }

    return buildModifierEffect(input);
  }

  function setOutput(root, state, data) {
    const text =
      typeof data === "string"
        ? data
        : JSON.stringify(data, null, 2);

    state.outputText = text;

    const out = root.querySelector("[data-builder-output]");
    if (out) out.value = text;
  }

  function rerender(root, state) {
    const holder = root.querySelector("[data-builder-holder]");
    if (!holder) return;
    holder.innerHTML = renderDialogContent(state);
  }

  async function refreshFieldEntries(state) {
    const catalogue = getFieldCatalogueApi();

    if (!catalogue) {
      state.fieldEntries = [];
      return {
        ok: false,
        reason: "field_catalogue_api_not_found"
      };
    }

    const actorUuid = state.actorUuids?.[0] ?? null;

    if (catalogue.refresh) {
      await catalogue.refresh({
        actorUuid,
        includeLegacyConditionKeys: false,
        includeReadOnly: false,
        suggestionsOnly: false
      });
    }

    const entries =
      catalogue.getRecommended?.({ cloneResult: false }) ??
      catalogue.getAll?.({ cloneResult: false }) ??
      [];

    state.fieldEntries = Array.isArray(entries) ? entries : [];

    return {
      ok: true,
      count: state.fieldEntries.length
    };
  }

  async function open(options = {}) {
    if (!game.user?.isGM) {
      ui.notifications?.warn?.("Custom Active Effect Builder is GM-only.");
      return null;
    }

    injectStyle();

    const state = {
      actorUuids: options.actorUuids ?? getSelectedTokenActorUuids(),

      fieldEntries: [],

      effectType: options.effectType ?? "modifier",
      name: options.name ?? "Custom Active Effect",
      img: options.img ?? DEFAULT_MARKER_ICON,
      category: normalizeCategory(options.category ?? "Buff"),
      statuses: asArray(options.statuses ?? []).join(", "),
      rounds: options.duration?.rounds ?? 3,
      turns: options.duration?.turns ?? 0,
      description: options.description ?? "",

      rows: asArray(options.rows ?? options.changes ?? []).length
        ? asArray(options.rows ?? options.changes).map(r => ({
            id: randomId("row"),
            key: r.key ?? "",
            mode: Number(r.mode ?? getModeValue("ADD")),
            value: String(r.value ?? "1"),
            priority: Number(r.priority ?? 20)
          }))
        : [{
            id: randomId("row"),
            key: "",
            mode: getModeValue("ADD"),
            value: "1",
            priority: 20
          }],

      outputText: ""
    };

    try {
      await refreshFieldEntries(state);
    } catch (e) {
      warn("Initial field refresh failed.", e);
    }

    return await new Promise(resolve => {
      let resolved = false;

      const dialog = new Dialog({
        title: "Custom Active Effect Builder",
        content: `
          <div data-builder-holder>
            ${renderDialogContent(state)}
          </div>
        `,
        buttons: {
          close: {
            label: "Close",
            callback: () => {
              if (!resolved) {
                resolved = true;
                resolve(null);
              }
            }
          }
        },
        default: "close",
        render: (html) => {
          const root = normalizeHtmlRoot(html);
          if (!root) return;

          root.addEventListener("change", async ev => {
            readState(root, state);

            if (ev.target?.name === "actorUuids") {
              try {
                await refreshFieldEntries(state);
              } catch (e) {
                warn("Field refresh on actor change failed.", e);
              }
              rerender(root, state);
            }
          });

          root.addEventListener("click", async ev => {
            const btn = ev.target.closest?.("[data-builder-action]");
            if (!btn) return;

            ev.preventDefault();
            ev.stopPropagation();

            const action = btn.dataset.builderAction;

            try {
              btn.disabled = true;
              readState(root, state);

              if (action === "use-selected-tokens") {
                state.actorUuids = getSelectedTokenActorUuids();
                await refreshFieldEntries(state);
                rerender(root, state);
                return;
              }

              if (action === "refresh-fields") {
                const result = await refreshFieldEntries(state);
                setOutput(root, state, result);
                rerender(root, state);
                return;
              }

              if (action === "add-row") {
                state.rows.push({
                  id: randomId("row"),
                  key: "",
                  mode: getModeValue("ADD"),
                  value: "1",
                  priority: 20
                });
                rerender(root, state);
                return;
              }

              if (action === "remove-row") {
                const id = btn.dataset.rowId;
                state.rows = state.rows.filter(r => r.id !== id);

                if (!state.rows.length) {
                  state.rows.push({
                    id: randomId("row"),
                    key: "",
                    mode: getModeValue("ADD"),
                    value: "1",
                    priority: 20
                  });
                }

                rerender(root, state);
                return;
              }

              if (action === "preview") {
                const built = buildFromDialogState(state);
                const report = preview(built.effectData, {
                  actorUuids: state.actorUuids,
                  allowNoChanges: state.effectType === "marker"
                });

                setOutput(root, state, {
                  built,
                  preview: report
                });
                return;
              }

              if (action === "open-native-sheet") {
                const built = buildFromDialogState(state);
                const result = await openNativeUnsavedSheet(built.effectData, state.actorUuids?.[0] ?? null);

                setOutput(root, state, {
                  built,
                  nativeSheet: result
                });
                return;
              }

              if (action === "apply") {
                const built = buildFromDialogState(state);

                if (!built.ok) {
                  setOutput(root, state, built);
                  return;
                }

                const manager = getManagerApi();

                if (!manager?.applyEffects) {
                  setOutput(root, state, {
                    ok: false,
                    reason: "active_effect_manager_api_not_found"
                  });
                  return;
                }

                if (!state.actorUuids.length) {
                  setOutput(root, state, {
                    ok: false,
                    reason: "no_target_actors"
                  });
                  return;
                }

                const result = await manager.applyEffects({
                  actorUuids: state.actorUuids,
                  effects: [{
                    effectData: built.effectData
                  }],
                  duplicateMode: "replace"
                });

                setOutput(root, state, result);
                return;
              }

              if (action === "copy") {
                const out = root.querySelector("[data-builder-output]")?.value ?? "";

                try {
                  if (game.clipboard?.copyPlainText) {
                    await game.clipboard.copyPlainText(out);
                  } else {
                    await navigator.clipboard.writeText(out);
                  }

                  ui.notifications?.info?.("Copied custom effect builder output.");
                } catch (_e) {
                  ui.notifications?.warn?.("Could not copy. Select the output manually.");
                }

                return;
              }

            } catch (e) {
              err("Builder dialog action failed.", {
                action,
                error: e
              });

              setOutput(root, state, {
                ok: false,
                action,
                error: compactError(e)
              });
            } finally {
              btn.disabled = false;
            }
          });
        },
        close: () => {
          if (!resolved) {
            resolved = true;
            resolve(null);
          }
        }
      }, {
        width: 860,
        height: "auto",
        resizable: true
      });

      dialog.render(true);
    });
  }

  // --------------------------------------------------------------------------
  // API
  // --------------------------------------------------------------------------

  const api = {
    version: "0.1.0",

    buildChangeRow,
    normalizeChangeRows,
    buildChangeFromField,

    buildMarkerEffect,
    buildModifierEffect,
    buildModifierEffectFromFields,
    buildEffect,

    validateEffectData,
    preview,
    openNativeUnsavedSheet,

    open,

    _internal: {
      DEFAULT_OPTIONS,
      LEGACY_CONDITION_KEYS,
      isLegacyConditionKey,
      normalizeDuration,
      normalizeCategory,
      makeCreateSnippet,
      makeManagerApplySnippet
    }
  };

  exposeApi(api);

  Hooks.once("ready", () => {
    exposeApi(api);

    log("Ready. Active Effect Manager Custom Builder API installed.", {
      api: "FUCompanion.api.activeEffectManager.customBuilder"
    });
  });
})();