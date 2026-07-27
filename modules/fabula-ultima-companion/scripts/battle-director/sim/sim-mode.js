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
//   - list-picker.js / target-picker.js — answer with a hint, else first option
//   - check.js             — skip the ask-mode die-swap picker; the auto path
//                            below it already takes the biggest upgrade
//   - skill-effects.js     — `prompt_number` takes its default instead of
//                            opening a Dialog; the Soul Steal loot panel (which
//                            BLOCKS resolve on a click) reports to the
//                            transcript instead of rendering
//   - standalone-reactions — NOT injected: it already honours the pre-existing
//                            `__FU_HARNESS_ACCEPT_PASSIVES__` override, which
//                            begin()/end() set and clear for us.
//
// Deliberately NOT touched: state-handlers, director.js, states.js, the damage
// pipeline — ask-mode incoming reducers are answered through skill-effects'
// own `setDamageReactionAskDecider` hook (installShims) rather than a branch
// inside the pipeline. The harness replaces the player, never the rules — a sim
// that ran on its own math would just be a new estimate, and estimates are the
// thing we're trying to stop trusting. See [[project_battle_director]].

import { log, warn } from "../logger.js";
import { Journal } from "./sim-journal.js";

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
  // Fallback for ACTION-CARD ask-mode pills that have NO named policy in
  // reaction-brain.js. Named policies always win over this, and STANDALONE reactions
  // (turn_end free actions, conflict_start passives) ignore it entirely — they are
  // always taken. See installShims().
  reactions: "apply",   // "skip" | "apply"
  // Opportunities (crit follow-ups). The PARTY takes Advantage (+4 on the next check,
  // which includes accuracy) on a random ally; enemies still decline. See
  // opportunity-brain.js.
  opportunities: "advantage",   // "advantage" | "skip"
  // The design budget. A fight that has not resolved EITHER WAY by this round is
  // reported as a design failure, not a stalemate: by now the party should have
  // won or lost. This is a verdict, not just a loop guard.
  expectedRounds: 7,
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
  elementFallback: null, // card-scoped: best element vs the current target
  focus: null,          // the party's called target (tokenUuid)
  blocked: new Map(),   // turnKey → Set<action name that bounced>
  scripts: [],          // scripted directives (skill-under-test) — see scripted-action.js
  dice: null,           // { queue, restore } — the forced-dice override, when armed
  dmgDecider: null,     // { uninstall } — the ask-mode damage-reaction answer
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
//   ONI.OpportunitySystem — the crit follow-up picker. The PARTY now cashes its crits
//                         in: always Advantage (+4 to the next check, which includes
//                         accuracy), on a random ally. Enemies still decline. We skip
//                         the effect's `pre` phase (the ally-targeting UI, which
//                         nothing would answer) and call `post` directly with the pick
//                         already made — so the AE that lands is the real one and only
//                         the prompt is bypassed. The other options (Affliction,
//                         Bonding…) need judgement we don't model, so they are simply
//                         not chosen: value left on the table, which is the honest
//                         direction to err. See opportunity-brain.js.
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
      // The party now CASHES its crits (Advantage, +4, on a random ally) instead of
      // declining them. Loaded lazily to keep sim-mode free of a cycle back through
      // the brains. See opportunity-brain.js.
      offer: async (args = {}) => {
        const { simOpportunity } = await import("./opportunity-brain.js");
        return simOpportunity(args);
      },
    };
    log("[SIM] OpportunitySystem → party takes Advantage");
  }

  _state.saved = saved;
  installDamageReactionDecider();
}

function restoreShims() {
  restoreDamageReactionDecider();
  const saved = _state.saved;
  if (!saved) return;
  const ONI = globalThis.ONI ?? {};
  if (saved.cr) ONI.CheckRequester = saved.cr;
  if (saved.opp) ONI.OpportunitySystem = saved.opp;
  _state.saved = null;
}

