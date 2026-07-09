// ============================================================================
// Clock System — check-driven advancement (Fabula Ultima core, p.53).
//
// Pure, like clock-model.js. `previewCheck` exists *because* this is pure: a
// preview is the same math run without persisting the result, so the action
// card can honestly promise "this check would fill 2 sections" before the dice
// are committed.
//
// The rules, verbatim:
//
//   Fill one section for a successful Check.
//   Fill an additional section if the Result surpassed the Difficulty Level
//   (or the opponent's Result, in an Opposed Check) by 3 or more, or two
//   additional sections if it was by 6 or more.
//   If the Check was a critical success, the corresponding opportunity may be
//   spent to fill two additional sections.
//
// ...and the mirror, for clocks that represent a threat:
//
//   Fill one section for a failed Check. [same margin tiers]
//   If the Check was a fumble, the corresponding opportunity may be spent to
//   fill two additional sections.
//
// Note "MAY be spent". The opportunity is a player resource; the engine never
// spends it silently. `spendOpportunity` is opt-in, always.
//
// ── Which side advances ─────────────────────────────────────────────────────
// We never ask the caller "is this a progress clock or a threat clock". We ask
// the clock: on this check outcome, is there a pole whose outcome MATCHES? A
// passed check advances toward a `success` pole; a failed one advances toward a
// `failure` pole. Fall out of that rule:
//
//   progress  (players/success high)          pass → +1..; fail → nothing
//   threat    (gm/failure high)               pass → nothing; fail → +1..
//   teardown  (players/success low)           pass → -1..; fail → nothing
//   struggle  (players/success + gm/failure)  pass → up;  fail → down
//
// A struggle clock is therefore bidirectional from ONE call, and a `paired`
// group (RAW "A Threshold For Failure", p.54) needs no special case: hand the
// same check to every clock in the group and each one's poles decide whether it
// takes it. See applyCheckToMany.
// ============================================================================

import {
  OUTCOME, MARGIN_TIER_1, MARGIN_TIER_2, OPPORTUNITY_SECTIONS, CLOCK_STATE,
} from "./clock-const.js";
import { applyDelta, signFor, resolutionFor } from "./clock-model.js";

/**
 * Resolve a check spec into pass/fail plus the margin, in the direction that
 * matters. `margin` is always non-negative: it is "by how much did this go the
 * way it went".
 *
 * Opposed checks: strictly greater wins. A tie is a failure with margin 0 —
 * the acting character did not surpass their opponent.
 */
export function readCheck({ result, difficulty = null, opposedResult = null } = {}) {
  const res = Number(result);
  if (!Number.isFinite(res)) throw new Error("[FU][Clock] check.result must be a number");

  // `Number(null)` is 0, so a missing difficulty would silently become "DL 0"
  // and pass every check. Test for absence before coercing.
  const opposed = opposedResult != null;
  const rawBar = opposed ? opposedResult : difficulty;
  if (rawBar == null) throw new Error("[FU][Clock] check needs a difficulty or an opposedResult");
  const bar = Number(rawBar);
  if (!Number.isFinite(bar)) throw new Error("[FU][Clock] check difficulty/opposedResult must be a number");

  const success = opposed ? res > bar : res >= bar;
  return {
    outcome: success ? OUTCOME.SUCCESS : OUTCOME.FAILURE,
    margin: Math.abs(res - bar),
    opposed,
  };
}

/** RAW margin tiers. 6+ grants two extra sections INSTEAD OF the one for 3+. */
export function marginBonus(margin) {
  if (margin >= MARGIN_TIER_2) return 2;
  if (margin >= MARGIN_TIER_1) return 1;
  return 0;
}

/**
 * How many sections does this check fill, for a clock that advances on
 * `outcome`? Zero when the check went the other way.
 *
 * The opportunity bonus requires the matching die result: a critical only pays
 * out on a success, a fumble only on a failure. Asking to spend an opportunity
 * you didn't earn is silently worth nothing rather than an error — the caller
 * is usually a UI checkbox, not a rules lawyer.
 */
