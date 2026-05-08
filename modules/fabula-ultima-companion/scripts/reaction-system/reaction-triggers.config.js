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
    console.log("[ReactionTriggers] Already installed.");
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
      key: "creature_check_outcome_flipped",
      label: "When a creature changes the outcome of a check",
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
      filters: ["source", "damage_type"]
    },
    {
      key: "creature_takes_damage",
      label: "When a creature takes damage",
      bucket: "resolution_phase",
      subjectFrom: SUBJECT_TARGET,
      filters: ["source", "damage_type"]
    },
    {
      key: "creature_takes_vulnerable_damage",
      label: "When a creature takes Vulnerable damage",
      bucket: "resolution_phase",
      subjectFrom: SUBJECT_TARGET,
      filters: ["source", "damage_type"]
    },
    {
      key: "creature_takes_weak_damage",
      label: "When a creature takes Weak damage",
      bucket: "resolution_phase",
      subjectFrom: SUBJECT_TARGET,
      filters: ["source", "damage_type"]
    },
    {
      key: "creature_resists_damage",
      label: "When a creature Resists damage",
      bucket: "resolution_phase",
      subjectFrom: SUBJECT_TARGET,
      filters: ["source", "damage_type"]
    },
    {
      key: "creature_absorbs_damage",
      label: "When a creature Absorbs damage",
      bucket: "resolution_phase",
      subjectFrom: SUBJECT_TARGET,
      filters: ["source", "damage_type"]
    },
    {
      key: "creature_immune_damage",
      label: "When a creature is Immune to damage",
      bucket: "resolution_phase",
      subjectFrom: SUBJECT_TARGET,
      filters: ["source", "damage_type"]
    },
    {
      key: "creature_shield_break",
      label: "When a creature's Shield breaks",
      bucket: "resolution_phase",
      subjectFrom: SUBJECT_TARGET,
      filters: ["source", "damage_type"]
    },
    {
      key: "creature_recovers_hp",
      label: "When a creature recovers HP",
      bucket: "resolution_phase",
      subjectFrom: SUBJECT_TARGET,
      filters: ["source"]
    },
    {
      key: "creature_lose_mp",
      label: "When a creature loses MP",
      bucket: "resolution_phase",
      subjectFrom: SUBJECT_TARGET,
      filters: ["source"]
    },
    {
      key: "creature_recovers_mp",
      label: "When a creature recovers MP",
      bucket: "resolution_phase",
      subjectFrom: SUBJECT_TARGET,
      filters: ["source"]
    },
    {
      key: "creature_status_applied",
      label: "When a creature gains a Status Effect",
      bucket: "resolution_phase",
      subjectFrom: SUBJECT_TARGET,
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
    }
  ];

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

  /** Subject-resolution shape (or null for global triggers). */
  function subjectShapeFor(triggerKey) {
    const entry = getTrigger(resolveKey(triggerKey));
    return entry?.subjectFrom ?? null;
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
    subjectShapeFor
  };

  console.log("[ReactionTriggers] Installed. %d triggers registered.", TRIGGERS.length);
});
