// Battler poses — per-state sprite art for battle tokens (hurt, KO, crisis,
// guard, attack, cast).
//
// Runs on EVERY client and only ever changes what THIS client draws: the pose
// art is laid on the token's mesh locally, the same way the walk sprites are
// (map-system/sprite-facing-runtime.js). Nothing is written to the token, so
// there is nothing to sync and a reload lands on the right pose by itself.
//
//   lasting poses  come from the actor's markers (KO, Guard, Crisis effects),
//                  which every client already has.
//   one-shots      hurt rides the existing hurt-reaction broadcast;
//                  attack / cast are broadcast by the GM when an action's
//                  animation starts (emitBattlerPose).
//
// Fallback: a pose with no art on the sheet (or art that fails to load) shows
// the token's own image, i.e. exactly what the game did before. Rules and the
// fallback chain live in battler-pose-rules.js.
//
// Each token gets its OWN <video> per clip: Foundry shares one video per URL,
// so two Porings hit separately would otherwise both flinch.
//
// Scope: tokens the director spawned for a battle (flag directorSpawned).

import { log, warn } from "./logger.js";
import { registerAnimation } from "./director-surfaces.js";
import {
  ONE_SHOT, HOLD, LOOPING, poseSrc, declaredPoseSrcs, lastingPose, shownPose,
  statePoseSrc, poseScaleFix, poseAnchor,
} from "./battler-pose-rules.js";

