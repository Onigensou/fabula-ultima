// ── Nox Wraith: Soul Ripper / Devour Soul / Ethereal (approved mockup spec, final round code). cfg.move picks one.
const MOVE = cfg.move;
const GLOW_J = 'drop-shadow(0 0 {8} rgba(' + JADE + ',.95)) drop-shadow(0 0 {2} rgba(' + JADE + ',.9))';

if (MOVE === 'soulripper') {
  // FULL TAKEOVER (cfg.live = false): Rise (thins, floats up, camera in) -> Ghost arc (slow curve to the target, camera
  // following) -> Ghost hands (two pxfx_nox_hands clips turned 90 deg at its hand; the hit on the clip's grab) ->
  // the soul bursts out of him, hangs, is pulled into his Soul Fragment which swells -> drift home.
  const tk = FOES[0];
  if (!tk) { oni.fireDone(); return; }
  const C = cfg, rise = C.rise * KP, pk = C.peak * KP;
  const FR = TOK.f ? 'f' : null;
  const sT = Sd(tk), tf = feet(TOK[tk]);
  const end = { x: tf.x - DIR * C.gap * KP * sT, y: tf.y };
  const A0 = 900, A1 = A0 + C.arc, H0 = A1;
  const HIT = H0 + ((CL.pxfx_nox_hands_front && CL.pxfx_nox_hands_front.impact) || 500);
  const B4 = HIT + 100 + 500;                  // hitstop 100 + wait 500, then the soul bursts out
  const PULL = B4 + C.hover;                   // the soul hangs, then is pulled in
  const SW = PULL + C.pull + 300;              // the fragment swells
  const B5 = FR ? SW + 900 : PULL + 500;       // drift home (no fragment: the motes just fade)
  const total = B5 + 200 + 900 + 300;
  // ── its body ──
  const alphaT = tw(1, [[0, 500, 0.5, X.sine], [H0, 160, 0.9, X.sine], [B5, 200, 0.5, X.sine], [B5 + 1100, 300, 1, X.sine]]);
  const sxT = tw(1, [[H0 + 90, 100, 1.08, X.out], [B4, 200, 1, X.out]]), syT = tw(1, [[H0 + 90, 100, 0.94, X.out], [B4, 200, 1, X.out]]);
  bodyOf('k', (t) => {
    let x = kf.x, y = kf.y, air = 0;
    if (t < A0) air = rise * X.sine(t / A0);
    else if (t < A1) { const u = X.sine(seg(t, A0, A1)); x = lerp(kf.x, end.x, u); y = lerp(kf.y, end.y, u); air = (1 - u) * (1 - u) * rise + 2 * u * (1 - u) * (rise + pk) + Math.sin(u * Math.PI * 3) * 4 * KP; }
    else if (t < B5 + 200) { x = end.x; y = end.y; }
    else { const u = X.quad(seg(t, B5 + 200, B5 + 1100)); x = lerp(end.x, kf.x, u); y = lerp(end.y, kf.y, u); }
    return { x, y, air, alpha: alphaT(t), sx: sxT(t), sy: syT(t) };
  });
  for (let t = A0 + 100; t < A1; t += 100) afterimage('k', t, 0.2, 500, 'brightness(1.4) saturate(.3)');
  // the fragments keep their look (painted: the takeover hides every token); the target's own one swells at the end
  for (const g of OTHERF) bodyOf(g, () => ({ alpha: 0.9, filter: FRAG_F }));
  if (FR) bodyOf(FR, (t) => {
    let k = 1, br = 0;
    if (t >= SW && t < SW + 500) { const e = X.outBack(seg(t, SW, SW + 500)); k = 1 + 0.18 * e; br = 0.4 * e; }
    else if (t >= SW + 500 && t < SW + 900) { k = 1.18 - 0.1 * X.sine(seg(t, SW + 500, SW + 900)); br = 0.4; }
    else if (t >= SW + 900) k = 1.08;
    return { alpha: 0.9, sx: k, sy: k, filter: FRAG_F + (br ? ' brightness(' + (1 + br).toFixed(3) + ')' : '') };
  });
  // ── camera ──
  const b0 = boxT('k');
  camTo(0, 900, { x: kf.x + 40 * DIR * KP, y: b0.bottom - b0.h * 0.7 - rise, z: C.zin });
  camFollow(A0, A1, 'k', { z: C.zin, k: 0.06 });
  camTo(B4, 900, { x: tl.REST.cx, y: tl.REST.cy, z: 1 });
  // ── sound ──
  S_(0, 'spook', 0.35); S_(A0, 'wind7', 0.3, 0.7);
  S_(H0, 'darkness1', 0.4); S_(H0, 'wind7', 0.3, 1.3); S_(HIT, 'darkness1', 0.5);
  S_(B4, 'absorb1', 0.4);
  if (FR) { S_(PULL, 'absorb2', 0.45); S_(SW, 'magic4', 0.4); }
  // ── ghost hands: two clips at its hand, turned sideways toward the target (mirrored when it faces left) ──
  const sE = depthAt(end), bE = boxS('k', stAt('k', H0)), hd = PT.hand(bE);
  const mkH = (at, oy) => { const pt = { x: hd.x - 6 * DIR * KP, y: hd.y + oy * KP * sE }, o = { rot: DIR * Math.PI / 2, flip: DIR < 0 };
    fx('pxfx_nox_hands_front', at, pt, C.hands, sE, Object.assign({ z: 40, filter: 'brightness(1.35) saturate(1.2)' }, o));
    fx('pxfx_nox_hands_light', at, pt, C.hands, sE, Object.assign({ z: 41 }, o)); };
  mkH(H0, -14); mkH(H0 + 90, 16);
  // ── the grab: MV 101 darkness, jade shards, the contact ──
  const bT = boxT(tk);
  fx('101_darkness_one_1', HIT, PT.body(bT), 0.55, sT);
  shards(HIT, 'hit', PT.body(bT), JADE_HOT, 12, 0.35);
  once(HIT, () => oni.hit());
  // ── the soul (part-r5 soulBurst): ~22 jade motes fly up and out of him, hang bobbing, then curve into the fragment ──
  const from = PT.body(bT), to = FR ? PT.body(boxT(FR)) : null, OUT = 520, n = C.soulN || 22;
  for (let i = 0; i < n; i++) {
    const an = rnd(-Math.PI * 0.95, -Math.PI * 0.05), d = rnd(40, 110) * KP;
    const hx = from.x + Math.cos(an) * d, hy = from.y + Math.sin(an) * d * 0.8 - rnd(10, 50) * KP;
    const ph = rnd(0, 6.28), r = rnd(2.2, 4.2), delay = rnd(0, 260), pe = PULL - B4;
    const free = (e) => { const u = Math.min(1, e / OUT), ee = 1 - Math.pow(1 - u, 3); return { x: lerp(from.x, hx, ee) + (u >= 1 ? Math.sin((e + ph * 300) / 260) * 3 * KP : 0), y: lerp(from.y, hy, ee) + (u >= 1 ? Math.cos((e + ph * 300) / 330) * 4 * KP : 0) }; };
    const p0 = free(pe), cx = to ? (p0.x + to.x) / 2 : 0, cy = to ? Math.min(p0.y, to.y) - 90 * KP : 0;
    const pos = (e) => { if (e < pe || !to) return free(e); const u = clamp01((e - pe - delay) / C.pull), q = u * u * u; return { x: (1 - q) * (1 - q) * p0.x + 2 * q * (1 - q) * cx + q * q * to.x, y: (1 - q) * (1 - q) * p0.y + 2 * q * (1 - q) * cy + q * q * to.y }; };
    part({ t0: B4, life: to ? pe + delay + C.pull : pe + 500, pos, layer: 'hit', draw: (g, x, y, u, e) => { const a = to ? 1 : 1 - clamp01((e - pe) / 500); glw(g, x, y, r * 4.2 * KP, JADE_HOT, 0.9 * a); glw(g, x, y, r * 1.6 * KP, '235,255,245', 0.9 * a); } });
  }
  await runShot(total, HIT);
}

