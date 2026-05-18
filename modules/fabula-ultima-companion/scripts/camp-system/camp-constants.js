// ============================================================================
// Camp System — Constants
// ============================================================================
(() => {
  const CAMP = globalThis.CampSystem ??= {};

  CAMP.MODULE_ID = "fabula-ultima-companion";
  CAMP.TAG       = "[CampSystem]";

  // ---------------------------------------------------------------------------
  // Phase state machine
  // ---------------------------------------------------------------------------
  CAMP.PHASE = Object.freeze({
    FREE_ROAM:        "free_roam",        // "Camp Activity" button; players roam freely
    ACTIVITY_SELECT:  "activity_select",  // dimmed screen, JRPG activity picker
    ACTIVITY_RESOLVE: "activity_resolve", // activities run in sequence
    BOND_UPDATE:      "bond_update",      // each player edits bonds locally
    BOND_SUMMARY:     "bond_summary",     // animated group bond reveal
    SLEEP_LOBBY:      "sleep_lobby",      // "Sleep" button with ready lobby
    SLEEPING:         "sleeping",         // sleep animation + macro
    SET_OUT_LOBBY:    "set_out_lobby",    // "Set Out" button with ready lobby
  });

  // ---------------------------------------------------------------------------
  // World setting keys  (registered under MODULE_ID scope)
  // ---------------------------------------------------------------------------
  CAMP.SETTING = Object.freeze({
    PHASE:                "campPhase",
    READY:                "campReady",                // JSON { [userId]: true }
    SELECTIONS:           "campSelections",           // JSON { [actorId]: { locked: key|null, lockedAt: ms|null } }
    RESOLVED:             "campResolved",             // JSON { [actorId]: true }
    BOND_CONFIRMED:       "campBondConfirmed",        // JSON { [userId]: true }
    BOND_SUMMARY:         "campBondSummary",          // JSON { [actorId]: BondSummaryEntry }
    SLEEP_READY:          "campSleepReady",           // JSON { [userId]: true }
    SET_OUT_READY:        "campSetOutReady",          // JSON { [userId]: true }
    EXPLORATION_DEBUFFS:  "campExplorationDebuffs",   // JSON { [actorId]: { halfRest: true } }
  });

  // ---------------------------------------------------------------------------
  // Socket
  // ---------------------------------------------------------------------------
  CAMP.SOCKET_CH = `module.${CAMP.MODULE_ID}`;
  CAMP.MSG = Object.freeze({
    // Client → GM requests
    TOGGLE_READY:       "CAMP_TOGGLE_READY",
    LOCK_ACTIVITY:      "CAMP_LOCK_ACTIVITY",
    UNLOCK_ACTIVITY:    "CAMP_UNLOCK_ACTIVITY",
    CONFIRM_BOND:       "CAMP_CONFIRM_BOND",
    UNCONFIRM_BOND:     "CAMP_UNCONFIRM_BOND",
    ACTIVITY_DONE:      "CAMP_ACTIVITY_DONE",
    TOGGLE_SLEEP:       "CAMP_TOGGLE_SLEEP",
    TOGGLE_SET_OUT:     "CAMP_TOGGLE_SET_OUT",
    // Ephemeral broadcast (any → all)
    HOVER_ACTIVITY:     "CAMP_HOVER_ACTIVITY",
    // Exploration roulette (GM → all, owner → GM)
    EXPLORATION_START:  "CAMP_EXPLORATION_START",
    EXPLORATION_RESULT: "CAMP_EXPLORATION_RESULT",
    EXPLORATION_DONE:   "CAMP_EXPLORATION_DONE",
  });

  // ---------------------------------------------------------------------------
  // Activity definitions  (metadata only — execute() lives in each activity file)
  // ---------------------------------------------------------------------------
  CAMP.ACTIVITY_DEFS = [
    {
      key:    "camp_forge",
      name:   "Camp Forge",
      target: "Yourself",
      icon:   "fas fa-hammer",
      desc:   "Repair a damaged item; or create a basic weapon, armor, or shield without paying its cost; or destroy equipment to obtain a material of equal value.",
    },
    {
      key:    "cartography",
      name:   "Cartography",
      target: "Yourself",
      icon:   "fas fa-map",
      desc:   "Once before the next rest, after your group makes a travel roll, you may reroll the die and keep the new result.",
    },
    {
      key:    "combat_lesson",
      name:   "Combat Lesson",
      target: "One ally",
      icon:   "fas fa-fist-raised",
      desc:   "Once before the next rest, after the target makes an Accuracy Check or Magic Check for an offensive spell, they may add +4 to the Result.",
    },
    {
      key:    "daydream",
      name:   "Daydream",
      target: "Yourself",
      icon:   "fas fa-cloud",
      desc:   "Once before the next rest, when you lose Hit Points for any reason, you may choose to halve that HP loss.",
    },
    {
      key:    "double_portion",
      name:   "Double Portion",
      target: "One ally",
      icon:   "fas fa-utensils",
      desc:   "Once before the next rest, if the target is about to recover Hit Points, they may double the amount recovered.",
    },
    {
      key:    "exploration",
      name:   "Exploration",
      target: "Yourself",
      icon:   "fas fa-search",
      desc:   "Spend your time looking for useful items; describe how, then roll 1d6 to determine what you find.",
    },
    {
      key:    "gathering",
      name:   "Gathering",
      target: "A character with the Gourmet Class",
      icon:   "fas fa-leaf",
      desc:   "Look for ingredients in the area; describe how, then roll 1d6. You may gain ingredients or accidentally trigger a conflict.",
    },
    {
      key:    "magic_lesson",
      name:   "Magic Lesson",
      target: "One ally",
      icon:   "fas fa-magic",
      desc:   "Choose a single spell you know. Once before the next rest, the target may cast that spell (still paying MP cost and performing checks).",
    },
    {
      key:    "martial_practice",
      name:   "Martial Practice",
      target: "Yourself",
      icon:   "fas fa-dumbbell",
      desc:   "Once before the next rest, when you perform an attack, you may grant that attack multi (2) or increase its multi property by one.",
    },
    {
      key:    "massage",
      name:   "Massage",
      target: "One ally",
      icon:   "fas fa-hand-paper",
      desc:   "Once before the next rest, if the target is about to pay a Mind Point cost, they may halve it. Cannot apply to a Ritual's MP cost.",
    },
    {
      key:    "midnight_oil",
      name:   "Midnight Oil",
      target: "Yourself",
      icon:   "fas fa-scroll",
      desc:   "Generate 3 points of progress for a single Project of your choice.",
    },
    {
      key:    "pep_talk",
      name:   "Pep Talk",
      target: "One ally",
      icon:   "fas fa-comment",
      desc:   "Once before the next rest, if the target is about to recover Mind Points, they may double the amount recovered.",
    },
    {
      key:    "planning",
      name:   "Planning",
      target: "One ally",
      icon:   "fas fa-chess",
      desc:   "Once before the next rest, after the target performs a Group Check as leader or a Check to examine someone/something, they may add +4 to the Result.",
    },
    {
      key:    "sleep_soundly",
      name:   "Sleep Soundly",
      target: "Yourself",
      icon:   "fas fa-bed",
      desc:   "Once before the next rest, you may perform an additional action on your turn during a conflict scene. This action must be Equipment, Hinder, or Inventory.",
    },
    {
      key:    "training",
      name:   "Training",
      target: "Yourself",
      icon:   "fas fa-shield-alt",
      desc:   "Once before the next rest, if you are about to suffer one or more status effects from the same source, you may instead choose to suffer none of them.",
    },
  ];

  // ---------------------------------------------------------------------------
  // Bond emotion options
  // ---------------------------------------------------------------------------
  CAMP.EMOTIONS = ["", "Admiration", "Inferiority", "Affection", "Mistrust", "Loyalty", "Hatred"];

  console.debug(CAMP.TAG, "Constants loaded.");
})();
