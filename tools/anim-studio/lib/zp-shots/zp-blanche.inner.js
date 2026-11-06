// Blanche — Zero Power: Give me tips or 5stars. Port of the approved Zero Power
// overhaul mockup (artifact v17, 2026-11-06; cfg locked by the user).
// Maid-cafe gag: up to four allies on the field sit at the cafe tables; Blanche
// serves each a random NEO TWEWY dish, faster every lap, trips on the last dash
// (her KO pose), the final dish (cake / drink / omurice) hangs in slow motion in
// front of the last customer's face, a whiteout hides the hit, and back on the
// battlefield the game's heal + cleanse beats play on the party while the victim
// wears the dish. BD's own heal / cleanse numbers land at the gate (fireDone at
// the "Back to battle" moment; the rest of the shot is a cosmetic tail).
// The cafe is drawn in SCREEN space in the mockup's stage coordinates (1682 x 788,
// the size of the cafe painting), covered to the view, over a dark floor, so the
// tilted slow-motion camera never shows past the painting.
// Storage rules: no backticks and no dollar-brace anywhere in this file.
if (!caster) { K.ready(); oni.fireDone(); return; }
const SW = 1682, SH = 788;
const CF = {
  home: { x: 760, y: 470 },
  seats: [{ x: 480, y: 315, table: { x: 350, y: 205 } }, { x: 1215, y: 300, table: { x: 1075, y: 160 } }, { x: 1260, y: 665, table: { x: 1095, y: 590 } }, { x: 300, y: 690, table: { x: 140, y: 600 } }],
  path: [{ x: 600, y: 380 }, { x: 1090, y: 360 }, { x: 1110, y: 700 }, { x: 430, y: 705 }],
};
// Blanche's own pose art from her sheet, when it has one (the cfg carries the Forge defaults).
const BP = (caster.actor && caster.actor.system && caster.actor.system.props) || {};
const sheetUrl = (k) => { const v = String(BP[k] || '').trim(); return v || null; };
if (A.clips.walkdl && sheetUrl('sprite_walk')) A.clips.walkdl.url = sheetUrl('sprite_walk');
if (A.clips.walkul && sheetUrl('sprite_walk_up_left')) A.clips.walkul.url = sheetUrl('sprite_walk_up_left');
if (A.clips.ko && sheetUrl('sprite_ko')) A.clips.ko.url = sheetUrl('sprite_ko');

// Customers: up to four random allies on the field other than Blanche (party, summons, guests).
const disp = caster.document ? caster.document.disposition : 1;
const pool = ((canvas.tokens && canvas.tokens.placeables) || []).filter((tk) => tk && tk.id !== caster.id && tk.visible && tk.mesh && tk.document && !tk.document.hidden && tk.document.disposition === disp);
for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const x = pool[i]; pool[i] = pool[j]; pool[j] = x; }
const cust = pool.slice(0, Math.max(0, Math.min(4, cfg.customers == null ? 4 : cfg.customers)));
const extra = {}; cust.forEach((tk, i) => { extra['q' + i] = { token: tk }; });
const B = await boot(extra);
const { tl, T, m, TOK, TG, E } = B;
const lerp = (a, b, k) => a + (b - a) * k;
const clampN = (v, a, b) => (v < a ? a : v > b ? b : v);
const outBack = (k) => { const c = 1.6; return 1 + (c + 1) * Math.pow(k - 1, 3) + c * Math.pow(k - 1, 2); };
const sine = (k) => 0.5 - 0.5 * Math.cos(Math.PI * k);
const n = cust.length;
// Sizes in cafe px: a battler is drawn 1.25x its own rendered token height (the mockup rule);
// KF scales the mockup's px offsets (tray, hops, dish) to Blanche's real size (213 = her mockup height).
const HB = TOK.c.h * 1.25, KF = HB / 213;
const custH = (i) => TOK['q' + i].h * 1.25;
const Ub = TOK.c.h / 170;   // world-space sizes on the battlefield (the mockup battler was ~170 px)

// sounds fired straight through oni.sfx (rate / fade options the timeline cues lack)
const S5 = cfg.s || {};
const play = (at, key, o) => { const s = S5[key]; if (!s) return; o = o || {}; ZP.once(m, at, () => { try { oni.sfx(s.url, { volume: Math.min(1, (o.v != null ? o.v : 1) * (s.v != null ? s.v : 0.7)), rate: o.rate || 1, fadeAfter: o.fadeAfter || 0 }); } catch (e) {} }); };
const sfx = (cfg.sfx || []).slice();

