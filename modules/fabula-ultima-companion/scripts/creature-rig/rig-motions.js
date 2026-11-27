// ============================================================================
// creature-rig/rig-motions.js — named motions for a 3D creature rig (pure; no Foundry, no THREE)
//
// A rig is posed by a handful of CHANNELS (degrees unless noted):
//   jaw     lower jaw open on its hinge            (+ = open)
//   lift    skull lifted on the neck                (+ = up)
//   breath  chest rise, -1..1 (x 4 px at full weight)
//   tail    tail swing
//   wings   wing beat about each wing root          (- = flare up/back)
//   tailPhase  seconds, drives the tail's travelling wave
//
// The ANIMATOR keeps a looping idle under any number of one-shot motions. One-shots are ADDITIVE over the
// idle and may quiet it (`calm`) while they run; each fades in/out so overlapping calls never pop.
// play() returns a handle: { done, peak, cancel() } (the same motion asked for while it runs joins the running one) where `done` resolves when the motion ends and `peak`
// when it reaches its marked moment (the roar's jaw snap), so callers can time a shake or a sound to it.
//
// Motions are data: defineMotion(name, spec). spec.sample(t, opts) returns a partial channel object for t in
// seconds since the motion started; spec.duration(opts) its length; spec.peakAt(opts) the peak time.
// ============================================================================

export const CHANNELS = ["jaw", "lift", "breath", "tail", "wings"];
const ZERO = () => ({ jaw: 0, lift: 0, breath: 0, tail: 0, wings: 0 });

export const ease = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
export const outBack = (t) => { t = Math.min(1, Math.max(0, t)); const s = 1.6; return 1 + (s + 1) * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2); };

const MOTIONS = new Map();

/** Register (or replace) a named motion. */
export function defineMotion(name, spec) {
  if (!name || typeof spec?.sample !== "function") throw new Error(`creature-rig: motion "${name}" needs a sample(t, opts)`);
  MOTIONS.set(name, {
    calm: 0.35, fadeIn: 0.12, fadeOut: 0.25,
    duration: () => 1, peakAt: () => 0,
    ...spec,
  });
}
export function motionNames() { return [...MOTIONS.keys()]; }
export function hasMotion(name) { return MOTIONS.has(name); }

// ---- idle: slow breath, a small nod, the tail swaying, the wings shifting (the motion test's idle) ----
export function idle(t, k = 1) {
  const TAU = 2 * Math.PI;
  return {
    jaw: k * 2.5 * (0.5 + 0.5 * Math.sin((t * TAU) / 5.3)),
    lift: k * 1.6 * Math.sin((t * TAU) / 5.3 - 0.6),
    breath: k * Math.sin((t * TAU) / 3.9),
    tail: k * 6 * Math.sin((t * TAU) / 4.4),
    wings: k * 4 * Math.sin((t * TAU) / 3.9 + 0.8),
  };
}

// ---- roar: breath in with the head dipped, SNAP the jaw open while the head rises on the neck (reptiles open
// wide that way), hold with a tremor and the wings flared, settle. Options:
//   hold   seconds held at full roar (default 1.6)
//   jaw    full gape in degrees (default 32; the painted mouth is drawn for 32)
//   head   head lift at full roar (default 16; 0 = jaw only)
//   wings  wing flare at full roar (default -18)
defineMotion("roar", {
  calm: 0.35,
  fadeIn: 0, fadeOut: 0,                       // the timeline starts and ends at rest by itself
  duration: (o = {}) => 0.8 + 0.3 + (o.hold ?? 1.6) + 1.1,
  peakAt: () => 1.1,
  sample(t, o = {}) {
    const HOLD = o.hold ?? 1.6, J = o.jaw ?? 32, HD = o.head ?? 16, WG = o.wings ?? -18;
    const t1 = 0.8, t2 = 1.1, t3 = t2 + HOLD, t4 = t3 + 1.1;
    let jaw, head, breath, wings;
    if (t < t1) { const e = ease(t / t1); jaw = -5 * e; head = -5 * e; breath = 1.2 * e; wings = -4 * e; }
    else if (t < t2) { const e = outBack((t - t1) / (t2 - t1)); jaw = -5 + (J + 5) * e; head = -5 + (HD + 5) * e; breath = 1.2 - 1.6 * e; wings = -4 + (WG + 4) * e; }
    else if (t < t3) {
      jaw = J + 1.6 * Math.sin(t * 31) + 0.8 * Math.sin(t * 53); head = HD + 0.7 * Math.sin(t * 41);
      breath = -0.4; wings = WG + 2.5 * Math.sin(t * 23);
    } else if (t < t4) { const e = ease((t - t3) / (t4 - t3)); jaw = J * (1 - e); head = HD * (1 - e); breath = -0.4 * (1 - e); wings = WG * (1 - e); }
    else { jaw = 0; head = 0; breath = 0; wings = 0; }
    return { jaw, lift: head, breath, wings };
  },
});

