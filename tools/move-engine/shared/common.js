// ═════════ Legacy bosses · shared kit (movement, hits, projectiles, floor FX, dance)
DN_COLOR.heal = "#7dff9a"; DN_COLOR.ip = "#ffd75e";
const tv = (C, k) => C.cfg[k];
const hitstop = (ms = 80) => wait(ms);
const P = (k) => ACT[k];
const HINA = ACT.hina, ZARG = ACT.zarg, KEREN = ACT.keren, BLANCHE = ACT.blanche;
Object.assign(OPT, { flyer: "hina", dmgShow: true });

// ───────── movement (depth-correct: scale follows the floor row)
function moveActor(a, x, y, ms, ease = EASE.sine, { hop = 0, trail = 0, hue = null } = {}) {
  const x0 = OX(a), y0 = OY(a); let last = 0;
  return tween(ms, ease, (t) => { const nx = lerp(x0, x, t), ny = lerp(y0, y, t); a.s = tokenScaleAt(ny); a.el.style.zIndex = Math.round(ny);
    setPos(a, nx - a.x, ny - a.y, -Math.sin(t * Math.PI) * hop); if (trail && t - last > trail) { last = t; afterimage(a, { hue }); } });
}
const goHome = (a, ms = 420, o = {}) => moveActor(a, a.x, a.y, ms, EASE.quad, o);
function teleport(a, x, y) { a.s = tokenScaleAt(y); a.el.style.zIndex = Math.round(y); setPos(a, x - a.x, y - a.y); }
function afterimage(a, { opacity = .5, ms = 380, hue = null } = {}) {
  if (FAST) return; const f = hue == null ? "brightness(1.6) saturate(.4)" : `sepia(1) saturate(5) hue-rotate(${hue - 38}deg) brightness(1.35)`;
  const g = sprite(a.media.getAttribute("src"), $("factors"), { x: OX(a), y: OY(a) - (a.lift || 0), h: hgt(a), opacity, z: Math.round(OY(a)) - 1, flip: a.flip, filter: f });
  g.set({ rot: a.rot }); g.fade(0, ms).then(() => g.remove()).catch(() => g.remove());
}
const lean = (a, deg, ms, ease = EASE.out) => { const r0 = a.rot; return tween(ms, ease, (t) => { a.rot = lerp(r0, deg, t); setPos(a, a.dx, a.dy); }); };
const squash = (a, sx, sy, ms, ease = EASE.out) => { const x0 = a.kx ?? 1, y0 = a.ky ?? 1; return tween(ms, ease, (t) => { a.kx = lerp(x0, sx, t); a.ky = lerp(y0, sy, t); setPos(a, a.dx, a.dy); }); };
const liftTo = (a, h, ms, ease = EASE.outCubic) => { const h0 = a.lift || 0; return tween(ms, ease, (t) => { a.lift = lerp(h0, h, t); setPos(a, a.dx, a.dy); }); };
// a point in front of a battler, on the side it faces (the attacker's side)
const front = (t, gap = 70) => ({ x: OX(t) + face(t) * gap * t.s, y: OY(t) });
const fadeActor = (a, to, ms) => { const o0 = +(a.el.style.opacity || 1); return tween(ms, EASE.sine, (t) => a.el.style.opacity = lerp(o0, to, t)); };
function resetExtra() { WINGS.on = false; DANCE.on = false; for (const a of Object.values(ACT)) { a.kx = 1; a.ky = 1; } }

// ───────── hits
// clip on the body + number + the game's hurt reaction
function land(t, dmg, { el = "physical", tier = "normal", fxKey = null, fxScale = 1, s = null, vol = .5, cascade = 0, flip = false, rot = 0 } = {}) {
  if (fxKey) clip(fxKey, center(t), { scale: fxScale * t.s, flip, rot });
  if (s) sfx(s, vol);
  dmgNum(t.id, numAt(t), dmg, { element: el, cascade }); hitReact(t, tier);
}
const statusBeat = (t, key = "054_powerdown_1") => clip(key, feet(t), { scale: t.s });

