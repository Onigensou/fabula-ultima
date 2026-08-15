// Battle Director — ES module entry point.
//
// Registered in module.json's `esmodules` array. Loads the director, exposes
// the public API on `FUCompanion.api.experimental.battleDirector`, and does
// NOT fire on `combatStart` (legacy continues to do that).
//
// To start the director on a combat:
//   await FUCompanion.api.experimental.battleDirector.start(game.combat.id)
//
// To stop it:
//   await FUCompanion.api.experimental.battleDirector.stop()
//
// See modules/fabula-ultima-companion/scripts/battle-director/README.md for
// the full v1 scope + caveats.

import { log, warn } from "./logger.js";
import { BattleDirector } from "./director.js";
import { STATE_HANDLERS, installGuardHpWatcher, installApplierReaperWatcher, installSideWipeWatcher, checkSideWipe } from "./state-handlers.js";
import { installGrappledCoverWatcher } from "./grappled.js";
import { installConditionAdoptionWatcher } from "./condition-adoption.js";
import { STATES } from "./states.js";
import { INTENTS } from "./intents.js";
import { showBattleEndPrompt } from "./battle-end/battle-end-prompt.js";
import {
  setFollowupActive,
  isFollowupActive,
  listActiveFollowups,
  listFollowupRules,
  getFollowupPity,
} from "./battle-end/battle-followup.js";
import { registerWanderingFlameAmbush } from "./battle-end/followups/wandering-flame-ambush.js";
import { initWanderingFlameEntrance } from "./battle-end/followups/wandering-flame-entrance.js";
import { getPendingClaim, clearPendingClaim, listUndyingRules, isForceCinematic, setForceCinematic } from "./battle-end/undying/undying.js";
import { registerBlackestNight, blackestNightReactor } from "./battle-end/undying/geist-blackest-night.js";
import { initBlackestNightCinematic } from "./battle-end/undying/blackest-night-cinematic.js";
import { getIntentChannel, attachDirector, detachDirector } from "./intent-channel.js";
import { TurnUI } from "./turn-ui.js";
import { registerPlayerComposeActionHandler } from "./compose-action.js";
import { registerPlayerActionCardHandler } from "./action-card.js";
import { TurnPicker, registerPlayerTurnPickerHandler } from "./turn-picker.js";
import { registerPlayerReactionMenuHandler } from "./reaction-menu-player.js";
import { registerPlayerDieSwapHandler } from "./check-die-swap-picker.js";
import { registerPlayerSoulStealHandler } from "./soul-steal-result.js";
import { registerRemotePickResponder } from "./remote-pick.js";
import { WeaponModePicker } from "./weapon-mode-picker.js";
import { AttributePairPicker } from "./attribute-pair-picker.js";
import { DieSwapPicker } from "./check-die-swap-picker.js";
import { BattlefieldActionCard } from "./action-card.js";
import * as LegacySuppressor from "./legacy-suppressor.js";
import { runDirectorInit, cleanupDirectorSpawnedTokens, initDirectorEntrance, spawnLiveDirectorTokens } from "./director-init.js";
import { initDirectorCutin } from "./director-cutin.js";
import { initDirectorRoundBanner, hideRoundBanner, refreshTurnActions as bannerRefreshTurnActions, showRoundBannerForResume, showRoundBannerForResumeFromState } from "./director-round-banner.js";
import { initDirectorBattleLoader } from "./director-battle-loader.js";
import { initIconFocusTuner } from "./icon-focus-tuner.js";
import { stopBattleBgm, preloadDirectorSfx, playResourceLossVfx } from "./director-vfx.js";
import { initDirectorSfx, collapseSidebarLocal } from "./director-sfx.js";
import { initSfxAudition } from "./sfx-audition.js";
import { initDamageNumbers, emitDamageNumber, renderDamageNumberLocal } from "./damage-numbers/director-damage-numbers.js";
import { initImpactFx } from "./damage-numbers/director-impact-fx.js";
import { initHurtReaction, emitHurtReaction, playHurtReactionLocal } from "./damage-numbers/director-hurt-reaction.js";
import { initNpcHpBar, emitNpcHpBar, emitNpcHpBarUnchecked, renderNpcHpBarLocal } from "./damage-numbers/director-hp-bar.js";
import { initDominationFx } from "./domination.js";
import { initDominationCrest } from "./domination-crest.js";
// Damage-number audition (look-only) tool is intentionally not registered as a
// dev-tool button — consolidated into the live-path tool below to save space.
import { initDamageNumberLivetest } from "./damage-numbers/damage-number-livetest.js";
import { initBattleStateTool } from "./battle-state-tool.js";
import { initTestBattleTool } from "./test-battle-tool.js";
import { run as simRun, abort as simAbort, testSkill as simTestSkill } from "./sim/sim-run.js";
import { SimMode } from "./sim/sim-mode.js";
import { Journal as SimJournal } from "./sim/sim-journal.js";
import { initSimPanel } from "./sim/sim-panel.js";
import { registerBuiltinReactor, clearBuiltinReactors } from "./instance-settle.js";
import { crisisReactor } from "./crisis-reactor.js";
import { defeatReactor } from "./defeat-reactor.js";
import { derivedStatusReactor } from "./derived-status-reactor.js";
import { initDirectorUiSfx } from "./director-ui-sfx.js";
import { initKeywordSuggest } from "./keyword-suggest.js";
import { initDevToolsMenu, registerDevTool } from "./dev-tools-menu.js";
import { registerAutopilotSetting, registerAutopilotDevTool } from "./enemy-autopilot.js";
import { registerSummonAutopilotSetting, registerSummonAutopilotDevTool } from "./summon-autopilot.js";
import { initDirectorSurfaces, getActiveSurfaces, hasSurface, countSurfaces, clearAllSurfaces } from "./director-surfaces.js";
import { sweepTransientAEsAtSceneEnd, firePassiveTriggers, installRiderAeLinkage } from "./skill-effects.js";
import { LEGACY_BRIDGED_TRIGGERS } from "./director-triggers.js";
import { PassiveManager } from "./passive-manager.js";
import { initPassiveCardUi, passiveCardQueue } from "./passive-card-ui/director-passive-card-ui.js";
import { clearAllStandaloneMenus } from "./standalone-reactions.js";
import { freezeActionResult, snapshotDirectorCombatant, snapshotEligibleTargetsFromDCombat } from "./snapshot.js";
import {
  findSavedDirectorState,
  reconstructDirectorCombat,
  clearDirectorStateFlag,
  clearAllDirectorStateFlags,
  installItemDeletionTracker,
  getHistory,
  findHistorySnapshot,
  rewindToHistorySnapshot,
  hydrateContinuationState,
  saveDirectorState,
} from "./persistence.js";
import { peekTop, topIsFreeAction, topIsSrwDetour, stackDepth } from "./continuation-stack.js";
// Anim Studio preview — lets the Preview Bench run a skill/scratch animation
// through the real BD execution core (payload shape, selection bridging, damage
// gate) with NO director/combat/damage. See director-animation.js.
import { previewAnimation, resolveAnimationSpec } from "./director-animation.js";
// Test harness — side-effect import (registers
// FUCompanion.api.test.runDirectorSkillCompute on the "ready" hook).
// Doesn't add behavior to the live director; lets the test bridge
// drive skill COMPUTE for autonomous regression checks.
import "./_test-harness-director.js";
// Player resource HUD — side-effect import registers socket actions and the
// reload-gate canvasReady hook on every client (not just the GM).
import "./director-player-hud.js";
import { destroyDirectorHud } from "./director-player-hud.js";

// Module-level singleton — at most one director runs per client.
let _instance = null;

// Pre-flight cleanup: handle leftover state from a prior aborted/wedged run
// before starting fresh.
//
// Cases this catches:
//   - Rate-limited self-stop: FSM hit STOPPED internally but boot's _instance
//     never cleared, so a follow-up start() would refuse with "already running".
//   - Partial PREP failure that didn't fully unwind.
//   - Director-spawned tokens left on any scene from a prior run that crashed
//     mid-cleanup.
//   - Legacy-suppressor still active from a prior run that bypassed stop().
//   - Lingering Octopath / picker DOM from a UI-only leak.
async function preflightCleanup() {
  // 1. If _instance is set but the FSM has wedged itself (STOPPED state or
  //    _stopped flag), silently route through stop() to clean + clear the ref.
  if (_instance) {
    const state = _instance.state;
    const wedged = _instance._stopped || state === STATES.STOPPED;
    if (wedged) {
      log(`pre-flight: detected wedged director (state=${state}); auto-recovering before start`);
      try { await stop({ reason: "preflight-stale-cleanup" }); }
      catch (e) { warn("pre-flight stop threw", e); }
    }
  }

  // 2. Defensive DOM scrub. All despawnAll calls are idempotent; safe to
  //    invoke even if no instance ever ran on this page.
  try { TurnUI.despawnAll(); } catch {}
  try { TurnPicker.despawnAll(); } catch {}
  try { WeaponModePicker.despawnAll(); } catch {}
  try { AttributePairPicker.despawnAll(); } catch {}
  try { DieSwapPicker.despawnAll(); } catch {}
  try { BattlefieldActionCard.despawnAll(); } catch {}
  try { PassiveManager.despawn(); } catch {}

  // 3. If the legacy suppressor is still active without a live instance, that
  //    means a prior run got suppress()'d but never restore()'d. Restore now;
  //    boot will re-suppress in a moment with a clean slate.
  try {
    if (!_instance && LegacySuppressor.isActive?.()) {
      const n = LegacySuppressor.restore?.() ?? 0;
      log(`pre-flight: restored ${n} orphaned legacy hooks from prior run`);
    }
  } catch (e) { warn("pre-flight suppressor restore threw", e); }

  // 4. Sweep every scene for director-spawned tokens left behind. Most runs
  //    will have zero; only fires on real leftovers.
  let swept = 0;
  for (const scene of (game.scenes?.contents ?? [])) {
    try {
      const n = await cleanupDirectorSpawnedTokens(scene);
      if (n) swept += n;
    } catch (e) { warn("pre-flight token sweep threw on", scene?.name, e); }
  }
  if (swept) log(`pre-flight: cleaned ${swept} orphan director-spawned tokens`);
}

