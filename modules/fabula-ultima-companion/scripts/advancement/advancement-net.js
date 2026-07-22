/**
 * Advancement transport — one socket, one writer.
 *
 * Levelling is an event; the systems it feeds (skill points, attributes) are
 * separate domains. What they must NOT have separately is this layer.
 *
 * The level-up system shipped with two live channels and listeners on both, so
 * every player request was applied twice. From the GM seat it looked correct —
 * the GM path short-circuits and never touches the socket — which is why it
 * survived a whole session unnoticed. A second system copy-pasting this code
 * would recreate that bug in a new place, just as invisibly.
 *
 * So: ONE channel, ONE authority gate, ONE dedupe set, ONE listener. Domains
 * register their own message types and handlers on top.
 *
 * Foundry only relays `module.<id>` and `system.<id>`, so the channel name is
 * not free-form.
 */

const CHANNEL = "module.fabula-ultima-companion";
const DEFAULT_TIMEOUT_MS = 10000;

const log  = (...a) => console.log("%c[ONI][Advancement]", "color:#c8a24a", ...a);
const warn = (...a) => console.warn("[ONI][Advancement]", ...a);

/** Registered handlers, keyed by request type. */
const _handlers = new Map();   // reqType -> { resType, handle }
/** In-flight client requests, keyed by request id. */
const _pending = new Map();    // reqId -> resolve
/** Request ids this client has already acted on. */
const _handled = new Set();

let _installed = false;

/**
 * Is this client the one GM allowed to write?
 *
 * Prefers the module's shared primary-GM gate so every system in the world
 * agrees on who acts. The fallbacks matter for a solo GM and for the window
 * between a GM disconnecting and Foundry electing a new active one — without
 * the final `true`, a lone GM whose `activeGM` has not settled yet would be
 * unable to spend anything.
 */
export function isActingGM() {
  if (!game.user?.isGM) return false;
  try {
    if (typeof globalThis.FUCompanion?.isPrimaryGM === "function") {
      return globalThis.FUCompanion.isPrimaryGM();
    }
  } catch { /* fall through */ }
  const active = game.users?.activeGM ?? null;
  if (active) return active.id === game.user.id;
  const gms = game.users.filter((u) => u.isGM && u.active)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return gms[0] ? gms[0].id === game.user.id : true;
}

/**
 * Has this client already handled `reqId`?
 *
 * Belt to the `isActingGM` braces: if two GMs ever both consider themselves
 * primary for a moment, the second delivery is still dropped. Bounded so a long
 * session cannot grow it without limit.
 */
function alreadyHandled(reqId) {
  if (!reqId) return false;
  if (_handled.has(reqId)) return true;
  _handled.add(reqId);
  if (_handled.size > 500) _handled.delete(_handled.values().next().value);
  return false;
}

function emit(payload) {
  try { game.socket.emit(CHANNEL, payload); }
  catch (e) { warn("socket emit failed", e); }
}

/**
 * Register a domain's request type.
 *
 * @param {string} reqType  unique across ALL domains on this channel
 * @param {string} resType  its reply type
 * @param {(payload:object)=>Promise<object>} handle  runs on the acting GM only
 */
export function registerHandler(reqType, resType, handle) {
  if (_handlers.has(reqType)) {
    warn(`handler for "${reqType}" registered twice — the second is ignored`);
    return;
  }
  _handlers.set(reqType, { resType, handle });
}

/**
 * Ask the acting GM to do something, or just do it if that is us.
 *
 * A non-primary GM deliberately goes over the socket like a player, so the
 * primary stays the only writer and two GMs cannot interleave on one actor.
 */
export function request(reqType, payload, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const entry = _handlers.get(reqType);
  if (!entry) return Promise.resolve({ ok: false, reason: "unregistered_request" });

  if (isActingGM()) return Promise.resolve(entry.handle(payload));

  const reqId = foundry.utils.randomID();
  return new Promise((resolve) => {
    _pending.set(reqId, resolve);
    emit({ type: reqType, payload: { ...payload, reqId, requesterUserId: game.user.id } });
    setTimeout(() => {
      if (!_pending.has(reqId)) return;
      _pending.delete(reqId);
      resolve({ ok: false, reason: "timeout" });
    }, timeoutMs);
  });
}

async function onSocket(msg) {
  if (!msg || typeof msg !== "object") return;
  const { type, payload } = msg;

  // A reply coming back to whoever asked.
  for (const [, { resType }] of _handlers) {
    if (type !== resType) continue;
    const resolve = _pending.get(payload?.reqId);
    if (!resolve) return;
    _pending.delete(payload.reqId);
    resolve(payload.result);
    return;
  }

  // A request arriving at the GM. Exactly one may act, or it applies twice.
  const entry = _handlers.get(type);
  if (!entry) return;
  if (!isActingGM()) return;
  if (alreadyHandled(payload?.reqId)) return;

  const result = await entry.handle(payload);
  emit({ type: entry.resType, payload: { reqId: payload?.reqId, result } });
}

/** Attach the single listener. Safe to call from every domain; only the first binds. */
export function installNet() {
  if (_installed) return;
  _installed = true;
  try { game.socket.on(CHANNEL, onSocket); log(`socket ready on ${CHANNEL}`); }
  catch (e) { warn(`socket ${CHANNEL} unavailable`, e); }
}

export const NET_CHANNEL = CHANNEL;
