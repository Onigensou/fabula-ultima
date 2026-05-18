/**
 * [ONI] Reaction Exchange — State Machine (Foundry VTT v12)
 * ---------------------------------------------------------------------------
 * GM-authoritative, in-memory state for the shared reaction queue that
 * replaces the per-trigger `emitPhaseSequential` chain. Both PC and GM
 * sides queue into a single Exchange per actionCardId / lifecycle trigger.
 *
 * Step 1 scope (this file):
 *   - State container + lifecycle transitions (queueing → resolving → closed)
 *   - Mutation API (open, addEntry, removeEntry, reorderEntry,
 *     setReady, forceResolve, markResolved, close)
 *   - Per-mutation validation (eligibility, ownership, once-per-chain
 *     within-queue, status gate)
 *   - Version stamping + Hooks emission for the sync layer
 *
 * NOT in this file (later steps):
 *   - Eligibility / candidate computation (step 2 / 4): caller supplies
 *     eligibleUserIds at open time. The matcher integration is deferred so
 *     this module stays Foundry-state-free and bridge-testable in isolation.
 *   - Resolution engine, capability check, fizzle logging (step 2)
 *   - UI rendering (step 3)
 *   - Socket sync (sibling file `reaction-exchange-sync.js`)
 *   - AFK timer enforcement (step 6)
 *
 * Exposed on:
 *   - window["oni.ReactionExchange"]
 *   - globalThis.FUCompanion.api.reactionExchange
 *
 * Hooks emitted (all carry the full deep-cloned snapshot for sync):
 *   - "oni:exchange:opened"   { exchangeId, snapshot, mutation: "open" }
 *   - "oni:exchange:mutated"  { exchangeId, snapshot, mutation: <kind> }
 *   - "oni:exchange:resolving"{ exchangeId, snapshot }
 *   - "oni:exchange:closed"   { exchangeId, snapshot, reason }
 *
 * State shape (one entry in the active-exchanges Map):
 *   {
 *     exchangeId:       string             - unique id ("ex-<rand>")
 *     version:          number             - bumps on every mutation
 *     status:           "queueing" | "resolving" | "closed"
 *     kind:             "action_card" | "lifecycle" | "standalone"
 *     boundaryKey:      string             - dedupe key for joining
 *                                            (actionCardId / lifecycleKey)
 *     payload:          object             - initial event payload
 *     firedTriggers:    [{key, payload}]   - immutable record of triggers
 *                                            that fired this Exchange
 *     usedSkillUuids:   string[]           - skills already resolved
 *                                            (populated in step 2)
 *     eligibleUserIds:  string[]           - users who must Ready
 *     queue:            [Entry]            - ordered queue (top = first to fire)
 *     readyUsers:       { [userId]: { readiedAt } }
 *     resolutionLog:    [LogEntry]         - populated in step 2
 *     closeReason:      string|null
 *     openedAt:         number             - epoch ms
 *     closedAt:         number|null
 *   }
 *
 * Entry shape:
 *   {
 *     entryId:           string
 *     userId:            string            - controlling user (GM or player)
 *     reactorTokenId:    string
 *     reactorActorUuid:  string
 *     reactorName:       string            - display label
 *     skillUuid:         string            - item.uuid OR <effectUuid>::synth-reaction
 *     skillName:         string
 *     sourceTriggerKey:  string            - which trigger surfaced this skill
 *     predictedTriggers: [{key, payload}]  - what this entry will emit on fire
 *     targeting:         object            - opaque per-skill data (target uuid, etc.)
 *     addedAt:           number
 *     addedBy:           string            - userId of mutator (may differ
 *                                            from `userId` when GM adds for
 *                                            a player)
 *   }
 * ---------------------------------------------------------------------------
 */

