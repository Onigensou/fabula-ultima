// ============================================================================
// Nidhogg's fall → his crystal, as played in game (every client).
// The look, the timing and the sound are the user's (docs/nidhogg-boss-design.md
// §8b, mockup v15 FINAL); nidhogg-fall.js holds the clock (fallState), this file
// puts it on the canvas:
//
//   - the SMOKE layer (fall-painter "smoke", in the Worker): one frame over the
//     whole visible window, his body drawn at effect resolution where his token
//     is drawn (the token's own mesh is hidden once the first frame is up; that
//     frame is white, so the hand-over does not show). First fall: OVER every
//     battler (it covers the party too); later fall: just over the backdrop
//     (the party stays over it).
//   - the ARENA VOID (arena-void.js): pitch black under the battlers from the
//     smoke's settle on. The Crystal Round keeps it up from its own state.
//   - the CRYSTAL (crystal-runtime holdCrystal): the crystal host draws it, this
//     show drives it — first fall: fades in SOLID, holds, one quick 3D flash, the
//     soul shows; later fall: pops in (white frame, shake, no shards).
//   - the VOID layer (fall-painter "void"): the blips / pulses / rings round his
//     soul, just above the crystal.
//   - first fall only: the party + summons hidden in the dark and faded back,
//     the camera moves to centre the crystal (unseen, in the black) and back,
//     the HUD hidden through it (shared/hud-curtain.js).
//   - the sounds (FALL_SFX one-shots + the engulf BED), on this show's clock.
//
// The GM starts it everywhere with presentNidhoggFall(), which returns a GM
// wall clock the rules follow ({ at(beatSec), done }) whether or not the GM's
// own window draws; null with no audience (sim / lean / nobody watching): the
// rules then run at once ("skip the show, never the rules").
// ============================================================================

import { warn, log } from "../battle-director/logger.js";
import { getClientOption } from "../shared/client-options.js";
import { shouldRender, hasOtherViewers } from "../battle-director/presentation-clock.js";
import { channel, placeAfter, holdShadow, bufferSprite, takeFrame } from "./crystal-host-lib.js";
import { makeCueTrack, cueUrl, cueUrls } from "../shared/sfx-cues.js";
import { playSfx, playBed, preloadSfx } from "../battle-director/director-sfx.js";
import { hideHud, showHud, setHudLevel } from "../shared/hud-curtain.js";
import { holdArenaVoid } from "./arena-void.js";
import { holdCrystal, crystalPlace } from "./crystal-runtime.js";
import { fallState, fallEnd, FALL_SFX, FALL_BED, bedVolume, SHOW, FALL, BEATS } from "./nidhogg-fall.js";
import { registerBossCycleTransition } from "../battle-director/boss-rules/boss-cycle-styles.js";
import { VOID_FRAME } from "./fall-painter.js";
import { restViewFor, resolveIntent, panTo } from "../battle-director/director-camera.js";

const MODULE_ID = "fabula-ultima-companion";
const MSG = "FU_NIDHOGG_FALL";
/** Scene px per effect px at drawn scale 1, on a 110 px grid (the crystal's, the mockup's "pixel size 2"). */
const pxNow = () => 2 * ((canvas.grid?.size || 110) / 110);
/** The smoke frame's pixel budget: a client zoomed far out gets coarser smoke, never a huge frame. */
const SMOKE_MAX_PX = 1.1e6;
const PAD_SCENE = 40;

export const FALL_SFX_URLS = cueUrls(FALL_SFX.first, FALL_SFX.repeat, [FALL_BED.first, FALL_BED.repeat]);

let _uid = 0;
const _shows = new Set();

/* ── The sprite's pixels (the smoke draws his body from them) ───────────── */

