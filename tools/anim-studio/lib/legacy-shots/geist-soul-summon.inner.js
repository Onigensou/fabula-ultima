// ── Geist · Living Shadow (cfg.count 1) / Dark Missionary (cfg.count 3) ──
// Approved mockup (round 5 soulStream): NO tear-out. Purple / red soul motes stream out of his whole body
// (homing arcs), gather on the spawn spot in a swirl, and the shade condenses there from the floor up, red
// eyes lighting last. Dark Missionary = three streams and three shades AT ONCE (60 ms apart).
// The spawn spots are the July scripts' EXACT prediction (computeSpawnCells, a copy of
// director-init.spawnLiveDirectorTokens' freeCell: one cell ahead of the caster toward scene centre, then
// down the column), mapped to where the 3D stage DRAWS that floor point, so the real summoned token appears
// on the shade. The gate fires when the last shade has condensed (RESOLVE spawns the real token there); the
// shades then fade over it. The HP cost number is the game's (resolve side); the camera zoom of the mockup
// is not used (live board: the camera is left alone so the 3D stage keeps its parallax).
const N = Math.max(1, cfg.count || 1);
const cx = caster.center.x, cy = caster.center.y;

// EXACT spawn placement (July, verbatim): token CENTRE of each summon cell
const computeSpawnCells = (count) => {
  const scene = canvas.scene;
  const grid = canvas.grid?.size ?? 100;
  const SW = scene?.width ?? (canvas.dimensions?.sceneWidth ?? 0);
  const SH = scene?.height ?? (canvas.dimensions?.sceneHeight ?? 0);
  const step = grid * 1.15;
  const toward = (SW / 2 >= cx) ? 1 : -1;
  const anchorX = cx + toward * grid * 1.15;
  const baseX = Math.round(anchorX), baseY = Math.round(cy);
  const dir = anchorX <= SW / 2 ? 1 : -1;
  const occupied = ((scene && scene.tokens && scene.tokens.contents) ? scene.tokens.contents : [])
    .map((t) => ({ x: t.x + ((t.width || 1) * grid) / 2, y: t.y + ((t.height || 1) * grid) / 2 }));
  const freeCell = () => {
    for (let col = 0; col < 5; col++) for (let row = 0; row < 8; row++) {
      const x = baseX + col * step * dir;
      const y = baseY + row * step;
      if (x < grid || x > SW - grid || y > SH - grid) continue;
      if (occupied.some((o) => Math.abs(o.x - x) < grid * 0.7 && Math.abs(o.y - y) < grid * 0.7)) continue;
      return { x, y };
    }
    return { x: baseX, y: Math.min(SH - grid, baseY) };
  };
  const cells = [];
  for (let i = 0; i < count; i++) { const c = freeCell(); occupied.push(c); cells.push(c); }
  return { cells, grid };
};
const { cells } = computeSpawnCells(N);

// a cell centre (2D) -> the drawn feet of a body standing there: the shade is Geist's own art at shadeScale,
// its feet placed as his are on his token, then projected through the 3D stage (2D when there is none)
const h2D = (caster.mesh && caster.mesh.height) || caster.h || 100;
const P3 = globalThis.__ONI_BATTLE_STAGE_3D__;
const spotOf = (c, sc) => { const hs = h2D * sc; const f2 = { x: c.x, y: c.y - hs / 2 + hs * K.foot }; let p = null;
  try { p = P3 && P3.projectFoot ? P3.projectFoot(f2) : null; } catch (e) { p = null; }
  return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x, y: p.y } : f2; };

