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

// ── The thrown rock ─────────────────────────────────────────────────────────
//
// Diversion worked before this, but produced no picture: guards turned and
// walked toward an empty tile, and the only evidence of a cause was a line in
// the log. Showing the throw makes the mechanic legible — the player sees the
// noise happen where they aimed it, and can read the guards' reaction as the
// consequence of a specific object landing in a specific place.

export const THROW_SFX = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Fall.ogg";

export function playThrowSfx({ volume = 0.6 } = {}) {
  try {
    foundry.audio.AudioHelper.play({ src: THROW_SFX, volume, autoplay: true, loop: false }, false);
  } catch (e) {
    try { AudioHelper.play({ src: THROW_SFX, volume, autoplay: true, loop: false }, false); }
    catch (_) { /* audio locked — never let a sound break a turn */ }
  }
}

/** A small tumbling stone, drawn rather than loaded — no asset to ship. */
function rockSprite(gs) {
  const r = Math.max(3, gs * 0.11);
  const g = new PIXI.Graphics();
  g.beginFill(0x2b2620, 0.35);            // a soft dark rim so it reads on pale floor
  g.drawCircle(0, 0, r * 1.25);
  g.endFill();
  g.beginFill(0x6f6455, 1);
  g.drawCircle(0, 0, r);
  g.endFill();
  g.beginFill(0x9a8d78, 1);               // lit face, offset — gives it a spin to see
  g.drawCircle(-r * 0.28, -r * 0.3, r * 0.5);
  g.endFill();
  return g;
}

/** Dust where it lands. Short — the guards' reaction is the real payoff. */
async function dustPuff(point, gs) {
  const g = new PIXI.Graphics();
  g.x = point.x; g.y = point.y;
  g.zIndex = 499999;
  canvas.stage.sortableChildren = true;
  canvas.stage.addChild(g);

  const t0 = performance.now();
  const DUR = 420;
  await new Promise((resolve) => {
    const tick = () => {
      const t = Math.min(1, (performance.now() - t0) / DUR);
      g.clear();
      const r = gs * (0.12 + t * 0.34);
      g.lineStyle(Math.max(1, gs * 0.035 * (1 - t)), 0xd8cdb8, 0.7 * (1 - t));
      g.drawCircle(0, 0, r);
      if (t >= 1) {
        canvas?.app?.ticker?.remove?.(tick);
        try { g.parent?.removeChild(g); g.destroy(); } catch (_) {}
        resolve();
      }
    };
    canvas?.app?.ticker?.add?.(tick);
  });
}

/**
 * Arc a rock from one cell to another, then puff dust and sound the landing.
 *
 * The height of the arc scales with the distance thrown, so a rock lobbed
 * across the hall visibly travels further than one dropped beside you — the
 * throw reads as an act with reach rather than a fixed animation.
 */
export async function throwRock(fromCell, toCell, { sfx = true } = {}) {
  if (!fromCell || !toCell || !canvas?.stage) return;
  const a = centerOf(fromCell);
  const b = centerOf(toCell);
  const gs = canvas.grid?.size ?? 100;

  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  if (dist < 1) { if (sfx) playThrowSfx(); return; }

  const rock = rockSprite(gs);
  rock.x = a.x; rock.y = a.y;
  rock.zIndex = 500001;
  canvas.stage.sortableChildren = true;
  canvas.stage.addChild(rock);

  const arcH = Math.min(gs * 1.6, dist * 0.42);
  const duration = Math.max(320, Math.min(720, dist * 1.05));
  const t0 = performance.now();

  await new Promise((resolve) => {
    const tick = () => {
      const t = Math.min(1, (performance.now() - t0) / duration);
      // Linear along the ground, parabolic in height: a thrown object keeps
      // its horizontal speed and only the vertical reads as gravity. Easing
      // the ground track too made it float.
      rock.x = a.x + (b.x - a.x) * t;
      rock.y = a.y + (b.y - a.y) * t - Math.sin(Math.PI * t) * arcH;
      rock.rotation = t * Math.PI * 3;
      if (t >= 1) {
        canvas?.app?.ticker?.remove?.(tick);
        try { rock.parent?.removeChild(rock); rock.destroy(); } catch (_) {}
        resolve();
      }
    };
    canvas?.app?.ticker?.add?.(tick);
  });

  if (sfx) playThrowSfx();
  await dustPuff(b, gs);
}
