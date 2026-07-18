// The Blackest Night — revival cinematic (the fake-out victory).
//
// FULL beat sheet (first revival of a battle):
//   1. Geist drops — his token is hidden and replaced by the KO sprite
//      (world-anchored PIXI, so it tracks the camera through the pans)
//   2. battle BGM stops, victory fanfare plays, camera pans to the party —
//      this deliberately mirrors the REAL Battle-End FX so it reads as a win
//   3. the fanfare fades out under a heartbeat… vignette closes in
//   4. hard snap-pan to the body; heartbeats keep looping
//   5. THE VIGIL — the screen dims to near-black; the KO sprite hands off to
//      a screen-fixed DOM copy ABOVE the dim, pulsing with each heartbeat
//   6. screenflash (Flash1.ogg) — the KO sprite becomes the REVIVE sprite,
//      floating idly in the dark (~2.5s)
//   7. Zero Power cut-in: full-height portrait slides across (Overdrive
//      sting) while the action namecard banner announces the skill (💥 +
//      live item name, hostile theme)
//   8. THE RISE — restore lands here (onRise): overlay drops, the battle
//      webm returns, an "aura explosion" clone of the battle sprite scales
//      out over the screen (50% opacity → 0), red/violet particle burst,
//      MG_DEATH_BLUR SFX, screenshake
//   9. Geist's DEDICATED battle BGM ("Geist_Battle") starts, camera pans
//      home, dim lifts, combat resumes
//
// SHORT (2nd+ revival, ~4s): KO sprite swap, heartbeat, snap-pan, rise
// (aura explosion + burst + SFX). No fake victory, no BGM ops — the Geist
// BGM is already playing from revival #1.
//
// Architecture mirrors wandering-flame-entrance.js: GM resolves everything
// non-deterministic (fanfare URL, pan target, cut-in art, banner title) into
// ONE payload, broadcasts via socketlib, and every client — GM included —
// runs the same local timeline. Only the GM's run carries onRise (the
// restore), the world-level BGM ops, and the namecard broadcast (that
// renderer fans out on its own — firing it per client would stack banners).
//
// Overlay rendering is split by camera phase: while the camera MOVES the KO
// sprite is world-anchored PIXI; once the camera is static and the dim is up
// it becomes screen-fixed DOM (camera-transform-immune, above the dim).
// NOTE on injected <img>: a global stylesheet borders every img — zero out
// border/outline/box-shadow on all injected media (see
// [[feedback_dom_img_transparent_border]]).
//
// Contract (stable since Phase 1):
//   await playBlackestNightCinematic({ mode, director, endCtx, bossTokenUuid, onRise })
//   - onRise is awaited exactly once, at the rise beat (GM only).
//   - resolves when the cinematic has fully played out.

import { log, warn } from "../../logger.js";
import { stopBattleBgm, playBattleBgm } from "../../director-vfx.js";
import { setCrestsHiddenLocal } from "../../domination-crest.js";

const MODULE_ID   = "fabula-ultima-companion";
const ACTION_PLAY = "FU_BLACKEST_NIGHT_PLAY";
const STYLE_ID    = "fud-bn-style";
const VIGNETTE_ID = "fud-bn-vignette";
const DIM_ID      = "fud-bn-dim";
const SPRITE_ID   = "fud-bn-sprite";
const CUTIN_ID    = "fud-bn-cutin";
const FLASH_ID    = "fud-bn-flash";
const LOCK_ID     = "fud-bn-input-lock";

// ─── Art / SFX (Geist-specific; cut-in prefers the actor's own
// cut_in_zero_power prop so future art swaps need no code) ─────────────────
const ASSETS = {
  ko:       "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Campaign/The%20Legend%20of%20Dragonslayer/Image/NPCs/Geist/Geist_KO.png",
  revive:   "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Campaign/The%20Legend%20of%20Dragonslayer/Image/NPCs/Geist/Geist_Revive.png",
  cutin:    "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Campaign/The%20Legend%20of%20Dragonslayer/Image/NPCs/Geist/Portrait/Geist_Cutin.png",
  flashSfx: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Flash1.ogg",
  cutinSfx: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Overdrive.wav",
  riseSfx:  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/MG_DEATH_BLUR01.wav",
  downSfx:  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/SE_DOWNC.wav",
};

// Geist's dedicated boss track (playlist sound name, any playlist). Started
// at the rise of the FULL sequence; the short sequence assumes it's already
// playing. Played through playBattleBgm so the director's tracked-BGM stop
// still works at the real battle end.
const GEIST_BGM = "Geist_Battle";

