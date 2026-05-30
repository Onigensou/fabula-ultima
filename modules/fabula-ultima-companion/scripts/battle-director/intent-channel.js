// IntentChannel — GM ↔ player socket envelope.
//
// Per-client singleton, installed on `ready` for ALL users (not just GM).
// The GM client gets a `director` reference attached when start() runs and
// detached when stop() runs; player clients keep the channel installed for
// the whole session with director=null.
//
// Roles:
//   - GM:     receives INTENT events from players and either resolves a
//             pending `awaitIntent()` Promise OR dispatches to the running
//             director. Broadcasts MENU_OPEN / MENU_CLOSE / PING to players.
//   - Player: receives MENU_OPEN / MENU_CLOSE / PING events targeted at
//             this user. Calls registered `onMenuOpen` handlers to spawn
//             local UI, replies to PINGs with PONG.
//
// All payloads use namespace "battle-director".
//
// See [[director-player-driven-input]] for the migration plan that this
// scaffolding supports.

import { log, warn } from "./logger.js";

const NS = "battle-director";
const CHANNEL = "module.fabula-ultima-companion";

let _instance = null;

export class IntentChannel {
  constructor() {
    this.director = null; // set on GM via attachDirector(); stays null on players
    this._installed = false;
    this._socketHandler = null;
    // Pending awaitIntent() promises — id → { type, fromUserId, resolve, reject, timer }
    this._pendingAwaits = new Map();
    // Subscribers
    this._menuOpenHandlers = new Set();
    this._menuCloseHandlers = new Set();
    this._pongHandlers = new Set();
    // GM-side cache of recently-broadcast MENU_OPEN payloads, keyed by
    // targetUserId. Used by PLAYER_HELLO to re-broadcast on player
    // late-join (e.g. player's `ready` hook finished AFTER the GM's
    // broadcast fired during resumeFromSavedState — race condition).
    // Entries auto-removed when a matching MENU_CLOSE broadcasts.
    this._recentBroadcasts = new Map();
  }

  install() {
    if (this._installed) return;
    if (!game.socket) {
      warn("IntentChannel.install: game.socket unavailable");
      return;
    }
    this._socketHandler = (data) => this._onSocket(data);
    game.socket.on(CHANNEL, this._socketHandler);
    this._installed = true;
    log(`IntentChannel installed (${game.user?.isGM ? "GM" : "player"} ${game.user?.name ?? "?"})`);
  }

  uninstall() {
    if (!this._installed) return;
    try { game.socket.off(CHANNEL, this._socketHandler); } catch (e) { warn("IntentChannel.uninstall failed", e); }
    this._installed = false;
    this._socketHandler = null;
    // Reject any in-flight awaits — caller will see the cancellation.
    for (const [id, entry] of this._pendingAwaits) {
      try { clearTimeout(entry.timer); } catch {}
      try { entry.reject(new Error("IntentChannel uninstalled")); } catch {}
    }
    this._pendingAwaits.clear();
    log("IntentChannel uninstalled");
  }

  // ─── Socket dispatch ────────────────────────────────────────────────

  _onSocket(data) {
    if (!data || data.ns !== NS) return;
    switch (data.event) {
      case "INTENT":        return this._onIntent(data);
      case "MENU_OPEN":     return this._onMenuOpen(data);
      case "MENU_CLOSE":    return this._onMenuClose(data);
      case "PING":          return this._onPing(data);
      case "PONG":          return this._onPong(data);
      case "PLAYER_HELLO":  return this._onPlayerHello(data);
      default: return;
    }
  }

  // GM-side: a player just announced they're ready (handlers attached).
  // Re-emit any cached MENU_OPEN broadcasts targeted at this user that
  // may have been sent before their socket handlers were attached
  // (resume-after-F5 race condition).
  _onPlayerHello(data) {
    if (!game.user?.isGM) return;
    const userId = data.payload?.fromUserId;
    if (!userId) return;
    const cached = this._recentBroadcasts.get(userId);
    if (!cached || !cached.length) {
      log(`PLAYER_HELLO from ${userId} — no cached broadcasts to replay`);
      return;
    }
    log(`PLAYER_HELLO from ${userId} — replaying ${cached.length} cached broadcast(s)`);
    for (const payload of cached) {
      try { this._emitRaw("MENU_OPEN", payload); }
      catch (e) { warn("PLAYER_HELLO replay failed", e); }
    }
  }

