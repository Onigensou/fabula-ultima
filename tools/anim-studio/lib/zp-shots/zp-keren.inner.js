// Zero Power: Last Den of Cinders (Keren) — the approved Zero Power overhaul mockup
// (artifact 5FPS7VFAX7oqnTGy9KZAVC v17, round 16), ported onto oni.timeline.
//
// Board phase (LIVE board, real tokens): everyone but Keren and the targets fades out
// FIRST (her summons already on the field included: the user's dedupe rule), she steps
// out on a fire circle, the parade's summons drop in front of her (a streak of fire that
// squashes in), the cut-in, then fire portals drag the targets under.
// Underworld (screen space, covers the board): drawn in the mockup's own 1682 x 788
// space and fitted to the view, with its own camera (static for the parade, moving for
// the finale). Parade = her REAL summons in the chain-formula order: each own Phantasm
// (fox fire) 1 strike, each own Minion 1, Leichi/Leilan ALWAYS 1 cross strike (the user,
// 11-06: the twins are mandatory, summoned or not; their real tokens when on the field,
// else their standard art), each own Numen (Crysta) 2 knife stabs. Then the finale (fire portal, walk, den,
// spin with her back pose, channel circle, fox-fire ring, blast), the whiteout, and the
// last hit back on the board as the targets fall into their places.
// Ticks: strikes + blast + last hit = the item's 'chain {...}' count. Every tick is
// oni.hit({ numbersOnly, screenAt }) — the shot draws its own flinch and impact.
// Storage rules: no backticks and no dollar-brace anywhere in this file.
if (!caster) { K.ready(); oni.fireDone(); return; }
const NS = 'fabula-ultima-companion';
const casterActor = caster.actor || (caster.document && caster.document.actor) || null;
const meUuid = casterActor ? String(casterActor.uuid || '') : '';
const flagsOf = (t) => (t && t.document && t.document.flags && t.document.flags[NS]) || {};
const allTok = (canvas.tokens && canvas.tokens.placeables) || [];
const isMine = (t) => !!(meUuid && t && t.document && t.document.actor && String(flagsOf(t).summonedBy || '') === meUuid);
const nameIs = (t, n) => { const d = t && t.document; if (!d) return false; return String((d.actor && d.actor.name) || '').trim().toLowerCase() === n || String(d.name || '').trim().toLowerCase() === n; };
const propsOf = (t) => (t && t.document && t.document.actor && t.document.actor.system && t.document.actor.system.props) || {};
for (let i = targets.length - 1; i >= 0; i--) if (isMine(targets[i])) targets.splice(i, 1);

// ── the parade, in the KEYWORDS order (skill-formulas OWN_PHANTASM/MINION/NUMEN_COUNT, ON_FIELD) ──
const phantasms = allTok.filter((t) => isMine(t) && flagsOf(t).isPhantasm);
const numens = allTok.filter((t) => isMine(t) && (flagsOf(t).isNumen || propsOf(t).isNumen));
const minions = allTok.filter((t) => isMine(t) && flagsOf(t).cloneActorUuid && !flagsOf(t).isPhantasm);
const leichi = allTok.find((t) => nameIs(t, 'leichi')) || null, leilan = allTok.find((t) => nameIs(t, 'leilan')) || null;
const LIVEPARADE = phantasms.length + numens.length + minions.length + ((leichi || leilan) ? 1 : 0) > 0;
const parade = [];
const nPlan = (ctx.params.strikes || []).length;
if (LIVEPARADE || (nPlan && nPlan <= 3)) {
  // In battle: her real summons, plus the twins every time. With NO summons out the plan
  // is exactly the twins + the blast + the last hit (3 ticks): never show summons she lacks.
  phantasms.forEach((t, i) => parade.push({ kind: 'fox', i, tok: t }));
  minions.forEach((t) => parade.push({ kind: 'minion', tok: t }));
  parade.push({ kind: 'twins', a: leichi, b: leilan });
  numens.forEach((t) => parade.push({ kind: 'crysta', tok: t }));
} else {
  // Preview Bench (no strike plan, or a forged plan with parade strikes) and no summons out:
  // the mockup's set, drawn from Forge art.
  parade.push({ kind: 'fox', i: 0 }, { kind: 'fox', i: 1 }, { kind: 'twins', a: null, b: null }, { kind: 'crysta' });
}
const strikesOf = (s) => s.kind === 'crysta' ? 2 : 1;
const NTICK = parade.reduce((a, s) => a + strikesOf(s), 0) + 2;

// her own art for the walk and the back pose (sheet fields first, Forge fallback in cfg images)
const kp = propsOf(caster);
const useUrl = (u) => { const s = String(u || '').trim(); return s || null; };
A.images = Object.assign({}, A.images || {});
if (useUrl(kp.sprite_walk)) A.images.kerenWalk = useUrl(kp.sprite_walk);
if (useUrl(kp.sprite_stand_up_left)) A.images.kerenBack = useUrl(kp.sprite_stand_up_left);
targets.forEach((t, i) => { const u = useUrl(propsOf(t).sprite_hurt); if (u) A.images['hurt' + i] = u; });

// bystanders: everyone else on the board (her summons included) fades out first
const B0 = ZP.bystanders([]);
const B = await boot(B0);
const { tl, T, m, TOK, TG, U, E } = B;
if (!TG.length) { await tl.run(T, { total: 10, onStart: K.ready }); oni.fireDone(); return; }
const keyOfTok = (tok) => { if (!tok) return null; for (const k in TOK) if (TOK[k].token && TOK[k].token.id === tok.id) return k; return null; };
parade.forEach((s) => { s.key = keyOfTok(s.tok); s.ka = keyOfTok(s.a); s.kb = keyOfTok(s.b); });
const shatterKeys = new Set(); parade.forEach((s) => { if ((s.kind === 'fox' || s.kind === 'crysta') && s.key) shatterKeys.add(s.key); });

const c = cfg; const t = c.t || {};
const DRAG = t.drag || 1000, FALL = t.fall || 1000, PER = t.perSummon || 1600, WALK = t.walkMs || 1500, SPIN = t.spinMs || 2200;
const SPINDEG = t.spinDeg || 150, RINGN = t.ringFoxes || 9, RINGMS = t.ringMs || 1500, WHOLD = t.whiteHold || 1300, DROP = t.dropMs || 420;
const dir = K.dirOf(TOK, 'c');
const sfx = [];
const S_ = c.s || {};
const say = (at, key, vMul) => { const s = S_[key]; if (!s) return; sfx.push({ at: Math.round(at), url: s.url, v: Math.min(1, s.v * (vMul || 1)) }); };
const rnd01 = tl.rng(31);
const rr = (a, b) => a + (b - a) * rnd01();
const lerp = tl.lerp, clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const outBack = (k) => { const c1 = 1.6; return 1 + (c1 + 1) * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2); };
const vidPlay = (img) => { if (img && img.tagName === 'VIDEO' && img.paused) { try { img.loop = true; img.muted = true; img.play().catch(() => {}); } catch (e) {} } };

// ── field geometry (world px). MPX = world px per mockup px, from Keren's own drawn height ──
const KH_MOCK = 165;
const MPX = TOK.c.h / KH_MOCK;
const cf0 = tl.feet(TOK.c);
const STEP = 40;
const cfStep = { x: cf0.x + dir * STEP * MPX, y: cf0.y };
// mockup drop-in spots, relative to Keren's stepped-out feet (1272, 460), mirrored by facing
// (the mockup has Keren facing left, dir = -1: a spot at mockup x < 1272 is toward the enemy; mirrored when she faces right)
const SPOTS = [[1165, 430], [1085, 515], [1195, 560], [1050, 395], [1125, 640], [1005, 585], [1240, 665]].map((p) => ({ x: cfStep.x + (p[0] - 1272) * MPX * (dir === -1 ? 1 : -1), y: cfStep.y + (p[1] - 460) * MPX }));
const FIELD_H = { fox: 70, minion: 110, leichi: 150, leilan: 155, crysta: 230 };

// field drop-in list: each parade summon body that appears on the field
const drops = [];
parade.forEach((s) => {
  if (s.kind === 'twins') { drops.push({ s, who: 'a', key: s.ka, img: 'leichi', base: FIELD_H.leichi }); drops.push({ s, who: 'b', key: s.kb, img: 'leilan', base: FIELD_H.leilan }); }
  else if (s.kind === 'fox') drops.push({ s, key: s.key, img: 'foxfire', base: FIELD_H.fox, add: true });
  else if (s.kind === 'minion') drops.push({ s, key: s.key, img: null, base: FIELD_H.minion });
  else if (s.kind === 'crysta') drops.push({ s, key: s.key, img: 'crysta', base: FIELD_H.crysta });
});
const artOf = (key, img) => (key ? tl.art(key) : null) || (img ? tl.IMG[img] : null);
// a body's height in world px at foot point p: a real summon = its own drawn height, moved by depth
const fieldH = (d, p) => {
  if (d.key && TOK[d.key]) return TOK[d.key].h * tl.depthRatio(tl.feet(TOK[d.key]), p);
  return d.base * MPX * tl.depthRatio(cf0, p);
};

