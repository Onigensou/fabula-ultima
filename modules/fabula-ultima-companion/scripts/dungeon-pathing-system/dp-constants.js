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
    STANDBY_START:   "dungeonPathing.standbyStart",
    STANDBY_END:     "dungeonPathing.standbyEnd",
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
    // Loot tile sub-types (each maps to a different TreasureRoulette table)
    TREASURE:       "treasure",
    GOLD:           "gold",
    WEAPON:         "weapon",
    ARMOR:          "armor",
    ACCESSORY:      "accessory",
    CONSUMABLE:     "consumable",
    ITEM:           "item",
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
  DP.REBUILD_AFTER_MOVE_MS  = 60;

  // ── Developer UX Tuning ────────────────────────────────────────────────────
  // All visual/UX constants live here for easy adjustment without hunting
  // through individual files. Values are in world-space units unless noted.
  DP.UI = {
    // Token offset — shifts where the token document ends up relative to the
    // tile centre. Negative Y moves the token upward (feet align with tile).
    TOKEN_OFFSET: { x: 0, y: -20 },

    // Hand-cursor indicator shown on walkable (neighbour) tiles in helper mode
    CURSOR: {
      SIZE: 36,             // sprite size in world units
      EDGE_INSET: 0.35,     // fraction of SIZE pulled back from right edge
    },

    // Confirm / Go-Back panel (HTML overlay, dimensions in CSS px)
    BUTTON: {
      WIDTH:     130,       // px — panel width
      HEIGHT:    42,        // px — height of each button
      GAP:       5,         // px — gap between the two buttons
      OFFSET_X:  14,        // px — panel right offset from token right edge
      FONT_SIZE: "13px",
    },

    // Hover highlight drawn over walkable tiles when cursor enters them
    HOVER_HIGHLIGHT: {
      COLOR: 0xffd966,      // golden yellow
      ALPHA: 0.22,
      CORNER_R: 6,          // rounded-rect corner radius in world units
    },

    // Camera follow behaviour (player clients only)
    CAMERA: {
      LERP: 0.25,   // fraction of remaining distance closed per frame (~250 ms to settle at 60 fps)
    },

    // Scan Mode button (HTML DOM, fixed to viewport)
    SCAN_BUTTON: {
      SIZE:           64,    // diameter in px
      BOTTOM:         80,    // px from bottom of viewport
      LEFT:           20,    // px from left of viewport
      FONT_SIZE:      "28px", // emoji size
      DEFAULT_RADIUS: 600,   // world units — fallback when scene flag is unset
    },

    // Helper Mode button — placed to the right of the Scan button
    HELPER_BUTTON: {
      SIZE:      64,         // diameter in px (matches SCAN_BUTTON.SIZE)
      BOTTOM:    80,         // px from bottom (same row as scan button)
      LEFT:      94,         // 20 (scan left) + 64 (scan size) + 10 (gap)
      FONT_SIZE: "28px",
    },

    // Fast Travel button — placed to the right of the Helper button
    FAST_TRAVEL_BUTTON: {
      SIZE:      64,         // diameter in px
      BOTTOM:    80,         // px from bottom (same row)
      LEFT:      168,        // 94 (helper left) + 64 (helper size) + 10 (gap)
      FONT_SIZE: "28px",
    },

    // Scene Travel button — placed to the right of the Fast Travel button
    SCENE_TRAVEL_BUTTON: {
      SIZE:      64,
      BOTTOM:    80,
      LEFT:      242,        // 168 (ft left) + 64 (ft size) + 10 (gap)
      LEFT_NO_FT: 168,       // used when FT button is hidden (takes its slot)
      LEFT_SOLO:  20,        // used in exploration mode (only button)
      FONT_SIZE: "28px",
    },
  };

  // Flag key for per-scene scan radius (read by dp-scan-mode.js)
  DP.PATHING_SCAN_RADIUS_KEY = "scanRadius";

  // Convenience aliases kept for backward compatibility with movement.js
  // (DP.TOKEN_OFFSET is read directly from DP.UI.TOKEN_OFFSET at runtime)
  Object.defineProperty(DP, "TOKEN_OFFSET", {
    get() { return DP.UI.TOKEN_OFFSET; },
    configurable: true,
  });

  // Helper mode
  DP.HAND_CURSOR_URL = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/23478023.png";

  // Sound URLs
  DP.SOUNDS = Object.freeze({
    HOVER:      "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_4.wav",
    FOOTSTEP:   "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/SE_BTL_FootStepNormal_1.ogg",
    CONFIRM:    "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_4.wav",
    CANCEL:     "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_2.wav",
    SCAN_ON:    "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_4.wav",
    SCAN_OFF:   "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_2.wav",
    HELPER_ON:  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_4.wav",
    HELPER_OFF: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_2.wav",
    FT_OPEN:    "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Eagle%20Sound.mp3",
    FT_CLOSE:   "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_2.wav",
    FT_CYCLE:   "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_1.wav",
    FT_WIND:    "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Wind1.ogg",
    FT_LAND:    "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/SE_Jump.wav",
  });

  // Blank tile asset
  DP.BLANK_TILE_SRC =
    "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Fabula%20Ultima/Dungeon%20Tile/Special%20Tile/Blank_Tile.png";
})();
