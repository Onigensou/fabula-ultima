"use strict";
// ═════════ move-engine · MOCKUP host engine (canvas / DOM stage). Load order: shared/core.js, THIS, shared/fx-core.js,
// shared/common.js, shared/fx-melee.js, family parts, moves, page UI. Started from the Nox / Lionheart mockup engine
// (part-engine.nx.js, 2026-11-20); changes: the BEAT CLOCK (wait / tween on virtual time), the stage preset + lineup
// from window.STAGE_PRESET / window.ACTORS (no per-mockup regex patches), data: URI videos, seeded move jitter, the trace.
const M = window.META;
const $ = (id) => document.getElementById(id);
const stage = $("stage"), view = $("view");
new ResizeObserver(() => { view.style.transform = `scale(${stage.clientWidth / W})`; }).observe(stage);

// ───────── Run control: every wait/tween belongs to a run; a new run aborts the old one.
// FAST = replaying earlier beats instantly to reach a chosen beat.
let RUN = 0, FAST = false, SPEED = 1, SOUND = true;
const ABORT = new Error("abort");
window.addEventListener("unhandledrejection", (ev) => { if (ev.reason === ABORT) ev.preventDefault(); });
const live = (rid) => { if (rid !== RUN) throw ABORT; };
// ───────── The BEAT CLOCK. A run's waits and tweens are scheduled on VIRTUAL time (the move's ms as authored), anchored to
// the run's real start: wait(ms) ends at vt + ms, not "now + ms". A late timer or a slow frame no longer pushes every later
// beat back, so each beat lands at its planned ms, and the game runtime (the same move on a virtual clock) lands it at the
// same ms. CLK.vt = the virtual ms the code running right now belongs to; a resolver sets it just before resolving.
const CLK = { rid: -1, t0: 0, vt: 0, fast: false };
function clkSync() {
  if (CLK.rid !== RUN) { CLK.rid = RUN; CLK.vt = 0; CLK.t0 = performance.now(); CLK.fast = FAST; moveSeed(window.MOVE_SEED); traceReset(moveCaster()); }
  if (CLK.fast && !FAST) CLK.t0 = performance.now() - CLK.vt / SPEED;   // FAST replay just ended: re-anchor to now
  CLK.fast = FAST; }
const clockNow = () => { clkSync(); return CLK.vt; };
// Resolving: a finished wait / tween sets CLK.vt to its own target, then resolves in its OWN timer / frame callback, so its
// continuation runs (in that callback's microtask flush) with that vt. The engine therefore uses the browser's native
// timers: the review kit rewrites setTimeout / requestAnimationFrame to its pausable clock, which fires every due callback
// of a tick in ONE batch (continuations would then share one flush and read the last vt). Time is still read from
// performance.now(), which the kit maps to its pausable clock: a timer that fires during a pause just re-arms.
// FAST replay resolves through a queue released one per task (MessageChannel), each with its own vt.
const NATIVE = { timeout: window["set" + "Timeout"].bind(window), raf: window["request" + "AnimationFrame"].bind(window) };
const DUE = []; let DUE_SEQ = 0, DUE_POSTED = false; const DUE_MC = new MessageChannel();
DUE_MC.port1.onmessage = () => { DUE_POSTED = false; if (!DUE.length) return; DUE.sort((a, b) => a.target - b.target || a.seq - b.seq); const d = DUE.shift();
  CLK.vt = d.target; try { d.fn(); } catch (err) { console.error(err); } if (DUE.length && !DUE_POSTED) { DUE_POSTED = true; DUE_MC.port2.postMessage(0); } };
function dueQueued(target, fn) { DUE.push({ target, seq: DUE_SEQ++, fn }); if (!DUE_POSTED) { DUE_POSTED = true; DUE_MC.port2.postMessage(0); } }
TRACE.on = window.MOVE_TRACE !== false; TRACE.now = clockNow; TRACE.real = () => (performance.now() - CLK.t0) * SPEED;
window.__MOVE_ENGINE = { version: MOVE_ENGINE_VERSION, TRACE, CLK };   // tests read the trace here
function wait(ms) { clkSync(); const rid = RUN, target = CLK.vt + Math.max(0, ms || 0);
  const settle = (res, rej) => { if (rid !== RUN) return rej(ABORT); CLK.vt = target; res(); };
  if (FAST) return new Promise((res, rej) => dueQueued(target, () => settle(res, rej)));
  return new Promise((res, rej) => { const arm = () => { const left = CLK.t0 + target / SPEED - performance.now();
    if (left > 1) NATIVE.timeout(arm, left); else dueQueued(target, () => settle(res, rej)); };   // never settle in the CALLER's task: it would move the caller's vt
    NATIVE.timeout(arm, Math.max(0, CLK.t0 + target / SPEED - performance.now())); }); }
function tween(ms, ease, fn) {
  clkSync(); const rid = RUN, start = CLK.vt, d = Math.max(1, ms || 0), end = start + (ms || 0);
  const settle = (res, rej) => { if (rid !== RUN) return rej(ABORT); CLK.vt = end; res(); };
  if (FAST) { fn(ease(1)); return new Promise((res, rej) => dueQueued(end, () => settle(res, rej))); }
  return new Promise((res, rej) => {
    const step = () => { if (rid !== RUN) return rej(ABORT); const t = clamp(((performance.now() - CLK.t0) * SPEED - start) / d, 0, 1); fn(ease(t));
      if (t < 1) NATIVE.raf(step); else settle(res, rej); };
    NATIVE.raf(step);
  });
}
const isVideo = (src) => /\.webm$|^data:video\//.test(src || "");
const LOOPS = [];
function sfx(key, vol = .55, rate = 1, stopAfter = 0) { if (!FAST) traceEv("sfx", { key, vol, rate, ...(stopAfter ? { stopAfter } : {}), ...(M.sfx[key] ? {} : { missing: true }) }); if (FAST || !SOUND || !M.sfx[key]) return null; const a = new Audio(M.sfx[key]); a.volume = Math.min(1, vol * .75); a.playbackRate = rate; a.play().catch(() => {}); LOOPS.push(a);
  if (stopAfter) setTimeout(() => { const v0 = a.volume; let k = 0; const iv = setInterval(() => { k++; a.volume = Math.max(0, v0 * (1 - k / 10)); if (k >= 10) { clearInterval(iv); a.pause(); } }, 30); }, stopAfter / SPEED); return a; }

