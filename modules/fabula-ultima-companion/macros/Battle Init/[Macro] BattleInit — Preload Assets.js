// ============================================================================
// BattleInit — Preload Assets (between Spawner and Entrance) • Foundry VTT v12
// ----------------------------------------------------------------------------
// Sits between Step 5b (Spawner) and the Entrance Animation step. Spawned
// tokens are already on the battle scene, but no Combat doc exists yet — so
// we build the asset manifest from the spawned TokenDocuments directly
// (their actor + items + token textures) and union it with the JS-hardcoded
// STATIC_BATTLE_URLS the asset-cache module exposes.
//
// We then run the cross-client prepare protocol exposed by
// `FUCompanion.api.animationCache.prepareUrlsAcrossClients`:
//   - GM kicks off local preload
//   - Broadcasts the URL list to every active non-GM client via socket
//   - Each player runs `preloadMany` locally, then ACKs
//   - GM resolves when every player ACK'd OR `combatPrepareTimeoutMs` elapsed
//
// On completion, write `payload.phases.preload = { status: "ok", at }` so the
// Manager's step-completion poll unblocks and proceeds to Entrance.
// ============================================================================

(async () => {
  const DEBUG = false;

  const PAYLOAD_SCOPE = "world";
  const PAYLOAD_KEY   = "battleInit.latestPayload";

  const tag = "[BattleInit:PreloadAssets]";
  const log = (...a) => DEBUG && console.log(tag, ...a);
  const warn = (...a) => console.warn(tag, ...a);

  const nowIso = () => new Date().toISOString();

  // BGM lookup — mirror of Battle Transition's helper so the BGM kicks in
  // as the curtain fades (cinematic reveal) rather than during the hold.
  function getBgmNameFromPayload(payload) {
    return (
      payload?.battleConfig?.bgm ??
      payload?.battleConfig?.battleBGM ??
      payload?.bgm ??
      payload?.battleBGM ??
      payload?.music?.bgm ??
      payload?.music?.battleBGM ??
      payload?.chosenBgm ??
      ""
    );
  }

  // Plays a playlist track by name, on every connected client (playlist
  // sounds are globally synchronized by Foundry). Mirrors Battle Transition's
  // helper of the same name.
  async function playTrackFromAnyPlaylist(trackName) {
    const name = (trackName ?? "").trim();
    if (!name) return { ok: false, reason: "no-track-name" };

    // Stop currently playing playlist sounds so the new BGM doesn't layer.
    await Promise.allSettled(
      game.playlists
        .filter(pl => pl.playing?.length)
        .map(pl => pl.stopAll())
    );

    for (const pl of game.playlists) {
      const snd = pl.sounds?.getName?.(name);
      if (snd) {
        await pl.playSound(snd);
        return { ok: true, playlist: pl.name, sound: snd.name };
      }
    }
    return { ok: false, reason: "not-found" };
  }

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
        null;

      if (transitionedBattleId && transitionedBattleId === currentSceneId) {
        return { payload: p, sourceScene: s };
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Guards
  // ---------------------------------------------------------------------------
  if (!game.user?.isGM) {
    ui.notifications?.warn?.("BattleInit: Preload Assets is GM only.");
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

  // ---------------------------------------------------------------------------
  // Collect URLs from the spawned tokens + the static battle manifest
  // ---------------------------------------------------------------------------
  const api = globalThis.FUCompanion?.api?.animationCache;
  if (!api?.prepareUrlsAcrossClients) {
    warn("animation cache API not loaded; marking step ok and skipping preload.");
    payload.phases ??= {};
    payload.phases.preload = {
      status: "ok",
      at: nowIso(),
      skipped: "no-api",
      urlCount: 0
    };
    await sourceScene.setFlag(PAYLOAD_SCOPE, PAYLOAD_KEY, payload);
    return;
  }

  const spawnInfo = payload?.spawn?.step5b ?? {};
  const partyIds = Array.isArray(spawnInfo.partyTokenIds) ? spawnInfo.partyTokenIds : [];
  const enemyIds = Array.isArray(spawnInfo.enemyTokenIds) ? spawnInfo.enemyTokenIds : [];
  const allIds = new Set([...partyIds, ...enemyIds].filter(Boolean));

  const urls = new Set(Array.from(api.STATIC_BATTLE_URLS ?? []));

  const sceneTokens = canvas.scene.tokens?.contents ?? [];
  let scannedTokens = 0;
  for (const tokenDoc of sceneTokens) {
    if (!allIds.has(tokenDoc.id)) continue;
    scannedTokens++;
    try {
      for (const url of api.extractAssetUrlsFromToken(tokenDoc)) urls.add(url);
    } catch (e) {
      warn("extractAssetUrlsFromToken failed for", tokenDoc?.id, e);
    }
  }

  log("manifest built", {
    scannedTokens,
    totalUrls: urls.size,
    expectedTokens: allIds.size
  });

  // ---------------------------------------------------------------------------
  // Run the prepare protocol (broadcast + wait for ACKs or timeout)
  // ---------------------------------------------------------------------------
  ui.notifications?.info?.("Preparing battle assets…");

  const runId = payload?.phases?.entrance?.runId
    ?? payload?.phases?.cameraLock?.runId
    ?? `battleInit-${Date.now()}`;

  // The black curtain is already up — Battle Transition raised it (and
  // broadcast to players) before the scene activate. So we DON'T pass
  // fadeOverlay here; we just run the preload protocol behind the existing
  // curtain, then drop it explicitly at the bottom of this macro.
  let result = null;
  try {
    result = await api.prepareUrlsAcrossClients([...urls], {
      label: `battleInit:${runId}`,
      reason: "battleInit-preload"
    });
  } catch (e) {
    warn("prepareUrlsAcrossClients threw — marking ok and proceeding", e);
  }

  // Kick off battle BGM in parallel with the curtain drop so the music starts
  // at the same instant the fade-out begins (cinematic reveal). Fire-and-
  // forget: playSound updates the playlist document and broadcasts, which can
  // take ~100ms — awaiting would delay the curtain unnecessarily. Failures
  // surface as a notification but never block the reveal.
  const bgmName = (getBgmNameFromPayload(payload) ?? "").trim();
  if (bgmName) {
    playTrackFromAnyPlaylist(bgmName)
      .then(res => {
        if (!res?.ok) {
          ui.notifications?.warn?.(`BattleInit: BGM track not found in playlists: "${bgmName}"`);
        } else {
          log("BGM playing:", res);
        }
      })
      .catch(e => warn("BGM start failed (non-fatal)", e));
  }

  // Drop the curtain on every client. Fade-out is the user-visible reveal,
  // so we give it a gentler duration than the implicit-prepare fade.
  try {
    await api.dropCurtain({
      fadeOutMs: 600,
      broadcast: true
    });
  } catch (e) {
    warn("dropCurtain failed (non-fatal)", e);
  }

  if (result?.timedOut) {
    ui.notifications?.warn?.(
      `Some clients didn't finish preloading in time (${(result.missingNames ?? []).join(", ")}). Proceeding to entrance.`
    );
  }

  // ---------------------------------------------------------------------------
  // Mark step complete (the Manager's `stepMarker("preload")` reads this)
  // ---------------------------------------------------------------------------
  payload.phases ??= {};
  payload.phases.preload = {
    status: "ok",
    at: nowIso(),
    urlCount: urls.size,
    scannedTokens,
    timedOut: !!result?.timedOut,
    missing: result?.missingNames ?? [],
    ackedUserCount: Array.isArray(result?.ackedUserIds) ? result.ackedUserIds.length : 0,
    localOnly: !!result?.localOnly
  };

  await sourceScene.setFlag(PAYLOAD_SCOPE, PAYLOAD_KEY, payload);

  log("Preload step complete", payload.phases.preload);
})();
