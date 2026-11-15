// ── Geist · Shadow Wall (upkeep of the July script on the live board) ──
// The shared Sacrifice-HP beat (the shipped skull smoke over his head + Blind; at 250 ms he flinches as the
// HP is paid) -> at 600 ms the shipped dark illusion circle over him + Darkness3 and the mockup's dark ring
// opening on the floor -> at 1100 ms the buff beat (051 powerup + Powerup.ogg) and the gate. The shot runs
// on until the circle clip ends, as shipped.
const hp = { x: K.x, y: K.y - K.h * cfg.sacRise };   // shipped: token centre - h * .55
S_(0, 'blind', cfg.sacVol);
fx('skull', 0, hp, cfg.sacSize, { z: 42 });
hurtOn('k', 250, 'normal', { hold: 350, away: -1 });
const CIRC = cfg.sacHold;
S_(CIRC, 'darkness3', cfg.circleVol);
fx('circle', CIRC, center('k'), cfg.circleSize, { z: 41 });
ring(CIRC, kf, { rgb: DARK, r0: 20, r1: 130, ms: 900, w: 5 });
const GATE = CIRC + 500;
buffBeat(GATE);
const total = Math.max(GATE + 700, CIRC + (CL.circle ? CL.circle.dur : 0));
await go(total, GATE);
