/**
 * Character Creation — constants and shared helpers.
 *
 * Fabula Ultima core rulebook pp. 154–171.
 *
 * WHY A BLANK CLONE
 * -----------------
 * The CSB character template (`_FabU Char Template v3.fire`) carries ZERO
 * props — every prop lives on the instance. `Actor.create()` followed by
 * `reloadTemplate()` therefore does not reliably reproduce the dropdown and
 * derived state a hand-made PC has, and re-stamping is already known to reset
 * authored dropdowns. So creation clones `_CC Blank PC`, an actor seeded from a
 * real PC on the current template version with every character-specific prop
 * neutralised. Shape parity is guaranteed by construction.
 *
 * FOLDER RESOLUTION
 * -----------------
 * Destination is `Player Character / <Username>'s PC`, matched and created
 * EXACTLY. The pre-existing folders were made by hand and are inconsistent
 * ("Oni's PC" for user Onigensou, "Pika PC" for Pikabeer, "Fluffy's pc"
 * lowercase). Those stay as legacy; anything this system creates uses the
 * precise form. See cc-folder.js.
 */

export const CC = Object.freeze({
  MODULE_ID: "fabula-ultima-companion",

  /** The seed actor cloned for every new character. Authored by
   *  tools/safe-edit/_seed-cc-blank-pc.js. */
  BLANK_PC_ID: "CCBlankPC000Seed",
  BLANK_PC_NAME: "_CC Blank PC",

  /** Root Actor folder new characters are filed under. */
  PC_ROOT_FOLDER: "Player Character",
  /** `<Username>` + this = the per-player subfolder. */
  PC_FOLDER_SUFFIX: "'s PC",

  /** Item folders browsed by the starting-equipment step. Resolved by NAME,
   *  matching the class-registry convention — ids change when a folder is
   *  recreated, names survive it. */
  EQUIP_ROOT_FOLDER: "⚔️ Equipments",
  EQUIP_FOLDERS: Object.freeze({
    weapon: "Basic Weapon",   // has per-category subfolders
    armor: "Basic Armor",
    shield: "Basic Shield",
  }),

  RULE: Object.freeze({
    START_LEVEL: 5,
    MIN_LEVEL: 5,
    MAX_LEVEL: 50,
    /** Below this a character cannot have mastered anything, so the
     *  "2 to 3 classes" starting rule (p.160) is enforced. At or above it a
     *  mono-class build is legal and only the engine's max-3-unmastered rule
     *  (levelup-api, p.227) applies. */
    STARTING_CLASS_RULE_BELOW_LEVEL: 10,
    MIN_STARTING_CLASSES: 2,
    MAX_STARTING_CLASSES: 3,

    /** p.96 — a new character enters play with 3 Fabula Points. */
    START_FABULA: 3,
    /** p.163 — maximum Inventory Points before class bonuses. */
    BASE_IP: 6,

    /** p.164 — 500 zenit at level 5. p.229 suggests "+50 zenit per level" for
     *  higher-level starts. (The book's own level-30 example says 2000, which
     *  its stated formula does not produce; the formula is authoritative here.) */
    BASE_BUDGET: 500,
    BUDGET_PER_LEVEL: 50,

    /** p.165 — leftover budget plus this roll becomes starting savings. */
    SAVINGS_FORMULA: "2d6 * 10",
  }),

  /** p.162 — the three starting spreads. Order within each is the pool the
   *  player assigns, not a fixed attribute order. */
  ARRAYS: Object.freeze({
    jack: Object.freeze({
      key: "jack", label: "Jack of All Trades",
      dice: Object.freeze([8, 8, 8, 8]),
      blurb: "Even across the board. No weak save, no standout.",
    }),
    average: Object.freeze({
      key: "average", label: "Average",
      dice: Object.freeze([10, 8, 8, 6]),
      blurb: "One strength, one weakness. The default shape.",
    }),
    specialized: Object.freeze({
      key: "specialized", label: "Specialized",
      dice: Object.freeze([10, 10, 6, 6]),
      blurb: "Two strengths bought with two real weaknesses.",
    }),
  }),

  /** Character levels that grant a permanent die step (p.227). Mirrors
   *  ATTR.MILESTONES — duplicated as a constant only for the wizard's preview;
   *  the ledger written at finalize uses the attribute system's own values. */
  MILESTONES: Object.freeze([20, 40]),

  /** Wizard steps, in order. `id` doubles as the step module's key. */
  STEPS: Object.freeze([
    Object.freeze({ id: "profile", label: "Profile", n: 1 }),
    Object.freeze({ id: "attributes", label: "Attributes", n: 2 }),
    Object.freeze({ id: "classes", label: "Class & Skills", n: 3 }),
    Object.freeze({ id: "equipment", label: "Equipment", n: 4 }),
    Object.freeze({ id: "bond", label: "Bond", n: 5 }),
    Object.freeze({ id: "summary", label: "Summary", n: 6 }),
  ]),

  /** Foundry's stock placeholder, used when the player supplies no art. */
  DEFAULT_IMG: "icons/svg/mystery-man.svg",

  /** advancement-net message types. Namespaced so they cannot collide with
   *  the levelup ("levelup.*") or attribute ("attribute.*") domains. */
  MSG: Object.freeze({
    CREATE_REQ: "charcreate.create.req",
    CREATE_RES: "charcreate.create.res",
  }),

  REQUEST_TIMEOUT_MS: 30000, // creation does far more work than a single spend
});