// start() now accepts either:
//   - a combat id string  → manual fallback (attaches to an existing combat,
//                            FSM goes IDLE → ROUND_START, skipping PREP)
//   - a { payload }       → full director-owned init (FSM goes IDLE → PREP
//                            → ROUND_START, where PREP creates the combat)
//   - a { combatId }      → same as the string form
//   - undefined           → attaches to game.combat (manual fallback)
async function start(arg) {
  if (!game.user?.isGM) {
    ui.notifications?.warn("Battle Director v1 is GM-only.");
    return null;
  }

  // Pre-flight: scrub any leftover state from a prior wedged/aborted run so a
  // fresh start always begins on a clean slate. Auto-recovers from cases like
  // the rate-limiter self-stop where `_instance` lingered without a live FSM.
  await preflightCleanup();

  // After pre-flight, if `_instance` is still set, a LIVE director is running
  // (state != STOPPED, _stopped not set) — refuse to clobber it.
  if (_instance) {
    ui.notifications?.warn("Battle Director already running. Call .stop() first.");
    return _instance;
  }

  // Normalize the argument
  let payload = null;
  let combat = null;
  if (typeof arg === "string") {
    combat = game.combats?.get(arg) ?? null;
  } else if (arg && typeof arg === "object") {
    payload = arg.payload ?? null;
    if (arg.combatId && !combat) combat = game.combats?.get(arg.combatId) ?? null;
  } else {
    combat = game.combat ?? null;
  }
  if (!payload && !combat) {
    ui.notifications?.error("Battle Director: no payload and no combat found. Start an encounter first.");
    return null;
  }

  log(`Director.start: ${payload ? "payload-driven (PREP)" : `combat=${combat?.id} round=${combat?.round}`}`);

  // Neutralize legacy battle-system hook handlers (turn-ui-manager,
  // reaction-manager, turn-emitter, etc.) so they don't fight the director
  // for control over the same combat. Restored in stop().
  try {
    const n = LegacySuppressor.suppress();
    log(`Legacy listeners suppressed (${n} hooks)`);
  } catch (e) {
    warn("LegacySuppressor.suppress threw", e);
  }

  const director = new BattleDirector({
    combat,
    payload,
    stateHandlers: STATE_HANDLERS,
    // FSM-driven natural stop (e.g. combat ended, PREP aborted). Routes
    // through the same stop() path as a manual call so cleanup is uniform.
    onNaturalStop: ({ reason }) => stop({ reason }),
  });
  // Attach the per-client IntentChannel singleton (installed on `ready`
  // for every user). On GM, this wires the director ref so socket-arrived
  // INTENT envelopes can fall back to director.dispatch when nothing's
  // awaiting them.
  const channel = attachDirector(director);
  director.intentChannel = channel;

  // No Foundry Combat doc exists in director mode, so the legacy auto-stop
  // hooks (deleteCombat/combatEnd/updateCombat) are no-ops. The only entry to
  // stop is the End-Battle button (custom UI at the bottom-right of the
  // screen) → [BattleEnd: Manager] → [BattleEnd: Director Manager] → api.stop.

  // Register engine-mandatory transaction-settle reactors (run inside
  // settleInstance during every instance settle). Clear first so a restart
  // doesn't stack duplicates. The crisis reactor reconciles each creature's
  // Crisis AE by stored crisis_hp on every hp ledger event — the BD-native
  // replacement for the retired auto-crisis-detection hook. The defeat reactor
  // runs the removal pipeline (animation → drop combatant → delete token) for
  // eligible enemies at HP 0 — the BD-native replacement for auto-defeat.js,
  // which is suppressed while the director is active.
  clearBuiltinReactors();
  registerBuiltinReactor(crisisReactor);
  registerBuiltinReactor(defeatReactor);
  registerBuiltinReactor(derivedStatusReactor);
  // Geist's Blackest Night undying trigger — after defeatReactor so the
  // creature_defeated emit + KO status land first. See [[undying]].
  registerBuiltinReactor(blackestNightReactor);

  _instance = director;
  try {
    await director.start();
  } catch (e) {
    warn("director.start threw", e);
  }
  // Notify UI surfaces (e.g. the combat button installer) that the director
  // is now running. Without a Foundry Combat doc they have no `createCombat`
  // hook to listen to, so we emit a custom one.
  try { Hooks.callAll("fu-director-started", director); } catch (e) { warn("fu-director-started hook threw", e); }
  return director;
}

// `clearFlags` controls whether stop() also wipes the scene flags. Default
// true — the normal End-Battle / wedge-recovery path nukes both
// directorState + directorHistory because the combat is over. The rewind
// tool passes `clearFlags: false` so the orchestrator can write the
// rewound state back to directorState (and truncate, not erase, history)
// AFTER stop tears down the live instance.
//
// `cleanupTokens` controls the director-spawned-token sweep. Default true
// for the same reasons — End Battle should remove the tokens it created.
// The rewind tool passes `cleanupTokens: false` because the rewound
// snapshot still references those tokens by UUID; deleting them here
// would force `reconstructDirectorCombat` to drop every combatant as
// "stale" on the next mount.
async function stop({ reason = "manual", clearFlags = true, cleanupTokens = true } = {}) {
  if (!_instance) {
    log("Director.stop: no instance running");
    return;
  }
  // Resolve the battle scene from dCombat (the authoritative ref), falling
  // back to canvas.scene. Used for cleanupDirectorSpawnedTokens.
  const battleScene = _instance.dCombat?.scene ?? _instance.combat?.scene ?? canvas?.scene ?? null;

  // Detach the director from the per-client IntentChannel singleton, but
  // KEEP it installed — players still need it to receive future MENU_OPEN
  // events from the next start, and the GM uses it to log unmatched
  // intents. (Old behavior was to uninstall + recreate per start; now the
  // channel is session-lifetime.)
  try { detachDirector(); } catch {}

  // Release any still-active Guard / Covered AEs before tearing down
  // dCombat. Once the director stops, TURN_START won't fire again to
  // release them — they'd live as zombies on actors until manually
  // removed. RAW: "until the start of your next turn" is moot once the
  // conflict ends, so combat-end auto-releases.
  //
  // Batching strategy: group every effect-id by its owning actor, then
  // issue ONE `deleteEmbeddedDocuments` call per actor (combines Guard +
  // Covered when the same actor happens to hold both), and run those calls
  // for different actors in PARALLEL. Sequential per-AE awaits used to
  // stack a 2-actor cleanup into 4+ round-trips and visibly stuttered the
  // End-Battle button; this collapses it to two parallel calls.
  const liveGuards = Array.isArray(_instance.dCombat?.activeGuards) ? _instance.dCombat.activeGuards : [];
  if (liveGuards.length) {
    const deletesByActor = new Map(); // actorUuid → Set<effectId>
    for (const g of liveGuards) {
      if (g.guarderActorUuid && g.guarderEffectId) {
        let set = deletesByActor.get(g.guarderActorUuid);
        if (!set) { set = new Set(); deletesByActor.set(g.guarderActorUuid, set); }
        set.add(g.guarderEffectId);
      }
      if (g.coveredActorUuid && g.coveredEffectId) {
        let set = deletesByActor.get(g.coveredActorUuid);
        if (!set) { set = new Set(); deletesByActor.set(g.coveredActorUuid, set); }
        set.add(g.coveredEffectId);
      }
    }
    await Promise.all(Array.from(deletesByActor.entries()).map(async ([actorUuid, ids]) => {
      try {
        const actor = await fromUuid(actorUuid);
        if (!actor) return;
        // Filter to AEs that still exist — drop any the GM hand-deleted
        // before End Battle (no-op deletes throw in Foundry V12).
        const existing = Array.from(ids).filter((id) => !!actor.effects?.get?.(id));
        if (!existing.length) return;
        await actor.deleteEmbeddedDocuments("ActiveEffect", existing);
      } catch (e) {
        warn(`stop: AE cleanup failed for ${actorUuid}`, e);
      }
    }));
    log(`Cleared ${liveGuards.length} active Guard entr${liveGuards.length === 1 ? "y" : "ies"} on stop (${deletesByActor.size} actor${deletesByActor.size === 1 ? "" : "s"})`);
  }
  if (_instance.dCombat) _instance.dCombat.activeGuards = [];

  // Sweep every TRANSIENT AE on every actor — director-applied (Aura,
  // Barrier, Reinforce, ...), duration-bearing (Slow, Dazed, Buff, ...),
  // or opt-in buff/debuff-tagged. Passive AEs (equipment-derived, class
  // traits, no-duration unmarked) are preserved. AEs with the
  // `crossScene` or `directorPermanent` flag opt out of the sweep.
  // Skipped on the rewind path so the rewound state survives the
  // stop→reconstruct cycle.
  if (cleanupTokens) {
    try {
      await sweepTransientAEsAtSceneEnd();
    } catch (e) { warn("stop: sweepTransientAEsAtSceneEnd threw", e); }
  }

  try { await _instance.stop({ reason }); } catch (e) { warn("stop threw", e); }

  // Drop any free-action request that was granted but never drained. The queue
  // is a module singleton, so without this it OUTLIVES the battle: a round-end
  // grant (Late Actor) that the fight ended on top of would still be sitting
  // there when the next battle starts, and the next creature to reach a
  // free-action window would spend it. Measured 2026-08-15 — a fresh battle
  // opened with queue size 1 left over from the previous one.
  try {
    const { freeActionQueue } = await import("./free-action-queue.js");
    if (!freeActionQueue.isEmpty()) freeActionQueue.clear();
  } catch (e) { warn("stop: free-action queue clear threw", e); }

  try { TurnUI.despawnAll(); } catch {}
  try { TurnPicker.despawnAll(); } catch {}
  try { WeaponModePicker.despawnAll(); } catch {}
  try { AttributePairPicker.despawnAll(); } catch {}
  try { DieSwapPicker.despawnAll(); } catch {}
  try { BattlefieldActionCard.despawnAll(); } catch {}
  try { PassiveManager.despawn(); } catch {}
  // Surface registry — the despawnAll calls above remove DOM (the observer
  // unregisters each), but wipe the registry too so any explicitly-registered
  // overlay (banner / cut-in) doesn't linger as a stale entry.
  try { clearAllSurfaces(); } catch {}
  // Defensive standalone-menu cleanup. STOPPED.onEnter already calls
  // clearAllStandaloneMenus, but on the rewind path the FSM transition
  // may be mid-await (dispatchStandaloneTrigger blocked on a player's
  // pending pick) and the onEnter chain doesn't reach the menu cleanup
  // before this point. Running it here too is idempotent — the menu's
  // _instances map dedupes — and guarantees no stranded menu DOM across
  // rewind / End Battle.
  try { await clearAllStandaloneMenus(); } catch (e) { warn("stop: clearAllStandaloneMenus threw", e); }
  try { passiveCardQueue.clear(); } catch {}
  // Defensive player-HUD teardown, for the same reason as the menu cleanup above.
  // destroyDirectorHud normally runs from STOPPED.onEnter — but only a battle that
  // ENDS reaches STOPPED (BATTLE_ENDING → STOPPED → here). A stop() called
  // directly on a live battle (the sim harness aborting, a dev calling
  // api.stop(), any external teardown) skips those states entirely, and the HUD
  // was left stranded on every client with no way to dismiss it. Idempotent:
  // destroyLocally on an already-cleared key is a no-op and the unsetFlags swallow
  // their own errors, so the normal End-Battle path double-calling this is free.
  if (cleanupTokens) {
    try { await destroyDirectorHud(battleScene); }
    catch (e) { warn("stop: destroyDirectorHud threw", e); }
  }
  // The next two are TRUE-teardown cleanups (End Battle), NOT re-mount
  // cleanups (rewind / reload). The rewind path stops the live instance only
  // to reconstruct it a beat later via resumeFromSavedState — the conflict is
  // still going, so the BGM must keep playing and the round indicator must
  // stay. `cleanupTokens` is the real-end signal (true for End Battle, false
  // for rewind — same gate the transient-AE sweep above uses). Without this,
  // every rewind silenced the battle BGM (nothing restarts it on re-mount,
  // since the synced playlist is normally just left alone across F5).
  if (cleanupTokens) {
    // Clear the persistent start-of-round banner (fades out + broadcasts) so it
    // never lingers on screen after the battle ends.
    try { hideRoundBanner(); } catch {}
    // Stop the battle BGM the director started (mirrors legacy battle-end). The
    // payload's bgm name is passed as a fallback for the F5-mid-battle case.
    try { stopBattleBgm(_instance?.payload?.battleConfig?.bgm); } catch {}
  }

  // Broadcast MENU_CLOSE to every online non-primary client (players AND
  // secondary GMs) so any mirror overlays (action-card, Octopath, pickers)
  // tear down too. The per-state onExit/onAbort that normally sends these
  // doesn't run on End-Battle-mid-CONFIRM, so without this sweep those
  // overlays would linger forever on all non-primary clients.
  // Passing no `kind` matches all registered close handlers.
  try {
    const channel = getIntentChannel();
    const onlineNonPrimary = (game.users?.contents ?? []).filter((u) => u.active && u.id !== game.user?.id);
    if (onlineNonPrimary.length) {
      try {
        channel.broadcastMenuClose({
          targetUserIds: onlineNonPrimary.map((u) => u.id),
          reason: `director-stop:${reason}`,
        });
      } catch (e) { warn("stop: broadcastMenuClose sweep threw", e); }
    }
  } catch (e) { warn("stop: mirror MENU_CLOSE sweep threw", e); }

  // Remove tokens we spawned during runDirectorInit. Only tokens flagged
  // with fabula-ultima-companion.directorSpawned are touched — manually
  // placed tokens stay. Skipped on the rewind path (caller passes
  // `cleanupTokens: false`) since the snapshot's combatants reference
  // these tokens by UUID — sweeping them would force the reconstruct
  // step to drop every combatant.
  if (battleScene && cleanupTokens) {
    try {
      const n = await cleanupDirectorSpawnedTokens(battleScene);
      if (n) log(`Cleaned up ${n} director-spawned tokens`);
    } catch (e) {
      warn("cleanupDirectorSpawnedTokens threw", e);
    }
  }

  // Re-enable the legacy listeners we suppressed in start(). This restores
  // the legacy turn-ui-manager, reaction-manager, etc. to their normal
  // behavior for the next combat (legacy or director, doesn't matter — they
  // were no-ops while we were running anyway).
  try {
    const n = LegacySuppressor.restore();
    log(`Legacy listeners restored (${n} hooks)`);
  } catch (e) {
    warn("LegacySuppressor.restore threw", e);
  }
  _instance = null;
  // Drop the ambient active-dCombat global (MP_SPENT_THIS_TURN reads it) — the
  // combat is over, so any later formula eval correctly sees 0 spent.
  try { if (globalThis.__fudActiveDCombat) globalThis.__fudActiveDCombat = null; } catch { /* sandbox */ }
  // Clear any persisted director-state flag — the combat is over, no
  // resume is possible. Defensive `clearAll` (not scoped to the battle
  // scene) so that any orphaned flag from an earlier crash is also
  // swept on next stop. BattleEnd Cleanup macro does the same as
  // defense-in-depth in case a stop() path is bypassed.
  // Skipped when called from the rewind orchestrator (it just rewrote
  // the flags to the rewound state and will mount a fresh director
  // from them).
  if (clearFlags) {
    clearAllDirectorStateFlags().catch((e) => warn("stop: clearAll flags failed", e));
  }
  // Notify UI surfaces that the director has stopped so they can refresh state.
  try { Hooks.callAll("fu-director-stopped", { reason }); } catch (e) { warn("fu-director-stopped hook threw", e); }
}

