// ============================================================================
// Nidhogg's battle opening, "nidhogg-awakening" — the clock and the camera plan (pure; no DOM, no Foundry,
// Node-testable: nidhogg-awakening.test.mjs). The show that plays it: nidhogg-awakening-show.js.
//
// The user's direction (2026-11-19, verbatim in docs/nidhogg-boss-design.md §8d):
//   "Starting from the usual screen crack, instead of the screen breaking per usual, the black smoke start leaking
//    out of multiple points along the crack, until the screen turn black. A glimp of both dragon eyes flashes in the
//    blackness with its shapes (not sprite shape) briefly seen before back to blackness. 4 seconds after, a close up
//    of one of its claw with slow panning camera, then another similar shot at the wing (flip horizontally for
//    variation. The wing expands slightly for dynamic movement). Then, blackness before its roar that dispel the
//    smoke, introducing it at full body, 35 degree to emphasize its view from the front. 1 second after its roar
//    ends, moves the camera back to battle position, then the HUD shows and continue per usual. Skip players and
//    guest entrance animation. Fade them in when the camera get to position after the roar."
//
// Beats 1-2 (crack -> smoke leak -> black, the eyes) are the crack-out (nidhogg-crack-out.js, mocked up apart). This
// clock starts at the black the crack-out ends on (its eyes are gone), in SECONDS:
//   0           black (the eyes just went)
//   claw0       4 s later: the claw close-up fades up out of the dark, the camera panning slowly
//   wing0       a cut in the black: the wing close-up, composed as the claw shot MIRRORED (subject on the other side
//               of the frame, the pan the other way); the wing spreads slightly (rig motion wingSpread)
//   black0      black again
//   smoke0      Nidhogg's return smoke (opening mode) starts: its veil is the dark he is hidden in
//   roar0       his rig's roar starts (breath in), so its jaw snap lands on the pierce
//   pierce      the roar: the smoke is blown off him, he is revealed full body, camera at 35 degrees from his front
//   roarEnd     the rig's roar is over
//   back0       1 s after: the camera moves back to the battle position (the rest framing, yaw / tilt 0)
//   arrive      there: the party and guests fade in, the HUD shows, the usual start goes on (BATTLE START)
// ============================================================================

import { rigCamera, liveBattler, battlerDrawScale, floorPoint3, restPxPerMetre } from "../battle-director/battle-stage-3d-rules.js";

const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
const smooth = (a, b, v) => { const u = clamp((v - a) / (b - a)); return u * u * (3 - 2 * u); };
const lerp = (a, b, u) => a + (b - a) * u;

/** The beats' lengths (s). roar*: the rig's roar (rig-motions.js: 0.8 breath + 0.3 snap + hold + 1.1 settle; peak 1.1). */
export const AWAKENING = Object.freeze({
  afterEyes: 4.0,                                     // "4 seconds after" the glimpse of his eyes
  claw: Object.freeze({ len: 3.6, fadeIn: 0.6, fadeOut: 0.45 }),
  wing: Object.freeze({ len: 3.6, fadeIn: 0.5, fadeOut: 0.45, spreadAt: 0.2 }),
  black: 0.6,                                         // the black before the roar
  lead: 1.6,                                          // the smoke starts this long before the pierce (veil up, the breath in)
  uncover: Object.freeze({ at: 0.1, len: 0.4 }),      // the black cover lifts off the smoke's veil (s after smoke0)
  roarHold: 1.6, roarPeak: 1.1, roarSettle: 1.1, roarIn: 1.1,
  afterRoar: 1.0,                                     // "1 second after its roar ends"
  back: 1.8,                                          // the camera's move back to the battle position
  revealVignette: 0.5,                                // the soft dark round the reveal (cover vignette level)
  fadeIn: Object.freeze({ ms: 600, stagger: 90 }),    // the party / guests at the arrival (the usual enemy fade's numbers)
});