// ---- flinch: a short recoil (hit reaction). Options: strength (default 1)
defineMotion("flinch", {
  calm: 0.6, fadeIn: 0, fadeOut: 0,
  duration: () => 0.55,
  peakAt: () => 0.08,
  sample(t, o = {}) {
    const k = o.strength ?? 1;
    const e = t < 0.08 ? ease(t / 0.08) : 1 - ease((t - 0.08) / 0.47);
    return { lift: -7 * k * e, jaw: 6 * k * e, wings: -5 * k * e, breath: -0.5 * k * e };
  },
});

// ---- snarl: jaw parts and holds briefly (a threat beat). Options: hold (default 0.8), jaw (default 12)
defineMotion("snarl", {
  calm: 0.5, fadeIn: 0, fadeOut: 0,
  duration: (o = {}) => 0.35 + (o.hold ?? 0.8) + 0.45,
  peakAt: () => 0.35,
  sample(t, o = {}) {
    const H = o.hold ?? 0.8, J = o.jaw ?? 12;
    const e = t < 0.35 ? ease(t / 0.35) : t < 0.35 + H ? 1 : 1 - ease((t - 0.35 - H) / 0.45);
    return { jaw: J * e + (e > 0.99 ? 0.6 * Math.sin(t * 37) : 0), lift: 3 * e };
  },
});

// ---- wingSpread: the wings open a little and hold, then settle (a slow, breathing spread for a close-up; the
// battle opening's wing shot, 2026-11-19). Options:
//   spread  wing angle at full spread (default -14; - = flare up/back, the roar's flare is -18)
//   rise    seconds to open (default 1.1), hold (default 1.4) held open with a slow drift, fall (default 1.0)
defineMotion("wingSpread", {
  calm: 0.6, fadeIn: 0, fadeOut: 0,             // starts and ends at rest by itself
  duration: (o = {}) => (o.rise ?? 1.1) + (o.hold ?? 1.4) + (o.fall ?? 1.0),
  peakAt: (o = {}) => o.rise ?? 1.1,
  sample(t, o = {}) {
    const S = o.spread ?? -14, R = o.rise ?? 1.1, H = o.hold ?? 1.4, F = o.fall ?? 1.0;
    let k;
    if (t < R) k = ease(t / R);
    else if (t < R + H) k = 1;
    else k = 1 - ease((t - R - H) / F);
    // held open: a slow drift a little further out, so the hold is never a freeze
    const drift = t >= R && t < R + H ? 0.12 * Math.sin((Math.PI * (t - R)) / H) : 0;
    return { wings: S * (k + drift * k), breath: 0.5 * k };
  },
});

