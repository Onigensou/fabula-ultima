/**
 * Character Level-Up System — shared constants
 *
 * See docs/levelup-system-design.md for the model.
 */

export const LEVELUP = Object.freeze({
  MODULE_ID: "fabula-ultima-companion",
  TAG: "[ONI][LevelUp]",

  // ONE socket channel, deliberately.
  //
  // Foundry's server relays only `module.<id>` and `system.<id>` events, so
  // emitting the same payload on two VALID channels delivers it twice and a
  // write handler applies it twice. The shop system emits on two names too, but
  // its first ("fabula-ultima-companion", no prefix) is never relayed — it is
  // single-delivery by accident, which is not a pattern to copy.
  CHANNEL: "module.fabula-ultima-companion",

  MSG: Object.freeze({
    SPEND_REQ: "levelup.spend.req",
    SPEND_RES: "levelup.spend.res",
    REFUND_REQ: "levelup.refund.req",
    REFUND_RES: "levelup.refund.res",
    HEROIC_REQ: "levelup.heroic.req",
    HEROIC_RES: "levelup.heroic.res",
  }),

  // Actor props.
  PROP: Object.freeze({
    LEVEL: "level",
    SKILL_POINT: "skill_point",
    SKILL_POINT_BONUS: "skill_point_bonus",
    CLASS_LIST: "class_list",
  }),

  // Folders holding playable classes. Prototype Classes are deliberately
  // absent — they are homebrew under test and must never be spendable.
  // Matched by name so the system survives a re-created folder.
  PLAYABLE_FOLDERS: Object.freeze(["Classic Classes", "Custom Classes"]),
  CLASS_ROOT_FOLDER: "Classes",

  // Fabula Ultima core rules.
  RULE: Object.freeze({
    MAX_CLASS_LEVEL: 10,
    MAX_CHAR_LEVEL: 50,
    MAX_UNMASTERED_CLASSES: 3, // core rulebook p. 227
  }),

  // class actor `benefit_dropdown` → class_list `benefit` column.
  // "choice_benefit" and "" both mean the player picks.
  BENEFIT: Object.freeze({
    hp_benefit: "hp",
    mp_benefit: "mp",
    ip_benefit: "ip",
    choice_benefit: null,
    "": null,
  }),

  BENEFIT_LABEL: Object.freeze({
    hp: "Max HP +5",
    mp: "Max MP +5",
    ip: "Max IP +2",
  }),

  // "Forget me Nut" — the in-world price of giving a Skill level back. One nut
  // per level. Matched by name rather than uuid, because an actor's copy is a
  // clone and its uuid is its own; the world item is only the icon source.
  NUT: Object.freeze({
    UUID: "Item.fOEeRwVzYy6YQuIN",
    NAME: "Forget me Nut",
    IMG: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/Nut.png",
    QTY_PROP: "item_quantity",
  }),

  REQUEST_TIMEOUT_MS: 15000,
});

// JRPG-style keyboard controls, identical to the Healing and Ritual HUDs so
// the three windows never disagree about what Z does.
export const LEVELUP_KEYS = Object.freeze({
  UP: ["ArrowUp", "w", "W"],
  DOWN: ["ArrowDown", "s", "S"],
  LEFT: ["ArrowLeft", "a", "A"],
  RIGHT: ["ArrowRight", "d", "D"],
  CONFIRM: ["z", "Z", "Enter"],
  CANCEL: ["x", "X", "Escape"],
  TAB_NEXT: ["e", "E", "Tab"],
  TAB_PREV: ["q", "Q"],
});

/**
 * One Font Awesome glyph per class, for the picker list.
 *
 * FA6 **free** only — Foundry ships the free set, and a Pro-only name (there is
 * no free `fa-sword` or `fa-bow-arrow`) renders as an empty box rather than
 * failing loudly. Keyed by idKey so "Dark Blade" and "Darkblade" both resolve.
 */
export const CLASS_ICONS = Object.freeze({
  aceofcards: "fa-diamond",
  arcanist: "fa-wand-magic-sparkles",
  arcanistvariant: "fa-wand-magic-sparkles",
  berserker: "fa-hand-fist",
  chanter: "fa-music",
  chimerist: "fa-dna",
  commander: "fa-flag",
  dancer: "fa-shoe-prints",
  darkblade: "fa-moon",
  elementalist: "fa-fire",
  entropist: "fa-meteor",
  esper: "fa-brain",
  floralist: "fa-seedling",
  fury: "fa-face-angry",
  gourmet: "fa-utensils",
  guardian: "fa-shield-halved",
  hexer: "fa-spider",
  hunter: "fa-crosshairs",
  illusionist: "fa-ghost",
  invoker: "fa-hand-sparkles",
  loremaster: "fa-book",
  matador: "fa-fan",
  merchant: "fa-coins",
  monk: "fa-hands-praying",
  mutant: "fa-paw",
  necromancer: "fa-skull",
  orator: "fa-comments",
  pilot: "fa-robot",
  pirate: "fa-anchor",
  reaper: "fa-skull-crossbones",
  revolver: "fa-gun",
  rogue: "fa-user-ninja",
  sharpshooter: "fa-bullseye",
  slayer: "fa-khanda",
  spellfencer: "fa-bolt",
  spiritist: "fa-hand-holding-heart",
  symbolist: "fa-shapes",
  tailor: "fa-scissors",
  tamer: "fa-dog",
  tinkerer: "fa-screwdriver-wrench",
  wayfarer: "fa-compass",
  weaponmaster: "fa-hammer",
});

/** Icon for a class, falling back so a newly authored class still renders. */
export const classIcon = (key) => CLASS_ICONS[key] ?? "fa-circle-user";

// Difficulty and Role are not authored on the class actor yet. Shown at these
// defaults so the layout is real, and swapped for live data once the fields
// exist — deferred deliberately rather than faked per class.
export const CLASS_META_DEFAULT = Object.freeze({ difficulty: 1, difficultyMax: 3, roles: ["DPS"] });

/** Feather cursor sprite — the same asset the Healing and Ritual HUDs use. */
export const LEVELUP_CURSOR_SRC =
  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/feather.png";

export const keyMatch = (ev, list) => list.includes(ev.key);

export const log = (...a) => console.log(LEVELUP.TAG, ...a);
export const warn = (...a) => console.warn(LEVELUP.TAG, ...a);
export const err = (...a) => console.error(LEVELUP.TAG, ...a);

/** Numeric coercion that treats "", null and NaN as `fallback`. */
export const num = (v, fallback = 0) => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * Identity key for a class or skill name.
 *
 * `class_list.class_name` is free text typed by hand, so it drifts from the
 * class actor's name — this world has "Dark Blade" against an actor named
 * "Darkblade". Collapsing to lowercase alphanumerics makes those the same key
 * without needing a hand-maintained alias table, and it is the only drift
 * present across every party member's class list.
 */
export const idKey = (name) =>
  String(name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