/**
 * The camera per shot: a PLACED shot of the 3D camera (battle-stage-3d camera.stand: a real camera standing on the
 * floor, level, looking at a point; the 2D view stays on the battle framing, so the backdrop always fills the
 * screen). Per shot, round HIM (his feet on the floor, his height tallM in metres):
 *   bearing   degrees round him from straight-on (the line from him to the battle camera); + = toward the side his
 *             face is on (he faces the party, right), - = toward his tail
 *   distK     the camera's distance from his feet, x his height;  eyeK  the camera's height, x his height
 *   uv        the point of his PAINTING the shot is about (0..1 of the 859 x 837 sprite, unmirrored: he faces LEFT in
 *             the painting);  at  where it sits on the screen (fractions), start -> end of the shot (the pan)
 *   span      how many screen heights his whole painting is drawn (the close-up's size; the lens is solved for it)
 *   fit       (the reveal) his whole body's share of the screen height, centred at `at`
 * The look point and the lens are SOLVED through the real rig each frame (solvePlaced) so the subject lands at `at`.
 */
export const SHOTS = Object.freeze({
  // subject on the LEFT third; the camera arcs round to the right as it pans (bearing 10 -> 26), so he drifts
  // right -> left across the frame (0.36 -> 0.24): a clear, readable pan (2026-11-19 v3: the first, 42 -> 34 %, read
  // as nearly still)
  claw: Object.freeze({ uv: Object.freeze({ u: 0.192, v: 0.851 }), span: 3.4, eyeK: 0.12, distK: 0.9, bearing: Object.freeze([10, 26]),
    at: Object.freeze([Object.freeze({ x: 0.36, y: 0.58 }), Object.freeze({ x: 0.24, y: 0.58 })]) }),
  // the reveal (v3, the user: "move the camera closer during the roar. Let him have the whole screen"): a camera
  // CLOSER to him (distK 1.3, was 2.1), his painting 1.5 screen heights tall round his chest, so his body runs past
  // every edge with his face and jaw clear on the right. heading: the camera's own yaw (degrees, + = swung round to the
  // right, as the 3D camera reports it and his rig turns by): the user's "35 degree"; the bearing round him is solved
  // v4 (the user: "his face should be in the center vertically. and a bit more center horizontally"): the shot is
  // aimed at his FACE (the head between eye and jaw, painting px ~180, 470), put at the screen's vertical centre and
  // 57 % across (it sat ~68 % across, right of centre), the same close camera and 35 degrees
  reveal: Object.freeze({ uv: Object.freeze({ u: 0.21, v: 0.56 }), span: 1.5, heading: 35, bearing: 25, eyeK: 0.3, distK: 1.3, at: Object.freeze({ x: 0.57, y: 0.5 }) }),
});

/**
 * The wing shot: "another similar shot at the wing (flip horizontally for variation)". Composed exactly like the claw
 * shot (subject on the left third, the camera arcing right) on the wing, and then the IMAGE is flipped horizontally
 * (flip: the show mirrors the canvas for this shot), so on screen it is the claw shot's mirror: subject on the RIGHT
 * third, the pan running the other way (left -> right), and he faces the other way. (v1 mirrored only the composition
 * and the camera's side; the user did not see it as flipped, 2026-11-19.)
 */
export function flippedShot(s, o) {
  return Object.freeze({ ...s, ...o, uv: Object.freeze({ ...o.uv }), flip: true });
}
export const WING_SHOT = flippedShot(SHOTS.claw, { uv: { u: 0.652, v: 0.31 }, span: 1.7, eyeK: 0.35, distK: 1.1 });
/** Where a shot's subject is on the SCREEN (a flipped shot's image is mirrored). */
export const screenAt = (cam) => (cam?.flip ? { x: 1 - cam.at.x, y: cam.at.y } : { ...cam.at });

/** The timeline (s from the black the crack-out ends on). o: overrides of AWAKENING's lengths. */
export function awakeningPlan(o = {}) {
  const A = { ...AWAKENING, ...o };
  const roarLen = A.roarIn + A.roarHold + A.roarSettle;
  const claw0 = A.afterEyes, wing0 = claw0 + A.claw.len, black0 = wing0 + A.wing.len;
  const smoke0 = black0 + A.black, pierce = smoke0 + A.lead, roar0 = pierce - A.roarPeak;
  const roarEnd = roar0 + roarLen, back0 = roarEnd + A.afterRoar, arrive = back0 + A.back;
  const fadeEnd = arrive + (A.fadeIn.ms + 3 * A.fadeIn.stagger) / 1000;
  return Object.freeze({
    A, claw0, wing0, black0, smoke0, pierce, roar0, roarEnd, roarLen, back0, arrive, fadeEnd,
    spreadAt: wing0 + A.wing.spreadAt,
    total: fadeEnd,
  });
}

