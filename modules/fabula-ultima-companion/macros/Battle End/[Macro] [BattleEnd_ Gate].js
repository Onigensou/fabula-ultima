// ============================================================================
// [BattleEnd: Gate] • Foundry VTT v12
// ----------------------------------------------------------------------------
// Purpose:
// - Locate canonical payload stored on SOURCE scene (BattleInit design)
// - Validate BattleEnd Prompt data is ready
// - BLOCK early if something is wrong
// - Write payload.phases.battleEnd.gate = { status, at, errors, warnings }
// - Save updated payload back onto SOURCE scene flag (canonical)
//
// Storage (Scene Flags):
// - Canonical payload key: world.battleInit.latestPayload   (source scene)
// - Convenience key      : world.battleEnd.latestPayload    (optional)
// ============================================================================

(async () => {
  const DEBUG = true;

  // --------------------------------------------------------------------------
  // CONFIG (match your BattleInit / BattleEnd Prompt)
  // --------------------------------------------------------------------------
  const STORE_SCOPE   = "world";
  const CANONICAL_KEY = "battleInit.latestPayload";
  const BATTLEEND_KEY = "battleEnd.latestPayload";

  const tag = "[BattleEnd:Gate]";
  const log = (...args) => DEBUG && console.log(tag, ...args);

  // --------------------------------------------------------------------------
  // Guards
  // --------------------------------------------------------------------------
  if (!game.user?.isGM) {
    ui.notifications?.warn?.("BattleEnd: Gate is GM-only.");
    return;
  }
  if (!canvas?.scene) {
    ui.notifications?.error?.("BattleEnd: No active scene (canvas.scene is null).");
    return;
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------
  function nowIso() { return new Date().toISOString(); }

  function safeNumber(v, fallback = 0) {
    const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
    return Number.isFinite(n) ? n : fallback;
  }

  function parseIsoToMs(iso) {
    const t = Date.parse(String(iso ?? ""));
    return Number.isFinite(t) ? t : 0;
  }

  async function safeFromUuid(uuid) {
    const u = String(uuid ?? "").trim();
    if (!u) return null;
    try {
      return await fromUuid(u);
    } catch (err) {
      console.warn(`${tag} fromUuid failed:`, u, err);
      return null;
    }
  }

  function sceneUuidFromId(sceneId) {
    return `Scene.${sceneId}`;
  }

  function resolveSceneNameByUuid(uuid) {
    if (!uuid) return "";
    const id = String(uuid).startsWith("Scene.") ? String(uuid).slice("Scene.".length) : uuid;
    const sc = game.scenes?.get?.(id);
    return sc?.name ?? "";
  }

  // --------------------------------------------------------------------------
  // Locate canonical payload scene (same method as BattleEnd Prompt)
  // --------------------------------------------------------------------------
  function pickLatestPayloadAcrossScenes() {
    let best = null;

    for (const s of (game.scenes?.contents ?? [])) {
      const p = s.getFlag(STORE_SCOPE, CANONICAL_KEY);
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

  function locateSourceSceneAndPayloadForThisBattle() {
    const activeBattleSceneId = canvas.scene?.id;

    // 1) Best match: payload whose step4.battleScene.id matches the ACTIVE battle scene
    let bestMatch = null;
    let bestMatchMs = 0;

    for (const s of (game.scenes?.contents ?? [])) {
      const p = s.getFlag(STORE_SCOPE, CANONICAL_KEY);
      if (!p) continue;

      const battleSceneIdInPayload = p?.step4?.battleScene?.id ?? null;
      if (battleSceneIdInPayload && activeBattleSceneId && battleSceneIdInPayload === activeBattleSceneId) {
        const ms =
          parseIsoToMs(p?.meta?.createdAt) ||
          Number(p?.step4?.transitionedAt ?? 0) ||
          0;

        if (!bestMatch || ms > bestMatchMs) {
          bestMatch = { scene: s, payload: p, from: "scene-scan-match-step4.battleScene.id" };
          bestMatchMs = ms;
        }
      }
    }

    if (bestMatch) return bestMatch;

    // 2) If you ran Gate on the source scene by accident, local is fine
    const local = canvas.scene.getFlag(STORE_SCOPE, CANONICAL_KEY);
    if (local) return { scene: canvas.scene, payload: local, from: "current-scene-flag" };

    // 3) Fallback: newest payload across scenes
    const best = pickLatestPayloadAcrossScenes();
    if (best) return { scene: best.scene, payload: best.payload, from: "scene-scan-latest" };

    return null;
  }

  const located = locateSourceSceneAndPayloadForThisBattle();
  if (!located?.payload || !located?.scene) {
    ui.notifications?.error?.(`BattleEnd Gate: No canonical payload found anywhere at ${STORE_SCOPE}.${CANONICAL_KEY}.`);
    log("Missing canonical payload across all scenes.", { activeScene: { id: canvas.scene.id, name: canvas.scene.name } });
    return;
  }

  const sourceScene = located.scene;
  const payload = located.payload;

  log("Located canonical payload ✅", {
    from: located.from,
    sourceScene: { id: sourceScene.id, name: sourceScene.name },
    activeScene: { id: canvas.scene.id, name: canvas.scene.name },
    battleId: payload?.meta?.battleId ?? "(missing)"
  });

  // --------------------------------------------------------------------------
  // Gate validation
  // --------------------------------------------------------------------------
  const errors = [];
  const warnings = [];

  // Basic payload sanity
  if (!payload?.meta) warnings.push("payload.meta is missing (not fatal, but unusual).");

  // Are we actually on the battle scene?
  const expectedBattleSceneId = payload?.step4?.battleScene?.id ?? payload?.context?.battleSceneId ?? null;
  if (expectedBattleSceneId && expectedBattleSceneId !== canvas.scene.id) {
    warnings.push(
      `Active scene (${canvas.scene.name}) does not match payload battle scene id. ` +
      `Expected sceneId=${expectedBattleSceneId}. You may be running Gate on a non-battle scene.`
    );
  }

  // Prompt must exist
  const prompt = payload?.battleEnd?.prompt ?? null;
  if (!prompt) {
    errors.push("Missing payload.battleEnd.prompt. Run [BattleEnd: Prompt] first.");
  }

  // Validate mode
  const mode = String(payload?.battleEnd?.meta?.mode ?? "").trim();
  const allowedModes = new Set(["victory", "defeat"]);
  if (!mode || !allowedModes.has(mode)) {
    errors.push(`BattleEnd mode is missing/invalid. Expected: victory or defeat. Got: "${mode || "(empty)"}"`);
  }

  // Return Scene is required (both victory/defeat need to go somewhere)
  const returnSceneUuid = String(prompt?.returnSceneUuid ?? "").trim();
  if (!returnSceneUuid) {
    errors.push("Return Scene is missing (payload.battleEnd.prompt.returnSceneUuid). Choose one in [BattleEnd: Prompt].");
  } else {
    const sc = await safeFromUuid(returnSceneUuid);
    if (!sc || sc.documentName !== "Scene") {
      errors.push(`Return Scene UUID does not resolve to a Scene: ${returnSceneUuid}`);
    } else {
      // Optional: warn if return scene equals battle scene
      if (expectedBattleSceneId && sc.id === expectedBattleSceneId) {
        warnings.push("Return Scene is the same as the Battle Scene. (This is unusual; check your selection.)");
      }
    }
  }

  // BGM / FX checks (not fatal)
  const playMusic = !!prompt?.bgm?.playMusic;
  const bgmName = String(prompt?.bgm?.name ?? "").trim();
  if (playMusic && !bgmName) warnings.push("Play Music is enabled but BGM Name is empty (will likely do nothing).");

  const playAnimation = !!prompt?.fx?.playAnimation;
  if (playAnimation !== true && playAnimation !== false) warnings.push("fx.playAnimation is not a boolean (unexpected).");

  // Party checks (we’ll need these later for awarding EXP and cleanup)
  const partyMembers = Array.isArray(payload?.party?.members) ? payload.party.members : [];
  if (!partyMembers.length) {
    errors.push("Party List is missing in payload (payload.party.members). This should exist from BattleInit.");
  } else {
    // Optional resolution check
    let resolvedCount = 0;
    for (const m of partyMembers) {
      const actorUuid = String(m?.actorUuid ?? "").trim();
      const actorId = String(m?.actorId ?? "").trim();

      // Prefer actorUuid if present, else actorId
      let actorDoc = null;
      if (actorUuid) actorDoc = await safeFromUuid(actorUuid);
      else if (actorId) actorDoc = game.actors?.get?.(actorId) ?? null;

      if (!actorDoc || actorDoc.documentName !== "Actor") {
        warnings.push(`Party member slot ${m?.slot ?? "?"} cannot resolve to an Actor (uuid/id missing or invalid).`);
      } else {
        resolvedCount++;
      }
    }

    if (resolvedCount < 1) {
      errors.push("Party List exists, but none of the members resolve to real Actors anymore.");
    }
  }

  // Victory-only: EXP map must exist and contain numbers for at least one party member
  if (mode === "victory") {
    const expByActorId = (prompt && typeof prompt.expByActorId === "object" && !Array.isArray(prompt.expByActorId))
      ? prompt.expByActorId
      : null;

    if (!expByActorId) {
      errors.push("Victory mode requires payload.battleEnd.prompt.expByActorId, but it is missing/invalid.");
    } else {
      const entries = Object.entries(expByActorId);
      if (!entries.length) {
        errors.push("Victory mode requires expByActorId entries, but expByActorId is empty.");
      } else {
        // Ensure all values are numbers >= 0
        let numericCount = 0;
        let positiveCount = 0;

        for (const [actorId, v] of entries) {
          const n = safeNumber(v, NaN);
          if (!Number.isFinite(n) || n < 0) {
            errors.push(`Invalid EXP for actorId=${actorId}: "${v}" (must be a number >= 0)`);
          } else {
            numericCount++;
            if (n > 0) positiveCount++;
          }
        }

        // Warn if all are 0 (possible but usually unintended)
        if (numericCount > 0 && positiveCount === 0) {
          warnings.push("All EXP values are 0. This may be intended, but usually indicates missing EXP snapshot.");
        }
      }
    }

    // Also sanity check your Step8 snapshot exists (not required if prompt already has numbers, but helpful)
    const step8pcs = payload?.record?.step8?.expSnapshot?.pcs;
    if (!Array.isArray(step8pcs) || !step8pcs.length) {
      warnings.push("record.step8.expSnapshot.pcs is missing/empty. (Prompt EXP still works if expByActorId is set.)");
    }
  }

  // Combat-ended hint (not fatal)
  if (game.combat && game.combat.started && !game.combat.ended) {
    warnings.push("Combat is still marked as ongoing (game.combat.ended is false). Ensure battle truly ended.");
  }

  // --------------------------------------------------------------------------
  // Finalize gate result + save back to SOURCE scene
  // --------------------------------------------------------------------------
  payload.phases ??= {};
  payload.phases.battleEnd ??= {};
  payload.phases.battleEnd.gate = {
    status: errors.length ? "blocked" : "ok",
    at: nowIso(),
    errors,
    warnings
  };

  // Also keep a small convenience snapshot
  payload.battleEnd ??= {};
  payload.battleEnd.results ??= {};
  payload.battleEnd.results.gate = {
    status: payload.phases.battleEnd.gate.status,
    at: payload.phases.battleEnd.gate.at
  };

  await sourceScene.setFlag(STORE_SCOPE, CANONICAL_KEY, payload);
  await sourceScene.setFlag(STORE_SCOPE, BATTLEEND_KEY, payload.battleEnd);

  // --------------------------------------------------------------------------
  // Report (Notification + Chat card)
  // --------------------------------------------------------------------------
  if (errors.length) {
    ui.notifications?.error?.(`BattleEnd Gate BLOCKED: ${errors.length} issue(s). Check chat for details.`);
  }

  log("Gate result:", payload.phases.battleEnd.gate);

})();
