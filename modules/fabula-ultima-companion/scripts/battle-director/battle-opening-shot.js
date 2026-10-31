// Battle-start opening shot (3D camera scenes only).
//
// The battle opens on the party: the 3D camera is swung round toward the
// party's side and brought in close, so their column reads as a line across
// the screen. They make their entrances in that shot; then the camera swings
// back to the battle view, and only then do the enemies come in.
//
// Every client frames its own view (rest scale differs per window), so the GM
// broadcasts the shot before the screen opens and each client applies it on
// its own canvas; each one swings back at the end of its own party entrance.
// Off the 3D camera (2D scenes, the setting off, a hidden window) nothing
// happens and the opening is exactly what it was.
//
// Shot chosen by the user in the 3D camera sandbox (2026-10-31,
// claude.ai/artifact/NCmQKqC9fQNbXJTmzUT8Js): zoom = x the rest scale, yaw /
// tilt / push = battleStage3d.camera.go(), pivot = view centre offset from the
// party's centre (2D token centres, guests included).

import { log, warn } from "./logger.js";
import { restViewFor } from "./director-camera.js";
import { shouldRender } from "./presentation-clock.js";

export const OPENING_SHOT = Object.freeze({ zoom: 1.82, yaw: -57.1, tilt: -1.7, push: 1, pivot: Object.freeze({ dx: -15, dy: 50 }) });
const SWING_BACK_MS = 1400;
// A client that applied the shot but never runs its party entrance (window
// hidden by then, a broadcast lost) still has to get back to the battle view.
const FAILSAFE_MS = 25000;
// How long a client waits for its canvas / 3D camera to be up before it skips
// the shot (it would otherwise cut to it after the screen has opened).
const READY_WAIT_MS = 1500;

const ease = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
let _active = null;   // { sceneId, failsafe }

function camera() { return globalThis.FUCompanion?.api?.battleStage3d?.camera ?? null; }

async function cameraReady(sceneId) {
  const t0 = performance.now();
  for (;;) {
    if (canvas?.ready && canvas.scene?.id === sceneId && camera()?.status?.()?.running) return true;
    if (performance.now() - t0 > READY_WAIT_MS) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Put this client's camera on the opening shot. Resolves true if it did. */
export async function applyOpeningShotLocal({ sceneId, partyTokenIds = [] } = {}) {
  try {
    clearOpening();
    if (!shouldRender() || !(await cameraReady(sceneId))) return false;
    const toks = partyTokenIds.map((id) => canvas.tokens.get(id)).filter((t) => t && !t.destroyed);
    if (!toks.length) return false;
    // 2D centres from the documents (token.center reports the DRAWN body under the camera)
    const cx = toks.reduce((s, t) => s + t.document.x + t.w / 2, 0) / toks.length;
    const cy = toks.reduce((s, t) => s + t.document.y + t.h / 2, 0) / toks.length;
    const rest = restViewFor(canvas.scene);
    if (!rest) return false;
    const S = OPENING_SHOT;
    canvas.pan({ x: cx + S.pivot.dx, y: cy + S.pivot.dy, scale: rest.scale * S.zoom });
    camera().go({ yaw: S.yaw, tilt: S.tilt, push: S.push }, 1);
    _active = { sceneId, failsafe: setTimeout(() => { swingBackOpeningShot().catch(() => {}); }, FAILSAFE_MS) };
    log("opening shot: on");
    return true;
  } catch (e) {
    warn("opening shot: apply failed", e);
    return false;
  }
}

/** Is this client on the opening shot? */
export function isOpeningShotActive() { return !!_active; }

function clearOpening() {
  if (_active?.failsafe) clearTimeout(_active.failsafe);
  _active = null;
}

/**
 * Swing this client's camera back to the battle view. No-op when not on the
 * shot. Resolves true when it swung (the camera moved), false otherwise.
 */
export async function swingBackOpeningShot({ ms = SWING_BACK_MS } = {}) {
  if (!_active) return false;
  const { sceneId } = _active;
  clearOpening();
  try {
    const cam = camera();
    if (!canvas?.ready || canvas.scene?.id !== sceneId) { cam?.go?.({ yaw: 0, tilt: 0, push: 1 }, 1); return false; }
    const rest = restViewFor(canvas.scene);
    const from = { x: canvas.stage.pivot.x, y: canvas.stage.pivot.y, scale: canvas.stage.scale.x };
    const shot = cam?.go?.({ yaw: 0, tilt: 0, push: 1 }, ms);
    // the 2D view on the same curve as the camera's own tween, so the two land together
    if (rest && shouldRender()) {
      await new Promise((done) => {
        const t0 = performance.now();
        const step = (now) => {
          const u = Math.min(1, (now - t0) / ms), e = ease(u);
          canvas.pan({ x: from.x + (rest.x - from.x) * e, y: from.y + (rest.y - from.y) * e, scale: from.scale + (rest.scale - from.scale) * e });
          if (u < 1) requestAnimationFrame(step); else done();
        };
        requestAnimationFrame(step);
      });
    } else if (rest) canvas.pan(rest);
    await shot;
    log("opening shot: back on the battle view");
    return true;
  } catch (e) {
    warn("opening shot: swing back failed", e);
    try { camera()?.go?.({ yaw: 0, tilt: 0, push: 1 }, 1); } catch { /* gone */ }
    return false;
  }
}
