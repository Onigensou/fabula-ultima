// The Blackest Night — revival cinematic (the fake-out victory).
//
// FULL beat sheet (first revival of a battle):
//   1. Geist drops — downed treatment ON (webm paused, desaturated, darkened)
//   2. battle BGM stops, victory fanfare plays, camera pans to the party —
//      this deliberately mirrors the REAL Battle-End FX so it reads as a win
//   3. the fanfare fades out under a heartbeat… vignette closes in
//   4. hard snap-pan to Geist, gray and still; a second heartbeat; silence
//   5. dark implosion burst on Geist + screenshake
//   6. THE RISE — restore lands here (onRise): color floods back, the webm
//      resumes, violet flash
//   7. boss BGM returns, vignette lifts, input unlocks, combat resumes
//
// SHORT (2nd+ revival — "he just refuses to die", ~3s): no fake victory, no
// BGM swap. Heartbeat, snap-pan, burst, rise, done.
//
// Architecture mirrors wandering-flame-entrance.js: GM resolves everything
// non-deterministic (fanfare URL, pan target) into ONE payload, broadcasts
// via socketlib, and every client — GM included — runs the same local
// timeline. Only the GM's run carries onRise (the restore) and the world-
// level BGM ops (stop battle track / resume boss track propagate to all
// clients via playlist documents on their own).
//
// No external assets: heartbeat is WebAudio-synthesized, the burst is
// generated PIXI radial gradients, vignette/flash are DOM. The fanfare URL
// comes from whatever playlist track the game DB names as victory_bgm.
//
// Contract (stable since Phase 1):
//   await playBlackestNightCinematic({ mode, director, endCtx, bossTokenUuid, onRise })
//   - onRise is awaited exactly once, at the rise beat (GM only).
//   - resolves when the cinematic has fully played out.

import { log, warn } from "../../logger.js";
import { stopBattleBgm, playBattleBgm } from "../../director-vfx.js";

const MODULE_ID   = "fabula-ultima-companion";
const ACTION_PLAY = "FU_BLACKEST_NIGHT_PLAY";
const STYLE_ID    = "fud-bn-style";
const VIGNETTE_ID = "fud-bn-vignette";
const FLASH_ID    = "fud-bn-flash";
const LOCK_ID     = "fud-bn-input-lock";

