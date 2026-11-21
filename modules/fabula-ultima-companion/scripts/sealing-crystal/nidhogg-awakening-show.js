// ============================================================================
// Nidhogg's battle opening, "nidhogg-awakening" — the show (every client). Clock + camera plan: nidhogg-awakening.js;
// the runtime that calls it: battle-director/battle-opening.js; beats 1-2: nidhogg-crack-out.js.
//
// Claimed by an enemy whose actor carries flags["fabula-ultima-companion"].battleOpening = "nidhogg-awakening" (the
// dragon, written by tools/fvtt-playwright/scripts/_author-nidhogg-dragon.mjs).
//
// From the black the crack-out ends on, on THIS client, on its own clock:
//   - the HUD is hidden (hud-curtain), the arena held black (arena-void), the turn glow off, the 3D camera CLAIMED
//     and driven every frame (camera.set + the 2D view; his drawn points aimed through predictDrawn), the player's
//     camera fence suspended;
//   - the close-ups (claw, then the wing, mirrored) are his live token (3D rig) out of the dark: the arena black
//     behind him, the black DOM cover fading to a vignette and back to black at each cut; the wing spreads (rig
//     motion wingSpread);
//   - the roar: Nidhogg's return smoke in OPENING MODE (nidhogg-return-show.js: the veil he is hidden in, blown off
//     him by the roar; his body in it is the live rig, which roars, its jaw snap on the smoke's blast), the camera
//     at 35 degrees on his front, his whole body fitted;
//   - 1 s after the roar: the camera eases back to the battle position (the rest framing, yaw / tilt 0); there the
//     party, the guests and any other enemy fade in, the HUD comes back, and `arrived` resolves (the GM persists the
//     tokens and the usual start goes on: the HUD plates, BATTLE START).
// Every step is guarded: a step that throws is skipped, a show that stalls is finished by a real-time guard, and
// finish() always puts the camera, the HUD, the arena and his token back.
// ============================================================================

import { warn, log } from "../battle-director/logger.js";
import { registerBattleOpening } from "../battle-director/battle-opening-styles.js";
import { awakeningPlan, awakeningBeats, awakeningSfx, coverAt, cameraAt, pointOnRect, viewFor, blendView, solvePlaced, screenAt, AWAKENING } from "./nidhogg-awakening.js";
import { makeCueTrack, cueUrls } from "../shared/sfx-cues.js";
import { makeCloseupSmoke, OPENING_SMOKE, OPENING_SMOKE_LIT, CLOSE_SMOKE } from "./opening-smoke.js";
import { cloudFast } from "./smoke-cloud.js";
import { createFrame, clearFrame, painterFor } from "../battle-director/pixel-entrance/pixelfx/core/index.js";
import { playSfx, preloadSfx } from "../battle-director/director-sfx.js";
import { nidhoggCrackOut, CRACK_OUT_MS } from "./nidhogg-crack-out.js";
import { playNidhoggReturnLocal } from "./nidhogg-return-show.js";
import { returnPlan } from "./nidhogg-return.js";
import { holdArenaVoid } from "./arena-void.js";
import { holdShadow } from "./crystal-host-lib.js";
import { hideHud, showHud } from "../shared/hud-curtain.js";
import { holdTurnGlowOff } from "../battle-director/turn-glow.js";
import { whenRig } from "../creature-rig/rig-host.js";
import { restViewFor } from "../battle-director/director-camera.js";
import { suspendCamera } from "../battle-director/camera-authority.js";

export const NIDHOGG_AWAKENING = "nidhogg-awakening";
const NAME = NIDHOGG_AWAKENING;
const TOKEN_PARTS = ["bars", "nameplate", "effects", "tooltip", "border", "targetArrows", "targetPips"];
const RETURN_OPENING = Object.freeze({ live: true, camera: false, hud: false, glow: false, rings: false, look: false });

const stage3d = () => globalThis.FUCompanion?.api?.battleStage3d ?? null;
const S3 = () => globalThis.__ONI_BATTLE_STAGE_3D__ ?? null;
const _shows = new Set();