// ---- clawSwipe: rear up with the jaw parting and the wings lifting, then SLAM the head down and forward as the
// claws rake (the peak), hold the snarl a beat, settle (Nidhogg's Claw, 2026-11-19). Options: strength (default 1)
defineMotion("clawSwipe", {
  calm: 0.4, fadeIn: 0, fadeOut: 0,             // starts and ends at rest by itself
  duration: () => 1.25,
  peakAt: () => 0.5,
  sample(t, o = {}) {
    const k = o.strength ?? 1;
    let lift, jaw, wings, breath;
    if (t < 0.38) { const e = ease(t / 0.38); lift = 11 * e; jaw = 12 * e; wings = -14 * e; breath = e; }
    else if (t < 0.5) { const e = ease((t - 0.38) / 0.12); lift = 11 - 21 * e; jaw = 12 + 7 * e; wings = -14 + 19 * e; breath = 1 - 1.6 * e; }
    else if (t < 0.75) { lift = -10; jaw = 19 + 0.8 * Math.sin(t * 37); wings = 5; breath = -0.6; }
    else if (t < 1.25) { const e = 1 - ease((t - 0.75) / 0.5); lift = -10 * e; jaw = 19 * e; wings = 5 * e; breath = -0.6 * e; }
    else { lift = 0; jaw = 0; wings = 0; breath = 0; }
    return { lift: lift * k, jaw: jaw * k, wings: wings * k, breath: breath * k };
  },
});

// ---- tailStrike: coil the tail back and down, then SNAP it forward over the back (the peak: the stab lands),
// quiver there, settle (Nidhogg's Tail Stab, 2026-11-19). Options: reach (tail angle at the strike, default 34),
// hold (seconds quivering at full reach, default 0.3)
defineMotion("tailStrike", {
  calm: 0.4, fadeIn: 0, fadeOut: 0,             // starts and ends at rest by itself
  duration: (o = {}) => 0.5 + 0.12 + (o.hold ?? 0.3) + 0.6,
  peakAt: () => 0.58,
  sample(t, o = {}) {
    const T = o.reach ?? 34, H = o.hold ?? 0.3, t1 = 0.5, t2 = 0.62, t3 = t2 + H, t4 = t3 + 0.6;
    let tail, lift, breath, wings;
    if (t < t1) { const e = ease(t / t1); tail = -16 * e; lift = 3 * e; breath = 0.8 * e; wings = -5 * e; }
    else if (t < t2) { const u = (t - t1) / (t2 - t1), e = ease(u); tail = -16 + (T + 16) * outBack(u); lift = 3 - 6 * e; breath = 0.8 - 1.2 * e; wings = -5 + 7 * e; }
    else if (t < t3) { const q = 1 - (t - t2) / Math.max(0.01, H); tail = T + 1.5 * q * Math.sin(t * 40); lift = -3; breath = -0.4; wings = 2; }
    else if (t < t4) { const e = 1 - ease((t - t3) / (t4 - t3)); tail = T * e; lift = -3 * e; breath = -0.4 * e; wings = 2 * e; }
    else { tail = 0; lift = 0; breath = 0; wings = 0; }
    return { tail, lift, breath, wings };
  },
});

