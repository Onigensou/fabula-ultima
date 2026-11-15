// ── Hurl Spear / Spear Rain / Piercing Talon / Wind Lance (mockup b1, the wind-imbued r2 spears).
// cfg.move = 'hurl' | 'rain' | 'talon' | 'lance'. Lean values are the mockup's (deg); positive leans her back,
// away from the party, mirrored by DIR. Spear Rain's targets and damage come from the outer script (params.picks).
const MOVE = cfg.move;
const lean = (deg) => -deg * DIR;                 // mockup lean(MG, deg * baseFlip): + = back, - = into the throw
let total = 0, gate = 0;

if (MOVE === 'hurl') {
  // wind gathers on her hand, then wind-charged spears thrown high in quick succession; they glint at the top
  const n = cfg.n, gap = 170, W0 = 220;
  const segs = [[0, 220, lean(10), X.out]];
  for (let i = 0; i < n; i++) { const at = W0 + i * gap; segs.push([at, 70, lean(-8), X.out], [at + 70, 110, lean(6), X.out]); }
  const BACK = W0 + n * gap; segs.push([BACK, 180, 0, X.out]);
  const rotT = tw(0, segs);
  BODY = (t) => ({ rot: rotT(t) });
  wisps(0, handOf(st0()), { n: 10, r: 90, rgb: '150,255,190', ms: 350 }); S_(0, 'wind4', 0.4);
  const top = viewTop();
  for (let i = 0; i < n; i++) {
    const at = W0 + i * gap; S_(at, 'wind7', 0.45);
    const from = handOf(bodyAt(at)), to = { x: K.x + DIR * rnd(40, 260) * KP, y: top - 160 * KP };
    const end = fly(at, from, to, { ms: cfg.fly, ease: X.in, draw: WIND_SPEAR, trail: windTrail });
    twinkles(end, { x: K.x + DIR * rnd(60, 240) * KP, y: top + 30 * KP }, { n: 3, r: 30, rgb: '170,255,200' });
  }
  gate = BACK + 180; total = gate + 500;
}

if (MOVE === 'rain') {
  // for each hit a shadow snaps open under the target, then a wind-charged spear plunges in steep and fast and sticks
  // in the floor with a burst of green wind. The picks (and the 10 damage each) are the outer script's, as shipped.
  const byUuid = new Map(); for (let i = 0; i < targets.length; i++) { const d = targets[i].document; if (d) byUuid.set(d.uuid, FOES[i]); }
  const picks = (ctx.params.picks || []).map((u) => byUuid.get(u)).filter(Boolean);
  const list = picks.length ? picks : FOES.slice(0, 3);
  const top = viewTop();
  let last = 0;
  list.forEach((k, i) => {
    const at = i * cfg.gap, f = ftOf(k), pt = { x: f.x - DIR * 14 * KP, y: f.y - 6 * KP }, hitAt = at + 240 + cfg.plunge;
    floorShadow(at, hitAt, pt, { r: 34, grow: 240 });
    S_(at + 240, 'wind7', 0.4);
    fly(at + 240, { x: pt.x - DIR * 240 * KP, y: top - 140 * KP }, { x: pt.x, y: pt.y - 30 * KP }, { ms: cfg.plunge, ease: X.in, draw: WIND_SPEAR, trail: windTrail, stay: 800 });
    fx('wind', hitAt, pt, 0.7, { z: 24 }); ring(hitAt, pt, { rgb: '150,255,190', r1: 110 }); wisps(hitAt, { x: pt.x, y: pt.y - 20 * KP }, { n: 6, r: 50, rgb: '150,255,190', ms: 250 });
    dustBurst(hitAt, pt, { n: 8 }); S_(hitAt, 'hitpierceb', 0.4); shake(hitAt, 5, 160);
    once(hitAt, () => oni.hit());
    last = hitAt;
  });
  gate = last; total = last + 800 + 400;
}

if (MOVE === 'talon' || MOVE === 'lance') {
  const tk = FOES[0];
  if (!tk) { oni.fireDone(); return; }
  const isL = MOVE === 'lance', WU = isL ? 450 : 220, FL = isL ? 300 : 240, HIT = WU + FL;
  const rotT = tw(0, [[0, WU, lean(12), X.out], [WU, 100, lean(-10), X.out], [HIT, 200, 0, X.out]]);
  BODY = (t) => ({ rot: rotT(t) });
  if (isL) { wisps(0, handOf(st0()), { n: 12, r: 100, rgb: '150,255,190', ms: 450 }); S_(0, 'wind4', 0.4); }
  const tc = center(tk);
  if (!isL) {
    S_(WU, 'wind7', 0.5);
    const sp = spearShape(130);
    fly(WU, handOf(bodyAt(WU)), tc, { ms: FL, draw: (g) => sp(g), trail: (at, x, y) => part({ t0: at, life: 200, x, y, layer: 'field', draw: (g, px, py, u) => glw(g, px, py, 6 * KP, '255,255,255', 0.5 * (1 - u)) }) });
    fx('pierce', HIT, tc, 1, { z: 30 });
  } else {
    S_(WU, 'wind1', 0.5);
    const sp = spearShape(130, '120,255,170');
    const draw = (g, age) => { sp(g); for (let i = 0; i < 3; i++) { g.strokeStyle = 'rgba(160,255,200,.7)'; g.lineWidth = 2; g.beginPath(); g.ellipse(-30 - i * 30, 0, 10, 16, 0, age / 40 + i, age / 40 + i + 3.4); g.stroke(); } };
    fly(WU, handOf(bodyAt(WU)), tc, { ms: FL, draw, trail: (at, x, y) => part({ t0: at, life: 300, x, y, layer: 'field', draw: (g, px, py, u) => glw(g, px, py, 10 * KP, '140,255,180', 0.5 * (1 - u)) }) });
    fx('wind', HIT, tc, 1.3, { z: 30 }); ring(HIT, ftOf(tk), { rgb: '170,255,200', r1: 150 });
  }
  S_(HIT, 'hitpierceb', 0.5);
  once(HIT, () => oni.hit());
  gate = HIT + 200; total = gate + (isL ? 400 : 300);
}

await runShot(total, gate);