// ───────── projectiles (drawn on the hit canvas, pointing along travel)
function fly(from, to, { ms = 450, ease = EASE.lin, arc = 0, draw, spin = 0, trail = null, layer = "hit", stay = 0 } = {}) {
  if (FAST) return Promise.resolve();
  return new Promise((res) => {
    addP(layer, { x: from.x, y: from.y, life: ms, ang: 0, onDie: (p) => { res(); if (stay) stuck(p, draw, stay); },
      update: (p) => { const u = ease(Math.min(1, p.t / p.life)); const nx = lerp(from.x, to.x, u), ny = lerp(from.y, to.y, u) - arc * Math.sin(Math.PI * u);
        if (spin) p.ang += spin; else if (Math.hypot(nx - p.x, ny - p.y) > .01) p.ang = Math.atan2(ny - p.y, nx - p.x);
        if (trail) trail(p.x, p.y, nx, ny); p.x = nx; p.y = ny; },
      draw: (c, p) => { c.translate(p.x, p.y); c.rotate(p.ang); draw(c, p); } });
  });
}
// a projectile that stays where it landed (a spear in the floor), then fades
function stuck(p0, draw, ms) { addP("field", { x: p0.x, y: p0.y, ang: p0.ang, life: ms, draw: (c, p, t) => { c.globalCompositeOperation = "source-over"; c.globalAlpha = t > .7 ? 1 - (t - .7) / .3 : 1; c.translate(p.x, p.y); c.rotate(p.ang); draw(c, p); } }); }
// shapes, drawn with the tip at (0,0) pointing +x
const SHAPE = {
  spear: (len = 120, glowRgb = null) => (c) => { c.globalCompositeOperation = "source-over";
    if (glowRgb) { glow(c, -len * .4, 0, len * .6, glowRgb, .35); }
    c.strokeStyle = "#5a3a22"; c.lineWidth = 5; c.beginPath(); c.moveTo(-len, 0); c.lineTo(-16, 0); c.stroke();
    c.strokeStyle = "#8a5d3a"; c.lineWidth = 2; c.beginPath(); c.moveTo(-len, -1); c.lineTo(-16, -1); c.stroke();
    c.fillStyle = "#e6e9ef"; c.beginPath(); c.moveTo(6, 0); c.lineTo(-20, -8); c.lineTo(-14, 0); c.lineTo(-20, 8); c.closePath(); c.fill();
    c.fillStyle = "#9aa3b2"; c.beginPath(); c.moveTo(6, 0); c.lineTo(-14, 0); c.lineTo(-20, 8); c.closePath(); c.fill();
    c.fillStyle = "#3c8a4a"; c.fillRect(-26, -3, 6, 6); },
  arrow: (len = 70, rgb = "255,255,255", head = "#dfe4ea") => (c) => { glow(c, -6, 0, 26, rgb, .55); c.globalCompositeOperation = "source-over";
    c.strokeStyle = "#6b4a2a"; c.lineWidth = 3; c.beginPath(); c.moveTo(-len, 0); c.lineTo(-8, 0); c.stroke();
    c.fillStyle = head; c.beginPath(); c.moveTo(4, 0); c.lineTo(-10, -5); c.lineTo(-10, 5); c.closePath(); c.fill();
    c.fillStyle = `rgb(${rgb})`; c.beginPath(); c.moveTo(-len + 14, 0); c.lineTo(-len, -7); c.lineTo(-len + 4, 0); c.lineTo(-len, 7); c.closePath(); c.fill(); },
  lance: (len = 150, rgb = "130,255,190") => (c) => { glow(c, -len * .3, 0, len * .5, rgb, .5); c.fillStyle = `rgba(${rgb},.85)`;
    c.beginPath(); c.moveTo(10, 0); c.lineTo(-len * .25, -6); c.lineTo(-len, -1.5); c.lineTo(-len, 1.5); c.lineTo(-len * .25, 6); c.closePath(); c.fill();
    c.fillStyle = "#fff"; c.beginPath(); c.moveTo(6, 0); c.lineTo(-len * .3, -2.5); c.lineTo(-len * .8, 0); c.lineTo(-len * .3, 2.5); c.closePath(); c.fill(); },
  axe: (s = 1) => (c) => { c.globalCompositeOperation = "source-over"; c.scale(s, s); c.strokeStyle = "#4a2f1c"; c.lineWidth = 6; c.beginPath(); c.moveTo(-30, 0); c.lineTo(30, 0); c.stroke();
    c.fillStyle = "#c9ced6"; c.beginPath(); c.moveTo(18, -4); c.quadraticCurveTo(44, -30, 36, -36); c.quadraticCurveTo(54, -6, 40, 22); c.quadraticCurveTo(40, 6, 18, 4); c.closePath(); c.fill();
    c.strokeStyle = "#7d1c1c"; c.lineWidth = 2; c.stroke(); },
  wind: (r = 26, rgb = "190,255,215") => (c, p) => { for (let i = 0; i < 4; i++) { c.strokeStyle = `rgba(${rgb},${.8 - i * .15})`; c.lineWidth = 3; c.beginPath(); c.arc(0, 0, r * (1 - i * .18), p.t / 60 + i * 1.6, p.t / 60 + i * 1.6 + 3.6); c.stroke(); } glow(c, 0, 0, r * 1.2, rgb, .6); },
  coin: (r = 7) => (c, p) => { c.globalCompositeOperation = "source-over"; const k = Math.abs(Math.cos(p.t / 70)); c.fillStyle = "#e8b32a"; c.beginPath(); c.ellipse(0, 0, r * Math.max(.15, k), r, 0, 0, 7); c.fill(); c.fillStyle = "#fff3b0"; c.fillRect(-1, -r * .6, 2, r * .5); },
  heart: (r = 12, rgb = "255,110,170") => (c) => { glow(c, 0, 0, r * 2.2, rgb, .7); c.globalCompositeOperation = "source-over"; c.fillStyle = `rgb(${rgb})`; c.beginPath(); c.moveTo(0, r * .9);
    c.bezierCurveTo(-r * 1.5, -r * .2, -r * .6, -r * 1.3, 0, -r * .45); c.bezierCurveTo(r * .6, -r * 1.3, r * 1.5, -r * .2, 0, r * .9); c.fill(); },
  note: (r = 9, rgb = "255,214,120") => (c) => { glow(c, 0, 0, r * 2, rgb, .6); c.globalCompositeOperation = "source-over"; c.fillStyle = `rgb(${rgb})`; c.beginPath(); c.ellipse(0, 0, r * .75, r * .55, -.4, 0, 7); c.fill(); c.fillRect(r * .5, -r * 2.2, 2.4, r * 2.2); c.fillRect(r * .5, -r * 2.2, r * .9, 3); },
  soul: (r = 10, rgb = "180,120,255") => (c) => { glow(c, 0, 0, r * 3, rgb, .9); glow(c, -r * 2, 0, r * 2, rgb, .4); },
};
// a heart, coin, note… thrown up and away (no text)
function toss(layer, pt, draw, { n = 6, up = .35, spread = .25, life = 900, g = .0009 } = {}) { for (let i = 0; i < n; i++) addP(layer, { x: pt.x + rnd(-10, 10), y: pt.y, vx: rnd(-spread, spread), vy: -rnd(up * .6, up), g, life: life * rnd(.8, 1.2), ang: 0,
  draw: (c, p, t) => { c.globalAlpha = t > .75 ? 1 - (t - .75) / .25 : 1; c.translate(p.x, p.y); draw(c, p); } }); }