// ───────── Cameras. Focus point (x,y) in layer px at screen centre, zoom z, roll r (deg). Zoom moves in log space.
function makeCam(el) { const c = { el, x: W/2, y: H/2, z: 1, r: 0 };
  c.apply = () => { el.style.transform = `translate(${W/2}px, ${H/2}px) rotate(${c.r}deg) scale(${c.z}) translate(${-c.x}px, ${-c.y}px)`; };
  c.to = (p, ms, ease = EASE.sine) => { const s = { x: c.x, y: c.y, z: c.z, r: c.r }; const e = { ...s, ...p };
    return tween(ms, ease, (t) => { c.x = lerp(s.x, e.x, t); c.y = lerp(s.y, e.y, t); c.r = lerp(s.r, e.r, t); c.z = Math.exp(lerp(Math.log(s.z), Math.log(e.z), t)); c.apply(); }); };
  c.set = (p) => { Object.assign(c, p); c.apply(); };
  c.screen = (p) => { const a = c.r * Math.PI / 180, dx = (p.x - c.x) * c.z, dy = (p.y - c.y) * c.z; return { x: W/2 + dx * Math.cos(a) - dy * Math.sin(a), y: H/2 + dx * Math.sin(a) + dy * Math.cos(a) }; };
  c.apply(); return c; }
const FCAM = makeCam($("field")), DCAM = makeCam($("dimcam"));
{ const u = document.createElement("div"); u.id = "dunder"; Object.assign(u.style, { position: "absolute", left: -W + "px", top: -H + "px", width: 3 * W + "px", height: 3 * H + "px", background: "#000" }); $("dimcam").insertBefore(u, $("dimcam").firstChild); }

// ═════════ 3D battle stage (port of battle-director/battle-stage-3d*.js, "Full" mode) ═════════
// Training Ground = scene 2560x1270, stage rect (439,241,1682,788), preset Eisendrache_Battlemap001_v2.
// Depth scale: tokenScaleAt. Parallax: the same fragment shader, fed by the live camera + idle orbit.
const DEF3D = { refRow: 440, strength: .33, minScale: .6, maxScale: 1.12, band: [190, 600], pan: .3, near: .6, dolly: .5,
  orbitX: 12, orbitY: 3, orbitPeriodX: 26, orbitPeriodY: 19, maxShift: 120, dofFar: .4, dofNear: .55, blurPx: 5 };
// Valley_Battlemap004 preset (battle-stage-3d-rules.js): horizon 58.6, strength .374, relief model.
// a page picks its map preset with window.STAGE_PRESET = { horizon, strength, ... } (default: Valley_Battlemap004)
const TG = { ...DEF3D, horizon: 58.6, strength: .374, scene: { w: 2560, h: 1270 }, stage: { x: 439, y: 241, w: 1682, h: 788 }, ...(window.STAGE_PRESET || {}) };
const tokenScaleAt = (footY, P = TG) => { const den = P.refRow - P.horizon, num = Math.max(footY - P.horizon, den * .05); return clamp(Math.pow(num / den, P.strength), P.minScale, P.maxScale); };
const FRAG = `precision highp float;
varying vec2 vUV; uniform sampler2D uSampler; uniform sampler2D uBlur; uniform sampler2D uDepth;
uniform vec2 uOffset; uniform vec2 uPivot; uniform float uDolly; uniform vec2 uBand; uniform float uNear; uniform vec2 uDof;
float disp(vec2 uv) { return texture2D(uDepth, clamp(uv, 0.0, 1.0)).r * 2.0; }
float farW(float D) { return clamp(1.0 - D / max(uBand.x, 1e-4), 0.0, 1.0); }
float nearW(float D) { return clamp((D - uBand.y) / max(uBand.y, 1e-4), 0.0, 1.5); }
vec2 shiftAt(vec2 uv) { float D = disp(uv); float w = farW(D) - uNear * nearW(D); return w * (uOffset + (uPivot - uv) * uDolly); }
void main() { vec2 s = shiftAt(vUV); s = shiftAt(vUV - s); s = shiftAt(vUV - s); vec2 src = clamp(vUV - s, 0.0, 1.0);
  float D = disp(src); float b = clamp(uDof.x * farW(D) + uDof.y * min(nearW(D), 1.0), 0.0, 1.0);
  gl_FragColor = mix(texture2D(uSampler, src), texture2D(uBlur, src), b); }`;
