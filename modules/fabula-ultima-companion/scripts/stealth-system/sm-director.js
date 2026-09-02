// ============================================================================
// Stealth Mode — the director.
//
// Owns the FSM: one serial dispatch lock, one transition table, one place
// every hook and timer is registered so stop() is total. Runs on the GM.
//
// ── Why GM-side, when the player drives? ───────────────────────────────────
// The controller's player clicks; the GM decides. Every roll, alert change,
// spawn, EXP write and conflict launch resolves here, reached over the socket.
// That split is Dungeon Pathing's, and it is not ceremony: a stealth turn fans
// a detection roll, an alert write and an AI decision at the GM, all three
// read-modify-write against the same scene flag. They MUST be serialised or
// the last writer wins with stale data — the same bug DP.gmSerialize exists to
// prevent, which is why every mutation here goes through one queue.
// ============================================================================

import { TAG, HOOKS, readTuning } from "./sm-constants.js";
import { S, E, TRANSITIONS, STATE_TIMEOUT_MS } from "./sm-states.js";
import { readState, writeState, emptyState, pushLog } from "./sm-state.js";

class StealthDirector {
  constructor() {
    this.state = S.IDLE;
    this.scene = null;
    this.sm = null;              // the runtime state document
    this.tune = null;
    this.running = false;

    this._queue = Promise.resolve();
    this._hooks = [];
    this._timers = new Set();
    this._handlers = new Map();  // state → onEnter
    this._pendingIntent = null;
  }

  // ── Registries ────────────────────────────────────────────────────────────

  hook(name, fn) {
    const id = Hooks.on(name, fn);
    this._hooks.push({ name, id });
    return id;
  }

  timer(fn, ms) {
    const id = setTimeout(() => { this._timers.delete(id); fn(); }, ms);
    this._timers.add(id);
    return id;
  }

  clearRegistries() {
    for (const { name, id } of this._hooks) { try { Hooks.off(name, id); } catch (_) {} }
    this._hooks = [];
    for (const id of this._timers) clearTimeout(id);
    this._timers.clear();
  }

  registerHandlers(map) {
    for (const [state, fn] of Object.entries(map)) this._handlers.set(state, fn);
  }

  // ── Serialised mutation ───────────────────────────────────────────────────

