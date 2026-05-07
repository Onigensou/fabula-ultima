// ============================================================================
// ActiveEffectManager-field-catalogue.js
// Foundry VTT V12 — Fabula Ultima Companion
//
// Purpose:
// - Build a smart catalogue of actor fields that are safe/useful for custom
//   ActiveEffect modifier rows.
// - Uses Custom System Builder-style short keys for ActiveEffect changes.
//   Example:
//     ActiveEffect change key: "damage_receiving_mod_all"
//     Stored actor path:       "system.props.damage_receiving_mod_all"
//
// Important:
// - This script DOES NOT apply effects.
// - This script DOES NOT use legacy condition toggles like isSlow/isDazed.
// - Legacy condition keys are hidden from suggestions by default.
//
// Public API:
//   FUCompanion.api.activeEffectManager.fieldCatalogue.refresh(options)
//   FUCompanion.api.activeEffectManager.fieldCatalogue.getAll()
//   FUCompanion.api.activeEffectManager.fieldCatalogue.getSuggestions(query)
//   FUCompanion.api.activeEffectManager.fieldCatalogue.getByKey(key)
//   FUCompanion.api.activeEffectManager.fieldCatalogue.scanActorSheetFields(actorOrUuid)
//   FUCompanion.api.activeEffectManager.fieldCatalogue.scanActorProps(actorOrUuid)
//   FUCompanion.api.activeEffectManager.fieldCatalogue.scanStatusTabMetadata(actorOrUuid)
//
// Alias:
//   FUCompanion.api.activeEffectManager.fieldCatalog
//
// Console examples:
//   await FUCompanion.api.activeEffectManager.fieldCatalogue.refresh()
//   FUCompanion.api.activeEffectManager.fieldCatalogue.getSuggestions("damage")
//   FUCompanion.api.activeEffectManager.fieldCatalogue.getSuggestions("critical")
//   FUCompanion.api.activeEffectManager.fieldCatalogue.getSuggestions("turn")
// ============================================================================

