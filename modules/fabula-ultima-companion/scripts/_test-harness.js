/**
 * [ONI] Test Harness — dry-run + post-hoc diff for the action pipeline.
 * ---------------------------------------------------------------------------
 * FUCompanion.api.test exposes two helpers:
 *
 *   runActionDryRun({ skillUuid, attackerUuid?, targets?, force? })
 *     Runs the same pipeline a player would trigger by clicking a skill button
 *     (ADF → ADC → execute), but skips every world-mutating call: no MP/IP
 *     spent, no items consumed, no AEs applied, no damage rolled into target
 *     HP, no chat cards, no animations, no reaction emits. Returns a
 *     structured "what would happen" report under `result.dryRunReport`.
 *
 *     What dry-run NOW models (used to skip):
 *       - CustomLogic-Action runs (mutates cardPayload like real flow).
 *       - PassiveLogic-Action runs (passive modifiers on payload).
 *       - BEFORE_ATTACK AE directives are recorded (not applied).
 *       - ResourceGate affordability — would the actor actually pay?
 *       - Per-target snapshot (HP/MP/statuses/AEs) at dry-run time.
 *       - Roll overrides via `force` — see below.
 *       - Pre-flight payload snapshot for diffLastAction comparison.
 *
 *     What dry-run still DOES NOT model:
 *       - Resolution-phase scripts (CustomLogic-Resolution,
 *         PassiveLogic-Resolution). They're skipped because they can mutate
 *         actor docs and we can't safely trap that.
 *       - Reaction *cascade* — emits are recorded as a plan, not actually
 *         emitted, so chained reactions don't fire.
 *       - The Targeting macro — uses seed targets verbatim.
 *       - AE effect on subsequent steps — if an AE would change resistances
 *         mid-action, the damage step still uses the pre-AE snapshot.
 *
 *   diffLastAction({ dryRunReport, attackerUuid?, skillUuid?, lookback? })
 *     Walks recent chat messages, finds the most recent action card whose
 *     cardPayload was built for the same skill/attacker, and compares the
 *     dry-run's pre-flight snapshot against it. Surfaces the fields that
 *     diverged — the typical reason for "Claude said X but UI did Y."
 *
 * Usage:
 *   const dry = await FUCompanion.api.test.runActionDryRun({
 *     skillUuid: "Actor.xxx.Item.yyy",
 *     attackerUuid: "Scene.aaa.Token.bbb",   // optional, defaults to controlled token
 *     targets: ["Scene.aaa.Token.ccc"],      // optional, defaults to user targets
 *     force: {                                // optional roll overrides
 *       forceCrit: true,                      //   one of forceCrit/forceFumble
 *       forceHit: true,                       //   one of forceHit/forceMiss
 *       forceAccTotal: 18                     //   override accuracy total
 *     }
 *   });
 *
 *   // Later, after the real action runs in the UI:
 *   const diff = await FUCompanion.api.test.diffLastAction({
 *     dryRunReport: dry.dryRunReport,
 *     skillUuid: "Actor.xxx.Item.yyy",
 *     attackerUuid: "Scene.aaa.Token.bbb"
 *   });
 *   // diff.fields = [{ field, dryRun, real }, ...]
 *
 * GM only.
 */