// coins from one body to another (IP steal), resolves when the first lands
function coinsTo(from, to, n = 4, ms = 650) { sfx("coin", .45); let first; for (let i = 0; i < n; i++) { const pr = (async () => { await wait(i * 70); await fly({ x: from.x + rnd(-12, 12), y: from.y }, to, { ms, arc: rnd(70, 130), ease: EASE.sine, draw: SHAPE.coin(7) }); })(); first = first || pr; } return first; }

// ───────── floor FX (ground canvas = under the battlers, on top of the scene dim)
function ring(pt, { rgb = "255,255,255", r0 = 10, r1 = 160, ms = 600, sy = .3, w = 6, layer = "ground", s = 1 } = {}) {
  addP(layer, { x: pt.x, y: pt.y, life: ms, draw: (c, p, t) => { const r = lerp(r0, r1, EASE.outCubic(t)) * s; c.strokeStyle = `rgba(${rgb},${1 - t})`; c.lineWidth = w * (1 - t * .6) * s; c.beginPath(); c.ellipse(p.x, p.y, r, r * sy, 0, 0, 7); c.stroke(); } });
}
function floorShadow(pt, { r = 60, ms = 600, to = .55, s = 1 } = {}) { const o = { x: pt.x, y: pt.y, k: 0, a: 0, done: false };
  addP("ground", { x: pt.x, y: pt.y, life: 1e9, update: (p) => { if (o.done) p.dead = true; }, draw: (c) => { c.globalCompositeOperation = "source-over"; c.fillStyle = `rgba(0,0,0,${o.a})`; c.beginPath(); c.ellipse(o.x, o.y, r * o.k * s, r * o.k * s * .32, 0, 0, 7); c.fill(); } });
  o.grow = (ms2 = ms) => tween(ms2, EASE.in, (t) => { o.k = t; o.a = to * t; }); o.end = () => { o.done = true; }; return o; }
