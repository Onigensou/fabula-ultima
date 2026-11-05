// Zero Power: Meteor Shower (Zarg) — approved "Zero Power overhaul" mockup, round 8
// (artifact 5FPS7VFAX7oqnTGy9KZAVC, user-locked cfg). Archer limit break after FFXIV's Bard.
//
// Beats (times from cfg, see zp-sig-zarg.js):
//   focus: everyone but Zarg + the targets fades out; the shipped full-body cut-in (Overdrive)
//   close: the board zooms in on Zarg (CSS transform on the board canvas + the timeline overlay
//          together — the LIVE board never moves the camera), he steps out
//   draw:  he leans back to aim up the diagonal; the Disgaea 5 vine bow (03308 parts) appears,
//          the string draws; a sharp lance of energy gathers flare and ribbons
//   loose: Shot1; the board streams away down-right with blur (the camera tracks the shot) and
//          the void fades in
//   void:  speed lines rush past the shot as it shrinks into the vanishing point
//   sky:   the dark tears open onto the storm, seen FROM ABOVE at a slant (top of the screen
//          nearest, bottom recedes): a plane texture projected row by row; it holds alone
//   glyph: a screen-filling glyph draws itself on that plane (rings with a pen, runes, the star,
//          Disgaea 5's rune wheel 03639_07); motes charge it; it flares
//   arrows: arrows fan out of the glyph down toward the lens; the last comes head-on (Shot1)
//   volley: the rain pours over the enemy side only (nothing on / behind the party); 24 Chain
//          ticks via oni.hit (BD shows each number, flinch and hurt on the REAL tokens, which
//          the shot never touches); silhouettes rise over the white
//   back:  white clears; venom lingers (poison); the party fades back in
// The script ends after the tail; the director then writes HP (gate = end).
if (!caster) { K.ready(); oni.fireDone(); return; }
const c = cfg;
const ELEM = {
  poison: { hue: 105, rgb: '140,240,90' }, fire: { hue: 18, rgb: '255,140,50' }, ice: { hue: 195, rgb: '140,220,255' },
  bolt: { hue: 52, rgb: '255,240,110' }, air: { hue: 150, rgb: '170,255,210' }, earth: { hue: 32, rgb: '210,160,90' },
  light: { hue: 48, rgb: '255,250,215' }, dark: { hue: 275, rgb: '170,110,255' },
};
const ALIAS = { lightning: 'bolt', thunder: 'bolt', wind: 'air', holy: 'light', shadow: 'dark' };
// The player's element pick: the planned strikes carry it on every client; the acting GM can also
// read the frozen action result. Poison is the signature look and the fallback (Preview Bench).
let elKey = 'poison';
try {
  const norm = (v) => { const s = String(v || '').trim().toLowerCase(); return ELEM[s] ? s : (ALIAS[s] || ''); };
  const st = (ctx.params.strikes || [])[0]; const o0 = st && st.outcomes && st.outcomes[0];
  let el = norm(o0 && o0.element);
  if (!el) { const ar = globalThis.FUCompanion?.api?.experimental?.battleDirector?.getActiveDirector?.()?.ctx?.actionResult; el = norm(ar?.preActivateVars?.element) || norm(ar?.damageType); }
  if (!el && c.element) el = norm(c.element);
  if (el) elKey = el;
} catch (e) {}
const EL = ELEM[elKey]; const RGB = EL.rgb; const POISON = elKey === 'poison';
const hueF = POISON ? '' : 'hue-rotate(' + Math.round(EL.hue - 105) + 'deg)';

const B = await boot(ZP.bystanders());
const { tl, T, m, TOK, TG, E } = B;
const dir = K.dirOf(TOK, 'c');
const ZH = (TOK.c && TOK.c.h) || 157;
const UZ = ZH / 157;                       // mockup px (Zarg ~157 px tall) -> world px
const DEG = Math.PI / 180;

// ── the schedule (ms) ──
const Z0 = 2150, D = Z0 + 700, C0 = D + 320, C1 = C0 + c.chargeMs, L = C1, V = L + c.trackMs, V2 = V + c.flightMs + 320;
const K0 = V2, K1 = K0 + 700, K2 = K1 + c.skyHold, G0 = K2, G1 = G0 + c.glyphMs, C2 = G1, C3 = C2 + c.glyphCharge + 780;
const A0 = C3, A1 = A0 + c.lensMs + 420, R0 = A1, R1 = R0 + c.rainMs, B0 = R1 + 500, END = B0 + 700 + 460 + 1200;

const SND = c.snd || {};
const S1 = (at, key, v, rate) => { const u = SND[key]; if (!u) return; ZP.once(m, at, () => { try { oni.sfx(u, { volume: Math.min(1, (v == null ? 0.55 : v) * 0.75), rate: rate || 1 }); } catch (e) {} }); };
const r01 = (r, a, b) => a + r() * (b - a);

// ── particles: world list (drawn on the overlay with the board) + screen list (drawn on the ZC canvas) ──
const PWL = [], PSL = [];
const addP = (list, p) => { list.push(Object.assign({ t: 0, life: 1000, vx: 0, vy: 0, drag: 1 }, p)); };
const stepP = (list, dt) => { for (let i = list.length - 1; i >= 0; i--) { const p = list[i]; p.t += dt; if (p.t >= p.life) { list.splice(i, 1); continue; } if (p.update) p.update(p, dt); else { const f = Math.pow(p.drag, dt / 16); p.vx *= f; p.vy *= f; p.x += p.vx * dt; p.y += p.vy * dt; } } };
const drawP = (g, list) => { for (const p of list) { g.save(); g.globalCompositeOperation = p.comp || 'lighter'; try { p.draw(g, p, p.t / p.life); } catch (e) {} g.restore(); } };
let lastE = null;
m.hold(0, END, (e, S) => { const dt = lastE == null ? 16 : Math.max(0, Math.min(50, e - lastE)); lastE = e; stepP(PWL, dt); stepP(PSL, dt); if (PWL.length) S.world.push({ z: 60, draw: (g) => drawP(g, PWL) }); });

// ── focus, dim, cut-in ──
ZP.focus(m, TOK, 0, 350, B0 + 700, 500);
m.hold(0, END, (e, S) => { const d = e < R0 ? 0.55 * Math.min(1, e / 200) : e < B0 ? 0.35 : 0; S.dim = Math.max(S.dim, d); });
ZP.cutin(tl, m, 0, 'cut');
S1(0, 'overdrive', 0.9);