const MODULE_ID = "fabula-ultima-companion";
const FLAG_DIRECTOR_SPAWNED = "directorSpawned";
const ACTION_PLAY = "FU_BATTLER_POSE_PLAY";
const VIDEO_RE = /\.(webm|mp4|m4v|ogv)(\?|#|$)/i;

// A one-shot whose clip length is unknown (still image, metadata missing)
// shows for this long. Clips longer than the cap are cut off there, so a bad
// file can never pin a token in a pose.
const STILL_MS = 450;
const MAX_ONE_SHOT_MS = 4000;
// Strip art (frames side by side) has no timing of its own.
const STRIP_FRAME_MS = 100;
// How long a one-shot waits for its art to finish loading before giving up
// (the fallback then stands in). Art is preloaded when the token is drawn, so
// this only matters on a cold cache.
const ONE_SHOT_LOAD_WAIT_MS = 250;
// Hurt-with-art shake (the art itself is the reaction; this adds the impact).
const SHAKE_MS = { normal: 260, strong: 420 };
const SHAKE_PX = { normal: 4, strong: 8 };
// After a hurt clip on a hit that took HP to 0: how long to hold its last
// frame waiting for the KO to take over before standing back up.
const LETHAL_HURT_HOLD_MS = 1500;
const STRONG_TINT = 0xff7a7a;

let _socket = null;
let _installed = false;

// tokenId -> entry; reset with the canvas.
//   entry = { lasting, oneShot: { pose, timer, hold } | null, shown, applied, shake }
const _tokens = new Map();
// `${tokenId}|${src}` -> art; each token owns its clips (see header).
//   art = { src, kind: "video"|"image"|"strip", texture, video, frames,
//           ready, failed, waiters: [] }
const _arts = new Map();
const _failedSrcs = new Set();
let _stripTicker = null;

// Debug trace (off by default): globalThis.ONI_BATTLER_POSE_DEBUG = true, then
// read globalThis.__battlerPoseTrace — every pose decision with its reason.
function trace(token, what, extra = {}) {
  if (!globalThis.ONI_BATTLER_POSE_DEBUG) return;
  const buf = (globalThis.__battlerPoseTrace ??= []);
  const e = _tokens.get(token?.id);
  buf.push({ t: Math.round(performance.now()), token: token?.name, what, lasting: e?.lasting, oneShot: e?.oneShot?.pose ?? null, ...extra });
  if (buf.length > 400) buf.splice(0, buf.length - 400);
}

// ── boot ────────────────────────────────────────────────────────────────
export function initBattlerPose() {
  if (_installed) return;
  _installed = true;
  globalThis.__ONI_BATTLER_POSE__ = { afterBaseResize };
  try {
    if (typeof socketlib !== "undefined" && game.modules.get("socketlib")?.active) {
      _socket = socketlib.registerModule(MODULE_ID);
      _socket.register(ACTION_PLAY, (payload) => playBattlerPoseLocal(payload));
    } else {
      warn("battler-pose: socketlib unavailable — attack/cast poses stay local-only");
    }
  } catch (e) { warn("battler-pose: socket init failed", e); }

  Hooks.on("drawToken", (token) => { try { onTokenDrawn(token); } catch (e) { warn("battler-pose: drawToken", e); } });
  Hooks.on("refreshToken", (token, flags) => { try { onTokenRefreshed(token, flags); } catch (e) { warn("battler-pose: refreshToken", e); } });
  Hooks.on("destroyToken", (token) => { try { forgetToken(token?.id); } catch {} });
  Hooks.on("canvasTearDown", () => { try { forgetAll(); } catch {} });
  for (const h of ["createActiveEffect", "updateActiveEffect", "deleteActiveEffect"]) {
    Hooks.on(h, (effect) => { try { onEffectChanged(effect); } catch (e) { warn(`battler-pose: ${h}`, e); } });
  }
  // Art on the sheet edited mid-battle: reload it.
  Hooks.on("updateActor", (actor, change) => {
    try {
      const props = change?.system?.props;
      if (!props || !Object.keys(props).some((k) => k.startsWith("sprite_"))) return;
      for (const t of tokensOfActor(actor)) { dropArtsFor(t.id); onTokenDrawn(t); }
    } catch (e) { warn("battler-pose: updateActor", e); }
  });

  // Tokens already on the canvas (hot reload / ready after canvasReady).
  try { for (const t of canvas?.tokens?.placeables ?? []) onTokenDrawn(t); } catch {}
  log("battler-pose: installed");
}

// ── public: GM-side broadcast of a one-shot (attack / cast / ko) ─────────
export function emitBattlerPose(payload = {}) {
  try { playBattlerPoseLocal(payload); }
  catch (e) { warn("emitBattlerPose: local play threw", e); }
  try { _socket?.executeForOthers?.(ACTION_PLAY, payload); }
  catch (e) { warn("emitBattlerPose: broadcast failed", e); }
}

// Play a one-shot pose on this client. { tokenUuid, pose, hold? }
export function playBattlerPoseLocal({ tokenUuid, pose, hold = false } = {}) {
  const token = tokenFromUuid(tokenUuid);
  if (!token || !inScope(token)) return 0;
  if (!ONE_SHOT.has(pose) && !HOLD.has(pose)) return 0;
  if (!hold && globalThis.FUCompanion?.api?.vfxSuppressed?.()) return 0;
  return startOneShot(token, pose, { hold: hold || HOLD.has(pose) });
}

// Hurt with art: called by the hurt reaction on every client. Returns true
// when this token has hurt art ready and the pose system took the hit (the
// hurt reaction then skips its image-copy flinch); false = use the old flinch.
export function playHurtPoseLocal(tokenUuid, intensity = "normal") {
  const token = tokenFromUuid(tokenUuid);
  if (!token || !inScope(token) || !token.mesh) return false;
  const entry = entryFor(token);
  if (entry.lasting === "ko") return false;
  const src = poseSrc(propsOf(token), "hurt", _failedSrcs);
  if (!src) return false;
  const art = _arts.get(artKey(token.id, src));
  if (!art?.ready) return false;           // not loaded yet: old flinch this time
  startOneShot(token, "hurt", { art });
  const tier = intensity === "strong" ? "strong" : "normal";
  if (hurtFlinchMode() === "full") startFullFlinch(token, tier);
  else startShake(token, tier);
  return true;
}

// GM: play the KO clip on a creature that is about to be removed, on every
// client, and report how long it runs here (0 = no KO art; use the old death).
export function playDefeatPose(tokenDoc) {
  const tokenUuid = tokenDoc?.uuid;
  if (!tokenUuid) return 0;
  const token = tokenFromUuid(tokenUuid);
  if (!token || !inScope(token)) return 0;
  const src = poseSrc(propsOf(token), "ko", _failedSrcs);
  if (!src) return 0;
  const art = _arts.get(artKey(token.id, src));
  if (!art?.ready) return 0;
  emitBattlerPose({ tokenUuid, pose: "ko", hold: true });
  return clipMs(art) || STILL_MS;
}

// For tools / the console: what a token is showing and why.
export function describeToken(tokenOrUuid) {
  const token = typeof tokenOrUuid === "string" ? tokenFromUuid(tokenOrUuid) : tokenOrUuid;
  if (!token) return null;
  const e = _tokens.get(token.id);
  return {
    name: token.name, inScope: inScope(token),
    lasting: e?.lasting ?? null, oneShot: e?.oneShot?.pose ?? null, shown: e?.shown ?? null,
    arts: [..._arts.values()].filter((a) => a.tokenId === token.id).map((a) => ({ src: a.src, kind: a.kind, ready: a.ready, failed: a.failed })),
  };
}

// ── token lifecycle ─────────────────────────────────────────────────────
function onTokenDrawn(token) {
  if (!inScope(token)) return;
  const entry = entryFor(token);
  trace(token, "drawn");
  entry.shown = null;          // new mesh: whatever we laid on the old one is gone
  entry.applied = null;
  for (const src of declaredPoseSrcs(propsOf(token))) loadArt(token, src);
  entry.lasting = lastingPose(effectsOf(token));
  render(token, { fresh: true });
}

function onTokenRefreshed(token, flags) {
  const entry = _tokens.get(token?.id);
  if (!entry?.shown || entry.shown === "idle") return;
  // Foundry re-fitted the mesh (size/mesh refresh) — our size fix is gone.
  if (flags?.refreshMesh || flags?.refreshSize) applySizing(token, entry);
}

function onEffectChanged(effect) {
  const actor = effect?.parent;
  if (!actor || actor.documentName !== "Actor") return;
  for (const token of tokensOfActor(actor)) {
    if (!inScope(token)) continue;
    const entry = entryFor(token);
    const next = lastingPose(effectsOf(token));
    if (next === entry.lasting) continue;
    const prev = entry.lasting;
    entry.lasting = next;
    trace(token, "lasting", { from: prev, to: next, effect: effect.name });
    log(`battler-pose: ${token.name} ${prev} -> ${next}`);
    // Entering KO plays the fall from the start; anything else just switches.
    render(token, { restart: next === "ko" });
  }
}

function forgetToken(tokenId) {
  if (!tokenId) return;
  const e = _tokens.get(tokenId);
  if (e?.oneShot?.timer) clearTimeout(e.oneShot.timer);
  if (e?.shake) e.shake.stop();
  _tokens.delete(tokenId);
  dropArtsFor(tokenId);
}

function forgetAll() {
  for (const id of [..._tokens.keys()]) forgetToken(id);
  for (const key of [..._arts.keys()]) releaseArt(key);
  if (_stripTicker) { try { canvas.app.ticker.remove(_stripTicker); } catch {} _stripTicker = null; }
}

// ── one-shots ───────────────────────────────────────────────────────────
function startOneShot(token, pose, { hold = false, art = null } = {}) {
  const entry = entryFor(token);
  if (entry.lasting === "ko" && pose !== "ko") return 0;   // the fallen don't flinch
  const src = art?.src ?? poseSrc(propsOf(token), pose, _failedSrcs);
  if (!src) return 0;                                       // no art: fallback = nothing to show
  const a = art ?? loadArt(token, src);
  const begin = () => {
    if (token.destroyed) return 0;
    if (entry.oneShot?.timer) clearTimeout(entry.oneShot.timer);
    entry.oneShot = { pose, hold, timer: null };
    trace(token, "oneShot", { pose, hold, ms: clipMs(a) });
    render(token, { restart: true });
    const ms = Math.min(MAX_ONE_SHOT_MS, clipMs(a) || STILL_MS);
    if (!hold) {
      entry.oneShot.timer = setTimeout(() => endOneShot(token.id, pose), ms + 30);
      registerAnimation({ kind: `battler-pose-${pose}`, durationMs: ms, meta: { token: token.name } });
    }
    return ms;
  };
  if (a.ready) return begin();
  if (a.failed) return 0;
  // Cold cache: wait briefly, then let the fallback stand.
  let done = false;
  a.waiters.push(() => { if (!done) { done = true; begin(); } });
  setTimeout(() => { done = true; }, ONE_SHOT_LOAD_WAIT_MS);
  return 0;
}

function endOneShot(tokenId, pose) {
  const entry = _tokens.get(tokenId);
  if (!entry?.oneShot || entry.oneShot.pose !== pose) return;
  trace(canvas?.tokens?.get?.(tokenId), "end", { pose });
  entry.oneShot = null;
  const token = canvas?.tokens?.get?.(tokenId);
  if (!token || token.destroyed) return;
  // A lethal hit: the KO (marker or removal fall) lands a moment after the
  // hurt clip ends. Hold the hurt clip's last frame instead of standing back
  // up for that moment; whatever comes next renders over it. If nothing does
  // (no KO marker, no removal), stand up after a short wait.
  if (pose === "hurt" && Number(propsOf(token).current_hp) <= 0) {
    trace(token, "hold-hurt-until-ko");
    setTimeout(() => {
      const t = canvas?.tokens?.get?.(tokenId);
      const e = _tokens.get(tokenId);
      if (t && !t.destroyed && e && !e.oneShot && e.shown === "hurt") render(t, { restart: true });
    }, LETHAL_HURT_HOLD_MS);
    return;
  }
  render(token, { restart: true });
}

// ── drawing ─────────────────────────────────────────────────────────────
// Lay the right art on the mesh. `restart` plays the clip from the start;
// `fresh` (a new mesh, e.g. after a reload) shows a held KO already fallen.
function render(token, { restart = false, fresh = false } = {}) {
  const mesh = token?.mesh;
  if (!mesh || token.destroyed) return;
  const entry = entryFor(token);
  const pose = shownPose(entry.lasting, entry.oneShot?.pose ?? null);
  const src = pose === "idle" ? null
    : pose === "state" ? statePoseSrc(effectsOf(token), _failedSrcs)
    : poseSrc(propsOf(token), pose, _failedSrcs);
  const art = src ? _arts.get(artKey(token.id, src)) ?? loadArt(token, src) : null;
  trace(token, "render", { pose, src: src?.split("/").pop() ?? null, ready: !!art?.ready, restart, fresh });

  if (!art || !art.ready) {
    // No art (or not loaded yet): the token's own image. A loading lasting
    // pose re-renders itself when its art arrives (loadArt waiters).
    if (art && !art.failed && !art._renderQueued) {
      art._renderQueued = true;
      art.waiters.push(() => { art._renderQueued = false; const t = canvas?.tokens?.get?.(token.id); if (t) render(t, { restart, fresh }); });
    }
    showOwnImage(token, entry);
    entry.shown = "idle";
    return;
  }

  // Pause whatever clip this token was showing before.
  if (entry.shownArt && entry.shownArt !== art) stopArt(entry.shownArt);

  const holdPose = HOLD.has(pose) || !!entry.oneShot?.hold;
  const loop = LOOPING.has(pose);
  if (art.kind === "video") {
    const v = art.video;
    v.loop = loop;
    if (holdPose && fresh && !restart) {
      seekToEnd(art);                                       // already fallen
    } else if (restart || entry.shownArt !== art || v.paused) {
      try { v.currentTime = 0; } catch {}
      v.play?.().catch(() => {});
    }
  } else if (art.kind === "strip") {
    art.frameIdx = (holdPose && fresh && !restart) ? art.frames.length - 1 : (restart || entry.shownArt !== art ? 0 : art.frameIdx ?? 0);
    art.stripLoop = loop;
    art.stripHold = holdPose;
    art.stripAt = performance.now();
    art.playing = true;
    ensureStripTicker();
  }

  const tex = art.kind === "strip" ? art.frames[art.frameIdx ?? 0] : art.texture;
  if (mesh.texture !== tex) mesh.texture = tex;
  entry.shown = pose;
  entry.shownArt = art;
  try { token._refreshSize(); } catch {}
  reapplyDepth(token);
  applySizing(token, entry);
}

function showOwnImage(token, entry) {
  const mesh = token.mesh;
  if (entry.shownArt) { stopArt(entry.shownArt); entry.shownArt = null; }
  const own = token.texture;
  if (own?.valid && mesh.texture !== own) {
    mesh.texture = own;
    try { token._refreshSize(); } catch {}
    const a = baseAnchor(token);
    try { mesh.anchor.set(a.x, a.y); } catch {}
    reapplyDepth(token);
  }
  entry.applied = null;
}

// _refreshSize() re-fits the mesh from the document and drops the battle depth
// scale (map-system/depth-index.js, battle-stage-3d.js). Put it back; depth-index
// then calls afterBaseResize, which re-fits the pose on top.
function reapplyDepth(token) {
  try { globalThis.__ONI_DEPTH_INDEX__?.reapply?.(token); } catch (e) { warn("battler-pose: depth reapply", e); }
}

// depth-index re-fitted the base scale; lay the pose's size fix on top again.
function afterBaseResize(token) {
  const entry = _tokens.get(token?.id);
  if (!entry?.shown || entry.shown === "idle") return;
  applySizing(token, entry);
}

// The anchor the idle art uses: the token's own, or the feet while the idle
// bounce runs (idle-animation-logic.js pins it there).
function baseAnchor(token) {
  try {
    if (globalThis.__ONI_IDLE_ANIM_API__?.getBounceEntry?.(token.id)) return { x: 0.5, y: 1 };
  } catch {}
  const t = token.document?.texture ?? {};
  return { x: Number(t.anchorX ?? 0.5), y: Number(t.anchorY ?? 0.5) };
}

// Keep pose art at the idle art's pixel size, standing on the same spot
// (bottom-centre). No-op when the two canvases are the same size.
function applySizing(token, entry) {
  const mesh = token?.mesh;
  const own = token?.texture;
  const tex = mesh?.texture;
  if (!mesh || !own?.valid || !tex?.valid || tex === own) return;
  const idle = { w: own.width, h: own.height };
  const pose = { w: tex.width, h: tex.height };
  if (idle.w === pose.w && idle.h === pose.h) { entry.applied = null; return; }
  // Already laid on this base: a refresh can reach here twice (our refreshToken
  // hook and depth-index's afterBaseResize), and the fix multiplies.
  if (entry.applied && mesh.scale.x === entry.applied.sx && mesh.scale.y === entry.applied.sy) return;
  const doc = token.document;
  const { width, height } = token.getSize();
  const [kx, ky] = poseScaleFix(doc.texture?.fit, width, height, idle, pose);
  mesh.scale.x *= kx;
  mesh.scale.y *= ky;
  const a = poseAnchor(baseAnchor(token), idle, pose);
  mesh.anchor.set(a.x, a.y);
  entry.applied = { sx: mesh.scale.x, sy: mesh.scale.y };
  // Idle bounce keeps its own base scale; hand it the corrected one.
  try { globalThis.__ONI_IDLE_ANIM_API__?.setBounceBaseScale?.(token.id, mesh.scale.x, mesh.scale.y); } catch {}
}

// A short jitter for a hurt pose, on the mesh pivot (Foundry never sets the
// pivot, so its refreshes do not fight this), plus a red pulse on strong hits.
function startShake(token, tier) {
  const entry = entryFor(token);
  if (entry.shake) entry.shake.stop();
  const mesh = token.mesh;
  const dur = SHAKE_MS[tier], amp = SHAKE_PX[tier];
  const baseTint = mesh.tint;
  const t0 = performance.now();
  const tick = () => {
    const m = token.mesh;
    if (!m || token.destroyed) return stop();
    const t = (performance.now() - t0) / dur;
    if (t >= 1) return stop();
    const sx = Math.abs(m.scale.x) || 1;
    const off = Math.sin(t * Math.PI * 7) * amp * (1 - t);
    m.pivot.x = off / sx;
    if (tier === "strong") m.tint = t < 0.55 ? STRONG_TINT : baseTint;
  };
  let stopped = false;
  function stop() {
    if (stopped) return;
    stopped = true;
    try { canvas.app.ticker.remove(tick); } catch {}
    const m = token.mesh;
    if (m && !token.destroyed) { m.pivot.x = 0; m.tint = token.document?.texture?.tint ?? baseTint; }
    if (entry.shake === handle) entry.shake = null;
  }
  const handle = { stop };
  entry.shake = handle;
  canvas.app.ticker.add(tick, null, PIXI.UPDATE_PRIORITY.LOW + 1);
}

// Which flinch rides on a hurt clip: "light" = the pivot shake above;
// "full" (default) = the old image-copy flinch's squash, shake and white flash (+ red
// silhouette on strong hits), played on the token so the clip keeps moving.
// Default "full" (user's pick after the side-by-side demo, 2026-10-16);
// globalThis.ONI_HURT_POSE_FLINCH = "light" switches back to the shake only.
function hurtFlinchMode() {
  return globalThis.ONI_HURT_POSE_FLINCH === "light" ? "light" : "full";
}

// Keyframes copied from director-hurt-reaction.js's CSS (same durations,
// stops and values): [time 0..1, scaleX, scaleY, shiftX px]. Brightness
// stops: [time, brightness]. Red silhouette (strong only): [time, opacity].
const FULL_FLINCH = {
  normal: {
    ms: 300,
    move: [[0, 1, 1, 0], [0.12, 1.12, 0.88, 0], [0.30, 0.97, 1.03, -7], [0.50, 1, 1, 6], [0.70, 1, 1, -4], [0.85, 1, 1, 3], [1, 1, 1, 0]],
    bright: [[0, 3.6], [0.35, 1], [1, 1]],
    red: null,
  },
  strong: {
    ms: 480,
    move: [[0, 1, 1, 0], [0.10, 1.22, 0.80, 0], [0.26, 0.90, 1.10, -13], [0.44, 1, 1, 11], [0.62, 1, 1, -7], [0.80, 1, 1, 5], [1, 1, 1, 0]],
    bright: [[0, 4], [0.20, 1], [0.40, 3.2], [0.60, 1], [1, 1]],
    red: [[0, 0.9], [0.55, 0.45], [1, 0]],
  },
};

// Value at time t on a stop list (ease-out within each segment, like CSS).
function sampleStops(stops, t, col) {
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, t1] = [stops[i - 1][0], stops[i][0]];
      const u = t1 > t0 ? (t - t0) / (t1 - t0) : 1;
      const e = 1 - (1 - u) * (1 - u);
      return stops[i - 1][col] + (stops[i][col] - stops[i - 1][col]) * e;
    }
  }
  return stops[stops.length - 1][col];
}

