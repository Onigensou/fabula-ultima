/**
 * [ONI] Reaction Exchange — Test Helpers (Foundry VTT v12)
 * ---------------------------------------------------------------------------
 * Scenario runner that exercises the Reaction Exchange state machine
 * deterministically. Invoked by the test-bridge (`runExchangeScenario`
 * verb); also usable from the F12 console for ad-hoc smoke checks.
 *
 * The runner assumes single-client GM mode — no sockets touched, no
 * real reactor data needed. Eligibility, skills, payloads are all
 * supplied by the scenario directly. Subsequent steps (resolver,
 * matcher integration) will hook in here.
 *
 * Exposed:
 *   - window["oni.ReactionExchangeTest"]
 *   - FUCompanion.api.reactionExchangeTest
 *
 * Scenario shape (informal):
 *   {
 *     reset: true,                            // optional: clear state first
 *     open: {                                 // required
 *       kind: "action_card"|"lifecycle"|"standalone",
 *       boundaryKey: string,
 *       payload: object,
 *       initialTriggers: [{ key, payload? }, ...],
 *       eligibleUserIds: [string, ...]
 *     },
 *     script: [                               // ordered ops
 *       { op: "addEntry",      actor, params }                          // params.userId defaults to actor
 *       { op: "removeEntry",   actor, entryRef: "byId"|"byIndex"|"byUser", entryId?, entryIndex?, entryUserId? }
 *       { op: "reorderEntry",  actor, entryRef, newIndex, ...same selectors }
 *       { op: "setReady",      actor, isReady }
 *       { op: "forceResolve",  actor }
 *       { op: "markResolved",  usedSkillUuids?, resolutionLog? }
 *       { op: "close",         reason? }
 *       { op: "abort",         reason? }
 *       { op: "snapshot",      label? }                                 // captures state into log
 *       { op: "expect",        path, value }                            // strict-equals assertion
 *       { op: "expectThrows",  inner: <op-object> }                     // wraps any op; passes when it throws
 *     ],
 *     expectations: {                         // optional final-state checks
 *       finalStatus: "queueing"|"resolving"|"closed",
 *       queueSize: number,
 *       usedSkillUuids: string[]
 *     }
 *   }
 *
 * Result shape:
 *   {
 *     ok: boolean,
 *     exchangeId: string | null,
 *     finalSnapshot: object | null,
 *     log: [{ stepIndex, op, ok, error?, snapshot?, captured?, ... }, ...],
 *     failedStep: number | null,
 *     failures: string[]
 *   }
 * ---------------------------------------------------------------------------
 */

