// BattleDirector — the FSM owner.
// One instance per active combat. GM-side authoritative.
//
// Design intent: docs/battle-director-design.md §3 (architectural shape) +
// §10 (timeout/abort model).
//
// Public surface used by the entry point:
//   const d = new BattleDirector({ combat });
//   await d.start();
//   await d.dispatch({ type, body });
//   await d.stop();
//
// Public surface used by state handlers (passed in as `director` argument
// to onEnter / onExit / onAbort):
//   director.transitionTo(stateName)
//   director.enqueue(intent)
//   director.ctx                — mutable working context
//   director.hooks              — HookRegistry
//   director.timers             — TimerRegistry
//   director.intentChannel      — for menu broadcasts (stubbed in v1)
//   director.combat             — always null in director mode (no Foundry Combat doc).
//                                  Kept on the class as a no-op for compat with the
//                                  manual-fallback path that attached to an existing combat.

import { log, warn, err } from "./logger.js";
import { STATES, STATE_TIMEOUT_MS, TRANSITIONS } from "./states.js";
import { INTENTS } from "./intents.js";
import { HookRegistry, TimerRegistry } from "./registries.js";

export class BattleDirector {
  constructor({ combat, payload, stateHandlers, onNaturalStop } = {}) {
    // Combat can be null at construction when started via a payload — the
    // PREP state will create the combat doc and set it via _setCombat.
    // Both null is allowed for the reload-survival resume path, where the
    // boot calls `_setDirectorCombat()` directly with a reconstructed
    // dCombat and then transitions straight to TURN_START.
    if (!combat && !payload) {
      log("BattleDirector constructed without combat/payload — caller must _setDirectorCombat() before transitioning");
    }
    this.combat = combat ?? null;
    // Director-owned combat state. The FSM treats `dCombat` as authoritative
    // for turn / round / current combatant. The Foundry `combat` doc above
    // is kept as a shadow for display (Combat Tracker, End Combat button)
    // and external compatibility. PrepState attaches a `DirectorCombat` via
    // `_setDirectorCombat` after spawning + creating the Foundry combat.
    this.dCombat = null;
    this.payload = payload ?? null;
    this.state = STATES.IDLE;
    this.hooks = new HookRegistry();
    this.timers = new TimerRegistry();
    this.intentChannel = null;  // set by entry point if needed

    // Callback fired when the FSM enters STOPPED naturally (i.e. not via
    // boot's manual stop()). Lets the boot do final cleanup (spawned
    // tokens, legacy suppressor restore) when PREP fails or combatEnd
    // arrives. Optional.
    this._onNaturalStop = onNaturalStop ?? null;

    // Working context. State handlers read/write this. Frozen snapshots live
    // on it (turnSnapshot, eligibleTargets, actionResult, etc.). `combat`
    // mirrors this.combat so the transition-table branching functions can
    // read it without a director reference.
    this.ctx = {
      combat: this.combat,
      // Authoritative director-owned combat state. Transition table reads
      // this for branching (ABORTED routes on dCombat.started, not the
      // Foundry combat's started).
      dCombat: null,
      payload: this.payload,
      turnSnapshot: null,
      eligibleTargets: null,
      declaredCommand: null,
      actionResult: null,
      reactionDepth: 0,
      transientAEs: [],
      endOfRound: false,
      endOfCombat: false,
      abortReason: null,
    };

    this._stateHandlers = stateHandlers ?? {};
    this._stopped = false;

    // Dispatch lock. Only one transition in flight at a time; other dispatches
    // wait on this promise.
    this._lock = Promise.resolve();

    // Current state's timeout handle (cleared on every transition).
    this._stateTimeoutHandle = null;

    // Transition rate-limit guard. If the FSM transitions more than
    // MAX_TRANSITIONS_PER_WINDOW times in WINDOW_MS, we self-stop. This
    // catches infinite loops from a malformed transition table or a state
    // that immediately INTERNAL_DONEs back to itself.
    this._transitionTimestamps = [];
    this._MAX_TRANSITIONS_PER_WINDOW = 50;
    this._TRANSITION_WINDOW_MS = 1000;

    // Expose the latest instance globally so the user can inspect post-mortem
    // if the FSM gets stuck or crashes.
    try { globalThis.__fuDirector_lastInstance = this; } catch {}
  }

