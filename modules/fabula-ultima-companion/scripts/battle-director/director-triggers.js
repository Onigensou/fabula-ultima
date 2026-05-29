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
    all: ALL_DIRECTOR_TRIGGERS,
  };
}
