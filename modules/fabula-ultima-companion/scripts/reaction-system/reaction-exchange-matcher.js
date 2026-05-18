/**
 * [ONI] Reaction Exchange — Matcher / Emit Helper (Foundry VTT v12)
 * ---------------------------------------------------------------------------
 * Bridges the legacy `oni.ReactionTriggerCore.collectReactionsForTrigger`
 * matcher to the Reaction Exchange state machine.
 *
 * Exposes one main entry point — `openReactionExchange(opts)` — that emit
 * sites (damage card, crisis emitter, defeated emitter, lifecycle hooks)
 * call instead of the legacy `emitPhaseSequential` chain. Internally it:
 *
 *   1. Auto-resolves passive reactions via AutoPassiveManager (so passives
 *      fire BEFORE the Exchange opens, matching the design — passives
 *      aren't on the stack, they're automatic).
 *   2. Runs the matcher across every trigger in the batch.
 *   3. Aggregates eligible users from token-owner permissions.
 *   4. Returns early (no Exchange) if no manual reactions matched.
 *   5. Opens an Exchange with the union of fired triggers + payload.
 *   6. Calls setCandidates per user with the per-user candidate list.
 *
 * Also listens to `oni:exchange:mutated` to perform **combo refresh**:
 * when a queue mutation changes the speculative trigger set (queued
 * entries declare `predicted_triggers`), re-run the matcher and update
 * candidates so new options appear live.
 *
 * Step 4 scope:
 *   - openReactionExchange(opts)
 *   - Combo refresh on queue mutations
 *   - Once-per-chain marking on candidates (queued / used → disabled)
 *
 * Not in scope:
 *   - Effect dispatch — that's the resolver's runners (sub-step 4B).
 *   - Capability / cost — also resolver runners (4B).
 *   - Emit-site changes — sub-step 4C-F.
 *
 * Exposed:
 *   - window["oni.ReactionExchangeMatcher"]
 *   - FUCompanion.api.reactionExchangeMatcher
 * ---------------------------------------------------------------------------
 */

