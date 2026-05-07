// ============================================================================
// BattleEnd — Manager (Foundry VTT v12)
// ----------------------------------------------------------------------------
// Purpose:
// - Orchestrate the BattleEnd pipeline in a single run
// - Calls each step macro in order
// - Waits until each step writes its completion marker into the canonical payload
// - Stops early if any step blocks / errors
//
// Pipeline order:
//   1) Prompt
//   2) Gate
//   3) FX
//   4) SummaryLogic   (Victory only)
//   5) SummaryUI      (Victory only; includes a grace wait for animation)
//   6) Transition
//   7) Cleanup
//   8) Camera Reset   (final; resets stored battle-scene view position for all clients)
//
// Notes:
// - GM-only.
// - Canonical payload lives on SOURCE scene flag:
//     scope="world", key="battleInit.latestPayload"
// - We locate the canonical payload by matching payload.step4.battleScene.id
//   against the current active scene (battle scene), then fallback to "latest".
// ============================================================================

(async () => {
  const DEBUG = false;

  // -----------------------------
  // Canonical payload storage
  // -----------------------------
  const PAYLOAD_SCOPE = "world";
  const PAYLOAD_KEY = "battleInit.latestPayload";

  // -----------------------------
  // Macro names must match your macro list exactly
  // (edit these if your macro names differ)
  // -----------------------------
 const MACRO_NAMES = {
    prompt: "[BattleEnd: Prompt]",
    gate: "[BattleEnd: Gate]",
    fx: "[BattleEnd: FX]",
    summaryLogic: "[BattleEnd: SummaryLogic]",
    rankComputation: "[BattleEnd: RankComputation]",
    summaryUI: "[BattleEnd: SummaryUI]",
    transition: "[BattleEnd: Transition]",
    cameraReset: "[BattleEnd: CameraReset]",
    cleanup: "[BattleEnd: Cleanup]",
    resetResource: "[BattleEnd: ResetResource]"
  };

  // -----------------------------
  // Manager behavior tuning
  // -----------------------------
  const POLL_MS = 200;
  const STEP_TIMEOUT_MS = 60_000; // per step
  const SHOW_STEP_TOASTS = false; // "silent step toast" vibe: console logs only
  const SUMMARYUI_MIN_TOTAL_MS = 9000; // ensure SummaryUI has time to play on players before Transition

  const tag = "[BattleEnd:Manager]";
  const log = (...a) => DEBUG && console.log(tag, ...a);
  const warn = (...a) => console.warn(tag, ...a);
  const error = (...a) => console.error(tag, ...a);

  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const nowIso = () => new Date().toISOString();

  // -----------------------------
  // Guards
  // -----------------------------
  if (!game.user?.isGM) {
    ui.notifications?.warn?.("BattleEnd Manager: GM only.");
    return;
  }
  if (!canvas?.scene) {
    ui.notifications?.error?.("BattleEnd Manager: No active scene.");
    return;
  }

  // -----------------------------
  // Helpers: time + payload locate
  // -----------------------------
  function parseIsoToMs(iso) {
    const t = Date.parse(String(iso ?? ""));
    return Number.isFinite(t) ? t : 0;
  }

  function deepClone(x) {
    return foundry.utils.deepClone(x);
  }

  async function waitForCanvasNotLoading(timeoutMs = 15_000) {
    const t0 = Date.now();
    while (canvas.loading) {
      if ((Date.now() - t0) > timeoutMs) {
        warn("waitForCanvasNotLoading timed out; continuing anyway.");
        return false;
      }
      await wait(50);
    }
    return true;
  }

  async function ensureActiveScene(sceneId) {
    if (!sceneId) return false;

    if (canvas.scene?.id === sceneId) {
      await waitForCanvasNotLoading();
      return true;
    }

    const s = game.scenes?.get(sceneId);
    if (!s) return false;

    await waitForCanvasNotLoading();

    try {
      await s.activate();
    } catch (e) {
      warn("Scene activate failed (continuing):", e);
    }

    await wait(250);
    await waitForCanvasNotLoading();
    return canvas.scene?.id === sceneId;
  }

  function pickLatestPayloadAcrossScenes() {
    let best = null;

    for (const s of (game.scenes?.contents ?? [])) {
      const p = s.getFlag(PAYLOAD_SCOPE, PAYLOAD_KEY);
      if (!p) continue;

      const createdAtMs =
        parseIsoToMs(p?.meta?.createdAt) ||
        Number(p?.step4?.transitionedAt ?? 0) ||
        0;

      if (!best || createdAtMs > best.createdAtMs) {
        best = { scene: s, payload: p, createdAtMs };
      }
    }
    return best;
  }

  // Locate canonical payload for THIS battle scene:
  // - Prefer payload where payload.step4.battleScene.id === canvas.scene.id
  // - Fallback to "latest payload anywhere"
  function locateSourceSceneAndPayloadForThisBattle() {
    const activeBattleSceneId = canvas.scene?.id;

    let bestMatch = null;
    let bestMatchMs = 0;

    for (const s of (game.scenes?.contents ?? [])) {
      const p = s.getFlag(PAYLOAD_SCOPE, PAYLOAD_KEY);
      if (!p) continue;

      const battleSceneIdInPayload = p?.step4?.battleScene?.id ?? null;
      if (battleSceneIdInPayload && activeBattleSceneId && battleSceneIdInPayload === activeBattleSceneId) {
        const ms =
          parseIsoToMs(p?.meta?.createdAt) ||
          Number(p?.step4?.transitionedAt ?? 0) ||
          0;

        if (!bestMatch || ms > bestMatchMs) {
          bestMatch = { sourceScene: s, payload: p, from: "scene-scan-match-step4.battleScene.id" };
          bestMatchMs = ms;
        }
      }
    }

    if (bestMatch) return bestMatch;

    // Fallback: newest across all scenes
    const best = pickLatestPayloadAcrossScenes();
    if (best) return { sourceScene: best.scene, payload: best.payload, from: "scene-scan-latest" };

    return null;
  }

  async function readPayload(sourceScene) {
    return sourceScene.getFlag(PAYLOAD_SCOPE, PAYLOAD_KEY);
  }

  async function writePayload(sourceScene, payload) {
    await sourceScene.setFlag(PAYLOAD_SCOPE, PAYLOAD_KEY, payload);
  }

  function getMacroByNameOrNull(name) {
    return game.macros?.getName?.(name) ?? null;
  }

  async function runMacroByName(name) {
    const m = getMacroByNameOrNull(name);
    if (!m) throw new Error(`Macro not found: "${name}"`);
    return await m.execute();
  }

  // -----------------------------
  // Step completion markers (BattleEnd)
  // Each step must write payload.phases.battleEnd.<stepId>.status and .at (ISO)
  // Fallbacks are included for Prompt/Cleanup
  // -----------------------------
  function stepMarker(payload, stepId) {
    if (!payload) return { status: "missing", atMs: 0, details: null };

    const be = payload?.phases?.battleEnd ?? {};
    const getPh = (k) => be?.[k] ?? null;

    if (stepId === "prompt") {
      const ph = getPh("prompt");
      if (ph?.status) return { status: String(ph.status), atMs: parseIsoToMs(ph.at), details: ph };

      // Fallback: Prompt confirmed data exists
      const confirmedAt =
        payload?.battleEnd?.meta?.confirmedAt ??
        payload?.battleEnd?.prompt?.confirmedAt ??
        payload?.battleEnd?.prompt?.at ??
        null;

      const ok = !!payload?.battleEnd?.prompt && !!confirmedAt;
      return { status: ok ? "ok" : "missing", atMs: parseIsoToMs(confirmedAt), details: payload?.battleEnd?.prompt ?? null };
    }

    if (stepId === "gate") {
      const ph = getPh("gate");
      return { status: String(ph?.status ?? "missing"), atMs: parseIsoToMs(ph?.at), details: ph };
    }

    if (stepId === "fx") {
      const ph = getPh("fx");
      return { status: String(ph?.status ?? "missing"), atMs: parseIsoToMs(ph?.at), details: ph };
    }

    if (stepId === "summaryLogic") {
      const ph = getPh("summaryLogic");
      return { status: String(ph?.status ?? "missing"), atMs: parseIsoToMs(ph?.at), details: ph };
    }

    if (stepId === "rankComputation") {
      const ph = getPh("rankComputation");
      return { status: String(ph?.status ?? "missing"), atMs: parseIsoToMs(ph?.at), details: ph };
    }


    if (stepId === "summaryUI") {
      const ph = getPh("summaryUI");
      return { status: String(ph?.status ?? "missing"), atMs: parseIsoToMs(ph?.at), details: ph };
    }

    if (stepId === "transition") {
      const ph = getPh("transition");
      return { status: String(ph?.status ?? "missing"), atMs: parseIsoToMs(ph?.at), details: ph };
    }

    if (stepId === "cleanup") {
      // Cleanup clears the flag. Completion is: canonical payload is gone.
      // We'll represent that as status="cleared".
      return { status: "waiting", atMs: 0, details: null };
    }

    if (stepId === "cameraReset") {
      const ph = getPh("cameraReset");
      return { status: String(ph?.status ?? "ok"), atMs: parseIsoToMs(ph?.at) || Date.now(), details: ph };
    }

    return { status: "missing", atMs: 0, details: null };
  }

  function isBlockingStatus(stepId, status) {
    const s = String(status ?? "").toLowerCase();
    if (s === "blocked") return true;
    if (s === "missing") return true;
    if (s === "timeout") return true;

    // Acceptable "ok" only (for these steps)
    return (s !== "ok");
  }

  function getBattleEndMode(payload) {
    return String(payload?.battleEnd?.meta?.mode ?? "").toLowerCase();
  }

    function extractPartyActorIds(payload) {
    const ids = [];

    const partyMembers = payload?.party?.members;
    if (Array.isArray(partyMembers)) {
      for (const m of partyMembers) {
        const id =
          m?.actorId ??
          m?.id ??
          m?.actor_id ??
          "";

        if (id) ids.push(String(id));
      }
    }

    const partyActorIds = payload?.partyActorIds;
    if (Array.isArray(partyActorIds)) {
      for (const id of partyActorIds) {
        if (id) ids.push(String(id));
      }
    }

    const contextPartyActorIds = payload?.context?.partyActorIds;
    if (Array.isArray(contextPartyActorIds)) {
      for (const id of contextPartyActorIds) {
        if (id) ids.push(String(id));
      }
    }

    return [...new Set(ids.map(x => String(x ?? "").trim()).filter(Boolean))];
  }

  async function waitForStepCompletion(sourceScene, stepId, startedAtMs) {
    const t0 = Date.now();

    while (true) {
      const p = await readPayload(sourceScene);

      // Special completion logic: Cleanup clears payload flag
      if (stepId === "cleanup") {
        const gone = !p;
        if (gone && Date.now() >= startedAtMs) {
          return { ok: true, payload: null, mark: { status: "cleared", atMs: Date.now(), details: null } };
        }
      }

      const mark = stepMarker(p, stepId);
      const isAfterStart = (mark.atMs && mark.atMs >= startedAtMs);

      if (DEBUG) log(`Polling step="${stepId}"`, { status: mark.status, atMs: mark.atMs, isAfterStart });

      if (isAfterStart) {
        const st = String(mark.status ?? "").toLowerCase();
        if (st === "blocked" || st === "cancelled" || st === "canceled") return { ok: false, payload: p, mark };
        if (st === "ok") return { ok: true, payload: p, mark };
      }

      if ((Date.now() - t0) > STEP_TIMEOUT_MS) {
        return { ok: false, payload: p, mark: { status: "timeout", atMs: 0, details: null } };
      }

      await wait(POLL_MS);
    }
  }

  // -----------------------------
  // Start: locate canonical payload
  // -----------------------------
  const found = locateSourceSceneAndPayloadForThisBattle();
  if (!found) {
    ui.notifications?.error?.("BattleEnd Manager: No canonical payload found. (Did BattleInit run?)");
    return;
  }

  let { sourceScene, payload, from } = found;

  const runId = `bend_mgr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // Cache battle scene id + party actor ids early.
  // Cleanup clears the canonical payload flag, so later steps need this cached data.
  let cachedBattleSceneId = payload?.step4?.battleScene?.id ?? payload?.context?.battleSceneId ?? null;
  let cachedPartyActorIds = extractPartyActorIds(payload);

  const battleId = String(payload?.meta?.battleId ?? "(no battleId)");
    log("START", { runId, battleId, from, sourceScene: { id: sourceScene.id, name: sourceScene.name } });

  // (Removed: info toast)

  // Stamp manager state into payload (so you can inspect it later before Cleanup clears)
  payload = deepClone(payload);
  payload.battleEnd ??= {};
  payload.battleEnd.manager ??= {};
  payload.battleEnd.manager.runId = runId;
  payload.battleEnd.manager.startedAt = nowIso();
  payload.battleEnd.manager.status = "running";
  payload.battleEnd.manager.from = from;
  payload.battleEnd.manager.steps ??= {};
  await writePayload(sourceScene, payload);

  // -----------------------------
  // Define pipeline
  // wantsScene:
  //   - "battle": ensure we are on the battle scene before running
  //   - "any": do not force a scene
  // -----------------------------
  const steps = [
    { id: "prompt",      name: "Prompt",       macroName: MACRO_NAMES.prompt,      wantsScene: "battle" },
    { id: "gate",        name: "Gate",         macroName: MACRO_NAMES.gate,        wantsScene: "battle" },
    { id: "fx",          name: "FX",           macroName: MACRO_NAMES.fx,          wantsScene: "battle" },

    // Victory-only
    { id: "summaryLogic", name: "SummaryLogic", macroName: MACRO_NAMES.summaryLogic, wantsScene: "battle",
      conditional: (p) => getBattleEndMode(p) !== "defeat"
    },
        { id: "rankComputation", name: "RankComputation", macroName: MACRO_NAMES.rankComputation, wantsScene: "battle",
      conditional: (p) => getBattleEndMode(p) !== "defeat"
    },

    { id: "summaryUI",    name: "SummaryUI",    macroName: MACRO_NAMES.summaryUI,    wantsScene: "battle",
      conditional: (p) => getBattleEndMode(p) !== "defeat",
      // If the GM client didn't render locally, this delay keeps players on the battle scene long enough.
      // If the GM DID render locally, elapsed time will already exceed the minimum, so the delay becomes 0.
      afterRunDelayMs: ({ stepStartMs }) => Math.max(0, SUMMARYUI_MIN_TOTAL_MS - (Date.now() - stepStartMs))
    },

    { id: "transition",  name: "Transition",   macroName: MACRO_NAMES.transition,  wantsScene: "battle" },

    // Reset battle scene camera memory on all clients (fire-and-forget; socket broadcast)
    { id: "cameraReset", name: "Camera Reset", macroName: MACRO_NAMES.cameraReset, wantsScene: "any", waitForMarker: false },

    // Cleanup can run on any scene (it resolves battle scene from payload)
    { id: "cleanup",     name: "Cleanup",      macroName: MACRO_NAMES.cleanup,     wantsScene: "any" },

    // Reset battle-only class resources after Cleanup clears the battle payload.
    // This uses cached party actor IDs injected through __PAYLOAD.
    { id: "resetResource", name: "Reset Resource", macroName: MACRO_NAMES.resetResource, wantsScene: "any", waitForMarker: false, allowMissingPayload: true }
  ];

  // -----------------------------
  // Run pipeline
  // -----------------------------
  try {
    for (const step of steps) {
      // Refresh payload each step (except cleanup which clears it)
      const p0 = await readPayload(sourceScene);
      if (!p0 && step.id !== "cleanup" && !step.allowMissingPayload) throw new Error("Payload disappeared (flag missing).");

      // Keep battle scene id + party actor ids cached while payload still exists.
      if (p0) {
        cachedBattleSceneId = cachedBattleSceneId ?? (p0?.step4?.battleScene?.id ?? p0?.context?.battleSceneId ?? null);

        const idsNow = extractPartyActorIds(p0);
        if (idsNow.length) cachedPartyActorIds = idsNow;
      }

      // Conditional skip
      if (typeof step.conditional === "function" && p0) {
        const shouldRun = step.conditional(p0);
        if (!shouldRun) {
          log(`SKIP step="${step.id}" (${step.name}) due to mode/options.`);
          const pSkip = deepClone(p0);
          pSkip.battleEnd ??= {};
          pSkip.battleEnd.manager ??= {};
          pSkip.battleEnd.manager.steps ??= {};
          pSkip.battleEnd.manager.steps[step.id] = {
            status: "skipped",
            at: nowIso(),
            reason: "Disabled by mode/options",
            macroName: step.macroName
          };
          await writePayload(sourceScene, pSkip);
          continue;
        }
      }

      // Ensure scene if requested
      if (step.wantsScene === "battle") {
        const battleSceneId =
          p0?.step4?.battleScene?.id ??
          p0?.context?.battleSceneId ??
          null;

        if (!battleSceneId) {
          throw new Error(`Step "${step.id}" requires battle scene, but payload has no battleSceneId.`);
        }
        await ensureActiveScene(battleSceneId);
      } else if (step.wantsScene === "any") {
        // no-op
      }

      // Mark step start
      const stepStartMs = Date.now();
      const p1 = step.id === "cleanup" ? (await readPayload(sourceScene)) : deepClone(await readPayload(sourceScene));
      if (p1) {
        p1.battleEnd ??= {};
        p1.battleEnd.manager ??= {};
        p1.battleEnd.manager.currentStep = step.id;
        p1.battleEnd.manager.currentStepName = step.name;
        p1.battleEnd.manager.steps ??= {};
        p1.battleEnd.manager.steps[step.id] = {
          status: "running",
          at: nowIso(),
          startedAtMs: stepStartMs,
          macroName: step.macroName
        };
        await writePayload(sourceScene, p1);
      }

      log(`RUN step="${step.id}" macro="${step.macroName}"`);

      // Execute step macro

      // For CameraReset, inject minimal context so the macro can still find the battle scene.
      if (step.id === "cameraReset") {
        globalThis.__PAYLOAD = {
          meta: { battleId },
          battleEnd: { meta: { runId } },
          step4: { battleScene: { id: cachedBattleSceneId } }
        };
      }

      // For ResetResource, Cleanup may already have erased the canonical payload.
      // So we inject the cached party actor IDs directly.
      if (step.id === "resetResource") {
        globalThis.__PAYLOAD = {
          meta: { battleId },
          battleEnd: { meta: { runId } },
          resetResource: {
            actorIds: cachedPartyActorIds
          }
        };

        log("Injected ResetResource payload.", {
          actorIds: cachedPartyActorIds,
          battleId
        });
      }

      await runMacroByName(step.macroName);

           // Optional delay after running (SummaryUI animation grace)
      // - Supports number OR a function that returns a number.
      let postDelayMs = 0;
      if (typeof step.afterRunDelayMs === "function") {
        try {
          postDelayMs = Number(step.afterRunDelayMs({ stepStartMs, stepId: step.id, stepName: step.name }));
        } catch (e) {
          warn("afterRunDelayMs function failed; ignoring delay.", e);
          postDelayMs = 0;
        }
      } else {
        postDelayMs = Number(step.afterRunDelayMs ?? 0);
      }

      if (Number.isFinite(postDelayMs) && postDelayMs > 0) {
        log(`Post-step delay step="${step.id}" ms=${postDelayMs}`);
        await wait(postDelayMs);
      }

     // Wait for completion marker (unless this step is fire-and-forget)
let done;
if (step.waitForMarker === false) {
  done = {
    ok: true,
    mark: { status: "ok", atMs: Date.now(), details: { via: "manager-fire-and-forget" } }
  };
} else {
  done = await waitForStepCompletion(sourceScene, step.id, stepStartMs);
}

      // Record step end (if payload still exists)
      const p2 = await readPayload(sourceScene);
      if (p2) {
        const pEndStep = deepClone(p2);
        pEndStep.battleEnd ??= {};
        pEndStep.battleEnd.manager ??= {};
        pEndStep.battleEnd.manager.steps ??= {};
        pEndStep.battleEnd.manager.steps[step.id] = {
          ...(pEndStep.battleEnd.manager.steps[step.id] ?? {}),
          status: done.ok ? "ok" : "blocked",
          finishedAt: nowIso(),
          stepMarker: done.mark
        };
        await writePayload(sourceScene, pEndStep);
      }

      if (!done.ok) {
        if (!SHOW_STEP_TOASTS) ui.notifications?.error?.(`BattleEnd: BLOCKED at ${step.name}.`);
        warn("BLOCKED", { step: step.id, mark: done.mark });

        // Best-effort store final manager status (if payload still exists)
        const pStop = await readPayload(sourceScene);
        if (pStop) {
          const pStopped = deepClone(pStop);
          pStopped.battleEnd ??= {};
          pStopped.battleEnd.manager ??= {};
          pStopped.battleEnd.manager.status = "blocked";
          pStopped.battleEnd.manager.stoppedAt = nowIso();
          await writePayload(sourceScene, pStopped);
        }

        return;
      }

      log(`DONE step="${step.id}"`, done.mark);
    }

    // If we reached here, the pipeline ran to the end.
    log("COMPLETE", { runId, battleId });

  } catch (e) {
    error("Manager failed:", e);
    ui.notifications?.error?.(`BattleEnd Manager: FAILED — ${e?.message ?? String(e)}`);

    // Best-effort store failure (if payload still exists)
    try {
      const pFail = await readPayload(sourceScene);
      if (pFail) {
        const pF = deepClone(pFail);
        pF.battleEnd ??= {};
        pF.battleEnd.manager ??= {};
        pF.battleEnd.manager.status = "failed";
        pF.battleEnd.manager.failedAt = nowIso();
        pF.battleEnd.manager.error = { message: e?.message ?? String(e), stack: e?.stack ?? null };
        await writePayload(sourceScene, pF);
      }
    } catch (_) {}
  }
})();
