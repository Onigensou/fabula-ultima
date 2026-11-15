// Rauben · Zero Power: Night of Hundred Bandits (inner script, every client).
// Port of the shipped script as the legacy-boss mockup re-tuned it (part-b3.js "hundred" + part-r3 / r4 / r5 / r7):
// the shipped Zero Power cut-in over a .55 dim, Rauben turns to his gang and throws a tantrum, then a 9 s stampede
// of bandits pours across the WHOLE floor (far rows small, near rows big) in dust and smoke while every PC holds
// its hurt pose and flinches non-stop; the final Berserker stomps up and stops in front of the party, leaps, trips
// in the air, the screen whites out right before he lands, the slam is heard in the white, the white holds, the
// gate fires, the white lifts. FULL TAKEOVER (not the live board): the shot drives the camera, so the 2.1x zoom into
// the slam plays, and the camera snaps back to rest while the screen is still white (r7). No fist hit VFX
// (removed in review). No backticks in this file.
if (!caster || !targets.length) { readyHook(); oni.fireDone(); return; }
const tokens = { k: { token: caster, foot: cfg.casterFoot } };
const PARTY = [];
targets.forEach((t, i) => { const k = 't' + i; PARTY.push(k); tokens[k] = { token: t, foot: cfg.partyFoot }; });
const tl = oni.timeline({ tokens, clips: {}, images: A.images || {} });
await tl.load();
const T = [];
const RK = RKit(tl, T);
const E = tl.E, seg = tl.seg, lerp = tl.lerp, TOK = tl.TOK, feet = tl.feet;
const KP = RK.KP, m = RK.m, rnd = RK.rnd, R = RK.R;
const C = cfg.t;
const K = TOK.k, kf = feet(K);
const PF = PARTY.map((k) => feet(TOK[k]));
const PC = { x: PF.reduce((s, f) => s + f.x, 0) / PF.length, y: PF.reduce((s, f) => s + f.y, 0) / PF.length };
const DIR = PC.x >= kf.x ? 1 : -1;
const NEAR = DIR > 0 ? Math.min(...PF.map((f) => f.x)) : Math.max(...PF.map((f) => f.x));
const IMP = { x: PC.x, y: PC.y };                     // the slam lands in the middle of the party
const ed = RK.edges();
const BACK_EDGE = DIR > 0 ? ed.left : ed.right, FRONT_EDGE = DIR > 0 ? ed.right : ed.left;
const ST = C.stampede, DUR = cfg.stampedeMs, SLAM = C.slam, CLEAR = SLAM + cfg.jumpMs + 60, GATE = CLEAR + cfg.whiteHold;

// ── the smoke cloud clip, decoded once and tinted (sepia .7, brightness .85) in the background ──
let SMOKE = null;
(async () => { try { const d = await tl.decode(A.smoke.url, { fps: 15 }); const fr = d.frames.map((f) => { const c = document.createElement('canvas'); c.width = f.width; c.height = f.height; const x = c.getContext('2d'); x.filter = 'sepia(.7) brightness(.85)'; x.drawImage(f, 0, 0); return c; }); SMOKE = { frames: fr, dur: A.smoke.dur }; } catch (e) { SMOKE = null; } })();

// ── cut-in + dim (the dim sits under the battlers) ──
ZP.cutin(tl, m, 0, 'cut');
RK.snd(0, 'overdrive', 0.9);
m.hold(0, CLEAR + 10, (t, S) => { const a = t < CLEAR ? cfg.dim * E.sine(seg(t, 0, 180)) : cfg.dim * (1 - seg(t, CLEAR, CLEAR + 10)); S.dim = Math.max(S.dim, a); });

// ── Rauben: turns to his gang, tantrum, turns back 500 ms into the stampede ──
const TURN = C.turn, TAN = TURN + cfg.flipMs, TAN_END = TAN + cfg.tantrumMs, BACKF = ST + cfg.waitFlipBack;
m.hold(TURN, BACKF + cfg.flipMs, (tt, S) => { const t = tt + TURN, d = S.tok.k;
  if (t < TAN) d.sx = lerp(1, -1, E.ioC(seg(t, TURN, TAN)));
  else if (t < BACKF) d.sx = -1;
  else d.sx = lerp(-1, 1, E.ioC(seg(t, BACKF, BACKF + cfg.flipMs)));
  if (t >= TAN && t < TAN_END) { const e = E.ioC(seg(t, TAN, TAN_END)); d.dx = Math.sin(e * Math.PI * 2 * cfg.cycles) * cfg.ampX * KP; d.air = Math.abs(Math.sin(e * Math.PI * 4)) * cfg.ampY * KP; } });

