/**
 * [ONI] Reaction Exchange — Resolution Engine (Foundry VTT v12)
 * ---------------------------------------------------------------------------
 * Runs the resolution loop for an Exchange that has transitioned to
 * "resolving". Iterates the queue top-to-bottom; for each entry, runs
 * preFire checks (trigger recheck → capability → cost) and either
 * fizzles or fires the effect. Builds the resolution log + used-skill
 * set, then calls `markResolved` + `close` on the state machine.
 *
 * Step 2 scope (this file):
 *   - Injectable runner architecture: triggerRechecker, capabilityChecker,
 *     costChecker, effectRunner. Defaults are minimal so the engine is
 *     testable in isolation; step 4 plugs in real implementations.
 *   - `runResolution(exchangeId, { runners })` — explicit entry point.
 *   - Auto-wire to `oni:exchange:resolving` is OFF by default; enable
 *     via `enableAutoResolve()` in step 4.
 *   - Per-entry hook `oni:exchange:entryResolved` for UI subscribers.
 *
 * Not in scope (deferred):
 *   - Real trigger rechecker via `collectReactionsForTrigger` (step 4)
 *   - Real cost deduction (MP/IP/charges) (step 4)
 *   - Real effect runner via `oni.ReactionGrant.applyEffectByLabel`
 *     (step 4)
 *   - Suspending `updateActor`-driven crisis emits while resolving
 *     (step 4 — needs the option-flag plumbing)
 *
 * Runner contracts (all async-friendly; sync returns are accepted):
 *
 *   triggerRechecker(entry, snapshot) → boolean | { ok, reason? }
 *     Default: true. Step 4 will re-run `collectReactionsForTrigger`
 *     against `snapshot.payload` (post-mutations) to verify the row
 *     still matches.
 *
 *   capabilityChecker(entry, snapshot) → boolean | { ok, reason? }
 *     Default: scans the reactor actor's effects for a flag
 *     `flags["fabula-ultima-companion"].blocks_reactions === true`. Any
 *     active, non-suppressed effect with that flag fizzles the entry.
 *
 *   costChecker(entry, snapshot) → boolean | { ok, reason? }
 *     Default: true. Step 4 will verify MP/IP/charge availability.
 *
 *   effectRunner(entry, snapshot) → { ok, error?, capturedTriggers? }
 *     Default: no-op that returns `{ ok: true }`. Step 4 plugs in
 *     `oni.ReactionGrant.applyEffectByLabel` and a trigger collector.
 *
 * Result of runResolution(exchangeId):
 *   {
 *     ok: boolean,                 // overall — false if engine errored
 *     usedSkillUuids: string[],
 *     resolutionLog: [{
 *       entryId, skillUuid, skillName, userId,
 *       outcome: "fired" | "fizzled" | "errored",
 *       reason?: string,           // for fizzle / error
 *       error?: string,            // for errored
 *       capturedTriggers?: object[]
 *     }],
 *     closedSnapshot: object       // final snapshot after close
 *   }
 *
 * Exposed:
 *   - window["oni.ReactionExchangeResolver"]
 *   - FUCompanion.api.reactionExchangeResolver
 * ---------------------------------------------------------------------------
 */

