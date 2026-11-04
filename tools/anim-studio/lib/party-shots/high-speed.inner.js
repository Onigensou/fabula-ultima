// High Speed — port of the original "AfterImageBlurStep" pseudo script onto
// oni.timeline, same numbers: blur sway +/-70 px x7 (55 ms each), afterimages every
// 35 ms (fade 240), snap to centre, vanish 120, empty beat 140, fade back in 520.
// Fired by the play_animation step at the head of the hs_react chain (conflict start).
if (!caster) { oni.fireDone(); return; }
const B = await boot(); const { tl, T, m, TOK, U, E } = B;
const p = cfg.p; const C = TOK.c; const art = tl.art('c'); const f = K.feet(tl, 'c');
const swingEnd = p.swings * p.swingMs, snapEnd = swingEnd + Math.max(35, Math.floor(p.swingMs * 0.8));
const vanishEnd = snapEnd + p.disappearFadeMs, backAt = vanishEnd + p.hiddenHoldMs, end = backAt + p.returnFadeMs;
const xAt = (e) => {
  if (e >= swingEnd) { const x0 = (p.swings % 2 ? -1 : 1) * p.amplitude; return e < snapEnd ? x0 * (1 - E.sine((e - swingEnd) / (snapEnd - swingEnd))) : 0; }
  const i = Math.floor(e / p.swingMs), u = E.sine((e - i * p.swingMs) / p.swingMs);
  const from = i === 0 ? 0 : (i % 2 ? -1 : 1) * p.amplitude, to = (i % 2 ? 1 : -1) * p.amplitude;
  return from + (to - from) * u;
};
const drawC = (g, x, a, blur) => { if (!art || a <= 0) return; g.save(); g.translate(x, f.y); g.scale(C.flip, 1); g.globalAlpha = a; g.filter = 'blur(' + blur + 'px)'; g.drawImage(art, -C.w / 2, -C.h * C.foot, C.w, C.h); g.restore(); };
m.hold(0, end + 1, (e, S) => {
  S.tok.c.hidden = true;
  S.world.push({ z: 20, draw: (g) => {
    // afterimages: one stamp per 35 ms over the swing, each fading in 240 ms
    if (e < snapEnd + p.afterimageFadeMs) for (let s = 0; s * p.afterimageEveryMs <= Math.min(e, snapEnd); s++) { const age = e - s * p.afterimageEveryMs; if (age < 0 || age > p.afterimageFadeMs) continue; drawC(g, f.x + xAt(s * p.afterimageEveryMs) * U, 0.34 * (1 - age / p.afterimageFadeMs), 3); }
    if (e < snapEnd) drawC(g, f.x + xAt(e) * U, 1, p.blurStrength);
    else if (e < vanishEnd) drawC(g, f.x, 1 - E.outC((e - snapEnd) / p.disappearFadeMs), p.blurStrength + 4);
    else if (e >= backAt) drawC(g, f.x, E.outC(Math.min(1, (e - backAt) / p.returnFadeMs)), 1.5);
  } });
});
await tl.run(T, { total: end + 60, sfx: cfg.sfx || [], onStart: K.ready });
oni.fireDone();