// ── the stampede ──
RK.snd(ST, 'crowd', 0.45 / 0.75, { fadeAfter: C.crowdFade - ST, fadeMs: cfg.crowdFadeMs });
const ARTS = ['bandit', 'mage', 'berserker', 'archer'];
const MIDX = tl.STAGE.x + tl.STAGE.w / 2;
const every = Math.max(18, cfg.spawnEvery / cfg.density);
for (let at = ST; at < ST + DUR; at += every) {
  const art = RK.pick(ARTS), img = tl.IMG[art]; if (!img) continue;
  const y01 = rnd(cfg.rowMin, cfg.rowMax), d = RK.floor(MIDX, tl.STAGE.y + y01 * tl.STAGE.h), s = d.s;
  const h = RK.banditH(img, cfg.bsc[art] || 1.34, s) * rnd(0.9, 1.1), extra = Math.max(120 * KP, h * 0.5);
  const ms = rnd(cfg.runMin, cfg.runMax) * (1.1 - 0.2 * y01);
  const z = d.y < IMP.y - 30 * KP ? 3 : 20;
  RK.runner(at, { img, dir: DIR, x0: BACK_EDGE - DIR * extra, x1: FRONT_EDGE + DIR * extra, y: d.y, y1: d.y + rnd(-8, 8) * KP, h, ms, ease: E.ioC, fade: 80, z,
    bob: (u) => Math.abs(Math.sin(u * Math.PI * 7)) * 6 * s * KP,
    trail: 30, trailSpec: (p) => ({ x: p.x - DIR * h * 0.15, y: p.y - 4 * KP, vx: -DIR * rnd(0.02, 0.08) * KP, vy: -rnd(0.005, 0.03) * KP, life: rnd(500, 900), rr: rnd(6, 14) * s * 1.4 * KP, rgb: '185,165,135', a0: 0.42, grow: 1.4 }) });
}
// rolling smoke clouds over the lane + dust on a party member every 160-300 ms
const CLOUDS = [];
for (let at = ST; at < ST + DUR; at += rnd(160, 300)) {
  const y01 = rnd(0.3, 0.95), d = RK.floor(MIDX, tl.STAGE.y + y01 * tl.STAGE.h);
  CLOUDS.push({ at, x: rnd(ed.left + 80 * KP, ed.right - 80 * KP), y: d.y, w: 228 * 0.55 * rnd(0.8, 1.4) * d.s * KP });
  const k = RK.pick(PARTY), f = feet(TOK[k]); RK.dust(at, f, 5, RK.floor(f.x, f.y).s / RK.floor(kf.x, kf.y).s, null, 24);
}
m.hold(ST, CLEAR, (tt, S) => { if (!SMOKE) return; const t = tt + ST; const live = CLOUDS.filter((c) => t >= c.at && t < c.at + SMOKE.dur); if (!live.length) return;
  S.world.push({ z: 25, draw: (g) => { for (const c of live) { const u = (t - c.at) / SMOKE.dur, fr = SMOKE.frames[Math.min(SMOKE.frames.length - 1, Math.floor(u * SMOKE.frames.length))]; if (!fr) continue; const w = c.w, h = w * fr.height / fr.width; g.globalAlpha = 0.55; g.drawImage(fr, c.x - w / 2, c.y - h / 2, w, h); } g.globalAlpha = 1; } }); });

// every PC holds its hurt pose for the whole stampede (one swap in, one swap out) and flinches on every trample
m.hold(ST, ST + DUR, (tt, S) => { for (const k of PARTY) if (S.tok[k]) S.tok[k].hurt = true; });
const flinch = (at, k, tier) => { const F = ZP.FLINCH[tier]; m.hold(at, at + F.ms, (e, S) => { const q = S.tok[k]; if (!q) return; const f = ZP.flinchAt(e, tier); if (!f) return; q.sx *= f.sx; q.sy *= f.sy; q.dx += f.dx * KP; if (f.b > 1.05) { const a = Math.min(1, (f.b - 1) / 3); if (a > q.tintA) { q.tint = '#ffffff'; q.tintA = a; } } }); };
for (let at = ST; at < ST + DUR; at += cfg.bedEvery + rnd(0, cfg.bedJitter)) {
  flinch(at, RK.pick(PARTY), R() < 0.3 ? 'strong' : 'normal');
  RK.snd(at, 'damage3', 0.1 / 0.75, { rate: rnd(0.95, 1.08) });
}
// the ground rumbles under the stampede
m.hold(ST, C.final, (tt, S) => { S.shake = Math.max(S.shake, cfg.rumble * RK.SH()); });

