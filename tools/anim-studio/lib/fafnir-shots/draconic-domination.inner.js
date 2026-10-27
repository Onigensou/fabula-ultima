// Draconic Domination — the curse (inner script, every client). Port of the mockup:
// dim, everyone but the victim fades, camera 1.7x on them, a magic circle on the
// ground, speedlines, the curse vortex wraps them, the specter rises and dives in,
// violet flash and tint, then everything closes. Gate at 4.1 s (the dive lands).
const cfg = ctx.params.cfg || {};
const A = ctx.params.assets || {};
const caster = ctx.casterToken;
const targets = (ctx.targetTokens || []).filter((t) => t && t.center);
if (!caster || !targets.length) { oni.fireDone(); return; }
const tokens = { faf: { token: caster, art: A.casterArt || null, shadow: A.casterShadow || null, foot: cfg.casterFoot || 0.905, nativeDir: -1, hurt: null } };
const TG = []; targets.forEach((t, i) => { const k = 't' + i; TG.push(k); tokens[k] = { token: t, foot: cfg.partyFoot || 0.97 }; });
const tl = oni.timeline({ tokens, clips: A.clips || {} });
await tl.load();
const E = tl.E, seg = tl.seg, lerp = tl.lerp;
const TOK = tl.TOK, feet = tl.feet, REST = tl.REST, D = tl.draw;
const T = []; const m = tl.mk(T);
const vk = TG[0]; const V = TOK[vk]; const f = feet(V);
const others = Object.keys(TOK).filter((k) => k !== vk);

m.dim(0, 800, 0.66); m.cam(0, 1200, { cx: V.x, cy: V.y + 20, zoom: 1.7 }); m.beat(0, 'empty the frame');
m.tw(0, 700, (u, S) => { const a = 1 - E.sine(u); for (const k of others) S.tok[k].alpha = a; }); m.hold(700, 4800, (tl2, S) => { for (const k of others) S.tok[k].alpha = 0; });
m.tw(4800, 1200, (u, S) => { const a = E.sine(u); for (const k of others) S.tok[k].alpha = a; });
// the circle lies ON THE GROUND: squashed to a floor ellipse under the feet
m.clip('circle', 1000, { x: V.x, y: f.y, w: 440, sy: 0.36, z: 2, loop: true, hold: 4300, alpha: (u) => (u < 0.2 ? u / 0.2 : u > 0.9 ? (1 - u) / 0.1 : 1) * 0.85 }); m.beat(1000, 'the circle');
m.hold(1300, 4800, (tl2, S) => { const a = tl2 < 1800 ? seg(tl2, 0, 500) : tl2 > 4200 ? 1 - seg(tl2, 4200, 4800) : 1; S.screen.push({ draw: (g) => D.speedlines(g, g.W, g.H, tl2, a * 0.4, 0.34, '#140704') }); });
m.beat(1600, 'the curse'); m.clip('vortex', 1600, { x: V.x, y: V.y - 10, w: 460, z: 60, loop: true, hold: 3300, alpha: (u) => u < 0.12 ? u / 0.12 : u > 0.85 ? (1 - u) / 0.15 : 1 });
m.tint(1600, 3300, vk, '#3a1050', (k) => k < 0.1 ? k / 0.1 * 0.55 : k > 0.85 ? (1 - k) / 0.15 * 0.55 : 0.55);
m.beat(2400, 'the specter'); m.clip('devil', 2400, { x: V.x, y: V.y - 150, w: 320, z: 63, hold: 1700, alpha: (u) => u < 0.2 ? u / 0.2 : u > 0.75 ? (1 - u) / 0.25 : 1 });
m.beat(3600, 'it goes in');
m.tw(3600, 500, (u, S) => { const k = E.ioQ(u); S.world.push({ z: 64, draw: (g) => { g.save(); g.translate(V.x, lerp(V.y - 150, V.y, k)); g.scale(1 - 0.8 * k, 1 - 0.8 * k); g.globalAlpha = 1 - k * 0.9; D.glowCircle(g, 0, 0, 160, '#b58cff', 1); g.restore(); } }); });
m.flash(4100, 120, 600, '#b58cff', 0.45); m.shakeTok(4100, vk, 600, 12); m.tint(4100, 900, vk, '#b58cff');
m.beat(4800, 'close'); m.cam(4800, 1600, { cx: REST.cx, cy: REST.cy, zoom: 1 }); m.undim(4800, 900, 0.66);

await tl.run(T, { total: cfg.totalMs || 6800, sfx: cfg.sfx || [], onStart: () => { const h = ctx.params.readyHook; if (h) { try { Hooks.callAll(h); } catch (e) {} } } });
oni.fireDone();
