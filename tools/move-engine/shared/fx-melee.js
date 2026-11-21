// ═════════ v2 cinematic layer (FF8 Renzokuken study, reference/NOTES.md):
// isolation (dim UNDER the battlers + the other battlers fade), a follow camera with per-strike push / punch / roll,
// tapered slash sheets, sparks, embers, impact rays, a white frame + chromatic split on TRIGGER, a bigger finisher.
const dens = (C) => (C ? tv(C, "parts") : 100) / 100;
const nP = (C, n) => Math.max(0, Math.round(n * dens(C)));
const others = () => Object.values(ACT).filter((a) => a !== WA() && a !== ORC && (a.kind === "party" || a.on));
// fade every other battler to `fade` % and lay the dim under the two actors; on=false brings it all back
function isolate(C, on, msMul = 1) { const ms = tv(C, "fadeMs") * msMul, to = on ? tv(C, "fade") / 100 : 1;
  return Promise.all([...others().map((a) => fadeActor(a, to, ms)), fdim(on ? tv(C, "dim") / 100 : 0, ms, "#07040c")]); }
// the follow camera: eases (exponential, frame-rate independent) toward a target or a follow() point; punch = a zoom impulse that decays
const CD = { on: false, x: W / 2, y: H / 2, z: 1, r: 0, tgt: { x: W / 2, y: H / 2, z: 1, r: 0 }, follow: null, punch: 0, lag: 220 };
const camClamp = (p) => { const hw = W / 2 / p.z, hh = H / 2 / p.z, s = TG.stage, sc = TG.scene;
  return { ...p, x: clamp(p.x, -s.x + hw, sc.w - s.x - hw), y: clamp(p.y, -s.y + hh, sc.h - s.y - hh) }; };
function camGo(p, lag = CD.lag) { CD.tgt = { ...CD.tgt, ...p }; CD.lag = lag;
  if (FAST) { const c = camClamp(CD.tgt); FCAM.set({ x: c.x, y: c.y, z: c.z, r: c.r }); return; }
  if (CD.on) return; CD.on = true; Object.assign(CD, { x: FCAM.x, y: FCAM.y, z: FCAM.z, r: FCAM.r }); const rid = RUN; let last = performance.now();
  const step = (now) => { if (!CD.on || rid !== RUN) { CD.on = false; return; } const dt = Math.min(50, now - last) * SPEED; last = now;
    const g = camClamp(CD.follow ? { ...CD.tgt, ...CD.follow() } : CD.tgt), k = 1 - Math.exp(-dt / CD.lag);
    CD.x = lerp(CD.x, g.x, k); CD.y = lerp(CD.y, g.y, k); CD.r = lerp(CD.r, g.r, k); CD.z = Math.exp(lerp(Math.log(CD.z), Math.log(g.z), k));
    CD.punch *= Math.exp(-dt / 120); FCAM.set({ x: CD.x, y: CD.y, z: CD.z * (1 + CD.punch), r: CD.r }); requestAnimationFrame(step); };
  requestAnimationFrame(step); }
async function camHome(ms) { CD.on = false; CD.follow = null; CD.punch = 0; await FCAM.to({ x: W / 2, y: H / 2, z: 1, r: 0 }, ms, EASE.sine); }
const twoShot = () => { const pa = center(WA()), pt = center(ORC); return { x: (pa.x + pt.x) / 2, y: (pa.y + pt.y) / 2 - 8 }; };
function lhReset() { CD.on = false; CD.follow = null; CD.punch = 0; CD.tgt = { x: W / 2, y: H / 2, z: 1, r: 0 }; $("shake").style.filter = ""; }
// chromatic split + contrast punch on the field (SVG filter: R shifted one way, B the other)
{ const s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); s.setAttribute("width", "0"); s.setAttribute("height", "0"); s.style.position = "absolute";
  s.innerHTML = `<filter id="lhCA" color-interpolation-filters="sRGB"><feColorMatrix in="SourceGraphic" type="matrix" values="1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0" result="r"/><feOffset id="lhCAr" in="r" dx="0" result="r2"/>
    <feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0 0 1 0 0 0 0 0 0 0 0 0 0 0 1 0" result="g"/><feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0 0 1 0" result="b"/>
    <feOffset id="lhCAb" in="b" dx="0" result="b2"/><feBlend in="r2" in2="g" mode="screen" result="rg"/><feBlend in="rg" in2="b2" mode="screen"/></filter>`; document.body.appendChild(s); }