// ── the final Berserker: four heavy steps up to the front of the party, a pause, the leap + trip ──
const BIMG = tl.IMG.berserker;
const BH = BIMG ? (BIMG.naturalHeight || BIMG.height || 214) * cfg.finalScale * (788 / 1080) * KP : 0;
const BW = BIMG ? BH * (BIMG.naturalWidth || BIMG.width || 1) / (BIMG.naturalHeight || BIMG.height || 1) : 0;
const BY = IMP.y + cfg.finalYOff * KP;
const BX0 = BACK_EDGE - DIR * 303 * KP, BSTOP = NEAR - DIR * cfg.stopGap * KP, STEP = (BSTOP - BX0) / cfg.steps;
const FIN = C.final;
const JH = cfg.jumpH * (788 / 1080) * 1.2 * KP;
const bandit = (t) => {
  let x = BX0, y = BY, oy = 0, rot = 0;
  for (let i = 0; i < cfg.steps; i++) { const s0 = FIN + i * (cfg.stepMs + cfg.stepPause); if (t < s0) break; const u = E.ioC(seg(t, s0, s0 + cfg.stepMs)); x = BX0 + STEP * (i + E.ioC(u)); if (t < s0 + cfg.stepMs) oy = Math.sin(u * Math.PI) * cfg.stepBob * KP; }   // the mockup eases the step twice
  if (t >= SLAM) { const e = E.inQ(seg(t, SLAM, SLAM + cfg.jumpMs)); x = lerp(BSTOP, IMP.x - DIR * 40 * KP, e); y = lerp(BY, IMP.y + 10 * KP, e); oy = Math.sin(e * Math.PI) * JH; rot = cfg.fallRot * E.inQ(Math.max(0, (e - 0.5) / 0.5)) * 0.6; }
  return { x, y, oy, rot };
};
m.hold(FIN, CLEAR, (tt, S) => { if (!BIMG) return; const p = bandit(tt + FIN);
  S.world.push({ z: 46, draw: (g) => { g.save(); g.translate(p.x, p.y - p.oy); if (p.rot) g.rotate(p.rot * Math.PI / 180 * DIR); g.scale(-DIR, 1); g.drawImage(BIMG, -BW / 2, -BH, BW, BH); g.restore(); } }); });
for (let i = 0; i < cfg.steps; i++) { const at = FIN + i * (cfg.stepMs + cfg.stepPause) + cfg.stepMs;
  RK.snd(at, 'downc', 0.35 + i * 0.1); RK.shake(at, 200, 4 + i * 3); RK.dust(at, { x: BX0 + STEP * (i + 1), y: BY }, 8, 1.2, null, 44); }
RK.snd(SLAM, 'jump2', 0.6);

// ── the whiteout comes right before he lands; the slam is heard in the white; hold; gate; the white lifts ──
const W0 = SLAM + Math.round(cfg.jumpMs * Math.sqrt(0.78));
m.hold(W0, GATE + cfg.whiteOut, (tt, S) => { const t = tt + W0; const a = t < GATE ? E.sine(seg(t, W0, W0 + 90)) : 1 - E.ioC(seg(t, GATE, GATE + cfg.whiteOut)); if (a > S.flash.a) S.flash = { a, c: '#ffffff' }; });
RK.snd(CLEAR, 'explosion2', 0.6); RK.snd(CLEAR, 'blowL', 0.7); RK.snd(CLEAR, 'damage4', 0.5);
RK.shake(CLEAR, 500, 24);
RK.once(CLEAR, () => { for (const p of RK.P) p.dead = true; });   // the stampede is gone when the white lifts
// the camera: at rest until the leap, then pushes 2.1x into the impact (in-cubic); back at rest the moment the white is full
const CAM_RESET = W0 + 90;
m.hold(0, 1e9, (t, S) => { const z = t >= SLAM && t < CAM_RESET ? E.inC(seg(t, SLAM, SLAM + cfg.zoomMs)) : 0;
  S.cam = { cx: lerp(tl.REST.cx, IMP.x, z), cy: lerp(tl.REST.cy, IMP.y - cfg.zoomLift * KP, z), zoom: lerp(1, cfg.zoom, z) }; });
RK.once(GATE, () => { oni.hit(); oni.fireDone(); });
const total = GATE + cfg.whiteOut + 900;
await tl.run(T, { total, onStart: readyHook });
oni.fireDone();
