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
import { STATE_HANDLERS, installGuardHpWatcher } from "./state-handlers.js";
import { STATES } from "./states.js";
import { getIntentChannel, attachDirector, detachDirector } from "./intent-channel.js";
import { TurnUI } from "./turn-ui.js";
import { registerPlayerComposeActionHandler } from "./compose-action.js";
import { registerPlayerActionCardHandler } from "./action-card.js";
import { TurnPicker, registerPlayerTurnPickerHandler } from "./turn-picker.js";
import { WeaponModePicker } from "./weapon-mode-picker.js";
import { AttributePairPicker } from "./attribute-pair-picker.js";
import { BattlefieldActionCard } from "./action-card.js";
import * as LegacySuppressor from "./legacy-suppressor.js";
import { runDirectorInit, cleanupDirectorSpawnedTokens } from "./director-init.js";
import { initDirectorCutin } from "./director-cutin.js";
import { sweepTransientAEsAtSceneEnd, firePassiveTriggers } from "./skill-effects.js";
import { LEGACY_BRIDGED_TRIGGERS } from "./director-triggers.js";
import { PassiveManager } from "./passive-manager.js";
import { freezeActionResult, snapshotDirectorCombatant } from "./snapshot.js";
import {
  findSavedDirectorState,
  reconstructDirectorCombat,
  clearDirectorStateFlag,
  clearAllDirectorStateFlags,
  installItemDeletionTracker,
  getHistory,
  findHistorySnapshot,
  rewindToHistorySnapshot,
} from "./persistence.js";
// Test harness — side-effect import (registers
// FUCompanion.api.test.runDirectorSkillCompute on the "ready" hook).
// Doesn't add behavior to the live director; lets the test bridge
// drive skill COMPUTE for autonomous regression checks.
import "./_test-harness-director.js";

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
  try { TurnUI.despawnAll(); } catch {}
  try { TurnPicker.despawnAll(); } catch {}
  try { WeaponModePicker.despawnAll(); } catch {}
  try { AttributePairPicker.despawnAll(); } catch {}
  try { BattlefieldActionCard.despawnAll(); } catch {}
  try { PassiveManager.despawn(); } catch {}

  // Broadcast MENU_CLOSE to every online non-GM client so any player-side
  // mirror overlays (action-card mirror, compose-action local Octopath /
  // pickers) tear down too. The per-state onExit/onAbort that normally
  // sends these doesn't run on End-Battle-mid-CONFIRM — director.stop()
  // calls the current state's onAbort which doesn't exist for CONFIRM,
  // so player overlays would otherwise linger forever.
  // Passing no `kind` matches both registered close handlers
  // (action-card + compose-action) — see their `if (payload?.kind && ...)` gates.
  try {
    const channel = getIntentChannel();
    const onlinePlayers = (game.users?.contents ?? []).filter((u) => u.active && !u.isGM);
    for (const u of onlinePlayers) {
      try {
        channel.broadcastMenuClose({
          targetUserId: u.id,
          reason: `director-stop:${reason}`,
        });
      } catch (e) { warn(`stop: broadcastMenuClose to ${u.name} threw`, e); }
    }
  } catch (e) { warn("stop: player-mirror MENU_CLOSE sweep threw", e); }

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
  ui.notifications?.info("Battle Director stopped.");
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
async function resumeFromSavedState({ scene, state, suppressNextHistoryPush = false }) {
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
  // Rewind tool: same reasoning — re-install the item-deletion tracker
  // on the resume path so the rewind history's deletedItemsLog keeps
  // getting populated post-reload.
  installItemDeletionTracker(director);

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

  // Rewind-path opt-in: suppress the history push from the FIRST save
  // fired by the resumed state's onEnter. Without this, every rewind to
  // a snapshot adds another duplicate entry at that snapshot — rewinding
  // 3× to "Round 2 · Hina Turn Start" would leave 3 identical rows in
  // the rewind list. Read-and-clear in `saveDirectorState`.
  if (suppressNextHistoryPush) {
    director.ctx._suppressNextHistoryPush = true;
  }

  // Branch on what the survival flag is pointing at:
  //   - pendingAction set (F5 happened with an Action Card on-screen) →
  //     restore actionResult + the ctx subset CONFIRM/RESOLVE/CLEANUP
  //     need, prime turnSnapshot from dCombat.current, then jump
  //     straight to CONFIRM so the same card re-spawns. The
  //     pendingAction is cleared inside Confirm.onEnter the moment the
  //     card's promise resolves, so this only fires on a true mid-card
  //     reload.
  //   - currentTurnResolved=true → land at TURN_END so the turn advances
  //     without re-running RESOLVE (damage/AE/equipment was already
  //     applied to actor docs before the reload; replaying would double-
  //     apply). See state-handlers RESOLVE.onEnter for the write site.
  //   - otherwise → land at TURN_START, which auto-picks the saved
  //     combatant (currentCombatantId preserved through reconstruction)
  //     and routes to DECLARE for a fresh action.
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
  } else if (dCombat.currentTurnResolved) {
    resumeAt = STATES.TURN_END;
  } else {
    resumeAt = STATES.TURN_START;
  }
  try {
    await director.transitionTo(resumeAt);
  } catch (e) {
    warn(`resume: transitionTo(${resumeAt}) threw`, e);
  }

  const toastSuffix = resumedFromCard
    ? ` (resuming Action Card — ${state.pendingAction.actionResult?.kind ?? "?"})`
    : (dCombat.currentTurnResolved
      ? ` (turn was already resolved — advancing)`
      : `, ${dCombat.currentSide} acting`);
  ui.notifications?.info(
    `Battle Director resumed — round ${dCombat.round}${toastSuffix}`
  );

  try { Hooks.callAll("fu-director-started", director); } catch (e) { warn("fu-director-started hook threw on resume", e); }
  return director;
}

