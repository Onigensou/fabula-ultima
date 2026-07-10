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

  // ── Voter roster ─────────────────────────────────────────────────────────────
  //
  // Who gets a say: the host (primary) GM, plus the ASSIGNED PLAYER of each
  // MAIN-PARTY member actor — counted whether or not they are currently
  // connected. The roster is therefore fixed by party composition (host GM + the
  // 4 party players = 5 in a normal session), not by who happens to be online,
  // so the ready-check waits for the whole party.
  //
  // Detection is by User#character (Foundry's assigned-character link), NOT
  // ownership. Ownership is unreliable here — many player accounts hold OWNER on
  // the party actors (shared/permissive defaults), which counted all ~20 users.
  // `user.character` is the concrete 1:1 link: an actor is the assigned
  // character of exactly one user, so this yields precisely the 4 PC players.
  // Bench characters, spectators, extra player accounts and the co-GM are all
  // excluded — they can watch, but are not required to start.
  //
  // An offline player still counts, so the lobby cannot complete without the
  // full party present — the GM-only "Load Anyway" debug bypass (forceLoad) is
  // the deliberate escape hatch for solo testing.
  //
  // Recomputed on lobby open and on connect/disconnect (see title-bootstrap).
  // Cached as a Set because _voteState()/_evaluate() need it synchronously.

  let _eligible = new Set();

  async function _computeEligible() {
    const ids = new Set();

    const gm = globalThis.FUCompanion?.primaryGM?.();
    if (gm) ids.add(gm.id);

    // Main-party members only (member_id_1..N). buildContext().memberUuids folds
    // in bench characters too, so read the party props directly for members.
    const ctx      = await globalThis.SaveSystem?.Core?.buildContext?.();
    const props    = ctx?.partyActor?.system?.props ?? {};
    const memberIds = new Set();
    for (let i = 1; i <= 10; i++) {
      const raw = props[`member_id_${i}`];
      if (!raw) continue;
      memberIds.add(String(raw).startsWith("Actor.") ? String(raw).slice(6) : String(raw));
    }

    // The player of a member actor = the user whose assigned character IS it.
    for (const user of game.users.contents) {
      if (user.isGM) continue; // GMs are the host seat, never a "player" seat
      const charId = user.character?.id;
      if (charId && memberIds.has(charId)) ids.add(user.id);
    }
    return ids;
  }

  async function _refreshEligible() {
    if (!isPrimaryGM()) return;
    try {
      _eligible = await _computeEligible();
      console.log(TAG, `Eligible voters (${_eligible.size}):`,
        [..._eligible].map(id => game.users.get(id)?.name ?? id).join(", "));
    } catch (e) {
      console.error(TAG, "Failed to compute eligible voters; falling back to REQUIRED_PLAYERS.", e);
      _eligible = new Set();
    }

    // A voter who dropped mid-lobby leaves a ghost vote behind. Drop it, or the
    // count can sit at quorum with nobody there to have cast it.
    for (const userId of Object.keys(_votes)) {
      if (!_mayVote(userId)) delete _votes[userId];
    }
    _publishVotes();

    // Deliberately no _evaluate() here. A disconnect shrinks `required`, and
    // evaluating on that would let someone dropping out fire the load before
    // the remaining table has finished choosing. Quorum is only ever tested in
    // response to an actual vote.
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  // Total votes needed before the ready-check evaluates. Falls back to the
  // hardcoded headcount if the party could not be resolved — a wrong number is
  // recoverable, a lobby that can never reach quorum is not.
  function _requiredVoters() {
    return _eligible.size || TS.REQUIRED_PLAYERS;
  }

  function _broadcast(type, payload = {}) {
    game.socket.emit(TS.SOCKET_CH, { type, payload });
  }

  function _voteState() {
    return {
      votes:    { ..._votes },
      count:    Object.keys(_votes).length,
      required: _requiredVoters(),
      eligible: [..._eligible],   // drives the dot row on every client
    };
  }

  // Ignore votes from users outside the roster. An empty roster means the party
  // could not be resolved; accept everyone rather than deadlock the lobby.
  function _mayVote(userId) {
    return _eligible.size === 0 || _eligible.has(userId);
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
    if (!_mayVote(userId)) {
      console.debug(TAG, `Ignoring vote from non-roster user ${game.users.get(userId)?.name ?? userId}`);
      return;
    }
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
    console.log(TAG, `All ${required} users agreed on slot ${slotId}. Loading…`);
    await _performLoad(slotId);
  }

  // Run the actual load and drive every client's lobby through it. Reached two
  // ways: quorum (_evaluate) and the GM-only debug bypass (forceLoad). The
  // _evaluating flag serializes them so a bypass mid-quorum can't double-load.
  async function _performLoad(slotId) {
    if (_evaluating) return;
    _evaluating = true;
    try {
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

    // DEBUG bypass — skip quorum and load a slot immediately. Primary-GM only,
    // no socket path (a co-GM cannot trigger it). Wired to a GM-only button so
    // the whole party isn't needed for solo testing; there is no real-play case
    // for loading past a failed ready-check.
    forceLoad(slotId) {
      if (!isPrimaryGM()) { console.warn(TAG, "forceLoad ignored: not the primary GM."); return; }
      if (!slotId) return;
      console.warn(TAG, `DEBUG force-load of slot ${slotId} (quorum bypassed).`);
      _votes = {};
      return _performLoad(slotId);
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

    // Recompute the voter roster (primary GM + active party-member owners).
    // Called on lobby open and on connect/disconnect. No-op off the primary GM.
    refreshRoster() {
      return _refreshEligible();
    },

    // Reset vote table — called when title screen is closed mid-vote.
    resetVotes() {
      if (!isPrimaryGM()) return;
      _votes = {};
    },
  };

  console.debug(TAG, "Socket module loaded.");
})();