/**
 * The opening's sound (beats 3-7), on the show's clock, by the shared cue rule (shared/sfx-cues.js: a cue STARTS at
 * beat - peak, so its loudest moment lands on the beat; peaks measured from the files' envelopes, 2026-11-19). Files
 * are under SOUND_BASE, played with the house helper (director-sfx playSfx) on every client. (The deep breath in before
 * the roar, Soundboard/Absorb2.ogg, was cut at the user's ask, 2026-11-19.) The blacks are left
 * silent; the roar itself is the return smoke's own cue (Soundboard/Monster4.ogg on the pierce, nidhogg-return.js
 * returnSfx), listed here as `owner: "return"` so a rig sees the whole score but the show does not play it twice.
 */
export function awakeningSfx(P = awakeningPlan()) {
  return [
    { beat: P.claw0 + 0.4, file: "Soundboard/Growl.ogg", vol: 0.42, peak: 0.7, label: "a low rumble of breath under the claw shot" },
    { beat: P.spreadAt + 0.65, file: "Soundboard/Wind5.ogg", vol: 0.42, peak: 0.5, label: "the wing spreads: a heavy whoosh" },
    { beat: P.spreadAt + 0.7, file: "Soundboard/SE_SWINGF.wav", vol: 0.3, peak: 0.05, label: "the weight of the wing at full spread" },
    { beat: P.pierce, file: "Soundboard/Monster4.ogg", vol: 0.75, peak: 0.15, label: "he roars (the return smoke's cue)", owner: "return" },
    { beat: P.pierce + 0.9, file: "Soundboard/Darkness5.ogg", vol: 0.4, peak: 0.4, label: "a dark swell as the smoke rolls off him" },
  ];
}

/** The beat list (captions), for rigs and the stills. */
export function awakeningBeats(P = awakeningPlan()) {
  return [[0, "Black: the eyes are gone"], [P.claw0, "The claw close-up fades up, the camera panning slowly"],
    [P.wing0, "Cut: the wing close-up, mirrored; the wing spreads slightly"], [P.black0, "Black"],
    [P.smoke0, "The smoke he is hidden in"], [P.roar0, "He breathes in"], [P.pierce, "He roars: the smoke is blown off him (35 degrees, his front)"],
    [P.roarEnd, "The roar is over"], [P.back0, "1 s later: the camera moves back to the battle position"],
    [P.arrive, "Battle position: the party fades in, the HUD shows"]];
}

/**
 * The black cover at t: { black (solid, 0..1), vignette (the dark round a close-up, 0..1) }. Solid black at every
 * cut, so the camera can jump between shots unseen.
 */
export function coverAt(t, P = awakeningPlan()) {
  const A = P.A;
  if (t < P.claw0) return { black: 1, vignette: 0 };
  const shot = (t0, S) => {
    const u = t - t0;
    const up = smooth(0, S.fadeIn, u), down = smooth(S.len - S.fadeOut, S.len, u);
    return { black: clamp(1 - up + down), vignette: 1 };
  };
  if (t < P.wing0) return shot(P.claw0, A.claw);
  if (t < P.black0) return shot(P.wing0, A.wing);
  const u0 = P.smoke0 + A.uncover.at;
  if (t < u0) return { black: 1, vignette: 0 };
  // the reveal is framed out of a soft dark (his introduction; it also keeps the eye off the backdrop's far edge the
  // 35-degree camera sees past), lifting as the camera moves back to the battle position
  const vig = A.revealVignette * (t < P.back0 ? smooth(P.pierce, P.pierce + 0.6, t) : 1 - smooth(P.back0, P.arrive, t));
  return { black: 1 - smooth(u0, u0 + A.uncover.len, t), vignette: vig };
}

