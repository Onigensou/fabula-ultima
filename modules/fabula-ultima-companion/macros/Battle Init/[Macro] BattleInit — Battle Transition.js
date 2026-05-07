// ============================================================================
// BattleInit — Battle Transition (Step 4)  • Foundry VTT v12
// ----------------------------------------------------------------------------
// What this does:
// 1) Reads the latest BattleInit payload from the ACTIVE scene flag
// 2) Resolves the battle scene
// 3) Plays transition FX (Sequencer optional) + SFX (playlist optional)
// 4) Activates battle scene and pulls all players to it
// 5) Plays battle BGM (by track name, searched across all playlists)
// 6) Writes back transition status into the same payload flag
//
// Requires from earlier steps:
// - Payload stored at: canvas.scene.getFlag("world", "battleInit.latestPayload")
// - Payload contains (at minimum): battle map scene UUID/ID, and chosen BGM name (optional)
//
// Notes:
// - "Pull players" uses the core socket event: game.socket.emit("pullToScene", sceneId, userId)
//   (widely used in community macros; referenced by Foundry issue discussion). :contentReference[oaicite:0]{index=0}
// ============================================================================

(async () => {
  const DEBUG = false;

  const PAYLOAD_SCOPE = "world";
  const PAYLOAD_KEY   = "battleInit.latestPayload";

  // Optional: if you want a global (everyone hears it) transition SFX,
  // put the sound in ANY playlist and set this to its exact Sound name.
  // If not found, we fallback to local AudioHelper URL (GM-only audible).
  const TRANSITION_SFX_TRACK_NAME = "Random_Battle.mp3";
  const TRANSITION_SFX_FALLBACK_URL = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Random_Battle.mp3";

  // Optional Sequencer FX (if Sequencer + JB2A installed)
  const USE_SEQUENCER_FX = true;
  const SEQUENCER_FX_FILE = "jb2a.impact.ground_crack.orange";

  // Timing (feel free to tweak)
  const FX_DELAY_MS_BEFORE_SCENE = 900;
  const AFTER_ACTIVATE_DELAY_MS  = 250;

  const tag = "[BattleInit:BattleTransition:Step4]";

  // -----------------------------
  // Guards
  // -----------------------------
  if (!game.user?.isGM) {
    ui.notifications?.warn?.("BattleInit: Step 4 is GM only.");
    return;
  }
  if (!canvas?.scene) {
    ui.notifications?.error?.("BattleInit: No active scene.");
    return;
  }

  // -----------------------------
  // Helpers
  // -----------------------------
  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  function dlog(...args) {
    if (DEBUG) console.log(tag, ...args);
  }

  async function resolveDocFromIdOrUuid(ref, docType) {
    if (!ref || typeof ref !== "string") return null;

    // If it's a UUID like "Scene.xxxxx" or "RollTable.xxxxx"
    if (/^\s*[A-Za-z]+\./.test(ref.trim())) {
      return await fromUuid(ref.trim()).catch(() => null);
    }

    // If it's a raw ID
    if (docType === "Scene") return game.scenes?.get(ref.trim()) ?? null;
    if (docType === "RollTable") return game.tables?.get(ref.trim()) ?? null;

    return null;
  }

  async function playTrackFromAnyPlaylist(trackName) {
    const name = (trackName ?? "").trim();
    if (!name) return { ok: false, reason: "no-track-name" };

    // Stop currently playing playlist sounds
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

  async function playTransitionSfxGlobalIfPossible() {
    // Try playlist first (global)
    const res = await playTrackFromAnyPlaylist(TRANSITION_SFX_TRACK_NAME);
    if (res.ok) {
      dlog("Transition SFX played from playlist:", res);
      return;
    }

    // Fallback (local)
    dlog("Transition SFX track not found in playlists; using fallback URL (GM-local):", TRANSITION_SFX_FALLBACK_URL);
    try {
      await AudioHelper.play(
        { src: TRANSITION_SFX_FALLBACK_URL, volume: 0.2, autoplay: true, loop: false },
        true
      );
    } catch (e) {
      console.warn(tag, "Transition SFX fallback failed:", e);
    }
  }

    function getBattleSceneRefFromPayload(payload) {
    // Current BattleInit payload stores this under battleConfig (and also sometimes context)
    return (
      payload?.battleConfig?.battleSceneUuid ??
      payload?.context?.battleSceneUuid ??
      payload?.battleSceneUuid ??
      payload?.battleMapSceneUuid ??
      payload?.battleMap ??
      payload?.battleScene ??
      payload?.sceneUuid ??
      payload?.sceneId ??
      null
    );
  }

    function getBgmNameFromPayload(payload) {
    // BattleInit stores chosen BGM inside battleConfig
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

  function pullAllPlayersToScene(sceneId) {
    const users = game.users?.filter(u => u.active && !u.isGM) ?? [];
    for (const u of users) {
      // Core socket event used by Foundry to pull users to a scene. :contentReference[oaicite:1]{index=1}
      game.socket.emit("pullToScene", sceneId, u.id);
    }
    dlog("Pulled users:", users.map(u => ({ id: u.id, name: u.name })));
  }

  async function playSequencerFxIfAvailable() {
    if (!USE_SEQUENCER_FX) return;
    if (!globalThis.Sequence) {
      dlog("Sequencer not found; skipping visual FX.");
      return;
    }
    try {
      const w = canvas.app?.renderer?.width ?? window.innerWidth ?? 1000;
      const h = canvas.app?.renderer?.height ?? window.innerHeight ?? 700;

      new Sequence()
        .effect()
          .file(SEQUENCER_FX_FILE)
          .atLocation({ x: Math.floor(w / 2), y: Math.floor(h / 2) })
          .scale(7)
          .screenSpaceAboveUI()
        .play();

      dlog("Sequencer FX played:", SEQUENCER_FX_FILE);
    } catch (e) {
      console.warn(tag, "Sequencer FX failed:", e);
    }
  }

    async function waitForCanvasNotLoading(timeoutMs = 15000) {
    const t0 = Date.now();
    while (canvas.loading) {
      if ((Date.now() - t0) > timeoutMs) {
        console.warn(tag, "waitForCanvasNotLoading: timed out; continuing anyway.");
        return false;
      }
      await wait(50);
    }
    return true;
  }


  // -----------------------------
  // Load Payload (from active scene)
  // -----------------------------
  const activeScene = canvas.scene;
  const payload = activeScene.getFlag(PAYLOAD_SCOPE, PAYLOAD_KEY);

  if (!payload) {
    ui.notifications?.error?.("BattleInit: No payload found. Run Step 1 → Step 3 first.");
    return;
  }

  dlog("Loaded payload:", payload);

  // -----------------------------
  // Resolve Battle Scene
  // -----------------------------
  const battleSceneRef = getBattleSceneRefFromPayload(payload);
  dlog("Battle scene ref from payload =", battleSceneRef);
  const battleSceneDoc = await resolveDocFromIdOrUuid(battleSceneRef, "Scene");

  if (!battleSceneDoc) {
    ui.notifications?.error?.(`BattleInit: Battle scene not found from payload (${battleSceneRef ?? "missing"}).`);
    return;
  }

  const battleBgmName = getBgmNameFromPayload(payload);
  dlog("Resolved battle scene:", { id: battleSceneDoc.id, name: battleSceneDoc.name, uuid: battleSceneDoc.uuid });
  dlog("BGM chosen:", battleBgmName || "(none)");

  // -----------------------------
  // Preload battle scene assets for all connected users (reduces load hitch)
  // -----------------------------
  try {
    dlog("Preloading battle scene assets for all clients…", { id: battleSceneDoc.id, name: battleSceneDoc.name });
    await game.scenes.preload(battleSceneDoc.id);
    dlog("Preload request sent ✅");
  } catch (e) {
    console.warn(tag, "Scene preload failed (continuing):", e);
  }

  // -----------------------------
  // Transition FX + SFX
  // -----------------------------
  await playSequencerFxIfAvailable();
  await playTransitionSfxGlobalIfPossible();

  await wait(FX_DELAY_MS_BEFORE_SCENE);

    // -----------------------------
  // Activate (single switch) + Pull Players (optional)
  // -----------------------------
  try {
    await battleSceneDoc.activate(); // Activating already causes users to load into the active scene
    
      async function waitForCanvasNotLoading(timeoutMs = 15000) {
    const t0 = Date.now();
    while (canvas.loading) {
      if ((Date.now() - t0) > timeoutMs) {
        console.warn(tag, "waitForCanvasNotLoading: timed out; continuing anyway.");
        return false;
      }
      await wait(50);
    }
    return true;
  }

  } catch (e) {
    console.warn(tag, "battleScene.activate() failed (continuing):", e);
  }

  // OPTIONAL:
  // If you want to keep your manual pull as a “belt and suspenders”, delay it a bit
  // so you don’t spam scene-switch requests while clients are still starting to load.
  await wait(500);
  pullAllPlayersToScene(battleSceneDoc.id);

  await wait(AFTER_ACTIVATE_DELAY_MS);

  // -----------------------------
  // Play Battle BGM (optional)
  // -----------------------------
  if (battleBgmName?.trim()) {
    const res = await playTrackFromAnyPlaylist(battleBgmName.trim());
    if (!res.ok) ui.notifications?.warn?.(`BattleInit: BGM track not found in playlists: "${battleBgmName.trim()}"`);
    else dlog("BGM playing:", res);
  }

  // -----------------------------
  // Write back transition status
  // -----------------------------
  const nextPayload = foundry.utils.deepClone(payload);
  nextPayload.step4 = {
    ok: true,
    transitionedAt: Date.now(),
    battleScene: {
      id: battleSceneDoc.id,
      name: battleSceneDoc.name,
      uuid: battleSceneDoc.uuid
    }
  };

    await activeScene.setFlag(PAYLOAD_SCOPE, PAYLOAD_KEY, nextPayload);

  dlog("Saved payload.step4:", nextPayload.step4);
})();
