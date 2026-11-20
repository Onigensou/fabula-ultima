// ── Nox Priest kit: prepended to every priest-*.inner.js shot by nox-priest-signatures.js ──
// Port of the approved Nox Legion mockup (claude.ai/artifact/HPbnUfL5sy26XmK1oLU8hU v8, part-priest + r2..r6).
// Every beat is scheduled on ONE clock (ms from the shot's first frame): the mockup's awaits become fixed offsets.
// LIVE board for the on-board moves (camera never touched); cfg.live === false = the full-takeover timeline with the
// camera driven through S.cam (Lux Finis only). The Priest is painted by this kit (lean, dash, glow, flash filters);
// the real token stays hidden while the shot owns it. Mockup px are on a 1682 px stage, scaled by KP = stage w / 1682.
// The game draws numbers, statuses, hurt flinches and KO poses: none of those are drawn here.
// No backticks and no dollar-brace anywhere in this file (storage rule).
const cfg = ctx.params.cfg || {};
const A = ctx.params.assets || {};
const NS = 'fabula-ultima-companion';
const caster = ctx.casterToken;
if (!caster) { oni.fireDone(); return; }
const PLACE = (canvas.tokens && canvas.tokens.placeables) || [];
const isFragTok = (t) => { try { const f = t.document && t.document.flags && t.document.flags[NS]; if (f && f.soulFragment) return true; const af = t.actor && t.actor.flags && t.actor.flags[NS]; return !!(af && af.conflictObject === 'soul-fragment'); } catch (e) { return false; } };
const effList = (actor) => { try { const e = actor && actor.effects; if (!e) return []; return e.contents || Array.from(e); } catch (er) { return []; } };
// the game's own status test (skill-formulas actorHasNamedStatus): an enabled AE whose status ids or name carry it
const hasStatus = (tok, needle) => { for (const e of effList(tok && tok.actor)) { if (!e || e.disabled) continue; const st = e.statuses ? Array.from(e.statuses) : []; if (st.some((s) => String(s).toLowerCase().indexOf(needle) >= 0)) return true; if (String(e.name || '').trim().toLowerCase() === needle) return true; } return false; };
let RAW = (ctx.targetTokens || []).filter((t) => t && t.center && t !== caster);
// Soul Siphon: the destroyed Soul Fragment (Soul Tithe token flag soulFragment). The row targets trigger_actor = the
// fragment; fallback = a fragment token on the scene already at 0 HP (the one just destroyed). None: no stream.
let FRAG = null;
if (cfg.fragment) {
  FRAG = RAW.find(isFragTok) || null;
  if (!FRAG) { const hp = (t) => Number(t.actor && t.actor.system && t.actor.system.props && t.actor.system.props.current_hp); FRAG = PLACE.find((t) => t && t !== caster && isFragTok(t) && !(hp(t) > 0)) || null; }
  RAW = RAW.filter((t) => t !== FRAG && !isFragTok(t));
}
const tokens = { k: { token: caster, foot: cfg.casterFoot } };
const FOES = [];
RAW.forEach((t, i) => { const k = 't' + i; FOES.push(k); tokens[k] = { token: t, foot: cfg.partyFoot }; });
if (FRAG) tokens.fr = { token: FRAG };
const CL = A.clips || {};
const LIVE = cfg.live !== false;
const tl = oni.timeline({ tokens, clips: CL, live: LIVE, depthRef: 'k' });
await tl.load();
const E = tl.E, seg = tl.seg, lerp = tl.lerp, clamp01 = tl.clamp01, TOK = tl.TOK, feet = tl.feet;
const X = { lin: E.lin, out: E.outQ, in: E.inQ, quad: E.ioQ, sine: E.sine, outCubic: E.outC, inCubic: E.inC,
  outBack: (t) => { const c = 1.6; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); } };