function startFullFlinch(token, tier) {
  const entry = entryFor(token);
  if (entry.shake) entry.shake.stop();
  const spec = FULL_FLINCH[tier];
  const mesh = token.mesh;
  // Squash is a multiplier on whatever scale Foundry (and the bounce) set;
  // re-read the base each tick by undoing last tick's multiplier.
  // set = the scale we last wrote; if Foundry re-fitted the mesh since, its
  // new scale is the base and there is no multiplier of ours to undo.
  let lastKx = 1, lastKy = 1, setX = null, setY = null;
  const baseX = (m) => (setX !== null && m.scale.x === setX ? m.scale.x / lastKx : m.scale.x);
  const baseY = (m) => (setY !== null && m.scale.y === setY ? m.scale.y / lastKy : m.scale.y);
  const filter = new PIXI.ColorMatrixFilter();
  const ownFilters = mesh.filters ? [...mesh.filters] : [];
  mesh.filters = [...ownFilters, filter];
  const t0 = performance.now();
  const tick = () => {
    const m = token.mesh;
    if (!m || token.destroyed) return stop();
    const t = (performance.now() - t0) / spec.ms;
    if (t >= 1) return stop();
    const kx = sampleStops(spec.move, t, 1), ky = sampleStops(spec.move, t, 2), px = sampleStops(spec.move, t, 3);
    m.scale.x = baseX(m) * kx;
    m.scale.y = baseY(m) * ky;
    lastKx = kx; lastKy = ky; setX = m.scale.x; setY = m.scale.y;
    const zoom = canvas.stage?.scale?.x || 1;
    m.pivot.x = -px / ((Math.abs(m.scale.x) || 1) * zoom);
    // brightness b, then blend toward a red silhouette by r (alpha untouched)
    const b = sampleStops(spec.bright, t, 1);
    const r = spec.red ? sampleStops(spec.red, t, 1) : 0;
    const k = (1 - r) * b;
    filter.matrix = [
      k, 0, 0, 0, r * 1.0,
      0, k, 0, 0, r * 0.17,
      0, 0, k, 0, r * 0.17,
      0, 0, 0, 1, 0,
    ];
  };
  let stopped = false;
  function stop() {
    if (stopped) return;
    stopped = true;
    try { canvas.app.ticker.remove(tick); } catch {}
    const m = token.mesh;
    if (m && !token.destroyed) {
      m.scale.x = baseX(m); m.scale.y = baseY(m);
      m.pivot.x = 0;
      m.filters = (m.filters ?? []).filter((f) => f !== filter);
      if (!m.filters.length) m.filters = null;
    }
    try { filter.destroy(); } catch {}
    if (entry.shake === handle) entry.shake = null;
  }
  const handle = { stop };
  entry.shake = handle;
  canvas.app.ticker.add(tick, null, PIXI.UPDATE_PRIORITY.LOW + 1);
}

