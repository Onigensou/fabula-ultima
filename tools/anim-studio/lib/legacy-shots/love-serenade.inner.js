// Love: Zero Power: Love Serenade (inner script). Port of the APPROVED final mockup: part-b3.js beats,
// part-r7 (lights-down beat), part-r9 (disco rig, dim above every battler, dancers above the dim) and
// part-r10 (each circle its own colour: pink, cyan, amber, green, violet).
//
// Beats: shipped ZP cut-in (pixel art) -> the rig comes up (the WHOLE board and every battler dims) ->
// song: everyone on Love's side dances in full colour above the dim while 14 small coloured floor
// circles whirl over the whole floor like a disco ball's reflections (rotating field, spin reversals,
// erratic jumps, party side included) -> final chord: every circle locks onto the dancers, strobe,
// confetti, the dancers flash gold -> happy jumps (two hops each, hearts and notes), the lights come back.
//
// LAYERS on the LIVE board (oni-timeline renders: PIXI board + real tokens, then the overlay canvas with
// painted tokens, then world layers by z, then screen layers):
//   - floor circles: PIXI sprites of the pixelfx pool light layer (ADD blend) in canvas.primary at floor
//     level (backdrop sort + 3, the battle-stage-ambient pattern), so they sit UNDER every sprite;
//   - the dim: one half-resolution mask canvas (dark fill + soft holes where the circles are), drawn as
//     a world layer at z 60 over the whole view: it covers the map AND every real token;
//   - the dancers: their real tokens are hidden for the run (S.tok[k].hidden: the engine then neither
//     shows nor paints them) and this script paints them itself as a world layer at z 70, ABOVE the dim;
//   - notes / hearts at z 80, confetti + strobe in screen space on top.
// Performance: 14 sprites from 5 shared looping videos (no per-frame canvas work for the circles),
// the dim is one half-res fill + 14 stamp draws + one upscale per frame, shapes are pre-rendered.
if (!caster) { K.ready(); oni.fireDone(); return; }
const t = cfg.t || {}; const BPM = cfg.bpm || 128;
const SIDES = LV.sides();
// dancers: Love first, then every token on his side (summons, Jack / Jill...), in board order
const tk = new Map(); targets.forEach((x, i) => tk.set(x.id, 't' + i));
const extra = {}; const DK = ['c'];
SIDES.allies.forEach((x, i) => { const k = tk.get(x.id) || ('d' + i); if (!tk.has(x.id)) extra[k] = { token: x }; DK.push(k); });
const { tl, T, m, TOK } = await boot(extra);
LV.init(tl, TOK, SIDES.foes);
const U = LV.U, DIR = LV.DIR, E = tl.E, PI = Math.PI;
const nD = DK.length;

// ── the beat clock (absolute ms) ──
const RIG0 = t.rig, SONG0 = t.song, CH = t.chord, FL = t.flash, JUMP = t.jump;
const OFF = JUMP + (nD - 1) * 60 + 640;            // the last dancer's second hop is down
const LVL = cfg.levelMs || 550;                    // the mockup's level ramp: +-0.03 per frame
const TOTAL = OFF + 600 + 50;
const levelAt = (tt) => tt < RIG0 ? 0 : tt < OFF ? Math.min(1, (tt - RIG0) / LVL) : Math.max(0, 1 - (tt - OFF) / LVL);

// ── cut-in + sounds ──
LV.cutin(tl, m, 0, 'cut'); LV.Sraw(0, 'overdrive', 0.9);
LV.S(RIG0, 'item', 0.4);
LV.S(CH, 'powerup', 0.5); LV.S(CH, 'powerup2', 0.3);