if (MOVE === 'devoursoul') {
  // LIVE board: Crisis flicker -> unhinge + pull (the fragment stretches into a jade stream into its maw) -> heal
  // (gate) -> the turn-back ring, home. No eligible fragment: the fragment part is skipped (flicker, heal, ring).
  const FR = TOK.f ? 'f' : null;
  const FL = []; for (let i = 0; i < 48; i++) FL.push(R() < 0.3 ? 0.4 : 1);
  const flick = (t) => FL[Math.min(FL.length - 1, Math.floor(t / (1000 / 60)))];
  let D = null, sgn = -DIR, ff = null, B3 = 600;
  if (FR) { ff = feet(TOK[FR]); sgn = Math.sign(kf.x - ff.x) || -DIR; D = { x: ff.x + sgn * 110 * KP, y: ff.y - 10 * KP }; B3 = 1100 + 1100; }
  const G = B3 + 400, B4 = G + 400, HM = B4 + 300, total = HM + (D ? 600 : 0);
  const sxT = tw(1, D ? [[1100, 300, 1.1, X.out], [B3, 200, 1, X.out]] : []), syT = tw(1, D ? [[1100, 300, 1.06, X.out], [B3, 200, 1, X.out]] : []);
  bodyOf('k', (t) => {
    let x = kf.x, y = kf.y;
    if (D) { if (t >= 600 && t < 1100) { const u = X.quad(seg(t, 600, 1100)); x = lerp(kf.x, D.x, u); y = lerp(kf.y, D.y, u); }
      else if (t >= 1100 && t < HM) { x = D.x; y = D.y; }
      else if (t >= HM) { const u = X.quad(seg(t, HM, HM + 600)); x = lerp(D.x, kf.x, u); y = lerp(D.y, kf.y, u); } }
    let f = '';
    if (t >= B3 && t < B4) f = GLOW_J;
    else if (t >= B4 && t < B4 + 300) { const e = X.out(seg(t, B4, B4 + 300)); f = 'drop-shadow(0 0 {' + (14 * (1 - e)).toFixed(2) + '} #d8fff0) brightness(' + (1 + 1.3 * (1 - e)).toFixed(3) + ')'; }
    return { x, y, alpha: t < 600 ? flick(t) : 1, sx: sxT(t), sy: syT(t), filter: f };
  });
  S_(600, 'monster5', 0.35, 0.8);
  if (D) {
    // the fragment is pulled apart toward the maw, then stays hidden (the game removes it on the gate)
    bodyOf(FR, (t) => { if (t < 1100) return { skip: true }; if (t >= B3) return { hidden: true }; const e = X.in(seg(t, 1100, B3));
      return { x: ff.x + sgn * 40 * e * KP, y: ff.y, sx: 1 + 0.5 * e, sy: 1 - 0.45 * e, alpha: 0.9 * (1 - e), filter: FRAG_F }; });
    S_(1100, 'absorb2', 0.5); rumble(1100, B3, 2);
    soulStream(1100, PT.body(boxT(FR)), PT.head(boxS('k', stAt('k', 1100))), { n: 30, ms: 1100, arc: 30, spread: 24 });
  }
  const at = D || kf, sW = depthAt(at);
  fx('041_heal_one_1', B3, at, 1, sW, { filter: 'hue-rotate(110deg)' });
  S_(B3, 'heal3', 0.4);
  S_(B4, 'skill2', 0.45);
  ring(B4, at, { rgb: JADE_HOT, r1: 140, ms: 500, w: 5, s: sW });
  await runShot(total, G);
}

if (MOVE === 'ethereal') {
  // Passive, the owner's part only: right as the blow lands it goes thin and rippled, then fills back in.
  // (The mockup's arrow from the attacker is the attacker's own animation, not ported.)
  const alphaT = tw(1, [[0, 90, 0.3, X.sine], [350, 400, 1, X.sine]]);
  bodyOf('k', (t) => ({ alpha: alphaT(t) }));
  afterimage('k', 0, 0.4, 500, 'brightness(1.6) saturate(.2)');
  S_(0, 'spook', 0.3, 1.3);
  await runShot(1150, 100);
}