Hooks.once("ready", () => {
  (() => {
    const KEY = "oni.ReactionExchangeTest";
    if (window[KEY]) {
      console.debug("[ReactionExchangeTest] Already installed.");
      return;
    }

    const TAG = "[ReactionExchangeTest]";
    const exchangeApi = window["oni.ReactionExchange"];
    if (!exchangeApi) {
      console.error(`${TAG} oni.ReactionExchange not loaded.`);
      return;
    }
    // Optional: resolver may or may not be installed (load order varies
    // during step 1 vs step 2). Look up lazily at op invocation time.
    function _resolverApi() {
      return window["oni.ReactionExchangeResolver"] ?? null;
    }

    /**
     * Build runner overrides from a declarative mockOutcomes map.
     *
     * mockOutcomes is keyed by skillUuid; values:
     *   "fire"               — pass all checks; effect fires successfully
     *   "fizzle:trigger"     — triggerRechecker returns false
     *   "fizzle:capability"  — capabilityChecker returns false
     *   "fizzle:cost"        — costChecker returns false
     *   "throw:effect"       — effect runner throws
     *   "error:effect"       — effect runner returns { ok: false, error }
     *
     * Skills not listed in mockOutcomes use the resolver's defaults.
     */
    function _buildRunnerOverrides(mockOutcomes) {
      if (!mockOutcomes || typeof mockOutcomes !== "object") return {};
      const outcomes = { ...mockOutcomes };
      function _get(entry) { return outcomes[entry.skillUuid] ?? null; }
      return {
        triggerRechecker: async (entry) => {
          const o = _get(entry);
          if (o === "fizzle:trigger") return { ok: false, reason: "trigger_no_longer_matches" };
          return { ok: true };
        },
        capabilityChecker: async (entry) => {
          const o = _get(entry);
          if (o === "fizzle:capability") return { ok: false, reason: "reactor_incapacitated" };
          return { ok: true };
        },
        costChecker: async (entry) => {
          const o = _get(entry);
          if (o === "fizzle:cost") return { ok: false, reason: "cost_cannot_pay" };
          return { ok: true };
        },
        effectRunner: async (entry) => {
          const o = _get(entry);
          if (o === "throw:effect") throw new Error("mock_effect_threw");
          if (o === "error:effect") return { ok: false, error: "mock_effect_errored" };
          return { ok: true, capturedTriggers: [] };
        }
      };
    }

    function _clone(v) {
      if (foundry?.utils?.deepClone) return foundry.utils.deepClone(v);
      return JSON.parse(JSON.stringify(v));
    }

    /** Resolve a property path like "queue.0.userId" against an object. */
    function _readPath(obj, path) {
      if (!path) return undefined;
      const parts = String(path).split(".");
      let cur = obj;
      for (const p of parts) {
        if (cur == null) return undefined;
        cur = cur[p];
      }
      return cur;
    }

    function _resolveEntryId(snapshot, step) {
      const ref = step.entryRef ?? "byId";
      switch (ref) {
        case "byId":
          if (!step.entryId) throw new Error(`entryRef=byId requires entryId`);
          return step.entryId;
        case "byIndex": {
          const idx = Number(step.entryIndex);
          if (!Number.isInteger(idx)) throw new Error(`entryRef=byIndex requires integer entryIndex`);
          const e = snapshot.queue[idx];
          if (!e) throw new Error(`no entry at index ${idx}`);
          return e.entryId;
        }
        case "byUser": {
          if (!step.entryUserId) throw new Error(`entryRef=byUser requires entryUserId`);
          const e = snapshot.queue.find(x => x.userId === step.entryUserId);
          if (!e) throw new Error(`no entry for userId ${step.entryUserId}`);
          return e.entryId;
        }
        default:
          throw new Error(`unknown entryRef "${ref}"`);
      }
    }

    async function _runStep(state, step) {
      const { op } = step;
      const exchangeId = state.exchangeId;

      switch (op) {
        case "addEntry": {
          const params = { ...(step.params ?? {}) };
          if (!params.userId) params.userId = step.actor;
          const entryId = exchangeApi.addEntry(exchangeId, params, step.actor ?? null);
          return { entryId };
        }
        case "removeEntry": {
          const snap = exchangeApi.snapshot(exchangeId);
          const entryId = _resolveEntryId(snap, step);
          exchangeApi.removeEntry(exchangeId, entryId, step.actor ?? null);
          return { entryId };
        }
        case "reorderEntry": {
          const snap = exchangeApi.snapshot(exchangeId);
          const entryId = _resolveEntryId(snap, step);
          exchangeApi.reorderEntry(exchangeId, entryId, step.newIndex, step.actor ?? null);
          return { entryId, newIndex: step.newIndex };
        }
        case "setReady": {
          exchangeApi.setReady(exchangeId, step.actor, !!step.isReady, step.actor ?? null);
          return { actor: step.actor, isReady: !!step.isReady };
        }
        case "forceResolve": {
          exchangeApi.forceResolve(exchangeId, step.actor ?? null);
          return { actor: step.actor };
        }
        case "markResolved": {
          exchangeApi.markResolved(exchangeId, {
            usedSkillUuids: step.usedSkillUuids ?? [],
            resolutionLog: step.resolutionLog ?? []
          });
          return null;
        }
        case "close": {
          const closedSnap = exchangeApi.close(exchangeId, step.reason ?? "completed");
          return { reason: step.reason ?? "completed", __closedSnapshot: closedSnap };
        }
        case "abort": {
          const closedSnap = exchangeApi.abort(exchangeId, step.reason ?? "aborted");
          return { reason: step.reason ?? "aborted", __closedSnapshot: closedSnap };
        }
        case "snapshot": {
          const snap = exchangeApi.snapshot(exchangeId);
          return { captured: snap, label: step.label ?? null };
        }
        case "expect": {
          const snap = exchangeApi.snapshot(exchangeId);
          const actual = _readPath(snap, step.path);
          const eq = JSON.stringify(actual) === JSON.stringify(step.value);
          if (!eq) {
            throw new Error(
              `expect failed: path="${step.path}" actual=${JSON.stringify(actual)} ` +
              `expected=${JSON.stringify(step.value)}`
            );
          }
          return { path: step.path, actual };
        }
        case "expectThrows": {
          const inner = step.inner;
          if (!inner) throw new Error("expectThrows requires inner step");
          let threw = false;
          let captured = null;
          try {
            await _runStep(state, inner);
          } catch (e) {
            threw = true;
            captured = String(e?.message ?? e);
          }
          if (!threw) {
            throw new Error(`expectThrows: inner op "${inner.op}" did not throw`);
          }
          return { innerOp: inner.op, captured };
        }
        case "runResolution": {
          const resolver = _resolverApi();
          if (!resolver) throw new Error("oni.ReactionExchangeResolver not loaded");
          const runners = _buildRunnerOverrides(step.mockOutcomes);
          const result = await resolver.runResolution(exchangeId, {
            runners,
            closeReason: step.closeReason ?? "completed",
            perEntryDelayMs: Number(step.perEntryDelayMs ?? 0)
          });
          // close() runs inside runResolution; the closed snapshot comes
          // back so we can echo it into snapshotAfter via the same
          // __closedSnapshot convention used by op:"close".
          return {
            usedSkillUuids: result.usedSkillUuids,
            resolutionLog: result.resolutionLog,
            __closedSnapshot: result.closedSnapshot
          };
        }
        case "setCandidates": {
          exchangeApi.setCandidates(
            exchangeId,
            step.userId,
            step.candidates ?? [],
            step.actor ?? null
          );
          return { userId: step.userId, count: (step.candidates ?? []).length };
        }
        case "wait": {
          // Useful for visual smoke scenarios — let the user see a state
          // between mutations.
          const ms = Math.max(0, Math.min(60000, Number(step.ms ?? 500)));
          await new Promise(r => setTimeout(r, ms));
          return { ms };
        }
        default:
          throw new Error(`unknown op "${op}"`);
      }
    }

    function _checkFinalExpectations(snapshot, expectations) {
      const failures = [];
      if (!expectations || typeof expectations !== "object") return failures;
      if (expectations.finalStatus != null && snapshot?.status !== expectations.finalStatus) {
        failures.push(`finalStatus: expected "${expectations.finalStatus}", got "${snapshot?.status}"`);
      }
      if (expectations.queueSize != null && (snapshot?.queue?.length ?? -1) !== expectations.queueSize) {
        failures.push(`queueSize: expected ${expectations.queueSize}, got ${snapshot?.queue?.length}`);
      }
      if (Array.isArray(expectations.usedSkillUuids)) {
        const got = snapshot?.usedSkillUuids ?? [];
        const expected = expectations.usedSkillUuids;
        if (JSON.stringify([...got].sort()) !== JSON.stringify([...expected].sort())) {
          failures.push(
            `usedSkillUuids: expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`
          );
        }
      }
      return failures;
    }

    /**
     * Run a scenario. Returns a result object suitable for JSON
     * serialization (no live state references). Returns a Promise
     * because runResolution is async; the bridge dispatch awaits it.
     */
    async function runScenario(scenario) {
      if (!scenario || typeof scenario !== "object") {
        return { ok: false, failures: ["scenario must be an object"], log: [], failedStep: null };
      }

      const log = [];
      let exchangeId = null;
      let failedStep = null;
      const failures = [];

      // Suspend auto-resolve for the duration of the scenario so the
      // runResolution op fires deterministically with the supplied mock
      // runners. Auto-resolve fires on `oni:exchange:resolving` with the
      // default (real-actor) runners which would explode on the fake
      // skillUuids / tokenIds the scenarios use.
      const resolver = _resolverApi();
      const autoResolveWas = !!resolver?.isAutoResolveEnabled?.();
      if (autoResolveWas) {
        try { resolver.disableAutoResolve(); } catch (_) {}
      }

      try {
        if (scenario.reset) exchangeApi._testReset();

        if (!scenario.open || typeof scenario.open !== "object") {
          throw new Error("scenario.open required");
        }
        const openSnap = exchangeApi.open(scenario.open);
        if (!openSnap?.exchangeId) throw new Error("open did not return an exchange");
        exchangeId = openSnap.exchangeId;
        log.push({ stepIndex: -1, op: "open", ok: true, snapshot: openSnap });

        const state = { exchangeId };
        const script = Array.isArray(scenario.script) ? scenario.script : [];

        for (let i = 0; i < script.length; i++) {
          const step = script[i];
          try {
            const result = await _runStep(state, step);
            // close / abort / runResolution return the final snapshot via
            // __closedSnapshot because exchangeApi.snapshot() returns null
            // once the exchange is GC'd from the active map.
            const closedSnap = result?.__closedSnapshot ?? null;
            const cleanResult = result ? { ...result } : {};
            delete cleanResult.__closedSnapshot;
            log.push({
              stepIndex: i,
              op: step.op,
              ok: true,
              ...cleanResult,
              snapshotAfter: exchangeApi.snapshot(exchangeId) ?? closedSnap
            });
          } catch (e) {
            failedStep = i;
            failures.push(`step ${i} (${step.op}): ${String(e?.message ?? e)}`);
            log.push({
              stepIndex: i,
              op: step.op,
              ok: false,
              error: String(e?.message ?? e),
              snapshotAfter: exchangeApi.snapshot(exchangeId)
            });
            break;
          }
        }
      } catch (e) {
        failures.push(`setup: ${String(e?.message ?? e)}`);
      } finally {
        if (autoResolveWas && resolver?.enableAutoResolve) {
          try { resolver.enableAutoResolve(); } catch (_) {}
        }
      }

      const finalSnapshot = exchangeId ? exchangeApi.snapshot(exchangeId) : null;

      // If the exchange has been closed, the state machine's `snapshot()`
      // returns null because the entry is GC'd from the active map. Pull
      // the last in-log snapshot instead so callers see the closed state.
      const lastLoggedSnapshot = (() => {
        for (let i = log.length - 1; i >= 0; i--) {
          if (log[i].snapshotAfter) return log[i].snapshotAfter;
          if (log[i].snapshot) return log[i].snapshot;
        }
        return null;
      })();

      const effectiveFinalSnapshot = finalSnapshot ?? lastLoggedSnapshot;

      if (failedStep == null) {
        const expFails = _checkFinalExpectations(effectiveFinalSnapshot, scenario.expectations);
        for (const f of expFails) failures.push(`expectation: ${f}`);
      }

      return {
        ok: failures.length === 0,
        exchangeId,
        finalSnapshot: effectiveFinalSnapshot,
        log,
        failedStep,
        failures
      };
    }

    const api = { runScenario };
    window[KEY] = api;

    globalThis.FUCompanion ??= {};
    globalThis.FUCompanion.api ??= {};
    globalThis.FUCompanion.api.reactionExchangeTest = api;

    console.debug(`${TAG} Installed.`);
  })();
});
