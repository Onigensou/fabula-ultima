// ============================================================================
// Nidhogg's return: the whole show on one clock (pure; no DOM, no Foundry,
// Node-testable). A port of the approved mockup's timeline (tools/nidhogg-return-
// mockup/work/script.js v21: plan(), GL, ROAR, CAMF / camAt, CLOSE, BURST, the HUD
// band, brk.doneAt), approved by the user 2026-11-15 ("I think we should
// implement this one"). Every number is the mockup's at its default chips:
// Length 3.6 s, Pause 2 s, Camera On, Closing beat On, Burst 220, smoke 30 fps.
//
// The user's rulings, kept from the mockup (HANDOFF.md "Ruled so far"):
//   Phase 1 — the dark closes in on the crystal (it never moves, never "sinks"),
//     beams first, then the glass, then the core, which stays at full brightness.
//     The front never stops ("don't hold by stopping it"): it slows all the way,
//     slowest just before the core is gone. Then ONE star of light where the core
//     was (arms up / down, longer left / right) that dims, cools to a dark green
//     pixel and wavers in length as it goes out.
//   Phase 2 — a few s of black (chip 1 / 2 / 3 s; 2 picked) -> his eyes, mouth and
//     claws come up TOGETHER, slowly ("unveil the green light pieces together, but
//     more gradual") -> wind-up (brighter, a rumble) -> he ROARS (rings of light
//     from his mouth, shake) and the roar blows the dark away as 3D smoke; he stays
//     hidden until the smoke is blown off him; his face must be clear.
//   Camera — in the black, before his glow shows, it pushes in slowly to where his
//     face will be, keeps creeping in through the unveil and the wind-up; at the
//     roar it pulls back hard, past the battle framing, then eases back.
//   Closing beat — HIS LOOK ("something more menacing" than the eye glint): the
//     screen darkens toward its edges (the party stays lit), his eye and mouth glow
//     up and throb twice (a heartbeat), and his eye BURSTS into flame ("a short
//     burst should work better" than two standing tongues).
//   HUD — hidden for the whole animation: gone over its first 0.3 s, back over its
//     last 0.5 s.
//   The leftover wisps round his feet were dropped ("doesn't look good", v19).
//
// Rules on this clock (boss-cycle.js returnBoss): `hidden` = the core is gone (it
// goes out of play), `reveal` = the pierce, the roar (the boss is back: full
// HP / MP, in play, the cycle's next phase), `end` = the battle goes on.
// ============================================================================

const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
const smooth = (a, b, v) => { const u = clamp((v - a) / (b - a)); return u * u * (3 - 2 * u); };

/** The mockup's defaults (its chips as the user left them). */
export const RETURN_DEFAULTS = Object.freeze({
  len: 3.6,          // the dark closes in until the core is gone (s; chips 2.6 / 3.6 / 4.6)
  pause: 2,          // the black before his glow (s; chips 1 / 2 / 3)
  burstN: 220,       // his eye's flame puffs (chips 120 / 220 / 360: 120 scattered like confetti in the tail)
  smokeHz: 60,       // the phase-2 smoke's frame rate, at most (the client's fxFrameRate caps it; 30 until the 60 fps pass, 2026-11-17)
  ringHz: 30,        // the roar's rings and his eye's flame: painted on this thread at this rate (the smoke's 30 before)
  // brk.doneAt: the last billow out of sight (s after the pierce), from return-smoke.js makeReturnSmoke at the
  // mockup's inputs (fixtures/return-smoke.json). The show may pass its own (its smoke's .doneAt).
  doneAt: 2.7729822986924413,
  // the crystal frame's farthest pixel from the heart, in crystal heights (mockup: 560 x 620 frame, Float32 D[];
  // the game's 608 x 548 frame gives ~3.1665). Only the beat markers glassAt / coreAt read it.
  dmax: Math.fround(3.179599750977162),
});

