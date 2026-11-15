// ── Gryphon kit (legacy boss port, 2026-11-16) ─────────────────────────────────
// Canvas-2D ports of the legacy-boss mockup's shared kit (part-common.js / part-engine.js) that the
// Gryphon's moves use: wind wisps, floor rings, dust, cracks, a growing floor shadow, a drawn crescent,
// projectiles (dart / wind ball / wind crescent), horizontal speed lines, rumble, afterimage ghosts.
// Every helper schedules timeline tracks at an absolute time (ms) instead of running in real time.
// Sizes are mockup px (1682 px stage) times KP; s = the depth factor of the body the effect sits on.
// Prepended after _zpkit (ZP.once / ZP.hit / ZP.flinchTok / ZP.cutin). No backticks, no dollar-brace.
const GK = {};
GK.make = (tl, m, KP, seed) => {
  const E = tl.E, seg = tl.seg, lerp = tl.lerp, TOK = tl.TOK, feet = tl.feet;
  const R = tl.rng(seed || 77);
  const rnd = (a, b) => a + (b - a) * R();
  const K = {};
  K.rnd = rnd;
  const glow = (g, x, y, r, rgb, a) => { if (!(r > 0) || !(a > 0)) return; const gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, 'rgba(' + rgb + ',' + a + ')'); gr.addColorStop(1, 'rgba(' + rgb + ',0)'); g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill(); };
  K.glow = glow;
  // one particle = one track; fn(g, ageMs, u 0..1). comp: 'lighter' (the mockup particle default) or 'source-over'
  const add = (at, life, z, fn, comp) => m.hold(at, at + life, (e, S) => { S.world.push({ z, draw: (g) => { g.save(); g.globalCompositeOperation = comp || 'lighter'; try { fn(g, e, Math.min(1, e / life)); } catch (er) {} g.restore(); } }); });
  K.add = add;
  // depth factor of a timeline token relative to the caster ('k'), times KP
  K.s = (k) => { const T = TOK[k]; if (!T || !TOK.k) return KP; return KP * tl.depthRatio(feet(TOK.k), feet(T)); };
  K.center = (k) => { const T = TOK[k], f = feet(T); return { x: f.x, y: f.y - T.h * 0.5 }; };
  K.feet = (k) => feet(TOK[k]);

  // floor ring (ground layer, under the bodies)
  K.ring = (at, pt, o) => { o = o || {}; const rgb = o.rgb || '255,255,255', r0 = o.r0 == null ? 10 : o.r0, r1 = o.r1 == null ? 160 : o.r1, ms = o.ms || 600, sy = o.sy || 0.3, w = o.w || 6, s = o.s || KP;
    add(at, ms, 2, (g, e, t) => { const r = lerp(r0, r1, E.outC(t)) * s; g.strokeStyle = 'rgba(' + rgb + ',' + (1 - t) + ')'; g.lineWidth = Math.max(0.5, w * (1 - t * 0.6) * s); g.beginPath(); g.ellipse(pt.x, pt.y, Math.max(0.1, r), Math.max(0.1, r * sy), 0, 0, 7); g.stroke(); }); };
  // ground cracks
  K.crack = (at, pt, s) => { s = s || KP; const segs = []; for (let i = 0; i < 7; i++) segs.push([rnd(0, Math.PI * 2), rnd(30, 80)]);
    add(at, 1600, 3, (g, e, t) => { g.strokeStyle = 'rgba(30,18,10,' + (t > 0.7 ? (1 - t) / 0.3 * 0.8 : 0.8) + ')'; g.lineWidth = 3 * s;
      for (const sg of segs) { const a = sg[0], L = sg[1]; g.beginPath(); g.moveTo(pt.x, pt.y); g.lineTo(pt.x + Math.cos(a) * L * s * 0.5, pt.y + Math.sin(a) * L * s * 0.16); g.lineTo(pt.x + Math.cos(a + 0.3) * L * s, pt.y + Math.sin(a + 0.3) * L * s * 0.32); g.stroke(); } }, 'source-over'); };
  // dust puffs thrown up and out from a point (velocity decays with drag .97 per 16 ms)
  K.dust = (at, pt, o) => { o = o || {}; const n = o.n || 14, s = o.s || KP, rgb = o.rgb || '190,170,140'; const dk = -Math.log(0.97) / 16;
    for (let i = 0; i < n; i++) { const an = rnd(Math.PI, Math.PI * 2), sp1 = rnd(0.08, 0.25) * s, sp2 = rnd(0.02, 0.1) * s, life = rnd(500, 900), r = rnd(8, 18) * s, x0 = pt.x + rnd(-10, 10) * s;
      add(at, life, 6, (g, e, t) => { const d = (1 - Math.exp(-dk * e)) / dk; const x = x0 + Math.cos(an) * sp1 * d, y = pt.y + Math.sin(an) * sp2 * d; g.fillStyle = 'rgba(' + rgb + ',' + (0.45 * (1 - t)) + ')'; g.beginPath(); g.arc(x, y, r * (1 + t), 0, 7); g.fill(); }, 'source-over'); } };
  // a floor shadow that grows over growMs (ease-in) and is removed at endAt
  K.shadow = (at, growMs, endAt, pt, r, s) => { s = s || KP; add(at, Math.max(1, endAt - at), 2, (g, e) => { const k = E.inQ(Math.min(1, e / growMs)); g.fillStyle = 'rgba(0,0,0,' + (0.55 * k) + ')'; g.beginPath(); g.ellipse(pt.x, pt.y, Math.max(0.1, r * k * s), Math.max(0.1, r * k * s * 0.32), 0, 0, 7); g.fill(); }, 'source-over'); };
  // wind wisps: glowing motes that home in on a point along a curve (mockup homing, ease-in)
  K.wisps = (at, to, o) => { o = o || {}; const n = o.n || 14, rr = (o.r == null ? 220 : o.r) * KP, rgb = o.rgb || '200,255,225', ms = o.ms || 700, arc = 60 * KP, pr = 2 * KP;
    for (let i = 0; i < n; i++) { const a = rnd(0, Math.PI * 2); const from = { x: to.x + Math.cos(a) * rr, y: to.y + Math.sin(a) * rr * 0.6 };
      const cx = (from.x + to.x) / 2 + rnd(-arc, arc), cy = Math.min(from.y, to.y) - rnd(arc * 0.3, arc), life = ms * rnd(0.85, 1.15);
      const at2 = (q) => { const t = E.inQ(Math.min(1, q)), u = 1 - t; return { x: u * u * from.x + 2 * u * t * cx + t * t * to.x, y: u * u * from.y + 2 * u * t * cy + t * t * to.y }; };
      add(at, life, 40, (g, e) => { const p = at2(e / life), q = at2(Math.max(0, e - 16) / life); glow(g, p.x, p.y, pr * 3.5, rgb, 0.95); g.strokeStyle = 'rgba(' + rgb + ',.5)'; g.lineWidth = pr; g.beginPath(); g.moveTo(q.x, q.y); g.lineTo(p.x, p.y); g.stroke(); }); } };
  // a drawn crescent slash across a point; dir mirrors it for a caster facing left
  K.crescent = (at, pt, o) => { o = o || {}; const ang = o.ang == null ? -0.5 : o.ang, len = (o.len || 160) * KP, w = (o.w || 26) * KP, rgb = o.rgb || '255,255,255', ms = o.ms || 260, dir = o.dir || 1;
    add(at, ms, 42, (g, e, t) => { const k = E.outC(Math.min(1, t * 1.6)); g.translate(pt.x, pt.y); g.scale(dir, 1); g.rotate(ang); g.globalAlpha = 1 - Math.max(0, (t - 0.45) / 0.55);
      g.fillStyle = 'rgba(' + rgb + ',.9)'; g.beginPath(); g.moveTo(-len / 2, 0); g.quadraticCurveTo(0, -w * 1.6 * k, len / 2 * k, 0); g.quadraticCurveTo(0, -w * 0.4, -len / 2, 0); g.fill();
      glow(g, 0, -w * 0.5, len * 0.45, rgb, 0.35); }); };
  // a projectile from -> to over ms (ease), arcing up by arc px; draw(g, ageMs) with the tip at 0,0 pointing +x. Returns the arrival time.
  K.fly = (at, from, to, o) => { o = o || {}; const ms = o.ms || 450, ease = o.ease || E.lin, arc = (o.arc || 0) * KP, draw = o.draw, sc = o.scale || KP;
    const pos = (q) => { const u = ease(Math.max(0, Math.min(1, q))); return { x: lerp(from.x, to.x, u), y: lerp(from.y, to.y, u) - arc * Math.sin(Math.PI * u) }; };
    add(at, ms, o.z || 44, (g, e) => { const p = pos(e / ms), q = pos((e - 16) / ms); let an = Math.atan2(p.y - q.y, p.x - q.x); if (!(Math.abs(p.x - q.x) + Math.abs(p.y - q.y) > 0.01)) an = Math.atan2(to.y - from.y, to.x - from.x);
      g.translate(p.x, p.y); g.rotate(an); g.scale(sc, sc); draw(g, e); });
    return at + ms; };
  K.SHAPE = {
    dart: (g) => { g.globalCompositeOperation = 'source-over'; g.fillStyle = '#f4f1ea'; g.beginPath(); g.ellipse(-8, 0, 13, 3.2, 0, 0, 7); g.fill(); g.fillStyle = '#8a6a4a'; g.fillRect(-22, -0.8, 12, 1.6); glow(g, 0, 0, 10, '220,255,230', 0.5); },
    wind: (r, rgb) => { r = r || 26; rgb = rgb || '190,255,215'; return (g, e) => { for (let i = 0; i < 4; i++) { g.strokeStyle = 'rgba(' + rgb + ',' + (0.8 - i * 0.15) + ')'; g.lineWidth = 3; g.beginPath(); g.arc(0, 0, r * (1 - i * 0.18), e / 60 + i * 1.6, e / 60 + i * 1.6 + 3.6); g.stroke(); } glow(g, 0, 0, r * 1.2, rgb, 0.6); }; },
    crs: (g) => { g.rotate(Math.PI / 2); g.fillStyle = 'rgba(200,255,225,.9)'; g.beginPath(); g.moveTo(-34, 0); g.quadraticCurveTo(0, -30, 34, 0); g.quadraticCurveTo(0, -12, -34, 0); g.fill(); glow(g, 0, -10, 36, '160,255,200', 0.4); },
  };
  // horizontal speed lines over the screen (mockup speedLines, angle 0 / PI)
  K.speedLines = (at, end, o) => { o = o || {}; const n = o.n || 26, color = o.color || '255,255,255', alpha = o.alpha == null ? 0.5 : o.alpha, ang = o.angle || 0;
    const L = []; for (let i = 0; i < n; i++) L.push({ u: R(), off: rnd(-1, 1), len: rnd(0.15, 0.45), sp: rnd(0.0015, 0.003), w: rnd(1, 3.2) });
    m.hold(at, end, (e, S) => { S.screen.push({ draw: (g) => { const k = g.W / 1682, ca = Math.cos(ang), sa = Math.sin(ang), nx = -sa, ny = ca; g.save(); g.globalCompositeOperation = 'lighter';
      for (const l of L) { let u = (l.u + 0.3 + l.sp * e) % 1.6 - 0.3; g.strokeStyle = 'rgba(' + color + ',' + (alpha * (0.4 + l.w / 4)) + ')'; g.lineWidth = l.w * k;
        const along = (u * 2 - 1) * 1300 * k, perp = l.off * 900 * k; const x0 = g.W / 2 + ca * along + nx * perp, y0 = g.H / 2 + sa * along + ny * perp; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x0 + ca * l.len * 900 * k, y0 + sa * l.len * 900 * k); g.stroke(); }
      g.restore(); } }); }); };
  // a constant low rumble (mockup rumble(true, px) ... rumble(false))
  K.rumble = (at, end, px) => m.hold(at, end, (e, S) => { S.shake = Math.max(S.shake, px); });
  // a ghost of a timeline token at a recorded pose {dx, dy, air, sx, sy, rot}, fading out over ms (mockup afterimage)
  K.ghost = (at, k, pose, o) => { o = o || {}; const ms = o.ms || 380, op = o.opacity == null ? 0.5 : o.opacity, filter = o.filter || 'brightness(1.6) saturate(.4)'; const T = TOK[k], art = tl.art(k); if (!T || !art) return;
    const f = feet(T); const r = (pose.dx || pose.dy) ? tl.depthRatio(f, { x: f.x + (pose.dx || 0), y: f.y + (pose.dy || 0) }) : 1;
    add(at, ms, o.z == null ? 4 : o.z, (g, e, t) => { g.globalCompositeOperation = 'source-over'; g.globalAlpha = op * (1 - t); g.filter = filter; g.translate(T.x + (pose.dx || 0), f.y + (pose.dy || 0) - (pose.air || 0)); if (pose.rot) g.rotate(pose.rot);
      g.scale(T.flip * (pose.sx || 1) * r, (pose.sy || 1) * r); g.drawImage(art, -T.w / 2, -T.h * T.foot, T.w, T.h); }, 'source-over'); };
  // the hover the real token is drawn with (Flying / idle Float lift, TokenMagic), in drawn px: a painted copy carries it
  const HOV = {};
  K.hover = (k) => { if (k in HOV) return HOV[k]; let v = 0; try { const T = TOK[k], api = globalThis.FUCompanion.api.spriteShadow.airborne; if (T && T.token && api && typeof api.liftOf === 'function') v = Math.max(0, Number(api.liftOf(T.token)) || 0) * (T.m3d || 1); } catch (e) { v = 0; } HOV[k] = v; return v; };
  // the game's hurt reaction on a painted target + its strike cue (number reveal in a Chain; ignored otherwise).
  // noHover: the shot already lifts this body by its hover over the window.
  K.hit = (at, k, tier, cue, noHover) => { ZP.flinchTok(m, at, k, tier || 'normal', 900); if (cue !== false) ZP.hit(m, at, { numbersOnly: true }); const h = noHover ? 0 : K.hover(k); if (h > 0) m.hold(at, at + 900, (e, S) => { S.tok[k].air += h; }); };
  return K;
};