  // Live combat id — reflects the director-owned DirectorCombat. UI surfaces
  // (TurnUI, TurnPicker, action-card) use this as a stable instance key. With
  // no Foundry Combat doc in director mode, the dCombat id (assigned at
  // construction) is the canonical handle.
  get combatId() { return this.dCombat?.id ?? this.combat?.id ?? null; }

  // Called by PrepState once the Combat document has been created so the
  // rest of the FSM (and any combat-keyed hooks) can pick it up.
  _setCombat(combat) {
    this.combat = combat ?? null;
    this.ctx.combat = this.combat;
  }

  // Called by PrepState once the director-owned DirectorCombat has been
  // built. From this point forward the FSM treats `dCombat` as the source
  // of truth for round, turn, and current combatant. The Foundry `combat`
  // is mirrored for display.
  _setDirectorCombat(dCombat) {
    this.dCombat = dCombat ?? null;
    this.ctx.dCombat = this.dCombat;
  }

  async start() {
    log(`Starting director for combat ${this.combatId}`);
    this._stopped = false;
    await this.dispatch({ type: INTENTS.START_COMBAT });
  }

  async stop({ reason = "manual" } = {}) {
    log(`Stopping director for combat ${this.combatId} (reason: ${reason})`);
    this._stopped = true;
    // Run current state's onAbort if any
    const handler = this._stateHandlers[this.state];
    if (handler?.onAbort) {
      try { await handler.onAbort(this, { reason }); } catch (e) { warn("onAbort threw", this.state, e); }
    }
    this._clearStateTimeout();
    this.hooks.disposeAll();
    this.timers.disposeAll();
    this.state = STATES.STOPPED;
  }

  // Public entry to the dispatch loop. Returns when the transition has been
  // processed (including any synchronous INTERNAL_DONE chain after it).
  async dispatch(intent) {
    if (this._stopped) {
      warn("dispatch after stop", intent);
      return;
    }
    // Serialize: chain onto the lock.
    const prev = this._lock;
    let release;
    this._lock = new Promise((res) => { release = res; });
    try {
      await prev;
      await this._processIntent(intent);
    } catch (e) {
      err("dispatch threw", intent, e);
    } finally {
      release();
    }
  }

  // Used by state onEnter to schedule a follow-up that should run after the
  // current dispatch turn completes. Enqueued intents are processed serially.
  enqueue(intent) {
    // Fire-and-forget — dispatch handles the locking.
    this.dispatch(intent);
  }

