/**
 * [ONI] Reaction Exchange — Socket Sync Layer (Foundry VTT v12)
 * ---------------------------------------------------------------------------
 * Bridges the GM-authoritative state machine (`oni.ReactionExchange`) to
 * non-GM clients via the module socket channel.
 *
 * Architecture:
 *
 *   GM client                           Non-GM client
 *   ──────────                          ──────────────
 *   ReactionExchange (state)            (no state machine instance)
 *        │                                       │
 *        │  emits oni:exchange:{opened,         │
 *        │       mutated, resolving, closed}    │
 *        ▼                                       │
 *   ReactionExchangeSync ───socket───►    ReactionExchangeSync
 *   (broadcasts Snapshot/Closed)         (updates mirror; re-emits local hooks)
 *        ▲                                       │
 *        │  socket: Request                      │
 *        └───────────────────────────────────────┘
 *
 * Hook contract: the SAME hook names (`oni:exchange:opened`, etc.) fire on
 * every client. UI code subscribes to those without caring which client it's
 * running on. Hook payload always carries the full snapshot.
 *
 * Step 1 scope (this file):
 *   - GM broadcasts full snapshots after each state-machine mutation
 *     (no diff optimization yet — step 6 if needed)
 *   - Non-GM maintains a read-only mirror Map<exchangeId, snapshot>
 *   - Non-GM exposes `request*` wrappers that send Request socket messages
 *   - GM handles Request messages by applying via the local state machine
 *   - Late-join: non-GM can `requestSnapshot(exchangeId)` and GM responds
 *
 * Not in scope (step 1):
 *   - Diff-based sync (snapshots are always full state)
 *   - Reconcile-on-reconnect across persistent GM swap (treated as forcibly
 *     closed by the state machine)
 *
 * Public API (window["oni.ReactionExchangeSync"] / FUCompanion.api.reactionExchangeSync):
 *   - getMirror(exchangeId)            — read-only snapshot; works on both
 *                                        GM (delegates to state machine) and
 *                                        non-GM (reads mirror)
 *   - listMirror()                     — list all known exchanges
 *   - requestAddEntry(exchangeId, params)
 *   - requestRemoveEntry(exchangeId, entryId)
 *   - requestReorderEntry(exchangeId, entryId, newIndex)
 *   - requestSetReady(exchangeId, isReady)
 *   - requestForceResolve(exchangeId)
 *   - requestSnapshot(exchangeId)      — non-GM asks GM for current state
 *
 * Socket message envelope:
 *   { type: "OniReactionExchange:<kind>", payload: { ... } }
 *
 * `<kind>` values:
 *   - "Snapshot"        — GM → all (state changed)
 *   - "Closed"          — GM → all (exchange closed)
 *   - "Request"         — non-GM → GM (mutation request)
 *   - "Result"          — GM → originator (success / error)
 *   - "SnapshotRequest" — non-GM → GM (ask for current state of an exchange)
 * ---------------------------------------------------------------------------
 */

