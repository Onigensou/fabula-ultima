// ============================================================================
// Dungeon Pathing System — Constants
// ============================================================================
(() => {
  const DP = globalThis.DungeonPathing ??= {};

  DP.MODULE_ID        = "fabula-ultima-companion";
  DP.FABULA_ROOT_KEY  = "oniFabula";

  // ── Multi-GM host gate (dedupe) ─────────────────────────────────────────────
  // The game normally runs two GM clients (main GM + Co-DM). Player-triggered
  // tile events / turns fan out over raw game.socket, which delivers to BOTH GMs,
  // so any GM-side resolution handler runs twice unless gated to a single "host".
  // Returns true only on the primary active GM (core's game.users.activeGM —
  // the lowest-id active GM), with an id-sort fallback for cores without it.
  // See the GM Host / Anti-Dedupe pattern (Idiom A). NOTE: socketlib's
  // executeAsGM already routes to one GM, so only the raw-socket handlers need
  // this; the treasure system gates separately via its own authority model.
  DP.isPrimaryGM = function isPrimaryGM() {
    if (!game.user?.isGM) return false;
    const active = game.users?.activeGM ?? null;
    if (active) return active.id === game.user.id;
    const firstGM = game.users
      ?.filter?.(u => u.isGM && u.active)
      ?.sort?.((a, b) => String(a.id).localeCompare(String(b.id)))?.[0];
    return firstGM ? firstGM.id === game.user.id : true;
  };
  DP.GENERAL_KEY      = "general";
  DP.SCENE_MODE_KEY   = "sceneMode";
  DP.PATHING_ROOT_KEY = "dungeonPathing";

  DP.SCENE_MODE = Object.freeze({
    NONE:        "none",
    EXPLORATION: "exploration",
    DUNGEON:     "dungeon",
    CAMP:        "camp",
    TITLE:       "title",
    CONFLICT:    "conflict",
    // Visual-novel style scene: background only, used for roleplaying. Its
    // presentation is not implemented — for now the mode exists as a label that
    // hosts the Ritual button and suppresses dungeon pathing.
    THEATRE:     "theatre",
  });

  // Turn phase — tracks the current stage of the dungeon turn lifecycle.
  // Read via DungeonPathing.turnPhase or window.__ONI_DUNGEON_PATHING__.turnPhase.
  DP.TURN_PHASE = Object.freeze({
    IDLE:         "idle",          // dungeon mode inactive or between turns
    ACTION_PHASE: "action_phase",  // graph ready, waiting for player tile choice
    TURN_START:   "turn_start",    // player chose tile; movement + confirm dialog
    RESOLUTION:   "resolution",    // move confirmed; tile events being processed
    TURN_END:     "turn_end",      // tile events done; cleanup + rebuild pending
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
    CAMP_START:      "dungeonPathing.campStart",
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
    FORCE_MOVE:     "force_move",
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
    GUSTY:          "gusty",
    DIRT:           "dirt",
    VERTIGO:        "vertigo",
    UNKNOWN:        "unknown",
  });

  // 8-directional compass keys (screen space: Y increases downward)
  // SLIPPERY  — continue in entry direction (handled by force-move handler)
  // PUSH_BACK — reverse entry direction; ejects the token back the way it came
  // RANDOM    — pick any connected neighbor at random
  DP.DIRECTIONS = Object.freeze({
    N:         "N",
    NE:        "NE",
    E:         "E",
    SE:        "SE",
    S:         "S",
    SW:        "SW",
    W:         "W",
    NW:        "NW",
    SLIPPERY:  "SLIPPERY",
    PUSH_BACK: "PUSH_BACK",
    RANDOM:    "RANDOM",
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

    // Healing HUD button — docked as the SECOND button (right of Scan), shown
    // in both Dungeon and Exploration scene modes.
    HEAL_BUTTON: {
      SIZE:      64,
      BOTTOM:    80,
      LEFT:      94,         // 20 (scan left) + 64 (scan size) + 10 (gap)
      FONT_SIZE: "28px",
    },

    // Helper Mode button — placed to the right of the Heal button
    HELPER_BUTTON: {
      SIZE:      64,         // diameter in px (matches SCAN_BUTTON.SIZE)
      BOTTOM:    80,         // px from bottom (same row as scan button)
      LEFT:      168,        // 94 (heal left) + 64 (heal size) + 10 (gap)
      FONT_SIZE: "28px",
    },

    // Fast Travel button — placed to the right of the Helper button
    FAST_TRAVEL_BUTTON: {
      SIZE:      64,         // diameter in px
      BOTTOM:    80,         // px from bottom (same row)
      LEFT:      242,        // 168 (helper left) + 64 (helper size) + 10 (gap)
      FONT_SIZE: "28px",
    },

    // Scene Travel button — placed to the right of the Fast Travel button
    SCENE_TRAVEL_BUTTON: {
      SIZE:      64,
      BOTTOM:    80,
      LEFT:      316,        // 242 (ft left) + 64 (ft size) + 10 (gap)
      LEFT_NO_FT: 242,       // used when FT button is hidden (takes its slot)
      LEFT_SOLO:  20,        // used in exploration mode (leftmost; heal docks at 94)
      FONT_SIZE: "28px",
    },

    // Ritual button — the rightmost of the row. Shown in Dungeon, Exploration
    // and Theatre modes, and each mode docks a different set of buttons to its
    // left, so it has a slot per mode rather than one fixed offset.
    RITUAL_BUTTON: {
      SIZE:      64,
      BOTTOM:    80,
      LEFT:      390,        // dungeon, FT on:  316 (scene travel) + 64 + 10
      LEFT_NO_FT: 316,       // dungeon, FT off: scene travel slides to 242
      LEFT_EXPLORATION: 168, // exploration: only travel (20) + heal (94) dock
      LEFT_SOLO:  20,        // theatre: the only button, so it takes the leftmost slot
      FONT_SIZE: "28px",
    },

    // Vertigo — the party is blinded; the screen goes dark except for a small
    // circle of vision around the party token. See dp-vertigo.js.
    VERTIGO: {
      DEFAULT_MOVES:   5,     // dungeon steps the debuff lasts
      // Vision radius is DERIVED per node from the graph rather than fixed:
      // dungeon tiles are 20-50px nodes whose spacing varies by scene, so "one
      // tile of vision" is the distance to the furthest walkable neighbour.
      NEIGHBOR_FACTOR: 1.15,  // × furthest-neighbour distance
      MIN_RADIUS:      70,    // world units — floor for very tight node clusters
      MAX_RADIUS:      460,   // world units — ceiling for sprawling scenes
      FALLBACK_GRIDS:  1.5,   // × grid size, used when the graph has no neighbours
      FEATHER:         0.60,  // soft edge width as a fraction of the radius
      DARKNESS:        0.94,  // alpha of the dark field outside the circle
      GM_ALPHA:        0.35,  // GM sees a faded veil and keeps their overview
      FADE_MS:         500,   // overlay fade in / out
      FOLLOW_LERP:     0.12,  // per-frame catch-up toward the token (≈MOVE_MS)
      Z_INDEX:         99990, // under the confirm panel (99999) and HUD (99998)
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
    VERTIGO:    "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Darkness5.ogg",
  });

  // Blank tile asset
  DP.BLANK_TILE_SRC =
    "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Fabula%20Ultima/Dungeon%20Tile/Special%20Tile/Blank_Tile.png";
})();
