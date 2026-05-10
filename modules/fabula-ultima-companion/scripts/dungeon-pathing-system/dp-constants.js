// ============================================================================
// Dungeon Pathing System — Constants
// ============================================================================
(() => {
  const DP = globalThis.DungeonPathing ??= {};

  DP.MODULE_ID        = "fabula-ultima-companion";
  DP.FABULA_ROOT_KEY  = "oniFabula";
  DP.GENERAL_KEY      = "general";
  DP.SCENE_MODE_KEY   = "sceneMode";
  DP.PATHING_ROOT_KEY = "dungeonPathing";  // flags.<MODULE_ID>.dungeonPathing.*

  // Scene modes (shared with camera-follow and config UI)
  DP.SCENE_MODE = Object.freeze({
    NONE:        "none",
    EXPLORATION: "exploration",
    DUNGEON:     "dungeon"
  });

  // Hook names emitted by the system for developer tracking
  DP.HOOKS = Object.freeze({
    TURN_START:      "dungeonPathing.turnStart",
    TOKEN_MOVED:     "dungeonPathing.tokenMoved",
    TURN_CONFIRMED:  "dungeonPathing.turnConfirmed",
    TURN_REVERTED:   "dungeonPathing.turnReverted",
    TILE_EVENT:      "dungeonPathing.tileEvent",
    TURN_END:        "dungeonPathing.turnEnd",
    GRAPH_REBUILT:   "dungeonPathing.graphRebuilt",
  });

  // Known built-in tile type keys
  DP.TILE_TYPES = Object.freeze({
    BLANK:          "blank",
    RANDOM_BATTLE:  "random_battle",
    TREASURE:       "treasure",
    GOLD:           "gold",
    STEALTH:        "stealth",
    CHAOS:          "chaos",
    ADVANTAGE:      "advantage",
    EVENT:          "event",
    FINAL:          "final",
    STORY:          "story",
    FISHING:        "fishing",
    FREEZE:         "freeze",
    GATHERING:      "gathering",
    HAZARD:         "hazard",
    HEALING:        "healing",
    JUMP:           "jump",
    POISON:         "poison",
    RECIPE:         "recipe",
    SETTLEMENT:     "settlement",
    OBSTACLE:       "obstacle",
    SKILL_CHECK:    "skill_check",
    SLIPPERY:       "slippery",
    TRAP:           "trap",
    CAMP:           "camp",
    ALERT:          "alert",
    DOOR:           "door",
    UNKNOWN:        "unknown",
  });

  // Highlight colours for the PIXI overlay
  DP.HIGHLIGHT = Object.freeze({
    CURRENT:  0x4aa3ff,
    NEIGHBOR: 0x42ff8a,
    LINE:     0xffffff,
    LOCKED:   0xff4a4a,
  });

  // Blank tile asset (cleared state)
  DP.BLANK_TILE_SRC =
    "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Fabula%20Ultima/Dungeon%20Tile/Special%20Tile/Blank_Tile.png";

  // Animation timing
  DP.MOVE_MS                 = 650;
  DP.REAL_UPDATE_BEFORE_END  = 90;
  DP.REBUILD_AFTER_MOVE_MS   = 180;
})();