// ── the disco rig ──
const R = tl.rng(cfg.seed || 1414); const rr = (a, b) => a + (b - a) * R();
const COLS = ['pink', 'cyan', 'amber', 'green', 'violet'];
const N = cfg.circles || 14;
const ST = tl.STAGE; const KX = (ST.w || 1682) / 1682, KY = (ST.h || 788) / 788;
// the reflection field in mockup px (cx = W * .52, cy 440, RX = W * .5, RY 260): the whole floor, both sides
const CXm = 1682 * 0.52, CYm = 440, RXm = 1682 * 0.5, RYm = 260;
const home2D = { x: caster.center.x, y: ((caster.document && caster.document.y) != null ? caster.document.y : caster.y) + caster.h };
let D0 = 1; try { D0 = oni.depthAt(home2D).s || 1; } catch (e) { D0 = 1; }
// a mockup floor point -> where the 3D stage draws it, with its depth size relative to Love
const floorAt = (mx, my) => { if (DIR < 0) mx = 1682 - mx; const p2 = { x: ST.x + mx * KX, y: ST.y + my * KY }; let p = null; try { p = oni.depthAt(p2); } catch (e) { p = null; } return p ? { x: p.x, y: p.y, s: (p.s || 1) / D0 } : { x: p2.x, y: p2.y, s: 1 }; };
const LF = tl.feet(TOK.c);
const focusPts = DK.map((k) => { const f = tl.feet(TOK[k]); return { x: f.x, y: f.y, s: tl.depthRatio(LF, f) }; });
const rigs = []; for (let i = 0; i < N; i++) rigs.push({ i, ang: rr(0, 6.3), rad: rr(0.25, 1), jit: { x: 0, y: 0 }, next: 0, aim: null, half: 0, col: COLS[i % COLS.length], spr: null });
let spin = 1.3, lastFlip = 0, lastT = null, LEV = 0, PULSE = 1;
const POOL_HALF = 87, POOL_V = 0.95;

// floor circles: PIXI sprites (pixelfx pool, light layer, ADD) in one floor-level container (5 shared looping videos)
let POOLS = null; const madeSprites = [];
try {
  const PX = globalThis.PIXI; const prim = canvas.primary;
  if (PX && prim && A.pools) {
    POOLS = new PX.Container(); POOLS.name = 'oni-love-serenade-pools'; POOLS.eventMode = 'none';
    // floor level, like battle-stage-ambient's back layer: one sort step above the backdrop (+1 = the 3D stage mesh,
    // +2 = the ambient layer), so the primary group's own sort keeps it under every token
    const bg = prim.background;
    if (bg) { POOLS.elevation = bg.elevation || 0; POOLS.sortLayer = bg.sortLayer || 0; POOLS.sort = (bg.sort || 0) + 3; POOLS.zIndex = bg.zIndex || 0; POOLS.__keyed = true; }
    prim.addChild(POOLS); prim.sortDirty = true;
    const tex = {};
    for (const c of COLS) { const url = A.pools[c]; if (!url) continue; const fx = await oni.webm(url, { loop: true, restart: false, parent: POOLS, alpha: 0, blend: PX.BLEND_MODES.ADD, size: 240 }); if (fx && fx.sprite) { tex[c] = fx.sprite.texture; fx.sprite.visible = false; madeSprites.push(fx.sprite); } }
    for (const r of rigs) { const tx = tex[r.col]; if (!tx) continue; const sp = new PX.Sprite(tx); sp.anchor.set(0.5, POOL_V); sp.blendMode = PX.BLEND_MODES.ADD; sp.alpha = 0; sp.visible = false; POOLS.addChild(sp); r.spr = sp; madeSprites.push(sp); }
  }
} catch (e) { console.warn('[ONI][Love Serenade] pool sprites failed, drawing plain circles', e); }
const keepUnder = () => {
  const P = canvas.primary; if (!POOLS || POOLS.__keyed || !P || POOLS.parent !== P) return; const kids = P.children; let first = -1;
  for (let i = 0; i < kids.length; i++) { const n = kids[i] && kids[i].name; if (typeof n === 'string' && n.indexOf('Token.') === 0) { first = i; break; } }
  const want = first < 0 ? kids.length - 1 : Math.max(0, first - 1); const cur = kids.indexOf(POOLS);
  if (cur >= 0 && cur !== want) { try { P.setChildIndex(POOLS, Math.min(want, kids.length - 1)); } catch (e) {} }
};
// fallback circle stamps (only when the pool clips could not load): soft coloured ellipses on the under layer
const RGB = { pink: '255,90,190', cyan: '80,220,255', amber: '255,190,70', green: '120,255,130', violet: '190,120,255' };
const STAMPC = {}; const stampFor = (c) => { if (STAMPC[c]) return STAMPC[c]; const cv = document.createElement('canvas'); cv.width = cv.height = 128; const x = cv.getContext('2d'); const gr = x.createRadialGradient(64, 64, 0, 64, 64, 64); gr.addColorStop(0, 'rgba(' + RGB[c] + ',0.9)'); gr.addColorStop(0.6, 'rgba(' + RGB[c] + ',0.5)'); gr.addColorStop(1, 'rgba(' + RGB[c] + ',0)'); x.fillStyle = gr; x.fillRect(0, 0, 128, 128); STAMPC[c] = cv; return cv; };