/** Phase 1's front (shared with the close-in pass, WP3): crystal heights from the heart. */
export const CLOSE_IN = Object.freeze({ CORE_R: 0.17, EDGE: 0.2, EDGE_CORE: 0.07, RAG: 0.14, DECAY: 4 });
/** The soul's last light: born LEAD s before the core is gone, out `glint` s after. */
export const AFTER = Object.freeze({ glint: 2.6, lead: 0.45 });
/** Phase 2's glow-through (s from p2): up out of nothing, breathe, the wind-up; the roar starts at windup. */
export const GL = Object.freeze({ unveil: 2.2, hold: 2.6, windup: 3.15 });
/** The roar's rings of light (s from the pierce; speed effect px / s). FACE_PX: half his face, where they start. */
export const ROAR = Object.freeze({ len: 1.15, rings: 7, every: 0.13, speed: 560, life: 0.65, facePx: 48 });
/**
 * The camera, in the mockup's canvas px at the battle framing (1682 x 946 crop of the Great Seal; WP5 maps it):
 * face = the middle of his head; at = where it sits pushed in (a fraction of the screen: a little left, room on his
 * facing side); s / creep = pushed in, and where the creep ends at the roar; wide / out / back = the pull-back.
 */
export const CAMF = Object.freeze({ face: Object.freeze({ x: 730, y: 505 }), at: Object.freeze({ fx: 0.42, fy: 0.5 }), s: 2.0, creep: 2.12, wide: 0.92, out: 0.5, back: 1.5 });
/** His look (tau, s): up / hold / down; dim = how dark the screen's edges get. */
export const CLOSE = Object.freeze({ at: 1.6, up: 0.4, hold: 1.0, down: 0.8, dim: 0.85 });
/** His eye's burst (s since the look began): bursts at t, emission window, smoulder. */
export const BURST = Object.freeze({ t: 0.22, emit: 0.16, smoulder: 0.9 });
/** The HUD (s): out over the first 0.3, back over the last 0.5. */
export const HUD = Object.freeze({ out: 0.3, back: 0.5 });

const closeEnd = () => CLOSE.at + CLOSE.up + CLOSE.hold + CLOSE.down;
const E1 = Math.exp(-CLOSE_IN.DECAY);
/** The front's radius at T (phase 1), crystal heights from the heart: ONE curve, speed e^-4s, slowest at the end. */
export const frontAt = (T, len, dmax = RETURN_DEFAULTS.dmax) =>
  (dmax + CLOSE_IN.EDGE_CORE) * (Math.exp(-CLOSE_IN.DECAY * clamp(T / len)) - E1) / (1 - E1) - CLOSE_IN.EDGE_CORE;
/** Its inverse: the fraction of `len` at which the front is at f. */
export const sAt = (f, dmax = RETURN_DEFAULTS.dmax) =>
  -Math.log(((f + CLOSE_IN.EDGE_CORE) / (dmax + CLOSE_IN.EDGE_CORE)) * (1 - E1) + E1) / CLOSE_IN.DECAY;

/**
 * The timeline (s from the start of the return), as the mockup's plan():
 *   glassAt / coreAt (phase 1 markers), gone (the core is gone), black, p2 (his glow begins), pierce (the roar),
 *   clear (the last smoke gone), look / burst (the closing beat), end (the battle goes on).
 */
