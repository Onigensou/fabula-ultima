// ============================================================================
// Camp System — Minigame spectator sync (CAMP.MG)
//
// Whoever plays a minigame, everyone else should SEE the same live game and
// HEAR the same sounds ("watching a friend play"). The older minigames each
// rolled their own owner check, played feedback sounds only on the player's
// screen and had no way back in after a reload. This file is the shared layer:
//
//   Owner      CAMP.MG.ownerUserId(actor) / CAMP.MG.isOwner(actorId)
//              One rule for every minigame: the spectator system's decider
//              (linked player → explicit owner → any owner, participants
//              only, online only), else the PRIMARY GM. Never two clients,
//              never the Spectator account.
//
//   Send       CAMP.Socket.send(type, payload)  (camp-socket.js)
//              Emit to everyone AND run locally, so a GM playing an
//              unowned actor reaches its own GM-side resolvers.
//
//   Events     CAMP.MG.event(game, actorId, kind, data)   player → others
//              CAMP.MG.on(game, (kind, data, msg) => {})  spectator side
//              A generic live channel so a game can stream extra state
//              (pointer anchors, slash trails, popups, sound cues) without
//              adding a socket message per game. Not echoed locally.
//
//   Sound      CAMP.MG.sfx(src, volume)  local play, same call on every screen.
//              The pattern: the player's screen plays a sound in its input
//              handler; the message it sends carries what happened; the
//              spectator handler plays the SAME src at the SAME volume.
//
//   Late join  CAMP.MG.registerGame(game, { snapshot, apply })
//              A page that loads while a minigame runs asks everyone
//              (MG_SYNC_REQ). The player's screen answers with the START
//              message it saw plus snapshot(); the reloaded page replays
//              that START through the router (opens the spectator overlay)
//              and hands the snapshot to apply(), which drops it into the
//              running game (game area, positions, score, time left).
//
// `game` keys are the CAMP.MSG prefixes: "TRAINING", "MIDNIGHT_OIL",
// "FISHING", … (CAMP_<KEY>_START).
// ============================================================================
(() => {
  const CAMP = globalThis.CampSystem ??= {};
  const TAG  = "[CampSystem][MG]";

  // Ask for running games this long after `ready`: the camp RESOLVE replay
  // (camp-bootstrap) goes first, so START/BEGIN usually exist already.
  const SYNC_REQ_DELAY_MS = 2500;

  const _games   = new Map();   // key → { snapshot, apply }
  const _subs    = new Map();   // key → Set<fn>
  const _starts  = new Map();   // key → { type, payload } last START seen here

  const _keyOfStart = (type) => {
    const m = /^CAMP_(.+)_START$/.exec(String(type ?? ""));
    return m ? m[1] : null;
  };
  const _keyOfDone = (type) => {
    const m = /^CAMP_(.+)_DONE$/.exec(String(type ?? ""));
    return m ? m[1] : null;
  };

  function _primaryGMId() {
    const fn = globalThis.FUCompanion?.api?.primaryGM ?? globalThis.FUCompanion?.primaryGM;
    try { const u = fn?.(); if (u) return u.id; } catch {}
    const active = game.users?.activeGM;
    if (active) return active.id;
    return game.users?.filter?.(u => u.isGM && u.active)
      ?.sort?.((a, b) => String(a.id).localeCompare(String(b.id)))?.[0]?.id ?? null;
  }

  function _actor(actorOrId) {
    if (!actorOrId) return null;
    return typeof actorOrId === "string" ? (game.actors?.get(actorOrId) ?? null) : actorOrId;
  }

  CAMP.MG = {
    // ── Owner rule ──────────────────────────────────────────────────────────
    ownerUserId(actorOrId) {
      const actor = _actor(actorOrId);
      const Sp = globalThis.FUCompanion?.api?.Spectator;
      let uid = null;
      try { uid = actor ? (Sp?.deciderUserIdForActor?.(actor) ?? null) : null; } catch {}
      return uid ?? _primaryGMId();
    },

    isOwner(actorOrId) {
      const uid = this.ownerUserId(actorOrId);
      return !!uid && uid === game.user?.id;
    },

    // The dedicated stream account(s) listed in "Always-spectator users".
    // NOT the same as Spectator.isSpectator(), which also matches players of
    // another campaign.
    isStreamSpectator(user = game.user) {
      try { return !!globalThis.FUCompanion?.api?.Spectator?.isAlwaysSpectator?.(user); } catch { return false; }
    },

    // ── Sound ───────────────────────────────────────────────────────────────
    sfx(src, volume = 0.7) {
      if (!src) return;
      try {
        const AH = foundry?.audio?.AudioHelper ?? globalThis.AudioHelper;
        AH.play({ src, volume, autoplay: true, loop: false }, false);
      } catch {
        try { const a = new Audio(src); a.volume = volume; a.play().catch(() => {}); } catch {}
      }
    },

    // ── Live events ─────────────────────────────────────────────────────────
    event(gameKey, actorId, kind, data = {}) {
      try {
        game.socket.emit(CAMP.SOCKET_CH, { type: CAMP.MSG.MG_EVENT, payload: { g: gameKey, a: actorId, k: kind, d: data } });
      } catch (e) { console.warn(TAG, "event emit failed", gameKey, kind, e); }
    },

    on(gameKey, fn) {
      if (!_subs.has(gameKey)) _subs.set(gameKey, new Set());
      _subs.get(gameKey).add(fn);
      return () => _subs.get(gameKey)?.delete(fn);
    },

    // ── Late join ───────────────────────────────────────────────────────────
    // spec: {
    //   snapshot(): object|null   player side; null = nothing running to share
    //   apply(snap, msg): void    spectator side; overlay is already open
    //   isOpen?(): bool           spectator side; true = skip replaying START
    // }
    registerGame(gameKey, spec) {
      _games.set(gameKey, spec ?? {});
    },

    // Called by the camp router for every message this page handles or sends.
    noteMessage(type, payload) {
      const s = _keyOfStart(type);
      if (s) { _starts.set(s, { type, payload: payload ?? {} }); return; }
      const d = _keyOfDone(type);
      if (d) _starts.delete(d);
    },

    // A GM that opens its own overlay calls this (its broadcast already does).
    noteStart(gameKey, payload) {
      const type = CAMP.MSG?.[`${gameKey}_START`];
      if (type) _starts.set(gameKey, { type, payload: payload ?? {} });
    },

    requestSync() {
      try {
        game.socket.emit(CAMP.SOCKET_CH, { type: CAMP.MSG.MG_SYNC_REQ, payload: { userId: game.user?.id } });
      } catch {}
    },

    async onSocket(type, payload = {}) {
      if (type === CAMP.MSG.MG_EVENT) {
        const subs = _subs.get(payload.g);
        if (!subs?.size) return;
        for (const fn of subs) {
          try { await fn(payload.k, payload.d ?? {}, payload); } catch (e) { console.warn(TAG, "event handler failed", payload.g, payload.k, e); }
        }
        return;
      }

      if (type === CAMP.MSG.MG_SYNC_REQ) {
        const userId = payload.userId;
        if (!userId || userId === game.user?.id) return;
        for (const [key, spec] of _games) {
          let snap = null;
          try { snap = spec.snapshot?.() ?? null; } catch (e) { console.warn(TAG, "snapshot failed", key, e); }
          if (!snap) continue;
          const start = _starts.get(key) ?? null;
          game.socket.emit(CAMP.SOCKET_CH, {
            type: CAMP.MSG.MG_SYNC,
            payload: { userId, g: key, a: snap.actorId ?? null, start, snap },
          });
        }
        return;
      }

      if (type === CAMP.MSG.MG_SYNC) {
        if (payload.userId !== game.user?.id) return;
        const spec = _games.get(payload.g);
        if (!spec) return;
        let open = false;
        try { open = !!spec.isOpen?.(); } catch {}
        if (!open && payload.start?.type) {
          await CAMP.Socket?._dispatch?.({ type: payload.start.type, payload: payload.start.payload ?? {} });
        }
        try { await spec.apply?.(payload.snap, payload); }
        catch (e) { console.warn(TAG, "snapshot apply failed", payload.g, e); }
      }
    },
  };

  Hooks.once("ready", () => {
    setTimeout(() => CAMP.MG.requestSync(), SYNC_REQ_DELAY_MS);
  });

  console.debug(TAG, "Minigame sync loaded.");
})();
