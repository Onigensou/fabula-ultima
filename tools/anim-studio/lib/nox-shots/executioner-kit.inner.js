// ── Nox Executioner kit: prepended to every executioner-*.inner.js shot by nox-executioner-signatures.js ──
// Port of the approved Nox Legion mockup (claude.ai/artifact/HPbnUfL5sy26XmK1oLU8hU v8, rounds 2-7). The Executioner is
// painted by this kit from body tracks (glide, lift + bob, lean, fade, flip, teleport) and its Slash / Parry battler clips
// (PNG strips, frame-stepped). A pose frame keeps EXACTLY the idle's pixel size: frame px * (token drawn width / 374),
// bottom-centre on the idle's bottom-centre. Mockup px are on a 1682 px stage, scaled by KP = stage width / 1682.
// Mockup layout = the party to the RIGHT of the Executioner; DIR = -1 mirrors the whole shot (offsets, leans, clips).
// cfg.live === false = full-takeover timeline (camera via S.cam), else the LIVE board. No backticks, no dollar-brace.
const cfg = ctx.params.cfg || {};
const A = ctx.params.assets || {};
const NS = 'fabula-ultima-companion';
const caster = ctx.casterToken;
if (!caster) { oni.fireDone(); return; }
const isFrag = (t) => { try { const f = (t.document && t.document.flags && t.document.flags[NS]) || {}; const af = (t.actor && t.actor.flags && t.actor.flags[NS]) || {}; return f.soulFragment === true || af.conflictObject === 'soul-fragment'; } catch (e) { return false; } };
const targets = (ctx.targetTokens || []).filter((t) => t && t.center && t !== caster && !isFrag(t));
if (cfg.needsTarget && !targets.length) { oni.fireDone(); return; }

// ── the Soul Fragment (Soul Tithe): a real token. 'largest' = the one Soul Sever eats (most HP among those that have
// Called and are not paid out; else the one being eaten right now); 'owner' = the first target's own fragment ──
const onBoard = (t) => !!(t && t.center && t.mesh && t.visible !== false && !(t.document && t.document.hidden));
function fragInfo(t) {
  const a = t.actor; const props = (a && a.system && a.system.props) || {}; let mf = {}; let mark = null;
  try { mark = a && a.effects && a.effects.find((e) => e && e.flags && e.flags[NS] && e.flags[NS].soulFragmentMark === true); } catch (e) { mark = null; }
  if (mark) mf = mark.flags[NS] || {};
  const tf = (t.document.flags && t.document.flags[NS]) || {};
  return { t, hp: Number(props.current_hp) || 0, called: Number(mf.soulCalledRound) || 0, returned: mf.soulReturned === true || !mark, eatenAt: mf.soulEatenAt, eatenHp: Number(mf.soulEatenHp) || 0, owner: tf.soulFragmentOwner || null };
}
function findFragment() {
  const all = ((canvas.tokens && canvas.tokens.placeables) || []).filter((t) => onBoard(t) && isFrag(t)).map(fragInfo);
  if (!all.length) return null;
  if (cfg.frag === 'owner') { const tg = targets[0]; const u = tg && tg.actor && tg.actor.uuid; if (!u) return null; const f = all.find((q) => q.owner === u); return f ? f.t : null; }
  let best = null; for (const f of all) if (f.hp > 0 && f.called > 0 && !f.returned && (!best || f.hp > best.hp)) best = f;
  if (best) return best.t;
  for (const f of all) if (f.eatenAt != null && (!best || f.eatenHp > best.eatenHp)) best = f;
  return best ? best.t : null;
}
const FRT = cfg.frag ? findFragment() : null;

const tokens = { k: { token: caster } };
const FOES = [];
targets.forEach((t, i) => { const k = 't' + i; FOES.push(k); tokens[k] = { token: t }; });
if (FRT) tokens.fr = { token: FRT };
const CL = A.clips || {};
const LIVE = cfg.live !== false;
const tl = oni.timeline({ tokens, clips: CL, images: A.images || {}, live: LIVE, depthRef: 'k' });
await tl.load();
const E = tl.E, seg = tl.seg, lerp = tl.lerp, clamp01 = tl.clamp01, TOK = tl.TOK;
const X = { lin: E.lin, out: E.outQ, in: E.inQ, quad: E.ioQ, sine: E.sine, outCubic: E.outC, inCubic: E.inC };
const KP = (tl.STAGE.w || 1682) / 1682;
const R = tl.rng(cfg.seed || 7301);
const rnd = (a, b) => a + (b - a) * R();
const T = [];
const m = tl.mk(T);
const once = (at, fn) => { let did = false; T.push({ t0: at, t1: 1e9, fn: () => { if (did) return; did = true; try { fn(); } catch (e) { console.warn('[NoxEx] cue threw', e); } } }); };
// a mockup sfx(key, vol, rate): the mockup played vol * 0.75 (cfg.volume)
const S_ = (at, key, v, rate) => { const url = A.sfx && A.sfx[key]; if (!url) return; const vol = Math.min(1, v * (cfg.volume == null ? 0.75 : cfg.volume)); once(at, () => { try { oni.sfx(url, { volume: vol, rate: rate || 1 }); } catch (e) {} }); };
const HIT = (at) => once(at, () => oni.hit());
const JADE = '95,224,180', JADE_HOT = '200,255,232';
const RGB = cfg.rgb || {}; const FRAG_F = cfg.fragFilter || '';
const K = TOK.k;
const bot = (Tk) => ({ x: Tk.x, y: Tk.y + Tk.h / 2 });    // mockup OX/OY: bottom-centre of the art box
const HB = bot(K);
const NOX = !!TOK.fr;

// toward the party (mockup: +1 = to the right): the first target, else the friendly tokens, else where it faces
const DIR = (() => {
  if (cfg.faceToken && !FOES.length) return K.flip < 0 ? 1 : -1;   // Parry with no attacker: keep the way the token faces
  if (FOES.length) return TOK[FOES[0]].x >= K.x ? 1 : -1;
  const pcs = ((canvas.tokens && canvas.tokens.placeables) || []).filter((t) => t && t.document && t.document.disposition === 1 && t !== caster);
  if (pcs.length) return (pcs.reduce((s, t) => s + t.center.x, 0) / pcs.length) >= K.x ? 1 : -1;
  return K.flip < 0 ? 1 : -1;
})();
const FLIP0 = -DIR;                                       // its art faces left: flip -1 faces right (the mockup's EX.flip)
const leanDeg = (d) => -d * DIR;                          // mockup lean(EX, d * EX.baseFlip): screen degrees