// Public read of "is the director running on this client?" — used by the
// combat-button installer (no Foundry Combat doc means no createCombat hook
// to detect the running state).
function isRunning() {
  return !!_instance;
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
  // `suppressNextHistoryPush: true` tells the first save fired by the
  // resumed state's onEnter (TURN_START / TURN_END / CONFIRM) to skip
  // the history push — otherwise rewinding to a snapshot adds a
  // duplicate entry at that snapshot every time, so 3× rewinds to the
  // same point pile up 3 identical rows in the rewind list.
  const mountResult = await resumeFromSavedState({
    scene: result.scene,
    state: result.snapshot,
    suppressNextHistoryPush: true,
  });
  if (!mountResult) {
    ui.notifications?.error("Rewind: director mount failed after restore.");
    return { ok: false, error: "mount failed" };
  }

  // resumeFromSavedState's own toast (round / acting side) already
  // surfaced; add a confirmation noting the rewind target.
  ui.notifications?.info(`Rewound to: ${result.snapshot.label || "earlier checkpoint"}`);
  return { ok: true, snapshot: result.snapshot };
}

// Register the public API on ready. The `FUCompanion.api` root is set up by
// the rest of the module's boot sequence; we attach an `experimental`
// namespace under it so the director never shadows production APIs.
Hooks.once("ready", () => {
  const root = (globalThis.FUCompanion = globalThis.FUCompanion ?? {});
  const api = (root.api = root.api ?? {});
  const exp = (api.experimental = api.experimental ?? {});
  exp.battleDirector = {
    start,
    stop,
    status,
    isRunning,
    getSourceSceneId,
    // Rewind tool (GM-only). See [[director-rewind-tool-plan]].
    history,
    rewindTo,
    // Director-owned battle init pipeline (replaces the legacy Manager flow
    // when battleSystem === "director"). Called by the new "Director Manager"
    // macro after the user confirms the Battle Prompt.
    runDirectorInit,
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
    // Expose constructor + handlers for advanced debugging
    _BattleDirector: BattleDirector,
    _STATE_HANDLERS: STATE_HANDLERS,
  };
  log("Battle Director API registered at FUCompanion.api.experimental.battleDirector");

  // Install the IntentChannel singleton on EVERY client (not just GM).
  // Players need it to receive MENU_OPEN broadcasts and to reply to PINGs;
  // GM uses it for INTENT receipt + MENU_OPEN broadcast. Idempotent —
  // calling install() twice is a no-op.
  try {
    getIntentChannel().install();
    // Player-side: wire up the per-surface MENU_OPEN handlers + a
    // default catch-all logger for any kinds we haven't converted yet.
    if (!game.user?.isGM) {
      // Compose-action — when the GM broadcasts that this player's PC's
      // turn has started, run the full pick chain locally (Octopath →
      // weapon mode → target picker) and emit ACTION_COMPOSED with the
      // bundle. No per-pick socket traffic; one commit per action.
      // See [[director-player-driven-input]].
      registerPlayerComposeActionHandler(getIntentChannel());
      // Action-card mirror — render the GM's card on this client; owner
      // sees interactive buttons, observers see read-only.
      registerPlayerActionCardHandler(getIntentChannel());
      // Turn picker — show "Take Action" pills over the player's OWN
      // eligible combatants so they can pick which of their PCs acts
      // next on the current side.
      registerPlayerTurnPickerHandler(getIntentChannel());
      // Catch-all observer for any other surface kinds we haven't wired
      // up yet (future kinds). Lets us tell during testing that the
      // broadcast arrived even before the UI exists.
      getIntentChannel().onMenuOpen((menuSpec) => {
        const wired = new Set(["compose-action", "action-card", "turn-picker"]);
        if (!wired.has(menuSpec?.kind)) {
          log(`[player] MENU_OPEN (unwired kind): ${menuSpec?.kind ?? "?"}`, menuSpec);
        }
      });
      getIntentChannel().onMenuClose((payload) => {
        log(`[player] MENU_CLOSE: kind=${payload?.kind ?? "?"} reason=${payload?.reason ?? "?"}`);
      });
      // Announce ready to GM AFTER all handlers are attached. If the GM
      // already broadcast a MENU_OPEN (e.g. resumeFromSavedState fired
      // during our boot), this triggers a replay so we don't miss it.
      // See IntentChannel._onPlayerHello.
      try { getIntentChannel().announceReady(); }
      catch (e) { warn("announceReady threw", e); }
    }
  } catch (e) {
    warn("IntentChannel install on ready threw", e);
  }

  // Director-native critical cut-in — register its socketlib handlers on
  // EVERY client (GM + players) so a broadcast crit cut-in renders for all.
  // Self-contained; no dependency on the legacy cut-in system.
  try { initDirectorCutin(); }
  catch (e) { warn("initDirectorCutin on ready threw", e); }

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
    } catch (e) { warn(`oni:reactionPhase bridge (${payload?.trigger}) threw`, e); }
  });

  // Auto-resume mid-combat reloads. GM-only — the director is GM-side
  // authoritative, and a player reload should never auto-start anything.
  // Wrapped in setTimeout so the API registration completes first; if
  // resume throws, the rest of the module is still usable.
  if (game.user?.isGM) {
    setTimeout(() => {
      try {
        const found = findSavedDirectorState();
        if (found) {
          resumeFromSavedState(found).catch((e) => {
            warn("Auto-resume threw", e);
          });
        }
      } catch (e) {
        warn("Auto-resume detection threw", e);
      }
    }, 0);
  }
});
