// ============================================================================
// Gacha System — Socket layer
// ----------------------------------------------------------------------------
// One listener, installed on every client. Three roles inside it:
//
//   * REQUESTER  emits a *_REQ and awaits the matching *_RESULT (pending map
//                keyed by a request id, with a timeout so a dead GM cannot
//                hang the button forever).
//   * PRIMARY GM handles *_REQ, runs the engine, replies *_RESULT, then
//                broadcasts REVEAL to everyone.
//   * EVERYONE   receives REVEAL and plays the animation locally.
//
// Only the PRIMARY GM acts on a request. A second signed-in GM sees the same
// packet and returns immediately — that gate is the whole anti-dedupe story,
// and it lives here rather than in the engine's callers so no future entry
// point can forget it.
//
// The reveal is broadcast rather than replayed per client from a shared seed:
// the result is already decided GM-side, so spectators render exactly what the
// roller renders, with no divergence possible.
// ============================================================================

import { GACHA, log, warn } from "./gacha-const.js";
import { executeWish, executeBuy } from "./gacha-engine.js";
import { executeSwap, executeRedeem } from "./gacha-exchange.js";

const isPrimaryGM = () => globalThis.FUCompanion?.isPrimaryGM?.() === true;

const pending = new Map(); // reqId -> resolve

// Which handler and which result message each request maps to.
const ROUTES = {
  [GACHA.MSG.WISH_REQ]:   { run: executeWish,   result: GACHA.MSG.WISH_RESULT },
  [GACHA.MSG.BUY_REQ]:    { run: executeBuy,    result: GACHA.MSG.BUY_RESULT },
  [GACHA.MSG.SWAP_REQ]:   { run: executeSwap,   result: GACHA.MSG.SWAP_RESULT },
  [GACHA.MSG.REDEEM_REQ]: { run: executeRedeem, result: GACHA.MSG.REDEEM_RESULT },
};

const RESULT_TYPES = new Set([
  GACHA.MSG.WISH_RESULT, GACHA.MSG.BUY_RESULT,
  GACHA.MSG.SWAP_RESULT, GACHA.MSG.REDEEM_RESULT,
]);

let _onReveal = null;
let _onPool = null;
let _onStart = null;

/**
 * @param {object} handlers
 * @param {(payload:object)=>void} handlers.onReveal  play the animation
 * @param {(payload:object)=>void} handlers.onPool    refresh the currency UI
 */
export function setup({ onReveal, onPool, onStart } = {}) {
  _onReveal = onReveal ?? null;
  _onPool = onPool ?? null;
  _onStart = onStart ?? null;

  game.socket.on(GACHA.CHANNEL, async (payload) => {
    if (!payload || typeof payload !== "object") return;
    const { type } = payload;

    // ── Broadcasts: every client, spectators included ────────────────────
    if (type === GACHA.MSG.WISH_START) { _onStart?.(payload); return; }
    if (type === GACHA.MSG.REVEAL) { _onReveal?.(payload); return; }
    if (type === GACHA.MSG.POOL_UPDATE) { _onPool?.(payload); return; }

    // ── Paired results: only the client that asked ───────────────────────
    if (RESULT_TYPES.has(type)) {
      if (payload.toUserId && payload.toUserId !== game.user.id) return;
      const resolve = pending.get(payload.reqId);
      if (!resolve) return;
      pending.delete(payload.reqId);
      resolve(payload.result ?? { ok: false, reason: "empty_result" });
      return;
    }

    // ── Requests: primary GM only ────────────────────────────────────────
    const route = ROUTES[type];
    if (!route) return;
    if (!isPrimaryGM()) return;

    await handleRequest(route, payload);
  });

  log("Socket ready on", GACHA.CHANNEL);
}

/** GM side: run the handler, reply, and broadcast any side effects. */
async function handleRequest(route, payload) {
  let result;
  try {
    result = await route.run({ ...(payload.data ?? {}), onDecided: publishReveal });
  } catch (e) {
    warn("Handler threw:", e);
    result = { ok: false, reason: "error", message: String(e?.message ?? e) };
  }

  emit({
    type: route.result,
    reqId: payload.reqId,
    toUserId: payload.fromUserId,
    result,
  });

  if (!result?.ok) return;

  if (result.pool) {
    emit({ type: GACHA.MSG.POOL_UPDATE, pool: result.pool });
    _onPool?.({ pool: result.pool });
  }
}

function emit(msg) {
  try { game.socket.emit(GACHA.CHANNEL, msg); }
  catch (e) { warn("emit failed", e); }
}

/**
 * Tell every other client a wish just started, so their streak launches with
 * the roller's rather than after the GM round-trip. Fire-and-forget: this is
 * presentation only and carries no outcome.
 */
export function announceStart(count) {
  emit({ type: GACHA.MSG.WISH_START, count, byUserId: game.user.id });
}

/**
 * Publish a decided outcome to every client, including this one.
 *
 * Called by the engine the moment the roll resolves — deliberately BEFORE the
 * grants and pity writes finish, so the reveal is not held hostage to several
 * seconds of document I/O.
 */
function publishReveal({ bannerId, bannerName, results }) {
  emit({ type: GACHA.MSG.REVEAL, bannerId, bannerName, results, byUserId: game.user.id });
  _onReveal?.({ bannerId, bannerName, results, byUserId: game.user.id });
}

/**
 * Client side: ask the GM to do something and await the answer.
 *
 * When the caller already IS the primary GM the socket is bypassed entirely —
 * emitting to yourself does not round-trip in Foundry, so this is required for
 * correctness, not just speed.
 */
export async function request(reqType, data) {
  const route = ROUTES[reqType];
  if (!route) return { ok: false, reason: "unknown_request" };

  if (isPrimaryGM()) {
    const result = await route.run({ ...data, onDecided: publishReveal });

    // Diagnostic breadcrumb. This path threads a request through the engine,
    // a socket broadcast and a local handler; when the reveal does not appear
    // this says which of the three was missing.
    globalThis.__gachaLastRequest = {
      reqType, direct: true, ok: result?.ok ?? false,
      reason: result?.reason ?? null,
      hadOnReveal: !!_onReveal,
      resultCount: Array.isArray(result?.results) ? result.results.length : null,
      at: new Date().toISOString(),
    };

    // The reveal already went out from the engine's onDecided hook.
    if (result?.pool) {
      emit({ type: GACHA.MSG.POOL_UPDATE, pool: result.pool });
      _onPool?.({ pool: result.pool });
    }
    return result;
  }

  const reqId = foundry.utils.randomID();
  return new Promise((resolve) => {
    pending.set(reqId, resolve);

    emit({ type: reqType, reqId, fromUserId: game.user.id, data });

    setTimeout(() => {
      if (!pending.has(reqId)) return;
      pending.delete(reqId);
      resolve({ ok: false, reason: "timeout" });
    }, GACHA.REQ_TIMEOUT_MS);
  });
}