export function checkSections({
  outcome, margin = 0, advanceOn = OUTCOME.SUCCESS,
  isCritical = false, isFumble = false, spendOpportunity = false,
} = {}) {
  if (outcome !== advanceOn) {
    return { sections: 0, base: 0, marginSections: 0, opportunitySections: 0, opportunitySpent: false };
  }

  const earned = (outcome === OUTCOME.SUCCESS && isCritical) || (outcome === OUTCOME.FAILURE && isFumble);
  const opportunitySpent = Boolean(spendOpportunity && earned);

  const base = 1;
  const marginSections = marginBonus(margin);
  const opportunitySections = opportunitySpent ? OPPORTUNITY_SECTIONS : 0;

  return {
    sections: base + marginSections + opportunitySections,
    base,
    marginSections,
    opportunitySections,
    opportunitySpent,
  };
}

/**
 * The side that advances this clock on `outcome`: the owner of the pole whose
 * own outcome matches. Null when the clock is indifferent to that result — a
 * progress clock simply does not care that you failed.
 */
export function sideAdvancingOn(clock, outcome) {
  if (clock.poles.high?.outcome === outcome) return clock.poles.high.side;
  if (clock.poles.low?.outcome === outcome) return clock.poles.low.side;
  return null;
}

/** The outcome that fills `side`'s pole, or null when it owns none. */
function poleOutcomeFor(clock, side) {
  if (clock.poles.high?.side === side) return clock.poles.high.outcome;
  if (clock.poles.low?.side === side) return clock.poles.low.outcome;
  return null;
}

const ZERO_TALLY = Object.freeze({
  sections: 0, base: 0, marginSections: 0, opportunitySections: 0, opportunitySpent: false,
});

/**
 * Everything a caller needs to know about a check against a clock, WITHOUT
 * touching it. Feeds both `applyCheck` and the action-card preview pill.
 *
 * `side` / `advanceOn` override the derivation above; leave them unset for the
 * RAW behaviour.
 */
export function previewCheck(clock, spec = {}) {
  const { outcome, margin, opposed } = readCheck(spec);

  const side = spec.side ?? sideAdvancingOn(clock, outcome);

  // No side takes this check → the clock is indifferent to the result, and the
  // tally must read as zero rather than "2 sections it will never fill".
  const advanceOn = spec.advanceOn ?? (side ? poleOutcomeFor(clock, side) ?? outcome : null);
  const tally = side ? checkSections({ ...spec, outcome, margin, advanceOn }) : { ...ZERO_TALLY };

  const inactive = clock.state !== CLOCK_STATE.ACTIVE;
  const sign = side && !inactive ? signFor(clock, side, spec.direction ?? null) : 0;
  const applies = Boolean(side) && !inactive && sign !== 0 && tally.sections > 0;

  const nextValue = applies
    ? Math.min(clock.sections, Math.max(0, clock.value + sign * tally.sections))
    : clock.value;

  return {
    ...tally,
    clockId: clock.id,
    clockName: clock.name,
    outcome,
    margin,
    opposed,
    side,
    advanceOn,
    applies,
    direction: sign > 0 ? "high" : sign < 0 ? "low" : null,
    from: clock.value,
    to: nextValue,
    delta: nextValue - clock.value,
    wouldResolve: applies ? resolutionFor(clock, nextValue) : null,
  };
}

/**
 * Apply a check to a clock. Returns an `applyDelta`-shaped result, plus the
 * `preview` that produced it so a caller can narrate what the rules did
 * ("2 sections: 1 for the success, 1 for beating DL by 4").
 */
export function applyCheck(clock, spec = {}) {
  const preview = previewCheck(clock, spec);

  if (!preview.applies) {
    return { clock, delta: 0, previous: clock.value, resolution: null, noop: true, preview };
  }

  const result = applyDelta(clock, {
    side: preview.side,
    sections: preview.sections,
    direction: spec.direction ?? null,
    cause: spec.cause ?? `check:${preview.outcome}`,
    actorUuid: spec.actorUuid ?? null,
    at: spec.at,
  });

  return { ...result, preview };
}

/**
 * Hand ONE check to many clocks — the `paired` group primitive. Each clock
 * takes it or ignores it based on its own poles, so a passed check advances the
 * success clock and a failed one advances the parallel failure clock with no
 * branching here at all.
 *
 * Returns one result per clock, in the order given. Clocks that ignored the
 * check come back as no-ops.
 */
export function applyCheckToMany(clocks, spec = {}) {
  return clocks.map((clock) => applyCheck(clock, spec));
}

/** Preview form of the above, for a group-wide pill. */
export function previewCheckToMany(clocks, spec = {}) {
  return clocks.map((clock) => previewCheck(clock, spec));
}
