// ============================================================================
// Terrarium — pure rules (no Foundry, no DOM). 2026-11-12.
// Approved mockup: https://claude.ai/artifact/Sg95izKw5SLo32vd2E53wD (v4).
//
// A Terrarium is a Dungeon Mode consumable. The main controller throws it onto
// a tile next to the party and that tile becomes the Terrarium's tile type.
// Only the tile's CURRENT state changes; its origin (tileStates.initialType /
// initialTexture) is never written.
//
// This file owns: which tiles may change and why not, the warning for tiles
// that go back to origin on a new day, and the behaviour flags a placed tile
// must carry. The engine (dp-terrarium.js) owns the writes; dp-terrarium-fx.js
// owns what players see; dp-terrarium-ui.js owns the button, fan and picker.
// ============================================================================

export const KINDS = Object.freeze(["blank", "healing", "gathering", "camp", "random_battle"]);

export const TYPE_LABEL = Object.freeze({
  blank: "Blank Tile", random_battle: "Random Battle Tile", healing: "Healing Tile", gathering: "Gathering Tile",
  camp: "Camp Tile", door: "Door Tile", story: "Story Tile", final: "Final Story Tile", event: "Event Tile",
  travel: "Travel Tile", fishing: "Fishing Tile", settlement: "Settlement Tile", trap: "Trap Tile",
  skill_check: "Skill Check Tile", treasure: "Treasure Tile", gold: "Gold Tile", weapon: "Weapon Tile",
  armor: "Armor Tile", accessory: "Accessory Tile", consumable: "Consumable Tile", item: "Item Tile",
  dirt: "Dirt Tile", hazard: "Hazard Tile", poison: "Poison Tile", force_move: "Arrow Tile", gusty: "Gusty Tile",
  slippery: "Slippery Tile", vertigo: "Vertigo Tile", freeze: "Freeze Tile", chaos: "Chaos Tile",
  advantage: "Advantage Tile", stealth: "Stealth Tile", alert: "Alert Tile", obstacle: "Obstacle Tile",
  recipe: "Recipe Tile",
});
export const typeLabel = (t) => TYPE_LABEL[t] ?? (String(t || "tile").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) + " Tile");

export const KIND_NAME = Object.freeze({
  blank: "Terrarium: Blank", healing: "Terrarium: Healing", gathering: "Terrarium: Gathering",
  camp: "Terrarium: Camp", random_battle: "Terrarium: Random Battle",
});
export const KIND_SHORT = Object.freeze({
  blank: "Blank", healing: "Healing", gathering: "Gathering", camp: "Camp", random_battle: "Random Battle",
});

// Tile art per kind (Forge, the same files the tile presets use).
const TILE_ART = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Fabula%20Ultima/Dungeon%20Tile/Special%20Tile/";
export const KIND_TEXTURE = Object.freeze({
  blank: TILE_ART + "Blank_Tile.png", healing: TILE_ART + "Healing_Tile.png", gathering: TILE_ART + "Gathering_Tile.png",
  camp: TILE_ART + "Camp_Tile.png", random_battle: TILE_ART + "Random_Battle_Tile.png",
});

// Item → kind. The item flag wins; the "Terrarium: <Type>" name is the fallback.
export function kindOfItem({ flagKind = null, name = "" } = {}) {
  if (KINDS.includes(flagKind)) return flagKind;
  const m = /^\s*Terrarium:\s*(.+?)\s*$/i.exec(String(name ?? ""));
  if (!m) return null;
  const key = m[1].toLowerCase().replace(/\s+/g, "_");
  return KINDS.includes(key) ? key : null;
}

// ── What can't change ─────────────────────────────────────────────────────────
// User-approved 2026-11-12. Fishing spots reset on a new day, so they are
// locked and the refusal says why.
export const LOCKED_TYPES = Object.freeze({
  door:       "Doors lead to other maps.",
  travel:     "Travel tiles can't change.",
  story:      "Story tiles can't change.",
  final:      "Story tiles can't change.",
  event:      "Event tiles can't change.",
  camp:       "Camp tiles are rest points.",
  fishing:    "Fishing spots reset on a new day, so they can't change.",
  settlement: "Settlement tiles can't change.",
  unknown:    "This tile can't change.",
});
const LOCK_FLAGS = ["fixedEncounter", "storyBattle", "clearedSwitch", "travelThreat"]; // authored fights / switches
const TELEPORT_ACTIONS = new Set(["teleport", "scene"]);
const truthy = (v) => v === true || v === "true" || v === 1;
const hasValue = (v) => v != null && v !== "" && v !== false && !(typeof v === "object" && !Object.keys(v).length);

/**
 * Can `kind` be placed on this tile?
 *   currentType / initialType : tileStates entry
 *   dp            : the tile's dungeonPathing flags
 *   monksActions  : the tile's Monk's Active Tiles actions
 *   teleporter    : the tile's teleporter flag ({ enabled, destination })
 * → { ok, why?, warn? }
 */
export function checkTarget({ kind, currentType, initialType, dp = {}, monksActions = [], teleporter = null } = {}) {
  if (!KINDS.includes(kind)) return { ok: false, why: "That isn't a Terrarium." };
  const cur = currentType || initialType || "unknown";
  const rule = dp?.terrariumRule;
  if (rule === "lock") return { ok: false, why: "This tile can't change." };
  if (cur === kind) return { ok: false, why: `Already a ${typeLabel(cur)}.` };
  if (rule !== "allow") {
    if (truthy(teleporter?.enabled) || (monksActions ?? []).some((a) => TELEPORT_ACTIONS.has(a?.action))) {
      return { ok: false, why: LOCKED_TYPES.door };
    }
    // An original Camp/Door/Story… stays locked even when it is spent or changed.
    for (const t of [cur, initialType]) if (t && LOCKED_TYPES[t]) return { ok: false, why: LOCKED_TYPES[t] };
    if (LOCK_FLAGS.some((k) => hasValue(dp?.[k]))) return { ok: false, why: "This tile can't change." };
  }
  if (truthy(dp?.resetOnRest)) {
    return { ok: true, warn: `Resets to a ${typeLabel(initialType || cur)} on a new day.` };
  }
  return { ok: true };
}