/**
 * The camera at t: { shot, ... }.
 *   "claw" / "wing": { uv, at, span, bearing, eyeK, distK, u } (the pan: `at` and `bearing` move linearly);
 *   "reveal": { uv, at, fit, bearing, eyeK, distK } from the black before the roar until back0;
 *   "back": { stand } 1 -> 0 (eased): the placed camera hands back to the battle camera (it travels round its look
 *   point, battle-stage-3d placedRig); "rest" once there.
 * Shots are held through their black (the camera stands where the next fade-up needs it).
 */
export function cameraAt(t, P = awakeningPlan()) {
  const A = P.A;
  const pan = (S, t0, len) => {
    const u = clamp((t - t0) / len);
    return { uv: S.uv, span: S.span, eyeK: S.eyeK, distK: S.distK, bearing: lerp(S.bearing[0], S.bearing[1], u), at: { x: lerp(S.at[0].x, S.at[1].x, u), y: lerp(S.at[0].y, S.at[1].y, u) }, u, stand: 1, flip: !!S.flip };
  };
  if (t < P.wing0) return { shot: "claw", ...pan(SHOTS.claw, P.claw0, A.claw.len) };
  if (t < P.black0) return { shot: "wing", ...pan(WING_SHOT, P.wing0, A.wing.len) };
  const R = SHOTS.reveal;
  if (t < P.back0) return { shot: "reveal", uv: R.uv, span: R.span, heading: R.heading, bearing: R.bearing, eyeK: R.eyeK, distK: R.distK, at: { ...R.at }, stand: 1 };
  if (t < P.arrive) return { shot: "back", stand: 1 - smooth(P.back0, P.arrive, t) };
  return { shot: "rest", stand: 0 };
}

/**
 * Where a point of the painting (uv, unmirrored) is on his 2D spot (scene px). rect = his mesh's 2D rect; mirrored =
 * the token is flipped (he faces right in battle). The rig turns his model about its vertical centre line by the
 * camera's yaw, so the point's offset from that line shrinks by cos(yaw) (its depth's share is left out: small).
 */
export function pointOnRect(rect, uv, mirrored = false, yawDeg = 0) {
  const c = Math.cos(((Number(yawDeg) || 0) * Math.PI) / 180);
  const u = 0.5 + (uv.u - 0.5) * c;
  return { x: rect.x + (mirrored ? 1 - u : u) * rect.w, y: rect.y + uv.v * rect.h };
}

/**
 * The 2D view that puts the drawn point d at screen fraction `at`, at `scale` (canvas.pan's numbers). screen = { w, h }.
 * Under the 3D camera `d` is where that point is drawn for this view (iterate: see the show).
 */
export function viewFor(d, at, scale, screen) {
  return { x: d.x - ((at.x - 0.5) * screen.w) / scale, y: d.y - ((at.y - 0.5) * screen.h) / scale, scale };
}

/** Linear blend of two views (the move back to the battle position; k already eased). */
export function blendView(a, b, k) {
  return { x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), scale: Math.exp(lerp(Math.log(a.scale), Math.log(b.scale), k)) };
}

/**
 * The placed shot (battle-stage-3d camera.stand's keys) that frames his painting's point `cam.uv` at screen fraction
 * `cam.at`, `cam.span` screen heights tall (or, with `cam.fit`, his body `fit` of the screen), from a camera standing
 * `cam.bearing` degrees round him at distK / eyeK x his height. Solved through the real rig (rigCamera ->
 * liveBattler -> his drawn card: the same maths the camera draws him with): the lens for the size, the look point
 * (across the view and its height) for the place, a few Newton steps.
 *   model   { P, cfg, rest } (battle-stage-3d camera.model()); the 2D view is the rest view
 *   feet    his 2D feet (canvas px); rect his mesh's 2D rect (canvas px); mirrored: the token is flipped (faces right)
 *   screen  { w, h } the visible window in canvas px at the rest view (screen px / rest.scale)
 * -> { shot, rig, drawn: { x, y } (canvas px), size (his drawn height, canvas px), err (canvas px), tallM, dist, eye }
 */