// ── schedule (the mockup's awaits flattened to absolute ms) ──
let at = 0;
m.dim(0, 200, 0.6);
at = ZP.cutin(tl, m, 0, 'cut');                 // Zero Power cut-in (Overdrive cue at 0)
const tIrisC = at; at += 520;                   // iris closes on Blanche
const tCafe = at; play(tCafe, 'bell', { v: 0.45 }); at += 250;
const tIrisO = at; at += 600;                   // iris opens on the cafe
const tServe = at;

const foodKeys = (cfg.foods || []).filter((k) => !!A.images[k]);
let lastFood = -1;
const nextFood = () => { if (!foodKeys.length) return 'cake'; let i; do { i = Math.floor(Math.random() * foodKeys.length); } while (foodKeys.length > 1 && i === lastFood); lastFood = i; return foodKeys[i]; };
let bpos = { x: CF.home.x, y: CF.home.y };
const legs = [];    // { t0, t1, from, to, pose, flip, fast, rate }
const holds = [];   // the dish on her tray: { t0, t1, kind }
const served = [];  // { t0, hop, kind, i, lap }
const smokes = [];  // dash smoke at the end of a fast leg: { t, x, y, flip }
function leg(to, ms, fast) {
  const dx = to.x - bpos.x, dy = to.y - bpos.y;
  const pose = dy < -8 ? 'walkul' : 'walkdl', flip = dx > 0 ? -1 : 1;
  legs.push({ t0: at, t1: at + ms, from: { x: bpos.x, y: bpos.y }, to: { x: to.x, y: to.y }, pose, flip, fast, rate: Math.min(4, 700 / ms) });
  at += ms; bpos = { x: to.x, y: to.y };
  if (fast) smokes.push({ t: at, x: to.x, y: to.y - 8, flip: flip < 0 });
}
let legMs = cfg.laps > 0 ? cfg.lap1 : 0;
for (let lap = 0; lap < (cfg.laps || 0); lap++) {
  const fast = lap >= 1;
  for (let i = 0; i < n; i++) {
    const kind = nextFood(); holds.push({ t0: at, t1: 0, kind });
    leg(CF.path[i], legMs, fast);
    const hop = Math.max(120, 240 - lap * 40);
    holds[holds.length - 1].t1 = at; served.push({ t0: at, hop, kind, i, lap });
    at += hop; at += Math.max(60, 300 - lap * 90);
  }
  if (lap < cfg.laps - 1) leg(CF.home, legMs * 0.8, fast);
  legMs = legMs / cfg.accel;
}
// the trip
const SPILLS = ['cake', 'drink', 'omurice'];
const spill = SPILLS.indexOf(cfg.spill) >= 0 ? cfg.spill : SPILLS[Math.floor(Math.random() * 3)];
const spillArt = spill === 'drink' ? 'latte' : spill;
const tTrip = at;
holds.push({ t0: at, t1: 0, kind: spillArt });
bpos = { x: CF.home.x, y: CF.home.y };
const vi = n > 0 ? n - 1 : -1;
const vSeat = vi >= 0 ? CF.seats[vi] : CF.seats[0];
const vH = vi >= 0 ? custH(vi) : HB;
const midP = { x: lerp(CF.home.x, vSeat.x, 0.3), y: lerp(CF.home.y, vSeat.y, 0.3) };
leg(midP, 240, true);
play(at, 'fall', { v: 0.55 });
const dir = Math.sign(vSeat.x - bpos.x) || 1;
const cakeFrom = { x: bpos.x + dir * 30 * KF, y: bpos.y - HB * 0.62 };
holds[holds.length - 1].t1 = at;
const ko = { t0: at, from: { x: bpos.x, y: bpos.y }, to: { x: bpos.x + dir * 50 * KF, y: bpos.y + 6 * KF }, flip: dir > 0 ? -1 : 1 };
smokes.push({ t: at, x: bpos.x, y: bpos.y - 10, flip: dir < 0, ko: true });
at += 260;
// slow motion
const tSlow = at; play(tSlow, 'slowreel', { v: 0.6 }); at += cfg.slowMs;
// whiteout: the sound says which dish landed
const tWhite = at;
if (spill === 'drink') { play(tWhite, 'liquid', { v: 0.8 }); play(tWhite + 120, 'glass', { v: 0.6 }); }
else if (spill === 'omurice') { play(tWhite, 'smackA', { v: 0.95 }); play(tWhite + 110, 'crash', { v: 0.55 }); }
else { play(tWhite, 'smackB', { v: 0.95 }); play(tWhite + 100, 'water3', { v: 0.3, rate: 1.3 }); }
at += cfg.whiteHold;
// back to battle (the gate)
const tBack = at;
const tHeal = tBack + 450, tCure = tHeal + 380, tHop = tCure + 500, total = tHop + 520 + 1300;
ZP.once(m, tBack, () => oni.fireDone());