// ═════════ schedule (absolute ms) ═════════
const T_FOCUS = 450;                   // the cast focus finishes before anything else
const T_STEP = T_FOCUS;                // step out (380)
const T_CIRCLE = T_STEP + 380;
const T_DROP0 = T_CIRCLE;
const DROPGAP = 160, DROPLEN = 540;
const T_CUT = T_DROP0 + (drops.length ? (drops.length - 1) * DROPGAP + DROPLEN : 0);
const CUTLEN = 2150;
const T1 = T_CUT + CUTLEN;             // dragged under
const T_SINK = T1 + 600;
const T_BLACK = T_SINK + DRAG + 0;     // black over 200
const T2 = T_BLACK + 400;              // underworld (black fades over 300)
const NF = TG.length;
const T_LAND = (i) => T2 + 300 + i * 140 + FALL;
const T3 = T2 + 300 + (NF - 1) * 140 + FALL + 250;   // parade
// parade timings
let tp = T3; const hits = []; // { at, kind }
const plan = parade.map((s) => {
  const p = { s, at: tp };
  if (s.kind === 'fox') { p.enter = 380; p.fly = PER * 0.4; p.hit = tp + 380 + PER * 0.4; p.end = p.hit + PER * 0.32; hits.push(p.hit); }
  else if (s.kind === 'minion') { p.fade = 350; p.creep = PER * 0.3; p.lunge = PER * 0.1; p.hit = tp + 350 + PER * 0.3 + PER * 0.1; p.back = p.hit + PER * 0.18; p.shat = p.back + PER * 0.2; p.end = p.shat + 600; hits.push(p.hit); }
  else if (s.kind === 'twins') { p.enter = 360; p.dash = PER * 0.22; p.hit = tp + 360 + PER * 0.22; p.out = p.hit + PER * 0.25; p.end = p.out + 350; hits.push(p.hit); }
  else if (s.kind === 'crysta') { p.fade = 400; p.stab = []; let q = tp + 400; for (let i = 0; i < 2; i++) { const mv = q; const th = mv + PER * 0.1; const h = th + 90; p.stab.push({ mv, th, hit: h }); hits.push(h); q = h + PER * 0.18; } p.twk = q; p.shat = q + PER * 0.12; p.end = p.shat + 600; }
  tp = p.end; return p;
});
const T4 = tp + 400;                     // finale
const T_PORTAL = T4, T_KAPP = T4 + 380, T_KWALK = T_KAPP + 650 + 200, T_KSTOP = T_KWALK + WALK;
const T_ORB = T_KSTOP, T_SWELL = T_ORB + 900;
const T5 = T_SWELL + 3 * 500;            // spin
const T6 = T5 + SPIN;                    // ring + blast
const T_RINGIN = T6 + 700, T_RUSH = T_RINGIN + RINGMS, T_BLAST = T_RUSH + 260;
const T7 = T_BLAST + 1400 + 500;         // whiteout
const T_WHITE = T7 + 220, T_RET = T_WHITE + WHOLD;  // underworld off, white fades over 500
const T_FALL0 = T_RET + 500 + 220;
const T_LANDF = (i) => T_FALL0 + i * 90 + DROP;
const T_FINAL = T_FALL0 + (NF - 1) * 90 + DROP;
const T_BACK = T_FINAL + 700;
const TOTAL = T_BACK + 500 + 1200;
const UW_ON = T2, UW_OFF = T_RET;

// ═════════ BOARD PHASE ═════════
// cast focus: bystanders out (450 ms), back at T_BACK, except her shattered Phantasms / Numen
for (const k of Object.keys(TOK)) {
  if (!/^b[0-9]+$/.test(k)) continue; const keepGone = shatterKeys.has(k);
  m.hold(0, TOTAL + 1, (e, S) => { const q = S.tok[k]; if (!q) return; let a; if (e < T_FOCUS) a = 1 - e / T_FOCUS; else if (keepGone || e < T_BACK) a = 0; else a = Math.min(1, (e - T_BACK) / 500); if (a <= 0.001) q.hidden = true; else if (a < 1) q.alpha *= a; });
}
m.dim(T_FOCUS, 300, 0.55);
m.undim(T_RET, 400, 0.55);
// Keren steps out, then back when the party returns
K.path(m, E, 'c', [[T_STEP, 0, 0], [T_STEP + 380, dir * STEP * MPX, 0, 'ioQ'], [T_BACK, dir * STEP * MPX, 0], [T_BACK + 460, 0, 0, 'ioQ']]);
// hidden while she is in the underworld scene (the scene covers the board anyway)
// cast circle at her feet (RO hellinferno_cast_bottom, fire hue), until the drag starts
const CL = A.clips || {};
const cw = (key, scale, ro) => (CL[key] ? CL[key].w : 100) * scale * (ro ? 1.1 : 0.55);
m.clip('hellCast', T_CIRCLE, { x: cfStep.x, y: cfStep.y, w: cw('hellCast', 0.7, true) * MPX, sy: 0.5, z: 2, add: true, loop: true, hold: T1 + 200 - T_CIRCLE, filter: 'hue-rotate(-40deg) saturate(1.4)', alpha: (u) => { const e = u * (T1 + 200 - T_CIRCLE); return e > T1 - T_CIRCLE ? Math.max(0, 1 - (e - (T1 - T_CIRCLE)) / 200) : Math.min(1, e / 200); } });
say(T_CIRCLE, 'dark4', 0.5);
// world particles: deterministic emitters { born, x, y, vx, vy, life, r, rgb }
function emit(seed, t0, t1, every, per, make) { const r = tl.rng(seed); const out = []; for (let tt = t0; tt < t1; tt += every) for (let i = 0; i < per; i++) { const p = make(r, tt); p.born = tt; out.push(p); } return out; }
function drawEmbers(g, list, now, map) {
  g.save(); g.globalCompositeOperation = 'lighter';
  for (const p of list) { const age = now - p.born; if (age < 0 || age > p.life) continue; const u = age / p.life; let x = p.x + p.vx * age, y = p.y + p.vy * age; x += Math.sin(age / 300) * 6 * (p.wob || 1); const q = map ? map(x, y) : { x, y, k: 1 };
    ZP.glow(g, q.x, q.y, p.r * 3 * q.k, p.rgb, Math.sin(u * Math.PI) * 0.9); }
  g.restore();
}
const PINK = '255,90,170', ORANGE = '255,150,60';
// the drop-in: a streak of fire falls and squashes into the summon; it smoulders until the drag
const fieldEmbers = [];
drops.forEach((d, i) => {
  const at = T_DROP0 + i * DROPGAP; const p = SPOTS[i % SPOTS.length]; d.p = p; d.at = at;
  say(at, 'teleport', 0.22); say(at + 170, 'fire1', 0.28);
  const hh = fieldH(d, p);
  m.clip('magBurst', at + 170, { x: p.x, y: p.y - hh * 0.3, w: cw('magBurst', 0.6, false) * MPX * tl.depthRatio(cf0, p), z: 40, add: true, depth: false });
  for (const e of emit(100 + i, at + 170, at + 171, 1, 12, (r) => ({ x: p.x + (r() - 0.5) * 60 * MPX, y: p.y - r() * hh * 0.6, vx: (r() - 0.5) * 0.06, vy: -(0.08 + r() * 0.17), life: 700 + r() * 600, r: (2 + r() * 3) * MPX, rgb: r() < 0.4 ? PINK : ORANGE }))) fieldEmbers.push(e);
  // smoulder until the drag
  for (const e of emit(200 + i, at + 540, T_SINK, 120, 1, (r) => ({ x: p.x + (r() - 0.5) * 36 * MPX, y: p.y - r() * hh * 0.7, vx: (r() - 0.5) * 0.04, vy: -(0.05 + r() * 0.07), life: 1400 + r() * 1200, r: (1.5 + r() * 2) * MPX, rgb: r() < 0.4 ? PINK : ORANGE, skip: r() > 0.45 }))) if (!e.skip) fieldEmbers.push(e);
  m.hold(at, T_SINK + 200, (e, S) => {
    const art = artOf(d.key, d.img); if (!art) return; vidPlay(art);
    let sx = 1, sy = 1, oy = 0, a = 1; const u = e;
    if (u < 170) { sx = 0.12; sy = 2.4; oy = -320 * MPX * (1 - E.inQ(u / 170)); }
    else if (u < 280) { const k = E.outC((u - 170) / 110); sx = lerp(0.12, 1.4, k); sy = lerp(2.4, 0.62, k); }
    else if (u < 540) { const k = outBack((u - 280) / 260); sx = lerp(1.4, 1, k); sy = lerp(0.62, 1, k); }
    if (e > T_SINK - at) a = Math.max(0, 1 - (e - (T_SINK - at)) / 200);
    S.world.push({ z: 30 + p.y / 100, draw: (g) => { const iw = art.naturalWidth || art.videoWidth || art.width || 1, ih = art.naturalHeight || art.videoHeight || art.height || 1; const w = hh * iw / ih;
      g.save(); g.translate(p.x, p.y + oy); g.scale(sx * (d.key ? (TOK[d.key].flip || 1) : (dir === -1 ? 1 : -1)), sy); g.globalAlpha = a; if (d.add) g.globalCompositeOperation = 'lighter';
      if (!d.key && d.s.kind === 'minion') g.filter = 'grayscale(.7) sepia(.5) hue-rotate(60deg) brightness(.7) contrast(1.2)';
      g.drawImage(art, -w / 2, -hh, w, hh); g.restore(); } });
  });
});
m.hold(T_DROP0, T_SINK + 2600, (e, S) => S.world.push({ z: 45, draw: (g) => drawEmbers(g, fieldEmbers, e + T_DROP0, null) }));
// the cut-in
ZP.cutin(tl, m, T_CUT, 'cut');
say(T_CUT, 'overdrive', 0.9);

