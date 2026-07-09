// ============================================================================
// Clock System — Persistence + the single-writer gate.
//
// The whole registry lives in ONE world setting, `clockRegistry`, shaped as
// { [clockId]: Clock }. World scope buys us two things for free:
//
//   • Reconnect survival. A player who drops mid-scene and rejoins re-reads the
//     live registry on `ready`; there is no replay, no resync handshake.
//   • Broadcast. Foundry fires `updateSetting` on EVERY client when the setting
//     is written, so all clients converge without a socket of our own.
//
// Only the ACTIVE GM ever writes (`_isActiveGM`, the same guard healing-socket
// uses — with two GMs connected, exactly one owns the write). Players request
// mutations over a socket instead; that layer lands in phase 4 and calls
// straight into the same functions here.
//
// Change events are derived by DIFFING the previous registry snapshot against
// the new one, rather than being pushed alongside the write. That means a
// client which joins late, reloads, or misses a socket packet still emits the
// right events from the setting alone, and the writer and the observers run
// identical code paths.
// ============================================================================

import {
  CLOCK_MODULE_ID, CLOCK_SETTING, CLOCK_TAG, CLOCK_HOOK,
  CLOCK_STATE, LIFECYCLE, GROUP_MODE,
} from "./clock-const.js";
import {
  makeClock, reviveClock, applyDelta, applySet, applyResolve, applyReopen, applyDiscard,
} from "./clock-model.js";
import { applyCheckToMany, previewCheckToMany } from "./clock-check.js";

// Last registry we emitted events for. Seeded on `ready`; compared on every
// `updateSetting`. Values are frozen-by-convention (never mutated in place).
let _snapshot = {};
let _wired = false;

// ── Guards ──────────────────────────────────────────────────────────────────

/**
 * Exactly one GM must own the write, or a two-GM table double-applies every
 * advance. Mirrors healing-socket.js's `_isActiveGM`, including the fallback
 * for core versions without `game.users.activeGM`.
 */
export function isActiveGM() {
  if (!game.user?.isGM) return false;
  const active = game.users?.activeGM ?? null;
  if (active) return active.id === game.user.id;
  const firstGM = game.users?.filter?.((u) => u.isGM && u.active)
    ?.sort?.((a, b) => a.id.localeCompare(b.id))?.[0];
  return firstGM ? firstGM.id === game.user.id : true;
}

// ── Raw registry access ─────────────────────────────────────────────────────

function _readRaw() {
  try {
    const v = game.settings.get(CLOCK_MODULE_ID, CLOCK_SETTING);
    return (v && typeof v === "object") ? v : {};
  } catch {
    return {};
  }
}

async function _writeRaw(next) {
  if (!isActiveGM()) {
    console.warn(CLOCK_TAG, "refusing registry write from a non-active-GM client");
    return false;
  }
  await game.settings.set(CLOCK_MODULE_ID, CLOCK_SETTING, next);
  return true;
}

// ── Public reads ────────────────────────────────────────────────────────────

/** Every clock in the registry, revived and validated. Unsalvageable rows are dropped. */
export function all() {
  const raw = _readRaw();
  const out = {};
  for (const [id, rec] of Object.entries(raw)) {
    const clock = reviveClock(rec);
    if (clock) out[id] = clock;
    else console.warn(CLOCK_TAG, "dropping unreadable clock record", id);
  }
  return out;
}

export function get(id) {
  return all()[id] ?? null;
}

/**
 * Filtered list, oldest first (stable display order). Discarded clocks are
 * hidden unless asked for; resolved ones are kept — the UI wants to show the
 * resolution flourish before it clears.
 */