// ── depth: a size factor relative to the Executioner's home spot (the mockup's a.s) ──
const DC = new Map();
const depthAt = (x, y) => { const key = Math.round(x) + '|' + Math.round(y); let d = DC.get(key); if (d == null) { d = tl.depthRatio(HB, { x, y }); if (!(d > 0)) d = 1; DC.set(key, d); } return d; };
// a token's mockup geometry (static: targets do not walk in these shots)
const OXk = (k) => TOK[k].x, OYk = (k) => bot(TOK[k]).y, hgtk = (k) => TOK[k].h;
const sOf = (k) => depthAt(OXk(k), OYk(k));
const feetk = (k) => ({ x: OXk(k), y: OYk(k) - 4 * KP });
const centerk = (k, lift) => ({ x: OXk(k), y: OYk(k) - (lift || 0) - hgtk(k) * 0.5 });

// ── the Slash / Parry clips (EXEC_POSES): frames side by side in one strip ──
const POSES = cfg.poses || {};
const PCW = (POSES.canvas && POSES.canvas.w) || 534, PCH = (POSES.canvas && POSES.canvas.h) || 458;
const PXK = K.w / ((POSES.idle && POSES.idle.w) || 374);  // the idle's pixel scale (token drawn width / 374)
const ART0 = tl.art('k');
const natW = (im) => (im && (im.videoWidth || im.naturalWidth || im.width)) || 0;
const natH = (im) => (im && (im.videoHeight || im.naturalHeight || im.height)) || 0;
const FR_MS = (n) => ((POSES[n] && POSES[n].frames) || []).map((f) => f.ms);
const FR_KEY = (n) => ((POSES[n] && POSES[n].frames) || []).map((f) => f.key);

// ── the body: value tracks built from tweens [t0, ms, to, ease]; a later tween takes over from where the value is ──
function tw(init, segs) {
  const S = segs.slice().sort((a, b) => a[0] - b[0]); const starts = [];
  const valAt = (i, t) => { if (i < 0) return init; const sg = S[i]; if (t < sg[0]) return valAt(i - 1, t); const u = sg[1] > 0 ? clamp01((t - sg[0]) / sg[1]) : 1; return lerp(starts[i], sg[2], (sg[3] || X.lin)(u)); };
  for (let i = 0; i < S.length; i++) starts.push(i === 0 ? init : valAt(i - 1, S[i][0]));
  return (t) => { let i = S.length - 1; while (i >= 0 && t < S[i][0]) i--; return valAt(i, t); };
}
function track(init) { const segs = []; let fn = null; const get = (t) => { if (!fn) fn = tw(init, segs); return fn(t); }; get.add = (s) => { segs.push(s); fn = null; }; return get; }
function stepper(init) { const list = []; let sorted = true; const get = (t) => { if (!sorted) { list.sort((a, b) => a[0] - b[0]); sorted = true; } let v = init; for (const s of list) { if (t >= s[0]) v = s[1]; else break; } return v; }; get.add = (t, v) => { list.push([t, v]); sorted = false; }; return get; }
const BX = track(HB.x), BY = track(HB.y), BROT = track(0), BALPHA = track(1);
const BFLIP = stepper(FLIP0), BPOSE = stepper(null);
const HEAVY = [];
// heavyStep lift (part-r2): liftTo 12 over 260 (sine), then 12 + 3 sin(age/160) while gliding, then down to 0 over 240
const liftAt = (t) => { for (const h of HEAVY) { const e = t - h.at; if (e < 0 || e >= h.ms + 240) continue;
  if (e < 260 && e < h.ms) return 12 * X.sine(e / 260) * KP; if (e < h.ms) return (12 + 3 * Math.sin(e / 160)) * KP;
  const v0 = h.ms < 260 ? 12 * X.sine(h.ms / 260) : 12 + 3 * Math.sin(h.ms / 160); return lerp(v0, 0, X.sine((e - h.ms) / 240)) * KP; } return 0; };
function bodyAt(t) { const x = BX(t), y = BY(t); const pose = BPOSE(t); return { t, x, y, lift: liftAt(t), rot: BROT(t), alpha: BALPHA(t), flip: BFLIP(t), pose, d: (x === HB.x && y === HB.y) ? 1 : depthAt(x, y) }; }
const boxW = (s) => (s.pose ? PCW * PXK : K.w) * s.d, boxH = (s) => (s.pose ? PCH * PXK : K.h) * s.d;
const exAt = (t) => bodyAt(t);
// mockup poseAt(EX, cx, cy): a point on the clip canvas -> board, mirrored with the body
const poseAt = (s, cx, cy) => { const k = PXK * s.d; return { x: s.x + (cx - PCW / 2) * k * s.flip, y: s.y - s.lift - (PCH - cy) * k }; };
// mockup slashStance(EX, t, cx, dy): where to stand so canvas x = cx of the sweep lands on target k
const slashStance = (s, k, cx, dy) => { const kk = PXK * s.d; return { x: OXk(k) - (cx - PCW / 2) * kk * s.flip, y: OYk(k) + (dy == null ? 6 : dy) * KP }; };
const handOf = (s) => ({ x: s.x + DIR * boxW(s) * 0.3, y: s.y - s.lift - boxH(s) * 0.62 });
const exBody = (s) => ({ x: s.x, y: s.y - s.lift - boxH(s) * 0.5 });

