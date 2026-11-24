// Pre-ready socket noise gate.
//
// socketlib starts listening at `init`; our handlers register during `ready`.
// Every host broadcast that lands in between throws "No socket handler with the
// name 'FU_*' has been registered" — 150-220 errors per join, measured
// 2026-11-24 (tools/handoffs/late-join-hunt-2026-11-24.md, root cause 1). About
// half arrive after `game.ready` is already true, so the gate is NOT
// `game.ready`: it is a flag set once our own ready work is done
// (markSocketHandlersReady, from a 0 ms timer started by the gate's OWN
// Hooks.once("ready"), registered at install time: every module file's ready
// hook runs synchronously inside Hooks.callAll("ready"), so that timer lands
// after the last of them, and a throw in any one of them can't keep it shut).
//
// What it drops: a COMMAND (fire-and-forget) whose handler is not registered
// yet, before that flag. Those fail today anyway; this only removes the error.
// What it never touches: REQUESTs (socketlib answers them with UNREGISTERED so
// the sender does not hang — the late-join paths rely on that), responses,
// anything for a handler that IS registered, and everything after the flag.

const COMMAND = 0;   // socketlib MESSAGE_TYPES.COMMAND

let _ready = false;
let _dropped = 0;
const _names = new Map();
const _gated = new WeakSet();
let _openHooked = false;

/** True once the gate has opened (our ready work finished). */
export function socketHandlersReady() { return _ready; }

/** Commands dropped before the flag, and by which handler name. */
export function droppedPreReady() { return { total: _dropped, byName: Object.fromEntries(_names) }; }

/** The rule, on its own: should this incoming message be dropped quietly? */
export function shouldDrop(message, functions, ready = _ready) {
  if (ready) return false;
  if (message?.type !== COMMAND) return false;
  const name = message?.handlerName;
  return typeof name === "string" && !functions?.has?.(name);
}

/** Wrap one SocketlibSocket instance. Idempotent. */
export function gateSocket(sock) {
  if (!sock || _gated.has(sock) || typeof sock._handleRequest !== "function") return sock;
  const orig = sock._handleRequest;
  sock._handleRequest = function gatedHandleRequest(message, senderId) {
    if (shouldDrop(message, this.functions)) {
      _dropped++;
      _names.set(message.handlerName, (_names.get(message.handlerName) ?? 0) + 1);
      return Promise.resolve();
    }
    return orig.call(this, message, senderId);
  };
  _gated.add(sock);
  return sock;
}

/** Open the gate. Logs one summary line instead of the error storm. */
export function markSocketHandlersReady() {
  if (_ready) return;
  _ready = true;
  if (_dropped) console.debug(`[FU Companion] dropped ${_dropped} socket command(s) that arrived before our handlers were attached`, Object.fromEntries(_names));
}

/** Install on our module socket as soon as socketlib exists (its `init`). */
export function installSocketNoiseGate(moduleId = "fabula-ultima-companion") {
  const install = () => {
    try {
      if (!globalThis.socketlib || !globalThis.game?.modules?.get?.("socketlib")?.active) return;
      gateSocket(globalThis.socketlib.registerModule(moduleId));
    } catch (e) { console.warn("[FU Companion] socket noise gate not installed", e); }
  };
  if (globalThis.socketlib) install();
  else globalThis.Hooks?.once?.("socketlib.ready", install);
  if (!_openHooked) {
    _openHooked = true;
    globalThis.Hooks?.once?.("ready", () => { setTimeout(() => { try { markSocketHandlersReady(); } catch (_e) {} }, 0); });
  }
}

/** Test-only reset. */
export function _resetForTest() { _ready = false; _dropped = 0; _names.clear(); }