const VERT = `attribute vec2 p; varying vec2 vUV; void main() { vUV = vec2(p.x * .5 + .5, .5 - p.y * .5); gl_Position = vec4(p, 0.0, 1.0); }`;
function loadImg(src) { return new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src; }); }
// A parallax stage on a canvas. depth = image url, or a function (canvas) => draws a grey depth map.
function makeStage(canvas, P, cam, layerOffset) {
  const gl = canvas.getContext("webgl", { premultipliedAlpha: false, preserveDrawingBuffer: true }); const S = { ok: false, P, on: true, t0: performance.now(), orbit: true };
  if (!gl) return S;
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s)); return s; };
  const pr = gl.createProgram(); gl.attachShader(pr, sh(gl.VERTEX_SHADER, VERT)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FRAG)); gl.linkProgram(pr); gl.useProgram(pr);
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(pr, "p"); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const U = (n) => gl.getUniformLocation(pr, n);
  const tex = (unit, src) => { const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src); return t; };
  S.load = async (imgUrl, depth) => {
    const img = await loadImg(imgUrl); if (!img) return;
    const blur = document.createElement("canvas"); blur.width = img.width; blur.height = img.height; const bx = blur.getContext("2d"); bx.filter = `blur(${P.blurPx}px)`; bx.drawImage(img, 0, 0);
    let dimg; if (typeof depth === "function") { dimg = document.createElement("canvas"); dimg.width = 256; dimg.height = 128; depth(dimg); } else dimg = await loadImg(depth);
    gl.useProgram(pr); tex(0, img); tex(1, blur); tex(2, dimg);
    gl.uniform1i(U("uSampler"), 0); gl.uniform1i(U("uBlur"), 1); gl.uniform1i(U("uDepth"), 2); S.ok = true; };
  // canvas rows: horizon / bottom / band are stage-local rows; the canvas spans the whole scene image
  const sr = P.stage, sc = P.scene; const hz = sr.y + P.horizon, bottom = sr.y + sr.h;
  const D = (y) => Math.max(0, (y - hz) / (bottom - hz));
  S.draw = (now) => {
    if (!S.ok || !S.on) return; const t = (now - S.t0) / 1000;
    let ox = (cam.x - W / 2), oy = (cam.y - H / 2);
    ox += S.extraX || 0; oy += S.extraY || 0;
    if (S.orbit) { ox += P.orbitX * Math.sin(2 * Math.PI * t / P.orbitPeriodX); oy += P.orbitY * Math.sin(2 * Math.PI * t / P.orbitPeriodY + 1.3); }
    ox = clamp(ox, -P.maxShift, P.maxShift); oy = clamp(oy, -P.maxShift, P.maxShift);
    const dolly = clamp(P.dolly * (1 - 1 / cam.z), -.3, .3);
    gl.viewport(0, 0, canvas.width, canvas.height); gl.useProgram(pr);
    gl.uniform2f(U("uOffset"), ox * P.pan / sc.w, oy * P.pan / sc.h);
    gl.uniform2f(U("uPivot"), (cam.x + sr.x) / sc.w, (cam.y + sr.y) / sc.h);
    gl.uniform1f(U("uDolly"), dolly); gl.uniform2f(U("uBand"), D(sr.y + P.band[0]), D(sr.y + P.band[1]));
    gl.uniform1f(U("uNear"), P.near); gl.uniform2f(U("uDof"), P.dofFar, P.dofNear);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); };
  canvas.style.left = (-sr.x) + "px"; canvas.style.top = (-sr.y) + "px"; canvas.style.width = sc.w + "px"; canvas.style.height = sc.h + "px";
  canvas.width = Math.round(sc.w * .75); canvas.height = Math.round(sc.h * .75);
  return S;
}
const FIELD3D = makeStage($("fieldgl"), TG, FCAM);
FIELD3D.load(M.sprites.tg_bg, M.sprites.tg_depth);
// Keren's underworld: Keren_Map001 has no depth map yet, so a floor-only gradient stands in (horizon at row 160).
const UWP = { ...DEF3D, maxShift: 420, horizon: 160, strength: .33, band: [330, 640], pan: .55, near: .8, dolly: .6, orbitX: 6, orbitY: 2, dofFar: .25, dofNear: .3, blurPx: 4, scene: { w: W, h: H }, stage: { x: 0, y: 0, w: W, h: H } };
const DIM3D = makeStage($("dimgl"), UWP, DCAM); DIM3D.on = false;
// the painting is stretched 1.4x around the frame so tilted / panned shots never reach its edge
Object.assign($("dimgl").style, { left: (-W * .2) + "px", top: (-H * .2) + "px", width: (W * 1.4) + "px", height: (H * 1.4) + "px" });
const uwDepth = (c) => { const x = c.getContext("2d"); for (let y = 0; y < c.height; y++) { const row = y / c.height * H; const d = Math.max(0, (row - 160) / (H - 160)); const v = Math.round(clamp(d * .5 + (row < 160 ? 0 : 0), 0, 1) * 255); x.fillStyle = `rgb(${v},${v},${v})`; x.fillRect(0, y, c.width, 1); } };