// ── art loading (one per token per URL) ─────────────────────────────────
function artKey(tokenId, src) { return `${tokenId}|${src}`; }

function loadArt(token, src) {
  const key = artKey(token.id, src);
  let art = _arts.get(key);
  if (art) return art;
  art = { key, tokenId: token.id, src, kind: null, texture: null, video: null, frames: null, ready: false, failed: false, waiters: [] };
  _arts.set(key, art);

  const fail = (err) => {
    // releaseArt clears the video's src, which fires its error event. That is
    // our own cleanup, not a bad file, so it must not blacklist the URL.
    if (art.released) return;
    art.failed = true;
    _failedSrcs.add(src);
    warn(`battler-pose: could not load ${src} — falling back`, err ?? "");
    flushWaiters(art);
  };

  if (VIDEO_RE.test(src)) {
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.addEventListener("loadeddata", () => {
      try {
        art.texture = PIXI.Texture.from(video, { resourceOptions: { autoPlay: false } });
        art.video = video;
        art.kind = "video";
        art.ready = true;
        flushWaiters(art);
      } catch (e) { fail(e); }
    }, { once: true });
    // The video element keeps its last frame when it ends; PIXI stops
    // uploading frames once it stops playing, so the held frame stays.
    video.addEventListener("seeked", () => { try { art.texture?.baseTexture?.resource?.update?.(); } catch {} });
    video.addEventListener("error", () => fail(), { once: true });
    video.src = src;
  } else {
    Promise.resolve(loadTexture(src)).then((texture) => {
      if (!texture?.valid) throw new Error("texture not valid");
      // A strip is several frames of the idle art's shape side by side.
      const own = token.texture;
      const idleAspect = own?.width && own?.height ? own.width / own.height : 0;
      const count = idleAspect ? Math.round(texture.width / (texture.height * idleAspect)) : 1;
      if (count > 1) {
        const fw = texture.width / count;
        art.frames = [];
        for (let i = 0; i < count; i++) {
          art.frames.push(new PIXI.Texture(texture.baseTexture,
            new PIXI.Rectangle(texture.frame.x + Math.round(i * fw), texture.frame.y, Math.floor(fw), texture.height)));
        }
        art.kind = "strip";
      } else {
        art.kind = "image";
      }
      art.texture = texture;
      art.ready = true;
      flushWaiters(art);
    }).catch(fail);
  }
  return art;
}

