// Battle End Orchestrator — entry point for the BATTLE_ENDING FSM state.
//
// Detects victory/defeat from DirectorCombat, runs the GM-confirmation
// prompt (auto-filled from state), then drives the cinematic pipeline:
//   Prompt → FX → SummaryLogic → RankComputation → SummaryUI → Transition
//   → ResourceReset (fire-and-forget)
//
// Dev mode (payload.options.devMode or payload.context.lean) skips the
// entire pipeline — boot.stop() already handles bare cleanup.

import { log, warn } from "../logger.js";
import { showBattleEndPrompt } from "./battle-end-prompt.js";
import { runBattleEndFx } from "./battle-end-fx.js";
import { runBattleEndSummaryLogic } from "./battle-end-summary-logic.js";
import { runBattleEndRank } from "./battle-end-rank.js";
import { runBattleEndSummaryUI } from "./battle-end-summary-ui.js";
import { runBattleEndTransition } from "./battle-end-transition.js";
import { runBattleEndResourceReset } from "./battle-end-cleanup.js";

function detectOutcome(director) {
  const dc = director.dCombat;
  if (!dc) return "victory";
  const combatants = dc.combatants ?? [];
  const enemies = combatants.filter(c => c.side === "enemy");
  const party  = combatants.filter(c => c.side === "party");
  if (
    party.length > 0 && party.every(c => c.isDefeatedLive?.()) &&
    !(enemies.length > 0 && enemies.every(c => c.isDefeatedLive?.()))
  ) {
    return "defeat";
  }
  return "victory";
}

export async function runBattleEndSequence(director) {
  const dc = director.dCombat;
  const payload = director.ctx.payload;

  const endCtx = {
    director,
    outcome:      detectOutcome(director),
    sourceSceneId: dc?.sourceSceneId ?? null,
    battleSceneId: dc?.scene?.id ?? canvas?.scene?.id ?? null,
    partyActorIds: (dc?.combatants ?? [])
      .filter(c => c.side === "party")
      .map(c => c.actorDoc?.id)
      .filter(Boolean),
    totalRounds: dc?.round ?? 0,
    isBoss: !!(payload?.battlePlan?.isBoss) ||
            String(payload?.battlePlan?.type ?? "").toLowerCase() === "boss",
    promptResult:   null,
    summaryResults: null,
    rank:           null,
  };

  // Read snapshots pre-computed at PREP time.
  const _bdSnap = (() => {
    try { return game.settings.get("fabula-ultima-companion", "bdRewardSnapshot") ?? {}; }
    catch { return {}; }
  })();
  endCtx.defaultRewards = {
    expByActorId:   _bdSnap.expByActorId   ?? {},
    zenitByActorId: _bdSnap.zenitByActorId ?? {},
  };
  endCtx.preBattleCamera = (() => {
    try { return game.settings.get("fabula-ultima-companion", "bdPreBattleViewport") ?? null; }
    catch { return null; }
  })();
  endCtx.battleSceneViewport = (() => {
    try { return game.settings.get("fabula-ultima-companion", "bdBattleSceneViewport") ?? null; }
    catch { return null; }
  })();

  log("[BattleEnd] Starting sequence", { outcome: endCtx.outcome, rounds: endCtx.totalRounds });

  const promptResult = await showBattleEndPrompt(endCtx);
  if (!promptResult.ok) {
    log("[BattleEnd] Prompt cancelled — skipping cinematic");
    return;
  }
  endCtx.promptResult = promptResult;
  endCtx.outcome = promptResult.outcome;

  await runBattleEndFx(endCtx);

  if (endCtx.outcome === "victory") {
    await runBattleEndSummaryLogic(endCtx);
    await runBattleEndRank(endCtx);
    await runBattleEndSummaryUI(endCtx); // awaited: transition only starts after GM's animation finishes
  }

  await runBattleEndTransition(endCtx);

  // Resource reset fires after scene transition; token teardown is boot.stop()'s job
  runBattleEndResourceReset(endCtx).catch(e => warn("[BattleEnd] ResourceReset threw", e));

  // Clear all snapshots.
  try { game.settings.set("fabula-ultima-companion", "bdRewardSnapshot",      null); } catch (_) {}
  try { game.settings.set("fabula-ultima-companion", "bdPreBattleViewport",   null); } catch (_) {}
  try { game.settings.set("fabula-ultima-companion", "bdBattleSceneViewport", null); } catch (_) {}

  log("[BattleEnd] Sequence complete");
}