export function list({ state = null, tags = null, group = null, lifecycle = null, includeDiscarded = false } = {}) {
  return Object.values(all())
    .filter((c) => {
      if (!includeDiscarded && c.state === CLOCK_STATE.DISCARDED) return false;
      if (state && c.state !== state) return false;
      if (lifecycle && c.lifecycle !== lifecycle) return false;
      if (group && c.group?.id !== group) return false;
      if (tags?.length && !tags.every((t) => c.tags.includes(t))) return false;
      return true;
    })
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** Siblings of `clock` in its group, excluding itself. Empty when ungrouped. */
export function siblings(clock) {
  if (!clock?.group?.id) return [];
  return list({ group: clock.group.id, includeDiscarded: false }).filter((c) => c.id !== clock.id);
}

// ── Writes (active GM only) ─────────────────────────────────────────────────

/**
 * Create a clock. Accepts either a raw spec or a `preset.*()` product — both
 * end up through `makeClock`, so a spec that came off the wire is validated
 * exactly as one written in a macro.
 */
export async function create(spec = {}) {
  const id = spec.id ?? foundry.utils.randomID();
  const clock = makeClock({ ...spec, id });
  const next = { ..._readRaw(), [id]: clock };
  const ok = await _writeRaw(next);
  return ok ? clock : null;
}

/**
 * Apply a pure model function to one clock and persist the result.
 *
 * `fn(clock)` returns either a clock, or an `applyDelta`-shaped
 * `{ clock, delta, previous, resolution, noop }`. Both are accepted so the
 * simple mutators (resolve/reopen/discard) don't have to fake a result object.
 *
 * When the mutation resolves a clock in a `race` group, the losing siblings are
 * discarded in the SAME write — no client ever renders a frame with two winners.
 */
async function _mutate(id, fn, { cause = null } = {}) {
  const registry = all();
  const clock = registry[id];
  if (!clock) {
    console.warn(CLOCK_TAG, "mutate: no such clock", id);
    return null;
  }

  const out = fn(clock);
  const result = (out && "clock" in out) ? out : { clock: out, noop: false };
  if (!result.clock || result.noop) return result;

  const next = { ...registry, [id]: result.clock };
  _settleRaceInto(next, result.clock, cause);

  const ok = await _writeRaw(next);
  return ok ? result : null;
}

/**
 * A clock in a `race` group just resolved — its siblings lost. Mutates the
 * pending registry in place (it's a local copy, not yet written).
 */
function _settleRaceInto(registry, clock, cause) {
  if (clock.state !== CLOCK_STATE.RESOLVED) return;
  if (clock.group?.mode !== GROUP_MODE.RACE) return;

  for (const other of Object.values(registry)) {
    if (other.id === clock.id) continue;
    if (other.group?.id !== clock.group.id) continue;
    if (other.state !== CLOCK_STATE.ACTIVE) continue;
    registry[other.id] = applyDiscard(other, { cause: cause ?? `lost race to ${clock.name}` });
  }
}

/**
 * Advance a clock by `sections`, signed toward `side`'s own pole. Negative
 * pulls it back (RAW "Turning Back a Clock").
 */
export async function advance(id, opts = {}) {
  return _mutate(id, (clock) => applyDelta(clock, opts), { cause: opts.cause });
}

export async function set(id, value, opts = {}) {
  return _mutate(id, (clock) => applySet(clock, value, opts), { cause: opts.cause });
}

export async function resolve(id, pole, opts = {}) {
  return _mutate(id, (clock) => applyResolve(clock, pole, opts), { cause: opts.cause });
}

export async function reopen(id) {
  return _mutate(id, (clock) => applyReopen(clock));
}

export async function discard(id, opts = {}) {
  return _mutate(id, (clock) => applyDiscard(clock, opts), { cause: opts.cause });
}

// ── Check-driven advancement ────────────────────────────────────────────────

/**
 * Which clocks a check against `clock` touches. For a `paired` group that is
 * every member — each one's poles decide whether it takes the result, so the
 * success clock advances on a pass and the parallel failure clock on a miss
 * (RAW p.54) without this function knowing which is which.
 */
function _checkTargets(registry, clock) {
  if (clock.group?.mode !== GROUP_MODE.PAIRED) return [clock];
  return Object.values(registry)
    .filter((c) => c.group?.id === clock.group.id && c.state === CLOCK_STATE.ACTIVE)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Apply a Fabula Ultima check to a clock (and its paired siblings), persisting
 * every advance in ONE write.
 *
 * @returns {object[]} one `applyCheck` result per touched clock, each carrying
 *   its `.preview` so the caller can narrate the rules that fired.
 */
export async function check(id, spec = {}) {
  const registry = all();
  const clock = registry[id];
  if (!clock) {
    console.warn(CLOCK_TAG, "check: no such clock", id);
    return null;
  }

  const results = applyCheckToMany(_checkTargets(registry, clock), spec);
  const changed = results.filter((r) => !r.noop);
  if (!changed.length) return results;

  const next = { ...registry };
  for (const r of changed) {
    next[r.clock.id] = r.clock;
    _settleRaceInto(next, r.clock, spec.cause ?? null);
  }
  const ok = await _writeRaw(next);
  return ok ? results : null;
}

/**
 * Read-only twin of `check` — what WOULD this check do? Safe on any client
 * (no write, no GM gate), which is what lets a player's action card show the
 * outcome before the roll is committed.
 */
export function preview(id, spec = {}) {
  const registry = all();
  const clock = registry[id];
  if (!clock) return null;
  return previewCheckToMany(_checkTargets(registry, clock), spec);
}

/** Hard-remove a clock from the registry. `discard` is almost always what you want. */
export async function destroy(id) {
  const next = { ..._readRaw() };
  if (!(id in next)) return false;
  delete next[id];
  return _writeRaw(next);
}

// ── Lifecycle sweeps ────────────────────────────────────────────────────────
//
// Clocks survive a reconnect because they live server-side; the flip side is
// that they'd accumulate across sessions. `lifecycle` is what keeps the
// registry from becoming a graveyard. Callers: director-boot's stop (combat),
// the canvas-ready hook (scene). `manual` is never swept.

export async function sweep(lifecycle, { cause = null } = {}) {
  if (lifecycle === LIFECYCLE.MANUAL) return 0;
  if (!isActiveGM()) return 0;

  const registry = all();
  let swept = 0;
  for (const clock of Object.values(registry)) {
    if (clock.lifecycle !== lifecycle) continue;
    if (clock.state === CLOCK_STATE.DISCARDED) continue;
    registry[clock.id] = applyDiscard(clock, { cause: cause ?? `${lifecycle} lifecycle ended` });
    swept++;
  }
  if (swept) await _writeRaw(registry);
  return swept;
}

/** Purge discarded clocks from the registry entirely. Used by the manager window. */
export async function purgeDiscarded() {
  const registry = _readRaw();
  const next = {};
  let purged = 0;
  for (const [id, rec] of Object.entries(registry)) {
    if (rec?.state === CLOCK_STATE.DISCARDED) { purged++; continue; }
    next[id] = rec;
  }
  if (purged) await _writeRaw(next);
  return purged;
}

// ── Event emission (diff-driven, every client) ──────────────────────────────

function _emitDiff(prev, next) {
  for (const [id, clock] of Object.entries(next)) {
    const before = prev[id];

    if (!before) {
      Hooks.callAll(CLOCK_HOOK.CREATED, { clock });
      continue;
    }
    if (before.value !== clock.value || before.state !== clock.state) {
      const last = clock.history[clock.history.length - 1] ?? null;
      Hooks.callAll(CLOCK_HOOK.CHANGED, {
        clock,
        previous: before.value,
        delta: clock.value - before.value,
        cause: last?.cause ?? null,
        side: last?.side ?? null,
      });
    }
    if (!before.resolution && clock.resolution) {
      Hooks.callAll(CLOCK_HOOK.RESOLVED, { clock, resolution: clock.resolution });
    }
    if (before.state !== CLOCK_STATE.DISCARDED && clock.state === CLOCK_STATE.DISCARDED) {
      Hooks.callAll(CLOCK_HOOK.DISCARDED, { clock });
    }
  }

  for (const [id, clock] of Object.entries(prev)) {
    if (!next[id]) Hooks.callAll(CLOCK_HOOK.DISCARDED, { clock, destroyed: true });
  }
}

/** True when this `updateSetting` payload is our registry, across core versions. */
function _isOurSetting(setting) {
  const key = setting?.key ?? "";
  return key === `${CLOCK_MODULE_ID}.${CLOCK_SETTING}` || (setting?.namespace === CLOCK_MODULE_ID && setting?.key === CLOCK_SETTING);
}

// ── Bootstrap ───────────────────────────────────────────────────────────────

/** Register the world setting. Must run on `init` so get/set are live by `ready`. */
export function registerClockSetting() {
  try {
    game.settings.register(CLOCK_MODULE_ID, CLOCK_SETTING, {
      scope: "world", config: false, default: {}, type: Object,
    });
  } catch { /* already registered */ }
}

/** Seed the snapshot and start emitting diffs. Idempotent. */
export function wireClockStore() {
  if (_wired) return;
  _wired = true;

  _snapshot = all();

  Hooks.on("updateSetting", (setting) => {
    if (!_isOurSetting(setting)) return;
    const prev = _snapshot;
    const next = all();
    _snapshot = next;
    try { _emitDiff(prev, next); }
    catch (e) { console.warn(CLOCK_TAG, "diff emission threw", e); }
  });

  console.debug(CLOCK_TAG, `store wired — ${Object.keys(_snapshot).length} clock(s) in registry`);
}