// ── dragged under: fire portals open, the targets flinch, then shake as they sink ──
const portalOf = (pt, s, o) => { o = o || {}; return { pt, s, rx: 78 * (o.big || 1), ry: 24 * (o.big || 1), rgb: o.rgb || '255,110,40', hot: o.hot || '255,220,140' }; };
const FP = TG.map((k, i) => { const f = tl.feet(TOK[k]); const s = MPX * tl.depthRatio(cf0, f) * (TOK[k].h < TOK.c.h * 0.6 ? 0.8 : 1); return portalOf(f, s); });
function drawPortalHole(g, P, open) { if (open <= 0) return; const w = P.rx * P.s * open, h = P.ry * P.s * open; g.save(); g.translate(P.pt.x, P.pt.y);
  g.shadowColor = 'rgba(' + P.rgb + ',0.8)'; g.shadowBlur = 18 * P.s; const gr = g.createRadialGradient(0, 0, 0, 0, 0, w); gr.addColorStop(0, '#000'); gr.addColorStop(0.48, '#0d0106'); gr.addColorStop(0.78, 'rgba(' + P.rgb + ',0.85)'); gr.addColorStop(1, 'rgba(' + P.rgb + ',0)');
  g.scale(1, h / w); g.fillStyle = gr; g.beginPath(); g.arc(0, 0, w, 0, 6.2832); g.fill(); g.restore(); }
function portalFlames(seed, P, t0, t1) { return emit(seed, t0, t1, 40, 3, (r) => { const a = r() * 6.2832; return { x: P.pt.x + Math.cos(a) * P.rx * P.s * 0.92, y: P.pt.y + Math.sin(a) * P.ry * P.s * 0.92, vx: (r() - 0.5) * 0.04, vy: -(0.1 + r() * 0.14) * P.s, life: 350 + r() * 350, r: (5 + r() * 6) * P.s, rgb: P.rgb, hot: P.hot }; }); }
function drawFlames(g, list, now, map) { g.save(); g.globalCompositeOperation = 'lighter'; for (const p of list) { const age = now - p.born; if (age < 0 || age > p.life) continue; const u = age / p.life; const x = p.x + p.vx * age, y = p.y + p.vy * age; const q = map ? map(x, y) : { x, y, k: 1 }; ZP.glow(g, q.x, q.y, p.r * (1.7 - u) * q.k, u < 0.3 ? p.hot : p.rgb, (1 - u) * 0.9); } g.restore(); }
const portalOpen = (e, t0, t1) => (e < t0 ? 0 : e < t0 + 260 ? outBack((e - t0) / 260) : e < t1 ? 1 : e < t1 + 200 ? 1 - E.inQ((e - t1) / 200) : 0);
FP.forEach((P, i) => {
  const fl = portalFlames(300 + i, P, T1, T_BLACK);
  m.hold(T1, T_BLACK + 400, (e, S) => { const now = e + T1; const o = portalOpen(now, T1, T_BLACK); S.world.push({ z: 3, draw: (g) => drawPortalHole(g, P, o) }); S.world.push({ z: 60, draw: (g) => drawFlames(g, fl, now, null) }); });
  m.clip('hell', T1, { x: P.pt.x, y: P.pt.y, w: cw('hell', 0.6, true) * MPX, z: 55, add: true, filter: 'hue-rotate(-20deg)' });
});
say(T1, 'fire3', 0.55); m.flash(T1, 60, 300, '#ff5a2a', 0.45);
TG.forEach((k) => ZP.flinchTok(m, T1 + 240, k, 'normal', 600));
say(T1 + 240, 'darkness4', 0.65);
m.shake(T_SINK, DRAG, 4);
// they sink: the painted token is replaced by a copy cut at the floor line
TG.forEach((k, i) => {
  m.hold(T_SINK, T_BLACK + 400, (e, S) => { const q = S.tok[k]; if (!q) return; q.hidden = true; const Tk = TOK[k], art = tl.art(k); if (!art) return; const f = tl.feet(Tk); const u = Math.min(1, e / DRAG); const k2 = E.inQ(u);
    const dx = Math.sin(u * 70 + i * 2) * 7 * MPX * (1 - u * 0.4), dy = (Tk.h + 30 * MPX) * k2;
    S.world.push({ z: 20 + f.y / 1000, draw: (g) => { g.save(); g.beginPath(); g.rect(f.x - Tk.w * 2, f.y - Tk.h * 3, Tk.w * 4, Tk.h * 3); g.clip(); g.translate(f.x + dx, f.y + dy); g.scale(Tk.flip, 1); g.drawImage(art, -Tk.w / 2, -Tk.h * Tk.foot, Tk.w, Tk.h); g.restore(); } });
  });
});
m.hold(T_BLACK, T2 + 300, (e, S) => { S.black = Math.max(S.black, e < 200 ? e / 200 : 1); });
// the targets stay out of sight on the board until they fall back after the whiteout
TG.forEach((k) => m.hold(T_BLACK + 400, T_FALL0, (e, S) => { const q = S.tok[k]; if (q) q.hidden = true; }));
// Keren and the bystanders: the board is covered by the underworld; hide her copy there too
m.hold(T2, T_RET, (e, S) => { const q = S.tok.c; if (q) q.hidden = true; });

// ═════════ UNDERWORLD (virtual 1682 x 788, screen space) ═════════
const VW = 1682, VH = 788;
const UW = { cluster: [{ x: 840, y: 455 }, { x: 705, y: 568 }, { x: 980, y: 578 }], keren: { x: 1330, y: 640 }, den: { x: 1400, y: 250 }, portal: { x: 1545, y: 600 } };
const clusterAt = (i) => { if (i < 3) return UW.cluster[i]; const r = tl.rng(500 + i); return { x: 700 + r() * 300, y: 470 + r() * 120 }; };
const centroid = (list) => ({ x: list.reduce((a, s) => a + s.x, 0) / list.length, y: list.reduce((a, s) => a + s.y, 0) / list.length });
const UWC = centroid(TG.map((k, i) => clusterAt(i)));
const uwS = (y) => { const den = 440 - 160, num = Math.max(y - 160, den * 0.05); return clamp(Math.pow(num / den, 0.33), 0.6, 1.12); };
const sc0 = (canvas.stage && canvas.stage.scale && canvas.stage.scale.x) || 1;
const VIEW0 = tl.view(); const FIT0 = Math.max(VIEW0.W / VW, VIEW0.H / VH);
// a field token's on-screen height in virtual units
const vH = (k) => (TOK[k] ? TOK[k].h * sc0 / FIT0 : 160);
// ── the underworld camera: set/to commands in virtual space ──
const CAMB = { x: VW / 2, y: VH / 2, z: 1, r: 0 };
const CAMS = [];
const camTo = (at, ms, to, ease) => CAMS.push({ at, ms: Math.max(1, ms), to, ease: ease || E.sine });
let spinM0 = null;
function camAt(now) {
  let cur = Object.assign({}, CAMB);
  for (const cm of CAMS) { if (now < cm.at) break; const k = cm.ease(clamp((now - cm.at) / cm.ms, 0, 1)); const from = Object.assign({}, cur); const to = Object.assign({}, from, cm.to);
    cur = { x: lerp(from.x, to.x, k), y: lerp(from.y, to.y, k), z: Math.exp(lerp(Math.log(from.z), Math.log(to.z), k)), r: lerp(from.r, to.r, k) }; }
  if (now >= T5 && now < T5 + SPIN) { const u = (now - T5) / SPIN; cur.r += Math.sin(u * Math.PI) * 4; }
  return cur;
}
// virtual -> screen. UW_BIAS: the camera looks this much lower in the painting than the mockup did, which lifts
// the whole underworld up the screen so the centre-stage cluster clears the battle HUD along the bottom edge
// (sandbox 2026-11-06: at the mockup framing the targets sat behind the GM desk). The painting still covers.
const UW_BIAS = 120;
function proj(now, W, H) { const cm = camAt(now); const fit = Math.max(W / VW, H / VH); const k = fit * cm.z; const a = cm.r * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
  return { k, fit, cm, map: (x, y) => { const dx = (x - cm.x) * k, dy = (y - cm.y - UW_BIAS) * k; return { x: W / 2 + dx * ca - dy * sa, y: H / 2 + dx * sa + dy * ca, k }; } }; }