// ── Zarg: step out, lean back to aim, recoil on the loose, back at the volley ──
const OUT = dir * 30 * UZ;
K.path(m, E, 'c', [[Z0, 0, 0], [Z0 + 380, OUT, 0, 'ioQ'], [R0, OUT, 0], [R0 + 1, 0, 0]]);
const tiltAt = (t) => t < D ? 0 : t >= R0 ? 0 : -dir * c.tilt * DEG * E.outC(Math.min(1, (t - D) / 320));
const recoilAt = (t) => t < L || t >= R0 ? 0 : -dir * 8 * UZ * E.outQ(Math.min(1, (t - L) / 160));
m.hold(D, R0, (e, S) => { const q = S.tok.c; if (!q) return; const t = e + D; q.rot += tiltAt(t); q.dx += recoilAt(t); });
// a point fixed to his body (lx toward his front, ly up), turned with the lean about his feet
const f0 = tl.feet(TOK.c);
const bodyPt = (t, lx, ly) => { const r = tiltAt(t); const fx = f0.x + (t >= Z0 && t < R0 ? OUT * E.ioQ(Math.min(1, (t - Z0) / 380)) : 0) + recoilAt(t), fy = f0.y; return { x: fx + lx * Math.cos(r) - ly * Math.sin(r), y: fy + lx * Math.sin(r) + ly * Math.cos(r) }; };
const aimAt = (t) => { const r = tiltAt(t); return { x: dir * Math.cos(r), y: dir * Math.sin(r) }; };
const gripAt = (t) => bodyPt(t, dir * 34 * UZ, -ZH * 0.6);
const tipAt = (t) => { const g = gripAt(t), a = aimAt(t); return { x: g.x + a.x * 22 * UZ, y: g.y + a.y * 22 * UZ }; };

// ── the vine bow (Disgaea 5 03308 limb _00 + limb _01 + grip _02), a D shape, tips swept back toward him ──
const BOWK = c.bowSize * ZH / 210;
function drawBow(g, t, alpha, pull, wob) {
  const up = tl.IMG.bowU, lo = tl.IMG.bowL, gr = tl.IMG.bowG; if (!up || !lo || !gr || alpha <= 0) return;
  const iu = ZP.limbInfo(up), il = ZP.limbInfo(lo); const gh = (gr.naturalHeight || gr.height) * 0.42;
  const mu = iu.tip.x < iu.joint.x ? -1 : 1, ml = il.tip.x < il.joint.x ? -1 : 1;
  const tipU = { x: mu * (iu.tip.x - iu.joint.x), y: -gh + (iu.tip.y - iu.joint.y) }, tipL = { x: ml * (il.tip.x - il.joint.x), y: gh - (il.tip.y - il.joint.y) };
  const gp = gripAt(t);
  g.save(); g.translate(gp.x, gp.y); g.rotate(tiltAt(t)); g.scale(-dir * BOWK, BOWK); g.globalAlpha = alpha;
  const nockX = Math.max(tipU.x, tipL.x) * 0.55 + pull * 120 + Math.sin(wob * 40) * wob * 18;
  g.strokeStyle = 'rgba(235,255,225,.95)'; g.lineWidth = 2.2; g.shadowColor = 'rgb(' + RGB + ')'; g.shadowBlur = 8;
  g.beginPath(); g.moveTo(tipU.x, tipU.y); g.lineTo(nockX, (tipU.y + tipL.y) / 2); g.lineTo(tipL.x, tipL.y); g.stroke(); g.shadowBlur = 0;
  g.save(); g.translate(0, -gh); g.scale(mu, 1); g.drawImage(up, -iu.joint.x, -iu.joint.y); g.restore();
  g.save(); g.translate(0, gh); g.scale(ml, -1); g.drawImage(lo, -il.joint.x, -il.joint.y); g.restore();
  g.drawImage(gr, -(gr.naturalWidth || gr.width) / 2, -(gr.naturalHeight || gr.height) / 2);
  g.restore();
}
const pullAt = (t) => t < C0 ? 0 : t < L ? E.outC(Math.min(1, (t - C0) / 600)) : 0;
const wobAt = (t) => t < L ? 0 : Math.max(0, 1 - (t - L) / 450);
m.hold(D, V + 200, (e, S) => { const t = e + D; const a = Math.min(1, e / 320); S.world.push({ z: 58, draw: (g) => drawBow(g, t, a, pullAt(t), wobAt(t)) }); });
m.clip('ring', D, { x: gripAt(D).x, y: gripAt(D).y, w: 82 * 0.5 * 0.55 * UZ, z: 59, add: true, filter: K.tintF(EL.hue, 3, 1.2) });
S1(D, 'magic4', 0.3, 1.3);

// ── the lance: white-hot core, element glow, barbed tip; it sheds sparks as it moves ──
function lanceCanvas() {
  const Ln = 230, Tn = 46, pad = 18, hx = Ln - 8 + pad, hy = Tn / 2 + pad; const cv = document.createElement('canvas'); cv.width = (Ln + pad * 2) * 2; cv.height = (Tn + pad * 2) * 2; const x = cv.getContext('2d'); x.scale(2, 2);
  x.shadowColor = 'rgb(' + RGB + ')'; x.shadowBlur = 10;
  let gr = x.createLinearGradient(pad, 0, hx, 0); gr.addColorStop(0, 'rgba(' + RGB + ',0)'); gr.addColorStop(0.7, 'rgba(' + RGB + ',.45)'); gr.addColorStop(1, 'rgba(' + RGB + ',.85)');
  x.fillStyle = gr; x.beginPath(); x.moveTo(pad, hy); x.quadraticCurveTo(pad + (hx - pad) * 0.6, hy - 15, hx - 14, hy - 11); x.lineTo(hx + 6, hy); x.lineTo(hx - 14, hy + 11); x.quadraticCurveTo(pad + (hx - pad) * 0.6, hy + 15, pad, hy); x.fill();
  gr = x.createLinearGradient(pad + (hx - pad) * 0.25, 0, hx, 0); gr.addColorStop(0, 'rgba(255,255,240,0)'); gr.addColorStop(1, 'rgba(255,255,245,1)');
  x.shadowColor = '#fff'; x.shadowBlur = 3; x.fillStyle = gr; x.beginPath(); x.moveTo(pad + (hx - pad) * 0.25, hy); x.lineTo(hx - 18, hy - 4); x.lineTo(hx + 4, hy); x.lineTo(hx - 18, hy + 4); x.fill();
  x.shadowBlur = 0; x.strokeStyle = 'rgba(' + RGB + ',.95)'; x.lineWidth = 2;
  for (const s of [-1, 1]) { x.beginPath(); x.moveTo(hx - 6, hy + s * 3); x.lineTo(hx - 30, hy + s * 13); x.stroke(); x.beginPath(); x.moveTo(hx - 28, hy + s * 4); x.lineTo(hx - 50, hy + s * 11); x.stroke(); }
  return { cv, hx, hy, w: Ln + pad * 2, h: Tn + pad * 2 };
}
const LC = lanceCanvas();
const drawLance = (g, x, y, ang, s, a) => { if (!(s > 0) || a === 0) return; g.save(); g.translate(x, y); g.rotate(ang); g.scale(s, s); if (a != null) g.globalAlpha = a; g.drawImage(LC.cv, -LC.hx, -LC.hy, LC.w, LC.h); g.restore(); };
const sparkDraw = (g, p, t) => { ZP.glow(g, p.x, p.y, p.r * 3, RGB, (1 - t) * 0.9); g.fillStyle = 'rgba(255,255,235,' + (1 - t) + ')'; g.beginPath(); g.arc(p.x, p.y, p.r * 0.6, 0, 6.2832); g.fill(); };
function sparks(list, x, y, ang, k, moved, u) {
  const bx = -Math.cos(ang), by = -Math.sin(ang); const n = moved > 2 ? 3 : (Math.random() < 0.35 ? 1 : 0);
  for (let i = 0; i < n; i++) { const back = r01(Math.random, 10, 90) * k * u; addP(list, { x: x + bx * back + r01(Math.random, -4, 4) * u, y: y + by * back + r01(Math.random, -4, 4) * u, vx: (bx * r01(Math.random, 0.05, 0.25) + r01(Math.random, -0.07, 0.07)) * u, vy: (by * r01(Math.random, 0.05, 0.25) + r01(Math.random, -0.07, 0.07)) * u, drag: 0.96, life: r01(Math.random, 260, 560), r: r01(Math.random, 1.5, 3.5) * Math.max(0.6, k) * u, draw: sparkDraw }); }
}

