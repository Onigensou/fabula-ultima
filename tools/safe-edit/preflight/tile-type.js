"use strict";

/**
 * preflight/tile-type — offline port of the Dungeon Pathing runtime type
 * resolver.
 *
 * The checkup must judge a tile's type the SAME way the live game does, so this
 * mirrors:
 *   modules/fabula-ultima-companion/scripts/dungeon-pathing-system/dp-constants.js  (TILE_TYPES)
 *   modules/fabula-ultima-companion/scripts/dungeon-pathing-system/dp-tile-state.js (inferType)
 *
 * If either of those source files gains a tile type or alias, update the two
 * tables below to match. (They are browser-side IIFEs that assign to a global,
 * so they can't be `require`d directly — this is a deliberate, documented copy.)
 */

const MODULE_ID = "fabula-ultima-companion";
const PATHING_ROOT_KEY = "dungeonPathing";

// Canonical tile-type values — mirror of DP.TILE_TYPES (dp-constants.js).
const TILE_TYPES = Object.freeze({
  BLANK: "blank", RANDOM_BATTLE: "random_battle", TREASURE: "treasure", GOLD: "gold",
  WEAPON: "weapon", ARMOR: "armor", ACCESSORY: "accessory", CONSUMABLE: "consumable",
  ITEM: "item", STEALTH: "stealth", CHAOS: "chaos", ADVANTAGE: "advantage", EVENT: "event",
  FINAL: "final", STORY: "story", FISHING: "fishing", FREEZE: "freeze", GATHERING: "gathering",
  HAZARD: "hazard", HEALING: "healing", FORCE_MOVE: "force_move", POISON: "poison",
  RECIPE: "recipe", SETTLEMENT: "settlement", OBSTACLE: "obstacle", SKILL_CHECK: "skill_check",
  SLIPPERY: "slippery", TRAP: "trap", CAMP: "camp", ALERT: "alert", DOOR: "door",
  GUSTY: "gusty", DIRT: "dirt", UNKNOWN: "unknown",
});

const VALID_TYPES = new Set(Object.values(TILE_TYPES));

// Name/texture fragments the runtime scans, in priority order (mirror of KNOWN).
const KNOWN = [
  "random_battle", "random battle", "battle",
  "gold", "blank", "stealth", "chaos", "advantage", "event", "final",
  "story", "fishing", "freeze", "gathering", "hazard", "healing",
  "force_move", "force move", "forcemove",
  "doubledown", "doubleup", "doubleleft", "doubleright",
  "doublenorth", "doublesouth", "doubleeast", "doublewest",
  "doublenortheast", "doublenorthwest", "doublesoutheast", "doublesouthwest",
  "tripledown", "tripleup", "tripleleft", "tripleright",
  "triplenorth", "triplesouth", "tripleeast", "triplewest",
  "triplenortheast", "triplenorthwest", "triplesoutheast", "triplesouthwest",
  "jump",
  "poison", "recipe", "settlement", "obstacle", "skill check",
  "skillcheck", "slippery", "trap", "camp", "alert", "door", "treasure",
  "item", "weapon", "armor", "accessory", "consumable",
  "dirt", "gusty",
];

const FORCE = TILE_TYPES.FORCE_MOVE;
const ALIAS = {
  "random_battle": TILE_TYPES.RANDOM_BATTLE, "random battle": TILE_TYPES.RANDOM_BATTLE,
  "battle": TILE_TYPES.RANDOM_BATTLE,
  "skill check": TILE_TYPES.SKILL_CHECK, "skillcheck": TILE_TYPES.SKILL_CHECK,
  "force_move": FORCE, "force move": FORCE, "forcemove": FORCE, "jump": FORCE,
  "doubledown": FORCE, "doubleup": FORCE, "doubleleft": FORCE, "doubleright": FORCE,
  "doublenorth": FORCE, "doublesouth": FORCE, "doubleeast": FORCE, "doublewest": FORCE,
  "doublenortheast": FORCE, "doublenorthwest": FORCE, "doublesoutheast": FORCE, "doublesouthwest": FORCE,
  "tripledown": FORCE, "tripleup": FORCE, "tripleleft": FORCE, "tripleright": FORCE,
  "triplenorth": FORCE, "triplesouth": FORCE, "tripleeast": FORCE, "triplewest": FORCE,
  "triplenortheast": FORCE, "triplenorthwest": FORCE, "triplesoutheast": FORCE, "triplesouthwest": FORCE,
};

// Resolve a tile's type from its name + texture (exact mirror of inferType).
function inferType(tileDoc) {
  const name = String(tileDoc?.name ?? "").toLowerCase();
  const texSrc = String(tileDoc?.texture?.src ?? "");
  let texBase = "";
  try {
    texBase = decodeURIComponent(texSrc.split("?")[0]).split("/").pop().toLowerCase();
  } catch { /* leave blank */ }

  // Prefer name over texture (a configured tile's name declares its type; its
  // texture is often Blank_Tile.png by design for hidden-surprise loot).
  const hit = KNOWN.find((k) => name.includes(k)) ?? KNOWN.find((k) => texBase.includes(k));
  if (!hit) return TILE_TYPES.UNKNOWN;
  return ALIAS[hit] ?? hit.replace(/\s+/g, "_");
}

// Read the per-tile state map off a scene's flags (mirror of dp-tile-state.getStates).
function getTileStates(scene) {
  return scene?.flags?.[MODULE_ID]?.[PATHING_ROOT_KEY]?.tileStates ?? {};
}

// A scene participates in Dungeon Mode if it carries any tile state.
function isDungeonScene(scene) {
  return Object.keys(getTileStates(scene)).length > 0;
}

module.exports = {
  MODULE_ID, PATHING_ROOT_KEY, TILE_TYPES, VALID_TYPES,
  inferType, getTileStates, isDungeonScene,
};
