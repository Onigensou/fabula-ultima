// Ninja Log — approved mockup (round 3, 2026-11-06): the substitution trick on a BLOCK.
// Plays when a hit is soaked to 0 by Ninja Log (director-vfx playBlockVfx, which already
// floats BLOCK + plays the Parry block sound), on whoever wears it. Simple level: no
// cut-in, no dim, no camera. Every sound plays once (Parry is BD's, not ours).
//   0     GG smoke_anim08 puff over the wearer (first puff only, 0.7x) + Shukuchi
//   70    the wearer is gone; the item's own sprite (Log.png, never rotated) stands in
//         his place, pops up and drops to the floor like a video-game item drop
//   land  one small bounce + the wood thud
//   vanish  a second GG puff swallows the log + Smoke Bomb
//   back  a silent GG puff on the wearer's spot; he is back, with a short white flash
if (!caster) { K.ready(); oni.fireDone(); return; }
const B = await boot(); const { tl, T, m, TOK, E } = B;
const t = cfg.t; const k = cfg.k;
const C = TOK.c; const cf = K.feet(tl, 'c'); const cm = K.mid(tl, 'c');
const dir = K.dirOf(TOK, 'c');
const H = C.h;
const img = tl.IMG.log;
const LB = H * k.logSize;                       // the log sprite's square box
const rest = cf.y - LB / 2;                      // centre when its box sits on the floor
const top = cm.y - H * k.popH;
const drift = dir * H * k.drift;
const land = t.swap + t.pop + t.drop;
const vanish = land + t.bounce + t.lie;
const back = vanish + t.vanishHold + t.returnPause;

// GG smoke_anim08 holds two puffs back to back: show only the first, slowed to 0.7x.
const PUFF = Math.round(380 / 0.7);
function puff(at, p, w) {
  const cl = m.clip('poof', at, { x: p.x, y: p.y, w, z: 60, hold: PUFF, depth: false, filter: 'drop-shadow(0 3px 2px rgba(0,0,0,.25))', alpha: (u) => (u > 0.7 ? Math.max(0, (1 - u) / 0.3) : 1) });
  m.hold(at, at + PUFF, () => { const v = cl && cl.copy && cl.copy.video; if (v && v.playbackRate !== 0.7) v.playbackRate = 0.7; });
}

// the wearer is hidden from the swap until his return
m.hold(t.swap, back + t.reveal, (e, S) => { if (S.tok.c) S.tok.c.hidden = true; });
puff(0, { x: cm.x, y: cm.y + H * 0.05 }, H * k.swapPuff);

// the log: centre position over time (static sprite)
const logAt = (at) => {
  if (at < t.pop) { const u = E.outQ(at / t.pop); return { x: cf.x + drift * 0.45 * u, y: cm.y + (top - cm.y) * u }; }
  const a2 = at - t.pop;
  if (a2 < t.drop) { const u = E.inQ(a2 / t.drop); return { x: cf.x + drift * (0.45 + 0.45 * u), y: top + (rest - top) * u }; }
  const a3 = a2 - t.drop;
  if (a3 < t.bounce) { const u = a3 / t.bounce; return { x: cf.x + drift * (0.9 + 0.1 * u), y: rest - Math.sin(u * Math.PI) * H * k.popH * 0.18 }; }
  return { x: cf.x + drift, y: rest };
};
m.hold(t.swap, vanish + t.logGone, (e, S) => {
  if (!img) return; const p = logAt(e);
  S.world.push({ z: 20, draw: (g) => { g.save(); g.imageSmoothingEnabled = false; g.filter = 'drop-shadow(0 4px 3px rgba(0,0,0,.35))'; g.drawImage(img, p.x - LB / 2, p.y - LB / 2, LB, LB); g.restore(); } });
});
// the vanish puff on the fallen log
const lp = logAt(1e9);
puff(vanish, { x: lp.x, y: lp.y - LB * 0.1 }, H * k.vanishPuff);
// back on his spot: a silent puff, then he reappears with a short white flash
puff(back, cm, H * k.backPuff);
m.tint(back + t.reveal, 320, 'c', '#ffffff', (u) => 0.55 * (1 - u));
await tl.run(T, { total: back + PUFF + 500, sfx: cfg.sfx || [], onStart: K.ready });
oni.fireDone();
