// Blanche (Matador) - approved mockup "Party Action Animations" (round 3 + the
// final toned-down Fury Provoke). One shot file, cfg.kind picks the skill:
//   'tafallera' | 'capote' | 'castigo' | 'provoke' | 'veronica' | 'invocation'
// cfg.t   = the mockup timings (ms), cfg.sfx = fixed cues,
// cfg.hitCue = Tafallera's per-enemy slash cue (its time depends on where each
// enemy stands, so the cue is placed here), cfg.el = Invocation's element.
// cfg.tail = extra ms after the mockup end (petals drift; whatever is still in the
// air fades over the last cfg.fade ms).
// Storage rules: no backticks and no dollar-brace anywhere in this file.
const kind = cfg.kind;
const selfOnly = kind === 'veronica';
if (!caster || (!selfOnly && !targets.length)) { K.ready(); oni.fireDone(); return; }
const B = await boot(); const { tl, T, m, TOK, TG, U, E } = B;
const dir = K.dirOf(TOK, 'c');
const t = cfg.t || {};
const TOTAL = (t.total || 3000) + (cfg.tail || 0);
const FADE = cfg.fade || 700;
const SFX = (cfg.sfx || []).slice();
const CT = TOK.c; const cf = K.feet(tl, 'c');
const RAD = Math.PI / 180;
const cw = (nativeW, scale) => nativeW * 0.85 * (scale || 1) * U;   // mockup clip width, x U
// mockup anchors (OY = feet): feet() = OY - 8, center() = OY - H/2, head() = OY - 0.95 H
const fp = (k, ox) => { const f = K.feet(tl, k); return { x: f.x + (ox || 0), y: f.y - 8 * U }; };
const cp = (k, ox) => { const f = K.feet(tl, k); return { x: f.x + (ox || 0), y: f.y - TOK[k].h * 0.5 }; };
const hd = (k) => { const f = K.feet(tl, k); return { x: f.x, y: f.y - TOK[k].h * 0.95 }; };
// mockup hand(): 34 px ahead of her, at 45% height; ox = how far she has stepped
const hand = (ox) => ({ x: cf.x + ox + dir * 34 * U, y: cf.y - CT.h * 0.45 });
// the side of an enemy that faces Blanche (mockup enemies face right, toward the party)
const toward = (k) => (Math.sign(cf.x - K.feet(tl, k).x) || 1);
const pxScale = (g) => { try { return Math.abs(g.getTransform().a) || 1; } catch (e) { return 1; } };

// ── mockup hurt(): brightness flash (220 ms) + a 300 ms horizontal shudder ──
function hurt(at, k) {
  m.tint(at, 220, k, '#ffffff', (u) => 0.55 * (1 - u));
  m.hold(at, at + 300, (e, S) => { const q = S.tok[k]; if (!q) return; const u = Math.min(1, e / 300); q.dx += -Math.sin(u * Math.PI * 4) * 9 * U * (1 - u); });
}
// ── the mockup's drop-shadow(0 0 Npx colour) glow: a blurred silhouette under the token ──
function glow(k, t0, t1, color, blur) {
  m.hold(t0, t1, (e, S) => S.world.push({ z: 4, draw: (g) => {
    const q = S.tok[k], TT = TOK[k]; if (!q || !TT || q.hidden || q.alpha <= 0) return;
    const c = tl.tinted(k, color); if (!c) return; const f = tl.feet(TT);
    g.save(); g.translate(TT.x + q.dx, f.y + q.dy - (q.air || 0)); if (q.rot) g.rotate(q.rot); g.scale(TT.flip * q.sx, q.sy);
    g.globalAlpha = q.alpha; g.filter = 'blur(' + (blur * 0.5 * U * pxScale(g)).toFixed(1) + 'px)';
    for (let i = 0; i < 2; i++) g.drawImage(c, -TT.w / 2, -TT.h * TT.foot, TT.w, TT.h);
    g.restore();
  } }));
}

