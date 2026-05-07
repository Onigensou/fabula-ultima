// ============================================================================
// BattleInit — BattleInit Manager (Foundry VTT v12)
// ----------------------------------------------------------------------------
// Purpose:
// - Orchestrate the BattleInit pipeline in a single run
// - Calls each step macro in order
// - Waits until each step writes its completion marker into the payload
// - Stops early if any step blocks
//
// Pipeline order:
//   Step2 Gate
//   Step3 Resolver
//   Step4 Transition
//   Step5a Layout Engine
//   Step5b Spawner
//   Step6 Initiator
//   Step7 Unleash Detector
//   Step8 Battle Record Writer
//
// Notes:
// - This manager treats "payload.phases.*" (and step4 data) as the step "report back".
// - It is GM-only.
// ============================================================================

(async () => {
  const DEBUG = false;

  const PAYLOAD_SCOPE = "world";
  const PAYLOAD_KEY = "battleInit.latestPayload";

  

  // Prompt session marker (written by BattleInit Prompt even when payload is not created)
  const PROMPT_MARKER_KEY = "battleInit.promptMarker";
// Macro names must match your macro list exactly
  const MACRO_NAMES = {
  prompt: "BattleInit — Battle Prompt",
  gate: "BattleInit — Battle Gate",
  resolver: "BattleInit — Encounter Resolver",
  transition: "BattleInit — Battle Transition",
  layout: "BattleInit — Layout Engine",
  spawner: "BattleInit — Encounter Spawner",
  entrance: "BattleInit — Entrance Animation",
  initiator: "BattleInit — Battle Initiator",
  unleash: "BattleInit — Unleash Detector",
  record: "BattleInit — Battle Record Writer"
};

  const tag = "[BattleInit:Manager]";
  const log = (...a) => DEBUG && console.log(tag, ...a);
  const warn = (...a) => console.warn(tag, ...a);
  const error = (...a) => console.error(tag, ...a);

  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const nowIso = () => new Date().toISOString();

  // Polling controls
  const POLL_MS = 200;
  const STEP_TIMEOUT_MS = 60_000; // 60s per step (safe default)
  const PROMPT_TIMEOUT_MS = 10 * 60_000; // 10 minutes for GM to confirm the Prompt

  // -----------------------------
  // Guards
  // -----------------------------
  if (!game.user?.isGM) {
    ui.notifications?.warn?.("BattleInit Manager: GM only.");
    return;
  }
  if (!canvas?.scene) {
    ui.notifications?.error?.("BattleInit Manager: No active scene.");
    return;
  }

  // -----------------------------
  // Helpers: scene + payload location
  // -----------------------------
  function parseIsoToMs(iso) {
    const t = Date.parse(String(iso ?? ""));
    return Number.isFinite(t) ? t : 0;
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
    return best; // can be null
  }

  // Prefer the "latest payload" that the Prompt stored in window
  function locateSourceSceneAndPayload() {
    const hinted = globalThis.__BATTLEINIT_PAYLOAD_LATEST;
    const hintedId = hinted?.meta?.battleId ? String(hinted.meta.battleId) : "";

    if (hintedId) {
      for (const s of (game.scenes?.contents ?? [])) {
        const p = s.getFlag(PAYLOAD_SCOPE, PAYLOAD_KEY);
        if (!p) continue;
        if (String(p?.meta?.battleId ?? "") === hintedId) {
          return { sourceScene: s, payload: p, from: "window.__BATTLEINIT_PAYLOAD_LATEST" };
        }
      }
    }

    // Fallback: current scene
    const local = canvas.scene.getFlag(PAYLOAD_SCOPE, PAYLOAD_KEY);
    if (local) {
      return { sourceScene: canvas.scene, payload: local, from: "current-scene-flag" };
    }

    // Fallback: newest across all scenes
    const best = pickLatestPayloadAcrossScenes();
    if (best) {
      return { sourceScene: best.scene, payload: best.payload, from: "scene-scan-latest" };
    }

    return null;
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

    // Avoid spamming scene switches while still loading
    await waitForCanvasNotLoading();

    try {
      await s.activate();
    } catch (e) {
      warn("Scene activate failed (continuing):", e);
    }

    // Give the client time to actually swap + start loading
    await wait(250);
    await waitForCanvasNotLoading();
    return canvas.scene?.id === sceneId;
  }

  function getMacroByNameOrNull(name) {
    const m = game.macros?.getName?.(name) ?? null;
    return m || null;
  }

  async function runMacroByName(name) {
    const m = getMacroByNameOrNull(name);
    if (!m) {
      throw new Error(`Macro not found: "${name}"`);
    }
    // Macro.execute() returns whatever the macro returns (often undefined).
    // We still rely on payload polling for completion.
    return await m.execute();
  }

  function deepClone(x) {
    return foundry.utils.deepClone(x);
  }

  async function readPayload(sourceScene) {
    return sourceScene.getFlag(PAYLOAD_SCOPE, PAYLOAD_KEY);
  }

  async function writePayload(sourceScene, payload) {
    await sourceScene.setFlag(PAYLOAD_SCOPE, PAYLOAD_KEY, payload);
  }

  // -----------------------------
  // Step completion checks
  // -----------------------------
  function stepMarker(payload, stepId) {
    // Return an object describing completion status + timestamp
    if (!payload) return { status: "missing", atMs: 0, details: null };

    if (stepId === "gate") {
      const ph = payload?.phases?.gate;
      return { status: String(ph?.status ?? "missing"), atMs: parseIsoToMs(ph?.at), details: ph };
    }

    if (stepId === "resolver") {
      const ph = payload?.phases?.resolve;
      return { status: String(ph?.status ?? "missing"), atMs: parseIsoToMs(ph?.at), details: ph };
    }

    if (stepId === "transition") {
      const ok = Boolean(payload?.step4?.ok);
      const atMs = Number(payload?.step4?.transitionedAt ?? 0) || 0;
      return { status: ok ? "ok" : "missing", atMs, details: payload?.step4 ?? null };
    }

    if (stepId === "layout") {
      const ph = payload?.phases?.layout;
      return { status: String(ph?.status ?? "missing"), atMs: parseIsoToMs(ph?.at), details: ph };
    }

    if (stepId === "spawner") {
      const ph = payload?.phases?.spawn;
      return { status: String(ph?.status ?? "missing"), atMs: parseIsoToMs(ph?.at), details: ph };
    }

    if (stepId === "entrance") {
      const ph = payload?.phases?.entrance;
      return { status: String(ph?.status ?? "missing"), atMs: parseIsoToMs(ph?.at), details: ph };
    }

    if (stepId === "initiator") {
      const ph = payload?.phases?.combat;
      return { status: String(ph?.status ?? "missing"), atMs: parseIsoToMs(ph?.at), details: ph };
    }

    if (stepId === "unleash") {
      const ph = payload?.phases?.unleash;
      // unleash can be "ok" or "none" and both are acceptable completion
      return { status: String(ph?.status ?? "missing"), atMs: parseIsoToMs(ph?.at), details: ph };
    }

    if (stepId === "record") {
      const ph = payload?.phases?.recordWriter;
      return { status: String(ph?.status ?? "missing"), atMs: parseIsoToMs(ph?.at), details: ph };
    }

    return { status: "missing", atMs: 0, details: null };
  }

  function isBlockingStatus(stepId, status) {
    const s = String(status ?? "").toLowerCase();
    if (s === "blocked") return true;
    if (s === "missing") return true;

    // unleash "none" is fine
    if (stepId === "unleash" && s === "none") return false;

    // Anything else: accept "ok"
    return (s !== "ok");
  }

  // -----------------------------
// Prompt completion check (special: payload may not exist yet)
// We use a dedicated Scene flag marker written by the Prompt macro,
// so Manager can stop immediately when GM cancels/closes the dialog.
// -----------------------------
function promptSessionMarker(sourceScene) {
  const m = sourceScene?.getFlag?.(PAYLOAD_SCOPE, PROMPT_MARKER_KEY) ?? null;
  if (!m) return { status: "missing", atMs: 0, details: null };
  return {
    status: String(m?.status ?? "missing"),
    atMs: parseIsoToMs(m?.at),
    details: m
  };
}

async function waitForPromptCreation(sourceScene, startedAtMs) {
  const t0 = Date.now();

  while (true) {
    const mark = promptSessionMarker(sourceScene);

    // Only accept completion that happened after we started the Prompt
    const isAfterStart = (mark.atMs && mark.atMs >= startedAtMs);

    if (DEBUG) {
      log(`Polling step="prompt"`, { status: mark.status, atMs: mark.atMs, isAfterStart });
    }

    if (isAfterStart) {
      const st = String(mark.status ?? "").toLowerCase();

      if (st === "ok") {
        const p = await readPayload(sourceScene);
        if (p) return { ok: true, payload: p, mark };
        // If marker says ok but payload hasn't written yet, keep polling a bit more.
      }

      if (st === "blocked" || st === "cancelled" || st === "canceled") {
        const p = await readPayload(sourceScene);
        return { ok: false, payload: p, mark };
      }
    }

    if ((Date.now() - t0) > PROMPT_TIMEOUT_MS) {
      return { ok: false, payload: null, mark: { status: "timeout", atMs: 0, details: null } };
    }

    await wait(POLL_MS);
  }
}
  async function waitForStepCompletion(sourceScene, stepId, startedAtMs) {
    const t0 = Date.now();
    while (true) {
      const p = await readPayload(sourceScene);
      const mark = stepMarker(p, stepId);

      // Only accept completion that happened after we started this step
      const isAfterStart = (mark.atMs && mark.atMs >= startedAtMs);

      if (DEBUG) {
        log(`Polling step="${stepId}"`, { status: mark.status, atMs: mark.atMs, isAfterStart });
      }

      // For "missing", keep waiting (unless timeout)
      // For "blocked", stop immediately if it is after start
      if (isAfterStart) {
        if (String(mark.status).toLowerCase() === "blocked") return { ok: false, payload: p, mark };
        if (stepId === "unleash") {
          const st = String(mark.status).toLowerCase();
          if (st === "ok" || st === "none") return { ok: true, payload: p, mark };
        } else {
          if (String(mark.status).toLowerCase() === "ok") return { ok: true, payload: p, mark };
        }
      }

      if ((Date.now() - t0) > STEP_TIMEOUT_MS) {
        return { ok: false, payload: p, mark: { status: "timeout", atMs: 0, details: null } };
      }

      await wait(POLL_MS);
    }
  }

 // -----------------------------
// Manager start: run Prompt first (BattleEnd-style)
// -----------------------------
const invokerScene = canvas.scene;

const promptStartMs = Date.now();
log(`RUN step="prompt" macro="${MACRO_NAMES.prompt}"`);

await runMacroByName(MACRO_NAMES.prompt);

const promptDone = await waitForPromptCreation(invokerScene, promptStartMs);
if (!promptDone.ok) {
  ui.notifications?.error?.("BattleInit Manager: Prompt was not completed (cancelled/timeout).");
  warn("Prompt did not complete:", promptDone.mark);
  return;
}

// Clean up prompt marker now that we have a result (optional, but avoids confusion)
try {
  await invokerScene.unsetFlag(PAYLOAD_SCOPE, PROMPT_MARKER_KEY);
} catch (_) {}

// Now locate the payload that Prompt just created
const hintedBattleId = String(promptDone?.payload?.meta?.battleId ?? "");
let found = locateSourceSceneAndPayload();

if (!found || (hintedBattleId && String(found?.payload?.meta?.battleId ?? "") !== hintedBattleId)) {
  found = { sourceScene: invokerScene, payload: promptDone.payload, from: "prompt-created-on-invoker-scene" };
}

let { sourceScene, payload, from } = found;

  const runId = `mgr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const battleId = String(payload?.meta?.battleId ?? "(no battleId)");

  log("START", { runId, battleId, from, sourceScene: { id: sourceScene.id, name: sourceScene.name } });

  // Write manager metadata into payload
  payload = deepClone(payload);
  payload.manager ??= {};
  payload.manager.runId = runId;
  payload.manager.startedAt = nowIso();
  payload.manager.status = "running";
  payload.manager.sourceScene = { id: sourceScene.id, name: sourceScene.name, uuid: sourceScene.uuid };
  payload.manager.steps ??= {};
  payload.manager.steps.prompt = {
  status: "ok",
  at: nowIso(),
  startedAtMs: promptStartMs,
  finishedAt: nowIso(),
  macroName: MACRO_NAMES.prompt,
  stepMarker: promptDone.mark
};
  await writePayload(sourceScene, payload);

  // -----------------------------
  // Pipeline definition
  // -----------------------------
  const steps = [
  { id: "gate",       name: "Gate",           macroName: MACRO_NAMES.gate,       wantsScene: "source" },
  { id: "resolver",   name: "Resolver",       macroName: MACRO_NAMES.resolver,   wantsScene: "source" },
  { id: "transition", name: "Transition",     macroName: MACRO_NAMES.transition, wantsScene: "source" },
  { id: "layout",     name: "Layout Engine",  macroName: MACRO_NAMES.layout,     wantsScene: "battle" },
  { id: "spawner",    name: "Spawner",        macroName: MACRO_NAMES.spawner,    wantsScene: "battle" },
  { id: "entrance",   name: "Entrance",       macroName: MACRO_NAMES.entrance,   wantsScene: "battle" },
  { id: "initiator",  name: "Initiator",      macroName: MACRO_NAMES.initiator,  wantsScene: "battle", conditional: (p) => Boolean(p?.options?.combat?.autoStart) },
  { id: "unleash",    name: "Unleash",        macroName: MACRO_NAMES.unleash,    wantsScene: "battle", conditional: (p) => Boolean(p?.options?.unleash?.enabled) },
  { id: "record",     name: "Record Writer",  macroName: MACRO_NAMES.record,     wantsScene: "battle" }
];

  // -----------------------------
  // Run pipeline
  // -----------------------------
  try {
    for (const step of steps) {
      // Refresh payload each step
      const p0 = await readPayload(sourceScene);
      if (!p0) throw new Error("Payload disappeared (flag missing).");

      // Conditional skip (Initiator/Unleash based on Step1 options)
      if (typeof step.conditional === "function") {
        const shouldRun = step.conditional(p0);
        if (!shouldRun) {
          log(`SKIP step="${step.id}" (${step.name}) due to payload options.`);
          const pSkip = deepClone(p0);
          pSkip.manager ??= {};
          pSkip.manager.steps ??= {};
          pSkip.manager.steps[step.id] = {
            status: "skipped",
            at: nowIso(),
            reason: "Disabled by payload options",
            macroName: step.macroName
          };
          await writePayload(sourceScene, pSkip);
          continue;
        }
      }

      // Ensure we are on the correct scene for this step
      if (step.wantsScene === "source") {
        await ensureActiveScene(sourceScene.id);
      } else {
        const battleSceneId =
          p0?.step4?.battleScene?.id ??
          p0?.context?.battleSceneId ??
          null;

        if (!battleSceneId) {
          throw new Error(`Step "${step.id}" requires battle scene, but payload has no battleSceneId (run Transition first).`);
        }
        await ensureActiveScene(battleSceneId);
      }

      // Mark step start
      const stepStartMs = Date.now();
      const p1 = deepClone(await readPayload(sourceScene));
      p1.manager ??= {};
      p1.manager.currentStep = step.id;
      p1.manager.currentStepName = step.name;
      p1.manager.steps ??= {};
      p1.manager.steps[step.id] = {
        status: "running",
        at: nowIso(),
        startedAtMs: stepStartMs,
        macroName: step.macroName
      };
      await writePayload(sourceScene, p1);

      log(`RUN step="${step.id}" macro="${step.macroName}"`);

      // Execute the macro
      await runMacroByName(step.macroName);

      // Wait for completion marker in payload
      const done = await waitForStepCompletion(sourceScene, step.id, stepStartMs);

      // Record step end
      const p2 = deepClone(await readPayload(sourceScene));
      p2.manager ??= {};
      p2.manager.steps ??= {};
      p2.manager.steps[step.id] = {
        ...(p2.manager.steps[step.id] ?? {}),
        status: done.ok ? "ok" : "blocked",
        finishedAt: nowIso(),
        stepMarker: done.mark
      };
      await writePayload(sourceScene, p2);

      if (!done.ok) {
        const blockInfo = done.mark?.details ?? {};
        ui.notifications?.error?.(`BattleInit: BLOCKED at ${step.name}. Check chat/console.`);
        warn("BLOCKED", { step: step.id, mark: done.mark });

        // Optional: post a quick GM chat summary
        const errors = Array.isArray(blockInfo?.errors) ? blockInfo.errors : [];
        const warnings = Array.isArray(blockInfo?.warnings) ? blockInfo.warnings : [];

        const html = [];
        html.push(`<div style="font-weight:900; font-size:16px;">BattleInit — Manager STOPPED</div>`);
        html.push(`<div><b>Blocked Step:</b> ${step.name}</div>`);
        html.push(`<div><b>Macro:</b> ${step.macroName}</div>`);

        if (errors.length) {
          html.push(`<hr><div style="font-weight:900; margin:6px 0;">Errors</div>`);
          html.push(`<ul style="margin:0 0 0 18px;">${errors.map(e => `<li>${String(e)}</li>`).join("")}</ul>`);
        }
        if (warnings.length) {
          html.push(`<hr><div style="font-weight:900; margin:6px 0;">Warnings</div>`);
          html.push(`<ul style="margin:0 0 0 18px;">${warnings.map(w => `<li>${String(w)}</li>`).join("")}</ul>`);
        }

        await ChatMessage.create({
          speaker: ChatMessage.getSpeaker({ alias: "BattleInit" }),
          content: `<div style="padding:10px 12px; border:1px solid var(--color-border-light-primary); border-radius:10px;">${html.join("")}</div>`
        });

        // Final manager status
        const pEnd = deepClone(await readPayload(sourceScene));
        pEnd.manager ??= {};
        pEnd.manager.status = "blocked";
        pEnd.manager.stoppedAt = nowIso();
        await writePayload(sourceScene, pEnd);

        return;
      }

      log(`DONE step="${step.id}"`, done.mark);
    }

    // All steps done
    const pFinal = deepClone(await readPayload(sourceScene));
    pFinal.manager ??= {};
    pFinal.manager.status = "ok";
    pFinal.manager.finishedAt = nowIso();
    await writePayload(sourceScene, pFinal);

    log("COMPLETE", { runId, battleId });

  } catch (e) {
    error("Manager failed:", e);
    ui.notifications?.error?.(`BattleInit Manager: FAILED — ${e?.message ?? String(e)}`);

    // Best-effort store failure in payload
    try {
      const pFail = deepClone(await readPayload(sourceScene));
      if (pFail) {
        pFail.manager ??= {};
        pFail.manager.status = "failed";
        pFail.manager.failedAt = nowIso();
        pFail.manager.error = { message: e?.message ?? String(e), stack: e?.stack ?? null };
        await writePayload(sourceScene, pFail);
      }
    } catch (_) {}
  }
})();
