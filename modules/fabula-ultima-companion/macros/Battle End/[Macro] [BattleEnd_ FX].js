// ============================================================================
// BattleEnd — FX (Step 3) • Foundry VTT v12
// ----------------------------------------------------------------------------
// Does "end-of-battle presentation + cleanup":
//  1) End active combat automatically (no Foundry confirm dialog)
//  2) Stop Battle BGM (from BattleInit payload)
//  3) Play Victory BGM (from BattleEnd Prompt payload, victory only)
//  4) Simple camera FX: lock player camera input, pan+zoom to random PC, then unlock
//
// Storage:
//  - Canonical payload: SceneFlag world.battleInit.latestPayload (stored on SOURCE scene)
//  - BattleEnd slice  : SceneFlag world.battleEnd.latest
//
// Notes:
//  - This macro is GM-only.
//  - It searches ALL scenes for the canonical payload that matches the CURRENT battle scene,
//    because the canonical payload lives on the SOURCE scene, not the battle scene.
// ============================================================================

(async () => {
  const DEBUG = false;

  // -----------------------------
  // Multi-client Socket channel
  // -----------------------------
  const MODULE_ID = "fabula-ultima-companion";
  const SOCKET_CHANNEL = `module.${MODULE_ID}`;

  const STORE_SCOPE = "world";
  const CANONICAL_KEY = "battleInit.latestPayload";
  const BATTLEEND_KEY = "battleEnd.latest";

  const tag = "[BattleEnd:FX]";
  const log = (...a) => DEBUG && console.log(tag, ...a);
  const warn = (...a) => console.warn(tag, ...a);
  const error = (...a) => console.error(tag, ...a);

  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const nowIso = () => new Date().toISOString();

  // -----------------------------
  // Socket helper: broadcast camera FX to all clients
  // -----------------------------
  function makeRunId(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  }

  function emitCameraFxToAllClients({ sceneId, payload }) {
    try {
      if (!game.socket) return { ok: false, reason: "no-game-socket" };
      if (!SOCKET_CHANNEL) return { ok: false, reason: "no-socket-channel" };

      const msg = {
        type: "ONI_BATTLEEND_FX_CAMERA",
        sceneId: String(sceneId ?? ""),
        payload
      };

      game.socket.emit(SOCKET_CHANNEL, msg);
      return { ok: true, channel: SOCKET_CHANNEL };
    } catch (e) {
      warn("Socket emit failed:", e);
      return { ok: false, reason: "emit-failed", error: e?.message ?? String(e) };
    }
  }

  // -----------------------------
  // Guards
  // -----------------------------
  if (!game.user?.isGM) {
    ui.notifications?.warn?.("BattleEnd: FX is GM only.");
    return;
  }
  if (!canvas?.scene) {
    ui.notifications?.error?.("BattleEnd: No active scene.");
    return;
  }

  // -----------------------------
  // Helpers: locate canonical payload that matches CURRENT battle scene
  // -----------------------------
  function parseIsoToMs(iso) {
    const t = Date.parse(String(iso ?? ""));
    return Number.isFinite(t) ? t : 0;
  }

  function isMatchForBattleScene(payload, battleScene) {
    if (!payload || !battleScene) return false;

    const battleSceneId = String(battleScene.id ?? "");
    const battleSceneUuid = String(battleScene.uuid ?? "");

    const pStep4Id = String(payload?.step4?.battleScene?.id ?? "");
    const pStep4Uuid = String(payload?.step4?.battleScene?.uuid ?? "");
    const pCtxId = String(payload?.context?.battleSceneId ?? "");
    const pCtxUuid = String(payload?.context?.battleSceneUuid ?? "");

    if (battleSceneId && (pStep4Id === battleSceneId || pCtxId === battleSceneId)) return true;
    if (battleSceneUuid && (pStep4Uuid === battleSceneUuid || pCtxUuid === battleSceneUuid)) return true;

    return false;
  }

  function pickBestMatchingPayloadAcrossScenes(battleScene) {
    let best = null;

    for (const s of (game.scenes?.contents ?? [])) {
      const p = s.getFlag(STORE_SCOPE, CANONICAL_KEY);
      if (!p) continue;
      if (!isMatchForBattleScene(p, battleScene)) continue;

      const createdAtMs =
        parseIsoToMs(p?.battleEnd?.meta?.createdAt) ||
        parseIsoToMs(p?.meta?.createdAt) ||
        Number(p?.step4?.transitionedAt ?? 0) ||
        0;

      if (!best || createdAtMs > best.createdAtMs) {
        best = { sourceScene: s, payload: p, createdAtMs };
      }
    }

    return best; // can be null
  }

  function getBattleBgmNameFromPayload(payload) {
    // Mirrors BattleInit Transition logic (battleConfig.bgm + fallbacks)
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

  function getVictoryBgmFromBattleEndPrompt(payload) {
    const mode = String(payload?.battleEnd?.meta?.mode ?? "").toLowerCase();
    const playMusic = !!payload?.battleEnd?.prompt?.bgm?.playMusic;
    const name = String(payload?.battleEnd?.prompt?.bgm?.name ?? "").trim();
    return { mode, playMusic, name };
  }

  async function stopTrackFromAnyPlaylist(trackName) {
    const name = String(trackName ?? "").trim();
    if (!name) return { ok: false, reason: "no-track-name" };

    let stopped = false;

    for (const pl of (game.playlists ?? [])) {
      // First: stop anything currently playing that matches by name
      const playing = Array.isArray(pl.playing) ? pl.playing : [];
      for (const ps of playing) {
        // ps is usually a PlaylistSound doc
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

      // Second: if not in playing list, try direct lookup by name
      const snd = pl.sounds?.getName?.(name);
      if (snd) {
        try {
          // stopSound is safe even if not currently playing
          await pl.stopSound(snd);
          stopped = true;
        } catch (e) {
          warn("stopSound failed (lookup match):", { playlist: pl.name, sound: name, e });
        }
      }
    }

    return stopped ? { ok: true } : { ok: false, reason: "not-found-or-not-playing" };
  }

  async function playTrackFromAnyPlaylist(trackName) {
    const name = String(trackName ?? "").trim();
    if (!name) return { ok: false, reason: "no-track-name" };

    // Stop currently playing playlist sounds (so victory music starts clean)
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

  async function endActiveCombatSilently() {
    const active = game.combats?.active ?? game.combat ?? null;
    if (!active) return { ok: true, didEnd: false };

    try {
      // This deletes the active combat encounter without the default confirm dialog.
      await active.delete();
      return { ok: true, didEnd: true };
    } catch (e) {
      warn("Failed to delete active combat (continuing):", e);
      return { ok: false, didEnd: false, error: e?.message ?? String(e) };
    }
  }

  // -----------------------------
  // Helper: temporary input lock overlay
  // -----------------------------
  function installInputLock() {
    const id = "oni-battleend-fx-lock";
    if (document.getElementById(id)) return () => {};

    const el = document.createElement("div");
    el.id = id;
    el.style.position = "fixed";
    el.style.left = "0";
    el.style.top = "0";
    el.style.right = "0";
    el.style.bottom = "0";
    el.style.zIndex = "999999";
    el.style.pointerEvents = "all";
    el.style.background = "transparent";
    document.body.appendChild(el);

    const stopKeys = (ev) => {
      // Prevent common camera controls
      const k = String(ev.key ?? "").toLowerCase();
      const blocked = new Set([
        "arrowup","arrowdown","arrowleft","arrowright",
        "w","a","s","d",
        "+","-","=",
        "pageup","pagedown","home","end"
      ]);
      if (blocked.has(k)) {
        ev.preventDefault();
        ev.stopPropagation();
      }
    };

    const stopWheel = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
    };

    window.addEventListener("keydown", stopKeys, true);
    window.addEventListener("wheel", stopWheel, { capture: true, passive: false });

    return () => {
      try { window.removeEventListener("keydown", stopKeys, true); } catch (_) {}
      try { window.removeEventListener("wheel", stopWheel, true); } catch (_) {}
      try { el.remove(); } catch (_) {}
    };
  }

  async function computeCameraFxPlan() {
    // Pick a random "PC-ish" token on the current scene
    const candidates = (canvas.tokens?.placeables ?? []).filter(t => {
      const a = t?.actor;
      if (!a) return false;
      // hasPlayerOwner is a good generic PC indicator
      if (!a.hasPlayerOwner) return false;
      return true;
    });

    const token = candidates.length
      ? candidates[Math.floor(Math.random() * candidates.length)]
      : null;

    if (!token) {
      log("No PC token candidates found; skipping camera FX.");
      return { ok: true, skipped: true, reason: "no-pc-token" };
    }

    const center = token.center;

    // Pan slightly to the right of the chosen token and zoom in
    const target = {
      x: Math.floor(center.x + 220),
      y: Math.floor(center.y),
      scale: 1.7
    };

    const plan = {
      runId: makeRunId("battleend_fx_cam"),
      durationMs: 3200,
      holdMs: 450,
      target
    };

    log("Camera FX plan:", { token: { id: token.id, name: token.name }, plan });

    return { ok: true, skipped: false, token: { id: token.id, name: token.name }, plan };
  }

  async function runLocalCameraFx(plan) {
    const unlock = installInputLock();
    try {
      if (!plan?.target) return { ok: true, skipped: true, reason: "no-target" };

      await canvas.animatePan({
        x: plan.target.x,
        y: plan.target.y,
        scale: plan.target.scale,
        duration: plan.durationMs
      });

      await wait(plan.holdMs);
      return { ok: true, skipped: false };
    } catch (e) {
      warn("Camera FX failed (continuing):", e);
      return { ok: false, error: e?.message ?? String(e) };
    } finally {
      unlock();
    }
  }

  // -----------------------------
  // Load canonical payload (from SOURCE scene)
  // -----------------------------
  const battleScene = canvas.scene;
  const found = pickBestMatchingPayloadAcrossScenes(battleScene);

  if (!found?.payload || !found?.sourceScene) {
    ui.notifications?.error?.(
      "BattleEnd: No canonical payload found for this battle scene. (Expected world.battleInit.latestPayload on SOURCE scene)"
    );
    error("Missing canonical payload for current battle scene:", { battleScene: { id: battleScene.id, name: battleScene.name, uuid: battleScene.uuid } });
    return;
  }

  const sourceScene = found.sourceScene;
  const payload = found.payload;

  log("Loaded canonical payload ✅", { fromScene: { id: sourceScene.id, name: sourceScene.name }, battleScene: { id: battleScene.id, name: battleScene.name } });

  // -----------------------------
  // 1) End Combat (silently)
  // -----------------------------
  const combatRes = await endActiveCombatSilently();
  if (combatRes.didEnd) {
    // (Removed: confirmation toast)
  }

  // -----------------------------
  // 2) Stop Battle BGM (from BattleInit payload)
  // -----------------------------
  const battleBgmName = String(getBattleBgmNameFromPayload(payload) ?? "").trim();
  let stopBattleBgmRes = { ok: false, reason: "no-battle-bgm" };

  if (battleBgmName) {
    stopBattleBgmRes = await stopTrackFromAnyPlaylist(battleBgmName);
    log("Stop Battle BGM:", { battleBgmName, stopBattleBgmRes });
  } else {
    log("No Battle BGM name found in payload; skipping stop.");
  }

  // -----------------------------
  // 3) Play Victory BGM (from BattleEnd Prompt)
  // -----------------------------
  const v = getVictoryBgmFromBattleEndPrompt(payload);
  let playVictoryRes = { ok: false, reason: "skipped" };

  if (v.mode === "victory" && v.playMusic && v.name) {
    playVictoryRes = await playTrackFromAnyPlaylist(v.name);
        if (!playVictoryRes.ok) {
      ui.notifications?.warn?.(`BattleEnd: Victory BGM not found in playlists: "${v.name}"`);
    } else {
      // (Removed: confirmation toast)
    }
  } else {
    log("Victory BGM skipped by mode/toggle/name:", v);
  }

  // -----------------------------
  // 4) Camera FX (optional toggle from prompt)
  // -----------------------------
  const playAnim = !!payload?.battleEnd?.prompt?.fx?.playAnimation;
  let camRes = { ok: true, skipped: true };

  if (playAnim) {
    const planRes = await computeCameraFxPlan();

    if (planRes?.skipped) {
      camRes = { ok: true, skipped: true, reason: planRes?.reason ?? "skipped" };
    } else {
      const plan = planRes?.plan;

      // Broadcast so every connected client runs the same camera pan locally
      const broadcastRes = emitCameraFxToAllClients({
        sceneId: canvas.scene.id,
        payload: {
          lockId: plan.runId,
          durationMs: plan.durationMs,
          holdMs: plan.holdMs,
          target: plan.target
        }
      });

      // Run locally too (important: sockets may not echo back to the sender)
      const localRes = await runLocalCameraFx(plan);

      camRes = {
        ok: !!localRes?.ok,
        skipped: false,
        token: planRes?.token ?? null,
        plan,
        local: localRes,
        broadcast: broadcastRes
      };
    }
  } else {
    log("Camera FX skipped (playAnimation=false).");
  }

  // -----------------------------
  // Write back phase status
  // -----------------------------
  const next = foundry.utils.deepClone(payload);
  next.phases ??= {};
  next.phases.battleEnd ??= {};
  next.phases.battleEnd.fx = {
    status: "ok",
    at: nowIso(),
    details: {
      combat: combatRes,
      battleBgm: { name: battleBgmName, stop: stopBattleBgmRes },
      victoryBgm: { mode: v.mode, requested: v.name, play: playVictoryRes },
      camera: camRes
    }
  };

  next.battleEnd = next.battleEnd ?? {};
  next.battleEnd.fx = next.phases.battleEnd.fx;

  await sourceScene.setFlag(STORE_SCOPE, CANONICAL_KEY, next);
  await sourceScene.setFlag(STORE_SCOPE, BATTLEEND_KEY, next.battleEnd);

  log("Saved phases.battleEnd.fx ✅", next.phases.battleEnd.fx);
})();
