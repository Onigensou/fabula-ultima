// Storm Calm — the storm comes back into her (inner script, every client). Port of
// the mockup: dim, camera 1.55x onto her, the water-drop cue alone, then the
// Pramen rune ring on the ground under her, crossed lightning flickering into her
// chest three times with her glyphs glowing, the Energy Coat burst as the MP
// lands, undim and home. Gate at 3.3 s (the MP lands).
const cfg = ctx.params.cfg || {};
const A = ctx.params.assets || {};
const caster = ctx.casterToken;
if (!caster) { oni.fireDone(); return; }
const tokens = { faf: { token: caster, art: A.casterArt || null, shadow: A.casterShadow || null, foot: cfg.casterFoot || 0.905, nativeDir: -1, hurt: null } };
const tl = oni.timeline({ tokens, clips: A.clips || {} });
await tl.load();
const seg = tl.seg; const TOK = tl.TOK, feet = tl.feet, REST = tl.REST;
const T = []; const m = tl.mk(T);
const F = TOK.faf; const f = feet(F); const dir = F.dir || 1; const cx = F.x + F.w * 0.05 * dir, cy = F.y + F.h * 0.02;
m.dim(0, 900, 0.55); m.cam(0, 1500, { cx: F.x, cy: F.y, zoom: 1.55 }); m.beat(0, 'break off');
m.beat(1900, 'the cue'); m.beat(2520, 'the storm returns');
m.clip('pramen', 2520, { x: f.x, y: f.y + 10, w: 1500, sy: 0.34, z: 2, alpha: (u) => u < 0.15 ? u / 0.15 : u > 0.8 ? (1 - u) / 0.2 : 1 });
[[2520, -120, -60], [2700, 110, -20], [2880, -30, 40]].forEach(([at, dx, dy]) => m.clip('magical', at, { x: cx + dx, y: cy + dy + 80, w: 360, z: 40, add: true }));
m.hold(2520, 4000, (tl2, S) => { S.tok.faf.glow = tl.clamp01(tl2 / 600) * (1 - seg(tl2, 900, 1480)); });
m.beat(3300, '+50 MP lands'); m.clip('energycoat', 3300, { x: cx, y: cy + 120, w: 1000, z: 41, add: true }); m.clip('energycoat', 3380, { x: cx + 60, y: cy + 60, w: 700, z: 41, add: true });
m.beat(4200, 'home'); m.cam(4200, 1200, { cx: REST.cx, cy: REST.cy, zoom: 1 }); m.undim(4200, 1200, 0.55);

await tl.run(T, { total: cfg.totalMs || 5600, sfx: cfg.sfx || [], onStart: () => { const h = ctx.params.readyHook; if (h) { try { Hooks.callAll(h); } catch (e) {} } } });
oni.fireDone();