// ── Rose petals: the mockup leafGust({ petals: true, burst }) physics, canvas-2D.
// A burst flings them out, drag bleeds the burst, they fall slowly (gravity vs air
// drag), sway on a pendulum, spin, flip in 3D (cos on x scale), land on the floor
// line, rest 1.4 s, fade 0.8 s. Simulated in mockup px around pt, drawn x U.
const PETAL_COL = ['#b3122b', '#d61f3c', '#8e0e22', '#e8435a', '#c4162f'];
let SEED = 31;
function petalShape(g, s, col) {
  // the mockup's box: 1.2s x s, border-radius 60% 60% 50% 50% / 80% 80% 30% 30% (CSS-normalised)
  const w = 1.2 * s, h = s, x0 = -w / 2, y0 = -h / 2, x1 = w / 2, y1 = h / 2;
  const tx = 0.6 * s, ty = 0.667 * s, bx = 0.5 * s, by = 0.25 * s;
  g.beginPath();
  g.ellipse(x0 + tx, y0 + ty, tx, ty, 0, Math.PI, 1.5 * Math.PI);
  g.ellipse(x1 - tx, y0 + ty, tx, ty, 0, 1.5 * Math.PI, 2 * Math.PI);
  g.ellipse(x1 - bx, y1 - by, bx, by, 0, 0, 0.5 * Math.PI);
  g.ellipse(x0 + bx, y1 - by, bx, by, 0, 0.5 * Math.PI, Math.PI);
  g.closePath();
  const gr = g.createRadialGradient(x0 + 0.4 * w, y0 + 0.3 * h, 0, x0 + 0.4 * w, y0 + 0.3 * h, Math.hypot(0.6 * w, 0.7 * h));
  gr.addColorStop(0, '#ff8a9a'); gr.addColorStop(0.6, col); gr.addColorStop(1, col);
  g.fillStyle = gr; g.fill();
}
function petals(at, pt, floorY, n, burst) {
  const r = tl.rng(SEED += 17); const P = [];
  for (let i = 0; i < n; i++) {
    const s = 8 + r() * 7;
    P.push({ s, col: PETAL_COL[i % PETAL_COL.length], vx: (r() - 0.5) * 2 * burst, vy: -120 - r() * 200, x: (r() - 0.5) * 40, y: -30 + r() * 40,
      rot: r() * 6, spin: (r() - 0.5) * 5, sw: 2 + r() * 2, ph: r() * 6, flip: 3 + r() * 4, floor: (floorY - pt.y) / U - r() * 30, age: -i * 0.05, fade: 1, landed: null });
  }
  const step = (dt) => {
    for (const l of P) {
      l.age += dt;
      if (l.landed == null) {
        l.vx += (-l.vx) * 1.6 * dt;                 // drag bleeds the burst
        l.vy += (60 - l.vy * 1.8) * dt;             // gravity vs air drag: slow terminal fall
        l.x += (l.vx + Math.sin(l.age * l.sw + l.ph) * 38) * dt;
        l.y += (l.vy + Math.cos(l.age * l.sw * 2 + l.ph) * 12) * dt;
        l.rot += (l.spin + Math.sin(l.age * l.sw + l.ph) * 2) * dt;
        if (l.y >= l.floor) { l.y = l.floor; l.landed = l.age; }
      } else if (l.age - l.landed > 1.4) l.fade = Math.max(0, 1 - (l.age - l.landed - 1.4) / 0.8);
    }
  };
  let last = 0;
  m.hold(at, TOTAL, (e, S) => {
    let d = Math.min(40, Math.max(0, e - last)); last = e;   // the mockup clamps a frame to 40 ms
    while (d > 0) { const h = Math.min(20, d); step(h / 1000); d -= h; }
    const endA = Math.max(0, Math.min(1, (TOTAL - at - e) / FADE));
    S.world.push({ z: 55, draw: (g) => {
      for (const l of P) {
        const a = l.fade * endA; if (a <= 0.01) continue;
        const fl = l.landed != null ? 0.35 : Math.cos(l.age * l.flip + l.ph);
        g.save(); g.translate(pt.x + l.x * U, pt.y + l.y * U); g.rotate(l.rot); g.scale(fl, 1); g.globalAlpha = a;
        petalShape(g, l.s * U, l.col); g.restore();
      }
    } });
  });
}