  // Player-side: announce that handlers are installed and we're ready to
  // receive MENU_OPEN broadcasts. GM-side handler in _onPlayerHello replays
  // any cached payloads. Called from director-boot.js's ready hook on
  // non-GM clients after registerPlayer*Handler calls.
  announceReady() {
    if (game.user?.isGM) return;
    this._emitRaw("PLAYER_HELLO", { fromUserId: game.user?.id ?? null });
  }

  // GM-side: an intent arrived from a player. Try to satisfy a pending
  // awaitIntent first; if nothing's waiting, fall back to dispatching into
  // the director (legacy v1 behavior).
  _onIntent(data) {
    if (!game.user?.isGM) return;
    const payload = data.payload ?? {};
    if (!payload.fromUserId || !payload.type) {
      warn("IntentChannel: malformed intent from socket", data);
      return;
    }
    const user = game.users?.get(payload.fromUserId);
    if (!user) {
      warn("IntentChannel: unknown fromUserId on intent", payload.fromUserId);
      return;
    }

    const intent = {
      type: payload.type,
      body: payload.body,
      fromUserId: payload.fromUserId,
      combatId: payload.combatId,
    };

    // 1) Try to resolve a pending awaitIntent listener.
    if (this._tryResolveAwait(intent)) {
      log(`intent → resolved awaitIntent (${payload.type} from ${user.name})`);
      return;
    }

    // 2) Fallback: dispatch into the running director (legacy v1 path).
    if (this.director && payload.combatId === this.director.combatId) {
      log(`intent → director.dispatch (${payload.type} from ${user.name})`);
      this.director.dispatch({ type: payload.type, body: payload.body });
      return;
    }

    warn(`intent had no awaiter and no director match (${payload.type} from ${user.name})`);
  }

  _onMenuOpen(data) {
    const payload = data.payload ?? {};
    if (payload.targetUserId !== game.user?.id) return;
    log(`menu_open received: kind=${payload.menuSpec?.kind ?? "?"}`);
    for (const h of this._menuOpenHandlers) {
      try { h(payload.menuSpec, payload); } catch (e) { warn("onMenuOpen handler threw", e); }
    }
  }

  _onMenuClose(data) {
    const payload = data.payload ?? {};
    if (payload.targetUserId !== game.user?.id) return;
    log(`menu_close received: kind=${payload.kind ?? "?"}`);
    for (const h of this._menuCloseHandlers) {
      try { h(payload); } catch (e) { warn("onMenuClose handler threw", e); }
    }
  }

  // PING from a remote client → echo PONG back to sender.
  _onPing(data) {
    const payload = data.payload ?? {};
    if (payload.targetUserId !== game.user?.id) return;
    log(`ping received from ${payload.fromUserId} (pingId=${payload.pingId}) → replying pong`);
    this._emitRaw("PONG", {
      pingId: payload.pingId,
      fromUserId: game.user?.id ?? null,
      targetUserId: payload.fromUserId,
      payload: payload.payload ?? null,
      receivedAt: Date.now(),
    });
  }

  // PONG from a remote client → match against pending ping() promises.
  _onPong(data) {
    const payload = data.payload ?? {};
    if (payload.targetUserId !== game.user?.id) return;
    for (const h of this._pongHandlers) {
      try { h(payload); } catch (e) { warn("onPong handler threw", e); }
    }
  }

  // ─── Emit primitives ────────────────────────────────────────────────

  _emitRaw(event, payload) {
    if (!game.socket) {
      warn(`IntentChannel._emitRaw(${event}): no socket`);
      return;
    }
    const env = {
      ns: NS,
      event,
      payload,
      senderUserId: game.user?.id ?? null,
      timestamp: Date.now(),
    };
    game.socket.emit(CHANNEL, env);
  }

