// ── Rauben kit (prepended to every Rauben shot by legacy-rauben-signatures.js) ──
// The legacy-boss mockup's shared kit (part-common.js) ported to oni.timeline: sound cues at the
// mockup's loudness, a world-space particle field (dust, coins, twinkles), the afterimage ghost,
// the coin and the thrown axe shapes, depth-scaled bandit runners and the battler size of a bandit.
// Mockup px are on a 1682 px stage; KP scales them to the scene. No backticks, no dollar-brace.
const cfg = ctx.params.cfg || {};
const A = ctx.params.assets || {};
const caster = ctx.casterToken;
const targets = (ctx.targetTokens || []).filter((t) => t && t.center && t !== caster);
const VOL = (cfg.volume == null ? 1 : cfg.volume) * 0.75;   // mockup sfx(key, v) plays at v * 0.75
const readyHook = () => { const h = ctx.params.readyHook; if (h) { try { Hooks.callAll(h); } catch (e) {} } };

function RKit(tl, T) {
  const E = tl.E, seg = tl.seg, lerp = tl.lerp;
  const KP = (tl.STAGE.w || 1682) / 1682;
  const m = tl.mk(T);
  const R = tl.rng(cfg.seed || 7331);
  const rnd = (a, b) => a + (b - a) * R();
  const pick = (arr) => arr[Math.floor(R() * arr.length)];
  const K = { KP, m, R, rnd, pick, E, seg, lerp };
  // the screen px of one mockup stage px (shakes are screen space)
  K.SH = () => { try { return tl.view().H / 788; } catch (e) { return 1; } };
  // fire once when the run reaches 'at' (a track stays open so a slow frame cannot skip it)
  K.once = (at, fn) => { let did = false; T.push({ t0: at, t1: 1e9, fn: () => { if (did) return; did = true; try { fn(); } catch (e) { console.warn('[Rauben] cue threw', e); } } }); };
  // a sound cue: key in A.sfx, v = the mockup volume; o = { rate, fadeAfter, fadeMs }
  K.snd = (at, key, v, o) => { const url = A.sfx && A.sfx[key]; if (!url) return; K.once(at, () => { try { oni.sfx(url, Object.assign({ volume: Math.min(1, v * VOL) }, o || {})); } catch (e) {} }); };
  K.shake = (at, ms, px) => { T.push({ t0: at, t1: at + ms, fn: (tt, S) => { S.shake = Math.max(S.shake, px * K.SH() * (1 - tt / ms)); } }); };
  K.glow = (g, x, y, r, rgb, a) => { if (!(r > 0) || !(a > 0)) return; const gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, 'rgba(' + rgb + ',' + a + ')'); gr.addColorStop(1, 'rgba(' + rgb + ',0)'); g.fillStyle = gr; g.fillRect(x - r, y - r, r * 2, r * 2); };

  // ── particle field: { t0, life, z, draw(g, u, age) }; z < 5 = under the battlers ──
  const P = []; K.P = P;
  K.add = (p) => { P.push(p); return p; };
  m.hold(0, 1e9, (t, S) => {
    if (!P.length) return;
    const zs = {};
    for (let i = P.length - 1; i >= 0; i--) { const p = P[i]; if (t >= p.t0 + p.life) { P.splice(i, 1); continue; } if (t < p.t0 || p.dead) continue; (zs[p.z] = zs[p.z] || []).push(p); }
    for (const z in zs) { const list = zs[z]; S.world.push({ z: Number(z), draw: (g) => { for (const p of list) { const age = t - p.t0; g.save(); try { p.draw(g, age / p.life, age); } catch (e) {} g.restore(); } } }); }
  });
  // dust puffs (dustBurst): n puffs thrown up and out from a floor point, drag .97 per frame
  K.dust = (at, pt, n, s, rgb, z) => { rgb = rgb || '190,170,140'; for (let i = 0; i < n; i++) { const an = rnd(Math.PI, Math.PI * 2), sp = rnd(0.08, 0.25) * s * KP, vy = rnd(0.02, 0.1) * s * KP, x0 = pt.x + rnd(-10, 10) * s * KP, r = rnd(8, 18) * s * KP;
    K.add({ t0: at, life: rnd(500, 900), z: z == null ? 4 : z, draw: (g, u, age) => { const k = (1 - Math.pow(0.97, age / 16.67)) / 0.03 * 16.67; const x = x0 + Math.cos(an) * sp * k, y = pt.y + Math.sin(an) * vy * k; g.fillStyle = 'rgba(' + rgb + ',' + (0.45 * (1 - u)) + ')'; g.beginPath(); g.arc(x, y, r * (1 + u), 0, 7); g.fill(); } }); } };
  // one drifting puff (a runner's trail)
  K.puff = (at, x, y, vx, vy, life, rr, rgb, a0, grow, z) => K.add({ t0: at, life, z, draw: (g, u, age) => { g.fillStyle = 'rgba(' + rgb + ',' + (a0 * (1 - u)) + ')'; g.beginPath(); g.arc(x + vx * age, y + vy * age, rr * (1 + u * grow), 0, 7); g.fill(); } });
  // gold twinkles (twinkles)
  K.twinkles = (at, pt, n, r, rgb) => { for (let i = 0; i < n; i++) { const x = pt.x + rnd(-r, r) * KP, y = pt.y + rnd(-r, r) * 0.8 * KP, s = rnd(5, 11) * KP;
    K.add({ t0: at, life: rnd(500, 900), z: 42, draw: (g, u) => { const k = Math.sin(u * Math.PI) * s; g.globalCompositeOperation = 'lighter'; K.glow(g, x, y, k * 2.5, rgb, 0.7); g.globalCompositeOperation = 'source-over'; g.fillStyle = '#fff';
      g.beginPath(); g.moveTo(x, y - k * 1.6); g.lineTo(x + k * 0.3, y); g.lineTo(x, y + k * 1.6); g.lineTo(x - k * 0.3, y); g.closePath(); g.fill();
      g.beginPath(); g.moveTo(x - k * 1.6, y); g.lineTo(x, y + k * 0.3); g.lineTo(x + k * 1.6, y); g.lineTo(x, y - k * 0.3); g.closePath(); g.fill(); } }); } };
  // shapes (SHAPE.coin / SHAPE.axe), drawn at the origin
  K.coin = (g, age, r) => { const k = Math.abs(Math.cos(age / 70)); g.fillStyle = '#e8b32a'; g.beginPath(); g.ellipse(0, 0, r * Math.max(0.15, k), r, 0, 0, 7); g.fill(); g.fillStyle = '#fff3b0'; g.fillRect(-1 * KP, -r * 0.6, 2 * KP, r * 0.5); };
  K.axe = (g, s) => { g.scale(s, s); g.strokeStyle = '#4a2f1c'; g.lineWidth = 6; g.beginPath(); g.moveTo(-30, 0); g.lineTo(30, 0); g.stroke();
    g.fillStyle = '#c9ced6'; g.beginPath(); g.moveTo(18, -4); g.quadraticCurveTo(44, -30, 36, -36); g.quadraticCurveTo(54, -6, 40, 22); g.quadraticCurveTo(40, 6, 18, 4); g.closePath(); g.fill();
    g.strokeStyle = '#7d1c1c'; g.lineWidth = 2; g.stroke(); };
  // a thrown thing (fly): from -> to over ms, arc = mockup px up at mid-flight (negative dips), spin rad per 60 fps frame
  K.fly = (at, from, to, o) => { const ms = o.ms; K.add({ t0: at, life: ms, z: o.z == null ? 40 : o.z, draw: (g, u, age) => { const e = (o.ease || E.lin)(Math.min(1, age / ms)); const x = lerp(from().x, to().x, e), y = lerp(from().y, to().y, e) - o.arc * KP * Math.sin(Math.PI * e);
    g.translate(x, y); if (o.spin) g.rotate(o.spin * age / 16.67); o.draw(g, age); } }); };
  // afterimage: a pale copy of a timeline token's art at its painted spot, fading over ms
  K.ghost = (at, k, pose, o) => { o = o || {}; const art = tl.art(k), Tk = tl.TOK[k]; if (!art || !Tk) return; const ms = o.ms || 380, a0 = o.opacity || 0.5;
    K.add({ t0: at, life: ms, z: 4, draw: (g, u) => { const f = tl.feet(Tk); g.translate(Tk.x + pose.dx, f.y + pose.dy - (pose.air || 0)); if (pose.rot) g.rotate(pose.rot); g.scale(Tk.flip * (pose.sx || 1), pose.sy || 1); g.globalAlpha = a0 * (1 - u); g.filter = 'brightness(1.6) saturate(.4)'; g.drawImage(art, -Tk.w / 2, -Tk.h * Tk.foot, Tk.w, Tk.h); } }); };
  // the drawn height of a bandit art in the game: a 1x1 token box ("contain") times its texture scale, times the depth there
  K.banditH = (img, sc, ds) => { const nw = img.naturalWidth || img.width || 1, nh = img.naturalHeight || img.height || 1; return nh * Math.min(tl.GRID / nw, tl.GRID / nh) * sc * ds; };
  // where a body standing on a 2D floor point is drawn, and how big ({ x, y, s })
  // cfg.flat (full-takeover shots: the 3D stage flattens) = the 2D point itself, sized by the depth-map factor only
  K.floor = (x, y) => { try { const d = oni.depthAt({ x, y }); if (cfg.flat) return { x, y, s: d && Number.isFinite(d.f) && d.f > 0 ? d.f : 1 }; if (d && Number.isFinite(d.s) && d.s > 0) return d; } catch (e) {} return { x, y, s: 1 }; };
  // the board edges in world px right now (live board: the real camera)
  K.edges = () => { try { const v = tl.camView(tl.makeState()); return { left: v.left, right: v.right, top: v.top, bottom: v.bottom }; } catch (e) { return { left: tl.STAGE.x, right: tl.STAGE.x + tl.STAGE.w, top: tl.STAGE.y, bottom: tl.STAGE.y + tl.STAGE.h }; } };
  // a bandit sprite running across the board: img, dir (+1 = to the right), x0 -> x1, row y, h, ms, ease,
  // bob(u) mockup px up, rot(u) deg, fade-in ms, z; trail = puff spacing ms (0 = none)
  K.runner = (at, o) => { const img = o.img; if (!img) return; const nw = img.naturalWidth || img.width || 1, nh = img.naturalHeight || img.height || 1, h = o.h, w = h * nw / nh;
    const pos = (age) => { const u = Math.min(1, age / o.ms), e = (o.ease || E.lin)(u); return { u, x: lerp(o.x0, o.x1, e), y: lerp(o.y, o.y1 == null ? o.y : o.y1, e) }; };
    K.add({ t0: at, life: o.ms, z: o.z, draw: (g, u0, age) => { const p = pos(age); g.translate(p.x, p.y - (o.bob ? o.bob(p.u) : 0)); if (o.rot) g.rotate(o.rot(p.u) * Math.PI / 180 * o.dir); g.scale(-o.dir, 1);
      g.globalAlpha = o.fade ? Math.min(1, age / o.fade) : 1; g.drawImage(img, -w / 2, -h, w, h); } });
    if (o.trail) for (let a = 0; a < o.ms; a += o.trail) { const p = pos(a); const tr = o.trailSpec(p, w, h); K.puff(at + a, tr.x, tr.y, tr.vx, tr.vy, tr.life, tr.rr, tr.rgb, tr.a0, tr.grow, tr.z == null ? o.z - 1 : tr.z); }
    return { w, h };
  };
  return K;
}
