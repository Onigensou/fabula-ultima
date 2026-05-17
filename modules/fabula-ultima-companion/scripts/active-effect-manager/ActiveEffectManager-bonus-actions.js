/**
 * Bonus Action Grants — Foundry V12
 * -----------------------------------------------------------------------------
 * Thin facade over the Charges API ([[ActiveEffectManager-charges]]) for AEs
 * that grant extra actions per turn (Acceleration, Frenzy, Haste-likes).
 *
 * A bonus-action grant is an ActiveEffect carrying these flags under
 * `flags.fabula-ultima-companion`:
 *
 *   charges: 2            (mandatory; tracked by Charges API)
 *   chargesMax: 2         (optional, display)
 *   chargeKey: "bonusAction"     (mandatory; namespace for this kind of grant)
 *   bonusActionGrant: {
 *     condition: "in_turn" | "out_of_turn",   // when the grant can pay
 *     applicableTypes: ["*"] | ["Attack","Spell",...],  // which skill types
 *     expiry: "scene" | "round" | "combat-end" | "manual",
 *     sourceLabel: "Acceleration",            // for UI / logs
 *     casterUuid: <token-uuid>                // optional
 *   }
 *
 * The Charges API auto-deletes the AE when charges drain to 0
 * (`deleteWhenEmpty: true`). Scene-bounded grants that never drain are
 * removed by the combatEnd cleanup hook below.
 *
 * Public API: globalThis.FUCompanion.api.bonusActions
 *   findApplicable(actor, { condition, skillType }) → grants[]
 *   reserve(grant) → reservation token
 *   consumeReservation(reservation) → boolean
 */
