/**
 * Battle Director — canonical trigger registry.
 *
 * Gap 4 from the canon-hardening retrospective. Triggers were
 * fragmented across three places (reaction-config-schema.md,
 * reaction-config-lint's DIRECTOR_TRIGGERS, director-boot's
 * DIRECTOR_BRIDGED_TRIGGERS); when a new trigger landed, all three had
 * to be updated by hand and it was easy to forget one — silent dispatch
 * drift was the result.
 *
 * Now: this module is the single source of truth for which triggers the
 * director understands. Both director-boot.js and reaction-config-lint.js
 * read from here.
 *
 * Two flavors:
 *
 *   • DIRECTOR_NATIVE_TRIGGERS — fired directly by director engine code
 *     (e.g. firePassiveTriggers calls from state-handlers.js). Not in
 *     the legacy `oni.ReactionTriggers` registry.
 *
 *   • LEGACY_BRIDGED_TRIGGERS — emitted by the legacy reaction system on
 *     the `oni:reactionPhase` Hook; director-boot subscribes and routes
 *     them through firePassiveTriggers so director skills can react to
 *     them too. These ARE in `oni.ReactionTriggers`.
 *
 * Adding a trigger:
 *   1. Add to the appropriate set below.
 *   2. Add a case to skill-effects.js's firePassiveTriggers / matcher
 *      if the payload shape needs custom handling.
 *   3. Run a template-surgery migration if the CSB sheet should offer
 *      it as a select-column option (otherwise authors can't write
 *      it from the editor).
 *   4. Update docs/reaction-config-schema.md's trigger table.
 *
 * Also published on `globalThis.FUCompanion.api.directorTriggers` so
 * classic-script consumers (like reaction-config-lint) can read without
 * needing dynamic import.
 */

