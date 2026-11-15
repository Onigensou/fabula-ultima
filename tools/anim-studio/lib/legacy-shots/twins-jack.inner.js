// ── Jack: Zero Power: Apex Arrow, Thief Bow, Snaring Arrow, Burning Arrow, Poison Arrow ──
// Port of the approved legacy boss mockup (part-b2.js + round 3: afterimages on every Apex move).
// cfg.move = 'apex' | 'thief' | 'snaring' | 'burning' | 'poison'. The bow shots run on the live board;
// Apex Arrow is a full takeover (cfg.live false) so it can push the camera in on the slow-mo apex and snap
// back on the release (user-approved). No backticks in this file.
const MOVE = cfg.move;
if (!FOES.length) { oni.fireDone(); return; }
const TK = FOES[0];
let total = 0;

if (MOVE === 'apex') {
  const GH = { hue: 140 };
  // Cut-in (his sprite, pixel art)
  const A0 = cutinPx(0, 'cut');
  // Cartwheel shot: the first arrow thunks into the floor beside the target
  const cw = { x: KF.x + DIR * 120 * KP, y: KF.y + 30 * KP };
  fdim(A0, 300, 0.3); SX(A0, 'evade', 0.5);
  moveTo(A0, 520, cw, EZ.quad, { hop: 46 }); pivot(A0, true); key(BODY.rot, A0, 520, 360, EZ.quad); key(BODY.rot, A0 + 520, 0, 0);
  const tf = tFeet(TK), pin = { x: tf.x - DIR * 70 * KP, y: tf.y + 6 * KP };
  SX(A0 + 240, 'bow1', 0.5);
  const a1 = fly(A0 + 240, hand(A0 + 240), { x: pin.x, y: pin.y - 18 * KP }, 220, SHAPE.arrow(56, '255,255,255', '#dfe4ea'), { stay: 2600 });
  SX(a1, 'hitpierceb', 0.35); dustBurst(a1, pin, { n: 5, s: 0.7 }); twinkles(a1, { x: pin.x - DIR * 10 * KP, y: pin.y - 30 * KP }, { n: 2, r: 8, rgb: '255,255,200' });
  trail(A0, A0 + 520, 45, { opacity: 0.45, ms: 320, hue: GH.hue });
  // Backflip shot: the over-the-shoulder arrow clips the first, spark
  const B = A0 + 520, FL = cfg.flip;
  SX(B, 'jump2', 0.5); dustBurst(B, cw, { n: 6 });
  liftTo(B, FL, cfg.height, EZ.outCubic); key(BODY.rot, B, FL, -180, EZ.out);
  const bs = B + Math.round(FL * 0.45); SX(bs, 'bow1', 0.5);
  const a2 = fly(bs, hand(bs), { x: pin.x - DIR * 6 * KP, y: pin.y - 40 * KP }, 230, SHAPE.arrow(56, '255,230,150', '#dfe4ea'));
  const sp = { x: pin.x, y: pin.y - 34 * KP };
  SX(a2, 'sword1', 0.45); shards(a2, sp, '255,230,140', 10, 0.35); twinkles(a2, sp, { n: 4, r: 18, rgb: '255,230,150' });
  trail(B, B + FL, 45, { opacity: 0.45, ms: 320, hue: GH.hue });
  // Apex, upside down: time slows, wind ring round the bow, he draws
  const C = B + FL, SL = cfg.slow;
  fdim(C, 250, 0.62); SX(C, 'charging', 0.5);
  const body = bodyAt(C);
  for (let i = 0; i < 3; i++) ring(C, body, { layer: 'hit', rgb: '170,255,200', r0: 90, r1: 20, sy: 1, ms: 500, ref: KF });
  wisps(C, hand(C), { n: 14, r: 120, rgb: '170,255,200', ms: 600 });
  liftTo(C, SL, cfg.height + 10, EZ.sine);
  trail(C, C + SL, 90, { opacity: 0.35, ms: 600, hue: GH.hue });
  // camera (full takeover): push in between him and the target, at his flip height, then snap back on the release
  const Rl = C + SL;
  if (!LIVE) { const pc = pose(C), tfx = tFeet(TK).x; m.cam(C, 300, { cx: lerp(KF.x + pc.bx, tfx, 0.35), cy: KF.y + pc.dy - pc.lift - 60 * KP, zoom: cfg.zoom || 1.25 }, E.outC); m.cam(Rl, 200, { cx: tl.REST.cx, cy: tl.REST.cy, zoom: 1 }, E.sine); }
  // Release: streak, impact frame, hit, whiteout
  speedLines(C, Rl, body, '200,255,220', 0.35);
  SX(Rl, 'shukuchi', 0.6);
  const hitAt = fly(Rl, hand(Rl), tCenter(TK), 170, SHAPE.lance(170, '150,255,190'), { trail: '150,255,200' });
  const L = impactFrame(hitAt, [TK], 70);
  land(L, TK, { fx: 'wind', fxScale: 1.4, s: 'crit', vol: 0.6 });
  m.shake(L + 90, 300, 12 * KP); whiteTo(L + 90, 130, 1);
  gateAt(L + 220);
  // Landing: crouch, glint, back to his spot (the whiteout hides the drop from the top of the flip)
  const Ld = L + 340;
  key(BODY.rot, Ld, 0, 0); pivot(Ld, false); key(BODY.lift, Ld, 0, 0);
  squash(Ld, 10, 1.1, 0.85); whiteTo(Ld, 420, 0); fdim(Ld, 420, 0);
  SX(Ld + 260, 'magic4', 0.35); twinkles(Ld + 260, { x: cw.x + DIR * 8 * KP, y: cw.y - HB('k') * DR(cw) * 0.84 }, { n: 3, r: 4, rgb: '255,240,160' });
  squash(Ld + 260, 200, 1, 1);
  goHome(Ld + 460, 420);
  trail(Ld, Ld + 880, 50, { opacity: 0.4, ms: 300, hue: GH.hue });
  BODY_END = Ld + 880; total = BODY_END + 700;
} else {
  // ── the bow shots: lean back, loose, the arrow flies with a glow trail, the hit, then the payload ──
  const P = {
    thief: { rgb: '255,255,255', head: '#dfe4ea' },
    snaring: { rgb: '220,190,140', head: '#dfe4ea' },
    burning: { rgb: '255,140,60', head: '#ffb070' },
    poison: { rgb: '120,230,120', head: '#9fe39f' },
  }[MOVE] || { rgb: '255,255,255', head: '#dfe4ea' };
  lean(0, 200, -8); SX(200, 'bow1', 0.5); lean(200, 160, 0);
  const H = fly(200, hand(200), tCenter(TK), 260, SHAPE.arrow(60, P.rgb, P.head), { trail: P.rgb });
  land(H, TK, { fx: 'hit_phys', s: 'hitpierceb', vol: 0.45 });
  const f = tFeet(TK), c = tCenter(TK), hb = HB(TK);
  if (MOVE === 'thief') {
    // two coins pop off the target and fly to Jack (IP steal)
    SX(H, 'steal', 0.5); const G = coinsTo(H, c, bodyAt(H), 2);
    gateAt(G); total = G + 500 + 300;
  } else if (MOVE === 'snaring') {
    // a cord snaps tight round the feet
    SX(H, 'swingC', 0.4); for (let i = 0; i < 3; i++) ring(H, f, { rgb: '200,160,100', r0: 70, r1: 18, ms: 380, w: 4 });
    statusBeat(H + 380, TK); gateAt(H + 380); total = H + 380 + 900;
  } else if (MOVE === 'burning') {
    // fire-tipped: a burst of flame and embers
    clipAt('fire_one', H, c, 1, { z: 42 }); SX(H, 'fire1', 0.5);
    spawn(H, () => { for (let i = 0; i < 10; i++) ember('field', f.x + rnd(-20, 20) * KP, f.y - hb * rnd(0.2, 0.7), '255,140,60'); });
    statusBeat(H + 300, TK); gateAt(H + 300); total = H + 2700;
  } else {
    // poison: a green puff
    SX(H, 'darkness1', 0.35);
    spawn(H, () => { for (let i = 0; i < 16; i++) dust('field', f.x + rnd(-30, 30) * KP, f.y - hb * rnd(0.2, 0.8), '110,220,110', { vy: -rnd(0.02, 0.06), r: rnd(3, 6) }); });
    statusBeat(H + 300, TK); gateAt(H + 300); total = H + 2400;
  }
  BODY_END = 360;
}
await runShot(total);