const AFTER = [];
const JADE_F = 'sepia(1) saturate(4) hue-rotate(110deg) brightness(1.3)';
// heavyStep (part-r2): the float glide; Wind7 .18 at rate .6, sine glide, a faint jade afterimage every 90 ms; returns its end
function heavyStep(at, pt, ms) {
  S_(at, 'wind7', 0.18, 0.6); BX.add([at, ms, pt.x, X.sine]); BY.add([at, ms, pt.y, X.sine]); HEAVY.push({ at, ms });
  for (let e = 0; e < ms; e += 90) AFTER.push({ t0: at + e, ms: 420, op: 0.22, filter: JADE_F });
  return at + ms + 240;
}
const lean = (at, d, ms, ease) => BROT.add([at, ms, leanDeg(d), ease || X.out]);
const fadeEx = (at, to, ms) => BALPHA.add([at, ms, to, X.sine]);
const teleport = (at, pt) => { BX.add([at, 0, pt.x]); BY.add([at, 0, pt.y]); };
// playPose: frames [from, to] of a clip; on[key](t) runs when that frame shows; hold = stay on the last frame. Returns the end.
function playPose(at, name, o) {
  o = o || {}; const ms = FR_MS(name), keys = FR_KEY(name); const sp = o.speed || 1, from = o.from || 0, to = Math.min(o.to == null ? 99 : o.to, ms.length - 1);
  BROT.add([at, 1, 0]);
  let t = at; for (let i = from; i <= to; i++) { BPOSE.add(t, { n: name, i }); const kf = keys[i]; if (kf && o.on && o.on[kf]) o.on[kf](t); t += ms[i] / sp; }
  if (!o.hold) BPOSE.add(t, null); return t;
}
const endPose = (at) => BPOSE.add(at, null);

// ── painting the body (world z 20); the token itself is replaced by a blank so its shadow stays the engine's ──
const BAKE = new Map();
function baked(img, filter) { if (!filter || !img) return img; const key = filter; let c = BAKE.get(key); if (c) return c;
  const w = natW(img), h = natH(img); if (!w || !h) return img; c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.filter = filter; x.drawImage(img, 0, 0, w, h); BAKE.set(key, c); return c; }
function paintBody(g, s, a, filter) {
  g.save(); g.translate(s.x, s.y - s.lift); if (s.rot) g.rotate(s.rot * Math.PI / 180); g.scale(s.flip * s.d, s.d); g.globalAlpha = a;
  if (s.pose && tl.IMG[s.pose.n]) { const im = tl.IMG[s.pose.n]; const n = FR_MS(s.pose.n).length || 1; const fw = natW(im) / n, fh = natH(im); const dw = PCW * PXK, dh = PCH * PXK;
    if (filter) g.filter = filter; g.drawImage(im, s.pose.i * fw, 0, fw, fh, -dw / 2, -dh, dw, dh); }
  else if (ART0) g.drawImage(filter ? baked(ART0, filter) : ART0, -K.w / 2, -K.h, K.w, K.h);
  g.restore();
}
const HAS_SH = (() => { try { const f1 = caster.document.flags && caster.document.flags[NS]; const f2 = caster.actor && caster.actor.flags && caster.actor.flags[NS]; return !!((f1 && f1.spriteShadow) || (f2 && f2.spriteShadow)); } catch (e) { return false; } })();
const BLANK = document.createElement('canvas'); BLANK.width = 2; BLANK.height = 2;
(tl.POSE.k = tl.POSE.k || {}).blank = { img: BLANK, foot: 1, w: 0.01, h: 0.01 };
function bodyTrack(total) {
  m.hold(0, total, (t, S) => {
    const s = bodyAt(t); const q = S.tok.k;
    if (s.alpha <= 0.001) q.hidden = true;
    else { q.pose = 'blank'; q.dx = s.x - HB.x; q.dy = s.y - HB.y; q.air = s.lift; q.alpha = s.alpha; if (Math.abs(q.dy) > 0.5) q.noShadow = true; }
    if (HAS_SH && s.alpha > 0.001 && Math.abs(s.y - HB.y) > 0.5) S.world.push({ z: 2, draw: (g) => { const lk = Math.min(1, s.lift / K.h); g.save(); g.globalAlpha = 0.32 * (1 - 0.45 * lk) * s.alpha; g.fillStyle = '#000'; g.beginPath(); g.ellipse(s.x, s.y, K.w * 0.3 * s.d * (1 - 0.35 * lk), K.w * 0.09 * s.d * (1 - 0.35 * lk), 0, 0, 6.2832); g.fill(); g.restore(); } });
    S.world.push({ z: 19, draw: (g) => { for (const af of AFTER) { const age = t - af.t0; if (age < 0 || age >= af.ms) continue; const s2 = af.s || (af.s = bodyAt(af.t0)); if (s2.alpha <= 0) continue; paintBody(g, s2, af.op * (1 - X.sine(age / af.ms)), af.filter); } } });
    if (s.alpha > 0.001) S.world.push({ z: 20, draw: (g) => paintBody(g, s, s.alpha, '') });
  });
}

