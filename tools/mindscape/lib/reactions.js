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
  // The actor is about to swing — BEFORE targets are chosen. It exists because
  // a rider that changes an attack's REACH (Multi N) has to act before target
  // selection, which no post-roll trigger can reach. Fired on the ACTOR, for
  // weapon swings (engine.takeTurn). Added for paper equipment, 2026-09-13.
  // ctx: { round, sourceAction, isBasicAttack, attacker }
  ON_DECLARE_ATTACK: "on_declare_attack",
  // The reactor is about to LOSE HP to a landed hit — fired on the DEFENDER after
  // affinity and Protect, before the HP write. Live, this is the victim-side
  // adjust_damage at the HP write (Unbreakable / Mercy / Plot Armor's survive-at-1)
  // and card incoming multipliers on creature_targeted_by_action (Dragonic Scalemail).
  // Effects: `damage_taken_mult` (all applied first), then `survive_at_one`.
  // ctx: { attacker, victim, element, damage }
  ON_TAKE_HIT: "on_take_hit",
});

// Round parity for equipment riders. `round > 0` is load-bearing: 0 % 2 === 0
// is TRUE — the same trap as Overload Riposte's roll-less check — so a swing
// with no round threaded through would otherwise qualify every time.
function evenRoundBasicAttack(ctx) {
  const round = Number(ctx?.round);
  return !!ctx?.isBasicAttack && round > 0 && round % 2 === 0;
}

