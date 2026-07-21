/**
 * Character Level-Up System — shared constants
 *
 * See docs/levelup-system-design.md for the model.
 */

export const LEVELUP = Object.freeze({
  MODULE_ID: "fabula-ultima-companion",
  TAG: "[ONI][LevelUp]",

  // Socket channels. Mirrors the shop system's multi-channel emit so a player
  // request reaches the GM regardless of which channel the world is wired for.
  CHANNELS: Object.freeze([
    "module.fabula-ultima-companion",
    "system.custom-system-builder",
  ]),

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

  REQUEST_TIMEOUT_MS: 15000,
});

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
