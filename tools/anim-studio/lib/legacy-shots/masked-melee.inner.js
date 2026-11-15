// ── Spear / Draconic Roar (mockup b1 upkeep moves). cfg.move = 'spear' | 'roar'.
const MOVE = cfg.move;
const lean = (deg) => -deg * DIR;
let total = 0, gate = 0;

if (MOVE === 'spear') {
  // dash (afterimages), thrust, hit, hop back home
  const tk = FOES[0];
  if (!tk) { oni.fireDone(); return; }
  const tf = ftOf(tk), dst = { x: tf.x - DIR * 100 * KP * depthAt(tf.x, tf.y), y: tf.y };
  const DASH = 360, HIT = DASH + 90, BACK = HIT + 250, HOME = BACK + 160, END = HOME + 420;
  const rotT = tw(0, [[DASH, 90, lean(-14), X.out], [BACK, 160, 0, X.out]]);
  BODY = (t) => {
    let x = kf.x, y = kf.y, air = 0;
    if (t < DASH) { const u = X.quad(seg(t, 0, DASH)); x = lerp(kf.x, dst.x, u); y = lerp(kf.y, dst.y, u); }
    else if (t < HOME) { x = dst.x; y = dst.y; }
    else { const u = X.quad(seg(t, HOME, END)); x = lerp(dst.x, kf.x, u); y = lerp(dst.y, kf.y, u); air = Math.sin(u * Math.PI) * 24 * KP; }
    return { x, y, air, rot: rotT(t) };
  };
  // mockup moveActor trail .25: an afterimage each quarter of the (eased) dash
  for (const u of [0.354, 0.5, 0.646]) AFTER.push({ t0: DASH * u, ms: 380, op: 0.5, filter: 'brightness(1.6) saturate(.4)' });
  S_(HIT, 'swingA', 0.5); S_(HIT, 'hitpierceb', 0.5);
  fx('pierce', HIT, center(tk), 1, { z: 30 });
  once(HIT, () => oni.hit());
  gate = HIT; total = END;
}

if (MOVE === 'roar') {
  // full-screen dim, she rears up, roar shockwaves roll over the party, then a debuff beat on each
  const ROAR = 300, RINGS = ROAR + 3 * 170, HITS = RINGS + Math.max(1, FOES.length) * 60, AFTERH = HITS + 300, SETTLE = AFTERH + 300;
  const sxT = tw(1, [[0, 300, 0.96, X.out], [ROAR, 120, 1.05, X.out], [AFTERH, 300, 1, X.out]]);
  const syT = tw(1, [[0, 300, 1.1, X.out], [ROAR, 120, 0.95, X.out], [AFTERH, 300, 1, X.out]]);
  const rotT = tw(0, [[0, 300, lean(8), X.out], [ROAR, 120, lean(-6), X.out], [AFTERH, 300, 0, X.out]]);
  BODY = (t) => ({ sx: sxT(t), sy: syT(t), rot: rotT(t) });
  dimLevel(tw(0, [[0, 400, 0.45, X.sine], [AFTERH, 400, 0, X.sine]]), SETTLE + 400);
  S_(ROAR, 'monster5', 0.6); rumble(ROAR, AFTERH, 4);
  for (let i = 0; i < 3; i++) { const at = ROAR + i * 170; ring(at, bodyMid(bodyAt(at)), { layer: 'field', r1: 1200, ms: 900, sy: 0.55, w: 10, rgb: '255,240,220' }); }
  // one contact for the whole party (the game flinches everyone hit), then the debuff beat on each
  once(RINGS, () => oni.hit());
  for (const k of FOES) fx('powerdown', AFTERH, ftOf(k), 1, { z: 26 });
  gate = AFTERH; total = SETTLE + 400;
}

await runShot(total, gate);
