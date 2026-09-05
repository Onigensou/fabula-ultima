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
import { evaluateFollowups, mergeRewardSnapshots } from "./battle-followup.js";
import { evaluateUndying } from "./undying/undying.js";

function detectOutcome(director) {
  const dc = director.dCombat;
  if (!dc) return "victory";
  // An explicit outcome set by content wins over inference. Run Away stamps
  // "escaped" (via the `set_battle_outcome` effect) BEFORE its leave_combat
  // empties the party side — order that matters, because an empty party side
  // reaches the `party.length > 0` guard below and falls through to "victory",
  // handing a fleeing party the full reward prompt.
  //
  // In-memory by design: persistence.save returns early once dCombat.ended is
  // set, so there is no F5 window between dc.end() and the battle-end sequence
  // for a persisted marker to cover.
  const forced = String(dc.outcomeOverride ?? "").trim().toLowerCase();
  if (forced === "escaped" || forced === "victory" || forced === "defeat") return forced;
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
    battleType: String(payload?.battlePlan?.type ?? "default").toLowerCase(),
    // Which follow-up rule (if any) spawned THIS battle — lets a rule avoid
    // chaining off its own ambush battle.
    followupRuleId: payload?.meta?.followupRuleId ?? null,
    promptResult:   null,
    summaryResults: null,
    rank:           null,
  };

  // Read snapshots pre-computed at PREP time. bdRewardSnapshot is THIS battle's
  // own rewards; bdCarriedRewards is the accumulated pool from any preceding
  // follow-up battle(s). Merge them so the prompt + award include the whole
  // chain (e.g. the random encounter's loot AND the Wandering Flame's).
  const _bdSnap = (() => {
    try { return game.settings.get("fabula-ultima-companion", "bdRewardSnapshot") ?? {}; }
    catch { return {}; }
  })();
  const _carried = (() => {
    try { return game.settings.get("fabula-ultima-companion", "bdCarriedRewards") ?? null; }
    catch { return null; }
  })();
  const _combined = _carried ? mergeRewardSnapshots(_carried, _bdSnap) : _bdSnap;
  endCtx.defaultRewards = {
    expByActorId:   _combined.expByActorId   ?? {},
    zenitByActorId: _combined.zenitByActorId ?? {},
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

  // ── Undying interception (e.g. Geist's Zero Power: The Blackest Night) ───
  // Runs FIRST — before the prompt, the victory cinematic, and follow-up
  // evaluation. A pending undying claim means a battle-ender hit 0 HP with
  // its revive condition met: the rule plays the fake-out, applies the
  // restore, un-latches dCombat, and sets ctx.pendingUndying so the FSM
  // resumes the SAME conflict instead of stopping. Reward snapshots are left
  // untouched (the battle isn't over — the real Battle-End still needs them).
  // An undying claim outranks a follow-up: you can't be ambushed after a
  // fight that never ended. See [[undying]].
  let _undying = null;
  try { _undying = await evaluateUndying(endCtx); }
  catch (e) { warn("[BattleEnd] evaluateUndying threw", e); _undying = null; }
  if (_undying?.handled) {
    log("[BattleEnd] Undying rule handled — resuming conflict, skipping victory pipeline");
    // Consume any pre-filled (sword-button) prompt result so it can't leak
    // into the resumed battle's eventual real Battle-End prompt.
    director.ctx.battleEndPromptResult = null;
    return;
  }

  // ── Conflict event teardown ──────────────────────────────────────────────
  // Deliberately placed AFTER the undying early-return and BEFORE the
  // follow-up hand-off:
  //   • undying resumed THIS conflict — the rule is still in play, so the
  //     early return above must skip teardown entirely
  //   • a follow-up is a NEW conflict on the same scene (round resets,
  //     conflict_start re-fires) — sweeping here means it re-seeds clean
  //     instead of the old state surviving alongside the new
  // This is also where the system's cleanup lives generally: BD has no
  // conflict_end dispatch site yet (see the note in state-handlers' STOPPED),
  // and a status an event seeded must never follow a creature out of the
  // fight. See [[conflict-event]].
  try {
    const { teardownConflictEvent } = await import("../../conflict-event/conflict-event-runtime.js");
    await teardownConflictEvent(director);
  } catch (e) { warn("[BattleEnd] conflict-event teardown threw", e); }

  // ── Follow-up / sequel evaluation (e.g. ⭐ Wandering Flame ambush) ────────
  // Runs BEFORE the Battle-End prompt + victory cinematic so a triggered
  // ambush skips the victory screen entirely: enemies wiped → boss drops in →
  // new conflict, in place, on the same scene. Rules self-gate on outcome,
  // story state, and their own (pity-escalated) chance. Only the auto-detected
  // outcome is needed here — a triggered ambush only applies to a victory.
  let _followup = null;
  try { _followup = await evaluateFollowups(endCtx); }
  catch (e) { warn("[BattleEnd] evaluateFollowups threw", e); _followup = null; }
  if (_followup?.resolved?.kind === "battle" && _followup.resolved.payload) {
    log(`[BattleEnd] Follow-up "${_followup.rule.id}" triggered — deferring to in-place reinforce`);
    try { await _followup.rule.intro?.(endCtx); }
    catch (e) { warn("[BattleEnd] follow-up intro threw", e); }
    // Stash for the BATTLE_ENDING → PREP hand-off. states.js routes
    // INTERNAL_DONE on ctx.pendingFollowup (→ PREP instead of STOPPED) and a
    // commit hook swaps ctx.payload to this sequel payload.
    director.ctx.pendingFollowup = { payload: _followup.resolved.payload, ruleId: _followup.rule.id };
    // Carry THIS won battle's rewards forward so the FINAL pool (after the boss
    // fight) still includes them — the player earns both the original
    // encounter's and the boss's EXP/Zenit. Accumulates across a chain.
    try {
      const cur     = game.settings.get("fabula-ultima-companion", "bdRewardSnapshot")  ?? null;
      const carried = game.settings.get("fabula-ultima-companion", "bdCarriedRewards")   ?? null;
      await game.settings.set("fabula-ultima-companion", "bdCarriedRewards", mergeRewardSnapshots(carried, cur));
    } catch (e) { warn("[BattleEnd] carry rewards forward failed", e); }
    // Consume any pre-filled (sword-button) prompt result so it can't leak
    // into the follow-up battle's own Battle-End prompt later.
    director.ctx.battleEndPromptResult = null;
    // Skip the prompt, FX, summary, transition, and resource reset — the won
    // fight is not "over"; it continues as the boss conflict.
    return;
  }

  // Sword-button path: prompt was shown in battleEndManager before the FSM
  // committed. Consume the pre-filled result and skip the prompt dialog.
  // Auto-trigger path (enemy wipe → TURN_END → BATTLE_ENDING): no pre-fill,
  // show prompt here as normal.
  const prefilledResult = director.ctx.battleEndPromptResult ?? null;
  director.ctx.battleEndPromptResult = null;

  let promptResult;
  if (prefilledResult) {
    promptResult = prefilledResult;
  } else {
    promptResult = await showBattleEndPrompt(endCtx);
    if (!promptResult.ok) {
      log("[BattleEnd] Prompt cancelled — skipping cinematic");
      return;
    }
  }
  endCtx.promptResult = promptResult;
  endCtx.outcome = promptResult.outcome;
  endCtx.debug = !!promptResult.debug;

  await runBattleEndFx(endCtx);

  // Debug mode returns to the scene with no rewards/summary cinematic.
  //
  // Only VICTORY gets a cinematic: the summary screen is the Oni EXP/zenit/rank
  // presentation, which has nothing to show for a party wipe. Defeat runs
  // prompt → FX → transition. (A dedicated party-wipe screen was scaffolded as a
  // stub here and removed 2026-07-28 — it was never implemented, and the branch
  // only existed to call it.)
  if (endCtx.outcome === "victory" && !endCtx.debug) {
    await runBattleEndSummaryLogic(endCtx);
    await runBattleEndRank(endCtx);
    await runBattleEndSummaryUI(endCtx); // awaited: transition only starts after GM's animation finishes
  }

  await runBattleEndTransition(endCtx);

  // Resource reset fires after scene transition; token teardown is boot.stop()'s job
  runBattleEndResourceReset(endCtx).catch(e => warn("[BattleEnd] ResourceReset threw", e));

  // Clear all snapshots. The carried-rewards pool is now baked into the
  // awarded snapshot, so clear it too (end of any follow-up chain).
  try { game.settings.set("fabula-ultima-companion", "bdCarriedRewards",      null); } catch (_) {}
  try { game.settings.set("fabula-ultima-companion", "bdRewardSnapshot",      null); } catch (_) {}
  try { game.settings.set("fabula-ultima-companion", "bdPreBattleViewport",   null); } catch (_) {}
  try { game.settings.set("fabula-ultima-companion", "bdBattleSceneViewport", null); } catch (_) {}

  // Publish the result so systems that HANDED a fight to the Director can
  // react to how it went. Stealth needs exactly this: a victory should clear
  // the guards it sent in, an escape should only daze them. Nothing else was
  // announcing the outcome, so the only alternative was inferring it from
  // whatever state happened to survive the scene change.
  //
  // Fired last, after rewards and the transition, so a listener sees a settled
  // world rather than one mid-teardown.
  try {
    Hooks.callAll("fu.battleEnd", {
      outcome:        endCtx.outcome,
      sourceSceneId:  endCtx.sourceSceneId,
      battleSceneId:  endCtx.battleSceneId,
      partyActorIds:  endCtx.partyActorIds,
      totalRounds:    endCtx.totalRounds,
      meta:           payload?.meta ?? null,
    });
  } catch (e) {
    warn("[BattleEnd] fu.battleEnd listener threw", e);
  }

  log("[BattleEnd] Sequence complete");
}