// draw: the lance grows on the bow over the charge; flare at its tip; ribbons spiral in
const angAt = (t) => { const a = aimAt(t); return Math.atan2(a.y, a.x); };
let wPrev = null;
m.hold(C0, L, (e, S) => { const t = e + C0; const p = tipAt(t), k = 0.05 + 0.95 * E.outC(Math.min(1, e / c.chargeMs)); const s = 0.58 * UZ * k;
  const moved = wPrev ? Math.hypot(p.x - wPrev.x, p.y - wPrev.y) : 0; wPrev = p; sparks(PWL, p.x, p.y, angAt(t), 0.58 * k, moved, UZ);
  S.world.push({ z: 61, draw: (g) => drawLance(g, p.x, p.y, angAt(t), s) }); });
m.hold(C0, C0 + c.chargeMs + 600, (e, S) => { const t = e + C0; const p0 = tipAt(Math.min(t, L - 1)); const a = aimAt(t); const p = { x: p0.x + a.x * 12 * UZ, y: p0.y + a.y * 12 * UZ };
  const k = Math.min(1, e / c.chargeMs), fl = 1 + Math.sin(e / 40) * 0.08, fade = t > L ? Math.max(0, 1 - (t - L) / 200) : 1; if (fade <= 0) return;
  S.world.push({ z: 62, draw: (g) => { g.save(); g.globalCompositeOperation = 'lighter'; g.globalAlpha = fade; ZP.glow(g, p.x, p.y, (30 + 90 * k) * fl * UZ, RGB, 0.7); g.globalAlpha = k * fade; g.fillStyle = 'rgba(' + RGB + ',.6)'; g.fillRect(p.x - 260 * k * UZ, p.y - 1.5 * UZ, 520 * k * UZ, 3 * UZ); g.fillStyle = 'rgba(255,255,240,.9)'; g.fillRect(p.x - 140 * k * UZ, p.y - 0.8 * UZ, 280 * k * UZ, 1.6 * UZ); g.restore(); } }); });
{ let acc = 0, lastR = null, n = 0;
  m.hold(C0, C1, (e) => { const dt = lastR == null ? 0 : e - lastR; lastR = e; acc += dt; while (acc >= 40) { acc -= 40; const t = e + C0; const h = tipAt(t); const a0 = Math.random() * 6.28, rr = r01(Math.random, 80, 150) * UZ; const odd = (n++) % 2;
    addP(PWL, { x: 0, y: 0, life: 700, trail: [], update: (p) => { const u = p.t / p.life; const an = a0 + u * 5; const r = rr * (1 - u); p.x = h.x + Math.cos(an) * r; p.y = h.y + Math.sin(an) * r * 0.55; p.trail.push([p.x, p.y]); if (p.trail.length > 10) p.trail.shift(); },
      draw: (g, p, tt) => { g.strokeStyle = 'rgba(' + (odd ? RGB : '255,255,230') + ',' + (0.7 * (1 - tt)) + ')'; g.lineWidth = 2 * UZ; g.beginPath(); p.trail.forEach((q, i) => (i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1]))); g.stroke(); } }); } }); }
S1(C0, 'wind4', 0.45); S1(C0, 'magic4', 0.4, 0.8);
m.shake(C1, 300, 4); m.flash(C1, 30, 200, 'rgb(' + RGB + ')', 0.2);

// ── screen pieces: the view rect (before any CSS transform), the board + overlay zoom, the ZC canvas ──
const view = canvas.app.view;
const VR = view.getBoundingClientRect();
const VW = VR.width, VH = VR.height, Q = VH / 788;
const VP = { x: VW / 2, y: VH * 0.419 };
const prevStyle = { transform: view.style.transform, transformOrigin: view.style.transformOrigin, filter: view.style.filter };
const overlayEl = () => { const l = document.querySelectorAll('canvas.oni-timeline-overlay'); return l.length ? l[l.length - 1] : null; };
let ovPrev = null;
function setXform(z, tx, ty, blur) {
  const tf = (z === 1 && !tx && !ty) ? '' : 'translate(' + tx.toFixed(1) + 'px,' + ty.toFixed(1) + 'px) scale(' + z.toFixed(4) + ')'; const fl = blur > 0.05 ? 'blur(' + blur.toFixed(1) + 'px)' : '';
  for (const el of [view, overlayEl()]) { if (!el) continue; if (el !== view && !ovPrev) ovPrev = { transform: el.style.transform, transformOrigin: el.style.transformOrigin, filter: el.style.filter }; el.style.transformOrigin = '0 0'; el.style.transform = tf; el.style.filter = fl; }
}
function clearXform() {
  try { view.style.transform = prevStyle.transform || ''; view.style.transformOrigin = prevStyle.transformOrigin || ''; view.style.filter = prevStyle.filter || ''; } catch (e) {}
  const o = overlayEl(); if (o && ovPrev) { try { o.style.transform = ovPrev.transform || ''; o.style.transformOrigin = ovPrev.transformOrigin || ''; o.style.filter = ovPrev.filter || ''; } catch (e) {} }
}
// the close-up: zoom 1.7 on a point ahead of and above him (the mockup's camera focus), log-space blend over 700 ms
const ZOOM = 1.7, run = 900 * UZ;
const focusW = { x: f0.x + dir * 110 * UZ + OUT, y: f0.y - 150 * UZ };
let XF = { z: 1, tx: 0, ty: 0 };
m.hold(Z0, V, (e, S) => {
  const t = e + Z0; const sc = canvas.stage.scale.x || 1;
  const b = E.sine(Math.min(1, e / 700)); const z = Math.exp(Math.log(ZOOM) * b);
  const F = tl.toScreen(focusW.x, focusW.y); const fx = VW / 2 + (F.x - VW / 2) * b, fy = VH / 2 + (F.y - VH / 2) * b;
  let tx = VW / 2 - fx * z, ty = VH / 2 - fy * z, blur = 0;
  if (t >= L) { const k = E.inQ(Math.min(1, (t - L) / c.trackMs)); const a = aimAt(L); tx -= a.x * run * sc * z * k; ty -= a.y * run * sc * z * k; blur = 7 * k; }
  XF = { z, tx, ty }; setXform(z, tx, ty, blur);
});
ZP.once(m, V, () => { clearXform(); XF = { z: 1, tx: 0, ty: 0 }; });