// ───────── Battlers on the Training Ground (formation.js party line P0→P1, enemy line E0→E1; token 1x1 on grid 110, texture scale per actor)
const GRID = 110;
// a page sets its lineup with window.ACTORS = { id: { cx, cy, sc, kind } } (default: the party + the Nox Legion)
const ACT = window.ACTORS || {
  hina:    { cx: 1202, cy: 162, sc: 1.54, kind: "party" }, zarg: { cx: 1257, cy: 272, sc: 1.56, kind: "party" },
  keren:   { cx: 1312, cy: 382, sc: 1.47, kind: "party" }, blanche: { cx: 1367, cy: 492, sc: 1.55, kind: "party" },
  // Nox Legion: texture scale from the 2026-11-20 authoring migration (1x1 tokens); art faces left, the enemy side mirrors it
  ghoul: { cx: 400, cy: 300, sc: 0.95, kind: "enemy" }, hound: { cx: 460, cy: 180, sc: 1.0, kind: "enemy" }, priest: { cx: 330, cy: 450, sc: 1.47, kind: "enemy" },
  wraith: { cx: 420, cy: 300, sc: 1.0, kind: "enemy" }, viper: { cx: 410, cy: 320, sc: 1.41, kind: "enemy" }, executioner: { cx: 380, cy: 330, sc: 2.24, kind: "enemy" },
  // a Soul Fragment stand-in: Zarg's battler mirrored onto the enemy side, tinted like soul-tithe.js does
  frag: { cx: 560, cy: 470, sc: 1.56, kind: "enemy" },
};
const POSES = {
  zarg: ["zarg", "pose_zarg_crisis", "pose_zarg_hurt", "pose_zarg_ko", "pose_zarg_sleep", "pose_zarg_walkdl", "pose_zarg_walkul", "pose_zarg_walkd", "pose_zarg_standd", "pose_zarg_standul"],
  keren: ["keren", "pose_keren_crisis", "pose_keren_hurt", "pose_keren_ko", "pose_keren_sleep", "pose_keren_walkdl", "pose_keren_walkul", "pose_keren_walkd", "pose_keren_standd", "pose_keren_standul"],
  blanche: ["blanche", "pose_blanche_crisis", "pose_blanche_hurt", "pose_blanche_ko", "pose_blanche_sleep", "pose_blanche_walkdl", "pose_blanche_walkul", "pose_blanche_walkd", "pose_blanche_standd", "pose_blanche_standul"],
};
// drawn size of a sprite in a 1x1 token box ("contain"), times the texture scale
const boxSize = (nw, nh, sc) => { const k = Math.min(GRID / nw, GRID / nh) * sc; return { w: nw * k, h: nh * k }; };
for (const [id, a] of Object.entries(ACT)) {
  const el = document.createElement("div"); el.className = "actor";
  const body = document.createElement("div"); body.className = "body";
  const src = M.sprites[id]; const vid = isVideo(src);
  const m = document.createElement(vid ? "video" : "img");
  if (vid) { m.muted = true; m.loop = true; m.autoplay = true; m.playsInline = true; }
  m.className = "media"; m.src = src;
  Object.assign(a, { id, el, body, media: m, src, dx: 0, dy: 0, rot: 0, flip: a.kind === "enemy" ? -1 : 1, baseFlip: a.kind === "enemy" ? -1 : 1, hb: 160, wb: 80, lift: 0 });
  a.x = a.cx; a.y = a.cy + 84;
  const size = () => { if (a.noResize) return; const mm = a.media; const nw = mm.videoWidth || mm.naturalWidth, nh = mm.videoHeight || mm.naturalHeight; if (!nw) return; const b = a.pxK ? { w: nw * a.pxK, h: nh * a.pxK } : boxSize(nw, nh, a.sc);
    a.wb = b.w; a.hb = b.h; a.y = a.cy + b.h / 2; a.s = tokenScaleAt(a.y); mm.style.width = b.w + "px"; mm.style.height = b.h + "px"; el.style.left = a.x + "px"; el.style.top = a.y + "px"; el.style.zIndex = Math.round(a.y); setPos(a, a.dx, a.dy); };
  a.resize = size; m.addEventListener("loadedmetadata", size); m.addEventListener("load", size); if (vid) m.play().catch(() => {});
  body.appendChild(m); el.appendChild(body); $("factors").appendChild(el);
  a.s = tokenScaleAt(a.y); el.style.left = a.x + "px"; el.style.top = a.y + "px";
  setPos(a, 0, 0);
}
const PARTY = ["hina", "zarg", "keren", "blanche"].map((k) => ACT[k]);
let ENEMIES = [];
// ───────── host roles (the same names the game runtime gives a move). The page says who acts with
// window.MOVE_ROLES = { caster: () => ACT[WIELD], target: (i) => ACT.orc, result: (t) => null | { hit, crit, total, fumble } }.
// result() is the GAME's real outcome; on a page it is normally null, so a move falls back to its own sliders / rolls.
const MOVE_ROLES = () => window.MOVE_ROLES || {};
const moveCaster = () => (MOVE_ROLES().caster ? MOVE_ROLES().caster() : PARTY[0]);
const moveTarget = (i = 0) => (MOVE_ROLES().target ? MOVE_ROLES().target(i) : ENEMIES[i] || ENEMIES[0] || null);
const moveResult = (t) => (MOVE_ROLES().result ? MOVE_ROLES().result(t) : null);
const moveStrikes = (t) => (MOVE_ROLES().strikes ? MOVE_ROLES().strikes(t) : []);
// the page's result picker (mockup/result-picker.js): { check: "odd" | "crit" | …, chain: "all" | 0.75 | … } or null = the move's sliders
const movePick = () => window.MOVE_PICK || null;
const moveVariant = () => (MOVE_ROLES().variant ? MOVE_ROLES().variant() : null);
// the boss's side of the field for the chosen fight: who stands, where (cx, cy = token centre on the stage)
function setLineup(list) {
  for (const a of Object.values(ACT)) if (a.kind === "enemy") { a.on = false; a.el.style.display = "none"; }
  ENEMIES = list.map(([id, cx, cy]) => { const a = ACT[id]; a.on = true; a.el.style.display = ""; a.cx = cx; a.cy = cy; a.x = cx; a.y = cy + a.hb / 2; a.s = tokenScaleAt(a.y);
    a.el.style.left = a.x + "px"; a.el.style.top = a.y + "px"; a.el.style.zIndex = Math.round(a.y); a.resize(); setPos(a, 0, 0); return a; });
}
// swap a battler's art the way the pose system does: the new art keeps the idle art's PIXEL size, bottom-centre aligned
function swapArt(a, src) { const mm = a.media; const nw = mm.videoWidth || mm.naturalWidth, nh = mm.videoHeight || mm.naturalHeight;
  if (nw && !a.pxK) a.pxK = boxSize(nw, nh, a.sc).w / nw;
  const vid = isVideo(src); const n = document.createElement(vid ? "video" : "img"); if (vid) { n.muted = true; n.loop = true; n.autoplay = true; n.playsInline = true; }
  n.className = "media"; n.style.filter = mm.style.filter; n.addEventListener("loadedmetadata", a.resize); n.addEventListener("load", a.resize); n.src = src; mm.replaceWith(n); a.media = n; if (vid) n.play().catch(() => {}); }
function restoreArt(a) { if (a.media.getAttribute("src") === a.src && !a.pxK) return; a.pxK = null; swapArt(a, a.src); a.pxK = null; }
// a flat copy of a battler on the screen layer (impact frames)
function silhouette(a) { const p = FCAM.screen(feet(a)); const h = hgt(a) * FCAM.z; const s = sprite(a.media.getAttribute("src"), $("screen"), { x: p.x, y: p.y + 4 * FCAM.z, h, z: 33 }); return s.el; }
function setPos(a, dx, dy = a.dy, bob = 0) { a.dx = dx; a.dy = dy;
  a.body.style.transform = `translate(${dx}px, ${dy + bob - (a.lift || 0)}px) rotate(${a.rot}deg) scale(${a.s * a.flip * (a.kx ?? 1)}, ${a.s * (a.ky ?? 1)})`; }
const hgt = (a) => a.hb * a.s, wid = (a) => a.wb * a.s;
const OX = (a) => a.x + a.dx, OY = (a) => a.y + a.dy;
const center = (a) => ({ x: OX(a), y: OY(a) - hgt(a) * .5 });
const feet = (a) => ({ x: OX(a), y: OY(a) - 4 });
const head = (a) => ({ x: OX(a), y: OY(a) - hgt(a) * .92 });
const face = (a) => a.kind === "party" ? -1 : 1;
async function slide(a, dx, ms = 420, dy = a.dy, ease = EASE.quad) { const x0 = a.dx, y0 = a.dy; await tween(ms, ease, (t) => setPos(a, lerp(x0, dx, t), lerp(y0, dy, t))); }
const stepOut = (a, d = 40) => slide(a, face(a) * d, 380);
const stepBack = (a) => slide(a, 0, 460, 0);
function flashActor(a, color = "#fff", ms = 260) { const m = a.media; return tween(ms, EASE.out, (t) => { m.style.filter = `drop-shadow(0 0 ${14*(1-t)}px ${color}) brightness(${1 + 1.3*(1-t)})`; }).then(() => m.style.filter = ""); }
async function hurt(a, color) { flashActor(a, color).catch(() => {}); const d = -face(a); await tween(300, EASE.lin, (t) => setPos(a, d * Math.sin(t * Math.PI * 4) * 7 * (1 - t), a.dy)); setPos(a, 0, a.dy); }
function pop(pt, text, cls = "") { if (FAST) return; const n = document.createElement("div"); n.className = "num " + cls; n.textContent = text;
  n.style.left = pt.x + "px"; n.style.top = pt.y + "px"; $("ffx").appendChild(n);
  tween(1200, EASE.out, (t) => { n.style.top = (pt.y - 40 * t) + "px"; n.style.opacity = t > .7 ? (1 - (t - .7) / .3) : 1; }).catch(() => {}).then(() => n.remove()); }