function spritePixels(tex) {
  const base = tex?.baseTexture, src = base?.resource?.source, fr = tex?.frame;
  if (!fr || !(fr.width > 0)) return null;
  const w = Math.round(fr.width), h = Math.round(fr.height);
  try {
    if (src && (src instanceof HTMLImageElement || src instanceof HTMLCanvasElement || (typeof ImageBitmap !== "undefined" && src instanceof ImageBitmap))) {
      const c = document.createElement("canvas"); c.width = w; c.height = h;
      const g = c.getContext("2d", { willReadFrequently: true });
      g.drawImage(src, fr.x, fr.y, fr.width, fr.height, 0, 0, w, h);
      const d = g.getImageData(0, 0, w, h);
      return { width: w, height: h, data: d.data };
    }
  } catch (e) { warn("nidhogg-fall: the sprite could not be read from its image (trying the GPU)", e); }
  try {
    const sp = new PIXI.Sprite(tex);
    const px = canvas.app.renderer.extract.pixels(sp);
    sp.destroy();
    return { width: w, height: h, data: new Uint8ClampedArray(px.buffer ?? px) };
  } catch (e) { warn("nidhogg-fall: the sprite cannot be read at all (no body in the smoke)", e); }
  return null;
}

/** The token's sprite rect where it is DRAWN, in scene px (the 3D camera's spot when it runs). */
function drawnRect(token) {
  const S = globalThis.__ONI_BATTLE_STAGE_3D__;
  const r = S?.drawnMeshBounds?.(token) ?? token.mesh?.getBounds?.();
  if (!r) return null;
  const wt = canvas.stage.worldTransform;
  const a = wt.applyInverse(new PIXI.Point(r.x, r.y)), b = wt.applyInverse(new PIXI.Point(r.x + r.width, r.y + r.height));
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

/* ── One layer: a painter in the Worker + its two buffer sprites ─────────── */

class Layer {
  constructor(name, W, H, fall) {
    this.id = `f${++_uid}:${name}`; this.W = W; this.H = H; this.fall = fall;
    this.ready = false; this.inflight = false; this.seq = 0; this.shown = false; this.frames = 0; this.lastTick = -1;
    this.spare = { color: null, light: null };
    this.root = new PIXI.Container();
    this.root.name = `fud-nidhogg-fall:${name}`; this.root.eventMode = "none"; this.root.visible = false;
    this.color = bufferSprite(W, H); this.light = bufferSprite(W, H);
    this.light.sp.blendMode = PIXI.BLEND_MODES.ADD;
    this.root.addChild(this.color.sp, this.light.sp);
    canvas.primary.addChild(this.root);
    this.#init();
  }
  #init() { channel().init(this.id, { W: this.W, H: this.H }, undefined, (m) => this.#onMessage(m), { painter: "fall", fall: this.fall }); }
  #onMessage(m) {
    if (m.type === "ready") { this.ready = true; this.inflight = false; return; }
    if (m.type === "restart") { this.ready = false; this.inflight = false; this.#init(); return; }
    if (m.type === "error") { this.inflight = false; return; }
    if (m.type !== "frame" || this.dropped) return;
    this.inflight = false;
    try { takeFrame(this.color, m.color, m.cRect, this.W); takeFrame(this.light, m.light, m.lRect, this.W); }
    catch (e) { warn("nidhogg-fall: upload failed", e); }
    this.spare = { color: m.color, light: m.light };
    this.empty = !m.cRect && !m.lRect;
    this.shown = true; this.frames++;
  }
  /** Ask for the frame at fall time T on this tick (one in flight). */
  request(T, now, hz) {
    if (!this.ready || this.inflight || this.dropped) return;
    const tick = Math.floor((now / 1000) * hz);
    if (tick === this.lastTick) return;
    this.lastTick = tick; this.inflight = true;
    const { color, light } = this.spare;
    this.spare = { color: null, light: null };
    channel().draw(this.id, ++this.seq, now / 1000, { T }, color, light);
  }
  drop() {
    if (this.dropped) return;
    this.dropped = true;
    try { channel().drop(this.id); } catch { /* gone */ }
    try { this.root.parent?.removeChild(this.root); this.root.destroy({ children: true, texture: true, baseTexture: true }); } catch { /* gone */ }
  }
}

/* ── The show ──────────────────────────────────────────────────────────── */

export class NidhoggFallShow {
  /**
   * kind: "first" | "repeat"; dragon: his token; crystalTokenId: the crystal's token (drawn by crystal-runtime);
   * clock: () => ms (performance.now by default; rigs step it); startAt: s already gone when this client starts
   * (a late broadcast), so every client is on the GM's beats.
   */
  constructor({ kind, dragon, crystalTokenId, clock = null, startAt = 0 }) {
    this.kind = kind === "first" ? "first" : "repeat";
    this.dragon = dragon; this.dragonId = dragon?.id ?? null; this.crystalTokenId = crystalTokenId ?? null;
    this.clock = clock ?? (() => performance.now());
    this.t0 = this.clock() - Math.max(0, Number(startAt) || 0) * 1000;
    this.end = fallEnd(this.kind);
    this.fxHz = Number(getClientOption("fxFrameRate")) === 30 ? 30 : 60;
    this.touched = new Map();
    this.finished = false; this.camIn = false; this.camOut = false;
    this.done = new Promise((r) => { this.resolveDone = r; });
    this.cues = makeCueTrack(FALL_SFX[this.kind]);
    this.bed = null;
    this.state = fallState(this.kind, 0);

    // the crystal: this show drives it until the end
    if (this.crystalTokenId) this.releaseCrystal = holdCrystal(this.crystalTokenId, () => this.#crystalState());

    // the smoke: the frame over the whole visible window, his body where he is drawn
    try { this.#makeSmoke(); } catch (e) { warn("nidhogg-fall: the smoke could not start (the rest plays)", e); this.smoke = null; }
    // the void's layer round his soul
    try { this.void = new Layer("void", VOID_FRAME.W, VOID_FRAME.H, { layer: "void", kind: this.kind }); }
    catch (e) { warn("nidhogg-fall: the void layer could not start", e); this.void = null; }

    // the screen flash (the later fall's blip)
    this.flash = document.createElement("div");
    this.flash.id = "fud-nidhogg-fall-flash";
    Object.assign(this.flash.style, { position: "fixed", inset: "0", pointerEvents: "none", zIndex: "10040", background: "rgb(255,244,240)", opacity: "0" });
    document.body.appendChild(this.flash);

    // the HUD (first fall): a hold on the curtain, driven from this clock
    if (this.kind === "first") this.hud = hideHud("nidhogg-fall", { level: 1, maxS: this.end + 30 });

    // real-time guard: a stalled ticker (hidden window) must not strand it
    if (!clock) this.timer = setTimeout(() => this.finish(), (this.end - Math.max(0, Number(startAt) || 0) + 3) * 1000);
    log(`nidhogg-fall: ${this.kind} fall begins (${dragon?.name ?? "no dragon"})`);
  }

  #makeSmoke() {
    const token = this.dragon;
    if (!token || token.destroyed || !token.mesh) { this.smoke = null; return; }
    const rect = drawnRect(token), img = spritePixels(token.mesh.texture);
    const st = canvas.stage, scr = canvas.app.renderer.screen, k = st.scale.x || 1;
    const view = { x: st.pivot.x - scr.width / (2 * k) - PAD_SCENE, y: st.pivot.y - scr.height / (2 * k) - PAD_SCENE, w: scr.width / k + 2 * PAD_SCENE, h: scr.height / k + 2 * PAD_SCENE };
    let px = pxNow();
    const n = (view.w / px) * (view.h / px);
    if (n > SMOKE_MAX_PX) px *= Math.sqrt(n / SMOKE_MAX_PX);
    const W = Math.ceil(view.w / px), H = Math.ceil(view.h / px);
    const fall = rect && img
      ? { layer: "smoke", kind: this.kind, img, x0: Math.round((rect.x - view.x) / px), y0: Math.round((rect.y - view.y) / px), k: rect.w / img.width / px, mirror: (token.mesh.scale?.x ?? 1) < 0 }
      : { layer: "smoke", kind: this.kind, img: { width: 1, height: 1, data: new Uint8ClampedArray(4) }, x0: 0, y0: 0, k: 1, mirror: false };
    this.smoke = new Layer("smoke", W, H, fall);
    this.smoke.root.position.set(view.x, view.y);
    this.smoke.root.scale.set(px);
    this.hasBody = !!(rect && img);
    // depth: first fall OVER every battler; later fall just over the backdrop and the void (under the battlers)
    const r = this.smoke.root, bg = canvas.primary.background;
    if (this.kind === "first") { r.elevation = 1e9; r.sortLayer = 1e9; r.sort = 0; r.zIndex = 0; }
    else { r.elevation = bg?.elevation ?? -Infinity; r.sortLayer = bg?.sortLayer ?? 0; r.sort = (bg?.sort || 0) + 3; r.zIndex = 0; }
    canvas.primary.sortDirty = true;
  }

  #crystalState() {
    const c = this.state?.crystal;
    return c ? { ...c } : null;
  }

  /** Seconds since the fall began. */
  D() { return Math.max(0, (this.clock() - this.t0) / 1000); }
  /** Rigs: jump to fall time D. */
  seek(D) { this.t0 = this.clock() - D * 1000; }

  /** Every display frame. */
  step() {
    if (this.finished) return;
    const now = this.clock(), D = Math.max(0, (now - this.t0) / 1000), s = (this.state = fallState(this.kind, D));

    // ── sound ──
    this.cues.step(D, (c, url) => playSfx(url, c.vol));
    const bed = FALL_BED[this.kind], bv = bedVolume(bed, D);
    if (bv > 0 && !this.bed && D - bed.from < 0.5) this.bed = playBed(cueUrl(bed.file), { vol: bv, offset: D - bed.from });
    if (this.bed) { if (D >= bed.to) { this.bed.stop(); this.bed = null; } else this.bed.setVolume(bv); }

    // ── the smoke ──
    if (this.smoke) {
      const on = s.smoke;
      this.smoke.root.visible = on && this.smoke.shown && !this.smoke.empty;
      if (on) this.smoke.request(D, now, this.fxHz);
      else if (!this.smoke.dropped) this.smoke.drop();
    }
    // his token: hidden once the smoke draws his body (from its first frame), until the end
    const hideDragon = !this.smoke || !this.hasBody || this.smoke.shown || D > 0.5;
    if (this.dragon && !this.dragon.destroyed && this.dragon.mesh && hideDragon) {
      try { this.dragon.mesh.alpha = 0; } catch { /* gone */ }
      holdShadow(this.dragon, 0);
    }

    // ── the arena void ──
    if (s.arenaBlack && !this.releaseVoid) this.releaseVoid = holdArenaVoid("nidhogg-fall");

    // ── the void layer, at his soul, just above the crystal ──
    const place = this.crystalTokenId ? crystalPlace(this.crystalTokenId) : null;
    if (this.void) {
      const on = !!s.void && !!place;
      if (on) {
        const k = place.px * place.m;
        this.void.root.position.set(place.soul.x - (VOID_FRAME.W / 2) * k, place.soul.y - (VOID_FRAME.H / 2) * k);
        this.void.root.scale.set(k);
        const above = place.root ?? canvas.tokens.get(this.crystalTokenId)?.mesh;
        if (above) placeAfter(this.void.root, above);
        this.void.request(D, now, this.fxHz);
      }
      this.void.root.visible = on && this.void.shown && !this.void.empty;
    }

    // ── first fall: the party in the dark, the camera, the HUD ──
    this.#party(s.party);
    if (this.hud) setHudLevel(this.hud, s.hud);
    if (this.kind === "first") this.#camera(D, place);

    // ── the blip's screen flash (later fall) ──
    this.flash.style.opacity = s.screenFlash > 0 ? s.screenFlash.toFixed(3) : "0";

    if (D >= this.end) this.finish();
  }

  #camera(D, place) {
    const S = SHOW.first;
    if (!this.camIn && D >= S.camIn[0] && D < S.camOut[0]) {
      this.camIn = true;
      if (place) {
        try {
          const v = resolveIntent({ point: place.soul, zoom: 1 }, canvas.scene);
          panTo(v, { duration: (S.camIn[1] - S.camIn[0]) * 1000, scene: canvas.scene }).catch(() => {});
        } catch (e) { warn("nidhogg-fall: the camera could not move in", e); }
      }
    }
    if (!this.camOut && D >= S.camOut[0]) {
      this.camOut = true;
      try { panTo(restViewFor(canvas.scene), { duration: (S.camOut[1] - S.camOut[0]) * 1000, scene: canvas.scene }).catch(() => {}); }
      catch (e) { warn("nidhogg-fall: the camera could not move back", e); }
    }
  }

  #party(a) {
    for (const t of canvas.tokens?.placeables ?? []) {
      if (t.id === this.crystalTokenId || t.id === this.dragonId || t.destroyed || !t.mesh) continue;
      if (a >= 0.999) {
        if (this.touched.has(t.id)) { this.touched.delete(t.id); this.#showToken(t); }
        continue;
      }
      this.touched.set(t.id, t);
      try { t.mesh.alpha = (t.alpha ?? 1) * a; } catch { /* gone */ }
      holdShadow(t, a);
    }
  }
  #showToken(t) {
    if (!t || t.destroyed) return;
    try { if (t.mesh) t.mesh.alpha = t.alpha ?? 1; } catch { /* gone */ }
    holdShadow(t, 1);
    try { t.renderFlags?.set?.({ refreshState: true }); } catch { /* older core */ }
  }

  /** Over (or torn down): everything put back; the states (out of play, the Crystal Round's void) carry on. */
  finish() {
    if (this.finished) return;
    this.finished = true;
    clearTimeout(this.timer);
    try { this.bed?.stop(); } catch { /* gone */ }
    this.smoke?.drop(); this.void?.drop();
    try { this.releaseCrystal?.(); } catch { /* gone */ }
    try { this.releaseVoid?.(); } catch { /* gone */ }
    if (this.hud) showHud(this.hud, { fade: 0 });
    for (const t of this.touched.values()) this.#showToken(t);
    this.touched.clear();
    // his token goes back to Foundry (out-of-play-render hides it from here on, while he is down)
    if (this.dragon && !this.dragon.destroyed) this.#showToken(this.dragon);
    try { this.flash.remove(); } catch { /* gone */ }
    _shows.delete(this);
    this.resolveDone();
    log(`nidhogg-fall: ${this.kind} fall over`);
  }

  status() {
    const D = this.D();
    return { kind: this.kind, D: +D.toFixed(2), end: this.end, smoke: this.smoke ? { W: this.smoke.W, H: this.smoke.H, frames: this.smoke.frames, body: this.hasBody } : null,
      void: this.void ? { frames: this.void.frames } : null, hud: +this.state.hud.toFixed(3), party: +this.state.party.toFixed(3), cam: +this.state.cam.toFixed(3), finished: this.finished };
  }
}