// Resume an in-progress combat from a persisted scene flag. Returns the
// new director instance, or null on failure.
//
// Bypasses PREP entirely — the tokens are already on the battle scene,
// the dCombat is rebuilt from the saved snapshot, and we transition
// straight to TURN_START. The picker re-prompts on the saved currentSide
// (we deliberately cleared currentCombatantId during reconstruction so
// the GM gets one re-pick — handy if the reload was triggered because
// they made a wrong declaration).
async function resumeFromSavedState({ scene, state, animateBanner = true }) {
  log(`Director resume: found saved state on scene "${scene.name}" (round ${state.dCombat?.round ?? "?"})`);

  // Refuse to clobber a live director (shouldn't happen at `ready`-time
  // since we just loaded, but guard anyway).
  if (_instance) {
    warn("resume: a director is already running — skipping");
    return null;
  }

  // Reconstruct dCombat from the saved snapshot. Token UUIDs are
  // re-resolved; missing combatants are dropped with a warning toast.
  const dCombat = await reconstructDirectorCombat(state, scene);
  // Mirror the reconstructed combat into the ambient active-dCombat global so
  // MP_SPENT_THIS_TURN (Bimagus) resolves after a reload-resume too. The
  // per-turn tally itself is not serialized (resets on reload — documented),
  // but new spends this session must read the live instance.
  if (dCombat) { try { globalThis.__fudActiveDCombat = dCombat; } catch { /* sandbox */ } }
  if (!dCombat) {
    warn("resume: reconstruction failed (no combatants survived)");
    await clearDirectorStateFlag(scene);
    return null;
  }

  // Suppress legacy hooks (same as fresh start path).
  try {
    const n = LegacySuppressor.suppress();
    log(`Legacy listeners suppressed for resume (${n} hooks)`);
  } catch (e) {
    warn("LegacySuppressor.suppress threw on resume", e);
  }

  // Activate + view the battle scene so the GM sees the right canvas.
  try {
    if (canvas?.scene?.id !== scene.id) {
      await scene.activate();
    }
    scene.view?.();
  } catch (e) {
    warn("resume: scene.activate/view threw", e);
  }

  // Build the director. No combat, no payload — we'll install dCombat
  // directly and skip START_COMBAT routing by going straight to TURN_START.
  const director = new BattleDirector({
    stateHandlers: STATE_HANDLERS,
    onNaturalStop: ({ reason }) => stop({ reason }),
  });
  director._setDirectorCombat(dCombat);
  // Make `ctx.payload` accessible for diagnostics (the snapshot has it).
  director.ctx.payload = state.payload ?? null;
  // Stash payload on the director itself too, mirroring the fresh-start path.
  director.payload = state.payload ?? null;

  const channel = attachDirector(director);
  director.intentChannel = channel;

  // Re-install the guard-HP watcher (PrepState.onEnter does this on the
  // fresh path; on resume we install it here since we bypass PREP).
  installGuardHpWatcher(director);
  // Same reasoning: re-install the applier-tied-AE reaper on resume.
  installApplierReaperWatcher(director);
  // Same reasoning: re-install side-wipe detection on resume.
  installSideWipeWatcher(director);
  // Rewind tool: same reasoning — re-install the item-deletion tracker
  // on the resume path so the rewind history's deletedItemsLog keeps
  // getting populated post-reload.
  installItemDeletionTracker(director);

  // Same reasoning: re-register the engine-mandatory transaction-settle reactors
  // (crisis etc.). A hard reload rebuilds the instance-settle module with an EMPTY
  // BUILTIN_REACTORS; the fresh-start path registers them in start() (above), but
  // resume bypasses start(). Without this the crisis reactor never fires after a
  // mid-combat reload, so creatures dropping below crisis_hp get no Crisis AE.
  clearBuiltinReactors();
  registerBuiltinReactor(crisisReactor);
  registerBuiltinReactor(defeatReactor);
  registerBuiltinReactor(derivedStatusReactor);
  // Geist's Blackest Night undying trigger — must survive resume too, or a
  // mid-boss-fight F5 silently disables the revive. See [[undying]].
  registerBuiltinReactor(blackestNightReactor);

  _instance = director;

  // Notify UI surfaces (rewind button, combat-button-installer, etc.) that
  // the director is now running. Fired BEFORE the resume's blocking
  // transitionTo(...) below: if pendingAction is set, the transition awaits
  // the spawned Action Card's promise — gating the started event behind
  // the user's click would leave the rewind button hidden for the whole
  // duration of that card. Listeners are idempotent (just call refresh
  // functions reading isRunning()), so the later fire at the bottom of
  // resumeFromSavedState is a harmless safety re-tick.
  try { Hooks.callAll("fu-director-started", director); } catch (e) { warn("fu-director-started hook threw on resume (early)", e); }

  // History-push dedup lives in pushToHistory now — no per-resume flag
  // needed. Same-fingerprint entries (rewind to "Hina · Turn Start" →
  // TURN_START re-saves same) collapse to one in the rewind list.

  // Resume routing — stack-driven.
  //
  // Hydrate the runtime continuation state first (freeActions registry,
  // freeActionQueue, continuationStack, standalone* fields). All
  // routing decisions below read from those structures.
  //
  // Branch priority (first match wins):
  //   1. pendingAction set → CONFIRM (F5 mid-action-card; one-shot
  //      orthogonal to the stack — survives any combination of frames)
  //   2. round=0 → STANDALONE_REACTION_WINDOW for conflict_start
  //      (pre-combat phase; defensively clears a stale
  //      currentTurnResolved=true that would otherwise misroute to
  //      TURN_END and flip currentSide before anyone's turn)
  //   3. currentTurnResolved (and no in-flight stack) → TURN_END (turn
  //      committed pre-reload, just advance)
  //   4. Stack non-empty → top.resumeAt (suspended sub-flow:
  //      freeAction → FAW for teardown / drain; srwDetour → SRW for
  //      pop + re-dispatch loop; future interrupt frames likewise)
  //   5. Default → TURN_START (auto-picks the saved combatant)
  const facSummary = hydrateContinuationState(director, state);
  if (facSummary.restored) {
    log(`resume: continuation state restored — queue=${facSummary.queueSize}, stack=${facSummary.stackDepth ?? 0}, top="${facSummary.topReason ?? "(none)"}"`);
  }

  let resumeAt;
  let resumedFromCard = false;
  if (state.pendingAction?.actionResult) {
    try {
      director.ctx.actionResult = freezeActionResult(state.pendingAction.actionResult);
      // Restore the ctx subset Confirm.onEnter persisted. Each field is
      // copied individually rather than via Object.assign so an
      // unexpectedly-shaped ctx blob can't clobber unrelated ctx state.
      const savedCtx = state.pendingAction.ctx ?? {};
      if (savedCtx.passIndex != null) director.ctx.passIndex = savedCtx.passIndex;
      if (savedCtx.totalPasses != null) director.ctx.totalPasses = savedCtx.totalPasses;
      if (savedCtx.attackMode !== undefined) director.ctx.attackMode = savedCtx.attackMode;
      if (savedCtx.pendingPasses !== undefined) director.ctx.pendingPasses = savedCtx.pendingPasses;
      if (savedCtx.pickedTargetUuids !== undefined) director.ctx.pickedTargetUuids = savedCtx.pickedTargetUuids;
      if (savedCtx.currentWeapon !== undefined) director.ctx.currentWeapon = savedCtx.currentWeapon;
      if (savedCtx.hinderCheckConfig !== undefined) director.ctx.hinderCheckConfig = savedCtx.hinderCheckConfig;
      if (savedCtx.declaredCommand !== undefined) director.ctx.declaredCommand = savedCtx.declaredCommand;
      // turnSnapshot isn't persisted — re-derive from the saved
      // currentCombatant so handlers that read ctx.turnSnapshot stay
      // happy. Falls back to the actionResult.attacker as a last resort
      // (e.g. token UUID no longer resolves after a reload).
      if (dCombat.current) {
        try {
          director.ctx.turnSnapshot = snapshotDirectorCombatant(dCombat.current);
        } catch (e) {
          warn("resume: snapshotDirectorCombatant threw", e);
        }
      }
      if (!director.ctx.turnSnapshot) {
        director.ctx.turnSnapshot = director.ctx.actionResult.attacker ?? null;
      }
      // One-shot flag — Confirm.onEnter reads this to skip the
      // pendingAction save (the survival flag already holds the same
      // payload from the pre-reload Confirm save; re-saving would
      // duplicate the rewind history entry).
      director.ctx._resumedFromPendingAction = true;
      resumeAt = STATES.CONFIRM;
      resumedFromCard = true;
    } catch (e) {
      warn("resume: failed to restore pendingAction — falling back to TURN_START", e);
      resumeAt = STATES.TURN_START;
    }
  } else if ((dCombat.round ?? 0) === 0) {
    // "Battle Start" rewind / cold resume — conflict_start hasn't
    // completed yet. dCombat.start() leaves round=0 as the pre-combat
    // phase marker; ROUND_START.onEnter bumps to 1 only when entering
    // Round 1 for real. So any saved state with round=0 is, by
    // construction, pre-conflict_start.
    //
    // This branch fires BEFORE the currentTurnResolved-based routing to
    // catch a corrupted edge case: if currentTurnResolved persists as
    // true at round=0 (which is impossible in normal flow — RESOLVE
    // only runs during a turn, and turns only exist at round>0), the
    // old order would route to TURN_END → nextTurn() flips currentSide
    // → "Round 0 · Enemies Pick Next Turn" surfaces with no real turn
    // having taken place. Clearing the flag here + routing via SRW is
    // the authoritative repair.
    if (dCombat.currentTurnResolved) {
      warn("resume: corrupted state — currentTurnResolved=true at round=0; clearing + routing via conflict_start SRW");
      dCombat.currentTurnResolved = false;
    }
    // Re-enter the same handoff so conflict_start reactions (High
    // Speed pill, future Sentinel, etc.) re-fire — the standaloneFired
    // flag was cleared by the rewind pipeline so dispatchStandaloneTrigger
    // sees fresh candidates. For F5 mid-conflict_start the flag was
    // NOT cleared so only un-decided reactors re-spawn menus.
    director.ctx.standaloneTrigger = "conflict_start";
    director.ctx.standaloneAfter   = STATES.ROUND_START;
    director.ctx.standalonePayload = null;
    resumeAt = STATES.STANDALONE_REACTION_WINDOW;
  } else if (dCombat.currentTurnResolved && stackDepth(director.ctx) === 0) {
    // Normal turn fully resolved pre-reload AND no suspended sub-flows.
    // currentTurnResolved is only set when we're back at the top-level
    // turn (the gate in RESOLVE.onEnter skips the flip for free-action
    // pipelines), so we can route directly to TURN_END to advance.
    resumeAt = STATES.TURN_END;
  } else if (stackDepth(director.ctx) > 0) {
    // Suspended sub-flow — route to the top frame's resume state. The
    // handler at that state inspects the stack and pops as needed
    // (FAW pops `freeAction:*` for teardown; SRW pops `srwDetour:*`
    // and resumes its dispatch loop).
    const top = peekTop(director.ctx);
    resumeAt = top?.resumeAt ?? STATES.TURN_START;
    log(`resume: routing into ${resumeAt} per top frame "${top?.reason}"`);
  } else {
    resumeAt = STATES.TURN_START;
  }

  // Restore the persistent Round X banner + turn-action icons (client DOM,
  // wiped on F5; the resume path never re-enters ROUND_START which normally
  // draws them). On F5 (animateBanner=true) replay the full cinematic before
  // transitioning into the resumed state; on rewind snap straight to docked.
  try { await showRoundBannerForResume(director.dCombat, { animate: animateBanner }); }
  catch (e) { warn("resume: showRoundBannerForResume threw", e); }

  try {
    await director.transitionTo(resumeAt);
  } catch (e) {
    warn(`resume: transitionTo(${resumeAt}) threw`, e);
  }

  try { Hooks.callAll("fu-director-started", director); } catch (e) { warn("fu-director-started hook threw on resume", e); }
  return director;
}

