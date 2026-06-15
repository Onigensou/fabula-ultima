// Battle End Transition — stops victory BGM, activates return scene, pulls players.
//
// Also emits + applies the camera reset so everyone lands on the same view.
// Uses FUCompanion.api.animationCache for curtain (raiseCurtain/dropCurtain).

import { log, warn } from "../logger.js";

const MODULE_ID      = "fabula-ultima-companion";
const SOCKET_CHANNEL = `module.${MODULE_ID}`;

const CAMERA_RESET_VIEW = { x: 771, y: 339, scale: 1.2687237223069694, durationMs: 250 };

const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function stopTrackFromAnyPlaylist(trackName) {
  const name = String(trackName ?? "").trim();
  if (!name) return;
  for (const pl of (game.playlists ?? [])) {
    const playing = Array.isArray(pl.playing) ? pl.playing : [];
    for (const ps of playing) {
      if (String(ps?.name ?? "") === name) {
        try { await pl.stopSound(ps); } catch (_) {}
      }
    }
    const snd = pl.sounds?.getName?.(name);
    if (snd) { try { await pl.stopSound(snd); } catch (_) {} }
  }
}

async function waitForCanvasReady(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!canvas?.loading) return true;
    await wait(150);
  }
  return false;
}

export async function runBattleEndTransition(endCtx) {
  const { promptResult } = endCtx;
  const { returnSceneId, bgm, outcome } = promptResult;

  // 1) Stop victory BGM before scene switch
  if (outcome === "victory" && bgm.playMusic && bgm.name) {
    try {
      await stopTrackFromAnyPlaylist(bgm.name);
    } catch (e) {
      warn("[BattleEnd:Transition] Stop victory BGM threw (continuing):", e);
    }
  }

  // 2) Drop curtain
  try {
    await FUCompanion.api.animationCache.dropCurtain();
  } catch (e) {
    warn("[BattleEnd:Transition] dropCurtain threw (continuing):", e);
  }

  // 3) Activate return scene
  const returnScene = returnSceneId ? game.scenes?.get?.(returnSceneId) : null;
  if (!returnScene) {
    warn("[BattleEnd:Transition] No return scene found for id:", returnSceneId);
  } else {
    try {
      await returnScene.activate();
      log("[BattleEnd:Transition] Return scene activated:", returnScene.name);
    } catch (e) {
      warn("[BattleEnd:Transition] scene.activate() threw:", e);
    }

    // 4) Wait for canvas
    await waitForCanvasReady();

    // 5) Pull all online non-GM players to the return scene
    const onlinePlayers = (game.users?.contents ?? []).filter(u => u.active && !u.isGM);
    for (const u of onlinePlayers) {
      try {
        game.socket.emit("pullToScene", returnScene.id, u.id);
      } catch (e) {
        warn(`[BattleEnd:Transition] pullToScene failed for ${u.name}:`, e);
      }
    }
  }

  // 6) Camera reset — broadcast to all clients, apply locally
  const { x, y, scale, durationMs } = CAMERA_RESET_VIEW;
  try {
    game.socket.emit(SOCKET_CHANNEL, {
      type: "ONI_BATTLEEND_CAMERA_RESET",
      sceneId: canvas.scene?.id ?? "",
      payload: CAMERA_RESET_VIEW,
    });
  } catch (e) {
    warn("[BattleEnd:Transition] Camera reset socket emit threw:", e);
  }

  try {
    canvas.animatePan({ x, y, scale, duration: durationMs });
    if (canvas.scene) canvas.scene._viewPosition = { x, y, scale };
  } catch (e) {
    warn("[BattleEnd:Transition] Local camera reset threw:", e);
  }

  // 7) Raise curtain
  try {
    await FUCompanion.api.animationCache.raiseCurtain();
  } catch (e) {
    warn("[BattleEnd:Transition] raiseCurtain threw (continuing):", e);
  }

  log("[BattleEnd:Transition] Complete");
}
