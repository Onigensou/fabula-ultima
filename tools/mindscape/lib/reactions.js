"use strict";
//
// Mindscape — the reaction layer.
//
// Before this file, `skill_type: "Passive"` rows were extracted, counted for the
// coverage printout, and then never looked at again: `engine.js` had no notion of
// a reaction at all. That made the model structurally unable to evaluate any
// monster whose kit lives in `reaction_config_table` — it saw the HP and the base
// attack and nothing else, so a rework that ADDS reactions and pays for them with
// HP/damage read as a pure nerf. See docs/mindscape-ruleset.md Part 7.
//
// Same shape as UTILITY_REGISTRY in skills.js, and for the same reason: what a
// reaction does is structural (grant an attack, accumulate a counter, burst) and
// none of it is legible from the sheet. So reactions are DECLARED here, and
// anything undeclared is reported as a gap rather than silently ignored.
//
// This module is PURE — it decides whether a reaction fires and returns a
// description of what it wants. `engine.js` executes it. Keeping the decision
// side free of the combat loop is what makes it testable without a battle, and
// it avoids a require cycle with resolveAction.

// ── Triggers ────────────────────────────────────────────────────────────────
// Deliberately a SHORT list. Each one is a real hook point in resolveAction, not
// a translation of the live engine's trigger taxonomy — the live names carry
// distinctions (pre/post-resolve, per-target vs action-level) this model has no
// way to honour. Mapping a live trigger onto one of these is a modelling
// decision and belongs in the registry entry's `note`.
const TRIGGERS = Object.freeze({
  // The reactor was targeted by a damaging action and the check was rolled.
  // ctx: { accuracyResult, hit, damage, element, attacker }
  ON_TARGETED: "on_targeted",
  // The reactor dealt damage to somebody. Fires once per damaged victim.
  // ctx: { victim, element, damage }
  ON_DEAL_DAMAGE: "on_deal_damage",
  // The reactor's HP moved because of an element — INCLUDING a heal from an
  // absorb, which is the whole point for Chain Reaction.
  // ctx: { element, damage, direction, cause }
  ON_TAKE_ELEMENT: "on_take_element",
});

// ── Effects ─────────────────────────────────────────────────────────────────
// `free_attack`  — the reactor immediately performs one of its own actions.
//                  `target` is "attacker" (who hit it) or "victim".
// `stack_burst`  — increment a named counter; at `threshold`, deal flat damage
//                  and reset. Models the AE-charge idiom without an AE system.

const REACTION_REGISTRY = Object.freeze({
  // ── Skizzik ───────────────────────────────────────────────────────────────
  "Overload Riposte": {
    trigger: TRIGGERS.ON_TARGETED,
    // Live: creature_targeted_by_action, gated
    //   SUBJECT_IS_SELF && INCOMING_DAMAGE > 0 && ATTACK_CHECK_RESULT > 0
    //   && ATTACK_CHECK_RESULT % 2 == 0 && TRIGGER_DAMAGE_IS_BOLT == 0
    // UNCAPPED by design — it is the monster's whole identity.
    gate: (ctx) =>
      ctx.hit &&
      ctx.damage > 0 &&
      ctx.accuracyResult > 0 &&
      ctx.accuracyResult % 2 === 0 &&
      ctx.element !== "bolt",
    effect: { kind: "free_attack", actionName: "Thunder Strike (Riposte)", target: "attacker" },
    note: "fires pre-resolve live, so it also fires on the killing blow; modelled the same way",
  },

  "Static Buildup": {
    trigger: TRIGGERS.ON_DEAL_DAMAGE,
    gate: () => true,
    effect: {
      kind: "stack_burst", counter: "static", threshold: 3,
      damage: 30, element: "bolt", target: "victim",
    },
    note: "live: two mutually-exclusive creature_deals_damage rows over a persistent_counter AE",
  },

  "Chain Reaction": {
    trigger: TRIGGERS.ON_TAKE_ELEMENT,
    // Live: creature_lose_resource + creature_gain_resource, both
    // TRIGGER_DAMAGE_IS_BOLT, cause filter BLANK so the Lightning Storm feeds
    // it. Skizzik ABSORBS bolt, so the storm's strike arrives as a heal —
    // hence direction is deliberately not gated.
    gate: (ctx) => ctx.element === "bolt",
    effect: { kind: "free_attack", actionName: "Thunder Strike", target: "hostile" },
    note: "absorb counts: the Rod strike heals Skizzik AND buys it this attack",
  },

  // ── Other Valley of the Dragon monsters ───────────────────────────────────
  "Volt Counter": {
    trigger: TRIGGERS.ON_TARGETED,
    gate: (ctx) => ctx.hit && ctx.damage > 0 && ctx.accuracyResult > 0 && ctx.accuracyResult % 2 === 0,
    effect: { kind: "burst", damage: 10, element: "bolt", target: "everyone-else" },
    note: "Ampere — hits its own allies too, which is why target is everyone-else",
  },

  "Lightning Charge": {
    trigger: TRIGGERS.ON_TAKE_ELEMENT,
    gate: (ctx) => ctx.element === "bolt",
    effect: { kind: "grant_mp", amount: 20, overflowToShield: true },
    note: "Kirin — one Rod strike (+30) plus this (+20) exactly arms Rail Stream",
  },
});

// Actions that exist only to be fired BY a reaction must never be picked as a
// turn action. Derived from the registry so a new entry cannot forget it.
const REACTION_ONLY_ACTIONS = Object.freeze(new Set(
  Object.values(REACTION_REGISTRY)
    .filter((r) => r.effect.kind === "free_attack" && r.effect.target === "attacker")
    .map((r) => r.effect.actionName),
));

// ── Lookup ──────────────────────────────────────────────────────────────────
// `passives` is the array skills.js already builds; it was previously write-only.
function declaredReactions(passives) {
  const out = [];
  for (const p of passives ?? []) {
    const entry = REACTION_REGISTRY[p.name];
    if (entry) out.push({ name: p.name, ...entry });
  }
  return out;
}

function undeclaredReactions(passives) {
  return (passives ?? []).filter((p) => !REACTION_REGISTRY[p.name]).map((p) => p.name);
}

// Which declared reactions on this combatant fire for this trigger + context.
// Pure: returns descriptors, never mutates and never resolves anything.
function collect(combatant, trigger, ctx) {
  const fired = [];
  for (const r of combatant.reactions ?? []) {
    if (r.trigger !== trigger) continue;
    let ok = false;
    try { ok = !!r.gate(ctx); } catch { ok = false; }
    if (ok) fired.push(r);
  }
  return fired;
}

// ── Recursion budget ────────────────────────────────────────────────────────
// A free attack can itself deal damage and fire more reactions. The real chains
// terminate (Skizzik's riposte does not hit Skizzik with bolt), but a registry
// edit could introduce a loop, and an infinite loop inside a 2000-run Monte
// Carlo is indistinguishable from a hang. Depth 2 covers every authored chain
// here (riposte → its own Static stack) and stops there.
const MAX_REACTION_DEPTH = 2;

module.exports = {
  TRIGGERS, REACTION_REGISTRY, REACTION_ONLY_ACTIONS, MAX_REACTION_DEPTH,
  declaredReactions, undeclaredReactions, collect,
};
