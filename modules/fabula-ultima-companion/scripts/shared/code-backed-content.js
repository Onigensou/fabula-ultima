/*:
 * @target Foundry VTT v12
 * @plugindesc [ONI] Code-backed content registry — the single declared list of
 *             content whose behaviour lives in ENGINE CODE rather than in the
 *             document's own config rows.
 *
 * File: modules/fabula-ultima-companion/scripts/shared/code-backed-content.js
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * "Is this skill implemented?" is normally answered by looking at the document:
 * reaction_config_table rows, effect_table rows, an activate ref, own damage,
 * AE changes / reactionConfig / flags, a linked `_skill`, or (for gear) stat
 * props. All eight of those carriers are LOCAL to the document.
 *
 * Two whole classes of implementation carry NOTHING on the document:
 *
 *   INBOUND REFERENCE — another document names it in a formula, e.g. Warning
 *     Shot's `menu_pick_count: "1 + HAS_SKILL_PERFECT_AIM"`. Owning the skill
 *     IS the mechanism (see skill-formulas.js, the HAS_SKILL_<NAME> branch).
 *     Nothing to register: the reference is itself data, and greppable.
 *
 *   CODE-BACKED — the engine looks the document up BY NAME and implements the
 *     behaviour in JS. Nothing anywhere in the data hints that this happened.
 *     That is what this file registers.
 *
 * Measured 2026-08-09: an audit of the party's content reported Quick Summoning,
 * Perfect Aim, Resourceful, the Ritual disciplines and Turbo Tonic as UNBUILT.
 * All five were fully implemented — two by inbound reference, three in code.
 * The audit was not careless; the information simply did not exist in any one
 * place. Now it does.
 *
 * ── WHAT BELONGS HERE ───────────────────────────────────────────────────────
 * An entry is warranted when engine code matches a document BY NAME in order to
 * change behaviour. It is NOT warranted for:
 *   - a display-label fallback (`cand.carrierName ?? "Divination"`) — cosmetic,
 *     the behaviour is config-driven;
 *   - a name compared against a value that came from DATA (a row's
 *     `consume_item_name`, an `ae_template_ref`) — that is generic dispatch;
 *   - loot/fish/dish tables that happen to contain item names as data.
 *
 * ── THIS IS ALSO THE LINT ALLOWLIST ─────────────────────────────────────────
 * `lint/engine-canon-lint.js` flags ENGINE_HARDCODED_SKILL_NAME because the
 * canon is "the engine dispatches via reaction_config_table, never on a name".
 * These entries are the declared, reviewed exceptions: a name declared here
 * silences the hit; an UNDECLARED one still fires. So adding a new code-backed
 * lookup without declaring it is now a lint error rather than invisible.
 *
 * Adding one? Declare it here in the same commit as the code.
 *
 * ── NO STATIC IMPORTS ───────────────────────────────────────────────────────
 * Mirrors shared/identifier-registry.js: this module imports nothing, so it can
 * load first and can never create a cycle. It self-registers on
 * globalThis["oni.CodeBackedContent"] so the CLASSIC (non-module) scripts —
 * engine-canon-lint.js, tile-event-gathering.js — can read it too.
 */