// the per-frame rig step (one track): circle targets, the eased aim, the sprites
m.hold(RIG0, TOTAL + 100, (e, S) => {
  const now = e + RIG0; const dt = lastT == null ? 16.67 : Math.max(1, Math.min(100, now - lastT)); lastT = now;
  LEV = levelAt(now); const b = (now - RIG0) / 1000 * BPM / 60; PULSE = 0.8 + 0.2 * Math.pow(1 - (b % 1), 3);
  const focus = now >= CH;
  if (!focus && b - lastFlip > 3 && R() < 1 - Math.pow(0.98, dt / 16.67)) { spin = -spin * rr(0.8, 1.3); lastFlip = b; }
  const q = 1 - Math.pow(1 - (focus ? 0.14 : 0.32), dt / 16.67);
  for (const r of rigs) {
    let tg;
    if (focus) tg = focusPts[r.i % focusPts.length];
    else {
      if (b > r.next) { r.next = b + rr(0.25, 0.6); if (R() < 0.45) { r.jit = { x: rr(-160, 160), y: rr(-70, 70) }; r.ang += rr(-1.2, 1.2); } }   // erratic jumps
      const a = r.ang + b * spin * 0.9; tg = floorAt(CXm + Math.cos(a) * RXm * r.rad + r.jit.x, CYm + Math.sin(a) * RYm * r.rad + r.jit.y);
    }
    r.aim = r.aim ? { x: r.aim.x + (tg.x - r.aim.x) * q, y: r.aim.y + (tg.y - r.aim.y) * q, s: r.aim.s + (tg.s - r.aim.s) * q } : { x: tg.x, y: tg.y, s: tg.s };
    r.half = (focus ? 95 : 62) * U * r.aim.s;
    const sp = r.spr; if (sp) { const w = 240 * r.half / POOL_HALF; sp.width = w; sp.height = w * 2; sp.position.set(r.aim.x, r.aim.y); sp.alpha = 0.42 * LEV * PULSE; sp.visible = LEV > 0.001; }
  }
  if (POOLS) keepUnder();
  else if (LEV > 0) S.world.push({ z: 2, draw: (g) => { g.save(); g.globalCompositeOperation = 'lighter'; for (const r of rigs) { if (!r.aim) continue; const rx = r.half * 1.15, ry = r.half * 0.45; g.globalAlpha = 0.42 * LEV * PULSE; g.drawImage(stampFor(r.col), r.aim.x - rx, r.aim.y - ry, rx * 2, ry * 2); } g.restore(); } });
});