export function returnPlan(o = {}) {
  const len = Number(o.len) > 0 ? Number(o.len) : RETURN_DEFAULTS.len;
  const pause = Number.isFinite(Number(o.pause)) && Number(o.pause) >= 0 ? Number(o.pause) : RETURN_DEFAULTS.pause;
  const doneAt = Number(o.doneAt) > 0 ? Number(o.doneAt) : RETURN_DEFAULTS.doneAt;
  const dmax = Number(o.dmax) > 0 ? Number(o.dmax) : RETURN_DEFAULTS.dmax;
  const gone = len, black = gone + AFTER.glint, p2 = black + pause, pierce = p2 + GL.windup;
  return Object.freeze({
    len, pause, doneAt, dmax, burstN: Number(o.burstN) > 0 ? Math.round(Number(o.burstN)) : RETURN_DEFAULTS.burstN,
    smokeHz: Number(o.smokeHz) > 0 ? Number(o.smokeHz) : Number(globalThis.__FU_RETURN_SMOKE_HZ__) > 0 ? Number(globalThis.__FU_RETURN_SMOKE_HZ__) : RETURN_DEFAULTS.smokeHz,
    ringHz: Number(o.ringHz) > 0 ? Number(o.ringHz) : RETURN_DEFAULTS.ringHz,
    glassAt: sAt(1.05, dmax) * len, coreAt: sAt(CLOSE_IN.CORE_R + 0.02, dmax) * len,
    gone, black, p2, pierce, clear: pierce + doneAt,
    look: pierce + CLOSE.at, burst: pierce + CLOSE.at + BURST.t,
    end: pierce + Math.max(doneAt + 0.6, closeEnd() + 0.6),
  });
}

/**
 * The return's sound (§8c; the user's picks in the mockup's audition, v23, 2026-11-16 — every other moment is
 * deliberately silent). One-shots on the plan's beats, played by the shared cue rule (start = beat - peak, so the
 * loudest moment lands on the beat; peaks measured by the mockup's sfx-fetch). Files are under SOUND_BASE.
 */
export function returnSfx(P = returnPlan()) {
  return [
    { beat: P.pierce, file: "Soundboard/Monster4.ogg", vol: 0.75, peak: 0.15, label: "he roars" },
    { beat: P.look, file: "Soundboard/Darkness3.ogg", vol: 0.45, peak: 0.15, label: "his look" },
    { beat: P.burst, file: "Soundboard/Fire1.ogg", vol: 0.55, peak: 0.35, label: "his eye bursts into flame" },
  ];
}
/** The dark closing in on the crystal: a BED (fades in 0.8 s, loops, fades out over its last 1.2 s, gone at the core's end). */
export const returnBed = (P = returnPlan()) => Object.freeze({ from: 0.02, to: P.gone, file: "BGS/Darkness.ogg", vol: 0.45, fadeIn: 0.8, fadeOut: 1.2 });

/** The beats the rules wait on (s on the show's clock). */
export const returnBeats = (P = returnPlan()) => Object.freeze({ hidden: P.gone, reveal: P.pierce, end: P.end });
export const returnEnd = (P = returnPlan()) => P.end;

/**
 * A client that starts LATE (it joined, reloaded or redrew its canvas while the return plays): the second of the
 * return it starts at, from the GM's start and now (both server ms, game.time.serverTime). 0 without a start (or a
 * start in the future: clock skew); null once nothing is left to show (inside its last LATE_MIN s).
 */
export const LATE_MIN = 0.25;
export function lateStartAt(startedAt, now, P = returnPlan()) {
  const t = Number(startedAt), n = Number(now);
  if (!Number.isFinite(t) || !(t > 0) || !Number.isFinite(n)) return 0;
  const s = Math.max(0, (n - t) / 1000);
  return s >= P.end - LATE_MIN ? null : s;
}

