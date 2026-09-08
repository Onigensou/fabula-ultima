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

// Read the stance fields for a skill.
//
// Two sources, in order:
//   1. `mindscape_stance_*` on the item — an explicit declaration, used by paper
//      specs where there is no action_pattern_table to infer from.
//   2. INFERRED from the shipped data, so a monster already in the world models
//      correctly with nothing authored for the sim's benefit. Inference beats
//      declaration here: a hand-maintained mirror of live data drifts, and the
//      drift is silent.
//
// The inference is deliberately narrow, and both halves must agree:
//   · a skill the action_pattern gates on `self_has_status: "X"` REQUIRES X
//   · a skill whose apply_ae draws from a pool of names, where those names are
//     the very statuses other rows gate on, GRANTS one of them
// So "an action that hands out the states other actions are locked behind" is
// what identifies the cycle — not a name, a flag, or a guess about intent.
function readStanceFields(props, actor, itemName) {
  const declaredGrants = splitList(props?.mindscape_stance_grants);
  const declaredRequires = String(props?.mindscape_stance_requires ?? "").trim() || null;
  if (declaredGrants.length || declaredRequires) {
    return {
      stanceGrants: declaredGrants.length ? declaredGrants : null,
      stanceRequires: declaredRequires,
    };
  }

  const gated = gatedStatuses(actor);
  if (!gated.size) return null;

  // REQUIRES — this skill's own row in the pattern gates on a status.
  const name = String(itemName ?? "").trim().toLowerCase();
  for (const row of patternRows(actor)) {
    if (String(row.action_pattern_name ?? "").trim().toLowerCase() !== name) continue;
    if (String(row.action_pattern_condition ?? "").trim().toLowerCase() !== "self_has_status") continue;
    const st = String(row.action_pattern_string ?? "").trim();
    if (st) return { stanceGrants: null, stanceRequires: st };
  }

  // GRANTS — a self-targeted apply_ae drawing from a pool of those same statuses.
  for (const row of Object.values(props?.effect_table ?? {})) {
    if (row?.$deleted) continue;
    if (String(row.effect_kind ?? "").trim().toLowerCase() !== "apply_ae") continue;
    const pool = splitList(row.ae_name_pool);
    if (pool.length < 2) continue;
    if (!pool.every((n) => gated.has(n.toLowerCase()))) continue;
    return { stanceGrants: pool, stanceRequires: null };
  }

  return null;
}

function patternRows(actor) {
  const t = actor?._rawProps?.action_pattern_table ?? {};
  return Object.values(t).filter((r) => r && !r.$deleted);
}

// Every status the action pattern locks an action behind.
function gatedStatuses(actor) {
  const out = new Set();
  for (const row of patternRows(actor)) {
    if (String(row.action_pattern_condition ?? "").trim().toLowerCase() !== "self_has_status") continue;
    const st = String(row.action_pattern_string ?? "").trim();
    if (st) out.add(st.toLowerCase());
  }
  return out;
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