// ── cafe camera: identity until the slow motion, then a creep onto the dish and the face ──
const faceAt = { x: vSeat.x, y: vSeat.y - vH * 0.86 + vH * 0.06 };
const stopP = { x: lerp(cakeFrom.x, faceAt.x, 0.93), y: lerp(cakeFrom.y, faceAt.y, 0.93) };
const zS = 2.15;
const camEnd = { x: clampN((stopP.x + faceAt.x) / 2, SW / 2 / zS + 30, SW - SW / 2 / zS - 30), y: clampN((stopP.y + faceAt.y) / 2, SH / 2 / zS + 30, SH - SH / 2 / zS - 30), z: zS, r: 2 };
function camAt(tt) {
  if (tt < tSlow) return { x: SW / 2, y: SH / 2, z: 1, r: 0 };
  const k = sine(clampN((tt - tSlow) / cfg.slowMs, 0, 1));
  return { x: lerp(SW / 2, camEnd.x, k), y: lerp(SH / 2, camEnd.y, k), z: Math.exp(lerp(0, Math.log(camEnd.z), k)), r: lerp(0, camEnd.r, k) };
}
// cafe -> screen: cover the view, then the cafe camera around the stage centre
function xf(g, tt) {
  const s0 = Math.max(g.W / SW, g.H / SH), ox = (g.W - SW * s0) / 2, oy = (g.H - SH * s0) / 2; const c = camAt(tt); const rr = c.r * Math.PI / 180, co = Math.cos(rr), si = Math.sin(rr);
  return {
    s: s0 * c.z, r: rr,
    apply: (gg) => { gg.translate(ox, oy); gg.scale(s0, s0); gg.translate(SW / 2, SH / 2); gg.rotate(rr); gg.scale(c.z, c.z); gg.translate(-c.x, -c.y); },
    P: (x, y) => { const dx = (x - c.x) * c.z, dy = (y - c.y) * c.z; return { x: ox + s0 * (SW / 2 + dx * co - dy * si), y: oy + s0 * (SH / 2 + dx * si + dy * co) }; },
  };
}
// Blanche in the cafe at time tt: { x, y, oy, pose, flip, h, rate, fast, legT0 }
function blAt(tt) {
  if (tt >= ko.t0) { const k = 1 - (1 - clampN((tt - ko.t0) / 260, 0, 1)) * (1 - clampN((tt - ko.t0) / 260, 0, 1)); return { x: lerp(ko.from.x, ko.to.x, k), y: lerp(ko.from.y, ko.to.y, k), oy: 0, pose: 'ko', flip: ko.flip, h: HB * (248 / 250), rate: tt >= tSlow ? 0.08 : 1 }; }
  let last = null;
  for (const L of legs) { if (tt < L.t0) break; last = L; if (tt < L.t1) { const u = (tt - L.t0) / (L.t1 - L.t0); return { x: lerp(L.from.x, L.to.x, u), y: lerp(L.from.y, L.to.y, u), oy: -Math.abs(Math.sin(u * Math.PI * 2)) * (L.fast ? 4 : 7) * KF, pose: L.pose, flip: L.flip, h: HB, rate: L.rate, fast: L.fast, leg: L }; } }
  if (last) return { x: last.to.x, y: last.to.y, oy: 0, pose: last.pose, flip: last.flip, h: HB, rate: 1 };
  return { x: CF.home.x, y: CF.home.y, oy: 0, pose: 'walkdl', flip: 1, h: HB, rate: 1 };
}
const trayPt = (b) => { const d = b.flip > 0 ? -1 : 1; return { x: b.x + d * 22 * KF, y: b.y - b.h * 0.55 + b.oy }; };

