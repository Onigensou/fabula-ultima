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

// Normalize the two addressing forms into a deduped id array.
//
// Foundry relays a module socket to EVERY connected client — there is no
// server-side recipient routing — so addressing is done client-side by the
// `_isForMe` filter below. Emitting once per recipient therefore made a table
// of N clients pay N x N payload deliveries for N useful ones. Passing
// `targetUserIds` lets one emit serve every recipient that shares a payload,
// which collapses that back to N. The slowest connection at the table is the
// one that felt the multiplier, so this is the main lever for it.
//
// Returns [] when neither form is given — callers treat that as "no addressed
// recipient" (broadcastMenuClose keeps its own null == all-users semantics).
function normalizeTargets(targetUserId, targetUserIds) {
  const out = [];
  const push = (v) => { if (v && !out.includes(v)) out.push(v); };
  if (Array.isArray(targetUserIds)) targetUserIds.forEach(push);
  else push(targetUserIds);
  push(targetUserId);
  return out;
}

export class IntentChannel {
  constructor() {
    this.director = null; // set on GM via attachDirector(); stays null on players
    this._installed = false;
    this._socketHandler = null;
    // Pending awaitIntent() promises — id → { type, fromUserId, resolve, reject, timer }
    this._pendingAwaits = new Map();
    // Subscribers
    this._menuOpenHandlers = new Set();
    this._menuPatchHandlers = new Set();
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
      case "MENU_PATCH":    return this._onMenuPatch(data);
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
    // Secondary GM has no cached broadcasts — only the primary GM (who owns
    // _recentBroadcasts) should replay. Skip silently to avoid log noise.
    if (!this._recentBroadcasts.size) return;
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
    // Secondary GM: no director attached and no awaits pending — nothing to
    // do. Skip silently to prevent spurious "no director match" warnings.
    if (!this.director && this._pendingAwaits.size === 0) return;
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

  // Is this payload addressed to this client? Accepts the legacy single
  // `targetUserId` and the multi-recipient `targetUserIds` array. A null/absent
  // address matches nobody, which preserves the previous behavior for
  // MENU_CLOSE's `targetUserId: null` (GM-side uncache-all; never delivered).
  _isForMe(payload) {
    const me = game.user?.id ?? null;
    if (!me) return false;
    const many = payload?.targetUserIds;
    if (Array.isArray(many)) return many.includes(me);
    return payload?.targetUserId === me;
  }

  _onMenuOpen(data) {
    const payload = data.payload ?? {};
    if (!this._isForMe(payload)) return;
    log(`menu_open received: kind=${payload.menuSpec?.kind ?? "?"}`);
    for (const h of this._menuOpenHandlers) {
      try { h(payload.menuSpec, payload); } catch (e) { warn("onMenuOpen handler threw", e); }
    }
  }

  // In-place patch of an already-open menu. Player handler is expected to
  // mutate DOM rather than spawn a new menu — avoids the jarring redraw
  // of a despawn+spawn cycle (the load-bearing requirement for the
  // multi-reactor flow).
  _onMenuPatch(data) {
    const payload = data.payload ?? {};
    if (!this._isForMe(payload)) return;
    log(`menu_patch received: kind=${payload.patch?.kind ?? "?"}`);
    for (const h of this._menuPatchHandlers) {
      try { h(payload.patch, payload); } catch (e) { warn("onMenuPatch handler threw", e); }
    }
  }

  _onMenuClose(data) {
    const payload = data.payload ?? {};
    if (!this._isForMe(payload)) return;
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
  // Accepts a single `targetUserId` or a `targetUserIds` array. When the same
  // menuSpec goes to several recipients, pass the array — that ships ONE
  // envelope instead of one per user (see normalizeTargets).
  broadcastMenuOpen({ targetUserId = null, targetUserIds = null, menuSpec }) {
    if (!game.user?.isGM) return;
    const targets = normalizeTargets(targetUserId, targetUserIds);
    if (!targets.length) return;
    const requestId = foundry.utils?.randomID?.() ?? `bd-${Date.now()}`;

    this._emitRaw("MENU_OPEN", {
      requestId,
      // Keep the scalar populated for the single-recipient case so anything
      // reading it off the envelope still works.
      targetUserId: targets.length === 1 ? targets[0] : null,
      targetUserIds: targets,
      menuSpec,
    });

    // Cache for resync — one SINGLE-target entry per recipient. Replaying a
    // multi-target payload to one reconnecting user would re-open the menu on
    // every other recipient too, so the cache never stores the array form.
    const kind = menuSpec?.kind ?? null;
    for (const uid of targets) {
      const arr = this._recentBroadcasts.get(uid) ?? [];
      // De-dup by menuSpec.kind — only the latest broadcast of each kind
      // per user stays in cache. Prevents stale entries piling up.
      const filtered = arr.filter((p) => (p.menuSpec?.kind ?? null) !== kind);
      filtered.push({ requestId, targetUserId: uid, menuSpec });
      this._recentBroadcasts.set(uid, filtered);
    }
  }

  // GM-side: force-close a menu on a player's client (e.g. timeout,
  // GM-side cancel, director stopped mid-prompt). Also uncaches any
  // recent MENU_OPEN broadcast of the same kind so PLAYER_HELLO doesn't
  // replay it.
  broadcastMenuClose({ targetUserId = null, targetUserIds = null, kind = null, reason = null, data = null } = {}) {
    if (!game.user?.isGM) return;
    const targets = normalizeTargets(targetUserId, targetUserIds);
    // An explicitly-passed EMPTY recipient list means "nobody is listening"
    // (e.g. no active players), NOT the sweep-everyone form. Callers that used
    // to loop over an empty array did nothing; preserve that exactly, or a
    // solo-GM session would uncache every pending menu.
    if (!targets.length && Array.isArray(targetUserIds)) return;
    this._emitRaw("MENU_CLOSE", {
      // No addressed recipient keeps the historical `null` form: nothing is
      // delivered, and the uncache below sweeps every user.
      targetUserId: targets.length === 1 ? targets[0] : null,
      targetUserIds: targets.length ? targets : null,
      kind,
      reason,
      data,
    });
    // Uncache: no target means ALL active players (used by
    // director-boot.js stop() sweep). In that case clear the matching kind
    // for every user; otherwise clear it for each addressed user.
    if (!targets.length) {
      if (kind == null) this._recentBroadcasts.clear();
      else {
        for (const [uid, arr] of this._recentBroadcasts) {
          const filtered = arr.filter((p) => (p.menuSpec?.kind ?? null) !== kind);
          if (filtered.length) this._recentBroadcasts.set(uid, filtered);
          else this._recentBroadcasts.delete(uid);
        }
      }
    } else {
      for (const uid of targets) {
        const arr = this._recentBroadcasts.get(uid);
        if (!arr) continue;
        const filtered = kind == null
          ? []
          : arr.filter((p) => (p.menuSpec?.kind ?? null) !== kind);
        if (filtered.length) this._recentBroadcasts.set(uid, filtered);
        else this._recentBroadcasts.delete(uid);
      }
    }
  }

  // Player-side: register a handler for incoming MENU_OPEN events.
  // Returns an unregister function.
  onMenuOpen(handler) {
    this._menuOpenHandlers.add(handler);
    return () => this._menuOpenHandlers.delete(handler);
  }

  // Player-side: register a handler for incoming MENU_PATCH events.
  // Patch handlers are expected to mutate an already-open menu in place
  // (e.g. update disabled blade labels) — they do NOT spawn a new menu.
  // Returns an unregister function.
  onMenuPatch(handler) {
    this._menuPatchHandlers.add(handler);
    return () => this._menuPatchHandlers.delete(handler);
  }

  // GM-side: send an in-place patch to a player's open menu (e.g.
  // refresh disabled blade labels after a peer commits an action-
  // creating reaction). Best-effort: if the player's client lags or
  // hasn't received the prior MENU_OPEN yet, the patch is dropped on
  // their end (no spawn). The GM's authoritative state is the source
  // of truth — see the stale-click safeguard in
  // dispatchReactionMenu.processDecision for the recovery path.
  //
  // NOT cached for PLAYER_HELLO replay — only the latest MENU_OPEN
  // spec is replayed on resume. Patches are session-only.
  broadcastMenuPatch({ targetUserId = null, targetUserIds = null, patch } = {}) {
    if (!game.user?.isGM) return;
    const targets = normalizeTargets(targetUserId, targetUserIds);
    if (!targets.length) return;
    this._emitRaw("MENU_PATCH", {
      requestId: foundry.utils?.randomID?.() ?? `bd-${Date.now()}`,
      targetUserId: targets.length === 1 ? targets[0] : null,
      targetUserIds: targets,
      patch,
    });
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