/**
 * Is a whole kind usable on this map? → "" or the reason (greys its orb).
 *   scene: { hasCampScene, hasMaterialTable, hasEncounterTable }
 */
export function kindBlock(kind, scene = {}) {
  if (kind === "camp" && !scene.hasCampScene) return "This map has no camp.";
  if (kind === "gathering" && !scene.hasMaterialTable) return "Nothing to gather on this map.";
  if (kind === "random_battle" && !scene.hasEncounterTable) return "No monsters on this map.";
  return "";
}

// ── Behaviour flags a placed tile carries ────────────────────────────────────
// The tile's behaviour lives on the TILE DOCUMENT (Use button, confirm, effect
// engine config…), and the effect engine runs the tile's effectConfig after
// every dispatch whatever the type. So a placed tile takes the target type's
// behaviour and the old values are kept for the restore. Values are the most
// common set on that type's tiles in the world (measured 2026-11-12).
// Kept as they are (not behaviour): resetOnRest (origin wins on a new day),
// fogMode/fog, fast travel mode, consumed/expired stamps, terrariumRule.
export const BEHAVIOUR_KEYS = Object.freeze([
  "usable", "skipConfirm", "persistAfterTrigger", "disableGoBack", "blockGoBack",
  "forceMoveDirection", "forceMoveSteps", "effectConfig", "checkGate", "vertigoMoves",
  "travelThreat", "clearedSwitch", "fixedEncounter", "fixedEngagement", "fixedVictorySwitch", "storyBattle",
]);

const EFFECT_OFF = Object.freeze({
  enabled: false, targetMode: "all", useResourceChange: false, resourceType: "damage", resourceValue: 0,
  elementType: "elementless", ignoreReduction: false, weaponType: "none_ef", useActiveEffect: false,
  activeEffectsJson: "", useRemoveEffect: false, removeEffectsJson: "", silent: false, vfxType: "none",
  vfxFile: "", vfxFlashTint: "#ff0000", vfxFlashAlpha: 0.5, sfxUrl: "",
});
// The heal amount itself comes from dp-heal-rules.js (35% max HP); the engine
// only needs a healing resource change on a Healing tile.
const EFFECT_HEAL = Object.freeze({ ...EFFECT_OFF, enabled: true, useResourceChange: true, resourceType: "healing", resourceValue: 50 });
const BASE = Object.freeze({
  skipConfirm: false, persistAfterTrigger: false, disableGoBack: false, blockGoBack: false,
  forceMoveDirection: "", forceMoveSteps: 1,
});
export const PROFILES = Object.freeze({
  blank:         Object.freeze({ ...BASE, usable: false, effectConfig: EFFECT_OFF }),
  random_battle: Object.freeze({ ...BASE, usable: false, effectConfig: EFFECT_OFF }),
  healing:       Object.freeze({ ...BASE, usable: true,  effectConfig: EFFECT_HEAL }),
  gathering:     Object.freeze({ ...BASE, usable: true,  effectConfig: EFFECT_OFF }),
  camp:          Object.freeze({ ...BASE, usable: true,  effectConfig: EFFECT_OFF }),
});

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/**
 * The swap for one tile. The backup records each behaviour key as it was
 * (absent keys as `null` in `absent`), plus the Monk's actions, so a restore
 * puts the tile back exactly.
 * → { set: {dpKey: value}, unset: [dpKey], actions: [], backup }
 */
export function buildSwap(kind, dpBefore = {}, monksActionsBefore = []) {
  const profile = PROFILES[kind];
  if (!profile) throw new Error(`unknown Terrarium kind: ${kind}`);
  const backup = { flags: {}, absent: [], actions: clone(monksActionsBefore ?? []) };
  for (const k of BEHAVIOUR_KEYS) {
    if (dpBefore && Object.prototype.hasOwnProperty.call(dpBefore, k)) backup.flags[k] = clone(dpBefore[k]);
    else backup.absent.push(k);
  }
  const set = {};
  for (const [k, v] of Object.entries(profile)) set[k] = clone(v);
  const unset = BEHAVIOUR_KEYS.filter((k) => !(k in profile) && dpBefore && Object.prototype.hasOwnProperty.call(dpBefore, k));
  // Monk's actions are cleared: a Trap Damage / Random Battle macro on the old
  // tile would otherwise still fire on enter (the type no longer matters there).
  return { set, unset, actions: [], backup };
}

/** Undo a swap from its backup. → { set, unset, actions } */
export function buildRestore(backup) {
  const set = {}, unset = [];
  for (const [k, v] of Object.entries(backup?.flags ?? {})) set[k] = clone(v);
  for (const k of backup?.absent ?? []) unset.push(k);
  return { set, unset, actions: clone(backup?.actions ?? []) };
}

globalThis.DungeonPathing ??= {};
globalThis.DungeonPathing.TerrariumRules = Object.freeze({
  KINDS, TYPE_LABEL, typeLabel, KIND_NAME, KIND_SHORT, KIND_TEXTURE, kindOfItem, LOCKED_TYPES,
  checkTarget, kindBlock, BEHAVIOUR_KEYS, PROFILES, buildSwap, buildRestore,
});
