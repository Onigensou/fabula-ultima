// Nocebo Weapon — approved mockup (v8). Keren steps out on a violet (275)
// hexagram circle (Magic1) and steps back; sparks gather at the ally's weapon
// hand, then a power-up burst (MV 052_powerup_2, Up1) on the ally.
// The player's Light / Dark pick is not visible to the animation, so this uses
// ONE neutral default: white sparks and a desaturated white power-up (the
// mockup's options were gold for Light, violet for Dark). No number: gate null.
if (!caster) { K.ready(); oni.fireDone(); return; }
const B = await boot(); const { tl, T, m, TOK, TG, U, E } = B;
const t = cfg.t;
const dir = K.dirOf(TOK, 'c');
const tk = TG[0] || 'c';
K.step(m, E, U, dir, 'c', 0, 0, t.release, 46);
K.circle(tl, m, U, 'c', t.cast, t.castHold, 275, { dx: dir * 46 * U });
const af = K.feet(tl, tk), adir = K.dirOf(TOK, tk);
const hand = { x: af.x + adir * 34 * U, y: af.y - TOK[tk].h * 0.45 };
K.twinkles(m, t.release, hand, 'brightness(1.3)', 7, 30, U);
m.clip('powerup', t.burst, { x: af.x, y: af.y, w: 508 * 0.85 * U, z: 50, filter: 'grayscale(1) brightness(1.3)' });
await tl.run(T, { total: t.total, sfx: cfg.sfx || [], onStart: K.ready });
oni.fireDone();