const KP = (tl.STAGE.w || 1682) / 1682;
const R = tl.rng(cfg.seed || 7301);
const rnd = (a, b) => a + (b - a) * R();
const T = [];
const m = tl.mk(T);
const once = (at, fn) => { let did = false; T.push({ t0: at, t1: 1e9, fn: () => { if (did) return; did = true; try { fn(); } catch (e) { console.warn('[NoxPriest] once threw', e); } } }); };
// mockup sfx(key, vol, rate): the same keys through ASSETS.sfx (nox-assets SFX)
const S_ = (at, key, v, rate) => { const url = A.sfx && A.sfx[key]; if (!url) return; const vol = Math.min(1, v * (cfg.volume == null ? 0.9 : cfg.volume)); once(at, () => oni.sfx(url, { volume: vol, rate: rate || 1 })); };
const RGB = cfg.rgb || {};
const JADE = RGB.JADE || '95,224,180', JADE_HOT = RGB.JADE_HOT || '200,255,232', GOLD = RGB.GOLD || '255,224,140';

// ── geometry (mockup OX/OY = the feet line, hgt = art top to feet; a.s = depth size relative to the Priest) ──
const K = TOK.k, kf = feet(K);
const OXk = (k) => TOK[k].x;
const OYk = (k) => feet(TOK[k]).y;
const hgtK = (k) => TOK[k].h * TOK[k].foot;
const widK = (k) => TOK[k].w;
const ftOf = (k) => ({ x: OXk(k), y: OYk(k) - 4 * KP });
const centerOf = (k) => ({ x: OXk(k), y: OYk(k) - hgtK(k) * 0.5 });
const DCACHE = new Map();
const depthAt = (x, y) => { const key = Math.round(x) + '|' + Math.round(y); let d = DCACHE.get(key); if (d == null) { d = tl.depthRatio(kf, { x, y }); DCACHE.set(key, d); } return d; };
const sOf = (k) => (k === 'k' ? 1 : depthAt(OXk(k), OYk(k)));
const PCS = PLACE.filter((t) => t && t !== caster && t.document && t.document.disposition === 1 && t.visible);
// toward the party (+1 = to the right of the Priest): the mockup's enemies stand left, facing +x
const DIR = (() => { const ref = RAW.length ? RAW : PCS; if (ref.length) return (ref.reduce((s, t) => s + t.center.x, 0) / ref.length) >= caster.center.x ? 1 : -1; return K.dir || 1; })();
// a target faces the Priest (mockup face(party) = -1)
const headOf = (k) => ({ x: OXk(k) - DIR * widK(k) * 0.12, y: OYk(k) - hgtK(k) * 0.82 });
// mockup PARTY_C(): the middle of the party's feet (the targets; with none, the friendly tokens)
const PARTY_C = () => { if (FOES.length) return { x: FOES.reduce((s, k) => s + OXk(k), 0) / FOES.length, y: FOES.reduce((s, k) => s + OYk(k), 0) / FOES.length };
  if (PCS.length) return { x: PCS.reduce((s, t) => s + t.center.x, 0) / PCS.length, y: PCS.reduce((s, t) => s + t.center.y + t.h / 2, 0) / PCS.length };
  return { x: kf.x + DIR * 400 * KP, y: kf.y }; };
// mockup DOM z (battlers sit at z = their feet row) -> world layer: under every battler / over the target / over all
// plain clips with no z play in the page's effect layer, which comes AFTER the battlers: over them (z 26, as the other Nox
// kits); an explicit low z (the floor miasma, z 3) stays under; a z at a battler's feet row (+k) is over the battlers too
const zOf = (mz) => (mz == null ? 26 : mz <= 10 ? 3 : mz < 2000 ? 26 : mz < 5000 ? 45 : 50 + (mz - 5000) / 50);
const LAYER_Z = { ground: 2, field: 4, hit: 45 };