// ---- beamBreath: a breath weapon. The head rears back and lifts while the jaw opens slowly (the charge: soul
// gathering in the mouth), then at the peak the head THRUSTS forward and down with the jaw snapped wide (the
// release), held with a tremor while the beam pours out, and settles (Nidhogg's Wailing Breath, 2026-11-19). Options:
//   charge  seconds of the slow opening (default 1.7; the peak)   hold  seconds held wide (default 3.4)
//   jaw     full gape (default 34)   head  head drop at the release (default -7; the charge lifts it +9)
//   slam    seconds from the start of a second thrust inside the hold (optional; off by default)
defineMotion("beamBreath", {
  calm: 0.3, fadeIn: 0, fadeOut: 0,             // starts and ends at rest by itself
  duration: (o = {}) => (o.charge ?? 1.7) + 0.12 + (o.hold ?? 3.4) + 0.9,
  peakAt: (o = {}) => o.charge ?? 1.7,
  sample(t, o = {}) {
    const C = o.charge ?? 1.7, H = o.hold ?? 3.4, J = o.jaw ?? 34, HD = o.head ?? -7;
    const t1 = C, t2 = C + 0.12, t3 = t2 + H, t4 = t3 + 0.9;
    let jaw, lift, breath, wings;
    if (t < t1) { const u = t / t1, e = ease(u); jaw = 20 * u * u; lift = 9 * e; breath = 1.3 * e; wings = -10 * e; }
    else if (t < t2) { const u = (t - t1) / (t2 - t1); jaw = 20 + (J - 20) * outBack(u); lift = 9 + (HD - 9) * ease(u); breath = 1.3 - 1.9 * ease(u); wings = -10 - 6 * ease(u); }
    else if (t < t3) {
      jaw = J + 1.4 * Math.sin(t * 33) + 0.7 * Math.sin(t * 57); lift = HD + 0.8 * Math.sin(t * 43); breath = -0.6; wings = -16 + 2 * Math.sin(t * 21);
      // o.slam (seconds): a second, harder thrust mid-hold (the massive beam after a thin feint), decaying over ~0.4 s
      if (o.slam > t2 && t >= o.slam) { const s = t - o.slam, kk = s < 0.06 ? s / 0.06 : Math.exp(-(s - 0.06) * 7); jaw += 6 * kk; lift -= 5 * kk; wings -= 6 * kk; }
    }
    else if (t < t4) { const e = 1 - ease((t - t3) / (t4 - t3)); jaw = J * e; lift = HD * e; breath = -0.6 * e; wings = -16 * e; }
    else { jaw = 0; lift = 0; breath = 0; wings = 0; }
    return { jaw, lift, breath, wings };
  },
});

// ---- inhale: the jaw opens wide and HOLDS open through a long draw of breath while the head pulls back and up
// (a tremor in the last half second), then at the peak (`swallow`) the jaw SNAPS shut with the head thrust forward,
// and it settles (Nidhogg's Soul Devour, 2026-11-20). Options:
//   swallow  seconds from the start to the swallow (default 2.5; the peak)   jaw   full gape (default 30)
//   head     head lift while drawing breath (default +10)   thrust  head at the swallow, forward (default -6)
defineMotion("inhale", {
  calm: 0.3, fadeIn: 0, fadeOut: 0,             // starts and ends at rest by itself
  duration: (o = {}) => (o.swallow ?? 2.5) + 0.12 + 0.9,
  peakAt: (o = {}) => o.swallow ?? 2.5,
  sample(t, o = {}) {
    const S = o.swallow ?? 2.5, J = o.jaw ?? 30, HD = o.head ?? 10, TH = o.thrust ?? -6;
    const t2 = S + 0.12, t3 = t2 + 0.9;
    let jaw, lift, breath, wings;
    if (t < 0.1) { jaw = 0; lift = 0; breath = 0; wings = 0; }
    else if (t < 0.3) { const e = ease((t - 0.1) / 0.2); jaw = 8 * e; lift = 3 * e; breath = 0.4 * e; wings = 0; }
    else if (t < S) {
      const u = Math.min(1, (t - 0.3) / Math.max(0.01, S - 0.3)), e = ease(u);
      jaw = 8 + (J - 8) * Math.pow(u, 1.5); lift = 3 + (HD - 3) * e; breath = 0.4 + 0.9 * e; wings = -6 * e;
      const w = ease((t - (S - 0.5)) / 0.5);    // the last half second: a tremor as the breath tops out
      jaw += w * 1.2 * Math.sin(t * 33); lift += w * 0.6 * Math.sin(t * 41);
    }
    else if (t < t2) { const u = (t - S) / (t2 - S), e = ease(u); jaw = J * (1 - e) - 2 * Math.sin(Math.PI * u); lift = HD + (TH - HD) * e; breath = 1.3 - 2.3 * e; wings = -6 + 8 * e; }
    else if (t < t3) { const e = 1 - ease((t - t2) / (t3 - t2)); jaw = 0; lift = TH * e; breath = -1 * e; wings = 2 * e; }
    else { jaw = 0; lift = 0; breath = 0; wings = 0; }
    return { jaw, lift, breath, wings };
  },
});

