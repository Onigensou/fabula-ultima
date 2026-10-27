// Searing Brand — stamped on (inner script, every client). Port of the mockup:
// camera 1.5x on the victim, the sigil falls from larger-than-screen onto their
// body and STAMPS (a scale punch), red flash, the victim goes red and shakes
// hard, Gate of Hell ring under their feet; the sigil shrinks up to its overhead
// seat for the persistent badge to take over. Gate at 1.4 s (the stamp).
const cfg = ctx.params.cfg || {};
const A = ctx.params.assets || {};
const caster = ctx.casterToken;
const targets = (ctx.targetTokens || []).filter((t) => t && t.center);
if (!caster || !targets.length) { oni.fireDone(); return; }
const tokens = { faf: { token: caster, art: A.casterArt || null, shadow: A.casterShadow || null, foot: cfg.casterFoot || 0.905, nativeDir: -1, hurt: null } };
const TG = []; targets.forEach((t, i) => { const k = 't' + i; TG.push(k); tokens[k] = { token: t, foot: cfg.partyFoot || 0.97 }; });
const tl = oni.timeline({ tokens, clips: A.clips || {}, images: { brand: A.brandImg } });
await tl.load();
const E = tl.E, seg = tl.seg, lerp = tl.lerp;
const TOK = tl.TOK, IMG = tl.IMG, feet = tl.feet, REST = tl.REST;
const T = []; const m = tl.mk(T);
const vk = TG[0]; const V = TOK[vk]; const f = feet(V);
m.cam(0, 900, { cx: V.x, cy: V.y - 60, zoom: 1.5 }); m.beat(0, 'close in');
const onY = V.y - 10, overY = V.y - V.h / 2 * 0.78 - 60;
m.hold(500, 3800, (tl2, S) => { const u = E.inQ(seg(tl2, 0, 900)); let sz = lerp(1600, V.h * 1.1, u), y = lerp(V.y - 900, onY, u), a = tl2 < 900 ? 0.85 : 0.8; if (tl2 >= 900 && tl2 < 1020) { const p = 1 - (tl2 - 900) / 120; sz *= 1 + 0.35 * p; } if (tl2 >= 1500) { const k = E.ioQ(seg(tl2, 1500, 2000)); sz = lerp(V.h * 1.1, 120, k); y = lerp(onY, overY, k); a = lerp(0.8, 1, k); }
  S.world.push({ z: 90, draw: (g) => { const img = IMG.brand; if (!img) return; const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height; const h = sz, w = h * iw / ih; g.save(); g.globalAlpha = a; g.drawImage(img, V.x - w / 2, y - h / 2, w, h); g.restore(); } }); });
m.beat(500, 'the sigil falls'); m.beat(1400, 'stamp · mark applied');
m.clip('gate', 1400, { x: f.x, y: f.y, w: 440, z: 40 }); m.flash(1400, 80, 400, '#ff3b30', 0.25); m.shake(1400, 420, 9); m.shakeTok(1400, vk, 520, 18); m.tint(1400, 900, vk, '#ff2a2a', (k) => k < 0.3 ? 1 : 1 - (k - 0.3) / 0.7);
m.beat(2000, 'to the overhead seat'); m.beat(2600, 'home'); m.cam(2600, 900, { cx: REST.cx, cy: REST.cy, zoom: 1 });

await tl.run(T, { total: cfg.totalMs || 3800, sfx: cfg.sfx || [], onStart: () => { const h = ctx.params.readyHook; if (h) { try { Hooks.callAll(h); } catch (e) {} } } });
oni.fireDone();