// ── the Priest's body: MOVE(t) -> feet point, ROT(t) -> degrees, FILT -> CSS filter steps (glow / flash) ──
const ART0 = tl.art('k');
const BLANK = document.createElement('canvas'); BLANK.width = 2; BLANK.height = 2;
(tl.POSE.k = tl.POSE.k || {}).blank = { img: BLANK, foot: 1, w: 0.01, h: 0.01 };
let MOVE = null, ROT = () => 0;
const FILT = [];
const HAS_SH = (() => { try { const f1 = caster.document.flags && caster.document.flags[NS]; const f2 = caster.actor && caster.actor.flags && caster.actor.flags[NS]; return !!((f1 && f1.spriteShadow) || (f2 && f2.spriteShadow)); } catch (e) { return false; } })();
const bodyAtT = (t) => { const p = MOVE ? MOVE(t) : { x: kf.x, y: kf.y }; const d = (p.x !== kf.x || p.y !== kf.y) ? depthAt(p.x, p.y) : 1; return { x: p.x, y: p.y, d }; };
// mockup hand(PR): toward the party, 62% up; bodyAt: the middle of the body
const handAt = (t) => { const b = bodyAtT(t); return { x: b.x + DIR * K.w * b.d * 0.3, y: b.y - hgtK('k') * b.d * 0.62 }; };
const midAt = (t) => { const b = bodyAtT(t); return { x: b.x, y: b.y - hgtK('k') * b.d * 0.5 }; };
// {n} in a filter string = n mockup px -> overlay px under the current transform
const fpx = (g, n) => { let a = 1; try { a = g.getTransform().a; } catch (e) {} return Math.max(0, n * KP * a); };
const glowOn = (at, rgb, px) => FILT.push([at, 'drop-shadow(0 0 {' + px + '}px rgba(' + rgb + ',.95)) drop-shadow(0 0 {2}px rgba(' + rgb + ',.9))']);
const glowOff = (at) => FILT.push([at, '']);
// mockup flashActor(PR, color, ms): drop-shadow + brightness fading out (ease out), then the filter is cleared
const flashActor = (at, color, ms) => { FILT.push([at, (e) => { const u = 1 - X.out(clamp01(e / ms)); return 'drop-shadow(0 0 {' + (14 * u).toFixed(2) + '}px ' + color + ') brightness(' + (1 + 1.3 * u).toFixed(3) + ')'; }]); FILT.push([at + ms, '']); };
const filterAt = (t) => { let f = '', at = 0; for (const s of FILT) if (t >= s[0]) { f = s[1]; at = s[0]; } return typeof f === 'function' ? f(t - at) : f; };
function bodyTrack(total) {
  FILT.sort((a, b) => a[0] - b[0]);
  m.hold(0, total, (t, S) => {
    const b = bodyAtT(t), rot = ROT(t), q = S.tok.k;
    q.pose = 'blank'; q.dx = b.x - kf.x; q.dy = b.y - kf.y; if (Math.abs(q.dy) > 0.5) q.noShadow = true;
    if (HAS_SH && Math.abs(b.y - kf.y) > 0.5) S.world.push({ z: 2, draw: (g) => { g.save(); g.globalAlpha = 0.32; g.fillStyle = '#000'; g.beginPath(); g.ellipse(b.x, b.y, K.w * 0.3 * b.d, K.w * 0.09 * b.d, 0, 0, 6.2832); g.fill(); g.restore(); } });
    const f = filterAt(t);
    S.world.push({ z: 20, draw: (g) => { if (!ART0) return; g.save(); g.translate(b.x, b.y); if (rot) g.rotate(rot * Math.PI / 180); g.scale(K.flip * b.d, b.d);
      if (f) g.filter = f.replace(/\{(\d+(\.\d+)?)\}/g, (mm, n) => fpx(g, Number(n)).toFixed(2) + 'px');
      g.drawImage(ART0, -K.w / 2, -K.h * K.foot, K.w, K.h); g.restore(); } });
  });
}
// mockup lean(PR, v * PR.baseFlip): baseFlip = -1 for the Legion, mirrored when the party is on the left
const leanDeg = (v) => -v * DIR;