// ── other bodies: per-token state hooks (lift, squash, flinch, hurt loop, hide) ──
const FLINCH = {
  normal: { ms: 300, move: [[0, 1, 1, 0], [0.12, 1.12, 0.88, 0], [0.30, 0.97, 1.03, -7], [0.50, 1, 1, 6], [0.70, 1, 1, -4], [0.85, 1, 1, 3], [1, 1, 1, 0]], bright: [[0, 3.6], [0.35, 1], [1, 1]] },
  strong: { ms: 480, move: [[0, 1, 1, 0], [0.10, 1.22, 0.80, 0], [0.26, 0.90, 1.10, -13], [0.44, 1, 1, 11], [0.62, 1, 1, -7], [0.80, 1, 1, 5], [1, 1, 1, 0]], bright: [[0, 4], [0.20, 1], [0.40, 3.2], [0.60, 1], [1, 1]] },
};
const stopAt = (st, u, col) => { for (let i = 1; i < st.length; i++) if (u <= st[i][0]) { const a = st[i - 1], b = st[i]; const v = (u - a[0]) / Math.max(1e-6, b[0] - a[0]); return lerp(a[col], b[col], 1 - (1 - v) * (1 - v)); } return st[st.length - 1][col]; };
// ── target poses, read like battler-pose.js: actor system.props.sprite_<pose> (hurt -> idle, ko -> idle). A posed target
// is painted by the shot (its token hidden) from the window's start, the clip played from its first frame on that cue
// (hurt: once, its clip length; ko: once, then holds its last frame). Pose art keeps the idle's PIXEL size, bottom-centre
// on the idle's bottom-centre. The painter reads the token's per-frame state (lift, squash, flinch, focus fade). ──
const propsOfK = (k) => { try { return (TOK[k].token.actor.system.props) || {}; } catch (e) { return {}; } };
const poseUrl = (k, pose) => { const s = String(propsOfK(k)['sprite_' + pose] || '').trim(); return s || null; };
const ARTS = {};                                   // key|pose -> { el, video, ms } | null
function loadArt(url) {
  return new Promise((ok) => { if (!url) return ok(null); let done = false; const fin = (r) => { if (done) return; done = true; ok(r); };
    if (/\.(webm|mp4|m4v|ogv)(\?|$)/i.test(url)) { const v = document.createElement('video'); v.crossOrigin = 'anonymous'; v.muted = true; v.loop = false; v.playsInline = true; v.preload = 'auto';
      v.addEventListener('loadeddata', () => fin({ el: v, video: true, ms: (Number.isFinite(v.duration) && v.duration > 0) ? v.duration * 1000 : 900 })); v.addEventListener('error', () => fin(null)); setTimeout(() => fin(v.readyState >= 2 ? { el: v, video: true, ms: 900 } : null), 5000); v.src = url; }
    else { const im = new Image(); im.crossOrigin = 'anonymous'; im.onload = () => fin({ el: im, video: false, ms: 900 }); im.onerror = () => fin(null); setTimeout(() => fin(im.complete && im.naturalWidth ? { el: im, video: false, ms: 900 } : null), 5000); im.src = url; } }); }
async function loadPoses(k, poses) { for (const p of poses) { const key = k + '|' + p; if (key in ARTS) continue; ARTS[key] = await loadArt(poseUrl(k, p)); } }
const poseMs = (k, p) => { const a = ARTS[k + '|' + p]; return a ? a.ms : 0; };
const PWIN = {};                                   // key -> [{ at, until, pose }]  (pose 'ko-fall' = no KO art: the red fade)
const PAINTED = {};                                // key -> { z, always }
function paintTarget(k, total, o) {
  o = o || {}; if (PAINTED[k]) { Object.assign(PAINTED[k], o); return; } PAINTED[k] = { z: o.z == null ? 18 : o.z, always: !!o.always };
  m.hold(0, total, (t, S) => { const q = S.tok[k]; if (!q) return; const P = PAINTED[k]; const wins = PWIN[k] || [];
    let w = null; for (const x of wins) if (t >= x.at && t < x.until) w = x;
    if (!w && !P.always) return;
    if (q.hidden || q.alpha <= 0.001) { q.hidden = true; return; }
    q.hidden = true; const st = q;   // read at draw time: every track has written this frame by then
    const art = w && w.pose !== 'ko-fall' ? ARTS[k + '|' + w.pose] : null;
    if (art && art.video && !w.started) { w.started = true; try { art.el.currentTime = 0; const pr = art.el.play(); if (pr && pr.catch) pr.catch(() => {}); } catch (e) {} }
    S.world.push({ z: P.z, draw: (g) => { const Tk = TOK[k], idle = tl.art(k); if (!idle) return; const sc = Tk.w / (natW(idle) || Tk.w);
      const bx = Tk.x + st.dx, by = Tk.y + Tk.h / 2 + st.dy - (st.air || 0); let a = st.alpha, red = 0; if (!(a > 0.001)) return;
      if (w && w.pose === 'ko-fall') { const e = t - w.at; red = 0.75 * X.sine(clamp01(e / 250)); a *= lerp(1, 0.3, X.sine(clamp01((e - 300) / 650))); }
      g.save(); g.translate(bx, by); g.scale(Tk.flip * st.sx, st.sy); g.globalAlpha = a; if ((st.tintA || 0) > 0.01) g.filter = 'brightness(' + (1 + 3 * st.tintA).toFixed(3) + ')';
      if (art) { const iw = natW(art.el), ih = natH(art.el); if (iw && ih) g.drawImage(art.el, -iw * sc / 2, -ih * sc, iw * sc, ih * sc); }
      else { g.drawImage(idle, -Tk.w / 2, -Tk.h, Tk.w, Tk.h); if (red > 0.01) { const c = silOf(k, '#c0141c'); if (c) { g.filter = 'none'; g.globalAlpha = a * red; g.drawImage(c, -Tk.w / 2, -Tk.h, Tk.w, Tk.h); } } }
      g.restore(); } }); });
}
// a pose window on target k from 'at': hurt = its clip length (none: nothing), ko = held to the end (none: the red fade)
function poseOn(k, at, pose, total) {
  const has = !!ARTS[k + '|' + pose]; if (!has && pose === 'hurt') return;
  const until = pose === 'ko' ? total + 1 : at + poseMs(k, pose);
  (PWIN[k] = PWIN[k] || []).push({ at, until, pose: has ? pose : (pose === 'ko' ? 'ko-fall' : pose) }); paintTarget(k, total);
}
// the hurt reaction (battler-pose FULL_FLINCH on the token state + the hurt clip from its first frame)
const flinchOn = (k, at, tier, hurt, total) => { const sp = FLINCH[tier] || FLINCH.normal;
  if (hurt) poseOn(k, at, 'hurt', total);
  m.hold(at, at + sp.ms, (e, S) => { const q = S.tok[k]; if (!q) return; const u = e / sp.ms;
    q.sx *= stopAt(sp.move, u, 1); q.sy *= stopAt(sp.move, u, 2); q.dx += stopAt(sp.move, u, 3) * KP * sOf(k) * TOK[k].flip;
    const b = stopAt(sp.bright, u, 1); if (b > 1.05) { const a = Math.min(1, (b - 1) / 3); if (a > q.tintA) { q.tint = '#ffffff'; q.tintA = a; } } }); };