let ZC = null, ZX = null, zdpr = 1;
function zcMake() { if (ZC) return; ZC = document.createElement('canvas'); ZC.className = 'oni-zp-zarg-screen'; zdpr = Math.min(2, window.devicePixelRatio || 1); ZC.width = Math.round(VW * zdpr); ZC.height = Math.round(VH * zdpr);
  ZC.style.cssText = 'position:fixed; pointer-events:none; z-index:70; left:' + VR.left + 'px; top:' + VR.top + 'px; width:' + VW + 'px; height:' + VH + 'px;'; document.body.appendChild(ZC); ZX = ZC.getContext('2d'); }
function zcKill() { if (ZC) { try { ZC.remove(); } catch (e) {} } ZC = null; ZX = null; }
let ZQ = [];                      // this frame's screen draws: { z, draw(g) }
const zq = (z, draw) => ZQ.push({ z, draw });
// screen flashes on the ZC phases (the overlay flash sits under the ZC canvas)
const ZF = [];
const zflash = (at, inMs, outMs, color, alpha) => ZF.push({ at, inMs, outMs, color, alpha });

// ── loose: Shot1, the lance leaves on the screen layer, the field streams away, the void fades in ──
S1(L, 'shot1', 0.9); S1(L, 'wind7', 0.45, 1.4); m.flash(L, 20, 150, '#ffffff', 0.5); m.shake(L, 200, 6);
const VOIDC = (g, a) => { const R = Math.hypot(VW, VH); const gr = g.createRadialGradient(VP.x, VP.y, 0, VP.x, VP.y, R); gr.addColorStop(0, 'rgb(18,30,16)'); gr.addColorStop(0.45, '#07080a'); gr.addColorStop(1, '#000'); g.save(); g.globalAlpha = a; g.fillStyle = gr; g.fillRect(-20, -20, VW + 40, VH + 40); g.restore(); };
const loosePt = () => { const a = aimAt(L); return { x: VP.x - a.x * 220 * Q, y: VP.y - a.y * 220 * Q }; };
let sPrev = null;
m.hold(L, V, (e) => { const t = e + L; const k = e / c.trackMs; const sc = canvas.stage.scale.x || 1;
  const tw = tipAt(L - 1); const sp = tl.toScreen(tw.x, tw.y); const s0 = { x: XF.tx + sp.x * XF.z, y: XF.ty + sp.y * XF.z };
  const T1 = loosePt(); const a = E.outC(Math.min(1, k / 0.35)); const x = s0.x + (T1.x - s0.x) * a + Math.sin(k * 40) * 2, y = s0.y + (T1.y - s0.y) * a;
  const k0 = 0.58 * UZ * sc * XF.z / 0.8 / Q; const s = (k0 + (1 - k0) * a) * 0.8 * Q; const ang = angAt(L);
  const moved = sPrev ? Math.hypot(x - sPrev.x, y - sPrev.y) : 0; sPrev = { x, y }; sparks(PSL, x, y, ang, s / Q, moved, Q);
  // the board's uncovered edges (it slid down-right) + the void rising over it
  const bx0 = XF.tx, by0 = XF.ty, bx1 = XF.tx + VW * XF.z, by1 = XF.ty + VH * XF.z; const va = Math.max(0, Math.min(1, (k - 0.3) / 0.45));
  zq(0, (g) => { g.fillStyle = '#030403'; if (by0 > 0) g.fillRect(-20, -20, VW + 40, by0 + 20); if (bx0 > 0) g.fillRect(-20, -20, bx0 + 20, VH + 40); if (bx1 < VW) g.fillRect(bx1, -20, VW - bx1 + 20, VH + 40); if (by1 < VH) g.fillRect(-20, by1, VW + 40, VH - by1 + 20); });
  zq(1, (g) => VOIDC(g, va));
  zq(30, (g) => parallelLines(g, t, Math.atan2(-aimAt(L).y, -aimAt(L).x), 0.45, 34));
  zq(40, (g) => drawLance(g, x, y, ang, s)); });
// speed lines (the mockup's: parallel when tracking, radial into the vanishing point in the void)
const LINES = ZP.swarm(tl, 40, 71, (i, r) => ({ u0: r(), off: r() * 2 - 1, len: 0.15 + r() * 0.3, sp: 0.0015 + r() * 0.0015, w: 1 + r() * 2.2 }));
function lineU(l, t) { const span = 1.6; let u = (l.u0 + l.sp * t) % span; return u - 0.3; }
function parallelLines(g, t, angle, alpha, n) {
  const ca = Math.cos(angle), sa = Math.sin(angle), nx = -sa, ny = ca;
  g.save(); g.lineCap = 'round'; for (let i = 0; i < n; i++) { const l = LINES[i]; const u = lineU(l, t); g.strokeStyle = 'rgba(' + RGB + ',' + (alpha * (0.4 + l.w / 4)) + ')'; g.lineWidth = l.w * Q;
    const along = (u * 2 - 1) * 1300 * Q, perp = l.off * 900 * Q; const x0 = VW / 2 + ca * along + nx * perp, y0 = VH / 2 + sa * along + ny * perp; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x0 + ca * l.len * 900 * Q, y0 + sa * l.len * 900 * Q); g.stroke(); } g.restore();
}
function radialLines(g, t, alpha, n) {
  g.save(); g.lineCap = 'round'; for (let i = 0; i < n; i++) { const l = LINES[i]; const u = lineU(l, t); const a = l.off * Math.PI; const r0 = u * 1100 * Q, r1 = r0 + l.len * 700 * Q;
    g.strokeStyle = 'rgba(' + RGB + ',' + (alpha * (0.4 + l.w / 4)) + ')'; g.lineWidth = l.w * Q; g.beginPath(); g.moveTo(VP.x + Math.cos(a) * r0, VP.y + Math.sin(a) * r0); g.lineTo(VP.x + Math.cos(a) * r1, VP.y + Math.sin(a) * r1); g.stroke(); } g.restore();
}

// ── void: radial speed lines, the lance shrinks into the vanishing point ──
S1(V, 'wind7', 0.5, 1.2);
m.hold(V, K1, (e) => { const t = e + V; if (t < K0) zq(1, (g) => VOIDC(g, 1)); if (t < V + c.flightMs) zq(30, (g) => radialLines(g, t, 0.55, 40)); });
m.hold(V, V + c.flightMs, (e) => { const k0 = e / c.flightMs; const k = k0 * k0 * (3 - 2 * k0); const from = loosePt(); const x = from.x + (VP.x - from.x) * k + Math.sin(k * 30) * 3 * (1 - k) * Q, y = from.y + (VP.y - from.y) * k; const s = (1 + (0.04 - 1) * E.inQ(k)) * 0.8 * Q; const a = k0 > 0.9 ? (1 - k0) / 0.1 : 1;
  const moved = sPrev ? Math.hypot(x - sPrev.x, y - sPrev.y) : 0; sPrev = { x, y }; if (a > 0.3) sparks(PSL, x, y, angAt(L), s / Q, moved, Q);
  zq(40, (g) => drawLance(g, x, y, angAt(L), s, a)); });
m.hold(V + c.flightMs, V + c.flightMs + 500, (e) => { const k = e / 500; zq(41, (g) => { g.save(); g.globalCompositeOperation = 'lighter'; ZP.glow(g, VP.x, VP.y, (10 + 40 * Math.sin(k * Math.PI)) * Q, '255,255,240', 1 - k); g.restore(); }); });

