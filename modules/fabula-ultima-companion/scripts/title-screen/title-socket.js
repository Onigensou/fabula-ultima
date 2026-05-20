// ============================================================================
// Title Screen — Socket Handler
//
// All title messages share the module socket channel and are identified by a
// TITLE_ prefix so they don't collide with other system messages.
//
// Architecture:
//   All users (players + GM) vote. GM votes are handled locally because
//   Foundry does not echo socket emits back to the sender.
//   Once TS.REQUIRED_PLAYERS unique votes are collected:
//     - All same slot → GM broadcasts LOAD_LOADING, executes load, then PROCEED.
//     - Disagreement  → GM resets, broadcasts LOAD_CONFLICT.
//   GM broadcasts LOAD_VOTES_UPDATE after every change for the live counter.
// ============================================================================
(() => {
  const TS    = globalThis.TitleScreen ??= {};
  const TAG   = "[TitleScreen][Socket]";
  const GUARD = "__ONI_TITLE_SOCKET__";

  // In-memory vote table  { [userId]: slotId }  — ephemeral, resets on proceed/conflict.
  let _votes = {};

  // ── Helpers ──────────────────────────────────────────────────────────────────

  function _broadcast(type, payload = {}) {
    game.socket.emit(TS.SOCKET_CH, { type, payload });
  }

  function _broadcastVotesUpdate() {
    _broadcast(TS.MSG.LOAD_VOTES_UPDATE, {
      votes:    { ..._votes },
      count:    Object.keys(_votes).length,
      required: TS.REQUIRED_PLAYERS,
    });
  }

  // ── GM-side vote aggregator ───────────────────────────────────────────────────

  async function _onVote({ userId, slotId } = {}) {
    if (!userId || !slotId) return;
    _votes[userId] = slotId;
    _broadcastVotesUpdate();
    // Also update the GM's own local UI (broadcast doesn't echo back to sender)
    TS.LoadUI?.onVotesUpdate?.({ votes: { ..._votes }, count: Object.keys(_votes).length, required: TS.REQUIRED_PLAYERS });
    await _evaluate();
  }

  function _onCancel({ userId } = {}) {
    if (!userId) return;
    delete _votes[userId];
    _broadcastVotesUpdate();
    TS.LoadUI?.onVotesUpdate?.({ votes: { ..._votes }, count: Object.keys(_votes).length, required: TS.REQUIRED_PLAYERS });
  }

  async function _evaluate() {
    const count = Object.keys(_votes).length;
    if (count < TS.REQUIRED_PLAYERS) return; // still waiting

    const values  = Object.values(_votes);
    const allSame = values.every(v => v === values[0]);

    if (allSame) {
      const slotId = values[0];
      _votes = {};
      console.log(TAG, `All ${TS.REQUIRED_PLAYERS} users agreed on slot ${slotId}. Loading…`);

      // Tell everyone (and GM's own UI) to show the loading bar
      _broadcast(TS.MSG.LOAD_LOADING, { slotId });
      TS.LoadUI?.onLoading?.({ slotId });

      const result = await (globalThis.SaveSystem?.Core?.load?.(slotId)
        ?? Promise.resolve({ ok: false, error: "SaveSystem unavailable" }));

      if (result.ok) {
        _broadcast(TS.MSG.LOAD_PROCEED, { slotId });
        TS.LoadUI?.onProceed?.({ slotId });
      } else {
        console.error(TAG, "Load failed:", result.error);
        _broadcast(TS.MSG.LOAD_CONFLICT, { votes: {}, error: result.error });
        TS.LoadUI?.onConflict?.({ error: result.error });
      }
    } else {
      const snapshot = { ..._votes };
      _votes = {};
      console.log(TAG, "Vote conflict detected. Resetting.", snapshot);
      _broadcast(TS.MSG.LOAD_CONFLICT, { votes: snapshot });
      TS.LoadUI?.onConflict?.({ votes: snapshot });
    }
  }

  // ── Public emit helpers (called by client-side UI) ───────────────────────────

  TS.Socket = {
    // Foundry does not echo socket emits to the sender, so the GM's vote is
    // handled locally via _onVote() rather than going through the socket.
    emitVote(slotId) {
      if (game.user?.isGM) {
        _onVote({ userId: game.user.id, slotId });
      } else {
        game.socket.emit(TS.SOCKET_CH, {
          type:    TS.MSG.LOAD_VOTE,
          payload: { userId: game.user.id, slotId },
        });
      }
    },

    emitCancel() {
      if (game.user?.isGM) {
        _onCancel({ userId: game.user.id });
      } else {
        game.socket.emit(TS.SOCKET_CH, {
          type:    TS.MSG.LOAD_CANCEL,
          payload: { userId: game.user.id },
        });
      }
    },

    // ── Install listener (called on ready for all clients) ──────────────────
    setup() {
      if (window[GUARD]) return;
      window[GUARD] = true;

      game.socket.on(TS.SOCKET_CH, async (msg) => {
        const { type, payload } = msg ?? {};
        if (!type?.startsWith("TITLE_")) return;

        // ── GM only: vote aggregation (players' votes arrive here) ──────────
        if (game.user?.isGM) {
          if (type === TS.MSG.LOAD_VOTE)   { await _onVote(payload); return; }
          if (type === TS.MSG.LOAD_CANCEL) { _onCancel(payload);     return; }
        }

        // ── All clients: react to GM broadcasts ─────────────────────────────
        if (type === TS.MSG.LOAD_VOTES_UPDATE) { TS.LoadUI?.onVotesUpdate?.(payload); return; }
        if (type === TS.MSG.LOAD_LOADING)      { TS.LoadUI?.onLoading?.(payload);     return; }
        if (type === TS.MSG.LOAD_PROCEED)      { TS.LoadUI?.onProceed?.(payload);     return; }
        if (type === TS.MSG.LOAD_CONFLICT)     { TS.LoadUI?.onConflict?.(payload);    return; }
      });

      console.log(TAG, "Socket listener installed.");
    },

    // Reset vote table — called when title screen is closed mid-vote.
    resetVotes() {
      if (!game.user?.isGM) return;
      _votes = {};
    },
  };

  console.debug(TAG, "Socket module loaded.");
})();
