// ── Geist · Attack (imbued by Shadow Strike) ──
// Approved mockup (round 3 'imbued'): dark flames lick off his blade arm as he lunges (Darkness4, 340 ms,
// purple trail) -> wind-up lean, SwingF, a violet crescent cut across the target, a small pxfx_dark_plasma
// blast on it, Darkness3 + HitSlashL, dark shards, the target's hurt + flinch -> lean back -> home.
// Gate on contact as in the mockup (cfg.gateAtEnd moves it to the end, like the July attacks).
const tk = FOES[0], c = center(tk), DEST = frontOf(tk);
const L = cfg.lungeMs, CUT = L + 120, SWING = CUT + 90, REST = CUT + 320, UP = REST + 160, HOME = UP + cfg.backMs;
KMOVE = pathOf([
  { t0: 0, t1: L, from: kf, to: DEST, ease: E.ioQ },
  { t0: L, t1: CUT, to: DEST, rot0: 0, rot1: -12, ease: E.outQ },
  { t0: CUT, t1: SWING, to: DEST, rot0: -12, rot1: 14, ease: E.outQ },
  { t0: REST, t1: UP, to: DEST, rot0: 14, rot1: 0, ease: E.outQ },
  { t0: UP, t1: HOME, from: DEST, to: kf, ease: E.ioQ },
]);
trail(0, L, 0.2, { hue: 280 });
trail(UP, cfg.backMs, 0.3, { hue: 280 });
// dark flames off his blade arm through the lunge (2 embers every 40 ms, riding with him)
S_(0, 'darkness4', 0.35);
for (let e = 0; e < L; e += 40) { const p = KMOVE(e) || kf; for (let i = 0; i < 2; i++) ember(e, p.x + DIR * rnd(10, 40) * KP, p.y - K.h * rnd(0.3, 0.7), DARK, { vy: -rnd(0.08, 0.16), r: rnd(3, 6) }); }
// contact
S_(CUT, 'swingF', 0.5); S_(CUT, 'darkness3', 0.5); S_(CUT, 'slashL', 0.4);
PT.push({ kind: 'slash', t0: CUT, life: 260, x: c.x, y: c.y, ang: -0.7, len: 230 * KP, w: 30 * KP, rgb: '200,110,255' });
pxfx('pxfx_dark_plasma', CUT, c, (CL.pxfx_dark_plasma_front ? CL.pxfx_dark_plasma_front.w : 672) * 0.55 * 0.6 * KP);
shards(CUT, c, DARK, 12, 0.45);
hurtOn(tk, CUT, 'normal', { hold: 700 });
once(CUT, () => oni.hit({ numbersOnly: true }));
const total = Math.max(HOME + 80, CUT + (CL.pxfx_dark_plasma_front ? CL.pxfx_dark_plasma_front.dur : 0));
await go(total, cfg.gateAtEnd ? HOME : CUT);
