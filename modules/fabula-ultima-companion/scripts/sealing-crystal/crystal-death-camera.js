// ============================================================================
// Sealing Crystal — the death's camera, planned. Pure (the 3D stage rules
// only): the show (crystal-death-show.js) and the Node test both use it.
//
// The move the user built live on the mockup (v20–v30, docs/nidhogg-boss-design.md §8):
//   10.8 → 13.5 s  the camera orbits round the crystal and comes down to a low spot (eye 0.6 m) close to it, on the
//                  line square to the party's line through its middle, FACING along that line; the crystal is held
//                  at the screen's centre by a sideways lens shift (the game's placed shot: stand / face).
//   15 → 19.8 s    an accelerating (cubic ease-in) pull-away along the same line, to the party's distance past them;
//                  still moving when the full white covers everything (the white hides the stop).
//   19.8 → 20.4 s  back to the battle framing under the white.
// One deliberate change from the mockup: the stand's lens is SOLVED so the crystal stands STAND.fill of the screen's
// height at the stand point, measured through the real rig. The mockup's closed-form lens was tuned on a guessed
// stage preset (horizon -590); on the measured one (-78) the same numbers overfilled the frame (101 % vs the 74 %
// the user approved, 2026-11-10). Solving it keeps the approved framing on any preset.
//
// Coordinates: canvas px for floor points, metres for heights (the rules' projector P).
// ============================================================================

import { rigCamera, projectLive, floorPoint3, restPxPerMetre } from "../battle-director/battle-stage-3d-rules.js";
import { DEATH, POURS } from "./crystal-death.js";

export const CAM = Object.freeze({ from: DEATH.jets[0], to: 13.5 });
/** The stand: `ahead` of the party→crystal distance from the party, eye height (m), the crystal's share of the screen height. */
export const STAND = Object.freeze({ ahead: 0.45, eye: 0.6, fill: 0.74 });
/** The pull-away: from, to (= the full white), and how far past the party (× the party→crystal distance). */
export const BACK = Object.freeze({ from: 15.0, to: DEATH.whiteFull, behind: 1.0 });
/** The party is hidden over the first share of the stand's blend (they are flat billboards: user, 11m). */
export const PARTY_FADE = 0.15;
/** The crystal's look point (its visual centre) and body height above its feet, in effect px (mockup: 142 / 250). */
export const CRYSTAL_UP_FX = 142, CRYSTAL_TALL_FX = 250;

export const ease = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);   // the game's tween curve
export const easeIn = (u) => u * u * u;                                                   // the game's "in" curve
const clamp01 = (v) => Math.max(0, Math.min(1, v));

/**
 * Plan the move.
 *   model      { P, cfg, rest } from the live camera (battle-stage-3d camera.model())
 *   party      [{x, y}] the party's feet (canvas px), any order
 *   feet       {x, y} the crystal's feet (canvas px)
 *   px         scene px per effect px at drawn scale 1
 *   screenH    the visible height in canvas px at the rest view (screen height / view scale)
 */
