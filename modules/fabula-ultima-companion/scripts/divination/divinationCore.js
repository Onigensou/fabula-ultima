/**
 * Divination Core — shared helpers for the Divination charged-AE feature.
 *
 * Used by:
 *   - scripts/check-roller/checkRoller-divinationButtons.js   (Open Checks)
 *   - scripts/divination/actionCard-divinationButtons.js      (Strike + Magic Action cards)
 *
 * Both consumers gate the button on the same rules:
 *   - The viewer owns an actor carrying a charged AE keyed `divination`.
 *   - The current roll is NOT a Crit or Fumble (RAW: those are locked outcomes).
 *
 * Exposes `globalThis.ONI.Divination`. Must load BEFORE either button file.
 */
(() => {
  const TAG = "[ONI][Divination:Core]";
  const MODULE_ID  = "fabula-ultima-companion";
  const CHARGE_KEY = "divination";

  if (globalThis.ONI?.Divination) {
    console.debug(`${TAG} Already installed.`);
    return;
  }

  // ---------------------------------------------------------------------------
  // Tiny helpers
  // ---------------------------------------------------------------------------
  const safeInt = (v, fb = 0) => {
    const n = typeof v === "number"
      ? v
      : parseInt(String(v ?? "").replace(/[^\d-]/g, ""), 10);
    return Number.isFinite(n) ? n : fb;
  };

  function chargesApi() {
    return globalThis?.FUCompanion?.api?.charges ?? null;
  }

  // ---------------------------------------------------------------------------
  // Caster lookup / charge consumption
  // ---------------------------------------------------------------------------
  function findOwnedCaster() {
    const api = chargesApi();
    if (!api) {
      console.warn(`${TAG} FUCompanion.api.charges unavailable; Divination disabled.`);
      return null;
    }
    return api.findFirstOwned({ key: CHARGE_KEY });
  }

  async function consumeOneCharge(effect) {
    const api = chargesApi();
    if (!api) return { ok: false, error: "charges_api_unavailable" };
    return await api.consume(effect, { count: 1, deleteWhenEmpty: true });
  }

  // ---------------------------------------------------------------------------
  // Crit / Fumble computation
  // ---------------------------------------------------------------------------
  // Open-Check rule. Preserves the simple rule that has been used by
  // checkRoller-divinationButtons since inception. NOT the full FU accuracy
  // rule — Open Checks here use "matched dice ≥ 6 = crit, double-1 = fumble".
  function computeOpenCheckResult(rA, rB) {
    const isFumble = (rA === 1 && rB === 1);
    const isCrit   = (!isFumble && rA === rB && rA >= 6);
    return { isCrit, isFumble };
  }

  // Full FU Accuracy-Check rule. Mirrors rollAccuracy() in
  // ActionDataComputation.js so a Divination reroll on an Action card matches
  // what a fresh accuracy roll would produce.
  function computeAccuracyResult(rA, rB, attackerActor, { checkBonus = 0 } = {}) {
    const props = attackerActor?.system?.props ?? {};
    const critRange = Number(props.critical_dice_range  ?? 0);
    const minCrit   = Number(props.minimum_critical_dice ?? 999);
    const fumbleTH  = Number(props.fumble_threshold      ?? -1);

    const total = rA + rB + Number(checkBonus || 0);
    const hr    = Math.max(rA, rB);
    const diff  = Math.abs(rA - rB);

    const rawIsCrit   = (diff <= critRange) && (rA >= minCrit || rB >= minCrit);
    const rawIsFumble = (fumbleTH >= 0)
      ? (rA <= fumbleTH && rB <= fumbleTH)
      : (rA === 1 && rB === 1);

    const isFumble = !!rawIsFumble;
    const isCrit   = !!rawIsCrit && !isFumble;
    const isBunny  = isCrit && (rA !== rB);

    return { total, hr, isCrit, isBunny, isFumble };
  }

  function isLockedByCritOrFumble({ isCrit, isFumble } = {}) {
    return !!(isCrit || isFumble);
  }

  // ---------------------------------------------------------------------------
  // Outcome-flip detection
  // ---------------------------------------------------------------------------
  // The reaction trigger `creature_check_outcome_flipped` should only fire
  // when the reroll actually changes pass↔fail. Per the FU spec for Hina's
  // Foresight Zero Trigger, no outcome change → no Zero Power.
  //
  // Conservative semantic: when the outcome can't be determined (e.g. an Open
  // Check rolled without a Difficulty Level), we DO NOT emit. Per design
  // decision: GM grants the Zero Power manually in that case.

  // Open-Check outcome: "success" | "failure" | "unknown".
  // Crit/Fumble are intrinsic outcomes regardless of total vs DL.
  function outcomeOpenCheck(result, dl) {
    if (result?.isCrit) return "success";
    if (result?.isFumble) return "failure";
    const n = Number(dl);
    if (!Number.isFinite(n)) return "unknown";
    return Number(result?.total) >= n ? "success" : "failure";
  }

  function outcomeFlippedOpenCheck(before, after, dl) {
    const a = outcomeOpenCheck(before, dl);
    const b = outcomeOpenCheck(after, dl);
    if (a === "unknown" || b === "unknown") return false;
    return a !== b;
  }

  // Per-target hit determination, mirroring action-execution-core.js
  // (isCrit → true, isFumble → false, else total >= defense). Returns null
  // if either side isn't finite (treated as no-flip downstream).
  function accuracyHitVsDefense({ total, isCrit, isFumble } = {}, defense) {
    if (isCrit) return true;
    if (isFumble) return false;
    const def = Number(defense);
    const t   = Number(total);
    if (!Number.isFinite(def) || !Number.isFinite(t)) return null;
    return t >= def;
  }

  // Outcome flipped on an Action card if ANY target's hit/miss changed
  // (per user spec: "1 ZP per action, if at least 1 outcome is flipped").
  // With no targets, only an isCrit/isFumble flip can change outcome.
  function outcomeFlippedAccuracy(before, after, defenses) {
    if (!Array.isArray(defenses) || defenses.length === 0) {
      return (!!before?.isCrit   !== !!after?.isCrit)
          || (!!before?.isFumble !== !!after?.isFumble);
    }
    for (const def of defenses) {
      const hb = accuracyHitVsDefense(before, def);
      const ha = accuracyHitVsDefense(after,  def);
      if (hb === null || ha === null) continue;
      if (hb !== ha) return true;
    }
    return false;
  }

  // Mirrors readDefenseLike() in action-execution-core.js so an Accuracy-flip
  // check uses the same defense numbers as the runtime hit calculation.
  function readActorDefense(actor, useMagic = false) {
    const props = actor?.system?.props ?? actor?.system ?? {};
    const numberish = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    const hardKeys = useMagic
      ? ["magic_defense", "current_mdef", "mdef"]
      : ["defense", "current_def", "def"];
    for (const k of hardKeys) {
      const n = numberish(props[k]);
      if (n !== null) return n;
    }

    const isBanned = (k) => /(^|_)mod($|_)/i.test(k);
    const rePhys = /(^|_)(current_)?(def|guard|armor)($|_)/i;
    const reMag  = /(^|_)(current_)?(m(def|agic.*def)|magic.*resist|spirit)($|_)/i;
    const rx = useMagic ? reMag : rePhys;

    for (const k of Object.keys(props)) {
      if (isBanned(k)) continue;
      const n = numberish(props[k]);
      if (n === null) continue;
      if (rx.test(k)) return n;
    }
    return 0;
  }

  // Resolve target uuids → defense numbers for the appropriate accuracy type.
  async function readTargetDefenses(targetUuids, useMagic) {
    const out = [];
    for (const uuid of (Array.isArray(targetUuids) ? targetUuids : [])) {
      try {
        const doc = await fromUuid(uuid);
        const actor = doc?.actor ?? (doc?.documentName === "Actor" ? doc : null);
        out.push(actor ? readActorDefense(actor, useMagic) : 0);
      } catch (_) { out.push(0); }
    }
    return out;
  }

  // Mirror fuResolveDefenseTarget() in CreateActionCard.js so we pick the same
  // defense (DEF vs Magic DEF) the runtime would use for hit calculation.
  function isAccuracyAgainstMagic(payload) {
    const meta = payload?.meta ?? {};
    const raw = String(
      meta.targetDefenseType ??
      meta.accuracyAgainst   ??
      meta.defenseKind       ??
      meta.defenseType       ??
      ""
    ).trim().toLowerCase();

    const STRIKE = ["def","defense","strike","phys","physical","guard","armor"];
    const MAGIC  = ["mdef","magic_defense","magicdefense","magic","mdf","res","resistance","spirit"];
    if (STRIKE.includes(raw)) return false;
    if (MAGIC.includes(raw))  return true;
    return !!meta.isSpellish;
  }

  // ---------------------------------------------------------------------------
  // Reaction emit (lifted verbatim from checkRoller-divinationButtons.js so
  // both flows fire the same `creature_check_outcome_flipped` trigger)
  // ---------------------------------------------------------------------------
  function emitOutcomeFlipped({ actor, before, after, mechanism = "divination" } = {}) {
    if (!actor) return;
    const tokens = (typeof actor.getActiveTokens === "function")
      ? actor.getActiveTokens(true, true)
      : [];
    const token = Array.isArray(tokens) && tokens[0] ? tokens[0] : null;
    const tokenUuid = token?.document?.uuid ?? null;

    const reactionPayload = {
      kind: "check_adjusted",
      trigger: "creature_check_adjusted",
      timestamp: Date.now(),

      actorUuid: actor.uuid ?? null,
      tokenUuid,
      sourceUuid: tokenUuid,
      sourceActorUuid: actor.uuid ?? null,
      subjectTokenUuid: tokenUuid,
      subjectActorUuid: actor.uuid ?? null,

      // Causer = the actor who performed the reroll/invoke. Here it equals the
      // subject (a self-flip); the bridge dispatches causer-side too so
      // CHECK_ADJUSTED_BY_ME matches on the reroller regardless.
      causerActorUuid: actor.uuid ?? null,
      causerTokenUuid: tokenUuid,
      mechanism,
      flipMechanism: mechanism,
      // These open-check emitters fire ONLY on a confirmed pass↔fail flip.
      resultChanged: true,
      before: { ...(before ?? {}) },
      after:  { ...(after  ?? {}) },

      requestedByUserId:   game.user?.id   ?? null,
      requestedByUserName: game.user?.name ?? null
    };

    const channel = `module.${MODULE_ID}`;

    if (game.user?.isGM) {
      if (globalThis.ONI?.emit) {
        ONI.emit("oni:reactionPhase", reactionPayload, { local: true, world: false });
      }
    } else {
      if (game.socket) {
        game.socket.emit(channel, {
          type: "OniReactionPhaseRequest",
          payload: reactionPayload
        });
      }
      if (globalThis.ONI?.emit) {
        ONI.emit("oni:reactionPhase", reactionPayload, { local: true, world: false });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Snapshot helpers (used to build before/after pairs for the reaction emit)
  // ---------------------------------------------------------------------------
  function snapshotCheckResult(res) {
    return {
      rollA: safeInt(res?.rollA, 0),
      rollB: safeInt(res?.rollB, 0),
      total: safeInt(res?.total, 0),
      hr:    safeInt(res?.hr, 0),
      isCrit:   !!res?.isCrit,
      isFumble: !!res?.isFumble,
      pass: (res?.pass === true || res?.pass === false) ? res.pass : null
    };
  }

  function snapshotAccuracy(acc) {
    return {
      rollA: safeInt(acc?.rA?.total, 0),
      rollB: safeInt(acc?.rB?.total, 0),
      total: safeInt(acc?.total, 0),
      hr:    safeInt(acc?.hr, 0),
      isCrit:   !!acc?.isCrit,
      isFumble: !!acc?.isFumble
    };
  }

  // ---------------------------------------------------------------------------
  // Expose
  // ---------------------------------------------------------------------------
  globalThis.ONI = globalThis.ONI || {};
  globalThis.ONI.Divination = Object.freeze({
    MODULE_ID,
    CHARGE_KEY,
    findOwnedCaster,
    consumeOneCharge,
    computeOpenCheckResult,
    computeAccuracyResult,
    isLockedByCritOrFumble,
    emitOutcomeFlipped,
    snapshotCheckResult,
    snapshotAccuracy,
    // Outcome-flip detection
    outcomeOpenCheck,
    outcomeFlippedOpenCheck,
    accuracyHitVsDefense,
    outcomeFlippedAccuracy,
    readActorDefense,
    readTargetDefenses,
    isAccuracyAgainstMagic
  });

  console.debug(`${TAG} Installed at ONI.Divination.`);
})();
