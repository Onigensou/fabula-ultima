// ============================================================================
// Per-target impact offsets — stagger WHEN each target's hit is shown.
//
// A non-Chain action has ONE damage gate: RESOLVE commits every target after
// it, and each target's number / flinch / HP bar / MISS used to float the
// moment its write landed. An animation whose hits land one after another
// (Soulflare's staggered bolts) then showed targets 2..N their numbers before
// their bolt arrived.
//
// Opt-in, per action:
//   1. The animation reports, BEFORE it fires the gate, how long after the gate
//      each target's impact lands:   oni.impactOffsets({ [tokenUuid]: ms })
//      (a local "oni:impactOffsets" hook, like oni.hit — the acting GM's own run
//      of the script is the one the director hears).
//   2. playDirectorAnimation collects it (armImpactOffsetsCollector) and leaves
//      it on director.ctx.animImpactOffsets = { actionId, offsets }.
//   3. resolveAction takes it (takeImpactOffsets, matched to the action's
//      _instanceId and consumed once) and builds a presenter. Every HP / MP
//      WRITE stays where it was; only the presentation calls go through
//      presenter.present(tokenUuid, fn), which runs fn `offset` ms after the
//      action's FIRST presentation (the anchor), so the numbers keep the
//      animation's spacing and the uniform RESOLVE latency.
//   4. RESOLVE drains the presenter before settleInstance, so a defeat (the
//      reactor's removal, or an on-hit style riding the number) never plays
//      before that target's delayed number.
//
// No offsets (every existing script) → present() runs fn synchronously and
// applyDamageToTarget gets no deferral: exactly the old behavior.
//
// Multi-client: presentation is emitted on the director host and broadcast
// from there (damage numbers, hurt reaction, HP bar, miss text all own their
// socket), so delaying the emit on the host delays it on every client. The
// offsets never need to travel.
//
// Pure module (no Foundry globals at import): node-tested by
// impact-offsets.test.mjs.
// ============================================================================

export const IMPACT_OFFSETS_HOOK = "oni:impactOffsets";

// A cinematic's hits sit within a few seconds of its gate; anything past this
// is an authoring error and would hold RESOLVE (the drain) for no reason.
export const MAX_IMPACT_OFFSET_MS = 4000;

// { [tokenUuid]: ms } → a clean plain object, or null when nothing usable.
// Drops non-finite / negative values and empty keys, clamps to the max, rounds.
export function normalizeImpactOffsets(raw, { maxMs = MAX_IMPACT_OFFSET_MS } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(raw)) {
    const key = String(k ?? "").trim();
    const ms = Number(v);
    if (!key || !Number.isFinite(ms) || ms < 0) continue;
    out[key] = Math.round(Math.min(ms, maxMs));
    n++;
  }
  return n ? out : null;
}

// Listen for the script's report during ONE animation run. Scoped to the caster
// (a concurrent cinematic's report is ignored); a payload without a caster is
// accepted. The last report wins. `stop()` unhooks and returns what was heard.
export function armImpactOffsetsCollector({ casterTokenUuid = null, hooks = globalThis.Hooks } = {}) {
  let offsets = null;
  let stopped = false;
  const onReport = (data) => {
    if (stopped) return;
    const src = data?.casterTokenUuid ?? null;
    if (casterTokenUuid && src && src !== casterTokenUuid) return;
    const clean = normalizeImpactOffsets(data?.offsets);
    if (clean) offsets = clean;
  };
  try { hooks?.on?.(IMPACT_OFFSETS_HOOK, onReport); } catch (_e) { /* no hooks: nothing to hear */ }
  return {
    get offsets() { return offsets; },
    stop() {
      if (!stopped) {
        stopped = true;
        try { hooks?.off?.(IMPACT_OFFSETS_HOOK, onReport); } catch (_e) { /* ignore */ }
      }
      return offsets;
    },
  };
}

// Read + consume the offsets left for THIS action. Another action's entry (a
// nested resolve, or a stale one whose RESOLVE never ran) is never applied and
// is left alone; Animation.onEnter clears it at the next action. An entry or
// an action without an id never matches.
export function takeImpactOffsets(director, ar) {
  const ctx = director?.ctx;
  const entry = ctx?.animImpactOffsets ?? null;
  if (!entry) return null;
  const id = ar?._instanceId ?? null;
  if (entry.actionId == null || id == null || entry.actionId !== id) return null;
  ctx.animImpactOffsets = null;
  return normalizeImpactOffsets(entry.offsets);
}

// How long a "settled" presentation may take to settle after it ran. The vfx
// bridges (fireResourceLossVfx …) return their lazy-import chain, which settles
// a few microtasks after the number is emitted; this only bounds a hung import.
export const IMPACT_SETTLE_CAP_MS = 1000;