// the Soul Fragment painted by the shot (the full takeover draws token art untinted): its token look = the owner's art
// through the mockup's FRAG_F (Sealed Cavern green, soul-tithe.js), alpha .9 * alphaFn(t); optional flinch + flashActor
let FR_BAKED = null;
function fragPaint(total, alphaFn, o) {
  o = o || {}; const Tk = TOK.fr; if (!Tk) return; const fl = FLINCH[o.tier || 'strong'];
  const bakedFr = (art) => { if (!FR_BAKED) { const w = natW(art), h = natH(art); if (!w || !h) return art; const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); if (FRAG_F) x.filter = FRAG_F; x.drawImage(art, 0, 0, w, h); FR_BAKED = c; } return FR_BAKED; };
  m.hold(0, total, (t, S) => { const q = S.tok.fr; if (q) q.hidden = true; const a = 0.9 * alphaFn(t) * (o.alpha ? o.alpha(t) : 1); if (a <= 0.001) return; S.world.push({ z: 19, draw: (g) => {
    const art = tl.art('fr'); if (!art) return; let sx = 1, sy = 1, dx = 0, filt = '';
    if (o.flinchAt != null) { const e = t - o.flinchAt; if (e >= 0 && e < fl.ms) { const u = e / fl.ms; sx = stopAt(fl.move, u, 1); sy = stopAt(fl.move, u, 2); dx = stopAt(fl.move, u, 3) * KP * sOf('fr') * Tk.flip; } }
    if (o.flashAt != null) { const e = t - o.flashAt; if (e >= 0 && e < 200) { const k = 1 - X.out(e / 200); filt = (FRAG_F ? FRAG_F + ' ' : '') + 'drop-shadow(0 0 ' + (14 * k * KP).toFixed(1) + 'px ' + (o.flashCol || '#ffffff') + ') brightness(' + (1 + 1.3 * k).toFixed(3) + ')'; } }
    const f = tl.feet(Tk); g.save(); g.translate(Tk.x + dx, f.y); g.scale(Tk.flip * sx, sy); g.globalAlpha = a;
    if (filt) { g.filter = filt; g.drawImage(art, -Tk.w / 2, -Tk.h * Tk.foot, Tk.w, Tk.h); } else g.drawImage(bakedFr(art), -Tk.w / 2, -Tk.h * Tk.foot, Tk.w, Tk.h);
    g.restore(); } }); });
}
const tokTrack = (k, total, fn) => m.hold(0, total, (t, S) => { const q = S.tok[k]; if (q) fn(q, t); });

// ── particles (world space; z 2 ground, 4 field: under the battlers; 30 hit: over them) ──
const PS = [];
const LAYER_Z = { ground: 2, field: 4, hit: 30 };
const part = (p) => { p.z = LAYER_Z[p.layer || 'hit']; PS.push(p); return p; };
function posOf(p, age) {
  let dx, dy; const vx = p.vx || 0, vy = p.vy || 0;
  if (p.drag && p.drag < 1) { const L = Math.log(p.drag) / 16; const f = (Math.exp(L * age) - 1) / L; dx = vx * f; dy = vy * f; } else { dx = vx * age; dy = vy * age; }
  dy += 0.5 * (p.g || 0) * age * age; return { x: p.x + dx * KP, y: p.y + dy * KP };
}
function particleTrack(total) {
  m.hold(0, total, (t, S) => {
    for (const z of [2, 4, 30]) { let any = false; for (const p of PS) if (p.z === z && t >= p.t0 && t < p.t0 + p.life) { any = true; break; } if (!any) continue;
      S.world.push({ z, draw: (g) => { for (const p of PS) { if (p.z !== z) continue; const age = t - p.t0; if (age < 0 || age >= p.life) continue; const pt = p.pos ? p.pos(age, t) : posOf(p, age); g.save(); g.globalCompositeOperation = p.comp || 'lighter'; p.draw(g, pt.x, pt.y, age / p.life, age, p, t); g.restore(); } } }); }
  });
}
const glw = (g, x, y, r, rgb, a) => { if (!(r > 0) || !(a > 0)) return; const gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, 'rgba(' + rgb + ',' + a + ')'); gr.addColorStop(1, 'rgba(' + rgb + ',0)'); g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, 6.2832); g.fill(); };
// mockup shards(): spinning jade slivers thrown out of a point
const shards = (at, pt, rgb, n, spread) => { for (let i = 0; i < n; i++) { const an = rnd(0, 6.2832), sp = rnd(0.15, spread), rot = rnd(0, 6), vr = rnd(-0.02, 0.02), sz = rnd(5, 11);
  part({ t0: at, life: rnd(600, 1000), x: pt.x, y: pt.y, vx: Math.cos(an) * sp, vy: Math.sin(an) * sp - 0.2, g: 0.0012, drag: 0.985, layer: 'hit', comp: 'source-over',
    draw: (g, x, y, u, age) => { const s = sz * KP; g.translate(x, y); g.rotate(rot + vr * age); g.globalAlpha = 1 - u; g.fillStyle = 'rgba(' + rgb + ',1)'; g.beginPath(); g.moveTo(0, -s); g.lineTo(s * 0.6, 0); g.lineTo(0, s * 0.9); g.lineTo(-s * 0.5, 0); g.fill(); } }); } };
// mockup homing(): a mote on a quadratic curve (ease-in), glow + a short streak
const homing = (at, from, to, rgb, o) => { o = o || {}; const arc = (o.arc == null ? 120 : o.arc) * KP; const cx = (from.x + to.x) / 2 + rnd(-arc, arc), cy = Math.min(from.y, to.y) - rnd(arc * 0.3, arc);
  const life = (o.ms || 900) * rnd(0.85, 1.15), r = (o.r || 4) * KP;
  const at2 = (age) => { const tt = X.in(Math.min(1, age / life)), u = 1 - tt; return { x: u * u * from.x + 2 * u * tt * cx + tt * tt * to.x, y: u * u * from.y + 2 * u * tt * cy + tt * tt * to.y }; };
  part({ t0: at, life, pos: at2, layer: 'hit', draw: (g, x, y, u, age) => { const pv = at2(Math.max(0, age - 16)); glw(g, x, y, r * 3.5, rgb, 0.95); g.strokeStyle = 'rgba(' + rgb + ',.5)'; g.lineWidth = r; g.beginPath(); g.moveTo(pv.x, pv.y); g.lineTo(x, y); g.stroke(); } }); };