// drawn dishes (the final spill) — the mockup's foodCanvas, verbatim
const heartPath = (c, x, y, r) => { c.beginPath(); c.moveTo(x, y + r * 0.9); c.bezierCurveTo(x - r * 1.4, y - r * 0.1, x - r * 0.6, y - r * 1.1, x, y - r * 0.35); c.bezierCurveTo(x + r * 0.6, y - r * 1.1, x + r * 1.4, y - r * 0.1, x, y + r * 0.9); };
function foodCanvas(kind) {
  const cv = document.createElement('canvas'); cv.width = 120; cv.height = 110; const c = cv.getContext('2d');
  const plate = (y, rx) => { y = y || 92; rx = rx || 50; c.fillStyle = '#f7f7fb'; c.beginPath(); c.ellipse(60, y, rx, 12, 0, 0, 7); c.fill(); c.strokeStyle = '#c9c9d6'; c.lineWidth = 2.5; c.stroke(); };
  if (kind === 'cake') { plate(); c.fillStyle = '#f4dfb0'; c.beginPath(); c.moveTo(26, 88); c.lineTo(96, 88); c.lineTo(96, 52); c.lineTo(26, 42); c.closePath(); c.fill();
    c.fillStyle = '#fffaf2'; c.fillRect(26, 62, 70, 6); c.beginPath(); c.moveTo(24, 44); c.quadraticCurveTo(60, 28, 98, 53); c.lineTo(98, 45); c.quadraticCurveTo(58, 22, 24, 37); c.fill();
    c.fillStyle = '#e5354f'; c.beginPath(); c.arc(61, 30, 9, 0, 7); c.fill(); c.fillStyle = '#3c8c3a'; c.fillRect(58, 18, 5, 5); }
  else if (kind === 'latte') { c.fillStyle = 'rgba(230,240,255,.55)'; c.beginPath(); c.moveTo(34, 20); c.lineTo(86, 20); c.lineTo(80, 100); c.lineTo(40, 100); c.closePath(); c.fill();
    c.fillStyle = '#f2a7b8'; c.beginPath(); c.moveTo(36, 40); c.lineTo(84, 40); c.lineTo(80, 98); c.lineTo(40, 98); c.closePath(); c.fill();
    c.fillStyle = '#5b3a2e'; for (let i = 0; i < 7; i++) { c.beginPath(); c.arc(46 + (i % 4) * 9, 86 + Math.floor(i / 4) * 7, 4, 0, 7); c.fill(); }
    c.fillStyle = '#fffaf2'; c.beginPath(); c.arc(50, 22, 12, 0, 7); c.arc(66, 18, 13, 0, 7); c.arc(78, 24, 10, 0, 7); c.fill();
    c.strokeStyle = '#e5354f'; c.lineWidth = 6; c.beginPath(); c.moveTo(72, 30); c.lineTo(92, 2); c.stroke(); c.fillStyle = '#e5354f'; c.beginPath(); c.arc(58, 9, 6, 0, 7); c.fill(); }
  else { plate(88, 54); c.fillStyle = '#f6c84a'; c.beginPath(); c.ellipse(60, 72, 40, 20, 0, Math.PI, 0); c.lineTo(100, 78); c.quadraticCurveTo(60, 92, 20, 78); c.closePath(); c.fill();
    c.fillStyle = 'rgba(255,255,255,.35)'; c.beginPath(); c.ellipse(52, 60, 16, 5, -0.2, 0, 7); c.fill();
    c.fillStyle = '#d8262c'; heartPath(c, 60, 68, 12); c.fill(); }
  return cv;
}
const DRAWN = { cake: foodCanvas('cake'), latte: foodCanvas('latte'), omurice: foodCanvas('omurice') };
// the spill's real art (Genshin icons, user 11-06); the drawn dishes stay as the fallback if an image fails to load
const SPILL_ART = { cake: 'gCake', latte: 'gDrink', omurice: 'gOmurice' };
// a dish in a 120 x 110 box (icons fit "contain"), centred at (x, y), rotated r deg, scaled s, alpha a
const TRAY_SC = 0.85;
function drawDish(g, kind, x, y, r, s, a) {
  const gk = SPILL_ART[kind]; const src = (gk && tl.IMG[gk]) || DRAWN[kind] || tl.IMG[kind]; if (!src || !(s > 0) || !(a > 0)) return;
  const drawn = src === DRAWN[kind];
  const iw = src.naturalWidth || src.width || 1, ih = src.naturalHeight || src.height || 1; const k = Math.min(120 / iw, 110 / ih); const w = iw * k, h = ih * k;
  g.save(); g.translate(x, y); if (r) g.rotate(r * Math.PI / 180); g.scale(s * KF, s * KF); g.globalAlpha *= a;
  if (!drawn) { g.shadowColor = 'rgba(0,0,0,.35)'; g.shadowBlur = 2; g.shadowOffsetY = 3; }
  g.drawImage(src, -w / 2, -h / 2, w, h); g.restore();
}
// a playing clip copy's current frame (the pose clips run hidden; we draw their frames ourselves)
const vf = (c) => { if (!c) return null; const v = c.copy && c.copy.video; if (v && v.readyState >= 2) return v; return c.cache || null; };