// ── the dim: half-resolution mask over the whole view, soft holes where the circles are ──
const MC = document.createElement('canvas'), mc = MC.getContext('2d');
const HOLE = (() => { const c = document.createElement('canvas'); c.width = c.height = 128; const x = c.getContext('2d'); const gr = x.createRadialGradient(64, 64, 0, 64, 64, 64); gr.addColorStop(0, 'rgba(0,0,0,.75)'); gr.addColorStop(0.6, 'rgba(0,0,0,.6)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = gr; x.fillRect(0, 0, 128, 128); return c; })();
m.hold(RIG0, TOTAL + 100, (e, S) => {
  if (LEV <= 0) return;
  S.world.push({ z: 60, draw: (g) => {
    const V = tl.view(); const w2 = Math.max(2, Math.ceil(V.W * 0.5)), h2 = Math.max(2, Math.ceil(V.H * 0.5));
    if (MC.width !== w2 || MC.height !== h2) { MC.width = w2; MC.height = h2; }
    mc.setTransform(1, 0, 0, 1, 0, 0); mc.globalCompositeOperation = 'source-over'; mc.globalAlpha = 1; mc.clearRect(0, 0, w2, h2);
    mc.fillStyle = 'rgba(4,2,10,' + (0.72 * LEV).toFixed(3) + ')'; mc.fillRect(0, 0, w2, h2);
    mc.globalCompositeOperation = 'destination-out'; mc.globalAlpha = PULSE; const sc = (canvas.stage.scale.x || 1) * 0.5;
    for (const r of rigs) { if (!r.aim) continue; const p = tl.toScreen(r.aim.x, r.aim.y); const rx = r.half * 1.15 * sc, ry = r.half * 0.45 * sc; mc.drawImage(HOLE, p.x * 0.5 - rx, p.y * 0.5 - ry, rx * 2, ry * 2); }
    mc.globalCompositeOperation = 'source-over'; mc.globalAlpha = 1;
    g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1; g.imageSmoothingEnabled = true; g.drawImage(MC, 0, 0, g.canvas.width, g.canvas.height); g.restore();
  } });
});

// ── the dancers: hidden as tokens for the whole rig window, painted here above the dim ──
const STY = ['sway', 'bounce', 'turn', 'kick'];
const style = DK.map((k, i) => i === 0 ? 'bounce' : STY[i % STY.length]);
const hop = DK.map((k, i) => { const J = JUMP + i * 60; return [[J, 0], [J + 170, 34, 'outC'], [J + 320, 0, 'inQ'], [J + 490, 34, 'outC'], [J + 640, 0, 'inQ']]; });
const keyAt = (keys, tt) => { if (tt <= keys[0][0]) return keys[0][1]; for (let i = 1; i < keys.length; i++) { const a = keys[i - 1], bb = keys[i]; if (tt <= bb[0]) { const u = (tt - a[0]) / (bb[0] - a[0]); return a[1] + (bb[1] - a[1]) * ((E[bb[2]] || E.lin)(u)); } } return keys[keys.length - 1][1]; };
const poseAt = (i, tt) => {
  const o = { dx: 0, bob: 0, rot: 0, kx: 1, ky: 1, fl: 1, lift: keyAt(hop[i], tt) * U, flash: 0 };
  if (tt >= SONG0 && tt < CH) {
    const beats = (tt - SONG0) / 1000 * BPM / 60, ph = beats % 1, kk = Math.floor(beats); const st = style[i];
    if (st === 'sway') { o.dx = Math.sin(beats * PI) * 12; o.rot = Math.sin(beats * PI) * 7; }
    else if (st === 'bounce') { o.bob = -Math.abs(Math.sin(ph * PI)) * 12; const qq = Math.max(0, 1 - ph * 5); o.ky = 1 - 0.1 * qq; o.kx = 1 + 0.08 * qq; }
    else if (st === 'turn') { o.fl = (kk % 4 < 2) ? 1 : -1; o.bob = -Math.abs(Math.sin(ph * PI)) * 6; o.rot = Math.sin(beats * PI * 2) * 3; }
    else { o.bob = kk % 2 ? -Math.sin(ph * PI) * 18 : 0; o.rot = kk % 2 ? Math.sin(ph * PI) * 12 : Math.sin(ph * PI) * 4; }
  }
  if (tt >= FL && tt < FL + 500) { const u = (tt - FL) / 500; o.flash = (1 - u) * (1 - u); }
  return o;
};
const SHADOW = (() => { const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d'); const gr = x.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, 'rgba(0,0,0,.55)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = gr; x.fillRect(0, 0, 64, 64); return c; })();
const order = DK.map((k, i) => i).sort((a, b) => tl.feet(TOK[DK[a]]).y - tl.feet(TOK[DK[b]]).y);
m.hold(RIG0, TOTAL + 100, (e, S) => {
  const now = e + RIG0;
  for (const k of DK) if (S.tok[k]) S.tok[k].hidden = true;
  const poses = DK.map((k, i) => poseAt(i, now));
  S.world.push({ z: 70, draw: (g) => {
    for (const i of order) { const k = DK[i], Tk = TOK[k], f = tl.feet(Tk), o = poses[i]; const lk = Math.min(1, o.lift / Math.max(1, Tk.h)); const sw = Tk.w * 0.62 * (1 - 0.35 * lk);
      g.save(); g.globalAlpha = 0.8 * (1 - 0.45 * lk); g.drawImage(SHADOW, f.x + o.dx * U * DIR - sw / 2, f.y - sw * 0.14, sw, sw * 0.28); g.restore(); }
    for (const i of order) { const k = DK[i], Tk = TOK[k], art = tl.art(k); if (!art) continue; const f = tl.feet(Tk), o = poses[i];
      g.save(); g.translate(f.x + o.dx * U * DIR, f.y + o.bob * U - o.lift); if (o.rot) g.rotate(o.rot * PI / 180 * DIR); g.scale(Tk.flip * o.fl * o.kx, o.ky);
      if (o.flash > 0.01) g.filter = 'brightness(' + (1 + 1.3 * o.flash).toFixed(3) + ') drop-shadow(0 0 ' + (14 * o.flash * U).toFixed(1) + 'px #ffe28a)';
      g.drawImage(art, -Tk.w / 2, -Tk.h * Tk.foot, Tk.w, Tk.h); g.restore(); }
  } });
});

// ── notes from his hand during the song, hearts / notes tossed on the jumps ──
const HI = LV.layer(m, 80);
LV.noteStream(HI, SONG0, CH, 160, LV.hand('c'));
DK.forEach((k, i) => LV.toss(HI, JUMP + i * 60, LV.head(k), 4, () => (R() < 0.5 ? LV.shape('heart', 7, LV.HEART) : LV.shape('note', 7, LV.NOTE))));

// ── final chord: strobe x3 (90 ms apart, decaying x0.82 per frame), confetti, gold flash on the dancers ──
m.hold(CH, CH + 1400, (e, S) => { const last = e >= 180 ? 180 : e >= 90 ? 90 : 0; const a = 0.55 * Math.pow(0.82, (e - last) / 16.67); if (a > 0.011 && a > S.flash.a) S.flash = { a, c: '#ffffff' }; });
const CF = LV.layer(m, 0, true);
for (let i = 0; i < 70; i++) {
  const x0 = rr(0, 900), y0 = rr(-80, -10), vx = rr(-0.04, 0.04), vy = rr(0.08, 0.18), life = rr(1800, 2600), rot0 = rr(0, 6), vr = rr(-0.01, 0.01), rgb = LV.CONCERT[Math.floor(R() * LV.CONCERT.length)], w = rr(4, 8);
  CF.push({ t0: FL, life, draw: (g, e, u) => { const KW = g.W / 1682, KH = g.H / 788; let x = (x0 + vx * e + Math.sin(e / 200) * 10) * KW; if (DIR < 0) x = g.W - x; const y = (y0 + vy * e) * KH;
    g.globalCompositeOperation = 'source-over'; g.globalAlpha = u > 0.8 ? (1 - u) / 0.2 : 1; g.translate(x, y); g.rotate(rot0 + vr * e); g.fillStyle = 'rgb(' + rgb + ')'; g.fillRect(-w * KW / 2, -w * KW * 0.3, w * KW, w * KW * 0.6); } });
}

LV.gate(m, OFF);
try { await tl.run(T, { total: TOTAL, sfx: LV.sfx, onStart: K.ready }); }
finally { try { if (POOLS) POOLS.destroy({ children: true, texture: false, baseTexture: false }); } catch (e) {} }
oni.fireDone();