  /**
   * Every state write funnels through here, in emission order.
   * See the header — this is the anti-clobber guarantee, not a nicety.
   */
  serialize(op) {
    const next = this._queue.then(op, op);
    this._queue = next.catch((e) => { console.error(TAG, "serialized op threw", e); });
    return next;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async start(scene = canvas?.scene, { resume = true } = {}) {
    if (!game.user?.isGM) return { ok: false, reason: "GM only" };
    if (this.running) return { ok: false, reason: "already running" };

    this.scene = scene;
    this.tune = readTuning(scene);

    const existing = resume ? readState(scene) : null;
    this.sm = existing?.active ? existing : emptyState();
    this.sm.active = true;

    this.running = true;
    this.state = S.IDLE;

    try { Hooks.callAll(HOOKS.STARTED, { sceneId: scene?.id }); } catch (_) {}

    // A resumed run re-enters at ACTION rather than replaying the round: the
    // player was mid-turn when the page reloaded, and their remaining movement
    // and objective slot are already in the flag.
    if (existing?.active && existing.phase && existing.phase !== S.IDLE) {
      console.debug(TAG, `resuming at ${existing.phase}`);
      await this.enter(this._resumeTarget(existing.phase));
      return { ok: true, resumed: true };
    }

    await this.dispatch(E.START);
    return { ok: true, resumed: false };
  }

  _resumeTarget(phase) {
    // Mid-enemy-phase or mid-resolution is not safely resumable — those states
    // were partway through a sequence of writes. Rewinding to the top of the
    // player's turn is the honest recovery: it can only ever GIVE the party
    // back a fraction of a turn, never take one away.
    const safe = [S.ACTION, S.CONTROLLER_PICK, S.ROUND_START];
    return safe.includes(phase) ? phase : S.ROUND_START;
  }

  async stop({ persist = false } = {}) {
    if (!this.running) return;
    this.running = false;
    this.clearRegistries();

    if (this.sm) {
      this.sm.active = persist;
      this.sm.phase = S.STOPPED;
      try { await writeState(this.sm, this.scene); } catch (_) {}
    }

    this.state = S.STOPPED;
    try { Hooks.callAll(HOOKS.STOPPED, { sceneId: this.scene?.id }); } catch (_) {}
    console.debug(TAG, "stopped");
  }

  // ── Dispatch ──────────────────────────────────────────────────────────────

  /**
   * Feed an event to the machine. Serialised: a click arriving while the enemy
   * phase is mid-flight queues rather than interleaving.
   */
  dispatch(event, payload = null) {
    return this.serialize(async () => {
      if (!this.running) return { ok: false, reason: "not running" };

      const table = TRANSITIONS[this.state] ?? {};
      const entry = table[event];

      if (!entry) {
        console.debug(TAG, `dropped ${event} in ${this.state} (no transition)`);
        return { ok: false, reason: "no-transition", state: this.state };
      }

      if (entry.guard) {
        const verdict = entry.guard(this._ctx(), payload);
        if (verdict !== true) {
          console.debug(TAG, `guard refused ${event} in ${this.state}: ${verdict}`);
          return { ok: false, reason: String(verdict), state: this.state };
        }
      }

      const next = typeof entry.next === "function"
        ? entry.next(this._ctx(), payload)
        : entry.next;

      const from = this.state;
      this.state = next;
      if (this.sm) this.sm.phase = next;

      console.debug(TAG, `${from} --${event}--> ${next}`);
      try { Hooks.callAll(HOOKS.STATE_CHANGED, { from, to: next, event }); } catch (_) {}

      await this._runHandler(next, payload);
      return { ok: true, from, to: next };
    });
  }

  /** Enter a state directly, bypassing the table. Recovery paths only. */
  async enter(state, payload = null) {
    const from = this.state;
    this.state = state;
    if (this.sm) this.sm.phase = state;
    console.debug(TAG, `${from} ==> ${state} (direct)`);
    await this._runHandler(state, payload);
  }

  async _runHandler(state, payload) {
    const fn = this._handlers.get(state);
    if (!fn) return;

    const ms = STATE_TIMEOUT_MS[state];
    let timedOut = false;
    let timerId = null;
    if (ms) {
      timerId = this.timer(() => {
        timedOut = true;
        console.warn(TAG, `${state} exceeded ${ms}ms`);
      }, ms);
    }

    try {
      await fn(this._ctx(), payload);
    } catch (e) {
      console.error(TAG, `handler for ${state} threw`, e);
      ui.notifications?.error?.(`Stealth: ${state} failed — check console.`);
      pushLog(this.sm, `ERROR in ${state}: ${e?.message ?? e}`);
    } finally {
      if (timerId !== null) { clearTimeout(timerId); this._timers.delete(timerId); }
      if (timedOut) console.warn(TAG, `${state} completed after its timeout`);
    }
  }

  /** The context handed to handlers, guards and branching transitions. */
  _ctx() {
    return {
      director: this,
      scene: this.scene,
      sm: this.sm,
      tune: this.tune,
      state: this.state,
      dispatch: (ev, p) => this.dispatch(ev, p),
      save: () => writeState(this.sm, this.scene),
      turnExhausted: () => {
        const p = this.sm?.party;
        if (!p) return true;
        return p.moveLeft <= 0 && p.objectiveUsed;
      },
    };
  }

  status() {
    return {
      running: this.running,
      state: this.state,
      round: this.sm?.round ?? 0,
      alert: this.sm?.alert ?? null,
      sceneId: this.scene?.id ?? null,
      party: this.sm?.party ?? null,
      enemies: Object.keys(this.sm?.enemies ?? {}).length,
      ledger: this.sm?.ledger?.length ?? 0,
    };
  }
}

export const director = new StealthDirector();
export { S, E };
