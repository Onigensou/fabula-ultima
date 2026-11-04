// ============================================================================
// Wisps — layered spirit-light particles for 2D canvas overlays (no Foundry,
// no DOM). First built for the defeat lab (FFX-style pyreflies), kept here so
// any overlay effect can pull them in.
//
// A wisp is four layers: a white-hot core a pixel or two wide, a thin
// four-point glint that turns and twinkles, a faint coloured halo, and a
// tapered ribbon trail of its last ~0.3 s. It lifts off, rises faster as it
// goes and sways in a slow curve. Vapour is the soft, tall haze that can sit
// under a group of wisps.
//
// Units: positions are in TOKEN HEIGHTS from the centre of the body they rise
// out of (x right, y down), so `draw(ctx, r)` projects them onto the body's
// on-screen rect { x, y (centre), h } every frame and a camera move carries
// the whole effect along. Times are ms. `rnd` is injectable for tests.
//
// Used by: defeat-fx.js (the crimson wisps of the FF7 red fade).
// ============================================================================

export const WISP_PALETTES = {
  // FFX pyreflies: mostly cyan, some sea green, pale violet
  spirit:  ["150,225,255", "150,225,255", "140,255,215", "185,240,255", "205,185,255", "175,255,195"],
  // the FF7 red fade's own: crimson, ember, rose
  crimson: ["255,80,95", "255,80,95", "255,120,90", "255,150,135", "255,95,140", "255,175,120"],
};

/**
 * An alpha for a colour string. A tiny number prints as "1e-7", which is not a
 * valid colour and makes a gradient call throw — so clamp and fix the digits.
 */
export function wispAlpha(x) {
  return (x > 0 ? Math.min(1, x) : 0).toFixed(3);
}

/** A halo colour from a palette ("r,g,b"). `pixelRgb` ([r,g,b]) pulls it half-way to that pixel's hue. */
export function pickWispColour(palette = "spirit", rnd = Math.random, pixelRgb = null) {
  const list = WISP_PALETTES[palette] ?? WISP_PALETTES.spirit;
  const s = list[Math.floor(rnd() * list.length) % list.length];
  if (!pixelRgb) return s;
  const sp = s.split(",").map(Number);
  return pixelRgb.map((c, i) => Math.round((c + (255 - c) * 0.45) * 0.6 + sp[i] * 0.4)).join(",");
}

const between = (rnd, a, b) => a + rnd() * (b - a);

export class Wisp {
  /**
   * x, y: start, in token heights from the body's centre. cx: the body's centre
   * x in the same units (wisps drift outward from it). life: ms.
   */
  constructor({ x = 0, y = 0, rgb = WISP_PALETTES.spirit[0], life = 1200, cx = 0, rnd = Math.random, core = 0.016, minCorePx = 1.3 } = {}) {
    this.x = x; this.y = y; this.rgb = rgb; this.life = life; this.age = 0;
    this.vx = (x - cx) * between(rnd, 0.3, 0.8); this.vy = -between(rnd, 0.1, 0.35);
    this.core = core; this.minCorePx = minCorePx;
    this.phase = between(rnd, 0, 6.28); this.freq = between(rnd, 0.6, 1.3); this.sway = between(rnd, 2.5, 4.5);
    this.rise = between(rnd, 1.3, 1.9); this.rot = between(rnd, 0, 6.28); this.spin = between(rnd, -0.6, 0.6);
    this.trail = [[x, y]]; this.lastPush = 0;
  }

  /** Advance by dt ms. Returns false once it has burnt out. */
  update(dt) {
    this.age += dt;
    const s = dt / 1000;
    const ax = Math.sin((this.age / 1000) * this.freq * 6.283 + this.phase) * this.sway;
    this.vx += ax * s; this.vy -= this.rise * s;
    const k = Math.exp(-1.5 * s); this.vx *= k; this.vy *= k;
    this.x += this.vx * s; this.y += this.vy * s; this.rot += this.spin * s;
    if (this.age - this.lastPush >= 16) {
      this.trail.push([this.x, this.y]); this.lastPush = this.age;
      if (this.trail.length > 20) this.trail.shift();
    }
    return this.age < this.life;
  }