// ── The registry ────────────────────────────────────────────────────────────
// name    canonical display name, as authored on the document.
// kind    "skill" | "item" | "status"  (status = an AE name, not a document)
// module  path of the file that owns the lookup, relative to the module root.
// symbol  the function or constant to read there.
// note    what owning/having it actually DOES, in one line.
// match   how the comparison is made, because it differs per site and a
//         rename has to respect it: "lower" (lowercased) | "exact" | "id+name".
const ENTRIES = [
  {
    name: "Quick Summoning", kind: "skill", match: "lower",
    module: "scripts/battle-director/skill-effects.js", symbol: "quickSummonMods",
    note: "Arcanist: summon cost reduced by SL x 5, and auto-Pulse when merged.",
  },
  {
    name: "Potion Rain", kind: "skill", match: "lower",
    module: "scripts/healing-system/potion-rain.js", symbol: "POTION_RAIN_NAME",
    note: "Owning it (and its SL) unlocks the Potion Rain mode in the healing HUD.",
  },
  {
    name: "Resourceful", kind: "skill", match: "id+name",
    module: "scripts/dungeon-pathing-system/tile-events/tile-event-gathering.js",
    symbol: "awardResourcefulIP",
    note: "Wayfarer: recover SL Inventory Points after a travel/gathering roll.",
  },
  {
    name: "Dual Shieldbearer", kind: "skill", match: "exact",
    module: "scripts/battle-director/equipment-swap.js", symbol: "DUAL_SHIELDBEARER_NAME",
    note: "Guardian: permits a shield in the MAIN hand (UI filter + apply-side gate).",
  },
  {
    name: "Matador Cape", kind: "item", match: "exact",
    module: "scripts/matador-cape-crisis-def-solver.js", symbol: "ITEM_NAME",
    note: "Gear: recomputes DEF while the wearer is in Crisis, via a dedicated solver.",
  },
  // ── statuses (AE names, not documents) ────────────────────────────────────
  {
    name: "Crisis", kind: "status", match: "lower",
    module: "scripts/battle-director/crisis-reactor.js", symbol: "isCrisisEffect",
    note: "The Crisis AE is recognised by name in 3 evaluators + the reactor.",
  },
  {
    name: "Flying", kind: "status", match: "lower",
    module: "scripts/battle-director/skill-formulas.js", symbol: "(inline)",
    note: "Read by name for flight gating in skill-formulas and snapshot.",
  },
  {
    name: "Grappled", kind: "status", match: "lower",
    module: "scripts/battle-director/grappled.js", symbol: "GRAPPLED_NAME",
    note: "Advanced debuff: movement/cover rules + the DC10 break-free check.",
  },
  {
    name: "Grappling", kind: "status", match: "lower",
    module: "scripts/battle-director/grappled.js", symbol: "GRAPPLING_NAME",
    note: "Grappler-side reciprocal AE; hosts the shared-space splash reaction.",
  },
];

// ── Families that already have their OWN registry ───────────────────────────
// Declared here for DISCOVERY only — the authoritative data stays in the owning
// module, so there is exactly one place to edit. Do not copy their contents.
const DELEGATED = [
  {
    what: "Cleanse consumables (Tonic, Super Tonic, Turbo Tonic, Cleanse)",
    module: "scripts/healing-system/healing-cleanse.js", symbol: "CLEANSE_REGISTRY",
    note: "uuid + name -> { scope: one|all debuffs, target: single|all allies }.",
  },
  {
    what: "Ritual disciplines (Arcanism, Chimerism, Elementalism, Entropism, "
        + "Illusionism, Spiritism, Ritualism)",
    module: "scripts/ritual-system/ritual-const.js", symbol: "DISCIPLINE",
    note: "itemIds + itemNames -> check attributes, icon, blurb for the ritual window.",
  },
];

// ── Name constants for consumers ────────────────────────────────────────────
// Import these instead of re-typing a literal, so the registry and the code can
// never disagree. Each consumer normalises exactly as it did before (most
// lowercase; Dual Shieldbearer / Matador Cape compare case-sensitively).
export const NAME = Object.freeze(
  Object.fromEntries(ENTRIES.map((e) => [
    e.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_"),
    e.name,
  ])),
);

export const CODE_BACKED = Object.freeze(ENTRIES.map((e) => Object.freeze({ ...e })));
export const CODE_BACKED_DELEGATED = Object.freeze(DELEGATED.map((d) => Object.freeze({ ...d })));

const BY_LOWER = new Map(ENTRIES.map((e) => [e.name.toLowerCase(), e]));

/** The entry for a document/AE name, or null. Case-insensitive. */
export function codeBackedFor(name) {
  return BY_LOWER.get(String(name ?? "").trim().toLowerCase()) ?? null;
}

/** Is this name implemented in engine code? */
export function isCodeBacked(name) {
  return BY_LOWER.has(String(name ?? "").trim().toLowerCase());
}

/** Every declared name, lowercased — the lint reads this as its allowlist. */
export function codeBackedNames() {
  return [...BY_LOWER.keys()];
}

// Classic (non-module) scripts read it from here.
globalThis["oni.CodeBackedContent"] = Object.freeze({
  NAME, CODE_BACKED, CODE_BACKED_DELEGATED,
  codeBackedFor, isCodeBacked, codeBackedNames,
});