// ── The red cape (mockup .cape: 150 px disc, conic-gradient from 200deg) ──
let CAPE = null;
function capeArt() {
  if (CAPE) return CAPE;
  const c = document.createElement('canvas'); c.width = c.height = 150; const g = c.getContext('2d');
  let gr;
  if (g.createConicGradient) {
    // CSS conic 'from 200deg' starts at 12 o'clock; canvas starts at 3 o'clock
    gr = g.createConicGradient((200 - 90) * RAD, 75, 75);
    gr.addColorStop(0, 'rgba(190,20,40,0)'); gr.addColorStop(0.2, 'rgba(190,20,40,0)'); gr.addColorStop(0.35, '#b3122b');
    gr.addColorStop(0.55, '#e0364d'); gr.addColorStop(0.75, 'rgba(190,20,40,0)'); gr.addColorStop(1, 'rgba(190,20,40,0)');
  } else { gr = g.createRadialGradient(75, 75, 0, 75, 75, 75); gr.addColorStop(0, 'rgba(190,20,40,0)'); gr.addColorStop(0.7, '#b3122b'); gr.addColorStop(1, 'rgba(190,20,40,0)'); }
  g.fillStyle = gr; g.beginPath(); g.arc(75, 75, 75, 0, 6.2832); g.fill();
  return (CAPE = c);
}
// pose(q) with q = sine-eased progress -> { rot (deg), sc, a }
function cape(at, ms, pt, pose) {
  const art = capeArt();
  m.hold(at, at + ms, (e, S) => {
    const p = pose(E.sine(Math.min(1, e / ms))); if (p.a <= 0) return;
    S.world.push({ z: 54, draw: (g) => { const s = 150 * U * p.sc; g.save(); g.translate(pt.x, pt.y); g.rotate(p.rot * RAD); g.globalAlpha = p.a; g.drawImage(art, -s / 2, -s / 2, s, s); g.restore(); } });
  });
}

// ── The drawn rose (mockup roseUrl(): 64 x 96 canvas) ──
function roseArt() {
  const c = document.createElement('canvas'); c.width = 64; c.height = 96; const g = c.getContext('2d');
  g.strokeStyle = '#2f6a2a'; g.lineWidth = 4; g.beginPath(); g.moveTo(32, 40); g.quadraticCurveTo(36, 70, 30, 94); g.stroke();
  g.fillStyle = '#3f8a35'; g.beginPath(); g.ellipse(42, 66, 9, 4, -0.6, 0, 6.3); g.fill(); g.beginPath(); g.ellipse(24, 76, 8, 3.5, 0.6, 0, 6.3); g.fill();
  for (let i = 0; i < 9; i++) { const a = i * 2.4, r = 20 - i * 1.9; g.fillStyle = i % 2 ? '#a3102a' : '#d61f3c'; g.beginPath(); g.ellipse(32 + Math.cos(a) * (9 - i), 28 + Math.sin(a) * (6 - i * 0.5), r, r * 0.75, a, 0, 6.3); g.fill(); }
  g.strokeStyle = 'rgba(60,0,10,.5)'; g.lineWidth = 1.5; for (let i = 0; i < 4; i++) { g.beginPath(); g.arc(32, 28, 4 + i * 4, i, i + 3.6); g.stroke(); }
  return c;
}

// ── The anime anger mark (four inward-bulging red arcs), mockup angerMark(): 84 px,
// pops in (220 ms, scale 0 -> 1.25), throbs (500 ms), fades (220 ms). Fixed in place.
function angerMark(at, pt, size) {
  const sz = size * U, mm = sz / 2;
  const scaleAt = (e) => e < 220 ? 1.25 * E.outQ(e / 220) : e < 720 ? 1.1 + 0.15 * Math.abs(Math.sin((e - 220) / 500 * Math.PI * 3)) : 1.1 + 0.15 * Math.abs(Math.sin(Math.PI * 3));
  const arcs = (g) => {
    for (let i = 0; i < 4; i++) {
      const sx = i % 2 ? 1 : -1, sy = i < 2 ? -1 : 1, R = sz * 0.44, r = sz * 0.33, cx = mm + sx * R, cy = mm + sy * R;
      const a0 = Math.atan2(-sy, -sx) - Math.PI / 4 + 0.18, a1 = Math.atan2(-sy, -sx) + Math.PI / 4 - 0.18;
      g.beginPath(); g.arc(cx, cy, r, a0, a1); g.stroke();
    }
  };
  m.hold(at, at + 940, (e, S) => {
    const s = scaleAt(e), a = e < 720 ? 1 : Math.max(0, 1 - (e - 720) / 220); if (a <= 0 || s <= 0) return;
    S.world.push({ z: 58, draw: (g) => {
      const px = pxScale(g);
      g.save(); g.translate(pt.x, pt.y); g.scale(s, s); g.translate(-mm, -mm); g.globalAlpha = a;
      g.strokeStyle = '#e0242f'; g.lineWidth = sz * 0.11; g.lineCap = 'round';
      g.shadowColor = 'rgba(0,0,0,.4)'; g.shadowOffsetY = 2 * U * px * s; g.shadowBlur = 2 * U * px * s; arcs(g);
      g.shadowColor = '#ffffff'; g.shadowOffsetY = 0; g.shadowBlur = 3 * U * px * s; arcs(g);
      g.restore();
    } });
  });
}

