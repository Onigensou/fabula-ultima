// ============================================================================
// expAwarder-ui-listener.js (Foundry V12 Module Script)
// - Listens on socket "module.fabula-ultima-companion"
// - When it receives an EXP UI event, it re-emits Hooks.callAll("oni:expAwarded")
// - Includes dedupe so clients won't play the same runId twice
// ============================================================================

(() => {
  const TAG = "[ONI][EXPAwarder][UIListener]";
  const DEBUG = true; // <-- toggle off when done

  const SOCKET_CHANNEL = "module.fabula-ultima-companion";
  const MSG_TYPE = "expAwarder:playUi";

  // Dedupe cache (per client)
  const DEDUPE_TTL_MS = 30_000;
  const seen = new Map(); // runId -> timestamp

  const log = (...a) => (DEBUG ? console.log(TAG, ...a) : null);
  const warn = (...a) => console.warn(TAG, ...a);
  const err = (...a) => console.error(TAG, ...a);

  function now() { return Date.now(); }

  function cleanupSeen() {
    const t = now();
    for (const [k, ts] of seen.entries()) {
      if (t - ts > DEDUPE_TTL_MS) seen.delete(k);
    }
  }

  function markSeen(runId) {
    cleanupSeen();
    if (!runId) return;
    seen.set(runId, now());
  }

  function hasSeen(runId) {
    cleanupSeen();
    if (!runId) return false;
    return seen.has(runId);
  }

  function isValidPayload(p) {
    return !!p && typeof p === "object" && Array.isArray(p.entries) && !!p.runId;
  }

  Hooks.once("ready", () => {
    try {
      if (!game?.socket) {
        warn("game.socket not found - cannot install socket listener.");
        return;
      }

      // Install listener
      game.socket.on(SOCKET_CHANNEL, (msg) => {
        try {
          if (!msg || msg.type !== MSG_TYPE) return;

          const payload = msg.payload;
          if (!isValidPayload(payload)) {
            warn("Received invalid payload", { msg });
            return;
          }

          // Dedupe
          if (hasSeen(payload.runId)) {
            log("Duplicate runId ignored", payload.runId);
            return;
          }

          markSeen(payload.runId);

          // Mark so broadcaster doesn't re-broadcast and loop
          const patched = { ...payload, __fromSocket: true };

          log("Received socket UI signal -> emitting local hook", {
            runId: patched.runId,
            entries: patched.entries?.length ?? 0,
            fromUser: msg.fromUser,
          });

          Hooks.callAll("oni:expAwarded", patched);
        } catch (e) {
          err("Socket handler crashed", e);
        }
      });

      log("Installed socket listener on", SOCKET_CHANNEL);
    } catch (e) {
      err("Listener boot crashed", e);
    }
  });
})();
