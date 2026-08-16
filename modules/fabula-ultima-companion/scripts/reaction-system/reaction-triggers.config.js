/**
 * [ONI] Reaction System — Trigger Registry (Foundry VTT v12)
 * ---------------------------------------------------------------------------
 * Single source of truth for every reaction trigger key.
 *
 * Adding a new trigger means editing THIS file and (usually) one emit site.
 * Downstream consumers (TriggerCore, Manager, ChooseSkill) read from this
 * registry instead of hardcoding switch-cases.
 *
 * Exposed on:  window["oni.ReactionTriggers"]
 * ---------------------------------------------------------------------------
 *
 * Registry entry shape:
 *
 *   {
 *     key:            canonical trigger string (used in reaction_config_table rows)
 *     label:          human-readable label shown in the skill editor dropdown
 *     bucket:         phase-bucket id; reactions clear when bucket changes
 *     subjectFrom:    null OR { tokenFields, tokenListFields, actorFields, actorListFields }
 *                     null   = global trigger with no per-creature subject (conflict/round)
 *                     object = ordered list of payload fields used to resolve "the
 *                              creature this trigger is talking about" for source filtering
 *     damageSourceFrom: null OR same shape as subjectFrom
 *                     Identifies the *damage source / acting creature* in the payload
 *                     when it differs from the subject (e.g. creature_takes_damage:
 *                     subject = target = reactor, source = attacker). Used by the
 *                     universal `reaction_damage_source` row filter. Null = no
 *                     source side declared (filter fails-closed if active).
 *     filters:        which row filters apply
 *                     ["source"]                          → reaction_source matters
 *                     ["source", "damage_type"]           → also reaction_damage_type
 *                     ["source", "debuff_count"]          → also reaction_debuff_count_*
 *     aliases:        deprecated/raw payload trigger strings that map to this key
 *   }
 *
 * Buckets:
 *   conflict_start | round_start | round_end | turn_start | turn_end |
 *   action_phase   | resolution_phase
 *
 * Reactions in the same bucket coexist in one merged window (so e.g. damage +
 * crisis + defeat all stay available in resolution_phase).
 */

