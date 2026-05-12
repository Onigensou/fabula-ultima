/**
 * [ONI] Test Harness — dry-run the action pipeline for a skill.
 * ---------------------------------------------------------------------------
 * Exposes FUCompanion.api.test.runActionDryRun() — runs the same pipeline a
 * player would trigger by clicking a skill button (ADF → ADC → execute), but
 * skips every world-mutating call: no MP/IP spent, no items consumed, no AEs
 * applied, no damage rolled into target HP, no chat cards, no animations, no
 * reaction emits.
 *
 * Instead, returns a structured "what would happen" report under
 * `result.dryRunReport`. See modules/fabula-ultima-companion/docs/
 * action-payload-shape.md for field meanings; the dryRunReport mirrors the
 * fields the live pipeline would have written.
 *
 * Usage:
 *   await FUCompanion.api.test.runActionDryRun({
 *     skillUuid: "Actor.xxx.Item.yyy",
 *     attackerUuid: "Scene.aaa.Token.bbb", // optional, defaults to controlled token
 *     targets: ["Scene.aaa.Token.ccc"]     // optional, defaults to user targets
 *   });
 *
 * Returned shape (success):
 *   {
 *     ok: true,
 *     dryRun: true,
 *     executionMode: "manualCard",
 *     executionCoreResult: {        // the raw execute() summary
 *       ok, hitUUIDs, missUUIDs, savedTargetUUIDs, treatAutoHit, isHealing,
 *       spentCosts, dryRun, dryRunReport
 *     },
 *     dryRunReport: {               // surfaced for convenience
 *       runId, executionMode, skipped: [...],
 *       resourceSpendPlan, itemConsumePlan,
 *       customLogicResolutionWouldRun, passiveLogicResolutionWouldRun,
 *       aeWouldApply: [{ trigger, directives, targetUUIDs, ... }],
 *       missPlan, damagePlan, animationPlan,
 *       reactionEmitsPlan: [...]
 *     }
 *   }
 *
 * Limitations (V1):
 *   - Skill branch only (no Weapon attacks, no Item-fastpath consume).
 *   - Resolution-phase author scripts (CustomLogic-Resolution,
 *     PassiveLogic-Resolution) are skipped. If a skill author relies on those
 *     to mutate the payload, the dry-run won't reflect their tweaks.
 *   - Accuracy is rolled fresh each call; no seeding API yet.
 *   - GM only.
 */
(() => {
  const TAG = "[FUCompanion][TestHarness]";
  const API_ROOT = (globalThis.FUCompanion = globalThis.FUCompanion || {});
  API_ROOT.api = API_ROOT.api || {};

  async function runActionDryRun({
    skillUuid,
    attackerUuid = null,
    targets = null
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

    console.info(`${TAG} START`, {
      skillUuid,
      attackerUuid,
      targetsCount: targets.length
    });

    // Stamp __dryRun in meta. ADF preserves meta via buildForwardMeta, so the
    // flag rides through to ADC, where isDryRunExecution picks it up and jumps
    // straight to executeDryRun() — Targeting / ResourceGate / CreateActionCard
    // all bypassed.
    const result = await adf.execute({
      __AUTO: true,
      __PAYLOAD: {
        skillUuid,
        attackerUuid,
        targets: [...targets],
        originalTargetUUIDs: [...targets],
        meta: {
          __dryRun: true,
          attackerUuid,
          originalTargetUUIDs: [...targets]
        }
      }
    });

    console.info(`${TAG} RESULT`, result);
    return result;
  }

  API_ROOT.api.test = {
    ...(API_ROOT.api.test || {}),
    runActionDryRun
  };

  console.info(`${TAG} API registered at FUCompanion.api.test.runActionDryRun`);
})();
