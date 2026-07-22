/**
 * Character Creation — the draft and its step machine.
 *
 * The draft is a plain, serialisable object held entirely client-side. No Actor
 * exists until the summary step is confirmed, so backing up and editing an
 * earlier step costs nothing and can never leave a half-built character in the
 * world.
 *
 * DOWNSTREAM INVALIDATION
 * -----------------------
 * Steps are not independent. Level sets both the Skill Point pool and the
 * equipment budget; the classes picked decide which martial gear is legal. Edit
 * an early step and later ones can become impossible.
 *
 * The rule here is: NEVER silently discard a player's choices. `reconcile()`
 * reports what is now wrong and lets the UI say so; it trims only where leaving
 * the data would be incoherent rather than merely invalid (skill picks beyond a
 * pool that shrank, an attribute assignment whose die pool no longer exists).
 * Everything else — over-budget gear, a now-illegal martial item — is reported
 * and blocks Finalize, but the picks stay put so the player can see what to fix.
 */

import {
  CC, CC_ATTR_KEYS, budgetForLevel, milestonesForLevel, pointsForLevel,
  startingClassRuleApplies, num,
} from "./cc-const.js";

/** A fresh, empty draft at the default starting level. */
export function createDraft() {
  return {
    step: "profile",
    /** Steps the player has visited — drives the "reviewed" tick in the rail. */
    seen: ["profile"],

    profile: {
      name: "",
      identity: "",
      theme: "",
      origin: "",
      backstory: "",
      img: "",
      tokenImg: "",
    },

    attributes: {
      level: CC.RULE.START_LEVEL,
      arrayKey: "average",
      /** attr key -> die size. Empty until the player assigns the pool. */
      assign: {},
      /** One attr key per milestone step earned (level 20 / 40). */
      milestonePicks: [],
    },

    /** One entry per Skill Point spent, in the order spent. */
    classes: [], // { classKey, className, skillUuid, skillName, benefit, facetUuids[] }

    equipment: {
      picks: [], // { uuid, name, cost, itemType, isMartial, category, handSlots }
    },

    bond: { name: "", rel: "", e1: "", e2: "", e3: "" },
  };
}

// ── derived reads ──────────────────────────────────────────────────────────

export const draftLevel = (d) => num(d?.attributes?.level, CC.RULE.START_LEVEL);
export const draftPointPool = (d) => pointsForLevel(draftLevel(d));
export const draftPointsSpent = (d) => (d?.classes ?? []).length;
export const draftPointsLeft = (d) => Math.max(0, draftPointPool(d) - draftPointsSpent(d));
export const draftBudget = (d) => budgetForLevel(draftLevel(d));
export const draftSpend = (d) =>
  (d?.equipment?.picks ?? []).reduce((n, p) => n + num(p.cost, 0), 0);
export const draftBudgetLeft = (d) => draftBudget(d) - draftSpend(d);
export const draftMilestones = (d) => milestonesForLevel(draftLevel(d));

/** Distinct classes taken, in first-picked order. */
export function draftClassKeys(d) {
  const seen = [];
  for (const c of d?.classes ?? []) if (!seen.includes(c.classKey)) seen.push(c.classKey);
  return seen;
}

/** Class key -> levels taken in it. */
export function draftClassLevels(d) {
  const out = {};
  for (const c of d?.classes ?? []) out[c.classKey] = (out[c.classKey] ?? 0) + 1;
  return out;
}

/**
 * Does the build grant martial equipment rights?
 *
 * Only used to warn in the equipment step — the authoritative flags are set by
 * the class benefits the levelup system applies at finalize.
 *
 * @param {Function} resolve  class key -> class record (pass `resolveClass`
 *                            from class-registry; kept injectable so this
 *                            module stays testable without a live registry).
 */
export function draftMartial(d, resolve) {
  const out = { melee: false, ranged: false, armor: false, shield: false };
  if (typeof resolve !== "function") return out;
  for (const key of draftClassKeys(d)) {
    const free = resolve(key)?.free ?? {};
    if (free.martialMelee) out.melee = true;
    if (free.martialRanged) out.ranged = true;
    if (free.martialArmor) out.armor = true;
    if (free.martialShield) out.shield = true;
  }
  return out;
}