// ── sky: a plane seen from above. Plane units = mockup px; u across, v up from the VP line. ──
// Projection (perspective P, plane turned about the VP line so its upper part comes toward us):
//   screen y = VPy - v cos(a) P / (P - v sin(a)),   x = VPx + u P / (P - v sin(a))
const PT_U = 1700, PT_UP = 420, PT_DN = 1300, PT_R = 0.5;            // texture extents + resolution
let PT = null, PX = null, SKYB = null, CLOUD = null, SG = null, SGX = null, RUNE = null;
function skyInit() {
  if (PT) return;
  PT = document.createElement('canvas'); PT.width = Math.round(PT_U * 2 * PT_R); PT.height = Math.round((PT_UP + PT_DN) * PT_R); PX = PT.getContext('2d');
  const img = tl.IMG.sky; if (img) { const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height; SKYB = document.createElement('canvas'); SKYB.width = 1200; SKYB.height = Math.round(1200 * ih / iw); const x = SKYB.getContext('2d');
    x.filter = (POISON ? 'hue-rotate(110deg) saturate(.9) brightness(.8)' : 'hue-rotate(' + Math.round(EL.hue - 10) + 'deg) saturate(.8) brightness(.85)') + ' blur(2px)'; x.drawImage(img, 0, 0, SKYB.width, SKYB.height); }
  CLOUD = document.createElement('canvas'); CLOUD.width = 700; CLOUD.height = 450; const cx = CLOUD.getContext('2d'); const r = tl.rng(97);
  for (let i = 0; i < 46; i++) { const x0 = r() * 700, y0 = r() * 450, rr = 30 + r() * 80; const gr = cx.createRadialGradient(x0, y0, 0, x0, y0, rr); gr.addColorStop(0, 'rgba(' + (POISON ? '190,230,170' : '230,235,240') + ',' + (0.05 + r() * 0.09) + ')'); gr.addColorStop(1, 'rgba(0,0,0,0)'); cx.fillStyle = gr; cx.beginPath(); cx.ellipse(x0, y0, rr * 1.8, rr * 0.7, (r() - 0.5) * 0.6, 0, 6.2832); cx.fill(); }
  SG = document.createElement('canvas'); SG.width = SG.height = 1440; SGX = SG.getContext('2d');
  if (tl.IMG.rune) RUNE = ZP.glowAlpha(tl.IMG.rune);
}
// the glyph state
const GS = { rot: 0, prog: 0, pulse: 0, chg: 0, heads: ZP.swarm(tl, 72, 5, (i, r) => ({ a: i / 72 * 6.283, r: 150 + r() * 150, on: 0 })) };
const segG = (a, b) => Math.max(0, Math.min(1, (GS.prog - a) / (b - a)));
function drawSigil() {
  const x = SGX; x.setTransform(2, 0, 0, 2, 0, 0); x.clearRect(0, 0, 720, 720); x.save(); x.translate(360, 360);
  const k = 1 + GS.pulse * 0.06, col = 'rgba(' + RGB + ','; x.shadowColor = 'rgb(' + RGB + ')'; x.shadowBlur = 18 + GS.chg * 26;
  const pen = (px, py) => { x.save(); x.shadowBlur = 0; const g = x.createRadialGradient(px, py, 0, px, py, 22); g.addColorStop(0, 'rgba(255,255,240,1)'); g.addColorStop(1, 'rgba(' + RGB + ',0)'); x.fillStyle = g; x.beginPath(); x.arc(px, py, 22, 0, 6.2832); x.fill(); x.restore(); };
  const partial = (len, p, build) => { if (p <= 0) return; x.setLineDash([len * p, len]); x.beginPath(); build(); x.stroke(); x.setLineDash([]); };
  if (GS.chg > 0) { const g = x.createRadialGradient(0, 0, 0, 0, 0, 340); g.addColorStop(0, 'rgba(' + RGB + ',' + (0.35 * GS.chg) + ')'); g.addColorStop(1, 'rgba(' + RGB + ',0)'); x.fillStyle = g; x.beginPath(); x.arc(0, 0, 340, 0, 6.2832); x.fill(); }
  const RINGS = [[330, 4, []], [300, 2, [14, 10]], [220, 3, []], [150, 2, [4, 8]]];
  RINGS.forEach((rg, i) => { const p = segG(i * 0.09, i * 0.09 + 0.3); if (p <= 0) return; const sgn = i % 2 ? -1 : 1;
    const a0 = -Math.PI / 2 + sgn * GS.rot * (i + 1) * 0.5, a1 = a0 + Math.PI * 2 * p * sgn;
    x.strokeStyle = col + (0.8 + GS.pulse * 0.2) + ')'; x.lineWidth = rg[1] + GS.chg * 1.5; x.setLineDash(rg[2]); x.beginPath(); x.arc(0, 0, rg[0] * k, a0, a1, i % 2 === 1); x.stroke(); x.setLineDash([]);
    if (p < 1) pen(Math.cos(a1) * rg[0] * k, Math.sin(a1) * rg[0] * k); });
  const ps = segG(0.42, 0.62);
  x.save(); x.rotate(GS.rot); for (let i = 0; i < 12; i++) { x.rotate(6.283 / 12); if (i / 12 >= ps) continue; x.strokeStyle = col + '.9)'; x.lineWidth = 2; x.beginPath(); x.moveTo(0, -300 * k); x.lineTo(10, -270 * k); x.lineTo(0, -240 * k); x.lineTo(-10, -270 * k); x.closePath(); x.stroke(); x.beginPath(); x.moveTo(-16, -315 * k); x.lineTo(16, -315 * k); x.stroke(); } x.restore();
  const ph = segG(0.58, 0.8); x.save(); x.rotate(-GS.rot * 1.6); x.strokeStyle = col + '.85)'; x.lineWidth = 3;
  for (let i = 0; i < 2; i++) partial(3 * 220 * 1.732 * k, ph, () => { for (let j = 0; j <= 3; j++) { const a = j / 3 * 6.283 + i * 3.1416 / 3; const px = Math.cos(a) * 220 * k, py = Math.sin(a) * 220 * k; if (j) x.lineTo(px, py); else x.moveTo(px, py); } });
  if (ph > 0 && ph < 1) { const a = ph * 6.283; pen(Math.cos(a) * 220 * k, Math.sin(a) * 220 * k); } x.restore();
  const pr = segG(0.86, 1); if (RUNE && pr > 0) { x.save(); x.shadowBlur = 0; x.globalAlpha = pr * (0.75 + GS.chg * 0.25); x.rotate(-GS.rot * 2.2); if (hueF) x.filter = hueF; const ob = 1 + 2.6 * Math.pow(pr - 1, 3) + 1.6 * Math.pow(pr - 1, 2); const s = 260 * (0.6 + 0.4 * ob) * k; x.drawImage(RUNE, -s / 2, -s / 2, s, s); x.restore(); }
  for (const h of GS.heads) { if (h.on <= 0.01) continue; const hx = Math.cos(h.a + GS.rot * 0.5) * h.r * k, hy = Math.sin(h.a + GS.rot * 0.5) * h.r * k; x.fillStyle = 'rgba(255,250,235,' + h.on + ')'; x.beginPath(); x.moveTo(hx, hy + 10); x.lineTo(hx - 5, hy - 6); x.lineTo(hx + 5, hy - 6); x.fill(); }
  x.restore();
}
// the plane texture: base gradient, the painting turning about its storm eye (717, 263 of the painting at W 1682),
// the nearer cloud layer (slides against the tilt), the glyph
let skyA = c.skyAngle;
function paintPlane(t, withGlyph) {
  const x = PX; const W2 = PT.width, H2 = PT.height; x.setTransform(1, 0, 0, 1, 0, 0);
  const oy = PT_UP * PT_R, ox = PT_U * PT_R;                          // texture px of plane (0, 0)
  const bg = x.createRadialGradient(ox, oy + 300 * PT_R, 0, ox, oy, 2200 * PT_R); bg.addColorStop(0, 'rgb(40,60,34)'); bg.addColorStop(0.6, 'rgb(10,16,12)'); bg.addColorStop(1, '#050807'); x.fillStyle = bg; x.fillRect(0, 0, W2, H2);
  // the mockup stretched the painting to 1682 x 788, x4.4, with the storm eye (717, 263) on the plane's origin
  if (SKYB) { const s = 4.4 * PT_R; x.save(); x.translate(ox, oy); x.rotate((t - K0) / 1000 * 2.2 * DEG); x.drawImage(SKYB, -717 * s, -263 * s, 1682 * s, 788 * s); x.restore(); }
  const drift = (t - K0) / 1000 * 14, par = (skyA - c.skyAngle) * 14; const CW = 1400 * 2.6 * PT_R, CH = 900 * 2.6 * PT_R;
  x.save(); x.globalAlpha = 1; x.drawImage(CLOUD, ox - CW / 2 + drift * PT_R, oy - CH * 0.35 + (Math.sin((t - K0) / 1000 * 0.7) * 10 + par) * PT_R, CW, CH); x.restore();
  if (withGlyph) { drawSigil(); const gw = 720 * c.glyphScale * PT_R; x.drawImage(SG, ox - gw / 2, oy - gw / 2, gw, gw); }
}
// project the plane onto the screen, row by row
function projectPlane(g, t) {
  const a = (skyA + Math.sin((t - K0) / 1000 * 0.9) * 1.2) * DEG, roll = Math.sin((t - K0) / 1000 * 0.5) * 1.5 * DEG; const P = 900, ca = Math.cos(a), sa = Math.sin(a);
  g.save(); g.translate(VP.x, VP.y); g.rotate(roll); g.translate(-VP.x, -VP.y);
  g.fillStyle = '#050807'; g.fillRect(-40, -40, VW + 80, VH + 80);
  const step = 3; const vOf = (y) => { const s = (VP.y - y) / Q; return s * P / (ca * P + s * sa); };
  for (let y = -30; y < VH + 30; y += step) {
    const v1 = vOf(y), v2 = vOf(y + step); const d1 = P - v1 * sa; if (!(d1 > 20) || !(P - v2 * sa > 20)) continue;
    if (v1 > PT_UP || v2 < -PT_DN) continue;
    const k = P / d1; const ty1 = (PT_UP - Math.min(PT_UP, v1)) * PT_R, ty2 = (PT_UP - Math.max(-PT_DN, v2)) * PT_R; const sh = Math.max(0.5, ty2 - ty1);
    const dw = PT_U * 2 * k * Q; g.drawImage(PT, 0, ty1, PT.width, sh, VP.x - dw / 2, y, dw, step + 0.6);
  }
  g.restore();
}
S1(K0, 'magic3', 0.5); S1(K0, 'wind7', 0.35, 0.7); zflash(K0, 20, 300, 'rgb(' + RGB + ')', 0.45); m.shake(K0, 300, 6);
m.hold(K0, A1 + 1, (e) => { const t = e + K0; skyInit(); if (t < K2) skyA = c.skyAngle + 12 - 12 * (t < K1 ? 0 : E.sine(Math.min(1, (t - K1) / c.skyHold))); else skyA = c.skyAngle;
  paintPlane(t, t >= G0); zq(2, (g) => projectPlane(g, t));
  if (t < K1) { const r = (t - K0) / 700; const R = E.outC(Math.min(1, r)) * 1900 * Q; zq(3, (g) => { const gr = g.createRadialGradient(VP.x, VP.y, Math.max(0, R), VP.x, VP.y, R + 40 * Q); gr.addColorStop(0, 'rgba(3,4,3,0)'); gr.addColorStop(1, 'rgba(3,4,3,1)'); g.save(); g.beginPath(); g.rect(-20, -20, VW + 40, VH + 40); g.arc(VP.x, VP.y, Math.max(0.1, R), 0, 6.2832, true); g.clip('evenodd'); g.fillStyle = gr; g.fillRect(-20, -20, VW + 40, VH + 40); g.restore(); }); } });