// ── Ask-mode INCOMING damage reductions ─────────────────────────────────────
// Mercy, Unbreakable and friends are "you MAY halve / survive this" reducers:
// resolveDamageReactions asks the defender yes/no before the hit lands. With no
// decider installed that ask is a GM Dialog, which in a hands-free run is a hang
// — and an invisible one, because it fires deep inside the damage pipeline
// rather than at a decision point anyone is watching.
//
// skill-effects exposes `setDamageReactionAskDecider` for exactly this, so the
// policy lives HERE and the damage pipeline stays untouched (see this file's
// header). The policy: TAKE IT. The engine has already narrowed the ask to the
// moments it matters — `condition_formula` blocks a spent once-per-conflict
// reducer, and `reaction_damage_outcome: "would_reduce_to_zero"` limits a death
// save to the hit that would actually kill — so by the time we are asked, a
// player declining would just be choosing to eat the damage. The run's
// `reactions: "skip"` knob still opts out, same as it does for unnamed card
// pills.
//
// Imported dynamically: skill-effects imports THIS module, so a static import
// back would close a cycle. The engine's own import is the same specifier with
// no cache-bust, so this resolves to the same singleton the engine reads.
function installDamageReactionDecider() {
  const decide = async ({ target, ae, damage }) => {
    if (_state.config.reactions === "skip") {
      SimMode.note("damage-reaction", `${target?.name} declines "${ae?.name}" (run config: skip)`);
      return false;
    }
    SimMode.note("damage-reaction", `${target?.name} takes "${ae?.name}" against ${damage} damage`);
    return true;
  };

  _state.dmgDecider = { uninstall: null };
  import("../skill-effects.js")
    .then((mod) => {
      // The run can end before a slow import lands; installing then would leak
      // the decider into real play, where a GM must be the one to answer.
      if (!_state.active) return;
      mod.setDamageReactionAskDecider(decide);
      _state.dmgDecider.uninstall = () => mod.setDamageReactionAskDecider(null);
      log("[SIM] damage-reaction ask → auto-accept");
    })
    .catch((e) => warn("[SIM] could not install the damage-reaction decider", e));
}

function restoreDamageReactionDecider() {
  try { _state.dmgDecider?.uninstall?.(); } catch {}
  _state.dmgDecider = null;
}

// ── Forced dice (scripted skill-under-test) ─────────────────────────────────
// A scripted directive can pin an accuracy outcome (crit / hit / miss / raw faces).
// Foundry V12 draws die faces from CONFIG.Dice.randomUniform (a Mersenne-Twister
// wrapper), NOT Math.random — face = ceil((1 - v) * N), so to force face R out of
// dN we return v = 1 - (R - 0.5)/N. We wrap randomUniform for the whole run and
// drain a FIFO queue: each armed pair feeds the next check's two draws, then the
// override transparently falls back to the real generator. Same math as the
// isolated harness's installRollOverride; installed once so any number of scripted
// casts across the fight can each arm their own outcome. Restored on end().
function installDiceOverride() {
  if (_state.dice) return;   // already installed
  const queue = [];
  const original = CONFIG.Dice.randomUniform;
  CONFIG.Dice.randomUniform = function simForcedRandomUniform() {
    const next = queue.shift();
    if (!next) return original();
    return 1 - (next.R - 0.5) / next.N;
  };
  _state.dice = {
    queue,
    restore() { CONFIG.Dice.randomUniform = original; },
  };
}

