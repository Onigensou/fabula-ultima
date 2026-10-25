// ============================================================================
// Shared — Mirror Prompt (one client operates, everyone else watches)
//
// "Console at a friend's house": the Main Controller holds the pad and answers
// a prompt; every other client (party players, the stream spectator, GMs)
// sees the SAME prompt read-only, with the operator's highlight echoed live,
// and it closes everywhere when the operator answers.
//
// This is a transport + lifecycle layer only. Each system keeps its own look:
// it registers a WATCHER renderer for its kind and opens a session from the
// operator's real prompt.
//
//   Operator (inside the system's real prompt):
//     const m = MirrorPrompt.open("teleporter.confirm", payload, { onAnswer });
//     m.patch({ picked: "yes" });   // highlight moved
//     m.close(result);              // answered / dismissed
//
//   Watchers (once, at load):
//     MirrorPrompt.register("teleporter.confirm", {
//       show(ctx) { ...draw read-only...; return { patch(state), close(result) }; }
//     });
//     ctx = { sessionId, payload, state, operatorUserId, operatorName,
//             canOverride, answer(value) }
//
// GM override: a GM watcher may call ctx.answer(value). It is delivered to the
// operator's `onAnswer(value, fromUserId)`, which should finish its own prompt
// with that value — so the action still runs exactly once, on the operator.
// Non-GM answers are dropped on the operator side.
//
// Late joiners / reloads: on ready a client asks (SYNC_REQ) and every operator
// re-sends its open sessions to it. A watcher prompt is torn down when its
// operator disconnects, or on scene teardown for scene-scoped sessions.
//
// Socket never echoes to the sender, so the operator never draws a watcher.
// ============================================================================
(() => {
  const CHANNEL = "module.fabula-ultima-companion";
  const TAG     = "[Shared][MirrorPrompt]";
  const T = Object.freeze({
    OPEN:     "fu.mirror.open",
    PATCH:    "fu.mirror.patch",
    CLOSE:    "fu.mirror.close",
    ANSWER:   "fu.mirror.answer",
    SYNC_REQ: "fu.mirror.syncReq",
  });

  globalThis.FUCompanion     = globalThis.FUCompanion || {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};

  const _renderers = new Map(); // kind → { show(ctx) }
  const _own       = new Map(); // sessionId → { kind, payload, state, sceneId, onAnswer }
  const _watching  = new Map(); // sessionId → { kind, operatorUserId, sceneId, handle }

  function emit(msg) {
    try { game.socket?.emit?.(CHANNEL, { ...msg, fromUserId: game.user?.id ?? null }); }
    catch (err) { console.warn(TAG, "emit failed", err); }
  }

  // The name watchers read: the operator's character if linked, else the user.
  function displayName(userId) {
    const u = game.users?.get(userId);
    return u?.character?.name || u?.name || "Someone";
  }

  function register(kind, renderer) {
    if (!kind || typeof renderer?.show !== "function") return;
    _renderers.set(kind, renderer);
  }

  function open(kind, payload = {}, { sceneId = canvas?.scene?.id ?? null, onAnswer = null } = {}) {
    const sessionId = foundry.utils.randomID();
    _own.set(sessionId, { kind, payload, state: {}, sceneId, onAnswer });
    emit({ type: T.OPEN, sessionId, kind, payload, state: {}, sceneId, operatorUserId: game.user?.id ?? null });
    return {
      sessionId,
      patch(state = {}) {
        const s = _own.get(sessionId);
        if (!s) return;
        s.state = { ...s.state, ...state };
        emit({ type: T.PATCH, sessionId, state });
      },
      close(result = null) {
        if (!_own.delete(sessionId)) return;
        emit({ type: T.CLOSE, sessionId, result });
      },
    };
  }

  // ── Watcher side ──────────────────────────────────────────────────────────
  function _closeWatcher(sessionId, result = null) {
    const w = _watching.get(sessionId);
    if (!w) return;
    _watching.delete(sessionId);
    try { w.handle?.close?.(result); } catch (err) { console.warn(TAG, "watcher close failed", err); }
  }

  function _onOpen(msg) {
    const { sessionId, kind, operatorUserId } = msg;
    if (!sessionId || operatorUserId === game.user?.id || _watching.has(sessionId)) return;
    if (msg.sceneId && canvas?.scene?.id && msg.sceneId !== canvas.scene.id) return;
    const renderer = _renderers.get(kind);
    if (!renderer) return;
    const ctx = {
      sessionId,
      payload: msg.payload ?? {},
      state: msg.state ?? {},
      operatorUserId,
      operatorName: displayName(operatorUserId),
      canOverride: !!game.user?.isGM,
      answer: (value) => {
        if (!game.user?.isGM) return;
        emit({ type: T.ANSWER, sessionId, value, to: operatorUserId });
      },
    };
    let handle = null;
    try { handle = renderer.show(ctx); }
    catch (err) { console.warn(TAG, `watcher render failed (${kind})`, err); }
    if (handle) _watching.set(sessionId, { kind, operatorUserId, sceneId: msg.sceneId ?? null, handle });
  }

  function _onAnswer(msg) {
    if (msg.to !== game.user?.id) return;
    const s = _own.get(msg.sessionId);
    if (!s?.onAnswer) return;
    if (!game.users?.get(msg.fromUserId)?.isGM) return;
    try { s.onAnswer(msg.value, msg.fromUserId); }
    catch (err) { console.warn(TAG, "onAnswer failed", err); }
  }

  function _onSyncReq(msg) {
    if (!msg.fromUserId || msg.fromUserId === game.user?.id) return;
    for (const [sessionId, s] of _own) {
      emit({ type: T.OPEN, sessionId, kind: s.kind, payload: s.payload, state: s.state,
             sceneId: s.sceneId, operatorUserId: game.user?.id ?? null, to: msg.fromUserId });
    }
  }

  Hooks.once("ready", () => {
    game.socket?.on?.(CHANNEL, (msg) => {
      if (!msg?.type?.startsWith?.("fu.mirror.")) return;
      if (msg.to && msg.to !== game.user?.id) return;
      switch (msg.type) {
        case T.OPEN:     _onOpen(msg); break;
        case T.PATCH: {
          const w = _watching.get(msg.sessionId);
          try { w?.handle?.patch?.(msg.state ?? {}); } catch (err) { console.warn(TAG, "watcher patch failed", err); }
          break;
        }
        case T.CLOSE:    _closeWatcher(msg.sessionId, msg.result ?? null); break;
        case T.ANSWER:   _onAnswer(msg); break;
        case T.SYNC_REQ: _onSyncReq(msg); break;
      }
    });
    emit({ type: T.SYNC_REQ });
  });

  // Operator left: nobody will ever close their prompts.
  Hooks.on("userConnected", (user, connected) => {
    if (connected) return;
    for (const [sessionId, w] of [..._watching]) if (w.operatorUserId === user.id) _closeWatcher(sessionId);
  });

  Hooks.on("canvasTearDown", () => {
    for (const [sessionId, w] of [..._watching]) if (w.sceneId) _closeWatcher(sessionId);
  });

  globalThis.FUCompanion.api.MirrorPrompt = { register, open, displayName, TYPES: T };

  console.debug(TAG, "Helper loaded.");
})();