/* ── Every client ──────────────────────────────────────────────────────── */

let _ticker = null, _tickerOwner = null;
function startTicker() {
  const tk = canvas?.app?.ticker ?? PIXI.Ticker.shared;
  if (_ticker && _tickerOwner === tk) return;
  if (_ticker) { try { _tickerOwner.remove(_ticker); } catch { /* gone */ } }
  _ticker = () => { for (const sh of [..._shows]) { try { sh.step(); } catch (e) { warn("nidhogg-fall: step threw", e); sh.finish(); } } };
  _tickerOwner = tk;
  // just before the render, after the crystal host (its hold reads this frame's state)
  tk.add(_ticker, null, (PIXI.UPDATE_PRIORITY?.LOW ?? -25) + 2);
}

/**
 * Play the fall on THIS client. spec: { kind, sceneId, dragonTokenId, crystalTokenId }. Resolves when it is
 * over here (at once where nothing is drawn). opts.clock: a stepped clock for rigs.
 */
export function playNidhoggFallLocal(spec, opts = {}) {
  try {
    if (!spec || !canvas?.ready || typeof PIXI === "undefined" || !shouldRender()) return Promise.resolve();
    if (spec.sceneId && canvas.scene?.id !== spec.sceneId) return Promise.resolve();
    const dragon = canvas.tokens.get(spec.dragonTokenId) ?? null;
    const show = new NidhoggFallShow({ kind: spec.kind, dragon, crystalTokenId: spec.crystalTokenId, clock: opts.clock ?? null, startAt: opts.startAt ?? 0 });
    _shows.add(show);
    startTicker();
    return show.done;
  } catch (e) {
    warn("nidhogg-fall: the show could not start", e);
    return Promise.resolve();
  }
}