// ── pose clips: looping, invisible tracks whose frames the cafe draw uses ──
const poseClip = {};
for (const k of ['walkdl', 'walkul', 'ko']) if (A.clips[k]) poseClip[k] = m.clip(k, tCafe, { screen: { x: 0, y: 0 }, wh: 0.01, loop: true, hold: tBack - tCafe, alpha: () => 0 });

// ── the cafe (screen space over a black board) ──
const ghostF = 'sepia(1) hue-rotate(290deg) saturate(3) brightness(1.2)';
function drawBody(g, src, x, y, h, flip, a, filter) {
  if (!src) return; const vw = src.videoWidth || src.naturalWidth || src.width || 1, vh = src.videoHeight || src.naturalHeight || src.height || 1; const w = h * vw / vh;
  g.save(); g.translate(x, y); g.scale(flip, 1); g.globalAlpha *= a; if (filter) g.filter = filter; g.drawImage(src, -w / 2, -h, w, h); g.restore();
}
m.hold(tCafe, tBack, (e, S) => {
  const tt = tCafe + e; S.black = Math.max(S.black, 1);
  S.screen.push({ draw: (g) => {
    const X = xf(g, tt); g.save(); X.apply(g);
    if (tt >= tSlow) g.filter = 'saturate(.55) contrast(1.12)';
    g.fillStyle = '#1e120a'; g.fillRect(-SW, -SH, SW * 3, SH * 3);
    const pic = tl.IMG.cafe; if (pic) g.drawImage(pic, 0, 0, SW, SH);
    // customers at their seats; each bobs when served
    for (let i = 0; i < n; i++) {
      const seat = CF.seats[i]; const art = tl.art('q' + i); if (!art) continue;
      let sy = 1; for (const s of served) if (s.i === i) { const u = (tt - (s.t0 + s.hop)) / 260; if (u >= 0 && u < 1) sy = 1 + Math.sin(u * Math.PI) * 0.06; }
      const h = custH(i); const vw = art.videoWidth || art.naturalWidth || art.width || 1, vh = art.videoHeight || art.naturalHeight || art.height || 1; const w = h * vw / vh;
      g.save(); g.translate(seat.x, seat.y); g.scale(1, sy); g.drawImage(art, -w / 2, -h, w, h); g.restore();
    }
    // Blanche (+ pink afterimages on the fast legs)
    const b = blAt(tt); const pc = poseClip[b.pose]; const src = vf(pc);
    if (pc && pc.copy && pc.copy.video) { try { pc.copy.video.playbackRate = b.rate || 1; } catch (er) {} }
    if (b.leg && b.fast && src) for (let j = 5; j >= 1; j--) { const tg = tt - j * 45; if (tg < b.leg.t0) continue; const u = (tg - b.leg.t0) / (b.leg.t1 - b.leg.t0); const gx = lerp(b.leg.from.x, b.leg.to.x, u), gy = lerp(b.leg.from.y, b.leg.to.y, u); drawBody(g, src, gx, gy, b.h, b.flip, 0.45 * (1 - j * 45 / 260), ghostF); }
    if (src) drawBody(g, src, b.x, b.y + b.oy, b.h, b.flip, 1, null);
    // the dish on her tray (pops in 200 ms)
    for (const hd of holds) if (tt >= hd.t0 && tt < hd.t1) { const k = clampN((tt - hd.t0) / 200, 0, 1); const p = trayPt(b); drawDish(g, hd.kind, p.x, p.y, 0, TRAY_SC * outBack(k), 1); }
    // served dishes: hop to the table, sit 500 ms, then rise and fade
    for (const s of served) {
      const e2 = tt - s.t0; if (e2 < 0 || e2 > s.hop + 800) continue; const to = CF.seats[s.i].table;
      if (e2 < s.hop) { const b0 = blAt(s.t0); const p0 = trayPt(b0); const k = 1 - (1 - e2 / s.hop) * (1 - e2 / s.hop); drawDish(g, s.kind, lerp(p0.x, to.x, k), lerp(p0.y, to.y, k) - Math.sin(k * Math.PI) * 40 * KF, 0, TRAY_SC, 1); }
      else if (e2 < s.hop + 500) drawDish(g, s.kind, to.x, to.y, 0, TRAY_SC, 1);
      else { const u = (e2 - s.hop - 500) / 300; if (u < 1) drawDish(g, s.kind, to.x, to.y - u * 10, 0, TRAY_SC * (1 - u * 0.4), 1 - u); }
    }
    g.restore();
  } });
});

