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
  // The reactor was attacked, HIT OR MISS. Distinct from ON_TARGETED, which
  // fires only on a hit: a whole class of live reactions is gated on
  // `creature_hit_by_action` + `creature_miss_action` together, i.e. "it does
  // not matter whether the attack landed". Modelling those on ON_TARGETED would
  // silently discount them by the party's miss rate — ~60% against a DEF 14
  // elite, which is not a rounding error.
  // ctx: { hit, weaponFamily, element, attacker, damage }
  ON_ATTACKED: "on_attacked",
});

// ── Effects ─────────────────────────────────────────────────────────────────
// `free_attack`  — the reactor immediately performs one of its own actions.
//                  `target` is "attacker" (who hit it) or "victim".
// `stack_burst`  — increment a named counter; at `threshold`, deal flat damage
//                  and reset. Models the AE-charge idiom without an AE system.
// `weapon_read`  — the reactor's own weapon-efficiency table adapts to the
//                  family that just attacked it. See WEAPON READ below.
// `damage_mult`  — multiply the damage the reactor is about to deal to one
//                  victim. Models a conditional keyword (Execute / Cripple),
//                  which lives on the sheet as an `adjust_damage` reaction row
//                  rather than as engine code.
//
// ── WEAPON READ ─────────────────────────────────────────────────────────────
// A least-recently-used window over weapon families. Each family carries a
// freshness counter; attacking with family X sets X to `window` and decrements
// every other family by 1. Efficiency is read off that counter through `curve`,
// so a family recovers only as OTHER families are shown — `window` of them for
// a full reset, which is the entire tempo of the mechanic.
//
//   window: 4, curve: [25, 40, 60, 80]    counter 4..1 -> EF%, 0 -> 100%
//
// `evict: false` freezes the decrements (nothing recovers) — how a Crisis phase
// that stops forgetting is expressed without a second registry entry.
//
// The counters live on the REACTOR, and the table it writes is the same
// `actor.efficiency` object `rules.incomingDamage` already reads. That matters:
// an efficiency axis modelled twice is an efficiency axis that can disagree
// with itself.

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

  // ── Rakshasa ──────────────────────────────────────────────────────────────
  // PAPER DESIGN, not yet in the world. docs/rakshasa-design-proposal.md §4.
  "Adaptive Defense": {
    trigger: TRIGGERS.ON_ATTACKED,
    // Live: creature_hit_by_action + creature_miss_action, both carrying the
    // attacker's weapon. Modelled on ON_ATTACKED precisely because the design
    // says "it does not matter whether the attack hits" — on ON_TARGETED this
    // would only read ~40% of the party's swings.
    //
    // Fails CLOSED with no family: a spell that the loader failed to classify
    // must not silently register as some arbitrary lane.
    gate: (ctx) => !!ctx.weaponFamily,
    effect: {
      kind: "weapon_read",
      window: 4,
      curve: [25, 40, 60, 80],
      // Crisis flips this to false via `evictUntilCrisis` below.
      evict: true,
    },
    // The Crisis passive is the SAME mechanism with eviction switched off, so
    // it is a property of this entry rather than a second reaction — mirroring
    // the design, where it is one field on one row.
    evictUntilCrisis: true,
    note: "5-slot LRU window; Ten Thousand Arms stops eviction at Crisis",
  },

  "Execute": {
    trigger: TRIGGERS.ON_DEAL_DAMAGE,
    // Live: creature_will_deal_damage + condition_formula TARGET_AE_COUNT_CRISIS > 0
    // + adjust_damage multiply 2. Copied from Kirin's Horn Rush, which is the
    // shipped instance of this pattern.
    gate: (ctx) => ctx.sourceAction === "Execute" && ctx.victimInCrisis,
    effect: { kind: "damage_mult", factor: 2 },
    note: "200% to a creature IN Crisis — the finisher half of the pair",
  },

  "Cripple": {
    trigger: TRIGGERS.ON_DEAL_DAMAGE,
    gate: (ctx) => ctx.sourceAction === "Cripple" && !ctx.victimInCrisis,
    effect: { kind: "damage_mult", factor: 2 },
    note: "200% to a creature NOT in Crisis — the opener half of the pair",
  },
});

// ── Weapon read: the pure state transition ──────────────────────────────────
// Kept here, next to the effect that uses it, and PURE so it can be tested
// without a battle. `counters` is a plain family -> freshness map owned by the
// reactor; `efficiency` is the reactor's live table, mutated in place.
//
// Returns the efficiency now in force for `family`, which is what the caller
// logs — the number a reader wants is "what did this swing actually land at".
function applyWeaponRead(counters, efficiency, family, { window = 4, curve = [], evict = true } = {}) {
  const fam = String(family ?? "").toLowerCase();
  if (!fam) return null;

  if (evict) {
    for (const k of Object.keys(counters)) {
      if (k !== fam && counters[k] > 0) counters[k] -= 1;
    }
  }
  counters[fam] = window;

  // Recompute every touched lane, not just this one: the decrements above moved
  // the others, and a table that only refreshed the attacked family would drift
  // out of step with its own counters within two swings.
  for (const [k, n] of Object.entries(counters)) {
    efficiency[k] = efficiencyForCounter(n, window, curve);
  }
  return efficiency[fam];
}

// counter `window` -> curve[0], `window-1` -> curve[1], ..., 0 -> 100.
// A counter past the end of the curve clamps to its last entry rather than
// throwing, so shortening the curve degrades gracefully instead of producing
// `undefined` and an NaN multiplier three layers down.
function efficiencyForCounter(n, window, curve) {
  if (!(n > 0)) return 100;
  const idx = Math.min(Math.max(window - n, 0), curve.length - 1);
  const v = Number(curve[idx]);
  return Number.isFinite(v) ? v : 100;
}

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
    if (!entry) continue;
    out.push({ name: p.name, ...entry, effect: applyTuning(entry.effect, p.props) });
  }
  return out;
}

// `mindscape_*` props on the carrying item override the registry's numbers, so a
// balance sweep is a data edit rather than a source edit. The registry still
// owns the SHAPE of the mechanic (which is structural and cannot be inferred);
// only its dials move.
//
// Unknown keys are ignored rather than rejected: a spec written against a newer
// registry entry should degrade to the entry's defaults, not refuse to load.
function applyTuning(effect, props) {
  if (!effect || !props) return effect;
  const out = { ...effect };
  const n = (v) => (v == null || String(v).trim() === "" ? null : Number(v));

  const window = n(props.mindscape_read_window);
  if (Number.isFinite(window)) out.window = window;

  const curve = String(props.mindscape_read_curve ?? "").trim();
  if (curve) {
    const parsed = curve.split(/[,\s]+/).map(Number).filter((x) => Number.isFinite(x));
    if (parsed.length) out.curve = parsed;
  }

  const factor = n(props.mindscape_damage_factor);
  if (Number.isFinite(factor)) out.factor = factor;

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
  applyWeaponRead, efficiencyForCounter,
};