class AwakeningShow {
  /** ctx: battle-opening.js's ({ spec, scene, boss, party, others, cover, fadeIn }); opts.clock: a stepped clock (rigs). */
  constructor(ctx, opts = {}) {
    this.ctx = ctx; this.boss = ctx.boss && !ctx.boss.destroyed ? ctx.boss : null;
    this.P = awakeningPlan(opts.plan ?? {});
    this.clock = opts.clock ?? (() => performance.now());
    this.stepped = !!opts.clock;
    this.t0 = this.clock();
    this.fired = new Set();
    this.finished = false; this.arrivedFlag = false;
    this.flips = [];
    this.arrived = new Promise((r) => { this.resolveArrived = r; });
    this.done = new Promise((r) => { this.resolveDone = r; });
    this.sceneId = canvas.scene?.id ?? null;
    this.rest = restViewFor(canvas.scene);
    this.rig = null;
    this.cam = { landed: false, frames: 0, last: null, revealView: null, maxErr: 0 };
    // the sound (awakeningSfx; the roar is the return smoke's own cue)
    this.cues = makeCueTrack(awakeningSfx(this.P).filter((c) => c.owner !== "return"));
    this.sfx = [];

    // holds: HUD hidden, arena black, no turn glow, the camera ours
    try { this.hud = hideHud(NAME, { fade: 0, maxS: this.P.total + 30 }); } catch { this.hud = null; }
    try { this.releaseVoid = holdArenaVoid(NAME); } catch { this.releaseVoid = null; }
    try { this.releaseGlow = holdTurnGlowOff(); } catch { this.releaseGlow = null; }
    try { this.releaseClaim = stage3d()?.camera?.claim?.(NAME) ?? null; } catch { this.releaseClaim = null; }
    try { this.resumeCamera = suspendCamera(); } catch { this.resumeCamera = null; }

    // his token: shown on this client (the party stays hidden until the arrival); his 2D spot read once, outside a render
    if (this.boss) {
      try { this.boss.alpha = 1; } catch { /* gone */ }
      this.rect2D = this.#rect2D(this.boss);
      this.mirrored = (this.boss.mesh?.scale?.x ?? 1) < 0;
      try { whenRig(this.boss, 4000).then((r) => { if (!this.finished) this.rig = r; }).catch(() => {}); } catch { /* none */ }
    }

    // the close-ups' backdrop: a faint dark-green haze behind the subject over the black arena (his wings are black:
    // on pure black they vanish), just above the void plate, under every battler
    try { this.#makeHaze(); } catch (e) { warn("nidhogg-awakening: no haze", e); this.haze = null; }
    // the close-ups' smoke (opening-smoke.js): dark wisps drifting in front of him, screen-space, under the cover
    try { this.#makeSmoke(); } catch (e) { warn("nidhogg-awakening: no close-up smoke", e); this.smoke = null; }
    this.flipped = false;

    this.tick = () => { try { this.step(); } catch (e) { warn("nidhogg-awakening: step threw", e); this.finish(); } };
    this.tk = canvas.app?.ticker ?? PIXI.Ticker.shared;
    // after the return show (its +2 lays his mesh out this frame), before the render (the 3D camera reads our shot)
    this.tk.add(this.tick, null, (PIXI.UPDATE_PRIORITY?.LOW ?? -25) + 3);
    if (!this.stepped) this.timer = setTimeout(() => { warn("nidhogg-awakening: real-time guard"); this.finish(); }, (this.P.total + 6) * 1000);
    _shows.add(this);
    log(`nidhogg-awakening: begins (${this.boss?.name ?? "no boss token"}, arrive ${this.P.arrive.toFixed(2)} s)`);
  }

  #makeSmoke() {
    const PX = CLOSE_SMOKE.PX, W = Math.ceil(window.innerWidth / PX), H = Math.ceil(window.innerHeight / PX);
    const el = document.createElement("canvas");
    el.id = "fud-opening-smoke"; el.width = W; el.height = H;
    Object.assign(el.style, { position: "fixed", inset: "0", width: "100vw", height: "100vh", zIndex: "99998", pointerEvents: "none", imageRendering: "pixelated", display: "none" });
    document.body.appendChild(el);
    const frame = createFrame(W, H);
    // the claw's wisps drift right, the wing's left: the wing shot is the claw shot flipped, its smoke too
    this.smoke = { el, ctx: el.getContext("2d"), frame, img: new ImageData(new Uint8ClampedArray(frame.color.buffer), W, H), W, H, tick: -1, frames: 0,
      claw: makeCloseupSmoke(W, H, { seed: 11, dir: 1 }), wing: makeCloseupSmoke(W, H, { seed: 23, dir: -1 }) };
  }

  /** The close-up smoke this frame (painted at 30 Hz while a close-up is up). */
  #paintSmoke(t) {
    const sm = this.smoke, P = this.P;
    if (!sm) return;
    const on = t >= P.claw0 - 0.25 && t < P.black0 + 0.05 && !!this.boss;
    sm.el.style.display = on ? "" : "none";
    if (!on) return;
    const tick = Math.floor(t * 30);
    if (tick === sm.tick) return;
    sm.tick = tick;
    const wing = t >= P.wing0, cam = cameraAt(t, P), gen = wing ? sm.wing : sm.claw;
    // a shot's wisps have been drifting for a while when it fades up (never an empty frame filling in)
    const lt = (t - (wing ? P.wing0 : P.claw0)) + 3;
    clearFrame(sm.frame);
    cloudFast(painterFor(sm.frame), gen.lobesAt(lt, screenAt(cam)), OPENING_SMOKE, OPENING_SMOKE_LIT, { dens: CLOSE_SMOKE.dens, max: CLOSE_SMOKE.max, steps: CLOSE_SMOKE.steps });
    sm.ctx.putImageData(sm.img, 0, 0);
    sm.frames++;
  }