// finale camera (the parade holds the wide view; camPunch 1)
const P0 = UW.portal;
camTo(T4, 1, { x: P0.x - 130, y: P0.y - 110, z: 1.55, r: -2 });
camTo(T_KWALK, WALK, { x: 1210, y: UW.keren.y - 90, z: 1.45, r: 0 });
camTo(T_ORB, 900, { x: UWC.x + 200, y: 420, z: 1.2, r: 2 });
camTo(T5, SPIN * 0.4, { x: 0, y: 470, z: 1.15 });            // x filled in below (spin midpoint)
camTo(T5 + SPIN, 300, { r: 0 });
camTo(T6, 900, { x: UWC.x, y: UWC.y - 120, z: 1.3 });
camTo(T_BLAST, 900, { x: UWC.x + 60, y: UWC.y - 160, z: 1.1 }, E.outC);
// ── bodies in the underworld ──
// foes: fall in, hold, swing with the spin; hits flinch them
const FOES = TG.map((k, i) => { const p = clusterAt(i); return { k, i, x: p.x, y0: p.y, h: vH(k) * uwS(p.y) * 1.3, tin: T2 + 300 + i * 140, flip: TOK[k].flip || 1 }; });
const KREN = { x: UW.keren.x, y: UW.keren.y, h: vH('c') * uwS(UW.keren.y) * 1.3 };
spinM0 = { x: (KREN.x + UWC.x) / 2, y: 600 };
CAMS[3].to.x = spinM0.x;
const hitTimesAll = hits.slice(); // parade strike times (absolute)
const lastHitBefore = (now) => { let h = -1e9; for (const x of hitTimesAll) if (x <= now && x > h) h = x; if (now >= T_BLAST && T_BLAST > h) h = T_BLAST; return now - h; };
function spinPose(now, dx0, y0, h0, f0) {
  if (now < T5) return { dx: dx0, y: y0, h: h0, flip: f0, th: 0 };
  const u = Math.min(1, (now - T5) / SPIN); const th = E.ioQ(u) * SPINDEG * Math.PI / 180; const dz = dx0 * Math.sin(th);
  return { dx: dx0 * Math.cos(th), y: y0 + dz * 0.14, h: h0 * (1 + dz / 2400), flip: Math.cos(th) < 0 ? -f0 : f0, th, z: y0 + dz * 0.14 + 500 };
}
function foeState(F, now) {
  if (now < F.tin) return null;
  const fy = now < F.tin + FALL ? lerp(F.y0 - 700, F.y0, E.inQ((now - F.tin) / FALL)) : F.y0;
  const sp = spinPose(now, F.x - spinM0.x, fy, F.h, F.flip);
  return { x: spinM0.x + sp.dx, y: sp.y, h: sp.h, flip: sp.flip, z: sp.z != null ? sp.z : fy };
}
function kerenState(now) {
  if (now < T_KAPP) return null;
  let x = P0.x, y = P0.y, a = 1, oy = 0, pose = 'idle';
  if (now < T_KAPP + 650) { const k = (now - T_KAPP) / 650; a = E.sine(k); oy = 30 * (1 - E.outC(k)); }
  else if (now < T_KWALK) { }
  else if (now < T_KSTOP) { const k = (now - T_KWALK) / WALK; x = lerp(P0.x, KREN.x, k); y = lerp(P0.y, KREN.y, k); pose = 'walk'; }
  else { x = KREN.x; y = KREN.y; }
  let h = KREN.h, flip = 1;
  if (now >= T5) { const sp = spinPose(now, KREN.x - spinM0.x, KREN.y, KREN.h, 1); x = spinM0.x + sp.dx; y = sp.y; h = sp.h; flip = sp.flip; if (sp.th * 180 / Math.PI >= 50) { pose = 'back'; flip = -1; } }
  return { x, y, a, oy, h, flip, pose, z: now >= T5 ? (KREN.y + 500) : 700 };
}
// the den: grows with each shatter / fox explosion; moves over the targets, swells, follows the spin, splits into the ring
const denGrow = [];
plan.forEach((p) => { if (p.s.kind === 'fox') denGrow.push(p.hit); if (p.s.kind === 'minion' || p.s.kind === 'crysta') denGrow.push(p.shat + 600); });
function denState(now) {
  if (now >= T6) return null;
  let s = 0.2; for (const tg of denGrow) if (now >= tg) s += 0.35;
  let x = UW.den.x, y = UW.den.y; const tgt = { x: UWC.x, y: UWC.y - 230 };
  if (now >= T_ORB) { const k = E.sine(Math.min(1, (now - T_ORB) / 900)); x = lerp(UW.den.x, tgt.x, k); y = lerp(UW.den.y, tgt.y, k) - Math.sin(k * Math.PI) * 60; }
  const steps = [1.4, 2, 2.7]; let sv = s;
  for (let i = 0; i < 3; i++) { const t0 = T_SWELL + i * 500; if (now >= t0) { const k = E.outC(Math.min(1, (now - t0) / 240)); const from = i ? steps[i - 1] : s; sv = lerp(from, steps[i], k); } }
  if (now >= T5) { const fs = FOES.map((F) => foeState(F, now)).filter(Boolean); if (fs.length) { const cc = centroid(fs); x = cc.x; y = cc.y - 270; } sv = 2.7; }
  return { x, y, s: sv };
}
for (let i = 0; i < 3; i++) { say(T_SWELL + i * 500 + 240, 'fire1', 0.3 + i * 0.08); m.flash(T_SWELL + i * 500 + 240, 30, 140, '#ff8a3a', 0.14 + i * 0.05); }
// ambient embers: 3 / 90 ms until the spin, 4 / 70 ms from the blast
const uwEmbers = emit(600, T2, T5, 90, 3, (r) => ({ x: r() * VW, y: VH * 0.5 + r() * (VH * 0.5 + 20), vx: (r() - 0.5) * 0.06, vy: -(0.05 + r() * 0.07), life: 1400 + r() * 1200, r: 2 + r() * 3, rgb: r() < 0.3 ? PINK : '255,140,60' }))
  .concat(emit(601, T_BLAST, T_RET, 70, 4, (r) => ({ x: r() * VW, y: VH * 0.4 + r() * (VH * 0.6 + 20), vx: (r() - 0.5) * 0.06, vy: -(0.05 + r() * 0.07), life: 1400 + r() * 1200, r: 2 + r() * 3, rgb: r() < 0.3 ? PINK : '255,160,60' })));
