/**
 * [ONI] Reaction System — Module Version (Foundry VTT v12)
 * ---------------------------------------------------------------------------
 * Refactored 2026-05: now reads its trigger taxonomy from the
 * reaction-triggers.config.js registry (window["oni.ReactionTriggers"]).
 * Subject resolution and source filtering are table-driven.
 * ---------------------------------------------------------------------------
 */

Hooks.once("ready", () => {
  // ============================================================================
  // ONI ReactionTriggerCore – v0.2 (registry-driven)
  // ---------------------------------------------------------------------------
  // PURPOSE
  // -------
  // Pure detection layer for reactions:
  //   - Resolve raw phase triggers → canonical trigger keys (via registry)
  //   - Validate trigger keys
  //   - Build subject token lists from a payload using each trigger's
  //     `subjectFrom` shape declared in the registry
  //   - Apply reaction_source / reaction_damage_type row filters
  //   - Scan the active combat for actors with matching Reaction items
  //
  // This file does NOT decide UI ownership, spawn UI, or talk to sockets.
  //
  // EXPOSED API (window["oni.ReactionTriggerCore"])
  // ----------------------------------------------
  //   byIdOnCanvas(tokenId)
  //   mapIncomingTrigger(rawTrigger)             — alias of registry.resolveKey
  //   isValidTriggerKey(triggerKey)              — alias of registry.isValidKey
  //   collectReactionsForTrigger(triggerKey, phasePayload)
  //   extractRows(tableValue)
  //   extractReactionTriggers(item)
  //   reactionSourceMatchesRow(rowSource, reactionToken, triggerKey, phasePayload, combat)
  //   reactionDamageTypeMatchesRow(rowDamageType, triggerKey, phasePayload)
  //   reactionDebuffCountMatchesRow(rowTarget, rowMin, reactionToken, triggerKey, combat)
  //   reactionSubjectKindMatchesRow(rowKind, triggerKey, phasePayload, combat)
  //   reactionOwnershipMatchesRow(rowOwnership, reactionToken, triggerKey, phasePayload, combat)
  //   reactionActionIntentMatchesRow(rowIntent, phasePayload)
  //   reactionBondPresenceMatchesRow(rowValue, reactionToken, triggerKey, phasePayload, combat)
  //   reactionBondEmotionMatchesRow(rowValue, reactionToken, triggerKey, phasePayload, combat)
  // ============================================================================
  (() => {
    const KEY = "oni.ReactionTriggerCore";
    if (window[KEY]) {
      console.debug("[ReactionTriggerCore] Already installed.");
      return;
    }

    const registry = window["oni.ReactionTriggers"];
    if (!registry) {
      console.error("[ReactionTriggerCore] oni.ReactionTriggers registry is not loaded; load reaction-triggers.config.js BEFORE reaction-triggerCore.js.");
      return;
    }

    // -------------------------------------------------------------------------
    // Small helper – resolve token by id on current canvas
    // -------------------------------------------------------------------------
    function byIdOnCanvas(tokenId) {
      if (!tokenId) return null;
      return canvas?.tokens?.get(tokenId) ?? null;
    }

    // -------------------------------------------------------------------------
    // Trigger key helpers (delegate to the registry)
    // -------------------------------------------------------------------------
    function mapIncomingTrigger(rawTrigger) {
      return registry.resolveKey(rawTrigger);
    }

    function isValidTriggerKey(triggerKey) {
      return registry.isValidKey(triggerKey);
    }

    // -------------------------------------------------------------------------
    // Helpers for reading dynamic-table rows
    // -------------------------------------------------------------------------
    function extractRows(tableValue) {
      if (!tableValue) return [];
      const rows = [];

      if (Array.isArray(tableValue)) {
        for (const row of tableValue) {
          if (row && typeof row === "object") rows.push(row);
        }
        return rows;
      }

      if (typeof tableValue === "object") {
        for (const k of Object.keys(tableValue)) {
          const row = tableValue[k];
          if (row && typeof row === "object") rows.push(row);
        }
      }

      return rows;
    }

    /**
     * Synthesize a virtual reaction "item" from an ActiveEffect whose
     * flags carry `fabula-ultima-companion.reactionConfig`. The shape
     * mimics a CSB skill item closely enough for the matcher + picker
     * + dispatcher to treat it the same as a real item.
     *
     * Used so AE-borne reactions (e.g. Acceleration's free-action
     * offer) appear in the reaction picker without polluting the
     * affected actor's sheet with a transient skill item.
     *
     * Returns null if the AE has no reactionConfig flag (so the caller
     * can ignore it).
     */
    function synthesizeReactionItemFromAE(effect) {
      if (!effect) return null;
      const flag = effect?.flags?.["fabula-ultima-companion"]?.reactionConfig;
      if (!flag) return null;

      const reactionConfigTable = flag?.reaction_config_table ?? flag?.configTable ?? null;
      // Phase D rename: prefer `effect_table` (general-purpose), fall back
      // to legacy `reaction_effect_table` for back-compat.
      const reactionEffectTable = flag?.effect_table ?? flag?.reaction_effect_table ?? flag?.effectTable ?? null;
      if (!reactionConfigTable && !reactionEffectTable) return null;

      // If the AE carries a charges flag (e.g. bonusActionGrant), don't
      // synthesize a reaction offer when the charge is drained. The AE
      // itself sticks around (e.g. waiting for scene cleanup) but it
      // shouldn't show up in the reaction picker anymore.
      const chargesFlag = Number(effect?.flags?.["fabula-ultima-companion"]?.charges ?? NaN);
      if (Number.isFinite(chargesFlag) && chargesFlag <= 0) return null;

      // Tag the synth UUID so downstream consumers (picker / dispatcher)
      // can recognize it. We don't try to make this a real Foundry UUID —
      // nothing inside the substrate dereferences it via fromUuid().
      const synthUuid = `${effect.uuid}::synth-reaction`;

      return {
        // Item-shaped facade
        id: `synth-${effect.id}`,
        uuid: synthUuid,
        name: flag.name ?? effect.name ?? "Reaction",
        img: flag.img ?? effect.icon ?? effect.img ?? "icons/svg/aura.svg",
        type: "equippableItem",

        // Mark for debugging / safe-checks; downstream code that needs
        // to distinguish a synth from a real item can read these.
        __synthFromActiveEffect: true,
        __sourceEffectUuid: effect.uuid,
        __sourceEffectId: effect.id,

        system: {
          props: {
            isReaction: true,
            name: flag.name ?? effect.name ?? "Reaction",
            reaction_config_table: reactionConfigTable ?? {},
            // Phase D rename: synth always emits the new key (`effect_table`).
            // readEffectRows still falls back to `reaction_effect_table` for
            // any non-AE callers that haven't migrated yet.
            effect_table: reactionEffectTable ?? {}
          }
        }
      };
    }

    /**
     * Iterate every "reaction-bearing item" on an actor — real items
     * plus virtual items synthesized from any ActiveEffect that carries
     * a `reactionConfig` flag.
     */
    function* enumerateActorReactionItems(actor) {
      if (!actor) return;
      for (const item of actor.items ?? []) yield item;
      for (const effect of actor.effects ?? []) {
        if (effect?.disabled || effect?.isSuppressed) continue;
        const synth = synthesizeReactionItemFromAE(effect);
        if (synth) yield synth;
      }
    }

    function extractReactionTriggers(item) {
      const sys   = item.system ?? {};
      const props = sys.props ?? sys;
      const table = props.reaction_config_table;
      const rows  = extractRows(table);
      const out   = [];

      for (const row of rows) {
        const key = row.reaction_trigger;
        if (typeof key === "string" && key.length > 0) out.push(key);
      }
      return out;
    }

    // -------------------------------------------------------------------------
    // Source / disposition helpers
    // -------------------------------------------------------------------------
    function normalizeSourceKey(raw) {
      if (!raw || raw === "") return "all";
      const k = String(raw).toLowerCase();
      switch (k) {
        case "self":
        case "ally":
        case "enemy":
        case "neutral":
        case "all":
          return k;
        default:
          return "all";
      }
    }

    function normalizeDisposition(disposition) {
      // Foundry: 1 = Friendly, 0 = Neutral, -1 = Hostile, -2 = Secret (treat as Neutral)
      if (disposition === -2) return 0;
      if (disposition === 1)  return 1;
      if (disposition === -1) return -1;
      return 0;
    }

    // -------------------------------------------------------------------------
    // Token resolution helpers
    // -------------------------------------------------------------------------
    function findTokenByActorUuidInCombat(combat, actorUuid) {
      if (!combat || !actorUuid) return null;
      const combatants = combat.combatants?.contents ?? combat.combatants ?? [];
      for (const cmbt of combatants) {
        if (cmbt?.actor?.uuid === actorUuid) {
          const tokenId = cmbt.tokenId ?? cmbt.token?.id;
          const token   = byIdOnCanvas(tokenId);
          if (token) return token;
        }
      }
      return null;
    }

    function findTokenByUuidish(uuidish, combat = game.combat) {
      if (!uuidish || typeof uuidish !== "string") return null;

      const match = uuidish.match(/\.Token\.([A-Za-z0-9]+)$/);
      if (match) {
        const tokenId = match[1];
        const t = byIdOnCanvas(tokenId);
        if (t) return t;
      }

      const direct = byIdOnCanvas(uuidish);
      if (direct) return direct;

      try {
        const doc = (typeof fromUuidSync === "function")
          ? fromUuidSync(uuidish)
          : null;

        if (!doc) return null;

        if (doc.documentName === "Token" || doc.documentName === "TokenDocument") {
          return doc.object ?? byIdOnCanvas(doc.id) ?? null;
        }

        if (doc.documentName === "Actor") {
          const combatToken = findTokenByActorUuidInCombat(combat, doc.uuid);
          if (combatToken) return combatToken;

          try {
            const active = doc.getActiveTokens?.(true, true) ?? doc.getActiveTokens?.() ?? [];
            if (active?.[0]) return active[0];
          } catch (_err) {}

          try {
            const protoObj = doc.token?.object ?? doc.prototypeToken?.object ?? null;
            if (protoObj) return protoObj;
          } catch (_err) {}

          return null;
        }

        const embeddedToken = doc?.token?.object ?? doc?.object ?? null;
        if (embeddedToken?.document?.documentName === "Token") {
          return embeddedToken;
        }

        const tokenId2 = doc?.token?.id ?? null;
        if (tokenId2) {
          const t = byIdOnCanvas(tokenId2);
          if (t) return t;
        }
      } catch (_err) {
        // ignore
      }

      return null;
    }

    // -------------------------------------------------------------------------
    // Subject tokens for a trigger – TABLE-DRIVEN from the registry
    // -------------------------------------------------------------------------
    //
    // Each registry entry's `subjectFrom` declares which payload fields point at
    // the "subject creature(s)" of this trigger. We process them in order:
    //   1) tokenFields      — single-value token UUIDs
    //   2) tokenListFields  — array-value token UUIDs
    // If at least one token resolved, we stop there. Otherwise we fall back to:
    //   3) actorFields      — single-value actor UUIDs (resolved via combat)
    //   4) actorListFields  — array-value actor UUIDs
    //
    function getSubjectTokensForTrigger(triggerKey, phasePayload, combat) {
      const subjects = [];
      if (!phasePayload || !combat) return subjects;

      const shape = registry.subjectShapeFor(triggerKey);
      if (!shape) return subjects;

      const seen = new Set();
      const addToken = (token) => {
        if (!token) return;
        if (seen.has(token.id)) return;
        seen.add(token.id);
        subjects.push(token);
      };

      // 1) Single token UUIDs
      for (const f of shape.tokenFields ?? []) {
        const t = findTokenByUuidish(phasePayload[f], combat);
        if (t) addToken(t);
      }

      // 2) Array token UUIDs
      for (const f of shape.tokenListFields ?? []) {
        const list = phasePayload[f];
        if (!Array.isArray(list)) continue;
        for (const u of list) {
          const t = findTokenByUuidish(u, combat);
          if (t) addToken(t);
        }
      }

      // If we got token-side hits, do NOT fall back to actor fields.
      if (subjects.length > 0) return subjects;

      // 3) Single actor UUIDs
      for (const f of shape.actorFields ?? []) {
        const t = findTokenByActorUuidInCombat(combat, phasePayload[f]);
        if (t) addToken(t);
      }

      // 4) Array actor UUIDs
      for (const f of shape.actorListFields ?? []) {
        const list = phasePayload[f];
        if (!Array.isArray(list)) continue;
        for (const aUuid of list) {
          const t = findTokenByActorUuidInCombat(combat, aUuid);
          if (t) addToken(t);
        }
      }

      return subjects;
    }

    // -------------------------------------------------------------------------
    // reaction_source matching
    // -------------------------------------------------------------------------
    function reactionSourceMatchesRow(rowSourceRaw, reactionToken, triggerKey, phasePayload, combat) {
      const sourceKey = normalizeSourceKey(rowSourceRaw);
      const filters = registry.filtersFor(triggerKey);

      // If "source" is not a declared filter for this trigger, always match.
      if (!filters.includes("source")) return true;

      const subjects = getSubjectTokensForTrigger(triggerKey, phasePayload, combat);

      // Empty subject list:
      //   - "all" still matches (generic "a creature/turn" with unknown subject)
      //   - more specific filters (self/ally/enemy/neutral) do not.
      if (!subjects.length) {
        return sourceKey === "all";
      }

      const reactDoc  = reactionToken?.document;
      const reactDisp = normalizeDisposition(reactDoc?.disposition ?? 0);

      const matchOne = (subjectToken) => {
        const subDoc  = subjectToken?.document;
        const subDisp = normalizeDisposition(subDoc?.disposition ?? 0);

        switch (sourceKey) {
          case "all":
            return true;

          case "self":
            if (!reactDoc || !subDoc) return false;
            if (subjectToken.id === reactionToken.id) return true;
            const reactActorUuid = reactionToken.actor?.uuid;
            const subjActorUuid  = subjectToken.actor?.uuid;
            return !!reactActorUuid && reactActorUuid === subjActorUuid;

          case "ally":
            if (reactDisp === 1)  return subDisp === 1;
            if (reactDisp === -1) return subDisp === -1;
            return false;

          case "enemy":
            if (reactDisp === 1)  return subDisp === -1;
            if (reactDisp === -1) return subDisp === 1;
            return false;

          case "neutral":
            return subDisp === 0;

          default:
            return true;
        }
      };

      return subjects.some(matchOne);
    }

    // -------------------------------------------------------------------------
    // reaction_damage_type matching
    // -------------------------------------------------------------------------
    function reactionDamageTypeMatchesRow(rowDamageTypeRaw, triggerKey, phasePayload) {
      const desired = (rowDamageTypeRaw ?? "").toString().trim().toLowerCase();
      if (!desired) return true;

      const filters = registry.filtersFor(triggerKey);
      if (!filters.includes("damage_type")) return true;

      if (!phasePayload || typeof phasePayload !== "object") return false;

      const possibleKeys = [
        "elementType",
        "damageElementType",
        "damageType",
        "damage_type",
        "element"
      ];

      let eventRaw = null;
      for (const k of possibleKeys) {
        if (phasePayload[k] != null) {
          eventRaw = phasePayload[k];
          break;
        }
      }

      if (eventRaw == null) {
        console.log("[ReactionTriggerCore] reaction_damage_type filter set, but no elementType found in payload for trigger",
          triggerKey, phasePayload);
        return false;
      }

      const eventType = eventRaw.toString().trim().toLowerCase();
      return eventType === desired;
    }

    // -------------------------------------------------------------------------
    // reaction_subject_kind matching
    // -------------------------------------------------------------------------
    //
    // Filter "the subject creature is of kind X" by checking truthiness of
    // `subject.actor.system.props[<rowKind>]`. Blank row value disables the
    // filter. Triggers without a per-creature subject (conflict/round) make
    // the filter inert (matches anything).
    //
    // Conventional kind keys:
    //   isPhantasm   — the Phantasm summon family (see scripts/phantasm-api.js)
    //   isSummon     — any summoned creature
    // Authors can introduce new kind keys by setting the corresponding flag
    // on actors; no code change needed.
    function reactionSubjectKindMatchesRow(rowKindRaw, triggerKey, phasePayload, combat) {
      const rowKind = (rowKindRaw ?? "").toString().trim();
      if (!rowKind) return true; // empty = filter inactive

      const shape = registry.subjectShapeFor(triggerKey);
      if (!shape) return true; // subject-less trigger → filter inert

      const subjects = getSubjectTokensForTrigger(triggerKey, phasePayload, combat);
      if (!subjects.length) return false; // active filter + no subject = no match

      const matchOne = (subjectToken) => {
        const actor = subjectToken?.actor;
        if (!actor) return false;
        const props = actor?.system?.props ?? {};
        return !!props[rowKind];
      };
      return subjects.some(matchOne);
    }

    // -------------------------------------------------------------------------
    // reaction_ownership matching
    // -------------------------------------------------------------------------
    //
    // Filter on a summon-ownership relationship between the subject token and
    // the reactor. Currently one value: "own_summon" — the subject token's
    // `flags["fabula-ultima-companion"].summonedBy` matches the reactor's
    // actor UUID. Blank row value = filter inactive.
    //
    // The flag is written by FUCompanion.api.phantasm.markSummon() when a
    // summon is spawned, but the matcher reads the raw flag directly so it
    // works even if the phantasm helper isn't loaded yet.
    function reactionOwnershipMatchesRow(rowOwnershipRaw, reactionToken, triggerKey, phasePayload, combat) {
      const rowOwnership = (rowOwnershipRaw ?? "").toString().trim();
      if (!rowOwnership) return true; // empty = filter inactive

      const shape = registry.subjectShapeFor(triggerKey);
      if (!shape) return true;

      const reactActorUuid = reactionToken?.actor?.uuid;
      if (!reactActorUuid) return false;

      const subjects = getSubjectTokensForTrigger(triggerKey, phasePayload, combat);
      if (!subjects.length) return false;

      const MODULE_ID = "fabula-ultima-companion";
      const FLAG_KEY = "summonedBy";

      const matchOne = (subjectToken) => {
        const tokenDoc = subjectToken?.document;
        if (!tokenDoc) return false;
        const summonedBy = tokenDoc.getFlag?.(MODULE_ID, FLAG_KEY)
          ?? tokenDoc.flags?.[MODULE_ID]?.[FLAG_KEY]
          ?? null;
        if (!summonedBy) return false;

        switch (rowOwnership) {
          case "own_summon":
            return summonedBy === reactActorUuid;
          default:
            console.warn("[ReactionTriggerCore] reaction_ownership: unknown value, treating as no-match.", rowOwnership);
            return false;
        }
      };
      return subjects.some(matchOne);
    }

    // -------------------------------------------------------------------------
    // reaction_action_intent matching
    // -------------------------------------------------------------------------
    //
    // Universal filter: "this row only matches when the triggering action is
    // harmful / aid / neutral." Set on `reaction_config_table` rows.
    //
    // Possible row values:
    //   ""        — filter disabled (any intent matches; default).
    //   "harmful" — match only when the phase payload classifies the action
    //               as harmful (attack, offensive spell, damage source).
    //               This is the gate Protect/Cover/Counterattack need so
    //               they don't fire on an ally's buff/heal.
    //   "aid"     — match only when the action is aid (heal, recovery, buff
    //               spell, utility active). Niche; e.g. an aura that procs
    //               on incoming healing.
    //   "neutral" — match only when classification is "neutral" (Passive,
    //               Item, Other).
    //
    // The payload's `actionIntent` is set by ADC from the action's
    // skill_type / isOffensiveSpell / declaresHealing / damage signals,
    // with optional `props.action_intent` author override. Lifecycle phase
    // payloads (turn_start, round_end, etc.) carry no intent — a row with
    // an active intent filter against such a payload returns no-match
    // (fail-closed), which is the desired behavior for reactions like
    // Protect that only make sense around actions.
    function reactionActionIntentMatchesRow(rowIntentRaw, phasePayload) {
      const desired = String(rowIntentRaw ?? "").trim().toLowerCase();
      if (!desired) return true; // empty = filter inactive

      if (!(desired === "harmful" || desired === "aid" || desired === "neutral")) {
        console.warn("[ReactionTriggerCore] reaction_action_intent: unknown value, treating as no-match.", rowIntentRaw);
        return false;
      }

      if (!phasePayload || typeof phasePayload !== "object") return false;

      const actual = String(phasePayload.actionIntent ?? "").trim().toLowerCase();
      if (!actual) return false; // payload doesn't carry intent → fail-closed

      return actual === desired;
    }

    // -------------------------------------------------------------------------
    // reaction_bond_presence / reaction_bond_emotion matching
    // -------------------------------------------------------------------------
    //
    // Bond data on a character actor (Traits & Bonds tab in CSB):
    //   system.props.bond_N             — target's name (text). N ∈ 1..6 + "temp".
    //   system.props.emotion_N_1        — Admiration / Inferiority pair (select).
    //   system.props.emotion_N_2        — Loyalty    / Mistrust    pair (select).
    //   system.props.emotion_N_3        — Affection  / Hatred      pair (select).
    //
    // Matching is case-insensitive throughout because the template's option
    // values aren't perfectly consistent across slots (slot 1 ships
    // capitalized "Admiration"/"Inferiority"; slots 2-6/temp ship lowercase).
    //
    // Both filters are universal — applicable to any trigger whose subject
    // is a creature (subject-less lifecycle triggers make the filter inert,
    // matching the reaction_subject_kind / reaction_ownership convention).
    const BOND_SLOTS = Object.freeze(["1","2","3","4","5","6","temp"]);
    const BOND_EMOTION_PAIR = Object.freeze({
      admiration:   1, inferiority: 1,
      loyalty:      2, mistrust:    2,
      affection:    3, hatred:      3
    });

    function _collectBondedNames(actor) {
      const props = actor?.system?.props ?? {};
      const out = new Set();
      for (const slot of BOND_SLOTS) {
        const v = String(props[`bond_${slot}`] ?? "").trim().toLowerCase();
        if (v) out.add(v);
      }
      return out;
    }

    function _subjectNameMatches(subjectToken, nameSet) {
      const an = String(subjectToken?.actor?.name ?? "").trim().toLowerCase();
      const tn = String(subjectToken?.document?.name ?? subjectToken?.name ?? "").trim().toLowerCase();
      return (an && nameSet.has(an)) || (tn && nameSet.has(tn));
    }

    // Collect every creature the bond filter could plausibly care about for
    // this trigger: the trigger's declared subject (per registry) PLUS the
    // action's target list (regardless of trigger).
    //
    // Why both: Agony fires on `creature_deals_damage` where the trigger's
    // subject is the damage SOURCE (the reactor herself — useless for the
    // bond check). The RAW phrase "Bond towards (one of those creatures)"
    // means the damaged creatures, which live in the payload's target fields.
    // For triggers where subject IS the target (e.g. creature_hit_by_action),
    // the two sets overlap; the Set dedups.
    function _collectBondCheckCreatures(triggerKey, phasePayload, combat) {
      const seen = new Set();
      const out = [];
      const push = (t) => { if (!t || seen.has(t.id)) return; seen.add(t.id); out.push(t); };

      // Subject side (registry-driven).
      for (const t of getSubjectTokensForTrigger(triggerKey, phasePayload, combat)) push(t);

      // Targets — payload-driven, irrespective of trigger.
      const single = ["targetUuid", "targetTokenUuid"];
      const lists  = ["targets", "targetTokenUuids"];
      for (const f of single) push(findTokenByUuidish(phasePayload?.[f], combat));
      for (const f of lists) {
        const list = phasePayload?.[f];
        if (!Array.isArray(list)) continue;
        for (const u of list) push(findTokenByUuidish(u, combat));
      }

      return out;
    }

    // reaction_bond_presence:
    //   ""        — filter inactive (any subject matches).
    //   "present" — reactor's bond_N matches at least one subject's name.
    //   "absent"  — reactor has no bond toward any subject.
    function reactionBondPresenceMatchesRow(rowValueRaw, reactionToken, triggerKey, phasePayload, combat) {
      const v = String(rowValueRaw ?? "").trim().toLowerCase();
      if (!v) return true;

      const shape = registry.subjectShapeFor(triggerKey);
      if (!shape) return true; // subject-less trigger → filter inert

      const reactActor = reactionToken?.actor;
      if (!reactActor) return false;

      const creatures = _collectBondCheckCreatures(triggerKey, phasePayload, combat);
      if (!creatures.length) return false; // active filter + no creatures = fail-closed

      const bonded = _collectBondedNames(reactActor);
      const hasMatch = creatures.some(c => _subjectNameMatches(c, bonded));

      if (v === "present") return hasMatch;
      if (v === "absent")  return !hasMatch;
      console.warn("[ReactionTriggerCore] reaction_bond_presence: unknown value, treating as no-match.", rowValueRaw);
      return false;
    }

    // reaction_bond_emotion:
    //   ""           — filter inactive.
    //   one of the 6 emotions — reactor's bond toward a subject must carry
    //                           that emotion in its category field. Implies
    //                           presence (an emotion only exists inside a Bond).
    function reactionBondEmotionMatchesRow(rowValueRaw, reactionToken, triggerKey, phasePayload, combat) {
      const v = String(rowValueRaw ?? "").trim().toLowerCase();
      if (!v) return true;

      const pair = BOND_EMOTION_PAIR[v];
      if (!pair) {
        console.warn("[ReactionTriggerCore] reaction_bond_emotion: unknown value, treating as no-match.", rowValueRaw);
        return false;
      }

      const shape = registry.subjectShapeFor(triggerKey);
      if (!shape) return true;

      const reactActor = reactionToken?.actor;
      if (!reactActor) return false;

      const creatures = _collectBondCheckCreatures(triggerKey, phasePayload, combat);
      if (!creatures.length) return false;

      const props = reactActor.system?.props ?? {};

      return creatures.some(subj => {
        const an = String(subj?.actor?.name ?? "").trim().toLowerCase();
        const tn = String(subj?.document?.name ?? subj?.name ?? "").trim().toLowerCase();
        for (const slot of BOND_SLOTS) {
          const bondName = String(props[`bond_${slot}`] ?? "").trim().toLowerCase();
          if (!bondName) continue;
          if (bondName !== an && bondName !== tn) continue;
          const emoVal = String(props[`emotion_${slot}_${pair}`] ?? "").trim().toLowerCase();
          if (emoVal === v) return true;
        }
        return false;
      });
    }

    // -------------------------------------------------------------------------
    // reaction_debuff_count_* matching
    // -------------------------------------------------------------------------
    // Off semantics: an empty/zero `_min` always matches (filter inactive).
    // When active, sums "Debuff"-classified active effects across the chosen
    // group (self/ally/enemy/all, computed relative to the reactor's
    // disposition; `ally` includes the reactor itself) and returns whether
    // the total meets the configured minimum. Effects that are disabled or
    // suppressed (expired but not yet removed) are skipped.
    //
    // Categorization is delegated to ActiveEffectManager-registry's
    // inferCategory(), reachable via globalThis.FUCompanion.api.activeEffectRegistry.
    // If that helper is unavailable when the filter is active, we fail-closed
    // (no match) — better to drop a reaction than to mis-fire.
    function reactionDebuffCountMatchesRow(rowTargetRaw, rowMinRaw, reactionToken, triggerKey, combat) {
      const rawMin = (rowMinRaw === null || rowMinRaw === undefined) ? "" : String(rowMinRaw).trim();
      if (rawMin === "") return true;
      const minVal = Number(rawMin);
      if (!Number.isFinite(minVal) || minVal <= 0) return true;

      const filters = registry.filtersFor(triggerKey);
      if (!filters.includes("debuff_count")) return true; // silently inert

      if (!combat || !reactionToken) return false;

      const target = (rowTargetRaw ?? "").toString().trim().toLowerCase();
      if (!target) return true; // no target group chosen → filter inactive

      const inferCategory = globalThis?.FUCompanion?.api?.activeEffectRegistry?._internal?.inferCategory;
      if (typeof inferCategory !== "function") {
        console.warn("[ReactionTriggerCore] reaction_debuff_count: inferCategory unavailable; failing closed.");
        return false;
      }

      const reactDisp = normalizeDisposition(reactionToken?.document?.disposition ?? 0);
      const reactActorUuid = reactionToken?.actor?.uuid;

      const combatants = combat.combatants?.contents ?? combat.combatants ?? [];
      const seenActorUuids = new Set();
      const actors = [];
      for (const cmbt of combatants) {
        const actor = cmbt?.actor;
        if (!actor || !actor.uuid) continue;
        if (seenActorUuids.has(actor.uuid)) continue;

        const tokenId = cmbt.tokenId ?? cmbt.token?.id;
        const tokenDoc = byIdOnCanvas(tokenId)?.document;
        const subDisp = normalizeDisposition(tokenDoc?.disposition ?? 0);

        let included = false;
        switch (target) {
          case "self":
            included = !!reactActorUuid && actor.uuid === reactActorUuid;
            break;
          case "ally":
            // Same-disposition tokens; INCLUDES reactor itself.
            included = (reactDisp === 1 && subDisp === 1) ||
                       (reactDisp === -1 && subDisp === -1);
            break;
          case "enemy":
            included = (reactDisp === 1 && subDisp === -1) ||
                       (reactDisp === -1 && subDisp === 1);
            break;
          case "all":
            included = true;
            break;
          default:
            included = false;
        }

        if (included) {
          seenActorUuids.add(actor.uuid);
          actors.push(actor);
        }
      }

      let total = 0;
      for (const actor of actors) {
        const effects = actor.effects?.contents ?? actor.effects ?? [];
        for (const effect of effects) {
          if (!effect) continue;
          if (effect.disabled) continue;
          if (effect.isSuppressed) continue;
          try {
            if (inferCategory(effect) === "Debuff") total++;
          } catch (e) {
            console.warn("[ReactionTriggerCore] inferCategory threw on effect", effect, e);
          }
        }
      }

      return total >= minVal;
    }

    // -------------------------------------------------------------------------
    // collectReactionsForTrigger – main detector entry point
    // -------------------------------------------------------------------------
    function collectReactionsForTrigger(triggerKey, phasePayload) {
      const normalizedTriggerKey = mapIncomingTrigger(triggerKey);

      const combat = game.combat;
      if (!combat) {
        console.log("[ReactionTriggerCore] collectReactionsForTrigger: no active combat.", {
          triggerKey: normalizedTriggerKey,
          rawTriggerKey: triggerKey,
          phasePayload
        });
        return [];
      }

      if (!normalizedTriggerKey || !isValidTriggerKey(normalizedTriggerKey)) {
        console.log("[ReactionTriggerCore] collectReactionsForTrigger: invalid trigger key.", {
          triggerKey,
          normalizedTriggerKey,
          phasePayload
        });
        return [];
      }

      const results = [];
      const combatants = combat.combatants?.contents ?? combat.combatants ?? [];

      console.log("[ReactionTriggerCore] collectReactionsForTrigger: scanning combatants for trigger.", {
        triggerKey: normalizedTriggerKey,
        rawTriggerKey: triggerKey,
        numCombatants: combatants.length,
        phasePayload
      });

      for (const cmbt of combatants) {
        const actor = cmbt?.actor;
        if (!actor) continue;

        const tokenId = cmbt.tokenId ?? cmbt.token?.id;
        const token   = byIdOnCanvas(tokenId);
        if (!token) continue;

        const tokenDoc = token.document;
        const actorReactions = [];

        for (const item of enumerateActorReactionItems(actor)) {
          const sys   = item.system ?? {};
          const props = sys.props ?? sys;
          if (!props?.isReaction) continue;

          const table = props.reaction_config_table;
          const rows  = extractRows(table);
          const matchingRows = [];

          for (const row of rows) {
            const rowTrigger = mapIncomingTrigger(row.reaction_trigger);
            if (rowTrigger !== normalizedTriggerKey) continue;

            // Source filter (Self / Ally / Enemy / Neutral / All)
            if (!reactionSourceMatchesRow(row.reaction_source, token, normalizedTriggerKey, phasePayload, combat)) continue;

            // Damage-type filter (Physical / Fire / Ice / etc.)
            if (!reactionDamageTypeMatchesRow(row.reaction_damage_type, normalizedTriggerKey, phasePayload)) continue;

            // Debuff-count filter (only consulted on triggers that declare it).
            if (!reactionDebuffCountMatchesRow(
              row.reaction_debuff_count_target,
              row.reaction_debuff_count_min,
              token,
              normalizedTriggerKey,
              combat
            )) continue;

            // Subject-kind filter (subject.actor.system.props[<kind>] truthy).
            if (!reactionSubjectKindMatchesRow(
              row.reaction_subject_kind,
              normalizedTriggerKey,
              phasePayload,
              combat
            )) continue;

            // Ownership filter (e.g. subject was summoned by reactor).
            if (!reactionOwnershipMatchesRow(
              row.reaction_ownership,
              token,
              normalizedTriggerKey,
              phasePayload,
              combat
            )) continue;

            // Action-intent filter (harmful vs aid vs neutral).
            if (!reactionActionIntentMatchesRow(
              row.reaction_action_intent,
              phasePayload
            )) continue;

            // Bond-presence filter (reactor has/doesn't have a Bond toward subject).
            if (!reactionBondPresenceMatchesRow(
              row.reaction_bond_presence,
              token,
              normalizedTriggerKey,
              phasePayload,
              combat
            )) continue;

            // Bond-emotion filter (specific emotion within the Bond toward subject).
            if (!reactionBondEmotionMatchesRow(
              row.reaction_bond_emotion,
              token,
              normalizedTriggerKey,
              phasePayload,
              combat
            )) continue;

            matchingRows.push(row);
          }

          if (matchingRows.length > 0) {
            console.log("[ReactionTriggerCore] item has matching rows for trigger.", {
              actorName: actor.name,
              tokenName: tokenDoc.name,
              itemName: item.name,
              triggerKey: normalizedTriggerKey,
              matchingRowCount: matchingRows.length
            });

            actorReactions.push({
              item,
              triggers: matchingRows.map(r => mapIncomingTrigger(r.reaction_trigger)),
              rows: matchingRows
            });
          }
        }

        if (actorReactions.length > 0) {
          results.push({
            combatant: cmbt,
            actor,
            token,
            reactions: actorReactions,
            triggerKey: normalizedTriggerKey,
            phasePayload
          });
        }
      }

      console.log("[ReactionTriggerCore] collectReactionsForTrigger: done.", {
        triggerKey: normalizedTriggerKey,
        rawTriggerKey: triggerKey,
        matchCount: results.length
      });

      return results;
    }

    // -------------------------------------------------------------------------
    // Export
    // -------------------------------------------------------------------------
    window[KEY] = {
      byIdOnCanvas,
      mapIncomingTrigger,
      isValidTriggerKey,
      collectReactionsForTrigger,
      extractRows,
      extractReactionTriggers,
      reactionSourceMatchesRow,
      reactionDamageTypeMatchesRow,
      reactionDebuffCountMatchesRow,
      reactionSubjectKindMatchesRow,
      reactionOwnershipMatchesRow,
      reactionActionIntentMatchesRow,
      reactionBondPresenceMatchesRow,
      reactionBondEmotionMatchesRow
    };

    console.debug("[ReactionTriggerCore] Installed (registry-driven). Exposed on window['oni.ReactionTriggerCore'].");
  })();
});
