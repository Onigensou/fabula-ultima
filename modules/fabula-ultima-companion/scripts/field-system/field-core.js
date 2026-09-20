// ============================================================================
// Field System — pure core (no Foundry globals).
//
// A "field effect" is an effect held by the BATTLE SCENE itself rather than by
// any creature: the elemental wellsprings an Invoker draws on, a weather, a
// terrain hazard, a boss arena's aura. The runtime holder is ONE hidden world
// Actor — the Field actor — whose only content is its Active Effects. That
// choice is what makes the whole thing cheap: every facility the engine already
// has for an "effect" (round/turn charges, tags, remove_tagged_ae, the AE →
// reactionConfig bridge, formula identifiers reading AE-applied flags, the
// status library) operates on Active Effects on an Actor, so a field effect
// needs none of it re-implemented.
//
// Relationship to the Conflict Event system (scripts/conflict-event/): that is
// the SCRIPTED counterpart — one JS-authored rule per scene, for hazards whose
// logic cannot be expressed declaratively (Lightning Storm's moving Rod). The
// Field is the DATA counterpart: any number of effects, authored as AE templates
// in the "Field Effects" library, stackable, readable by gate formulas and
// writable by skills through `target_ref: "field"`. They coexist; a conflict
// event may itself seed Field AEs.
//
// Two ways a field effect reaches creatures, both pre-existing:
//   QUERY — a formula identifier reads the Field's AE-applied flags
//           (WELLSPRING_<ELEM>_AVAILABLE, FIELD_HAS_<NAME>, FIELD_FLAG_<KEY>).
//   PUSH  — the AE carries `flags[NS].reactionConfig` (the Ninja Log pattern);
//           the Field is enumerated as a REACTOR, so a `round_end` row on it
//           fires like any creature's. Rows on the Field must be `force` / `on`
//           (there is no token to hang an ask-menu on) and should use
//           `reaction_source: "all"` — the Field has no side.
//
// Scoping rule for availability questions (one line, applied everywhere):
//   available(X) = Field AEs ∪ the ASKING creature's own AEs with the same flag.
// So a per-character grant (Inner Wellspring, Wheel of Moon and Sun) is an
// ordinary self-AE carrying `flags.<NS>.wellspring_<elem>` and needs no field
// machinery at all.
//
// This module is deliberately PURE so field-core.test.mjs runs in bare Node.
// ============================================================================

export const FLAG_NS = "fabula-ultima-companion";

/** Actor flag marking THE Field actor. Exactly one per world. */
export const FIELD_ACTOR_FLAG = "isField";
export const FIELD_ACTOR_NAME = "Field";
export const FIELD_TEMPLATE_NAME = "_Field Template";
/** The activeEffectContainer Item holding field-effect AE templates. */
export const FIELD_LIBRARY_NAME = "Field Effects";

/** Scene flag path pieces — same root/group the Scene Config UI writes. */
export const SCENE_FLAG_ROOT = "oniFabula";
export const SCENE_FLAG_GROUP = "general";
/** Newline/comma-separated AE template names the scene seeds onto the Field. */
export const SCENE_FIELD_EFFECTS_KEY = "fieldEffects";

/** AE flag stamps on a scene-seeded Field AE. */
export const AE_ORIGIN_KEY = "fieldOrigin";      // "scene" | "skill" | "gm"
export const AE_SCENE_ID_KEY = "fieldSceneId";   // which scene seeded it

/**
 * The wellspring vocabulary. `elem` is the DAMAGE TYPE (what formulas and
 * changes key on); `label` is the fiction name RAW uses for the wellspring
 * (Lightning → bolt, Water → ice — the two renames that trip people up).
 * The five RAW scene wellsprings default to AVAILABLE when a scene has no
 * config (so the class works out of the box); Moon/Sun are heroic-only and
 * default to absent.
 */