// background brightness / tint over time (mockup: brightness .55 base; spin -> 0; blast flare 1.7 -> .75)
function bgLook(now) {
  let b = 0.55, tint = 1, ex = 0;
  if (now >= T5) { const u = Math.min(1, (now - T5) / SPIN); b = 0.55 * (1 - u); tint = 1 - u; ex = -u * 360; }
  if (now >= T_BLAST) { const u = Math.min(1, (now - T_BLAST) / 1400); const k = E.outQ(u); b = k < 0.25 ? lerp(0, 1.7, k / 0.25) : lerp(1.7, 0.75, (k - 0.25) / 0.75); tint = Math.min(1, k * 2); ex = -360 * (1 - Math.min(1, u * 0.2)); }
  return { b, tint, ex };
}
// the painting, recoloured once (hue-rotate -35, saturate 1.5, contrast 1.1); brightness is applied per frame
let BG = null;
function bgCanvas() { if (BG) return BG; const img = tl.IMG.uwBg; if (!img) return null; const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height; if (!w) return null; const cv = document.createElement('canvas'); cv.width = w; cv.height = h; const x = cv.getContext('2d'); x.filter = 'hue-rotate(-35deg) saturate(1.5) contrast(1.1)'; x.drawImage(img, 0, 0); BG = cv; return BG; }
// a body drawn in virtual space: art at feet (x, y), height h, flip, alpha, optional flinch / filter / additive
function drawBody(g, P, art, x, y, h, flip, a, o) {
  o = o || {}; if (!art || a <= 0) return; vidPlay(art); const iw = art.naturalWidth || art.videoWidth || art.width || 1, ih = art.naturalHeight || art.videoHeight || art.height || 1;
  const q = P.map(x, y); const hh = h * q.k, w = hh * iw / ih; const fl = o.fl || null;
  g.save(); g.translate(q.x + (fl ? fl.dx * q.k : 0) + (o.ox || 0) * q.k, q.y + (o.oy || 0) * q.k); g.rotate(P.cm.r * Math.PI / 180); g.scale(flip * (fl ? fl.sx : 1) * (o.sx || 1), (fl ? fl.sy : 1) * (o.sy || 1)); g.globalAlpha = a;
  if (o.add) g.globalCompositeOperation = 'lighter'; if (o.filter) g.filter = o.filter;
  const footF = o.foot || 1;
  g.drawImage(art, -w / 2, -hh * footF, w, hh);
  if (o.black) { g.globalAlpha = a * o.black; g.filter = 'none'; g.globalCompositeOperation = 'source-over'; const bk = o.blackImg; if (bk) g.drawImage(bk, -w / 2, -hh * footF, w, hh); }
  if (fl && fl.b > 1.05 && o.white) { g.globalAlpha = a * Math.min(1, (fl.b - 1) / 3); g.globalCompositeOperation = 'source-over'; g.filter = 'none'; g.drawImage(o.white, -w / 2, -hh * footF, w, hh); }
  g.restore();
}
// ── the parade bodies (each returns draw jobs for a given now) ──
const sh = (k, fallbackH) => (k && TOK[k] ? vH(k) : fallbackH) * uwS(600) * 1.3;
const SUM_H = { fox: 120, minion: 150, leichi: 200, leilan: 210, crysta: 230 };
const MID = { x: UWC.x, y: UWC.y };
const X = (x) => x + (MID.x - 700), Y = (y) => y + (MID.y - 560);
const Mx = (x) => 2 * MID.x - X(x);
const ry = tl.rng(77);
const foxFrom = [{ x: 1700, y: 520 }, { x: 900, y: -160 }, { x: -180, y: 380 }, { x: 1500, y: 900 }, { x: 1700, y: 60 }];
const foxOrder = [0, 1, 2, 3, 4].sort(() => ry() - 0.5);
const bodyJobs = [];   // (now, P, g) => [{ z, draw }]
const shardSets = [];
const cinders = [];
plan.forEach((p) => {
  const s = p.s;
  if (s.kind === 'fox') {
    const from = foxFrom[foxOrder[s.i % 5]], tgt = { x: MID.x, y: MID.y - 95 };
    const nx = -(tgt.y - from.y), ny = tgt.x - from.x, nl = Math.hypot(nx, ny) || 1, bow = (110 + ry() * 100) * (ry() < 0.5 ? -1 : 1);
    const ctrl = { x: (from.x + tgt.x) / 2 + nx / nl * bow, y: (from.y + tgt.y) / 2 + ny / nl * bow };
    const at = (u) => { const v = 1 - u; return { x: v * v * from.x + 2 * v * u * ctrl.x + u * u * tgt.x, y: v * v * from.y + 2 * v * u * ctrl.y + u * u * tgt.y }; };
    const h = sh(s.key, SUM_H.fox), fl = tgt.x > from.x ? -1 : 1;
    const posAt = (now) => { const e = now - p.at; if (e < p.enter) return { q: at(0.2 * E.outQ(e / p.enter)), a: Math.min(1, e / 220) }; const u = E.inQ(Math.min(1, (e - p.enter) / p.fly)); return { q: at(0.2 + 0.8 * u), a: 1 }; };
    bodyJobs.push((now, P) => { if (now < p.at || now >= p.hit) return []; const art = artOf(s.key, 'foxfire'); const out = [];
      for (let j = 4; j >= 1; j--) { const tt = now - j * 30; if (tt < p.at + p.enter) continue; const o = posAt(tt); out.push({ z: 640, draw: (g) => drawBody(g, P, art, o.q.x, o.q.y, h, fl, 0.5 * (1 - j / 5), { add: true }) }); }
      const o = posAt(now); out.push({ z: 650, draw: (g) => drawBody(g, P, art, o.q.x, o.q.y, h, fl, o.a, { add: true }) }); return out; });
    say(p.at + p.enter, 'fire1', 0.45);
    // it explodes on the hit (subtle: a small pink fireball core + the magenta burst + 8 shards)
    uwClip('jbFire', p.hit, tgt, 0.5, false, { add: true, filter: 'hue-rotate(-62deg) saturate(1.5)', alpha: () => 0.7 });
    uwClip('magBurst', p.hit, tgt, 1.05, false, { add: true });
    uwShards(p.hit, tgt, '255,120,200', 8, 0.45);
    say(p.hit, 'explode', 0.26); say(p.hit, 'hitfire', 0.4);
  } else if (s.kind === 'minion') {
    const h = sh(s.key, SUM_H.minion);
    const fade = p.at + p.fade, creepEnd = fade + p.creep, lungeEnd = creepEnd + p.lunge;
    bodyJobs.push((now, P) => { if (now < p.at || now >= p.shat) return []; const art = artOf(s.key, null); if (!art) return [];
      let x, y, oy = 0, a = 1; if (now < fade) { x = X(1180); y = Y(700); a = (now - p.at) / p.fade; }
      else if (now < creepEnd) { const k = (now - fade) / p.creep; x = lerp(X(1180), X(1000), k); y = lerp(Y(700), Y(690), k); oy = -Math.abs(Math.sin(k * Math.PI * 3)) * 6; }
      else if (now < lungeEnd) { const k = E.inQ((now - creepEnd) / p.lunge); x = lerp(X(1000), X(840), k); y = lerp(Y(690), Y(640), k); }
      else if (now < p.back) { x = X(840); y = Y(640); }
      else { const k = E.outQ(Math.min(1, (now - p.back) / (PER * 0.2))); x = lerp(X(840), X(1000), k); y = lerp(Y(640), Y(690), k); }
      return [{ z: y, draw: (g) => drawBody(g, P, art, x, y, h, s.key ? (TOK[s.key].flip || 1) : -1, a, { oy, filter: s.key ? null : 'grayscale(.7) sepia(.5) hue-rotate(60deg) brightness(.7) contrast(1.2)' }) }]; });
    uwClip('dark', p.at, { x: X(1180), y: Y(650) }, 0.8, false, { add: true }); say(p.at, 'dark2', 0.5);
    uwClip('slash3', p.hit, { x: X(740), y: Y(560) }, 1.1, false, { tint: '#7cff6a', flip: true });
    uwClip('dark', p.hit, MID, 1, false, { add: true }); say(p.hit, 'swingB', 0.45);
    uwShatter(p.shat, () => ({ x: X(1000), y: Y(690) }), h, '150,220,140');
  } else if (s.kind === 'twins') {
    const TWS = t.twinScale || 0.55; // user 11-06: the twins read too big in the attack (1.0 -> 0.8 still too big; 0.55 = ~1.3x a dummy)
    const ha = sh(s.ka, SUM_H.leichi) * TWS, hb = sh(s.kb, SUM_H.leilan) * TWS;
    const showA = true, showB = true; // mandatory: real token art when on the field, else the standard art
    const enterEnd = p.at + p.enter, dashEnd = p.hit;
    const pathA = (now) => now < enterEnd ? { x: lerp(X(1500), X(1080), E.outQ((now - p.at) / p.enter)), y: lerp(Y(430), Y(450), E.outQ((now - p.at) / p.enter)) } : now < dashEnd ? { x: lerp(X(1080), X(300), E.inQ((now - enterEnd) / p.dash)), y: lerp(Y(450), Y(700), E.inQ((now - enterEnd) / p.dash)) } : { x: X(300), y: Y(700) };
    const pathB = (now) => now < enterEnd ? { x: lerp(Mx(1500), Mx(1080), E.outQ((now - p.at) / p.enter)), y: lerp(Y(720), Y(700), E.outQ((now - p.at) / p.enter)) } : now < dashEnd ? { x: lerp(Mx(1080), Mx(300), E.inQ((now - enterEnd) / p.dash)), y: lerp(Y(700), Y(450), E.inQ((now - enterEnd) / p.dash)) } : { x: Mx(300), y: Y(450) };
    const alpha = (now) => now < p.at + 250 ? (now - p.at) / 250 : now < p.out ? 1 : Math.max(0, 1 - (now - p.out) / 350);
    bodyJobs.push((now, P) => { if (now < p.at || now >= p.end) return []; const out = []; const a = alpha(now);
      if (showA) { const q = pathA(now); const art = artOf(s.ka, 'leichi'); out.push({ z: 650, draw: (g) => drawBody(g, P, art, q.x, q.y, ha, s.ka ? (TOK[s.ka].flip || 1) : 1, a) }); }
      if (showB) { const q = pathB(now); const art = artOf(s.kb, 'leilan'); out.push({ z: 720, draw: (g) => drawBody(g, P, art, q.x, q.y, hb, s.kb ? -(TOK[s.kb].flip || 1) : -1, a) }); }
      return out; });
    say(enterEnd, 'dashA', 0.4);
    uwClip('slash1', p.hit, MID, 1.3, false, { tint: '#9cffd8', add: true, rot: 35 * Math.PI / 180 });
    uwClip('slash1', p.hit, MID, 1.3, false, { tint: '#9cffd8', add: true, rot: -35 * Math.PI / 180, flip: true });
    say(p.hit, 'swing', 0.5); say(p.hit + 90, 'swingB', 0.45);
  } else if (s.kind === 'crysta') {
    const h = sh(s.key, SUM_H.crysta);
    const xAt = (now) => { let x = X(1060); for (let i = 0; i < 2; i++) { const st = p.stab[i]; const tgt = lerp(X(1060), X(820), (i + 1) / 2); const from = i ? lerp(X(1060), X(820), 0.5) : X(1060); if (now >= st.mv) x = lerp(from, tgt, E.outQ(Math.min(1, (now - st.mv) / (PER * 0.1)))); } return x; };
    const knifeAt = (now) => { let ext = 0, tilt = 0; for (let i = 0; i < 2; i++) { const st = p.stab[i]; if (now >= st.mv && now < st.th) { const k = E.outQ(Math.min(1, (now - st.mv) / 140)); ext = -18 * k; tilt = -12 * k; } else if (now >= st.th && now < st.hit) { const k = E.outC((now - st.th) / 90); ext = lerp(-18, 78, k); tilt = lerp(-12, i ? 6 : -4, k); } else if (now >= st.hit && now < st.hit + 180) { const k = E.inQ((now - st.hit) / 180); ext = lerp(78, 0, k); tilt = lerp(i ? 6 : -4, 0, k); } } return { ext, tilt }; };
    bodyJobs.push((now, P) => { if (now < p.at || now >= p.shat) return []; const art = artOf(s.key, 'crysta'); const a = Math.min(1, (now - p.at) / p.fade); const x = xAt(now), y = Y(610);
      const out = [{ z: 660, draw: (g) => drawBody(g, P, art, x, y, h, s.key ? (TOK[s.key].flip || 1) : 1, a) }];
      // her knife: Disgaea 5 sword parts (blade _00 over grip _01), 32% of her height, at her front hand, pointed at the targets
      out.push({ z: 661, draw: (g) => { const bl = tl.IMG.knifeBlade, gr = tl.IMG.knifeGrip; if (!bl || !gr || a <= 0) return; const b = ZP.limbInfo(bl), gi = ZP.limbInfo(gr); const kn = knifeAt(now);
        const gl = gi.joint.y - gi.tip.y, bln = b.joint.y - b.tip.y; const hand = P.map(x - h * 0.17 - kn.ext, y - h * 0.5); const kk = h * 0.32 / (bln + gl) * hand.k;
        g.save(); g.translate(hand.x, hand.y); g.rotate((-90 + kn.tilt + P.cm.r) * Math.PI / 180); g.globalAlpha = a; g.shadowColor = 'rgba(190,225,255,.7)'; g.shadowBlur = 4;
        g.drawImage(bl, -b.joint.x * kk, (-gl / 2 - b.joint.y) * kk, (bl.naturalWidth || bl.width) * kk, (bl.naturalHeight || bl.height) * kk);
        g.drawImage(gr, -gi.tip.x * kk, (-gl / 2 - gi.tip.y) * kk, (gr.naturalWidth || gr.width) * kk, (gr.naturalHeight || gr.height) * kk); g.restore(); } });
      return out; });
    uwClip('pillar', p.at, { x: X(1060), y: Y(610) }, 0.7, false, { add: true, filter: 'hue-rotate(180deg) brightness(1.2)' }); say(p.at, 'saint5', 0.45);
    p.stab.forEach((st, i) => { say(st.mv + PER * 0.1, 'swing', 0.3); say(st.hit, 'shing', 0.4); uwClip('slash3', st.hit, { x: X(700), y: Y(520) }, 1.6, false, { tint: '#bfe4ff', add: true, rot: (i ? -20 : 15) * Math.PI / 180, flip: !!i }); });
    uwClip('twinkle', p.twk, { x: X(820), y: Y(610) - h * 0.5 }, 0.9, false, { tint: '#bfe4ff', add: true });
    uwShatter(p.shat, () => ({ x: X(820), y: Y(610) }), h, '190,225,255');
  }
});
// every parade strike: the static camera's white flash + a shake (camPunch 1)
plan.forEach((p) => { const list = p.s.kind === 'crysta' ? p.stab.map((s2) => s2.hit) : [p.hit]; list.forEach((h) => { m.flash(h, 20, 120, '#ffffff', 0.8); m.shake(h, p.s.kind === 'twins' ? 260 : 220, p.s.kind === 'twins' ? 10 : 8); }); });