  // Manual state forcing — used by state handlers that want to short-circuit
  // (e.g. synchronous states that complete inside onEnter).
  // NOTE: This must only be called from inside a handler that's already
  // serialized by the dispatch lock.
  async transitionTo(nextState) {
    if (this._stopped) return;
    if (nextState === this.state) {
      warn("transitionTo: same state, ignoring", nextState);
      return;
    }
    await this._transition(nextState);
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  async _processIntent(intent) {
    if (!intent || typeof intent !== "object" || !intent.type) {
      warn("invalid intent shape", intent);
      return;
    }
    const stateTable = TRANSITIONS[this.state];
    if (!stateTable) {
      warn("no transition table for state", this.state);
      return;
    }
    const rule = stateTable[intent.type];
    if (!rule) {
      // Event with no declared transition for this state — dropped. (A former
      // `pendingTriggers` queue buffered TRIGGER_EMIT events here but was never
      // drained, so they were dropped at Cleanup anyway; removed as dead state.
      // Real out-of-band events now flow through the resource ledger + settle.)
      log(`drop intent ${intent.type} in state ${this.state}`);
      return;
    }
    // Guard check
    if (rule.guard) {
      let ok;
      try { ok = rule.guard(this.ctx, intent); }
      catch (e) { warn("guard threw", this.state, intent.type, e); ok = false; }
      if (ok !== true) {
        log(`guard rejected ${intent.type} in ${this.state}: ${ok === false ? "false" : ok}`);
        return;
      }
    }
    // Resolve next state (may be a function)
    let nextState = typeof rule.next === "function" ? rule.next(this.ctx, intent) : rule.next;
    if (!nextState) {
      warn("transition rule resolved to no state", this.state, intent);
      return;
    }
    // Commit hook
    if (rule.commit) {
      try { await rule.commit(this.ctx, intent, this); }
      catch (e) { err("commit threw — moving to ABORTED", this.state, intent.type, e); nextState = STATES.ABORTED; this.ctx.abortReason = `commit threw: ${e?.message || e}`; }
    }
    await this._transition(nextState, intent);
  }

  async _transition(nextState, triggerIntent = null) {
    const prevState = this.state;
    log(`${prevState} → ${nextState}` + (triggerIntent ? ` via ${triggerIntent.type}` : ""));

    // Rate-limit guard. Drop very old timestamps; if we still have too many
    // in the window, self-stop.
    const now = Date.now();
    this._transitionTimestamps.push(now);
    const cutoff = now - this._TRANSITION_WINDOW_MS;
    while (this._transitionTimestamps.length && this._transitionTimestamps[0] < cutoff) {
      this._transitionTimestamps.shift();
    }
    if (this._transitionTimestamps.length > this._MAX_TRANSITIONS_PER_WINDOW) {
      err(`Transition rate-limit exceeded (${this._transitionTimestamps.length} in ${this._TRANSITION_WINDOW_MS}ms). Stopping director to prevent runaway.`);
      this._stopped = true;
      try { this.hooks.disposeAll(); } catch {}
      try { this.timers.disposeAll(); } catch {}
      this.state = STATES.STOPPED;
      return;
    }

    this._clearStateTimeout();

    // onExit on the previous state
    const prevHandler = this._stateHandlers[prevState];
    if (prevHandler?.onExit) {
      try { await prevHandler.onExit(this, { nextState, triggerIntent }); }
      catch (e) { warn("onExit threw", prevState, e); }
    }

    this.state = nextState;

    // If the FSM has reached STOPPED naturally (i.e. not via boot's manual
    // stop() — that sets _stopped before transitioning), notify the boot
    // so it can do final cleanup. Fire on a microtask so we don't recurse
    // into the dispatch loop. Idempotent — the callback's boot.stop() is
    // a no-op when _instance is already null.
    if (nextState === STATES.STOPPED && !this._stopped) {
      this._stopped = true;
      const cb = this._onNaturalStop;
      if (cb) Promise.resolve().then(() => { try { cb({ reason: "fsm-natural" }); } catch (e) { warn("onNaturalStop threw", e); } });
    }

    // Set the new state's timeout (if any)
    const tMs = STATE_TIMEOUT_MS[nextState];
    if (tMs && tMs > 0) {
      this._stateTimeoutHandle = this.timers.setTimeout(
        () => this.dispatch({ type: INTENTS.TIMEOUT, body: { state: nextState } }),
        tMs,
        { label: `${nextState}_timeout` }
      );
    }

    // onEnter on the new state
    const nextHandler = this._stateHandlers[nextState];
    if (nextHandler?.onEnter) {
      try { await nextHandler.onEnter(this, { prevState, triggerIntent }); }
      catch (e) {
        err("onEnter threw", nextState, e);
        this.ctx.abortReason = `onEnter threw: ${e?.message || e}`;
        // Avoid infinite recursion: only fall to ABORTED if we aren't already there
        if (nextState !== STATES.ABORTED && nextState !== STATES.STOPPED) {
          await this._transition(STATES.ABORTED);
        }
      }
    }
  }

  _clearStateTimeout() {
    if (this._stateTimeoutHandle) {
      this.timers.clear(this._stateTimeoutHandle);
      this._stateTimeoutHandle = null;
    }
  }

  // ── Animation control ──────────────────────────────────────────────────

  get isAnimationPlaying() {
    return !!this.ctx.animationController?.playing;
  }

  // Abort the currently playing animation (if any) so the FSM advances to
  // RESOLVE immediately. When no animation is playing the SKIP_ANIMATION
  // intent is dispatched directly — if the FSM is already past ANIMATION
  // the transition table will drop it (no matching entry in RESOLVE etc.).
  skipAnimation() {
    const ctrl = this.ctx.animationController;
    if (ctrl?.playing) {
      // Resolves the abortPromise inside playDirectorAnimation, which races
      // it against the gate — this collapses the gate and INTERNAL_DONE
      // is enqueued from within playDirectorAnimation.
      ctrl.abort?.();
    } else {
      this.dispatch({ type: INTENTS.SKIP_ANIMATION });
    }
  }
}
