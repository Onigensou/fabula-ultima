// ============================================================================
// BattleEnd — Transition (Step 5) • Foundry VTT v12
// ----------------------------------------------------------------------------
// Mirrors BattleInit — Battle Transition (Step 4) but returns players BACK to
// the Return Scene / Source Scene.
//
// What this does:
// 1) Locate canonical payload (stored on SOURCE scene flag world.battleInit.latestPayload)
// 2) Resolve Return Scene (prefer BattleEnd Prompt selection; fallback to context.sourceSceneUuid)
// 3) Preload return scene assets for all connected users (reduces hitch)  [mirrors BattleInit]
// 4) STOP Victory BGM (if it was started by BattleEnd:FX, victory only)   [NEW]
// 5) Activate return scene
// 6) Pull all players to return scene (belt-and-suspenders)              [mirrors BattleInit]
// 7) Write back transition status into canonical payload
//
// Notes:
// - GM only.
// - Uses same “payload lives on SOURCE scene” reality as your BattleEnd Prompt/Gate.
// ============================================================================

(async () => {
  const DEBUG = false;

  const PAYLOAD_SCOPE = "world";
  const PAYLOAD_KEY   = "battleInit.latestPayload";

  // Optional: transition SFX (global via playlist if found)
  // If you don't want any SFX, set TRANSITION_SFX_TRACK_NAME = "".
  const TRANSITION_SFX_TRACK_NAME = ""; // e.g. "Victory_Fanfare.mp3" (playlist sound name)
  const TRANSITION_SFX_FALLBACK_URL = ""; // optional URL fallback if track not found

  // Optional Sequencer FX (if Sequencer + JB2A installed)
  const USE_SEQUENCER_FX = false;
  const SEQUENCER_FX_FILE = "jb2a.impact.ground_crack.orange";

  // Timing (feel free to tweak)
  const FX_DELAY_MS_BEFORE_SCENE = 600;
  const AFTER_ACTIVATE_DELAY_MS  = 250;

  const tag = "[BattleEnd:Transition:Step5]";
  const dlog = (...a) => DEBUG && console.log(tag, ...a);
  const warn = (...a) => console.warn(tag, ...a);

  // -----------------------------
  // Guards
  // -----------------------------
  if (!game.user?.isGM) {
    ui.notifications?.warn?.("BattleEnd: Transition is GM only.");
    return;
  }
  if (!canvas?.scene) {
    ui.notifications?.error?.("BattleEnd: No active scene.");
    return;
  }

  // -----------------------------
  // Helpers
  // -----------------------------
  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  function parseIsoToMs(iso) {
    const t = Date.parse(String(iso ?? ""));
    return Number.isFinite(t) ? t : 0;
  }

  async function resolveDocFromIdOrUuid(ref, docType) {
    if (!ref || typeof ref !== "string") return null;

    // UUID like "Scene.xxxxx"
    if (/^\s*[A-Za-z]+\./.test(ref.trim())) {
      return await fromUuid(ref.trim()).catch(() => null);
    }

    // Raw ID
    if (docType === "Scene") return game.scenes?.get(ref.trim()) ?? null;

    return null;
  }

  // NEW: same extraction logic as BattleEnd:FX uses
  function getVictoryBgmFromBattleEndPrompt(payload) {
    const mode = String(payload?.battleEnd?.meta?.mode ?? "").toLowerCase();
    const playMusic = !!payload?.battleEnd?.prompt?.bgm?.playMusic;
    const name = String(payload?.battleEnd?.prompt?.bgm?.name ?? "").trim();
    return { mode, playMusic, name };
  }

  // NEW: stop a specific playlist track by name across all playlists
  async function stopTrackFromAnyPlaylist(trackName) {
    const name = String(trackName ?? "").trim();
    if (!name) return { ok: false, reason: "no-track-name" };

    let stopped = false;

    for (const pl of (game.playlists ?? [])) {
      // 1) If it's in the "playing" list, stop that exact playing sound
      const playing = Array.isArray(pl.playing) ? pl.playing : [];
      for (const ps of playing) {
        const psName = String(ps?.name ?? "");
        if (psName === name) {
          try {
            await pl.stopSound(ps);
            stopped = true;
          } catch (e) {
            warn("stopSound failed (playing match):", { playlist: pl.name, sound: psName, e });
          }
        }
      }

      // 2) Also try lookup-by-name (safe even if not currently playing)
      const snd = pl.sounds?.getName?.(name);
      if (snd) {
        try {
          await pl.stopSound(snd);
          stopped = true;
        } catch (e) {
          warn("stopSound failed (lookup match):", { playlist: pl.name, sound: name, e });
        }
      }
    }

    return stopped ? { ok: true } : { ok: false, reason: "not-found-or-not-playing" };
  }

  // NEW: stop Victory BGM if BattleEnd FX started it
  async function stopVictoryBgmIfNeeded(payload) {
    const v = getVictoryBgmFromBattleEndPrompt(payload);

    // Only stop if we were in Victory mode AND music toggle is on AND a name exists
    if (v.mode === "victory" && v.playMusic && v.name) {
      const stopRes = await stopTrackFromAnyPlaylist(v.name);
      dlog("Stop Victory BGM:", { victoryBgmName: v.name, stopRes });
      return { requested: v, stop: stopRes };
    }

    dlog("Victory BGM stop skipped:", v);
    return { requested: v, stop: { ok: false, reason: "skipped" } };
  }

  async function playTrackFromAnyPlaylist(trackName) {
    const name = (trackName ?? "").trim();
    if (!name) return { ok: false, reason: "no-track-name" };

    // Stop currently playing playlist sounds
    await Promise.allSettled(
      (game.playlists ?? [])
        .filter(pl => pl.playing?.length)
        .map(pl => pl.stopAll())
    );

    for (const pl of (game.playlists ?? [])) {
      const snd = pl.sounds?.getName?.(name);
      if (snd) {
        await pl.playSound(snd);
        return { ok: true, playlist: pl.name, sound: snd.name };
      }
    }
    return { ok: false, reason: "not-found" };
  }

  async function playTransitionSfxGlobalIfPossible() {
    const name = (TRANSITION_SFX_TRACK_NAME ?? "").trim();
    if (!name) return;

    // Try playlist first (global)
    const res = await playTrackFromAnyPlaylist(name);
    if (res.ok) {
      dlog("Transition SFX played from playlist:", res);
      return;
    }

    // Fallback (local)
    const url = (TRANSITION_SFX_FALLBACK_URL ?? "").trim();
    if (!url) {
      dlog("Transition SFX not found and no fallback URL. Skipping.");
      return;
    }

    dlog("Transition SFX track not found in playlists; using fallback URL (GM-local):", url);
    try {
      await AudioHelper.play(
        { src: url, volume: 0.2, autoplay: true, loop: false },
        true
      );
    } catch (e) {
      warn("Transition SFX fallback failed:", e);
    }
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
      warn("Sequencer FX failed:", e);
    }
  }

  function pullAllPlayersToScene(sceneId) {
    const users = game.users?.filter(u => u.active && !u.isGM) ?? [];
    for (const u of users) {
      game.socket.emit("pullToScene", sceneId, u.id);
    }
    dlog("Pulled users:", users.map(u => ({ id: u.id, name: u.name })));
  }

  async function waitForCanvasNotLoading(timeoutMs = 15000) {
    const t0 = Date.now();
    while (canvas.loading) {
      if ((Date.now() - t0) > timeoutMs) {
        warn("waitForCanvasNotLoading: timed out; continuing anyway.");
        return false;
      }
      await wait(50);
    }
    return true;
  }

  // --------------------------------------------------------------------------
  // Locate canonical payload (payload is stored on SOURCE scene)
  // --------------------------------------------------------------------------
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
          bestMatch = { scene: s, payload: p, from: "scene-scan-match-step4.battleScene.id" };
          bestMatchMs = ms;
        }
      }
    }

    if (bestMatch) return bestMatch;

    const local = canvas.scene.getFlag(PAYLOAD_SCOPE, PAYLOAD_KEY);
    if (local) return { scene: canvas.scene, payload: local, from: "current-scene-flag" };

    const best = pickLatestPayloadAcrossScenes();
    if (best) return { scene: best.scene, payload: best.payload, from: "scene-scan-latest" };

    return null;
  }

  const located = locateSourceSceneAndPayloadForThisBattle();
  if (!located?.payload || !located?.scene) {
    ui.notifications?.error?.(`BattleEnd: No canonical payload found at ${PAYLOAD_SCOPE}.${PAYLOAD_KEY}.`);
    return;
  }

  const sourceScene = located.scene;
  const payload = located.payload;

  dlog("Located canonical payload ✅", {
    from: located.from,
    sourceScene: { id: sourceScene.id, name: sourceScene.name },
    activeScene: { id: canvas.scene.id, name: canvas.scene.name },
    battleId: payload?.meta?.battleId ?? "(missing)"
  });

  // --------------------------------------------------------------------------
  // Resolve Return Scene
  // Priority:
  //   1) BattleEnd Prompt selection
  //   2) Original Source Scene from BattleInit context
  // --------------------------------------------------------------------------
  function getReturnSceneRefFromPayload(p) {
    return (
      p?.battleEnd?.prompt?.returnSceneUuid ??
      p?.battleEnd?.prompt?.returnSceneId ??
      p?.battleEnd?.prompt?.returnScene ??
      p?.context?.sourceSceneUuid ??
      p?.context?.sourceSceneId ??
      p?.sourceSceneUuid ??
      p?.sourceSceneId ??
      null
    );
  }

  const returnSceneRef = getReturnSceneRefFromPayload(payload);
  dlog("Return scene ref from payload =", returnSceneRef);

  const returnSceneDoc = await resolveDocFromIdOrUuid(returnSceneRef, "Scene");
  if (!returnSceneDoc) {
    ui.notifications?.error?.(`BattleEnd: Return scene not found from payload (${returnSceneRef ?? "missing"}).`);
    return;
  }

  dlog("Resolved return scene:", { id: returnSceneDoc.id, name: returnSceneDoc.name, uuid: returnSceneDoc.uuid });

  // --------------------------------------------------------------------------
  // Preload return scene assets for all connected users (reduces load hitch)
  // Mirrors BattleInit transition preload call.
  // --------------------------------------------------------------------------
  try {
    dlog("Preloading return scene assets for all clients…", { id: returnSceneDoc.id, name: returnSceneDoc.name });
    await game.scenes.preload(returnSceneDoc.id);
    dlog("Preload request sent ✅");
  } catch (e) {
    warn("Scene preload failed (continuing):", e);
  }

  // --------------------------------------------------------------------------
  // NEW: Stop Victory BGM before the actual scene switch
  // --------------------------------------------------------------------------
  const stopVictoryRes = await stopVictoryBgmIfNeeded(payload);

  // --------------------------------------------------------------------------
  // Optional transition FX + SFX
  // --------------------------------------------------------------------------
  await playSequencerFxIfAvailable();
  await playTransitionSfxGlobalIfPossible();

  await wait(FX_DELAY_MS_BEFORE_SCENE);

  // --------------------------------------------------------------------------
  // Activate return scene
  // --------------------------------------------------------------------------
  try {
    await returnSceneDoc.activate();
  } catch (e) {
    warn("returnScene.activate() failed (continuing):", e);
  }

  // Wait for loading to settle (best-effort)
  await waitForCanvasNotLoading(15000);

  // Belt-and-suspenders: pull players after a small delay
  await wait(500);
  pullAllPlayersToScene(returnSceneDoc.id);

  await wait(AFTER_ACTIVATE_DELAY_MS);

  // --------------------------------------------------------------------------
  // Write back transition status
  // --------------------------------------------------------------------------
  payload.phases = payload.phases ?? {};
  payload.phases.battleEnd = payload.phases.battleEnd ?? {};
  payload.phases.battleEnd.transition = {
    status: "ok",
    at: nowIso(),
    details: {
      returnScene: { id: returnSceneDoc.id, name: returnSceneDoc.name, uuid: returnSceneDoc.uuid },
      victoryBgmStop: stopVictoryRes // NEW: record what we stopped (or skipped)
    }
  };

  payload.battleEnd = payload.battleEnd ?? {};
  payload.battleEnd.results = payload.battleEnd.results ?? {};
  payload.battleEnd.results.transition = {
    status: "ok",
    at: payload.phases.battleEnd.transition.at,
    returnScene: { id: returnSceneDoc.id, name: returnSceneDoc.name, uuid: returnSceneDoc.uuid }
  };

  await sourceScene.setFlag(PAYLOAD_SCOPE, PAYLOAD_KEY, payload);

  dlog("Saved payload.phases.battleEnd.transition ✅", payload.phases.battleEnd.transition);

  function nowIso() { return new Date().toISOString(); }
})();