// ── Effects ─────────────────────────────────────────────────────────────────
// `free_attack`  — the reactor immediately performs one of its own actions.
//                  `target` is "attacker" (who hit it) or "victim".
// `stack_burst`  — increment a named counter; at `threshold`, deal flat damage
//                  and reset. Models the AE-charge idiom without an AE system.
// `weapon_read`  — the reactor's own weapon-efficiency table adapts to the
//                  family that just attacked it. See WEAPON READ below.
// `damage_add`   — add a FLAT amount to the damage the reactor is about to
//                  deal. Distinct from damage_mult because the live rows are
//                  distinct: `damage_operation: "add"` vs `"multiply"`, and a
//                  boss that stacks several additive riders on every swing
//                  behaves very differently from one that doubles a few.
// `damage_mult`  — multiply the damage the reactor is about to deal to one
//                  victim. Models a conditional keyword (Execute / Cripple),
//                  which lives on the sheet as an `adjust_damage` reaction row
//                  rather than as engine code.
// `target_count` — raise the declared attack's target count to AT LEAST
//                  `count` (Multi N). ON_DECLARE_ATTACK only; a maximum, not a
//                  sum. `damage_add` may also carry `levelDiv`, adding
//                  floor(level / levelDiv) — a gear bonus that scales.
// `stack_deny`   — increment a named counter on the VICTIM; at `threshold`,
//                  reset it and the victim loses its next action (a turn
//                  debt). Live: apply_ae add_charges + modify_turns -1, which
//                  lands this round if the victim still has a turn, else next.
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
      evict: true,
    },
    // Ten Thousand Arms is RETIRED: the Crisis identity is now the dual-arm
    // combo, so the read window behaves identically in both halves of the
    // fight. One less escalation stacked on the phase, and one less rule to
    // explain at the table.
    note: "5-slot LRU window, ungated — same before and after Crisis",
  },

  // ⚠ Keyed by ACTION name, not by keyword name. "Saber" is the action; the
  // keyword it carries is `execute`. Naming an action after its own keyword is
  // the anti-pattern — a keyword is a property, not an identity.
  "Saber": {
    trigger: TRIGGERS.ON_DEAL_DAMAGE,
    // Live: creature_will_deal_damage + condition_formula TARGET_AE_COUNT_CRISIS > 0
    // + adjust_damage multiply 2, scoped by reaction_source_skill: "Saber".
    // Copied from Kirin's Horn Rush, the shipped instance of this pattern.
    gate: (ctx) => ctx.sourceAction === "Saber" && ctx.victimInCrisis,
    effect: { kind: "damage_mult", factor: 2 },
    note: "Execute keyword — 200% to a creature IN Crisis; the finisher half",
  },

  // ── Crisis combos ─────────────────────────────────────────────────────────
  // Same authored pattern as Saber/Mace, on the dual-arm actions.
  "Executioner's Volley": {
    trigger: TRIGGERS.ON_DEAL_DAMAGE,
    gate: (ctx) => ctx.sourceAction === "Executioner's Volley" && ctx.victimInCrisis,
    effect: { kind: "damage_mult", factor: 2 },
    note: "Execute keyword on the Sword+Bow combo — doubles on a Crisis victim",
  },

  "Rending Orbit": {
    trigger: TRIGGERS.ON_DEAL_DAMAGE,
    gate: (ctx) => ctx.sourceAction === "Rending Orbit" && !ctx.victimInCrisis,
    effect: { kind: "damage_mult", factor: 2 },
    note: "Cripple keyword on the Flail+Throwing combo — doubles on a healthy victim",
  },

  // ── Asura ─────────────────────────────────────────────────────────────────
  // Asura's damage is not in its damage_bonus. Three passives stack additively
  // onto EVERY slash, four times a round, and none of them were modelled: the
  // measured EnemyDPR of 126.4 was a floor, not the figure.
  //
  // Two are registered here. Ascension and Quad-Elemental Slash are NOT, and
  // that is deliberate -- see the note on Ascension below.
  "Elemental Aspect": {
    trigger: TRIGGERS.ON_DEAL_DAMAGE,
    // Live: adjust_damage `slash_bonus`, +10 outgoing, riding the Aspect the
    // enchant set. In the model an armed Asura always holds one, so the gate is
    // simply 'has armed' -- which is also why it must NOT fire before the first
    // enchant, when the plain slash is what swings.
    gate: (ctx) => !!ctx.attackerStance,
    effect: { kind: "damage_add", amount: 10 },
    note: "+10 outgoing on every slash once enchanted",
  },

  "Four-Armed Fury": {
    trigger: TRIGGERS.ON_DEAL_DAMAGE,
    // Live: adjust_damage `fury_crisis`, +20 outgoing. Gated on ASURA being in
    // Crisis, not the victim -- it is the boss's own second wind.
    gate: (ctx) => !!ctx.attackerInCrisis,
    effect: { kind: "damage_add", amount: 20 },
    note: "+20 outgoing while Asura itself is in Crisis",
  },

  // NOT REGISTERED, and left to report as a coverage gap on purpose:
  //
  //   Ascension            +8 per charge (AE_CHARGES_ASCENSION * 8), up to +32
  //   Quad-Elemental Slash 4 x 45 flat, party-wide, resets the Marks
  //
  // Both depend on a state this model cannot hold. Live, Asura spends four
  // activations on four DIFFERENT Sword Enchants -- each gated on lacking its
  // own Mark -- accumulating one Ascension charge apiece, then spends Quad to
  // cash them and reset. `stances.js` carries a single-valued stance, so it
  // arms ONCE and holds Enchanted forever: the model can reach 1 charge, never
  // 4, and Quad's precondition never arrives.
  //
  // Registering an approximation here would put a number on the report that
  // nothing in the data supports. Declaring nothing keeps both in the
  // unmodelled list, where a reader can see them. Asura therefore still reads
  // LOW by roughly +8..32 per slash plus a 180-point party-wide hit every third
  // round; modelling them needs multi-status state in stances.js first.

  "Mace": {    trigger: TRIGGERS.ON_DEAL_DAMAGE,
    gate: (ctx) => ctx.sourceAction === "Mace" && !ctx.victimInCrisis,
    effect: { kind: "damage_mult", factor: 2 },
    note: "Cripple keyword — 200% to a creature NOT in Crisis; the opener half",
  },

  // ── Paper equipment ───────────────────────────────────────────────────────
  // PAPER DESIGN, not in the world. docs/equipment-balance-design.md, Part 9.
  // Carried by the gear-skill sub-item of an --equip spec (lib/equip-file.js),
  // so it only exists on a combatant actually holding the weapon.
  //
  // An ARRAY entry: one mechanic, two hook points. Reach (Multi) has to land
  // before targets are chosen; the bonus lands per victim at the damage seam.
  // Both rows share one gate so they can never disagree about which swing
  // qualifies.
  //
  // "When you attack with this weapon" means a BASIC attack only (design ruling
  // 2026-09-13) — a skill that swings the weapon does not qualify.
  "Explosion Whip (Passive)": [
    {
      trigger: TRIGGERS.ON_DECLARE_ATTACK,
      gate: evenRoundBasicAttack,
      effect: { kind: "target_count", count: 3 },
      note: "even rounds: the basic attack gains Multi 3 (dial: mindscape_target_count)",
    },
    {
      trigger: TRIGGERS.ON_DEAL_DAMAGE,
      gate: evenRoundBasicAttack,
      effect: { kind: "damage_add", amount: 10, levelDiv: 0 },
      note: "even rounds: +10 per target (dials: mindscape_damage_add, mindscape_damage_add_level_div)",
    },
  ],
  // Spread-damage test rider (bin/spread-test.js): EVERY basic attack gains Multi N, no
  // round gate, so the only difference from a single-target arm is where the damage lands.
  "Mindscape Multi Rider (Passive)": {
    trigger: TRIGGERS.ON_DECLARE_ATTACK,
    gate: (ctx) => !!ctx?.isBasicAttack,
    effect: { kind: "target_count", count: 2 },
    note: "test rider: basic attacks gain Multi N (dial: mindscape_target_count)",
  },
  // Armor passive: "When you are reduced to 0 HP, spend 1 Fabula Point to hold on
  // at 1 HP instead." Live: an equipped AE on the HP-write path (would_reduce_to_zero,
  // ask) capping damage at CUR_HP - 1, then consume_resource fp 1. The model always
  // spends when it can — a player at 0 HP in a fight they want to win does.
  "Plot Armor (Passive)": {
    trigger: TRIGGERS.ON_TAKE_HIT,
    gate: (ctx) => (ctx?.damage ?? 0) >= (ctx?.victim?.hp ?? Infinity) && (ctx?.victim?.fp ?? 0) >= 1,
    effect: { kind: "survive_at_one", fpCost: 1 },
    note: "lethal hit → spend 1 FP, stay at 1 HP (dial: mindscape_fp_cost)",
  },
  // Armor passive pair: damage from Dragon-subtype attackers × (1 - X%), and the
  // wearer's Fire damage × 1.1. Live: creature_targeted_by_action incoming multiply
  // gated ATTACKER_SUBTYPE_IS_DRAGON; creature_will_deal_damage outgoing multiply
  // with reaction_damage_type fire.
  "Dragonic Scalemail (Passive)": [
    {
      trigger: TRIGGERS.ON_TAKE_HIT,
      gate: (ctx) => (ctx?.attacker?.actor?.subtypes ?? []).includes("DRAGON"),
      effect: { kind: "damage_taken_mult", factor: 0.85 },
      note: "damage from DRAGON-subtype attackers × factor (dial: mindscape_damage_taken_factor)",
    },
    {
      trigger: TRIGGERS.ON_DEAL_DAMAGE,
      gate: (ctx) => String(ctx?.element ?? "").toLowerCase() === "fire",
      effect: { kind: "damage_mult", factor: 1.1 },
      note: "the wearer's Fire damage × 1.1",
    },
  ],
  // Legendary Arcane weapon (2026-09-14): a hit with the weapon gives the target 1
  // Chronostasis; at 3 it loses them all and one action. Live: one creature_deals_damage
  // row (reaction_requires_weapon_used, same shape as Razor Plume) chaining apply_ae
  // add_charges → modify_turns -1 / remove_ae, both gated TARGET_AE_CHARGES_CHRONOSTASIS >= 3.
  // Live also counts skills that swing the weapon; an archetype's only weapon action is
  // its basic attack, so gating on isBasicAttack reads the same here.
  // The granted spell Time Dilation (Swift, or Slow + 1 Chronostasis) is NOT modelled.
  "Chrono (Passive)": {
    trigger: TRIGGERS.ON_DEAL_DAMAGE,
    gate: (ctx) => !!ctx?.isBasicAttack && (ctx?.damage ?? 0) > 0,
    effect: { kind: "stack_deny", counter: "chronostasis", threshold: 3 },
    note: "basic-attack damage stacks Chronostasis on the victim; 3 → it loses its next action (dial: mindscape_stack_threshold)",
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

// A registry value is ONE row or an ARRAY of rows. An array is one mechanic with
// several hook points (Explosion Whip: reach before targeting, damage at the
// seam). Every consumer goes through here, so none can forget the shape.
function registryRows(entry) {
  if (!entry) return [];
  return Array.isArray(entry) ? entry : [entry];
}

// Actions that exist only to be fired BY a reaction must never be picked as a
// turn action. Derived from the registry so a new entry cannot forget it.
const REACTION_ONLY_ACTIONS = Object.freeze(new Set(
  Object.values(REACTION_REGISTRY)
    .flatMap(registryRows)
    .filter((r) => r.effect.kind === "free_attack" && r.effect.target === "attacker")
    .map((r) => r.effect.actionName),
));

// ── Lookup ──────────────────────────────────────────────────────────────────
// `passives` is the array skills.js already builds; it was previously write-only.
function declaredReactions(passives) {
  const out = [];
  for (const p of passives ?? []) {
    for (const row of registryRows(REACTION_REGISTRY[p.name])) {
      out.push({ name: p.name, ...row, effect: applyTuning(row.effect, p.props) });
    }
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

  // Kind-scoped: an ARRAY entry's rows all read ONE item's props, so a dial may
  // only reach the row whose effect it names. Without the scope, a count dial
  // would land on the damage row too and every row would drift together.
  if (out.kind === "target_count") {
    const count = n(props.mindscape_target_count);
    if (Number.isFinite(count) && count >= 1) out.count = count;
  }
  if (out.kind === "damage_taken_mult") {
    const f = n(props.mindscape_damage_taken_factor);
    if (Number.isFinite(f) && f >= 0) out.factor = f;
  }
  if (out.kind === "survive_at_one") {
    const cost = n(props.mindscape_fp_cost);
    if (Number.isFinite(cost) && cost >= 0) out.fpCost = cost;
  }
  if (out.kind === "stack_deny") {
    const threshold = n(props.mindscape_stack_threshold);
    if (Number.isFinite(threshold) && threshold >= 1) out.threshold = threshold;
  }
  if (out.kind === "damage_add") {
    const amount = n(props.mindscape_damage_add);
    if (Number.isFinite(amount)) out.amount = amount;
    const div = n(props.mindscape_damage_add_level_div);
    if (Number.isFinite(div) && div >= 0) out.levelDiv = div;
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
  declaredReactions, undeclaredReactions, collect, registryRows,
  applyWeaponRead, efficiencyForCounter,
};
