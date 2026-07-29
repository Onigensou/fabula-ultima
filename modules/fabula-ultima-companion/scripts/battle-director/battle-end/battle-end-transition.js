// Battle End Transition — stops victory BGM, activates return scene, pulls players.
//
// Camera restore sequence (two independent resets):
//
//   After raiseCurtain (screen black, still on battle scene):
//     → Reset battle scene _viewPosition to its initial capture (undoes FX pan).
//       Broadcast via CAMERA_RESET so all clients silently fix their stored view.
//
//   After waitForCanvasReady (canvas is now on return scene):
//     → Restore pre-battle viewport via animatePan + _viewPosition.
//       Broadcast via CAMERA_RESET so all clients land on the same view.
//
// Both viewports are captured at PREP time and passed via endCtx.

import { log, warn } from "../logger.js";

const MODULE_ID      = "fabula-ultima-companion";
const SOCKET_CHANNEL = `module.${MODULE_ID}`;

// NOT a presentation dwell — deliberately NOT presentation-clock's `pWait`.
// The only use is the poll interval inside waitForCanvasReady(), and a wait
// that collapses to zero while the window is hidden would turn that loop into
// a busy-spin pegging a core until its 8 s deadline. Keep it a real delay.
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

function emitCameraReset(sceneId, x, y, scale, durationMs = 0) {
  try {
    game.socket.emit(SOCKET_CHANNEL, {
      type: "ONI_BATTLEEND_CAMERA_RESET",
      sceneId,
      payload: { x, y, scale, durationMs },
    });
  } catch (e) {
    warn("[BattleEnd:Transition] Camera reset socket emit threw:", e);
  }
}

export async function runBattleEndTransition(endCtx) {
  const { promptResult, battleSceneId, preBattleCamera, battleSceneViewport } = endCtx;
  const { returnSceneId, bgm, outcome } = promptResult;

  // 1) Black out all clients instantly.
  //    raiseCurtain = opaque black overlay; dropCurtain = reveal (fade in).
  try {
    await FUCompanion.api.animationCache.raiseCurtain({ broadcast: true });
  } catch (e) {
    warn("[BattleEnd:Transition] raiseCurtain threw (continuing):", e);
  }

  // 2) Reset battle scene camera — screen is black and canvas still on battle scene.
  //    Undoes the FX camera pan so the battle scene starts correctly next run.
  if (battleSceneViewport && battleSceneId) {
    const { x, y, scale } = battleSceneViewport;
    // Local: just overwrite _viewPosition (no animation needed, screen is black)
    try {
      const battleScene = game.scenes?.get?.(battleSceneId);
      if (battleScene) battleScene._viewPosition = { x, y, scale };
    } catch (e) {
      warn("[BattleEnd:Transition] Local battle scene _viewPosition reset threw:", e);
    }
    // Broadcast: clients set _viewPosition on battle scene silently (listener
    // skips animatePan when sceneId !== current scene, or durationMs:0 if still on it)
    emitCameraReset(battleSceneId, x, y, scale, 0);
  }

  // 3) Stop victory BGM while screen is black
  if (outcome === "victory" && bgm.playMusic && bgm.name) {
    try {
      await stopTrackFromAnyPlaylist(bgm.name);
    } catch (e) {
      warn("[BattleEnd:Transition] Stop victory BGM threw (continuing):", e);
    }
  }

  // 4) Activate return scene
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

    // 5) Wait for canvas to finish loading the new scene
    await waitForCanvasReady();

    // 6) Pull all online non-GM players to the return scene
    const onlinePlayers = (game.users?.contents ?? []).filter(u => u.active && !u.isGM);
    for (const u of onlinePlayers) {
      try {
        game.socket.emit("pullToScene", returnScene.id, u.id);
      } catch (e) {
        warn(`[BattleEnd:Transition] pullToScene failed for ${u.name}:`, e);
      }
    }

    // 7) Restore pre-battle viewport — only if the stored sceneId matches where we landed.
    //    If missing or mismatched, skip (let Foundry restore whatever it has).
    const cam = (preBattleCamera?.sceneId === returnSceneId) ? preBattleCamera : null;
    if (cam) {
      const { x, y, scale } = cam;
      try {
        canvas.animatePan({ x, y, scale, duration: 300 });
        if (canvas.scene) canvas.scene._viewPosition = { x, y, scale };
      } catch (e) {
        warn("[BattleEnd:Transition] Pre-battle camera restore threw:", e);
      }
      emitCameraReset(returnSceneId, x, y, scale, 300);
    } else {
      log("[BattleEnd:Transition] No pre-battle viewport stored — skipping camera restore");
    }
  }

  // 8) Fade in the new scene
  try {
    await FUCompanion.api.animationCache.dropCurtain({ broadcast: true, fadeOutMs: 800 });
  } catch (e) {
    warn("[BattleEnd:Transition] dropCurtain threw (continuing):", e);
  }

  log("[BattleEnd:Transition] Complete");
}