// a value track built from tweens: segs = [t0, ms, to, ease]; a later tween takes over from where the value is
function tw(init, segs) {
  const S = segs.slice().sort((a, b) => a[0] - b[0]); const starts = [];
  const valAt = (i, t) => { if (i < 0) return init; const sg = S[i]; if (t < sg[0]) return valAt(i - 1, t); const u = sg[1] > 0 ? clamp01((t - sg[0]) / sg[1]) : 1; return lerp(starts[i], sg[2], (sg[3] || X.lin)(u)); };
  for (let i = 0; i < S.length; i++) starts.push(i === 0 ? init : valAt(i - 1, S[i][0]));
  return (t) => { let i = S.length - 1; while (i >= 0 && t < S[i][0]) i--; return valAt(i, t); };
}
// a target squash (mockup squash(a, sx, sy, ms, ease) on a party battler): S.tok sx / sy from the feet
function squashTrack(k, sxSegs, sySegs, t0, t1) { const sx = tw(1, sxSegs), sy = tw(1, sySegs); m.hold(t0, t1, (e, S) => { const q = S.tok[k]; if (!q) return; const t = e + t0; q.sx *= sx(t); q.sy *= sy(t); }); }

// ── particles (mockup addP layers: ground / field under the battlers, hit over them) ──
const PS = [];
const part = (p) => { p.z = LAYER_Z[p.layer || 'hit']; PS.push(p); return p; };
function posOf(p, age) {
  let dx, dy; const vx = p.vx || 0, vy = p.vy || 0;
  if (p.drag && p.drag < 1) { const L = Math.log(p.drag) / 16; const f = (Math.exp(L * age) - 1) / L; dx = vx * f; dy = vy * f; } else { dx = vx * age; dy = vy * age; }
  dy += 0.5 * (p.g || 0) * age * age; return { x: p.x + dx * KP, y: p.y + dy * KP };
}
function particleTrack(total) {
  m.hold(0, total, (t, S) => {
    for (const z of [2, 4, 45]) { let any = false; for (const p of PS) if (p.z === z && t >= p.t0 && t < p.t0 + p.life) { any = true; break; } if (!any) continue;
      S.world.push({ z, draw: (g) => { for (const p of PS) { if (p.z !== z) continue; const age = t - p.t0; if (age < 0 || age >= p.life) continue; const pt = p.pos ? p.pos(age) : posOf(p, age); g.save(); g.globalCompositeOperation = p.comp || 'lighter'; p.draw(g, pt.x, pt.y, age / p.life, age, p); g.restore(); } } }); }
  });
}
const glw = (g, x, y, r, rgb, a) => { if (!(r > 0) || !(a > 0)) return; const gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, 'rgba(' + rgb + ',' + a + ')'); gr.addColorStop(1, 'rgba(' + rgb + ',0)'); g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, 6.2832); g.fill(); };
// mockup homing(layer, from, to, rgb, { ms, arc, r }): a mote on a curve, eased in, with a short streak
const homing = (at, from, to, rgb, o) => { o = o || {}; const ms = o.ms || 900, arc = (o.arc == null ? 120 : o.arc) * KP, r = o.r || 4;
  const cx = (from.x + to.x) / 2 + rnd(-arc, arc), cy = Math.min(from.y, to.y) - rnd(arc * 0.3, arc); const life = o.life || ms * rnd(0.85, 1.15);
  const at2 = (age) => { const tt = X.in(Math.min(1, age / life)), u = 1 - tt; return { x: u * u * from.x + 2 * u * tt * cx + tt * tt * to.x, y: u * u * from.y + 2 * u * tt * cy + tt * tt * to.y }; };
  part({ t0: at, life, pos: at2, layer: o.layer || 'hit', draw: (g, x, y, u, age) => { const pv = at2(Math.max(0, age - 16)); glw(g, x, y, r * 3.5 * KP, rgb, 0.95); g.strokeStyle = 'rgba(' + rgb + ',.5)'; g.lineWidth = r * KP; g.beginPath(); g.moveTo(pv.x, pv.y); g.lineTo(x, y); g.stroke(); } });
  return at + life; };