// ── glyph: it draws itself, then motes charge it, then it pulses ──
let gLast = null;
m.hold(G0, A1 + 1, (e) => { const t = e + G0; const dt = gLast == null ? 16 : Math.max(0, t - gLast); gLast = t;
  GS.rot = (t - G0) * 0.00024; GS.prog = Math.min(1, (t - G0) / c.glyphMs); GS.pulse *= Math.pow(0.93, dt / 16); for (const h of GS.heads) h.on *= Math.pow(0.985, dt / 16);
  GS.chg = t < C2 ? 0 : Math.min(1, (t - C2) / c.glyphCharge); });
S1(G0, 'saint4', 0.4); if (POISON) S1(G0, 'cpoison', 0.3);
for (let q = 1; q <= 5; q++) S1(G0 + c.glyphMs * q / 6, 'tick', 0.18, 1.4 + q * 0.08);
S1(G1, 'saint5', 0.35); ZP.once(m, G1, () => { GS.pulse = 1; });
S1(C2, 'magic4', 0.45, 0.7); S1(C2 + 300, 'powerup', 0.35, 0.8);
{ let acc = 0, last = null;
  m.hold(C2, C2 + c.glyphCharge, (e) => { const dt = last == null ? 0 : e - last; last = e; acc += dt; const k = e / c.glyphCharge;
    while (acc >= 30) { acc -= 30; for (let j = 0; j < 3 + Math.round(k * 4); j++) chargeMote(r01(Math.random, 420, 900)); } }); }
function chargeMote(r0) { const a0 = Math.random() * 6.283, spin = r01(Math.random, 1.4, 2.4) * (Math.random() < 0.5 ? -1 : 1);
  addP(PSL, { x: 0, y: 0, life: r01(Math.random, 550, 850), trail: [], update: (p) => { const u = Math.min(1, p.t / p.life), ee = u * u; const a = a0 + u * spin, r = r0 * (1 - ee) * Q;
      p.x = VP.x + Math.cos(a) * r; p.y = VP.y + Math.sin(a) * r * 0.62; p.trail.push([p.x, p.y]); if (p.trail.length > 7) p.trail.shift(); },
    draw: (g, p, t) => { g.strokeStyle = 'rgba(' + RGB + ',' + (0.75 * (1 - t * 0.5)) + ')'; g.lineWidth = 2.5 * Q; g.beginPath(); p.trail.forEach((q, i) => (i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1]))); g.stroke(); ZP.glow(g, p.x, p.y, 7 * Q, '235,255,220', 0.9); } }); }