  /** Draw onto ctx over the body rect r = { x, y (centre), h } in screen px. */
  draw(ctx, r) {
    const k = this.age / this.life;
    const a = Math.min(1, this.age / 180) * (k > 0.6 ? 1 - (k - 0.6) / 0.4 : 1);
    if (!(a > 0) || !(r?.h > 0)) return;
    const X = (u) => r.x + u * r.h, Y = (v) => r.y + v * r.h;
    const px = X(this.x), py = Y(this.y);
    const rad = Math.max(this.minCorePx, this.core * r.h) * (1 - 0.35 * k);
    const t = this.trail, n = t.length;
    ctx.save();
    ctx.globalCompositeOperation = "lighter"; ctx.lineCap = "round";
    // trail: halo colour, then a white thread down its newer half
    for (let i = 1; i < n; i++) {
      const f = i / n;
      ctx.strokeStyle = `rgba(${this.rgb},${wispAlpha(0.42 * f * a)})`; ctx.lineWidth = rad * 2.4 * f;
      ctx.beginPath(); ctx.moveTo(X(t[i - 1][0]), Y(t[i - 1][1])); ctx.lineTo(X(t[i][0]), Y(t[i][1])); ctx.stroke();
    }
    for (let i = Math.max(1, Math.floor(n * 0.5)); i < n; i++) {
      const f = (i - n * 0.5) / (n * 0.5);
      ctx.strokeStyle = `rgba(255,255,255,${wispAlpha(0.45 * f * a)})`; ctx.lineWidth = Math.max(0.6, rad * 0.6 * f);
      ctx.beginPath(); ctx.moveTo(X(t[i - 1][0]), Y(t[i - 1][1])); ctx.lineTo(X(t[i][0]), Y(t[i][1])); ctx.stroke();
    }
    // halo
    const hr = rad * 7;
    let g = ctx.createRadialGradient(px, py, 0, px, py, hr);
    g.addColorStop(0, `rgba(${this.rgb},${wispAlpha(0.5 * a)})`);
    g.addColorStop(0.35, `rgba(${this.rgb},${wispAlpha(0.16 * a)})`);
    g.addColorStop(1, `rgba(${this.rgb},0)`);
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(px, py, hr, 0, 6.283); ctx.fill();
    // glint: a long cross and a short diagonal one
    const tw = 0.6 + 0.4 * Math.sin(this.age * 0.013 + this.phase);
    const L = rad * 7.5 * tw;
    ctx.translate(px, py); ctx.rotate(this.rot);
    for (let q = 0; q < 4; q++) {
      const len = q < 2 ? L : L * 0.5, al = (q < 2 ? 0.85 : 0.45) * a * tw;
      ctx.save(); ctx.rotate(q * Math.PI / 2 + (q >= 2 ? Math.PI / 4 : 0));
      const lg = ctx.createLinearGradient(-len, 0, len, 0);
      lg.addColorStop(0, "rgba(255,255,255,0)");
      lg.addColorStop(0.5, `rgba(255,255,255,${wispAlpha(al)})`);
      lg.addColorStop(1, "rgba(255,255,255,0)");
      ctx.strokeStyle = lg; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(-len, 0); ctx.lineTo(len, 0); ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
    // core
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    g = ctx.createRadialGradient(px, py, 0, px, py, rad * 1.9);
    g.addColorStop(0, `rgba(255,255,255,${wispAlpha(a)})`);
    g.addColorStop(0.5, `rgba(255,255,255,${wispAlpha(0.7 * a)})`);
    g.addColorStop(1, `rgba(${this.rgb},0)`);
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(px, py, rad * 1.9, 0, 6.283); ctx.fill();
    ctx.restore();
  }
}

export class Vapour {
  /** x, y: start in token heights from the body's centre. rgb: haze colour. */
  constructor({ x = 0, y = 0, life = 1100, rgb = "120,190,255", rnd = Math.random } = {}) {
    this.x = x; this.y = y; this.life = life; this.age = 0; this.rgb = rgb;
    this.r = between(rnd, 0.07, 0.13); this.vy = -between(rnd, 0.25, 0.45); this.phase = between(rnd, 0, 6.28);
  }
  update(dt) { this.age += dt; this.y += this.vy * dt / 1000; return this.age < this.life; }
  draw(ctx, r) {
    const k = this.age / this.life, a = Math.sin(Math.PI * k) * 0.16;
    if (!(a > 0) || !(r?.h > 0)) return;
    const px = r.x + (this.x + Math.sin(this.age * 0.004 + this.phase) * 0.04) * r.h, py = r.y + this.y * r.h;
    const rad = this.r * (1 + k * 0.8) * r.h;
    ctx.save();
    ctx.globalCompositeOperation = "screen";
    ctx.translate(px, py); ctx.scale(1, 2.6);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rad);
    g.addColorStop(0, `rgba(${this.rgb},${wispAlpha(a)})`); g.addColorStop(1, `rgba(${this.rgb},0)`);
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, rad, 0, 6.283); ctx.fill();
    ctx.restore();
  }
}

/**
 * A burst of wisps out of a body, as a schedule: `count` wisps released between
 * fromMs and fromMs + spawnOverMs, each living lifeMs [min, max], coloured from
 * `palette`. Start points are spread over the body (an ellipse `spread` wide in
 * token heights, from the shoulders to the feet). Sorted by release time.
 */
export function scheduleWisps({ count = 8, fromMs = 0, spawnOverMs = 500, lifeMs = [900, 1200], palette = "spirit", spread = 0.5 } = {}, rnd = Math.random) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const ang = rnd() * Math.PI * 2, rad = Math.sqrt(rnd());
    out.push({
      at: fromMs + rnd() * spawnOverMs,
      life: between(rnd, lifeMs[0], lifeMs[1]),
      x: Math.cos(ang) * rad * spread * 0.5,
      y: Math.sin(ang) * rad * 0.38 + 0.02,
      rgb: pickWispColour(palette, rnd),
    });
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * Runs a schedule from scheduleWisps: call step(t, dt) every frame (t = ms
 * since the effect began) and draw(ctx, r). `alive` is true while anything is
 * still waiting or burning.
 */
export class WispBurst {
  constructor(schedule, rnd = Math.random) { this.queue = schedule.slice(); this.live = []; this.rnd = rnd; }
  get alive() { return this.queue.length > 0 || this.live.length > 0; }
  step(t, dt) {
    while (this.queue.length && this.queue[0].at <= t) {
      const s = this.queue.shift();
      this.live.push(new Wisp({ x: s.x, y: s.y, rgb: s.rgb, life: s.life, rnd: this.rnd }));
    }
    if (dt > 0) this.live = this.live.filter((w) => w.update(dt));
  }
  draw(ctx, r) { for (const w of this.live) w.draw(ctx, r); }
}