export function solvePlaced(o) {
  const { cam } = o;
  if (cam.heading == null) return solveAt(o, cam.bearing);
  // `heading`: the camera's yaw is what is asked for; the bearing round him that gives it (yaw grows ~1:1 with it)
  let b = Number(cam.bearing) || 0, S = null;
  for (let i = 0; i < 6; i++) {
    S = solveAt(o, b);
    const e = cam.heading - S.rig.yaw;
    if (Math.abs(e) < 0.05) break;
    b += e * (o.mirrored ? 1 : -1);
  }
  S.bearing = b;
  return S;
}

function solveAt({ model, feet, rect, mirrored = false, screen, cam }, bearing) {
  const { P, cfg, rest } = model;
  const F = floorPoint3(feet, P), ppm = restPxPerMetre(feet.y, P), tallM = rect.h / ppm;
  const facing = mirrored ? 1 : -1;
  const canvasOf = ({ X, Z }) => { const z = Math.min(-0.5, Z); return { x: P.cx + (P.f * X) / -z, y: P.hz + (P.f * P.Hp) / -z }; };
  // straight-on = from him toward the battle camera (the origin), on the floor; turned `bearing` toward his face side
  let vx = -F.X, vz = -F.Z; const n = Math.hypot(vx, vz) || 1; vx /= n; vz /= n;
  const th = (facing * (Number(bearing) || 0) * Math.PI) / 180, c = Math.cos(th), sn = Math.sin(th);
  const dx = vx * c + vz * sn, dz = -vx * sn + vz * c;
  const dist = Math.max(2.2, (cam.distK ?? 1) * tallM), eye = Math.max(0.3, (cam.eyeK ?? 0.3) * tallM);
  const A = canvasOf({ X: F.X + dx * dist, Z: F.Z + dz * dist });
  // the camera looks back along -d; across the view = right of that heading
  const rx = dz, rz = -dx;
  const target = { x: rest.x + (cam.at.x - 0.5) * screen.w, y: rest.y + (cam.at.y - 0.5) * screen.h };
  const wantSize = cam.fit != null ? cam.fit * screen.h : (cam.span ?? 1) * screen.h;
  const sub = cam.fit != null ? { u: 0.5, v: 0.5 } : cam.uv;
  const shotOf = (o, h, lens) => {
    const L = canvasOf({ X: F.X + rx * o, Z: F.Z + rz * o });
    return { stand: 1, standX: A.x, standY: A.y, eye, lookX: L.x, lookY: L.y, lookH: h, lens, faceX: L.x, faceY: L.y };
  };
  const draw = (o, h, lens) => {
    const shot = shotOf(o, h, lens);
    const rig = rigCamera({ view: rest, rest, shot, sway: false }, P, cfg);
    const b = liveBattler(feet, P, rig), m = battlerDrawScale(b.scale, rig);
    const p = pointOnRect(rect, sub, mirrored, rig.yaw);
    return { shot, rig, x: b.x + (p.x - feet.x) * m, y: b.y + (p.y - feet.y) * m, size: rect.h * m };
  };
  // start: look at the subject's height above his feet, straight at him
  let o = 0, h = Math.max(0.1, (feet.y - (rect.y + sub.v * rect.h)) / ppm), lens = 1;
  let d = draw(o, h, lens);
  for (let i = 0; i < 8; i++) {
    if (d.size > 0) lens = Math.max(0.05, Math.min(20, lens * (wantSize / d.size)));
    d = draw(o, h, lens);
    const ex = target.x - d.x, ey = target.y - d.y;
    if (Math.hypot(ex, ey) < 0.5 && Math.abs(d.size - wantSize) < 0.5) break;
    // Jacobian by finite differences (canvas px per metre of look shift / look height)
    const e = 0.05, dO = draw(o + e, h, lens), dH = draw(o, h + e, lens);
    const a11 = (dO.x - d.x) / e, a21 = (dO.y - d.y) / e, a12 = (dH.x - d.x) / e, a22 = (dH.y - d.y) / e;
    const det = a11 * a22 - a12 * a21;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-9) break;
    o += (a22 * ex - a12 * ey) / det; h += (-a21 * ex + a11 * ey) / det;
    d = draw(o, h, lens);
  }
  return { shot: d.shot, rig: d.rig, drawn: { x: d.x, y: d.y }, size: d.size, err: Math.hypot(target.x - d.x, target.y - d.y), tallM, dist, eye };
}
