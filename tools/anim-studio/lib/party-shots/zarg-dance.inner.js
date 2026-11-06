// Zarg's Dances — approved mockup (Party Action Animations v8), one shared shot.
// The dance: three hop-spins in place (300 ms each: through the 8 standing directions when
// the dancer has them wired, else the flat scaleX = cos(2 pi u) spin; a 26 px hop,
// a 20 px sway that alternates side), two tinted GG twinkles at the start of each hop.
// Fall.ogg at the start, Up1 at the burst (cues in cfg.sfx; no Move1 step sound).
// cfg.kind:
//   'element'   — the five element Dances: 052_powerup_2 hue-shifted to cfg.hue
//                 (Angel Light 48, Griffin Air 140, Myrmidon Earth 28, Bat Dark 280, Golem Bolt 55)
//   'lion'      — warm sparkles (35), 045_cure_one_1 on Zarg (Recovery)
//   'unicorn'   — pink sparkles (330), 041_heal_one_1 on Zarg AND the ally target (Heal3); gate at the heal
//   'ouroboros' — teal sparkles (170), a ring of light arcs to the ally and widens around them (Bell1)
// No text (the mockup's option tags are dropped: BD shows the real result).
if (!caster) { K.ready(); oni.fireDone(); return; }
const B = await boot(null, { c: K.SPIN8_POSES }); const { tl, T, m, TOK, TG, U, E } = B;
const kind = cfg.kind || 'element';
const hue = cfg.hue == null ? 48 : cfg.hue;
const dir = K.dirOf(TOK, 'c');
const C = TOK.c;
const SP = 300, N = 3, END = SP * N;
// 8-direction spin when the dancer has all five standing slots wired (sprite_standard +
// sprite_stand_down/_left/_up_left/_up); otherwise the flat Paper Mario spin (scaleX = cos).
const SPIN8 = K.spin8Ready(tl, 'c');

// three hop-spins
m.hold(0, END + 1, (e, S) => {
  const q = S.tok.c; if (!q) return;
  if (e >= END) return;
  const i = Math.min(N - 1, Math.floor(e / SP));
  const u = E.sine(Math.min(1, (e - i * SP) / SP));
  if (SPIN8) { const s = K.spin8At(C, dir, u); q.pose = s.pose; q.sx *= s.sx; }
  else q.sx *= Math.cos(u * Math.PI * 2);
  q.dx += dir * 20 * U * Math.sin(u * Math.PI) * (i % 2 ? -1 : 1);
  q.air += Math.sin(u * Math.PI) * 26 * U;
});
const mid = K.mid(tl, 'c');
for (let i = 0; i < N; i++) K.twinkles(m, i * SP, mid, K.tintF(hue, 4, 1.3), 2, 50, U);

const cf = K.feet(tl, 'c');
const onFeet = (key, at, k, nativeW, filter) => { const f = K.feet(tl, k); m.clip(key, at, { x: f.x, y: f.y - 8 * U, w: nativeW * 0.85 * U, z: 40, filter: filter || '' }); };
let total = END;

if (kind === 'lion') {
  onFeet('cure', END, 'c', 700);
  total = END + 1133;
} else if (kind === 'unicorn') {
  onFeet('heal', END, 'c', 546);
  if (TG.length) onFeet('heal', END, TG[0], 546);
  total = END + 1400;
} else if (kind === 'ouroboros') {
  total = END + 600 + 900 + 600;
  const tk = TG[0];
  if (tk) {
    const from = { x: mid.x, y: mid.y }, to = K.mid(tl, tk);
    const ARC = 600, GROW = 900;
    const ring = (g, x, y, sx, sy, a) => { g.save(); g.globalCompositeOperation = 'lighter'; g.globalAlpha = a; g.translate(x, y); g.scale(sx, sy); g.strokeStyle = '#5fe0c8'; g.lineWidth = 6 * U; g.beginPath(); g.arc(0, 0, 27 * U, 0, 6.283); g.stroke(); g.restore(); };
    // the ring arcs from Zarg to the ally (mockup arc(): ioQ, 70 px high)
    m.hold(END, END + ARC, (e, S) => { const k = Math.min(1, e / ARC), q = E.ioQ(k); const x = from.x + (to.x - from.x) * q, y = from.y + (to.y - from.y) * q - Math.sin(q * Math.PI) * 70 * U; S.world.push({ z: 55, draw: (g) => ring(g, x, y, 1, 1, 1) }); });
    // then widens into a flat loop around them, sinking toward their feet
    m.hold(END + ARC, END + ARC + GROW, (e, S) => { const t = E.sine(Math.min(1, e / GROW)); const s = 1 + 1.6 * t; S.world.push({ z: 55, draw: (g) => ring(g, to.x, to.y + 60 * U * t, s, s * 0.35, 1 - t * 0.6) }); });
    m.tint(END + ARC + GROW, 220, tk, '#ffffff', (u) => 0.45 * (1 - E.outQ(u)));
  }
} else {
  onFeet('powerup', END, 'c', 508, 'hue-rotate(' + Math.round(hue - 55) + 'deg)');
  total = END + 1200;
}

await tl.run(T, { total: total + 60, sfx: cfg.sfx || [], onStart: K.ready });
oni.fireDone();