// ── validation ─────────────────────────────────────────────────────────────

const issue = (step, code, message) => ({ step, code, message });

/** Validate one step. Returns { ok, issues[] }. */
export function validateStep(d, stepId) {
  const issues = [];

  if (stepId === "profile") {
    if (!String(d.profile.name ?? "").trim()) {
      issues.push(issue("profile", "no_name", "A character needs a name."));
    }
  }

  if (stepId === "attributes") {
    const lvl = draftLevel(d);
    if (lvl < CC.RULE.MIN_LEVEL || lvl > CC.RULE.MAX_LEVEL) {
      issues.push(issue("attributes", "bad_level",
        `Level must be between ${CC.RULE.MIN_LEVEL} and ${CC.RULE.MAX_LEVEL}.`));
    }
    const assigned = CC_ATTR_KEYS.filter((k) => num(d.attributes.assign[k], 0) > 0);
    if (assigned.length !== CC_ATTR_KEYS.length) {
      issues.push(issue("attributes", "unassigned",
        "Every attribute needs a die from the chosen array."));
    }
    const need = draftMilestones(d);
    const got = (d.attributes.milestonePicks ?? []).filter(Boolean).length;
    if (got < need) {
      issues.push(issue("attributes", "milestones_unspent",
        `${need - got} milestone advance${need - got === 1 ? "" : "s"} still to assign.`));
    }
  }

  if (stepId === "classes") {
    const left = draftPointsLeft(d);
    if (left > 0) {
      issues.push(issue("classes", "points_unspent",
        `${left} Skill Point${left === 1 ? "" : "s"} still to spend.`));
    }
    // Takes a LEVEL, not the draft — passing the draft coerces to NaN and the
    // default keeps the rule permanently on, blocking every legal mono-class
    // build at level 10+.
    if (startingClassRuleApplies(draftLevel(d))) {
      const n = draftClassKeys(d).length;
      if (n < CC.RULE.MIN_STARTING_CLASSES) {
        issues.push(issue("classes", "too_few_classes",
          `A starting character below level ${CC.RULE.STARTING_CLASS_RULE_BELOW_LEVEL} ` +
          `must take ${CC.RULE.MIN_STARTING_CLASSES}–${CC.RULE.MAX_STARTING_CLASSES} classes.`));
      }
      if (n > CC.RULE.MAX_STARTING_CLASSES) {
        issues.push(issue("classes", "too_many_classes",
          `No more than ${CC.RULE.MAX_STARTING_CLASSES} classes at this level.`));
      }
    }
  }

  if (stepId === "equipment") {
    if (draftBudgetLeft(d) < 0) {
      issues.push(issue("equipment", "over_budget",
        `Over budget by ${Math.abs(draftBudgetLeft(d))} zenit.`));
    }
  }

  if (stepId === "bond") {
    const b = d.bond;
    const hasName = !!String(b.name ?? "").trim();
    const emo = [b.e1, b.e2, b.e3].filter((e) => String(e ?? "").trim()).length;
    // The bond is optional in full, but half a bond is not a thing.
    if (hasName && emo === 0) {
      issues.push(issue("bond", "no_emotion", "Pick one emotion for this bond."));
    }
    if (!hasName && emo > 0) {
      issues.push(issue("bond", "no_target", "Name who or what the bond is toward."));
    }
    if (emo > 1) {
      issues.push(issue("bond", "too_many_emotions",
        "A starting bond carries exactly one emotion."));
    }
  }

  return { ok: issues.length === 0, issues };
}

/** Validate every step. Used to gate Finalize. */
export function validateAll(d) {
  const issues = [];
  for (const s of CC.STEPS) {
    if (s.id === "summary") continue;
    issues.push(...validateStep(d, s.id).issues);
  }
  return { ok: issues.length === 0, issues };
}

// ── reconciliation after an upstream edit ──────────────────────────────────