// free a removed video element's decoder right away (Chrome caps live decoders; removed-but-unreleased ones pile up)
function releaseVideos(root) { const list = root.tagName === "VIDEO" ? [root] : [...root.querySelectorAll("video")]; for (const v of list) { try { v.pause(); v.removeAttribute("src"); v.load(); } catch (e) {} } }
// ───────── Generic sprite (dimension copies, props). Anchored at feet. h = drawn height px.
function sprite(src, parent, { x = 0, y = 0, h = 170, flip = 1, filter = "", opacity = 1, z = 1, blend = "" } = {}) {
  const el = document.createElement("div"); el.className = "spr";
  const vid = isVideo(src); const m = document.createElement(vid ? "video" : "img"); m.className = "m"; m.src = src;
  if (vid) { m.muted = true; m.loop = true; m.autoplay = true; m.playsInline = true; m.play().catch(() => {}); }
  el.appendChild(m); parent.appendChild(el);
  const o = { el, m, x, y, h, w: h * .6, flip, rot: 0, sx: 1, sy: 1, opacity, ox: 0, oy: 0, z };
  const fit = () => { const mm = o.m; const nw = mm.videoWidth || mm.naturalWidth, nh = mm.videoHeight || mm.naturalHeight; if (nw) { o.ar = nw / nh; o.apply(); } };
  m.addEventListener("loadedmetadata", fit); m.addEventListener("load", fit);
  o.apply = () => { if (o.ar) o.w = o.h * o.ar; el.style.width = o.w + "px"; el.style.height = o.h + "px"; el.style.left = (o.x - o.w / 2) + "px"; el.style.top = (o.y - o.h) + "px";
    el.style.opacity = o.opacity; el.style.zIndex = o.z;
    el.style.transform = `translate(${o.ox}px, ${o.oy}px) rotate(${o.rot}deg) scale(${o.sx * o.flip}, ${o.sy})`; };
  if (filter) m.style.filter = filter; if (blend) el.style.mixBlendMode = blend;
  o.set = (p) => { Object.assign(o, p); o.apply(); return o; };
  o.swap = (src2) => { const v2 = isVideo(src2); if (v2 === (o.m.tagName === "VIDEO")) { o.m.src = src2; if (v2) o.m.play().catch(() => {}); return; }
    const n = document.createElement(v2 ? "video" : "img"); n.className = "m"; if (v2) { n.muted = true; n.loop = true; n.autoplay = true; n.playsInline = true; }
    n.style.filter = o.m.style.filter; n.addEventListener("loadedmetadata", fit); n.addEventListener("load", fit); n.src = src2; o.m.replaceWith(n); o.m = n; if (v2) n.play().catch(() => {}); };
  o.move = (x2, y2, ms, ease = EASE.quad, hop = 0, steps = 1) => { const x0 = o.x, y0 = o.y;
    return tween(ms, ease, (t) => { o.x = lerp(x0, x2, t); o.y = lerp(y0, y2, t); o.oy = -Math.abs(Math.sin(t * Math.PI * steps)) * hop; o.apply(); }); };
  o.fade = (to, ms) => { const f = o.opacity; return tween(ms, EASE.sine, (t) => { o.opacity = lerp(f, to, t); o.apply(); }); };
  o.headPt = () => ({ x: o.x, y: o.y - o.h * .86 }); o.mid = () => ({ x: o.x, y: o.y - o.h * .5 });
  o.remove = () => { releaseVideos(el); el.remove(); };
  o.apply(); return o;
}
// a copy of a battler for another scene; same in-game size rule, scaled by depth where it stands
function battlerCopy(a, parent, x, y, opt = {}) { const h = a.hb * (opt.P ? tokenScaleAt(y, opt.P) : 1) * (opt.scale || 1); return sprite(opt.src || a.src, parent, { x, y, h, flip: opt.flip ?? 1, ...opt }); }

// ───────── Effect clips. Sizes follow the game's MV/RO tables, relative to a 170 px battler.
const CLIPS = [];
function clip(key, pt, { scale = 1, filter = "", blend = "", rate = 1, flip = false, rot = 0, opacity = 1, parent = $("ffx"), loop = false, z = 0, sy = 1 } = {}) {
  const c = M.clips[key];
  if (!FAST) traceEv("clip", { key, at2: tracePt(pt), scale: Math.round(scale * 1000) / 1000, rate, ...(filter ? { filter } : {}), ...(flip ? { flip } : {}), ...(rot ? { rot } : {}), ...(loop ? { loop } : {}), ...(c ? {} : { missing: true }) });
  const dummy = { done: Promise.resolve(), impact: Promise.resolve(), el: null, stop() { return Promise.resolve(); } };
  if (FAST || !c) return dummy;
  const v = document.createElement("video"); v.muted = true; v.playsInline = true; v.src = c.src; v.loop = loop;
  const k = scale * (c.ro ? 1.1 : .55); const w = c.w * k, h = c.h * k;
  Object.assign(v.style, { left: (pt.x - w * c.ax) + "px", top: (pt.y - h * c.ay) + "px", width: w + "px", height: h + "px", opacity, zIndex: z, pointerEvents: "none", transformOrigin: `${c.ax*100}% ${c.ay*100}%` });
  const tf = []; if (flip) tf.push("scaleX(-1)"); if (rot) tf.push(`rotate(${rot}deg)`); if (sy !== 1) tf.push(`scaleY(${sy})`); if (tf.length) v.style.transform = tf.join(" ");
  if (filter) v.style.filter = filter; if (blend) v.style.mixBlendMode = blend;
  parent.appendChild(v); v.playbackRate = SPEED * rate; v.play().catch(() => {}); CLIPS.push(v);
  const done = loop ? new Promise(() => {}) : new Promise((r) => { v.onended = r; setTimeout(r, c.dur / (SPEED * rate) + 900); }).then(() => { releaseVideos(v); v.remove(); });
  const impact = wait((c.impact ?? c.dur * .4) / rate);
  return { done, impact, el: v, stop: (ms = 300) => tween(ms, EASE.sine, (t) => v.style.opacity = opacity * (1 - t)).catch(() => {}).then(() => { releaseVideos(v); v.remove(); }) };
}