// ─── Timing / tuning (ms unless noted) — edit here during live tuning ─────
const CFG = {
  full: {
    downedSettleMs:   700,    // beat 1 — let the death land before the "win"
    fakeHoldMs:       2500,   // fake "GM operating the victory screen" pause
    victoryPanMs:     2800,   // camera drift to the party
    victoryPanScale:  1.7,
    victoryHoldMs:    2300,   // savor the fake win (fanfare playing)
    fanfareVol:       0.8,
    fanfareFadeMs:    1000,   // beat 3 — the music dies
    vignetteInMs:     700,
    beatAfterFadeMs:  600,    // heartbeat #1 lands here
    snapPanMs:        550,    // beat 4 — hard cut to Geist
    snapPanScale:     1.9,
    preDimBeatsMs:    1500,   // heartbeats looping over the body before the dim
    dimInMs:          600,    // the world goes dark…
    vigilMs:          4000,   // …Geist alone stays lit, pulsing with each beat
    beatIntervalMs:   950,    // heartbeat cadence through pre-dim + vigil
    flashSwapMs:      260,    // beat 6 — screenflash, KO → Revive sprite
    reviveHoldMs:     2500,   // floating in the dark
    cutinInMs:        380,    // beat 7 — Zero Power cut-in slide-in
    cutinHoldMs:      2300,   // (+1s per review)
    cutinOutMs:       380,
    gatherMs:         1300,   // beat 7.5 — purple energy converges into Geist
    burstMs:          1000,   // beat 8 — rise burst
    explodeMs:        950,    // aura-explosion clone scale-out
    shakeMs:          700,
    riseFlashMs:      450,
    riseTailMs:       800,    // hold on the risen boss before control returns
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
    explodeMs:        750,
    shakeMs:          500,
    riseFlashMs:      350,
    riseTailMs:       400,
    vignetteOutMs:    350,
    resetPanMs:       650,
  },
  heartbeatVol: 0.9,
  riseSfxVol:   0.5,
  explodeAlpha: 0.7,          // aura clone starting opacity (raised per review)
  // Overlay sprite sizing/facing. Art faces LEFT; enemies face RIGHT on this
  // battlefield → mirror horizontally.
  spriteFlipX: true,
  spriteScale: 1.2,           // overlay height = token height × this
  cutinHeightVh: 100,         // cut-in portrait fills the screen height
  namecardHoldMs: 2700,       // (+1s per review)
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
  const bossDoc  = bossTokenUuid ? await fromUuid(bossTokenUuid).catch(() => null) : null;
  const bossTd   = bossDoc?.document ?? bossDoc;
  const sceneId  = bossTd?.parent?.id ?? canvas?.scene?.id ?? null;
  const tokenId  = bossTd?.id ?? null;
  const bossActor = bossTd?.actor ?? null;

  // Fake-victory pan target: a random player-owned token (same pick for every
  // client — the GM chooses).
  let panTargetId = null;
  if (mode === "full") {
    const pcs = (canvas?.tokens?.placeables ?? []).filter((t) => t?.actor?.hasPlayerOwner);
    if (pcs.length) panTargetId = pcs[Math.floor(Math.random() * pcs.length)].id;
  }

  // Victory fanfare URL off the DB's victory_bgm playlist track (played as a
  // LOCAL Audio per client so the fade is frame-accurate).
  let fanfareUrl = null;
  if (mode === "full") {
    const name = await fetchVictoryBgmName();
    fanfareUrl = resolvePlaylistSoundUrl(name);
    if (!fanfareUrl) warn(`[BlackestNight] victory track "${name}" not found — fake-out plays without fanfare`);
  }

  // Banner title + cut-in art off the LIVE actor so renames / art swaps need
  // no code change. Falls back to the pinned assets.
  const skillItem = bossActor?.items?.find?.((i) => /blackest\s+night/i.test(i?.name ?? "")) ?? null;
  const bannerTitle = skillItem?.name ?? "Zero Power: The Blackest Night";
  const cutinUrl = String(bossActor?.system?.props?.cut_in_zero_power ?? "").trim() || ASSETS.cutin;

  const payload = {
    runId: `bn_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    mode, sceneId, tokenId, panTargetId, fanfareUrl, cutinUrl,
  };

  // World-level BGM stop FIRST (propagates to all clients via the playlist
  // doc), then broadcast the visual timeline. Whatever is playing when Geist
  // falls (boss BGM, generic battle BGM, anything) must die for the fake-out
  // to read — sweep EVERY playing playlist sound by handle. playlist.stopAll()
  // is unreliable in this world, so stop per-sound via stopSound instead.
  if (mode === "full") {
    try { await stopBattleBgm(director?.ctx?.payload?.battleConfig?.bgm); }
    catch (e) { warn("[BlackestNight] stopBattleBgm threw", e); }
    try {
      for (const pl of (game.playlists ?? [])) {
        for (const snd of (pl.sounds ?? [])) {
          if (snd.playing) { try { await pl.stopSound(snd); } catch (_) {} }
        }
      }
    } catch (e) { warn("[BlackestNight] playlist sweep threw", e); }
  }

  try { _socket?.executeForOthers?.(ACTION_PLAY, payload); }
  catch (e) { warn("[BlackestNight] broadcast failed", e); }

  await playLocal(payload, { onRise, director, bannerTitle });
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
  const { mode = "full", sceneId, tokenId, panTargetId, fanfareUrl, cutinUrl } = payload ?? {};
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
  let fanfare = null;
  let tokenHide = null;
  let koWorld = null;    // world-anchored PIXI KO sprite (camera-tracking)

  // Dominance crest pips vanish for the duration — a "defeated" boss with a
  // visible super-armor gauge undercuts the fake-out. Local per client (this
  // timeline runs on every client); restored in the finally.
  try { setCrestsHiddenLocal(true); } catch (_) {}

  // Warm the overlay art while the fake victory plays (fire-and-forget).
  preloadImages([ASSETS.ko, ASSETS.revive, cutinUrl]);

  try {
    // ── beat 1: he lies defeated — KO sprite REPLACES the token outright ──
    playSfx(ASSETS.downSfx, 0.8);
    if (bossToken) {
      koWorld = await mountKoWorldSprite(bossToken, ASSETS.ko);
      if (koWorld) tokenHide = hideToken(bossToken);
    }
    await wait(t.downedSettleMs);

    if (mode === "full") {
      // Fake hold — sell "the GM is clicking through the victory screen"
      // before the fanfare/pan begin. Dead air on purpose.
      await wait(t.fakeHoldMs);

      // ── beat 2: the fake victory ──
      if (fanfareUrl) fanfare = startFanfare(fanfareUrl, CFG.full.fanfareVol);
      const target = panTargetId ? canvas.tokens?.get?.(panTargetId) : null;
      if (target) await panTo(target.center, t.victoryPanScale, t.victoryPanMs);
      else await wait(t.victoryPanMs);
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

    if (mode === "full") {
      // Heartbeats keep looping over the body…
      await heartbeatSpan(t.preDimBeatsMs, t.beatIntervalMs, null);

      // ── beat 5: THE VIGIL — the world goes dark, Geist alone stays lit ──
      // Camera is static now: hand the KO sprite off from world-PIXI to a
      // screen-fixed DOM copy that rides ABOVE the dim. DOM mounts first so
      // there's no blink.
      const spriteEl = bossToken ? mountSpriteOverlay(bossToken, ASSETS.ko) : null;
      destroyKoWorldSprite(koWorld); koWorld = null;
      showDim(t.dimInMs);
      await heartbeatSpan(t.vigilMs, t.beatIntervalMs, spriteEl);

      // ── beat 6: screenflash — the body stirs ──
      playSfx(ASSETS.flashSfx, 0.8);
      flash(t.flashSwapMs * 2);
      await wait(t.flashSwapMs);
      swapSpriteOverlay(spriteEl, ASSETS.revive, { floating: true });
      await wait(t.reviveHoldMs);

      // ── beat 7: the Zero Power announces itself ──
      playSfx(ASSETS.cutinSfx, 0.8);
      if (isGM) fireNamecard(gmExtras.bannerTitle);
      await playCutin(cutinUrl, t.cutinInMs, t.cutinHoldMs, t.cutinOutMs);

      // ── beat 7.5: the gather — one final pulse, energy converges into him ──
      heartbeat();
      if (spriteEl) pulseSprite(spriteEl);
      if (bossToken) await playEnergyGather(bossToken, t.gatherMs);

      // ── beat 8: THE RISE ──
      if (isGM && typeof gmExtras.onRise === "function") {
        try { await gmExtras.onRise(); } catch (e) { warn("[BlackestNight] onRise threw", e); }
      }
      unmountSpriteOverlay();
      if (tokenHide) { tokenHide(); tokenHide = null; }
      playSfx(ASSETS.riseSfx, CFG.riseSfxVol);
      if (bossToken) {
        playAuraExplosion(bossToken, t.explodeMs);
        playRiseBurst(bossToken, t.burstMs);
      }
      screenshake(t.shakeMs);
      flash(t.riseFlashMs);
      await wait(Math.max(t.burstMs, t.explodeMs));

      // ── beat 9: Geist's own theme takes over ──
      if (isGM) {
        try { await playBattleBgm({ battleConfig: { bgm: GEIST_BGM } }); }
        catch (e) { warn("[BlackestNight] Geist BGM start threw", e); }
      }
      hideDim(t.vignetteOutMs);
    } else {
      // ── SHORT: heartbeat → rise, no theatrics; Geist BGM already playing ──
      heartbeat();
      await wait(t.dreadHoldMs);
      if (isGM && typeof gmExtras.onRise === "function") {
        try { await gmExtras.onRise(); } catch (e) { warn("[BlackestNight] onRise threw", e); }
      }
      destroyKoWorldSprite(koWorld); koWorld = null;
      if (tokenHide) { tokenHide(); tokenHide = null; }
      // Same action-name banner as the full path — the short beat still
      // announces the skill.
      if (isGM) fireNamecard(gmExtras.bannerTitle);
      playSfx(ASSETS.riseSfx, CFG.riseSfxVol);
      if (bossToken) {
        playAuraExplosion(bossToken, t.explodeMs);
        playRiseBurst(bossToken, t.burstMs);
      }
      screenshake(t.shakeMs);
      flash(t.riseFlashMs);
      await wait(Math.max(t.burstMs, t.explodeMs));
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
    try { unmountSpriteOverlay(); } catch (_) {}
    try { destroyKoWorldSprite(koWorld); } catch (_) {}
    try { if (tokenHide) tokenHide(); } catch (_) {}
    try { stopFanfare(fanfare); } catch (_) {}
    try { hideDim(200); } catch (_) {}
    try { hideVignette(200); } catch (_) {}
    try { document.getElementById(CUTIN_ID)?.remove(); } catch (_) {}
    try { setCrestsHiddenLocal(false); } catch (_) {}
    unlock();
  }
}

// ─── World-anchored KO sprite (camera-tracking replacement for the token) ──
// Used while the camera is MOVING (fake victory pan, snap-pan). Sized off
// the token footprint, flipped to face right (art faces left).
async function mountKoWorldSprite(token, url) {
  try {
    const loader = foundry?.canvas?.loadTexture ?? globalThis.loadTexture;
    const tex = await loader(url).catch(() => null);
    if (!tex || !token?.center) return null;
    const stage = canvas?.stage;
    if (!stage) return null;
    stage.sortableChildren = true;
    const spr = new PIXI.Sprite(tex);
    spr.anchor.set(0.5);
    spr.position.set(token.center.x, token.center.y);
    const s = ((token.h ?? 100) * CFG.spriteScale) / tex.height;
    spr.scale.set(CFG.spriteFlipX ? -s : s, s);
    spr.zIndex = 99000;
    stage.addChild(spr);
    return spr;
  } catch (e) { warn("[BlackestNight] KO world sprite failed", e); return null; }
}

function destroyKoWorldSprite(spr) {
  if (!spr) return;
  try { spr.destroy(); } catch (_) {}
}

// Hide the real token under the overlays. Per the proven recipe: a one-shot
// `renderable=false` gets undone by Foundry's per-frame refresh, so
// re-assert every tick; restore = remove guard + renderFlags refresh.
function hideToken(token) {
  if (!token) return null;
  const guard = () => {
    try { token.renderable = false; if (token.mesh) token.mesh.renderable = false; } catch (_) {}
  };
  canvas.app.ticker.add(guard);
  guard();
  return () => {
    try { canvas.app.ticker.remove(guard); } catch (_) {}
    try {
      token.renderable = true;
      if (token.mesh) token.mesh.renderable = true;
      token.renderFlags?.set?.({ refreshVisibility: true, refreshMesh: true, refreshState: true });
    } catch (_) {}
  };
}

// ─── Sprite overlay (screen-fixed DOM above the dim) ──────────────────────
// Token center/size → screen px via the stage worldTransform. Camera is
// static during overlay beats, so a one-time projection holds.
function tokenScreenRect(token) {
  const wt = canvas.stage.worldTransform;
  const c = wt.apply(new PIXI.Point(token.center.x, token.center.y));
  const scale = canvas.stage.scale.x;
  return { x: c.x, y: c.y, w: (token.w ?? 100) * scale, h: (token.h ?? 100) * scale };
}

// Injected media must zero out border/outline/box-shadow — a global
// stylesheet decorates every <img> with a border otherwise.
function nakedImg(img) {
  img.style.border = "none";
  img.style.outline = "none";
  img.style.boxShadow = "none";
  img.style.background = "transparent";
}

function mountSpriteOverlay(token, url) {
  try {
    unmountSpriteOverlay();
    ensureStyle();
    const r = tokenScreenRect(token);
    const root = document.createElement("div");
    root.id = SPRITE_ID;
    Object.assign(root.style, {
      position: "fixed",
      left: `${Math.round(r.x)}px`,
      top: `${Math.round(r.y)}px`,
      transform: "translate(-50%, -50%)",
      zIndex: "99982",
      pointerEvents: "none",
    });
    const bob = document.createElement("div");    // pulse/bob live here so the
    bob.className = "fud-bn-bob-wrap";            // img keeps its flip transform
    const img = document.createElement("img");
    img.src = url;
    Object.assign(img.style, {
      height: `${Math.round(r.h * CFG.spriteScale)}px`,
      width: "auto",
      transform: CFG.spriteFlipX ? "scaleX(-1)" : "none",
      filter: "drop-shadow(0 0 18px rgba(120,20,160,0.55))",
    });
    nakedImg(img);
    bob.appendChild(img);
    root.appendChild(bob);
    document.body.appendChild(root);
    return root;
  } catch (e) { warn("[BlackestNight] sprite overlay mount failed", e); return null; }
}

function swapSpriteOverlay(root, url, { floating = false } = {}) {
  try {
    const img = root?.querySelector?.("img");
    if (!img) return;
    img.src = url;
    if (floating) root.querySelector(".fud-bn-bob-wrap")?.classList.add("fud-bn-floating");
  } catch (_) {}
}

function unmountSpriteOverlay() {
  try { document.getElementById(SPRITE_ID)?.remove(); } catch (_) {}
}

// One synced heartbeat + sprite pulse. The pulse rides the bob wrapper so it
// composes with the float animation instead of fighting it.
function pulseSprite(root) {
  try {
    const bob = root?.querySelector?.(".fud-bn-bob-wrap");
    const img = root?.querySelector?.("img");
    bob?.animate?.(
      [{ transform: "scale(1)" }, { transform: "scale(1.07)", offset: 0.25 }, { transform: "scale(1)" }],
      { duration: 480, easing: "ease-out" }
    );
    img?.animate?.(
      [{ filter: "drop-shadow(0 0 18px rgba(120,20,160,0.55)) brightness(1)" },
       { filter: "drop-shadow(0 0 34px rgba(200,40,80,0.85)) brightness(1.35)", offset: 0.25 },
       { filter: "drop-shadow(0 0 18px rgba(120,20,160,0.55)) brightness(1)" }],
      { duration: 480, easing: "ease-out" }
    );
  } catch (_) {}
}

// Run heartbeats (SFX + optional sprite pulse) every `intervalMs` across
// `spanMs`, then resolve.
async function heartbeatSpan(spanMs, intervalMs, spriteEl) {
  const t0 = performance.now();
  while (performance.now() - t0 < spanMs) {
    heartbeat();
    if (spriteEl) pulseSprite(spriteEl);
    const remaining = spanMs - (performance.now() - t0);
    await wait(Math.min(intervalMs, Math.max(0, remaining)));
  }
}

// ─── Zero Power cut-in (full-height portrait slides across over the dim) ──
function playCutin(url, inMs, holdMs, outMs) {
  return new Promise((resolve) => {
    try {
      document.getElementById(CUTIN_ID)?.remove();
      const img = document.createElement("img");
      img.id = CUTIN_ID;
      img.src = url;
      Object.assign(img.style, {
        position: "fixed",
        left: "0",
        top: "50%",
        height: `${CFG.cutinHeightVh}vh`,
        width: "auto",
        zIndex: "99983",
        pointerEvents: "none",
        transform: "translate(-110%, -50%)",
        filter: "drop-shadow(0 0 30px rgba(0,0,0,0.8))",
      });
      nakedImg(img);
      document.body.appendChild(img);
      const total = inMs + holdMs + outMs;
      const anim = img.animate(
        [
          { transform: "translate(-110%, -50%)" },
          { transform: "translate(14vw, -50%)",  offset: inMs / total },
          { transform: "translate(20vw, -50%)",  offset: (inMs + holdMs) / total }, // slow drift on hold
          { transform: "translate(110vw, -50%)" },
        ],
        { duration: total, easing: "linear", fill: "forwards" }
      );
      anim.onfinish = () => { try { img.remove(); } catch (_) {} resolve(); };
      setTimeout(() => { try { img.remove(); } catch (_) {} resolve(); }, total + 400); // failsafe
    } catch (e) { warn("[BlackestNight] cutin failed", e); resolve(); }
  });
}

// Action namecard banner — same renderer every BD action card uses. GM-only:
// namecardBroadcast fans out to all clients itself.
function fireNamecard(title) {
  try {
    const render = window.FUCompanion?.api?.namecardBroadcast;
    if (typeof render !== "function") { log("[BlackestNight] namecard renderer missing — skipping"); return; }
    render({
      title: title || "Zero Power: The Blackest Night",
      options: {
        bg: "#000000",
        accent: "#ff5a5a",                    // hostile theme (director-vfx)
        text: ["#ffffff", "#ffd6d6"],
        glowColor: "#ffffff",
        border: "rgba(255,255,255,.10)",
        dropShadow: "0 10px 22px rgba(0,0,0,.35)",
        maskEdges: true, edgeFade: 0.12,
        showIcon: true, iconOverride: "💥", iconScale: 0.93, iconGapPx: 10,
        xAlign: "center", offsetX: 0, offsetY: 64,
        fixedWidth: 640, autoWidth: false, cardScale: 1.0,
        inMs: 350, holdMs: CFG.namecardHoldMs, outMs: 400, enterFrom: "left",
        maxFontPx: 30, minFontPx: 16, letterSpacing: 0.06, fontWeight: 700,
        upperCase: false, fontFamily: "Pixel Operator, system-ui, sans-serif",
        textShadowStrength: 0.0, textStrokePx: 0.1, textStrokeColor: "rgba(0,0,0,0.55)",
        baselineVh: 900, scaleMin: 0.75, scaleMax: 1.75, scaleMode: "vh",
      },
    });
  } catch (e) { warn("[BlackestNight] namecard failed", e); }
}

// ─── Camera ────────────────────────────────────────────────────────────────
// Default battle view: the director's PREP-time viewport snapshot when one
// exists, else the scene's configured Initial View Position. Null → skip.
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

// ─── Audio ─────────────────────────────────────────────────────────────────
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
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { a.volume = 0; } catch (_) {}
      try { a.pause(); } catch (_) {}
      resolve();
    };
    const v0 = a.volume;
    const t0 = performance.now();
    const step = () => {
      if (done) return;
      const k = Math.min(1, (performance.now() - t0) / fadeMs);
      try { a.volume = v0 * (1 - k); } catch (_) {}
      if (k >= 1) finish();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    // Failsafe: rAF is fully paused in a hidden/backgrounded tab, so this fade
    // loop never advances there — and this promise is awaited mid-timeline, so
    // without a guard a tabbed-out client (GM included) hangs the whole revive
    // sequence here until refocus. A throttled setTimeout still fires: force the
    // resolve (and kill the audio) so the timeline can never stall on the fade.
    setTimeout(finish, fadeMs + 500);
  });
}

function stopFanfare(a) {
  try { a?.pause?.(); } catch (_) {}
}

function playSfx(url, vol = 0.7) {
  try {
    const a = new Audio(url);
    a.volume = vol;
    a.play().catch(() => {});
  } catch (_) {}
}

// WebAudio-synthesized "lub-dub" — no asset, cadence-accurate.
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

// ─── DOM: style / dim / vignette / flash / shake / lock ───────────────────
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
.fud-bn-shaking { animation: fud-bn-shake 120ms linear infinite; }
@keyframes fud-bn-float {
  0%,100% { translate: 0 0; }
  50%     { translate: 0 -10px; }
}
.fud-bn-floating { animation: fud-bn-float 2.2s ease-in-out infinite; }`;
  document.head.appendChild(st);
}

// Near-black dim UNDER the sprite overlay — "the world goes dark, Geist
// alone stays lit".
function showDim(fadeInMs) {
  try {
    let el = document.getElementById(DIM_ID);
    if (!el) {
      el = document.createElement("div");
      el.id = DIM_ID;
      Object.assign(el.style, {
        position: "fixed", inset: "0", zIndex: "99981", pointerEvents: "none",
        background: "rgba(2,0,8,0.88)",
        opacity: "0", transition: `opacity ${fadeInMs}ms ease-in`,
      });
      document.body.appendChild(el);
    }
    el.style.transition = `opacity ${fadeInMs}ms ease-in`;
    requestAnimationFrame(() => { el.style.opacity = "1"; });
  } catch (_) {}
}

function hideDim(fadeOutMs) {
  try {
    const el = document.getElementById(DIM_ID);
    if (!el) return;
    el.style.transition = `opacity ${fadeOutMs}ms ease-out`;
    el.style.opacity = "0";
    setTimeout(() => { try { el.remove(); } catch (_) {} }, fadeOutMs + 100);
  } catch (_) {}
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

// Violet-white pop (rise + sprite swap).
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

function preloadImages(urls) {
  for (const u of urls) {
    try {
      if (!u) continue;
      const img = new Image();
      img.src = u;
      img.decode?.().catch(() => {});
    } catch (_) {}
  }
}

// ─── DOM FX layer ──────────────────────────────────────────────────────────
// The rise happens while the near-black dim (DOM) is still up, and PIXI
// renders UNDER every DOM element — so the gather, the aura explosion, and
// the burst all render on the DOM side, ABOVE the dim (per review). Camera
// is static through these beats, so a one-time token→screen projection holds.

// Full-screen 2D canvas for particle work (additive compositing). Each
// effect creates its own and removes it when done.
function makeFxCanvas() {
  const c = document.createElement("canvas");
  c.width = window.innerWidth;
  c.height = window.innerHeight;
  Object.assign(c.style, {
    position: "fixed", inset: "0", zIndex: "99984", pointerEvents: "none",
  });
  document.body.appendChild(c);
  const ctx = c.getContext("2d");
  ctx.globalCompositeOperation = "lighter";
  return { c, ctx, done: () => { try { c.remove(); } catch (_) {} } };
}

function drawGlow(ctx, x, y, r, rgb, alpha) {
  if (r <= 0 || alpha <= 0) return;
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, `rgba(${rgb},${alpha})`);
  g.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
}

const VIOLET = "190,90,255";
const RED    = "255,60,80";
const WHITE  = "255,255,255";

// ─── Energy gather (beat 7.5) — purple motes converge into Geist ──────────
function playEnergyGather(token, durMs) {
  return new Promise((resolve) => {
    try {
      const r = tokenScreenRect(token);
      const fx = makeFxCanvas();
      const R0 = Math.min(window.innerWidth, window.innerHeight) * 0.48;
      const N = 30;
      const parts = [];
      for (let i = 0; i < N; i++) {
        const ang = Math.random() * Math.PI * 2;
        parts.push({
          ang,
          r0: R0 * (0.7 + Math.random() * 0.5),
          size: 6 + Math.random() * 12,
          delay: Math.random() * 0.35,            // staggered departures
          swirl: (Math.random() - 0.5) * 1.6,     // spiral-in curvature
          rgb: (i % 3) ? VIOLET : RED,
        });
      }
      const t0 = performance.now();
      const tick = () => {
        const k = Math.min(1, (performance.now() - t0) / durMs);
        fx.ctx.clearRect(0, 0, fx.c.width, fx.c.height);
        for (const p of parts) {
          const kk = Math.min(1, Math.max(0, (k - p.delay) / (1 - p.delay)));
          const e = kk * kk * kk;                 // easeInCubic — accelerate inward
          const rad = p.r0 * (1 - e);
          const ang = p.ang + p.swirl * e;
          const x = r.x + Math.cos(ang) * rad;
          const y = r.y + Math.sin(ang) * rad;
          drawGlow(fx.ctx, x, y, p.size * (1 + e * 1.5), p.rgb, 0.25 + 0.65 * e);
        }
        // Growing core glow as the energy lands.
        drawGlow(fx.ctx, r.x, r.y, r.h * 0.55 * k, VIOLET, 0.35 * k);
        if (k >= 1) { fx.done(); resolve(); }
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      setTimeout(() => { try { fx.done(); } catch (_) {} resolve(); }, durMs + 500); // failsafe
    } catch (e) { warn("[BlackestNight] energy gather failed", e); resolve(); }
  });
}

// ─── Aura explosion — battle-sprite clone scales out over the screen ──────
// DOM clone (video for webm, img otherwise) of the token's texture source,
// starting at token screen size / CFG.explodeAlpha opacity, scaling out to
// cover the viewport while fading to 0. Renders above the dim.
function playAuraExplosion(token, durMs) {
  try {
    const src = String(token?.document?.texture?.src ?? "");
    if (!src) return;
    const r = tokenScreenRect(token);
    const isVideo = /\.(webm|mp4|m4v|ogv)(\?|$)/i.test(src);
    const el = isVideo ? document.createElement("video") : document.createElement("img");
    if (isVideo) {
      el.muted = true; el.autoplay = true; el.loop = true; el.playsInline = true;
      el.src = src;
      el.play?.().catch(() => {});
    } else {
      el.src = src;
    }
    // Match the rendered mesh's facing (mesh sign folds in mirror + facing).
    const flip = Math.sign(token?.mesh?.scale?.x ?? 1) || 1;
    Object.assign(el.style, {
      position: "fixed",
      left: `${Math.round(r.x)}px`,
      top: `${Math.round(r.y)}px`,
      height: `${Math.round(r.h)}px`,
      width: "auto",
      zIndex: "99983",
      pointerEvents: "none",
      opacity: String(CFG.explodeAlpha),
      transform: `translate(-50%, -50%) scale(${flip}, 1)`,
    });
    nakedImg(el);
    document.body.appendChild(el);
    const growTo = Math.max(3, (window.innerHeight / Math.max(1, r.h)) * 1.2);
    const anim = el.animate(
      [
        { transform: `translate(-50%, -50%) scale(${flip}, 1)`, opacity: CFG.explodeAlpha },
        { transform: `translate(-50%, -50%) scale(${flip * growTo}, ${growTo})`, opacity: 0 },
      ],
      { duration: durMs, easing: "cubic-bezier(0.33, 1, 0.68, 1)", fill: "forwards" } // easeOutCubic
    );
    anim.onfinish = () => { try { el.remove(); } catch (_) {} };
    setTimeout(() => { try { el.remove(); } catch (_) {} }, durMs + 400); // failsafe
  } catch (e) { warn("[BlackestNight] aura explosion failed", e); }
}

// ─── Rise burst — core bloom + shockwave ring + embers (red/violet) ────────
function playRiseBurst(token, durMs) {
  try {
    const r = tokenScreenRect(token);
    const fx = makeFxCanvas();
    const size = Math.max(r.w, r.h);
    const N = 34;
    const parts = [];
    for (let i = 0; i < N; i++) {
      const ang = (i / N) * Math.PI * 2 + Math.random() * 0.35;
      parts.push({
        ang,
        speed: size * (1.2 + Math.random() * 1.6),
        size: size * (0.10 + Math.random() * 0.14),
        drift: (Math.random() - 0.5) * size * 0.4,
        rgb: (i % 2) ? RED : VIOLET,
      });
    }
    const t0 = performance.now();
    const tick = () => {
      const k = Math.min(1, (performance.now() - t0) / durMs);
      const e = 1 - Math.pow(1 - k, 3);   // easeOutCubic
      fx.ctx.clearRect(0, 0, fx.c.width, fx.c.height);
      // Core bloom + expanding shockwave ring.
      drawGlow(fx.ctx, r.x, r.y, size * (0.4 + 2.2 * e) * 0.5, WHITE, 1 - k);
      fx.ctx.strokeStyle = `rgba(${VIOLET},${0.9 * (1 - k)})`;
      fx.ctx.lineWidth = Math.max(1, size * 0.09 * (1 - k));
      fx.ctx.beginPath();
      fx.ctx.arc(r.x, r.y, size * (0.3 + 1.7 * e), 0, Math.PI * 2);
      fx.ctx.stroke();
      // Embers thrown outward with a slight upward lift.
      for (const p of parts) {
        const x = r.x + Math.cos(p.ang) * p.speed * e + p.drift * e;
        const y = r.y + Math.sin(p.ang) * p.speed * e - size * 0.5 * e * e;
        drawGlow(fx.ctx, x, y, p.size * 0.5, p.rgb, 1 - k);
      }
      if (k >= 1) fx.done();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    setTimeout(() => { try { fx.done(); } catch (_) {} }, durMs + 500); // failsafe
  } catch (e) { warn("[BlackestNight] rise burst failed", e); }
}