function chroma(px, ms = 180, punch = 1.25) { if (FAST || px <= 0) return Promise.resolve(); const sh = $("shake"), r = $("lhCAr"), b = $("lhCAb");
  return tween(ms, EASE.out, (t) => { const k = 1 - t; r.setAttribute("dx", (px * k).toFixed(2)); b.setAttribute("dx", (-px * k).toFixed(2));
    sh.style.filter = `url(#lhCA) contrast(${1 + (punch - 1) * k}) saturate(${1 + (punch - 1) * 1.6 * k})`; }).then(() => { sh.style.filter = ""; }); }
// a pixelfx clip (three layers: back under the battlers, front over, light added on top)
function pxfx(key, pt, h, { rate = 1, hold = 0 } = {}) { const c = M.clips["px_" + key + "_front"]; if (!c) return { stop: () => Promise.resolve() };
  const scale = h / (c.h * .55), o = { pt, scale, rate };
  const L = [clip("px_" + key + "_back", pt, { ...o, parent: $("fground") }), clip("px_" + key + "_front", pt, { ...o, z: 3990 }), clip("px_" + key + "_light", pt, { ...o, z: 3991, blend: "plus-lighter" })];
  return { stop: (ms = 300) => Promise.all(L.map((l) => l.stop(ms))) }; }
// the approved tapered-blade slash (reference_slash_vfx_tapered_blade): straight polygon, 3 additive fills, head races, tail follows
function bladePoly(c, ax, ay, bx, by, w) { const L = Math.hypot(bx - ax, by - ay); if (L < 1 || w <= 0) return; const ux = (bx - ax) / L, uy = (by - ay) / L, nx = -uy, ny = ux, N = 24, top = [], bot = [];
  for (let i = 0; i <= N; i++) { const u = i / N; let h = w / 2 * Math.pow(Math.sin(Math.PI * u), .7); if (u > .6) h *= 1 - (u - .6) * .5; const px = ax + (bx - ax) * u, py = ay + (by - ay) * u; top.push([px + nx * h, py + ny * h]); bot.push([px - nx * h, py - ny * h]); }
  c.beginPath(); c.moveTo(top[0][0], top[0][1]); for (const p of top) c.lineTo(p[0], p[1]); for (let i = bot.length - 1; i >= 0; i--) c.lineTo(bot[i][0], bot[i][1]); c.closePath(); c.fill(); }
function slashSheet(pt, ang, { L = 200, w = 26, rgb = STEEL, ms = 300, core = .3 } = {}) { const ca = Math.cos(ang), sa = Math.sin(ang);
  addP("hit", { x: pt.x, y: pt.y, life: ms, draw: (c, p, t) => { const hu = EASE.outCubic(Math.min(1, t / .22)), tu = t < .18 ? 0 : Math.pow((t - .18) / .82, 2);
    const h = -L + 2 * L * hu, tl = -L + 2 * L * tu; if (h - tl < 2) return; const ww = w * (1 - .5 * t), a = t > .6 ? 1 - (t - .6) / .4 : 1;
    const P = (u) => [p.x + ca * u, p.y + sa * u]; const [hx, hy] = P(h), [tx, ty] = P(tl);
    c.fillStyle = `rgba(${rgb},${.22 * a})`; bladePoly(c, hx, hy, tx, ty, ww * 2.4);
    c.fillStyle = `rgba(${rgb},${.85 * a})`; bladePoly(c, hx, hy, tx, ty, ww);
    c.fillStyle = `rgba(255,255,255,${.95 * a})`; bladePoly(c, hx, hy, tx, ty, ww * core); } }); }