/** The mockup's beat list (the timeline's captions), for rigs and the status read. */
export function returnBeatList(P = returnPlan()) {
  return [[0, "The Crystal Round ends"], [0.02, "The dark closes in: the far ends of its beams go first"], [P.glassAt, "Its tips and edges, then the glass"],
    [P.coreAt, "Only its core is left, at full light; the dark slows as it closes on it"], [P.gone - AFTER.lead, "Its light gathers into a star as the last of it shrinks"],
    [P.gone, "The core is gone: its last light, at full strength"], [P.gone + 0.5, "The light goes out, wavering, slowest at the end"], [P.black, "Black"],
    [P.black + 0.2, "In the black, the camera pushes in slowly to where his face will be"],
    [P.p2, "Phase 2: his eyes, mouth and claws come up out of the dark, together"], [P.p2 + GL.hold, "The wind-up: they burn brighter, a rumble"],
    [P.pierce, "He roars: the camera pulls back hard and the roar blows the dark off him"], [P.pierce + 0.6, "He is uncovered; the smoke rolls out over the seal"],
    [P.clear, "The arena is back"], [P.look, "His look: the light pulls away from all but him"], [P.burst, "His eye bursts into flame"]];
}

/** The camera at T: s = scale, k = 0 the battle framing .. 1 his face at CAMF.at (the mockup's camAt). */
export function camAt(T, P = returnPlan()) {
  let k = 0, s = 1;
  if (T != null && T >= P.black) {
    const tau = T - P.pierce;
    if (tau < 0) {
      // slow push in over the black, settled just before his glow is seen (it is ~2 % at p2 + 0.4); then the creep
      k = smooth(P.black + 0.2, P.p2 + 0.4, T);
      s = Math.exp(Math.log(CAMF.s) * k) * (1 + (CAMF.creep / CAMF.s - 1) * clamp((T - P.p2 - 0.4) / (P.pierce - P.p2 - 0.4)));
    } else if (tau < CAMF.back) {
      // the roar: out fast and slowing (cubic), past the battle framing, then eased back onto it
      const o = 1 - Math.pow(1 - clamp(tau / CAMF.out), 3);
      k = 1 - o;
      s = tau < CAMF.out ? Math.exp(Math.log(CAMF.creep) + (Math.log(CAMF.wide) - Math.log(CAMF.creep)) * o) : CAMF.wide + (1 - CAMF.wide) * smooth(CAMF.out, CAMF.back, tau);
    }
  }
  return { s, k };
}

/** His look's strength at u = tau - CLOSE.at (0..1), and the heartbeat (1 + two throbs). */
export function closeK(u) {
  const end = CLOSE.up + CLOSE.hold + CLOSE.down;
  if (u < 0 || u > end) return 0;
  return u < CLOSE.up ? smooth(0, CLOSE.up, u) : 1 - smooth(CLOSE.up + CLOSE.hold, end, u);
}
export const throb = (u) => 1 + 0.3 * (Math.exp(-((u - CLOSE.up - 0.15) ** 2) / 0.005) + Math.exp(-((u - CLOSE.up - 0.6) ** 2) / 0.005));

/** The glow-through's strength per part at T (the mockup's drawGlow: L = up * breathe * gone * boost). */
export function glowAt(T, P = returnPlan()) {
  const g0 = T - P.p2, tau = T - P.pierce;
  if (g0 < 0) return null;
  const up = Math.pow(smooth(0, GL.unveil, g0), 1.6);                      // slow out of nothing
  const breathe = g0 > GL.unveil ? 0.88 + 0.12 * Math.sin((g0 - GL.unveil) * 4.2) : 1;
  const wind = smooth(GL.hold, GL.windup, g0);                             // the wind-up: brighter
  // the roar: one burst of light, short, then the glow is gone fast once he is uncovered (the user, 2026-11-15: at
  // 0.55 s into the roar his face was still covered, by the mouth's own flaring halo and its outlines, not by smoke)
  const roar = tau > 0 ? Math.max(0, 1 - tau / 0.25) : 0;
  const gone = tau > 0 ? 1 - smooth(0.05, 0.35, tau) : 1;
  const L = (k) => up * breathe * gone * (1 + (k === "mouth" ? 0.9 : 0.4) * wind + (k === "mouth" ? 1.2 : 0.5) * roar);
  return { eyes: L("eyes"), mouth: L("mouth"), claws: L("claws") };
}

