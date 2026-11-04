// Life Transference — approved mockup (v8). A reaction after her action made
// enemies lose HP. Target = the healed ally (Keren herself when the list is
// empty: the mote then just rises and lands back on her). A violet-green mote
// (Absorb1) arcs from Keren to the ally (900 ms, height 140); Heal3 + MV
// 041_heal_one_1 on the ally; the heal lands 450 ms into the clip (gate).
if (!caster) { K.ready(); oni.fireDone(); return; }
const B = await boot(); const { tl, T, m, TOK, TG, U, E } = B;
const t = cfg.t;
const tk = TG[0] || 'c';
const from = K.mid(tl, 'c'), to = K.mid(tl, tk), tf = K.feet(tl, tk);
K.orb(m, 0, from, to, t.travel, 140, '#9dffb0', 18, U);
m.clip('heal', t.travel, { x: tf.x, y: tf.y, w: 546 * 0.85 * 0.85 * U, z: 50 });
await tl.run(T, { total: t.total, sfx: cfg.sfx || [], onStart: K.ready });
oni.fireDone();
