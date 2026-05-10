// ============================================================================
// Dungeon Pathing System — Constants
// ============================================================================
(() => {
  const DP = globalThis.DungeonPathing ??= {};

  DP.MODULE_ID        = "fabula-ultima-companion";
  DP.FABULA_ROOT_KEY  = "oniFabula";
  DP.GENERAL_KEY      = "general";
  DP.SCENE_MODE_KEY   = "sceneMode";
  DP.PATHING_ROOT_KEY = "dungeonPathing";

  DP.SCENE_MODE = Object.freeze({
    NONE:        "none",
    EXPLORATION: "exploration",
    DUNGEON:     "dungeon"
  });

  DP.HOOKS = Object.freeze({
    TURN_START:      "dungeonPathing.turnStart",
    TOKEN_MOVED:     "dungeonPathing.tokenMoved",
    TURN_CONFIRMED:  "dungeonPathing.turnConfirmed",
    TURN_REVERTED:   "dungeonPathing.turnReverted",
    TILE_EVENT:      "dungeonPathing.tileEvent",
    TURN_END:        "dungeonPathing.turnEnd",
    GRAPH_REBUILT:   "dungeonPathing.graphRebuilt",
  });

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

  // Animation timing
  DP.MOVE_MS                = 650;
  DP.REAL_UPDATE_BEFORE_END = 90;
  DP.REBUILD_AFTER_MOVE_MS  = 180;

  // Token offset — applied when placing the token on a tile so the
  // character's feet align with the tile graphic rather than the center.
  // Increase negative Y to push the token further up.
  DP.TOKEN_OFFSET = { x: 0, y: -40 };

  // Helper mode
  DP.HAND_CURSOR_URL = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/23478023.png";

  // Sound URLs
  DP.SOUNDS = Object.freeze({
    HOVER:    "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_4.wav",
    FOOTSTEP: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/SE_BTL_FootStepNormal_1.ogg",
  });

  // Blank tile asset
  DP.BLANK_TILE_SRC =
    "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Fabula%20Ultima/Dungeon%20Tile/Special%20Tile/Blank_Tile.png";
})();
