// Rend — claw swap (inner script, every client). Port of the mockup: she leans in
// (no travel: her sprite is too big to lunge), Claw Thunder plays on the victim,
// she returns. Gate at 0.527 s (the clip's own target flash, 67 ms in).
const cfg = ctx.params.cfg || {};
const A = ctx.params.assets || {};
const caster = ctx.casterToken;
const targets = (ctx.targetTokens || []).filter((t) => t && t.center);
if (!caster || !targets.length) { oni.fireDone(); return; }
const tokens = { faf: { token: caster, art: A.casterArt || null, shadow: A.casterShadow || null, foot: cfg.casterFoot || 0.905, nativeDir: -1, hurt: null } };
const TG = []; targets.forEach((t, i) => { const k = 't' + i; TG.push(k); tokens[k] = { token: t, foot: cfg.partyFoot || 0.97 }; });
const tl = oni.timeline({ tokens, clips: A.clips || {} });
await tl.load();
const E = tl.E; const TOK = tl.TOK;
const T = []; const m = tl.mk(T);
const vk = TG[0]; const V = TOK[vk]; const F = TOK.faf;
const dx = V.x - F.x, dy = V.y - F.y, len = Math.hypot(dx, dy) || 1, reach = F.w / 2 * 0.22;
m.beat(0, 'wind-up'); m.tw(0, 260, (u, S) => { const v = E.outQ(u); S.tok.faf.dx = -dx / len * reach * 0.35 * v; S.tok.faf.dy = -dy / len * reach * 0.35 * v; });
m.beat(260, 'shove'); m.tw(260, 200, (u, S) => { const v = E.outQ(u); S.tok.faf.dx = -dx / len * reach * 0.35 * (1 - v) + dx / len * reach * v; S.tok.faf.dy = -dy / len * reach * 0.35 * (1 - v) + dy / len * reach * v; });
m.hold(460, 900, (tl2, S) => { S.tok.faf.dx = dx / len * reach; S.tok.faf.dy = dy / len * reach; });
m.clip('claw', 460, { x: V.x, y: V.y, w: 300, z: 50 }); m.beat(460, 'claw · damage gate'); m.shakeTok(527, vk, 480, 8);
m.beat(900, 'return'); m.tw(900, 520, (u, S) => { const v = 1 - E.ioQ(u); S.tok.faf.dx = dx / len * reach * v; S.tok.faf.dy = dy / len * reach * v; });

await tl.run(T, { total: cfg.totalMs || 2400, sfx: cfg.sfx || [], onStart: () => { const h = ctx.params.readyHook; if (h) { try { Hooks.callAll(h); } catch (e) {} } } });
oni.fireDone();