export function planDeathCamera({ model, party, feet, px, screenH }) {
  const { P, cfg, rest } = model;
  const F = floorPoint3(feet, P), ppm = restPxPerMetre(feet.y, P);
  const heartH = (CRYSTAL_UP_FX * px) / ppm, tallM = (CRYSTAL_TALL_FX * px) / ppm;
  const heart = { X: F.X, Y: heartH, Z: F.Z };
  const canvasOf = ({ X, Z }) => ({ x: P.cx + (P.f * X) / -Z, y: P.hz + (P.f * P.Hp) / -Z });

  // the party's line on the floor (metres): its two ends along the formation, and its middle
  const W = (party.length ? party : [feet]).map((q) => floorPoint3(q, P));
  const mid = { X: W.reduce((a, q) => a + q.X, 0) / W.length, Z: W.reduce((a, q) => a + q.Z, 0) / W.length };
  let dir = { X: 1, Z: 0 };
  if (W.length >= 2) {
    // principal axis of the feet (the formation's diagonal), so any count / order works
    let sxx = 0, szz = 0, sxz = 0;
    for (const q of W) { const dx = q.X - mid.X, dz = q.Z - mid.Z; sxx += dx * dx; szz += dz * dz; sxz += dx * dz; }
    const a = 0.5 * Math.atan2(2 * sxz, sxx - szz);
    dir = { X: Math.cos(a), Z: Math.sin(a) };
  }
  let nrm = { X: -dir.Z, Z: dir.X };
  if ((F.X - mid.X) * nrm.X + (F.Z - mid.Z) * nrm.Z < 0) nrm = { X: -nrm.X, Z: -nrm.Z };      // toward the crystal's side
  const toCrystal = Math.hypot(F.X - mid.X, F.Z - mid.Z);
  const onPath = (m) => canvasOf({ X: mid.X + nrm.X * m, Z: mid.Z + nrm.Z * m });
  const at = onPath(STAND.ahead * toCrystal), face = onPath(toCrystal * 3), back = onPath(-BACK.behind * toCrystal);

  const base = { stand: 1, standX: at.x, standY: at.y, eye: STAND.eye, lookX: feet.x, lookY: feet.y, lookH: heartH, faceX: face.x, faceY: face.y };
  // the lens: a first guess from the distance, then measured through the real rig (size on screen is linear in it)
  const A = floorPoint3(at, P), dist = Math.hypot(F.X - A.X, heartH - STAND.eye, F.Z - A.Z);
  const tallPx = (lens) => {
    const rig = rigCamera({ view: rest, rest, shot: { ...base, lens }, sway: false }, P, cfg);
    const top = projectLive({ ...heart, Y: heartH + tallM / 2 }, rig), bot = projectLive({ ...heart, Y: heartH - tallM / 2 }, rig);
    return Math.hypot(top.x - bot.x, top.y - bot.y);
  };
  let lens = (STAND.fill * screenH) / (tallM / dist) / P.f;
  for (let i = 0; i < 3; i++) { const h = tallPx(lens); if (h > 0) lens *= (STAND.fill * screenH) / h; }
  const shot = { ...base, lens };

  const rig0 = rigCamera({ view: rest, rest, shot: {}, sway: false }, P, cfg);
  const plan = { P, cfg, rest, heart, heartH, tallM, toCrystal, shot, back, rig0, px };
  plan.sight0 = sightOf(rig0, heart);
  plan.hp0 = projectLive(heart, rig0);
  plan.camPoses = POURS.map((d) => turnOf(rigAt(plan, d), plan));
  return plan;
}

/** The scripted shot at death time D (null = the orbit camera, untouched). */
export function shotAt(plan, D) {
  const keep = 1 - clamp01((D - DEATH.whiteFull) / (DEATH.whiteHold - DEATH.whiteFull));
  const u = D < CAM.from ? 0 : ease(clamp01((D - CAM.from) / (CAM.to - CAM.from))) * keep;
  if (u <= 0) return { stand: 0 };
  const b = D < BACK.from ? 0 : easeIn(clamp01((D - BACK.from) / (BACK.to - BACK.from)));
  const s = plan.shot;
  return { ...s, standX: s.standX + (plan.back.x - s.standX) * b, standY: s.standY + (plan.back.y - s.standY) * b, stand: u };
}

/** The rig the camera will draw at death time D (no sway): for planning (the pours' cracks). */
export function rigAt(plan, D) {
  const shot = shotAt(plan, D);
  return rigCamera({ view: plan.rest, rest: plan.rest, shot: shot.stand > 0 ? shot : {}, sway: false }, plan.P, plan.cfg);
}

function sightOf(rig, h) {
  const dx = h.X - rig.C[0], dy = h.Y - rig.C[1], dz = h.Z - rig.C[2];
  return { az: Math.atan2(-dx, -dz), el: Math.asin(dy / (Math.hypot(dx, dy, dz) || 1)) };
}
/**
 * How the crystal renderer must turn to be seen from where the camera stands: the bearing turns it, the line's
 * height tips it (the painted view's -0.2 rad at rest, the true angle once the placed shot is in).
 */
export function turnOf(rig, plan) {
  const s = sightOf(rig, plan.heart), u = rig.stand || 0;
  return { yaw: -(s.az - plan.sight0.az), pitch: u * (s.el + 0.2) };
}

/**
 * Where the crystal is drawn by this rig: its feet point (canvas px) and its size relative to rest. It HOVERS, so it
 * is placed from its heart's true projection, not stood on its floor spot (a feet-anchored cut-out bobbed as the camera
 * came down: mockup 11l).
 */
export function crystalPlacement(plan, rig) {
  const hp = projectLive(plan.heart, rig);
  const k = (rig.f / hp.depth) / (plan.rig0.f / plan.hp0.depth);
  return { x: hp.x, y: hp.y + CRYSTAL_UP_FX * plan.px * k, k, heart: { x: hp.x, y: hp.y }, depth: hp.depth };
}

/** The party's alpha for a rig (hidden as the stand blends in). */
export const partyAlpha = (rig) => 1 - clamp01((rig?.stand || 0) / PARTY_FADE);
