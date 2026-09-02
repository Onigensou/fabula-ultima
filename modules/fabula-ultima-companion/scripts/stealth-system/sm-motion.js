// ============================================================================
// Stealth Mode — token motion.
//
// Movement used to write the token document once per cell, which reads as a
// snap-snap-snap down the path: Foundry animates each hop independently, and a
// five-cell move became five separate lurches with a document round-trip
// between each.
//
// So the document is written ONCE — start cell to final cell — and everything
// between is a cloned sprite tweened on the ticker. Same pattern
// dp-movement.js uses, for the same reason: the clone is free to move
// smoothly because nothing is listening to it.
//
// ── Why the detour still has to be per-cell ────────────────────────────────
// Detection is evaluated at every cell entered, and a walk must STOP at the
// cell that gets you spotted. So the caller drives the path a cell at a time
// and calls `glide()` for the run it has already decided is safe; when a
// sighting cuts the walk short, only the cells actually travelled are animated.
// The alternative — animate the whole path, then rewind on a spot — would
// show the player a move that never happened.
// ============================================================================

import { TAG, MSG } from "./sm-constants.js";
import { centerOf, topLeftOf } from "./sm-grid.js";

export const MOVE_SFX = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/DashA.wav";
export const ALERT_SFX = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Alert.mp3";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ease-in-out cubic. Gentler than a linear crawl, no bounce at the ends. */
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// ── SFX ─────────────────────────────────────────────────────────────────────

let _lastSfxAt = 0;

/**
 * Footstep for a move. Rate-limited: a five-cell walk is ONE sound, not five
 * overlapping copies of the same 200ms sample.
 */
export function playMoveSfx({ volume = 0.5 } = {}) {
  const now = performance.now();
  if (now - _lastSfxAt < 220) return;
  _lastSfxAt = now;
  try {
    foundry.audio.AudioHelper.play({ src: MOVE_SFX, volume, autoplay: true, loop: false }, false);
  } catch (e) {
    try { AudioHelper.play({ src: MOVE_SFX, volume, autoplay: true, loop: false }, false); }
    catch (_) { /* audio still locked — never let a sound break a turn */ }
  }
}

// ── The clone tween ─────────────────────────────────────────────────────────

/**
 * Slide a token's SPRITE along a series of world points. Writes nothing.
 *
 * @param {Token}  token      the placeable (not the document)
 * @param {Array}  points     world-space {x,y} centres, first is the start
 * @param {number} msPerLeg   duration of one cell-to-cell leg
 */