/**
 * Bring the draft back into internal coherence after an earlier step changed,
 * and report what the player now has to look at.
 *
 * Trims only what would otherwise be incoherent. Anything merely invalid is
 * left in place and surfaced, because a player who lowers their level by
 * accident should not lose the gear list they spent five minutes on.
 *
 * @returns {{ trimmed: string[], warnings: string[] }}
 */
export function reconcile(d) {
  const trimmed = [];
  const warnings = [];

  /*
   * Every placed die must still be one the current array offers.
   *
   * A PARTIAL assignment is normal — the player places dice one at a time, and
   * for three of those four drops the assignment is legitimately incomplete.
   * This used to compare the placed dice against the WHOLE pool, so the first
   * drop never matched and was wiped by the very next reconcile. That is what
   * made assignment look like it did nothing, and why the step then insisted no
   * die had been chosen.
   *
   * Matching is by INSTANCE against a copy of the pool: "Average" is
   * d10 d8 d8 d6, so two d8s are legal but three are not.
   *
   * Switching array is handled where it happens, by clearing the sockets
   * outright — this is only the safety net for a draft that arrives incoherent.
   */
  const arr = CC.ARRAYS[d.attributes.arrayKey];
  if (arr) {
    const pool = [...arr.dice];
    let offered = true;
    for (const k of CC_ATTR_KEYS) {
      const die = num(d.attributes.assign[k], 0);
      if (!die) continue;
      const i = pool.indexOf(die);
      if (i < 0) { offered = false; break; }
      pool.splice(i, 1);
    }
    if (!offered) {
      d.attributes.assign = {};
      trimmed.push("attribute assignment (dice no longer on offer)");
    }
  }

  // Milestone picks cannot outnumber the milestones the level actually reaches.
  const need = draftMilestones(d);
  if ((d.attributes.milestonePicks?.length ?? 0) > need) {
    d.attributes.milestonePicks = d.attributes.milestonePicks.slice(0, need);
    trimmed.push("milestone advances (level lowered)");
  }

  // Skill picks beyond the pool are dropped from the END, so the player keeps
  // the earliest decisions — the ones the later picks were built on.
  const pool = draftPointPool(d);
  if (d.classes.length > pool) {
    const dropped = d.classes.length - pool;
    d.classes = d.classes.slice(0, pool);
    trimmed.push(`${dropped} skill pick${dropped === 1 ? "" : "s"} (level lowered)`);
  }

  // Over budget is reported, never auto-trimmed.
  if (draftBudgetLeft(d) < 0) {
    warnings.push(`Equipment is ${Math.abs(draftBudgetLeft(d))} zenit over the new budget.`);
  }

  const spare = draftPointsLeft(d);
  if (spare > 0 && d.classes.length) {
    warnings.push(`${spare} Skill Point${spare === 1 ? "" : "s"} now unspent.`);
  }

  return { trimmed, warnings };
}

// ── step machine ───────────────────────────────────────────────────────────

export const stepIndex = (id) => CC.STEPS.findIndex((s) => s.id === id);
export const stepAt = (i) => CC.STEPS[Math.max(0, Math.min(CC.STEPS.length - 1, i))];

/**
 * Move to a step by id.
 *
 * Movement is POSITIONAL and unconditional between real steps — the only
 * callers are Back and Next, which are already bounded by `stepAt`'s clamp.
 *
 * An earlier version gated this on a `seen`-derived reachability set so the
 * rail could offer jumps. That set was also what Back consulted, so a jump
 * could leave the draft in a state where stepping backwards was refused with
 * no visible reason. The rail is now a read-only indicator and the reachability
 * concept is gone with it: one way in, one way out, no set to fall out of sync.
 *
 * `seen` survives because the rail still uses it to mark progress and
 * `_issuesHTML` uses it to avoid criticising a step nobody has opened.
 */
export function goTo(d, stepId) {
  const i = stepIndex(stepId);
  if (i < 0) return false;
  d.step = stepId;
  if (!d.seen.includes(stepId)) d.seen.push(stepId);
  return true;
}

export const nextStep = (d) => goTo(d, stepAt(stepIndex(d.step) + 1).id);
export const prevStep = (d) => goTo(d, stepAt(stepIndex(d.step) - 1).id);
