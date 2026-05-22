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
    EXPLORATION_START:   "CAMP_EXPLORATION_START",
    EXPLORATION_RESULT:  "CAMP_EXPLORATION_RESULT",
    EXPLORATION_PROCEED: "CAMP_EXPLORATION_PROCEED",
    EXPLORATION_DONE:    "CAMP_EXPLORATION_DONE",
    // Cartography Snake minigame
    CARTOGRAPHY_START:   "CAMP_CARTOGRAPHY_START",    // GM → all
    CARTOGRAPHY_RESULT:  "CAMP_CARTOGRAPHY_RESULT",   // owner → GM (score+hits) / GM → all (charges)
    CARTOGRAPHY_PROCEED: "CAMP_CARTOGRAPHY_PROCEED",  // owner → GM
    CARTOGRAPHY_DONE:    "CAMP_CARTOGRAPHY_DONE",     // GM → all
    CARTOGRAPHY_BEGIN:   "CAMP_CARTOGRAPHY_BEGIN",    // owner → all (Click to Begin)
    CARTOGRAPHY_TICK:    "CAMP_CARTOGRAPHY_TICK",     // owner → all (spectator grid sync)
    // Combat Lesson minigame
    COMBAT_LESSON_START:   "CAMP_COMBAT_LESSON_START",
    COMBAT_LESSON_TARGET:  "CAMP_COMBAT_LESSON_TARGET",   // owner → GM (ally chosen)
    COMBAT_LESSON_RESULT:  "CAMP_COMBAT_LESSON_RESULT",   // GM → all (roll totals + bonus)
    COMBAT_LESSON_PROCEED: "CAMP_COMBAT_LESSON_PROCEED",  // owner → GM
    COMBAT_LESSON_DONE:    "CAMP_COMBAT_LESSON_DONE",
    // Daydream minigame (Counting Sheep)
    DAYDREAM_START:           "CAMP_DAYDREAM_START",
    DAYDREAM_BEGIN:           "CAMP_DAYDREAM_BEGIN",           // owner → all clients (begin trigger; starts spectator countdown)
    DAYDREAM_HIT:             "CAMP_DAYDREAM_HIT",             // owner → all clients (SPACE result: success/fail flash on spectators)
    DAYDREAM_RESULT:          "CAMP_DAYDREAM_RESULT",          // owner → GM (score) / GM → all (score+reduction)
    DAYDREAM_PROCEED:         "CAMP_DAYDREAM_PROCEED",         // owner → GM
    DAYDREAM_DONE:            "CAMP_DAYDREAM_DONE",
    DAYDREAM_CHOICE_REQUEST:  "CAMP_DAYDREAM_CHOICE_REQUEST",  // GM → owner (in-combat "you may" dialog)
    DAYDREAM_CHOICE_RESPONSE: "CAMP_DAYDREAM_CHOICE_RESPONSE", // owner → GM
    // Double Portion minigame
    DOUBLE_PORTION_START:            "CAMP_DOUBLE_PORTION_START",            // GM → all
    DOUBLE_PORTION_TARGET:           "CAMP_DOUBLE_PORTION_TARGET",           // owner → GM (ally chosen)
    DOUBLE_PORTION_MINIGAME:         "CAMP_DOUBLE_PORTION_MINIGAME",         // GM → all (arena phase)
    DOUBLE_PORTION_RESULT:           "CAMP_DOUBLE_PORTION_RESULT",           // owner → GM (score) / GM → all (grade)
    DOUBLE_PORTION_PROCEED:          "CAMP_DOUBLE_PORTION_PROCEED",          // owner → GM
    DOUBLE_PORTION_DONE:             "CAMP_DOUBLE_PORTION_DONE",             // GM → all
    DOUBLE_PORTION_CHOICE_REQUEST:   "CAMP_DOUBLE_PORTION_CHOICE_REQUEST",   // GM → target's owner (in-combat)
    DOUBLE_PORTION_CHOICE_RESPONSE:  "CAMP_DOUBLE_PORTION_CHOICE_RESPONSE",  // target's owner → GM
    DOUBLE_PORTION_GAME_STATE:       "CAMP_DOUBLE_PORTION_GAME_STATE",       // owner → all clients (grid+order sync on start + each drop)
    // Massage minigame (Hot-and-Cold grid)
    MASSAGE_START:    "CAMP_MASSAGE_START",    // GM → all (show ally-picker)
    MASSAGE_TARGET:   "CAMP_MASSAGE_TARGET",   // owner → GM (ally chosen)
    MASSAGE_MINIGAME: "CAMP_MASSAGE_MINIGAME", // GM → all (show arena)
    MASSAGE_BEGIN:    "CAMP_MASSAGE_BEGIN",    // owner → all (Click to Begin; starts spectator countdown)
    MASSAGE_HIT:      "CAMP_MASSAGE_HIT",      // owner → all (per-click: cell + proximity + score + newSpot)
    MASSAGE_RESULT:   "CAMP_MASSAGE_RESULT",   // owner → GM (score) / GM → all (score + reduction)
    MASSAGE_PROCEED:  "CAMP_MASSAGE_PROCEED",  // owner → GM
    MASSAGE_DONE:     "CAMP_MASSAGE_DONE",     // GM → all
    // Training minigame (Timing Gauge)
    TRAINING_START:            "CAMP_TRAINING_START",            // GM → all clients
    TRAINING_BEGIN:            "CAMP_TRAINING_BEGIN",            // owner → all (Click to Begin; starts spectator countdown)
    TRAINING_HIT:              "CAMP_TRAINING_HIT",              // owner → all (SPACE result: { hit, perfect, miss, pointerPx, sweetSpotPx, combo, score })
    TRAINING_RESULT:           "CAMP_TRAINING_RESULT",           // owner → GM (score) / GM → all (score + charges)
    TRAINING_PROCEED:          "CAMP_TRAINING_PROCEED",          // owner → GM
    TRAINING_DONE:             "CAMP_TRAINING_DONE",             // GM → all
    TRAINING_CHOICE_REQUEST:   "CAMP_TRAINING_CHOICE_REQUEST",   // GM → owner client (in-combat "prevent?" dialog)
    TRAINING_CHOICE_RESPONSE:  "CAMP_TRAINING_CHOICE_RESPONSE",  // owner → GM (yes/no)
    // Sleep Soundly minigame (Radial Dream Protector)
    SLEEP_SOUNDLY_START:   "CAMP_SLEEP_SOUNDLY_START",   // GM → all clients
    SLEEP_SOUNDLY_BEGIN:   "CAMP_SLEEP_SOUNDLY_BEGIN",   // owner → all (Click to Begin; broadcasts RNG seed)
    SLEEP_SOUNDLY_HIT:     "CAMP_SLEEP_SOUNDLY_HIT",     // owner → all (object clicked: { actorId, objId, hitType })
    SLEEP_SOUNDLY_RESULT:  "CAMP_SLEEP_SOUNDLY_RESULT",  // owner → GM (score) / GM → all (score + charges)
    SLEEP_SOUNDLY_PROCEED: "CAMP_SLEEP_SOUNDLY_PROCEED", // owner → GM
    SLEEP_SOUNDLY_DONE:    "CAMP_SLEEP_SOUNDLY_DONE",    // GM → all
    // Gathering minigame (4×4 grid ingredient collector)
    GATHERING_START:      "CAMP_GATHERING_START",       // GM → all
    GATHERING_BEGIN:      "CAMP_GATHERING_BEGIN",        // owner → all (Click to Begin; syncs countdown)
    GATHERING_GAME_STATE: "CAMP_GATHERING_GAME_STATE",  // owner → all (per-move: playerPos + ingredients + score)
    GATHERING_RESULT:     "CAMP_GATHERING_RESULT",       // owner → GM (score+taste) / GM → all (grade+taste)
    GATHERING_PROCEED:    "CAMP_GATHERING_PROCEED",      // owner → GM
    GATHERING_DONE:       "CAMP_GATHERING_DONE",         // GM → all
    // Magic Lesson minigame
    MAGIC_LESSON_START:    "CAMP_MAGIC_LESSON_START",    // GM → all (show ally picker)
    MAGIC_LESSON_TARGET:   "CAMP_MAGIC_LESSON_TARGET",   // owner → GM (ally chosen)
    MAGIC_LESSON_SPELL:    "CAMP_MAGIC_LESSON_SPELL",    // owner → GM (spell chosen)
    MAGIC_LESSON_RESULT:   "CAMP_MAGIC_LESSON_RESULT",   // GM → all (3 payload shapes: spell-pick / rolling / reveal)
    MAGIC_LESSON_PROCEED:  "CAMP_MAGIC_LESSON_PROCEED",  // owner → GM
    MAGIC_LESSON_DONE:     "CAMP_MAGIC_LESSON_DONE",     // GM → all
  });

  // ---------------------------------------------------------------------------
  // Activity definitions  (metadata only — execute() lives in each activity file)
  //
  // requiredClass: "any"              → available to everyone
  //               "Foo"               → single class (case-insensitive)
  //               ["Foo", "Bar", …]  → available if actor has ANY of these classes
  // ---------------------------------------------------------------------------
  CAMP.ACTIVITY_DEFS = [
    {
      key:           "camp_forge",
      name:          "Camp Forge",
      target:        "Yourself",
      icon:          "fas fa-hammer",
      requiredClass: ["Merchant", "Tinkerer", "Pilot"],
      desc:          "Repair a damaged item; or create a basic weapon, armor, or shield without paying its cost; or destroy equipment to obtain a material of equal value.",
    },
    {
      key:           "cartography",
      name:          "Cartography",
      target:        "Yourself",
      icon:          "fas fa-map",
      requiredClass: ["Wayfarer", "Rogue", "Merchant", "Pirate", "Hunter", "Loremaster"],
      desc:          "Once before the next rest, after your group makes a travel roll, you may reroll the die and keep the new result.",
    },
    {
      key:           "combat_lesson",
      name:          "Combat Lesson",
      target:        "One ally",
      icon:          "fas fa-fist-raised",
      requiredClass: ["Commander", "Weaponmaster", "Sharpshooter", "Guardian", "Darkblade", "Spell Fencer", "Loremaster"],
      desc:          "Once before the next rest, after the target makes an Accuracy Check or Magic Check for an offensive spell, they may add +4 to the Result.",
    },
    {
      key:           "curse",
      name:          "Curse",
      target:        "One Villain",
      icon:          "fas fa-skull",
      requiredClass: ["Hexer", "Necromancer"],
      desc:          "Perform dark magic to curse your enemy. The next time you enter a conflict scene, if a Villain is present, they are inflicted with a random debuff. This effect lasts until it triggers or until your next rest.",
    },
    {
      key:           "cooking",
      name:          "Cooking",
      target:        "Yourself + up to 3 allies",
      icon:          "fas fa-fire",
      requiredClass: "any",
      desc:          "Cook a delicious meal with your friends whom you share precious bonds with. Meals grant benefits until your next rest.",
    },
    {
      key:           "daydream",
      name:          "Daydream",
      target:        "Yourself",
      icon:          "fas fa-cloud",
      requiredClass: "any",
      desc:          "Once before the next rest, when you lose Hit Points for any reason, you may choose to halve that HP loss.",
    },
    {
      key:           "double_portion",
      name:          "Double Portion",
      target:        "One ally",
      icon:          "fas fa-utensils",
      requiredClass: ["Wayfarer", "Gourmet", "Merchant"],
      desc:          "Once before the next rest, if the target is about to recover Hit Points, they may double the amount recovered.",
    },
    {
      key:           "exploration",
      name:          "Exploration",
      target:        "Yourself",
      icon:          "fas fa-search",
      requiredClass: ["Wayfarer", "Rogue", "Pirate", "Hunter", "Floralist"],
      desc:          "Spend your time looking for useful items; describe how, then roll 1d6 to determine what you find.",
    },
    {
      key:           "fishing",
      name:          "Fishing",
      target:        "Yourself",
      icon:          "fas fa-fish",
      requiredClass: "any",
      desc:          "Cast your line into the nearest body of water and wait for a bite. Describe where you fish and how, then roll 1d6 to see what you catch.",
    },
    {
      key:           "gathering",
      name:          "Gathering",
      target:        "Yourself",
      icon:          "fas fa-leaf",
      requiredClass: ["Gourmet", "Merchant", "Hunter", "Floralist"],
      desc:          "Look for ingredients in the area; describe how, then roll 1d6. You may gain ingredients or accidentally trigger a conflict.",
    },
    {
      key:           "magic_lesson",
      name:          "Magic Lesson",
      target:        "One ally",
      icon:          "fas fa-magic",
      requiredClass: ["Elementalist", "Entropist", "Spiritist", "Illusionist", "Necromancer", "Spell Fencer", "Loremaster", "Chimerist", "Arcanist", "Symbolist"],
      desc:          "Choose a single spell you know. Once before the next rest, the target may cast that spell (still paying MP cost and performing checks).",
    },
    {
      key:           "martial_practice",
      name:          "Martial Practice",
      target:        "Yourself",
      icon:          "fas fa-dumbbell",
      requiredClass: ["Weaponmaster", "Sharpshooter", "Darkblade", "Guardian", "Fury"],
      desc:          "Once before the next rest, when you perform an attack, you may grant that attack multi (2) or increase its multi property by one.",
    },
    {
      key:           "massage",
      name:          "Massage",
      target:        "One ally",
      icon:          "fas fa-hand-paper",
      requiredClass: "any",
      desc:          "Once before the next rest, if the target is about to pay a Mind Point cost, they may halve it. Cannot apply to a Ritual's MP cost.",
    },
    {
      key:           "meditate",
      name:          "Meditate",
      target:        "Yourself",
      icon:          "fas fa-yin-yang",
      requiredClass: ["Monk", "Invoker"],
      desc:          "Still your mind and calm your spirit through quiet contemplation. Once before the next rest, when you spend MP, you may reduce that cost by 30 (to a minimum of 0).",
    },
    {
      key:           "mending",
      name:          "Mending",
      target:        "One ally",
      icon:          "fas fa-band-aid",
      requiredClass: ["Spiritist", "Tailor", "Wayfarer"],
      desc:          "Tend to your ally's wounds with careful hands. They gain Shield equal to half their level (rounded down).",
    },
    {
      key:           "midnight_oil",
      name:          "Midnight Oil",
      target:        "Yourself",
      icon:          "fas fa-scroll",
      requiredClass: ["Tinkerer", "Merchant", "Pilot"],
      desc:          "Generate 3 points of progress for a single Project of your choice.",
    },
    {
      key:           "pep_talk",
      name:          "Pep Talk",
      target:        "One ally",
      icon:          "fas fa-comment",
      requiredClass: ["Orator", "Dancer", "Loremaster", "Chanter", "Commander"],
      desc:          "Once before the next rest, if the target is about to recover Mind Points, they may double the amount recovered.",
    },
    {
      key:           "planning",
      name:          "Planning",
      target:        "One ally",
      icon:          "fas fa-chess",
      requiredClass: ["Commander", "Loremaster"],
      desc:          "Once before the next rest, after the target performs a Group Check as leader or a Check to examine someone/something, they may add +4 to the Result.",
    },
    {
      key:           "sing",
      name:          "Sing",
      target:        "One ally",
      icon:          "fas fa-music",
      requiredClass: ["Chanter", "Dancer"],
      desc:          "Sing an inspiring song for an ally. Choose one attribute (DEX, INS, MIG, or WLP); the target's chosen attribute increases by one stage until the end of their next rest.",
    },
    {
      key:           "sleep_soundly",
      name:          "Sleep Soundly",
      target:        "Yourself",
      icon:          "fas fa-bed",
      requiredClass: "any",
      desc:          "Once before the next rest, you may perform an additional action on your turn during a conflict scene. This action must be Equipment, Hinder, or Inventory.",
    },
    {
      key:           "training",
      name:          "Training",
      target:        "Yourself",
      icon:          "fas fa-shield-alt",
      requiredClass: "any",
      desc:          "Once before the next rest, if you are about to suffer one or more status effects from the same source, you may instead choose to suffer none of them.",
    },
  ];

  // ---------------------------------------------------------------------------
  // Class gate utility
  // requiredClass can be "any", a single string, or an array of strings.
  // Returns true if the actor has ANY of the required classes.
  // Reads class_list from actor.system.props (CSB dynamic table).
  // Each row: { $deleted: bool, class_name: string, level: string, benefit: string }
  // ---------------------------------------------------------------------------
  CAMP.actorHasClass = function(actor, requiredClass) {
    if (!requiredClass) return true;
    const classes = Array.isArray(requiredClass) ? requiredClass : [requiredClass];
    if (classes.every(c => !c || c === "any")) return true;
    const classList = actor?.system?.props?.class_list ?? {};
    const actorClasses = Object.values(classList)
      .filter(row => !row?.$deleted)
      .map(row => String(row.class_name ?? "").toLowerCase().trim());
    return classes.some(req => actorClasses.includes(String(req).toLowerCase().trim()));
  };

  // ---------------------------------------------------------------------------
  // Bond emotion options
  // ---------------------------------------------------------------------------
  CAMP.EMOTIONS = ["", "Admiration", "Inferiority", "Affection", "Mistrust", "Loyalty", "Hatred"];

  console.debug(CAMP.TAG, "Constants loaded.");
})();
