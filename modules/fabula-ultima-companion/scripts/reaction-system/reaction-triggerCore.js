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

        for (const item of actor.items ?? []) {
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
      reactionDebuffCountMatchesRow
    };

    console.debug("[ReactionTriggerCore] Installed (registry-driven). Exposed on window['oni.ReactionTriggerCore'].");
  })();
});