// The delayed-presentation scheduler for one action's RESOLVE.
//   present(tokenUuid, fn, { settle }): run fn now (no offset / inactive) or at
//     anchor+offset. Active: returns a promise that resolves once fn has run —
//     with `settle`, once the thenable fn returned has settled too (so the
//     number it emits is really out; capped by IMPACT_SETTLE_CAP_MS). Inactive:
//     runs fn inline and returns undefined, exactly as before.
//   drain(): resolves once every scheduled fn has run and every settle-tracked
//     one has settled (capped as a backstop).
//   flush(): run everything still pending now.
export function createImpactPresenter(offsets, {
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (h) => clearTimeout(h),
} = {}) {
  const map = normalizeImpactOffsets(offsets);
  const active = !!map;
  let anchor = null;
  const pending = new Map();   // id -> { fire, handle, fired, resolve }
  let seq = 0;
  let waiters = [];

  const settleWaiters = () => {
    if (pending.size) return;
    const w = waiters; waiters = [];
    for (const r of w) { try { r(); } catch (_e) { /* ignore */ } }
  };
  const run = (fn) => {
    try { return fn(); }
    catch (e) { try { console.warn("[BD] impact presenter: presentation threw", e); } catch (_e) { /* ignore */ } return undefined; }
  };
  const finish = (id) => {
    const e = pending.get(id);
    if (!e) return;
    pending.delete(id);
    try { clearTimer(e.capHandle); } catch (_e) { /* ignore */ }
    try { e.resolve(); } catch (_e) { /* ignore */ }
    settleWaiters();
  };

  function present(tokenUuid, fn, { settle = false } = {}) {
    if (typeof fn !== "function") return active ? Promise.resolve() : undefined;
    if (!active) { fn(); return undefined; }
    const t = now();
    if (anchor == null) anchor = t;
    const off = map[String(tokenUuid ?? "")] ?? 0;
    const delay = anchor + off - t;
    const id = ++seq;
    let resolve;
    const done = new Promise((r) => { resolve = r; });
    const entry = { fired: false, handle: null, capHandle: null, resolve };
    entry.fire = () => {
      if (entry.fired) return;
      entry.fired = true;
      const out = run(fn);
      if (settle && out && typeof out.then === "function") {
        entry.capHandle = setTimer(() => finish(id), IMPACT_SETTLE_CAP_MS);
        Promise.resolve(out).then(() => finish(id), () => finish(id));
      } else {
        finish(id);
      }
    };
    pending.set(id, entry);
    if (delay <= 0) entry.fire();
    else entry.handle = setTimer(() => { if (pending.has(id)) entry.fire(); }, delay);
    return done;
  }

  // Run every not-yet-run presentation now and stop waiting on any settle.
  function flush() {
    const items = [...pending.entries()];
    for (const [, e] of items) {
      try { clearTimer(e.handle); } catch (_e) { /* ignore */ }
      e.fire();
    }
    for (const [id] of items) finish(id);
    settleWaiters();
  }

  function drain({ capMs = MAX_IMPACT_OFFSET_MS + 1000 } = {}) {
    if (!pending.size) return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      let capHandle = null;
      const end = () => {
        if (done) return;
        done = true;
        try { clearTimer(capHandle); } catch (_e) { /* ignore */ }
        resolve();
      };
      waiters.push(end);
      capHandle = setTimer(() => { if (!done) { flush(); end(); } }, capMs);
    });
  }

  return {
    active,
    present,
    // applyDamageToTarget's `deferPresentation` for one target (null when inactive,
    // so the write path is untouched without offsets). Settle-tracked: the
    // returned promise resolves once the vfx bridge's import chain has emitted
    // the number, so a follow-up awaiting it stages after the hit.
    forTarget: (tokenUuid) => (active ? (fn) => present(tokenUuid, fn, { settle: true }) : null),
    drain,
    flush,
    get pendingCount() { return pending.size; },
    offsetFor: (tokenUuid) => (active ? (map[String(tokenUuid ?? "")] ?? 0) : 0),
  };
}

// Wrap a { name: fn } presentation table so each call is handed to `defer`
// instead of running now. Used by applyDamageToTarget's vfx switch.
export function deferVfxTable(table, defer) {
  if (!table || typeof defer !== "function") return table;
  const out = {};
  for (const [k, f] of Object.entries(table)) {
    out[k] = typeof f === "function" ? (...args) => defer(() => f(...args)) : f;
  }
  return out;
}

// RESOLVE's drain point. resolveAction registers the presenter it used; the
// RESOLVE state awaits it before settleInstance (defeats) runs.
const _presenters = new WeakMap();   // director -> presenter[]
export function rememberImpactPresenter(director, presenter) {
  if (!director || !presenter?.active) return;
  const list = _presenters.get(director) ?? [];
  list.push(presenter);
  _presenters.set(director, list);
}
export async function drainImpactPresentation(director) {
  const list = director ? _presenters.get(director) : null;
  if (!list?.length) return 0;
  _presenters.delete(director);
  const t0 = Date.now();
  await Promise.all(list.map((p) => p.drain()));
  return Date.now() - t0;
}