const SHADES = [];
// one stream: start at S0 -> returns the time the shade has fully condensed
function soulStream(S0, to, shadeScale) {
  const ds = dS(kf, to);
  S_(S0, 'darkness1', 0.45);
  flashK(S0, '#c070ff', 500);
  // 46 motes leave from all over his body, arc up and stream to the spot
  let G = S0;
  for (let i = 0; i < 46; i++) {
    const st = S0 + i * 18;
    const from = { x: kf.x + rnd(-bw('k') * 0.35, bw('k') * 0.35), y: kf.y - rnd(K.h * 0.15, K.h * 0.9) };
    const end = { x: to.x + rnd(-14, 14) * KP, y: to.y - rnd(10, 60) * KP * ds };
    G = Math.max(G, homing(st, from, end, pick(['190,80,255', '235,60,110', '255,170,230']), { ms: rnd(520, 760), arc: 130, r: rnd(2.5, 4.5) }));
  }
  G = Math.min(G, S0 + 2200);
  // gathered: a swirl of motes on the spot, a floor ring, then the shade condenses from the floor up
  S_(G, 'darkness4', 0.55);
  ring(G, to, { rgb: '230,60,120', r1: 110, w: 6, s: ds });
  for (let i = 0; i < 18; i++) PT.push({ kind: 'swirl', t0: G, life: 700, x: to.x, y: to.y, a0: rnd(0, 6.3), R0: rnd(20, 45) * KP * ds, rgb: pick(['190,80,255', '235,60,110']) });
  const h = K.h * shadeScale * ds, REV = 620;
  for (let e = 0; e < REV; e += 16) { const u = E.sine(e / REV), ly = to.y - h * u;
    for (let i = 0; i < 2; i++) ember(G + e, to.x + rnd(-h * 0.28, h * 0.28), ly, pick(['170,70,255', '255,60,90']), { vy: -rnd(0.08, 0.16), r: rnd(3, 6), life: rnd(250, 420) }); }
  const sh = { G, REV, to, h, fade: 1e9 }; SHADES.push(sh);
  const eyes = { x: to.x - 6 * KP * ds * DIR, y: to.y - h * 0.86 };
  twinkles(G + REV, eyes, { n: 3, r: 4, rgb: '255,60,80' });
  return G + REV;
}

// the shade: Geist's art, darkened to a violet silhouette with a red / violet rim, revealed bottom-up.
// The filtered silhouette is rendered once to a padded canvas (a still of his art), then drawn per frame.
let SIL = null;
const silhouette = () => {
  if (SIL !== null) return SIL; SIL = false; const art = tl.art('k'); if (!art) return SIL;
  const w = art.videoWidth || art.naturalWidth || art.width, h = art.videoHeight || art.naturalHeight || art.height; if (!w || !h) return SIL;
  const pad = Math.round(h * 0.08); const cv = document.createElement('canvas'); cv.width = w + pad * 2; cv.height = h + pad * 2; const g = cv.getContext('2d');
  g.filter = 'brightness(.18) sepia(1) hue-rotate(235deg) saturate(4) drop-shadow(0 0 ' + Math.round(h * 0.03) + 'px rgba(235,50,110,1)) drop-shadow(0 0 ' + Math.round(h * 0.012) + 'px rgba(190,110,255,1))';
  try { g.drawImage(art, pad, pad, w, h); } catch (e) { return SIL; }
  SIL = { cv, pad, w, h }; return SIL; };
m.hold(0, 600000, (t, S) => { const live = SHADES.filter((s) => t >= s.G && t <= s.fade + 300); if (!live.length) return;
  S.world.push({ z: 20, draw: (g) => { const sil = silhouette(); if (!sil) return;
    for (const s of live) { const u = E.sine(Math.min(1, (t - s.G) / s.REV)); const a = t > s.fade ? 1 - (t - s.fade) / 300 : 1; if (a <= 0 || u <= 0) continue;
      const k = s.h / sil.h, dw = (sil.w + sil.pad * 2) * k, dh = (sil.h + sil.pad * 2) * k, top = -K.foot * s.h - sil.pad * k;
      g.save(); g.translate(s.to.x, s.to.y); g.scale(K.flip, 1); g.globalAlpha = a;
      g.beginPath(); g.rect(-dw, -s.h * K.foot + (1 - u) * s.h, dw * 2, s.h * u + dh); g.clip();
      g.drawImage(sil.cv, -dw / 2, top, dw, dh); g.restore(); } } }); });

// ── schedule ──
const DIM = N > 1 ? 0.45 : 0.5;
m.dim(0, 300, DIM);
if (N > 1) S_(0, 'spook', 0.5);
const S0 = N > 1 ? 500 : 450;
const order = N === 3 ? [2, 0, 1] : cells.map((_, i) => i);
let ready = S0;
order.forEach((ci, i) => { const c = cells[ci] || cells[0]; ready = Math.max(ready, soulStream(S0 + i * 60, spotOf(c, cfg.shadeScale), cfg.shadeScale)); });
const HOLD = N > 1 ? 500 : 600;
const FADE = ready + HOLD;
for (const s of SHADES) s.fade = FADE;
m.undim(FADE + 300, 400, DIM);
await go(FADE + 300 + 400 + 60, ready);
