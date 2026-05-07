// ============================================================================
// ActiveEffectManager-key-suggestions.js
// Foundry VTT V12 — Fabula Ultima Companion
//
// Purpose:
// - Global Smart Suggestions for ALL native Active Effect Configuration windows.
// - Works when an Active Effect sheet is opened from:
//     1. Active Effect Manager native builder
//     2. Actor sheet embedded effects
//     3. Item sheet embedded effects
//     4. Any normal Foundry ActiveEffectConfig / CSB CustomActiveEffectConfig window
//
// New focused logic:
// - Pulls actor data keys from actor.system.props.
// - Also pulls compatible entries from the existing Field Catalogue.
// - Only allows gameplay-relevant keys based on allowed keywords:
//   dex, wlp, ins, mig, defense, mdef, elements, weapon types, hp/mp/ip, etc.
// - Supports aliases such as dexterity -> dex, willpower -> wlp.
// - Outputs short CSB-style keys such as bonus_dex, firearm_ef, current_hp.
// ============================================================================

(() => {
  const MODULE_ID = "fabula-ultima-companion";
  const TAG = "[ONI][AEKeySuggest]";
  const PATCH_KEY = "__ONI_ACTIVE_EFFECT_KEY_SUGGESTIONS_GLOBAL_V2__";

  const DEBUG = false;

  const STYLE_ID = "oni-aem-native-key-suggestion-style";
  const DROPDOWN_CLASS = "oni-aem-native-key-suggestion-dropdown";

  // "short" => defense
  // "path"  => system.props.defense
  const SUGGESTION_VALUE_MODE = "short";

  const CFG = {
    enabled: true,
    limit: 12,
    cacheMs: 8000,

    focusedActorModifierSuggestions: true,
    showOnlyFocusedSuggestions: true,
    includeFocusedFallbackKeys: true,

    hookNames: [
      "renderActiveEffectConfig",
      "renderCustomActiveEffectConfig"
    ],

    refreshOnRender: true,
    includeLegacyConditionKeys: false,
    includeReadOnly: false,
    suggestionsOnly: false,

// Do not use broad Field Catalogue rows directly in the dropdown.
// This prevents world/party/database actors from leaking keys like fish_*,
// member_*, bench_*, skill_hp, etc.
useFieldCatalogueRowsInDropdown: false,

// Never use party/database actors as the source actor for suggestions.
skipPartyActors: true
  };

  const FOCUSED_EXTRA_KEYS = [
    // Core actor modifier keys
    { key: "bonus_dex", label: "Bonus DEX", category: "Parameter", valueKind: "number" },
    { key: "bonus_mig", label: "Bonus MIG", category: "Parameter", valueKind: "number" },
    { key: "bonus_ins", label: "Bonus INS", category: "Parameter", valueKind: "number" },
    { key: "bonus_wlp", label: "Bonus WLP", category: "Parameter", valueKind: "number" },

    { key: "override_dex", label: "Override DEX", category: "Parameter", valueKind: "number" },
    { key: "override_mig", label: "Override MIG", category: "Parameter", valueKind: "number" },
    { key: "override_ins", label: "Override INS", category: "Parameter", valueKind: "number" },
    { key: "override_wlp", label: "Override WLP", category: "Parameter", valueKind: "number" },

    { key: "bonus_defense", label: "Bonus Defense", category: "Parameter", valueKind: "number" },
    { key: "bonus_magic_defense", label: "Bonus Magic Defense", category: "Parameter", valueKind: "number" },
    { key: "override_defense", label: "Override Defense", category: "Parameter", valueKind: "number" },
    { key: "override_magic_defense", label: "Override Magic Defense", category: "Parameter", valueKind: "number" },

    { key: "defense", label: "Defense", category: "Parameter", valueKind: "number" },
    { key: "magic_defense", label: "Magic Defense", category: "Parameter", valueKind: "number" },

    // Resources
    { key: "current_hp", label: "Current HP", category: "Resource", valueKind: "number" },
    { key: "current_mp", label: "Current MP", category: "Resource", valueKind: "number" },
    { key: "current_ip", label: "Current IP", category: "Resource", valueKind: "number" },

    { key: "max_hp", label: "Max HP", category: "Resource", valueKind: "number" },
    { key: "max_mp", label: "Max MP", category: "Resource", valueKind: "number" },
    { key: "max_ip", label: "Max IP", category: "Resource", valueKind: "number" },

    // Base attribute naming variants
    { key: "base_dex", label: "Base DEX", category: "Base Attribute", valueKind: "number" },
    { key: "base_mig", label: "Base MIG", category: "Base Attribute", valueKind: "number" },
    { key: "base_ins", label: "Base INS", category: "Base Attribute", valueKind: "number" },
    { key: "base_wlp", label: "Base WLP", category: "Base Attribute", valueKind: "number" },

    { key: "dex_base", label: "Base DEX", category: "Base Attribute", valueKind: "number" },
    { key: "mig_base", label: "Base MIG", category: "Base Attribute", valueKind: "number" },
    { key: "ins_base", label: "Base INS", category: "Base Attribute", valueKind: "number" },
    { key: "wlp_base", label: "Base WLP", category: "Base Attribute", valueKind: "number" }
  ];

  const FOCUSED_KEYWORD_GROUPS = [
    { id: "dex", terms: ["dex", "dexterity"] },
    { id: "wlp", terms: ["wlp", "willpower"] },
    { id: "ins", terms: ["ins", "insight"] },
    { id: "mig", terms: ["mig", "might"] },

    { id: "defense", terms: ["def", "defense"] },
    { id: "magic_defense", terms: ["mdef", "magic_defense", "magicdefense", "magicDefense"] },

    { id: "fire", terms: ["fire"] },
    { id: "air", terms: ["air"] },
    { id: "physical", terms: ["physical"] },
    { id: "ice", terms: ["ice"] },
    { id: "dark", terms: ["dark"] },
    { id: "light", terms: ["light"] },
    { id: "bolt", terms: ["bolt"] },
    { id: "earth", terms: ["earth"] },
    { id: "poison", terms: ["poison"] },

    { id: "range", terms: ["range", "ranged"] },
    { id: "melee", terms: ["melee"] },

    { id: "sword", terms: ["sword"] },
    { id: "arcane", terms: ["arcane"] },
    { id: "firearm", terms: ["firearm"] },
    { id: "bow", terms: ["bow", "now"] },
    { id: "flail", terms: ["flail"] },
    { id: "thrown", terms: ["thrown"] },
    { id: "brawling", terms: ["brawling"] },
    { id: "heavy", terms: ["heavy"] },
    { id: "dagger", terms: ["dagger"] },
    { id: "spear", terms: ["spear"] },

    { id: "spell", terms: ["spell"] },
    { id: "magic", terms: ["magic"] },

    { id: "hp", terms: ["hp"] },
    { id: "ip", terms: ["ip"] },
    { id: "mp", terms: ["mp"] }
  ];

  const FOCUSED_BLOCKED_KEYS = new Set([
    "",
    "status_tab",
    "active_effect_list",
    "type_affinity_panel",
    "efficiency_tab",
    "condition_affinity_panel",
    "condition_status_panel",
    "NA",
    "RS",
    "IM"
  ]);

  const FOCUSED_BLOCKED_KEY_PATTERNS = [
  // Party database actor keys
  /^member_/i,
  /^bench_/i,
  /^party_/i,
  /^total_zenit$/i,

  // Fishing / collection / overworld database keys
  /^fish_/i,
  /^victory_/i,
  /^battle_log_/i,

  // Option/config keys
  /^option_/i,

  // Skill editor/input fields, not actor Active Effect modifier keys
  /^skill_/i,

  // Item/equipment template fields, not actor modifier keys
  /^item_/i,

  // Story/profile fields
  /^bond_/i,
  /^emotion_/i,
  /^relationship_/i,
  /^camp_/i,
  /^quirk_/i,
  /^char_/i,
  /^theme$/i,
  /^origin$/i,
  /^memory/i,
  /^memories_/i
];

const FOCUSED_BUILTIN_GAMEPLAY_KEYS = [
  // Accuracy
  { key: "attack_accuracy_mod_all", category: "Attack Accuracy" },
  { key: "attack_accuracy_mod_melee", category: "Attack Accuracy" },
  { key: "attack_accuracy_mod_ranged", category: "Attack Accuracy" },
  { key: "attack_accuracy_mod_magic", category: "Attack Accuracy" },

  // Extra Damage — general / range / spell
  { key: "extra_damage_mod_all", category: "Extra Damage" },
  { key: "extra_damage_mod_melee", category: "Extra Damage" },
  { key: "extra_damage_mod_ranged", category: "Extra Damage" },
  { key: "extra_damage_mod_spell", category: "Extra Damage" },

  // Extra Damage — element
  { key: "extra_damage_mod_physical", category: "Extra Damage" },
  { key: "extra_damage_mod_air", category: "Extra Damage" },
  { key: "extra_damage_mod_bolt", category: "Extra Damage" },
  { key: "extra_damage_mod_dark", category: "Extra Damage" },
  { key: "extra_damage_mod_earth", category: "Extra Damage" },
  { key: "extra_damage_mod_fire", category: "Extra Damage" },
  { key: "extra_damage_mod_ice", category: "Extra Damage" },
  { key: "extra_damage_mod_light", category: "Extra Damage" },
  { key: "extra_damage_mod_poison", category: "Extra Damage" },

  // Extra Damage — weapon
  { key: "extra_damage_mod_arcane", category: "Extra Damage" },
  { key: "extra_damage_mod_bow", category: "Extra Damage" },
  { key: "extra_damage_mod_brawling", category: "Extra Damage" },
  { key: "extra_damage_mod_dagger", category: "Extra Damage" },
  { key: "extra_damage_mod_firearm", category: "Extra Damage" },
  { key: "extra_damage_mod_flail", category: "Extra Damage" },
  { key: "extra_damage_mod_heavy", category: "Extra Damage" },
  { key: "extra_damage_mod_spear", category: "Extra Damage" },
  { key: "extra_damage_mod_sword", category: "Extra Damage" },
  { key: "extra_damage_mod_thrown", category: "Extra Damage" },

  // Damage Reduction — flat
  { key: "damage_receiving_mod_all", category: "Damage Reduction" },
  { key: "damage_receiving_mod_melee", category: "Damage Reduction" },
  { key: "damage_receiving_mod_range", category: "Damage Reduction" },
  { key: "damage_receiving_mod_ranged", category: "Damage Reduction" },
  { key: "damage_receiving_mod_physical", category: "Damage Reduction" },
  { key: "damage_receiving_mod_air", category: "Damage Reduction" },
  { key: "damage_receiving_mod_bolt", category: "Damage Reduction" },
  { key: "damage_receiving_mod_dark", category: "Damage Reduction" },
  { key: "damage_receiving_mod_earth", category: "Damage Reduction" },
  { key: "damage_receiving_mod_fire", category: "Damage Reduction" },
  { key: "damage_receiving_mod_ice", category: "Damage Reduction" },
  { key: "damage_receiving_mod_light", category: "Damage Reduction" },
  { key: "damage_receiving_mod_poison", category: "Damage Reduction" },

  // Damage Reduction — percentage
  { key: "damage_receiving_percentage_all", category: "Damage Reduction" },
  { key: "damage_receiving_percentage_melee", category: "Damage Reduction" },
  { key: "damage_receiving_percentage_range", category: "Damage Reduction" },
  { key: "damage_receiving_percentage_ranged", category: "Damage Reduction" },
  { key: "damage_receiving_percentage_physical", category: "Damage Reduction" },
  { key: "damage_receiving_percentage_air", category: "Damage Reduction" },
  { key: "damage_receiving_percentage_bolt", category: "Damage Reduction" },
  { key: "damage_receiving_percentage_dark", category: "Damage Reduction" },
  { key: "damage_receiving_percentage_earth", category: "Damage Reduction" },
  { key: "damage_receiving_percentage_fire", category: "Damage Reduction" },
  { key: "damage_receiving_percentage_ice", category: "Damage Reduction" },
  { key: "damage_receiving_percentage_light", category: "Damage Reduction" },
  { key: "damage_receiving_percentage_poison", category: "Damage Reduction" },

  // Weapon Efficiency
  { key: "arcane_ef", category: "Weapon Efficiency" },
  { key: "bow_ef", category: "Weapon Efficiency" },
  { key: "brawling_ef", category: "Weapon Efficiency" },
  { key: "dagger_ef", category: "Weapon Efficiency" },
  { key: "firearm_ef", category: "Weapon Efficiency" },
  { key: "flail_ef", category: "Weapon Efficiency" },
  { key: "heavy_ef", category: "Weapon Efficiency" },
  { key: "spear_ef", category: "Weapon Efficiency" },
  { key: "sword_ef", category: "Weapon Efficiency" },
  { key: "thrown_ef", category: "Weapon Efficiency" }
];

  const STATE = {
    installed: false,
    hookIds: [],
    dropdown: null,
    activeField: null,
    activeRows: [],
    activeIndex: 0,
    refreshCache: new Map(),
    sheetSessions: new WeakMap(),
    lastInstallCount: 0,
    lastRefreshReport: null,
    lastActorUuid: null,
    lastActor: null,
    lastEntries: []
  };

  const log = (...args) => DEBUG && console.log(TAG, ...args);
  const warn = (...args) => console.warn(TAG, ...args);

  if (globalThis[PATCH_KEY]) {
    console.warn(TAG, "V2 already installed. Re-exposing existing API if available.");
    if (globalThis.FUCompanion?.api?.activeEffectKeySuggestions) return;
  }

  globalThis[PATCH_KEY] = true;

  // --------------------------------------------------------------------------
  // Namespace / API
  // --------------------------------------------------------------------------

  function ensureApiRoot() {
    globalThis.FUCompanion = globalThis.FUCompanion || {};
    globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
    return globalThis.FUCompanion.api;
  }

  function exposeApi(api) {
    const root = ensureApiRoot();

    root.activeEffectKeySuggestions = api;
    root.activeEffectSmartSuggestions = api;

    root.activeEffectManager = root.activeEffectManager || {};
    root.activeEffectManager.keySuggestions = api;
    root.activeEffectManager.smartSuggestions = api;

    try {
      const mod = game.modules?.get?.(MODULE_ID);

      if (mod) {
        mod.api = mod.api || {};
        mod.api.activeEffectKeySuggestions = api;
        mod.api.activeEffectSmartSuggestions = api;

        mod.api.activeEffectManager = mod.api.activeEffectManager || {};
        mod.api.activeEffectManager.keySuggestions = api;
        mod.api.activeEffectManager.smartSuggestions = api;
      }
    } catch (e) {
      warn("Could not expose API on module object.", e);
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

  function compactError(e) {
    return String(e?.message ?? e);
  }

  function cssEscape(value) {
    try {
      if (globalThis.CSS?.escape) return CSS.escape(String(value ?? ""));
    } catch (_e) {}

    return String(value ?? "").replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function normalizeHtmlRoot(htmlOrElement) {
    if (!htmlOrElement) return null;
    if (htmlOrElement instanceof HTMLElement) return htmlOrElement;
    if (htmlOrElement[0] instanceof HTMLElement) return htmlOrElement[0];
    if (htmlOrElement.element instanceof HTMLElement) return htmlOrElement.element;
    if (htmlOrElement.element?.[0] instanceof HTMLElement) return htmlOrElement.element[0];
    return null;
  }

  function documentFromSheet(app) {
    return app?.document ?? app?.object ?? null;
  }

  function actorFromDocument(doc) {
    if (!doc) return null;
    if (doc.documentName === "Actor") return doc;
    if (doc.actor?.documentName === "Actor") return doc.actor;
    if (doc.parent?.documentName === "Actor") return doc.parent;
    if (doc.parent?.actor?.documentName === "Actor") return doc.parent.actor;
    return null;
  }

  function isPartyDatabaseActor(actor) {
  if (!actor || actor.documentName !== "Actor") return false;

  const props = actor.system?.props ?? {};
  const name = String(actor.name ?? "").toLowerCase();

  return (
    CFG.skipPartyActors &&
    (
      props.isParty_boolean === true ||
      String(props.isParty_boolean ?? "").toLowerCase() === "true" ||
      name.includes("party") ||
      Object.prototype.hasOwnProperty.call(props, "member_id_1") ||
      Object.prototype.hasOwnProperty.call(props, "bench_id_1")
    )
  );
}

  async function resolveActor(actorOrUuid = null) {
    if (!actorOrUuid) return null;

    if (typeof actorOrUuid !== "string") {
      return actorFromDocument(actorOrUuid) ?? actorOrUuid;
    }

    try {
      const doc = await fromUuid(actorOrUuid);
      return actorFromDocument(doc) ?? doc ?? null;
    } catch (_e) {
      return null;
    }
  }

function getSelectedOrFallbackActor() {
  const selectedToken = canvas?.tokens?.controlled?.find(t => {
    return t?.actor && !isPartyDatabaseActor(t.actor);
  }) ?? null;

  if (selectedToken?.actor) return selectedToken.actor;

  if (game.user?.character && !isPartyDatabaseActor(game.user.character)) {
    return game.user.character;
  }

  return Array.from(game.actors ?? []).find(actor => {
    try {
      if (isPartyDatabaseActor(actor)) return false;
      return game.user?.isGM || actor.testUserPermission?.(game.user, "OWNER");
    } catch (_e) {
      return false;
    }
  }) ?? null;
}

async function resolveSuggestionActor(appOrActor = null, options = {}) {
  const direct = await resolveActor(options.actor ?? options.actorUuid ?? appOrActor);

  if (direct?.documentName === "Actor" && !isPartyDatabaseActor(direct)) {
    return direct;
  }

  const docActor = actorFromDocument(documentFromSheet(appOrActor));
  if (docActor && !isPartyDatabaseActor(docActor)) return docActor;

  const fromSheetDocument = actorFromDocument(appOrActor?.document ?? appOrActor?.object);
  if (fromSheetDocument && !isPartyDatabaseActor(fromSheetDocument)) {
    return fromSheetDocument;
  }

  if (STATE.lastActor && !isPartyDatabaseActor(STATE.lastActor)) {
    return STATE.lastActor;
  }

  return getSelectedOrFallbackActor();
}

  function getSheetRoot(app, html) {
    return normalizeHtmlRoot(html) ??
      normalizeHtmlRoot(app?.element) ??
      document.getElementById(app?.id) ??
      document.querySelector(`[data-appid="${app?.appId}"]`) ??
      document.querySelector(`#app-${app?.appId}`) ??
      null;
  }

  function normalizeKeyText(value) {
    return String(value ?? "")
      .replace(/([a-z])([A-Z])/g, "$1_$2")
      .replace(/[^a-zA-Z0-9]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "")
      .toLowerCase();
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

  // --------------------------------------------------------------------------
  // CSS / dropdown
  // --------------------------------------------------------------------------

  function ensureStyle() {
    let style = document.getElementById(STYLE_ID);
    if (style) return style;

    style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .${DROPDOWN_CLASS} {
        position: fixed;
        z-index: 9999999;
        display: none;
        min-width: 260px;
        max-width: 460px;
        max-height: 320px;
        overflow-y: auto;
        overflow-x: hidden;
        overscroll-behavior: contain;
        scrollbar-gutter: stable;
        padding: 5px;
        border: 1px solid rgba(40, 32, 24, .34);
        border-radius: 8px;
        background: rgba(248, 242, 224, .98);
        box-shadow: 0 10px 28px rgba(0,0,0,.28);
        color: #1f1a14;
        font-family: var(--font-primary, "Signika"), sans-serif;
      }

      .${DROPDOWN_CLASS} .aem-suggest-head {
        padding: 4px 6px 6px;
        font-size: 10px;
        font-weight: 900;
        text-transform: uppercase;
        letter-spacing: .04em;
        opacity: .62;
      }

      .${DROPDOWN_CLASS} .aem-suggest-row {
        display: grid;
        gap: 2px;
        padding: 6px 7px;
        border-radius: 6px;
        cursor: pointer;
      }

      .${DROPDOWN_CLASS} .aem-suggest-row:hover,
      .${DROPDOWN_CLASS} .aem-suggest-row.active {
        background: rgba(65, 50, 32, .14);
      }

      .${DROPDOWN_CLASS} .aem-suggest-key {
        font-family: monospace;
        font-size: 12px;
        font-weight: 900;
        color: #15110c;
        overflow-wrap: anywhere;
      }

      .${DROPDOWN_CLASS} .aem-suggest-meta {
        font-size: 10px;
        opacity: .7;
        line-height: 1.2;
      }
    `;

    document.head.appendChild(style);
    return style;
  }

  function isInsideDropdownEvent(ev) {
    const dropdown = STATE.dropdown;
    if (!dropdown) return false;

    const target = ev?.target ?? null;

    if (target && dropdown.contains(target)) return true;

    try {
      const path = ev.composedPath?.() ?? [];
      return path.includes(dropdown);
    } catch (_e) {
      return false;
    }
  }

  function onGlobalScroll(ev) {
    if (isInsideDropdownEvent(ev)) return;
    hideDropdown();
  }

  function onGlobalPointerDown(ev) {
    const dropdown = STATE.dropdown;

    if (dropdown && isInsideDropdownEvent(ev)) return;
    if (STATE.activeField && STATE.activeField.contains?.(ev.target)) return;

    hideDropdown();
  }

  function hideDropdown() {
    const dropdown = STATE.dropdown;
    if (!dropdown) return;

    dropdown.style.display = "none";
    dropdown.innerHTML = "";
    dropdown.__oniAeSuggestions = [];
    dropdown.__oniAeField = null;

    STATE.activeField = null;
    STATE.activeRows = [];
    STATE.activeIndex = 0;
  }

  function getDropdown() {
    if (STATE.dropdown?.isConnected) return STATE.dropdown;

    const dropdown = document.createElement("div");
    dropdown.className = DROPDOWN_CLASS;
    dropdown.dataset.globalAeKeySuggestions = "1";
    document.body.appendChild(dropdown);

    dropdown.addEventListener("mousedown", ev => {
      const row = ev.target.closest?.(".aem-suggest-row");
      if (!row) return;

      ev.preventDefault();
      ev.stopPropagation();

      chooseSuggestion(Number(row.dataset.suggestionIndex ?? 0) || 0);
    });

    dropdown.addEventListener("wheel", ev => {
      ev.stopPropagation();
    }, { passive: true });

    dropdown.addEventListener("scroll", ev => {
      ev.stopPropagation();
    }, { passive: true });

    dropdown.addEventListener("mousedown", ev => {
      ev.stopPropagation();
    });

    dropdown.addEventListener("pointerdown", ev => {
      ev.stopPropagation();
    });

    document.addEventListener("mousedown", onGlobalPointerDown);
    document.addEventListener("pointerdown", onGlobalPointerDown);

    window.addEventListener("resize", hideDropdown);
    window.addEventListener("scroll", onGlobalScroll, true);

    STATE.dropdown = dropdown;
    return dropdown;
  }

  // --------------------------------------------------------------------------
  // Suggestion entry helpers
  // --------------------------------------------------------------------------

  function getEntryKey(entry = {}) {
    const key = safeString(
      entry.activeEffectKey ??
      entry.key ??
      entry.rawKey ??
      ""
    );

    if (key) return key;

    const propPath = safeString(entry.propPath);
    if (propPath.startsWith("system.props.")) {
      return propPath.slice("system.props.".length);
    }

    return propPath;
  }

  function getEntrySections(entry = {}) {
    return [
      entry.category,
      entry.section,
      entry.sectionPath,
      entry.tabName,
      entry.parentTitle,
      entry.source,
      ...(Array.isArray(entry.tags) ? entry.tags : [])
    ]
      .flat(Infinity)
      .map(plainText)
      .filter(Boolean);
  }

  function normalizeSuggestionEntry(entry = {}) {
    const key = safeString(
      SUGGESTION_VALUE_MODE === "path"
        ? entry.propPath
        : entry.activeEffectKey ?? entry.key
    );

    if (!key) return null;

    return {
      key,
      rawKey: safeString(entry.key ?? entry.activeEffectKey, key),
      label: safeString(entry.label, key),
      category: safeString(entry.category, "Actor Key"),
      valueKind: safeString(entry.valueKind, "unknown"),
      source: safeString(entry.source, ""),
      currentValue: entry.currentValue,
      recommendedChange: entry.recommendedChange ?? null,
      entry
    };
  }

function isBlockedFocusedKey(key, entry = {}) {
  const clean = safeString(key);
  const normalized = normalizeKeyText(clean);

  if (!clean) return true;
  if (FOCUSED_BLOCKED_KEYS.has(clean)) return true;

  // Avoid tiny option IDs.
  if (/^[A-Z]{1,3}$/.test(clean)) return true;

  // Avoid obvious containers.
  if (/_panel$/i.test(clean)) return true;
  if (/_tab$/i.test(clean)) return true;
  if (/active_effect_list/i.test(clean)) return true;

  // Avoid party/database/story/item/template keys.
  if (FOCUSED_BLOCKED_KEY_PATTERNS.some(re => re.test(clean) || re.test(normalized))) {
    return true;
  }

  const type = safeString(entry.type ?? entry.fieldType).toLowerCase();

  if (["tab", "panel", "activeeffectcontainer", "dynamictable"].includes(type)) {
    return true;
  }

  return false;
}

  function getKeywordGroupForQuery(query = "") {
    const q = normalizeKeyText(query);
    if (!q) return null;

    return FOCUSED_KEYWORD_GROUPS.find(group => {
      return group.terms.some(term => {
        const t = normalizeKeyText(term);
        return q === t || q.includes(t) || t.includes(q);
      });
    }) ?? null;
  }

  function keyMatchesKeywordGroup(key, group) {
    if (!group) return false;

    const k = normalizeKeyText(key);

    if (group.id === "dex") return /(^|_)dex($|_)/i.test(k);
    if (group.id === "wlp") return /(^|_)wlp($|_)/i.test(k);
    if (group.id === "ins") return /(^|_)ins($|_)/i.test(k);
    if (group.id === "mig") return /(^|_)mig($|_)/i.test(k);

    if (group.id === "defense") {
      return (
        /(^|_)def($|_)/i.test(k) ||
        /(^|_)defense($|_)/i.test(k) ||
        k.includes("defense")
      );
    }

    if (group.id === "magic_defense") {
      return (
        k.includes("magic_defense") ||
        k.includes("magicdefense") ||
        k.includes("mdef")
      );
    }

    if (group.id === "range") {
      return k.includes("range") || k.includes("ranged");
    }

    if (group.id === "bow") {
      return k.includes("bow");
    }

    return group.terms.some(term => {
      const t = normalizeKeyText(term);
      return k.includes(t);
    });
  }

function isAllowedGameplayKeyFamily(key) {
  const k = normalizeKeyText(key);

  if (!k) return false;

  // Exact resource keys only.
  // This prevents skill_hp, member_currenthp_1, bench_maxhp_1, etc.
  if (/^(current|max)_(hp|mp|ip)$/.test(k)) return true;

  // Attribute dice.
  if (/^(dex|ins|mig|wlp)_(base|current)$/.test(k)) return true;
  if (/^base_(dex|ins|mig|wlp)$/.test(k)) return true;
  if (/^(bonus|override)_(dex|ins|mig|wlp)$/.test(k)) return true;

  // Defense.
  if (/^(defense|magic_defense)$/.test(k)) return true;
  if (/^(bonus|override)_(defense|magic_defense)$/.test(k)) return true;

  // Accuracy.
  if (/^attack_accuracy_mod_(all|melee|ranged|magic)$/.test(k)) return true;

  // Extra damage.
  if (
    /^extra_damage_mod_(all|melee|ranged|spell|physical|air|bolt|dark|earth|fire|ice|light|poison|arcane|bow|brawling|dagger|firearm|flail|heavy|spear|sword|thrown)$/.test(k)
  ) {
    return true;
  }

  // Damage reduction.
  if (
    /^damage_receiving_(mod|percentage)_(all|melee|range|ranged|physical|air|bolt|dark|earth|fire|ice|light|poison)$/.test(k)
  ) {
    return true;
  }

  // Weapon efficiency.
  if (/^(arcane|bow|brawling|dagger|firearm|flail|heavy|spear|sword|thrown)_ef$/.test(k)) {
    return true;
  }

  return false;
}

function keyMatchesAnyAllowedKeyword(key) {
  return isAllowedGameplayKeyFamily(key);
}

function entryMatchesAllowedKeyword(entry = {}) {
  const key = getEntryKey(entry);
  if (isBlockedFocusedKey(key, entry)) return false;

  return isAllowedGameplayKeyFamily(key);
}

  function focusedEntryMatchesQuery(entry = {}, query = "") {
    const q = safeString(query);
    if (!q) return true;

    const key = getEntryKey(entry);
    const normalizedKey = normalizeKeyText(key);
    const normalizedQuery = normalizeKeyText(q);

    if (!normalizedQuery) return true;

    if (normalizedKey.includes(normalizedQuery)) return true;

    const group = getKeywordGroupForQuery(q);
    if (group && keyMatchesKeywordGroup(key, group)) return true;

    const text = normalizeKeyText([
      key,
      entry.label,
      entry.category,
      entry.valueKind,
      getEntrySections(entry).join(" ")
    ].join(" "));

    return text.includes(normalizedQuery);
  }

  function inferFocusedCategoryFromKey(key) {
    const k = normalizeKeyText(key);

    if (/^(current|max)_(hp|mp|ip)$/.test(k)) return "Resource";
    if (/(^|_)(dex|mig|ins|wlp)($|_)/.test(k)) return "Parameter";
    if (k.includes("magic_defense")) return "Parameter";
    if (k.includes("defense") || k === "def") return "Parameter";

    if (
      k.includes("fire") ||
      k.includes("air") ||
      k.includes("physical") ||
      k.includes("ice") ||
      k.includes("dark") ||
      k.includes("light") ||
      k.includes("bolt") ||
      k.includes("earth") ||
      k.includes("poison")
    ) {
      return "Type Affinity / Damage";
    }

    if (
      k.includes("sword") ||
      k.includes("arcane") ||
      k.includes("firearm") ||
      k.includes("bow") ||
      k.includes("flail") ||
      k.includes("thrown") ||
      k.includes("brawling") ||
      k.includes("heavy") ||
      k.includes("dagger") ||
      k.includes("spear")
    ) {
      return "Weapon Efficiency";
    }

    if (k.includes("melee") || k.includes("range") || k.includes("ranged")) return "Range Type";
    if (k.includes("spell") || k.includes("magic")) return "Magic / Spell";

    return "Actor Key";
  }

  function inferValueKindFromValue(value) {
    if (typeof value === "boolean") return "boolean";
    if (typeof value === "number") return "number";

    const n = Number(value);
    if (value !== "" && value != null && Number.isFinite(n)) return "number";

    return "text";
  }

  function makeActorPropEntry(key, value, actor = null) {
    const cleanKey = safeString(key);
    if (!cleanKey) return null;

    return {
      key: cleanKey,
      activeEffectKey: cleanKey,
      propPath: `system.props.${cleanKey}`,
      label: cleanKey
        .replace(/_/g, " ")
        .replace(/\b\w/g, m => m.toUpperCase()),
      category: inferFocusedCategoryFromKey(cleanKey),
      section: [inferFocusedCategoryFromKey(cleanKey)],
      valueKind: inferValueKindFromValue(value),
      currentValue: value,
      recommendedChange: {
        key: cleanKey,
        mode: CONST?.ACTIVE_EFFECT_MODES?.ADD ?? 2,
        value: "1",
        priority: 20
      },
      isRecommended: true,
      isActorPropKey: true,
      source: actor?.name ? `Actor Data: ${actor.name}` : "Actor Data"
    };
  }

  function buildActorPropEntries(actor = null) {
    const props = actor?.system?.props ?? {};
    if (!props || typeof props !== "object") return [];

    return Object.entries(props)
      .map(([key, value]) => makeActorPropEntry(key, value, actor))
      .filter(Boolean)
      .filter(entry => entryMatchesAllowedKeyword(entry));
  }

  function makeFocusedManualEntry(row = {}, actor = null) {
    const key = safeString(row.key);
    if (!key) return null;

    const props = actor?.system?.props ?? {};
    const hasProp = Object.prototype.hasOwnProperty.call(props, key);

    return {
      key,
      activeEffectKey: key,
      propPath: `system.props.${key}`,
      label: row.label,
      category: row.category,
      section: [row.category],
      valueKind: row.valueKind ?? "number",
      currentValue: hasProp ? props[key] : undefined,
      recommendedChange: {
        key,
        mode: CONST?.ACTIVE_EFFECT_MODES?.ADD ?? 2,
        value: "1",
        priority: 20
      },
      isRecommended: true,
      isFocusedManual: true,
      source: "Focused Actor Modifier"
    };
  }

  function buildFocusedManualEntries(actor = null) {
    if (!CFG.includeFocusedFallbackKeys) return [];

    return FOCUSED_EXTRA_KEYS
      .map(row => makeFocusedManualEntry(row, actor))
      .filter(Boolean)
      .filter(entry => entryMatchesAllowedKeyword(entry));
  }

  function buildFocusedBuiltinEntries(actor = null) {
  return FOCUSED_BUILTIN_GAMEPLAY_KEYS
    .map(row => makeFocusedManualEntry({
      key: row.key,
      label: row.label ?? row.key.replace(/_/g, " ").replace(/\b\w/g, m => m.toUpperCase()),
      category: row.category ?? inferFocusedCategoryFromKey(row.key),
      valueKind: row.valueKind ?? "number"
    }, actor))
    .filter(Boolean)
    .filter(entry => entryMatchesAllowedKeyword(entry));
}

  function dedupeFocusedEntries(entries = []) {
    const byKey = new Map();

    for (const entry of asArray(entries)) {
      const key = getEntryKey(entry);
      if (!key) continue;

      const existing = byKey.get(key);

      if (!existing) {
        byKey.set(key, entry);
        continue;
      }

      const existingScore =
        (existing.isActorPropKey ? 200 : 0) +
        (existing.isFocusedManual ? 100 : 0) +
        (existing.isRecommended ? 20 : 0);

      const nextScore =
        (entry.isActorPropKey ? 200 : 0) +
        (entry.isFocusedManual ? 100 : 0) +
        (entry.isRecommended ? 20 : 0);

      if (nextScore > existingScore) {
        byKey.set(key, entry);
      }
    }

    return Array.from(byKey.values());
  }

  function focusedRank(entry = {}, query = "") {
    const key = getEntryKey(entry);
    const q = safeString(query);
    const normalizedKey = normalizeKeyText(key);
    const normalizedQuery = normalizeKeyText(q);

    let rank = 0;

    if (entry.isActorPropKey) rank += 10000;
    if (entry.isFocusedManual) rank += 9000;
    if (entry.isRecommended) rank += 500;

    // Query relevance wins.
    if (normalizedQuery) {
      const group = getKeywordGroupForQuery(q);

      if (normalizedKey === normalizedQuery) rank += 100000;
      else if (normalizedKey.startsWith(normalizedQuery)) rank += 80000;
      else if (normalizedKey.includes(normalizedQuery)) rank += 60000;

      if (group && keyMatchesKeywordGroup(key, group)) rank += 50000;
    }

    // Common Active Effect modifiers float higher inside their keyword group.
    if (/^bonus_/.test(normalizedKey)) rank += 8000;
    if (/^override_/.test(normalizedKey)) rank += 7500;
    if (/^base_/.test(normalizedKey) || /_base$/.test(normalizedKey)) rank += 7000;
    if (/^current_/.test(normalizedKey)) rank += 6500;
    if (/^max_/.test(normalizedKey)) rank += 6200;

    if (normalizedKey.includes("magic_defense")) rank += 5800;
    if (normalizedKey.includes("defense")) rank += 5500;
    if (normalizedKey.endsWith("_ef")) rank += 5000;
    if (normalizedKey.includes("affinity")) rank += 4800;
    if (normalizedKey.includes("damage")) rank += 4600;
    if (normalizedKey.includes("accuracy")) rank += 4400;

    return rank;
  }

function applyFocusedSuggestionProfile(entries = [], options = {}) {
  if (!CFG.focusedActorModifierSuggestions) {
    return dedupeFocusedEntries(entries);
  }

  const q = safeString(options.query);
  const actor = options.actor ?? STATE.lastActor ?? null;

  const catalogueEntries = CFG.useFieldCatalogueRowsInDropdown
    ? asArray(entries).filter(entry => entryMatchesAllowedKeyword(entry))
    : [];

  const combined = [
    ...buildActorPropEntries(actor),
    ...buildFocusedBuiltinEntries(actor),
    ...buildFocusedManualEntries(actor),
    ...catalogueEntries
  ];

  return dedupeFocusedEntries(combined)
    .filter(entry => focusedEntryMatchesQuery(entry, q))
    .sort((a, b) => focusedRank(b, q) - focusedRank(a, q));
}

  // --------------------------------------------------------------------------
  // Field catalogue / refresh / public suggestion query
  // --------------------------------------------------------------------------

  async function refresh(actorOrUuid = null, options = {}) {
    const catalogue = getFieldCatalogueApi();

    const actor = await resolveSuggestionActor(actorOrUuid, options);
    const actorUuid = actor?.uuid ?? null;
    const cacheKey = actorUuid ?? "fallback";
    const now = Date.now();

    const cached = STATE.refreshCache.get(cacheKey);
    const cacheMs = Number(options.cacheMs ?? CFG.cacheMs) || 0;

    if (!options.force && cached && now - cached.refreshedAt < cacheMs) {
      const report = {
        ok: true,
        cached: true,
        actorUuid,
        actorName: actor?.name ?? null,
        count: cached.entries.length,
        entries: cached.entries
      };

      STATE.lastRefreshReport = report;
      STATE.lastActorUuid = actorUuid;
      STATE.lastActor = actor;
      STATE.lastEntries = cached.entries;

      return report;
    }

    let rawEntries = [];

    try {
      if (catalogue && typeof catalogue.refresh === "function") {
        await catalogue.refresh({
          actorUuid,
          includeLegacyConditionKeys: options.includeLegacyConditionKeys ?? CFG.includeLegacyConditionKeys,
          includeReadOnly: options.includeReadOnly ?? CFG.includeReadOnly,
          suggestionsOnly: options.suggestionsOnly ?? CFG.suggestionsOnly
        });
      }

      if (catalogue) {
        const entries =
          typeof catalogue.getRecommended === "function"
            ? catalogue.getRecommended({ cloneResult: false })
            : typeof catalogue.getAll === "function"
              ? catalogue.getAll({ cloneResult: false })
              : [];

        rawEntries = Array.isArray(entries) ? entries : [];
      }

      const focusedEntries = applyFocusedSuggestionProfile(rawEntries, {
        actor,
        actorUuid,
        query: ""
      });

      STATE.refreshCache.set(cacheKey, {
        actorUuid,
        actorName: actor?.name ?? null,
        refreshedAt: now,
        entries: focusedEntries
      });

      STATE.lastActorUuid = actorUuid;
      STATE.lastActor = actor;
      STATE.lastEntries = focusedEntries;

      const report = {
        ok: true,
        cached: false,
        actorUuid,
        actorName: actor?.name ?? null,
        count: focusedEntries.length,
        rawCountBeforeFocusFilter: rawEntries.length,
        fieldCatalogueLoaded: !!catalogue,
        entries: focusedEntries
      };

      STATE.lastRefreshReport = report;
      return report;
    } catch (e) {
      const fallbackEntries = applyFocusedSuggestionProfile([], {
        actor,
        actorUuid,
        query: ""
      });

      const report = {
        ok: false,
        reason: "field_catalogue_refresh_failed",
        error: compactError(e),
        actorUuid,
        actorName: actor?.name ?? null,
        entries: cached?.entries ?? fallbackEntries
      };

      STATE.lastRefreshReport = report;
      STATE.lastActorUuid = actorUuid;
      STATE.lastActor = actor;
      STATE.lastEntries = report.entries;

      warn("Field catalogue refresh failed. Actor prop suggestions may still work.", report);
      return report;
    }
  }

  function getSessionEntries(options = {}) {
    const session = options.session ?? null;

    if (Array.isArray(session?.fieldEntries) && session.fieldEntries.length) {
      return session.fieldEntries;
    }

    const actorUuid =
      options.actor?.uuid ??
      options.actorUuid ??
      session?.actor?.uuid ??
      STATE.lastActorUuid ??
      null;

    if (actorUuid && STATE.refreshCache.has(actorUuid)) {
      return STATE.refreshCache.get(actorUuid).entries ?? [];
    }

    if (STATE.lastEntries?.length) return STATE.lastEntries;

    const fallback = STATE.refreshCache.get("fallback");
    if (fallback) return fallback.entries ?? [];

    const catalogue = getFieldCatalogueApi();

    try {
      const rows =
        typeof catalogue?.getRecommended === "function"
          ? catalogue.getRecommended({ cloneResult: false })
          : typeof catalogue?.getAll === "function"
            ? catalogue.getAll({ cloneResult: false })
            : [];

      return applyFocusedSuggestionProfile(Array.isArray(rows) ? rows : [], options);
    } catch (_e) {
      return [];
    }
  }

  function getSuggestions(query = "", options = {}) {
    const catalogue = getFieldCatalogueApi();
    const q = safeString(query);
    const limit = Number(options.limit ?? CFG.limit) || CFG.limit;

    const actor =
      options.actor ??
      options.session?.actor ??
      STATE.lastActor ??
      null;

    const rawRows = [];

try {
  if (CFG.useFieldCatalogueRowsInDropdown && typeof catalogue?.getSuggestions === "function") {
        const rows = catalogue.getSuggestions(q, {
          limit: Math.max(limit * 4, 40),
          cloneResult: false
        });

        if (Array.isArray(rows)) rawRows.push(...rows);
      }
    } catch (_e) {}

    rawRows.push(...getSessionEntries({
      ...options,
      actor
    }));

    const focusedRows = applyFocusedSuggestionProfile(rawRows, {
      actor,
      actorUuid: options.actorUuid ?? actor?.uuid ?? STATE.lastActorUuid ?? null,
      query: q
    });

    return focusedRows
      .map(normalizeSuggestionEntry)
      .filter(Boolean)
      .sort((a, b) => focusedRank(b.entry ?? b, q) - focusedRank(a.entry ?? a, q))
      .slice(0, limit);
  }

  // --------------------------------------------------------------------------
  // Input detection / dropdown binding
  // --------------------------------------------------------------------------

  function rowLooksLikeChangeRow(input, root) {
    const row =
      input.closest?.("tr, .form-group, .form-fields, .effect-change, .changes-list, li, fieldset") ??
      null;

    if (!row) return false;

    const names = Array.from(row.querySelectorAll?.("input, textarea, select") ?? [])
      .map(el => String(el.getAttribute("name") ?? ""));

    const hasChangeNames = names.some(name => /(^|\.|\[)changes(\.|\[|\])/i.test(name));
    const hasValueOrMode = names.some(name => /(\.|\[)(mode|value|priority)(\]|$|\.)/i.test(name));

    if (hasChangeNames && hasValueOrMode) return true;

    const labelText = [
      input.closest?.("label")?.textContent ?? "",
      input.id ? root?.querySelector?.(`label[for="${cssEscape(input.id)}"]`)?.textContent ?? "" : "",
      row.textContent ?? ""
    ].join(" ").toLowerCase();

    return /attribute\s*key|data\s*key|change\s*key|effect\s*key/.test(labelText) && hasValueOrMode;
  }

  function isActiveEffectChangeKeyInput(input, root) {
    if (!input || input.disabled || input.readOnly) return false;

    const name = String(input.getAttribute("name") ?? "");
    const placeholder = String(input.getAttribute("placeholder") ?? "");
    const aria = String(input.getAttribute("aria-label") ?? "");
    const title = String(input.getAttribute("title") ?? "");
    const text = [name, placeholder, aria, title].join(" ").toLowerCase();

    const explicitChangeKey =
      /(^|\.|\[)changes(\.|\[|\])/i.test(name) &&
      /(\.|\[)key(\]|$|\.)/i.test(name);

    if (explicitChangeKey) return true;

    const simpleKey =
      /^key$/i.test(name) ||
      /\.key$/i.test(name) ||
      /\[key\]$/i.test(name) ||
      /attribute key|data key|change key/.test(text);

    return simpleKey && rowLooksLikeChangeRow(input, root);
  }

  function findAttributeKeyFields(root) {
    const candidates = Array.from(root?.querySelectorAll?.("input, textarea") ?? []);
    return candidates.filter(input => isActiveEffectChangeKeyInput(input, root));
  }

  function renderDropdown(field, rows) {
    const dropdown = getDropdown();

    if (!field || !rows.length) {
      hideDropdown();
      return;
    }

    STATE.activeField = field;
    STATE.activeRows = rows;
    STATE.activeIndex = 0;

    dropdown.__oniAeSuggestions = rows;
    dropdown.__oniAeField = field;

    dropdown.innerHTML = `
      <div class="aem-suggest-head">Active Effect Key Suggestions</div>
      ${rows.map((row, index) => `
        <div
          class="aem-suggest-row ${index === 0 ? "active" : ""}"
          data-suggestion-index="${index}"
          data-suggestion-key="${escapeHtml(row.key)}"
        >
          <div class="aem-suggest-key">${escapeHtml(row.key)}</div>
          <div class="aem-suggest-meta">
            ${escapeHtml(row.label)}
            ${row.category ? " • " + escapeHtml(row.category) : ""}
            ${row.valueKind ? " • " + escapeHtml(row.valueKind) : ""}
          </div>
        </div>
      `).join("")}
    `;

    const rect = field.getBoundingClientRect();
    const maxLeft = Math.max(6, window.innerWidth - 470);
    const left = Math.min(Math.max(6, rect.left), maxLeft);

    dropdown.style.left = `${left}px`;
    dropdown.style.top = `${Math.max(6, rect.bottom + 4)}px`;
    dropdown.style.minWidth = `${Math.max(260, rect.width)}px`;
    dropdown.style.display = "block";
  }

  function refreshDropdownForField(field, session) {
    const rows = getSuggestions(field.value, {
      session,
      actor: session?.actor,
      actorUuid: session?.actor?.uuid,
      limit: CFG.limit
    });

    renderDropdown(field, rows);
  }

  function updateActiveRow() {
    const dropdown = STATE.dropdown;
    if (!dropdown) return;

    const rows = Array.from(dropdown.querySelectorAll?.(".aem-suggest-row") ?? []);

    for (const row of rows) row.classList.remove("active");

    const active = rows[STATE.activeIndex];
    active?.classList.add("active");
    active?.scrollIntoView?.({ block: "nearest" });
  }

  function moveActive(dir) {
    const total = STATE.activeRows.length;
    if (!total) return;

    STATE.activeIndex = Math.max(0, Math.min(total - 1, STATE.activeIndex + dir));
    updateActiveRow();
  }

  function chooseSuggestion(index = STATE.activeIndex) {
    const field = STATE.activeField ?? STATE.dropdown?.__oniAeField ?? null;
    const row = STATE.activeRows[index] ?? STATE.dropdown?.__oniAeSuggestions?.[index] ?? null;

    if (!field || !row) return false;

    field.value = row.key;

    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));

    hideDropdown();

    try {
      field.focus();
    } catch (_e) {}

    return true;
  }

  function bindField(field, session) {
    // Same marker as the old native builder so two systems do not bind one input twice.
    if (!field || field.dataset.oniAemNativeSuggestBound) return false;

    field.dataset.oniAemNativeSuggestBound = "1";
    field.dataset.oniAeKeySuggestGlobal = "1";
    field.setAttribute("autocomplete", "off");

    field.addEventListener("focus", () => refreshDropdownForField(field, session));
    field.addEventListener("click", () => refreshDropdownForField(field, session));
    field.addEventListener("input", () => refreshDropdownForField(field, session));

    field.addEventListener("keydown", ev => {
      const dropdown = STATE.dropdown;
      const open = dropdown?.style?.display === "block";
      if (!open || STATE.activeField !== field) return;

      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        moveActive(1);
        return;
      }

      if (ev.key === "ArrowUp") {
        ev.preventDefault();
        moveActive(-1);
        return;
      }

      if (ev.key === "Enter" || ev.key === "Tab") {
        if (STATE.activeRows.length) {
          ev.preventDefault();
          chooseSuggestion(STATE.activeIndex);
        }
        return;
      }

      if (ev.key === "Escape") {
        hideDropdown();
      }
    });

    return true;
  }

  function bindFields(root, session) {
    const fields = findAttributeKeyFields(root);
    let bound = 0;

    for (const field of fields) {
      if (bindField(field, session)) bound++;
    }

    STATE.lastInstallCount = fields.length;

    return {
      ok: true,
      fields: fields.length,
      newlyBound: bound
    };
  }

  // --------------------------------------------------------------------------
  // Sheet install / lifecycle
  // --------------------------------------------------------------------------

  function patchSheetClose(app, session) {
    if (!app?.close || app.__oniAeKeySuggestClosePatched) return;

    const originalClose = app.close.bind(app);

    app.__oniAeKeySuggestClosePatched = true;
    app.__oniAeKeySuggestOriginalClose = originalClose;

    app.close = async function patchedActiveEffectKeySuggestionClose(...args) {
      try {
        session.observer?.disconnect?.();

        if (STATE.activeField && session.root?.contains?.(STATE.activeField)) {
          hideDropdown();
        }
      } catch (_e) {}

      return await originalClose(...args);
    };
  }

  function getOrCreateSession(app, root) {
    let session = STATE.sheetSessions.get(app);

    if (!session) {
      session = {
        app,
        root,
        actor: null,
        fieldEntries: [],
        observer: null,
        refreshing: false
      };

      STATE.sheetSessions.set(app, session);
      patchSheetClose(app, session);
    }

    session.root = root ?? session.root;
    return session;
  }

  async function installIntoSheet(app, html, options = {}) {
    if (!CFG.enabled && options.force !== true) {
      return {
        ok: false,
        reason: "disabled"
      };
    }

    const root = getSheetRoot(app, html);

    if (!root) {
      return {
        ok: false,
        reason: "sheet_root_not_found"
      };
    }

    ensureStyle();
    getDropdown();

    const session = getOrCreateSession(app, root);
    session.actor = await resolveSuggestionActor(app, options);

    const firstBind = bindFields(root, session);

    if (CFG.refreshOnRender || options.forceRefresh) {
      session.refreshing = true;

      const report = await refresh(session.actor, {
        ...options,
        force: !!options.forceRefresh
      });

      session.refreshing = false;
      session.fieldEntries = report.entries ?? [];
    }

    const secondBind = bindFields(root, session);

    if (!session.observer) {
      session.observer = new MutationObserver(() => {
        bindFields(root, session);
      });

      session.observer.observe(root, {
        childList: true,
        subtree: true
      });
    }

    log("Installed key suggestions into ActiveEffect sheet.", {
      sheet: app?.constructor?.name,
      actor: session.actor?.name,
      fields: secondBind.fields,
      newlyBound: firstBind.newlyBound + secondBind.newlyBound,
      suggestions: session.fieldEntries.length
    });

    return {
      ok: true,
      sheet: app?.constructor?.name ?? null,
      actorUuid: session.actor?.uuid ?? null,
      actorName: session.actor?.name ?? null,
      fields: secondBind.fields,
      fieldSuggestions: session.fieldEntries.length
    };
  }

  function installHooks() {
    if (STATE.installed) return;

    for (const hookName of CFG.hookNames) {
      const id = Hooks.on(hookName, (app, html, data) => {
        installIntoSheet(app, html, { data }).catch(e => {
          warn(`Could not install key suggestions from ${hookName}.`, e);
        });

        setTimeout(() => {
          installIntoSheet(app, html, { data }).catch(() => {});
        }, 80);

        setTimeout(() => {
          installIntoSheet(app, html, { data }).catch(() => {});
        }, 350);
      });

      STATE.hookIds.push({ hookName, id });
    }

    STATE.installed = true;

    log("Installed ActiveEffect key suggestion hooks.", CFG.hookNames);
  }

  function uninstallHooks() {
    for (const row of STATE.hookIds.splice(0)) {
      try {
        Hooks.off(row.hookName, row.id);
      } catch (_e) {}
    }

    STATE.installed = false;
  }

  function status() {
    return {
      ok: true,
      version: api.version,
      enabled: CFG.enabled,
      installed: STATE.installed,
      hooks: STATE.hookIds.map(row => row.hookName),
      dropdownConnected: !!STATE.dropdown?.isConnected,
      lastInstallCount: STATE.lastInstallCount,
      lastActorUuid: STATE.lastActorUuid,
      lastActorName: STATE.lastActor?.name ?? null,
      lastEntriesCount: STATE.lastEntries?.length ?? 0,
      lastRefreshReport: STATE.lastRefreshReport
        ? {
            ok: STATE.lastRefreshReport.ok,
            cached: !!STATE.lastRefreshReport.cached,
            reason: STATE.lastRefreshReport.reason ?? null,
            actorUuid: STATE.lastRefreshReport.actorUuid ?? null,
            actorName: STATE.lastRefreshReport.actorName ?? null,
            count: STATE.lastRefreshReport.count ?? STATE.lastRefreshReport.entries?.length ?? 0,
            error: STATE.lastRefreshReport.error ?? null,
            fieldCatalogueLoaded: STATE.lastRefreshReport.fieldCatalogueLoaded ?? !!getFieldCatalogueApi()
          }
        : null,
      fieldCatalogueLoaded: !!getFieldCatalogueApi()
    };
  }

  function setEnabled(enabled = true) {
    CFG.enabled = !!enabled;
    if (!CFG.enabled) hideDropdown();
    return status();
  }

  const api = {
    version: "2.0.1",
    status,
    setEnabled,
    installHooks,
    uninstallHooks,
    installIntoSheet,
    refresh,
    getSuggestions,
    findAttributeKeyFields,
    hideDropdown,
    _internal: {
      CFG,
      STATE,
      FOCUSED_KEYWORD_GROUPS,
      FOCUSED_EXTRA_KEYS,
      getFieldCatalogueApi,
      normalizeSuggestionEntry,
      getEntryKey,
      normalizeKeyText,
      entryMatchesAllowedKeyword,
      focusedEntryMatchesQuery,
      applyFocusedSuggestionProfile,
      isActiveEffectChangeKeyInput,
      bindFields
    }
  };

  exposeApi(api);

  Hooks.once("ready", () => {
    installHooks();
  });
})();