"use strict";
//
// Mindscape — the stance cycle.
//
// WHY THIS EXISTS
// `chooseAction` picks the affordable action with the highest projected damage.
// It has no notion of the live `action_pattern_table`, so a monster that must
// spend an activation ARMING before it may attack was modelled as attacking on
// every activation. For a 4-activation boss whose real cadence is
// Shift → Strike → Shift → Strike that is a 2x overstatement of its entire
// output — the single largest error the model could make about such a fight,
// and invisible in the verdict because the number it produces is a perfectly
// plausible one.
//
// This is a deliberately SMALL abstraction. It does not implement action
// patterns (conditions, priorities, weighted windows, cooldowns, target focus);
// it implements the one structural fact those patterns are used to express here:
// some actions are locked behind a state that another action grants, and using
// them spends it.
//
//   mindscape_stance_grants: "Sword,Bow,Throwing,Flail"
//       This action is an ARMING action. It deals no damage, costs the
//       activation, and sets the actor's stance to one of these, drawn at
//       random EXCLUDING the current one — mirroring `ae_pool_skip_existing`,
//       which is how the live Form Shift guarantees it never redraws.
//
//   mindscape_stance_requires: "Sword"
//       This action is only legal while holding that stance, and CONSUMES it.
//
// Everything else about the cycle then falls out on its own: with no stance the
// only legal action is the arming one, and after a strike the stance is gone —
// so the alternation is a consequence of the rules rather than a scripted
// sequence, exactly as it is in play.
//
// LIMIT, stated rather than hidden: the arming action's choice is uniform over
// the other stances. The live version is also a random pool draw, so this is
// faithful TODAY — but a future Rakshasa that picks its form tactically (say,
// Sword whenever a PC is in Crisis) would be modelled as dumber than it plays.

function splitList(raw) {
  return String(raw ?? "")
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Read the stance fields off a skill item's props. Returns null for the ~all of
// actions that declare neither, so the common path allocates nothing.
function readStanceFields(props) {
  const grants = splitList(props?.mindscape_stance_grants);
  const requires = String(props?.mindscape_stance_requires ?? "").trim() || null;
  if (!grants.length && !requires) return null;
  return {
    stanceGrants: grants.length ? grants : null,
    stanceRequires: requires,
  };
}

// Is this action legal for the actor right now?
// An action requiring a stance needs that exact stance held. An arming action is
// legal only when it would actually change something — an actor already holding
// a stance must spend it before re-arming, which is what stops the model from
// burning every activation on Form Shift when that scores no damage.
function isLegal(action, actor) {
  if (action?.stanceRequires) return actor.stance === action.stanceRequires;
  if (action?.stanceGrants) return actor.stance == null;
  // An actor inside a stance cycle must not fall back on its unstanced actions;
  // otherwise the arming cost is free and the cadence collapses back to 2x.
  if (actor.stanceCycle) return false;
  return true;
}

// Does this actor participate in the stance cycle at all? Derived from its
// actions so a spec cannot forget to declare it.
function hasStanceCycle(actions) {
  return (actions ?? []).some((a) => a.stanceGrants || a.stanceRequires);
}

// Apply an arming action. Returns the stance taken, or null if it could not arm.
// `rng` is the seeded generator — never Math.random, or runs stop reproducing.
function arm(actor, action, rng) {
  const pool = (action.stanceGrants ?? []).filter((s) => s !== actor.stance);
  if (!pool.length) return null;
  const next = rng.pick(pool);
  actor.stance = next;
  return next;
}

// A strike spends the stance it required.
function consume(actor, action) {
  if (action?.stanceRequires && actor.stance === action.stanceRequires) actor.stance = null;
}

module.exports = { readStanceFields, isLegal, hasStanceCycle, arm, consume, splitList };