// ---- hurl: a throw from the mouth. The head rears back and up with the jaw parting (the catch: something is pulled
// into the mouth), holds it there with a tremor and a last wind-up, then at the peak SNAPS forward and down with the
// jaw thrown wide (the release), follows through a beat and settles (Nidhogg's Soul Strike, 2026-11-28). Options:
//   peak    seconds from the start to the release (default 1.15)   jaw   full gape at the release (default 28)
//   rear    head lift while holding (default +10)   thrust  head at the release, forward and down (default -8)
defineMotion("hurl", {
  calm: 0.3, fadeIn: 0, fadeOut: 0,             // starts and ends at rest by itself
  duration: (o = {}) => (o.peak ?? 1.15) + 0.12 + 0.2 + 0.45,
  peakAt: (o = {}) => o.peak ?? 1.15,
  sample(t, o = {}) {
    const P = o.peak ?? 1.15, J = o.jaw ?? 28, RR = o.rear ?? 10, TH = o.thrust ?? -8;
    const t0 = Math.min(0.3, P * 0.26), tw = Math.max(t0, P - 0.15), t2 = P + 0.12, t3 = t2 + 0.2, t4 = t3 + 0.45;
    const JH = 0.55 * J;                         // the jaw held part-open round the thing in the mouth
    let jaw, lift, breath, wings;
    if (t < t0) { const e = ease(t / t0); jaw = JH * 0.7 * e; lift = RR * e; breath = 0.8 * e; wings = -6 * e; }
    else if (t < P) {
      const u = (t - t0) / Math.max(0.01, P - t0), w = ease((t - tw) / Math.max(0.01, P - tw));   // w: the last wind-up
      jaw = JH * (0.7 + 0.3 * ease(u)) + 0.9 * Math.sin(t * 37) * ease(u * 3) * (1 - w); lift = RR + 3 * w; breath = 0.8 + 0.4 * w; wings = -6 - 4 * w;
    }
    else if (t < t2) { const u = (t - P) / (t2 - P), e = ease(u); jaw = JH + (J - JH) * outBack(u); lift = RR + 3 + (TH - RR - 3) * e; breath = 1.2 - 2 * e; wings = -10 - 6 * e; }
    else if (t < t3) { const q = 1 - (t - t2) / (t3 - t2); jaw = J * (0.85 + 0.15 * q); lift = TH + 0.8 * Math.sin(Math.PI * q) * Math.sin(t * 43); breath = -0.8; wings = -16 + 4 * (1 - q); }
    else if (t < t4) { const e = 1 - ease((t - t3) / (t4 - t3)); jaw = J * 0.85 * e; lift = TH * e; breath = -0.8 * e; wings = -12 * e; }
    else { jaw = 0; lift = 0; breath = 0; wings = 0; }
    return { jaw, lift, breath, wings };
  },
});

/** One animator per rigged token (per client). Time is in seconds, supplied by the caller. */
export class RigAnimator {
  constructor() {
    this.active = [];        // {name, spec, opts, t0, dur, peak, resolve, peakResolve, peaked, fadeOutAt, cancelled}
    this.idleOn = true;
    this.idleK = 1;          // current idle weight (eased toward idleOn ? 1 : 0)
    this.restK = 0;          // 1 = everything held at rest (rest())
    this.restTarget = 0;
    this.restRate = 4;
    this.now = 0;
  }