// hot streak sparks flying out of the cut
function sparks(pt, n, rgb = GOLD, sp = .9) { for (let i = 0; i < n; i++) { const an = rnd(0, Math.PI * 2), v = rnd(.25, sp);
  addP("hit", { x: pt.x, y: pt.y, vx: Math.cos(an) * v, vy: Math.sin(an) * v - .12, g: .0016, drag: .955, life: rnd(260, 520), w: rnd(1.2, 2.6),
    draw: (c, p, t) => { c.strokeStyle = `rgba(${t < .3 ? "255,255,240" : rgb},${1 - t})`; c.lineWidth = p.w; c.beginPath(); c.moveTo(p.x - p.vx * 26, p.y - p.vy * 26); c.lineTo(p.x, p.y); c.stroke(); } }); } }
// white speed rays out of an impact (FF8 TRIGGER hit), local to the target
function impactRays(pt, n, r0 = 30, r1 = 320, ms = 240, rgb = "255,255,255") { const rays = Array.from({ length: n }, () => [rnd(0, Math.PI * 2), rnd(.01, .035), rnd(.6, 1)]);
  addP("hit", { x: pt.x, y: pt.y, life: ms, draw: (c, p, t) => { const a = 1 - t, R0 = r0 + (r1 - r0) * .25 * EASE.out(t), R1 = r1 * (.6 + .4 * EASE.outCubic(t));
    c.fillStyle = `rgba(${rgb},${a * .85})`; for (const [an, w, k] of rays) { c.beginPath(); c.moveTo(p.x + Math.cos(an) * R0, p.y + Math.sin(an) * R0);
      c.lineTo(p.x + Math.cos(an - w) * R1 * k, p.y + Math.sin(an - w) * R1 * k); c.lineTo(p.x + Math.cos(an + w) * R1 * k, p.y + Math.sin(an + w) * R1 * k); c.fill(); } } }); }
// red radial bloom behind a fire hit
function bloom(pt, r, rgb = "255,70,30", ms = 380) { addP("hit", { x: pt.x, y: pt.y, life: ms, draw: (c, p, t) => glow(c, p.x, p.y, r * (.6 + .6 * EASE.outCubic(t)), rgb, .75 * (1 - t)) }); }

// ───────── shared beats
async function stepIn(a, t, ms = 520, snd = "move1") { sfx(snd, .45); const f = front(t, 92);
  dustBurst(feet(a), { n: 8, s: a.s * .8 }); await trailMove(a, f.x, f.y, ms); }
async function trailMove(a, x, y, ms) { let on = true; (async () => { while (on && !FAST) { afterimage(a, { opacity: .35, ms: 260 }); await wait(55); } })().catch(() => {});
  try { await moveActor(a, x, y, ms, EASE.quad, { hop: 8 }); } finally { on = false; } }
async function backHome(a, { quiet = false } = {}) { if (!quiet) sfx("jump1", .35); await goHome(a, 520, { hop: 14 }); lean(a, 0, 120).catch(() => {}); }
function muzzle(a, scale = 1) { const p = hand(a); clip("gg_burst_anim02", p, { scale: a.s * .55 * scale, filter: "sepia(1) saturate(6) hue-rotate(-12deg) brightness(1.3)", blend: "screen", z: 4000 });
  clip("gg_spark_anim01", p, { scale: a.s * .7 * scale, filter: "sepia(1) saturate(5) hue-rotate(-5deg) brightness(1.4)", blend: "screen", z: 4001 });
  for (let k = 0; k < 10; k++) addP("hit", { x: p.x, y: p.y, vx: face(a) * rnd(.15, .5), vy: rnd(-.25, .1), g: .0008, drag: .97, life: rnd(220, 420), r: rnd(1.5, 3), draw: (c, q, tt) => glow(c, q.x, q.y, q.r * 3, GOLD, 1 - tt) }); }
function igniteBlade(a) { const p = hand(a); clip("gg_fireanim02", p, { scale: a.s * .5, z: 4000 }); sfx("fire1", .35);
  for (let k = 0; k < 14; k++) ember("hit", p.x + rnd(-14, 14), p.y + rnd(-10, 10), FIRE, { life: rnd(500, 900) }); }