Hooks.once("ready", () => {
  (() => {
    const KEY = "oni.ReactionExchange";
    if (window[KEY]) {
      console.debug("[ReactionExchange] Already installed.");
      return;
    }

    const TAG = "[ReactionExchange]";

    // -------------------------------------------------------------------------
    // Module-level state
    // -------------------------------------------------------------------------

    /** @type {Map<string, object>} exchangeId → state */
    const _exchanges = new Map();

    /** @type {Map<string, string>} boundaryKey → exchangeId (for dedupe / join lookup) */
    const _byBoundary = new Map();

    // -------------------------------------------------------------------------
    // Small helpers
    // -------------------------------------------------------------------------

    function _randId(prefix) {
      const rnd = foundry?.utils?.randomID?.()
        ?? (Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
      return `${prefix}-${rnd}`;
    }

    function _now() { return Date.now(); }

    /** Deep-clone for hook payloads / external snapshots. */
    function _clone(v) {
      if (foundry?.utils?.deepClone) return foundry.utils.deepClone(v);
      return JSON.parse(JSON.stringify(v));
    }

    function _stringArray(v) {
      if (!Array.isArray(v)) return [];
      const out = [];
      const seen = new Set();
      for (const x of v) {
        const s = String(x ?? "").trim();
        if (!s || seen.has(s)) continue;
        seen.add(s);
        out.push(s);
      }
      return out;
    }

    /** Validate trigger key shape; doesn't verify against registry (deferred). */
    function _normalizeTriggers(arr) {
      if (!Array.isArray(arr)) return [];
      const out = [];
      for (const t of arr) {
        if (!t || typeof t !== "object") continue;
        const key = String(t.key ?? "").trim();
        if (!key) continue;
        out.push({
          key,
          payload: t.payload && typeof t.payload === "object" ? _clone(t.payload) : {}
        });
      }
      return out;
    }

    function _findEntry(state, entryId) {
      if (!state || !entryId) return { entry: null, index: -1 };
      const idx = state.queue.findIndex(e => e.entryId === entryId);
      return { entry: idx >= 0 ? state.queue[idx] : null, index: idx };
    }

    // -------------------------------------------------------------------------
    // Status / ownership guards
    // -------------------------------------------------------------------------

    function _requireStatus(state, allowed, opName) {
      if (!allowed.includes(state.status)) {
        throw new Error(
          `${TAG} ${opName}: exchange ${state.exchangeId} is "${state.status}"; ` +
          `requires one of [${allowed.join(", ")}].`
        );
      }
    }

    /**
     * A "GM userId" string is anything that maps to a user with isGM=true,
     * OR the literal string "__GM__" / "GM" used by bridge scenarios.
     * We don't take a hard dependency on game.users here so the state
     * machine stays Foundry-free during bridge tests.
     */
    function _isGmUser(userId) {
      if (!userId) return false;
      const literal = String(userId).toUpperCase();
      if (literal === "GM" || literal === "__GM__") return true;
      try {
        const u = game.users?.get?.(userId);
        return !!u?.isGM;
      } catch (_) { return false; }
    }

    /**
     * Player can only mutate their own entries; GM can mutate any.
     */
    function _requireEntryOwnership(state, entry, actorUserId, opName) {
      if (!entry) {
        throw new Error(`${TAG} ${opName}: entry not found.`);
      }
      if (entry.userId === actorUserId) return;
      if (_isGmUser(actorUserId)) return;
      throw new Error(
        `${TAG} ${opName}: user ${actorUserId} does not own entry ${entry.entryId} ` +
        `(owner ${entry.userId}). GM override required.`
      );
    }

    function _requireEligible(state, userId, opName) {
      if (!state.eligibleUserIds.includes(userId)) {
        throw new Error(
          `${TAG} ${opName}: user ${userId} is not eligible for exchange ${state.exchangeId}.`
        );
      }
    }

    // -------------------------------------------------------------------------
    // Internal mutators (validation + bump + hook)
    // -------------------------------------------------------------------------

    /**
     * Once-per-chain (within Exchange) check: a skill uuid must not already
     * be in the queue OR usedSkillUuids set.
     */
    function _skillAlreadyCommitted(state, skillUuid) {
      if (!skillUuid) return false;
      if (state.usedSkillUuids.includes(skillUuid)) return "already_fired";
      if (state.queue.some(e => e.skillUuid === skillUuid)) return "already_queued";
      return false;
    }

    /**
     * Editing your own queue auto-un-Readies you. Doesn't auto-un-Ready
     * other users.
     */
    function _autoUnReady(state, userId) {
      if (state.readyUsers[userId]) {
        delete state.readyUsers[userId];
      }
    }

    /** Return true iff every eligible user has Readied. */
    function _allEligibleReady(state) {
      for (const uid of state.eligibleUserIds) {
        if (!state.readyUsers[uid]) return false;
      }
      return state.eligibleUserIds.length > 0;
    }

    function _bumpAndBroadcast(state, mutationKind, extras = {}) {
      state.version += 1;
      const snapshot = _clone(state);
      const hookName = (mutationKind === "open")
        ? "oni:exchange:opened"
        : "oni:exchange:mutated";
      try {
        Hooks.callAll(hookName, {
          exchangeId: state.exchangeId,
          snapshot,
          mutation: mutationKind,
          ...extras
        });
      } catch (e) {
        console.warn(`${TAG} hook ${hookName} threw`, e);
      }
      return snapshot;
    }

    function _transitionToResolving(state) {
      if (state.status !== "queueing") return;
      state.status = "resolving";
      state.version += 1;
      const snapshot = _clone(state);
      try {
        Hooks.callAll("oni:exchange:resolving", { exchangeId: state.exchangeId, snapshot });
      } catch (e) {
        console.warn(`${TAG} hook oni:exchange:resolving threw`, e);
      }
    }

    function _closeInternal(state, reason) {
      if (state.status === "closed") return _clone(state);
      state.status = "closed";
      state.closeReason = reason ?? "unspecified";
      state.closedAt = _now();
      state.version += 1;
      const snapshot = _clone(state);
      try {
        Hooks.callAll("oni:exchange:closed", {
          exchangeId: state.exchangeId,
          snapshot,
          reason: state.closeReason
        });
      } catch (e) {
        console.warn(`${TAG} hook oni:exchange:closed threw`, e);
      }
      // Drop indexes. The state object itself is still returned to the
      // caller, but it's frozen-as-final from the manager's perspective.
      _exchanges.delete(state.exchangeId);
      if (state.boundaryKey) _byBoundary.delete(state.boundaryKey);
      return snapshot;
    }

    // -------------------------------------------------------------------------
    // Public API — Exchange lifecycle
    // -------------------------------------------------------------------------

    /**
     * Open a new Exchange. Returns the freshly created snapshot.
     *
     * @param {object} opts
     * @param {"action_card"|"lifecycle"|"standalone"} opts.kind
     * @param {string} opts.boundaryKey               - dedupe key (actionCardId / lifecycleKey).
     *                                                  If an Exchange with this key already
     *                                                  exists, it is returned (idempotent join).
     * @param {object} opts.payload                   - initial event payload.
     * @param {Array<{key:string,payload?:object}>} opts.initialTriggers
     * @param {string[]} opts.eligibleUserIds         - users who must Ready.
     */
    function open(opts = {}) {
      const kind = String(opts.kind ?? "standalone");
      if (!["action_card", "lifecycle", "standalone"].includes(kind)) {
        throw new Error(`${TAG} open: unknown kind "${kind}".`);
      }
      const boundaryKey = String(opts.boundaryKey ?? "").trim() || _randId("boundary");

      // Idempotent join: if an Exchange with this boundary already exists,
      // return it. (Callers like the damage card pipeline benefit from
      // multi-damage-card-per-action-card joining the same Exchange.)
      if (_byBoundary.has(boundaryKey)) {
        const existingId = _byBoundary.get(boundaryKey);
        const existing = _exchanges.get(existingId);
        if (existing && existing.status === "queueing") {
          // Merge fired triggers into the existing Exchange.
          const incoming = _normalizeTriggers(opts.initialTriggers);
          if (incoming.length) {
            existing.firedTriggers.push(...incoming);
            // Merge new eligible users.
            const incomingEligible = _stringArray(opts.eligibleUserIds);
            const merged = new Set(existing.eligibleUserIds);
            for (const u of incomingEligible) merged.add(u);
            existing.eligibleUserIds = Array.from(merged);
            _bumpAndBroadcast(existing, "join_boundary", {
              addedTriggers: incoming,
              addedEligibleUserIds: incomingEligible
            });
          }
          return _clone(existing);
        }
      }

      const exchangeId = _randId("ex");
      const state = {
        exchangeId,
        version: 0,
        status: "queueing",
        kind,
        boundaryKey,
        payload: opts.payload && typeof opts.payload === "object" ? _clone(opts.payload) : {},
        firedTriggers: _normalizeTriggers(opts.initialTriggers),
        usedSkillUuids: [],
        eligibleUserIds: _stringArray(opts.eligibleUserIds),
        queue: [],
        readyUsers: {},
        candidatesByUser: {},          // userId → [Candidate]; step 4 populates from matcher
        resolutionLog: [],
        closeReason: null,
        openedAt: _now(),
        closedAt: null
      };

      _exchanges.set(exchangeId, state);
      _byBoundary.set(boundaryKey, exchangeId);
      return _bumpAndBroadcast(state, "open");
    }

    /**
     * Add an entry to the queue. The actor (user proposing the mutation)
     * must be the entry's controlling user OR the GM.
     *
     * @returns {string} entryId
     */
    function addEntry(exchangeId, params = {}, actorUserId = null) {
      const state = _requireExchange(exchangeId, "addEntry");
      _requireStatus(state, ["queueing"], "addEntry");

      const userId = String(params.userId ?? "").trim();
      if (!userId) throw new Error(`${TAG} addEntry: userId required.`);
      _requireEligible(state, userId, "addEntry");

      // Ownership: if actorUserId is provided and differs from userId, must be GM.
      const acting = actorUserId ?? userId;
      if (acting !== userId && !_isGmUser(acting)) {
        throw new Error(
          `${TAG} addEntry: user ${acting} cannot add an entry on behalf of ${userId} ` +
          `without GM privileges.`
        );
      }

      const skillUuid = String(params.skillUuid ?? "").trim();
      if (!skillUuid) throw new Error(`${TAG} addEntry: skillUuid required.`);

      const conflict = _skillAlreadyCommitted(state, skillUuid);
      if (conflict) {
        throw new Error(
          `${TAG} addEntry: skill ${skillUuid} is ${conflict} in this Exchange ` +
          `(once-per-chain).`
        );
      }

      const entry = {
        entryId: _randId("e"),
        userId,
        reactorTokenId: String(params.reactorTokenId ?? "").trim() || null,
        reactorActorUuid: String(params.reactorActorUuid ?? "").trim() || null,
        reactorName: String(params.reactorName ?? "").trim() || null,
        skillUuid,
        skillName: String(params.skillName ?? "").trim() || skillUuid,
        sourceTriggerKey: String(params.sourceTriggerKey ?? "").trim() || null,
        predictedTriggers: _normalizeTriggers(params.predictedTriggers),
        targeting: params.targeting && typeof params.targeting === "object"
          ? _clone(params.targeting) : {},
        addedAt: _now(),
        addedBy: acting
      };

      state.queue.push(entry);
      _autoUnReady(state, userId);

      _bumpAndBroadcast(state, "addEntry", { entryId: entry.entryId });
      return entry.entryId;
    }

    function removeEntry(exchangeId, entryId, actorUserId = null) {
      const state = _requireExchange(exchangeId, "removeEntry");
      _requireStatus(state, ["queueing"], "removeEntry");

      const { entry, index } = _findEntry(state, entryId);
      _requireEntryOwnership(state, entry, actorUserId ?? entry?.userId, "removeEntry");

      state.queue.splice(index, 1);
      _autoUnReady(state, entry.userId);

      _bumpAndBroadcast(state, "removeEntry", { entryId, ownerUserId: entry.userId });
    }

    function reorderEntry(exchangeId, entryId, newIndex, actorUserId = null) {
      const state = _requireExchange(exchangeId, "reorderEntry");
      _requireStatus(state, ["queueing"], "reorderEntry");

      const { entry, index } = _findEntry(state, entryId);
      _requireEntryOwnership(state, entry, actorUserId ?? entry?.userId, "reorderEntry");

      const target = Math.max(0, Math.min(Number(newIndex) | 0, state.queue.length - 1));
      if (target === index) return;

      state.queue.splice(index, 1);
      state.queue.splice(target, 0, entry);
      _autoUnReady(state, entry.userId);

      _bumpAndBroadcast(state, "reorderEntry", {
        entryId, fromIndex: index, toIndex: target, ownerUserId: entry.userId
      });
    }

    function setReady(exchangeId, userId, isReady, actorUserId = null) {
      const state = _requireExchange(exchangeId, "setReady");
      _requireStatus(state, ["queueing"], "setReady");

      const u = String(userId ?? "").trim();
      _requireEligible(state, u, "setReady");

      const acting = actorUserId ?? u;
      if (acting !== u && !_isGmUser(acting)) {
        throw new Error(
          `${TAG} setReady: user ${acting} cannot toggle Ready for ${u} ` +
          `without GM privileges.`
        );
      }

      if (isReady) {
        state.readyUsers[u] = { readiedAt: _now() };
      } else {
        delete state.readyUsers[u];
      }

      _bumpAndBroadcast(state, "setReady", { userId: u, isReady: !!isReady });

      // All-ready transition.
      if (isReady && _allEligibleReady(state)) {
        _transitionToResolving(state);
      }
    }

    /**
     * Any user can Force-Resolve when every OTHER eligible user has Readied.
     * (Symmetric — neither GM nor PCs have exclusive override; whoever's still
     * waited-on can flip the switch.)
     *
     * GM can always force-resolve regardless (escape hatch).
     */
    function forceResolve(exchangeId, actorUserId) {
      const state = _requireExchange(exchangeId, "forceResolve");
      _requireStatus(state, ["queueing"], "forceResolve");

      const acting = String(actorUserId ?? "").trim();
      const isGM = _isGmUser(acting);

      if (!isGM) {
        // Non-GM: must be eligible AND every OTHER eligible user must be Ready.
        if (!state.eligibleUserIds.includes(acting)) {
          throw new Error(
            `${TAG} forceResolve: user ${acting} is not eligible and not GM.`
          );
        }
        for (const uid of state.eligibleUserIds) {
          if (uid === acting) continue;
          if (!state.readyUsers[uid]) {
            throw new Error(
              `${TAG} forceResolve: user ${uid} has not Readied; ` +
              `cannot force-resolve until everyone else is Ready (GM override required).`
            );
          }
        }
      }

      // Mark the caller Ready (no-op if already), then transition.
      if (state.eligibleUserIds.includes(acting)) {
        state.readyUsers[acting] = { readiedAt: _now(), forced: true };
      }
      _bumpAndBroadcast(state, "forceResolve", { actorUserId: acting, byGM: isGM });
      _transitionToResolving(state);
    }

    /**
     * Set the candidate list for a user. Candidates are skills the user
     * (or GM, for monsters) may add to the queue right now. Step 4's
     * matcher integration calls this whenever queue mutations change
     * the speculative trigger set; step 3's UI reads the list to render
     * the "Your reactions" panel.
     *
     * Caller authority: any user can set their own candidates; GM can set
     * any user's. (Players don't compute candidates themselves; they ask
     * the GM via socket. Step 4 wires that path.)
     *
     * Candidate shape:
     *   {
     *     skillUuid:         string
     *     skillName:         string
     *     reactorTokenId:    string
     *     reactorActorUuid:  string
     *     reactorName:       string            - display label (e.g. "Hina" or "Vengeful Spirit")
     *     sourceTriggerKey:  string            - which trigger surfaced this candidate
     *     predictedTriggers: [{key,payload?}]
     *     img:               string|null       - icon for the UI
     *     available:         boolean           - false = greyed/disabled
     *     disabledReason:    string|null       - "already_queued" | "already_used" | "blocks_reactions" | ...
     *   }
     */
    function setCandidates(exchangeId, userId, candidates, actorUserId = null) {
      const state = _requireExchange(exchangeId, "setCandidates");
      _requireStatus(state, ["queueing", "resolving"], "setCandidates");

      const u = String(userId ?? "").trim();
      if (!u) throw new Error(`${TAG} setCandidates: userId required.`);

      const acting = actorUserId ?? u;
      if (acting !== u && !_isGmUser(acting)) {
        throw new Error(
          `${TAG} setCandidates: user ${acting} cannot set candidates for ${u} ` +
          `without GM privileges.`
        );
      }

      const list = Array.isArray(candidates) ? candidates : [];
      const normalized = [];
      for (const c of list) {
        if (!c || typeof c !== "object") continue;
        const skillUuid = String(c.skillUuid ?? "").trim();
        if (!skillUuid) continue;
        normalized.push({
          skillUuid,
          skillName: String(c.skillName ?? "").trim() || skillUuid,
          reactorTokenId: String(c.reactorTokenId ?? "").trim() || null,
          reactorActorUuid: String(c.reactorActorUuid ?? "").trim() || null,
          reactorName: String(c.reactorName ?? "").trim() || null,
          sourceTriggerKey: String(c.sourceTriggerKey ?? "").trim() || null,
          predictedTriggers: _normalizeTriggers(c.predictedTriggers),
          img: c.img ? String(c.img) : null,
          available: c.available !== false,
          disabledReason: c.disabledReason ? String(c.disabledReason) : null
        });
      }

      state.candidatesByUser[u] = normalized;
      _bumpAndBroadcast(state, "setCandidates", { userId: u, count: normalized.length });
    }

    /**
     * Step 2's resolution engine calls this when it has finished processing
     * the queue. In step 1 it's the bridge's responsibility (the bridge
     * scenario explicitly calls markResolved + close to drive lifecycle
     * transitions deterministically).
     *
     * @param {object} resolution
     * @param {string[]} resolution.usedSkillUuids - skills that fired (not fizzled)
     * @param {LogEntry[]} resolution.resolutionLog
     */
    function markResolved(exchangeId, resolution = {}) {
      const state = _requireExchange(exchangeId, "markResolved");
      _requireStatus(state, ["resolving"], "markResolved");

      state.usedSkillUuids = _stringArray(resolution.usedSkillUuids);
      state.resolutionLog = Array.isArray(resolution.resolutionLog)
        ? resolution.resolutionLog.map(e => _clone(e))
        : [];

      _bumpAndBroadcast(state, "markResolved", {
        usedSkillUuids: state.usedSkillUuids.slice(),
        logCount: state.resolutionLog.length
      });
    }

    function close(exchangeId, reason = "completed") {
      const state = _requireExchange(exchangeId, "close");
      return _closeInternal(state, reason);
    }

    /**
     * Force-close a queueing or resolving Exchange (cleanup path: action card
     * cancelled, token deleted, combat ended, GM disconnect). Caller supplies
     * a reason so the close hook can route to appropriate cleanup. Returns
     * the final snapshot, or null if no such exchange existed.
     */
    function abort(exchangeId, reason = "aborted") {
      const state = _exchanges.get(exchangeId);
      if (!state || state.status === "closed") return null;
      return _closeInternal(state, reason);
    }

    // -------------------------------------------------------------------------
    // Read-only accessors
    // -------------------------------------------------------------------------

    function snapshot(exchangeId) {
      const state = _exchanges.get(exchangeId);
      return state ? _clone(state) : null;
    }

    function snapshotByBoundary(boundaryKey) {
      const exchangeId = _byBoundary.get(boundaryKey);
      return exchangeId ? snapshot(exchangeId) : null;
    }

    function listActive() {
      const out = [];
      for (const state of _exchanges.values()) out.push(_clone(state));
      return out;
    }

    function _requireExchange(exchangeId, opName) {
      const state = _exchanges.get(exchangeId);
      if (!state) {
        throw new Error(`${TAG} ${opName}: no active Exchange with id ${exchangeId}.`);
      }
      return state;
    }

    // -------------------------------------------------------------------------
    // Test helpers (bridge-only; do not call from gameplay code)
    // -------------------------------------------------------------------------

    /**
     * Reset all in-memory state. Used by bridge scenario runner between
     * scripted scenarios so they don't pollute each other.
     */
    function _testReset() {
      _exchanges.clear();
      _byBoundary.clear();
    }

    // -------------------------------------------------------------------------
    // Export
    // -------------------------------------------------------------------------

    const api = {
      // Lifecycle
      open,
      addEntry,
      removeEntry,
      reorderEntry,
      setReady,
      forceResolve,
      setCandidates,
      markResolved,
      close,
      abort,
      // Reads
      snapshot,
      snapshotByBoundary,
      listActive,
      // Predicates (exposed for sync layer / UI)
      _isGmUser,
      _allEligibleReady,
      _skillAlreadyCommitted,
      // Test
      _testReset
    };

    window[KEY] = api;

    // Convenience namespace on the global FUCompanion API surface.
    globalThis.FUCompanion ??= {};
    globalThis.FUCompanion.api ??= {};
    globalThis.FUCompanion.api.reactionExchange = api;

    console.debug(`${TAG} Installed (state machine). Exposed on window["${KEY}"] and FUCompanion.api.reactionExchange.`);
  })();
});