Hooks.once("ready", () => {
  (() => {
    const KEY = "oni.ReactionExchangeMatcher";
    if (window[KEY]) {
      console.debug("[ReactionExchangeMatcher] Already installed.");
      return;
    }

    const TAG = "[ReactionExchangeMatcher]";
    const MODULE_ID = "fabula-ultima-companion";
    const SOCKET_CHANNEL = `module.${MODULE_ID}`;

    const exchangeApi = window["oni.ReactionExchange"];
    if (!exchangeApi) {
      console.error(`${TAG} oni.ReactionExchange not loaded.`);
      return;
    }

    function _randId(prefix) {
      const rnd = foundry?.utils?.randomID?.()
        ?? (Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
      return `${prefix}-${rnd}`;
    }

    // -------------------------------------------------------------------------
    // GM-routing for player-side openReactionExchange calls
    // -------------------------------------------------------------------------
    //
    // Pending request map: requestId → resolver. Non-GM client populates this
    // when it sends a socket Open:Request; the entry resolves when the GM
    // returns the Open:Result (which it does only after the Exchange has
    // closed — single round-trip semantics).
    const _pendingOpens = new Map();
    const OPEN_REQUEST_TIMEOUT_MS = 180000; // 3 minutes; long because the GM
                                            // may be awaiting full resolution.

    function _requestOpenOnGM(opts) {
      if (!game.socket) {
        return Promise.resolve({ opened: false, reason: "no_socket" });
      }
      const requestId = _randId("rx-open");
      const originUserId = game.user?.id ?? null;
      const promise = new Promise((resolve) => {
        const timer = setTimeout(() => {
          _pendingOpens.delete(requestId);
          console.warn(`${TAG} Open:Request timed out`, { requestId });
          resolve({ opened: false, reason: "gm_timeout" });
        }, OPEN_REQUEST_TIMEOUT_MS);
        _pendingOpens.set(requestId, { resolve, timer });
      });
      try {
        game.socket.emit(SOCKET_CHANNEL, {
          type: "OniReactionExchange:Open:Request",
          payload: { requestId, originUserId, opts }
        });
      } catch (e) {
        _pendingOpens.delete(requestId);
        console.warn(`${TAG} Open:Request emit failed`, e);
        return Promise.resolve({ opened: false, reason: "emit_failed" });
      }
      return promise;
    }

    async function _handleOpenRequest(msg) {
      if (!game.user?.isGM) return;
      const payload = msg?.payload ?? {};
      const { requestId, originUserId, opts } = payload;
      if (!requestId || !originUserId || !opts) return;

      let result;
      try {
        // Re-enter the local function; since we're GM, it'll skip the
        // socket-routing branch and run the matcher locally.
        result = await openReactionExchange(opts);
      } catch (e) {
        console.warn(`${TAG} Open:Request handler threw`, e);
        result = { opened: false, reason: `gm_threw:${e?.message ?? e}` };
      }
      try {
        game.socket?.emit(SOCKET_CHANNEL, {
          type: "OniReactionExchange:Open:Result",
          payload: { requestId, originUserId, result }
        });
      } catch (e) {
        console.warn(`${TAG} Open:Result emit failed`, e);
      }
    }

    function _handleOpenResult(msg) {
      const payload = msg?.payload ?? {};
      const { requestId, originUserId, result } = payload;
      if (!requestId) return;
      // Result is broadcast to all clients; only the originator reacts.
      if (originUserId !== (game.user?.id ?? null)) return;
      const pending = _pendingOpens.get(requestId);
      if (!pending) return;
      _pendingOpens.delete(requestId);
      try { clearTimeout(pending.timer); } catch (_) {}
      pending.resolve(result ?? { opened: false, reason: "empty_result" });
    }

    function _onSocketMessage(msg) {
      if (!msg || typeof msg !== "object") return;
      switch (msg.type) {
        case "OniReactionExchange:Open:Request": return _handleOpenRequest(msg);
        case "OniReactionExchange:Open:Result":  return _handleOpenResult(msg);
        default: return;
      }
    }

    if (game.socket) {
      game.socket.on(SOCKET_CHANNEL, _onSocketMessage);
      console.debug(`${TAG} Socket listener attached on ${SOCKET_CHANNEL} (user ${game.user?.id ?? "(unknown)"}; isGM=${!!game.user?.isGM}).`);
    } else {
      console.warn(`${TAG} game.socket unavailable at ready; GM-routing disabled.`);
    }

    function _triggerCoreApi()   { return window["oni.ReactionTriggerCore"] ?? null; }
    function _helpersApi()       { return window["oni.ReactionManagerHelpers"] ?? null; }
    function _autoPassiveApi()   {
      return window["oni.AutoPassiveManager"]
        ?? globalThis.FUCompanion?.api?.autoPassiveManager
        ?? null;
    }
    function _registryApi()      { return window["oni.ReactionTriggers"] ?? null; }

    function _clone(v) {
      if (foundry?.utils?.deepClone) return foundry.utils.deepClone(v);
      return JSON.parse(JSON.stringify(v));
    }

    // -------------------------------------------------------------------------
    // Helpers — pull `predicted_triggers` from a reaction row
    // -------------------------------------------------------------------------

    /**
     * The reaction_config_table row may declare `predicted_triggers` as
     * a string list (one trigger key per row, like `creature_recovers_hp`)
     * OR an array. For step 4 we accept both; future authoring UI will
     * tighten this.
     */
    function _readPredictedTriggers(row) {
      const raw = row?.predicted_triggers
                ?? row?.predictedTriggers
                ?? null;
      if (!raw) return [];
      const out = [];
      const push = (val) => {
        const k = String(val ?? "").trim();
        if (k) out.push({ key: k, payload: {} });
      };
      if (Array.isArray(raw)) {
        for (const v of raw) {
          if (v && typeof v === "object" && v.key) {
            out.push({ key: String(v.key), payload: v.payload ?? {} });
          } else if (typeof v === "string") {
            push(v);
          }
        }
      } else if (typeof raw === "string") {
        // Support comma-separated or whitespace-separated list.
        for (const part of raw.split(/[,\s]+/)) push(part);
      }
      return out;
    }

    // -------------------------------------------------------------------------
    // Matcher invocation
    // -------------------------------------------------------------------------

    /**
     * Run `collectReactionsForTrigger` for every trigger in the batch,
     * then aggregate into a map by `actor.uuid`. Each entry has:
     *   { actor, token, combatant, reactions: [{ item, sourceTriggerKey, rows, predictedTriggers }] }
     *
     * Same skill (item.uuid) matched by multiple triggers becomes multiple
     * candidate entries — UI can collapse / decorate as needed. For step 4
     * we keep them separate so source-trigger attribution is preserved.
     */
    function _runMatcher(triggers, payload) {
      const core = _triggerCoreApi();
      if (!core) {
        console.error(`${TAG} oni.ReactionTriggerCore not installed.`);
        return [];
      }

      const out = [];
      for (const t of triggers) {
        const key = t?.key ?? t?.trigger ?? null;
        if (!key) continue;
        const merged = { ...(payload ?? {}), ...(t?.payload ?? {}), trigger: key };
        let matches = [];
        try {
          matches = core.collectReactionsForTrigger(key, merged) ?? [];
        } catch (e) {
          console.warn(`${TAG} matcher threw for trigger ${key}`, e);
          continue;
        }
        for (const m of matches) {
          for (const rx of (m.reactions ?? [])) {
            out.push({
              actor: m.actor,
              token: m.token,
              combatant: m.combatant,
              sourceTriggerKey: key,
              sourcePayload: merged,
              item: rx.item,
              rows: rx.rows ?? []
            });
          }
        }
      }
      return out;
    }

    /**
     * Convert raw matches → { eligibleUserIds, candidatesByUser }.
     *
     * - Eligibility is union of `getOwningUserIdsForToken` across all matches.
     * - Candidates per user: each match contributes one candidate object,
     *   filtered to skills the user controls.
     * - Mark candidates `available: false` if their skillUuid is already in
     *   the queue or in `usedSkillUuids` (once-per-chain).
     */
    function _buildCandidatesAndEligibility(matches, snapshot) {
      const helpers = _helpersApi();
      const getOwners = helpers?.getOwningUserIdsForToken;
      if (typeof getOwners !== "function") {
        console.error(`${TAG} reaction-manager-helpers.getOwningUserIdsForToken unavailable.`);
        return { eligibleUserIds: [], candidatesByUser: {} };
      }

      const queuedUuids = new Set(snapshot?.queue?.map(e => e.skillUuid) ?? []);
      const usedUuids = new Set(snapshot?.usedSkillUuids ?? []);

      const eligible = new Set();
      const byUser = {};

      for (const m of matches) {
        const tokenDoc = m.token?.document;
        if (!tokenDoc || !m.actor) continue;
        const owners = getOwners(tokenDoc, m.actor) ?? [];
        if (!owners.length) continue;

        // Disabled reason precedence: used > queued > available.
        const skillUuid = m.item.uuid;
        let available = true;
        let disabledReason = null;
        if (usedUuids.has(skillUuid)) {
          available = false;
          disabledReason = "already_used";
        } else if (queuedUuids.has(skillUuid)) {
          available = false;
          disabledReason = "already_queued";
        }

        // Predicted triggers — take from the first matching row that has them.
        let predicted = [];
        for (const row of m.rows) {
          const got = _readPredictedTriggers(row);
          if (got.length) { predicted = got; break; }
        }

        // Effect refs — dedup-preserve-order across matching rows. These
        // are the labels the resolver's effectRunner will pass to
        // applyEffectByLabel.
        const effectRefs = [];
        const refSeen = new Set();
        for (const row of m.rows) {
          const ref = String(row?.reaction_effect_ref ?? "").trim();
          if (!ref || refSeen.has(ref)) continue;
          refSeen.add(ref);
          effectRefs.push(ref);
        }

        const candidate = {
          skillUuid,
          skillName: m.item.name ?? skillUuid,
          reactorTokenId: tokenDoc.id ?? null,
          reactorActorUuid: m.actor.uuid,
          reactorName: tokenDoc.name ?? m.actor.name ?? null,
          sourceTriggerKey: m.sourceTriggerKey,
          effectRefs,
          predictedTriggers: predicted,
          img: m.item.img ?? null,
          available,
          disabledReason
        };

        for (const uid of owners) {
          eligible.add(uid);
          if (!byUser[uid]) byUser[uid] = [];
          // Per-user de-dup by skillUuid + sourceTriggerKey
          const dupIdx = byUser[uid].findIndex(c =>
            c.skillUuid === skillUuid && c.sourceTriggerKey === candidate.sourceTriggerKey
          );
          if (dupIdx >= 0) continue;
          byUser[uid].push(candidate);
        }
      }

      return {
        eligibleUserIds: Array.from(eligible),
        candidatesByUser: byUser
      };
    }

    // -------------------------------------------------------------------------
    // Passive auto-resolution (split off before the Exchange opens)
    // -------------------------------------------------------------------------

    /**
     * Run auto-passive resolution across the trigger batch and return the
     * MANUAL matches that remain. Mirrors reaction-manager's split logic
     * (passive rows fire automatically; manual rows go on the stack).
     */
    async function _splitPassives(triggers, payload) {
      const matches = _runMatcher(triggers, payload);
      console.log(`${TAG} _splitPassives: matcher returned`, {
        triggerKeys: triggers.map(t => t?.key),
        matchCount: matches.length,
        matches: matches.map(m => ({
          actorName: m.actor?.name,
          itemName: m.item?.name,
          sourceTrigger: m.sourceTriggerKey,
          rowCount: m.rows?.length,
          rowIsPassiveFlags: (m.rows ?? []).map(r => ({
            trigger: r?.reaction_trigger,
            isPassive: r?.reaction_isPassive,
            effectRef: r?.reaction_effect_ref
          }))
        }))
      });
      const autoApi = _autoPassiveApi();
      const registry = _registryApi();
      if (!autoApi?.processMatches) {
        console.warn(`${TAG} _splitPassives: AutoPassiveManager unavailable; treating all matches as manual.`);
        return matches;
      }
      const helpers = _helpersApi();
      const getOwners = helpers?.getOwningUserIdsForToken;

      // Group matches by actor for processMatches input shape.
      const byActor = new Map();
      for (const m of matches) {
        const k = m.actor?.uuid;
        if (!k) continue;
        if (!byActor.has(k)) {
          byActor.set(k, {
            actor: m.actor,
            token: m.token,
            combatant: m.combatant,
            ownerUserIds: getOwners ? getOwners(m.token?.document, m.actor) ?? [] : [],
            reactions: []
          });
        }
        byActor.get(k).reactions.push({
          item: m.item,
          triggers: [m.sourceTriggerKey],
          rows: m.rows
        });
      }
      const grouped = Array.from(byActor.values());

      const phasePayloadByTrigger = {};
      for (const t of triggers) {
        if (t?.key) phasePayloadByTrigger[t.key] = _clone({ ...(payload ?? {}), ...(t.payload ?? {}), trigger: t.key });
      }

      const sourceEvent = helpers?.buildPassiveSourceEvent?.({
        rawTrigger: triggers[0]?.key,
        triggerKey: triggers[0]?.key,
        phaseBucket: registry?.bucketFor?.(triggers[0]?.key) ?? null,
        payload
      }) ?? null;

      let processed = null;
      try {
        processed = await autoApi.processMatches({
          matches: grouped,
          triggerKey: triggers[0]?.key ?? null,
          phaseBucket: registry?.bucketFor?.(triggers[0]?.key) ?? null,
          rawTrigger: triggers[0]?.key ?? null,
          phasePayload: payload ?? {},
          phasePayloadByTrigger,
          sourceEvent
        });
      } catch (e) {
        console.warn(`${TAG} AutoPassiveManager.processMatches threw; treating all as manual.`, e);
        return matches;
      }

      // processMatches returns { manualMatches: groupedShape[] }; expand back
      // to flat matches keyed by (actor, item, trigger).
      //
      // IMPORTANT — alias normalization. The trigger value in `rx.triggers`
      // is the RAW row.reaction_trigger (possibly an alias like
      // "hp_reduced"), while my flat `m.sourceTriggerKey` is the
      // NORMALIZED key ("creature_takes_damage"). Normalize both sides.
      const manualGrouped = Array.isArray(processed?.manualMatches) ? processed.manualMatches : [];
      const triggerCore = window["oni.ReactionTriggerCore"];
      const normalizeTrigger = (t) =>
        triggerCore?.mapIncomingTrigger?.(t) ?? String(t ?? "").trim();

      const manualKeys = new Set();
      const manualRowsByKey = new Map();
      for (const g of manualGrouped) {
        for (const rx of (g.reactions ?? [])) {
          for (const tk of (rx.triggers ?? [])) {
            const k = `${g.actor?.uuid ?? ""}::${rx.item?.uuid ?? ""}::${normalizeTrigger(tk)}`;
            manualKeys.add(k);
            // shallowCloneReactionGroup already filtered rx.rows to manual-only.
            if (!manualRowsByKey.has(k)) manualRowsByKey.set(k, []);
            manualRowsByKey.get(k).push(...(rx.rows ?? []));
          }
        }
      }

      console.log(`${TAG} _splitPassives: processMatches returned`, {
        manualGroupCount: manualGrouped.length,
        manualKeys: Array.from(manualKeys),
        passiveResultCount: Array.isArray(processed?.passiveResults) ? processed.passiveResults.length : 0
      });

      // Filter the original flat match list AND replace each survivor's
      // rows with manual-only rows. Otherwise candidate.effectRefs would
      // include passive-row refs that already auto-fired.
      const filtered = [];
      for (const m of matches) {
        const key = `${m.actor?.uuid ?? ""}::${m.item?.uuid ?? ""}::${m.sourceTriggerKey}`;
        if (!manualKeys.has(key)) {
          console.log(`${TAG} _splitPassives: filtered out`, {
            actor: m.actor?.name,
            item: m.item?.name,
            sourceTrigger: m.sourceTriggerKey,
            key
          });
          continue;
        }
        const manualRows = manualRowsByKey.get(key);
        if (Array.isArray(manualRows) && manualRows.length) {
          m.rows = manualRows;
        }
        filtered.push(m);
      }
      return filtered;
    }

    // -------------------------------------------------------------------------
    // Combo refresh on queue mutations
    // -------------------------------------------------------------------------

    function _gatherSpeculativeTriggers(snapshot) {
      const out = [];
      for (const t of snapshot.firedTriggers ?? []) {
        if (t?.key) out.push({ key: t.key, payload: t.payload ?? {} });
      }
      for (const entry of snapshot.queue ?? []) {
        for (const t of entry.predictedTriggers ?? []) {
          if (t?.key) out.push({ key: t.key, payload: t.payload ?? {} });
        }
      }
      return out;
    }

    function _refreshCandidates(exchangeId) {
      const snapshot = exchangeApi.snapshot(exchangeId);
      if (!snapshot || snapshot.status !== "queueing") return;

      const triggers = _gatherSpeculativeTriggers(snapshot);
      const matches = _runMatcher(triggers, snapshot.payload);
      const { candidatesByUser } = _buildCandidatesAndEligibility(matches, snapshot);

      const known = new Set(snapshot.eligibleUserIds ?? []);
      for (const uid of known) {
        try {
          exchangeApi.setCandidates(exchangeId, uid, candidatesByUser[uid] ?? [], "__GM__");
        } catch (e) {
          console.warn(`${TAG} setCandidates failed during refresh`, { exchangeId, uid, error: e?.message });
        }
      }
    }

    // -------------------------------------------------------------------------
    // Main entry point
    // -------------------------------------------------------------------------

    /**
     * Wait for the Exchange with `exchangeId` to close. Resolves with the
     * final snapshot. Used by callers (damage card, lifecycle handlers)
     * that need to gate downstream work on resolution completion.
     */
    function _awaitClose(exchangeId, { timeoutMs = 120000 } = {}) {
      return new Promise((resolve) => {
        let timer = null;
        const handler = (data) => {
          if (data?.exchangeId !== exchangeId) return;
          try { Hooks.off("oni:exchange:closed", handler); } catch (_) {}
          if (timer != null) clearTimeout(timer);
          resolve(data.snapshot ?? null);
        };
        Hooks.on("oni:exchange:closed", handler);
        if (timeoutMs > 0) {
          timer = setTimeout(() => {
            try { Hooks.off("oni:exchange:closed", handler); } catch (_) {}
            console.warn(`${TAG} _awaitClose timeout after ${timeoutMs}ms for ${exchangeId}`);
            resolve(null);
          }, timeoutMs);
        }
      });
    }

    /**
     * Open a Reaction Exchange (or join an existing one with the same
     * boundaryKey).
     *
     * @param {object} opts
     * @param {"action_card"|"lifecycle"|"standalone"} opts.kind
     * @param {string} opts.boundaryKey
     * @param {Array<{key:string,payload?:object}>} opts.triggers
     * @param {object} opts.payload
     * @param {boolean} [opts.awaitClose=true]   - if true, the returned Promise
     *                                             only resolves when the Exchange
     *                                             closes (resolution complete or
     *                                             aborted). Set false for
     *                                             fire-and-forget emit sites.
     * @param {number} [opts.awaitTimeoutMs=120000] - safety bound for awaitClose
     *
     * @returns {Promise<object>} { opened: bool, exchangeId, hadMatches, finalSnapshot?, reason? }
     */
    async function openReactionExchange(opts = {}) {
      const kind = opts.kind ?? "standalone";
      const boundaryKey = String(opts.boundaryKey ?? "").trim();
      const payload = opts.payload ?? {};
      const triggers = Array.isArray(opts.triggers) ? opts.triggers : [];

      if (!triggers.length) {
        return { opened: false, exchangeId: null, hadMatches: false, reason: "no_triggers" };
      }

      // GM-authoritative: only the GM client runs the matcher + opens the
      // Exchange. Non-GM clients (player damage card emits) send the open
      // request via socket, wait for the GM to either decline (no manual
      // matches) or open + run to close, then receive the final result.
      //
      // Reason: AutoPassiveManager.processMatches short-circuits on non-GM
      // and returns the input list unchanged. Running the matcher on a
      // non-GM client would leak passive rows into the candidate list AND
      // skip auto-passive execution. Centralizing on GM fixes both.
      if (!game.user?.isGM) {
        return await _requestOpenOnGM({ kind, boundaryKey, payload, triggers, awaitClose: opts.awaitClose !== false });
      }

      // Suspend during in-flight resolution. Per design (single-stack-per-
      // phase), follow-up triggers fired while another Exchange is mid-
      // resolve are logged + discarded — they don't open a new Exchange.
      // The resolver flips its in-flight marker via runResolution.
      const resolver = window["oni.ReactionExchangeResolver"];
      if (resolver?.isAnyResolving?.()) {
        console.debug(`${TAG} openReactionExchange suppressed (in-flight resolution).`, {
          activeIds: resolver.getActiveResolutionIds?.() ?? [],
          opts: { kind, boundaryKey, triggers }
        });
        return { opened: false, exchangeId: null, hadMatches: false, reason: "in_flight_resolution" };
      }

      console.log(`${TAG} openReactionExchange (GM-side): entry`, {
        kind, boundaryKey,
        triggerKeys: triggers.map(t => t?.key),
        payloadKeys: Object.keys(payload ?? {})
      });

      // 1) Resolve passives first; only manual reactions feed the Exchange.
      const manualMatches = await _splitPassives(triggers, payload);
      console.log(`${TAG} openReactionExchange: after passive split`, {
        manualMatchCount: manualMatches.length
      });
      if (!manualMatches.length) {
        return { opened: false, exchangeId: null, hadMatches: false, reason: "no_manual_matches" };
      }

      // 2) Build initial candidates + eligibility from a synthetic empty
      //    snapshot (no queue, no used yet).
      const seed = {
        queue: [],
        usedSkillUuids: [],
        firedTriggers: triggers,
        eligibleUserIds: []
      };
      const { eligibleUserIds, candidatesByUser } = _buildCandidatesAndEligibility(manualMatches, seed);
      if (!eligibleUserIds.length) {
        return { opened: false, exchangeId: null, hadMatches: false, reason: "no_eligible_users" };
      }

      // 3) Open or join the Exchange.
      const snap = exchangeApi.open({
        kind,
        boundaryKey: boundaryKey || `${kind}-${Date.now()}`,
        payload,
        initialTriggers: triggers,
        eligibleUserIds
      });
      const exchangeId = snap.exchangeId;

      // 4) Populate candidates per user.
      for (const uid of eligibleUserIds) {
        try {
          exchangeApi.setCandidates(exchangeId, uid, candidatesByUser[uid] ?? [], "__GM__");
        } catch (e) {
          console.warn(`${TAG} initial setCandidates failed`, { exchangeId, uid, error: e?.message });
        }
      }

      const awaitClose = opts.awaitClose !== false;
      if (!awaitClose) {
        return {
          opened: true,
          exchangeId,
          snapshot: exchangeApi.snapshot(exchangeId),
          hadMatches: true
        };
      }

      const finalSnapshot = await _awaitClose(exchangeId, {
        timeoutMs: Number(opts.awaitTimeoutMs ?? 120000)
      });
      return {
        opened: true,
        exchangeId,
        hadMatches: true,
        finalSnapshot
      };
    }

    // -------------------------------------------------------------------------
    // Auto-wire: combo refresh on queue mutations
    // -------------------------------------------------------------------------

    let _autoRefreshActive = false;
    let _autoRefreshHandlerId = null;

    function enableAutoRefresh() {
      if (_autoRefreshActive) return;
      if (!game.user?.isGM) return;
      _autoRefreshHandlerId = Hooks.on("oni:exchange:mutated", ({ exchangeId, mutation }) => {
        // Only react to queue-shape mutations (the ones that change
        // speculative triggers). Skip ready / setCandidates / forceResolve.
        const queueShapeMutations = new Set(["addEntry", "removeEntry", "reorderEntry"]);
        if (!queueShapeMutations.has(mutation)) return;
        _refreshCandidates(exchangeId);
      });
      _autoRefreshActive = true;
      console.debug(`${TAG} Auto-refresh enabled (GM).`);
    }

    function disableAutoRefresh() {
      if (!_autoRefreshActive) return;
      try { Hooks.off("oni:exchange:mutated", _autoRefreshHandlerId); } catch (_) {}
      _autoRefreshHandlerId = null;
      _autoRefreshActive = false;
    }

    // Auto-enable on GM by default — emit sites assume combo refresh is on.
    if (game.user?.isGM) enableAutoRefresh();

    // -------------------------------------------------------------------------
    // Export
    // -------------------------------------------------------------------------

    const api = {
      openReactionExchange,
      enableAutoRefresh,
      disableAutoRefresh,
      isAutoRefreshEnabled: () => _autoRefreshActive,
      // Exposed for diagnostics + tests
      _runMatcher,
      _refreshCandidates
    };

    window[KEY] = api;
    globalThis.FUCompanion ??= {};
    globalThis.FUCompanion.api ??= {};
    globalThis.FUCompanion.api.reactionExchangeMatcher = api;

    console.debug(`${TAG} Installed.`);
  })();
});