function flushWaiters(art) {
  const ws = art.waiters.splice(0);
  for (const w of ws) { try { w(); } catch (e) { warn("battler-pose: waiter threw", e); } }
}

function clipMs(art) {
  if (!art?.ready) return 0;
  if (art.kind === "video") {
    const d = Number(art.video?.duration);
    return Number.isFinite(d) && d > 0 ? Math.round(d * 1000) : 0;
  }
  if (art.kind === "strip") return art.frames.length * STRIP_FRAME_MS;
  return 0;
}

function seekToEnd(art) {
  const v = art.video;
  if (!v) return;
  const go = () => { try { v.pause(); v.currentTime = Math.max(0, (v.duration || 0) - 0.001); } catch {} };
  if (Number.isFinite(v.duration) && v.duration > 0) go();
  else v.addEventListener("loadedmetadata", go, { once: true });
}

function stopArt(art) {
  if (art?.kind === "video") { try { art.video.pause(); } catch {} }
  if (art?.kind === "strip") art.playing = false;
}

function releaseArt(key) {
  const art = _arts.get(key);
  if (!art) return;
  _arts.delete(key);
  art.released = true;
  if (art.kind === "video") {
    try { art.video.pause(); art.video.removeAttribute("src"); art.video.load(); } catch {}
    try { art.texture?.destroy(true); } catch {}
  }
}