// mockup ring(): an expanding (or closing) floor ellipse
const ring = (at, pt, o) => { o = o || {}; const rgb = o.rgb || '255,255,255', r0 = o.r0 == null ? 10 : o.r0, r1 = o.r1 == null ? 160 : o.r1, ms = o.ms || 600, sy = o.sy || 0.3, w = o.w || 6, s = o.s || 1;
  part({ t0: at, life: ms, x: pt.x, y: pt.y, layer: o.layer || 'ground', draw: (g, x, y, u) => { const r = Math.max(0.1, lerp(r0, r1, X.outCubic(u)) * s * KP); g.strokeStyle = 'rgba(' + rgb + ',' + (1 - u) + ')'; g.lineWidth = w * (1 - u * 0.6) * s * KP; g.beginPath(); g.ellipse(x, y, r, r * sy, 0, 0, 6.2832); g.stroke(); } }); };
const dustBurst = (at, pt, o) => { o = o || {}; const n = o.n || 14, s = o.s || 1, rgb = o.rgb || '190,170,140';
  for (let i = 0; i < n; i++) { const an = rnd(Math.PI, Math.PI * 2), r = rnd(8, 18) * s; part({ t0: at, life: rnd(500, 900), x: pt.x + rnd(-10, 10) * s * KP, y: pt.y, vx: Math.cos(an) * rnd(0.08, 0.25) * s, vy: Math.sin(an) * rnd(0.02, 0.1) * s, drag: 0.97, layer: 'field', comp: 'source-over',
    draw: (g, x, y, u) => { g.fillStyle = 'rgba(' + rgb + ',' + (0.45 * (1 - u)) + ')'; g.beginPath(); g.arc(x, y, r * (1 + u) * KP, 0, 6.2832); g.fill(); } }); } };
const twinkles = (at, pt, o) => { o = o || {}; const n = o.n || 10, r = o.r == null ? 80 : o.r, rgb = o.rgb || '160,230,255';
  for (let i = 0; i < n; i++) { const sz = rnd(5, 11); part({ t0: at, life: rnd(500, 900), x: pt.x + rnd(-r, r) * KP, y: pt.y + rnd(-r, r) * 0.8 * KP, layer: o.layer || 'hit',
    draw: (g, x, y, u) => { const k = Math.sin(u * Math.PI) * sz * KP; glw(g, x, y, k * 2.5, rgb, 0.7); g.fillStyle = '#fff'; g.beginPath(); g.moveTo(x, y - k * 1.6); g.lineTo(x + k * 0.3, y); g.lineTo(x, y + k * 1.6); g.lineTo(x - k * 0.3, y); g.closePath(); g.fill();
      g.beginPath(); g.moveTo(x - k * 1.6, y); g.lineTo(x, y + k * 0.3); g.lineTo(x + k * 1.6, y); g.lineTo(x, y - k * 0.3); g.closePath(); g.fill(); } }); } };
// mockup ember(layer, x, y, rgb, o): a soft mote drifting up, swaying
const ember = (at, x, y, rgb, o) => { o = o || {}; const r = o.r || rnd(2, 5);
  part({ t0: at, life: o.life || rnd(1400, 2600), x, y, vx: o.vx == null ? rnd(-0.03, 0.03) : o.vx, vy: o.vy == null ? rnd(-0.12, -0.05) : o.vy, layer: o.layer || 'field',
    draw: (g, px, py, u, age) => { glw(g, px + Math.sin(age / 300) * 6 * KP, py, r * 3 * KP, rgb, Math.sin(u * Math.PI) * 0.9); } }); };