// ── underworld clips: m.clip in screen mode, placed through the underworld camera ──
function uwClip(key, at, pt, scale, ro, o) {
  o = o || {}; const def = CL[key]; if (!def) return;
  const hv = def.h * scale * (ro ? 1.1 : 0.55);
  m.clip(key, at, { screen: { x: 0.5, y: 0.5 }, wh: 0.1, add: !!o.add, tint: o.tint, filter: o.filter, flip: !!o.flip, loop: !!o.loop, hold: o.hold, sy: o.sy, alpha: o.alpha,
    live: (tl2, S, g) => { const P = proj(curNow, g.W, g.H); const pp = typeof pt === 'function' ? pt(curNow) : pt; const q = P.map(pp.x, pp.y); return { x: q.x, y: q.y, wh: hv * q.k / g.H, rot: (o.rot || 0) + P.cm.r * Math.PI / 180, sy: o.sy }; } });
}
// shards (and a homing cinder stream into the den) for a summon that shatters
function uwShards(at, pt, rgb, n, spread) { const r = tl.rng(900 + shardSets.length); const L = []; for (let i = 0; i < n; i++) { const an = r() * 6.2832, sp = 0.15 + r() * (spread - 0.15); L.push({ vx: Math.cos(an) * sp, vy: Math.sin(an) * sp - 0.2, life: 600 + r() * 400, rot: r() * 6, vr: (r() - 0.5) * 0.04, s: 5 + r() * 6 }); } shardSets.push({ at, pt, rgb, L }); }
function uwShatter(at, ptFn, h, rgb) {
  say(at, 'crystal', 0.35); m.flash(at, 20, 100, '#ffffff', 0.25);
  const p = ptFn(); uwShards(at, { x: p.x, y: p.y - h * 0.5 }, rgb, 18, 0.55);
  const r = tl.rng(1200 + cinders.length); for (let i = 0; i < 16; i++) cinders.push({ at, from: { x: p.x + (r() - 0.5) * 60, y: p.y - r() * h }, ms: 700 + r() * 300, arc: 160, cx: (r() - 0.5) * 320, cy: 50 + r() * 110, rgb: r() < 0.5 ? '255,140,60' : rgb });
  say(at + 600, 'fire1', 0.25);
}
// the finale bits: Keren's fire portal, her cast circle, the channel circle, the ring, the blast
const KPORT = portalOf({ x: P0.x, y: P0.y }, 1.35, { rgb: '255,90,60', hot: '255,170,210' });
const kportFlames = portalFlames(1400, KPORT, T_PORTAL, T_KSTOP);
say(T_PORTAL, 'fire3', 0.5); say(T_PORTAL, 'dark4', 0.35);
uwClip('magBurst', T_KAPP, { x: P0.x, y: P0.y - 40 }, 1.1, false, { add: true });
const kEmbers = emit(1500, T_KAPP, T_KAPP + 1, 1, 14, (r) => ({ x: P0.x + (r() - 0.5) * 100, y: P0.y - r() * KREN.h * 0.7, vx: (r() - 0.5) * 0.06, vy: -(0.08 + r() * 0.17), life: 1400 + r() * 1200, r: 2 + r() * 3, rgb: r() < 0.4 ? PINK : ORANGE }));
say(T_KWALK, 'move1', 0.55);
say(T_KSTOP, 'magic3', 0.5);
uwClip('hellCast', T_KSTOP, { x: KREN.x, y: KREN.y }, 0.9, true, { add: true, loop: true, hold: T5 - T_KSTOP + 200, sy: 0.5, filter: 'hue-rotate(-40deg) saturate(1.4)', alpha: (u) => { const e = u * (T5 - T_KSTOP + 200); return e > T5 - T_KSTOP ? Math.max(0, 1 - (e - (T5 - T_KSTOP)) / 200) : Math.min(1, e / 200); } });
say(T5, 'wind7', 0.5); say(T5, 'dark4', 0.4);
// channel circle: RO efst_magiccircle__mc tinted fire-pink, flat beneath her from the ring forming until after the blast
const kcAt = () => { const k = kerenState(T6) || { x: KREN.x, y: KREN.y }; return { x: k.x, y: k.y - 4 }; };
const KC_END = T_BLAST + 1400;
say(T6, 'magic3', 0.45);
uwClip('mc', T6, () => kcAt(), 2.6, true, { add: true, loop: true, hold: KC_END + 500 - T6, sy: 0.34, filter: 'sepia(1) saturate(5) hue-rotate(297deg) brightness(1.45)', alpha: (u) => { const e = u * (KC_END + 500 - T6); return e < 400 ? E.outQ(e / 400) : e > KC_END - T6 ? Math.max(0, 1 - (e - (KC_END - T6)) / 500) : 1; } });
const kcMotes = emit(1600, T6, KC_END, 60, 1, (r) => { const p = kcAt(); return { x: p.x + (r() - 0.5) * 220, y: p.y + (r() - 0.5) * 28, vx: (r() - 0.5) * 0.03, vy: -(0.1 + r() * 0.12), life: 1400 + r() * 1200, r: 2 + r() * 3, rgb: r() < 0.5 ? PINK : '255,160,70' }; });
// the ring: the den splits into fox fires around the targets, circles, tightens, rushes in
say(T6, 'fire3', 0.55); m.flash(T6, 30, 250, '#ff5ab0', 0.35);
say(T_RINGIN, 'dark2', 0.4); say(T_RUSH, 'wind4', 0.5);
const ringCen = () => { const fs = FOES.map((F) => foeState(F, T6)).filter(Boolean); return fs.length ? centroid(fs) : MID; };
const RING = () => { const cc = ringCen(); return { x: cc.x, y: cc.y - 40, rx: 300, ry: 105 }; };
// user 11-06: the ring shot and the blast frame the RING (the targets after the spin), not the
// pre-spin cluster centre, which sits toward Keren. CAMS[5] = T6, CAMS[6] = T_BLAST.
{ const rc = ringCen(); Object.assign(CAMS[5].to, { x: rc.x, y: rc.y - 120 }); Object.assign(CAMS[6].to, { x: rc.x, y: rc.y - 150 }); }
const ringEmbers = emit(1700, T_RINGIN, T_RUSH, 160, 1, (r) => { const R = RING(); return { x: R.x + (r() - 0.5) * 2 * R.rx, y: R.y - 20 + r() * 50, vx: (r() - 0.5) * 0.06, vy: -(0.05 + r() * 0.07), life: 1400 + r() * 1200, r: 2 + r() * 3, rgb: PINK }; });
function ringFoxes(now) {
  if (now < T6 || now >= T_BLAST) return [];
  const R = RING(); const d0 = denState(T6 - 1) || { x: UWC.x, y: UWC.y - 270 }; const H0 = 120 * uwS(ringCen().y) * 1.3 * (t.ringFoxScale || 0.7); /* user 11-06: ring foxes read too big */
  const out = []; let spinA = 0, r = 1, hk = 1;
  if (now >= T_RINGIN) { const u = Math.min(1, (now - T_RINGIN) / RINGMS); spinA = u * Math.PI * 1.2; r = lerp(1, 0.78, E.inQ(u)); }
  if (now >= T_RUSH) { const u = E.inC(Math.min(1, (now - T_RUSH) / 260)); spinA = Math.PI * 1.2; r = 0.78 * (1 - u); hk = 1 + u * 0.5; }
  for (let i = 0; i < RINGN; i++) { const a0 = i / RINGN * Math.PI * 2 + spinA; const qx = R.x + Math.cos(a0) * R.rx * r, qy = R.y + Math.sin(a0) * R.ry * r; const front = Math.sin(a0) > 0;
    let x = qx, y = qy, h = H0 * hk, a = 1;
    if (now < T_RINGIN) { const k = E.outC((now - T6) / 700); x = lerp(d0.x, qx, k); y = lerp(d0.y, qy, k); h = lerp(30, H0, k); a = k; }
    else if (now < T_RUSH) { y += Math.sin(now / 90 + i) * 4; a = 0.85 + Math.sin(now / 50 + i * 2) * 0.15; }
    out.push({ z: front ? 950 : 400, x, y, h, a }); }
  return out;
}
// the blast: ground eruption column (MV 070), fireball cores (JB2A), D4 fire explosion; half-transparent black silhouettes ABOVE the fire
say(T_BLAST, 'amalthea', 0.85); say(T_BLAST, 'explode2', 0.7); say(T_BLAST + 200, 'fire3', 0.6);
m.flash(T_BLAST, 30, 200, '#ffffff', 1); m.shake(T_BLAST, 900, 24);
const BC = () => ringCen();
uwClip('fireAll', T_BLAST, () => ({ x: BC().x, y: BC().y - 380 }), 1500 / (1082 * 0.55), false, {});
uwClip('jbFire', T_BLAST, () => ({ x: BC().x, y: BC().y - 90 }), 2.4, false, { add: true });
uwClip('jbFire', T_BLAST + 160, () => ({ x: BC().x + 170, y: BC().y - 40 }), 1.3, false, { add: true });
uwClip('jbFire', T_BLAST + 260, () => ({ x: BC().x - 180, y: BC().y - 20 }), 1.1, false, { add: true });
uwClip('fireExp', T_BLAST, () => ({ x: BC().x, y: BC().y - 60 }), 3.4, false, { add: true });
let curNow = 0;
m.hold(T_BLAST, T_RET, (e, S) => { const now = e + T_BLAST; S.screen.push({ draw: (g) => { const P = proj(now, g.W, g.H); for (const F of FOES) { const st = foeState(F, now); if (!st) continue; const blk = tl.tinted(F.k, '#000'); if (!blk) continue; drawBody(g, P, blk, st.x, st.y, st.h, st.flip, 0.5); } } }); });

