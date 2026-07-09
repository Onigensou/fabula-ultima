// ============================================================================
// Clock System — GM-mediated mutation.
//
// Only the active GM writes the registry (world settings are GM-writable, and
// with two GMs connected exactly one must own the write or every advance lands
// twice). A player who ticks a clock therefore emits a request and the GM
// applies it.
//
// Raw `game.socket` with a request/response envelope keyed by a generated id —
// the same pattern as healing-socket.js and the shop system. (socketlib's
// registerModule can only be called once per module and gm-executor.js already
// claimed it.)
//
// Flow:
//   • dispatch(op, payload) — called on ANY client.
//       - active GM  → applies directly. `game.socket.emit` does NOT echo to
//                      the sender, so a GM that emitted would wait forever.
//       - player     → op must be player-permitted; emits REQ, awaits RES.
//   • Only the ACTIVE GM processes REQ.
//
// The GM re-resolves everything from the registry and re-validates the op — it
// never trusts a client-sent section count or clock state. The `spec` for a
// check is re-run through the pure rules on the GM's side, so a tampered client
// can at most send a wrong die result, exactly as it could by lying out loud.
//
// ── A note on `visibility` ──────────────────────────────────────────────────
// `visibility: "gm"` hides a clock from the bundled UI. It is NOT a security
// boundary: the registry is a world setting, so any client can read every clock
// from the console. Do not put information in a clock's name that a player
// must not have. Making it real would mean a second, GM-only setting — worth
// doing if hidden clocks ever carry secrets, and deliberately not done now.
// ============================================================================

import { CLOCK_TAG, CLOCK_CHANNEL, CLOCK_SOCKET } from "./clock-const.js";
import * as store from "./clock-store.js";

const REQUEST_TIMEOUT_MS = 10_000;

const _pending = new Map();   // requestId → { resolve, timer }
let _wired = false;

// ── Op table ────────────────────────────────────────────────────────────────
// Every mutation the API can perform, mapped to its store call. Anything not in
// here cannot cross the socket, so a malicious payload can't name an arbitrary
// store export.
const OPS = Object.freeze({
  create:         (p) => store.create(p.spec),
  advance:        (p) => store.advance(p.id, p.opts),
  set:            (p) => store.set(p.id, p.value, p.opts),
  applyCheck:     (p) => store.check(p.id, p.spec),
  resolve:        (p) => store.resolve(p.id, p.pole, p.opts),
  reopen:         (p) => store.reopen(p.id),
  discard:        (p) => store.discard(p.id, p.opts),
  destroy:        (p) => store.destroy(p.id),
  sweep:          (p) => store.sweep(p.lifecycle, p.opts),
  sweepScene:     (p) => store.sweepScene(p.sceneId, p.opts),
  purgeDiscarded: () => store.purgeDiscarded(),
});

// Ops a non-GM may request. Players advance clocks (that is the point of the
// system); they do not get to create, delete, force-resolve, or sweep them.
export const PLAYER_OPS = Object.freeze(new Set(["advance", "applyCheck"]));

/** Exported so a headless test can prove the API never dispatches a typo. */
export const OP_NAMES = Object.freeze(Object.keys(OPS));

function _isPlayerPermitted(op) {
  return PLAYER_OPS.has(op);
}

// ── GM side ─────────────────────────────────────────────────────────────────

async function _applyLocal(op, payload) {
  const fn = OPS[op];
  if (!fn) throw new Error(`unknown clock op "${op}"`);
  return fn(payload ?? {});
}

async function _handleRequest({ requestId, op, payload, userId }) {
  if (!store.isActiveGM()) return;   // exactly one GM answers

  let response;
  try {
    const user = game.users?.get(userId);
    if (!user?.isGM && !_isPlayerPermitted(op)) {
      throw new Error(`op "${op}" is GM-only`);
    }
    const result = await _applyLocal(op, payload);
    response = { ok: true, result };
  } catch (e) {
    console.warn(CLOCK_TAG, `op "${op}" failed for ${userId}`, e);
    response = { ok: false, error: e?.message ?? String(e) };
  }

  game.socket.emit(CLOCK_CHANNEL, {
    type: CLOCK_SOCKET.RES, requestId, userId, ...response,
  });
}

// ── Requester side ──────────────────────────────────────────────────────────

function _handleResponse(data) {
  const entry = _pending.get(data.requestId);
  if (!entry) return;
  clearTimeout(entry.timer);
  _pending.delete(data.requestId);
  entry.resolve(data);
}

function _request(op, payload) {
  const requestId = foundry.utils.randomID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      _pending.delete(requestId);
      console.warn(CLOCK_TAG, `op "${op}" timed out — is a GM connected?`);
      resolve({ ok: false, error: "timeout" });
    }, REQUEST_TIMEOUT_MS);

    _pending.set(requestId, { resolve, timer });
    game.socket.emit(CLOCK_CHANNEL, {
      type: CLOCK_SOCKET.REQ, requestId, op, payload, userId: game.user.id,
    });
  });
}

/**
 * Perform a clock mutation from any client.
 *
 * @returns the store's return value on success; `null` when the request was
 *   refused, timed out, or errored (a warning is logged either way). Callers
 *   already treat `null` as "no change", so this collapses cleanly.
 */
export async function dispatch(op, payload = {}) {
  if (store.isActiveGM()) {
    try { return await _applyLocal(op, payload); }
    catch (e) { console.warn(CLOCK_TAG, `op "${op}" failed`, e); return null; }
  }

  if (!game.user?.isGM && !_isPlayerPermitted(op)) {
    console.warn(CLOCK_TAG, `op "${op}" is GM-only — request not sent`);
    return null;
  }

  const res = await _request(op, payload);
  if (!res.ok) {
    console.warn(CLOCK_TAG, `op "${op}" rejected by GM: ${res.error}`);
    return null;
  }
  return res.result;
}

// ── Wiring ──────────────────────────────────────────────────────────────────

export function wireClockSocket() {
  if (_wired) return;
  _wired = true;

  game.socket.on(CLOCK_CHANNEL, (data) => {
    if (!data?.type) return;
    if (data.type === CLOCK_SOCKET.REQ) {
      _handleRequest(data).catch((e) => console.warn(CLOCK_TAG, "request handler threw", e));
    } else if (data.type === CLOCK_SOCKET.RES && data.userId === game.user.id) {
      _handleResponse(data);
    }
  });

  console.debug(CLOCK_TAG, "socket wired");
}