export const WELLSPRINGS = Object.freeze([
  { elem: "air",   label: "Air",       aeName: "Air Wellspring",       defaultOn: true,  color: "#5fd3c6", icon: "fa-wind",      img: "icons/magic/air/wind-stream-blue-gray.webp" },
  { elem: "earth", label: "Earth",     aeName: "Earth Wellspring",     defaultOn: true,  color: "#c19a6b", icon: "fa-mountain",  img: "icons/magic/earth/projectile-boulder-dust.webp" },
  { elem: "fire",  label: "Fire",      aeName: "Fire Wellspring",      defaultOn: true,  color: "#e8603c", icon: "fa-fire",      img: "icons/magic/fire/flame-burning-campfire-orange.webp" },
  { elem: "bolt",  label: "Lightning", aeName: "Lightning Wellspring", defaultOn: true,  color: "#e8c93c", icon: "fa-bolt",      img: "icons/magic/lightning/bolt-strike-blue.webp" },
  { elem: "ice",   label: "Water",     aeName: "Water Wellspring",     defaultOn: true,  color: "#6fb7e8", icon: "fa-snowflake", img: "icons/magic/water/orb-water-bubbles-blue.webp" },
  { elem: "dark",  label: "Moon",      aeName: "Moon Wellspring",      defaultOn: false, color: "#8f7bd8", icon: "fa-moon",      img: "icons/magic/unholy/orb-glowing-purple.webp" },
  { elem: "light", label: "Sun",       aeName: "Sun Wellspring",       defaultOn: false, color: "#f2d16b", icon: "fa-sun",       img: "icons/magic/light/explosion-star-glow-orange.webp" },
]);

export const WELLSPRING_ELEMS = Object.freeze(WELLSPRINGS.map((w) => w.elem));

/** The AE-applied actor flag a wellspring grant sets (on the Field OR on a creature). */
export function wellspringFlagKey(elem) { return `wellspring_${String(elem).toLowerCase()}`; }
export function wellspringChangeKey(elem) { return `flags.${FLAG_NS}.${wellspringFlagKey(elem)}`; }

/**
 * Which wellsprings a scene declares, from its `general` flag group.
 * Per-element boolean `wellspring_<elem>`: UNSET → the element's default
 * (the five RAW ones available, Moon/Sun absent); explicit true/false wins.
 * Accepts the raw group object (or null for "no config at all").
 */
export function sceneWellsprings(general) {
  const g = general ?? {};
  const out = [];
  for (const w of WELLSPRINGS) {
    const raw = g[wellspringFlagKey(w.elem)];
    const on = (raw === undefined || raw === null || raw === "") ? w.defaultOn : truthy(raw);
    if (on) out.push(w.elem);
  }
  return out;
}

