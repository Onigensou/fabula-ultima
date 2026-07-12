// Sim Mode — the session flag + pacing policy for the automated-playtest harness.
//
// A "sim" is a real Battle Director battle with nobody at the keyboard: the same
// FSM, the same rolls, the same damage pipeline — but every gate that would wait
// for a human is answered by the harness instead. This module is the single
// switch the injected branches read. When `active` is false (i.e. always, during
// real play) every injection site is one boolean check and nothing else changes.
//
// The injections that read this flag:
//   - enemy-autopilot.js   — treat EVERY combatant as AI; zero the think-jitter
//   - action-card.js       — resolve the action card instead of awaiting a click
//   - attribute-pair-picker.js — answer with the defaults (Hinder's GM prompt)
//   - standalone-reactions — NOT injected: it already honours the pre-existing
//                            `__FU_HARNESS_ACCEPT_PASSIVES__` override, which
//                            begin()/end() set and clear for us.
//
// Deliberately NOT touched: state-handlers, director.js, states.js, the damage
// pipeline. The harness replaces the player, never the rules — a sim that ran on
// its own math would just be a new estimate, and estimates are the thing we're
// trying to stop trusting. See [[project_battle_director]].

import { log, warn } from "../logger.js";

// ── Pacing ─────────────────────────────────────────────────────────────────
// watch — readable in real time; you spectate the fight like a replay.
// fast  — everything still renders, but no dwell anywhere. The default.
// batch — nothing waits at all; for unattended multi-run batches.
export const PACE = {
  watch: { think: [400, 900], cardDwell: 1100, pip: true },
  fast:  { think: [0, 0],     cardDwell: 140,  pip: false },
  batch: { think: [0, 0],     cardDwell: 0,    pip: false },
};

export const DEFAULT_SIM_CONFIG = {
  pace: "fast",
  // Ask-mode reactions. "skip" is the Phase-0 default and it is NOT neutral —
  // a party that never uses its ask-mode reactions reads weaker than it plays,
  // so every report must state which setting produced it.
  reactions: "skip",   // "skip" | "apply"
  // Hard stop. A stalemate (two sides that cannot kill each other) must end the
  // run, not hang the harness.
  maxRounds: 30,
};

const _state = {
  active: false,
  config: { ...DEFAULT_SIM_CONFIG },
  transcript: [],
  startedAt: 0,
};

export const SimMode = {
  get active() { return _state.active; },
  get config() { return _state.config; },
  get transcript() { return _state.transcript; },

  // Enter sim mode. Returns the resolved config.
  begin(config = {}) {
    _state.config = { ...DEFAULT_SIM_CONFIG, ...config };
    _state.transcript = [];
    _state.startedAt = Date.now();
    _state.active = true;

    // Reactions ride the pre-existing harness override rather than a new
    // injection — `dispatchReactionMenu` already checks this global and
    // auto-accepts/declines askable candidates without spawning a menu.
    globalThis.__FU_HARNESS_ACCEPT_PASSIVES__ = _state.config.reactions === "apply";

    log(`[SIM] begin — pace=${_state.config.pace} reactions=${_state.config.reactions} maxRounds=${_state.config.maxRounds}`);
    return _state.config;
  },

  // Leave sim mode. MUST run even on a failed/aborted run, or the injected
  // branches stay live into real play (the card would confirm itself under a
  // real GM). Every caller wraps its run in try/finally around this.
  end() {
    if (!_state.active) return;
    _state.active = false;
    try { delete globalThis.__FU_HARNESS_ACCEPT_PASSIVES__; } catch { globalThis.__FU_HARNESS_ACCEPT_PASSIVES__ = undefined; }
    log(`[SIM] end — ${_state.transcript.length} event(s) in ${((Date.now() - _state.startedAt) / 1000).toFixed(1)}s`);
  },

  pace() {
    return PACE[_state.config.pace] ?? PACE.fast;
  },

  cardDwellMs() {
    return this.pace().cardDwell;
  },

  thinkRange() {
    return this.pace().think;
  },

  showPip() {
    return this.pace().pip;
  },

  // Append to the run transcript. The recorder (Phase 1) reads this; for the
  // spike it doubles as the console trace.
  note(kind, text, data = null) {
    if (!_state.active) return;
    _state.transcript.push({ t: Date.now() - _state.startedAt, kind, text, data });
    log(`[SIM] ${kind}: ${text}`);
  },
};

// Panic valve. If a run wedges and leaves the flag set, the injected branches
// would auto-confirm a real GM's cards — so expose a one-liner the user can
// paste into the console. Also called by the runner's watchdog.
export function forceEndSim(reason = "manual") {
  if (!_state.active) return false;
  warn(`[SIM] force-ended (${reason})`);
  SimMode.end();
  return true;
}
