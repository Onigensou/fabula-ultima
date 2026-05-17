/**
 * [ONI] Reaction System — Awaitable Window API (Foundry VTT v12)
 * ---------------------------------------------------------------------------
 * Phase R, Slice 1.5: Per-reactor sub-windows + multi-client sync.
 *
 * The reaction state model is **per reactor**, not per action card. Multiple
 * eligible reactors to the same action each get their own independent
 * sub-window — their own 5-second timer, their own button, their own picker
 * lifecycle, their own resolve. One reactor's pick / pass does NOT close
 * the others' sub-windows.
 *
 * Layering:
 *
 *   • Emit (caller side):
 *       `await FUCompanion.api.reactionSystem.openWindow(payload, opts)`
 *       Returns when EVERY sub-window spawned by this emit has closed.
 *       Result is an aggregate: `{ outcome, subResults: [{...}, ...] }`.
 *
 *   • Sub-window (per-reactor side):
 *       subKey = `${bucket}::${actionCardId ?? "noCard"}::${reactorTokenId}`
 *       Owns: timer (5s default), tick stream, picker lifecycle, rollback
 *       footprint registry. Shared across multiple emits within the same
 *       bucket + card for the same reactor — so a creature listening to
 *       both `creature_performs_action` and `creature_is_targeted` shows
 *       ONE button with one timer.
 *
 * Authority and multi-client:
 *
 *   • The GM is authoritative for sub-window state (timer, rollback log).
 *   • Sub-window lifecycle events are *bridged* across clients via the
 *     module socket so each client sees the same picture:
 *       – GM → all: `OniReactionSubTick`, `OniReactionSubClose`
 *       – player → GM: `OniReactionSubPickerOpened`,
 *                      `OniReactionSubPickerClosed`,
 *                      `OniReactionSubPickerPicked`
 *
 *   • Non-GM clients running `openWindow` don't pause locally (no
 *     authority); player-initiated cards still go fire-and-forget. Adding
 *     player-side cycle pause is a follow-up — would require a request /
 *     ack handshake with GM so the player's macro can await.
 *
 * Lifecycle hooks (local — bridged across clients via the socket layer):
 *
 *   oni:reactionWindow:reactorsFound { emitId, bucket, actionCardId,
 *                                     reactorTokenIds }
 *     Fired by the manager once per emit, after the passive split. Empty
 *     reactorTokenIds means no manual reactions matched.
 *
 *   oni:reactionWindow:tick { subKey, secondsLeft, msLeft, paused?,
 *                            closed? }
 *     Streamed every second by the substrate; consumed by buttonUI to
 *     render the countdown badge.
 *
 *   oni:reactionWindow:pickerOpened { subKey }
 *     Fired by buttonUI on click. Substrate pauses that sub-window's timer.
 *
 *   oni:reactionWindow:pickerClosed { subKey, picked }
 *     Fired by chooseSkill on dialog close / abort. picked=false → pass.
 *
 *   oni:reactionWindow:pickerPicked { subKey, item }
 *     Fired by chooseSkill after a successful pick. Sub resolves chose.
 *
 *   oni:reactionWindow:effectFired { subKey, footprint }
 *     Fired by effect handlers for rollback bookkeeping.
 *
 * Public API on `globalThis.FUCompanion.api.reactionSystem`:
 *
 *   openWindow(payload, { timeoutMs?, reason? }) → Promise<AggregateResult>
 *   closeWindowsForActionCard(actionCardId, reason)
 *   closeWindowsForToken(tokenId, reason)
 *   closeAll(reason)
 *   listPendingWindows()
 *   _internals.{ buildSubKey, computeBucket, recordFootprint }
 *
 * ---------------------------------------------------------------------------
 */