// ── cafe effects (clips placed in cafe coordinates through the camera) ──
const atCafe = (key, x, y, wMock, extraRot) => (tl2, S, g) => { const def = A.clips[key]; const tt = S._ttNow; const X = xf(g, tt == null ? tCafe : tt); const p = X.P(x, y); return { x: p.x, y: p.y, wh: (wMock * def.h / def.w) * X.s / g.H, rot: X.r + (extraRot || 0) }; };
// S._ttNow: the absolute shot time, for the live placements above
m.hold(0, total, (e, S) => { S._ttNow = e; });
for (const s of served) {
  const to = CF.seats[s.i].table, tLand = s.t0 + s.hop;
  play(tLand, 'eating', { v: 0.5, fadeAfter: 1100 }); play(tLand, 'item2', { v: 0.14, rate: 1.4 + s.lap * 0.1 });
  if (A.clips.sparkle) m.clip('sparkle', tLand, { screen: { x: 0, y: 0 }, wh: 0.05, live: atCafe('sparkle', to.x, to.y - 10, 96 * 0.55 * 1.1 * KF), add: true });
  // emotes over the customer (and a neighbour now and then)
  const em = ['love', 'heh', 'ok'].filter((k) => A.clips[k]);
  const who = [s.i]; if (s.lap >= 1 && Math.random() < 0.5 && n > 1) who.push((s.i + 1) % Math.min(3, n));
  for (const ci of who) { if (!em.length || ci >= n) continue; const key = em[Math.floor(Math.random() * em.length)]; const seat = CF.seats[ci]; const hx = seat.x + 16 + 30, hy = seat.y - custH(ci) * 0.86 - 60 + 30;
    m.clip(key, tLand, { screen: { x: 0, y: 0 }, wh: 0.05, hold: 900, loop: true, alpha: (u) => (u > 0.75 ? (1 - u) / 0.25 : 1), live: (tl2, S, g) => { const u = (S._ttNow - tLand) / 900; const X = xf(g, S._ttNow); const p = X.P(hx, hy - 14 * u); const sc = u < 0.15 ? u / 0.15 : 1; const def = A.clips[key]; return { x: p.x, y: p.y, wh: Math.max(0.0001, 60 * def.h / def.w * X.s * sc / g.H), rot: X.r }; } }); }
}
for (const sm of smokes) if (A.clips.dash) m.clip('dash', sm.t, { screen: { x: 0, y: 0 }, wh: 0.05, flip: sm.flip, alpha: () => (sm.ko ? 1 : 0.7), filter: sm.ko ? 'brightness(.85)' : 'brightness(.9) sepia(.4)', live: atCafe('dash', sm.x, sm.y, 1024 * 0.55 * (sm.ko ? 0.7 : 0.45) * KF) });