Hooks.once("ready", () => {
  (() => {
    const KEY = "oni.ReactionExchangeSync";
    if (window[KEY]) {
      console.debug("[ReactionExchangeSync] Already installed.");
      return;
    }

    const TAG = "[ReactionExchangeSync]";
    const MODULE_ID = "fabula-ultima-companion";
    const CHANNEL = `module.${MODULE_ID}`;

    const exchangeApi = window["oni.ReactionExchange"];
    if (!exchangeApi) {
      console.error(`${TAG} oni.ReactionExchange not loaded; load reaction-exchange.js before reaction-exchange-sync.js.`);
      return;
    }

    // -------------------------------------------------------------------------
    // Mirror state (non-GM clients hold a read-only view; GM uses the state
    // machine directly but the mirror is also populated on GM for uniform
    // read access)
    // -------------------------------------------------------------------------

    /** @type {Map<string, object>} exchangeId → snapshot */
    const _mirror = new Map();

    /** @type {Map<string, { resolve: Function, reject: Function, timer: any }>}
     *  requestId → resolver state, for awaitable request*/
    const _pendingRequests = new Map();

    function _randId(prefix) {
      const rnd = foundry?.utils?.randomID?.()
        ?? (Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
      return `${prefix}-${rnd}`;
    }

    function _isGM() {
      return !!game.user?.isGM;
    }

    function _userId() {
      return game.user?.id ?? null;
    }

    function _clone(v) {
      if (foundry?.utils?.deepClone) return foundry.utils.deepClone(v);
      return JSON.parse(JSON.stringify(v));
    }

    // -------------------------------------------------------------------------
    // Mirror maintenance
    // -------------------------------------------------------------------------

    function _updateMirrorFromSnapshot(snapshot) {
      if (!snapshot?.exchangeId) return;
      // Stale-write guard: ignore snapshots older than the one we already hold.
      const existing = _mirror.get(snapshot.exchangeId);
      if (existing && existing.version != null && snapshot.version != null) {
        if (snapshot.version < existing.version) {
          console.debug(`${TAG} dropping stale snapshot`, {
            exchangeId: snapshot.exchangeId,
            existingVersion: existing.version,
            incomingVersion: snapshot.version
          });
          return;
        }
      }
      _mirror.set(snapshot.exchangeId, _clone(snapshot));
    }

    function _removeFromMirror(exchangeId) {
      _mirror.delete(exchangeId);
    }

    // -------------------------------------------------------------------------
    // GM-side: hook listeners → socket broadcast
    // -------------------------------------------------------------------------

    function _broadcastSnapshot(snapshot) {
      if (!game.socket) return;
      try {
        game.socket.emit(CHANNEL, {
          type: "OniReactionExchange:Snapshot",
          payload: { snapshot }
        });
      } catch (e) {
        console.warn(`${TAG} broadcast Snapshot failed`, e);
      }
    }

    function _broadcastClosed(snapshot, reason) {
      if (!game.socket) return;
      try {
        game.socket.emit(CHANNEL, {
          type: "OniReactionExchange:Closed",
          payload: { snapshot, reason }
        });
      } catch (e) {
        console.warn(`${TAG} broadcast Closed failed`, e);
      }
    }

    // GM listens to the local state machine's hooks and broadcasts.
    // Non-GM clients also receive these hooks LOCALLY (when this file
    // re-emits them after a socket message) so subscribers don't need to
    // branch on isGM. To avoid GM re-broadcasting non-GM-originated
    // hook fires, we check isGM in the broadcast handlers.

    Hooks.on("oni:exchange:opened", ({ snapshot }) => {
      _updateMirrorFromSnapshot(snapshot);
      if (_isGM()) _broadcastSnapshot(snapshot);
    });

    Hooks.on("oni:exchange:mutated", ({ snapshot }) => {
      _updateMirrorFromSnapshot(snapshot);
      if (_isGM()) _broadcastSnapshot(snapshot);
    });

    Hooks.on("oni:exchange:resolving", ({ snapshot }) => {
      _updateMirrorFromSnapshot(snapshot);
      if (_isGM()) _broadcastSnapshot(snapshot);
    });

    Hooks.on("oni:exchange:closed", ({ snapshot, reason }) => {
      // Keep the final snapshot in the mirror momentarily so UI cleanup
      // can read its contents; the next "opened" / mirror flush will GC.
      _updateMirrorFromSnapshot(snapshot);
      if (_isGM()) _broadcastClosed(snapshot, reason);
      // GC the mirror entry shortly after broadcast.
      setTimeout(() => _removeFromMirror(snapshot.exchangeId), 5000);
    });

    // -------------------------------------------------------------------------
    // GM-side: handle Request messages from non-GM
    // -------------------------------------------------------------------------

    function _sendResultTo(originUserId, requestId, ok, errorMessage = null, data = null) {
      if (!game.socket) return;
      try {
        game.socket.emit(CHANNEL, {
          type: "OniReactionExchange:Result",
          payload: { requestId, originUserId, ok, errorMessage, data }
        });
      } catch (e) {
        console.warn(`${TAG} send Result failed`, e);
      }
    }

    function _handleRequest(msg) {
      // GM-only handler.
      if (!_isGM()) return;
      const payload = msg?.payload ?? {};
      const { requestId, originUserId, op, args } = payload;
      if (!requestId || !originUserId || !op) {
        console.warn(`${TAG} malformed Request`, payload);
        return;
      }

      try {
        let resultData = null;
        switch (op) {
          case "addEntry": {
            const eid = String(args?.exchangeId ?? "");
            const params = args?.params ?? {};
            // Force the params.userId to the originator (security: a player
            // cannot queue on someone else's behalf via socket).
            params.userId = originUserId;
            const entryId = exchangeApi.addEntry(eid, params, originUserId);
            resultData = { entryId };
            break;
          }
          case "removeEntry": {
            exchangeApi.removeEntry(args?.exchangeId, args?.entryId, originUserId);
            break;
          }
          case "reorderEntry": {
            exchangeApi.reorderEntry(args?.exchangeId, args?.entryId, args?.newIndex, originUserId);
            break;
          }
          case "setReady": {
            // Only the originator can set their own ready via socket.
            exchangeApi.setReady(args?.exchangeId, originUserId, !!args?.isReady, originUserId);
            break;
          }
          case "forceResolve": {
            exchangeApi.forceResolve(args?.exchangeId, originUserId);
            break;
          }
          default:
            throw new Error(`unknown op "${op}"`);
        }
        _sendResultTo(originUserId, requestId, true, null, resultData);
      } catch (e) {
        console.warn(`${TAG} Request failed`, { op, originUserId, error: e?.message });
        _sendResultTo(originUserId, requestId, false, String(e?.message ?? e));
      }
    }

    function _handleSnapshotRequest(msg) {
      if (!_isGM()) return;
      const payload = msg?.payload ?? {};
      const { requestId, originUserId, exchangeId } = payload;
      if (!requestId || !originUserId) return;
      try {
        const snap = exchangeApi.snapshot(exchangeId);
        _sendResultTo(originUserId, requestId, true, null, { snapshot: snap });
      } catch (e) {
        _sendResultTo(originUserId, requestId, false, String(e?.message ?? e));
      }
    }

    // -------------------------------------------------------------------------
    // Non-GM-side: handle incoming Snapshot/Closed messages
    // -------------------------------------------------------------------------

    function _handleSnapshot(msg) {
      const snapshot = msg?.payload?.snapshot;
      if (!snapshot) return;
      _updateMirrorFromSnapshot(snapshot);
      // On non-GM clients, the state machine never emitted local hooks for
      // this update (it's not even installed for writes). Emit them here so
      // UI subscribers fire uniformly across clients.
      if (_isGM()) {
        // GM already saw this via the state machine; don't double-emit.
        return;
      }
      // Decide which hook to emit based on the snapshot status / mutation.
      // We don't know the original mutation kind on the wire (we only carry
      // the snapshot), so we route by status transition heuristically.
      // For step 1, opened-vs-mutated isn't load-bearing for UI — the
      // payload tells you the version and status. Emit a single canonical
      // hook and let UI key off snapshot.status.
      Hooks.callAll("oni:exchange:mutated", {
        exchangeId: snapshot.exchangeId,
        snapshot: _clone(snapshot),
        mutation: "remote"
      });
      if (snapshot.status === "resolving") {
        Hooks.callAll("oni:exchange:resolving", {
          exchangeId: snapshot.exchangeId,
          snapshot: _clone(snapshot)
        });
      }
    }

    function _handleClosed(msg) {
      const snapshot = msg?.payload?.snapshot;
      const reason = msg?.payload?.reason ?? "unspecified";
      if (!snapshot) return;
      _updateMirrorFromSnapshot(snapshot);
      if (_isGM()) return; // GM saw local hook; don't double-emit
      Hooks.callAll("oni:exchange:closed", {
        exchangeId: snapshot.exchangeId,
        snapshot: _clone(snapshot),
        reason
      });
      setTimeout(() => _removeFromMirror(snapshot.exchangeId), 5000);
    }

    function _handleResult(msg) {
      const { requestId, originUserId, ok, errorMessage, data } = msg?.payload ?? {};
      if (!requestId) return;
      // Result messages are broadcast to all clients (we route on originUserId
      // here so only the requester reacts).
      if (originUserId !== _userId()) return;
      const pending = _pendingRequests.get(requestId);
      if (!pending) return;
      _pendingRequests.delete(requestId);
      try { clearTimeout(pending.timer); } catch (_) {}
      if (ok) pending.resolve(data ?? null);
      else pending.reject(new Error(errorMessage ?? "request_failed"));
    }

    // -------------------------------------------------------------------------
    // Socket router
    // -------------------------------------------------------------------------

    function _onSocketMessage(msg) {
      if (!msg || typeof msg !== "object") return;
      switch (msg.type) {
        case "OniReactionExchange:Snapshot":        return _handleSnapshot(msg);
        case "OniReactionExchange:Closed":          return _handleClosed(msg);
        case "OniReactionExchange:Request":         return _handleRequest(msg);
        case "OniReactionExchange:SnapshotRequest": return _handleSnapshotRequest(msg);
        case "OniReactionExchange:Result":          return _handleResult(msg);
        default: return; // not ours
      }
    }

    if (game.socket) {
      game.socket.on(CHANNEL, _onSocketMessage);
      console.debug(`${TAG} Socket listener attached on ${CHANNEL} for user ${_userId()}.`);
    } else {
      console.warn(`${TAG} game.socket unavailable at ready; sync disabled.`);
    }

    // -------------------------------------------------------------------------
    // Request* wrappers (non-GM path)
    // -------------------------------------------------------------------------

    const REQUEST_TIMEOUT_MS = 5000;

    function _sendRequest(op, args = {}) {
      if (!game.socket) return Promise.reject(new Error("no_socket"));
      const requestId = _randId("req");
      const originUserId = _userId();
      const promise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          _pendingRequests.delete(requestId);
          reject(new Error("request_timeout"));
        }, REQUEST_TIMEOUT_MS);
        _pendingRequests.set(requestId, { resolve, reject, timer });
      });
      try {
        game.socket.emit(CHANNEL, {
          type: "OniReactionExchange:Request",
          payload: { requestId, originUserId, op, args }
        });
      } catch (e) {
        _pendingRequests.delete(requestId);
        return Promise.reject(e);
      }
      return promise;
    }

    async function requestAddEntry(exchangeId, params) {
      if (_isGM()) {
        // GM-local path: ensure userId is present (defaults to current
        // user). Non-GM path forces it server-side via _handleRequest.
        const p = { ...(params ?? {}) };
        if (!p.userId) p.userId = _userId();
        const entryId = exchangeApi.addEntry(exchangeId, p, _userId());
        return { entryId };
      }
      return _sendRequest("addEntry", { exchangeId, params });
    }

    async function requestRemoveEntry(exchangeId, entryId) {
      if (_isGM()) {
        exchangeApi.removeEntry(exchangeId, entryId, _userId());
        return null;
      }
      return _sendRequest("removeEntry", { exchangeId, entryId });
    }

    async function requestReorderEntry(exchangeId, entryId, newIndex) {
      if (_isGM()) {
        exchangeApi.reorderEntry(exchangeId, entryId, newIndex, _userId());
        return null;
      }
      return _sendRequest("reorderEntry", { exchangeId, entryId, newIndex });
    }

    async function requestSetReady(exchangeId, isReady) {
      if (_isGM()) {
        exchangeApi.setReady(exchangeId, _userId(), !!isReady, _userId());
        return null;
      }
      return _sendRequest("setReady", { exchangeId, isReady: !!isReady });
    }

    async function requestForceResolve(exchangeId) {
      if (_isGM()) {
        exchangeApi.forceResolve(exchangeId, _userId());
        return null;
      }
      return _sendRequest("forceResolve", { exchangeId });
    }

    async function requestSnapshot(exchangeId) {
      if (_isGM()) {
        const snap = exchangeApi.snapshot(exchangeId);
        return { snapshot: snap };
      }
      if (!game.socket) throw new Error("no_socket");
      const requestId = _randId("req");
      const originUserId = _userId();
      const promise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          _pendingRequests.delete(requestId);
          reject(new Error("request_timeout"));
        }, REQUEST_TIMEOUT_MS);
        _pendingRequests.set(requestId, { resolve, reject, timer });
      });
      game.socket.emit(CHANNEL, {
        type: "OniReactionExchange:SnapshotRequest",
        payload: { requestId, originUserId, exchangeId }
      });
      return promise;
    }

    // -------------------------------------------------------------------------
    // Read accessors (mirror-backed; safe on all clients)
    // -------------------------------------------------------------------------

    function getMirror(exchangeId) {
      // GM: delegate to state machine for freshness
      if (_isGM()) {
        const fresh = exchangeApi.snapshot(exchangeId);
        if (fresh) return fresh;
      }
      const cached = _mirror.get(exchangeId);
      return cached ? _clone(cached) : null;
    }

    function listMirror() {
      if (_isGM()) {
        // Authoritative — return live state machine listing.
        return exchangeApi.listActive();
      }
      const out = [];
      for (const snap of _mirror.values()) out.push(_clone(snap));
      return out;
    }

    function _testReset() {
      _mirror.clear();
      for (const [reqId, p] of _pendingRequests) {
        try { clearTimeout(p.timer); } catch (_) {}
        try { p.reject(new Error("test_reset")); } catch (_) {}
      }
      _pendingRequests.clear();
    }

    // -------------------------------------------------------------------------
    // Export
    // -------------------------------------------------------------------------

    const api = {
      getMirror,
      listMirror,
      requestAddEntry,
      requestRemoveEntry,
      requestReorderEntry,
      requestSetReady,
      requestForceResolve,
      requestSnapshot,
      _testReset
    };

    window[KEY] = api;

    globalThis.FUCompanion ??= {};
    globalThis.FUCompanion.api ??= {};
    globalThis.FUCompanion.api.reactionExchangeSync = api;

    console.debug(`${TAG} Installed. isGM=${_isGM()}.`);
  })();
});
