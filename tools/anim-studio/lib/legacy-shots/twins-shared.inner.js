// ── shared: Mug and Cleaving Strike (Jill, and Rauben with his own flavour) ──
// Port of the approved legacy boss mockup (part-b2.js mug() / cleave()). cfg.move = 'mug' | 'cleave';
// cfg.coins = coins popped by Mug (Jill 2, Rauben 4). Live board. No backticks in this file.
const MOVE = cfg.move;
if (!FOES.length) { oni.fireDone(); return; }
let total = 0;

if (MOVE === 'mug') {
  // Dash, swipe, coins pop from the target to the thief, back
  const TK = FOES[0], n = Math.max(1, cfg.coins || 2);
  moveTo(0, 340, front(TK, 80), EZ.quad, { trail: true });
  SX(340, 'swingA', 0.5); const H = lean(340, 80, 10);
  crescent(H, tCenter(TK), { ang: 0.6, len: 110, w: 14 });
  land(H, TK, { fx: 'hit_phys', s: 'slash1', vol: 0.4 }); SX(H, 'steal', 0.5);
  const C = coinsTo(H, tCenter(TK), bodyAt(H), n, 520);
  const G = lean(C, 120, 0); gateAt(G);
  BODY_END = goHome(G + 150, 420, { hop: 22 });
  total = BODY_END + 400;
} else {
  // Cleaving Strike: steps up to the party, one wide sweep, a hit cue on each target as it passes
  const order = FOES.slice().sort((a, b) => tFeet(a).y - tFeet(b).y);
  const xs = order.map((k) => tFeet(k).x), near = DIR > 0 ? Math.min(...xs) : Math.max(...xs);
  const fy = order.reduce((s, k) => s + tFeet(k).y, 0) / order.length;
  const mid = { x: near - DIR * 92 * KP, y: fy - 47 * KP };
  const cen = { x: order.reduce((s, k) => s + tCenter(k).x, 0) / order.length, y: order.reduce((s, k) => s + tCenter(k).y, 0) / order.length };
  moveTo(0, 420, mid, EZ.quad, { trail: true });
  const W = lean(420, 220, -16); SX(W, 'swingF', 0.6); lean(W, 140, 18);
  clipAt('ggslash', W, cen, 2.4, { z: 44, add: true, rot: 80 * DEG * DIR, flip: DIR < 0, depth: false });
  order.forEach((k, i) => land(W + 70 * (i + 1), k, { fx: 'slash_phys', s: i % 2 ? 'slash2' : 'slash1', vol: 0.35, noCue: true }));
  // contact cues: one per planned strike in a Chain (spread over the sweep), else one per target
  const nCue = (oni.strikes && oni.strikes.length) || order.length;
  for (let i = 0; i < nCue; i++) hitCue(W + 70 * (Math.min(i, order.length - 1) + 1) + (i >= order.length ? 40 * (i - order.length + 1) : 0));
  const G = W + 70 * order.length; gateAt(G);
  lean(G + 350, 160, 0); BODY_END = goHome(G + 510, 460, { hop: 20 });
  total = BODY_END + 500;
}
await runShot(total);