(() => {
  const TAG = "[ReactionWindow]";
  const MODULE_ID = "fabula-ultima-companion";
  const SOCKET_CHANNEL = `module.${MODULE_ID}`;

  if (globalThis.FUCompanion?.api?.reactionSystem?.__installed) {
    console.debug(`${TAG} Already installed.`);
    return;
  }

  const root = (globalThis.FUCompanion = globalThis.FUCompanion ?? {});
  root.api = root.api ?? {};

  const log  = (...a) => console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  /** subKey → SubWindow record (GM-side authoritative state). */
  const _subWindows = new Map();

  /**
   * actionCardId → number of in-flight openWindow calls that have not
   * yet resolved their Promise.all of sub-windows. When this hits zero
   * the card is "settled" — we broadcast `cardSettled` and (on GM)
   * clear the `reactionsPending` message flag so reaction-cardLock.js
   * re-enables the card buttons.
   */
  const _cardPending = new Map();

  /** Lifecycle-trigger buckets — these don't get actionCardId in the key. */
  const LIFECYCLE_BUCKETS = new Set([
    "conflict_start", "round_start", "round_end", "turn_start", "turn_end"
  ]);

  // ---------------------------------------------------------------------------
  // Per-card pending tracker — drives the action-card UI lock
  // ---------------------------------------------------------------------------

  /**
   * actionCardId → setTimeout handle for a pending settle. Debounce
   * coalesces a fast 0→1→0 oscillation (e.g. 5 sequential no-reactor
   * emits within the same sync chain) so cardSettled only fires after
   * the counter has been zero for SETTLE_DEBOUNCE_MS.
   */
  const _settleTimers = new Map();
  const SETTLE_DEBOUNCE_MS = 60;

  function incrementCardPending(actionCardId) {
    if (!actionCardId) return;
    const cur = _cardPending.get(actionCardId) ?? 0;
    _cardPending.set(actionCardId, cur + 1);
    // Counter is non-zero — cancel any pending settle.
    if (_settleTimers.has(actionCardId)) {
      clearTimeout(_settleTimers.get(actionCardId));
      _settleTimers.delete(actionCardId);
    }
  }

  function decrementCardPending(actionCardId) {
    if (!actionCardId) return;
    const cur = _cardPending.get(actionCardId) ?? 0;
    if (cur <= 1) {
      _cardPending.delete(actionCardId);
      scheduleCardSettled(actionCardId);
    } else {
      _cardPending.set(actionCardId, cur - 1);
    }
  }

  function scheduleCardSettled(actionCardId) {
    if (!actionCardId) return;
    if (_settleTimers.has(actionCardId)) {
      clearTimeout(_settleTimers.get(actionCardId));
    }
    const tid = setTimeout(() => {
      _settleTimers.delete(actionCardId);
      // Re-check: a new openWindow may have incremented the counter
      // during the debounce window.
      const cur = _cardPending.get(actionCardId) ?? 0;
      if (cur > 0) return;
      onCardSettled(actionCardId);
    }, SETTLE_DEBOUNCE_MS);
    _settleTimers.set(actionCardId, tid);
  }

  function onCardSettled(actionCardId) {
    if (!actionCardId) return;
    try { Hooks.callAll("oni:reactionWindow:cardSettled", { actionCardId }); }
    catch (_) {}

    if (game.user?.isGM) {
      if (game.socket) {
        try {
          game.socket.emit(SOCKET_CHANNEL, {
            type: "OniReactionCardSettled",
            payload: { actionCardId }
          });
        } catch (_) {}
      }
      // GM is authoritative for chat flags — clear the lock now so
      // every client's updateChatMessage handler re-enables buttons.
      clearReactionsPendingFlag(actionCardId).catch((e) =>
        warn("clearReactionsPendingFlag threw", { actionCardId, error: String(e?.message ?? e) })
      );
    }
  }

  async function clearReactionsPendingFlag(actionCardId) {
    if (!actionCardId) return;
    const msg = findMessageForActionCard(actionCardId);
    if (!msg) {
      warn("clearReactionsPendingFlag: message not found.", { actionCardId });
      return;
    }
    const flag = msg.getFlag?.(MODULE_ID, "actionCard");
    if (!flag?.reactionsPending) return; // already clear
    try {
      await msg.update({
        [`flags.${MODULE_ID}.actionCard.reactionsPending`]: false
      });
      log("Cleared reactionsPending flag.", { actionCardId, messageId: msg.id });
    } catch (e) {
      warn("clearReactionsPendingFlag update failed", {
        actionCardId, messageId: msg.id, error: String(e?.message ?? e)
      });
    }
  }

  function findMessageForActionCard(actionCardId) {
    if (!actionCardId) return null;
    const messages = game.messages?.contents ?? [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      const flag = m?.flags?.[MODULE_ID]?.actionCard;
      if (flag?.actionCardId === actionCardId) return m;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Key derivation
  // ---------------------------------------------------------------------------

  function getRegistry() {
    return window["oni.ReactionTriggers"] ?? null;
  }

  function computeBucket(payload) {
    const reg = getRegistry();
    const raw = payload?.trigger ?? null;
    const triggerKey = reg?.resolveKey?.(raw) ?? raw ?? "(unknown)";
    return reg?.bucketFor?.(triggerKey) ?? triggerKey;
  }

  /**
   * sub-key: `${bucket}::${actionCardId ?? "noCard"}::${reactorTokenId}`.
   * Caller must supply the reactor token id (no fallback) — there is no
   * meaningful "global" sub-window.
   */
  function buildSubKey({ bucket, actionCardId, reactorTokenId }) {
    if (!reactorTokenId) return null;
    const card = (LIFECYCLE_BUCKETS.has(bucket) || !actionCardId)
      ? "noCard"
      : actionCardId;
    return `${bucket}::${card}::${reactorTokenId}`;
  }

  // ---------------------------------------------------------------------------
  // Sub-window lifecycle
  // ---------------------------------------------------------------------------

  function createSubWindow({ subKey, bucket, actionCardId, reactorTokenId, timeoutMs }) {
    let resolveFn;
    const promise = new Promise((r) => { resolveFn = r; });
    const sub = {
      subKey,
      bucket,
      actionCardId: actionCardId ?? null,
      reactorTokenId,
      resolve: resolveFn,
      promise,
      timeoutHandle: null,
      tickHandle: null,
      timeoutDeadline: null,
      timeoutMs,
      fired: []
    };
    _subWindows.set(subKey, sub);
    if (game.user?.isGM) startSubTimeout(subKey, timeoutMs);
    return sub;
  }

  function clearSubTimers(sub) {
    if (!sub) return;
    if (sub.timeoutHandle != null) {
      try { clearTimeout(sub.timeoutHandle); } catch (_) {}
      sub.timeoutHandle = null;
    }
    if (sub.tickHandle != null) {
      try { clearInterval(sub.tickHandle); } catch (_) {}
      sub.tickHandle = null;
    }
  }

  /**
   * Authoritative on GM only: start (or restart) the offer-button timeout
   * and stream tick events. Each tick is fired LOCALLY (Hooks.callAll)
   * AND broadcast via socket so all clients see the same countdown on
   * the relevant button.
   */
  function startSubTimeout(subKey, timeoutMs) {
    const sub = _subWindows.get(subKey);
    if (!sub) return;
    clearSubTimers(sub);

    sub.timeoutDeadline = Date.now() + timeoutMs;

    const emitTick = () => {
      const s = _subWindows.get(subKey);
      if (!s || s.timeoutDeadline == null) return;
      const msLeft = Math.max(0, s.timeoutDeadline - Date.now());
      const secondsLeft = Math.max(0, Math.ceil(msLeft / 1000));
      broadcastTick({ subKey, secondsLeft, msLeft, totalMs: timeoutMs });
    };

    emitTick();
    sub.tickHandle = setInterval(emitTick, 1000);

    sub.timeoutHandle = setTimeout(() => {
      resolveSub(subKey, { outcome: "pass", reason: "timeout" });
    }, timeoutMs);
  }

  function pauseSubTimer(subKey) {
    const sub = _subWindows.get(subKey);
    if (!sub) return;
    clearSubTimers(sub);
    sub.timeoutDeadline = null;
    broadcastTick({ subKey, secondsLeft: null, msLeft: null, paused: true });
  }

  function broadcastTick(data) {
    try { Hooks.callAll("oni:reactionWindow:tick", data); } catch (_) {}
    if (game.user?.isGM && game.socket) {
      try {
        game.socket.emit(SOCKET_CHANNEL, { type: "OniReactionSubTick", payload: data });
      } catch (_) {}
    }
  }

  /**
   * Resolve a sub-window. GM-authoritative; broadcasts the close so non-GM
   * clients can clear their buttons. Runs rollback footprints if requested.
   */
  async function resolveSub(subKey, result) {
    const sub = _subWindows.get(subKey);
    if (!sub) return false;

    _subWindows.delete(subKey);
    clearSubTimers(sub);

    if (result?.reason === "card_cancelled" || result?.reason === "forced_rollback") {
      await runRollback(sub, result.reason);
    }

    // Final tick so the UI clears the badge.
    broadcastTick({ subKey, secondsLeft: null, msLeft: null, closed: true });

    // Broadcast close so non-GM clients drop their floating button.
    if (game.user?.isGM && game.socket) {
      try {
        game.socket.emit(SOCKET_CHANNEL, {
          type: "OniReactionSubClose",
          payload: { subKey, reason: result?.reason ?? null }
        });
      } catch (_) {}
    }

    const subResult = {
      subKey,
      reactorTokenId: sub.reactorTokenId,
      outcome: result?.outcome ?? "pass",
      reason: result?.reason ?? null,
      pickedItem: result?.pickedItem ?? null,
      effectResult: result?.effectResult ?? null
    };

    try { sub.resolve(subResult); }
    catch (e) { warn("sub resolve threw", { subKey, error: String(e?.message ?? e) }); }

    log("Sub-window resolved.", { subKey, outcome: subResult.outcome, reason: subResult.reason });
    return true;
  }

  // ---------------------------------------------------------------------------
  // Rollback (footprints recorded by effect handlers)
  // ---------------------------------------------------------------------------

  function recordFootprint(subKey, footprint) {
    const sub = _subWindows.get(subKey);
    if (!sub) return false;
    if (!Array.isArray(sub.fired)) sub.fired = [];
    sub.fired.push(footprint);
    return true;
  }

  async function runRollback(sub, reason) {
    if (!sub || !Array.isArray(sub.fired) || !sub.fired.length) return [];
    const out = [];
    for (let i = sub.fired.length - 1; i >= 0; i--) {
      const f = sub.fired[i];
      if (typeof f?.undo !== "function") continue;
      try {
        await f.undo({ reason });
        out.push({ ok: true, kind: f.kind, label: f.label });
      } catch (e) {
        warn("Rollback step threw", { kind: f.kind, label: f.label, error: String(e?.message ?? e) });
        out.push({ ok: false, kind: f.kind, label: f.label, error: String(e?.message ?? e) });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Open an awaitable reaction window for `payload`. GM-only authoritative;
   * non-GM clients return a passthrough result and don't pause.
   *
   * Result on GM: { outcome: "complete" | "no_match",
   *                 subResults: [{ subKey, reactorTokenId, outcome, reason,
   *                                pickedItem?, effectResult? }, ...] }
   */
  async function openWindow(payload, opts = {}) {
    const { timeoutMs = 5000, reason: tag = "action" } = opts;

    if (!game.user?.isGM) {
      // Non-GM: still emit so the GM (running this client's payload) sees
      // the trigger. CreateActionCard's player path already does the
      // socket forward, so we don't double-emit there.
      try { globalThis.ONI?.emit?.("oni:reactionPhase", payload, { local: true, world: false }); } catch (_) {}
      return { outcome: "pass", reason: "non_gm_no_await", subResults: [] };
    }

    const emitId = foundry?.utils?.randomID?.() ?? String(Date.now()) + "-" + Math.random().toString(36).slice(2, 7);
    const stamped = { ...payload, __emitId: emitId };

    // Per-card pending tracker: increment on every openWindow that
    // carries an actionCardId; decrement when this call's
    // Promise.all settles (or fails early). When it hits zero the
    // card UI lock clears.
    const ownerActionCardId = payload?.actionCardId ?? payload?.meta?.actionCardId ?? null;
    if (ownerActionCardId) incrementCardPending(ownerActionCardId);

    log("openWindow start", { emitId, trigger: payload?.trigger, tag, ownerActionCardId });

    return new Promise((resolveOuter) => {
      let received = false;
      let safetyTimer = null;
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (ownerActionCardId) decrementCardPending(ownerActionCardId);
        resolveOuter(result);
      };

      const onReactorsFound = (data) => {
        if (data?.emitId !== emitId) return;
        Hooks.off("oni:reactionWindow:reactorsFound", onReactorsFound);
        if (safetyTimer != null) { try { clearTimeout(safetyTimer); } catch (_) {} }
        received = true;

        const reactors = Array.isArray(data.reactorTokenIds) ? data.reactorTokenIds : [];
        if (!reactors.length) {
          log("openWindow resolved: no reactors.", { emitId });
          finish({ outcome: "no_match", reason: "no_matches", subResults: [] });
          return;
        }

        const bucket = data.bucket;
        const actionCardId = data.actionCardId ?? null;

        const subPromises = reactors.map((reactorTokenId) => {
          const subKey = buildSubKey({ bucket, actionCardId, reactorTokenId });
          if (!subKey) return Promise.resolve({ subKey: null, outcome: "pass", reason: "bad_sub_key" });
          const existing = _subWindows.get(subKey);
          if (existing) return existing.promise;
          const sub = createSubWindow({ subKey, bucket, actionCardId, reactorTokenId, timeoutMs });
          return sub.promise;
        });

        Promise.all(subPromises).then((subResults) => {
          log("openWindow resolved: all subs closed.", { emitId, count: subResults.length });
          finish({ outcome: "complete", reason: "subs_closed", subResults });
        });
      };

      Hooks.on("oni:reactionWindow:reactorsFound", onReactorsFound);

      // Safety net: manager never fires reactorsFound (loaded out of order,
      // etc.) — resolve as no_match after 500ms.
      safetyTimer = setTimeout(() => {
        if (received) return;
        Hooks.off("oni:reactionWindow:reactorsFound", onReactorsFound);
        warn("openWindow safety timeout — no reactorsFound received.", { emitId });
        finish({ outcome: "no_match", reason: "manager_timeout", subResults: [] });
      }, 500);

      try { globalThis.ONI?.emit?.("oni:reactionPhase", stamped, { local: true, world: false }); } catch (_) {}
    });
  }

  async function closeWindowsForActionCard(actionCardId, reason = "forced") {
    if (!actionCardId) return [];
    const closed = [];
    for (const [key, sub] of Array.from(_subWindows.entries())) {
      if (sub.actionCardId !== actionCardId) continue;
      await resolveSub(key, { outcome: "forced", reason });
      closed.push(key);
    }
    if (closed.length) log("Closed subs for action card.", { actionCardId, reason, closed });
    return closed;
  }

  async function closeWindowsForToken(tokenId, reason = "forced") {
    if (!tokenId) return [];
    const closed = [];
    for (const [key, sub] of Array.from(_subWindows.entries())) {
      if (sub.reactorTokenId !== tokenId) continue;
      await resolveSub(key, { outcome: "forced", reason });
      closed.push(key);
    }
    if (closed.length) log("Closed subs for token.", { tokenId, reason, closed });
    return closed;
  }

  async function closeAll(reason = "forced") {
    const closed = [];
    for (const [key, sub] of Array.from(_subWindows.entries())) {
      await resolveSub(key, { outcome: "forced", reason });
      closed.push(key);
    }
    if (closed.length) log("Closed all subs.", { reason, closed });
    return closed;
  }

  function listPendingWindows() {
    return Array.from(_subWindows.entries()).map(([key, sub]) => ({
      subKey: key,
      bucket: sub.bucket,
      actionCardId: sub.actionCardId,
      reactorTokenId: sub.reactorTokenId,
      ageMs: sub.timeoutDeadline != null ? (sub.timeoutMs - Math.max(0, sub.timeoutDeadline - Date.now())) : null,
      msLeft: sub.timeoutDeadline != null ? Math.max(0, sub.timeoutDeadline - Date.now()) : null,
      footprintCount: sub.fired.length
    }));
  }

  /**
   * Return the live seconds-left for a sub-window's countdown, or null
   * if the sub doesn't exist / has no active timer (e.g. picker is
   * paused). Used by reaction-buttonUI's spawnButton to paint the
   * initial countdown badge — without this, the first tick (5) fires
   * BEFORE the button DOM exists and the badge starts at 4.
   */
  function getSecondsLeftFor(subKey) {
    const sub = _subWindows.get(subKey);
    if (!sub || sub.timeoutDeadline == null) return null;
    const msLeft = Math.max(0, sub.timeoutDeadline - Date.now());
    return Math.max(0, Math.ceil(msLeft / 1000));
  }

  // ---------------------------------------------------------------------------
  // Picker lifecycle hooks (LOCAL listeners)
  //
  // These fire on EVERY client (GM or player) when buttonUI / chooseSkill
  // do their work. On GM, they directly mutate the authoritative sub-window
  // state. On a player client, the socket forward layer (below) re-fires
  // them on GM so the authoritative timer pauses / resolves correctly.
  // ---------------------------------------------------------------------------

  Hooks.on("oni:reactionWindow:pickerOpened", ({ subKey } = {}) => {
    if (!subKey) return;
    if (game.user?.isGM) {
      pauseSubTimer(subKey);
      log("Picker opened — timer paused.", { subKey });
    }
  });

  Hooks.on("oni:reactionWindow:pickerClosed", ({ subKey, picked } = {}) => {
    if (!subKey) return;
    if (game.user?.isGM && !picked) {
      resolveSub(subKey, { outcome: "pass", reason: "picker_close" });
    }
  });

  Hooks.on("oni:reactionWindow:pickerPicked", ({ subKey, item, effectResult } = {}) => {
    if (!subKey) return;
    if (game.user?.isGM) {
      resolveSub(subKey, {
        outcome: "chose",
        reason: "picked",
        pickedItem: item ?? null,
        effectResult: effectResult ?? null
      });
    }
  });

  Hooks.on("oni:reactionWindow:effectFired", ({ subKey, footprint } = {}) => {
    if (!subKey || !footprint) return;
    if (game.user?.isGM) recordFootprint(subKey, footprint);
  });

  // ---------------------------------------------------------------------------
  // Socket bridge — multi-client lifecycle sync
  // ---------------------------------------------------------------------------
  //
  // Players forward their picker actions to GM, who owns the authoritative
  // timer. GM broadcasts tick + close events so player clients display
  // consistent state.
  // ---------------------------------------------------------------------------

  function forwardToGM(type, payload) {
    if (game.user?.isGM) return; // GM-side never forwards to self
    if (!game.socket) return;
    try {
      game.socket.emit(SOCKET_CHANNEL, { type, payload });
    } catch (_) {}
  }

  // Player-side: when buttonUI fires pickerOpened locally, forward to GM.
  Hooks.on("oni:reactionWindow:pickerOpened", ({ subKey } = {}) => {
    if (!subKey || game.user?.isGM) return;
    forwardToGM("OniReactionSubPickerOpened", { subKey, fromUserId: game.user?.id ?? null });
  });
  Hooks.on("oni:reactionWindow:pickerClosed", ({ subKey, picked } = {}) => {
    if (!subKey || game.user?.isGM) return;
    forwardToGM("OniReactionSubPickerClosed", { subKey, picked: !!picked, fromUserId: game.user?.id ?? null });
  });
  Hooks.on("oni:reactionWindow:pickerPicked", ({ subKey, item } = {}) => {
    if (!subKey || game.user?.isGM) return;
    forwardToGM("OniReactionSubPickerPicked", {
      subKey,
      itemUuid: item?.uuid ?? null,
      fromUserId: game.user?.id ?? null
    });
  });

  // Receiver — runs on every client. Each handler self-gates by role.
  function handleSocketMessage(data) {
    if (!data || typeof data !== "object") return;
    const { type, payload } = data;
    if (!type || !payload) return;

    switch (type) {
      case "OniReactionSubPickerOpened":
        // Re-fire the local hook on the GM. The GM's listener (above) pauses
        // the authoritative timer.
        if (game.user?.isGM) {
          try { Hooks.callAll("oni:reactionWindow:pickerOpened", { subKey: payload.subKey }); }
          catch (e) { warn("re-fire pickerOpened threw", e); }
        }
        return;

      case "OniReactionSubPickerClosed":
        if (game.user?.isGM) {
          try { Hooks.callAll("oni:reactionWindow:pickerClosed", { subKey: payload.subKey, picked: !!payload.picked }); }
          catch (e) { warn("re-fire pickerClosed threw", e); }
        }
        return;

      case "OniReactionSubPickerPicked":
        if (game.user?.isGM) {
          // Item resolution is best-effort here — the chosen-skill chain
          // already ran on the player's client. We just need to signal
          // "this sub is done, the player picked something."
          let item = null;
          if (payload.itemUuid) {
            try { item = fromUuidSync(payload.itemUuid); } catch (_) {}
          }
          try { Hooks.callAll("oni:reactionWindow:pickerPicked", { subKey: payload.subKey, item }); }
          catch (e) { warn("re-fire pickerPicked threw", e); }
        }
        return;

      case "OniReactionSubTick":
        // Players: re-fire the local hook so buttonUI's tick listener
        // updates the countdown badge.
        if (!game.user?.isGM) {
          try { Hooks.callAll("oni:reactionWindow:tick", payload); }
          catch (e) { warn("re-fire tick threw", e); }
        }
        return;

      case "OniReactionSubClose":
        // Players: re-fire as a "closed" tick so buttonUI's badge clears.
        // Floating button removal is handled by the existing manager
        // bucket-clear path; this just signals the badge.
        if (!game.user?.isGM) {
          try {
            Hooks.callAll("oni:reactionWindow:tick", {
              subKey: payload.subKey,
              secondsLeft: null,
              msLeft: null,
              closed: true
            });
          } catch (e) { warn("re-fire close-tick threw", e); }
        }
        return;
    }
  }

  Hooks.once("ready", () => {
    if (!game.socket) {
      warn("game.socket unavailable — multi-client sync disabled.");
      return;
    }
    game.socket.on(SOCKET_CHANNEL, handleSocketMessage);
  });

  // ---------------------------------------------------------------------------
  // Cancel-on-card-delete (chat message deletion = card cancelled)
  // ---------------------------------------------------------------------------

  const ACTION_CARD_FLAG_NS = "fabula-ultima-companion";
  Hooks.on("preDeleteChatMessage", (message) => {
    try {
      const flag = message?.getFlag?.(ACTION_CARD_FLAG_NS, "actionCard");
      const cardId = flag?.actionCardId ?? flag?.payload?.meta?.actionCardId ?? null;
      const state = flag?.actionCardState ?? null;
      if (!cardId) return;
      if (state === "resolved") return; // resolved cards don't roll back
      closeWindowsForActionCard(cardId, "card_cancelled").catch((e) => {
        warn("Cancel-rollback failed", { error: String(e?.message ?? e) });
      });
    } catch (e) {
      warn("preDeleteChatMessage handler threw", { error: String(e?.message ?? e) });
    }
  });

  /**
   * Card-emit guard: increment the per-card pending counter so a batch
   * of openWindow calls can be made without the FIRST no-reactor
   * resolution ping-ponging the counter to zero and prematurely
   * firing `cardSettled`. The caller MUST eventually call
   * `endCardEmit(actionCardId)` (in a finally) to release the guard.
   */
  function beginCardEmit(actionCardId) {
    if (!actionCardId) return;
    incrementCardPending(actionCardId);
    log("beginCardEmit", { actionCardId, pending: _cardPending.get(actionCardId) ?? 0 });
  }

  function endCardEmit(actionCardId) {
    if (!actionCardId) return;
    log("endCardEmit", { actionCardId, pending: _cardPending.get(actionCardId) ?? 0 });
    decrementCardPending(actionCardId);
  }

  // ---------------------------------------------------------------------------
  // Expose
  // ---------------------------------------------------------------------------
  root.api.reactionSystem = {
    __installed: true,
    openWindow,
    closeWindowsForActionCard,
    closeWindowsForToken,
    closeAll,
    listPendingWindows,
    getSecondsLeftFor,
    beginCardEmit,
    endCardEmit,
    _internals: {
      buildSubKey,
      computeBucket,
      recordFootprint,
      incrementCardPending,
      decrementCardPending
    }
  };

  log("Installed (v1.5 — per-reactor sub-windows + socket sync).");
})();
