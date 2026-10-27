// Condemn — sharp needles + detonation (inner script, every client). Port of the
// mockup: dim, bystanders out, camera 1.75x on the accused; they are hauled off
// the ground and pinned by seven conjured spears thrown from uneven angles at
// uneven gaps; a purple burst + the lion shockwave detonate them; they drop.
// Gate at 3.7 s (the detonation).
const cfg = ctx.params.cfg || {};
const A = ctx.params.assets || {};
const caster = ctx.casterToken;
const targets = (ctx.targetTokens || []).filter((t) => t && t.center);
if (!caster || !targets.length) { oni.fireDone(); return; }
const tokens = { faf: { token: caster, art: A.casterArt || null, shadow: A.casterShadow || null, foot: cfg.casterFoot || 0.905, nativeDir: -1, hurt: null } };
const TG = []; targets.forEach((t, i) => { const k = 't' + i; TG.push(k); tokens[k] = { token: t, foot: cfg.partyFoot || 0.97 }; });
const tl = oni.timeline({ tokens, clips: A.clips || {}, images: { spearHead: A.spearHead, spearShaft: A.spearShaft } });
await tl.load();
const E = tl.E, seg = tl.seg, lerp = tl.lerp, rng = tl.rng;
const TOK = tl.TOK, feet = tl.feet, REST = tl.REST, D = tl.draw;
const T = []; const m = tl.mk(T);
const vk = TG[0]; const V = TOK[vk]; const f = feet(V);
const others = Object.keys(TOK).filter((k) => k !== vk && k !== 'faf');

m.dim(0, 800, 0.62); m.cam(0, 1200, { cx: V.x - 60, cy: V.y - 40, zoom: 1.75 }); m.beat(0, 'the accused');
m.tw(0, 700, (u, S) => { for (const k of others) S.tok[k].alpha = 1 - E.sine(u); }); m.hold(700, 5000, (tl2, S) => { for (const k of others) S.tok[k].alpha = 0; }); m.tw(5000, 1100, (u, S) => { for (const k of others) S.tok[k].alpha = E.sine(u); });
m.tw(1000, 700, (u, S) => { S.tok[vk].dy = -160 * E.outQ(u); }); m.beat(1000, 'lifted');
m.hold(1700, 1900, (tl2, S) => { S.tok[vk].dy = -160 + Math.sin(tl2 / 40) * 9; });
const r = rng(7); const needles = []; let at = 1900; const base = [0.1, 2.9, 1.2, 4.4, 5.6, 3.7, 0.6];
for (let i = 0; i < 7; i++) { const an = base[i] + (r() - 0.5) * 0.9; at += i ? 90 + r() * 180 : 0; needles.push({ an, at, len: 220 + r() * 220, depth: 0.08 + r() * 0.22 }); }
m.beat(1900, 'the blades');
m.hold(1900, 4000, (tl2, S) => { let dy = -160; S.world.push({ z: 70, draw: (g) => { for (const n of needles) { const u = seg(tl2, n.at - 1900, n.at - 1900 + 240); if (u <= 0) continue; const farR = 1000; const cx = V.x, cy = V.y - 160; const sx = cx + Math.cos(n.an) * farR, sy = cy + Math.sin(n.an) * farR; const ex = cx + Math.cos(n.an) * n.len * n.depth, ey = cy + Math.sin(n.an) * n.len * n.depth; const k = E.outC(u); D.needle(g, lerp(sx, ex, k), lerp(sy, ey, k), n.an, n.len, 1, tl2 + n.at); } } });
  for (const n of needles) { const d = tl2 - (n.at - 1900 + 240); if (d >= 0 && d < 120) dy += Math.sin(d / 12) * 13 * (1 - d / 120); } S.tok[vk].dy = dy; });
m.beat(3100, 'pinned'); m.beat(3700, 'detonation · damage gate');
// the Disgaea burst is a pixel sprite: near native scale; the lion shockwave carries the size
m.clip('pburst', 3700, { x: f.x, y: f.y - 40, w: 400, z: 80 }); m.clip('lion', 3700, { x: V.x, y: V.y - 120, w: 1200, z: 79 });
m.flash(3700, 140, 760, '#b98cff', 0.55); m.shake(3700, 820, 16);
m.hold(4000, 4300, (tl2, S) => { S.tok[vk].dy = -160 * (1 - E.inQ(tl2 / 300)); }); m.shake(4300, 520, 16); m.shakeTok(4300, vk, 500, 10); m.beat(4000, 'dropped');
m.beat(5000, 'home'); m.cam(5000, 1100, { cx: REST.cx, cy: REST.cy, zoom: 1 }); m.undim(5000, 1100, 0.62);

await tl.run(T, { total: cfg.totalMs || 6800, sfx: cfg.sfx || [], onStart: () => { const h = ctx.params.readyHook; if (h) { try { Hooks.callAll(h); } catch (e) {} } } });
oni.fireDone();