// mockup soulStream(): n motes from 'from' to 'to', staggered over 60% of ms
const soulStream = (at, from, to, o) => { const n = o.n || 16, ms = o.ms || 800, spread = (o.spread == null ? 30 : o.spread) * KP;
  for (let i = 0; i < n; i++) homing(at + i * ms / n * 0.6, { x: from.x + rnd(-spread, spread), y: from.y + rnd(-spread, spread) }, to, o.rgb || JADE, { ms: ms * rnd(0.7, 1), arc: o.arc == null ? 90 : o.arc, r: rnd(2.5, 4.5) }); };
// mockup ring(): an expanding floor ellipse (ground layer)
const ring = (at, pt, o) => { const rgb = o.rgb || '255,255,255', r0 = o.r0 == null ? 10 : o.r0, r1 = o.r1 == null ? 160 : o.r1, ms = o.ms || 600, sy = o.sy || 0.3, w = o.w || 6;
  part({ t0: at, life: ms, x: pt.x, y: pt.y, layer: 'ground', draw: (g, x, y, u) => { const r = lerp(r0, r1, X.outCubic(u)) * KP; g.strokeStyle = 'rgba(' + rgb + ',' + (1 - u) + ')'; g.lineWidth = w * (1 - u * 0.6) * KP; g.beginPath(); g.ellipse(x, y, r, r * sy, 0, 0, 6.2832); g.stroke(); } }); };
// mockup floorShadow(): a dark ellipse that grows (EASE.in) under a target until 'end'
const floorShadow = (at, end, pt, o) => { const r = o.r || 60, grow = o.grow || 600, to = o.to == null ? 0.55 : o.to, s = o.s || 1;
  part({ t0: at, life: Math.max(1, end - at), x: pt.x, y: pt.y, layer: 'ground', comp: 'source-over', draw: (g, x, y, u, age) => { const k = X.in(clamp01(age / grow)); g.fillStyle = 'rgba(0,0,0,' + (to * k) + ')'; g.beginPath(); g.ellipse(x, y, Math.max(0.1, r * k * s * KP), Math.max(0.1, r * k * s * KP * 0.32), 0, 0, 6.2832); g.fill(); } }); };
const crack = (at, pt, s) => { const segs = Array.from({ length: 7 }, () => [rnd(0, 6.2832), rnd(30, 80)]);
  part({ t0: at, life: 1600, x: pt.x, y: pt.y, layer: 'ground', comp: 'source-over', draw: (g, x, y, u) => { g.strokeStyle = 'rgba(30,18,10,' + (u > 0.7 ? (1 - u) / 0.3 * 0.8 : 0.8) + ')'; g.lineWidth = 3 * s * KP; for (const sg of segs) { const a = sg[0], L = sg[1] * KP; g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * L * s * 0.5, y + Math.sin(a) * L * s * 0.16); g.lineTo(x + Math.cos(a + 0.3) * L * s, y + Math.sin(a + 0.3) * L * s * 0.32); g.stroke(); } } }); };
const dustBurst = (at, pt, o) => { const n = o.n || 14, s = o.s || 1, rgb = o.rgb || '190,170,140';
  for (let i = 0; i < n; i++) { const an = rnd(Math.PI, Math.PI * 2), r = rnd(8, 18) * s; part({ t0: at, life: rnd(500, 900), x: pt.x + rnd(-10, 10) * s * KP, y: pt.y, vx: Math.cos(an) * rnd(0.08, 0.25) * s, vy: Math.sin(an) * rnd(0.02, 0.1) * s, drag: 0.97, layer: 'field', comp: 'source-over',
    draw: (g, x, y, u) => { g.fillStyle = 'rgba(' + rgb + ',' + (0.45 * (1 - u)) + ')'; g.beginPath(); g.arc(x, y, r * (1 + u) * KP, 0, 6.2832); g.fill(); } }); } };
// the approved tapered slash (part-r2 taperBlade): straight, pointed both ends, glow / body / white core
function taperPath(g, x0, y0, x1, y1, w) { const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy) || 1, nx = -dy / L, ny = dx / L, N = 24, top = [], bt = [];
  for (let i = 0; i <= N; i++) { const u = i / N; let h = w / 2 * Math.pow(Math.sin(Math.PI * u), 0.7); if (u > 0.6) h *= 1 - (u - 0.6) * 0.5; const x = x0 + dx * u, y = y0 + dy * u; top.push([x + nx * h, y + ny * h]); bt.push([x - nx * h, y - ny * h]); }
  g.beginPath(); top.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); for (let i = bt.length - 1; i >= 0; i--) g.lineTo(bt[i][0], bt[i][1]); g.closePath(); }
function taperBlade(g, x0, y0, x1, y1, w, rgb, a) { g.globalCompositeOperation = 'lighter';
  taperPath(g, x0, y0, x1, y1, w * 2.4); g.fillStyle = 'rgba(' + rgb + ',' + (0.22 * a) + ')'; g.fill();
  taperPath(g, x0, y0, x1, y1, w); g.fillStyle = 'rgba(' + rgb + ',' + (0.85 * a) + ')'; g.fill();
  taperPath(g, x0, y0, x1, y1, w * 0.3); g.fillStyle = 'rgba(255,255,255,' + (0.95 * a) + ')'; g.fill(); }
// part-r2 screenStroke(): the head races A -> B, the tail follows, the width halves, it fades (w in mockup px)
const screenStroke = (at, A0, B0, o) => { const ms = o.ms || 520, w = (o.w || 40) * KP, rgb = o.rgb || JADE;
  part({ t0: at, life: ms, x: 0, y: 0, layer: 'hit', pos: () => ({ x: 0, y: 0 }), draw: (g, x, y, t) => { const head = X.outCubic(Math.min(1, t / 0.22)), tail = t < 0.18 ? 0 : Math.pow(Math.min(1, (t - 0.18) / 0.6), 2);
    const hx = lerp(A0.x, B0.x, head), hy = lerp(A0.y, B0.y, head), tx = lerp(A0.x, B0.x, tail), ty = lerp(A0.y, B0.y, tail); if (Math.hypot(hx - tx, hy - ty) < 2) return;
    taperBlade(g, tx, ty, hx, hy, w * (1 - t * 0.5), rgb, t > 0.6 ? 1 - (t - 0.6) / 0.4 : 1); } }); };