function dropArtsFor(tokenId) {
  for (const key of [..._arts.keys()]) if (key.startsWith(`${tokenId}|`)) releaseArt(key);
}

// One ticker advances every playing strip.
function ensureStripTicker() {
  if (_stripTicker) return;
  _stripTicker = () => {
    const now = performance.now();
    let any = false;
    for (const art of _arts.values()) {
      if (art.kind !== "strip" || !art.playing) continue;
      any = true;
      if (now - art.stripAt < STRIP_FRAME_MS) continue;
      art.stripAt = now;
      let i = (art.frameIdx ?? 0) + 1;
      if (i >= art.frames.length) {
        if (art.stripLoop) i = 0;
        else { i = art.frames.length - 1; art.playing = false; }
      }
      art.frameIdx = i;
      const token = canvas?.tokens?.get?.(art.tokenId);
      const entry = _tokens.get(art.tokenId);
      if (token?.mesh && entry?.shownArt === art) token.mesh.texture = art.frames[i];
    }
    if (!any) { try { canvas.app.ticker.remove(_stripTicker); } catch {} _stripTicker = null; }
  };
  canvas.app.ticker.add(_stripTicker);
}

// ── helpers ─────────────────────────────────────────────────────────────
function entryFor(token) {
  let e = _tokens.get(token.id);
  if (!e) { e = { lasting: "idle", oneShot: null, shown: null, shownArt: null, applied: null, shake: null }; _tokens.set(token.id, e); }
  return e;
}

function inScope(token) {
  return !!token?.document?.flags?.[MODULE_ID]?.[FLAG_DIRECTOR_SPAWNED] && !!token.actor;
}

function propsOf(token) { return token?.actor?.system?.props ?? {}; }

function effectsOf(token) {
  const list = token?.actor?.effects?.contents ?? [];
  return list.map((e) => ({ name: e.name, disabled: e.disabled, statuses: e.statuses, flags: e.flags }));
}

function tokenFromUuid(tokenUuid) {
  const id = String(tokenUuid ?? "").split(".Token.").pop();
  return id ? (canvas?.tokens?.get?.(id) ?? null) : null;
}

function tokensOfActor(actor) {
  try {
    if (actor.isToken) return actor.token?.object ? [actor.token.object] : [];
    return actor.getActiveTokens?.(true) ?? [];
  } catch { return []; }
}