// hearts rising off each table, the spill dish in slow motion, its drips, the sweat drop
const hearts = []; const rh = tl.rng(23);
for (const s of served) { const to = CF.seats[s.i].table; for (let k = 0; k < 5; k++) hearts.push({ t: s.t0 + s.hop, x: to.x + (rh() - 0.5) * 48, y: to.y - rh() * 16, vx: (rh() - 0.5) * 0.03, vy: -0.04 - rh() * 0.03, life: 700 + rh() * 300, r: 5 + rh() * 3 }); }
const spin = spill === 'drink' ? 120 : spill === 'omurice' ? 200 : 70;
const slowEase = (k) => (k < 0.12 ? k / 0.12 * 0.55 : 0.55 + 0.45 * (1 - (1 - (k - 0.12) / 0.88) * (1 - (k - 0.12) / 0.88)));
const dishAt = (tt) => { const k = slowEase(clampN((tt - tSlow) / cfg.slowMs, 0, 1)); return { x: lerp(cakeFrom.x, stopP.x, k), y: lerp(cakeFrom.y, stopP.y, k) - Math.sin(k * Math.PI) * 110 * KF, r: -25 + k * spin, s: 1.35 + k * 0.15 }; };
const bitCols = spill === 'drink' ? ['242,167,184', '90,58,46'] : spill === 'omurice' ? ['216,38,44', '246,200,74'] : ['255,250,240', '196,150,222']; // cream + the Traveler cake's lavender
const bits = []; const rb = tl.rng(57);
for (let tb = tSlow; tb < tWhite; tb += 16) if (rb() < 0.3) { const p = dishAt(tb); bits.push({ t: tb, x: p.x + (rb() - 0.5) * 32 * KF, y: p.y + (rb() - 0.5) * 20 * KF, vx: (rb() - 0.5) * 0.02, vy: (rb() - 0.5) * 0.018, r: (2 + rb() * 2.5) * KF, col: bitCols[rb() < 0.5 ? 0 : 1] }); }
m.hold(tCafe, tBack, (e, S) => { const tt = tCafe + e; S.screen.push({ draw: (g) => {
  const X = xf(g, tt); g.save(); X.apply(g); if (tt >= tSlow) g.filter = 'saturate(.55) contrast(1.12)';
  for (const h of hearts) { const a = tt - h.t; if (a < 0 || a > h.life) continue; const u = a / h.life; g.globalAlpha = 1 - u; g.fillStyle = '#ff6fa5'; heartPath(g, h.x + h.vx * a, h.y + h.vy * a, h.r); g.fill(); }
  g.globalAlpha = 1;
  if (tt >= tSlow) {
    for (const bt of bits) { const a = tt - bt.t; if (a < 0 || a > 2200) continue; g.fillStyle = 'rgba(' + bt.col + ',' + (1 - a / 2200) + ')'; g.beginPath(); g.arc(bt.x + bt.vx * a, bt.y + bt.vy * a, bt.r, 0, 7); g.fill(); }
    const d = dishAt(Math.min(tt, tWhite)); drawDish(g, spillArt, d.x, d.y, d.r, d.s, 1);
    // the sweat drop on the customer about to be hit
    const k = clampN((tt - tSlow) / 900, 0, 1); const sc = outBack(k); const hx = faceAt.x + 22 * KF + 6 * KF, hy = vSeat.y - vH * 0.86 - 26 * KF + 9 * KF + k * 6 * KF;
    if (sc > 0.01) { g.save(); g.translate(hx, hy); g.scale(sc * KF, sc * KF); const gr = g.createLinearGradient(0, -9, 0, 9); gr.addColorStop(0, '#bfe8ff'); gr.addColorStop(1, '#4aa8e8'); g.fillStyle = gr; g.strokeStyle = '#1d4c78'; g.lineWidth = 2; g.beginPath(); g.ellipse(0, 0, 6, 9, 0, 0, 7); g.fill(); g.stroke(); g.restore(); }
  }
  g.restore();
} }); });

// ── speed lines on the trip dash, vignette in slow motion ──
m.hold(tTrip, tSlow, (e, S) => S.screen.push({ draw: (g) => { const r = tl.rng(11); g.save(); g.lineCap = 'round';
  for (let i = 0; i < 26; i++) { const u0 = r(), off = r() * 2 - 1, len = 0.15 + r() * 0.3, sp = 0.0015 + r() * 0.0015, w = 1 + r() * 2.2; let u = (u0 + sp * e) % 1.6 - 0.3; const along = (u * 2 - 1) * 1300 * (g.W / SW), perp = off * 900 * (g.H / SH);
    const x0 = g.W / 2 + along, y0 = g.H / 2 + perp; g.strokeStyle = 'rgba(255,255,255,' + (0.35 * (0.4 + w / 4)) + ')'; g.lineWidth = w; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x0 + len * 900 * (g.W / SW), y0); g.stroke(); }
  g.restore(); } }));
