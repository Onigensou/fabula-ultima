// ── Geist · Souleater (upkeep of the July script on the live board) ──
// Mockup beats: dim .4 while he leans in (260 ms) -> Darkness4, the shipped purple impact burst on the target
// with its hurt + flinch + clone shake -> a purple soul mote is drawn back into Geist (800 ms arc) -> he
// flares violet, the dim lifts, he straightens. Gate at the END (July round 2).
const tk = FOES[0], c = center(tk);
const REACH = 260, HIT = REACH, ARRIVE = HIT + cfg.drainMs, UNDIM = ARRIVE, END = ARRIVE + 400;
m.dim(0, 300, cfg.dimTo); m.undim(UNDIM, 400, cfg.dimTo);
KMOVE = pathOf([
  { t0: 0, t1: REACH, to: kf, rot0: 0, rot1: 10, ease: E.outQ },
  { t0: ARRIVE, t1: ARRIVE + 200, to: kf, rot0: 10, rot1: 0, ease: E.outQ },
]);
S_(HIT, 'darkness4', cfg.castVol);
PT.push({ kind: 'disc', t0: HIT, life: cfg.impactMs, x: c.x, y: c.y, size: cfg.impactSize, rgb: '150,60,230' });
hurtOn(tk, HIT, 'strong', { hold: 700, jitter: cfg.shakeAmp, jitterMs: cfg.shakeMs });
once(HIT, () => oni.hit({ numbersOnly: true }));
// the soul: one big mote along an arc, target -> Geist
PT.push({ kind: 'home', t0: HIT, life: cfg.drainMs, from: c, to: center('k'), ctl: { x: (c.x + center('k').x) / 2 + rnd(-140, 140) * KP, y: Math.min(c.y, center('k').y) - rnd(42, 140) * KP }, rgb: '180,90,255', r: cfg.soulSize / 7 });
flashK(ARRIVE, '#c08cff', 300);
await go(END + 60, cfg.gateAtContact ? HIT : END);