// mockup soulRise(a, { n, ms, rgb }): jade light rising off a body, one ember every ms / n
const soulRise = (at, k, o) => { o = o || {}; const n = o.n || 26, ms = o.ms || 1400, rgb = o.rgb || JADE; const s = sOf(k);
  for (let e = 0; e < ms; e += ms / n) ember(at + e, OXk(k) + rnd(-widK(k) * 0.35, widK(k) * 0.35), OYk(k) - hgtK(k) * rnd(0.05, 0.8), rgb, { vy: -rnd(0.04, 0.09), r: rnd(2, 4) * s, life: rnd(900, 1500), layer: 'field' }); };
// mockup haze(pt, { rgb, n, w, s }): low poison puffs on the floor
const haze = (at, pt, o) => { o = o || {}; const rgb = o.rgb || '150,190,70', n = o.n || 10, w = o.w || 160, s = o.s || 1;
  for (let i = 0; i < n; i++) { const r = rnd(30, 52) * s; part({ t0: at, life: rnd(2000, 3000), x: pt.x + rnd(-w, w) * s * KP, y: pt.y - rnd(0, 26) * s * KP, vx: rnd(-0.015, 0.015), vy: -rnd(0.004, 0.015), layer: 'field', comp: 'source-over',
    draw: (g, x, y, u) => glw(g, x, y, r * (1 + u * 0.4) * KP, rgb, 0.26 * Math.sin(u * Math.PI)) }); } };
// mockup rite(a, rgb, ms): magic3, glow on, motes curl into the tome while it leans back
const rite = (at, rgb, ms) => { S_(at, 'magic3', 0.4); glowOn(at, rgb, 8);
  for (let e = 0; e < ms; e += 40) { const an = rnd(0, 6.28), r = rnd(60, 110) * KP; homing(at + e, { x: kf.x + Math.cos(an) * r, y: kf.y - hgtK('k') * 0.55 + Math.sin(an) * r * 0.6 }, handAt(at + e), rgb, { ms: 500, arc: 30, r: 2.5 }); }
  return at + ms; };
// mockup soulStream(from, to, { n, ms, spread, rgb, arc }): resolves (returns) when the FIRST mote arrives
const soulStream = (at, from, to, o) => { o = o || {}; const n = o.n || 16, ms = o.ms || 800, spread = (o.spread == null ? 30 : o.spread) * KP, rgb = o.rgb || JADE, arc = o.arc == null ? 90 : o.arc; let first = null;
  for (let i = 0; i < n; i++) { const t0 = at + i * ms / n * 0.6; const life = i === 0 ? ms * 0.85 : ms * rnd(0.7, 1) * rnd(0.85, 1.15);
    const end = homing(t0, { x: from.x + rnd(-spread, spread), y: from.y + rnd(-spread, spread) }, to, rgb, { ms, arc, r: rnd(2.5, 4.5), life }); if (first == null) first = end; }
  return first; };
// mockup shards(layer, pt, rgb, n, spread): spinning crystal flecks thrown out under gravity
const shards = (at, pt, rgb, n, spread) => { for (let i = 0; i < n; i++) { const an = rnd(0, 6.2832), sp = rnd(0.15, spread), rot0 = rnd(0, 6), vr = rnd(-0.02, 0.02), s = rnd(5, 11);
  part({ t0: at, life: rnd(600, 1000), x: pt.x, y: pt.y, vx: Math.cos(an) * sp, vy: Math.sin(an) * sp - 0.2, g: 0.0012, drag: 0.985, layer: 'hit',
    draw: (g, x, y, u, age) => { g.translate(x, y); g.rotate(rot0 + vr * age); g.globalAlpha = 1 - u; const k = s * KP; g.fillStyle = 'rgba(' + rgb + ',1)'; g.beginPath(); g.moveTo(0, -k); g.lineTo(k * 0.6, 0); g.lineTo(0, k * 0.9); g.lineTo(-k * 0.5, 0); g.fill(); } }); } };