// Public read of "is the director running on this client?" — used by the
// combat-button installer (no Foundry Combat doc means no createCombat hook
// to detect the running state).
function isRunning() {
  return !!_instance;
}

// Live director accessor for code paths with no `director` in scope — notably
// the effect-damage path (`applyToActor` via deal_damage) that needs to push
// onto the running instance's resource-ledger (`ctx._postResolveTriggers`).
// Returns the running director or null (out of combat → callers no-op).
function getActiveDirector() {
  return _instance;
}

function getSourceSceneId() {
  return _instance?.dCombat?.sourceSceneId ?? null;
}

function status() {
  if (!_instance) return { running: false };
  const dc = _instance.dCombat;
  return {
    running: true,
    state: _instance.state,
    combatId: _instance.combatId,
    // Director-owned authoritative state
    dCombat: dc ? {
      round: dc.round,
      firstSide: dc.firstSide,
      currentSide: dc.currentSide,
      currentCombatantId: dc.currentCombatantId,
      started: dc.started,
      ended: dc.ended,
      current: dc.current?.name ?? null,
      size: dc.size,
      sideCounts: {
        party: dc.combatants.filter((c) => c.side === "party").length,
        enemy: dc.combatants.filter((c) => c.side === "enemy").length,
      },
      eligible: {
        party: dc.eligibleOnSide("party").map((c) => c.name),
        enemy: dc.eligibleOnSide("enemy").map((c) => c.name),
      },
    } : null,
    // Foundry shadow (mostly for tracker UI / End button)
    foundryCombat: _instance.combat ? {
      round: _instance.combat.round,
      turn: _instance.combat.turn,
      combatant: _instance.combat.combatant?.name ?? null,
    } : null,
    hookCount: _instance.hooks.snapshot().length,
    timerCount: _instance.timers.snapshot().length,
  };
}

// ─── Rewind tool API ───────────────────────────────────────────────────
//
// Two entry points used by the rewind-button UI:
//   - `history()`     → slim metadata list (newest first) for the panel.
//   - `rewindTo(id)`  → reverse to a saved snapshot. Stops the live
//                       director, restores actors, mounts a fresh director.

// Return the metadata for each history entry on the running director's
// battle scene, newest first. Full snapshot data stays on the flag — the
// panel only needs labels / description / timing to render. Returns []
// if no director is running or no history exists.
function history() {
  if (!game.user?.isGM) return [];
  if (!_instance) return [];
  const scene = _instance.dCombat?.scene;
  if (!scene) return [];
  const list = getHistory(scene);
  if (!list.length) return [];
  // Newest first — convert to slim metadata so the panel doesn't have
  // to walk through full actor snapshots on render. Ordinal is "1 = most
  // recent" for human-friendly display.
  return list.slice().reverse().map((entry, i) => ({
    id: entry.id,
    label: entry.label ?? "",
    description: entry.description ?? "",
    savedAt: entry.savedAt ?? 0,
    round: entry.dCombat?.round ?? 0,
    currentSide: entry.dCombat?.currentSide ?? null,
    currentTurnResolved: !!entry.dCombat?.currentTurnResolved,
    ordinal: i + 1,
    isLatest: i === 0,
  }));
}

// Rewind to a saved snapshot. Steps:
//   1. Validate GM + snapshot exists.
//   2. Stop the running director WITHOUT clearing flags (the orchestrator
//      writes the rewound state back into them).
//   3. Run rewindToHistorySnapshot — reconstructs dCombat, restores
//      actors, truncates history at the target, rewrites directorState.
//   4. Mount a fresh director via resumeFromSavedState (same path used
//      for reload survival).
//
// Returns `{ ok: true, snapshot }` on success or `{ ok: false, error }`.
// Failure does NOT auto-restart the prior director — the user can pick
// a different snapshot or manually restart combat.
async function rewindTo(snapshotId) {
  if (!game.user?.isGM) {
    ui.notifications?.warn("Battle Director rewind is GM-only.");
    return { ok: false, error: "GM only" };
  }
  if (!snapshotId) {
    return { ok: false, error: "missing snapshotId" };
  }

  // Look up FIRST so we fail fast without tearing down a running director.
  const found = findHistorySnapshot(snapshotId);
  if (!found) {
    ui.notifications?.warn("Rewind target not found in history.");
    return { ok: false, error: "snapshot not found" };
  }

  // Tear down the live director, keeping the flags AND the spawned
  // tokens intact. The rewound snapshot points at the same token UUIDs
  // we'd otherwise sweep here, so cleanupTokens:false is mandatory for
  // reconstruct to find them again.
  if (_instance) {
    try {
      await stop({ reason: "rewind", clearFlags: false, cleanupTokens: false });
    } catch (e) {
      warn("rewindTo: stop threw", e);
    }
  }

  // Apply the snapshot — reconstructs dCombat, restores actor state,
  // truncates history past the target, rewrites the directorState flag.
  const result = await rewindToHistorySnapshot(snapshotId);
  if (!result.ok) {
    ui.notifications?.error(`Rewind failed: ${result.error}`);
    return result;
  }

  // Mount a fresh director from the rewound state. The snapshot is a
  // superset of the directorState shape so resumeFromSavedState accepts
  // it as-is (it reads dCombat / sourceSceneId / payload from `state`,
  // ignoring the extra `actors` / `label` / `description` / `id`).
  //
  // History-push dedup (in persistence.pushToHistory) handles the
  // "rewinding to a snapshot duplicates itself" case via fingerprint
  // match against the latest existing entry — replaces the prior
  // suppressNextHistoryPush flag which was over-aggressive (it ate
  // any first-save-after-rewind, including legitimate ones like a
  // fresh "Hina · Turn Start" entry after rewinding to "Battle Start").
  const mountResult = await resumeFromSavedState({
    scene: result.scene,
    state: result.snapshot,
    // Rewind happens often during play/testing — snap the banner straight to
    // docked instead of replaying the full ~2.5s cinematic each time. (F5
    // resume keeps the full animation.)
    animateBanner: false,
  });
  if (!mountResult) {
    ui.notifications?.error("Rewind: director mount failed after restore.");
    return { ok: false, error: "mount failed" };
  }

  return { ok: true, snapshot: result.snapshot };
}

// Register persistent world settings used by the BD subsystems.
// Must run on "init" (before "ready") so get/set are available immediately.
Hooks.once("init", () => {
  game.settings.register("fabula-ultima-companion", "bdRewardSnapshot", {
    scope: "world", config: false, default: null, type: Object,
  });
  game.settings.register("fabula-ultima-companion", "bdPreBattleViewport", {
    scope: "world", config: false, default: null, type: Object,
  });
  game.settings.register("fabula-ultima-companion", "bdBattleSceneViewport", {
    scope: "world", config: false, default: null, type: Object,
  });
  // Battle-End follow-up registry state. bdActiveFollowups: { ruleId: bool }
  // (story gating); bdFollowupPity: { ruleId: int } (escalation counter).
  // See [[battle-followup]].
  game.settings.register("fabula-ultima-companion", "bdActiveFollowups", {
    scope: "world", config: false, default: {}, type: Object,
  });
  game.settings.register("fabula-ultima-companion", "bdFollowupPity", {
    scope: "world", config: false, default: {}, type: Object,
  });
  // Reward pool carried across an in-place follow-up chain so the final
  // Battle-End award includes the preceding battle(s). See [[battle-followup]].
  game.settings.register("fabula-ultima-companion", "bdCarriedRewards", {
    scope: "world", config: false, default: null, type: Object,
  });
  // Undying interception state: { pending: claim|null }. The claim bridges
  // the trigger (settle loop) to its pickup (BATTLE_ENDING), surviving an F5
  // in between. See [[undying]].
  game.settings.register("fabula-ultima-companion", "bdUndyingState", {
    scope: "world", config: false, default: {}, type: Object,
  });
  // Enemy Autopilot toggle (Director drives enemy turns via Action Patterns up
  // to the action card). Registered here so get/set are live before "ready".
  // See [[project_action_pattern_ai]].
  try { registerAutopilotSetting(); } catch (e) { warn("registerAutopilotSetting threw", e); }
  // Summon Autopilot — the same treatment for SUMMONED creatures, on its own
  // switch so a GM who hand-drives monsters still gets self-driving summons.
  try { registerSummonAutopilotSetting(); } catch (e) { warn("registerSummonAutopilotSetting threw", e); }
});

