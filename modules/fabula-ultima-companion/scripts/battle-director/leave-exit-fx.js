// ============================================================================
// Leave-combat exit: the shared "it runs away" shot.
//
// Played by the leave_combat effect row, on every client, right before the
// token is removed. It lives on the row and not on an item's animation_script
// because an item script plays at the action's ANIMATION state, which is BEFORE
// a Run Away's Group Check: the monster would leave, then still be there if the
// party passed. The row only runs once its condition has passed.
//
// Styles (the row's Exit Style): run (default), walk, none.
//
// Facing: battle art is drawn facing left, and director-init mirrors enemies so
// the two sides face each other. An exit faces the way it TRAVELS: enemies leave
// to the left, everyone else to the right. Art drawn facing right carries the
// token Config mark "Art is drawn facing right" (spriteFacesRight), the same one
// the walk maps read. The sheet's *_facing_direction fields are not used: they
// disagree with the art on several monsters.
//
// Client-local and write-free: a copy of the token slides, the token is hidden
// behind it, and the GM's leave_combat row deletes the token afterwards.
// ============================================================================

import { warn } from "./logger.js";
import { buildOni } from "../anim-studio/oni-helpers.js";

const MODULE_ID = "fabula-ultima-companion";
const DRAWN_RIGHT_FLAG = "spriteFacesRight";
const ACTION_EXIT = "FU_LEAVE_EXIT_PLAY";
const SOUND = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/";

// All timings ms, distances world px. leadMs = turned around, not moving yet.
export const LEAVE_EXIT_CFG = Object.freeze({
  run: {
    leadMs: 250, slideMs: 1700, distance: 420, fadeFrom: 0.35, hopMs: 150, hopPx: 5,
    sounds: [{ at: 250, url: SOUND + "Soundboard/Run.ogg", volume: 0.8 }],
  },
  walk: {
    leadMs: 500, slideMs: 3600, distance: 300, fadeFrom: 0.5, hopMs: 460, hopPx: 3,
    sounds: [
      { at: 500, url: SOUND + "Soundboard/SE_BTL_FootStepNormal_1.ogg", volume: 0.7 },
      { at: 800, url: SOUND + "Wind1.ogg", volume: 0.4 },
    ],
  },
});

// Past the slide, the GM stops waiting for a client's own clock.
const FAILSAFE_PAD_MS = 1500;
// A token still here this long after its copy finished is coming back on screen.
const REMOVAL_WAIT_MS = 2000;

let _socket = null;

export function initLeaveExitFx() {
  try {
    if (typeof socketlib !== "undefined" && game.modules.get("socketlib")?.active) {
      _socket = socketlib.registerModule(MODULE_ID);
      _socket.register(ACTION_EXIT, playLeaveExitLocal);
    } else {
      warn("leave-exit: socketlib unavailable, the exit stays local-only");
    }
  } catch (e) {
    warn("leave-exit: socket init failed", e);
  }
}

// -1 = travels left, 1 = travels right.
function travelSide(token) {
  return token.document?.disposition === -1 ? -1 : 1;
}

// Sign of the copy's scale.x. Positive shows the art as drawn.
export function exitFacingSign(side, drawnRight) {
  const drawnSide = drawnRight ? 1 : -1;
  return side === drawnSide ? 1 : -1;
}

function drawnFacingRight(token) {
  const own = token.document?.getFlag?.(MODULE_ID, DRAWN_RIGHT_FLAG);
  if (own != null) return !!own;
  return !!token.actor?.prototypeToken?.flags?.[MODULE_ID]?.[DRAWN_RIGHT_FLAG];
}

function canvasToken(tokenUuid) {
  const id = String(tokenUuid ?? "").split(".Token.").pop();
  return id ? (canvas?.tokens?.get?.(id) ?? null) : null;
}

