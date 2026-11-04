// Hina: Starfall Comet (cfg.n = 1) / Starfall (cfg.n = 3) -- approved mockup, Round 3 gold.
// Night-blue dim + starfield, gold hexagram circle with the comet rune ring, then
// gold RO comets (new_comet recoloured by GOLD) on the targets, 420 ms apart.
// Comet i lands on the i-th entry of the target list (cycled), so a repeated
// random target in the list gets two comets, as the mockup allows.
if (!caster || !targets.length) { K.ready(); oni.fireDone(); return; }
const ORDER = targets.map((t) => t.id);
for (let i = targets.length - 1; i >= 0; i--) if (targets.findIndex((x) => x.id === targets[i].id) !== i) targets.splice(i, 1);
const B = await boot(); const { tl, T, m, TOK, TG, U, E } = B;
const t = cfg.t; const dir = K.dirOf(TOK, 'c'); const SC = tl.SCENE, ST = tl.STAGE;
const GOLD = 'hue-rotate(170deg) saturate(1.6) brightness(1.15)';
const fx = (key, at, pt, o) => { o = o || {}; const d = A.clips[key]; if (!d) return; m.clip(key, at, { x: pt.x, y: pt.y, w: d.w * 0.85 * (o.scale || 1) * (d.ro ? 1.9 : 1) * U, z: o.z || 50, add: !!o.add, filter: o.filter }); };
const hurt = (at, k) => { m.tint(at, 220, k, '#ffffff', (u) => 0.6 * (1 - u)); const d = -K.dirOf(TOK, k); m.hold(at, at + 300, (e, S) => { const q = S.tok[k]; if (q) q.dx += d * Math.sin(e / 300 * Math.PI * 4) * 9 * U * (1 - e / 300); }); };
// coloured dim (the mockup's night blue): ground layer, under the circle and tokens
const tdim = (at, inMs, to, color, outAt, outMs) => m.hold(at, outAt + outMs, (e, S) => { const tt = at + e; const a = tt < at + inMs ? to * E.sine(e / inMs) : tt < outAt ? to : to * (1 - E.sine((tt - outAt) / outMs)); S.world.push({ z: 0, draw: (g) => { g.save(); g.globalAlpha = a; g.fillStyle = color; g.fillRect(SC.x - SC.w, SC.y - SC.h, SC.w * 3, SC.h * 3); g.restore(); } }); });
// starfield: 170 seeded stars over the top two thirds of the stage, under the tokens
const starfield = (at, outAt) => {
  const r = tl.rng(4242); const stars = [];
  for (let i = 0; i < 170; i++) stars.push({ x: ST.x + r() * ST.w, y: ST.y + r() * ST.h * 0.66, rr: (r() * 1.6 + 0.3) * 4 * U, a: 0.5 + r() * 0.5 });
  const spr = document.createElement('canvas'); spr.width = spr.height = 32; const sg = spr.getContext('2d'); const gr = sg.createRadialGradient(16, 16, 0, 16, 16, 16); gr.addColorStop(0, 'rgba(235,240,255,1)'); gr.addColorStop(1, 'rgba(180,200,255,0)'); sg.fillStyle = gr; sg.fillRect(0, 0, 32, 32);
  m.hold(at, outAt + 600, (e, S) => { const tt = at + e; const k = tt < at + 600 ? E.sine(e / 600) : tt < outAt ? 1 : 1 - E.sine((tt - outAt) / 600);
    S.world.push({ z: 1, draw: (g) => { g.save(); for (const s of stars) { g.globalAlpha = k * s.a; g.drawImage(spr, s.x - s.rr, s.y - s.rr, s.rr * 2, s.rr * 2); } g.restore(); } }); });
};
tdim(0, 600, t.dim, '#060b26', t.end, 600);
starfield(0, t.end);
// cast: step out, Magic3, gold circle + comet ring; step back on release
K.step(m, E, U, dir, 'c', 0, 0, t.rel, 46);
K.circle(tl, m, U, 'c', 380, t.rel - 380, 48, { dx: dir * 46 * U, ring: 'ringComet', scale: t.scale });
for (let i = 0; i < t.n; i++) {
  const id = ORDER[i % ORDER.length]; const k = TG.find((q) => TOK[q].token && TOK[q].token.id === id) || TG[0];
  const c0 = t.rel + i * 420; const f0 = K.feet(tl, k);
  fx('cometBottom', c0, f0, { scale: 0.7, add: true, z: 2, filter: GOLD });
  fx('comet', c0 + 150, f0, { scale: 0.85, add: true, filter: GOLD });
  fx('cometSub', c0 + 640, f0, { scale: 0.9, add: true, z: 52, filter: GOLD });
  m.shake(c0 + 640, 260, 7 * U); hurt(c0 + 640, k);
}
await tl.run(T, { total: t.end + 650, sfx: cfg.sfx || [], onStart: K.ready });
oni.fireDone();
