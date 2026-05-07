// ============================================================================
// BattleInit — Battle Initiator (Step 6) • Foundry VTT v12
// ----------------------------------------------------------------------------
// Takes tokens created in Step 5b (payload.spawn.step5b.*TokenIds)
// and starts combat:
// - Ensures a Combat exists for the battle scene
// - Adds party + enemy tokens as combatants
// - Optionally rolls initiative
// - Starts combat (combat.startCombat())
//
// UPDATE (2026-01-19):
// - AFTER combat starts, auto-sync Lancer Initiative "Turn Activations" per combatant
//   using actor data field: .activation (and safe fallbacks)
//   IMPORTANT: This SETS activations to the desired number (not "adds").
// ============================================================================

(async () => {
  const DEBUG = true;

  const MODULE_ID = "fabula-ultima-companion";
  const SOCKET_CHANNEL = `module.${MODULE_ID}`;

  const PAYLOAD_SCOPE = "world";
  const PAYLOAD_KEY   = "battleInit.latestPayload";

  const ROLL_INITIATIVE = false;   // set false if your system handles init elsewhere
  const tag = "[BattleInit:BattleInitiator:Step6]";
  const log = (...a) => DEBUG && console.log(tag, ...a);

  // Lancer Initiative integration
  const LI_MODULE_ID = "lancer-initiative";
  const ENABLE_LANCER_ACTIVATION_SYNC = true;

  // -----------------------------
  // Helpers
  // -----------------------------
  const nowIso = () => new Date().toISOString();

  function findBattleInitPayloadForThisBattleScene() {
    const currentSceneId = canvas.scene?.id;
    if (!currentSceneId) return null;

    // 1) current scene
    const local = canvas.scene.getFlag(PAYLOAD_SCOPE, PAYLOAD_KEY);
    if (local) return { payload: local, sourceScene: canvas.scene };

    // 2) search other scenes that "own" the payload
    for (const s of (game.scenes?.contents ?? [])) {
      const p = s.getFlag(PAYLOAD_SCOPE, PAYLOAD_KEY);
      if (!p) continue;

      const transitionedBattleId =
        p?.step4?.battleScene?.id ??
        p?.step4?.battleSceneId ??
        null;

      if (transitionedBattleId && transitionedBattleId === currentSceneId) {
        return { payload: p, sourceScene: s };
      }
    }
    return null;
  }

  async function ensureCombatForScene(sceneId) {
    // If there is already an active combat for this scene, reuse it.
    const combats = game.combats?.contents ?? [];
    let combat = combats.find(c => c.scene?.id === sceneId) ?? null;

    if (!combat) {
      combat = await Combat.create({ scene: sceneId });
    }

    // Ensure it's the viewed combat in UI
    if (game.combat?.id !== combat.id) {
      await combat.activate();
    }

    return combat;
  }

  function uniq(arr) {
    return [...new Set((arr ?? []).filter(Boolean))];
  }

  function clampInt(n, min, max) {
    const x = Number.isFinite(n) ? Math.trunc(n) : NaN;
    if (!Number.isFinite(x)) return min;
    return Math.max(min, Math.min(max, x));
  }

  function readDesiredActivations(actor) {
    // Your main field: ".activation"
    // In Foundry data, that could be stored at:
    // - system.activation
    // - system.props.activation (common pattern in your JSON)
    // We'll also try a couple reasonable fallbacks.
    const gp = foundry.utils?.getProperty;
    const raw =
      gp?.(actor, "system.activation") ??
      gp?.(actor, "system.props.activation") ??
      gp?.(actor, "system.attributes.activation") ??
      gp?.(actor, "system.details.activation") ??
      actor?.system?.activation ??
      actor?.system?.props?.activation ??
      null;

    // Accept numbers or numeric strings. Default = 1.
    const parsed = raw === null || raw === undefined || raw === "" ? 1 : Number(raw);
    return clampInt(parsed, 0, 99); // allow 0 if you ever want "no activations"
  }

  async function syncLancerInitiativeActivations(combat, tokenIds) {
    if (!ENABLE_LANCER_ACTIVATION_SYNC) return { updated: 0, skipped: 0, reason: "disabled" };

    const liMod = game.modules?.get?.(LI_MODULE_ID);
    if (!liMod?.active) {
      log(`Lancer Initiative module "${LI_MODULE_ID}" is not active. Skipping activation sync.`);
      return { updated: 0, skipped: tokenIds.length, reason: "module-inactive" };
    }

    // Only touch combatants that belong to THIS BattleInit run (by tokenId)
    const all = combat.combatants?.contents ?? [];
    const ours = all.filter(c => tokenIds.includes(c.tokenId));

    const updates = [];
    let skipped = 0;

    for (const c of ours) {
      const actor = c.actor;
      if (!actor) { skipped++; continue; }

      const desired = readDesiredActivations(actor);

      // What the module currently thinks is max/value
      const currentMax = c.getFlag(LI_MODULE_ID, "activations.max") ?? 1;
      const currentVal = c.getFlag(LI_MODULE_ID, "activations.value") ?? 0;

      // IMPORTANT:
      // - You said everyone starts with 1 by default.
      // - If desired=3, that means SET to 3 (not "add 3").
      // So we set BOTH max and value to desired, so they begin the round with full activations.
      const needsUpdate = (Number(currentMax) !== desired) || (Number(currentVal) !== desired);

      if (!needsUpdate) {
        continue;
      }

      updates.push({
        _id: c.id,
        "flags.lancer-initiative.activations.max": desired,
        "flags.lancer-initiative.activations.value": desired
      });

      log(`Activation sync: ${c.name} -> desired=${desired} (was max=${currentMax}, value=${currentVal})`);
    }

    if (updates.length) {
      // Batch update = fewer socket events, faster & cleaner
      await combat.updateEmbeddedDocuments("Combatant", updates, { diff: false });
      game.combats?.render?.();
    }

    return { updated: updates.length, skipped };
  }

  // -----------------------------
  // Guards
  // -----------------------------
  if (!game.user?.isGM) {
    ui.notifications?.warn?.("BattleInit: Step 6 is GM only.");
    return;
  }
  if (!canvas?.scene) {
    ui.notifications?.error?.("BattleInit: No active scene.");
    return;
  }

  const found = findBattleInitPayloadForThisBattleScene();
  if (!found) {
    ui.notifications?.error?.("BattleInit: No payload found. Run Step 1 → Step 5b first.");
    return;
  }

  const { payload, sourceScene } = found;

  const lockRunId =
    payload?.phases?.cameraLock?.runId ??
    payload?.phases?.entrance?.runId ??
    null;

  log("Camera lock runId (from payload):", lockRunId);

  const spawnInfo = payload?.spawn?.step5b;
  if (!spawnInfo) {
    ui.notifications?.error?.("BattleInit: Missing spawn info. Run Step 5b first.");
    log("Missing payload.spawn.step5b:", payload?.spawn);
    return;
  }

  const partyTokenIds = uniq(spawnInfo.partyTokenIds);
  const enemyTokenIds = uniq(spawnInfo.enemyTokenIds);
  const allTokenIds   = uniq([...partyTokenIds, ...enemyTokenIds]);

  if (!allTokenIds.length) {
    ui.notifications?.error?.("BattleInit: No spawned tokens found in payload. Nothing to start combat with.");
    return;
  }

  // -----------------------------
  // Locate tokens in current battle scene
  // -----------------------------
  const sceneTokens = canvas.scene.tokens?.contents ?? [];
  const tokensToAdd = allTokenIds
    .map(id => sceneTokens.find(t => t.id === id))
    .filter(Boolean);

  if (!tokensToAdd.length) {
    ui.notifications?.error?.("BattleInit: Spawned token IDs were not found on this scene. Are you on the battle scene?");
    log("Token IDs expected:", allTokenIds);
    log("Scene token count:", sceneTokens.length);
    return;
  }

  // -----------------------------
  // Ensure Combat + add combatants
  // -----------------------------
  const combat = await ensureCombatForScene(canvas.scene.id);

  // Existing combatant tokenIds
  const existing = new Set((combat.combatants?.contents ?? []).map(c => c.tokenId).filter(Boolean));

  const toCreate = [];
  for (const t of tokensToAdd) {
    if (existing.has(t.id)) continue;
    toCreate.push({
      tokenId: t.id,
      actorId: t.actorId
    });
  }

  if (toCreate.length) {
    await combat.createEmbeddedDocuments("Combatant", toCreate);
  }

  // Refresh references after creation
  const combatants = combat.combatants?.contents ?? [];
  const idsToRoll = combatants
    .filter(c => allTokenIds.includes(c.tokenId))
    .map(c => c.id);

  // -----------------------------
  // Roll initiative (optional)
  // -----------------------------
  if (ROLL_INITIATIVE) {
    try {
      await combat.rollInitiative(idsToRoll);
    } catch (e) {
      console.warn(tag, "rollInitiative failed (continuing):", e);
    }
  }

  // -----------------------------
  // Start combat
  // -----------------------------
  try {
    if (!combat.started) {
      await combat.startCombat();
    }
  } catch (e) {
    console.warn(tag, "startCombat failed (continuing):", e);
  }

  // -----------------------------
  // NEW: Sync "Turn Activations" (Lancer Initiative) AFTER combat is started
  // -----------------------------
  let activationSyncResult = null;
  try {
    activationSyncResult = await syncLancerInitiativeActivations(combat, allTokenIds);
    log("Activation sync result:", activationSyncResult);
  } catch (e) {
    console.warn(tag, "Activation sync failed (continuing):", e);
    activationSyncResult = { updated: 0, skipped: 0, reason: "error" };
  }

  // -----------------------------
  // Save to payload
  // -----------------------------
  payload.initiator ??= {};
  payload.initiator.step6 = {
    at: nowIso(),
    battleScene: { id: canvas.scene.id, name: canvas.scene.name, uuid: canvas.scene.uuid },
    combatId: combat.id,
    tokenIds: allTokenIds,
    addedCombatants: toCreate.length,
    rolledInitiative: ROLL_INITIATIVE,
    activationSync: activationSyncResult
  };

  payload.phases ??= {};
  payload.phases.combat = {
    status: "ok",
    at: payload.initiator.step6.at,
    combatId: combat.id
  };

  await sourceScene.setFlag(PAYLOAD_SCOPE, PAYLOAD_KEY, payload);

  log("Step 6 complete:", payload.initiator.step6);

  // -----------------------------
  // Release camera lock (after combat start)
  // -----------------------------
  await new Promise(r => setTimeout(r, 200));
  try {
    if (lockRunId) {
      // Broadcast to all clients
      game.socket.emit(SOCKET_CHANNEL, { type: "BI_CAMERA_UNLOCK", runId: lockRunId });

      // Also unlock locally on GM (no-echo safe)
      if (typeof globalThis.BI_CameraUnlock === "function") {
        globalThis.BI_CameraUnlock(lockRunId);
      }

      // Mark unlocked in payload (optional)
      payload.phases ??= {};
      payload.phases.cameraLock = { status: "unlocked", at: nowIso(), runId: lockRunId };
      await sourceScene.setFlag(PAYLOAD_SCOPE, PAYLOAD_KEY, payload);

      log("Camera lock released ✅", lockRunId);
    } else {
      log("No lockRunId found; skipping camera unlock.");
    }
  } catch (e) {
    console.warn(tag, "Camera unlock failed (continuing):", e);
  }
})();