(() => {
  const TAG = "[FUCompanion][TestHarness]";
  const MODULE_NS = "fabula-ultima-companion";
  const API_ROOT = (globalThis.FUCompanion = globalThis.FUCompanion || {});
  API_ROOT.api = API_ROOT.api || {};

  async function runActionDryRun({
    skillUuid,
    attackerUuid = null,
    targets = null,
    force = null
  } = {}) {
    if (!game.user?.isGM) {
      ui.notifications?.warn(`${TAG} GM only.`);
      return { ok: false, reason: "gm_only" };
    }

    if (!skillUuid) {
      ui.notifications?.warn(`${TAG} skillUuid is required.`);
      return { ok: false, reason: "missing_skill_uuid" };
    }

    if (!attackerUuid) {
      const tok = canvas.tokens?.controlled?.[0] ?? null;
      attackerUuid = tok?.document?.uuid ?? tok?.actor?.uuid ?? null;
    }
    if (!attackerUuid) {
      ui.notifications?.warn(`${TAG} attackerUuid required (or select a token).`);
      return { ok: false, reason: "missing_attacker_uuid" };
    }

    if (!Array.isArray(targets) || !targets.length) {
      targets = Array.from(game.user?.targets ?? [])
        .map(t => t?.document?.uuid)
        .filter(Boolean);
    }
    if (!targets.length) {
      ui.notifications?.warn(`${TAG} No targets provided or selected.`);
      return { ok: false, reason: "no_targets" };
    }

    const adf = game.macros.getName("ActionDataFetch");
    if (!adf) {
      ui.notifications?.error(`${TAG} ActionDataFetch macro not found.`);
      return { ok: false, reason: "adf_macro_missing" };
    }

    const normalizedForce = normalizeForceOptions(force);

    console.info(`${TAG} START`, {
      skillUuid,
      attackerUuid,
      targetsCount: targets.length,
      force: normalizedForce
    });

    // Stamp __dryRun in meta. ADF preserves meta via buildForwardMeta, so the
    // flag rides through to ADC, where isDryRunExecution picks it up and jumps
    // to executeDryRun() — Targeting / ResourceGate / CreateActionCard skipped,
    // CustomLogic-Action + PassiveLogic-Action still run so the report mirrors
    // real-play payload state.
    const result = await adf.execute({
      __AUTO: true,
      __PAYLOAD: {
        skillUuid,
        attackerUuid,
        targets: [...targets],
        originalTargetUUIDs: [...targets],
        meta: {
          __dryRun: true,
          __dryRunForce: normalizedForce,
          attackerUuid,
          originalTargetUUIDs: [...targets]
        }
      }
    });

    console.info(`${TAG} RESULT`, result);
    return result;
  }

  function normalizeForceOptions(force) {
    if (!force || typeof force !== "object") return null;
    const out = {};
    if (force.forceHit    === true) out.forceHit    = true;
    if (force.forceMiss   === true) out.forceMiss   = true;
    if (force.forceCrit   === true) out.forceCrit   = true;
    if (force.forceFumble === true) out.forceFumble = true;
    if (Number.isFinite(Number(force.forceAccTotal))) {
      out.forceAccTotal = Number(force.forceAccTotal);
    }
    return Object.keys(out).length ? out : null;
  }

  // ---------------------------------------------------------------------
  // diffLastAction — compare a dry-run report against the most recent real
  // action card. The dryRunReport's payloadAfterPreflight is the canonical
  // "what the dry-run expected to feed execute()"; the real card flag's
  // cardPayload is "what the live pipeline actually built." Any divergence is
  // the gap to investigate.
  // ---------------------------------------------------------------------
  async function diffLastAction({
    dryRunReport = null,
    attackerUuid = null,
    skillUuid    = null,
    lookback     = 25,
    messageId    = null
  } = {}) {
    if (!game.user?.isGM) {
      ui.notifications?.warn(`${TAG} GM only.`);
      return { ok: false, reason: "gm_only" };
    }
    if (!dryRunReport || typeof dryRunReport !== "object") {
      return { ok: false, reason: "missing_dry_run_report" };
    }
    if (!dryRunReport.payloadAfterPreflight) {
      return {
        ok: false,
        reason: "no_payload_snapshot",
        hint: "dryRunReport.payloadAfterPreflight is missing — re-run after reloading the world so the latest test-harness/ADC is loaded."
      };
    }

    const match = findLastActionCard({ messageId, attackerUuid, skillUuid, lookback });
    if (!match.ok) return match;

    const real = match.cardPayload;
    const dry  = dryRunReport.payloadAfterPreflight;
    const fields = [];

    // Identity guard — flag mismatches if we found a different skill.
    const realSkillUuid = real?.meta?.skillUuid ?? real?.skillUuid ?? null;
    if (skillUuid && realSkillUuid && realSkillUuid !== skillUuid) {
      fields.push({ field: "meta.skillUuid", dryRun: skillUuid, real: realSkillUuid, note: "MATCHED CARD IS FOR A DIFFERENT SKILL" });
    }

    pushNumDiff(fields, "accuracy.total",    dry?.accuracy?.total,    real?.accuracy?.total);
    pushBoolDiff(fields, "accuracy.isCrit",   dry?.accuracy?.isCrit,   real?.accuracy?.isCrit);
    pushBoolDiff(fields, "accuracy.isFumble", dry?.accuracy?.isFumble, real?.accuracy?.isFumble);
    pushScalarDiff(fields, "accuracy.hr",     dry?.accuracy?.hr,       real?.accuracy?.hr);

    pushNumDiff(fields, "advPayload.damageBase", dry?.advPayload?.damageBase, real?.advPayload?.damageBase);
    pushNumDiff(fields, "advPayload.damageHR",   dry?.advPayload?.damageHR,   real?.advPayload?.damageHR);
    pushBoolDiff(fields, "advPayload.autoHit",   dry?.advPayload?.autoHit,    real?.advPayload?.autoHit);
    pushBoolDiff(fields, "advPayload.forceMiss", dry?.advPayload?.forceMiss,  real?.advPayload?.forceMiss);
    pushBoolDiff(fields, "advPayload.isCrit",    dry?.advPayload?.isCrit,     real?.advPayload?.isCrit);
    pushBoolDiff(fields, "advPayload.isFumble",  dry?.advPayload?.isFumble,   real?.advPayload?.isFumble);

    pushScalarDiff(fields, "meta.elementType", dry?.meta?.elementType, real?.meta?.elementType);
    pushBoolDiff(fields,   "meta.isSpellish",  dry?.meta?.isSpellish,  real?.meta?.isSpellish);
    pushBoolDiff(fields,   "meta.forceMiss",   dry?.meta?.forceMiss,   real?.meta?.forceMiss);

    pushArrayDiff(fields, "targets",             dry?.targets,             real?.targets);
    pushArrayDiff(fields, "originalTargetUUIDs", dry?.originalTargetUUIDs, real?.originalTargetUUIDs);

    pushCostsDiff(fields, dry?.meta?.costsNormalized, real?.meta?.costsNormalized);
    pushAeDirectivesDiff(fields, dry?.meta?.activeEffects, real?.meta?.activeEffects);

    const summary = {
      ok: true,
      messageId: match.messageId,
      messageCreated: match.messageCreated,
      realSkillUuid,
      diverged: fields.length > 0,
      fields,
      hint: fields.length
        ? "Fields above differ between dry-run and real play — investigate the first divergent field; downstream ones are usually cascading consequences."
        : "Pre-flight payload matched. If outcomes still differ, the gap is in resolution-phase scripts, reaction cascade, or post-execute() randomness."
    };

    console.info(`${TAG} diffLastAction`, summary);
    return summary;
  }

  function findLastActionCard({ messageId, attackerUuid, skillUuid, lookback }) {
    if (messageId) {
      const msg = game.messages?.get(messageId);
      if (!msg) return { ok: false, reason: "message_not_found" };
      const flag = msg.flags?.[MODULE_NS]?.actionCard ?? null;
      if (!flag?.payload) return { ok: false, reason: "message_has_no_action_card_flag" };
      return {
        ok: true,
        messageId: msg.id,
        messageCreated: msg.timestamp ?? null,
        cardPayload: flag.payload
      };
    }

    const all = Array.from(game.messages?.contents ?? []);
    const recent = all.slice(-Math.max(1, lookback)).reverse();
    for (const msg of recent) {
      const flag = msg?.flags?.[MODULE_NS]?.actionCard ?? null;
      const cp = flag?.payload;
      if (!cp) continue;

      if (attackerUuid) {
        const cardAttacker = cp?.meta?.attackerUuid ?? cp?.attackerUuid ?? null;
        if (cardAttacker && cardAttacker !== attackerUuid) continue;
      }
      if (skillUuid) {
        const cardSkill = cp?.meta?.skillUuid ?? cp?.skillUuid ?? null;
        if (cardSkill && cardSkill !== skillUuid) continue;
      }

      return {
        ok: true,
        messageId: msg.id,
        messageCreated: msg.timestamp ?? null,
        cardPayload: cp
      };
    }

    return { ok: false, reason: "no_matching_action_card_in_recent_messages", lookback };
  }

  function pushNumDiff(out, field, dry, real) {
    const a = numOrNull(dry);
    const b = numOrNull(real);
    if (a === b) return;
    out.push({ field, dryRun: a, real: b });
  }

  function pushBoolDiff(out, field, dry, real) {
    const a = !!dry;
    const b = !!real;
    if (a === b) return;
    out.push({ field, dryRun: a, real: b });
  }

  function pushScalarDiff(out, field, dry, real) {
    const a = dry ?? null;
    const b = real ?? null;
    if (a === b) return;
    out.push({ field, dryRun: a, real: b });
  }

  function pushArrayDiff(out, field, dry, real) {
    const a = JSON.stringify((dry ?? []).slice().sort());
    const b = JSON.stringify((real ?? []).slice().sort());
    if (a === b) return;
    out.push({ field, dryRun: dry ?? [], real: real ?? [] });
  }

  function pushCostsDiff(out, dry, real) {
    const norm = (arr) => (arr ?? [])
      .map(c => `${c?.type ?? "?"}:${c?.req ?? 0}`)
      .sort()
      .join(",");
    const a = norm(dry);
    const b = norm(real);
    if (a === b) return;
    out.push({ field: "meta.costsNormalized", dryRun: dry ?? [], real: real ?? [] });
  }

  function pushAeDirectivesDiff(out, dry, real) {
    const norm = (arr) => (arr ?? [])
      .map(d => `${d?.trigger ?? "?"}/${d?.statusKey ?? d?.status ?? "?"}/${d?.effect_kind ?? d?.effectKind ?? "?"}`)
      .sort()
      .join("|");
    const a = norm(dry);
    const b = norm(real);
    if (a === b) return;
    out.push({ field: "meta.activeEffects (directives)", dryRun: dry ?? [], real: real ?? [] });
  }

  function numOrNull(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : (v ?? null);
  }

  API_ROOT.api.test = {
    ...(API_ROOT.api.test || {}),
    runActionDryRun,
    diffLastAction
  };

  console.info(`${TAG} API registered at FUCompanion.api.test.{runActionDryRun, diffLastAction}`);
})();