// Register the public API on ready. The `FUCompanion.api` root is set up by
// the rest of the module's boot sequence; we attach an `experimental`
// namespace under it so the director never shadows production APIs.
Hooks.once("ready", () => {
  // Grappled rule #2: ending a Guard-cover when its guarder becomes Grappled.
  // Session-global, idempotent — install once here (path-independent of
  // fresh-start vs resume). See [[project_grappled_advanced_debuff]].
  installGrappledCoverWatcher();
  // Condition immunity/resistance for conditions applied INSIDE a battle by a
  // non-BD path (AEM UI, token-HUD, macros): IM blocks, RS reshapes into a
  // charge/turn-clamped BD condition so it expires. Only touches AEs whose
  // bearer has an explicit RS/IM affinity for that condition. Idempotent.
  // See [[project_condition_affinity]] / condition-adoption.js.
  installConditionAdoptionWatcher({ getActiveDirector });
  // Generic rider-AE linkage: an AE flagged `riderOf: "<parent>"` is removed
  // when its parent AE leaves the bearer (first consumer: Draconic Domination
  // riding Charmed). Session-global, idempotent. See [[reference_rider_ae_linkage]].
  installRiderAeLinkage();
  // Battle-End follow-up subsystem: register the entrance-animation socket on
  // every client, and register the ⭐ Wandering Flame ambush rule (GM evaluates
  // it). Idempotent. See [[battle-followup]].
  try { initWanderingFlameEntrance(); } catch (e) { warn("initWanderingFlameEntrance threw", e); }
  try { registerWanderingFlameAmbush(); } catch (e) { warn("registerWanderingFlameAmbush threw", e); }
  // Undying interception (Geist's Zero Power: The Blackest Night). The
  // builtin reactor is registered per-battle in start()/resume(); this
  // registers the BATTLE_ENDING rule + the cinematic's socket on every
  // client. See [[undying]].
  try { registerBlackestNight(); } catch (e) { warn("registerBlackestNight threw", e); }
  try { initBlackestNightCinematic(); } catch (e) { warn("initBlackestNightCinematic threw", e); }
  // Equipment Orbment system — dynamic import so it needs no module.json esmodules
  // entry (a hard reload picks it up; no Setup relaunch). Self-contained under
  // scripts/orbment/. See [[project_equipment_orbment]].
  import("../orbment/orbment-bootstrap.js")
    .then((m) => m.initOrbment())
    .catch((e) => warn("initOrbment failed to load", e));
  const root = (globalThis.FUCompanion = globalThis.FUCompanion ?? {});
  const api = (root.api = root.api ?? {});
  // Anim Studio preview surface — the Preview Bench (classic script) calls these
  // to run a skill/scratch animation through the real BD core without combat.
  const studio = (api.animStudio = api.animStudio ?? {});
  studio.preview = previewAnimation;
  studio.resolveSpec = resolveAnimationSpec;
  // Damage-number preview — fires the REAL production feedback (number + impact
  // + sound) on a token so the bench can show how a hit "feels" landing at the
  // animation's impact moment. Same path applyDamageToTarget drives in battle;
  // does NOT touch HP/MP (cosmetic only).
  studio.previewDamageVfx = (payload) => { try { playResourceLossVfx(payload); } catch (e) { warn("previewDamageVfx threw", e); } };
  const exp = (api.experimental = api.experimental ?? {});
  // Automated playtest harness (GM-only, dev). Runs a real hands-free battle and
  // reports how it went — see sim/sim-run.js. `sim.abort()` is the panic valve if
  // a run ever wedges. Phase 0: console-driven, one fight at a time.
  // `testSkill` FORCES a chosen combatant to cast a chosen skill in a live hands-free
  // battle (with optional forced dice) — the skill-under-test tool. `run({ scripts })`
  // is the general form. See sim/scripted-action.js + sim/sim-run.js.
  exp.sim = { run: simRun, testSkill: simTestSkill, abort: simAbort, mode: SimMode, journal: () => SimJournal.entries() };
  exp.battleDirector = {
    start,
    stop,
    status,
    isRunning,
    getActiveDirector,
    getSourceSceneId,
    // Rewind tool (GM-only). See [[director-rewind-tool-plan]].
    history,
    rewindTo,
    // Director-owned battle init pipeline (replaces the legacy Manager flow
    // when battleSystem === "director"). Called by the new "Director Manager"
    // macro after the user confirms the Battle Prompt.
    runDirectorInit,
    // Battle-End follow-up control (GM-only story gating). Flip an event on for
    // a story segment and off after. e.g.
    //   followups.setActive("wandering-flame-ambush", true)
    // See [[battle-followup]].
    followups: {
      setActive: (id, on) => setFollowupActive(id, on),
      isActive:  (id) => isFollowupActive(id),
      listActive: () => listActiveFollowups(),
      listRules: () => listFollowupRules().map((r) => ({
        id: r.id, label: r.label ?? "", priority: r.priority ?? 0,
      })),
      pity: (id) => getFollowupPity(id),
    },
    // Undying interception (boss revives — Geist's Blackest Night). GM
    // inspection + recovery: a stale pending claim would hijack the NEXT
    // battle's end, so clearPending() is the escape hatch. See [[undying]].
    undying: {
      pending: () => getPendingClaim(),
      clearPending: () => clearPendingClaim(),
      listRules: () => listUndyingRules().map((r) => ({ id: r.id, label: r.label ?? "" })),
      triggers: () => _instance?.ctx?._undyingTriggers ?? 0,
      // Dev: lean test battles revive inline (no cinematic) — flip this on to
      // preview the full fake-out from the Test Battle tool.
      forceCinematic: (on) => setForceCinematic(on),
      isForceCinematic: () => isForceCinematic(),
    },
    // Manual recovery — removes any tokens still flagged as director-spawned
    // on the given scene (or canvas.scene by default). Normally fires
    // automatically via stop(); exposed in case the auto-cleanup is bypassed.
    cleanupDirectorSpawnedTokens: (scene) => cleanupDirectorSpawnedTokens(scene ?? canvas?.scene),
    // Diagnostic access to the suppressor — call .snapshot() to see what's
    // currently neutralized; .isActive() returns true while a director is
    // running. Should not need manual suppress/restore in normal use.
    legacySuppressor: LegacySuppressor,
    // Player-driven input scaffolding. The IntentChannel singleton is
    // installed on every client at `ready` (below). See
    // [[director-player-driven-input]] for the migration plan.
    intentChannel: {
      get: () => getIntentChannel(),
      // GM → player ping. Resolves with { rtt, fromUserId, payload } or
      // rejects on timeout. Used to validate the socket round-trip
      // before wiring real surfaces.
      ping: (targetUserIdOrName, payload = null, opts = {}) => {
        const ch = getIntentChannel();
        const user = game.users?.get(targetUserIdOrName)
          ?? game.users?.find?.((u) => u.name === targetUserIdOrName);
        if (!user) throw new Error(`pingPlayer: user not found "${targetUserIdOrName}"`);
        return ch.ping(user.id, payload, opts);
      },
      // List online non-GM users (handy for picking a target in the
      // bridge test runner without having to know UUIDs).
      onlinePlayers: () => {
        return (game.users?.contents ?? [])
          .filter((u) => u.active && !u.isGM)
          .map((u) => ({ id: u.id, name: u.name }));
      },
    },
    // Free-action grant registry — singleton, accessed by:
    //   - skill-effects' open_action_menu free_mode (writer)
    //   - composeAction (reader; filters Octopath; injects checkBonus on
    //     pick; clears grant after action commits)
    // See [[free-actions]] for the grant shape + lifecycle.
    freeActions: (() => {
      try {
        // Dynamic import — keeps the boot graph linear (no circular import
        // through state-handlers). Module is self-contained; one-time load.
        return require?.("./free-actions.js")?.freeActions ?? null;
      } catch { return null; }
    })(),
    // UI surface registry — a queryable model of which director UI components
    // are on screen on THIS client. `list()` returns every tracked surface +
    // animation; `has(kind)` / `count(kind)` are quick checks. Subscribe to the
    // `fu-director-surface-change` hook for push updates. See director-surfaces.js.
    surfaces: {
      list: (filter) => getActiveSurfaces(filter),
      has: (kind) => hasSurface(kind),
      count: (kind) => countSurfaces(kind),
      clear: () => clearAllSurfaces(),
    },
    // Floating damage numbers (DOM screen-space subsystem). `emit` is the
    // GM-side entry — renders locally + broadcasts to all clients — and is the
    // drop-in replacement for the Sequencer scrollingText VFX (wired in Phase 1).
    // `renderLocal` renders on THIS client only (no broadcast) — used by the
    // audition tool. See damage-numbers/director-damage-numbers.js.
    damageNumbers: {
      emit: (payload) => emitDamageNumber(payload),
      renderLocal: (payload) => renderDamageNumberLocal(payload),
    },
    // Token hurt reaction (pseudo-animated flinch). `emit` = GM local + broadcast;
    // `renderLocal` = this client only. See damage-numbers/director-hurt-reaction.js.
    hurtReaction: {
      emit: (payload) => emitHurtReaction(payload),
      renderLocal: (payload) => playHurtReactionLocal(payload),
    },
    // Transient NPC HP bar. `emit` = production path (hostile + studied gates,
    // raw HP facts → fractions); `emitUnchecked` = gate-free fractions payload
    // (broadcasts — dev/preview); `renderLocal` = this client only. See
    // damage-numbers/director-hp-bar.js.
    npcHpBar: {
      emit: (payload) => emitNpcHpBar(payload),
      emitUnchecked: (payload) => emitNpcHpBarUnchecked(payload),
      renderLocal: (payload) => renderNpcHpBarLocal(payload),
    },
    // Re-broadcast the turn-action tracker from the live dCombat. Used by the
    // icon focal-point tuner to reflect a saved focus immediately mid-battle.
    refreshTurnActions: () => {
      const dc = _instance?.dCombat;
      if (dc) { try { bannerRefreshTurnActions(dc); } catch (e) { warn("refreshTurnActions API threw", e); } }
    },
    // ── Live roster (GM-only, dev) ───────────────────────────────────────
    // Add / remove / list combatants on a running battle without restarting.
    // Used by the Test Battle dev tool to switch the player/enemy or drop in
    // extra allies/enemies mid-fight. Spawned tokens carry the directorSpawned
    // flag, so the normal end-of-battle sweep removes them.
    listCombatants: () => {
      const dc = _instance?.dCombat;
      if (!dc?.started || dc.ended) return [];
      return (dc.combatants ?? []).map((c) => ({
        id: c.id, name: c.name, side: c.side, tokenUuid: c.tokenUuid,
        actorUuid: c.actorUuid, defeated: !!c.isDefeatedLive?.(),
        isCurrent: c.id === dc.currentCombatantId,
        hasToken: !!dc.scene?.tokens?.get(c.tokenId),
      }));
    },
    // Remove ghost combatants (token deleted out from under them). Returns the
    // count removed. Auto-runs on deleteToken too (see hook below).
    pruneGhostCombatants: () => {
      const dc = _instance?.dCombat;
      if (!dc?.started || dc.ended) return { ok: false, error: "no active battle" };
      const n = dc.pruneStaleCombatants();
      if (n) {
        try { bannerRefreshTurnActions(dc); } catch (_e) {}
        try { Hooks.callAll("fu-director-roster-changed", { dCombat: dc, change: "prune" }); } catch (_e) {}
        saveDirectorState(_instance, { skipHistory: true }).catch((e) => warn("prune: saveDirectorState failed", e));
      }
      return { ok: true, removed: n };
    },
    addCombatant: async ({ actorUuid, side } = {}) => {
      if (!game.user?.isGM) return { ok: false, error: "GM only" };
      const d = _instance, dc = d?.dCombat;
      if (!dc?.started || dc.ended) return { ok: false, error: "no active battle" };
      const actor = actorUuid ? await fromUuid(actorUuid) : null;
      if (!actor || actor.documentName !== "Actor") return { ok: false, error: "actor not found" };
      const sd = side === "enemy" ? "enemy" : "party";
      const disposition = sd === "enemy" ? -1 : 1;
      try {
        const [tokenDoc] = await spawnLiveDirectorTokens({ scene: dc.scene, actorUuids: [actor.uuid], disposition });
        if (!tokenDoc) return { ok: false, error: "token spawn failed" };
        // Use the TOKEN's own actor, not the base world actor we resolved
        // above. Enemy tokens spawn UNLINKED (director-init: actorLink=false),
        // so their live state lives in the token delta (synthetic actor). The
        // base world actor is shared across every unlinked copy. Keying the
        // combatant off the base actor makes the rewind snapshot/restore mutate
        // that shared actor — corrupting every token derived from it. This
        // mirrors buildDirectorCombat, which omits actorDoc so the constructor
        // defaults to tokenDoc.actor. For linked PCs tokenDoc.actor === actor.
        const c = dc.addCombatant({ tokenDoc, actorDoc: tokenDoc.actor ?? actor, side: sd, disposition });
        try { bannerRefreshTurnActions(dc); } catch (_e) {}
        try { Hooks.callAll("fu-director-roster-changed", { dCombat: dc, change: "add", combatantId: c.id }); } catch (_e) {}
        // Persist the roster change to the reload-survival flag immediately so the
        // new combatant isn't lost on F5 before the next FSM checkpoint save.
        // skipHistory: a mid-turn roster edit shouldn't push a rewind entry.
        saveDirectorState(d, { skipHistory: true }).catch((e) => warn("addCombatant: saveDirectorState failed", e));
        log(`live addCombatant: ${c.name} (${sd})`);
        return { ok: true, combatantId: c.id, tokenUuid: c.tokenUuid, name: c.name };
      } catch (e) {
        warn("addCombatant threw", e);
        return { ok: false, error: String(e?.message ?? e) };
      }
    },
    removeCombatant: async ({ combatantId, tokenUuid } = {}) => {
      if (!game.user?.isGM) return { ok: false, error: "GM only" };
      const d = _instance, dc = d?.dCombat;
      if (!dc?.started || dc.ended) return { ok: false, error: "no active battle" };
      const c = combatantId
        ? dc.findById(combatantId)
        : (dc.combatants ?? []).find((x) => x.tokenUuid === tokenUuid);
      if (!c) return { ok: false, error: "combatant not found" };
      try {
        const removed = dc.removeCombatantById(c.id);
        const td = removed?.tokenDoc;
        if (td?.id && td.parent) {
          try { await td.parent.deleteEmbeddedDocuments("Token", [td.id]); } catch (e) { warn("removeCombatant: token delete threw", e); }
        }
        try { bannerRefreshTurnActions(dc); } catch (_e) {}
        try { Hooks.callAll("fu-director-roster-changed", { dCombat: dc, change: "remove", combatantId: c.id }); } catch (_e) {}
        // A removal (leave_combat / destroy_summon / banish / defeat-removal) can
        // empty a side with no HP event to trip the wipe watcher — re-check here so
        // "last enemy fled" / "last enemy shattered" ends the battle (gap B).
        try { checkSideWipe(d); } catch (e) { warn("removeCombatant: checkSideWipe threw", e); }
        saveDirectorState(d, { skipHistory: true }).catch((e) => warn("removeCombatant: saveDirectorState failed", e));
        log(`live removeCombatant: ${c.name}`);
        return { ok: true, removedId: c.id, name: c.name };
      } catch (e) {
        warn("removeCombatant threw", e);
        return { ok: false, error: String(e?.message ?? e) };
      }
    },
    // ── Dev state controls (GM-only) ─────────────────────────────────────
    // Manual FSM nudges for testing — drive the battle forward without playing
    // out every turn. All operate on the live director instance; no-op (with a
    // reason) when no battle is running. Used by the Battle State dev tool.
    //
    // A compact read of the current state for a tool's status line.
    stateInfo: () => {
      const d = _instance, dc = d?.dCombat;
      if (!dc || !dc.started || dc.ended) return { running: false };
      return {
        running: true,
        round: dc.round ?? 0,
        currentSide: dc.currentSide === "enemy" ? "Enemies" : "Party",
        current: dc.current?.name ?? null,
        fsmState: d.state ?? null,
        combatants: (dc.combatants ?? []).map((c) => ({
          name: c.name, side: c.side, turnsRemaining: c.turnsRemaining,
          turnsPerRound: c.turnsPerRound, defeated: !!c.isDefeatedLive?.(),
        })),
      };
    },
    // Skip the current turn — route straight through TURN_END (which advances
    // the turn / flips side, wrapping the round only if all turns are spent).
    forceNextTurn: async () => {
      if (!game.user?.isGM) return { ok: false, error: "GM only" };
      const d = _instance;
      if (!d?.dCombat?.started || d.dCombat.ended) return { ok: false, error: "no active battle" };
      try { await d.transitionTo(STATES.TURN_END); return { ok: true, round: d.dCombat.round }; }
      catch (e) { warn("forceNextTurn threw", e); return { ok: false, error: String(e?.message ?? e) }; }
    },
    // End the current round + advance to the next: zero everyone's remaining
    // turns so TURN_END's nextTurn() wraps the round (round++ → ROUND_START
    // banner → next-turn picker).
    forceNextRound: async () => {
      if (!game.user?.isGM) return { ok: false, error: "GM only" };
      const d = _instance;
      if (!d?.dCombat?.started || d.dCombat.ended) return { ok: false, error: "no active battle" };
      for (const c of d.dCombat.combatants) c.turnsRemaining = 0;
      try { await d.transitionTo(STATES.TURN_END); return { ok: true, round: d.dCombat.round }; }
      catch (e) { warn("forceNextRound threw", e); return { ok: false, error: String(e?.message ?? e) }; }
    },
    // Refill every un-defeated combatant's turns for the CURRENT round (re-run
    // a round without advancing). Updates the turn-action HUD.
    refillRoundTurns: () => {
      if (!game.user?.isGM) return { ok: false, error: "GM only" };
      const d = _instance;
      if (!d?.dCombat?.started || d.dCombat.ended) return { ok: false, error: "no active battle" };
      for (const c of d.dCombat.combatants) c.turnsRemaining = c.isDefeatedLive?.() ? 0 : c.turnsPerRound;
      try { bannerRefreshTurnActions(d.dCombat); } catch (e) { warn("refillRoundTurns refresh threw", e); }
      return { ok: true };
    },
    // ── Animation control ────────────────────────────────────────────────
    // Abort the currently playing animation so the FSM advances to RESOLVE
    // immediately. Safe to call when no animation is playing — dispatches
    // SKIP_ANIMATION which the table drops if the FSM is past ANIMATION.
    skipAnimation: () => {
      const d = _instance;
      if (!d) return { ok: false, error: "no battle running" };
      d.skipAnimation();
      return { ok: true };
    },
    // Returns { playing: true } while the ANIMATION state is gating.
    isAnimationPlaying: () => ({ playing: !!_instance?.isAnimationPlaying }),

    // Expose constructor + handlers for advanced debugging
    _BattleDirector: BattleDirector,
    _STATE_HANDLERS: STATE_HANDLERS,
    // Debug: compute the live eligible-enemy list for the current (or first
    // party) combatant, exposing why an enemy might be filtered out.
    _debugEligible: () => {
      const dc = _instance?.dCombat;
      if (!dc?.started || dc.ended) return { err: "no battle" };
      const cur = dc.current ?? dc.combatants.find((c) => c.side === "party") ?? null;
      if (!cur) return { err: "no attacker" };
      let snap = null;
      try { snap = snapshotDirectorCombatant(cur); } catch (e) { return { err: "snap threw: " + (e?.message ?? e) }; }
      let enemies = [];
      try { enemies = snapshotEligibleTargetsFromDCombat(dc, snap, { category: "enemy" }); } catch (e) { return { err: "eligible threw: " + (e?.message ?? e), attackerDisp: snap?.disposition }; }
      return {
        attacker: { name: snap?.name, disposition: snap?.disposition, combatantId: snap?.combatantId },
        currentSet: !!dc.current,
        combatants: dc.combatants.map((c) => ({ name: c.name, side: c.side, disp: c.disposition, hasActor: !!c.actorDoc, hasToken: !!c.tokenDoc })),
        enemyCount: enemies.length,
        enemyNames: enemies.map((e) => e.name),
      };
    },
  };

  // Wire battleEndManager on the module's top-level API so the sword-button in
  // combat-button-installer.js picks it up without falling back to the legacy macro.
  //
  // The prompt is shown HERE, outside the FSM, so gameplay is completely unaffected
  // until the GM confirms. Cancel → zero side effects, battle continues. Confirm →
  // store promptResult on ctx, set endOfCombat, enqueue ABORT; the FSM routes
  // ABORTED → BATTLE_ENDING where the sequence picks up the pre-filled result and
  // skips its own prompt step.
  const _mod = game.modules.get("fabula-ultima-companion");
  if (_mod) {
    _mod.api = _mod.api ?? {};
    _mod.api.battleEndManager = async () => {
      const d = _instance;
      if (d?.state === STATES.BATTLE_ENDING) {
        return { ok: false, error: "Battle end already in progress" };
      }
      if (!d?.dCombat?.started || d.dCombat.ended) {
        return { ok: false, error: "No active BD battle" };
      }
      if (d.ctx.battleEndPromptOpen) {
        return { ok: false, error: "Battle end prompt already open" };
      }

      // Build the minimal endCtx the prompt needs from current live director state.
      const dc = d.dCombat;
      const combatants = dc?.combatants ?? [];
      const enemies = combatants.filter(c => c.side === "enemy");
      const party  = combatants.filter(c => c.side === "party");
      const detectedOutcome = (
        party.length > 0 && party.every(c => c.isDefeatedLive?.()) &&
        !(enemies.length > 0 && enemies.every(c => c.isDefeatedLive?.()))
      ) ? "defeat" : "victory";

      const _bdSnap = (() => {
        try { return game.settings.get("fabula-ultima-companion", "bdRewardSnapshot") ?? {}; }
        catch { return {}; }
      })();

      const promptEndCtx = {
        outcome:      detectedOutcome,
        sourceSceneId: dc?.sourceSceneId ?? null,
        partyActorIds: party.map(c => c.actorDoc?.id).filter(Boolean),
        defaultRewards: {
          expByActorId:   _bdSnap.expByActorId   ?? {},
          zenitByActorId: _bdSnap.zenitByActorId ?? {},
        },
      };

      // Show the prompt — FSM keeps running normally while GM decides.
      d.ctx.battleEndPromptOpen = true;
      let promptResult;
      try {
        promptResult = await showBattleEndPrompt(promptEndCtx);
      } finally {
        d.ctx.battleEndPromptOpen = false;
      }

      if (!promptResult?.ok) {
        return { ok: false, cancelled: true };
      }

      // GM confirmed — now commit: actively interrupt all blocking UIs so
      // the FSM dispatch lock is freed before ABORT is processed.
      d.ctx.battleEndPromptResult = promptResult;
      d.ctx.endOfCombat = true;
      TurnPicker.despawn({ director: d });               // unblocks TURN_START (resolves show() promise → null)
      d.ctx._composeCancelToken?.cancel?.("battle-end"); // unblocks DECLARE (compose → { cancelled: true })
      d._signalBattleEnd();                              // unblocks SRW (resolves all dispatchReactionMenu closed promises)
      d.enqueue({ type: INTENTS.ABORT });
      return { ok: true };
    };
  }

  // Auto-prune ghost combatants: if a token is deleted while a director battle
  // is live, drop its combatant so it never lingers as a target with no token
  // on the canvas. Self-skips during the api.removeCombatant path (combatant
  // already gone) and at battle end (dCombat ended).
  Hooks.on("deleteToken", (tokenDoc) => {
    try {
      const dc = _instance?.dCombat;
      if (!dc?.started || dc.ended) return;
      if (tokenDoc?.parent?.id !== dc.scene?.id) return;
      const c = dc.combatants.find((x) => x.tokenId === tokenDoc.id);
      if (!c) return;
      dc.removeCombatantById(c.id);
      try { bannerRefreshTurnActions(dc); } catch (_e) {}
      try { Hooks.callAll("fu-director-roster-changed", { dCombat: dc, change: "token-deleted", combatantId: c.id }); } catch (_e) {}
      log(`deleteToken: pruned ghost combatant ${c.name}`);
    } catch (e) { warn("deleteToken prune threw", e); }
  });

  // Equip lifecycle → gear `_skill` reactions. When a gear shell's `isEquipped`
  // flips during a live battle, dispatch creature_equips_item / creature_unequips_item
  // to the wearer so a gear `_skill` can arm / clean up its own state declaratively
  // (Apple o' Archer: arm the ranged-taunt aura on equip, remove it on unequip).
  // Force-only (no menu). GM-only + in-combat — out of combat, battle-start arming +
  // the taunt reader's source-equipped safety-net cover it. The unequip trigger
  // reaches the just-removed item's `_skill` via the containerReactionInPlay bypass
  // (payload.unequippedItemUuid), since isEquipped is already false by now.
  Hooks.on("updateItem", async (item, changes) => {
    try {
      if (!game.user?.isGM) return;
      const eqChange = changes?.system?.props?.isEquipped;
      if (eqChange === undefined) return;
      const GEAR = new Set(["accessory", "armor", "weapon", "shield"]);
      if (!GEAR.has(String(item.system?.props?.item_type ?? "").toLowerCase())) return;
      const actor = item.parent;
      if (!actor || actor.documentName !== "Actor") return;
      const director = _instance;
      const dc = director?.dCombat;
      if (!dc?.started || dc.ended) return; // in-combat only
      const isCombatant = (dc.combatants ?? []).some(
        (c) => c?.actorDoc?.uuid === actor.uuid || c?.actorUuid === actor.uuid,
      );
      if (!isCombatant) return;
      const token = canvas?.tokens?.placeables?.find((t) => t.actor?.uuid === actor.uuid) ?? null;
      if (!token) return;
      const trigger = eqChange ? "creature_equips_item" : "creature_unequips_item";
      const { dispatchReactionMenu } = await import("./standalone-reactions.js?cb=" + Date.now());
      await dispatchReactionMenu({
        director, reactor: actor, token, trigger,
        payload: {
          trigger, unequippedItemUuid: item.uuid, equippedItemUuid: item.uuid,
          sourceActorUuid: null, round: dc.round ?? null,
        },
        scope: null, scene: null, phase: "forced",
      });
    } catch (e) { warn("equip-lifecycle reaction dispatch threw", e); }
  });

  // Async-load freeActions onto the api surface (require isn't available
  // in ESM; the eager-loaded value above is a stub fallback). The async
  // path is the real wire.
  import("./free-actions.js").then((m) => {
    exp.battleDirector.freeActions = m.freeActions;
  }).catch((e) => warn("director-boot: free-actions import failed", e));
  log("Battle Director API registered at FUCompanion.api.experimental.battleDirector");

  // Install the IntentChannel singleton on EVERY client (not just GM).
  // Players need it to receive MENU_OPEN broadcasts and to reply to PINGs;
  // GM uses it for INTENT receipt + MENU_OPEN broadcast. Idempotent —
  // calling install() twice is a no-op.
  try {
    getIntentChannel().install();

    // Wire up per-surface MENU_OPEN handlers on ALL clients (GM + players).
    // The primary GM (the one that called start() and owns _instance) skips
    // each handler via the `isActiveDirector` guard — it spawns those surfaces
    // locally in state-handlers rather than via socket. Secondary GMs and
    // players both receive broadcasts and need these handlers.
    const _isActiveDirector = () => !!_instance;

    // Compose-action — run the full pick chain locally (Octopath → weapon
    // mode → target picker) and emit ACTION_COMPOSED with the bundle.
    // See [[director-player-driven-input]].
    registerPlayerComposeActionHandler(getIntentChannel(), _isActiveDirector);
    // Action-card mirror — render the GM's card on this client; owner
    // sees interactive buttons, observers see read-only.
    registerPlayerActionCardHandler(getIntentChannel(), _isActiveDirector);
    // Turn picker — show "Take Action" pills so the recipient can pick
    // which eligible combatant acts next on the current side.
    registerPlayerTurnPickerHandler(getIntentChannel(), _isActiveDirector);
    // Reaction menu — spawn the token-anchored menu for owned reactor +
    // emit REACTION_CHOICE back to the GM on click.
    // See [[reaction-menu-on-token]] §5 + [[reaction-architecture]] Rule 1.
    registerPlayerReactionMenuHandler(getIntentChannel(), _isActiveDirector);
    // Die-swap picker — spawn the pre-roll Attribute-die swap picker
    // (Psychokinesis et al.) for the acting owner + emit DIE_SWAP_PICKED back.
    registerPlayerDieSwapHandler(getIntentChannel(), _isActiveDirector);
    // Soul Steal result — render the broadcast loot-result panel; the action
    // owner gets a working close, spectators see it read-only.
    registerPlayerSoulStealHandler(getIntentChannel(), _isActiveDirector);
    // Remote pick responder — render a reaction's secondary picker (Protect
    // target / add-target / option-menu) routed to THIS client + emit
    // REMOTE_PICK_RESULT back. See remote-pick.js + [[director-player-driven-input]].
    registerRemotePickResponder(getIntentChannel());

    // Catch-all observer for any other surface kinds we haven't wired
    // up yet (future kinds). Primary GM skips — it never receives its
    // own broadcasts.
    getIntentChannel().onMenuOpen((menuSpec) => {
      if (_isActiveDirector()) return;
      const wired = new Set(["compose-action", "action-card", "action-card-pill-update", "action-card-body-update", "action-card-target-mutation", "turn-picker", "reaction-menu", "reaction-indicator", "turn-action-indicator", "die-swap", "soul-steal-result"]);
      if (!wired.has(menuSpec?.kind)) {
        log(`[non-primary] MENU_OPEN (unwired kind): ${menuSpec?.kind ?? "?"}`, menuSpec);
      }
    });
    getIntentChannel().onMenuClose((payload) => {
      if (_isActiveDirector()) return;
      log(`[non-primary] MENU_CLOSE: kind=${payload?.kind ?? "?"} reason=${payload?.reason ?? "?"}`);
    });

    // Announce ready to GM AFTER all handlers are attached (players only).
    // Secondary GMs don't need replay — they're present when the director
    // starts and the primary GM broadcasts directly to them at turn time.
    if (!game.user?.isGM) {
      try { getIntentChannel().announceReady(); }
      catch (e) { warn("announceReady threw", e); }

      // Re-announce on socket RECONNECT so the GM replays any MENU_OPEN we
      // missed while our socket was down. A transient socket.io reconnect
      // (network blip / laptop sleep-wake / Wi-Fi drop) auto-reconnects
      // WITHOUT reloading the page, so the one-shot Hooks.once("ready")
      // announceReady above never re-fires. Without this, a player whose
      // connection dropped while (or just before) a menu was broadcast for
      // them — e.g. their turn's compose-action or a pre_activate element
      // pick — reconnects to NO menu and is stuck (the spec sits unreplayed
      // in the GM's _recentBroadcasts cache). socket.io fires "connect" on
      // every reconnection; the initial connect already happened before this
      // listener is wired, so it only fires on genuine reconnects (no double
      // announce). Defer briefly so Foundry finishes its own session/world
      // resync first. Idempotent: same-requestId replays are de-duped on the
      // player side (see registerRemotePickResponder), so a still-open picker
      // is not duplicated when nothing was actually missed.
      try {
        game.socket?.on("connect", () => {
          setTimeout(() => {
            try {
              log("IntentChannel: socket reconnected — re-announcing ready for menu resync");
              getIntentChannel().announceReady();
            } catch (e) { warn("announceReady (reconnect) threw", e); }
          }, 750);
        });
      } catch (e) { warn("reconnect re-announce wiring threw", e); }
    }
  } catch (e) {
    warn("IntentChannel install on ready threw", e);
  }

  // Director-native critical cut-in — register its socketlib handlers on
  // EVERY client (GM + players) so a broadcast crit cut-in renders for all.
  // Self-contained; no dependency on the legacy cut-in system.
  try { initDirectorCutin(); }
  catch (e) { warn("initDirectorCutin on ready threw", e); }

  // Director-native start-of-round banner — same all-clients registration.
  try { initDirectorRoundBanner(); }
  catch (e) { warn("initDirectorRoundBanner on ready threw", e); }

  // Battle-init eye-catcher loader — registered on every client so the GM can
  // broadcast the "PREPARING BATTLE…" flourish that covers the scene-activate
  // + asset-preload pause behind the curtain.
  try { initDirectorBattleLoader(); }
  catch (e) { warn("initDirectorBattleLoader on ready threw", e); }

  // Director per-client broadcast channel (SFX + sidebar collapse) — registered
  // on every client so the GM-side director can fan cues / UI sync out to all.
  try { initDirectorSfx(); }
  catch (e) { warn("initDirectorSfx on ready threw", e); }

  // Passive Card UI — registers socket handler on every client so all players
  // see the token-anchored passive trigger card when a passive auto-fires.
  try { initPassiveCardUi(); }
  catch (e) { warn("initPassiveCardUi on ready threw", e); }

  // Developer Tools launcher — single bottom-left button (above the Players
  // list) that bundles the dev tools below; each registers itself into it.
  try { initDevToolsMenu(); }
  catch (e) { warn("initDevToolsMenu on ready threw", e); }

  // Anim Studio — Preview Bench, registered into the Developer Tools launcher
  // (moved off the Foundry scene-controls toolbar). The bench itself links to
  // the SFX Browser + Brief Builder.
  try {
    registerDevTool({
      id: "anim-studio",
      icon: "🎞️",
      label: "Anim Studio — Preview Bench",
      onClick: () => globalThis.FUCompanion?.api?.animStudio?.openBench?.(),
    });
  } catch (e) { warn("registerDevTool(anim-studio) on ready threw", e); }

  // Enemy Autopilot toggle button (registers into the Developer Tools launcher).
  try { registerAutopilotDevTool(); }
  catch (e) { warn("registerAutopilotDevTool on ready threw", e); }

  // Summon Autopilot toggle button (sits beside the enemy one in the launcher).
  try { registerSummonAutopilotDevTool(); }
  catch (e) { warn("registerSummonAutopilotDevTool on ready threw", e); }

  // SFX audition tool — registers into the Developer Tools launcher.
  try { initSfxAudition(); }
  catch (e) { warn("initSfxAudition on ready threw", e); }

  // Floating damage-number subsystem — registers its socketlib handler on every
  // client so the GM-side director can broadcast a hit/heal/miss number that
  // renders on all screens. (Phase 0: engine + audition only; the skill-effects
  // call sites still fire the legacy Sequencer VFX until Phase 1 repoints them.)
  try { initDamageNumbers(); }
  catch (e) { warn("initDamageNumbers on ready threw", e); }

  // BD-native impact VFX (DOM <video> overlay) — registers its socketlib handler
  // on every client so the GM-side hit/heal/absorb impact bursts render on all
  // screens. Replaces Sequencer's .effect() webm bursts for combat feedback.
  try { initImpactFx(); }
  catch (e) { warn("initImpactFx on ready threw", e); }

  // BD-native token hurt reaction (pseudo-animated DOM clone flinch) — registers
  // its socketlib handler on every client. Phase 0: engine + audition only; the
  // live loss path doesn't call it yet.
  try { initHurtReaction(); }
  catch (e) { warn("initHurtReaction on ready threw", e); }

  // Transient NPC HP bar — registers its socketlib handler on every client so
  // the GM-side damage/heal seams can slide a condition bar under a studied
  // hostile NPC's token on all screens.
  try { initNpcHpBar(); }
  catch (e) { warn("initNpcHpBar on ready threw", e); }

  // HP Bar Tuner (damage-numbers/hp-bar-tuner.js) is intentionally NOT loaded
  // at startup — the GM-tuned values are baked into TUNING_DEFAULTS. To re-tune,
  // load it on demand from the console:
  //   (await import("/modules/fabula-ultima-companion/scripts/battle-director/damage-numbers/hp-bar-tuner.js")).initHpBarTuner()
  // then open Developer Tools → "HP bar tuner".

  // Boss Domination VFX — socketlib handlers (energy burst, Escape fade) +
  // the AE-driven red outline watcher, on every client.
  try { initDominationFx(); }
  catch (e) { warn("initDominationFx on ready threw", e); }

  // Dominance Crest — floating boss emblem showing banked Dominance Point(s),
  // AE-replication-driven on every client.
  try { initDominationCrest(); }
  catch (e) { warn("initDominationCrest on ready threw", e); }

  // Damage-number dev tool — consolidated to a SINGLE button (the robust
  // live-path version below). The look-only audition tool
  // (initDamageNumberAudition) is intentionally NOT registered as its own
  // button to save space; its renderer is still available via the API.
  //
  // Damage FX live-path tool — fires the REAL director-vfx functions (number +
  // impact + SFX + broadcast) on the selected token. This is the one button.
  try { initDamageNumberLivetest(); }
  catch (e) { warn("initDamageNumberLivetest on ready threw", e); }

  // Director UI sound layer — delegated hover/click cues on all interactive
  // director surfaces (Legacy parity: BattleCursor_4 hover + switch_mode click).
  try { initDirectorUiSfx(); }
  catch (e) { warn("initDirectorUiSfx on ready threw", e); }

  // Keyword smart-suggestion — GM-only ProseMirror autocomplete that suggests
  // registry keywords/statuses as you type in any rich-text editor and inserts
  // the content-link. Independent of the Active Effect key-suggestion script
  // (different hook + surface).
  try { initKeywordSuggest(); }
  catch (e) { warn("initKeywordSuggest on ready threw", e); }

  // Director UI surface registry — DOM observer that tracks which director UI
  // components are on screen, per client. Queryable via the surfaces API.
  try { initDirectorSurfaces(); }
  catch (e) { warn("initDirectorSurfaces on ready threw", e); }

  // Icon focal-point tuner — GM button to set a per-actor crop focus for the
  // turn-action tracker icons (frame the face, not the ears).
  try { initIconFocusTuner(); }
  catch (e) { warn("initIconFocusTuner on ready threw", e); }

  try { initBattleStateTool(); }
  catch (e) { warn("initBattleStateTool on ready threw", e); }

  // Test Battle tool — GM panel to launch a lean live battle with hand-picked
  // participants (real/class-test player, real/dummy enemy, ally, extra enemies).
  try { initTestBattleTool(); }
  catch (e) { warn("initTestBattleTool on ready threw", e); }

  // Auto-Playtest (sim) — GM panel to run a hands-free battle and read a verdict.
  try { initSimPanel(); }
  catch (e) { warn("initSimPanel on ready threw", e); }

  // Director entrance renderer — registered on every client so the GM can
  // broadcast the party run-in dash + enemy fade to all screens.
  try { initDirectorEntrance(); }
  catch (e) { warn("initDirectorEntrance on ready threw", e); }

  // Warm-decode the director's short SFX cues during idle after load. The
  // battle-start transition fires at the very top of PREP — before the
  // per-battle preload step — so without a boot-time warm the FIRST battle of
  // a session would still pay its fetch+decode. decodeAudioData works on a
  // suspended AudioContext (no user gesture needed yet), so this is safe at
  // boot. Deferred + fire-and-forget so it never delays `ready`.
  try {
    setTimeout(() => { preloadDirectorSfx().catch(() => {}); }, 4000);
  } catch (e) { warn("boot preloadDirectorSfx schedule threw", e); }

  // ── Director-native passive dispatcher for legacy reaction events ───
  //
  // The legacy reaction-window emits `oni:reactionPhase` events for many
  // triggers the director cares about (creature_performs_check,
  // creature_fumbles_check, creature_recovers_hp, etc.). Director-native
  // skills + AE-bound reactionConfig blobs both consume the same trigger
  // keys, so we bridge: GM-side, on every `oni:reactionPhase` whose
  // trigger key the director should respond to, call
  // `firePassiveTriggers` on the subject actor. Walks BOTH items and
  // AEs (see firePassiveTriggers in skill-effects.js).
  //
  // Triggers fired from Skill RESOLVE (`creature_completes_spell`) are
  // dispatched directly by state-handlers and don't pass through this
  // bridge — listing them here would double-fire. The canonical set
  // lives in `./director-triggers.js` (Gap 4 from canon hardening).
  Hooks.on("oni:reactionPhase", async (payload) => {
    try {
      if (!game.user?.isGM) return;
      // Secondary GM: director runs on another client — skip to prevent
      // double-firing passive triggers from two GM sockets.
      if (!_instance) return;
      const trigger = payload?.trigger;
      if (!trigger || !LEGACY_BRIDGED_TRIGGERS.has(trigger)) return;
      // Resolve subject actor. The legacy payload uses `actorUuid` (some
      // emit sites) or carries an `actor` directly; tolerate both.
      let actor = payload.actor ?? null;
      if (!actor && payload.actorUuid) {
        actor = await fromUuid(payload.actorUuid).catch(() => null);
      }
      if (!actor) return;
      await firePassiveTriggers({
        director: _instance ?? null,
        casterActor: actor,
        trigger,
        payload,
      });
      // Causer-aware dispatch: some bridged triggers (creature_check_adjusted)
      // carry a `causerActorUuid` distinct from the subject — e.g. an observer
      // who rerolled someone else's check. firePassiveTriggers above only scans
      // the SUBJECT, so a causer-keyed reaction (CHECK_ADJUSTED_BY_ME) on the
      // causer would be missed. Fire a second pass on the causer when it differs.
      const causerUuid = payload?.causerActorUuid;
      if (causerUuid && causerUuid !== actor.uuid) {
        const causerDoc = await fromUuid(causerUuid).catch(() => null);
        const causerActor = causerDoc?.actor ?? (causerDoc?.documentName === "Actor" ? causerDoc : null);
        if (causerActor) {
          await firePassiveTriggers({
            director: _instance ?? null,
            casterActor: causerActor,
            trigger,
            payload,
          });
        }
      }
    } catch (e) { warn(`oni:reactionPhase bridge (${payload?.trigger}) threw`, e); }
  });

  // Auto-resume mid-combat reloads. PRIMARY-GM-only — the director is GM-side
  // authoritative and MUST have exactly one host. The saved director state is a
  // world-scope scene flag every GM can read, so gating this on `isGM` alone
  // made BOTH GM clients mount their own `_instance` on an F5/world reload with
  // two GMs connected — two FSMs driving the same combat, racing document
  // writes / defeat removal / crisis AEs / saveDirectorState. A second (Co-DM)
  // GM must edit data, not drive the director, so it falls through to the same
  // local banner-only self-restore as a player (no mount, no broadcast). We
  // pick the single host via `isPrimaryGM()` (core `game.users.activeGM`, the
  // lowest-id active GM), the same dedupe idiom used by derived-status-reactor.
  // Wrapped in setTimeout so the API registration completes first; if
  // resume throws, the rest of the module is still usable.
  const _amPrimaryGM = () =>
    globalThis.FUCompanion?.isPrimaryGM ? globalThis.FUCompanion.isPrimaryGM() : !!game.user?.isGM;
  if (_amPrimaryGM()) {
    setTimeout(() => {
      try {
        const found = findSavedDirectorState();
        if (found) {
          // Reloading back INTO an active battle — collapse the Foundry sidebar
          // locally so the battlefield gets the full screen again, matching the
          // battle-start transition.
          //
          // Timing: collapse AFTER resumeFromSavedState settles the scene/canvas
          // (+ one frame). At ready+setTimeout(0) the sidebar is still being
          // rendered/expanded by Foundry's own init, so an early collapse() gets
          // clobbered — which is why it stuck at battle-start (post-click) but
          // not on reload. Local-only: this client reloaded; other clients are
          // untouched. Done here (not inside resumeFromSavedState) because that
          // path is shared with rewind, which shouldn't re-collapse mid-battle.
          // Collapse the Foundry sidebar locally now we're reloading into an
          // active battle. Event-driven via Foundry's own `renderSidebar` hook
          // (its real "the sidebar drew" signal) instead of polling on width:
          // on reload the sidebar isn't laid out when `ready` fires, and the
          // app re-renders a few times during startup — those re-draws are what
          // reverted an early one-shot collapse. So we collapse after each
          // render until it sticks, then unhook. One immediate attempt covers
          // the case where it already rendered before this ran. We read
          // collapsed-state from `ui.sidebar.expanded` when available (falling
          // back to width only if that property is absent). Local + GM-only;
          // ui.sidebar.collapse() is collapse-only so repeats are harmless.
          {
            const isCollapsed = () => {
              if (typeof ui.sidebar?.expanded === "boolean") return !ui.sidebar.expanded;
              const el = document.getElementById("sidebar");
              return !!el && el.offsetWidth > 0 && el.offsetWidth < 100;
            };
            const collapseUntilStuck = () => {
              if (isCollapsed()) { Hooks.off("renderSidebar", collapseUntilStuck); return; }
              try { collapseSidebarLocal(); }
              catch (e) { warn("Auto-resume: sidebar collapse threw", e); }
            };
            Hooks.on("renderSidebar", collapseUntilStuck);
            requestAnimationFrame(collapseUntilStuck); // already-rendered case
            // Safety: stop listening once startup has settled.
            setTimeout(() => Hooks.off("renderSidebar", collapseUntilStuck), 15000);
          }

          resumeFromSavedState(found).catch((e) => warn("Auto-resume threw", e));
        }
      } catch (e) {
        warn("Auto-resume detection threw", e);
      }
    }, 0);
  } else {
    // NON-HOST reload (a player OR a secondary/Co-DM GM): the primary GM is
    // authoritative and won't re-broadcast just because someone else reloaded,
    // so the round HUD would stay blank. Self-restore it LOCALLY from the
    // persisted scene flag (no director mount, no broadcast) — a secondary GM
    // sees the battle state but never becomes a second host.
    setTimeout(() => {
      try {
        const found = findSavedDirectorState();
        if (found?.state) {
          showRoundBannerForResumeFromState(found.state, { animate: false })
            .catch((e) => warn("Player banner self-restore threw", e));
        }
      } catch (e) {
        warn("Player banner self-restore detection threw", e);
      }
    }, 0);
  }
});