/**
 * GM: start the fall on every client and return its clock, or null when nobody is watching (the rules then run at
 * once). at(s) resolves at the fall's second s on the GM's wall clock; done when the fall is over (and the GM's own
 * show, if it draws, has finished).
 */
export function presentNidhoggFall(spec) {
  try { if (!shouldRender() && !hasOtherViewers()) return null; } catch { return null; }
  const kind = spec?.kind === "first" ? "first" : "repeat";
  const full = { ...spec, kind };
  try { game.socket?.emit?.(`module.${MODULE_ID}`, { type: MSG, spec: full }); } catch (e) { warn("nidhogg-fall: broadcast failed", e); }
  const local = playNidhoggFallLocal(full);
  const t0 = performance.now(), end = fallEnd(kind);
  const until = (s) => new Promise((r) => setTimeout(r, Math.max(0, t0 + s * 1000 - performance.now())));
  return { kind, at: (s) => until(s), done: Promise.all([until(end), local]).then(() => {}) };
}

/* ── As a Boss Cycle transition (boss-rules/boss-cycle-styles.js) ─────────── */

/** Nidhogg's settings name these (bossCycle.transition.first / .repeat). */
export const NIDHOGG_TRANSITIONS = Object.freeze({ first: "nidhogg-fall-first", repeat: "nidhogg-fall-repeat" });
for (const kind of ["first", "repeat"]) {
  registerBossCycleTransition(NIDHOGG_TRANSITIONS[kind], {
    present: (spec) => presentNidhoggFall({ kind, sceneId: spec.sceneId, dragonTokenId: spec.bossTokenId, crystalTokenId: spec.coreTokenId }),
    // his hold on the souls breaks on the white flash; he is gone at the black; the crystal is in play as it comes in
    beats: () => ({ down: FALL[kind].flash, hidden: BEATS[kind].black, reveal: BEATS[kind].crystal }),
  });
}

let _hooked = false;
export function initNidhoggFall() {
  if (_hooked || typeof Hooks === "undefined") return;
  _hooked = true;
  preloadSfx(FALL_SFX_URLS).catch(() => {});
  game.socket?.on?.(`module.${MODULE_ID}`, (m) => { if (m?.type === MSG) playNidhoggFallLocal(m.spec); });
  Hooks.on("canvasTearDown", () => { for (const sh of [..._shows]) sh.finish(); });
  globalThis.__FU_NIDHOGG_FALL__ = {
    /** Play it on THIS client only (no rules): { kind, dragonTokenId, crystalTokenId }. */
    play: (spec, opts) => playNidhoggFallLocal({ sceneId: canvas.scene?.id, ...spec }, opts),
    shows: () => [..._shows],
    status: () => [..._shows].map((s) => s.status()),
  };
}
