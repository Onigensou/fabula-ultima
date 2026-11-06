// Bolt spells cast by anyone (gear + class parents, 2026-11-06). cfg.mode picks one:
//   fulgur       — tier 1: the Glacies-style cast (step out, yellow circle), then a
//                  SMALL spark burst on each target, 140 ms apart.
//   thunderstorm — Rumbling Staves' Chain 3 seek: the same cast, then three bolts
//                  from the sky, one per planned strike, each on the strike's REAL
//                  target (the plan already followed any redirect). oni.hit() on
//                  each bolt's contact frame reveals that strike's number. A miss
//                  strikes the ground beside the target; a lost strike draws nothing.
// No plan (Preview Bench): the bolts pick random targets so the shot still reads.
// Storage rules: no backticks and no dollar-brace anywhere in this file.
if (!caster) { K.ready(); oni.fireDone(); return; }
const mode = cfg.mode;
if (!targets.length) { K.ready(); oni.fireDone(); return; }
const B = await boot(); const { tl, T, m, TOK, TG, U, E } = B;
const t = cfg.t; const dir = K.dirOf(TOK, 'c');
const R = t.rel;
const fx = (key, tt, pt, o) => { o = o || {}; const d = A.clips[key]; if (!d) return; m.clip(key, tt, { x: pt.x, y: pt.y, w: d.w * 0.85 * (o.scale || 1) * U, z: o.z || 50, add: !!o.add }); };
const hurt = (tt, k) => { m.tint(tt, 220, k, '#fff6b0', (u) => 0.65 * (1 - u)); const d = -K.dirOf(TOK, k); m.hold(tt, tt + 300, (e, S) => { const q = S.tok[k]; if (q) q.dx += d * Math.sin(e / 300 * Math.PI * 4) * 9 * U * (1 - e / 300); }); };
const once = (at, fn) => { let done = false; m.hold(at, 1e9, () => { if (done) return; done = true; try { fn(); } catch (e) { console.warn('[gear-bolt] cue threw', e); } }); };
// Thunderstorm channels through its anticipation: the circle holds and the caster
// stays out until the first bolt (t.strike0); Fulgur releases at R as before.
const REL2 = mode === 'thunderstorm' ? (t.strike0 || R) : R;
K.step(m, E, U, dir, 'c', 0, 0, t.back || REL2, 46);
K.circle(tl, m, U, 'c', 380, REL2 - 380, cfg.hue, { dx: dir * 46 * U, scale: t.scale });
if (mode === 'fulgur') {
  // tier 1: a small crackle on each target (005 hit clip at ~55 %), damage on the burst
  TG.forEach((k, i) => { const at = R + i * 140; fx('spark', at, K.mid(tl, k), { scale: t.sparkScale, add: true }); hurt(at + 120, k); });
} else if (mode === 'thunderstorm') {
  const byUuid = {}; targets.forEach((tok, i) => { byUuid[tok.document.uuid] = TG[i]; });
  const plan = oni.strikes || [];
  const n = plan.length || t.bolts;
  const S0 = t.strike0 || R;
  // ── anticipation (King Gorger entrance, shot 1): a dark storm cloud looms in
  // over the top of the field while the quake rumble rolls (cfg sfx), the dim
  // deepens, and far-off lightning flickers inside the cloud before it breaks.
  m.dim(300, 700, t.dim1);
  m.dim(R, S0 - R, t.dim2, t.dim1);
  const UND = S0 + (n - 1) * t.gap + t.undimAfter;
  m.undim(UND, t.undimMs, t.dim2);
  const fl = t.flickers || [];
  fl.forEach((f) => m.flash(f[0], 30, f[1], '#d6defa', f[2]));
  // the cloud: blurred dark blobs (giant-entrance-fx cloud(), rgba 8,3,16) baked
  // once into a screen-sized band, pinned to the top of the view every frame
  const SL = oni.screenLive();
  const cw = Math.round(SL.W), ch = Math.round(SL.H * t.cloudBand);
  const cc = document.createElement('canvas'); cc.width = cw; cc.height = ch;
  const cx = cc.getContext('2d');
  let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  cx.filter = 'blur(' + Math.round(ch * 0.06) + 'px)';
  for (let i = 0; i < t.cloudBlobs; i++) {
    const x = rnd() * cw, y = rnd() * ch * 0.55, rx = cw * (0.10 + rnd() * 0.16), ry = ch * (0.22 + rnd() * 0.22);
    const g = cx.createRadialGradient(x, y, 0, x, y, rx);
    g.addColorStop(0, 'rgba(8,3,16,0.85)'); g.addColorStop(1, 'rgba(8,3,16,0)');
    cx.save(); cx.translate(x, y); cx.scale(1, ry / rx); cx.translate(-x, -y); cx.fillStyle = g; cx.fillRect(x - rx, y - rx, rx * 2, rx * 2); cx.restore();
  }
  // a solid top edge, so the band reads as a ceiling of cloud, not floating puffs
  cx.filter = 'none';
  const top = cx.createLinearGradient(0, 0, 0, ch); top.addColorStop(0, 'rgba(8,3,16,0.9)'); top.addColorStop(0.45, 'rgba(8,3,16,0.35)'); top.addColorStop(1, 'rgba(8,3,16,0)');
  cx.fillStyle = top; cx.fillRect(0, 0, cw, ch);
  const cloudTex = PIXI.Texture.from(cc);
  const sky = oni.layer({ zIndex: 89990 });
  const cloud = new PIXI.Sprite(cloudTex); cloud.anchor.set(0.5, 0); sky.addChild(cloud);
  const w0 = cloud.texture.width;
  m.hold(0, t.total, (now) => {
    const z = SL.zoom;
    const inK = E.outQ(Math.min(1, Math.max(0, (now - 300) / t.cloudInMs)));
    const outK = now < UND ? 0 : Math.min(1, (now - UND) / t.undimMs);
    const p = SL.S2W(0.5 + 0.015 * Math.sin(now / 1400), 0);
    cloud.position.set(p.x, p.y + SL.hPx(-t.cloudBand * (1 - inK) * 0.6 - t.cloudBand * outK * 0.5));
    cloud.scale.set((SL.W * 1.15 / w0) / z);
    cloud.alpha = t.cloudAlpha * inK * (1 - outK);
  });
  for (let i = 0; i < n; i++) {
    const at = S0 + i * t.gap;
    const s = plan[i]; const o = s && s.outcomes ? s.outcomes[0] : null;
    const k = (o && byUuid[o.tokenUuid]) || TG[Math.floor(Math.random() * TG.length)];
    const kind = o ? o.kind : 'hit';
    if (kind !== 'lost' && kind !== 'skip') {
      const f = K.feet(tl, k);
      const p = kind === 'miss' ? { x: f.x + (i % 2 ? 1 : -1) * TOK[k].w * 0.55, y: f.y } : f;
      fx('bolt', at, p, { scale: t.boltScale, add: true, z: 60 });
      m.flash(at + t.contact, 40, 140, '#fffbe0', 0.22);
      m.shake(at + t.contact, 220, 7 * U);
      if (kind !== 'miss') hurt(at + t.contact, k);
    }
    // one cue per planned strike, in order, even for a miss or a lost bolt
    once(at + t.contact, () => oni.hit({ paced: true }));
  }
}
await tl.run(T, { total: t.total, sfx: (cfg.sfx || []).filter((c) => !c.n || c.n <= (mode === 'fulgur' ? TG.length : 99)), onStart: K.ready });
oni.fireDone();
