// ── Nox Tome (spec noxtome.md): walk up, tome smack (gate on the thud), torn pages, back. LIVE board. ──
const tk = FOES[0];
if (!tk) { oni.fireDone(); return; }
// Beat 1: dashTo(PR, front(ZARG, 80), 700), ease quad
const tf = OYk(tk), dst = { x: OXk(tk) - DIR * 80 * KP * sOf(tk), y: tf };
const WALK = 700;
// Beat 2: lean back 220 (ease out), swing 90, 80 ms in: the hit; lean home 200, wait 300
const SWING = WALK + 220, HIT = SWING + 80, BACK = HIT + 200 + 300, HOME = BACK + 620;
MOVE = (t) => {
  if (t < WALK) { const u = X.quad(seg(t, 0, WALK)); return { x: lerp(kf.x, dst.x, u), y: lerp(kf.y, dst.y, u) }; }
  if (t < BACK) return dst;
  const u = X.quad(seg(t, BACK, HOME)); return { x: lerp(dst.x, kf.x, u), y: lerp(dst.y, kf.y, u) };
};
ROT = tw(0, [[WALK, 220, leanDeg(-12), X.out], [SWING, 90, leanDeg(14), X.out], [HIT, 200, 0, X.out]]);
S_(SWING, 'swingA', 0.4);
// the hit: 001_hit_physical on the body (over the battler), Blow1 (land's sound), one contact
const c = centerOf(tk), s = sOf(tk);
fx('001_hit_physical', HIT, c, { scale: s * 0.7 });
S_(HIT, 'blow1', 0.45);
once(HIT, () => oni.hit());
// five torn pages flutter out of the book (hit layer)
// (mockup x - 20 and vx are toward the Legion's side: mirrored with DIR)
const bx = c.x - 20 * KP * DIR, by = c.y;
for (let i = 0; i < 5; i++) { const vx = rnd(-0.12, 0.05) * DIR, vy = -rnd(0.08, 0.2), rot0 = rnd(0, 6), vr = rnd(-0.01, 0.01);
  part({ t0: HIT, life: rnd(1000, 1500), x: bx, y: by, vx, vy, g: 0.0003, drag: 0.985, layer: 'hit', comp: 'source-over',
    draw: (g, x, y, u, age) => { g.globalAlpha = 1 - u; g.translate(x + Math.sin(age / 200) * 6 * KP, y); g.rotate(rot0 + vr * age); g.scale(KP, KP);
      g.fillStyle = '#d8cfb4'; g.fillRect(-7, -9, 14, 18); g.fillStyle = 'rgba(' + JADE + ',.8)'; g.fillRect(-4, -5, 8, 1.5); g.fillRect(-4, -1, 6, 1.5); g.fillRect(-4, 3, 7, 1.5); } }); }
await runShot(Math.max(HOME, HIT + 1500) + 60, HIT);
