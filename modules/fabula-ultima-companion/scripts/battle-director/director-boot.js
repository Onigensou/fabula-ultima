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
import { STATE_HANDLERS } from "./state-handlers.js";
import { STATES } from "./states.js";
import { IntentChannel } from "./intent-channel.js";
import { TurnUI } from "./turn-ui.js";
import { TurnPicker } from "./turn-picker.js";
import * as LegacySuppressor from "./legacy-suppressor.js";
import { runDirectorInit, cleanupDirectorSpawnedTokens } from "./director-init.js";

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

  // 2. Defensive DOM scrub. Both despawnAll calls are idempotent; safe to
  //    invoke even if no instance ever ran on this page.
  try { TurnUI.despawnAll(); } catch {}
  try { TurnPicker.despawnAll(); } catch {}

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
  const channel = new IntentChannel({ director });
  director.intentChannel = channel;
  channel.install();

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

async function stop({ reason = "manual" } = {}) {
  if (!_instance) {
    log("Director.stop: no instance running");
    return;
  }
  // Resolve the battle scene from dCombat (the authoritative ref), falling
  // back to canvas.scene. Used for cleanupDirectorSpawnedTokens.
  const battleScene = _instance.dCombat?.scene ?? _instance.combat?.scene ?? canvas?.scene ?? null;

  try { _instance.intentChannel?.uninstall(); } catch {}
  try { await _instance.stop({ reason }); } catch (e) { warn("stop threw", e); }
  try { TurnUI.despawnAll(); } catch {}
  try { TurnPicker.despawnAll(); } catch {}

  // Remove tokens we spawned during runDirectorInit. Only tokens flagged
  // with fabula-ultima-companion.directorSpawned are touched — manually
  // placed tokens stay.
  if (battleScene) {
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
  // Notify UI surfaces that the director has stopped so they can refresh state.
  try { Hooks.callAll("fu-director-stopped", { reason }); } catch (e) { warn("fu-director-stopped hook threw", e); }
  ui.notifications?.info("Battle Director stopped.");
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
    // Expose constructor + handlers for advanced debugging
    _BattleDirector: BattleDirector,
    _STATE_HANDLERS: STATE_HANDLERS,
  };
  log("Battle Director API registered at FUCompanion.api.experimental.battleDirector");
});