(() => {
  const MODULE_ID = "fabula-ultima-companion";
  const TAG = "[ONI][ActiveEffectManager:FieldCatalogue]";
  const DEBUG = true;

  const log = (...a) => DEBUG && console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);
  const err = (...a) => console.error(TAG, ...a);

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

  const FIELD_TYPES = {
    NUMBER: "numberField",
    CHECKBOX: "checkbox",
    SELECT: "select",
    TEXT: "textField",
    TEXTAREA: "textArea",
    LABEL: "label",
    DYNAMIC_TABLE: "dynamicTable",
    ACTIVE_EFFECT_CONTAINER: "activeEffectContainer"
  };

  const DEFAULT_OPTIONS = {
    actorUuid: null,

    // Legacy condition toggles are visible only if explicitly requested.
    includeLegacyConditionKeys: false,

    // Formula labels and roll buttons are included only if requested.
    includeReadOnly: false,

    // Include top-level system.props keys even if the field is not found
    // in the actor sheet body layout.
    includePropsFallback: true,

    // Include dynamic table row-layout fields in reference output.
    // They are normally not recommended for ActiveEffect modifier rows.
    includeDynamicTableRowFields: true,

    // Only return fields that are useful as modifier suggestions.
    suggestionsOnly: false
  };

  const CACHE = {
    ready: false,
    refreshedAt: null,
    actorUuid: null,
    actorName: null,
    options: null,
    entries: [],
    byKey: new Map(),
    statusTabMetadata: null,
    report: null
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

    root.fieldCatalogue = api;
    root.fieldCatalog = api;

    try {
      const mod = game.modules?.get?.(MODULE_ID);
      if (mod) {
        mod.api = mod.api || {};
        mod.api.activeEffectManager = mod.api.activeEffectManager || {};
        mod.api.activeEffectManager.fieldCatalogue = api;
        mod.api.activeEffectManager.fieldCatalog = api;
      }
    } catch (e) {
      warn("Could not expose API on module object.", e);
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

  function nowIso() {
    return new Date().toISOString();
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

  function getProperty(obj, path, fallback = undefined) {
    try {
      if (foundry?.utils?.getProperty) {
        const v = foundry.utils.getProperty(obj, path);
        return v === undefined ? fallback : v;
      }
    } catch (_e) {}

    try {
      const parts = String(path).split(".");
      let cur = obj;
      for (const p of parts) {
        if (cur == null) return fallback;
        cur = cur[p];
      }
      return cur === undefined ? fallback : cur;
    } catch (_e) {
      return fallback;
    }
  }

  function numberish(value) {
    if (value === "" || value == null) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function valueTypeOf(value) {
    if (value === null) return "null";
    if (Array.isArray(value)) return "array";
    return typeof value;
  }

  function plainText(value) {
    let s = String(value ?? "");

    s = s.replace(/<style[\s\S]*?<\/style>/gi, "");
    s = s.replace(/<script[\s\S]*?<\/script>/gi, "");
    s = s.replace(/<[^>]*>/g, " ");
    s = s.replace(/\$\{[\s\S]*?\}\$/g, " ");
    s = s.replace(/&nbsp;/gi, " ");
    s = s.replace(/\s+/g, " ").trim();

    return s;
  }

  function hasFormula(value) {
    return /\$\{[\s\S]*?\}\$/.test(String(value ?? ""));
  }

  function hasMacroFormula(value) {
    return /%\{[\s\S]*?\}%/.test(String(value ?? ""));
  }

  function isPrimitive(value) {
    return (
      value === null ||
      ["string", "number", "boolean"].includes(typeof value)
    );
  }

  function getSelectedOrFallbackActor() {
    const selectedToken = canvas?.tokens?.controlled?.[0] ?? null;
    if (selectedToken?.actor) return selectedToken.actor;

    if (game.user?.character) return game.user.character;

    return Array.from(game.actors ?? []).find(a => {
      try {
        return game.user?.isGM || a.testUserPermission?.(game.user, "OWNER");
      } catch (_e) {
        return false;
      }
    }) ?? null;
  }

  async function resolveDocument(uuidOrDoc) {
    if (!uuidOrDoc) return null;
    if (typeof uuidOrDoc !== "string") return uuidOrDoc;

    try {
      return await fromUuid(uuidOrDoc);
    } catch (e) {
      warn("fromUuid failed.", {
        uuidOrDoc,
        error: String(e?.message ?? e)
      });
      return null;
    }
  }

  async function resolveActor(actorOrUuid = null) {
    if (!actorOrUuid) return getSelectedOrFallbackActor();

    const doc = await resolveDocument(actorOrUuid);
    if (!doc) return null;

    if (doc.documentName === "Actor") return doc;
    if (doc.actor) return doc.actor;
    if (doc.object?.actor) return doc.object.actor;
    if (doc.document?.actor) return doc.document.actor;

    return null;
  }

  // --------------------------------------------------------------------------
  // Sheet walking helpers
  // --------------------------------------------------------------------------

  function walkSheetNodes(value, visitor, path = [], ancestors = []) {
    if (Array.isArray(value)) {
      value.forEach((v, i) => walkSheetNodes(v, visitor, [...path, i], ancestors));
      return;
    }

    if (!value || typeof value !== "object") return;

    visitor(value, path, ancestors);

    const nextAncestors = [...ancestors, value];

    const childKeys = [
      "contents",
      "rowLayout",
      "options",
      "predefinedLines"
    ];

    for (const key of childKeys) {
      if (value[key] !== undefined) {
        walkSheetNodes(value[key], visitor, [...path, key], nextAncestors);
      }
    }
  }

  function nodeIdentityText(node = {}) {
    return [
      node.type,
      node.key,
      node.name,
      node.title,
      node.label,
      node.value,
      node.colName,
      node.tooltip
    ].map(plainText).join(" ").toLowerCase();
  }

  function keepShortLabel(value) {
    const s = plainText(value);
    if (!s) return false;
    if (s.length > 80) return false;
    if (/^\W+$/.test(s)) return false;
    return true;
  }

  function labelFromNode(node = {}) {
    const candidates = [
      node.label,
      node.colName,
      node.title,
      node.name,
      node.value,
      node.key
    ];

    for (const c of candidates) {
      if (keepShortLabel(c)) return plainText(c);
    }

    return safeString(node.key);
  }

  function sectionFromAncestors(ancestors = []) {
    const labels = [];

    for (const node of ancestors) {
      const candidates = [
        node.title,
        node.name,
        node.label,
        node.value
      ];

      for (const c of candidates) {
        if (keepShortLabel(c)) {
          const text = plainText(c);
          if (text && !labels.includes(text)) labels.push(text);
          break;
        }
      }
    }

    return labels.slice(-4);
  }

  function isStatusTabNode(node = {}) {
    if (node.type !== "tab") return false;

    const identity = nodeIdentityText(node);

    return (
      identity.includes("status") ||
      identity.includes("active effect") ||
      identity.includes("effect")
    );
  }

  function isInsideStatusTab(ancestors = []) {
    return ancestors.some(isStatusTabNode);
  }

  function isDynamicTableRowField(ancestors = []) {
    return ancestors.some(a => a?.type === FIELD_TYPES.DYNAMIC_TABLE);
  }

  function isActiveEffectContainerNode(node = {}) {
    const identity = nodeIdentityText(node);
    const key = String(node.key ?? "").toLowerCase();

    return (
      node.type === FIELD_TYPES.ACTIVE_EFFECT_CONTAINER ||
      key.includes("activeeffect") ||
      key.includes("active_effect") ||
      identity.includes("active effect")
    );
  }

  function isActiveEffectConfigTableNode(node = {}) {
    const identity = nodeIdentityText(node);
    const key = String(node.key ?? "").toLowerCase();

    return (
      key.includes("active_effect") ||
      key.includes("activeeffect") ||
      identity.includes("active effect config") ||
      (
        node.type === FIELD_TYPES.DYNAMIC_TABLE &&
        JSON.stringify(node).toLowerCase().includes("active_effect")
      )
    );
  }

  // --------------------------------------------------------------------------
  // Field classification
  // --------------------------------------------------------------------------

  function isLegacyConditionKey(key) {
    return LEGACY_CONDITION_KEYS.has(String(key ?? ""));
  }

  function inferValueKind({ key, nodeType, propValue } = {}) {
    if (nodeType === FIELD_TYPES.CHECKBOX) return "boolean";
    if (nodeType === FIELD_TYPES.NUMBER) return "number";
    if (nodeType === FIELD_TYPES.SELECT) return "select";
    if (nodeType === FIELD_TYPES.TEXT || nodeType === FIELD_TYPES.TEXTAREA) return "text";

    if (typeof propValue === "boolean") return "boolean";
    if (typeof propValue === "number") return "number";
    if (numberish(propValue) !== null) return "number";
    if (typeof propValue === "string") return "text";

    if (/percentage|percent|multiplier|bonus|reduction|accuracy|damage|defense|clock|resource|hp|mp|ip|turn/i.test(String(key ?? ""))) {
      return "number";
    }

    return "unknown";
  }

  function inferCategory({ key, label, section, nodeType } = {}) {
    const text = [
      key,
      label,
      ...(section ?? [])
    ].join(" ").toLowerCase();

    if (/damage_receiving|damage reduction|receiving|reduction/.test(text)) {
      return "Damage Reduction";
    }

    if (/damage_outgoing|extra_damage|attack_damage|damage bonus|bonus damage/.test(text)) {
      return "Damage Bonus";
    }

    if (/critical|crit/.test(text)) {
      return "Critical";
    }

    if (/accuracy/.test(text)) {
      return "Accuracy";
    }

    if (/affinity|physical|air|bolt|dark|earth|fire|ice|light|poison/.test(text)) {
      return "Type Affinity";
    }

    if (/weapon|arcane|bow|brawling|dagger|firearm|flail|heavy|spear|sword|thrown/.test(text)) {
      return "Weapon Efficiency";
    }

    if (/lifesteal|mana drain|manadrain|hp|mp|ip|resource|clock/.test(text)) {
      return "Resource";
    }

    if (/turn activation|turn_activations|initiative/.test(text)) {
      return "Turn / Initiative";
    }

    if (/status/.test(text) || nodeType === FIELD_TYPES.ACTIVE_EFFECT_CONTAINER) {
      return "Status";
    }

    return "Other";
  }

  function getModeValue(name) {
    const modes = CONST?.ACTIVE_EFFECT_MODES ?? {};
    return modes[name] ?? {
      CUSTOM: 0,
      MULTIPLY: 1,
      ADD: 2,
      DOWNGRADE: 3,
      UPGRADE: 4,
      OVERRIDE: 5
    }[name] ?? 0;
  }

  function modeNameFromValue(value) {
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

  function inferRecommendedChange({ key, valueKind, category, nodeType } = {}) {
    const keyText = String(key ?? "").toLowerCase();
    const cat = String(category ?? "");

    if (valueKind === "boolean" || nodeType === FIELD_TYPES.CHECKBOX) {
      return {
        mode: getModeValue("OVERRIDE"),
        modeName: "OVERRIDE",
        value: "true",
        priority: 20,
        note: "Boolean fields usually want OVERRIDE true/false."
      };
    }

    if (/^affinity_\d+/.test(keyText) || cat === "Type Affinity") {
      return {
        mode: getModeValue("OVERRIDE"),
        modeName: "OVERRIDE",
        value: "0",
        priority: 20,
        note: "Affinity fields often behave best as OVERRIDE, depending on your affinity code system."
      };
    }

    if (/percentage|percent/.test(keyText)) {
      return {
        mode: getModeValue("ADD"),
        modeName: "ADD",
        value: "10",
        priority: 20,
        note: "Percentage modifier field. Suggested test value is 10."
      };
    }

    if (/multiplier/.test(keyText)) {
      return {
        mode: getModeValue("ADD"),
        modeName: "ADD",
        value: "0.5",
        priority: 20,
        note: "Multiplier field. Confirm exact desired behavior before production use."
      };
    }

    if (valueKind === "number") {
      return {
        mode: getModeValue("ADD"),
        modeName: "ADD",
        value: "1",
        priority: 20,
        note: "Numeric fields usually want ADD for buffs/debuffs."
      };
    }

    if (valueKind === "select" || nodeType === FIELD_TYPES.SELECT) {
      return {
        mode: getModeValue("OVERRIDE"),
        modeName: "OVERRIDE",
        value: "",
        priority: 20,
        note: "Select fields usually want OVERRIDE, but value must match one of the select options."
      };
    }

    return {
      mode: getModeValue("OVERRIDE"),
      modeName: "OVERRIDE",
      value: "",
      priority: 20,
      note: "Unknown/text field. Use carefully."
    };
  }

  function isReadonlySheetNode(node = {}) {
    if (node.type === FIELD_TYPES.LABEL) return true;
    if (hasFormula(node.value)) return true;
    if (hasMacroFormula(node.rollMessage)) return true;
    return false;
  }

  function isSafeSuggestion(entry = {}) {
    if (!entry) return false;
    if (entry.isLegacyConditionKey) return false;
    if (entry.isReadOnly) return false;
    if (entry.isDynamicTableRowField && !entry.hasTopLevelProp) return false;

    if (entry.valueKind === "number") return true;
    if (entry.valueKind === "select") return true;

    // Boolean fields are allowed in general, but the old status boolean fields
    // are already blocked by isLegacyConditionKey.
    if (entry.valueKind === "boolean") return true;

    // Text fields are usually not useful for combat modifiers.
    if (entry.valueKind === "text") return false;

    return false;
  }

  function scoreSuggestion(query, entry) {
    const q = String(query ?? "").trim().toLowerCase();
    if (!q) return 0;

    const text = [
      entry.key,
      entry.activeEffectKey,
      entry.label,
      entry.category,
      entry.valueKind,
      ...(entry.section ?? []),
      entry.propPath
    ].join(" ").toLowerCase();

    const key = String(entry.key ?? "").toLowerCase();
    const label = String(entry.label ?? "").toLowerCase();

    let score = 0;

    if (key === q) score += 1000;
    if (label === q) score += 900;
    if (key.includes(q)) score += 700;
    if (label.includes(q)) score += 600;
    if (text.includes(q)) score += 300;

    const parts = q.split(/[\s._-]+/g).filter(Boolean);
    for (const part of parts) {
      if (key.includes(part)) score += 120;
      if (label.includes(part)) score += 90;
      if (text.includes(part)) score += 40;
    }

    if (entry.isRecommended) score += 80;
    if (entry.isReadOnly) score -= 500;
    if (entry.isLegacyConditionKey) score -= 1000;

    return score;
  }

  // --------------------------------------------------------------------------
  // Entry builders
  // --------------------------------------------------------------------------

  function buildEntryFromSheetNode(actor, node, path, ancestors) {
    const key = safeString(node.key);
    if (!key) return null;

    const props = actor?.system?.props ?? {};
    const propValue = props[key];
    const hasTopLevelProp = Object.prototype.hasOwnProperty.call(props, key);

    const nodeType = safeString(node.type, "unknown");
    const label = labelFromNode(node);
    const section = sectionFromAncestors(ancestors);

    const isLegacy = isLegacyConditionKey(key);
    const isReadOnly = isReadonlySheetNode(node);
    const isDyn = isDynamicTableRowField(ancestors);
    const insideStatusTab = isInsideStatusTab(ancestors);

    const valueKind = inferValueKind({
      key,
      nodeType,
      propValue
    });

    const category = inferCategory({
      key,
      label,
      section,
      nodeType
    });

    const recommendedChange = inferRecommendedChange({
      key,
      valueKind,
      category,
      nodeType
    });

    const entry = {
      key,
      activeEffectKey: key,
      propPath: `system.props.${key}`,

      label,
      section,
      category,

      source: "actor-sheet-body",
      nodeType,
      valueKind,

      hasTopLevelProp,
      currentValue: hasTopLevelProp ? clone(propValue, propValue) : undefined,
      currentValueType: hasTopLevelProp ? valueTypeOf(propValue) : "missing",

      isLegacyConditionKey: isLegacy,
      isReadOnly,
      isDynamicTableRowField: isDyn,
      insideStatusTab,

      isRecommended: false,

      recommendedChange,

      sheetNode: {
        path: path.join("."),
        key: node.key ?? "",
        type: node.type ?? "",
        label: node.label ?? "",
        colName: node.colName ?? "",
        title: node.title ?? "",
        valuePreview: plainText(node.value ?? "").slice(0, 140),
        tooltip: plainText(node.tooltip ?? "")
      }
    };

    entry.isRecommended = isSafeSuggestion(entry);

    return entry;
  }

  function buildEntryFromProp(actor, key, value) {
    const valueKind = inferValueKind({
      key,
      nodeType: "",
      propValue: value
    });

    const label = key
      .replace(/^_+/, "")
      .replace(/_/g, " ")
      .replace(/\b\w/g, m => m.toUpperCase());

    const category = inferCategory({
      key,
      label,
      section: ["system.props"],
      nodeType: ""
    });

    const recommendedChange = inferRecommendedChange({
      key,
      valueKind,
      category,
      nodeType: ""
    });

    const entry = {
      key,
      activeEffectKey: key,
      propPath: `system.props.${key}`,

      label,
      section: ["system.props"],
      category,

      source: "actor-system-props",
      nodeType: "prop",
      valueKind,

      hasTopLevelProp: true,
      currentValue: clone(value, value),
      currentValueType: valueTypeOf(value),

      isLegacyConditionKey: isLegacyConditionKey(key),
      isReadOnly: false,
      isDynamicTableRowField: false,
      insideStatusTab: false,

      isRecommended: false,

      recommendedChange,

      sheetNode: null
    };

    entry.isRecommended = isSafeSuggestion(entry);

    return entry;
  }

  function mergeEntries(sheetEntries = [], propEntries = []) {
    const byKey = new Map();

    for (const entry of sheetEntries) {
      if (!entry?.key) continue;
      byKey.set(entry.key, entry);
    }

    for (const prop of propEntries) {
      if (!prop?.key) continue;

      const existing = byKey.get(prop.key);

      if (!existing) {
        byKey.set(prop.key, prop);
        continue;
      }

      existing.hasTopLevelProp = true;
      existing.currentValue = prop.currentValue;
      existing.currentValueType = prop.currentValueType;

      if (!existing.valueKind || existing.valueKind === "unknown") {
        existing.valueKind = prop.valueKind;
      }

      if (!existing.category || existing.category === "Other") {
        existing.category = prop.category;
      }

      existing.recommendedChange = inferRecommendedChange({
        key: existing.key,
        valueKind: existing.valueKind,
        category: existing.category,
        nodeType: existing.nodeType
      });

      existing.isRecommended = isSafeSuggestion(existing);
    }

    return Array.from(byKey.values()).sort((a, b) => {
      const cat = String(a.category).localeCompare(String(b.category));
      if (cat) return cat;

      const label = String(a.label).localeCompare(String(b.label));
      if (label) return label;

      return String(a.key).localeCompare(String(b.key));
    });
  }

  function filterEntries(entries = [], options = {}) {
    const finalOptions = {
      ...DEFAULT_OPTIONS,
      ...(options ?? {})
    };

    return entries.filter(entry => {
      if (!entry) return false;

      if (!finalOptions.includeLegacyConditionKeys && entry.isLegacyConditionKey) {
        return false;
      }

      if (!finalOptions.includeReadOnly && entry.isReadOnly) {
        return false;
      }

      if (!finalOptions.includeDynamicTableRowFields && entry.isDynamicTableRowField) {
        return false;
      }

      if (finalOptions.suggestionsOnly && !entry.isRecommended) {
        return false;
      }

      return true;
    });
  }

  // --------------------------------------------------------------------------
  // Status tab metadata
  // --------------------------------------------------------------------------

  function summarizeNode(node = {}, path = []) {
    return {
      path: path.join("."),
      key: node.key ?? "",
      type: node.type ?? "",
      name: node.name ?? "",
      title: plainText(node.title ?? ""),
      label: plainText(node.label ?? ""),
      value: keepShortLabel(node.value) ? plainText(node.value) : "",
      colName: plainText(node.colName ?? ""),
      flow: node.flow ?? "",
      align: node.align ?? ""
    };
  }

  function collectInside(rootNode = {}, rootPath = []) {
    const labels = [];
    const fields = [];
    const activeEffectContainers = [];
    const configTables = [];

    walkSheetNodes(rootNode, (node, path, ancestors) => {
      const fullPath = [...rootPath, ...path];

      if (node.type === FIELD_TYPES.LABEL && keepShortLabel(node.value)) {
        labels.push(summarizeNode(node, fullPath));
      }

      if (node.key && node.type) {
        fields.push({
          ...summarizeNode(node, fullPath),
          section: sectionFromAncestors(ancestors)
        });
      }

      if (isActiveEffectContainerNode(node)) {
        const rowLayout = Array.isArray(node.rowLayout) ? node.rowLayout : [];
        const contents = Array.isArray(node.contents) ? node.contents : [];

        activeEffectContainers.push({
          ...summarizeNode(node, fullPath),
          section: sectionFromAncestors(ancestors),
          columns: rowLayout.map((col, i) => ({
            index: i,
            key: col.key ?? "",
            type: col.type ?? "",
            label: plainText(col.label ?? col.colName ?? col.value ?? ""),
            colName: plainText(col.colName ?? "")
          })),
          contentsLabels: contents
            .filter(c => c?.type === FIELD_TYPES.LABEL && keepShortLabel(c?.value))
            .map((c, i) => ({
              index: i,
              key: c.key ?? "",
              value: plainText(c.value ?? ""),
              label: plainText(c.label ?? "")
            }))
        });
      }

      if (isActiveEffectConfigTableNode(node)) {
        const rowLayout = Array.isArray(node.rowLayout) ? node.rowLayout : [];

        configTables.push({
          ...summarizeNode(node, fullPath),
          section: sectionFromAncestors(ancestors),
          rowFields: rowLayout.map((field, i) => ({
            index: i,
            key: field.key ?? "",
            type: field.type ?? "",
            label: plainText(field.label ?? field.colName ?? field.value ?? ""),
            defaultValue: field.defaultValue ?? "",
            options: clone(field.options ?? [], [])
          }))
        });
      }
    });

    return {
      labels,
      fields,
      activeEffectContainers,
      configTables
    };
  }

  async function scanStatusTabMetadata(actorOrUuid = null) {
    const actor = await resolveActor(actorOrUuid);

    if (!actor) {
      return {
        ok: false,
        reason: "actor_not_found",
        statusTabs: [],
        activeEffectContainers: [],
        configTables: [],
        labels: []
      };
    }

    const bodyContents = actor.system?.body?.contents ?? [];
    const statusTabs = [];

    walkSheetNodes(bodyContents, (node, path) => {
      if (!isStatusTabNode(node)) return;

      const inside = collectInside(node, path);

      statusTabs.push({
        ...summarizeNode(node, path),
        labels: inside.labels,
        fields: inside.fields,
        activeEffectContainers: inside.activeEffectContainers,
        configTables: inside.configTables
      });
    });

    const wholeSheet = collectInside(bodyContents, []);

    return {
      ok: true,
      actor: {
        name: actor.name,
        uuid: actor.uuid,
        type: actor.type
      },
      statusTabs,

      activeEffectContainers: statusTabs.length
        ? statusTabs.flatMap(t => t.activeEffectContainers)
        : wholeSheet.activeEffectContainers,

      configTables: statusTabs.length
        ? statusTabs.flatMap(t => t.configTables)
        : wholeSheet.configTables,

      labels: statusTabs.length
        ? statusTabs.flatMap(t => t.labels)
        : wholeSheet.labels,

      generatedAt: nowIso()
    };
  }

  // --------------------------------------------------------------------------
  // Scanners
  // --------------------------------------------------------------------------

  async function scanActorSheetFields(actorOrUuid = null, options = {}) {
    const finalOptions = {
      ...DEFAULT_OPTIONS,
      ...(options ?? {})
    };

    const actor = await resolveActor(actorOrUuid ?? finalOptions.actorUuid);

    if (!actor) {
      return {
        ok: false,
        reason: "actor_not_found",
        entries: []
      };
    }

    const entries = [];
    const bodyContents = actor.system?.body?.contents ?? [];

    walkSheetNodes(bodyContents, (node, path, ancestors) => {
      if (!node?.key || !node?.type) return;

      const entry = buildEntryFromSheetNode(actor, node, path, ancestors);
      if (!entry) return;

      entries.push(entry);
    });

    return {
      ok: true,
      actor: {
        name: actor.name,
        uuid: actor.uuid,
        type: actor.type
      },
      entries: filterEntries(entries, finalOptions),
      rawEntries: entries
    };
  }

  async function scanActorProps(actorOrUuid = null, options = {}) {
    const finalOptions = {
      ...DEFAULT_OPTIONS,
      ...(options ?? {})
    };

    const actor = await resolveActor(actorOrUuid ?? finalOptions.actorUuid);

    if (!actor) {
      return {
        ok: false,
        reason: "actor_not_found",
        entries: []
      };
    }

    const props = actor.system?.props ?? {};
    const entries = [];

    for (const [key, value] of Object.entries(props)) {
      // Top-level primitive props are the safest CSB ActiveEffect keys.
      if (!isPrimitive(value)) continue;

      const entry = buildEntryFromProp(actor, key, value);
      entries.push(entry);
    }

    return {
      ok: true,
      actor: {
        name: actor.name,
        uuid: actor.uuid,
        type: actor.type
      },
      entries: filterEntries(entries, finalOptions),
      rawEntries: entries
    };
  }

  async function refresh(options = {}) {
    const finalOptions = {
      ...DEFAULT_OPTIONS,
      ...(options ?? {})
    };

    const actor = await resolveActor(finalOptions.actorUuid);

    if (!actor) {
      const report = {
        ok: false,
        reason: "actor_not_found",
        entries: []
      };

      CACHE.report = report;
      return report;
    }

    const startedAt = Date.now();

    const sheetReport = await scanActorSheetFields(actor, {
      ...finalOptions,
      includeReadOnly: true,
      includeLegacyConditionKeys: true,
      suggestionsOnly: false
    });

    const propReport = finalOptions.includePropsFallback
      ? await scanActorProps(actor, {
          ...finalOptions,
          includeReadOnly: true,
          includeLegacyConditionKeys: true,
          suggestionsOnly: false
        })
      : { entries: [], rawEntries: [] };

    const mergedRaw = mergeEntries(
      sheetReport.rawEntries ?? sheetReport.entries ?? [],
      propReport.rawEntries ?? propReport.entries ?? []
    );

    const entries = filterEntries(mergedRaw, finalOptions);
    const recommended = entries.filter(e => e.isRecommended);

    const statusTabMetadata = await scanStatusTabMetadata(actor);

    const byKey = new Map();
    for (const entry of entries) {
      byKey.set(entry.key, entry);
      byKey.set(entry.activeEffectKey, entry);
    }

    CACHE.ready = true;
    CACHE.refreshedAt = nowIso();
    CACHE.actorUuid = actor.uuid;
    CACHE.actorName = actor.name;
    CACHE.options = clone(finalOptions, {});
    CACHE.entries = entries;
    CACHE.byKey = byKey;
    CACHE.statusTabMetadata = statusTabMetadata;

    const categoryCounts = entries.reduce((acc, e) => {
      acc[e.category] = (acc[e.category] ?? 0) + 1;
      return acc;
    }, {});

    const report = {
      ok: true,
      refreshedAt: CACHE.refreshedAt,
      durationMs: Date.now() - startedAt,

      actor: {
        name: actor.name,
        uuid: actor.uuid,
        type: actor.type
      },

      options: finalOptions,

      counts: {
        entries: entries.length,
        recommended: recommended.length,
        legacyHiddenByDefault: mergedRaw.filter(e => e.isLegacyConditionKey).length,
        readOnlyHiddenByDefault: mergedRaw.filter(e => e.isReadOnly).length,
        categories: categoryCounts
      },

      statusTabMetadata,

      entries,
      recommended
    };

    CACHE.report = report;

    log("Refresh complete.", {
      actor: actor.name,
      counts: report.counts,
      durationMs: report.durationMs
    });

    return report;
  }

  // --------------------------------------------------------------------------
  // Lookup APIs
  // --------------------------------------------------------------------------

  function ensureRefreshedWarning() {
    if (!CACHE.ready) {
      warn("Field catalogue cache is empty. Run await FUCompanion.api.activeEffectManager.fieldCatalogue.refresh()");
    }
  }

  function getAll(options = {}) {
    ensureRefreshedWarning();

    const finalOptions = {
      includeLegacyConditionKeys: false,
      includeReadOnly: false,
      includeDynamicTableRowFields: true,
      suggestionsOnly: false,
      cloneResult: true,
      ...(options ?? {})
    };

    const rows = filterEntries(CACHE.entries, finalOptions);

    return finalOptions.cloneResult ? clone(rows, []) : rows;
  }

  function getRecommended(options = {}) {
    ensureRefreshedWarning();

    const finalOptions = {
      cloneResult: true,
      ...(options ?? {})
    };

    const rows = CACHE.entries.filter(e => e.isRecommended);

    return finalOptions.cloneResult ? clone(rows, []) : rows;
  }

  function getByKey(key, options = {}) {
    ensureRefreshedWarning();

    const finalOptions = {
      cloneResult: true,
      ...(options ?? {})
    };

    const entry = CACHE.byKey.get(String(key ?? ""));

    if (!entry) return null;
    return finalOptions.cloneResult ? clone(entry, null) : entry;
  }

  function getSuggestions(query = "", options = {}) {
    ensureRefreshedWarning();

    const finalOptions = {
      limit: 25,
      includeLegacyConditionKeys: false,
      includeReadOnly: false,
      includeDynamicTableRowFields: true,
      recommendedOnly: true,
      cloneResult: true,
      ...(options ?? {})
    };

    let rows = filterEntries(CACHE.entries, {
      ...finalOptions,
      suggestionsOnly: false
    });

    if (finalOptions.recommendedOnly) {
      rows = rows.filter(e => e.isRecommended);
    }

    const scored = rows
      .map(entry => ({
        ...entry,
        score: scoreSuggestion(query, entry)
      }))
      .filter(entry => {
        if (!String(query ?? "").trim()) return true;
        return entry.score > 0;
      })
      .sort((a, b) => {
        const score = b.score - a.score;
        if (score) return score;

        const cat = String(a.category).localeCompare(String(b.category));
        if (cat) return cat;

        return String(a.label).localeCompare(String(b.label));
      })
      .slice(0, finalOptions.limit);

    return finalOptions.cloneResult ? clone(scored, []) : scored;
  }

  function buildChangePreview(key, overrides = {}) {
    const entry = getByKey(key, { cloneResult: false });

    if (!entry) {
      return {
        ok: false,
        reason: "field_not_found",
        key
      };
    }

    const rec = entry.recommendedChange ?? {};

    const mode = overrides.mode ?? rec.mode ?? getModeValue("ADD");
    const value = overrides.value ?? rec.value ?? "1";
    const priority = overrides.priority ?? rec.priority ?? 20;

    return {
      ok: true,
      entry: clone(entry, null),
      change: {
        key: entry.activeEffectKey,
        mode: Number(mode),
        modeName: modeNameFromValue(mode),
        value: String(value),
        priority: Number(priority)
      }
    };
  }

  function getStatusTabMetadata(options = {}) {
    const finalOptions = {
      cloneResult: true,
      ...(options ?? {})
    };

    return finalOptions.cloneResult
      ? clone(CACHE.statusTabMetadata, null)
      : CACHE.statusTabMetadata;
  }

  function getLastReport(options = {}) {
    const finalOptions = {
      cloneResult: true,
      ...(options ?? {})
    };

    return finalOptions.cloneResult
      ? clone(CACHE.report, null)
      : CACHE.report;
  }

  function clearCache() {
    CACHE.ready = false;
    CACHE.refreshedAt = null;
    CACHE.actorUuid = null;
    CACHE.actorName = null;
    CACHE.options = null;
    CACHE.entries = [];
    CACHE.byKey = new Map();
    CACHE.statusTabMetadata = null;
    CACHE.report = null;
  }

  function debugPrint() {
    console.groupCollapsed(`${TAG} Cache Debug`);
    console.log({
      ready: CACHE.ready,
      refreshedAt: CACHE.refreshedAt,
      actorUuid: CACHE.actorUuid,
      actorName: CACHE.actorName,
      entries: CACHE.entries,
      statusTabMetadata: CACHE.statusTabMetadata,
      report: CACHE.report
    });
    console.groupEnd();

    return getLastReport();
  }

  // --------------------------------------------------------------------------
  // API
  // --------------------------------------------------------------------------

  const api = {
    version: "0.1.0",

    refresh,

    scanActorSheetFields,
    scanActorProps,
    scanStatusTabMetadata,

    getAll,
    getRecommended,
    getSuggestions,
    getByKey,
    getStatusTabMetadata,
    getLastReport,

    buildChangePreview,

    clearCache,
    debugPrint,

    _internal: {
      LEGACY_CONDITION_KEYS,
      FIELD_TYPES,
      CACHE,
      inferCategory,
      inferRecommendedChange,
      isSafeSuggestion,
      buildEntryFromSheetNode,
      buildEntryFromProp,
      mergeEntries,
      filterEntries,
      scoreSuggestion
    }
  };

  exposeApi(api);

  Hooks.once("ready", async () => {
    exposeApi(api);

    try {
      const actor = getSelectedOrFallbackActor();

      if (actor) {
        await refresh({
          actorUuid: actor.uuid,
          includeLegacyConditionKeys: false,
          includeReadOnly: false
        });

        log("Ready. Field Catalogue API installed.", {
          actor: actor.name,
          entries: CACHE.entries.length,
          recommended: CACHE.entries.filter(e => e.isRecommended).length
        });
      } else {
        log("Ready. Field Catalogue API installed. No actor available for initial scan.");
      }
    } catch (e) {
      err("Initial field catalogue refresh failed.", e);
    }
  });
})();