/** Parse the scene's free-form field-effect list ("Rain, Fog" / one per line). */
export function parseFieldEffectList(raw) {
  if (Array.isArray(raw)) return raw.map((s) => String(s ?? "").trim()).filter(Boolean);
  return String(raw ?? "")
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The full set of AE template NAMES a scene wants on the Field: its wellsprings
 * (as library AEs) plus its declared field effects. Deduped, order-stable.
 */
export function desiredSceneEffectNames(general) {
  const names = [];
  const seen = new Set();
  const push = (n) => { const k = n.toLowerCase(); if (!seen.has(k)) { seen.add(k); names.push(n); } };
  for (const elem of sceneWellsprings(general)) {
    const w = WELLSPRINGS.find((x) => x.elem === elem);
    if (w) push(w.aeName);
  }
  for (const n of parseFieldEffectList(general?.[SCENE_FIELD_EFFECTS_KEY])) push(n);
  return names;
}

/**
 * Reconcile plan: given the AEs currently on the Field (plain objects with
 * name + flags) and the desired scene names, decide what to delete, what to
 * create and what to PROMOTE. Matching is by name, case-insensitive.
 *
 * Precedence — the scene declaration wins:
 *   • Only SCENE-origin AEs are ever deleted (a skill- or GM-added effect is
 *     not the scene's to remove). A scene-origin AE from ANOTHER scene is
 *     always dropped (scene changed).
 *   • A non-scene copy of a name the scene declares is PROMOTED to scene
 *     ownership rather than merely counted as present: left transient it would
 *     be swept at scene end and the declared effect would vanish until the next
 *     reseed; created alongside it would double-fire a reaction row. One copy,
 *     scene-owned, is the answer. (Post-test review, 2026-09-20.)
 */
export function planSceneReconcile({ existing = [], desiredNames = [], sceneId = null } = {}) {
  const want = new Map(desiredNames.map((n) => [n.toLowerCase(), n]));
  const deleteIds = [];
  const promoteIds = [];
  const have = new Set();
  for (const eff of existing) {
    const f = eff?.flags?.[FLAG_NS] ?? {};
    const name = String(eff?.name ?? "").toLowerCase();
    const id = eff?._id ?? eff?.id;
    if (f[AE_ORIGIN_KEY] !== "scene") {
      // Not ours to remove. If the scene wants it, take ownership of it.
      if (want.has(name) && !have.has(name)) { have.add(name); if (id) promoteIds.push(id); }
      continue;
    }
    const sameScene = sceneId == null || f[AE_SCENE_ID_KEY] === sceneId;
    if (sameScene && want.has(name) && !have.has(name)) { have.add(name); continue; }
    if (id) deleteIds.push(id);
  }
  const createNames = [];
  for (const [k, n] of want) if (!have.has(k)) createNames.push(n);
  return { deleteIds, createNames, promoteIds };
}

/** The flag patch that turns any Field AE into a scene-owned, standing one. */
export function scenePromotionPatch(sceneId) {
  return {
    [`flags.${FLAG_NS}.${AE_ORIGIN_KEY}`]: "scene",
    [`flags.${FLAG_NS}.${AE_SCENE_ID_KEY}`]: sceneId ?? null,
    [`flags.${FLAG_NS}.directorPermanent`]: true,
    // A transient copy's lifetime bookkeeping no longer applies.
    [`flags.${FLAG_NS}.-=directorAppliedBy`]: null,
    [`flags.${FLAG_NS}.-=charges`]: null,
    [`flags.${FLAG_NS}.-=chargesMax`]: null,
    disabled: false,
  };
}

/** Stamp a library AE template object as a scene-seeded Field AE. */
export function stampSceneAE(template, sceneId) {
  const data = JSON.parse(JSON.stringify(template ?? {}));
  delete data._id;
  data.transfer = false;
  data.disabled = false;
  data.flags = data.flags ?? {};
  data.flags[FLAG_NS] = {
    ...(data.flags[FLAG_NS] ?? {}),
    [AE_ORIGIN_KEY]: "scene",
    [AE_SCENE_ID_KEY]: sceneId ?? null,
    // Scene-seeded effects are the scene's standing state: no turn counter, and
    // the scene-end sweep / round tickers leave them alone. Re-seeding is the
    // ONLY thing that removes them.
    directorPermanent: true,
  };
  // A library AE may carry CSB's "predefined" provenance; on the Field it is a
  // live instance, not a template row.
  if (data.flags["custom-system-builder"]) delete data.flags["custom-system-builder"];
  return data;
}

// ── Identifier helpers (used by skill-formulas via the Field actor doc) ─────

/** Normalise an identifier suffix ("SCORCHING_GROUND") to a comparable key. */
export function normName(s) {
  return String(s ?? "").trim().toLowerCase().replace(/[\s\-]+/g, "_");
}

/**
 * Does an actor-like doc carry an ENABLED AE matching `needle` by name, tag or
 * status id? `effects` is any iterable of AE-like objects.
 */
export function hasMarkerEffect(effects, needle) {
  const want = normName(needle);
  if (!want) return false;
  for (const eff of effects ?? []) {
    if (!eff || eff.disabled === true) continue;
    if (normName(eff.name) === want) return true;
    const tags = eff.system?.tags;
    if (Array.isArray(tags) && tags.some((t) => normName(t) === want)) return true;
    const st = eff.statuses;
    const ids = st ? (typeof st.has === "function" ? Array.from(st) : (Array.isArray(st) ? st : [])) : [];
    if (ids.some((s) => normName(s) === want)) return true;
  }
  return false;
}

function truthy(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  const s = String(v ?? "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "on";
}

// ── The Field actor's CSB template (header + body JSON) ─────────────────────
//
// Layout, top to bottom:
//   header  — what this actor is (one line) + how to change it (one line)
//   body    — "Wellsprings" container   (tag `wellspring`; compact: on + name)
//             "Field Effects" container (tag `field`; on + name + description)
//             "GM notes" panel, collapsed by default (the rich-text area)
// Two containers instead of one because a mixed list reads badly: five
// wellspring rows with near-identical descriptions buried the one hazard that
// actually matters this round. `filterTags` filters the ROWS (not just the
// add-dropdown), so the split costs nothing at runtime. An effect with neither
// tag is invisible here — tag what you author (the library does).
//
// FIELD_TEMPLATE_VERSION: bump whenever this layout changes. ensureField
// rewrites an older world's template and reloads the Field actor from it.

export const FIELD_TEMPLATE_VERSION = 4;

function csbBase(extra = {}) {
  return {
    key: "", colSpan: 1, rowSpan: 1, cssClass: "", role: 0, editRole: 0, permission: 0,
    tooltip: "", visibilityFormula: "", ...extra,
  };
}

function csbLabel(key, value, extra = {}) {
  return csbBase({ key, type: "label", value, style: "default", icon: "", prefix: "", suffix: "",
    rollMessage: "", altRollMessage: "", ...extra });
}

function csbEffectContainer({ title, filterTags, withDescription, activeLabel = "On", nameLabel = "Effect" }) {
  return csbBase({
    type: "activeEffectContainer",
    title, hideEmpty: false, headDisplay: true, showDelete: true, showCreateButton: true,
    sortOption: "MANUAL", showOnlyOwnEffects: false, suggestExistingEffects: true, filterTags,
    staticRowLayout: {
      active:      { enabled: true,  colName: activeLabel, align: "left",   sort: 1 },
      name:        { enabled: true,  colName: nameLabel,   align: "left",   sort: 2 },
      origin:      { enabled: false, colName: "Origin",    align: "center", sort: 3 },
      description: { enabled: withDescription, colName: "What it does", align: "left", sort: 4, format: "full" },
      count:       { enabled: false, colName: "Count",     align: "center", sort: 5 },
    },
    contents: [], rowLayout: {},
  });
}

export function buildFieldTemplateSystem() {
  const header = {
    contents: [
      csbBase({
        type: "panel", flow: "vertical", align: "left", collapsible: false, defaultCollapsed: false,
        title: "", titleStyle: "default",
        contents: [
          csbLabel("field_kind", "Battle Field — effects the scene holds, not any creature", { style: "bold", icon: "fa-map" }),
          csbLabel("field_hint", "Set up per scene in Scene Config → Fabula (wellspring chips + Field Effects); this sheet shows what is in play right now. Untick or delete to change it for this scene; skills and hazards can add their own.", { style: "italic" }),
        ],
      }),
    ],
  };
  const body = {
    ...csbBase({ key: "custom_body", type: "panel", flow: "vertical", align: "", collapsible: false, defaultCollapsed: true, title: "", titleStyle: "default" }),
    cssClass: null, tooltip: null, visibilityFormula: null,
    contents: [
      csbEffectContainer({ title: "Wellsprings present on this scene", filterTags: ["wellspring"], withDescription: false, nameLabel: "Wellspring" }),
      csbEffectContainer({ title: "Field Effects in play", filterTags: ["field"], withDescription: true }),
      csbBase({
        type: "panel", flow: "vertical", align: "", collapsible: true, defaultCollapsed: true,
        title: "GM notes (how the field manifests, what the players know)", titleStyle: "default",
        contents: [csbBase({ key: "field_notes", type: "textArea", style: "sheet" })],
      }),
    ],
  };
  return {
    header, body,
    display: { width: "640", height: "720", fix_size: false, pp_width: "96", pp_height: "96" },
    attributeBar: {},
    statusEffects: {},
    hidden: [],
    templateSystemUniqueVersion: Math.floor(Math.random() * 4_000_000_000),
  };
}

// ── The starter library ("Field Effects" activeEffectContainer) ─────────────
//
// Seven wellspring grants plus two worked hazards so an author has a PUSH
// example (a standalone round_end row) and a per-turn example (turn_start with
// subject = the acting creature) to copy from.

const NO_DURATION = { rounds: null, turns: null, seconds: null, startRound: null, startTurn: null, startTime: null, combat: null };

function wellspringAE(w) {
  return {
    name: w.aeName,
    img: w.img ?? "icons/svg/aura.svg",
    description: `<p>The <strong>${w.label}</strong> wellspring is present. Invokers may draw ${w.elem} invocations from it.</p>`,
    changes: [{ key: wellspringChangeKey(w.elem), mode: 5, priority: 20, value: "1" }],
    disabled: false, transfer: false, tint: "#ffffff", type: "base", origin: null,
    duration: { ...NO_DURATION },
    statuses: [],
    system: { tags: ["wellspring"] },
    flags: { [FLAG_NS]: { wellspring: w.elem } },
  };
}

export function buildStarterLibraryEffects() {
  const out = WELLSPRINGS.map(wellspringAE);
  out.push({
    name: "Scorching Ground",
    img: "icons/magic/fire/barrier-wall-flame-ring-blue.webp",
    description: "<p>The ground burns. At the <strong>end of each round</strong>, every creature in the conflict takes <strong>5 fire damage</strong>.</p>",
    changes: [{ key: `flags.${FLAG_NS}.field_scorching`, mode: 5, priority: 20, value: "1" }],
    disabled: false, transfer: false, tint: "#ffffff", type: "base", origin: null,
    duration: { ...NO_DURATION },
    statuses: [],
    system: { tags: ["field", "hazard"] },
    flags: { [FLAG_NS]: {
      reactionConfig: {
        reaction_config_table: { "0": {
          reaction_trigger: "round_end", reaction_passive_mode: "force", reaction_source: "all",
          reaction_effect_ref: "scorch_all",
        } },
        effect_table: { "0": {
          effect_kind: "deal_damage", effect_label: "scorch_all", target_ref: "all_combatants",
          damage_amount: "5", damage_element: "fire", damage_verbosity: "full",
          // The Field has no name worth logging as a dealer; without this the
          // battle log credits "Effect". Name the hazard itself.
          attacker_name: "Scorching Ground",
        } },
      },
    } },
  });
  out.push({
    name: "Thin Air",
    img: "icons/magic/air/fog-gas-smoke-swirling-gray.webp",
    description: "<p>The air is thin. At the <strong>start of each creature's turn</strong>, it loses <strong>5 Mind Points</strong>.</p>",
    changes: [{ key: `flags.${FLAG_NS}.field_thin_air`, mode: 5, priority: 20, value: "1" }],
    disabled: false, transfer: false, tint: "#ffffff", type: "base", origin: null,
    duration: { ...NO_DURATION },
    statuses: [],
    system: { tags: ["field", "hazard"] },
    flags: { [FLAG_NS]: {
      reactionConfig: {
        reaction_config_table: { "0": {
          reaction_trigger: "turn_start", reaction_passive_mode: "force", reaction_source: "all",
          reaction_effect_ref: "thin_air_drain",
        } },
        effect_table: { "0": {
          effect_kind: "grant", effect_label: "thin_air_drain", target_ref: "trigger_subject",
          grant_resource: "mp", grant_amount: "-5",
        } },
      },
    } },
  });
  return out;
}