// ── the underworld frame: one screen-space draw, under the clips (registered before them in time order) ──
const uwTrack = (e, S) => {
  const now = e + UW_ON; curNow = now;
  S.screen.unshift({ draw: (g) => {
    const W = g.W, H = g.H; const P = proj(now, W, H); const look = bgLook(now);
    // 0. black base
    g.save(); g.fillStyle = '#000'; g.fillRect(-20, -20, W + 40, H + 40); g.restore();
    // 1. the painting (1.4x bleed), with a parallax shift opposite the camera pan and the spin sweep
    const bg = bgCanvas();
    if (bg) { const px = -(P.cm.x - VW / 2) * 0.3 + look.ex, py = -(P.cm.y - VH / 2) * 0.3; const tl0 = P.map(-VW * 0.2 + px, -VH * 0.2 + py); g.save(); g.translate(tl0.x, tl0.y); g.rotate(P.cm.r * Math.PI / 180); g.drawImage(bg, 0, 0, VW * 1.4 * P.k, VH * 1.4 * P.k);
      if (look.b < 1) { g.globalAlpha = 1 - look.b; g.fillStyle = '#000'; g.fillRect(0, 0, VW * 1.4 * P.k, VH * 1.4 * P.k); }
      else if (look.b > 1) { g.globalAlpha = Math.min(1, look.b - 1); g.globalCompositeOperation = 'lighter'; g.drawImage(bg, 0, 0, VW * 1.4 * P.k, VH * 1.4 * P.k); }
      g.restore(); }
    // 2. heat + fog tint
    if (look.tint > 0) { g.save(); g.globalAlpha = look.tint;
      const hc = P.map(VW * 0.5, VH * 0.72); const R = Math.max(W, H) * 0.9; let gr = g.createRadialGradient(hc.x, hc.y, 0, hc.x, hc.y, R); gr.addColorStop(0, 'rgba(255,90,30,0.14)'); gr.addColorStop(0.5, 'rgba(120,10,30,0.06)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.globalCompositeOperation = 'lighter'; g.fillStyle = gr; g.fillRect(-20, -20, W + 40, H + 40);
      g.globalCompositeOperation = 'source-over'; gr = g.createLinearGradient(0, H, 0, H * 0.4); gr.addColorStop(0, 'rgba(40,0,20,0.7)'); gr.addColorStop(1, 'rgba(40,0,20,0)'); g.fillStyle = gr; g.fillRect(-20, H * 0.4, W + 40, H * 0.6 + 20); g.restore(); }
    // 3. ground: Keren's portal hole + her cast circle glow
    if (now >= T_PORTAL && now < T_KSTOP + 400) { const o = portalOpen(now, T_PORTAL, T_KSTOP); const q = P.map(KPORT.pt.x, KPORT.pt.y); drawPortalHole(g, { pt: q, s: KPORT.s * P.k, rx: KPORT.rx, ry: KPORT.ry, rgb: KPORT.rgb, hot: KPORT.hot }, o); }
    if (now >= T6 && now < KC_END + 500) { const k0 = kcAt(); const q = P.map(k0.x, k0.y); const a = now < T6 + 400 ? (now - T6) / 400 : now > KC_END ? Math.max(0, 1 - (now - KC_END) / 500) : 1; g.save(); g.globalCompositeOperation = 'lighter'; g.globalAlpha = a; g.translate(q.x, q.y); g.scale(1, 0.32); const gr = g.createRadialGradient(0, 0, 0, 0, 0, 170 * P.k); gr.addColorStop(0, 'rgba(255,120,190,0.55)'); gr.addColorStop(0.55, 'rgba(255,90,60,0.25)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.beginPath(); g.arc(0, 0, 170 * P.k, 0, 6.2832); g.fill(); g.restore(); }
    // 4. bodies, sorted by layer: foes, Keren, the parade, the ring
    const jobs = [];
    const sinceHit = lastHitBefore(now);
    FOES.forEach((F, i) => { const st = foeState(F, now); if (!st) return; const art = tl.art(F.k); const fl = (now >= T3 && sinceHit >= 0) ? ZP.flinchAt(sinceHit, 'normal') : null; const hurt = tl.IMG['hurt' + i];
      const useArt = (fl || (sinceHit >= 0 && sinceHit < 700 && now >= T3)) && hurt ? hurt : art; const ringZ = now >= T6 ? 700 + st.y / 10 : st.z;
      jobs.push({ z: ringZ, draw: (g2) => drawBody(g2, P, useArt, st.x, st.y, st.h, st.flip, 1, { fl, white: tl.tinted(F.k, '#fff') }) }); });
    const ks = kerenState(now); if (ks) { const art = ks.pose === 'walk' ? (tl.IMG.kerenWalk || tl.art('c')) : ks.pose === 'back' ? (tl.IMG.kerenBack || tl.art('c')) : tl.art('c');
      jobs.push({ z: now >= T6 ? 690 : ks.z, draw: (g2) => drawBody(g2, P, art, ks.x, ks.y, ks.h, ks.flip, ks.a, { oy: ks.oy }) }); }
    for (const job of bodyJobs) for (const j of job(now, P)) jobs.push(j);
    for (const rf of ringFoxes(now)) jobs.push({ z: rf.z, draw: (g2) => drawBody(g2, P, tl.IMG.foxfire, rf.x, rf.y, rf.h, 1, rf.a, { add: true }) });
    jobs.sort((a, b) => a.z - b.z); for (const j of jobs) j.draw(g);
    // 5. the den
    const d = denState(now); if (d) { const q = P.map(d.x, d.y); const r = 30 * d.s * P.k; const fl = 1 + Math.sin(now / 70) * 0.06; g.save(); g.globalCompositeOperation = 'lighter'; ZP.glow(g, q.x, q.y, r * 3.2 * fl, '255,80,30', 0.55); ZP.glow(g, q.x, q.y, r * 1.6 * fl, '255,170,70', 0.9); ZP.glow(g, q.x, q.y, r * 0.7, '255,250,220', 1); g.restore(); }
    // 6. particles: embers, portal flames, shards, cinders
    const mapV = (x, y) => P.map(x, y);
    drawEmbers(g, uwEmbers, now, mapV); drawEmbers(g, kEmbers, now, mapV); drawEmbers(g, kcMotes, now, mapV); drawEmbers(g, ringEmbers, now, mapV);
    if (now >= T_PORTAL && now < T_KSTOP + 800) drawFlames(g, kportFlames, now, mapV);
    g.save(); g.globalCompositeOperation = 'lighter';
    for (const set of shardSets) { const e2 = now - set.at; if (e2 < 0 || e2 > 1000) continue; for (const s2 of set.L) { const u = e2 / s2.life; if (u >= 1) continue; const x = set.pt.x + s2.vx * e2, y = set.pt.y + s2.vy * e2 + 0.0006 * e2 * e2; const q = P.map(x, y); g.save(); g.translate(q.x, q.y); g.rotate(s2.rot + s2.vr * e2); g.globalAlpha = 1 - u; const sz = s2.s * P.k; const gr = g.createLinearGradient(-sz, -sz, sz, sz); gr.addColorStop(0, '#fff'); gr.addColorStop(1, 'rgb(' + set.rgb + ')'); g.fillStyle = gr; g.beginPath(); g.moveTo(0, -sz); g.lineTo(sz * 0.6, 0); g.lineTo(0, sz * 0.9); g.lineTo(-sz * 0.5, 0); g.fill(); g.restore(); } }
    const dn = denState(now) || { x: UWC.x, y: UWC.y - 230 };
    for (const cd of cinders) { const e2 = now - cd.at; if (e2 < 0 || e2 > cd.ms) continue; const u = E.inQ(e2 / cd.ms), v = 1 - u; const cx = (cd.from.x + dn.x) / 2 + cd.cx, cy = Math.min(cd.from.y, dn.y) - cd.cy; const x = v * v * cd.from.x + 2 * v * u * cx + u * u * dn.x, y = v * v * cd.from.y + 2 * v * u * cy + u * u * dn.y; const q = P.map(x, y); ZP.glow(g, q.x, q.y, 3 * 3.5 * P.k, cd.rgb, 0.95); }
    g.restore();
    // 7. the underworld's own black: in at the switch (black -> scene over 300 ms)
    let bk = 0; if (now < T2 + 300) bk = 1 - (now - T2) / 300; if (bk > 0) { g.save(); g.globalAlpha = bk; g.fillStyle = '#000'; g.fillRect(-20, -20, W + 40, H + 40); g.restore(); }
  } });
};
// register: the frame first (so its S.screen push precedes the clips), then everything else already queued
T.unshift({ t0: UW_ON, t1: UW_OFF, fn: (tl2, S) => uwTrack(tl2, S) });
// foes land: dust + Fall + a small shake
FOES.forEach((F, i) => { say(T_LAND(i), 'fall', 0.3); uwClip('smoke', T_LAND(i), { x: F.x, y: F.y0 - 10 }, 0.55, false, { tint: '#3a1810', alpha: () => 0.8 }); m.shake(T_LAND(i), 200, 5); });
say(T2, 'dark2', 0.5);

// ── the ticks: parade strikes, the blast, the last hit (Chain cues, numbers anchored where the foes are drawn) ──
const anchorAt = (now) => { const V = tl.view(); const P = proj(now, V.W, V.H); const out = {}; FOES.forEach((F) => { const st = foeState(F, now); if (!st) return; const q = P.map(st.x, st.y - st.h * 0.62); const tk = TOK[F.k].token; if (tk && tk.document) out[tk.document.uuid] = { fx: q.x / V.W, fy: q.y / V.H }; }); return out; };
hits.forEach((h) => ZP.hit(m, h, () => ({ numbersOnly: true, screenAt: anchorAt(h) })));
ZP.hit(m, T_BLAST, () => ({ numbersOnly: true, screenAt: anchorAt(T_BLAST) }));

// ═════════ WHITEOUT + THE LAST HIT ON THE BOARD ═════════
m.hold(T7, T_RET + 500, (e, S) => { const now = e + T7; let w; if (now < T_WHITE) w = (now - T7) / 220; else if (now < T_RET) w = 1; else w = 1 - E.sine((now - T_RET) / 500); S.flash = { a: Math.max(S.flash.a, w), c: '#ffffff' }; });
// they fall from above the top of the view into their places, one after another, and slam down
say(T_FALL0, 'wind4', 0.4);
TG.forEach((k, i) => {
  const t0 = T_FALL0 + i * 90;
  m.hold(T_RET, t0 + DROP, (e, S) => { const now = e + T_RET; const q = S.tok[k]; if (!q) return; const v = tl.camView(S); const f = tl.feet(TOK[k]); const d0 = -(f.y - v.top) - 60 / (v.scale || 1);
    if (now < t0) { q.hidden = true; return; } q.dy += d0 * (1 - E.inQ((now - t0) / DROP)); });
  say(t0 + DROP, 'fall', 0.45);
  const f = tl.feet(TOK[k]); m.clip('smoke', t0 + DROP, { x: f.x, y: f.y, w: cw('smoke', 0.65, false) * MPX, z: 12, tint: '#4a3a30', alpha: (u) => 0.85 * (1 - u) });
  m.shake(t0 + DROP, 160, 5);
});
// the last hit: Damage2, a fire burst on each, the hurt reaction + number, their sprites shake a little
m.shake(T_FINAL, 380, 14); say(T_FINAL, 'damage2', 0.9);
TG.forEach((k, i) => { const T0 = TOK[k]; const mid = { x: T0.x, y: tl.feet(T0).y - T0.h * 0.5 }; m.clip('fireExp', T_FINAL, { x: mid.x, y: mid.y, w: cw('fireExp', 1.1, false) * MPX, z: 55, add: true });
  ZP.flinchTok(m, T_FINAL, k, 'normal', 700);
  m.hold(T_FINAL, T_FINAL + 460, (e, S) => { const q = S.tok[k]; if (q) q.dx += Math.sin(e / 460 * 55 + i) * 4 * MPX * (1 - e / 460); }); });
ZP.hit(m, T_FINAL, { numbersOnly: true, screenAt: null });
// The gate opens just after the last hit, so RESOLVE writes HP and destroys the shattered
// Phantasms / Numen while the tail (the party fading back) still covers them; otherwise the
// real summon tokens would flash back for a moment between the teardown and RESOLVE.
ZP.once(m, T_FINAL + 450, () => oni.fireDone());

await tl.run(T, { total: TOTAL, sfx, onStart: K.ready });
oni.fireDone();