(() => {
  const TAG = "[ONI][BonusActions]";
  const MODULE_ID = "fabula-ultima-companion";
  const CHARGE_KEY = "bonusAction";
  const GRANT_FLAG = "bonusActionGrant";

  if (globalThis.FUCompanion?.api?.bonusActions) {
    console.debug(`${TAG} Already installed.`);
    return;
  }

  const log = (...a) => console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);

  function getGrantSpec(effect) {
    if (!effect) return null;
    try {
      return effect.getFlag?.(MODULE_ID, GRANT_FLAG) ?? null;
    } catch (_) {
      return effect?.flags?.[MODULE_ID]?.[GRANT_FLAG] ?? null;
    }
  }

  function isApplicableType(spec, skillType) {
    const types = Array.isArray(spec?.applicableTypes) ? spec.applicableTypes : ["*"];
    if (!types.length) return true;
    if (types.includes("*")) return true;
    if (!skillType) return true; // unspecified caller — be permissive
    return types.includes(skillType);
  }

  // Per-turn cap: spec.maxPerTurn caps how many times THIS grant can pay an
  // action in a single turn. Default 1 (matches RAW for most grants like
  // Acceleration: "a single additional action during each of their turns").
  // `usesThisTurn` is a state flag stamped on the AE by consumeReservation;
  // it pairs a turnSerial with a count so we don't need to reset it at turn
  // start — when turnSerial changes, the old count is implicitly stale.
  function getCurrentTurnSerial() {
    const emitter = globalThis.FUCompanion?.api?.fabulaInitiativeTurnEmitter;
    const ts = emitter?.getTurnState?.();
    const n = Number(ts?.turnSerial);
    return Number.isFinite(n) ? n : null;
  }

  function usesUsedThisTurn(effect, currentSerial) {
    if (currentSerial == null) return 0;
    let stamp = null;
    try { stamp = effect.getFlag?.(MODULE_ID, "usesThisTurn") ?? null; } catch (_) {}
    if (!stamp || stamp.turnSerial !== currentSerial) return 0;
    return Number(stamp.count) || 0;
  }

  function hasPerTurnCapacity(effect, spec, currentSerial) {
    const max = Number(spec?.maxPerTurn ?? 1);
    if (!Number.isFinite(max) || max <= 0) return true; // 0/invalid → uncapped
    const used = usesUsedThisTurn(effect, currentSerial);
    return used < max;
  }

  /**
   * @param {Actor} actor
   * @param {{condition?: string, skillType?: string}} opts
   * @returns {Array<{effect, effectUuid, charges, max, spec}>}
   */
  function findApplicable(actor, { condition = "in_turn", skillType = null } = {}) {
    const charges = globalThis.FUCompanion?.api?.charges;
    if (!charges) {
      warn("Charges API not loaded — bonus-actions facade is inert.");
      return [];
    }
    if (!actor) return [];

    const candidates = charges.findOnActor(actor, { key: CHARGE_KEY }) ?? [];
    const currentSerial = getCurrentTurnSerial();
    const out = [];
    for (const entry of candidates) {
      const eff = entry?.effect ?? null;
      if (!eff) continue;
      if (eff.disabled || eff.isSuppressed) continue;

      // Reaction-offered grants (AE carries `reactionConfig`) are not
      // in-turn grants — they appear in the reaction picker at turn_end
      // and consume their charge through the free_action reservation in
      // ActionDataFetch. Excluding them here means:
      //   • the Octopath budget label won't list them as a usable slot
      //   • the gate in ActionDataFetch won't auto-reserve them
      //   • the auto-end-of-activation check in action-execution-core
      //     correctly treats the actor as "out of actions" once the
      //     base slot is spent, so end_of_turn fires and the reaction
      //     picker can offer Acceleration.
      if (eff.flags?.["fabula-ultima-companion"]?.reactionConfig) continue;

      const spec = getGrantSpec(eff);
      if (!spec) continue;
      if (spec.condition && spec.condition !== condition) continue;
      if (!isApplicableType(spec, skillType)) continue;
      // Per-turn cap (Phase 2a follow-up): RAW Acceleration says "a single
      // additional action during each of their turns" — once consumed this
      // turn it can't pay again until the next turn even though charges>0.
      if (!hasPerTurnCapacity(eff, spec, currentSerial)) continue;

      const read = charges.read(eff);
      if (!read || (read.charges ?? 0) <= 0) continue;

      out.push({
        effect: eff,
        effectUuid: eff.uuid,
        charges: read.charges,
        max: read.max,
        spec
      });
    }

    // Earliest-applied first (stable ordering via effect creation time when
    // available; falls back to UUID compare for deterministic results).
    out.sort((a, b) => {
      const ta = Number(a.effect?._stats?.createdTime ?? 0);
      const tb = Number(b.effect?._stats?.createdTime ?? 0);
      if (ta !== tb) return ta - tb;
      return String(a.effectUuid).localeCompare(String(b.effectUuid));
    });

    return out;
  }

  function reserve(grant) {
    if (!grant?.effectUuid) return null;
    return {
      kind: "grant",
      effectUuid: grant.effectUuid,
      sourceLabel: grant.spec?.sourceLabel ?? null,
      reservedAt: Date.now()
    };
  }

  async function consumeReservation(reservation) {
    if (!reservation || reservation.kind !== "grant") return false;
    const charges = globalThis.FUCompanion?.api?.charges;
    if (!charges) {
      warn("Charges API not loaded — cannot consume reservation.");
      return false;
    }

    let eff = null;
    try { eff = await fromUuid(reservation.effectUuid); } catch (_) {}
    if (!eff) {
      warn("Reservation effect no longer exists (already removed?).", reservation);
      return false;
    }

    try {
      // Stamp the per-turn-uses counter BEFORE consume — if consume drains
      // the AE to 0, deleteWhenEmpty will remove it and the stamp goes with
      // it (which is correct: the grant no longer exists, no need to track).
      // If consume leaves the AE alive, the stamp persists for the cap check
      // in findApplicable until the turn changes.
      const currentSerial = getCurrentTurnSerial();
      if (currentSerial != null) {
        try {
          const prev = eff.getFlag(MODULE_ID, "usesThisTurn") ?? null;
          const count = (prev?.turnSerial === currentSerial)
            ? (Number(prev.count) || 0) + 1
            : 1;
          await eff.setFlag(MODULE_ID, "usesThisTurn", { turnSerial: currentSerial, count });
        } catch (stampErr) {
          warn("Failed to stamp usesThisTurn (non-fatal).", { error: String(stampErr?.message ?? stampErr) });
        }
      }

      await charges.consume(eff, { count: 1, deleteWhenEmpty: true });
      log("Consumed grant charge.", {
        effectUuid: reservation.effectUuid,
        sourceLabel: reservation.sourceLabel,
        turnSerial: currentSerial
      });
      return true;
    } catch (e) {
      warn("charges.consume failed.", { error: String(e?.message ?? e), reservation });
      return false;
    }
  }

  // ── Scene cleanup ────────────────────────────────────────────
  // On combat end, remove scene-duration bonus-action grants that still
  // have charges left. Drained grants self-deleted via the Charges API.
  async function cleanupSceneDurationGrants(combat) {
    if (!game.user?.isGM) return;
    if (!combat) return;

    const charges = globalThis.FUCompanion?.api?.charges;
    if (!charges) return;

    const actorsSeen = new Set();
    const actors = [];
    for (const co of combat.combatants ?? []) {
      const a = co?.actor ?? (co?.actorId ? game.actors?.get(co.actorId) : null);
      if (!a?.uuid || actorsSeen.has(a.uuid)) continue;
      actorsSeen.add(a.uuid);
      actors.push(a);
    }

    let removed = 0;
    for (const actor of actors) {
      const grants = charges.findOnActor(actor, { key: CHARGE_KEY, includeDisabled: true }) ?? [];
      const toRemove = [];
      for (const entry of grants) {
        const eff = entry?.effect ?? null;
        if (!eff) continue;
        const spec = getGrantSpec(eff);
        if (spec?.expiry === "scene" || spec?.expiry === "combat-end") {
          toRemove.push(eff.id);
        }
      }
      if (!toRemove.length) continue;
      try {
        await actor.deleteEmbeddedDocuments("ActiveEffect", toRemove);
        removed += toRemove.length;
      } catch (e) {
        warn("Failed to remove scene-duration grants.", {
          actor: actor.name,
          error: String(e?.message ?? e)
        });
      }
    }

    if (removed > 0) {
      log("Removed scene-duration grants on combat end.", {
        combatId: combat.id,
        removed
      });
    }
  }

  Hooks.on("deleteCombat", cleanupSceneDurationGrants);
  Hooks.on("combatEnd", cleanupSceneDurationGrants);

  // ── Expose API at script-load time ────────────────────────
  // Don't gate on Hooks.once("ready") — it won't fire if this script
  // is injected after ready (e.g., via test-bridge during dev). The API
  // is pure-functional + reads game.* only when called, so it's safe to
  // register immediately.
  const root = (globalThis.FUCompanion = globalThis.FUCompanion ?? {});
  root.api = root.api ?? {};
  root.api.bonusActions = {
    findApplicable,
    reserve,
    consumeReservation,
    cleanupSceneDurationGrants
  };
  log("API registered at FUCompanion.api.bonusActions");
})();
