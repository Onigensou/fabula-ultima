// Ruinous Breath · A "Storm Breath" — triple breath (inner script, every client).
// Port of the approved mockup: she rears and charges at the jaw, then three bolt
// beams leave her mouth at once, through each party member and past the stage
// edge, and HOLD for three seconds with bursts landing on the party; the party
// goes black in the glare, the frame whites out and holds, the white clears onto
// the board with her back on all fours. Damage gate at 2.6 s (offset timing).
// No backticks in this file.
const cfg = ctx.params.cfg || {};
const A = ctx.params.assets || {};
const caster = ctx.casterToken;
const targets = (ctx.targetTokens || []).filter((t) => t && t.center);
if (!caster || !targets.length) { oni.fireDone(); return; }

const tokens = { faf: { token: caster, art: A.casterArt || null, shadow: A.casterShadow || null, foot: cfg.casterFoot || 0.905, nativeDir: -1, hurt: null } };
const TG = [];
targets.forEach((t, i) => { const k = 't' + i; TG.push(k); tokens[k] = { token: t, foot: cfg.partyFoot || 0.97 }; });
const tl = oni.timeline({ tokens, clips: A.clips || {} });
await tl.load();

const E = tl.E, seg = tl.seg, lerp = tl.lerp;
const TOK = tl.TOK, feet = tl.feet, STAGE = tl.STAGE, REST = tl.REST, D = tl.draw;
const T = []; const m = tl.mk(T);
const F = TOK.faf; const ff = feet(F); const dir = F.dir || 1; const V = '#c9a5ff';
const PC = { x: TG.reduce((s, k) => s + TOK[k].x, 0) / TG.length, y: TG.reduce((s, k) => s + TOK[k].y, 0) / TG.length };