function crack(pt, s = 1) { addP("ground", { x: pt.x, y: pt.y, life: 1600, segs: Array.from({ length: 7 }, () => { const a = rnd(0, Math.PI * 2); return [a, rnd(30, 80)]; }),
  draw: (c, p, t) => { c.globalCompositeOperation = "source-over"; c.strokeStyle = `rgba(30,18,10,${t > .7 ? (1 - t) / .3 * .8 : .8})`; c.lineWidth = 3 * s; for (const [a, L] of p.segs) { c.beginPath(); c.moveTo(p.x, p.y); c.lineTo(p.x + Math.cos(a) * L * s * .5, p.y + Math.sin(a) * L * s * .16); c.lineTo(p.x + Math.cos(a + .3) * L * s, p.y + Math.sin(a + .3) * L * s * .32); c.stroke(); } } }); }
function dustBurst(pt, { n = 14, s = 1, rgb = "190,170,140" } = {}) { for (let i = 0; i < n; i++) { const an = rnd(Math.PI, Math.PI * 2); addP("field", { x: pt.x + rnd(-10, 10) * s, y: pt.y, vx: Math.cos(an) * rnd(.08, .25) * s, vy: Math.sin(an) * rnd(.02, .1) * s, drag: .97, life: rnd(500, 900), r: rnd(8, 18) * s,
  draw: (c, p, t) => { c.globalCompositeOperation = "source-over"; c.fillStyle = `rgba(${rgb},${.45 * (1 - t)})`; c.beginPath(); c.arc(p.x, p.y, p.r * (1 + t), 0, 7); c.fill(); } }); } }