// mockup runTo(): ioQ ease, 12 px bob over 'steps' strides (the bob reads the EASED t, as the mockup does)
function runTo(at, ms, x0, y0, x1, y1, steps) {
  m.hold(at, at + ms, (e, S) => { const q = E.ioQ(Math.min(1, e / ms)); const s = S.tok.c; s.dx += x0 + (x1 - x0) * q; s.dy += y0 + (y1 - y0) * q - Math.abs(Math.sin(q * Math.PI * steps)) * 12 * U; });
}

// ═════════════════════════════════════════════════════════════════════════════
if (kind === 'tafallera') {
  // Run to stage centre, a 2.5-turn spin with 4 crimson cape-slash arcs and petals,
  // a floor ring (perspective 0.45) that hits each enemy as it reaches them, run back.
  const C = { x: tl.REST.cx, y: tl.REST.cy };
  const DX = C.x - cf.x, DY = C.y - cf.y;
  runTo(0, t.run, 0, 0, DX, DY, 5);
  m.hold(t.run, t.back, (e, S) => { S.tok.c.dx += DX; S.tok.c.dy += DY; });
  runTo(t.back, t.backMs, DX, DY, 0, 0, 5);
  // the spin: scaleX = cos(5 pi q); it ends mirrored and snaps back when the ring is done (as in the mockup)
  const ringEnd = t.ring + t.ringMs;
  m.hold(t.run, ringEnd, (e, S) => { S.tok.c.sx *= e < t.spinMs ? Math.cos(E.sine(e / t.spinMs) * Math.PI * 5) : -1; });
  const ctr = { x: C.x, y: C.y - CT.h * 0.45 };
  for (let i = 0; i < 4; i++) {
    const at = t.run + i * t.slashGap; const deg = i * 90 + 30;
    // CSS 'scaleX(-1) rotate(r)' = canvas rotate(-r) then flip
    m.clip('slash', at, { x: ctr.x, y: ctr.y, w: cw(512, 0.5), z: 50, add: true, filter: K.tintF(350, 6, 1.05), rot: (i % 2 ? -deg : deg) * RAD, flip: i % 2 === 1 });
    petals(at, ctr, C.y + 40 * U, 6, 380);
  }
  // the ring: r 60 -> R mockup px (outQ, t.ringMs), ellipse 2r x 0.9r on the floor, fades to 10%
  const dist = TG.map((k) => { const f = K.feet(tl, k); return Math.hypot(f.x - C.x, (f.y - C.y) / 0.45) / U; });
  const R = Math.max(700, Math.max.apply(null, dist.concat([0])) + 40);   // 700 as mocked; grown only if an enemy stands further out
  TG.forEach((k, i) => {
    const q = (dist[i] - 60) / (R - 60); const kk = q <= 0 ? 0 : 1 - Math.sqrt(1 - Math.min(1, q));
    const at = Math.round(t.ring + t.ringMs * kk);
    if (cfg.hitCue) SFX.push({ at, url: cfg.hitCue.url, v: cfg.hitCue.v });
    const f = fp(k);
    m.clip('sweep', at, { x: f.x, y: f.y, w: cw(440, 1.2), z: 50 });
    hurt(at, k);
  });
  m.hold(t.ring, ringEnd, (e, S) => {
    const k = E.outQ(Math.min(1, e / t.ringMs)); const r = (60 + (R - 60) * k) * U;
    S.world.push({ z: 3, draw: (g) => {
      const px = pxScale(g);
      g.save(); g.globalCompositeOperation = 'lighter'; g.globalAlpha = 1 - k * 0.9;
      g.shadowColor = '#ff3355'; g.shadowBlur = 22 * U * px; g.strokeStyle = 'rgba(225,40,70,.85)'; g.lineWidth = 10 * U;
      g.beginPath(); g.ellipse(C.x, C.y, r, r * 0.45, 0, 0, 6.2832); g.stroke(); g.stroke();
      g.restore();
    } });
  });
} else if (kind === 'capote') {
  // Step out, a wide cape flourish with petals, the target snorts two puffs of steam, red power-down.
  const tk = TG[0], tf = K.feet(tl, tk), TT = TOK[tk];
  K.step(m, E, U, dir, 'c', 0, 0, t.back, 60);
  const hp = hand(dir * 60 * U);
  cape(t.cape, t.capeMs, { x: hp.x + dir * 20 * U, y: hp.y }, (q) => ({ rot: -200 * q, sc: 0.6 + 0.6 * Math.sin(q * Math.PI), a: 1 - Math.max(0, q - 0.7) / 0.3 }));
  petals(t.cape, hp, cf.y + 30 * U, 8, 220);
  // the bull: two snorts from the muzzle (the side facing Blanche)
  const nose = { x: tf.x + toward(tk) * TT.w * 0.32, y: tf.y - TT.h * 0.55 };
  for (let i = 0; i < 2; i++) m.clip('smoke', t.snort + i * 260, { x: nose.x, y: nose.y, w: cw(170, 1.1), z: 52, filter: 'brightness(1.4) grayscale(1)', alpha: () => 0.85 });
  const f = fp(tk);
  m.clip('pdown1', t.down, { x: f.x, y: f.y, w: cw(508), z: 50, filter: 'hue-rotate(-250deg)' });
} else if (kind === 'castigo') {
  // Step out, a drawn rose thrown spinning onto the target, petals burst, dark-red power-down.
  const tk = TG[0], tf = K.feet(tl, tk);
  K.step(m, E, U, dir, 'c', 0, 0, t.back, 50);
  const from = hand(dir * 50 * U), to = cp(tk); const rose = roseArt();
  m.hold(t.toss, t.land, (e, S) => {
    const k = Math.min(1, e / (t.land - t.toss));
    const x = from.x + (to.x - from.x) * k, y = from.y + (to.y - from.y) * k - Math.sin(k * Math.PI) * 170 * U;
    S.world.push({ z: 56, draw: (g) => { const px = pxScale(g); g.save(); g.translate(x, y); g.rotate(1080 * k * RAD);
      g.shadowColor = 'rgba(0,0,0,.5)'; g.shadowOffsetY = 2 * U * px; g.shadowBlur = 3 * U * px; g.drawImage(rose, -32 * U, -48 * U, 64 * U, 96 * U); g.restore(); } });
  });
  petals(t.land, to, tf.y, 10, 200);
  m.tint(t.land, 220, tk, '#ffffff', (u) => 0.3 * (1 - u));   // flashActor(wolf, 1.6)
  const f = fp(tk);
  m.clip('pdown2', t.land, { x: f.x, y: f.y, w: cw(384, 1.2), z: 50, filter: 'hue-rotate(100deg)' });
} else if (kind === 'provoke') {
  // Final toned-down Fury taunt: fury burst + red glow, smug bounces + lean back,
  // anger mark on the target, then the target's tantrum (red glow, three hops with
  // a squash on landing and a cartoon smoke puff + hiss each hop). No text.
  const tk = TG[0], tf = K.feet(tl, tk), TT = TOK[tk];
  K.step(m, E, U, dir, 'c', 0, 0, t.back, 60);
  const ff = fp('c', dir * 60 * U);
  m.clip('pup2', t.fury, { x: ff.x, y: ff.y, w: cw(508, 0.9), z: 50, filter: 'hue-rotate(-55deg) saturate(1.6)' });
  glow('c', t.fury, t.back, '#ff3030', 12);
  m.tint(t.fury, t.back - t.fury, 'c', '#ffffff', () => 0.06);   // brightness(1.1)
  // two chin-up bounces (200 ms each, sine), then lean back 6 deg (220 ms) and hold
  m.hold(t.fury, t.fury + 400, (e, S) => { const k = (e % 200) / 200; S.tok.c.air += 10 * U * Math.sin(E.sine(k) * Math.PI); });
  m.hold(t.fury + 400, t.back, (e, S) => { S.tok.c.rot += -dir * 6 * RAD * E.outQ(Math.min(1, e / 220)); });
  angerMark(t.mark, { x: tf.x + toward(tk) * 30 * U, y: hd(tk).y + 10 * U }, 84);
  // the tantrum
  m.tint(t.tantrum, t.back - t.tantrum, tk, '#ff2a1a', () => 0.35);
  glow(tk, t.tantrum, t.back, '#ff2a2a', 10);
  const top = hd(tk);
  for (let i = 0; i < 3; i++) {
    const h0 = t.tantrum + i * 400;
    m.clip('smoke', h0, { x: top.x + (i % 2 ? 26 : -18) * U, y: top.y + 4 * U, w: cw(170, 1.2), z: 52, filter: 'grayscale(1) brightness(1.6)', alpha: () => 0.9 });
    m.hold(h0, h0 + 170, (e, S) => { S.tok[tk].air += 34 * U * E.outQ(Math.min(1, e / 170)); });
    m.hold(h0 + 170, h0 + 320, (e, S) => { S.tok[tk].air += 34 * U * (1 - E.inQ(Math.min(1, e / 150))); });
    m.hold(h0 + 320, h0 + 400, (e, S) => { const s = Math.sin(E.outQ(Math.min(1, e / 80)) * Math.PI); S.tok[tk].sx *= 1 + 0.06 * s; S.tok[tk].sy *= 1 - 0.08 * s; });
  }
} else if (kind === 'veronica') {
  // Reaction when she is targeted: a slow cape pass across her body, petals trailing, a crest.
  const c0 = cp('c');
  petals(0, c0, cf.y + 20 * U, 10, 160);
  cape(t.cape, t.capeMs, { x: cf.x, y: cf.y - CT.h * 0.45 }, (q) => ({ rot: 360 * q, sc: 1.2, a: 1 - Math.max(0, q - 0.7) / 0.3 }));
  m.clip('pup3', t.crest, { x: c0.x, y: c0.y, w: cw(354, 0.9), z: 50 });
} else if (kind === 'invocation') {
  // Wellspring pillar under her, an element orb arcs to the target, the element clip.
  // The player picks the wellspring at resolve; the shot cannot see it, so cfg.el
  // carries ONE default element (Fire).
  const tk = TG[0]; const el = cfg.el || { hue: 12 };
  K.step(m, E, U, dir, 'c', 0, 0, t.back, 40);
  const pf = fp('c', dir * 40 * U);
  const pdur = Math.round(2467 / 1.4);   // the mockup plays the pillar at rate 1.4
  const pc = m.clip('pillar', t.pillar, { x: pf.x, y: pf.y, w: cw(384, 0.8), z: 50, add: true, filter: 'hue-rotate(' + Math.round(el.hue - 45) + 'deg)', hold: pdur });
  m.hold(t.pillar, t.pillar + pdur, () => { try { const v = pc && pc.copy && pc.copy.video; if (v && v.playbackRate !== 1.4) v.playbackRate = 1.4; } catch (e) {} });
  const from = cp('c', dir * 40 * U), to = cp(tk); const col = 'hsl(' + el.hue + ',90%,60%)';
  m.hold(t.orb, t.orb + t.orbMs, (e, S) => {
    const k = Math.min(1, e / t.orbMs), q = E.ioQ(k);
    const x = from.x + (to.x - from.x) * q, y = from.y + (to.y - from.y) * q - Math.sin(q * Math.PI) * 120 * U;
    S.world.push({ z: 57, draw: (g) => { const r = 31 * U; const gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, '#fff'); gr.addColorStop(0.18, '#fff'); gr.addColorStop(0.4, col); gr.addColorStop(0.72, 'rgba(0,0,0,0)');
      g.save(); g.globalCompositeOperation = 'lighter'; g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, 6.2832); g.fill(); g.restore(); } });
  });
  const f = fp(tk);
  m.clip('el', t.hit, { x: f.x, y: f.y, w: cw(el.w || 776), z: 50 });
  hurt(t.hit + (el.impact || 67), tk);
} else { K.ready(); oni.fireDone(); return; }

await tl.run(T, { total: TOTAL, sfx: SFX, onStart: K.ready });
oni.fireDone();