m.hold(tSlow, tBack, (e, S) => S.screen.push({ draw: (g) => { const a = 0.9 * clampN(e / 600, 0, 1); const R = Math.hypot(g.W, g.H) / 2; const gr = g.createRadialGradient(g.W / 2, g.H / 2, R * 0.45 * 1.4, g.W / 2, g.H / 2, R * 1.1); gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,' + (0.85 * a) + ')'); g.fillStyle = gr; g.fillRect(0, 0, g.W, g.H); } }));

// ── the iris: closes on Blanche on the battlefield, opens on the cafe ──
const irisDraw = (g, cx, cy, r) => { g.save(); g.fillStyle = '#000'; g.beginPath(); g.rect(-20, -20, g.W + 40, g.H + 40); if (r > 0) { g.moveTo(cx + r, cy); g.arc(cx, cy, r, 0, 6.2832, true); } /* moveTo: no sliver from the rect corner to the circle */ g.fill('evenodd'); g.restore(); };
m.hold(tIrisC, tCafe, (e, S) => S.screen.push({ draw: (g) => { const f = tl.feet(TOK.c); const p = tl.toScreen(f.x, f.y - TOK.c.h * 0.5); const R = Math.hypot(g.W, g.H); const k = e / 520; irisDraw(g, p.x, p.y, lerp(R, 0, k * k)); } }));
m.hold(tCafe, tIrisO + 600, (e, S) => S.screen.push({ draw: (g) => { const tt = tCafe + e; const X = xf(g, tt); const p = X.P(CF.home.x, CF.home.y - 100); const R = Math.hypot(g.W, g.H); const k = tt < tIrisO ? 0 : clampN((tt - tIrisO) / 600, 0, 1); irisDraw(g, p.x, p.y, R * (1 - (1 - k) * (1 - k))); } }));

// ── the whiteout: white the instant before contact, holds, clears onto the battlefield ──
m.hold(tWhite, tHeal, (e, S) => { const tt = tWhite + e; const a = tt < tBack ? 1 : 1 - sine((tt - tBack) / 450); if (a > S.flash.a) S.flash = { a, c: '#ffffff' }; });

// ── back on the battlefield: the game's heal + cleanse beats on the party ──
m.undim(tBack, 1, 0.6);
const party = ['c'].concat(TG);
for (const k of party) { const f = tl.feet(TOK[k]); if (A.clips.heal) m.clip('heal', tHeal, { x: f.x, y: f.y, w: 546 * 0.55 * Ub, z: 40 }); }
play(tHeal, 'heal1', { v: 0.45 });
for (const k of party) { const f = tl.feet(TOK[k]); if (A.clips.cure) m.clip('cure', tCure, { x: f.x, y: f.y, w: 700 * 0.55 * 0.9 * Ub, z: 41 }); }
play(tCure, 'powerup', { v: 0.45 });
// the customer who took the dish wears it for a moment
if (cfg.cream !== false && vi >= 0) {
  const vk = 'q' + vi; const Uv = TOK[vk].h / 170; const sp = document.createElement('canvas'); sp.width = 90; sp.height = 80; const c = sp.getContext('2d'); const rs = tl.rng(91);
  if (spill === 'drink') { c.fillStyle = 'rgba(242,167,184,.85)'; for (let i = 0; i < 7; i++) { c.beginPath(); c.arc(45 + (rs() - 0.5) * 44, 30 + (rs() - 0.5) * 24, 8 + rs() * 5, 0, 7); c.fill(); } for (let i = 0; i < 5; i++) c.fillRect(22 + i * 11, 32, 5, 20 + rs() * 20); c.fillStyle = '#5b3a2e'; for (let i = 0; i < 4; i++) { c.beginPath(); c.arc(30 + i * 10, 26 + (rs() - 0.5) * 12, 4, 0, 7); c.fill(); } }
  else if (spill === 'omurice') { c.fillStyle = '#f6c84a'; for (let i = 0; i < 6; i++) { c.beginPath(); c.arc(45 + (rs() - 0.5) * 48, 30 + (rs() - 0.5) * 20, 9 + rs() * 5, 0, 7); c.fill(); } c.fillStyle = '#d8262c'; heartPath(c, 45, 30, 13); c.fill(); for (let i = 0; i < 3; i++) c.fillRect(34 + i * 10, 36, 4, 14 + rs() * 12); }
  else { c.fillStyle = '#fffaf0'; for (let i = 0; i < 9; i++) { c.beginPath(); c.arc(45 + (rs() - 0.5) * 48, 30 + (rs() - 0.5) * 24, 8 + rs() * 6, 0, 7); c.fill(); } for (let i = 0; i < 4; i++) c.fillRect(24 + i * 13, 32, 6, 18 + rs() * 16); c.fillStyle = '#c496de'; c.beginPath(); c.arc(50, 22, 6, 0, 7); c.fill(); }
  play(tCure, 'water3', { v: 0.3, rate: 1.2 });
  m.hold(tCure, tCure + 160 + 1500 + 400, (e, S) => { const hd = K.head(tl, vk); let s, a = 1, dy = 0; if (e < 160) s = lerp(0.2, 1, outBack(e / 160)); else if (e < 1660) s = 1; else { const u = (e - 1660) / 400; s = 1; a = 1 - u; dy = u * 26 * Uv; }
    S.world.push({ z: 60, draw: (g) => { g.save(); g.globalAlpha = a; g.translate(hd.x, hd.y + 20 * Uv + dy); g.scale(s * Uv, s * Uv); g.drawImage(sp, -45, -20, 90, 80); g.restore(); } }); });
}
// Blanche bounces twice, pleased with herself
m.hold(tHop, tHop + 520, (e, S) => { const q = S.tok.c; if (!q) return; const u = (e % 260) / 260; q.air += Math.sin(u * Math.PI) * 8 * Ub; });

await tl.run(T, { total, sfx, onStart: K.ready });
oni.fireDone();
