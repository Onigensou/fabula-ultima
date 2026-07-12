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
  // Opportunities (crit follow-ups, either side). Auto-picking one well needs
  // option semantics we don't model yet, so a sim declines them — symmetric,
  // since both sides crit, but a real fidelity gap the report must own.
  opportunities: "skip",   // "skip"
  // The design budget. A fight that has not resolved EITHER WAY by this round is
  // reported as a design failure, not a stalemate: by now the party should have
  // won or lost. This is a verdict, not just a loop guard.
  expectedRounds: 12,
  // Hard stop, well past expectedRounds. Two sides that literally cannot kill
  // each other must still terminate the run.
  maxRounds: 30,
};

const _state = {
  active: false,
  config: { ...DEFAULT_SIM_CONFIG },
  transcript: [],
  startedAt: 0,
  saved: null,   // originals of the ONI APIs we shim for the duration of a run
  decl: new Map(),      // turnKey → Set<action signature declared>
  budget: new Map(),    // `round:key` → times spent (Protect once/round, …)
  hint: null,           // next picker's answer, when a brain already knows it
  blocked: new Map(),   // turnKey → Set<action name that bounced>
};

// ── The ONI shims ───────────────────────────────────────────────────────────
// Two systems outside the Battle Director still stop a hands-free fight dead,
// because they ask a HUMAN to click:
//
//   ONI.CheckRequester  — the "roll your check" panel (e.g. the Wandering Flame's
//                         Explosive Entrance). Its `request` already supports a
//                         `mode: "silent"` path that performs the SAME roll with
//                         no UI, and `rollCost` pre-rolls before it ever opens the
//                         overlay (the overlay resolves with the value already
//                         rolled). So the sim keeps every roll and drops only the
//                         panel — no math is faked.
//
//   ONI.OpportunitySystem — the crit follow-up picker. There is no headless path:
//                         picking WELL needs option semantics we don't model yet.
//                         So a sim DECLINES opportunities and says so. Both sides
//                         crit, so it is roughly symmetric — but it is a real
//                         fidelity gap, and the report has to own it rather than
//                         quietly bank the difference.
//
// These are installed on begin() and restored on end(), so nothing leaks into
// real play. Shimming here keeps the injection surface at 4 old files: neither
// check-requester nor opportunity-system is edited.
function installShims() {
  const ONI = globalThis.ONI ?? (globalThis.ONI = {});
  const saved = { cr: ONI.CheckRequester ?? null, opp: ONI.OpportunitySystem ?? null };

  const cr = saved.cr;
  if (cr?.request) {
    ONI.CheckRequester = {
      ...cr,
      request: (actors, options = {}) => cr.request(actors, { ...options, mode: "silent" }),
      requestOne: (actor, options = {}) => cr.requestOne(actor, { ...options, mode: "silent" }),
      // Same dice, no overlay. rollCost's own overlay is presentational — it
      // resolves with the value it rolled before opening.
      rollCost: async ({ faces = 6, count = 1 } = {}) => {
        SimMode.note("check", `cost roll ${count}d${faces} (silent)`);
        return ONI.Dice.roll(count, faces);
      },
    };
    log("[SIM] CheckRequester → silent mode");
  }

  const opp = saved.opp;
  if (opp?.offer) {
    ONI.OpportunitySystem = {
      ...opp,
      offer: async ({ actorName } = {}) => {
        SimMode.note("opportunity", `${actorName ?? "someone"} declined an Opportunity (sim does not pick these yet)`);
        return { cancelled: true };
      },
    };
    log("[SIM] OpportunitySystem → auto-decline");
  }

  _state.saved = saved;
}

function restoreShims() {
  const saved = _state.saved;
  if (!saved) return;
  const ONI = globalThis.ONI ?? {};
  if (saved.cr) ONI.CheckRequester = saved.cr;
  if (saved.opp) ONI.OpportunitySystem = saved.opp;
  _state.saved = null;
}