export async function glideSprite(token, points, { msPerLeg = 190, sfx = true } = {}) {
  if (!token || token.destroyed || !points || points.length < 2) return;

  const base = token.mesh ?? token.icon;
  let tex = base?.texture;
  if (!tex) {
    try { tex = await loadTexture(token.document.texture.src); } catch (_) { return; }
  }

  const s = new PIXI.Sprite(tex);
  s.anchor.set(0.5);
  s.x = points[0].x;
  s.y = points[0].y;

  if (base) {
    s.width = base.width; s.height = base.height;
    s.rotation = base.rotation ?? 0;
    s.alpha = base.alpha ?? 1;
    // Preserve a horizontally-flipped sprite. Tokens here have no directional
    // art, but an authored flip is still the artist's intent.
    if ((base.scale?.x ?? 1) < 0) s.scale.x = -Math.abs(s.scale.x);
    if ((base.scale?.y ?? 1) < 0) s.scale.y = -Math.abs(s.scale.y);
  } else {
    s.width = token.w; s.height = token.h;
  }

  s.zIndex = 500000;
  const prevSortable = canvas.stage.sortableChildren;
  canvas.stage.sortableChildren = true;
  canvas.stage.addChild(s);

  const origTokenVisible = token.visible;
  const origMeshVisible = base?.visible ?? true;

  try {
    if (base) base.visible = false;
    token.visible = false;

    if (sfx) playMoveSfx();

    // ONE tween over the WHOLE polyline, not one per leg.
    //
    // Easing each leg separately meant the sprite decelerated to a stop at
    // every cell boundary and accelerated out again — a five-cell walk read as
    // five little hops with a pause between each. Here the ease runs once over
    // the total distance and the position is sampled by ARC LENGTH, so the
    // sprite tracks the corners at a constant, smooth rate and only slows at
    // the true start and end of the move.
    const segLen = [];
    let total = 0;
    for (let i = 1; i < points.length; i++) {
      const d = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
      segLen.push(d);
      total += d;
    }
    if (total <= 0) return;

    const duration = Math.max(msPerLeg, msPerLeg * (points.length - 1));

    /** Position at arc-length `dist` along the polyline. */
    const at = (dist) => {
      let d = Math.max(0, Math.min(total, dist));
      for (let i = 0; i < segLen.length; i++) {
        if (d <= segLen[i] || i === segLen.length - 1) {
          const f = segLen[i] > 0 ? d / segLen[i] : 1;
          const a = points[i], b = points[i + 1];
          return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
        }
        d -= segLen[i];
      }
      return points[points.length - 1];
    };

    await new Promise((res) => {
      const start = performance.now();
      const tick = () => {
        const t = Math.min((performance.now() - start) / duration, 1);
        const p = at(ease(t) * total);
        s.x = p.x; s.y = p.y;
        if (t >= 1) { canvas.app.ticker.remove(tick); res(); }
      };
      canvas.app.ticker.add(tick);
    });

    // A beat at the destination before the real token reappears, so the swap
    // is never visible as a flicker.
    await wait(40);
  } finally {
    canvas.stage.sortableChildren = prevSortable;
    try { canvas.stage.removeChild(s); } catch (_) {}
    try { s.destroy(); } catch (_) {}
    if (base) base.visible = origMeshVisible;
    token.visible = origTokenVisible;
  }
}

/**
 * Walk a token along `cells` and commit the move.
 *
 * The sprite glides the whole path; the document is updated ONCE at the end,
 * with `animate: false` because the visible motion has already happened —
 * letting Foundry animate the same distance again would play the move twice.
 *
 * GM-side. Other clients get the same glide via `broadcastMotion`.
 */
export async function walkToken(tokenDoc, cells, {
  msPerLeg = 190, sfx = true, broadcast = null,
} = {}) {
  if (!tokenDoc || !cells?.length) return;

  const token = tokenDoc.object;
  const startPoint = token?.center
    ? { x: token.center.x, y: token.center.y }
    : centerOf(cells[0]);

  const points = [startPoint, ...cells.map((c) => centerOf(c))];

  if (broadcast) {
    try { broadcast({ tokenId: tokenDoc.id, points, msPerLeg, sfx }); } catch (_) {}
  }

  if (token) await glideSprite(token, points, { msPerLeg, sfx });

  const dest = topLeftOf(cells[cells.length - 1]);
  await tokenDoc.update({ x: dest.x, y: dest.y }, {
    animate: false,
    stealthAuthorised: true,
  });
}

/** Replay a broadcast glide on a non-GM client. */
export async function replayMotion(payload) {
  const tokenDoc = canvas?.scene?.tokens?.get?.(payload?.tokenId);
  const token = tokenDoc?.object;
  if (!token) return;
  await glideSprite(token, payload.points, {
    msPerLeg: payload.msPerLeg ?? 190,
    sfx: payload.sfx !== false,
  });
}

/**
 * The alarm cue for a detection.
 *
 * Rate-limited like the footstep: a party crossing a room can be noticed by
 * three guards in the same step, and three overlapping copies of an alarm is
 * noise, not tension.
 */
let _lastAlertAt = 0;
export function playAlertSfx({ volume = 0.65 } = {}) {
  const now = performance.now();
  if (now - _lastAlertAt < 500) return;
  _lastAlertAt = now;
  try {
    foundry.audio.AudioHelper.play({ src: ALERT_SFX, volume, autoplay: true, loop: false }, false);
  } catch (_) {
    try { AudioHelper.play({ src: ALERT_SFX, volume, autoplay: true, loop: false }, false); }
    catch (_e) { /* audio locked */ }
  }
}