  /** Start a named motion. Returns { done, peak, cancel }. Unknown names resolve at once with ok:false. */
  play(name, opts = {}, now = this.now) {
    const spec = MOTIONS.get(name);
    if (!spec) return { done: Promise.resolve({ ok: false, reason: "unknown-motion" }), peak: Promise.resolve(false), cancel() {} };
    // the same motion asked for again while it runs JOINS it (a roar while roaring keeps roaring; restarting
    // would snap the jaw shut mid-gape). opts.restart: true starts over instead.
    if (opts.exclusive !== false && !opts.restart) {
      const run = this.active.find((o) => o.name === name);
      if (run) return { done: run.doneP, peak: run.peakP, cancel: () => this.#finish(run, "cancelled"), joined: true };
    }
    const speed = opts.speed > 0 ? opts.speed : 1;
    const dur = spec.duration(opts) / speed, peak = spec.peakAt(opts) / speed;
    let resolve, peakResolve;
    const done = new Promise((r) => { resolve = r; });
    const peakP = new Promise((r) => { peakResolve = r; });
    const m = { name, spec, opts, speed, t0: now, dur, peak, resolve, peakResolve, peaked: false, cancelled: false, doneP: done, peakP };
    if (opts.exclusive !== false) for (const o of [...this.active]) if (o.name === name) this.#finish(o, "replaced");
    this.active.push(m);
    if (this.restTarget) this.release();
    return { done, peak: peakP, cancel: () => this.#finish(m, "cancelled") };
  }

  #finish(m, reason) {
    if (m.cancelled) return;
    m.cancelled = true;
    const i = this.active.indexOf(m); if (i >= 0) this.active.splice(i, 1);   // a cancelled/replaced motion stops contributing
    if (!m.peaked) { m.peaked = true; m.peakResolve(false); }
    m.resolve({ ok: reason === "ended", reason, name: m.name });
  }

  /** Hold the rig at its painted rest pose (front view of the painting), easing there over `ms`. */
  rest(ms = 250) { this.restTarget = 1; this.restRate = 1000 / Math.max(1, ms); for (const m of [...this.active]) this.#finish(m, "rest"); }
  /** Let it move again after rest(). */
  release(ms = 400) { this.restTarget = 0; this.restRate = 1000 / Math.max(1, ms); }
  get resting() { return this.restTarget === 1 && this.restK >= 0.999; }
  get busy() { return this.active.length > 0; }

  /** Advance to `now` (seconds) and return the pose channels. */
  sample(now) {
    const dt = Math.max(0, Math.min(0.25, now - this.now)); this.now = now;
    this.restK += (this.restTarget - this.restK) * Math.min(1, dt * this.restRate * 1.5);
    if (Math.abs(this.restK - this.restTarget) < 0.002) this.restK = this.restTarget;
    const p = ZERO();
    let calm = 1;
    for (const m of [...this.active]) {
      const t = (now - m.t0) * m.speed;
      const tt = now - m.t0;
      if (!m.peaked && tt >= m.peak) { m.peaked = true; m.peakResolve(true); }
      if (tt >= m.dur) { this.#finish(m, "ended"); continue; }
      const fi = m.spec.fadeIn > 0 ? Math.min(1, tt / m.spec.fadeIn) : 1;
      const fo = m.spec.fadeOut > 0 ? Math.min(1, (m.dur - tt) / m.spec.fadeOut) : 1;
      const w = Math.min(fi, fo);
      const s = m.spec.sample(t, m.opts) || {};
      for (const c of CHANNELS) if (typeof s[c] === "number") p[c] += s[c] * w;
      calm = Math.min(calm, 1 - (1 - m.spec.calm) * w);
    }
    const idleTarget = this.idleOn ? calm : 0;
    this.idleK += (idleTarget - this.idleK) * Math.min(1, dt * 6);
    const id = idle(now, this.idleK);
    p.jaw += id.jaw; p.lift += id.lift; p.breath += id.breath * (this.active.length ? 0.5 : 1); p.tail += id.tail; p.wings += id.wings;
    const k = 1 - this.restK;
    for (const c of CHANNELS) p[c] *= k;
    p.tailPhase = now;
    return p;
  }

  /** Is the pose (as last sampled) indistinguishable from rest? Lets the host skip re-rendering. */
  static isRest(p, eps = 0.02) { return CHANNELS.every((c) => Math.abs(p[c]) < eps); }
}