export const SimMode = {
  get active() { return _state.active; },
  get config() { return _state.config; },
  get transcript() { return _state.transcript; },

  // Enter sim mode. Returns the resolved config.
  begin(config = {}) {
    _state.config = { ...DEFAULT_SIM_CONFIG, ...config };
    _state.transcript = [];
    _state.startedAt = Date.now();
    _state.decl = new Map();
    _state.blocked = new Map();
    _state.budget = new Map();
    _state.hint = null;
    _state.active = true;

    // Reactions ride the pre-existing harness override rather than a new
    // injection — `dispatchReactionMenu` already checks this global and
    // auto-accepts/declines askable candidates without spawning a menu.
    globalThis.__FU_HARNESS_ACCEPT_PASSIVES__ = _state.config.reactions === "apply";
    installShims();

    log(`[SIM] begin — pace=${_state.config.pace} reactions=${_state.config.reactions} expected=${_state.config.expectedRounds} max=${_state.config.maxRounds}`);
    return _state.config;
  },

  // Leave sim mode. MUST run even on a failed/aborted run, or the injected
  // branches stay live into real play (the card would confirm itself under a
  // real GM). Every caller wraps its run in try/finally around this.
  end() {
    if (!_state.active) return;
    _state.active = false;
    try { delete globalThis.__FU_HARNESS_ACCEPT_PASSIVES__; } catch { globalThis.__FU_HARNESS_ACCEPT_PASSIVES__ = undefined; }
    restoreShims();
    log(`[SIM] end — ${_state.transcript.length} event(s) in ${((Date.now() - _state.startedAt) / 1000).toFixed(1)}s`);
  },

  // ── Re-declare guard ──────────────────────────────────────────────────────
  // Some actions cannot execute for reasons no AI can see from the sheet. Keren's
  // Detonate Phantasm needs a phantasm ON THE FIELD; declared without one, the
  // FSM bounces straight back to DECLARE — where the brain, being deterministic,
  // confidently picks the very same spell again. That is an infinite loop, and it
  // is what parked our first profiled run.
  //
  // So: remember what each combatant has already declared THIS TURN. A repeat
  // means the action bounced, so blacklist it for the rest of the turn and let
  // the brain choose again. Exhaust every option and the turn ends in a Guard.
  // Generic on purpose — this catches the next skill with an invisible
  // precondition too, without us having to predict which one it is.
  declaredThisTurn(turnKey, sig) {
    return _state.decl.get(turnKey)?.has(sig) ?? false;
  },

  recordDeclaration(turnKey, sig) {
    if (!_state.decl.has(turnKey)) _state.decl.set(turnKey, new Set());
    _state.decl.get(turnKey).add(sig);
  },

  blockForTurn(turnKey, name) {
    if (!name) return;
    if (!_state.blocked.has(turnKey)) _state.blocked.set(turnKey, new Set());
    _state.blocked.get(turnKey).add(String(name).trim().toLowerCase());
    this.note("blocked", `"${name}" bounced back to DECLARE — not offering it again this turn`);
  },

  blockedForTurn(turnKey) {
    return _state.blocked.get(turnKey) ?? new Set();
  },

  // ── Per-round budgets ─────────────────────────────────────────────────────
  // "Blanche protects at most once per round", and — crucially — Hina must be
  // able to ASK whether Blanche has already spent it, because her heal is gated
  // on the party's defensive option being exhausted. So the budget is shared
  // state, not a private counter inside one profile.
  spend(round, key) {
    const k = `${round}:${key}`;
    _state.budget.set(k, (_state.budget.get(k) ?? 0) + 1);
  },

  spent(round, key) {
    return _state.budget.get(`${round}:${key}`) ?? 0;
  },

  // ── Pick hint ─────────────────────────────────────────────────────────────
  // The pickers auto-answer with the FIRST option, which is fine for a picker
  // that only exists to be acknowledged and actively wrong for one that carries a
  // real decision — WHICH ally to Protect, WHICH element to load into Zarg's
  // Gadgets. A brain that already knows the answer leaves it here; the next
  // picker consumes it (once) and falls back to first-option if nothing matches.
  setPickHint(hint) {
    _state.hint = hint ?? null;
  },

  takePickHint() {
    const h = _state.hint;
    _state.hint = null;
    return h;
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