// ───────── Screen effects
function flash(color = "#fff", peak = 1, inMs = 40, outMs = 160) { traceEv("flash", { color, peak, inMs, outMs }); const f = $("flash"); f.style.background = color;
  return tween(inMs, EASE.lin, (t) => f.style.opacity = peak * t).then(() => tween(outMs, EASE.out, (t) => f.style.opacity = peak * (1 - t))); }
const whiteTo = (o, ms, ease = EASE.sine) => { traceEv("white", { to: o, ms }); const f = $("flash"); f.style.background = "#fff"; const s = +f.style.opacity || 0; return tween(ms, ease, (t) => f.style.opacity = lerp(s, o, t)); };
const blackTo = (o, ms) => { traceEv("black", { to: o, ms }); const b = $("black"); const s = +b.style.opacity || 0; return tween(ms, EASE.sine, (t) => b.style.opacity = lerp(s, o, t)); };
const fdim = (o, ms = 500, color = "#000") => { traceEv("dim", { to: o, ms, color }); const d = $("fdim"); d.style.background = color; const s = +d.style.opacity || 0; return tween(ms, EASE.sine, (t) => d.style.opacity = lerp(s, o, t)); };
const vignette = (o, ms) => { const v = $("vig"); const s = +v.style.opacity || 0; return tween(ms, EASE.sine, (t) => v.style.opacity = lerp(s, o, t)); };
let SHAKE = 0;
function shake(px = 10, ms = 320) { traceEv("shake", { px, ms }); const s = $("shake"); return tween(ms, EASE.lin, (t) => { const k = (1 - t) * px; s.style.transform = `translate(${(Math.random()*2-1)*k}px, ${(Math.random()*2-1)*k}px)`; }).then(() => s.style.transform = ""); }
function rumble(on, px = 3) { traceEv("rumble", { on: !!on, px }); SHAKE = on ? px : 0; if (!on) $("shake").style.transform = ""; }
function markGate() { traceEv("gate"); GATE_AT = performance.now() - T0; const g = $("gate"); g.style.opacity = 1; setTimeout(() => g.style.opacity = 0, 1600); renderMeta(); }
// the game's universal buff beat (action-anim-rules BEAT.buff): MV 051_powerup_1 at the feet + Soundboard/Powerup.ogg
function buffBeat(a) { clip("051_powerup_1", feet(a), { scale: tokenScaleAt(OY(a)) }); sfx("powerup", .35 / .75); }

// Zero Power cut-in, exactly as the shipped scripts build it (createCutin / runCutin): a full-body image
// 92vh tall on the bottom edge, left -120% → 0 (ease-out 650 ms), hold 850 ms, → 120% (ease-in 650 ms).
async function cutin(src, { slideIn = 650, hold = 850, slideOut = 650, pixel = false } = {}) {
  if (FAST) return;
  sfx("overdrive", .9);
  const img = document.createElement("img"); img.src = src; if (pixel) img.style.imageRendering = "pixelated";
  Object.assign(img.style, { bottom: "0", height: (H * .92) + "px", width: "auto", left: (-1.2 * W) + "px", zIndex: 25 });
  $("screen").appendChild(img);
  await tween(slideIn, EASE.cssOut, (t) => img.style.left = lerp(-1.2 * W, 0, t) + "px");
  await wait(hold);
  await tween(slideOut, EASE.cssIn, (t) => img.style.left = lerp(0, 1.2 * W, t) + "px");
  img.remove();
}

// ───────── Particles: one canvas per layer, drawn in that layer's coordinates.
// "hit": field coordinates like "field", but stacked ABOVE the battlers and fists (hit sparks must read on top of the body)
{ const f = $("fparts"), h = f.cloneNode(); h.id = "hparts"; h.style.zIndex = "4500"; h.style.pointerEvents = "none"; $("field").appendChild(h); }
{ const g = document.createElement("canvas"); g.id = "gparts"; g.className = "parts"; g.width = W; g.height = H; g.style.position = "absolute"; g.style.left = "0"; g.style.top = "0"; g.style.pointerEvents = "none"; $("fground").appendChild(g); }
const PARTS = { field: [], dim: [], screen: [], hit: [], ground: [] };
const CTX = { field: $("fparts").getContext("2d"), dim: $("dparts").getContext("2d"), screen: $("sparts").getContext("2d"), hit: $("hparts").getContext("2d"), ground: $("gparts").getContext("2d") };
function addP(layer, p) { if (!FAST) PARTS[layer].push(Object.assign({ t: 0, life: 1000, vx: 0, vy: 0, g: 0, drag: 1 }, p)); }
let LAST = performance.now();
function frame(now) {
  const dt = Math.min(50, now - LAST) * SPEED; LAST = now;
  for (const L of ["ground", "field", "dim", "screen", "hit"]) {
    const c = CTX[L]; c.clearRect(0, 0, W, H); c.globalCompositeOperation = "lighter";
    const arr = PARTS[L];
    for (let i = arr.length - 1; i >= 0; i--) { const p = arr[i]; p.t += dt;
      if (p.t >= p.life || p.dead) { arr.splice(i, 1); p.onDie && p.onDie(p); continue; }
      if (p.update) p.update(p, dt); else { p.vy += p.g * dt; p.vx *= Math.pow(p.drag, dt / 16); p.vy *= Math.pow(p.drag, dt / 16); p.x += p.vx * dt; p.y += p.vy * dt; }
      c.save(); c.globalCompositeOperation = p.comp || "lighter"; p.draw(c, p, p.t / p.life); c.restore(); }
  }
  if (SHAKE) $("shake").style.transform = `translate(${rndFx(-SHAKE, SHAKE)}px, ${rndFx(-SHAKE, SHAKE)}px)`;
  FIELD3D.orbit = SWAY; DIM3D.orbit = SWAY; FIELD3D.draw(now); DIM3D.draw(now);
  requestAnimationFrame(frame);
}
let SWAY = true;
requestAnimationFrame(frame);

const OPT = { stance: "vajra", slapPair: "kz", spin: "auto", breakBy: "aoe", stacks: [5, 2] };
const SK = {};
let CUR = "slap", GATE_AT = null, T0 = 0, BEAT = -1;