export const DIRECTOR_NATIVE_TRIGGERS = new Set([
  // Cost-substitution: caster declares an action whose cost exceeds the
  // declared resource pool. Vismagus listens to convert MP→HP.
  "caster_short_on_mp",
  // After a successful spell resolve (Spell type checks). Spiritual
  // Magic + Heart-of-Light style passives chain off this.
  "creature_completes_spell",
  // Post-resolve attack hook — fires ONCE per Attack action after all
  // per-target creature_deals_damage fires. Carries allTargetsHit so
  // "if all targets hit, do X" passives (e.g. Centauros Blazing Sweep
  // repeat) can gate on a single clean event rather than per-target fires.
  "creature_completes_attack",
  // Pre-resolve item hook — fires DURING the Item action card so a player can
  // react before the item resolves (pills on the card). Action-level, once per
  // action. Payload carries actionKind/actionName + targets. The post-resolve
  // counterpart is `creature_completes_item`.
  "creature_uses_item",
  // Post-resolve item hook — fires ONCE after a creature uses an Item (the
  // Item action, items-as-skill-shaped). Lets reactions hook "when a creature
  // uses an item". Payload carries actionKind/actionName + targets.
  "creature_completes_item",
  // Pre-resolve attack damage hook — fires per-target AFTER COMPUTE has
  // locked rawDamage + affinity but BEFORE the action card commits the
  // damage. Reactions matching this trigger surface as pre-resolve
  // pills on the action card; accepted effects can modify rawDamage
  // (via effect_kind: "add_damage" et al.), and RESOLVE recomputes
  // post-affinity `damage` before applyDamageToTarget runs. Used by
  // Cheap Shot's "deal extra damage when hitting a single statused
  // target" pattern. Per the user's locked timing rule: reactions that
  // manipulate action values fire pre-resolve (action card), not post.
  // The post-resolve `creature_deals_damage` trigger stays for
  // Drain-Spirit-style grants that fire after damage commits.
  "creature_will_deal_damage",
  // Post-Guard trigger — fires once per Guard action with whether the
  // guarder covered an ally. Bodyguard (Guardian Core RAW p.197) listens
  // with `didCoverAlly === true` to apply RS-to-all-affinities AE to the
  // covered ally. Future reactions: Hawkeye's `!didCoverAlly` gate, etc.
  // Payload shape:
  //   { guarderUuid, didCoverAlly, coveredAllyUuid, coveredAllyTokenUuid,
  //     guarderTokenUuid, targets, targetTokenUuids }
  // The `targets`/`targetTokenUuids` carry the covered ally's token UUID
  // (when present) so `target_ref: "action_targets"` in the apply_ae chain
  // resolves cleanly.
  "creature_guards",
  // Resource-ledger triggers — the SINGLE post-commit event family for any
  // resource value moving (HP, MP, IP, FP, zero_power, shield, zenit, enmity).
  // "Damage" is NOT a separate event family — it's a `cause` of a loss (the
  // payload carries cause: damage|hazard|cost|drain|grant|heal + attacker
  // context when cause==damage). `damage` = creature-inflicted attack;
  // `hazard` = Burn/Poison/environment (deal_damage default), which must NOT
  // trip player-inflicted-damage reactions. Reactions filter via reaction_resource_filter
  // + reaction_cause_filter. Fired (subject = the creature whose resource
  // changed) from every BD commit point: the damage loop, consume_resource,
  // grant, and applyToActor. NOTE: attacker-side `creature_deals_damage` stays
  // separate (it's not a resource change on the actor), as does the PRE-commit
  // damage-adjustment layer (Guard/DR/Mercy reduce before the write).
  "creature_lose_resource",
  "creature_gain_resource",
  // Status-ledger triggers — fired (subject = the creature whose status changed)
  // when an AE that represents a status lands/leaves during a settle. The
  // built-in crisis reactor emits these when it applies/removes the Crisis AE,
  // so reactions (On the Hunt: "when an enemy enters Crisis") can chain off them.
  "creature_status_applied",
  "creature_loses_status",
  // Standalone phase triggers — fire outside any action card and don't
  // manipulate an active action's values. Examples per RAW: High Speed
  // ("at the start of a conflict, you may spend 10 MP and..."),
  // Sentinel ("at the start of your turn..."), etc. UI: token-anchored
  // reaction-menu blade list (legacy reaction-buttonUI pattern); user
  // confirmed direction 2026-05-29. Dispatch from director FSM
  // transitions — see [[reaction-menu-on-token]].
  "conflict_start",
  "conflict_end",
  "round_start",
  "round_end",
  "turn_start",
  "turn_end",
]);

export const LEGACY_BRIDGED_TRIGGERS = new Set([
  "creature_performs_check",
  "creature_fumbles_check",
  "creature_check_outcome_flipped",
  "creature_recovers_hp",
  "creature_recovers_mp",
  "creature_lose_mp",
]);

// Standalone triggers — fire independent of any action card. Used by
// the upcoming token-anchored reaction-menu UI to know when to spawn
// blade lists vs. attach pills to a card. Membership reads from the
// runtime registry at boot.
export const STANDALONE_TRIGGERS = new Set([
  "conflict_start",
  "conflict_end",
  "round_start",
  "round_end",
  "turn_start",
  "turn_end",
]);