// part-common crescent(): a curved cut drawn across a point (mirrored with the shot)
const crescent = (at, pt, o) => { const len = (o.len || 160) * KP, w = (o.w || 26) * KP, rgb = o.rgb || '255,255,255', ang = o.ang == null ? -0.5 : o.ang;
  part({ t0: at, life: o.ms || 260, x: pt.x, y: pt.y, layer: 'hit', draw: (g, x, y, t) => { const k = X.outCubic(Math.min(1, t * 1.6)); g.translate(x, y); g.scale(DIR, 1); g.rotate(ang); g.globalAlpha = 1 - Math.max(0, (t - 0.45) / 0.55);
    g.fillStyle = 'rgba(' + rgb + ',.9)'; g.beginPath(); g.moveTo(-len / 2, 0); g.quadraticCurveTo(0, -w * 1.6 * k, len / 2 * k, 0); g.quadraticCurveTo(0, -w * 0.4, -len / 2, 0); g.fill();
    glw(g, 0, -w * 0.5, len * 0.45, rgb, 0.35); } }); };

// ── clips: size = source px * scale * the library factor k * KP; mirrored with the shot ──
// Additive pixelfx _light layers are glow on black: an SVG luminance-to-alpha filter makes the black transparent
// before the 'lighter' add (the Geist kit's black-box fix).
const LUMA_FILTER = (() => { const id = 'oni-luma-alpha'; try { if (!document.getElementById(id)) { const ns = 'http://www.w3.org/2000/svg'; const svg = document.createElementNS(ns, 'svg'); svg.setAttribute('width', '0'); svg.setAttribute('height', '0'); svg.style.position = 'absolute'; svg.style.pointerEvents = 'none'; const f = document.createElementNS(ns, 'filter'); f.setAttribute('id', id); f.setAttribute('color-interpolation-filters', 'sRGB'); const cm = document.createElementNS(ns, 'feColorMatrix'); cm.setAttribute('type', 'matrix'); cm.setAttribute('values', '1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  1 1 1 0 0'); f.appendChild(cm); svg.appendChild(f); document.body.appendChild(svg); } } catch (e) {} return 'url(#' + id + ')'; })();
const clipW = (key, scale) => (CL[key] ? CL[key].w * scale * (CL[key].k || 0.55) * KP : 0);
// plain clips (MV): over the battlers (mockup #ffx comes after #factors), z 26 unless given
const fx = (key, at, pt, scale, o) => { if (!CL[key]) return null; o = o || {}; return m.clip(key, at, Object.assign({ x: pt.x, y: pt.y, w: clipW(key, scale), z: 26, flip: DIR < 0 }, o)); };
// pixelfx: back under the battlers (z 2), front at o.z (over), light over the front, added (mockup pxClip)
// o.until + o.fade: a looping clip stopped with a fade (mockup .stop(ms))
const pxfx = (base, at, pt, scale, o) => { o = o || {}; const z = o.z == null ? 40 : o.z;
  const extra = {}; if (o.loop) { extra.loop = true; extra.hold = (o.until - at) + (o.fade || 0); const until = o.until, fade = o.fade || 0, dur = extra.hold; extra.alpha = (u) => { const ta = at + u * dur; return ta <= until ? 1 : 1 - X.sine(clamp01((ta - until) / Math.max(1, fade))); }; }
  else if (o.until != null) { const def = CL[base + '_front'] || CL[base + '_light']; if (def) { const dur = Math.min(def.dur, o.until - at + (o.fade || 0)); extra.hold = dur; const until = o.until, fade = o.fade || 0; extra.alpha = (u) => { const ta = at + u * dur; return ta <= until ? 1 : 1 - X.sine(clamp01((ta - until) / Math.max(1, fade))); }; } }
  const zb = o.zBack == null ? 2 : o.zBack;
  if (o.back !== false) fx(base + '_back', at, pt, scale, Object.assign({ z: zb }, extra));
  fx(base + '_front', at, pt, scale, Object.assign({ z }, extra));
  fx(base + '_light', at, pt, scale, Object.assign({ z: z + 0.5, add: true, filter: LUMA_FILTER }, extra)); };
// mockup pxMover(): a looping pixelfx (front + light) moved along pos(e) for dur ms (no back layer)
const pxMover = (base, at, dur, scale, z, pos) => { for (const L of ['front', 'light']) { const key = base + '_' + L; if (!CL[key]) continue; const w = clipW(key, scale);
  m.clip(key, at, Object.assign({ x: 0, y: 0, w, z: L === 'light' ? z + 0.5 : z, loop: true, hold: dur, flip: DIR < 0, live: (e) => { const p = pos(e); return { x: p.x, y: p.y, w, rot: 0 }; } }, L === 'light' ? { add: true, filter: LUMA_FILTER } : {})); } };