// ═════════ In-game hit feedback, ported from the battle director:
// damage numbers (director-damage-numbers.js + damage-number-style.js), the hit counter (hit-counter.js),
// and the hurt reaction (battler-pose.js playHurtPoseLocal: hurt art + full flinch; director-hurt-reaction.js: the flinch alone).
const TIMERS = [];
const DN_COLOR = { physical: "#ffffff", fire: "#e25822", ice: "#5ab3d4", air: "#48c774", earth: "#b5793f", bolt: "#b06cc9", light: "#d4bb5f", dark: "#8c6cff", poison: "#3fae6c" };
const DN_LIFE = 1150, DN_STAGGER = 120, DN_CASCADE = [[-42, -54], [-14, -36], [14, -18], [42, 0]];
{ const st = document.createElement("style"); st.textContent = `
#dnl { position: absolute; left: 0; top: 0; width: ${W}px; height: ${H}px; pointer-events: none; z-index: 60; overflow: hidden; }
.dn { position: absolute; transform: translate(-50%, -50%); --dn-num-font: 'Arial Black', 'Segoe UI', system-ui, Arial, sans-serif; }
.dn-riser { animation: dn-rise ${DN_LIFE}ms cubic-bezier(.18,.7,.3,1) forwards, dn-fade ${DN_LIFE}ms ease-in forwards; }
.dn-inner { position: relative; display: flex; flex-direction: column; align-items: center; gap: 2px; animation: dn-pop 240ms cubic-bezier(.2,1.55,.4,1) both; }
.dn-num { display: inline-flex; align-items: center; font-family: var(--dn-num-font); font-weight: 900; font-style: italic; line-height: 1; color: var(--dn-color, #fff); font-size: var(--dn-size, 34px);
  transform: skewX(-8deg); -webkit-text-stroke: 2.5px #1a1a1a; text-shadow: 0 3px 0 rgba(0,0,0,.55), 0 0 10px rgba(0,0,0,.3); }
@keyframes dn-rise { 0% { transform: translateY(10px); } 16% { transform: translateY(0); } 100% { transform: translateY(-54px); } }
@keyframes dn-fade { 0%, 68% { opacity: 1; } 100% { opacity: 0; } }
@keyframes dn-pop { 0% { transform: scale(.25); } 62% { transform: scale(1.16); } 100% { transform: scale(1); } }
#hc { position: absolute; right: 18px; top: 26%; display: flex; flex-direction: column; align-items: flex-end; opacity: 0; transform: translateX(18px);
  transition: opacity 220ms ease-out, transform 260ms cubic-bezier(.2,.9,.3,1); font-family: "Arial Black", "Segoe UI Black", "Helvetica Neue", Arial, sans-serif; --hc-tag: #7fc4ff; }
#hc.on { opacity: 1; transform: translateX(0); }
#hc.out { opacity: 0; transition: opacity 420ms ease-in; }
#hc .row { display: flex; align-items: baseline; gap: 7px; }
#hc .hits b { font-style: italic; font-weight: 900; font-size: 50px; line-height: .95; color: #fff; -webkit-text-stroke: 2px #101622; paint-order: stroke fill; text-shadow: 0 3px 0 rgba(0,0,0,.55); display: inline-block; }
#hc i { font-style: normal; letter-spacing: 2px; font-family: "Bebas Neue", "Anton", "Haettenschweiler", Impact, "Arial Narrow", sans-serif; }
#hc .hits i { font-size: 28px; color: var(--hc-tag); text-shadow: 0 2px 0 rgba(0,0,0,.7); }
#hc .dmg b { font-style: italic; font-weight: 900; font-size: 22px; color: #ffe8a8; white-space: nowrap; -webkit-text-stroke: 1.5px #2a1b06; paint-order: stroke fill; display: inline-block; }
#hc .dmg i { font-size: 16px; color: #ffcf8a; text-shadow: 0 2px 0 rgba(0,0,0,.7); }
#hc .punch { animation: hc-punch 200ms ease-out; }
@keyframes hc-punch { 0% { transform: scale(1.25); } 100% { transform: scale(1); } }`; document.head.appendChild(st); }
const DNL = document.createElement("div"); DNL.id = "dnl";
DNL.innerHTML = `<div id="hc"><div class="row hits"><b>0</b><i>HIT</i></div><div class="row dmg"><b>0</b><i>DAMAGE</i></div></div>`;
$("view").appendChild(DNL);
// hit counter: shown from the 2nd hit, held 1.6 s after the last one, then it fades
const HC = { hits: 0, dmg: 0, t: 0 };
function hcReset() { HC.hits = 0; HC.dmg = 0; clearTimeout(HC.t); $("hc").className = ""; }
function hcAdd(n) { HC.hits++; HC.dmg += n; if (HC.hits < 2) return; const el = $("hc"); el.className = "on";
  const hb = el.querySelector(".hits b"); hb.textContent = HC.hits; el.querySelector(".dmg b").textContent = HC.dmg;
  hb.classList.remove("punch"); void hb.offsetWidth; hb.classList.add("punch");
  clearTimeout(HC.t); HC.t = setTimeout(() => { el.className = "on out"; }, 1600 / SPEED); }