/** The shake at T, screen px (the wind-up's rumble, then the roar's shake, held, easing off). */
export function shakeAt(T, P = returnPlan()) {
  const tau = T - P.pierce, g0 = T - P.p2;
  if (g0 < 0) return { x: 0, y: 0, amp: 0 };
  const sh = tau > 0 ? 7 * (tau < 0.15 ? 1 : Math.max(0, 1 - (tau - 0.15) / (ROAR.len + 0.3))) : 1.6 * smooth(GL.hold, GL.windup, g0);
  return { x: Math.round(Math.sin(tau * 91) * sh), y: Math.round(Math.cos(tau * 67) * sh * 0.6), amp: sh };
}

/** The HUD's level at T: 1 shown .. 0 hidden. */
export const hudAt = (T, P = returnPlan()) => (T == null ? 1 : Math.max(1 - smooth(0, HUD.out, T), smooth(P.end - HUD.back, P.end, T)));

/**
 * Everything at time T (s from the start of the return):
 *   phase  — "close" (the dark closes in, T < gone) | "light" (the soul's last light) | "black" | "glow" (p2 ..
 *            pierce: eyes, mouth, claws come up, the wind-up) | "roar" (pierce .. clear: the smoke blown off him) |
 *            "look" (the closing beat) | "after" | "done"
 *   beat   — the index into returnBeatList, and its caption
 *   hidden / revealed / done — past those beats (the rules' clock)
 *   close  — phase 1: { T, len, front (crystal heights), lastK (the soul burns brighter as the glass goes) } or null
 *   glintU — T - gone, while the soul's last light lives ([-lead, glint)), else null
 *   g0     — T - p2 (the glow's clock), tau — T - pierce (the smoke / roar clock; < 0 before)
 *   smoke  — the smoke is drawn (tau in [0, doneAt + 0.6))
 *   glow   — per-part strength (glowAt) or null; rings — the roar's rings are up; flash — the break's white flash
 *   lookU  — tau - CLOSE.at while the look plays, else null; look (closeK), beat throb, burstF (u - BURST.t)
 *   cam    — { s, k }; shake { x, y, amp }; hud (1 shown .. 0 hidden)
 */
export function returnState(T, P = returnPlan()) {
  T = Math.max(0, Number(T) || 0);
  const tau = T - P.pierce, g0 = T - P.p2, beats = returnBeatList(P);
  let bi = 0; beats.forEach(([at], i) => { if (T >= at) bi = i; });
  const lookU = tau - CLOSE.at, lookOn = lookU >= 0 && lookU <= CLOSE.up + CLOSE.hold + CLOSE.down;
  const phase = T >= P.end ? "done" : T < P.gone ? "close" : T < P.black ? "light" : T < P.p2 ? "black" : T < P.pierce ? "glow"
    : lookOn ? "look" : T < P.clear ? "roar" : "after";
  const u = T - P.gone;
  return {
    T, phase, beat: bi, caption: beats[bi][1],
    hidden: T >= P.gone, revealed: T >= P.pierce, done: T >= P.end,
    close: T < P.gone ? { T, len: P.len, front: frontAt(T, P.len, P.dmax), lastK: smooth(P.glassAt, P.coreAt, T) } : null,
    glintU: u >= -AFTER.lead && u < AFTER.glint ? u : null,
    g0, tau,
    smoke: tau >= 0 && tau < P.doneAt + 0.6,
    glow: glowAt(T, P),
    rings: tau > 0 && tau <= ROAR.rings * ROAR.every + ROAR.life,
    flash: tau > 0 && tau < 0.2 ? 0.18 * (1 - tau / 0.2) : 0,
    lookU: lookOn ? lookU : null, look: lookOn ? closeK(lookU) : 0, throb: lookOn ? throb(lookU) : 1,
    burstF: lookOn ? lookU - BURST.t : null,
    cam: camAt(T, P), shake: shakeAt(T, P), hud: hudAt(T, P),
  };
}
