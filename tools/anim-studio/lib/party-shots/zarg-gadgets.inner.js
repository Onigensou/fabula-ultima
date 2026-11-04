// Gadgets — approved mockup (v8). Zarg steps out 46, three teal twinkles glint at his
// hand, a vial is tossed (650 ms, 160 px arc, 720 deg spin) onto the target, a teal
// GG burst + brightness pop for the infusion; he steps back. The attack's own
// animation plays afterwards as usual. No number (gate null).
// No target: the vial lands 200 px in front of him.
if (!caster) { K.ready(); oni.fireDone(); return; }
const B = await boot(); const { tl, T, m, TOK, TG, U, E } = B;
const t = cfg.t;
const dir = K.dirOf(TOK, 'c');
const C = TOK.c; const cf = K.feet(tl, 'c');
K.step(m, E, U, dir, 'c', 0, 0, t.back, 46);
const hand = { x: cf.x + dir * 46 * U + dir * 34 * U, y: cf.y - C.h * 0.45 };
const tk = TG[0] || null;
const dest = tk ? K.mid(tl, tk) : { x: hand.x + dir * 200 * U, y: hand.y };
K.twinkles(m, t.glint, hand, K.tintF(170, 4, 1.3), 3, 10, U);
// the vial: 26 x 38, pale cap over teal liquid, cyan glow
m.hold(t.toss, t.land, (e, S) => {
  const k = Math.min(1, e / (t.land - t.toss));
  const x = hand.x + (dest.x - hand.x) * k, y = hand.y + (dest.y - hand.y) * k - Math.sin(k * Math.PI) * 160 * U;
  S.world.push({ z: 60, draw: (g) => {
    const w = 26 * U, h = 38 * U;
    g.save(); g.translate(x, y); g.rotate(k * 4 * Math.PI);
    g.shadowColor = '#88ffff'; g.shadowBlur = 10 * U;
    const gr = g.createLinearGradient(0, -h / 2, 0, h / 2); gr.addColorStop(0, '#cfe7f5'); gr.addColorStop(0.22, '#cfe7f5'); gr.addColorStop(0.22, '#5ad0b0'); gr.addColorStop(1, '#5ad0b0');
    g.fillStyle = gr; g.beginPath();
    if (g.roundRect) g.roundRect(-w / 2, -h / 2, w, h, [6 * U, 6 * U, 12 * U, 12 * U]); else g.rect(-w / 2, -h / 2, w, h);
    g.fill(); g.restore();
  } });
});
m.clip('burst', t.land, { x: dest.x, y: dest.y, w: 682 * 0.85 * 0.5 * U, z: 50, add: true, filter: K.tintF(165) });
if (tk) m.tint(t.land, 220, tk, '#ffffff', (u) => 0.6 * (1 - E.outQ(u)));
await tl.run(T, { total: t.total, sfx: cfg.sfx || [], onStart: K.ready });
oni.fireDone();