// ── Phase classification — single source of truth for UI routing ────
//
// Locked 2026-05-30: the reaction system runs TWO co-existing UIs,
// not one. Each trigger declares which phase it belongs to; the FSM
// dispatch site reads this to pick the UI without per-handler
// conditionals.
//
//   "pre-resolve"  — the trigger fires DURING an action card window
//                    and can manipulate the action's values. UI:
//                    pills on the action card. Card-level lock until
//                    every ask-mode pill is decided. Live preview
//                    updates as decisions toggle.
//                    Per user rule: "If it manipulates the values in
//                    the action, the reaction shows during the Action
//                    Card."
//
//   "post-resolve" — the trigger fires AFTER the action commits. The
//                    action is already done; the reaction's effects
//                    are independent. UI: token-anchored reaction
//                    menu over the reactor's token. No action-card
//                    lock needed. Counterattack / Absorb MP / Painful
//                    Lesson canonical examples.
//
//   "standalone"   — the trigger fires OUTSIDE any action — FSM phase
//                    transitions like start-of-turn or start-of-
//                    conflict. UI: token-anchored reaction menu. No
//                    action card exists at all. High Speed canonical
//                    example.
//
// Authoring: when adding a NEW trigger to DIRECTOR_NATIVE_TRIGGERS,
// also add it here. The lint enforces every native trigger has a
// declared phase (see runTemplateEngineEnums).
export const TRIGGER_PHASE = Object.freeze({
  // Pre-resolve — pills on the action card.
  "caster_short_on_mp":         "pre-resolve",
  "creature_completes_spell":   "pre-resolve",
  "creature_will_deal_damage":  "pre-resolve",
  "creature_uses_item":         "pre-resolve",
  // Post-resolve — token-anchored menu, fires after action commits.
  "creature_deals_damage":      "post-resolve",
  "creature_completes_attack":  "post-resolve",
  "creature_completes_item":    "post-resolve",
  "creature_takes_damage":      "post-resolve",
  "creature_guards":            "post-resolve",
  // Resource-ledger family (post-commit, subject = the changed creature).
  "creature_lose_resource":     "post-resolve",
  "creature_gain_resource":     "post-resolve",
  // Status-ledger family (post-commit, subject = the creature gaining/losing it).
  "creature_status_applied":    "post-resolve",
  "creature_loses_status":      "post-resolve",
  // Legacy-bridged triggers — all post-resolve by RAW shape.
  "creature_performs_check":      "post-resolve",
  "creature_fumbles_check":       "post-resolve",
  "creature_check_outcome_flipped": "post-resolve",
  "creature_recovers_hp":         "post-resolve",
  "creature_recovers_mp":         "post-resolve",
  "creature_lose_mp":             "post-resolve",
  // Standalone — token-anchored menu at FSM transitions.
  "conflict_start":             "standalone",
  "conflict_end":               "standalone",
  "round_start":                "standalone",
  "round_end":                  "standalone",
  "turn_start":                 "standalone",
  "turn_end":                   "standalone",
});

// Convenience accessors derived from TRIGGER_PHASE.
export const PRE_RESOLVE_TRIGGERS = new Set(
  Object.entries(TRIGGER_PHASE).filter(([, p]) => p === "pre-resolve").map(([t]) => t)
);
export const POST_RESOLVE_TRIGGERS = new Set(
  Object.entries(TRIGGER_PHASE).filter(([, p]) => p === "post-resolve").map(([t]) => t)
);

// Lookup helper. Returns "pre-resolve" | "post-resolve" | "standalone"
// | null. Default to "post-resolve" for unknown triggers so a stray
// trigger doesn't crash the dispatch — but the lint will flag it.
export function phaseOf(trigger) {
  return TRIGGER_PHASE[trigger] ?? null;
}

export const ALL_DIRECTOR_TRIGGERS = new Set([
  ...DIRECTOR_NATIVE_TRIGGERS,
  ...LEGACY_BRIDGED_TRIGGERS,
]);

if (typeof globalThis !== "undefined") {
  globalThis.FUCompanion = globalThis.FUCompanion ?? {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api ?? {};
  globalThis.FUCompanion.api.directorTriggers = {
    native: DIRECTOR_NATIVE_TRIGGERS,
    legacyBridged: LEGACY_BRIDGED_TRIGGERS,
    standalone: STANDALONE_TRIGGERS,
    preResolve: PRE_RESOLVE_TRIGGERS,
    postResolve: POST_RESOLVE_TRIGGERS,
    phase: TRIGGER_PHASE,
    phaseOf,
    all: ALL_DIRECTOR_TRIGGERS,
  };
}
