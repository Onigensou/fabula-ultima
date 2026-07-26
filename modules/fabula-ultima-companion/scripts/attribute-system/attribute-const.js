/**
 * Attribute system — shared constants.
 *
 * Attributes are their own domain, not part of the skill-point system. Levelling
 * is the event that feeds both: a level grants a Skill Point, and reaching 20 or
 * 40 grants an Attribute Advance. The two never share a currency.
 *
 * WHAT THIS SYSTEM WRITES
 * ----------------------
 * `<attr>_base` and nothing else. Verified live: writing `dex_base` recomputes
 * `dex_current`, `base_defense` and `defense`; writing `mig_base` moved
 * `max_hp` 111 → 121 while keeping the +30 that equipment contributes. The
 * modifier layer (`bonus_*`, `override_*`) belongs to Active Effects, and
 * `<attr>_current` is CSB-computed — writing either would fight the effect
 * system or be silently overwritten.
 */

export const ATTR = Object.freeze({
  CHANNEL_MSG: Object.freeze({
    ADVANCE_REQ: "attribute.advance.req",
    ADVANCE_RES: "attribute.advance.res",
    REFUND_REQ:  "attribute.refund.req",
    REFUND_RES:  "attribute.refund.res",
  }),

  PROP: Object.freeze({
    LEVEL: "level",
  }),

  /*
   * The ledger lives in a FLAG, not a CSB prop.
   *
   * `reloadTemplate` prunes every prop missing from `getAllProperties()` and
   * persists the deletion, so a prop with no template node is not safe to rely
   * on: a re-stamp would silently reset `claimed` to 0 and re-offer the whole
   * party two advances they had already taken. Adding template nodes would fix
   * that, but it means splicing a 282kB header onto every actor for two numbers
   * nobody is ever meant to look at.
   *
   * Flags are outside CSB's property system entirely — nothing prunes them,
   * they need no template change, and they do not appear on the sheet, which
   * matches attributes being system-owned. `skill_point` is a prop precisely
   * because the opposite was wanted there: players must see it.
   */
  FLAG_SCOPE: "fabula-ultima-companion",
  FLAG_KEY: "attributeAdvance",   // { claimed: number, log: entry[] }

  // Milestones are on ACTOR level (the authored `level` field, max 50), not on
  // skill levels. Zarg reads level 41 against 39 class levels — the gap of 2 is
  // his unspent Skill Points, which is what confirms `level` is the real one.
  MILESTONES: Object.freeze([20, 40]),

  // Natural range for a base attribute. The world's extended d2–d20 applies to
  // modifiers, never to what a milestone can write.
  DIE: Object.freeze({ MIN: 6, MAX: 12, STEPS: Object.freeze([6, 8, 10, 12]) }),

  REQUEST_TIMEOUT_MS: 15000,
});

/** Display order, top to bottom, matching the sheet. */
export const ATTR_KEYS = Object.freeze(["mig", "dex", "ins", "wlp"]);

const ICON = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/";

export const ATTR_META = Object.freeze({
  mig: Object.freeze({ label: "MIG", full: "Might",      icon: ICON + "asan.png" }),
  dex: Object.freeze({ label: "DEX", full: "Dexterity",  icon: ICON + "boot.png" }),
  ins: Object.freeze({ label: "INS", full: "Insight",    icon: ICON + "book.png" }),
  wlp: Object.freeze({ label: "WLP", full: "Willpower",  icon: ICON + "stat.png" }),
});

/**
 * What one die step does to the derived stats, per attribute.
 *
 * Applied as a DELTA to CSB's computed value rather than by recomputing the
 * formula. HP is `level + 5 × MIG`, but Zarg's max_hp is 111 where the formula
 * alone gives 81 — equipment and effects make up the rest. Recomputing would
 * silently drop that 30; adding +10 to whatever CSB currently reports keeps it.
 * The +10 was confirmed live (111 → 121 on a single MIG step).
 */
export const STEP_EFFECT = Object.freeze({
  mig: Object.freeze([{ prop: "max_hp",        label: "HP",   delta: 10 }]),
  wlp: Object.freeze([{ prop: "max_mp",        label: "MP",   delta: 10 }]),
  dex: Object.freeze([{ prop: "defense",       label: "DEF",  delta: 2 }]),
  ins: Object.freeze([{ prop: "magic_defense", label: "MDEF", delta: 2 }]),
});

export const num = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

/** The next die up, or null at the ceiling. */
export const nextDie = (die) => {
  const i = ATTR.DIE.STEPS.indexOf(num(die, 0));
  return i >= 0 && i < ATTR.DIE.STEPS.length - 1 ? ATTR.DIE.STEPS[i + 1] : null;
};

/** The next die down, or null at the floor. For reversion. */
export const prevDie = (die) => {
  const i = ATTR.DIE.STEPS.indexOf(num(die, 0));
  return i > 0 ? ATTR.DIE.STEPS[i - 1] : null;
};

export const log  = (...a) => console.log("%c[ONI][Attribute]", "color:#c8a24a", ...a);
export const warn = (...a) => console.warn("[ONI][Attribute]", ...a);
export const err  = (...a) => console.error("[ONI][Attribute]", ...a);