Hooks.once("ready", () => {
  (() => {
    const KEY = "oni.ReactionExchangeResolver";
    if (window[KEY]) {
      console.debug("[ReactionExchangeResolver] Already installed.");
      return;
    }

    const TAG = "[ReactionExchangeResolver]";
    const exchangeApi = window["oni.ReactionExchange"];
    if (!exchangeApi) {
      console.error(`${TAG} oni.ReactionExchange not loaded.`);
      return;
    }

    // -------------------------------------------------------------------------
    // Default runners (stubs / minimal impls; step 4 replaces these)
    // -------------------------------------------------------------------------

    async function defaultTriggerRechecker(_entry, _snapshot) {
      // Real impl in step 4: walk the original matcher against current
      // payload / world state to verify the row still hits.
      return { ok: true };
    }

    async function defaultCapabilityChecker(entry, _snapshot) {
      // Look up the reactor actor and scan effects for the
      // `blocks_reactions` flag. Sleep / Stunned / similar statuses will
      // carry this flag (added as a small migration in step 4 or 6).
      const uuid = entry.reactorActorUuid;
      if (!uuid) return { ok: true }; // no actor to check — proceed
      let actor = null;
      try {
        actor = fromUuidSync ? fromUuidSync(uuid) : null;
      } catch (_) { actor = null; }
      if (!actor) {
        // Unknown actor → fail-closed for safety
        return { ok: false, reason: "reactor_actor_missing" };
      }
      // Check defeated
      try {
        const defeated = actor.statuses?.has?.("defeated") || actor.statuses?.has?.("dead");
        if (defeated) return { ok: false, reason: "reactor_defeated" };
      } catch (_) {}
      // Check blocks_reactions flag on any active, non-suppressed effect
      try {
        const effects = actor.effects?.contents ?? actor.effects ?? [];
        for (const eff of effects) {
          if (!eff) continue;
          if (eff.disabled) continue;
          if (eff.isSuppressed) continue;
          const flag = eff.flags?.["fabula-ultima-companion"]?.blocks_reactions;
          if (flag === true) {
            return { ok: false, reason: `blocks_reactions:${eff.name ?? eff.label ?? "unknown_status"}` };
          }
        }
      } catch (_) {}
      return { ok: true };
    }

    async function defaultCostChecker(_entry, _snapshot) {
      // Real impl in step 4: verify MP / IP / charges.
      return { ok: true };
    }

    // ---- Helpers for the real effect runner ----

    function _resolveReactionToken(tokenId) {
      if (!tokenId) return null;
      const onCanvas = canvas?.tokens?.get?.(tokenId);
      if (onCanvas) return onCanvas;
      // Fallback: derive from scene's TokenDocument when not placed on canvas.
      const scene = canvas?.scene ?? game?.scenes?.active ?? null;
      const tokenDoc = scene?.tokens?.get?.(tokenId);
      return tokenDoc?.object ?? null;
    }

    /**
     * Resolve a skill item from an Exchange entry's skillUuid. Handles
     * both real item UUIDs and the AE-borne synth-reaction case (where
     * the skillUuid is `<effectUuid>::synth-reaction`).
     */
    function _resolveSkillItem(skillUuid) {
      if (!skillUuid) return null;
      const synthSuffix = "::synth-reaction";
      if (skillUuid.endsWith(synthSuffix)) {
        const effectUuid = skillUuid.slice(0, -synthSuffix.length);
        let effect = null;
        try { effect = fromUuidSync(effectUuid); } catch (_) {}
        if (!effect) return null;
        const triggerCore = window["oni.ReactionTriggerCore"];
        if (!triggerCore?.synthesizeReactionItemFromAE) {
          console.warn(`${TAG} synthesizeReactionItemFromAE unavailable; can't resolve synth skill ${skillUuid}`);
          return null;
        }
        return triggerCore.synthesizeReactionItemFromAE(effect);
      }
      try { return fromUuidSync(skillUuid); } catch (_) { return null; }
    }

    async function defaultEffectRunner(entry, snapshot) {
      // Step 4 wiring: delegate to oni.ReactionGrant.applyEffectByLabel
      // for each effect_ref declared on the entry. The matcher pre-resolves
      // these from the matching rows at queue time, so the resolver doesn't
      // need to re-run the matcher.
      //
      // capturedTriggers is left empty for now — the existing effect handlers
      // emit follow-up triggers through the legacy `emitPhaseSequential`
      // path, which is harmless under single-stack-per-phase (those emits
      // open new Exchanges or fall back to ONI.emit). A proper trigger
      // collector wrapper is step 4 polish if/when we author a skill that
      // needs follow-up triggers captured into the same Exchange's log.
      const reactionToken = _resolveReactionToken(entry.reactorTokenId);
      if (!reactionToken) {
        return { ok: false, error: `reactor_token_missing:${entry.reactorTokenId}` };
      }

      const item = _resolveSkillItem(entry.skillUuid);
      if (!item) {
        return { ok: false, error: `skill_item_missing:${entry.skillUuid}` };
      }

      const grant = window["oni.ReactionGrant"];
      if (!grant?.applyEffectByLabel) {
        return { ok: false, error: "reaction_grant_api_unavailable" };
      }

      const refs = Array.isArray(entry.effectRefs) ? entry.effectRefs : [];
      if (!refs.length) {
        // No effect refs declared — the matched row(s) had no
        // reaction_effect_ref. Treat as silent success (the skill row
        // exists but has nothing to fire).
        return { ok: true, capturedTriggers: [] };
      }

      const payload = snapshot.payload ?? {};
      const applied = [];
      for (const ref of refs) {
        let res;
        try {
          res = await grant.applyEffectByLabel(
            item, ref, reactionToken, game.combat ?? null, payload, { isPassive: false }
          );
        } catch (e) {
          return {
            ok: false,
            error: `effect_threw:${ref}:${e?.message ?? e}`,
            capturedTriggers: []
          };
        }
        applied.push({ effectRef: ref, result: res });
        if (res?.abort) {
          return {
            ok: false,
            error: `aborted_at:${ref}:${res?.reason ?? "no_reason"}`,
            capturedTriggers: [],
            applied
          };
        }
      }

      return { ok: true, capturedTriggers: [], applied };
    }

    /** @type {{triggerRechecker:Function, capabilityChecker:Function, costChecker:Function, effectRunner:Function}} */
    const _defaults = {
      triggerRechecker:  defaultTriggerRechecker,
      capabilityChecker: defaultCapabilityChecker,
      costChecker:       defaultCostChecker,
      effectRunner:      defaultEffectRunner
    };

    function setDefaultRunners(overrides = {}) {
      for (const k of Object.keys(_defaults)) {
        if (typeof overrides[k] === "function") _defaults[k] = overrides[k];
      }
    }

    function getDefaultRunners() {
      return { ..._defaults };
    }

    // -------------------------------------------------------------------------
    // Pre-fire pipeline
    // -------------------------------------------------------------------------

    function _normalizeRunnerResult(raw, defaultReason) {
      if (raw === true) return { ok: true };
      if (raw === false) return { ok: false, reason: defaultReason };
      if (raw && typeof raw === "object") {
        return { ok: !!raw.ok, reason: raw.reason ?? (raw.ok ? null : defaultReason) };
      }
      return { ok: true };
    }

    async function _preFire(entry, snapshot, runners) {
      try {
        const t = _normalizeRunnerResult(
          await runners.triggerRechecker(entry, snapshot),
          "trigger_no_longer_matches"
        );
        if (!t.ok) return t;
      } catch (e) {
        return { ok: false, reason: `trigger_check_threw:${e?.message ?? e}` };
      }
      try {
        const c = _normalizeRunnerResult(
          await runners.capabilityChecker(entry, snapshot),
          "reactor_incapacitated"
        );
        if (!c.ok) return c;
      } catch (e) {
        return { ok: false, reason: `capability_check_threw:${e?.message ?? e}` };
      }
      try {
        const co = _normalizeRunnerResult(
          await runners.costChecker(entry, snapshot),
          "cost_cannot_pay"
        );
        if (!co.ok) return co;
      } catch (e) {
        return { ok: false, reason: `cost_check_threw:${e?.message ?? e}` };
      }
      return { ok: true };
    }

    // -------------------------------------------------------------------------
    // Main resolution loop
    // -------------------------------------------------------------------------

    /**
     * Resolve an Exchange. Must be in "resolving" status (i.e. all eligible
     * users Readied or someone Force-Resolved).
     *
     * @param {string} exchangeId
     * @param {object} [opts]
     * @param {object} [opts.runners]                  - override runners for this run
     * @param {string} [opts.closeReason="completed"]  - reason for the final close
     * @param {number} [opts.perEntryDelayMs=0]        - sleep N ms between entries
     *                                                   so per-entry flash animations
     *                                                   have time to play. Visual /
     *                                                   pacing tool, not gameplay-load-bearing.
     * @returns {Promise<object>} resolution result
     */
    /** @type {Set<string>} active resolution exchangeIds (in-flight markers). */
    const _activeResolutions = new Set();

    function isResolving(exchangeId) {
      return _activeResolutions.has(exchangeId);
    }
    function isAnyResolving() {
      return _activeResolutions.size > 0;
    }
    function getActiveResolutionIds() {
      return Array.from(_activeResolutions);
    }

    async function runResolution(exchangeId, opts = {}) {
      const initialSnapshot = exchangeApi.snapshot(exchangeId);
      if (!initialSnapshot) {
        throw new Error(`${TAG} runResolution: no Exchange with id ${exchangeId}.`);
      }
      if (initialSnapshot.status !== "resolving") {
        throw new Error(
          `${TAG} runResolution: Exchange ${exchangeId} is "${initialSnapshot.status}"; ` +
          `must be "resolving".`
        );
      }

      _activeResolutions.add(exchangeId);

      const runners = { ..._defaults, ...(opts.runners ?? {}) };
      const closeReason = String(opts.closeReason ?? "completed");
      const perEntryDelayMs = Math.max(0, Math.min(60000, Number(opts.perEntryDelayMs ?? 0)));

      const usedSkillUuids = [];
      const resolutionLog = [];

      let snapshot = initialSnapshot;
      const queue = initialSnapshot.queue;
      const lastIdx = queue.length - 1;

      console.log(`${TAG} runResolution: begin`, {
        exchangeId,
        queueLen: queue.length,
        perEntryDelayMs,
        usingMockRunners: !!opts.runners,
        firstEntry: queue[0] ? { entryId: queue[0].entryId, skillUuid: queue[0].skillUuid, effectRefs: queue[0].effectRefs } : null
      });

      for (let i = 0; i < queue.length; i++) {
        const entry = queue[i];
        // Refresh snapshot before each entry — the per-entry hook listeners
        // (UI) may read state in between. For step 2 the snapshot doesn't
        // change between entries (we batch markResolved at the end), but
        // we want the hook payload to be accurate.
        const pre = await _preFire(entry, snapshot, runners);
        if (!pre.ok) {
          const logRow = {
            entryId: entry.entryId,
            skillUuid: entry.skillUuid,
            skillName: entry.skillName,
            userId: entry.userId,
            outcome: "fizzled",
            reason: pre.reason
          };
          resolutionLog.push(logRow);
          _fireEntryResolved(exchangeId, entry, logRow, snapshot);
          continue;
        }

        let result;
        try {
          result = await runners.effectRunner(entry, snapshot);
        } catch (e) {
          const logRow = {
            entryId: entry.entryId,
            skillUuid: entry.skillUuid,
            skillName: entry.skillName,
            userId: entry.userId,
            outcome: "errored",
            error: String(e?.message ?? e)
          };
          resolutionLog.push(logRow);
          _fireEntryResolved(exchangeId, entry, logRow, snapshot);
          continue;
        }

        if (result?.ok) {
          usedSkillUuids.push(entry.skillUuid);
          const logRow = {
            entryId: entry.entryId,
            skillUuid: entry.skillUuid,
            skillName: entry.skillName,
            userId: entry.userId,
            outcome: "fired",
            capturedTriggers: Array.isArray(result.capturedTriggers)
              ? result.capturedTriggers
              : []
          };
          resolutionLog.push(logRow);
          _fireEntryResolved(exchangeId, entry, logRow, snapshot);
        } else {
          const logRow = {
            entryId: entry.entryId,
            skillUuid: entry.skillUuid,
            skillName: entry.skillName,
            userId: entry.userId,
            outcome: "errored",
            error: String(result?.error ?? "effect_runner_returned_falsy")
          };
          resolutionLog.push(logRow);
          _fireEntryResolved(exchangeId, entry, logRow, snapshot);
        }

        if (perEntryDelayMs > 0 && i < lastIdx) {
          await new Promise(r => setTimeout(r, perEntryDelayMs));
        }
      }

      // Commit final state to the state machine + close.
      console.log(`${TAG} runResolution: loop complete, committing`, {
        exchangeId,
        usedCount: usedSkillUuids.length,
        logCount: resolutionLog.length
      });
      try {
        exchangeApi.markResolved(exchangeId, { usedSkillUuids, resolutionLog });
      } catch (e) {
        console.error(`${TAG} markResolved threw`, e);
        _activeResolutions.delete(exchangeId);
        throw e;
      } finally {
        _activeResolutions.delete(exchangeId);
      }
      let closedSnapshot;
      try {
        closedSnapshot = exchangeApi.close(exchangeId, closeReason);
      } catch (e) {
        console.error(`${TAG} close threw`, e);
        throw e;
      }
      console.log(`${TAG} runResolution: complete`, { exchangeId, closeReason });

      return {
        ok: true,
        usedSkillUuids,
        resolutionLog,
        closedSnapshot
      };
    }

    function _fireEntryResolved(exchangeId, entry, logRow, snapshot) {
      try {
        Hooks.callAll("oni:exchange:entryResolved", {
          exchangeId,
          entry,
          logRow,
          snapshot
        });
      } catch (e) {
        console.warn(`${TAG} entryResolved hook threw`, e);
      }
    }

    // -------------------------------------------------------------------------
    // Auto-wire (off by default; step 4 turns it on)
    // -------------------------------------------------------------------------

    let _autoResolveHandlerId = null;
    let _autoResolveActive = false;

    function enableAutoResolve() {
      if (_autoResolveActive) return;
      _autoResolveHandlerId = Hooks.on("oni:exchange:resolving", ({ exchangeId }) => {
        // GM-only: only the authoritative client should drive resolution.
        if (!game.user?.isGM) return;
        console.log(`${TAG} auto-resolve: triggered by oni:exchange:resolving`, { exchangeId });
        // Fire-and-forget; resolution failures bubble as console warnings.
        runResolution(exchangeId).catch(e => {
          console.error(`${TAG} auto-resolve threw for exchange ${exchangeId}`, e);
        });
      });
      _autoResolveActive = true;
      console.debug(`${TAG} Auto-resolve enabled.`);
    }

    function disableAutoResolve() {
      if (!_autoResolveActive || _autoResolveHandlerId == null) return;
      try { Hooks.off("oni:exchange:resolving", _autoResolveHandlerId); } catch (_) {}
      _autoResolveHandlerId = null;
      _autoResolveActive = false;
      console.debug(`${TAG} Auto-resolve disabled.`);
    }

    function isAutoResolveEnabled() {
      return _autoResolveActive;
    }

    // -------------------------------------------------------------------------
    // Export
    // -------------------------------------------------------------------------

    const api = {
      runResolution,
      setDefaultRunners,
      getDefaultRunners,
      enableAutoResolve,
      disableAutoResolve,
      isAutoResolveEnabled,
      // In-flight resolution markers — used by the matcher to suppress
      // follow-up Exchange opens during resolution (single-stack-per-phase).
      isResolving,
      isAnyResolving,
      getActiveResolutionIds,
      // Exposed for tests / step 4
      _defaults
    };

    window[KEY] = api;

    globalThis.FUCompanion ??= {};
    globalThis.FUCompanion.api ??= {};
    globalThis.FUCompanion.api.reactionExchangeResolver = api;

    // Production default: auto-resolve enabled on the GM client. Test
    // scenarios (via reaction-exchange-test-helpers.runScenario) disable
    // it for the duration of each scripted run so they can call
    // runResolution deterministically with mock runners.
    if (game.user?.isGM) {
      enableAutoResolve();
    }

    console.debug(`${TAG} Installed (auto-resolve=${_autoResolveActive ? "on" : "off"}).`);
  })();
});