// projectiles (mockup fly(): drawn along their travel, tip at the point; draw paints in mockup px)
function fly(at, from, to, o) {
  const ms = o.ms || 450, ease = o.ease || X.lin, arc = o.arc || 0;
  const posAt = (age) => { const u = ease(Math.min(1, age / ms)); return { x: lerp(from.x, to.x, u), y: lerp(from.y, to.y, u) - arc * KP * Math.sin(Math.PI * u) }; };
  const angAt = (age) => { const a = posAt(Math.max(0, age - 8)), b = posAt(Math.min(ms, age + 8)); return Math.atan2(b.y - a.y, b.x - a.x); };
  m.hold(at, at + ms, (age, S) => { const p = posAt(age), an = angAt(age); S.world.push({ z: o.z || 45, draw: (g) => { g.save(); g.globalCompositeOperation = 'lighter'; g.translate(p.x, p.y); g.rotate(an); g.scale(KP, KP); o.draw(g, age); g.restore(); } }); });
  return at + ms;
}

// ── clips (mockup clip(key, pt, { scale, filter, blend, z, sy, opacity, loop })): size = source px * scale * k * KP ──
// Drawn by this kit (the timeline's clip only runs the video): blend 'screen' for the pixelfx light layers and the
// JB2A blast, and the EDGE_FADE masks (nox-assets) for clips whose picture touches their own frame edge.
const EDGE = A.edge || {};
const MCAN = document.createElement('canvas'), MCTX = MCAN.getContext('2d');
function masked(V, key) {
  const ef = EDGE[key]; if (!ef) return V;
  const w = V.videoWidth || V.naturalWidth || V.width || 2, h = V.videoHeight || V.naturalHeight || V.height || 2;
  if (MCAN.width !== w || MCAN.height !== h) { MCAN.width = w; MCAN.height = h; }
  const c = MCTX; c.globalCompositeOperation = 'source-over'; c.clearRect(0, 0, w, h); c.drawImage(V, 0, 0, w, h);
  c.globalCompositeOperation = 'destination-in'; let gr;
  if (ef.dir === 'top') { gr = c.createLinearGradient(0, 0, 0, h * ef.pct); gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,1)'); }
  else if (ef.dir === 'bottom') { gr = c.createLinearGradient(0, h, 0, h * (1 - ef.pct)); gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,1)'); }
  else { const Rr = Math.hypot(w / 2, h / 2); gr = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Rr); gr.addColorStop(0, 'rgba(0,0,0,1)'); gr.addColorStop(ef.pct, 'rgba(0,0,0,1)'); gr.addColorStop(Math.min(1, ef.outer || 1), 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); }
  c.fillStyle = gr; c.fillRect(0, 0, w, h); c.globalCompositeOperation = 'source-over';
  return MCAN;
}
// o: scale, filter, blend, z (mockup DOM z), sy, opacity, loop, hold (ms on screen), fadeAt + fadeMs (mockup .stop(ms))
function fx(key, at, pt, o) {
  o = o || {}; const def = CL[key]; if (!def) return null;
  const dur = o.fadeAt != null ? (o.fadeAt - at) + (o.fadeMs || 300) : (o.hold != null ? o.hold : def.dur);
  if (!(dur > 0)) return null;
  const c = m.clip(key, at, { x: pt.x, y: pt.y, w: 1, hold: dur, loop: !!o.loop, alpha: () => 0, depth: false });
  if (!c) return null;
  const w = def.w * (o.scale || 1) * def.k * KP, h = w * def.h / def.w, sy = o.sy || 1, z = o.wz != null ? o.wz : zOf(o.z), op = o.opacity == null ? 1 : o.opacity;
  m.hold(at, at + dur, (e, S) => {
    const V = c.frame(!!o.loop); if (!V) return;
    let a = op; if (o.fadeAt != null && at + e > o.fadeAt) a *= 1 - X.sine(clamp01((at + e - o.fadeAt) / (o.fadeMs || 300))); if (a <= 0) return;
    S.world.push({ z, draw: (g) => { const F = masked(V, key); g.save(); g.translate(pt.x, pt.y); if (sy !== 1) g.scale(1, sy); g.globalAlpha = a;
      if (o.blend) g.globalCompositeOperation = o.blend; if (o.filter) g.filter = o.filter;
      g.drawImage(F, -def.ax * w, -def.ay * h, w, h); g.restore(); } });
  });
  return { at, dur };
}
// mockup pxClip(name, pt, o): back layer under the battlers, front over (o.z), light over that in screen blend
function pxClip(name, at, pt, o) {
  o = o || {}; const out = [];
  if (o.back !== false && CL[name + '_back']) out.push(fx(name + '_back', at, pt, Object.assign({}, o, { wz: 2.5 })));
  if (CL[name + '_front']) out.push(fx(name + '_front', at, pt, Object.assign({}, o, { z: o.z == null ? 6000 : o.z })));
  if (CL[name + '_light']) out.push(fx(name + '_light', at, pt, Object.assign({}, o, { z: (o.z == null ? 6000 : o.z) + 1, blend: 'screen' })));
  return out;
}