  // Player-side (or GM-side): emit an INTENT envelope. GM rarely calls
  // this — they dispatch locally. Players call it from every UI surface
  // to forward their click decisions to the GM director.
  emit(intent) {
    const payload = {
      requestId: foundry.utils?.randomID?.() ?? `bd-${Date.now()}`,
      combatId: this.director?.combatId ?? intent.combatId ?? null,
      fromUserId: game.user?.id ?? null,
      type: intent.type,
      body: intent.body ?? null,
    };
    this._emitRaw("INTENT", payload);
  }

  // GM-side: return a Promise that resolves with the next matching intent
  // (either via socket from a player or via local dispatch). Resolves the
  // FIRST match; subsequent matches go to the director's normal dispatch.
  //
  // Options:
  //   - timeoutMs:  default 60000. On timeout the Promise rejects.
  //   - fromUserId: if set, only intents from this user satisfy the await.
  awaitIntent(type, { timeoutMs = 60000, fromUserId = null } = {}) {
    if (!game.user?.isGM) {
      return Promise.reject(new Error("awaitIntent is GM-only"));
    }
    let resolveFn, rejectFn;
    const promise = new Promise((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });
    const id = foundry.utils?.randomID?.() ?? `await-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const entry = { id, type, fromUserId, resolve: resolveFn, reject: rejectFn, timer: null };
    entry.timer = setTimeout(() => {
      this._pendingAwaits.delete(id);
      rejectFn(new Error(`awaitIntent timeout (${type}, ${timeoutMs}ms)`));
    }, timeoutMs);
    this._pendingAwaits.set(id, entry);
    // Hang `abort()` off the returned Promise so callers can clean up
    // unused awaits. CRITICAL for pair-style usage (e.g. postActionCard
    // awaits both CONFIRM_ACTION + CANCEL_ACTION — only one fires; the
    // other must be aborted or it lingers in _pendingAwaits and the
    // NEXT turn's await of the same type gets consumed by the stale
    // entry instead of the current one.
    promise.abort = (reason = "aborted") => {
      if (!this._pendingAwaits.has(id)) return;
      try { clearTimeout(entry.timer); } catch {}
      this._pendingAwaits.delete(id);
      try { rejectFn(new Error(reason)); } catch {}
    };
    return promise;
  }

  _tryResolveAwait(intent) {
    for (const [id, entry] of this._pendingAwaits) {
      if (entry.type !== intent.type) continue;
      if (entry.fromUserId && entry.fromUserId !== intent.fromUserId) continue;
      try { clearTimeout(entry.timer); } catch {}
      this._pendingAwaits.delete(id);
      try { entry.resolve(intent); } catch (e) { warn("awaitIntent resolve threw", e); }
      return true;
    }
    return false;
  }

  // GM-side: locally dispatch an intent as if it arrived from a player.
  // Used when the GM clicks a button on their own NPC's overlay — same
  // code path that awaitIntent uses for socket intents, so state handlers
  // don't have to special-case "GM clicked their own button".
  dispatchLocalIntent(intent) {
    if (!game.user?.isGM) {
      warn("dispatchLocalIntent called on non-GM client");
      return;
    }
    const wrapped = {
      type: intent.type,
      body: intent.body ?? null,
      fromUserId: game.user?.id ?? null,
      combatId: this.director?.combatId ?? null,
    };
    if (this._tryResolveAwait(wrapped)) {
      log(`local intent → resolved awaitIntent (${intent.type})`);
      return;
    }
    if (this.director) {
      log(`local intent → director.dispatch (${intent.type})`);
      this.director.dispatch({ type: intent.type, body: intent.body });
    } else {
      warn(`local intent had no awaiter and no director (${intent.type})`);
    }
  }

  // GM-side: tell a specific user's client to open a menu (turn UI, target
  // picker, skill picker, etc.). The payload is also cached against
  // `targetUserId` so a player re-joining (or finishing a slow `ready`
  // boot) can request replay via PLAYER_HELLO.
  broadcastMenuOpen({ targetUserId, menuSpec }) {
    if (!game.user?.isGM) return;
    const payload = {
      requestId: foundry.utils?.randomID?.() ?? `bd-${Date.now()}`,
      targetUserId,
      menuSpec,
    };
    this._emitRaw("MENU_OPEN", payload);
    // Cache for resync.
    let arr = this._recentBroadcasts.get(targetUserId);
    if (!arr) { arr = []; this._recentBroadcasts.set(targetUserId, arr); }
    // De-dup by menuSpec.kind — only the latest broadcast of each kind
    // per user stays in cache. Prevents stale entries piling up.
    const kind = menuSpec?.kind ?? null;
    const filtered = arr.filter((p) => (p.menuSpec?.kind ?? null) !== kind);
    filtered.push(payload);
    this._recentBroadcasts.set(targetUserId, filtered);
  }

  // GM-side: force-close a menu on a player's client (e.g. timeout,
  // GM-side cancel, director stopped mid-prompt). Also uncaches any
  // recent MENU_OPEN broadcast of the same kind so PLAYER_HELLO doesn't
  // replay it.
  broadcastMenuClose({ targetUserId, kind = null, reason = null, data = null } = {}) {
    if (!game.user?.isGM) return;
    this._emitRaw("MENU_CLOSE", {
      targetUserId,
      kind,
      reason,
      data,
    });
    // Uncache: targetUserId === null means broadcast to ALL active
    // players (used by director-boot.js stop() sweep). In that case
    // clear the matching kind for every user.
    if (targetUserId == null) {
      if (kind == null) this._recentBroadcasts.clear();
      else {
        for (const [uid, arr] of this._recentBroadcasts) {
          const filtered = arr.filter((p) => (p.menuSpec?.kind ?? null) !== kind);
          if (filtered.length) this._recentBroadcasts.set(uid, filtered);
          else this._recentBroadcasts.delete(uid);
        }
      }
    } else {
      const arr = this._recentBroadcasts.get(targetUserId);
      if (arr) {
        const filtered = kind == null
          ? []
          : arr.filter((p) => (p.menuSpec?.kind ?? null) !== kind);
        if (filtered.length) this._recentBroadcasts.set(targetUserId, filtered);
        else this._recentBroadcasts.delete(targetUserId);
      }
    }
  }

  // Player-side: register a handler for incoming MENU_OPEN events.
  // Returns an unregister function.
  onMenuOpen(handler) {
    this._menuOpenHandlers.add(handler);
    return () => this._menuOpenHandlers.delete(handler);
  }

  // Player-side: register a handler for incoming MENU_CLOSE events.
  // Returns an unregister function.
  onMenuClose(handler) {
    this._menuCloseHandlers.add(handler);
    return () => this._menuCloseHandlers.delete(handler);
  }

  // ─── Ping / pong (diagnostics + step-1 validation) ──────────────────

  // Send a PING to a remote client and resolve when its PONG arrives.
  // Returns { rtt: ms, fromUserId, payload }. Rejects on timeout.
  ping(targetUserId, payload = null, { timeoutMs = 5000 } = {}) {
    return new Promise((resolve, reject) => {
      const pingId = foundry.utils?.randomID?.() ?? `ping-${Date.now()}`;
      const startedAt = Date.now();
      const handler = (pong) => {
        if (pong.pingId !== pingId) return;
        try { clearTimeout(timer); } catch {}
        this._pongHandlers.delete(handler);
        resolve({
          rtt: Date.now() - startedAt,
          fromUserId: pong.fromUserId,
          payload: pong.payload,
        });
      };
      const timer = setTimeout(() => {
        this._pongHandlers.delete(handler);
        reject(new Error(`ping timeout (${timeoutMs}ms) — target user may be offline`));
      }, timeoutMs);
      this._pongHandlers.add(handler);
      this._emitRaw("PING", {
        pingId,
        fromUserId: game.user?.id ?? null,
        targetUserId,
        payload,
      });
    });
  }
}

// ─── Singleton + lifecycle helpers ────────────────────────────────────

// Return the per-client singleton. Lazy-instantiates on first call.
export function getIntentChannel() {
  if (!_instance) _instance = new IntentChannel();
  return _instance;
}

// GM-only: attach the running director so INTENT fallbacks can dispatch
// into the FSM. Also installs the channel if it wasn't already (defensive).
export function attachDirector(director) {
  const ch = getIntentChannel();
  ch.director = director;
  if (!ch._installed) ch.install();
  return ch;
}

// GM-only: detach director on stop. The channel stays installed for
// future starts AND for handling player-side events on this client.
export function detachDirector() {
  const ch = _instance;
  if (!ch) return;
  ch.director = null;
}