// ─── Timing / tuning (ms unless noted) — edit here during live tuning ─────
const CFG = {
  full: {
    downedSettleMs:   700,    // beat 1 — let the death land before the "win"
    victoryPanMs:     2800,   // camera drift to the party
    victoryPanScale:  1.7,
    victoryHoldMs:    2300,   // savor the fake win (fanfare playing)
    fanfareVol:       0.8,
    fanfareFadeMs:    1000,   // beat 3 — the music dies
    vignetteInMs:     700,
    beatAfterFadeMs:  600,    // heartbeat #1 lands here
    snapPanMs:        550,    // beat 4 — hard cut to Geist
    snapPanScale:     1.9,
    dreadHoldMs:      900,    // heartbeat #2 + silence
    burstMs:          900,    // beat 5 — implosion
    shakeMs:          700,
    riseFlashMs:      450,    // beat 6 — color floods back
    riseTailMs:       700,    // hold on the risen boss before control returns
    vignetteOutMs:    600,
    resetPanMs:       900,    // camera home to the default battle view
  },
  short: {
    downedSettleMs:   250,
    vignetteInMs:     300,
    beatAfterFadeMs:  250,    // heartbeat #1
    snapPanMs:        450,
    snapPanScale:     1.9,
    dreadHoldMs:      550,    // heartbeat #2
    burstMs:          650,
    shakeMs:          500,
    riseFlashMs:      350,
    riseTailMs:       400,
    vignetteOutMs:    350,
    resetPanMs:       650,
  },
  heartbeatVol: 0.9,
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let _socket = null;

// Idempotent socket registration. Called once per client on boot `ready`
// (director-boot.js), same pattern as the WF entrance.
export function initBlackestNightCinematic() {
  try {
    if (typeof socketlib === "undefined" || !game.modules.get("socketlib")?.active) {
      warn("[BlackestNight] socketlib unavailable — cinematic stays local-only");
      return;
    }
    _socket = socketlib.registerModule(MODULE_ID);
    _socket.register(ACTION_PLAY, (payload) => playLocal(payload, null));
    log("[BlackestNight] cinematic socket registered");
  } catch (e) { warn("[BlackestNight] cinematic init failed", e); }
}

// ─── GM entry ──────────────────────────────────────────────────────────────
export async function playBlackestNightCinematic({
  mode = "full",
  director = null,
  endCtx = null,          // reserved (viewport snapshots, future use)
  bossTokenUuid = null,
  onRise = null,
} = {}) {
  // Resolve everything clients need into one deterministic payload.
  const bossDoc  = bossTokenUuid ? await fromUuid(bossTokenUuid).catch(() => null) : null;
  const bossTd   = bossDoc?.document ?? bossDoc;
  const sceneId  = bossTd?.parent?.id ?? canvas?.scene?.id ?? null;
  const tokenId  = bossTd?.id ?? null;

  // Fake-victory pan target: a random player-owned token (same pick for every
  // client — the GM chooses).
  let panTargetId = null;
  if (mode === "full") {
    const pcs = (canvas?.tokens?.placeables ?? []).filter((t) => t?.actor?.hasPlayerOwner);
    if (pcs.length) panTargetId = pcs[Math.floor(Math.random() * pcs.length)].id;
  }

  // Victory fanfare URL off the DB's victory_bgm playlist track (played as a
  // LOCAL Audio per client so the fade is frame-accurate; playlist docs would
  // add write-latency to every volume step).
  let fanfareUrl = null;
  if (mode === "full") {
    const name = await fetchVictoryBgmName();
    fanfareUrl = resolvePlaylistSoundUrl(name);
    if (!fanfareUrl) warn(`[BlackestNight] victory track "${name}" not found — fake-out plays without fanfare`);
  }

  const payload = {
    runId: `bn_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    mode, sceneId, tokenId, panTargetId, fanfareUrl,
  };

  // World-level BGM stop FIRST (propagates to all clients via the playlist
  // doc), then broadcast the visual timeline.
  if (mode === "full") {
    try { await stopBattleBgm(director?.ctx?.payload?.battleConfig?.bgm); }
    catch (e) { warn("[BlackestNight] stopBattleBgm threw", e); }
  }

  try { _socket?.executeForOthers?.(ACTION_PLAY, payload); }
  catch (e) { warn("[BlackestNight] broadcast failed", e); }

  await playLocal(payload, { onRise, director });
}

async function fetchVictoryBgmName() {
  try {
    const api = window?.FUCompanion?.api;
    if (!api?.getCurrentGameDb) return "Victory Fanfare";
    const { source: db } = await api.getCurrentGameDb();
    const raw = db?.system?.props?.victory_bgm;
    return (typeof raw === "string" && raw.trim()) ? raw.trim() : "Victory Fanfare";
  } catch { return "Victory Fanfare"; }
}

function resolvePlaylistSoundUrl(name) {
  if (!name) return null;
  for (const pl of (game.playlists ?? [])) {
    const snd = pl.sounds?.getName?.(name);
    if (snd) return snd.path ?? snd.sound?.src ?? null;
  }
  return null;
}

// ─── Local timeline (every client; gmExtras only on the GM) ───────────────
async function playLocal(payload, gmExtras) {
  const { mode = "full", sceneId, tokenId, panTargetId, fanfareUrl } = payload ?? {};
  const t = CFG[mode] ?? CFG.short;
  const isGM = !!gmExtras;

  // Wrong scene → visuals can't anchor. GM still owes the rise beat.
  if (sceneId && canvas?.scene?.id !== sceneId) {
    if (isGM && typeof gmExtras.onRise === "function") {
      try { await gmExtras.onRise(); } catch (e) { warn("[BlackestNight] onRise threw", e); }
    }
    return;
  }

  const bossToken = tokenId ? canvas.tokens?.get?.(tokenId) ?? null : null;
  const unlock = installInputLock();
  let downed = null;
  let fanfare = null;

  try {
    // ── beat 1: he lies defeated ──
    downed = applyDownedTreatment(bossToken);
    await wait(t.downedSettleMs);

    if (mode === "full") {
      // ── beat 2: the fake victory ──
      if (fanfareUrl) fanfare = startFanfare(fanfareUrl, CFG.full.fanfareVol);
      const target = panTargetId ? canvas.tokens?.get?.(panTargetId) : null;
      if (target) {
        await panTo(target.center, t.victoryPanScale, t.victoryPanMs);
      } else {
        await wait(t.victoryPanMs);
      }
      await wait(t.victoryHoldMs);

      // ── beat 3: the music dies ──
      if (fanfare) await fadeOutFanfare(fanfare, t.fanfareFadeMs);
      else await wait(t.fanfareFadeMs);
    }

    showVignette(t.vignetteInMs);
    heartbeat();
    await wait(t.vignetteInMs + t.beatAfterFadeMs);

    // ── beat 4: snap to the body ──
    if (bossToken) await panTo(bossToken.center, t.snapPanScale, t.snapPanMs);
    heartbeat();
    await wait(t.dreadHoldMs);

    // ── beat 5: implosion ──
    if (bossToken) playImplosionBurst(bossToken, t.burstMs);
    screenshake(t.shakeMs);
    await wait(t.burstMs);

    // ── beat 6: THE RISE — restore lands exactly here ──
    if (isGM && typeof gmExtras.onRise === "function") {
      try { await gmExtras.onRise(); } catch (e) { warn("[BlackestNight] onRise threw", e); }
    }
    liftDownedTreatment(downed); downed = null;
    flash(t.riseFlashMs);

    // ── beat 7: the fight goes on ──
    if (isGM && mode === "full") {
      try { await playBattleBgm(gmExtras.director?.ctx?.payload); }
      catch (e) { warn("[BlackestNight] boss BGM resume threw", e); }
    }
    await wait(t.riseTailMs);
    hideVignette(t.vignetteOutMs);
    // Camera home — the cinematic ends where the battle camera lives, not
    // zoomed into Geist's face. Every client pans back on its own.
    const home = battleCameraTarget();
    if (home) await panTo({ x: home.x, y: home.y }, home.scale, t.resetPanMs);
    await wait(t.vignetteOutMs);
  } catch (e) {
    warn("[BlackestNight] cinematic threw (cleaning up)", e);
  } finally {
    try { liftDownedTreatment(downed); } catch (_) {}
    try { stopFanfare(fanfare); } catch (_) {}
    try { hideVignette(200); } catch (_) {}
    unlock();
  }
}

// ─── Downed treatment ──────────────────────────────────────────────────────
// Geist has no defeated art — his battle stance IS his token webm. "Downed"
// = pause the video + desaturate/darken the mesh. NOTE: Foundry shares video
// textures by src, so pausing would freeze every token using the same file —
// Geist's sprite is unique to him, which is why this is safe here.
function applyDownedTreatment(token) {
  const mesh = token?.mesh;
  if (!mesh) return null;
  let vid = null;
  try {
    const src = mesh.texture?.baseTexture?.resource?.source;
    if (typeof HTMLVideoElement !== "undefined" && src instanceof HTMLVideoElement) {
      vid = src;
      vid.pause();
    }
  } catch (_) {}
  let cm = null;
  try {
    cm = new PIXI.ColorMatrixFilter();
    cm.desaturate();
    cm.brightness(0.5, true);
    mesh.filters = [...(mesh.filters ?? []), cm];
  } catch (e) { warn("[BlackestNight] downed filter failed", e); }
  return { mesh, cm, vid };
}

function liftDownedTreatment(h) {
  if (!h) return;
  try { if (h.cm) h.mesh.filters = (h.mesh.filters ?? []).filter((f) => f !== h.cm); } catch (_) {}
  try { h.vid?.play?.(); } catch (_) {}
}

// ─── Camera ────────────────────────────────────────────────────────────────
// Default battle view: the director's PREP-time viewport snapshot when one
// exists, else the scene's configured Initial View Position. Null → skip
// (leave the camera wherever it is).
function battleCameraTarget() {
  try {
    const vp = game.settings.get(MODULE_ID, "bdBattleSceneViewport");
    if (vp && Number.isFinite(Number(vp.x)) && Number.isFinite(Number(vp.y))) {
      return { x: Number(vp.x), y: Number(vp.y), scale: Number(vp.scale) || canvas.stage.scale.x };
    }
  } catch (_) {}
  const init = canvas?.scene?.initial;
  if (init && Number.isFinite(Number(init.x)) && Number.isFinite(Number(init.y))) {
    return { x: Number(init.x), y: Number(init.y), scale: Number(init.scale) || 1 };
  }
  return null;
}

async function panTo(center, scale, durationMs) {
  try {
    await Promise.race([
      canvas.animatePan({ x: center.x, y: center.y, scale, duration: durationMs }),
      wait(durationMs + 1500),
    ]);
  } catch (e) { warn("[BlackestNight] pan failed", e); }
}

// ─── Fanfare (local Audio, per client) ────────────────────────────────────
function startFanfare(url, vol) {
  try {
    const a = new Audio(url);
    a.volume = vol;
    a.play().catch(() => {});
    return a;
  } catch { return null; }
}

function fadeOutFanfare(a, fadeMs) {
  return new Promise((resolve) => {
    if (!a) return resolve();
    const v0 = a.volume;
    const t0 = performance.now();
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / fadeMs);
      try { a.volume = v0 * (1 - k); } catch (_) {}
      if (k >= 1) { try { a.pause(); } catch (_) {} resolve(); }
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

function stopFanfare(a) {
  try { a?.pause?.(); } catch (_) {}
}

// ─── Heartbeat (WebAudio "lub-dub", no asset) ─────────────────────────────
let _audioCtx = null;
function heartbeat() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    _audioCtx = _audioCtx ?? new AC();
    const ctx = _audioCtx;
    if (ctx.state === "suspended") { try { ctx.resume(); } catch (_) {} }
    const thump = (at, freq, dur, peak) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(peak, at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      o.connect(g).connect(ctx.destination);
      o.start(at); o.stop(at + dur + 0.05);
    };
    const now = ctx.currentTime;
    const v = CFG.heartbeatVol;
    thump(now,        58, 0.16, 0.85 * v);   // lub
    thump(now + 0.22, 46, 0.22, 0.60 * v);   // dub
  } catch (_) {}
}

// ─── Vignette / flash / shake / input lock (DOM) ──────────────────────────
function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const st = document.createElement("style");
  st.id = STYLE_ID;
  st.textContent = `
@keyframes fud-bn-shake {
  0%,100% { transform: translate(0,0); }
  10% { transform: translate(-8px, 6px); }
  20% { transform: translate(7px,-6px); }
  30% { transform: translate(-6px,-7px); }
  40% { transform: translate(6px, 6px); }
  50% { transform: translate(-5px, 4px); }
  60% { transform: translate(5px,-4px); }
  70% { transform: translate(-3px, 3px); }
  80% { transform: translate(3px, 2px); }
  90% { transform: translate(-2px,-1px); }
}
.fud-bn-shaking { animation: fud-bn-shake 120ms linear infinite; }`;
  document.head.appendChild(st);
}

function showVignette(fadeInMs) {
  try {
    let el = document.getElementById(VIGNETTE_ID);
    if (!el) {
      el = document.createElement("div");
      el.id = VIGNETTE_ID;
      Object.assign(el.style, {
        position: "fixed", inset: "0", zIndex: "99980", pointerEvents: "none",
        background: "radial-gradient(ellipse at center, rgba(0,0,0,0) 30%, rgba(10,0,20,0.78) 100%)",
        opacity: "0", transition: `opacity ${fadeInMs}ms ease-in`,
      });
      document.body.appendChild(el);
    }
    el.style.transition = `opacity ${fadeInMs}ms ease-in`;
    requestAnimationFrame(() => { el.style.opacity = "1"; });
  } catch (_) {}
}

function hideVignette(fadeOutMs) {
  try {
    const el = document.getElementById(VIGNETTE_ID);
    if (!el) return;
    el.style.transition = `opacity ${fadeOutMs}ms ease-out`;
    el.style.opacity = "0";
    setTimeout(() => { try { el.remove(); } catch (_) {} }, fadeOutMs + 100);
  } catch (_) {}
}

// Violet-white pop at the rise.
function flash(durMs) {
  try {
    let el = document.getElementById(FLASH_ID);
    if (el) el.remove();
    el = document.createElement("div");
    el.id = FLASH_ID;
    Object.assign(el.style, {
      position: "fixed", inset: "0", zIndex: "99985", pointerEvents: "none",
      background: "radial-gradient(ellipse at center, rgba(255,255,255,0.95) 0%, rgba(170,80,255,0.55) 45%, rgba(60,0,90,0) 75%)",
      opacity: "1", transition: `opacity ${durMs}ms ease-out`,
    });
    document.body.appendChild(el);
    requestAnimationFrame(() => { el.style.opacity = "0"; });
    setTimeout(() => { try { el.remove(); } catch (_) {} }, durMs + 100);
  } catch (_) {}
}

function screenshake(durMs) {
  try {
    ensureStyle();
    const view = canvas?.app?.view;
    if (!view) return;
    view.classList.add("fud-bn-shaking");
    setTimeout(() => { try { view.classList.remove("fud-bn-shaking"); } catch (_) {} }, durMs);
  } catch (_) {}
}

function installInputLock() {
  try {
    if (document.getElementById(LOCK_ID)) return () => {};
    const el = document.createElement("div");
    el.id = LOCK_ID;
    Object.assign(el.style, {
      position: "fixed", inset: "0", zIndex: "999999",
      pointerEvents: "all", background: "transparent",
    });
    document.body.appendChild(el);
    const BLOCKED = new Set([
      "arrowup","arrowdown","arrowleft","arrowright",
      "w","a","s","d","+","-","=","pageup","pagedown","home","end",
    ]);
    const stopKeys  = (ev) => { if (BLOCKED.has(String(ev.key ?? "").toLowerCase())) { ev.preventDefault(); ev.stopPropagation(); } };
    const stopWheel = (ev) => { ev.preventDefault(); ev.stopPropagation(); };
    window.addEventListener("keydown", stopKeys, true);
    window.addEventListener("wheel", stopWheel, { capture: true, passive: false });
    return () => {
      try { window.removeEventListener("keydown", stopKeys, true); } catch (_) {}
      try { window.removeEventListener("wheel", stopWheel, true); } catch (_) {}
      try { el.remove(); } catch (_) {}
    };
  } catch { return () => {}; }
}

// ─── Implosion burst (generated PIXI, no assets) ──────────────────────────
// A dark ring converges on the boss, then a violet core bloom (ADD blend)
// pops at the moment of the rise flash.
function radialTexture(inner, outer) {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(128, 128, 10, 128, 128, 128);
  grad.addColorStop(0, inner);
  grad.addColorStop(1, outer);
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  return PIXI.Texture.from(c);
}

function playImplosionBurst(token, durMs) {
  try {
    const stage = canvas?.stage;
    if (!stage || !token?.center) return;
    stage.sortableChildren = true;

    const size = Math.max(token.w ?? 100, token.h ?? 100);
    const mk = (tex, blend, scale0, alpha0) => {
      const s = new PIXI.Sprite(tex);
      s.anchor.set(0.5);
      s.position.set(token.center.x, token.center.y);
      s.width = s.height = size * scale0;
      s.alpha = alpha0;
      s.zIndex = 100000;
      if (blend != null) s.blendMode = blend;
      stage.addChild(s);
      return s;
    };

    const ring = mk(radialTexture("rgba(20,0,40,0)", "rgba(40,0,70,0.9)"), null, 3.2, 0);
    const core = mk(radialTexture("rgba(200,120,255,0.95)", "rgba(80,0,140,0)"), PIXI.BLEND_MODES.ADD, 0.2, 0);

    const t0 = performance.now();
    const convergeMs = durMs * 0.72;
    const tick = () => {
      const now = performance.now();
      const k = Math.min(1, (now - t0) / convergeMs);
      const e = 1 - Math.pow(1 - k, 3);   // easeOutCubic
      const sc = 3.2 - (3.2 - 0.35) * e;
      ring.width = ring.height = size * sc;
      ring.alpha = Math.min(0.9, k * 1.6);
      if (k >= 1) {
        // core bloom for the remainder
        const k2 = Math.min(1, (now - t0 - convergeMs) / (durMs - convergeMs));
        ring.alpha = 0.9 * (1 - k2);
        core.alpha = Math.sin(k2 * Math.PI);
        core.width = core.height = size * (0.2 + 2.4 * k2);
      }
      if (now - t0 >= durMs) {
        canvas.app.ticker.remove(tick);
        try { ring.destroy(); } catch (_) {}
        try { core.destroy(); } catch (_) {}
      }
    };
    canvas.app.ticker.add(tick);
  } catch (e) { warn("[BlackestNight] burst failed", e); }
}
