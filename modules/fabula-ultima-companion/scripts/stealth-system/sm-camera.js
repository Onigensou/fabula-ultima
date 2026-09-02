// ============================================================================
// Stealth Mode — camera policy.
//
// This mode leans on Foundry's own fog of war, so free panning during YOUR turn
// costs nothing: everything past the fog is hidden anyway, and being able to
// study the room you are creeping through is most of the planning.
//
// Outside your turn it is the opposite. A player who can roam the map while the
// GM moves guards sees positions the fog was meant to withhold, and — worse —
// misses the one thing that matters, which is the guard walking toward them.
// So the camera snaps to the party token and holds there until the phase comes
// back around.
//
// ── How the lock works ─────────────────────────────────────────────────────
// `canvas.pan` is wrapped rather than input being intercepted. Every route into
// moving the view — right-drag, wheel, keyboard, a script — ends up in pan(),
// so one wrapper catches all of them, and unwrapping restores the original
// exactly. Intercepting pointer events instead would have meant guessing at
// Foundry's input plumbing and missing the paths that skip it.
// ============================================================================

import { TAG } from "./sm-constants.js";
import { centerOf } from "./sm-grid.js";

let _origPan = null;
let _locked = false;
let _anchor = null;      // world point the lock holds the view on

/** Centre the view on a cell. */
export async function panToCell(cell, { scale = null, duration = 420 } = {}) {
  if (!cell || !canvas?.ready) return;
  const p = centerOf(cell);
  const view = { x: p.x, y: p.y };
  if (scale) view.scale = scale;
  try {
    // Go through the ORIGINAL pan when a lock is installed, or the wrapper
    // would bounce our own recentre back to the anchor.
    const fn = _origPan ?? canvas.pan.bind(canvas);
    await (canvas.animatePan ? canvas.animatePan({ ...view, duration }) : fn(view));
  } catch (e) {
    console.warn(TAG, "panToCell failed", e);
  }
}

/**
 * Hold the view on `cell` and refuse every pan request until unlock().
 * Zoom is deliberately still allowed — pulling back to see more of a fogged
 * room reveals nothing, and taking zoom away as well feels like a seized
 * mouse rather than a framing decision.
 */
export function lockOn(cell) {
  if (!canvas?.ready || !cell) return;
  _anchor = centerOf(cell);

  if (_locked) return;                 // already wrapped; just moved the anchor
  _locked = true;
  _origPan = canvas.pan.bind(canvas);

  canvas.pan = (view = {}) => {
    // Keep whatever zoom was asked for, force the position.
    const forced = { ...view, x: _anchor.x, y: _anchor.y };
    return _origPan(forced);
  };
}

export function unlock() {
  if (!_locked) return;
  _locked = false;
  try { if (_origPan) canvas.pan = _origPan; } catch (_) {}
  _origPan = null;
  _anchor = null;
}

export const isLocked = () => _locked;

/**
 * Apply the policy for a phase.
 *
 * Player phase: recentre once, then hand the camera back.
 * Anything else: recentre and hold.
 */
export async function applyPhasePolicy(phase, partyCell, { scale = null } = {}) {
  const PLAYER_PHASES = ["PLAYER_START", "CONTROLLER_PICK", "ACTION", "RESOLUTION"];
  const isPlayerTurn = PLAYER_PHASES.includes(phase);

  if (!partyCell) { unlock(); return; }

  if (isPlayerTurn) {
    unlock();
    // Recentre only at the TOP of the turn. Recentring on every ACTION
    // broadcast would yank the view back mid-plan every time the state
    // changed, which is the opposite of free panning.
    if (phase === "PLAYER_START") await panToCell(partyCell, { scale });
    return;
  }

  await panToCell(partyCell, { scale });
  lockOn(partyCell);
}
