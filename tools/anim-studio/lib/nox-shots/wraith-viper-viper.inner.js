// ── Nox Viper: Poison Fang / Coil / Bile Spew (+ its Armor Break cue) / Feeding Coil tell (approved mockup spec).
// LIVE board. cfg.move picks one. Lean degrees: the mockup's enemy baseFlip is -1 with the party on the right, so a
// mockup lean of k * baseFlip is -k * DIR here.
// Bile Spew's own script also carries the Armor Break beat: play_animation 'Bile Spew#armorbreak' -> variant 'armorbreak'
const MOVE = (cfg.move === 'bilespew' && ctx.params.variant === 'armorbreak') ? 'bilebreak' : cfg.move;
const GLOW_V = 'drop-shadow(0 0 {8} rgba(' + VENOM + ',.95)) drop-shadow(0 0 {2} rgba(' + VENOM + ',.9))';

// mockup viperStrike(t): rear back, a quick lunge (the body stretches forward, no travel), the fangs snap, acid
// splash + the hit, hitstop, snap back. Writes into the x / rot tween lists; returns when it is back (gate point).
function strike(at, tk, pos, XS, ROT) {
  const tf = feet(TOK[tk]), sT = Sd(tk);
  const lungeX = (tf.x - DIR * 40 * KP * sT - pos.x) * 0.55;
  ROT.push([at, 160, deg(10 * DIR), X.out], [at + 160, 90, deg(-14 * DIR), X.out], [at + 690, 150, 0, X.out]);
  XS.push([at + 160, 110, pos.x + lungeX, X.out], [at + 470, 220, pos.x, X.sine]);
  S_(at + 160, 'monster2', 0.35, 1.3);
  jawSnap(at + 270, PT.body(boxT(tk)), { s: 0.85 * sT, rgb: '240,250,230', glowRgb: VENOM });
  px('pxfx_nox_acid', at + 390, tf, 1.1, sT);
  S_(at + 390, 'hitpierceb', 0.45);
  once(at + 390, () => oni.hit());
  return at + 690;
}
// mockup corrodedCue(t): grey-green smoke hisses off the gear (the status icon is the game's)
function corroded(at, tk) { S_(at, 'water3', 0.35, 1.4); fumes(at, tk, '150,165,140', 10); shards(at, 'field', PT.body(boxT(tk)), '160,170,150', 6, 0.2); }

if (MOVE === 'poisonfang') {
  // Slide in between the two targets + rear -> one strike each (Multi 2) -> back. Gate = after the last strike
  // (the mockup's markGate), fired by the shot (its time depends on the target count).
  if (!FOES.length) { oni.fireDone(); return; }
  const f0 = feet(TOK[FOES[0]]), f1 = feet(TOK[FOES[Math.min(1, FOES.length - 1)]]);
  const nearX = DIR > 0 ? Math.min(f0.x, f1.x) : Math.max(f0.x, f1.x);
  const P = { x: nearX - DIR * 210 * KP, y: lerp(f0.y, f1.y, 0.5) + 20 * KP };
  const XS = [[0, 800, P.x, X.sine]], YS = [[0, 800, P.y, X.sine]], ROT = [];
  S_(0, 'cpoison', 0.3);
  let t = 1040, gate = 0;
  FOES.forEach((k, j) => {
    const back = strike(t, k, P, XS, ROT);
    if (j < FOES.length - 1) { corroded(back, k); t = back + 150; }
    else { gate = back; corroded(back, k); t = back + 350; }
  });
  const BK = t, total = BK + 700;
  XS.push([BK, 700, kf.x, X.quad]); YS.push([BK, 700, kf.y, X.quad]);
  const xT = tw(kf.x, XS), yT = tw(kf.y, YS), rT = tw(0, ROT);
  const sxT = tw(1, [[800, 240, 0.95, X.out], [BK, 200, 1, X.out]]), syT = tw(1, [[800, 240, 1.08, X.out], [BK, 200, 1, X.out]]);
  bodyOf('k', (tt) => ({ x: xT(tt), y: yT(tt), rot: rT(tt), sx: sxT(tt), sy: syT(tt) }));
  await runShot(total, gate);
}

if (MOVE === 'coil') {
  // Slither over (wavy) -> MV 057 bind in Viper green + three tightening rings climbing her -> the crush (gate) -> home.
  // Not ported (the game draws them): her squash on the crush (the hurt reaction), the Grappled pulse rings.
  const tk = FOES[0];
  if (!tk) { oni.fireDone(); return; }
  const P = front(tk, 55), sB = Sd(tk), bB = boxT(tk), fB = feet(TOK[tk]);
  const HIT = 900 + 3 * 140, BK = HIT + 300, total = BK + 700;
  bodyOf('k', (t) => {
    if (t < 900) { const u = X.sine(t / 900); return { x: lerp(kf.x, P.x, u), y: lerp(kf.y, P.y, u) + Math.sin(u * Math.PI * 4) * 6 * KP }; }
    if (t < BK) return { x: P.x, y: P.y };
    const u = X.quad(seg(t, BK, total)); return { x: lerp(P.x, kf.x, u), y: lerp(P.y, kf.y, u) };
  });
  S_(0, 'cpoison', 0.3);
  fx('057_bind', 900, fB, 0.5, sB, { filter: 'sepia(1) saturate(3) hue-rotate(50deg)' });
  S_(900, 'monster2', 0.4);
  for (let i = 0; i < 3; i++) ring(900 + i * 140, PT.at(bB, 0.2 + i * 0.2), { layer: 'field', rgb: VENOM, r0: 70, r1: 26, s: sB, sy: 0.3, ms: 420, w: 6 });
  S_(HIT, 'blowM', 0.5);
  once(HIT, () => oni.hit());
  await runShot(total, HIT);
}

