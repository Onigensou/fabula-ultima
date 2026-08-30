// Battle End FX — BGM swap + camera pan.
//
// Skips endActiveCombatSilently (no Foundry combat doc in BD).
// Uses stopBattleBgm() from director-vfx.js to stop the tracked battle BGM,
// then starts victory BGM by name, then broadcasts a camera pan to all clients.

import { log, warn } from "../logger.js";
import { stageOf, resolveIntent, clampToCanvas } from "../director-camera.js";
import { stopBattleBgm } from "../director-vfx.js";
import { pWait } from "../presentation-clock.js";

const MODULE_ID     = "fabula-ultima-companion";
const SOCKET_CHANNEL = `module.${MODULE_ID}`;

// Presentation dwell — zero while hidden (the only use is a cinematic hold).
const wait = pWait;

function makeRunId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

async function playTrackFromAnyPlaylist(trackName) {
  const name = String(trackName ?? "").trim();
  if (!name) return { ok: false, reason: "no-track-name" };

  // Stop everything currently playing first
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

function installInputLock() {
  const id = "oni-battleend-fx-lock";
  if (document.getElementById(id)) return () => {};

  const el = document.createElement("div");
  el.id = id;
  Object.assign(el.style, {
    position: "fixed", left: "0", top: "0", right: "0", bottom: "0",
    zIndex: "999999", pointerEvents: "all", background: "transparent",
  });
  document.body.appendChild(el);

  const BLOCKED_KEYS = new Set([
    "arrowup","arrowdown","arrowleft","arrowright",
    "w","a","s","d","+","-","=","pageup","pagedown","home","end",
  ]);
  const stopKeys  = (ev) => { if (BLOCKED_KEYS.has(String(ev.key ?? "").toLowerCase())) { ev.preventDefault(); ev.stopPropagation(); } };
  const stopWheel = (ev) => { ev.preventDefault(); ev.stopPropagation(); };

  window.addEventListener("keydown", stopKeys, true);
  window.addEventListener("wheel", stopWheel, { capture: true, passive: false });

  return () => {
    try { window.removeEventListener("keydown", stopKeys, true); } catch (_) {}
    try { window.removeEventListener("wheel", stopWheel, true); } catch (_) {}
    try { el.remove(); } catch (_) {}
  };
}

async function runLocalCameraFx(plan) {
  const unlock = installInputLock();
  try {
    // Resolve the stage-space intent against THIS client's viewport, then
    // clamp so the shot can never leave the artwork. `target` stays honoured
    // as a fallback for any caller still building an absolute view.
    const view = plan?.intent ? resolveIntent(plan.intent)
               : plan?.target ? clampToCanvas(plan.target)
               : null;
    if (!view) return;
    const timeoutMs = Math.max(1000, plan.durationMs + 1500);
    await Promise.race([
      canvas.animatePan({ x: view.x, y: view.y, scale: view.scale, duration: plan.durationMs }),
      wait(timeoutMs),
    ]);
    await wait(plan.holdMs);
  } catch (e) {
    warn("[BattleEnd:FX] Camera FX failed (continuing):", e);
  } finally {
    unlock();
  }
}

export async function runBattleEndFx(endCtx) {
  const { director, outcome, promptResult } = endCtx;
  const { bgm, fx } = promptResult;

  // 1) Stop battle BGM (the track director-init started)
  try {
    await stopBattleBgm(director.ctx.payload?.battleConfig?.bgm);
  } catch (e) {
    warn("[BattleEnd:FX] stopBattleBgm threw (continuing):", e);
  }

  // 2) Play victory BGM
  if (outcome === "victory" && bgm.playMusic && bgm.name) {
    try {
      const r = await playTrackFromAnyPlaylist(bgm.name);
      if (!r.ok) ui.notifications?.warn?.(`BattleEnd: Victory BGM not found: "${bgm.name}"`);
      else log(`[BattleEnd:FX] Victory BGM playing: ${r.playlist} / ${r.sound}`);
    } catch (e) {
      warn("[BattleEnd:FX] Play victory BGM threw (continuing):", e);
    }
  }

  // 3) Camera pan (optional)
  if (!fx.playAnimation) return;

  const candidates = (canvas.tokens?.placeables ?? []).filter(t => t?.actor?.hasPlayerOwner);
  if (!candidates.length) return;

  const token  = candidates[Math.floor(Math.random() * candidates.length)];
  const center = token.center;
  const stage  = stageOf(canvas.scene);

  // Stage-space intent, not an absolute view.
  //
  // The old form baked in a +220px offset and scale 1.7 — numbers measured
  // against a 1682-wide scene on one particular monitor — and broadcast them
  // verbatim, so a player on a smaller window got a different shot. Worse, on
  // a 1682-wide canvas that pan sails several hundred pixels past the right
  // edge into the void, because Foundry's own constraint lets the pivot travel
  // 0.4 of a viewport beyond the map.
  //
  // OFFSET_FRAC and ZOOM reproduce the INTENDED framing (220/1682 of the stage
  // width; 1.7 against the legacy 1.142 rest scale is ~1.5x) and each client
  // resolves and clamps it against its own viewport.
  const OFFSET_FRAC = 220 / 1682;
  const ZOOM = 1.5;
  const plan   = {
    runId:      makeRunId("battleend_fx_cam"),
    durationMs: 3200,
    holdMs:     450,
    intent:     { point: { x: center.x + stage.w * OFFSET_FRAC, y: center.y }, zoom: ZOOM },
  };

  // Broadcast to all clients so everyone pans
  try {
    game.socket.emit(SOCKET_CHANNEL, {
      type: "ONI_BATTLEEND_FX_CAMERA",
      sceneId: canvas.scene?.id ?? "",
      payload: { lockId: plan.runId, durationMs: plan.durationMs, holdMs: plan.holdMs, intent: plan.intent },
    });
  } catch (e) {
    warn("[BattleEnd:FX] Socket emit failed:", e);
  }

  // Run locally on GM (non-blocking)
  Promise.resolve()
    .then(() => runLocalCameraFx(plan))
    .catch(e => warn("[BattleEnd:FX] Local camera FX threw:", e));
}
