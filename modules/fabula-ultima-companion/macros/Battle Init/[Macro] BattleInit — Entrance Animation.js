// ============================================================================
// BattleInit — Entrance Animation (Step 5c) • Foundry VTT v12
// ----------------------------------------------------------------------------
// - Plays phased pseudo entrance animations (Party then Enemies) across clients
// - Reveals real tokens in 2 phases to avoid blink gap
// - Locks camera pan during the entrance (and keeps it locked into Initiator)
//   -> Initiator (Step 6) is responsible for unlocking after combat starts.
// ============================================================================

(async () => {
  const DEBUG = false;
  const TRACE_TOKENS = false; // set true if you want the probe logs again

  const MODULE_ID = "fabula-ultima-companion";
  const SOCKET_CHANNEL = `module.${MODULE_ID}`;

  const PAYLOAD_SCOPE = "world";
  const PAYLOAD_KEY   = "battleInit.latestPayload";

  const BROADCAST_SCOPE = "world";
  const BROADCAST_KEY   = "battleInit.entrance.broadcast";

  const tag = "[BattleInit:Entrance:Step5c]";
  const log  = (...a) => DEBUG && console.log(tag, ...a);
  const warn = (...a) => console.warn(tag, ...a);

  const wait   = (ms) => new Promise(r => setTimeout(r, ms));
  const nowIso = () => new Date().toISOString();

  const tStart = performance.now();
  const t = () => Math.round(performance.now() - tStart);

  function snapToken(id) {
    const tok = canvas.tokens?.get?.(id);
    if (!tok) return { id, ok: false, reason: "missing-token" };

    const docHidden = Boolean(tok.document?.hidden);
    const docAlpha  = Number(tok.document?.alpha ?? 1);
    const tokAlpha  = (typeof tok.alpha === "number") ? tok.alpha : 1;
    const meshAlpha = (tok.mesh && typeof tok.mesh.alpha === "number") ? tok.mesh.alpha : null;
    const iconAlpha = (tok.icon && typeof tok.icon.alpha === "number") ? tok.icon.alpha : null;
    const visible   = Boolean(tok.visible);

    return { id, docHidden, docAlpha, tokAlpha, meshAlpha, iconAlpha, visible };
  }

  function probeTokens(label, ids) {
    if (!TRACE_TOKENS) return;
    const states = (ids ?? []).slice(0, 6).map(snapToken);
    log(`PROBE ${label} +${t()}ms`, { count: (ids ?? []).length, sample: states });
  }

  // -----------------------------
  // Guards
  // -----------------------------
  if (!game.user?.isGM) {
    ui.notifications?.warn?.("BattleInit: Entrance Animation is GM only.");
    return;
  }
  if (!canvas?.scene) {
    ui.notifications?.error?.("BattleInit: No active scene.");
    return;
  }

  // -----------------------------
  // Find payload even if stored on source scene
  // -----------------------------
  function findBattleInitPayloadForThisBattleScene() {
    const currentSceneId = canvas.scene?.id;
    if (!currentSceneId) return null;

    const local = canvas.scene.getFlag(PAYLOAD_SCOPE, PAYLOAD_KEY);
    if (local) return { payload: local, sourceScene: canvas.scene };

    for (const s of (game.scenes?.contents ?? [])) {
      const p = s.getFlag(PAYLOAD_SCOPE, PAYLOAD_KEY);
      if (!p) continue;

      const transitionedBattleId =
        p?.step4?.battleScene?.id ??
        p?.step4?.battleSceneId ??
        p?.context?.battleSceneId ??
        null;

      if (transitionedBattleId && transitionedBattleId === currentSceneId) {
        return { payload: p, sourceScene: s };
      }
    }
    return null;
  }

  const found = findBattleInitPayloadForThisBattleScene();
  if (!found) {
    ui.notifications?.error?.("BattleInit: No payload found. Run Step 1 → Step 5b first.");
    return;
  }

  const { payload, sourceScene } = found;

  const spawn = payload?.spawn?.step5b;
  if (!spawn?.partyTokenIds || !spawn?.enemyTokenIds) {
    ui.notifications?.error?.("BattleInit: Missing spawn.step5b token ids. Run Encounter Spawner first.");
    log("Missing spawn:", payload?.spawn);
    return;
  }

  const animationsEnabled = Boolean(payload?.options?.animations?.enabled);

  // If animations disabled: reveal everything now (also do NOT lock camera)
  if (!animationsEnabled) {
    try {
      const allIds = [...(spawn.partyTokenIds ?? []), ...(spawn.enemyTokenIds ?? [])];
      const updates = allIds.map(id => ({ _id: id, hidden: false, alpha: 1 }));

      log("Animations disabled: revealing all tokens", { updates: updates.length });

      if (updates.length) await canvas.scene.updateEmbeddedDocuments("Token", updates);

      payload.phases ??= {};
      payload.phases.entrance = { status: "ok", at: nowIso(), mode: "instant-reveal" };
      await sourceScene.setFlag(PAYLOAD_SCOPE, PAYLOAD_KEY, payload);

      return;
    } catch (e) {
      console.error(tag, "Instant reveal failed:", e);
      ui.notifications?.error?.("BattleInit: Entrance reveal failed. Check console.");
      return;
    }
  }

  // -----------------------------
  // Build run/broadcast data
  // -----------------------------
  const runId = `bi_entrance_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const config = {
    partyRunMs: 650,
    enemyFadeMs: 550,
    partyStartOffsetX: 650
  };

  const data = {
    runId,
    battleSceneId: canvas.scene.id,
    partyTokenIds: Array.isArray(spawn.partyTokenIds) ? spawn.partyTokenIds : [],
    enemyTokenIds: Array.isArray(spawn.enemyTokenIds) ? spawn.enemyTokenIds : [],
    config,
    startedAtMs: Date.now(),
    expiresAtMs: Date.now() + 60_000
  };

  log("START", { runId, scene: canvas.scene.id, party: data.partyTokenIds.length, enemies: data.enemyTokenIds.length });

  probeTokens("pre-party", data.partyTokenIds);
  probeTokens("pre-enemy", data.enemyTokenIds);

  // Store catch-up broadcast on the scene (late canvasReady clients can read it)
  try {
    await canvas.scene.setFlag(BROADCAST_SCOPE, BROADCAST_KEY, data);
  } catch (e) {
    warn("Could not set broadcast flag (continuing):", e);
  }

  // -----------------------------
  // ACK tracking (phased)
  // -----------------------------
  const gmId = game.user?.id ?? null;

  const expectedUserIds = (game.users?.contents ?? [])
    .filter(u => u.active)
    .map(u => u.id);

  const expectedOtherUserIds = gmId ? expectedUserIds.filter(id => id !== gmId) : expectedUserIds;

  const ACK_TIMEOUT_MS = 20_000;

  let currentPhase = "";
  const acks = new Set();

  function resetPhase(phase) {
    currentPhase = String(phase ?? "");
    acks.clear();
    if (gmId) acks.add(gmId);
  }

  function ackHandler(msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.type !== "BI_ENTRANCE_ACK") return;
    if (String(msg.runId ?? "") !== runId) return;

    const msgPhase = String(msg.phase ?? "");
    if (msgPhase !== currentPhase) return;

    const uid = String(msg.userId ?? "");
    if (!uid) return;

    if (!acks.has(uid)) {
      acks.add(uid);
      log("ACK", { phase: currentPhase, from: uid, count: acks.size, expectedOther: expectedOtherUserIds.length, atMs: t() });
    }
  }

  async function waitForOtherAcksOrTimeout() {
    const t0 = Date.now();
    while (true) {
      const allAcked = expectedOtherUserIds.every(id => acks.has(id));
      if (allAcked) return true;

      if ((Date.now() - t0) > ACK_TIMEOUT_MS) return false;
      await wait(150);
    }
  }

  game.socket.on(SOCKET_CHANNEL, ackHandler);

  let success = false;

  try {
    // Validate GM functions exist (Listener must be installed on GM)
    const hasGMPartyPlay = (typeof globalThis.BI_Entrance_GM_playParty === "function");
    const hasGMEnemyPlay = (typeof globalThis.BI_Entrance_GM_playEnemy === "function");
    const hasGMPartyCleanup = (typeof globalThis.BI_Entrance_GM_cleanupParty === "function");
    const hasGMEnemyCleanup = (typeof globalThis.BI_Entrance_GM_cleanupEnemy === "function");

    log("GM hooks present?", { hasGMPartyPlay, hasGMEnemyPlay, hasGMPartyCleanup, hasGMEnemyCleanup });

    // -----------------------------
    // CAMERA LOCK (stay locked into Initiator)
    // -----------------------------
    log("Broadcast CAMERA LOCK", { atMs: t(), runId });
    game.socket.emit(SOCKET_CHANNEL, { type: "BI_CAMERA_LOCK", runId });

    // Also lock locally on GM (no-echo safe)
    if (typeof globalThis.BI_CameraLock === "function") {
      globalThis.BI_CameraLock(runId);
      log("Local CAMERA LOCK (GM) called", { atMs: t(), runId });
    } else {
      warn("Local BI_CameraLock not found on GM. (Listener may not be installed on GM)");
    }

    // Record locked marker so Step 6 can unlock later (and can find runId)
    payload.phases ??= {};
    payload.phases.cameraLock = { status: "locked", at: nowIso(), runId };
    await sourceScene.setFlag(PAYLOAD_SCOPE, PAYLOAD_KEY, payload);

    // -----------------------------
    // PHASE A — PARTY
    // -----------------------------
    resetPhase("party");

    log("Broadcast PARTY START", { atMs: t(), expectedUserIds, expectedOtherUserIds });
    game.socket.emit(SOCKET_CHANNEL, { type: "BI_ENTRANCE_START", phase: "party", data });

    // GM play-only: resolves when tween completes (NOT waiting for reveal)
    const gmPartyTween = hasGMPartyPlay ? globalThis.BI_Entrance_GM_playParty(data) : Promise.resolve();

    // Wait other clients to finish PARTY tween
    const okParty = await Promise.all([gmPartyTween, waitForOtherAcksOrTimeout()]);
    log("PHASE PARTY done", { atMs: t(), okOtherAcks: okParty[1] });

    if (!okParty[1]) {
      warn("PARTY ACK timeout (others); continuing anyway.", {
        got: acks.size,
        expectedOther: expectedOtherUserIds.length
      });
    }

    // Reveal PARTY real tokens NOW (seamless swap)
    probeTokens("pre-reveal-party", data.partyTokenIds);

    const partyUpdates = (data.partyTokenIds ?? []).map(id => ({ _id: id, hidden: false, alpha: 1 }));

    log("REVEAL PARTY (updateEmbeddedDocuments)", { atMs: t(), count: partyUpdates.length });
    if (partyUpdates.length) await canvas.scene.updateEmbeddedDocuments("Token", partyUpdates);

    probeTokens("post-reveal-party", data.partyTokenIds);

    // Trigger GM cleanup: remove stored party sprites only after tokens actually visible
    if (hasGMPartyCleanup) {
      log("GM PARTY cleanup start", { atMs: t() });
      globalThis.BI_Entrance_GM_cleanupParty(data);
    }

    await wait(30);

    // -----------------------------
    // PHASE B — ENEMY
    // -----------------------------
    resetPhase("enemy");

    log("Broadcast ENEMY START", { atMs: t(), expectedUserIds, expectedOtherUserIds });
    game.socket.emit(SOCKET_CHANNEL, { type: "BI_ENTRANCE_START", phase: "enemy", data });

    const gmEnemyTween = hasGMEnemyPlay ? globalThis.BI_Entrance_GM_playEnemy(data) : Promise.resolve();

    const okEnemy = await Promise.all([gmEnemyTween, waitForOtherAcksOrTimeout()]);
    log("PHASE ENEMY done", { atMs: t(), okOtherAcks: okEnemy[1] });

    if (!okEnemy[1]) {
      warn("ENEMY ACK timeout (others); continuing anyway.", {
        got: acks.size,
        expectedOther: expectedOtherUserIds.length
      });
    }

    // Reveal ENEMY real tokens NOW
    probeTokens("pre-reveal-enemy", data.enemyTokenIds);

    const enemyUpdates = (data.enemyTokenIds ?? []).map(id => ({ _id: id, hidden: false, alpha: 1 }));

    log("REVEAL ENEMY (updateEmbeddedDocuments)", { atMs: t(), count: enemyUpdates.length });
    if (enemyUpdates.length) await canvas.scene.updateEmbeddedDocuments("Token", enemyUpdates);

    probeTokens("post-reveal-enemy", data.enemyTokenIds);

    // Trigger GM cleanup for enemy sprites
    if (hasGMEnemyCleanup) {
      log("GM ENEMY cleanup start", { atMs: t() });
      globalThis.BI_Entrance_GM_cleanupEnemy(data);
    }

    // -----------------------------
    // Mark payload completion
    // -----------------------------
    payload.phases ??= {};
    payload.phases.entrance = {
      status: "ok",
      at: nowIso(),
      runId,
      counts: {
        party: (data.partyTokenIds ?? []).length,
        enemies: (data.enemyTokenIds ?? []).length
      }
    };

    // Keep cameraLock marker as "locked" here; Step 6 will flip to "unlocked"
    await sourceScene.setFlag(PAYLOAD_SCOPE, PAYLOAD_KEY, payload);

    log("DONE", { atMs: t(), entrance: payload.phases.entrance, cameraLock: payload.phases.cameraLock });

    success = true;


  } catch (e) {
    console.error(tag, "Entrance step failed:", e);
    ui.notifications?.error?.(`BattleInit: Entrance FAILED — ${e?.message ?? String(e)}`);

    // If entrance fails, unlock so the table isn't stuck (Initiator may never run)
    try {
      warn("Entrance failed -> unlocking camera as fail-safe", { runId });

      game.socket.emit(SOCKET_CHANNEL, { type: "BI_CAMERA_UNLOCK", runId });

      if (typeof globalThis.BI_CameraUnlock === "function") {
        globalThis.BI_CameraUnlock(runId);
      }

      payload.phases ??= {};
      payload.phases.cameraLock = { status: "unlocked", at: nowIso(), runId, note: "failsafe (entrance failed)" };
      await sourceScene.setFlag(PAYLOAD_SCOPE, PAYLOAD_KEY, payload);
    } catch (ee) {
      warn("Fail-safe unlock failed:", ee);
    }

  } finally {
    try { game.socket.off(SOCKET_CHANNEL, ackHandler); } catch (_) {}

    // Expire broadcast immediately (prevents late replays)
    try {
      const b = canvas.scene.getFlag(BROADCAST_SCOPE, BROADCAST_KEY);
      if (b?.runId === runId) {
        b.expiresAtMs = Date.now() - 1;
        await canvas.scene.setFlag(BROADCAST_SCOPE, BROADCAST_KEY, b);
      }
    } catch (_) {}

    if (!success) {
      log("END (failed)", { atMs: t(), runId });
    }
  }
})();
