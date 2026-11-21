// ═════════ move-engine · shared fx core (host-neutral; loaded right after the host engine)
// Particle helpers written only in terms of the engine API (addP, glow's canvas 2D, rnd, EASE, FAST). Moved out of
// the Nox / Lionheart mockup engine (part-engine.nx.js) unchanged, so both hosts draw them from the same code.
const tint = (hue, sat = 5, br = 1.1) => `sepia(1) saturate(${sat}) hue-rotate(${hue - 38}deg) brightness(${br})`;
const glow = (c, x, y, r, rgb, a) => { if (r <= 0) return; const g = c.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, `rgba(${rgb},${a})`); g.addColorStop(1, `rgba(${rgb},0)`); c.fillStyle = g; c.beginPath(); c.arc(x, y, r, 0, 7); c.fill(); };
function ember(layer, x, y, rgb = "255,140,60", o = {}) { addP(layer, { x, y, vx: rnd(-.03, .03), vy: rnd(-.12, -.05), life: rnd(1400, 2600), r: rnd(2, 5), ...o,
  draw: (c, p, t) => { const a = Math.sin(t * Math.PI); glow(c, p.x + Math.sin(p.t / 300) * 6, p.y, p.r * 3, rgb, a * .9); } }); }
function dust(layer, x, y, rgb, o = {}) { addP(layer, { x, y, vx: rnd(-.02, .02), vy: rnd(-.02, .02), life: rnd(1800, 3400), r: rnd(1, 2.6), ...o,
  draw: (c, p, t) => { const a = Math.sin(t * Math.PI) * (.5 + .5 * Math.sin(p.t / 120 + p.x)); c.fillStyle = `rgba(${rgb},${a})`; c.beginPath(); c.arc(p.x, p.y, p.r, 0, 7); c.fill(); glow(c, p.x, p.y, p.r * 4, rgb, a * .35); } }); }
function shards(layer, pt, rgb = "220,200,255", n = 14, spread = .5) { for (let i = 0; i < n; i++) { const an = rnd(0, Math.PI * 2), sp = rnd(.15, spread);
  addP(layer, { x: pt.x, y: pt.y, vx: Math.cos(an) * sp, vy: Math.sin(an) * sp - .2, g: .0012, drag: .985, life: rnd(600, 1000), rot: rnd(0, 6), vr: rnd(-.02, .02), s: rnd(5, 11),
    draw: (c, p, t) => { p.rot += p.vr * 16; c.translate(p.x, p.y); c.rotate(p.rot); c.globalAlpha = 1 - t; c.fillStyle = `rgba(${rgb},1)`; c.beginPath(); c.moveTo(0, -p.s); c.lineTo(p.s * .6, 0); c.lineTo(0, p.s * .9); c.lineTo(-p.s * .5, 0); c.fill(); } }); } }
function homing(layer, from, to, rgb, { ms = 900, arc = 120, r = 4, onDie } = {}) { const cx = (from.x + to.x) / 2 + rnd(-arc, arc), cy = Math.min(from.y, to.y) - rnd(arc * .3, arc);
  addP(layer, { x: from.x, y: from.y, life: ms * rnd(.85, 1.15), r, onDie, update: (p) => { const t = EASE.in(Math.min(1, p.t / p.life)); const u = 1 - t;
      p.px = p.x; p.py = p.y; p.x = u*u*from.x + 2*u*t*cx + t*t*to.x; p.y = u*u*from.y + 2*u*t*cy + t*t*to.y; },
    draw: (c, p) => { glow(c, p.x, p.y, p.r * 3.5, rgb, .95); c.strokeStyle = `rgba(${rgb},.5)`; c.lineWidth = p.r; c.beginPath(); c.moveTo(p.px ?? p.x, p.py ?? p.y); c.lineTo(p.x, p.y); c.stroke(); } }); }
// speed lines on the screen canvas: dir = travel angle of the LINES (rad); radial when vp given
let SL = null;
function speedLines(on, { angle = 0, vp = null, color = "255,255,255", alpha = .5, n = 26 } = {}) {
  if (SL) { SL.run = false; SL = null; } if (!on || FAST) return; const s = { run: true }; SL = s;
  const lines = Array.from({ length: n }, () => ({ u: MOVE_RNG(), off: rnd(-1, 1), len: rnd(.15, .45), sp: rnd(.0015, .003), w: rnd(1, 3.2) }));
  traceEv("speedLines", { on: true, angle: Math.round(angle * 100) / 100, alpha, n });
  addP("screen", { x: 0, y: 0, life: 1e9, update: (p, dt) => { if (!s.run) p.dead = true; for (const l of lines) { l.u += l.sp * dt; if (l.u > 1.3) { l.u = -.3; l.off = rndFx(-1, 1); } } },
    draw: (c) => { for (const l of lines) { c.strokeStyle = `rgba(${color},${alpha * (.4 + l.w / 4)})`; c.lineWidth = l.w;
      if (vp) { const a = l.off * Math.PI; const r0 = l.u * 1100, r1 = r0 + l.len * 700; c.beginPath(); c.moveTo(vp.x + Math.cos(a) * r0, vp.y + Math.sin(a) * r0); c.lineTo(vp.x + Math.cos(a) * r1, vp.y + Math.sin(a) * r1); c.stroke(); }
      else { const ca = Math.cos(angle), sa = Math.sin(angle), nx = -sa, ny = ca; const along = (l.u * 2 - 1) * 1300, perp = l.off * 900; const x0 = W / 2 + ca * along + nx * perp, y0 = H / 2 + sa * along + ny * perp; c.beginPath(); c.moveTo(x0, y0); c.lineTo(x0 + ca * l.len * 900, y0 + sa * l.len * 900); c.stroke(); } } } }); }
// a one-roll pseudo multi-hit: one damage value split into ticks that add up exactly (chain-strikes.js splitTicks)
function splitTicks(total, n) { const out = []; let prev = 0; for (let i = 1; i <= n; i++) { const c = Math.round(total * i / n); out.push(c - prev); prev = c; } return out; }
// the full flinch (battler-pose.js FULL_FLINCH): [time, scaleX, scaleY, shiftX px] and brightness stops
const FLINCH = {
  normal: { ms: 300, move: [[0, 1, 1, 0], [.12, 1.12, .88, 0], [.30, .97, 1.03, -7], [.50, 1, 1, 6], [.70, 1, 1, -4], [.85, 1, 1, 3], [1, 1, 1, 0]], bright: [[0, 3.6], [.35, 1], [1, 1]] },
  strong: { ms: 480, move: [[0, 1, 1, 0], [.10, 1.22, .80, 0], [.26, .90, 1.10, -13], [.44, 1, 1, 11], [.62, 1, 1, -7], [.80, 1, 1, 5], [1, 1, 1, 0]], bright: [[0, 4], [.20, 1], [.40, 3.2], [.60, 1], [1, 1]] },
};
function stopAt(stops, t, col) { for (let i = 1; i < stops.length; i++) if (t <= stops[i][0]) { const a = stops[i - 1], b = stops[i]; const u = (t - a[0]) / Math.max(1e-6, b[0] - a[0]); return lerp(a[col], b[col], 1 - (1 - u) * (1 - u)); } return stops[stops.length - 1][col]; }