for (let i = 0; i < 3; i++) { const at = C2 + c.glyphCharge + i * 260; S1(at, 'tick', 0.35 + i * 0.1, 1 + i * 0.25); ZP.once(m, at, () => { GS.pulse = 1; for (const h of GS.heads) if (Math.random() < 0.45) h.on = 1; }); }
zflash(C3, 30, 220, 'rgb(' + RGB + ')', 0.5); m.shake(C3, 250, 6);

// ── arrows fan out of the glyph down toward the lens, faster and faster; the last comes head-on ──
function glyphArrow(k) { const a = Math.random() * 6.283, rr = Math.sqrt(Math.random()); const gs = c.glyphScale;
  const sx = VP.x + Math.cos(a) * rr * 330 * gs * 0.9 * Q, sy = VP.y + Math.sin(a) * rr * 330 * gs * 0.45 * Q;
  const ex = sx + (sx - VP.x) * r01(Math.random, 0.6, 1.4) + r01(Math.random, -60, 60) * Q, ey = VH + r01(Math.random, 80, 300) * Q; const ms = r01(Math.random, 200, 320) * (1 - k * 0.3), wk = r01(Math.random, 1, 2) * (1 + k * 0.6);
  addP(PSL, { x: sx, y: sy, life: ms, update: () => {}, draw: (g, p, t) => { const ee = Math.pow(t, 1.5); const hx = sx + (ex - sx) * ee, hy = sy + (ey - sy) * ee, b = Math.max(0, ee - 0.35), tx = sx + (ex - sx) * b, ty = sy + (ey - sy) * b; const wd = (2 + 18 * ee) * wk * Q;
    const ang = Math.atan2(hy - ty, hx - tx), len = Math.hypot(hx - tx, hy - ty) + 1; g.translate(tx, ty); g.rotate(ang);
    const gr = g.createLinearGradient(0, 0, len, 0); gr.addColorStop(0, 'rgba(' + RGB + ',0)'); gr.addColorStop(0.7, 'rgba(' + RGB + ',.8)'); gr.addColorStop(1, 'rgba(255,255,240,1)');
    g.fillStyle = gr; g.beginPath(); g.moveTo(0, -wd * 0.12); g.lineTo(len, -wd / 2); g.lineTo(len + wd * 1.4, 0); g.lineTo(len, wd / 2); g.lineTo(0, wd * 0.12); g.fill(); } }); }
{ let next = 0, lastP = -999;
  m.hold(A0, A0 + c.lensMs, (e) => { const k = e / c.lensMs; while (e >= next) { for (let j = 0; j < 2 + Math.round(k * 2); j++) glyphArrow(k); next += 90 + (25 - 90) * k; } });
  for (let at = 0; at < c.lensMs; at += 140) S1(A0 + at, 'piercing', 0.15, 1.2 + (at % 420) / 1400); }
S1(A0 + c.lensMs, 'shot1', 0.9, 0.85);
const BARS = ZP.swarm(tl, 14, 23, (i, r) => ({ a: r() * 6.283, w: 0.02 + r() * 0.04 }));
m.hold(A0 + c.lensMs, A1, (e) => { const t = E.inQ(Math.min(1, e / 420)); zq(50, (g) => { const s = (14 + 1500 * t * t) * Q; g.save(); g.translate(VP.x, VP.y); g.globalCompositeOperation = 'lighter';
  ZP.glow(g, 0, 0, s * 1.6, RGB, 0.55 + 0.4 * t); ZP.glow(g, 0, 0, s * 0.7, '255,255,240', 0.9); g.globalCompositeOperation = 'source-over';
  g.fillStyle = 'rgba(' + RGB + ',' + (0.35 + 0.4 * t) + ')'; for (const b of BARS) { g.beginPath(); g.moveTo(Math.cos(b.a) * s * 0.3, Math.sin(b.a) * s * 0.3); g.lineTo(Math.cos(b.a - b.w) * s * 2.4, Math.sin(b.a - b.w) * s * 2.4); g.lineTo(Math.cos(b.a + b.w) * s * 2.4, Math.sin(b.a + b.w) * s * 2.4); g.fill(); }
  g.rotate(Math.PI / 4 + t * 0.6); g.fillStyle = 'rgba(255,255,245,1)'; g.beginPath(); g.moveTo(0, -s); g.lineTo(s * 0.22, -s * 0.22); g.lineTo(s, 0); g.lineTo(s * 0.22, s * 0.22); g.lineTo(0, s); g.lineTo(-s * 0.22, s * 0.22); g.lineTo(-s, 0); g.lineTo(-s * 0.22, -s * 0.22); g.fill(); g.restore(); }); });
zflash(A1 - 1, 1, 1, '#ffffff', 1); m.shake(A1, 400, 16);

// ── the ZC flush: everything queued this frame, flashes, shake; registered after every ZC writer ──
m.hold(L, R0, (e, S) => { const t = e + L; zcMake(); if (!ZX) { ZQ = []; return; }
  const g = ZX; g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, ZC.width, ZC.height);
  const shx = S.shake ? Math.sin(t * 0.9) * S.shake : 0, shy = S.shake ? Math.cos(t * 1.3) * S.shake * 0.6 : 0;
  g.setTransform(zdpr, 0, 0, zdpr, zdpr * shx, zdpr * shy);
  ZQ.sort((a, b) => a.z - b.z); for (const q of ZQ) { g.save(); try { q.draw(g); } catch (err) {} g.restore(); } ZQ = [];
  g.save(); drawP(g, PSL); g.restore();
  let fa = 0, fc = '#fff'; for (const f of ZF) { const d = t - f.at; if (d < 0 || d > f.inMs + f.outMs) continue; const a = d < f.inMs ? f.alpha * d / f.inMs : f.alpha * (1 - (d - f.inMs) / f.outMs); if (a > fa) { fa = a; fc = f.color; } }
  if (t >= A1 - 1) { fa = 1; fc = '#ffffff'; }
  if (fa > 0) { g.globalAlpha = fa; g.fillStyle = fc; g.fillRect(-20, -20, VW + 40, VH + 40); g.globalAlpha = 1; } });
ZP.once(m, R0, () => { zcKill(); });