  /** The wing shot is the claw shot with its IMAGE flipped horizontally: the canvas is mirrored for that shot only. */
  #flip(on) {
    if (on === this.flipped) return;
    this.flipped = on;
    const v = canvas?.app?.view;
    if (!v) return;
    if (on) { this.viewTransform = v.style.transform; v.style.transform = "scaleX(-1)"; }
    else v.style.transform = this.viewTransform ?? "";
  }

  #makeHaze() {
    const prim = canvas.primary, bg = prim?.background;
    if (!prim) { this.haze = null; return; }
    const c = document.createElement("canvas"); c.width = c.height = 256;
    const g = c.getContext("2d"), gr = g.createRadialGradient(128, 128, 0, 128, 128, 128);
    gr.addColorStop(0, "rgba(46,60,52,1)"); gr.addColorStop(0.35, "rgba(24,32,28,1)"); gr.addColorStop(0.7, "rgba(8,11,9,1)"); gr.addColorStop(1, "rgba(0,0,0,1)");
    g.fillStyle = gr; g.fillRect(0, 0, 256, 256);
    const h = new PIXI.Sprite(PIXI.Texture.from(c));
    h.anchor.set(0.5); h.eventMode = "none"; h.name = "fud-nidhogg-awakening:haze"; h.visible = false;
    h.elevation = bg?.elevation ?? -Infinity; h.sortLayer = bg?.sortLayer ?? 0; h.sort = (bg?.sort || 0) + 2;
    prim.addChild(h); prim.sortDirty = true;
    this.haze = h;
  }

  /** His mesh's rect on his 2D spot (scene px): its bounds read outside a render (the 3D camera moves it only inside one). */
  #rect2D(t) {
    try {
      const r = t.mesh?.getBounds?.();
      if (!r || !(r.width > 0)) throw new Error("no bounds");
      const wt = canvas.stage.worldTransform;
      const a = wt.applyInverse(new PIXI.Point(r.x, r.y)), b = wt.applyInverse(new PIXI.Point(r.x + r.width, r.y + r.height));
      return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
    } catch {
      return { x: t.document.x, y: t.document.y, w: t.w, h: t.h };
    }
  }

  /** Seconds since the black. */
  T() { return Math.max(0, (this.clock() - this.t0) / 1000); }
  /** Rigs: jump to show time t. */
  seek(t) { this.t0 = this.clock() - t * 1000; }

  #once(key, cond, fn) {
    if (!cond || this.fired.has(key)) return;
    this.fired.add(key);
    this.flips.push([key, +this.T().toFixed(2)]);
    try { fn(); } catch (e) { warn(`nidhogg-awakening: beat ${key} threw`, e); }
  }

  step() {
    if (this.finished) return;
    if (!canvas?.ready || canvas.scene?.id !== this.sceneId) { this.finish(); return; }
    const t = this.T(), P = this.P, b = this.boss;

    // ── the cover (until the arrival drops it) ──
    if (!this.arrivedFlag) { const cv = coverAt(t, P); this.ctx.cover.set(cv.black, { vignette: cv.vignette }); }

    // ── his token: shown (the return show owns it from the smoke until its end) ──
    if (b && !b.destroyed && !this.returnLive()) {
      try { if (b.alpha !== 1) b.alpha = 1; if (b.mesh) b.mesh.alpha = 1; } catch { /* gone */ }
      if (!this.arrivedFlag) for (const k of TOKEN_PARTS) { const o = b[k]; if (o && !o.destroyed && o.visible) o.visible = false; }
      // no floor shadow in the black void of the close-ups; from the smoke on the return show hands it back
      if (!this.fired.has("smoke")) holdShadow(b, 0);
    }

    // ── the close-ups: the wing shot's image flipped, the smoke in front ──
    this.#flip(t >= P.wing0 && t < P.black0);
    try { this.#paintSmoke(t); } catch (e) { warn("nidhogg-awakening: smoke paint threw", e); try { this.smoke?.el.remove(); } catch { /* gone */ } this.smoke = null; }

    // ── the haze behind the close-ups (gone from the black before the roar) ──
    if (this.haze && !this.haze.destroyed) {
      const on = t < P.black0 + 0.05 && !!b;
      this.haze.visible = on;
      if (on) {
        const cam = cameraAt(t, P), st = canvas.stage, scr = canvas.app.renderer.screen, k = st.scale.x || 1;
        const at = cam.at ?? { x: 0.5, y: 0.5 };
        this.haze.position.set(st.pivot.x + (at.x - 0.5) * scr.width / k, st.pivot.y + (at.y - 0.5) * scr.height / k);
        this.haze.width = this.haze.height = (1.5 * Math.max(scr.width, scr.height)) / k;
      }
    }

    // ── the sound ──
    this.cues.step(t, (c, url) => { playSfx(url, c.vol); this.sfx.push([c.file, +t.toFixed(2)]); });

    // ── the beats ──
    this.#once("spread", t >= P.spreadAt, () => { this.rig?.play("wingSpread", {}); });
    this.#once("smoke", t >= P.smoke0, () => this.#startReturn());
    this.#once("void-handoff", t >= P.smoke0 + 0.4, () => { try { this.releaseVoid?.(); } catch { /* gone */ } this.releaseVoid = null; });
    this.#once("roar", t >= P.roar0, () => { this.roar = this.rig?.play("roar", { hold: AWAKENING.roarHold }) ?? null; });
    this.#once("arrive", t >= P.arrive, () => this.#arrive());

    // ── the camera ──
    try { this.#camera(t); } catch (e) { warn("nidhogg-awakening: the camera could not move", e); this.#landCamera(); }

    if (t >= P.fadeEnd + 0.3 && this.arrivedFlag) this.finish();
  }

  /** The return show (opening mode) is drawing him right now. */
  returnLive() { return !!this.retShow && !this.retShow.finished; }

  #startReturn() {
    if (!this.boss) return;
    const RP = returnPlan();
    const startAt = RP.pierce - AWAKENING.lead;
    const spec = { sceneId: this.sceneId, dragonTokenId: this.boss.id, crystalTokenId: null, plan: {}, opening: RETURN_OPENING };
    const opts = this.stepped ? { startAt, clock: this.clock } : { startAt };
    const before = new Set(globalThis.__FU_NIDHOGG_RETURN__?.shows?.() ?? []);
    this.ret = playNidhoggReturnLocal(spec, opts);
    this.retShow = (globalThis.__FU_NIDHOGG_RETURN__?.shows?.() ?? []).find((s) => !before.has(s)) ?? null;
    if (!this.retShow) warn("nidhogg-awakening: the roar's smoke did not start (he is shown plainly)");
  }

  /** His 2D feet (canvas px): where the 3D camera stands his card on the floor. */
  #feet() { const b = this.boss; return { x: b.document.x + b.w / 2, y: b.document.y + b.h }; }

  /**
   * The camera this frame. Under the 3D camera every shot is a PLACED shot (a real camera standing round him; the 2D
   * view stays on the battle framing), solved through the real rig so his painting's point lands where the plan puts
   * it (solvePlaced); the move back is the placed camera's own hand-back (stand 1 -> 0). Off the 3D camera (Battle
   * depth off / a 2D scene): the same framing with the flat 2D view (zoom, clamped to the canvas).
   */
  #camera(t) {
    const c = this.cam;
    if (c.landed || !this.rest) return;
    const cam = cameraAt(t, this.P), api = stage3d()?.camera;
    if (this.flips.at(-1)?.[0] !== `cam:${cam.shot}`) this.flips.push([`cam:${cam.shot}`, +t.toFixed(2)]);
    if (cam.shot === "rest") { this.#landCamera(); return; }
    const model = api?.model?.() ?? null, sr = canvas.app.renderer.screen;
    if (model && S3()?.cameraLive?.() !== false && this.boss) {
      const rest = model.rest ?? this.rest;
      if (!c.restPanned) { try { canvas.pan({ x: rest.x, y: rest.y, scale: rest.scale }); } catch { /* gone */ } c.restPanned = true; }
      if (cam.shot === "back") {
        try { api.set({ ...(c.lastShot ?? {}), stand: cam.stand, yaw: 0, tilt: 0, push: 1 }); } catch { /* off */ }
      } else {
        const S = solvePlaced({ model: { ...model, rest }, feet: this.#feet(), rect: this.rect2D, mirrored: this.mirrored, screen: { w: sr.width / rest.scale, h: sr.height / rest.scale }, cam });
        try { api.set({ ...S.shot, yaw: 0, tilt: 0, push: 1 }); } catch { /* off */ }
        c.lastShot = S.shot; c.err = +S.err.toFixed(2); c.solve = { lens: +S.shot.lens.toFixed(3), dist: +S.dist.toFixed(2), eye: +S.eye.toFixed(2), tallM: +S.tallM.toFixed(2), lookH: +S.shot.lookH.toFixed(2) };
      }
      c.mode = "placed"; c.frames++; c.shot = cam.shot;
      return;
    }
    // flat: the 2D view does the framing
    c.mode = "flat";
    const scr = { w: sr.width, h: sr.height }, rest = this.rest;
    const hi = Number(CONFIG?.Canvas?.maxZoom) || 3, lo = rest.scale * 0.5;
    let v;
    if (cam.shot === "back") { c.revealView ??= c.last ?? { ...rest }; v = blendView(c.revealView, rest, 1 - cam.stand); }
    else if (!this.boss) v = { ...rest };
    else {
      const scale = Math.min(hi, Math.max(lo, (((cam.fit ?? cam.span) || 1) * scr.h) / this.rect2D.h));
      v = viewFor(pointOnRect(this.rect2D, cam.fit != null ? { u: 0.5, v: 0.5 } : cam.uv, this.mirrored, 0), cam.at, scale, scr);
      // keep the window on the canvas (outside it is Foundry's black)
      const d = canvas.dimensions, hw = scr.w / (2 * scale), hh = scr.h / (2 * scale);
      if (d) { v.x = Math.min(Math.max(v.x, hw), Math.max(hw, d.width - hw)); v.y = Math.min(Math.max(v.y, hh), Math.max(hh, d.height - hh)); }
    }
    try { canvas.pan({ x: v.x, y: v.y, scale: v.scale }); } catch { /* gone */ }
    c.last = { ...v }; c.frames++; c.shot = cam.shot;
  }

  /** The camera at the battle position (rest framing, yaw / tilt 0) and handed back. */
  #landCamera() {
    const c = this.cam;
    if (c.landed) return;
    c.landed = true;
    try { stage3d()?.camera?.set?.({ stand: 0, yaw: 0, tilt: 0, push: 1 }); } catch { /* off */ }
    if (this.rest && canvas?.ready && canvas.scene?.id === this.sceneId) { try { canvas.pan({ x: this.rest.x, y: this.rest.y, scale: this.rest.scale }); } catch { /* gone */ } }
    try { this.releaseClaim?.(); } catch { /* gone */ }
    this.releaseClaim = null;
    try { this.resumeCamera?.(); } catch { /* gone */ }
    this.resumeCamera = null;
  }

  /** At the battle position: the party (+ guests, + any other enemy) fade in, the HUD comes back. */
  #arrive() {
    this.arrivedFlag = true;
    this.#landCamera();
    this.ctx.cover.drop();
    if (this.hud) { try { showHud(this.hud, { fade: 0.45 }); } catch { /* gone */ } this.hud = null; }
    if (this.boss) holdShadow(this.boss, 1);
    const who = [...(this.ctx.party ?? []), ...(this.ctx.others ?? [])];
    Promise.resolve(this.ctx.fadeIn(who, { ms: AWAKENING.fadeIn.ms, stagger: AWAKENING.fadeIn.stagger }))
      .catch((e) => warn("nidhogg-awakening: fade-in threw", e))
      .finally(() => this.resolveArrived(true));
    log("nidhogg-awakening: at the battle position");
  }

  /** Over (or torn down / rescued): everything put back. */
  finish() {
    if (this.finished) return;
    this.finished = true;
    clearTimeout(this.timer);
    try { this.tk?.remove(this.tick); } catch { /* gone */ }
    try { this.haze?.parent?.removeChild(this.haze); this.haze?.destroy({ texture: true, baseTexture: true }); } catch { /* gone */ }
    this.haze = null;
    this.#flip(false);
    try { this.smoke?.el?.remove(); } catch { /* gone */ }
    this.smoke = null;
    this.#landCamera();
    try { this.releaseVoid?.(); } catch { /* gone */ }
    try { this.releaseGlow?.(); } catch { /* gone */ }
    if (this.hud) { try { showHud(this.hud, { fade: 0 }); } catch { /* gone */ } this.hud = null; }
    try { this.ctx.cover.drop(); } catch { /* gone */ }
    const b = this.boss;
    if (b && !b.destroyed) {
      try { b.alpha = 1; if (b.mesh) b.mesh.alpha = 1; } catch { /* gone */ }
      holdShadow(b, 1);
      try { b.renderFlags?.set?.({ refreshState: true, refreshBars: true, refreshNameplate: true, refreshEffects: true }); } catch { /* older core */ }
    }
    if (!this.arrivedFlag) {
      // rescued before the arrival: everyone shown at once
      for (const p of [...(this.ctx.party ?? []), ...(this.ctx.others ?? [])]) { if (p && !p.destroyed) { try { p.alpha = 1; if (p.mesh) p.mesh.alpha = 1; } catch { /* gone */ } } }
      this.resolveArrived(false);
    }
    _shows.delete(this);
    this.resolveDone(true);
    log("nidhogg-awakening: over");
  }

  status() {
    const t = this.T();
    return { t: +t.toFixed(2), arrive: +this.P.arrive.toFixed(2), finished: this.finished, arrived: this.arrivedFlag, flips: this.flips.slice(),
      cam: { shot: this.cam.shot ?? null, mode: this.cam.mode ?? null, frames: this.cam.frames, landed: this.cam.landed, view: this.cam.last ?? null, err: this.cam.err ?? null, solve: this.cam.solve ?? null, rest: this.rest,
        rig: stage3d()?.camera?.rig?.() ? (({ yaw, tilt }) => ({ yaw: +yaw.toFixed(2), tilt: +tilt.toFixed(2) }))(stage3d().camera.rig()) : null },
      cover: this.ctx.cover.status?.() ?? null, sfx: this.sfx.slice(), flipped: !!this.flipped, smokeFrames: this.smoke?.frames ?? null, rig: !!this.rig, roar: !!this.roar, ret: this.retShow ? { finished: this.retShow.finished, status: this.retShow.finished ? null : (() => { try { return this.retShow.status?.() ?? null; } catch { return null; } })() } : null,
      rect2D: this.rect2D ?? null, mirrored: !!this.mirrored };
  }
}

/** Play the opening on THIS client (battle-opening.js calls it through the registry). */
export function playNidhoggAwakening(ctx, opts = {}) {
  const show = new AwakeningShow(ctx, opts);
  return { arrived: show.arrived, done: show.done, cancel: () => show.finish(), show };
}

registerBattleOpening(NAME, {
  crackOut: nidhoggCrackOut,
  crackOutMs: CRACK_OUT_MS,
  spanMs: () => Math.round(awakeningPlan().fadeEnd * 1000),
  play: (ctx) => playNidhoggAwakening(ctx),
});

export function initNidhoggAwakening() {
  preloadSfx(cueUrls(awakeningSfx())).catch(() => {});
  globalThis.__FU_NIDHOGG_AWAKENING__ = {
    shows: () => [..._shows],
    status: () => [..._shows].map((s) => s.status()),
    plan: (o) => awakeningPlan(o),
    beats: () => awakeningBeats(awakeningPlan()),
  };
}