// ── screen: level tracks (tw) for the field dim, the white flash and the vignette ──
const dimTrack = track(0), whiteTrack = track(0), vigTrack = track(0);
const fdim = (at, to, ms) => dimTrack.add([at, ms, to, X.sine]);
const whiteTo = (at, to, ms) => whiteTrack.add([at, ms, to, X.sine]);
const vignette = (at, to, ms) => vigTrack.add([at, ms, to, X.sine]);
const flashC = (at, color, peak, inMs, outMs) => m.hold(at, at + inMs + outMs, (e, S) => { const a = e < inMs ? peak * e / inMs : peak * (1 - X.out((e - inMs) / outMs)); if (a > S.flash.a) S.flash = { a, c: color }; });
const shake = (at, px, ms) => m.shake(at, ms, px * KP);
const rumble = (t0, t1, px) => m.hold(t0, t1, (e, S) => { S.shake = Math.max(S.shake, px * KP); });
function screenTrack(total) {
  m.hold(0, total, (t, S) => {
    const d = dimTrack(t); if (d > 0.001) S.dim = Math.max(S.dim, d);
    const w = whiteTrack(t); if (w > 0.001 && w > S.flash.a) S.flash = { a: w, c: '#ffffff' };
    const v = vigTrack(t); if (v > 0.001) S.screen.push({ draw: (g) => { const W = g.W, H = g.H, Rr = W / Math.SQRT2; g.save(); g.translate(W / 2, H / 2); g.scale(1, H / W);
      const gr = g.createRadialGradient(0, 0, 0, 0, 0, Rr); gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(0.45, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,.85)'); g.globalAlpha = v; g.fillStyle = gr; g.fillRect(-Rr, -Rr, Rr * 2, Rr * 2); g.restore(); } });
  });
}
// the mockup's anime impact frame: 70 ms black with the targets in white + a burst of white lines, then 70 ms white
// with them in black and black lines. who = [{ k, lift(t) }] (a hoisted target is drawn where it hangs)
const SIL = new Map();
function silOf(k, col) { const key = k + '|' + col; let c = SIL.get(key); if (c) return c; const art = tl.art(k); const w = natW(art), h = natH(art); if (!w || !h) return null;
  c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.drawImage(art, 0, 0, w, h); x.globalCompositeOperation = 'source-in'; x.fillStyle = col; x.fillRect(0, 0, w, h); SIL.set(key, c); return c; }
const impactFrame = (at, who) => { const rays = Array.from({ length: 46 }, () => [rnd(0, 6.2832), rnd(0.006, 0.03), rnd(90, 220)]); const rays2 = Array.from({ length: 46 }, () => [rnd(0, 6.2832), rnd(0.006, 0.03), rnd(90, 220)]);
  m.hold(at, at + 140, (e, S) => { const first = e < 70; S.screen.push({ draw: (g) => {
    const W = g.W, H = g.H, o0 = tl.toScreen(0, 0), sc = tl.toScreen(1, 0).x - o0.x, hk = H / 788;
    g.save(); g.fillStyle = first ? '#000' : '#fff'; g.fillRect(-20, -20, W + 40, H + 40);
    let cx = 0, cy = 0; for (const w of who) { const Tk = TOK[w.k]; const lf = w.lift ? w.lift(at + e) : 0; const p = tl.toScreen(Tk.x, Tk.y - lf); cx += p.x / who.length; cy += p.y / who.length; }
    g.fillStyle = first ? '#fff' : '#000'; for (const r of (first ? rays : rays2)) { const a = r[0], w = r[1], r0 = r[2] * hk; g.beginPath(); g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); g.lineTo(cx + Math.cos(a - w) * 1900 * hk, cy + Math.sin(a - w) * 1900 * hk); g.lineTo(cx + Math.cos(a + w) * 1900 * hk, cy + Math.sin(a + w) * 1900 * hk); g.fill(); }
    for (const w of who) { const Tk = TOK[w.k]; const c = silOf(w.k, first ? '#ffffff' : '#000000'); if (!c) continue; const lf = w.lift ? w.lift(at + e) : 0; const f = tl.feet(Tk); const p = tl.toScreen(Tk.x, f.y - lf);
      g.save(); g.translate(p.x, p.y + 4 * KP * sc); g.scale(Tk.flip, 1); g.drawImage(c, -Tk.w * sc / 2, -Tk.h * Tk.foot * sc, Tk.w * sc, Tk.h * sc); g.restore(); }
    g.restore(); } }); }); };

// ── the camera (mockup FCAM): 'to' tweens (zoom in log space; a later tween wins where they overlap; a partial target
// keeps the other values where they were when it started) and camFollow (each 16 ms: x/y += 10 %, zoom += 6 %),
// replayed at 60 fps up front so every client gets the same path. World px, home = the stage rest view. ──
const REST = { x: tl.REST.cx, y: tl.REST.cy, z: 1 };
const CAMOPS = [];
const camTo = (at, p, ms, ease) => CAMOPS.push({ k: 'to', at, p, ms, ease: ease || X.sine });
const camHome = (at, ms) => camTo(at, { x: REST.x, y: REST.y, z: 1 }, ms, X.sine);
const camFollow = (at, until, z, up, kk) => CAMOPS.push({ k: 'f', at, until, z, up: up == null ? 0.55 : up, kk: kk == null ? 0.1 : kk });
const FRM = 1000 / 60;
function cameraTrack(total) {
  if (LIVE || !CAMOPS.length) return;
  const c = { x: REST.x, y: REST.y, z: 1 }; const out = []; const ops = CAMOPS.map((o) => Object.assign({ s: null, done: false }, o));
  for (let t = 0; t <= total + FRM; t += FRM) {
    for (const o of ops) { if (t < o.at || o.done) continue;
      if (o.k === 'to') { if (!o.s) o.s = { x: c.x, y: c.y, z: c.z }; const e = Object.assign({}, o.s, o.p); const u = o.ms > 0 ? Math.min(1, (t - o.at) / o.ms) : 1; const k = o.ease(u);
        c.x = lerp(o.s.x, e.x, k); c.y = lerp(o.s.y, e.y, k); c.z = Math.exp(lerp(Math.log(o.s.z), Math.log(e.z), k)); if (u >= 1) o.done = true; }
      else { if (t >= o.until) { o.done = true; continue; } const s = bodyAt(t); const tx = s.x, ty = s.y - s.lift - boxH(s) * o.up; c.x += (tx - c.x) * o.kk; c.y += (ty - c.y) * o.kk; c.z += (o.z - c.z) * o.kk * 0.6; } }
    out.push({ cx: c.x, cy: c.y, zoom: c.z }); }
  m.hold(0, total, (t, S) => { S.cam = out[Math.min(out.length - 1, Math.floor(t / FRM))]; });
}

// ── run: body, particles, screen, camera; the damage gate fires at 'gate' (and again, harmlessly, at the end) ──
async function runShot(total, gate) {
  bodyTrack(total); particleTrack(total); screenTrack(total); cameraTrack(total);
  if (gate != null) once(gate, () => oni.fireDone());
  await tl.run(T, { total, onStart: () => { const h = ctx.params.readyHook; if (h) { try { Hooks.callAll(h); } catch (e) {} } } });
  oni.fireDone();
}