function feathersOut(pt, { n = 16, rgb = "255,255,255", spread = .35, s = 1, layer = "hit" } = {}) { for (let i = 0; i < n; i++) { const an = rnd(0, Math.PI * 2), sp = rnd(.05, spread);
  addP(layer, { x: pt.x, y: pt.y, vx: Math.cos(an) * sp, vy: Math.sin(an) * sp * .7, g: .00025, drag: .975, life: rnd(1100, 1900), rot: rnd(0, 6), vr: rnd(-.004, .004), L: rnd(9, 16) * s,
    draw: (c, p, t) => { p.rot += p.vr * 16; c.globalCompositeOperation = "source-over"; c.globalAlpha = t > .6 ? (1 - t) / .4 : 1; c.translate(p.x + Math.sin(p.t / 260) * 5, p.y); c.rotate(p.rot);
      c.fillStyle = `rgb(${rgb})`; c.beginPath(); c.ellipse(0, 0, p.L, p.L * .28, 0, 0, 7); c.fill(); c.strokeStyle = "rgba(120,140,170,.6)"; c.lineWidth = 1; c.beginPath(); c.moveTo(-p.L, 0); c.lineTo(p.L, 0); c.stroke(); } }); } }
function twinkles(pt, { n = 10, r = 80, rgb = "160,230,255", layer = "hit" } = {}) { for (let i = 0; i < n; i++) addP(layer, { x: pt.x + rnd(-r, r), y: pt.y + rnd(-r, r) * .8, life: rnd(500, 900), s: rnd(5, 11),
  draw: (c, p, t) => { const k = Math.sin(t * Math.PI) * p.s; glow(c, p.x, p.y, k * 2.5, rgb, .7); c.fillStyle = "#fff"; c.beginPath(); c.moveTo(p.x, p.y - k * 1.6); c.lineTo(p.x + k * .3, p.y); c.lineTo(p.x, p.y + k * 1.6); c.lineTo(p.x - k * .3, p.y); c.closePath(); c.fill();
    c.beginPath(); c.moveTo(p.x - k * 1.6, p.y); c.lineTo(p.x, p.y + k * .3); c.lineTo(p.x + k * 1.6, p.y); c.lineTo(p.x, p.y - k * .3); c.closePath(); c.fill(); } }); }
function windWisps(to, { n = 14, r = 220, rgb = "200,255,225", ms = 700 } = {}) { for (let i = 0; i < n; i++) { const a = rnd(0, Math.PI * 2); homing("hit", { x: to.x + Math.cos(a) * r, y: to.y + Math.sin(a) * r * .6 }, to, rgb, { ms, arc: 60, r: 2 }); } }
// a crescent slash drawn across a point (no clip needed), dir = angle of the cut
function crescent(pt, { ang = -.5, len = 160, w = 26, rgb = "255,255,255", ms = 260, layer = "hit" } = {}) { addP(layer, { x: pt.x, y: pt.y, life: ms, draw: (c, p, t) => {
  const k = EASE.outCubic(Math.min(1, t * 1.6)); c.translate(p.x, p.y); c.rotate(ang); c.globalAlpha = 1 - Math.max(0, (t - .45) / .55);
  c.fillStyle = `rgba(${rgb},.9)`; c.beginPath(); c.moveTo(-len / 2, 0); c.quadraticCurveTo(0, -w * 1.6 * k, len / 2 * k, 0); c.quadraticCurveTo(0, -w * .4, -len / 2, 0); c.fill();
  glow(c, 0, -w * .5, len * .45, rgb, .35); } }); }