m.dim(0, 700, 0.55); m.cam(0, 1400, { cx: lerp(F.x, PC.x, 0.39), cy: lerp(F.y, PC.y, 0.5) + 20, zoom: 1.18 }); m.beat(0, 'rear');
m.tw(0, 1400, (u, S) => { const k = E.outQ(u); S.tok.faf.sy = 1 + 0.12 * k; S.tok.faf.sx = 1 - 0.04 * k; S.tok.faf.glow = k; });
m.hold(1400, 5400, (tl2, S) => { S.tok.faf.sy = 1.12; S.tok.faf.sx = 0.96; S.tok.faf.glow = 1 + Math.sin(tl2 / 90) * 0.15; });
// the LIVE jaw: her rear (sx/sy about the feet) moves it, so it is re-read every frame before any clip reads it
const J0 = tl.JAW('faf');
const jawAt = (S) => ({ x: F.x + (J0.x - F.x) * S.tok.faf.sx - F.w * 0.02 * dir, y: ff.y + (J0.y - ff.y) * S.tok.faf.sy });
let J = J0; m.hold(0, 6000, (tl2, S) => { J = jawAt(S); }); m.beat(300, 'charge');
m.clip('chaincast', 300, { x: ff.x, y: ff.y, w: 900, z: 4 }); m.clip('chaincast', 1300, { x: ff.x, y: ff.y, w: 1000, z: 4 });
m.clip('sparkring', 500, { x: J.x, y: J.y, w: 1, z: 30, loop: true, hold: 1800, live: (tl2) => ({ x: J.x, y: J.y, w: lerp(180, 460, E.ioQ(seg(tl2, 0, 1600))) * (1 + Math.sin(tl2 / 50) * 0.04) }) });
m.hold(500, 2300, (tl2, S) => { S.shake = Math.max(S.shake, 5 * seg(tl2, 0, 1600)); });
m.beat(2300, 'release'); m.clip('thunderball', 2300, { x: J.x, y: J.y, w: 1, z: 31, add: true, tint: V, live: () => ({ x: J.x, y: J.y, w: 820 }) });
// the mouth burns while the beams are out
m.clip('sparkring', 2400, { x: J.x, y: J.y, w: 1, z: 42, loop: true, hold: 3000, live: (tl2) => ({ x: J.x, y: J.y, w: 420 * (1 + Math.sin(tl2 / 40) * 0.08) }) });
m.hold(2400, 5400, (tl2, S) => { S.world.push({ z: 41, draw: (g) => D.glowCircle(g, J.x, J.y, 260 + Math.sin(tl2 / 50) * 20, '#d9c2ff', 0.95) }); });
m.cam(2400, 450, { cx: lerp(F.x, PC.x, 0.69), cy: lerp(F.y, PC.y, 0.5) + 20, zoom: 1.22 }, E.ioQ);
// the fan: one beam per target plus one between, ALL at 2400, each aimed THROUGH its target and on past the stage edge on the party's side
const far = (PC.x >= J.x) ? STAGE.x + STAGE.w + 500 : STAGE.x - 500;
const thru = (p) => { const dx = p.x - J.x, dy = p.y - J.y; const k = (far - J.x) / (dx || 1); return { x: far, y: J.y + dy * k }; };
const aims = TG.map((k) => thru({ x: TOK[k].x, y: TOK[k].y }));
if (TG.length >= 2) aims.push(thru({ x: PC.x + 90 * Math.sign(PC.x - J.x), y: PC.y }));
m.beat(2400, 'the fan · damage gate 2.6');
// The clip's bolt starts at 16% of its height and its burst sits at 85.8%: pivot at the bolt's top, pinned to the live jaw, the clip narrowed (sx .8)
const TOP = 0.16;
for (const tg of aims) { const geo = () => { const dx = tg.x - J.x, dy = tg.y - J.y, len = Math.hypot(dx, dy); const dh = len / (0.858 - TOP); return { x: J.x, y: J.y, w: dh * 624 / 704, rot: Math.atan2(dy, dx) - Math.PI / 2 }; };
  for (const [d, off] of [[0, -0.03], [150, 0.03]]) m.clip('thunder1', 2400 + d, { x: 0, y: 0, w: 1, sx: 0.8, z: 40, add: true, tint: V, pivot: { x: 0.5, y: TOP }, loop: true, hold: 3000 - d, alpha: (u) => u < 0.05 ? u / 0.05 : u > 0.85 ? (1 - u) / 0.15 : 1, live: () => { const o = geo(); o.rot += off; return o; } });
}
TG.forEach((k) => { const P = TOK[k]; for (const at of [2600, 3300, 4000, 4700]) m.clip('thunderball', at, { x: P.x, y: P.y, w: at === 2600 ? 380 : 320, z: 50, add: true, tint: V }); });
m.hold(2400, 5400, (tl2, S) => { S.shake = Math.max(S.shake, 12 * (1 - seg(tl2, 800, 1500)) + 5); });
m.flash(2400, 80, 500, '#c9a5ff', 0.45);
TG.forEach((k) => { m.shakeTok(2600, k, 2800, 12); });
// the party goes black in the glare, then the whole frame whites out; the beams end under the white
m.beat(4600, 'silhouettes'); m.hold(4600, 7400, (tl2, S) => { const a = E.sine(seg(tl2, 0, 600)) * (1 - seg(tl2, 2200, 2800)); for (const k of TG) S.tok[k].black = Math.max(S.tok[k].black, a); });
m.beat(5000, 'whiteout'); m.hold(5000, 8300, (tl2, S) => { S.white = Math.max(S.white, E.sine(seg(tl2, 0, 800)) * (1 - E.sine(seg(tl2, 2000, 3300)))); });
m.tw(5400, 500, (u, S) => { const k = E.ioQ(u); S.tok.faf.sy = 1 + 0.12 * (1 - k); S.tok.faf.sx = 1 - 0.04 * (1 - k); S.tok.faf.glow = 1 - k; });
m.hold(5800, 1e9, (tl2, S) => { S.cam = { cx: REST.cx, cy: REST.cy, zoom: 1 }; }); m.undim(6400, 800, 0.55); m.beat(7000, 'the white clears');

await tl.run(T, { total: cfg.totalMs || 8600, sfx: cfg.sfx || [], onStart: () => { const h = ctx.params.readyHook; if (h) { try { Hooks.callAll(h); } catch (e) {} } } });
oni.fireDone();