if (MOVE === 'bilespew') {
  // Rear + gurgle (hood up, throat glows) -> a long arcing stream of big wet gobs over the party, acid + MV 059 at
  // every pair of feet (gate after the last) -> settle. The DL13 save runs at RESOLVE (interactive, after this shot),
  // so the Armor Break + Envenomed beat is its own script (move 'bilebreak') for the save_failed_targets.
  if (!FOES.length) { oni.fireDone(); return; }
  const g = cfg.gob || 1.9, n = FOES.length;
  const CLR = 900 + 450 + 130 * n, gate = CLR, B3 = gate + 300, total = B3 + 400;
  const rT = tw(0, [[600, 300, deg(10 * DIR), X.out], [900, 160, deg(-8 * DIR), X.out], [B3, 300, 0, X.out]]);
  const sxT = tw(1, [[0, 600, 0.92, X.sine], [900, 160, 1.06, X.out], [B3, 300, 1, X.out]]);
  const syT = tw(1, [[0, 600, 1.14, X.sine], [900, 160, 0.96, X.out], [B3, 300, 1, X.out]]);
  bodyOf('k', (t) => ({ rot: rT(t), sx: sxT(t), sy: syT(t), filter: t < B3 ? GLOW_V : '' }));
  S_(0, 'liquid', 0.5, 0.8); S_(0, 'monster3', 0.35);
  S_(900, 'water1', 0.5); S_(900, 'poison', 0.4);
  const head = PT.head(boxT('k'));
  for (let t = 900 + 45; t < CLR; t += 45) {
    const k = FOES[Math.floor(R() * n)], f = feet(TOK[k]), r = rnd(0.8, 1.2) * g;
    fly(t, head, { x: f.x + DIR * rnd(-50, 30) * KP, y: f.y - rnd(0, 30) * KP }, { ms: rnd(440, 600), arc: rnd(120, 180), draw: (c) => {
      c.globalCompositeOperation = 'source-over'; c.fillStyle = 'rgba(' + VENOM + ',.92)'; c.beginPath(); c.ellipse(0, 0, 7 * r, 4.6 * r, 0, 0, 7); c.fill();
      c.fillStyle = 'rgba(230,255,200,.55)'; c.beginPath(); c.ellipse(-2 * r, -1.4 * r, 2 * r, 1.2 * r, 0, 0, 7); c.fill(); glw(c, 0, 0, 12 * r, VENOM, 0.4); } });
  }
  FOES.forEach((k, i) => { const at = 900 + 450 + 130 * i, s = Sd(k);
    px('pxfx_nox_acid', at, feet(TOK[k]), 1.2, s);
    fx('059_poison', at, PT.body(boxT(k)), 0.7, s);
    once(at, () => oni.hit()); });
  await runShot(total, gate);
}

if (MOVE === 'bilebreak') {
  // Bile Spew's "who failed DL13" beat on its own (targets = the save_failed_targets): a hissing toxic puddle under each
  // and the armour cracks (shards). No Break sound (user). The Envenomed tint loop is the game's status, not ported.
  if (!FOES.length) { oni.fireDone(); return; }
  const n = FOES.length, END = 200 * n + 1300, total = END + 500;
  FOES.forEach((k, i) => { const at = 200 * i, hold = total - at, s = Sd(k);
    px('pxfx_nox_puddle', at, feet(TOK[k]), 1.1, s, { z: 4, zl: 4.5, hold, alpha: (u) => { const tt = at + u * hold; return tt < END ? 1 : Math.max(0, 1 - (tt - END) / 500); } });
    shards(at, 'hit', PT.body(boxT(k)), '190,200,210', 12, 0.35); });
  await runShot(total, 0);
}

if (MOVE === 'feedingcoil') {
  // Passive TELL only (the free Poison Fang that follows plays its own animation): the coils pulse round the held one,
  // then tighten once (ring + Monster2, she is squeezed). The Viper stays at its spot; the gate = the end of the tell.
  const tk = FOES[0];
  if (!tk) { oni.fireDone(); return; }
  const sB = Sd(tk), bB = boxT(tk), waist = PT.at(bB, 0.4);
  ring(0, waist, { layer: 'field', rgb: VENOM, r0: 34, r1: 44, s: sB, sy: 0.3, ms: 600, w: 4 });
  const TI = 700, END = TI + 160 + 300;
  ring(TI, waist, { layer: 'field', rgb: VENOM, r0: 60, r1: 24, s: sB, sy: 0.3, ms: 380, w: 6 });
  S_(TI, 'monster2', 0.35);
  const sxT = tw(1, [[TI, 160, 0.9, X.out], [TI + 160, 300, 1, X.out]]), syT = tw(1, [[TI, 160, 1.03, X.out], [TI + 160, 300, 1, X.out]]);
  m.hold(TI, END, (e, S) => { const q = S.tok[tk]; if (!q) return; const t = e + TI; q.sx *= sxT(t); q.sy *= syT(t); });
  await runShot(END, END);
}