function restoreDiceOverride() {
  if (!_state.dice) return;
  try { _state.dice.restore(); } catch {}
  _state.dice = null;
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
    _state.elementFallback = null;
    _state.focus = null;
    _state.scripts = [];
    _state.active = true;
    installDiceOverride();

    // STANDALONE reactions (turn_start / turn_end / conflict_start / round_*) ride the
    // pre-existing harness override: `dispatchReactionMenu` checks this global and
    // auto-fires askable candidates without spawning a menu.
    //
    // This is ALWAYS on in a sim, and that is a deliberate change. It used to be tied
    // to the run's `reactions` setting, which meant a stale panel config reading "skip"
    // silently threw away every standalone reaction the party had — Acceleration's
    // free-action charge and Zarg's Dance among them — while the CARD pills kept
    // working, because those go through named policies in reaction-brain.js and never
    // consulted this flag. So the party looked like it was reacting normally and was
    // quietly missing a whole class of its kit. It cost several rounds of debugging to
    // find, and the failure mode is invisible by construction: harnessSkipped candidates
    // are dropped with no menu, no fire and no log.
    //
    // A real party takes its free actions. There is no version of "playing well" that
    // declines them, so the sim does not model one.
    globalThis.__FU_HARNESS_ACCEPT_PASSIVES__ = true;
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
    _state.scripts = [];
    try { delete globalThis.__FU_HARNESS_ACCEPT_PASSIVES__; } catch { globalThis.__FU_HARNESS_ACCEPT_PASSIVES__ = undefined; }
    restoreShims();
    restoreDiceOverride();
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

  // Sticky, card-scoped fallback for ELEMENT menus specifically. Any augment that
  // lets the caster choose a damage type opens such a menu, and without an answer
  // the picker takes option one — which is how Keren ended up firing Fire into an
  // Inferex that ABSORBS it. A named policy hints the right element; this catches
  // the augments nobody has written a policy for yet. Unlike the one-shot hint it
  // persists for the whole card, because we don't know how many menus will open.
  setElementFallback(el) { _state.elementFallback = el ?? null; },
  elementFallback() { return _state.elementFallback ?? null; },

  // ── Focus fire ────────────────────────────────────────────────────────────
  // The party's called target, shared across all four brains. This is not the AI
  // cheating — it is the single most ordinary thing that happens at a real table
  // ("okay, everyone on the big one"), and the sim had no way to express it, so
  // four characters each picked their own favourite and spread damage across the
  // whole enemy line. Spread damage kills nothing; nothing dying means nobody stops
  // acting; and that is a large part of why the AI takes 9 rounds where the table
  // takes 3.
  setFocus(tokenUuid) { _state.focus = tokenUuid ?? null; },
  focus() { return _state.focus ?? null; },

  // ── Scripted actions (skill-under-test) ────────────────────────────────────
  // The runner registers directives that FORCE a named combatant to cast a named
  // skill on chosen targets (optionally with a forced dice outcome), so a specific
  // skill can be exercised through the live FSM instead of waiting for a brain to
  // choose it. Consumed by scripted-action.js at the DECLARE chokepoint.
  //
  // A directive: { match: { name, uuid }, skill, targets, force, once, _spent }.
  setScripts(directives) {
    _state.scripts = Array.isArray(directives) ? directives.filter(Boolean) : [];
    if (_state.scripts.length) log(`[SIM] ${_state.scripts.length} scripted directive(s) armed`);
  },
  hasScripts() { return _state.scripts.length > 0; },

  // First live directive whose match names this actor (by base name or UUID).
  scriptFor({ name, uuid } = {}) {
    const want = String(name ?? "").replace(/\s*\[SIM\]\s*$/i, "").trim().toLowerCase();
    for (const d of _state.scripts) {
      if (d._spent) continue;
      const m = d.match ?? {};
      const byName = m.name && String(m.name).replace(/\s*\[SIM\]\s*$/i, "").trim().toLowerCase() === want;
      const byUuid = m.uuid && uuid && m.uuid === uuid;
      if (byName || byUuid) return d;
    }
    return null;
  },

  // Retire a `once` directive after it fires.
  exhaustScript(directive) { if (directive) directive._spent = true; },

  // ── Forced dice ────────────────────────────────────────────────────────────
  // Arm the next accuracy check's two die draws. Faces R over dN each; drained by
  // the randomUniform override installed for the run. A no-op if the override isn't
  // installed (i.e. not in a sim), so callers needn't guard.
  armDice(rA, dA, rB, dB) {
    if (!_state.dice) return;
    if (Number.isFinite(rA) && Number.isFinite(dA)) _state.dice.queue.push({ R: rA, N: dA });
    if (Number.isFinite(rB) && Number.isFinite(dB)) _state.dice.queue.push({ R: rB, N: dB });
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

  // Append to the run transcript AND the on-disk journal.
  //
  // The journal previously only recorded reactions, because it was wired into the
  // reaction brain by hand and nowhere else — so an entire run's worth of TURN
  // decisions was invisible, and "is she even casting Acceleration?" was unanswerable
  // from the log. Forwarding every note here means anything a brain bothers to say is
  // captured, and there is no second place to remember to wire up.
  note(kind, text, data = null) {
    if (!_state.active) return;
    _state.transcript.push({ t: Date.now() - _state.startedAt, kind, text, data });
    try { Journal.write(kind, text, data ? { data } : {}); } catch {}
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