Hooks.once("ready", () => {
  const KEY = "oni.ReactionTriggers";
  if (window[KEY]) {
    console.debug("[ReactionTriggers] Already installed.");
    return;
  }

  // ---------------------------------------------------------------------------
  // Reusable subject-resolution shapes
  // ---------------------------------------------------------------------------

  // The creature performing the action / check / source side of the event.
  const SUBJECT_PERFORMER = {
    tokenFields:     ["tokenUuid", "attackerUuid", "checkTokenUuid", "sourceUuid", "subjectTokenUuid"],
    tokenListFields: [],
    actorFields:     ["actorUuid", "checkActorUuid", "attackerActorUuid", "sourceActorUuid", "subjectActorUuid"],
    actorListFields: []
  };

  // The creature on the source/attacker side, as seen by Damage Card payloads
  // (sourceTokenUuid is preferred there).
  const SUBJECT_DAMAGE_SOURCE = {
    tokenFields:     ["sourceTokenUuid", "attackerUuid", "sourceUuid", "tokenUuid", "subjectTokenUuid"],
    tokenListFields: [],
    actorFields:     ["sourceActorUuid", "attackerActorUuid", "actorUuid", "subjectActorUuid"],
    actorListFields: []
  };

  // The creature being targeted / hit / receiving the effect.
  // For damage-card-shaped payloads, subject/source aliases must NOT be read here
  // (those are the attacker side). Only target-side fields.
  const SUBJECT_TARGET = {
    tokenFields:     ["targetUuid"],
    tokenListFields: ["targets", "targetTokenUuids"],
    actorFields:     ["targetActorUuid"],
    actorListFields: ["targetActorUuids"]
  };

  // The creature whose state changed (crisis enter/exit, defeated, status applied).
  const SUBJECT_STATE_CHANGED = {
    tokenFields:     ["tokenUuid", "targetUuid", "defeatedTokenUuid", "subjectTokenUuid"],
    tokenListFields: ["targets"],
    actorFields:     ["actorUuid", "targetActorUuid", "defeatedActorUuid", "subjectActorUuid"],
    actorListFields: []
  };

  // The token whose turn it is (used for turn_start / turn_end source filtering).
  // Note: phaseHandler emits both `tokenUuid` and `tokenId`; findTokenByUuidish
  // accepts either form, so we list both.
  const SUBJECT_TURN = {
    tokenFields:     ["tokenUuid", "tokenId"],
    tokenListFields: [],
    actorFields:     ["actorUuid"],
    actorListFields: []
  };

  // ---------------------------------------------------------------------------
  // Trigger registry
  // ---------------------------------------------------------------------------
  // ORDER OF KEYS HERE = display order in the skill editor dropdown.
  // ---------------------------------------------------------------------------
  const TRIGGERS = [
    // ----- Lifecycle phase triggers ------------------------------------------
    {
      key: "conflict_start",
      label: "At the start of conflict",
      bucket: "conflict_start",
      subjectFrom: null,
      filters: [],
      aliases: ["start_of_conflict"] // raw form emitted by reaction-phaseHandler
    },
    {
      key: "conflict_end",
      label: "At the end of conflict",
      bucket: "conflict_end",
      subjectFrom: null,
      filters: [],
      aliases: ["end_of_conflict"] // raw form emitted on preDeleteCombat
    },
    {
      key: "round_start",
      label: "At the start of the Round",
      bucket: "round_start",
      subjectFrom: null,
      filters: ["debuff_count"],
      aliases: ["start_of_round"]
    },
    {
      key: "round_end",
      label: "At the end of the Round",
      bucket: "round_end",
      subjectFrom: null,
      filters: ["debuff_count"],
      aliases: ["end_of_round"]
    },
    {
      key: "turn_start",
      label: "At the start of a turn",
      bucket: "turn_start",
      subjectFrom: SUBJECT_TURN,
      filters: ["source", "debuff_count"],
      aliases: ["start_of_turn"]
    },
    {
      key: "turn_end",
      label: "At the end of a turn",
      bucket: "turn_end",
      subjectFrom: SUBJECT_TURN,
      filters: ["source", "debuff_count"],
      aliases: ["end_of_turn"]
    },
    {
      // Fires AFTER the active combatant's normal actions resolve, but
      // BEFORE `combat.update({turn:null})` runs (i.e. before turn_end
      // fires and before buffs/debuffs with "until end of your turn"
      // duration expire). Used by Acceleration: the playtest rewrite says
      // "at the end of each of their turns, the target may choose one
      // option [free attack | free Spell ≤10 MP]". Doing this BEFORE
      // turn_end means the free action runs while end-of-turn buffs are
      // still active. Emitted by `endCurrentActivation`; player turns
      // round-trip through the GM via OniReactionPhaseRequest with
      // `awaitable: true` so the player's auto-end logic can await the
      // substrate before committing combat.update.
      key: "pre_turn_end",
      label: "Right before the turn ends (after actions resolve)",
      bucket: "turn_end",
      subjectFrom: SUBJECT_TURN,
      filters: ["source", "debuff_count"],
      aliases: ["pre_end_of_turn"]
    },

    // ----- Action declaration / check triggers -------------------------------
    {
      key: "creature_performs_check",
      label: "When a creature performs a Check",
      bucket: "action_phase",
      subjectFrom: SUBJECT_PERFORMER,
      filters: ["source"]
    },
    {
      key: "creature_performs_action",
      label: "When a creature performs an Action",
      bucket: "action_phase",
      subjectFrom: SUBJECT_PERFORMER,
      filters: ["source"],
      aliases: ["creature_perform_action"] // legacy typo
    },
    {
      key: "creature_targeted_by_action",
      label: "When a creature gets targeted by an action",
      bucket: "action_phase",
      subjectFrom: SUBJECT_TARGET,
      damageSourceFrom: SUBJECT_DAMAGE_SOURCE,
      filters: ["source", "damage_type"],
      aliases: ["creature_is_targeted"] // internal payload uses this
    },
    {
      key: "creature_fumbles_check",
      label: "When a creature fumbles a Check",
      bucket: "action_phase",
      subjectFrom: SUBJECT_PERFORMER,
      filters: ["source"]
    },
    {
      key: "creature_check_adjusted",
      label: "When a check is adjusted (reroll / accuracy / DEF·MDEF)",
      bucket: "action_phase",
      subjectFrom: SUBJECT_PERFORMER,
      filters: ["source"]
    },

    // ----- Resolution triggers (hit / damage / heal / state changes) ---------
    {
      key: "creature_hit_by_action",
      label: "When a creature gets hit by an action",
      bucket: "resolution_phase",
      subjectFrom: SUBJECT_TARGET,
      damageSourceFrom: SUBJECT_DAMAGE_SOURCE,
      filters: ["source", "damage_type"]
    },
    {
      key: "creature_critical_hit",
      label: "When a creature scores a Critical Hit",
      bucket: "resolution_phase",
      subjectFrom: SUBJECT_DAMAGE_SOURCE,
      filters: ["source"]
    },
    {
      key: "creature_miss_action",
      // subject = the attacker (the creature that missed). The post-resolve
      // dispatch is subject-scoped to the MISSED creature as the reactor (see
      // state-handlers §7d), whose reaction_source:"enemy" row then matches the
      // attacker carried in payload.sourceActorUuid. Defender-side reactions:
      // Adoration Clock fill, Fancy Footwork, Thread the Horns, Counter Pass.
      label: "When a creature misses an Action",
      bucket: "resolution_phase",
      subjectFrom: SUBJECT_DAMAGE_SOURCE,
      filters: ["source"]
    },
    {
      key: "creature_deals_damage",
      label: "When a creature deals damage",
      bucket: "resolution_phase",
      subjectFrom: SUBJECT_DAMAGE_SOURCE,
      filters: ["source", "damage_type", "damage_amount"]
    },
    {
      key: "creature_takes_damage",
      label: "When a creature takes damage",
      bucket: "resolution_phase",
      subjectFrom: SUBJECT_TARGET,
      damageSourceFrom: SUBJECT_DAMAGE_SOURCE,
      filters: ["source", "damage_type", "damage_amount"]
    },
    {
      key: "creature_takes_vulnerable_damage",
      label: "When a creature takes Vulnerable damage",
      bucket: "resolution_phase",
      subjectFrom: SUBJECT_TARGET,
      damageSourceFrom: SUBJECT_DAMAGE_SOURCE,
      filters: ["source", "damage_type"]
    },
    {
      key: "creature_takes_weak_damage",
      label: "When a creature takes Weak damage",
      bucket: "resolution_phase",
      subjectFrom: SUBJECT_TARGET,
      damageSourceFrom: SUBJECT_DAMAGE_SOURCE,
      filters: ["source", "damage_type"]
    },
    {
      key: "creature_resists_damage",
      label: "When a creature Resists damage",
      bucket: "resolution_phase",
      subjectFrom: SUBJECT_TARGET,
      damageSourceFrom: SUBJECT_DAMAGE_SOURCE,
      filters: ["source", "damage_type"]
    },
    {
      key: "creature_absorbs_damage",
      label: "When a creature Absorbs damage",
      bucket: "resolution_phase",
      subjectFrom: SUBJECT_TARGET,
      damageSourceFrom: SUBJECT_DAMAGE_SOURCE,
      filters: ["source", "damage_type"]
    },
    {
      key: "creature_immune_damage",
      label: "When a creature is Immune to damage",
      bucket: "resolution_phase",
      subjectFrom: SUBJECT_TARGET,
      damageSourceFrom: SUBJECT_DAMAGE_SOURCE,
      filters: ["source", "damage_type"]
    },
    {
      key: "creature_shield_break",
      label: "When a creature's Shield breaks",
      bucket: "resolution_phase",
      subjectFrom: SUBJECT_TARGET,
      damageSourceFrom: SUBJECT_DAMAGE_SOURCE,
      filters: ["source", "damage_type"]
    },
    {
      key: "creature_recovers_hp",
      label: "When a creature recovers HP",
      bucket: "resolution_phase",
      subjectFrom: SUBJECT_TARGET,
      damageSourceFrom: SUBJECT_DAMAGE_SOURCE,
      filters: ["source"]
    },
    {
      key: "creature_lose_mp",
      label: "When a creature loses MP",
      bucket: "resolution_phase",
      subjectFrom: SUBJECT_TARGET,
      damageSourceFrom: SUBJECT_DAMAGE_SOURCE,
      filters: ["source"]
    },
    {
      key: "creature_recovers_mp",
      label: "When a creature recovers MP",
      bucket: "resolution_phase",
      subjectFrom: SUBJECT_TARGET,
      damageSourceFrom: SUBJECT_DAMAGE_SOURCE,
      filters: ["source"]
    },
    {
      key: "creature_status_applied",
      label: "When a creature gains a Status Effect",
      bucket: "resolution_phase",
      subjectFrom: SUBJECT_TARGET,
      damageSourceFrom: SUBJECT_DAMAGE_SOURCE,
      filters: ["source", "debuff_count"]
    },
    {
      key: "creature_enter_crisis",
      label: "When a creature enters Crisis",
      bucket: "resolution_phase",
      subjectFrom: SUBJECT_STATE_CHANGED,
      filters: ["source"]
    },
    {
      key: "creature_exit_crisis",
      label: "When a creature recovers from Crisis",
      bucket: "resolution_phase",
      subjectFrom: SUBJECT_STATE_CHANGED,
      filters: ["source"]
    },
    {
      key: "creature_defeated",
      label: "When a creature is reduced to 0 HP",
      bucket: "resolution_phase",
      subjectFrom: SUBJECT_STATE_CHANGED,
      filters: ["source"]
    },
    {
      key: "creature_unleashes_zero_power",
      label: "When a creature unleashes Zero Power",
      bucket: "resolution_phase",
      subjectFrom: SUBJECT_PERFORMER,
      filters: ["source"]
    },
    {
      // GENERIC "a status produced its effect" event — DECOUPLED from the HP
      // delta so it fires whether the tick dealt damage, healed (absorb), or did
      // nothing (immune). Emitted by any `deal_damage` row carrying
      // `emit_trigger:"creature_status_triggered"` (the Burn DoT tick, and via
      // the `trigger_status` effect_kind, Flame Claw / Meteor — which replay the
      // REAL tick). The row names the status via `emit_status` -> payload.status,
      // so a listener scopes with `reaction_status_filter` (e.g. "Burn"), exactly
      // like creature_status_applied. Subject = the afflicted creature
      // (payload.sourceActorUuid). Observer-aware (instance-settle LEDGER_FAMILY)
      // so the Wandering Flame's Ignition reacts to ANY creature's Burn trigger;
      // Poison/Bleed/etc. reuse the same trigger via their own emit_status.
      key: "creature_status_triggered",
      label: "When a creature's Status triggers (e.g. Burn DoT)",
      bucket: "resolution_phase",
      subjectFrom: SUBJECT_PERFORMER,
      filters: ["source"]
    }
  ];

  // ---------------------------------------------------------------------------
  // Trigger FAMILIES — coarse groupings used only for sheet VISIBILITY.
  // ---------------------------------------------------------------------------
  // `filters` above is a per-trigger capability list, which is the right shape
  // for the narrow payload filters (damage_type, debuff_count, …) but scales
  // badly for the broad ones: gating `reaction_action_kind` that way would mean
  // editing ~25 trigger entries, and forgetting ONE silently hides live authored
  // config (measured 2026-08-16: 320 authored cells were invisible for exactly
  // this class of mistake). A family is ONE list per axis instead, so the
  // membership is reviewable in a single place.
  //
  // Families are deliberately GENEROUS supersets: a filter cell showing on a
  // trigger where it happens to be a no-op costs a little noise; a cell HIDDEN
  // on a trigger someone authored against costs uneditable data. Every family
  // below is a strict superset of the triggers those cells are measurably
  // authored against in the live corpus.
  const TRIGGER_FAMILIES = {
    // "how a resource moved" — resource/cause/origin filters.
    resource: [
      "creature_lose_resource", "creature_gain_resource",
      "creature_recovers_hp", "creature_recovers_mp", "creature_lose_mp",
      "creature_takes_damage", "creature_deals_damage", "creature_will_deal_damage",
      "creature_shield_break", "creature_enter_crisis", "creature_exit_crisis",
      "creature_defeated"
    ],
    // "which status changed" — status filter. Crisis enter/exit are status
    // changes too (Crisis is an AE), so a "when Crisis lands" row can scope by name.
    status: [
      "creature_status_applied", "creature_status_triggered",
      "creature_enter_crisis", "creature_exit_crisis"
    ],
    // "an action happened" — action-kind / source-skill / responder filters.
    action: [
      "creature_performs_action", "creature_performs_check", "creature_targeted_by_action",
      "creature_hit_by_action", "creature_miss_action", "creature_critical_hit",
      "creature_fumbles_check", "creature_check_adjusted", "creature_check_outcome_flipped",
      "accuracy_check", "creature_guards",
      "creature_deals_damage", "creature_will_deal_damage", "creature_takes_damage",
      "creature_takes_vulnerable_damage", "creature_takes_weak_damage",
      "creature_resists_damage", "creature_absorbs_damage", "creature_immune_damage",
      "creature_completes_action", "creature_completes_skill", "creature_completes_attack",
      "creature_completes_spell", "creature_completes_item", "creature_uses_item",
      // A Zero Power is a thing a creature DID, so "when anyone unleashes <name>"
      // must stay scopable by reaction_source_skill.
      "creature_unleashes_zero_power"
    ]
  };

  // DELIBERATELY in no family: conflict_start / conflict_end / round_start /
  // round_end / turn_start / turn_end / pre_turn_end. These fire off the clock,
  // not off anything a creature did, so their payload carries no action, no
  // resource delta and no status — every family-gated filter would be a no-op
  // cell. NOTE the engine disagrees in one direction: passesMatchFilters applies
  // those filters on ANY trigger and several FAIL CLOSED on a missing payload
  // field, so a lifecycle row that somehow acquired one would never fire. Hiding
  // the cells is therefore the safer half of that mismatch, but it does mean a
  // filter authored on a lifecycle row by migration is invisible — check with
  // tools/csb-template/bin/visibility-audit.js if that is ever suspected.

  const FAMILY_SETS = new Map(
    Object.entries(TRIGGER_FAMILIES).map(([name, keys]) => [name, new Set(keys)])
  );

  // ---------------------------------------------------------------------------
  // Indexes built once at install time
  // ---------------------------------------------------------------------------

  const BY_KEY = new Map();
  const ALIAS_TO_KEY = new Map();

  for (const t of TRIGGERS) {
    if (BY_KEY.has(t.key)) {
      console.warn(`[ReactionTriggers] Duplicate trigger key: ${t.key}`);
    }
    BY_KEY.set(t.key, Object.freeze(t));
    if (Array.isArray(t.aliases)) {
      for (const alias of t.aliases) ALIAS_TO_KEY.set(alias, t.key);
    }
  }

  Object.freeze(TRIGGERS);

  // ---------------------------------------------------------------------------
  // Public helpers
  // ---------------------------------------------------------------------------

  /** All registered trigger entries, in dropdown order. */
  function listTriggers() {
    return TRIGGERS;
  }

  /** Lookup an entry by its canonical key. */
  function getTrigger(key) {
    return BY_KEY.get(key) ?? null;
  }

  /** Resolve a raw payload trigger string to its canonical key. */
  function resolveKey(rawTrigger) {
    if (!rawTrigger) return null;
    if (BY_KEY.has(rawTrigger)) return rawTrigger;
    return ALIAS_TO_KEY.get(rawTrigger) ?? rawTrigger;
  }

  /** Is `triggerKey` (after alias resolution) a known canonical key? */
  function isValidKey(triggerKey) {
    if (!triggerKey) return false;
    return BY_KEY.has(resolveKey(triggerKey));
  }

  /** Phase bucket for `triggerKey`; falls back to the key itself. */
  function bucketFor(triggerKey) {
    const entry = getTrigger(resolveKey(triggerKey));
    return entry?.bucket ?? triggerKey ?? null;
  }

  /** Filter set for `triggerKey` ([] if unknown). */
  function filtersFor(triggerKey) {
    const entry = getTrigger(resolveKey(triggerKey));
    return entry?.filters ?? [];
  }

  /**
   * Is `triggerKey` a member of the named visibility family? Unknown family
   * name → true (fail OPEN: never hide a cell because of a typo here).
   * Unknown trigger key is handled by the caller (reaction-formulaFunctions),
   * which shows the cell rather than hiding it.
   */
  const WARNED_FAMILIES = new Set();
  function triggerInFamily(triggerKey, familyName) {
    const name = String(familyName ?? "").trim();
    const set = FAMILY_SETS.get(name);
    if (!set) {
      // Fail OPEN, but say so once. A typo'd family name is otherwise
      // undetectable: the gate just renders everywhere and looks like a
      // deliberately generous one.
      if (name && !WARNED_FAMILIES.has(name)) {
        WARNED_FAMILIES.add(name);
        console.warn(`[ReactionTriggers] Unknown visibility family "${name}" — gate treated as always-visible. Known: ${[...FAMILY_SETS.keys()].join(", ")}`);
      }
      return true;
    }
    return set.has(resolveKey(triggerKey));
  }

  /** Families `triggerKey` belongs to (for debugging / the preset picker). */
  function familiesFor(triggerKey) {
    const key = resolveKey(triggerKey);
    return [...FAMILY_SETS.entries()].filter(([, s]) => s.has(key)).map(([n]) => n);
  }

  /** Subject-resolution shape (or null for global triggers). */
  function subjectShapeFor(triggerKey) {
    const entry = getTrigger(resolveKey(triggerKey));
    return entry?.subjectFrom ?? null;
  }

  /**
   * Damage-source-resolution shape (or null if this trigger doesn't expose a
   * source side distinct from its subject). Used by the universal
   * `reaction_damage_source` row filter to identify the acting creature on
   * triggers where subject = target (creature_takes_damage, status_applied,
   * etc.). Returns null for triggers where source == subject
   * (creature_deals_damage) or where there is no source at all
   * (round/conflict lifecycle).
   */
  function damageSourceShapeFor(triggerKey) {
    const entry = getTrigger(resolveKey(triggerKey));
    return entry?.damageSourceFrom ?? null;
  }

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------
  window[KEY] = {
    listTriggers,
    getTrigger,
    resolveKey,
    isValidKey,
    bucketFor,
    filtersFor,
    subjectShapeFor,
    damageSourceShapeFor,
    triggerInFamily,
    familiesFor
  };

  console.debug("[ReactionTriggers] Installed. %d triggers registered.", TRIGGERS.length);
});