/** Attribute keys in sheet order. Matches ATTR_KEYS in attribute-const. */
export const CC_ATTR_KEYS = Object.freeze(["mig", "dex", "ins", "wlp"]);

export const CC_ATTR_LABEL = Object.freeze({
  mig: "Might", dex: "Dexterity", ins: "Insight", wlp: "Willpower",
});

/**
 * The three emotion pairs, one per bond slot field.
 *
 * Mirrors `BondUpdater.PAIRS` in scripts/bond-system/bond-updater-core.js,
 * which is the source of truth for the vocabulary and for the writes. That
 * module is a globalThis IIFE rather than an ES module, so it cannot be
 * imported here; the `slot` field records which `emotion_N_<slot>` prop each
 * pair belongs to, and finalize hands these values straight to `writeSlot`.
 */
export const CC_EMOTION_PAIRS = Object.freeze([
  Object.freeze({ slot: 1, key: "e1", pos: "admiration", neg: "inferiority" }),
  Object.freeze({ slot: 2, key: "e2", pos: "loyalty",    neg: "mistrust"    }),
  Object.freeze({ slot: 3, key: "e3", pos: "affection",  neg: "hatred"      }),
]);

/** Coerce anything CSB may have stored to a finite number. */
export const num = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

/** Zenit available for starting equipment at a given level. */
export const budgetForLevel = (level) =>
  CC.RULE.BASE_BUDGET +
  Math.max(0, num(level, CC.RULE.START_LEVEL) - CC.RULE.START_LEVEL) * CC.RULE.BUDGET_PER_LEVEL;

/** How many milestone die-steps a character created at `level` has earned. */
export const milestonesForLevel = (level) =>
  CC.MILESTONES.filter((m) => num(level, 0) >= m).length;

/** Skill Points a fresh character has: level, since no class levels are held. */
export const pointsForLevel = (level) => Math.max(0, num(level, CC.RULE.START_LEVEL));

/**
 * Is the "2 to 3 classes" starting rule in force at this level?
 *
 * Takes a LEVEL. Handing it a draft object coerces to NaN, which would fall
 * back to the starting level and leave the rule permanently on — silently
 * blocking every legal mono-class build at level 10+. It is loud about that
 * rather than forgiving, because the failure is otherwise invisible.
 */
export const startingClassRuleApplies = (level) => {
  const n = Number(level);
  if (!Number.isFinite(n)) {
    err("startingClassRuleApplies expects a level number, got:", level);
    return true; // fail closed — enforcing a rule wrongly beats skipping it
  }
  return n < CC.RULE.STARTING_CLASS_RULE_BELOW_LEVEL;
};

export const esc = (s) => String(s ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#39;");

export const log = (...a) => console.log("%c[ONI][CharCreate]", "color:#c8a24a", ...a);
export const warn = (...a) => console.warn("[ONI][CharCreate]", ...a);
export const err = (...a) => console.error("[ONI][CharCreate]", ...a);