// ── screen: dim (mockup fdim), white (whiteTo), flashes, shake / rumble, vignette ──
const dimTrack = (fn, total) => m.hold(0, total, (t, S) => { const v = fn(t); if (v > 0.001) S.dim = Math.max(S.dim, v); });
const whiteTrack = (fn, total) => m.hold(0, total, (t, S) => { const v = fn(t); if (v > 0.001 && v > S.flash.a) S.flash = { a: v, c: '#ffffff' }; });
// mockup flash(color, peak, inMs, outMs): linear in, ease-out down
const flashC = (at, color, peak, inMs, outMs) => m.hold(at, at + inMs + outMs, (e, S) => { const a = e < inMs ? peak * e / inMs : peak * (1 - X.out((e - inMs) / outMs)); if (a > S.flash.a) S.flash = { a, c: color }; });
const shake = (at, px, ms) => m.shake(at, ms, px * KP);
const rumble = (t0, t1, px) => m.hold(t0, t1, (e, S) => { S.shake = Math.max(S.shake, px * KP); });
const vignetteTrack = (fn, total) => m.hold(0, total, (t, S) => { const v = fn(t); if (v <= 0.001) return; S.screen.push({ draw: (g) => { const W = g.W, H = g.H; const gr = g.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75); gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,' + v + ')'); g.save(); g.fillStyle = gr; g.fillRect(0, 0, W, H); g.restore(); } }); });
// a battler drawn as a flat colour (mockup filter brightness(0) invert(1) / a white flashActor on a party battler)
const silhouette = (k, at, ms, color, alphaFn) => m.hold(at, at + ms, (e, S) => { const a = alphaFn(clamp01(e / ms)); if (a <= 0) return; const Tk = TOK[k], c = tl.tinted(k, color); if (!c) return; const f = feet(Tk), q = S.tok[k] || {};
  S.world.push({ z: 13, draw: (g) => { g.save(); g.translate(Tk.x + (q.dx || 0), f.y + (q.dy || 0)); g.scale(Tk.flip * (q.sx || 1), q.sy || 1); g.globalAlpha = a; g.drawImage(c, -Tk.w / 2, -Tk.h * Tk.foot, Tk.w, Tk.h); g.restore(); } }); });

// run the shot: the damage gate at 'gate' (null = none: the shot calls oni.fireDone itself), the ready hook on frame one
async function runShot(total, gate) {
  bodyTrack(total); particleTrack(total);
  if (gate != null) once(gate, () => oni.fireDone());
  await tl.run(T, { total, onStart: () => { const h = ctx.params.readyHook; if (h) { try { Hooks.callAll(h); } catch (e) {} } } });
  oni.fireDone();
}