// Resolves when the copy has left. The copy's run stays alive (token hidden)
// until the token is deleted, so the token cannot blink back in between.
export async function playLeaveExitLocal({ tokenUuid, style = "run" } = {}) {
  const cfg = LEAVE_EXIT_CFG[style];
  const token = canvasToken(tokenUuid);
  if (!cfg || !token || token.destroyed || !token.mesh) return;
  if (globalThis.FUCompanion?.api?.vfxSuppressed?.()) return;
  // Already gone from view: the Ultima Escape runs its own fade before this row.
  if ((token.mesh.alpha ?? 1) < 0.05) return;

  const release = globalThis.__ONI_BATTLE_STAGE_3D__?.hold?.("leave-exit");
  let oni = null;
  let removalHook = null;
  let removalTimer = null;
  const finish = () => {
    if (removalHook != null) Hooks.off("deleteToken", removalHook);
    removalHook = null;
    clearTimeout(removalTimer);
    try { oni?.dispose?.(); } catch (e) { warn("leave-exit: dispose threw", e); }
    try { release?.(); } catch { /* nothing to undo */ }
  };

  try {
    const mesh = token.mesh;
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    oni = buildOni({ casterToken: token, targetTokens: [], params: {} },
      { canvas, PIXI, loadTexture, fromUuid, wait, foundry });

    const host = oni.layer({ zIndex: 93000 });
    const clone = oni.cloneToken(token, { parent: host });
    if (!clone) { finish(); return; }
    // Exactly over the drawn body: the depth system plants the mesh by its feet,
    // so token.center can be off from where the art really stands.
    clone.anchor.copyFrom(mesh.anchor);
    const x0 = mesh.x, y0 = mesh.y;
    clone.position.set(x0, y0);
    oni.hideToken(token);

    const side = travelSide(token);
    clone.scale.x = Math.abs(clone.scale.x) * exitFacingSign(side, drawnFacingRight(token));

    for (const s of cfg.sounds) oni.sfx(s.url, { volume: s.volume, delay: s.at });

    const baseAlpha = clone.alpha;
    const total = cfg.leadMs + cfg.slideMs;
    await oni.tween({
      from: 0, to: total, duration: total, ease: oni.EASE.linear,
      onUpdate: (t) => {
        if (token.destroyed || clone.destroyed) return;
        const moved = t - cfg.leadMs;
        const u = Math.max(0, Math.min(1, moved / cfg.slideMs));
        // A run picks up speed. A walk holds one pace, it does not hurry.
        const eased = style === "walk" ? u : u * u * 0.6 + u * 0.4;
        const hop = (moved > 0 && u < 1) ? Math.abs(Math.sin(moved / cfg.hopMs * Math.PI)) * cfg.hopPx : 0;
        const fade = Math.max(0, (u - cfg.fadeFrom) / (1 - cfg.fadeFrom));
        clone.lift = hop;
        clone.position.set(x0 + side * cfg.distance * eased, y0 - hop);
        clone.alpha = baseAlpha * (0.5 + 0.5 * Math.cos(Math.PI * fade));
      },
    });
    if (!clone.destroyed) clone.alpha = 0;

    if (token.destroyed) { finish(); return; }
    removalHook = Hooks.on("deleteToken", (doc) => { if (doc.id === token.id) finish(); });
    removalTimer = setTimeout(finish, REMOVAL_WAIT_MS);
  } catch (e) {
    warn("leave-exit: playback threw", e);
    finish();
  }
}

// GM side, called by the leave_combat row. Awaits the slide on this client.
export async function emitLeaveExit({ tokenUuid, style = "run" } = {}) {
  const cfg = LEAVE_EXIT_CFG[style];
  if (!cfg) return;
  try { _socket?.executeForOthers?.(ACTION_EXIT, { tokenUuid, style }); }
  catch (e) { warn("leave-exit: broadcast failed", e); }
  const limit = cfg.leadMs + cfg.slideMs + FAILSAFE_PAD_MS;
  await Promise.race([
    playLeaveExitLocal({ tokenUuid, style }),
    new Promise((res) => setTimeout(res, limit)),
  ]);
}