// one floating number. key = who was hit (numbers on one target stagger 120 ms), at() = its screen point at spawn,
// cascade = the tick's index, stepping each one down-right of the last like a Chain tick
const DN_SLOT = new Map();
function dmgNum(key, at, amount, { element = "physical", cascade = 0, prefix = "" } = {}) {
  if (!FAST) traceEv("num", { who: key, amount, element, ...(cascade ? { cascade } : {}) });
  if (FAST || amount <= 0) return; const now = performance.now(); const slot = Math.max(now, DN_SLOT.get(key) ?? 0); DN_SLOT.set(key, slot + DN_STAGGER / SPEED);
  const step = cascade > 0 ? DN_CASCADE[(cascade - 1) % DN_CASCADE.length] : null; const jx = step ? step[0] : Math.round((Math.random() - .5) * 26), oy = step ? step[1] : 0;
  const rid = RUN;
  setTimeout(() => { if (rid !== RUN) return; const p = at(); const root = document.createElement("div"); root.className = "dn"; root.style.left = (p.x + jx) + "px"; root.style.top = (p.y + oy) + "px";
    root.innerHTML = `<div class="dn-riser"><div class="dn-inner"><div class="dn-num" style="--dn-color:${DN_COLOR[element] || "#fff"};--dn-size:${Math.round(30 + Math.min(26, amount / 7))}px">${prefix}${amount}</div></div></div>`;
    DNL.appendChild(root); if (!["mp", "ip", "heal", "self"].includes(element)) hcAdd(amount); setTimeout(() => root.remove(), DN_LIFE + 60); }, slot - now);
}
// where the game floats a number: a little above the body's centre
const numAt = (a) => () => FCAM.screen({ x: OX(a), y: OY(a) - hgt(a) * .5 - GRID * a.s * .22 });
const hurtArt = (id) => (id && M.sprites["pose_" + id + "_hurt"]) || null;
// the game's hurt reaction on whoever got hit (a field battler, or a copy made with actorId): its hurt art plays once with the
// flinch on top; with no hurt art, the flinch alone (white flash, squash, shake)
function hitReact(t, tier = "normal") {
  if (FAST) return; const m = t.media || t.m; if (!m) return; const spec = FLINCH[tier] || FLINCH.normal;
  const art = hurtArt(t.actorId || (t.media ? t.id : null)), idle = t.src || t.idle;
  if (art && idle && m.tagName === "VIDEO" && !t.hurtHold) { clearTimeout(t.hurtT); if (m.getAttribute("src") !== art) { m.loop = false; m.src = art; m.play().catch(() => {}); }
    t.hurtT = setTimeout(() => { m.src = idle; m.loop = true; m.play().catch(() => {}); }, 900 / SPEED); }
  if (m._fl) m._fl.stop();
  const base = m.style.filter, base2 = base || (t.media ? "drop-shadow(0 4px 3px rgba(0,0,0,.35))" : ""), tf0 = m.style.transform; m.style.transformOrigin = "50% 100%";
  const t0 = performance.now(); let done = false; const rid = RUN;
  const stop = () => { if (done) return; done = true; m.style.transform = tf0; m.style.filter = base; m._fl = null; };
  m._fl = { stop };
  const step = (now) => { if (done) return; if (rid !== RUN) return stop(); const u = (now - t0) * SPEED / spec.ms; if (u >= 1) return stop();
    m.style.transform = `translateX(${stopAt(spec.move, u, 3)}px) scale(${stopAt(spec.move, u, 1)}, ${stopAt(spec.move, u, 2)})`; m.style.filter = `${base2} brightness(${stopAt(spec.bright, u, 1)})`; requestAnimationFrame(step); };
  requestAnimationFrame(step);
}
// only the caster and the targets stay on the field for the cast; the others fade out and come back at the end
function castFocus(keep, ms = 350) { return Promise.all(Object.values(ACT).filter((a) => !keep.includes(a.id)).map((a) => { a.faded = true; return tween(ms, EASE.sine, (t) => a.el.style.opacity = 1 - t); })); }
function castUnfocus(ms = 500) { return Promise.all(Object.values(ACT).filter((a) => a.faded).map((a) => { a.faded = false; return tween(ms, EASE.sine, (t) => a.el.style.opacity = t); })); }
// a fire portal on the floor: a dark hole with a burning rim, flames licking up out of it
function groundPortal(layer, groundEl, pt, s = 1, { rx = 78, ry = 24, rgb = "255,110,40", hot = "255,220,140" } = {}) {
  const hole = document.createElement("div"); const w = rx * 2 * s, h = ry * 2 * s;
  Object.assign(hole.style, { position: "absolute", left: (pt.x - w / 2) + "px", top: (pt.y - h / 2) + "px", width: w + "px", height: h + "px", borderRadius: "50%",
    background: `radial-gradient(ellipse at 50% 50%, #000 0%, #0d0106 48%, rgba(${rgb},.85) 78%, rgba(${rgb},0) 100%)`,
    boxShadow: `0 0 ${18 * s}px ${5 * s}px rgba(${rgb},.7), inset 0 0 ${10 * s}px rgba(${hot},.6)`, transform: "scale(0)" });
  groundEl.appendChild(hole);
  const o = { open: true };
  tween(260, EASE.outBack, (t) => hole.style.transform = `scale(${t})`).catch(() => {});
  const iv = setInterval(() => { if (!o.open || FAST) return; for (let i = 0; i < 3; i++) { const a = rndFx(0, Math.PI * 2); const x = pt.x + Math.cos(a) * rx * s * .92, y = pt.y + Math.sin(a) * ry * s * .92;
    addP(layer, { x, y, vx: rndFx(-.02, .02), vy: rndFx(-.24, -.1) * s, life: rndFx(350, 700), r: rndFx(5, 11) * s, draw: (c, p, t) => { glow(c, p.x, p.y, p.r * (1.7 - t), t < .3 ? hot : rgb, (1 - t) * .9); } }); } }, 40);
  TIMERS.push(iv);
  o.close = (ms = 320) => { o.open = false; clearInterval(iv); return tween(ms, EASE.in, (t) => hole.style.transform = `scale(${1 - t})`).catch(() => {}).then(() => hole.remove()); };
  return o;
}

// an anime impact frame: black with the targets in white and a burst of lines, then white with them in black, then the hit
async function impactFrame(targets, ms = 70) {
  if (FAST) return; const box = document.createElement("div"); Object.assign(box.style, { inset: 0, zIndex: 32, background: "#000" });
  const cv = document.createElement("canvas"); cv.width = W; cv.height = H; Object.assign(cv.style, { position: "absolute", left: 0, top: 0, width: W + "px", height: H + "px" }); box.appendChild(cv); $("screen").appendChild(box);
  const cen = targets.reduce((a, t) => { const p = FCAM.screen(center(t)); return { x: a.x + p.x / targets.length, y: a.y + p.y / targets.length }; }, { x: 0, y: 0 });
  const burst = (col) => { const c = cv.getContext("2d"); c.clearRect(0, 0, W, H); c.fillStyle = col; for (let i = 0; i < 46; i++) { const a = rnd(0, Math.PI * 2), w = rnd(.006, .03), r0 = rnd(90, 220);
    c.beginPath(); c.moveTo(cen.x + Math.cos(a) * r0, cen.y + Math.sin(a) * r0); c.lineTo(cen.x + Math.cos(a - w) * 1900, cen.y + Math.sin(a - w) * 1900); c.lineTo(cen.x + Math.cos(a + w) * 1900, cen.y + Math.sin(a + w) * 1900); c.fill(); } };
  const sil = targets.map((a) => { const s = silhouette(a); s.style.zIndex = 33; return s; });
  burst("#fff"); sil.forEach((s) => s.style.filter = "brightness(0) invert(1)"); await wait(ms);
  box.style.background = "#fff"; burst("#000"); sil.forEach((s) => s.style.filter = "brightness(0)"); await wait(ms);
  box.remove(); sil.forEach((s) => s.remove());
}
