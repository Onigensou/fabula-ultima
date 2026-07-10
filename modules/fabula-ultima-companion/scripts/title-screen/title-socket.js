// ============================================================================
// Title Screen — Socket Handler
//
// All title messages share the module socket channel and are identified by a
// TITLE_ prefix so they don't collide with other system messages.
//
// Architecture:
//   All users (players + GM) vote. Votes are aggregated on exactly ONE client —
//   the PRIMARY GM (game.users.activeGM). Gating on `isGM` is not enough: this
//   game runs two GM clients, raw socket messages reach both, and each would
//   keep its own vote table, reach quorum independently, and run a second
//   concurrent SaveSystem.Core.load(). Two overlapping loads interleave the
//   delete-all/recreate-all in applyActorEmbeds and corrupt the first party
//   member's embedded items. See FUCompanion.isPrimaryGM().
//
//   The primary GM's own vote is applied locally because Foundry does not echo
//   socket emits back to the sender. Every other client — players AND the
//   co-GM — emits over the socket.
//
//   Once _requiredVoters() unique votes are collected:
//     - All same slot → primary GM broadcasts LOAD_LOADING, executes load, then PROCEED.
//     - Disagreement  → primary GM resets, broadcasts LOAD_CONFLICT.
//   The primary GM broadcasts LOAD_VOTES_UPDATE after every change for the live counter.
// ============================================================================
(() => {
  const TS    = globalThis.TitleScreen ??= {};
  const TAG   = "[TitleScreen][Socket]";
  const GUARD = "__ONI_TITLE_SOCKET__";

  const isPrimaryGM = () => globalThis.FUCompanion?.isPrimaryGM?.() ?? false;

  // In-memory vote table  { [userId]: slotId }  — ephemeral, resets on proceed/conflict.
  // Only ever populated on the primary GM.
  let _votes = {};

  // Re-entrancy guard: two votes landing in the same tick must not both enter
  // _evaluate() and both reach quorum.
  let _evaluating = false;

  // ── Helpers ──────────────────────────────────────────────────────────────────

  // Total votes needed before the ready-check evaluates.
  function _requiredVoters() {
    return TS.REQUIRED_PLAYERS;
  }

  function _broadcast(type, payload = {}) {
    game.socket.emit(TS.SOCKET_CH, { type, payload });
  }

  function _voteState() {
    return {
      votes:    { ..._votes },
      count:    Object.keys(_votes).length,
      required: _requiredVoters(),
    };
  }

  // Push the vote table to every client, then to our own UI — the socket does
  // not echo back to the sender, so the primary GM must update itself directly.
  function _publishVotes() {
    const state = _voteState();
    _broadcast(TS.MSG.LOAD_VOTES_UPDATE, state);
    TS.LoadUI?.onVotesUpdate?.(state);
  }

  // ── Vote aggregator — PRIMARY GM ONLY ────────────────────────────────────────
  // Callers are already gated, but these re-check: _onVote is also reachable
  // from emitVote() on this client, and a GM demotion or activeGM handover can
  // land between the two.

  async function _onVote({ userId, slotId } = {}) {
    if (!isPrimaryGM() || !userId || !slotId) return;
    _votes[userId] = slotId;
    _publishVotes();
    await _evaluate();
  }

  function _onCancel({ userId } = {}) {
    if (!isPrimaryGM() || !userId) return;
    delete _votes[userId];
    _publishVotes();
  }

  async function _evaluate() {
    if (_evaluating) return;

    const required = _requiredVoters();
    if (Object.keys(_votes).length < required) return; // still waiting

    const values  = Object.values(_votes);
    const allSame = values.every(v => v === values[0]);

    if (!allSame) {
      const snapshot = { ..._votes };
      _votes = {};
      console.log(TAG, "Vote conflict detected. Resetting.", snapshot);
      _broadcast(TS.MSG.LOAD_CONFLICT, { votes: snapshot });
      TS.LoadUI?.onConflict?.({ votes: snapshot });
      return;
    }

    const slotId = values[0];
    _votes = {};
    _evaluating = true;
    try {
      console.log(TAG, `All ${required} users agreed on slot ${slotId}. Loading…`);

      // Tell everyone (and our own UI) to show the loading bar
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
    } finally {
      _evaluating = false;
    }
  }

  // ── Public emit helpers (called by client-side UI) ───────────────────────────

  TS.Socket = {
    // Foundry does not echo socket emits to the sender, so the PRIMARY GM's own
    // vote is applied locally. Everyone else — players and the co-GM alike —
    // goes over the socket so the single aggregator sees every vote.
    emitVote(slotId) {
      if (isPrimaryGM()) {
        _onVote({ userId: game.user.id, slotId });
      } else {
        game.socket.emit(TS.SOCKET_CH, {
          type:    TS.MSG.LOAD_VOTE,
          payload: { userId: game.user.id, slotId },
        });
      }
    },

    emitCancel() {
      if (isPrimaryGM()) {
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

        // ── Primary GM only: vote aggregation (everyone else's votes land here).
        // A second GM client receives these too; it must NOT aggregate or load.
        if (isPrimaryGM()) {
          if (type === TS.MSG.LOAD_VOTE)   { await _onVote(payload); return; }
          if (type === TS.MSG.LOAD_CANCEL) { _onCancel(payload);     return; }
        }

        // ── All clients (incl. the co-GM): react to the primary GM's broadcasts.
        if (type === TS.MSG.LOAD_VOTES_UPDATE) { TS.LoadUI?.onVotesUpdate?.(payload); return; }
        if (type === TS.MSG.LOAD_LOADING)      { TS.LoadUI?.onLoading?.(payload);     return; }
        if (type === TS.MSG.LOAD_PROCEED)      { TS.LoadUI?.onProceed?.(payload);     return; }
        if (type === TS.MSG.LOAD_CONFLICT)     { TS.LoadUI?.onConflict?.(payload);    return; }
      });

      console.log(TAG, "Socket listener installed.", isPrimaryGM() ? "(vote aggregator)" : "(client)");
    },

    // Reset vote table — called when title screen is closed mid-vote.
    resetVotes() {
      if (!isPrimaryGM()) return;
      _votes = {};
    },
  };

  console.debug(TAG, "Socket module loaded.");
})();
