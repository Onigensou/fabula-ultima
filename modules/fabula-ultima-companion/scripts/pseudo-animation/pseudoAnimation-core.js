/**
 * [ONI][PseudoAnim] Core API (Foundry VTT v12)
 * - Public API: game.ONI.pseudo.play(payload)
 * - Broadcasts to all clients via module socket: "fabula-ultima-companion"
 *
 * Socket channel used:
 *   game.socket.emit("module.fabula-ultima-companion", message)
 */

(() => {
  const TAG = "[ONI][PseudoAnim][Core]";
  const SOCKET_NS = "module.fabula-ultima-companion";
  const API_PATH = ["ONI", "pseudo"];
  const DEBUG = true;

  function log(...args) { if (DEBUG) console.log(TAG, ...args); }
  function warn(...args) { console.warn(TAG, ...args); }
  function err(...args) { console.error(TAG, ...args); }

  function ensureApiRoot() {
    game[API_PATH[0]] ??= {};
    game[API_PATH[0]][API_PATH[1]] ??= {};
    return game[API_PATH[0]][API_PATH[1]];
  }

function makeRunId() {
  // Foundry v12+: use foundry.utils.randomID (global randomID is deprecated)
  const rid = foundry?.utils?.randomID ? foundry.utils.randomID(6) : `${Math.random()}`.slice(2, 8);
  return `${Date.now()}-${rid}`;
}

  function normalizePayload(input) {
    const p = foundry.utils.deepClone(input ?? {});
    p.type = "oni.pseudo.play";
    p.runId ??= makeRunId();
    p.sentAt ??= Date.now();
    p.meta ??= {};
    p.meta.senderUserId ??= game.user?.id;
    p.meta.senderUserName ??= game.user?.name;
    return p;
  }

  function validateOutgoing(p) {
    if (!p.scriptId) return "Missing scriptId";
    // casterTokenUuid is optional for some scripts, but most need it.
    // We won't hard-require it here; listener scripts can enforce per-script.
    return null;
  }

  async function runLocallyIfPossible(msg) {
  const fn = game.ONI?.pseudo?._receive;
  if (typeof fn !== "function") {
    warn("Local receive not installed yet (listener missing or not ready).");
    return;
  }
  // Run locally on the broadcaster client
  try {
    await fn(msg);
  } catch (e) {
    err("Local playback error:", e);
  }
}

  function emitToAllClients(payload) {
    const msg = normalizePayload(payload);
    const bad = validateOutgoing(msg);
    if (bad) {
      warn("Blocked emit:", bad, msg);
      ui.notifications?.warn?.(`PseudoAnim blocked: ${bad}`);
      return null;
    }

    log(`EMIT runId=${msg.runId} scriptId=${msg.scriptId}`, msg);

    // Broadcast to everyone (including the sender)
game.socket.emit(SOCKET_NS, msg);

// IMPORTANT: Foundry module sockets may not echo back to sender,
// so we also run locally on the broadcaster client.
runLocallyIfPossible(msg);

return msg.runId;
  }

  Hooks.once("init", () => {
    const api = ensureApiRoot();

    api.play = emitToAllClients;

    // Convenience helper (optional): turn Token object into UUID
    api.uuidOfToken = (token) => token?.document?.uuid ?? token?.uuid ?? null;

    log("API ready: game.ONI.pseudo.play(payload)");
  });

})();