// ───────── dance (Love Serenade): per-dancer routine on one BPM, played on the real battler
const DANCE = { on: false };
function startDance(list, bpm) { DANCE.on = true; const rid = RUN; const t0 = performance.now();
  const styles = ["sway", "bounce", "turn", "kick"]; list.forEach((a, i) => a.danceStyle = a.danceStyle || styles[i % styles.length]);
  const step = (now) => { if (!DANCE.on || rid !== RUN || FAST) { for (const a of list) { a.rot = 0; a.kx = 1; a.ky = 1; a.flip = a.baseFlip; setPos(a, a.dx, a.dy); } return; }
    const beats = (now - t0) / 1000 * bpm / 60 * SPEED;
    for (const a of list) { const ph = beats % 1, k = Math.floor(beats); let dx = 0, bob = 0;
      if (a.danceStyle === "sway") { dx = Math.sin(beats * Math.PI) * 12; a.rot = Math.sin(beats * Math.PI) * 7; }
      else if (a.danceStyle === "bounce") { bob = -Math.abs(Math.sin(ph * Math.PI)) * 12; a.ky = 1 - .1 * Math.max(0, 1 - ph * 5); a.kx = 1 + .08 * Math.max(0, 1 - ph * 5); }
      else if (a.danceStyle === "turn") { a.flip = (k % 4 < 2) ? a.baseFlip : -a.baseFlip; bob = -Math.abs(Math.sin(ph * Math.PI)) * 6; a.rot = Math.sin(beats * Math.PI * 2) * 3; }
      else { bob = k % 2 ? -Math.sin(ph * Math.PI) * 18 : 0; a.rot = k % 2 ? -Math.sin(ph * Math.PI) * 12 * a.baseFlip : Math.sin(ph * Math.PI) * 4; }
      setPos(a, dx, a.dy, bob); }
    requestAnimationFrame(step); };
  requestAnimationFrame(step); }
function stopDance() { DANCE.on = false; }

// ───────── energy wings (Rebellious Wing): a canvas just behind the battler; g = growth 0..1, open = spread 0..1, solid 0..1, beat = down-sweep
const WINGS = { on: false };
function wingsOn(a, rgb = "120,255,140") { const cv = document.createElement("canvas"); cv.width = W; cv.height = H; Object.assign(cv.style, { position: "absolute", left: 0, top: 0, width: W + "px", height: H + "px", pointerEvents: "none", zIndex: Math.round(OY(a)) - 1 });
  $("factors").appendChild(cv); const c = cv.getContext("2d"); Object.assign(WINGS, { on: true, cv, a, g: 0, open: 0, solid: 0, beat: 0, alpha: 1, rgb }); const rid = RUN;
  const step = () => { if (!WINGS.on || rid !== RUN) { cv.remove(); return; } c.clearRect(0, 0, W, H); drawWings(c, WINGS); requestAnimationFrame(step); }; requestAnimationFrame(step); return WINGS; }
function drawWings(c, Wg) { const a = Wg.a; const base = { x: OX(a), y: OY(a) - (a.lift || 0) - hgt(a) * .62 }; const S = hgt(a) / 170 * 1.25;
  for (const side of [-1, 1]) for (let i = 0; i < 8; i++) { const u = i / 7;
    const fold = -Math.PI / 2 + side * .18, openA = -Math.PI / 2 + side * (.35 + u * 1.25), ang = lerp(fold, openA, Wg.open) + side * Wg.beat * (.9 + u * .3);
    const L = (90 + (1 - Math.abs(u - .35)) * 70) * S * Wg.g; if (L < 2) continue; const tx = base.x + Math.cos(ang) * L, ty = base.y + Math.sin(ang) * L * .92;
    const nx = -Math.sin(ang), ny = Math.cos(ang), wd = (10 + 6 * (1 - u)) * S * Wg.g;
    const mx = (base.x + tx) / 2 + nx * wd * side, my = (base.y + ty) / 2 + ny * wd * side;
    c.save(); c.globalAlpha = Wg.alpha; c.beginPath(); c.moveTo(base.x, base.y); c.quadraticCurveTo(mx + nx * wd, my + ny * wd, tx, ty); c.quadraticCurveTo(mx - nx * wd * .4, my - ny * wd * .4, base.x, base.y);
    c.shadowColor = `rgba(${Wg.rgb},1)`; c.shadowBlur = 18;
    c.fillStyle = `rgba(${lerp(140, 255, Wg.solid) | 0},${255},${lerp(160, 255, Wg.solid) | 0},${lerp(.18, .95, Wg.solid)})`; c.fill();
    c.strokeStyle = `rgba(${Wg.rgb},${lerp(.95, .7, Wg.solid)})`; c.lineWidth = 2.2; c.stroke(); c.restore(); }
}
