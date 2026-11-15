// ── Geist · Dark Bane (upkeep of the July script on the live board) ──
// Mockup beats: lunge with a purple afterimage trail (340 ms) -> wind-up lean, swing, the pink-purple slash
// on the target (the shipped JB2A TrailAttack01 + the shipped particle burst + Hit_PiercingB), shards, the
// target's hurt + flinch on contact -> lean back -> home with a trail. Gate at the END (July round 2: keeps
// the CSB HP-recompute pause out of the choreography).
const tk = FOES[0], c = center(tk), DEST = frontOf(tk);
const L = cfg.lungeMs, WIND = L + 120, CUT = WIND, SWING = CUT + 90, REST = CUT + 300, UP = REST + 160, HOME = UP + cfg.backMs;
KMOVE = pathOf([
  { t0: 0, t1: L, from: kf, to: DEST, ease: E.ioQ },
  { t0: L, t1: WIND, to: DEST, rot0: 0, rot1: -12, ease: E.outQ },
  { t0: CUT, t1: SWING, to: DEST, rot0: -12, rot1: 14, ease: E.outQ },
  { t0: REST, t1: UP, to: DEST, rot0: 14, rot1: 0, ease: E.outQ },
  { t0: UP, t1: HOME, from: DEST, to: kf, ease: E.ioQ },
]);
trail(0, L, 0.2, { hue: 280 });
trail(UP, cfg.backMs, 0.3, { hue: 280 });
S_(CUT, 'swingF', 0.5);
// contact
const sw = cfg.slashSize;
fx('trail01', CUT, c, sw, { z: 40, sy: 800 / 600 });
burst(CUT, c, cfg.impactParticles, cfg.particleSpread, cfg.particleMs, '190,90,255');
shards(CUT, c, DARK, 14, 0.45);
S_(CUT, 'hitpierceb', cfg.hitVol);
m.shake(CUT, cfg.shakeMs, cfg.shakeIntensity);
hurtOn(tk, CUT, 'normal', { hold: 700 });
once(CUT, () => oni.hit({ numbersOnly: true }));
const total = Math.max(HOME + 80, CUT + (CL.trail01 ? CL.trail01.dur : 0));
await go(total, cfg.gateAtContact ? CUT : HOME);