// ── volley: the rain over the enemy side only; 24 Chain ticks; silhouettes over the rising white ──
const NS = 'fabula-ultima-companion';
const disp = caster.document ? caster.document.disposition : 1;
const partyX = []; for (const tk of (canvas.tokens && canvas.tokens.placeables) || []) { if (!tk.visible || !tk.document || tk.document.hidden) continue; if (tk.document.disposition === disp) partyX.push(tk.center.x); }
if (!partyX.length) partyX.push(f0.x);
const FRONT = dir < 0 ? Math.min.apply(null, partyX) - 150 * UZ : Math.max.apply(null, partyX) + 150 * UZ;
const ST = tl.STAGE; const yTop = ST.y + ST.h * 0.24, yBot = ST.y + ST.h;
const xMin = dir < 0 ? ST.x + 20 : Math.max(ST.x + 20, FRONT), xMax = dir < 0 ? Math.min(ST.x + ST.w - 20, FRONT) : ST.x + ST.w - 20;
const volleyPoint = () => ({ x: xMin + Math.random() * Math.max(10, xMax - xMin), y: yTop + Math.random() * (yBot - yTop) });
const c0 = tl.feet(TOK.c);
function volleyStreak(x, y, onHit) { const ms = r01(Math.random, 170, 260), d = UZ * K.depth({ x, y }), big = Math.random() < 0.18, len = r01(Math.random, 480, 900) * d * (big ? 1.3 : 1), wd = (big ? 13 : 7) * d; const top = Math.min(tl.camView ? tl.camView({}).top : y - 1200, y - 1200);
  addP(PWL, { x, y, life: ms + 320, update: () => {}, draw: (g, p) => { const u = Math.min(1, p.t / ms); const yy = top + (y - top) * u;
    if (p.t < ms) { const gr = g.createLinearGradient(x, yy - len, x, yy); gr.addColorStop(0, 'rgba(' + RGB + ',0)'); gr.addColorStop(0.75, 'rgba(' + RGB + ',.8)'); gr.addColorStop(1, 'rgba(255,255,240,1)');
      g.globalCompositeOperation = 'source-over'; g.strokeStyle = gr; g.lineWidth = wd; g.lineCap = 'round'; g.beginPath(); g.moveTo(x - 10 * d, yy - len); g.lineTo(x, yy); g.stroke();
      g.strokeStyle = 'rgba(255,255,245,.95)'; g.lineWidth = wd * 0.3; g.beginPath(); g.moveTo(x - 5 * d, yy - len * 0.5); g.lineTo(x, yy); g.stroke();
      g.fillStyle = 'rgba(255,255,245,1)'; g.beginPath(); g.moveTo(x, yy + wd * 2.2); g.lineTo(x - wd * 1.1, yy - wd * 0.6); g.lineTo(x + wd * 1.1, yy - wd * 0.6); g.fill(); g.globalCompositeOperation = 'lighter'; ZP.glow(g, x, yy, wd * 3, RGB, 0.8); }
    else { const tt = (p.t - ms) / 320; if (!p.hit) { p.hit = true; if (onHit) onHit(); } ZP.glow(g, x, y, (big ? 80 : 46) * (0.4 + tt) * d, RGB, 0.9 * (1 - tt)); g.strokeStyle = 'rgba(255,255,240,' + (1 - tt) + ')'; g.lineWidth = 3 * d; g.beginPath(); g.ellipse(x, y, 30 * (0.3 + tt) * d, 10 * (0.3 + tt) * d, 0, 0, 6.2832); g.stroke(); } } }); }
{ let acc = 0, last = null, lastHit = -1e9;
  m.hold(R0, R1, (e) => { const dt = last == null ? 16 : e - last; last = e; const k = e / c.rainMs; acc += c.density / 60 * (0.6 + k * 0.8) * dt / 16;
    while (acc >= 1) { acc -= 1; const q = volleyPoint(); volleyStreak(q.x, q.y, () => { const n = performance.now(); if (n - lastHit > 60 && SND.piercing) { lastHit = n; try { oni.sfx(SND.piercing, { volume: 0.16 * 0.75, rate: r01(Math.random, 0.9, 1.2) }); } catch (er) {} } }); } }); }
m.hold(R0, R1, (e, S) => { const k = e / c.rainMs; const w = k > 0.55 ? E.inQ((k - 0.55) / 0.45) : 0; S.shake = Math.max(S.shake, 4 + 8 * w); });
m.flash(R0, 1, 259, '#ffffff', 1);
S1(R0, 'wind7', 0.4);
// the Chain ticks: one cue = every target's next number (flinch + hurt art on the real tokens)
// The ticks end before the white starts (55% of the rain): the game's own flinch and impact sit above
// the shot's canvas, so a tick inside the white would cover the silhouettes with a bright flinch copy.
for (let j = 0; j < c.hits; j++) ZP.hit(m, R0 + c.rainMs * (0.04 + 0.46 * (j + 0.5) / c.hits), {});
// arrow-storm clips + venom (or the element's burst) on the targets, every 300 ms
const DEFS = A.clips || {};
for (let at = 0, i = 0; at < c.rainMs && TG.length; at += 300, i++) {
  const k = TG[i % TG.length]; const ft = K.feet(tl, k), md = K.mid(tl, k);
  const key = i % 2 ? 'storm1' : 'storm0'; const dd = DEFS[key]; if (dd) m.clip(key, R0 + at, { x: ft.x, y: ft.y, w: dd.w * 0.9 * 1.1 * UZ, z: 56, add: true, filter: hueF || undefined });
  if (POISON) { const pk = i % 2 ? 'hpoison' : 'psmoke'; const pd = DEFS[pk]; if (pd) m.clip(pk, R0 + at, { x: ft.x + (Math.random() - 0.5) * 80 * UZ, y: ft.y, w: pd.w * 0.9 * 1.1 * UZ, z: 57, alpha: () => 0.85 }); }
  else { const bk = c.burstFor && c.burstFor[elKey]; const bd = bk && DEFS[bk]; if (bd) m.clip(bk, R0 + at, { x: md.x, y: md.y, w: bd.w * 0.5 * 1.3 * (bd.ro ? 1.1 : 0.55) * UZ, z: 57, add: true, filter: bd.mask ? K.tintF(EL.hue, 4, 1.3) : undefined }); }
}
// the white rises over the last 45%; the enemies go to silhouettes above it, then the light eats them
m.hold(R0 + c.rainMs * 0.55, B0 + 1, (e, S) => { const t = e + R0 + c.rainMs * 0.55; const k = Math.min(1, (t - R0) / c.rainMs); const w = t >= R1 ? 1 : E.inQ((k - 0.55) / 0.45);
  const wa = Math.min(1, w * 1.05); if (wa > S.flash.a) S.flash = { a: wa, c: '#ffffff' };
  if (t >= R1) return; const sa = w < 0.75 ? 1 : 1 - (w - 0.75) / 0.25; if (sa <= 0) return;
  S.over.push({ draw: (g) => { const sc = canvas.stage.scale.x || 1; for (const k2 of TG) { const Tk = TOK[k2]; const cc = tl.tinted(k2, '#000'); if (!cc) continue; const f = tl.feet(Tk); const p = tl.toScreen(f.x, f.y); const w2 = Tk.w * sc, h2 = Tk.h * sc;
    g.save(); g.globalAlpha = sa; g.translate(p.x, p.y); g.scale(Tk.flip, 1); g.drawImage(cc, -w2 / 2, -h2 * Tk.foot, w2, h2); g.restore(); } } }); });
S1(R1, 'explode', 0.5);
// ── back to battle: the white clears; venom lingers; the party fades back; Zarg steps home ──
m.hold(B0, B0 + 700, (e, S) => { const a = 1 - e / 700; if (a > S.flash.a) S.flash = { a, c: '#ffffff' }; });
if (POISON) for (const k of TG) { const ft = K.feet(tl, k); const pd = DEFS.psmoke; if (pd) m.clip('psmoke', B0 + 700, { x: ft.x, y: ft.y, w: pd.w * 0.8 * 1.1 * UZ, z: 57, alpha: () => 0.6 }); }

try {
  await tl.run(T, { total: END, sfx: [], onStart: K.ready });
} finally {
  clearXform(); zcKill();
}
oni.fireDone();
