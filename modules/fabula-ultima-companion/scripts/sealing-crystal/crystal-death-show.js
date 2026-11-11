// ============================================================================
// Sealing Crystal — the death, as played in game (every client).
//
// The user's script and mockup v33 (docs/nidhogg-boss-design.md §8), timed by
// crystal-death.js DEATH: the spin stops, four flashes, the cracks spread with a
// screen flash, the soul pours out (3 + 4 more in the build-up), the inside
// whitens, the white-out swells from the crystal, it shatters with the 11p
// explosion (dip, hero frame, green arena light, rings, sparks, burst), full
// white, and then one of two endings:
//   - "clear": the white clears onto the arena, lit again (the fight goes on);
//   - "black": the crystal was the battle's last foe (the user, 2026-11-11). Full
//     white holds 5 s, fades to black, and the black stays: the GM's battle-end
//     prompt and the result screen run on it, and the scene change takes it away
//     (canvasTearDown), or release() when the battle ends without one.
//
// What this file adds to the crystal painter (which draws the crystal, pours,
// shards, burst):
//   - the arena goes pitch black (a black plate just above the backdrop, under
//     every battler), back to lit under the full white;
//   - the screen-wide beats on a DOM overlay above the whole UI: the crack flash,
//     the dip, the hero frame, the green arena light (plus-lighter), the
//     white-out radial from the crystal's heart; the screen shake on #board;
//   - the 3D camera move (crystal-death-camera.js), driven every frame from this
//     show's own clock (camera.set), so it can be stepped and seeked; the camera
//     is CLAIMED meanwhile (no hold applies); off the 3D camera (Battle depth
//     Off, a flat scene) the crystal simply stays put, as the mockup's camera-off;
//   - while the camera stands: the GM desk / player HUD / token overlays fade out
//     and every other battler is hidden (flat billboards from that angle: 11m).
//
// The show owns its own painter (a larger frame, DEATH_FRAME, for the burst)
// and its own sprites, so it outlives the crystal's token: the director removes
// the token once `done` resolves (the white has cleared, or the screen is black),
// the embers keep floating up to DEATH.end.
// ============================================================================

import { warn, log } from "../battle-director/logger.js";
import { getClientOption } from "../shared/client-options.js";
import { DEATH_FRAME } from "./crystal-painter.js";
import { DEATH, deathTimeline, ENDING_BLACK_AT, endingScreen } from "./crystal-death.js";
import { channel, placeAfter, holdShadow, bufferSprite, takeFrame } from "./crystal-host-lib.js";
import { DEATH_SFX } from "./crystal-death-sfx.js";
import { makeCueTrack } from "../shared/sfx-cues.js";
import { playSfx } from "../battle-director/director-sfx.js";
import { planDeathCamera, shotAt, crystalPlacement, turnOf, partyAlpha, CRYSTAL_UP_FX } from "./crystal-death-camera.js";
import { hideHud, showHud, setHudLevel } from "../shared/hud-curtain.js";

const STYLE_ID = "fud-crystal-death-style";
// The GM desk / player HUD / token overlays fade out while the camera stands low: a hold on the HUD curtain
// (shared/hud-curtain.js), driven every frame from the camera's stand.
const DARK_IN = 0.8;          // s: the arena sinks to black at the start (already black in the crystal phase)
const LATE_DARK = 0.0;
const RELEASE_S = 0.6;        // s: the ending's black fading back when it is let go on the battle scene
const BLACK_CAP_S = 600;      // s: the ending's black lets go by itself after this, whatever happened to the battle end
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const stage3d = () => globalThis.FUCompanion?.api?.battleStage3d ?? null;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const st = document.createElement("style");
  st.id = STYLE_ID;
  st.textContent = `
#fud-crystal-death-fx { position: fixed; inset: 0; pointer-events: none; z-index: 10050; }
#fud-crystal-death-fx canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
#fud-crystal-death-fx canvas.add { mix-blend-mode: plus-lighter; }`;
  document.head.appendChild(st);
}

let _uid = 0;

export class CrystalDeathShow {
  /**
   * token: the crystal's token (read at the start; the show outlives it)
   * stage / stageT: its crack stage when it died (the host's), px: scene px per effect px
   * clock: () => ms (performance.now by default; rigs step it)
   * ending: "clear" (the white clears onto the arena) | "black" (the battle's last foe: white, then black, held)
   */
  constructor({ token, stage = 3, stageT = -1e9, px = 2, clock = null, ending = "clear" }) {
    this.id = `d${++_uid}:${token.id}`;
    this.token = token; this.tokenId = token.id; this.stage = stage; this.stageT = stageT; this.px = px;
    this.clock = clock ?? (() => performance.now());
    this.t0 = this.clock();
    this.deathT = this.t0 / 1000;
    this.ready = false; this.inflight = false; this.seq = 0; this.lastTick = -1; this.frames = 0; this.shown = false;
    this.spare = { color: null, light: null };
    this.touched = new Map();       // tokenId -> token whose mesh this show has hidden
    this.done = new Promise((r) => { this.resolveDone = r; });
    this.ended = new Promise((r) => { this.resolveEnded = r; });
    this.resolved = false; this.finished = false; this.cameraReleased = false;
    this.ending = ending === "black" ? "black" : "clear";
    this.resolveAt = this.ending === "black" ? ENDING_BLACK_AT : DEATH.whiteGone;
    this.blackA = 0; this.releasedAt = null;
    this.cues = makeCueTrack(DEATH_SFX);   // its sounds, on this show's clock (crystal-death-sfx.js)
    this.fxHz = Number(getClientOption("fxFrameRate")) === 30 ? 30 : 60;

    // where it stands: the token's 2D feet (the floor point the 3D camera plans with) and how it is drawn now
    const tw = token.w, th = token.h;
    this.feet = { x: token.document.x + tw / 2, y: token.document.y + th };
    const map = globalThis.__ONI_BATTLE_STAGE_3D__?.drawnMap?.(token) ?? null;
    this.flat = { x: map ? map.bx : token.x + tw / 2, y: map ? map.by : token.y + th, m: map ? map.m : 1 };

    // the 3D camera's plan (only where it runs on this client)
    try {
      const S = stage3d(), model = S?.camera?.model?.();
      if (model) {
        const party = canvas.tokens.placeables.filter((t) => t.id !== token.id && t.actor?.hasPlayerOwner && t.document.disposition === 1);
        const scr = canvas.app.renderer.screen;
        this.plan = planDeathCamera({
          model, px, feet: this.feet, screenH: scr.height / (model.rest.scale || 1),
          party: party.map((t) => ({ x: t.document.x + t.w / 2, y: t.document.y + t.h })),
        });
        this.releaseCamera = S.camera.claim("crystal-death");
      }
    } catch (e) { warn("sealing-crystal: the death's camera could not be planned (it stays put)", e); this.plan = null; }

    // PIXI: the crystal (its own painter + sprites) and the black plate over the backdrop
    const { W, H } = DEATH_FRAME;
    this.root = new PIXI.Container();
    this.root.name = `fud-crystal-death:${token.id}`; this.root.eventMode = "none"; this.root.visible = false;
    this.color = bufferSprite(W, H); this.light = bufferSprite(W, H);
    this.light.sp.blendMode = PIXI.BLEND_MODES.ADD;
    for (const s of [this.color.sp, this.light.sp]) { s.position.set(-DEATH_FRAME.CX, -DEATH_FRAME.FLOOR); this.root.addChild(s); }
    canvas.primary.addChild(this.root);
    if (token.mesh) placeAfter(this.root, token.mesh);
    this.dark = new PIXI.Sprite(PIXI.Texture.WHITE);
    this.dark.tint = 0x000000; this.dark.alpha = 0; this.dark.eventMode = "none"; this.dark.name = "fud-crystal-death-dark";
    const bg = canvas.primary.background;
    this.dark.elevation = bg?.elevation ?? -Infinity; this.dark.sortLayer = bg?.sortLayer ?? 0; this.dark.sort = (bg?.sort || 0) + 2;
    canvas.primary.addChild(this.dark);
    canvas.primary.sortDirty = true;

    // DOM: the screen-wide beats
    ensureStyle();
    this.fx = document.createElement("div");
    this.fx.id = "fud-crystal-death-fx";
    this.cv = document.createElement("canvas"); this.cvAdd = document.createElement("canvas"); this.cvAdd.className = "add";
    this.fx.append(this.cvAdd, this.cv);
    document.body.appendChild(this.fx);
    this.hud = hideHud("crystal-death", { level: 1, maxS: BLACK_CAP_S + 30 });
    this.board = document.getElementById("board");

    channel().init(this.id, DEATH_FRAME, undefined, (m) => this.#onMessage(m));
    // real-time guards: the GM's removal must not hang on a stalled ticker (a hidden window)
    this.timers = [];
    if (!clock) {
      this.timers.push(setTimeout(() => this.#resolve(), this.resolveAt * 1000 + 200));
      this.timers.push(setTimeout(() => this.finish(), (this.ending === "black" ? BLACK_CAP_S : DEATH.end + 3) * 1000));
    }
    log(`sealing-crystal: ${token.name} dies (camera ${this.plan ? "3D" : "flat"}, ending ${this.ending})`);
  }

  #onMessage(m) {
    if (m.type === "ready") { this.ready = true; this.inflight = false; return; }
    if (m.type === "restart") { this.ready = false; this.inflight = false; channel().init(this.id, DEATH_FRAME, undefined, (x) => this.#onMessage(x)); return; }
    if (m.type === "error") { this.inflight = false; return; }
    if (m.type !== "frame" || this.finished) return;
    this.inflight = false;
    try { takeFrame(this.color, m.color, m.cRect, DEATH_FRAME.W); takeFrame(this.light, m.light, m.lRect, DEATH_FRAME.W); }
    catch (e) { warn("sealing-crystal: death upload failed", e); }
    this.spare = { color: m.color, light: m.light };
    this.shown = true; this.frames++;
  }

  /** Seconds since the death began. */
  D() { return Math.max(0, (this.clock() - this.t0) / 1000); }
  /** Rigs: jump to death time D (the clock keeps running from there). */
  seek(D) { this.t0 = this.clock() - D * 1000; this.lastTick = -1; }

  /** Every display frame (the host's ticker). */
  step() {
    if (this.finished) return;
    const now = this.clock(), D = Math.max(0, (now - this.t0) / 1000), tl = deathTimeline(D);
    const S = stage3d();
    if (this.releasedAt == null) this.cues.step(D, (c, url) => playSfx(url, c.vol));

    // ── the ending: the white held, then the black over it; let go → all of it fades away ──
    let gone = 1;
    if (this.ending === "black") {
      const es = endingScreen(D);
      if (es.white != null) { tl.white = es.white; tl.whiteR = 1; }
      this.blackA = es.black;
    }
    if (this.releasedAt != null) {
      gone = 1 - clamp01((now - this.releasedAt) / 1000 / RELEASE_S);
      tl.white *= gone; tl.screenFlash *= gone; this.blackA *= gone;
    }

    // ── the camera: from this show's clock, every frame ──
    let rig = null;
    if (this.plan && !this.cameraReleased) {
      if (D < DEATH.whiteHold + 0.05) { try { S?.camera?.set?.(shotAt(this.plan, D)); } catch { /* camera gone */ } }
      else this.#releaseCamera();
    }
    if (this.plan) rig = S?.camera?.rig?.() ?? null;

    // ── the crystal: from its heart's true projection under the 3D camera, else where it stood ──
    let place, turn = { yaw: 0, pitch: 0 };
    if (rig) { place = crystalPlacement(this.plan, rig); turn = turnOf(rig, this.plan); }
    else place = { x: this.flat.x, y: this.flat.y, k: this.flat.m, heart: { x: this.flat.x, y: this.flat.y - CRYSTAL_UP_FX * this.px * this.flat.m } };
    this.root.position.set(place.x, place.y);
    this.root.scale.set(this.px * place.k);
    this.root.visible = this.shown;
    const u = rig?.stand || 0;

    // ── the rest of the field while the camera stands ──
    this.#party(rig ? partyAlpha(rig) : 1);
    // (the ending keeps the HUD away from the full white on: the battle end draws its own screens)
    const hudOff = this.ending === "black" && D >= DEATH.whiteFull && this.releasedAt == null;
    setHudLevel(this.hud, hudOff ? 0 : 1 - u);

    // ── the arena: pitch black from the start until the full white ──
    this.#dark(D < DEATH.whiteFull ? clamp01(D / DARK_IN) : LATE_DARK);

    // ── the painter: one frame in flight (nothing to paint under the ending's black) ──
    if (this.ready && !this.inflight && this.blackA < 0.999) {
      const tick = Math.floor((now / 1000) * this.fxHz);
      if (tick !== this.lastTick) {
        this.lastTick = tick;
        this.inflight = true;
        const st = { stage: this.stage, stageT: this.stageT, hitT: null, deathT: this.t0 / 1000, floorClip: false,
          camYaw: turn.yaw, camPitch: turn.pitch, camPoses: this.plan?.camPoses ?? null, camKey: this.plan ? "plan" : "off" };
        const { color, light } = this.spare;
        this.spare = { color: null, light: null };
        channel().draw(this.id, ++this.seq, now / 1000, st, color, light);
      }
    }

    // ── the screen-wide beats ──
    this.#screen(D, tl, place);

    if (D >= this.resolveAt) this.#resolve();
    if (this.ending === "clear" && D >= DEATH.end) this.finish();
    if (this.releasedAt != null && gone <= 0) this.finish();
  }

  /**
   * Let go of the ending's black (the battle ended without a scene change): it fades back over RELEASE_S, then the
   * show is over. The "clear" ending lets go by itself.
   */
  release() {
    if (this.finished || this.ending !== "black" || this.releasedAt != null) return;
    this.releasedAt = this.clock();
    this.#resolve();
    log(`sealing-crystal: the ending's black is let go (D ${this.D().toFixed(1)} s)`);
    // a stalled ticker (hidden window) must not keep it
    if (!this.timers) this.timers = [];
    this.timers.push(setTimeout(() => this.finish(), RELEASE_S * 1000 + 300));
  }

  #releaseCamera() {
    if (this.cameraReleased) return;
    this.cameraReleased = true;
    try { stage3d()?.camera?.set?.({ stand: 0 }); } catch { /* gone */ }
    try { this.releaseCamera?.(); } catch { /* gone */ }
  }

  #party(a) {
    for (const t of canvas.tokens?.placeables ?? []) {
      if (t.id === this.tokenId || t.destroyed || !t.mesh) continue;
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

  #dark(a) {
    const d = this.dark;
    d.alpha = a;
    d.visible = a > 0.001;
    if (!d.visible) return;
    // over the whole visible window, with room for the shake
    const st = canvas.stage, scr = canvas.app.renderer.screen, k = st.scale.x || 1, pad = 400 / k;
    d.position.set(st.pivot.x - scr.width / (2 * k) - pad, st.pivot.y - scr.height / (2 * k) - pad);
    d.width = scr.width / k + 2 * pad; d.height = scr.height / k + 2 * pad;
  }

  #screen(D, tl, place) {
    const W = Math.max(1, Math.round(window.innerWidth / 2)), H = Math.max(1, Math.round(window.innerHeight / 2));   // half res: gradients only
    for (const c of [this.cv, this.cvAdd]) if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    const ctx = this.cv.getContext("2d"), add = this.cvAdd.getContext("2d");
    ctx.clearRect(0, 0, W, H); add.clearRect(0, 0, W, H);
    const vs = canvas.stage.scale.x || 1;
    const hs = canvas.stage.worldTransform.apply(new PIXI.Point(place.heart.x, place.heart.y));
    const rc = this.board?.getBoundingClientRect?.() ?? { left: 0, top: 0 };
    const hx = (hs.x + rc.left) / 2, hy = (hs.y + rc.top) / 2;

    // the screen shake (each pour, the build-up, the shatter's jolt: harder at the impact)
    if (this.board) {
      const shakeK = D >= DEATH.shatter && D < DEATH.shatter + 0.6 ? 1.8 : 1;
      if (tl.shake > 0) {
        const a = tl.shake * 7 * shakeK * vs, n = Math.floor(D * 60);
        const fx = Math.sin(n * 12.9898) * 43758.5453, fy = Math.sin(n * 78.233) * 43758.5453;
        this.board.style.transform = `translate(${Math.round(((fx - Math.floor(fx)) * 2 - 1) * a)}px, ${Math.round(((fy - Math.floor(fy)) * 2 - 1) * a * 0.7)}px)`;
      } else if (this.board.style.transform) this.board.style.transform = "";
    }
    // the cracks spread: the whole screen flashes
    if (tl.screenFlash > 0) { ctx.fillStyle = `rgba(255,255,255,${tl.screenFlash})`; ctx.fillRect(0, 0, W, H); }
    // the impact: a dip just before, the white hero frame through the hit-stop, the arena lit soul green after
    const f0 = D - DEATH.shatter;
    if (f0 > -0.18 && f0 < 0) { ctx.fillStyle = `rgba(0,0,0,${0.5 * Math.pow((f0 + 0.18) / 0.18, 2)})`; ctx.fillRect(0, 0, W, H); }
    if (f0 >= 0 && f0 < 0.07) { ctx.fillStyle = f0 < 0.035 ? "rgba(255,255,255,0.92)" : "rgba(214,255,210,0.7)"; ctx.fillRect(0, 0, W, H); }
    if (f0 >= 0.035 && f0 < 0.9) {
      const k = Math.pow(1 - (f0 - 0.035) / 0.865, 2), g = add.createRadialGradient(hx, hy, 0, hx, hy, Math.max(W, H) * 0.9);
      g.addColorStop(0, `rgba(140,255,150,${0.75 * k})`);
      g.addColorStop(0.35, `rgba(60,214,108,${0.45 * k})`);
      g.addColorStop(1, `rgba(17,82,74,${0.2 * k})`);
      add.fillStyle = g; add.fillRect(0, 0, W, H);
    }
    // the white-out, from the crystal outward (the ending holds it full)
    if (tl.white > 0) {
      const R = (160 * vs) / 2 + Math.pow(tl.whiteR, 1.3) * 2.4 * Math.max(W, H), a = tl.white;
      const g = ctx.createRadialGradient(hx, hy, 0, hx, hy, Math.max(1, R));
      g.addColorStop(0, `rgba(255,255,255,${Math.min(1, a * 1.8)})`);
      g.addColorStop(0.55, `rgba(255,255,255,${a})`);
      g.addColorStop(1, `rgba(255,255,255,${a * a})`);
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }
    // the ending: black over everything (the battle end's own screens sit above this overlay)
    if (this.blackA > 0) { ctx.fillStyle = `rgba(0,0,0,${Math.min(1, this.blackA)})`; ctx.fillRect(0, 0, W, H); }
  }

  #resolve() {
    if (this.resolved) return;
    this.resolved = true;
    this.resolveDone();
  }

  /** Over (or torn down): everything put back. */
  finish() {
    if (this.finished) return;
    this.finished = true;
    this.#resolve();
    for (const t of this.timers) clearTimeout(t);
    this.#releaseCamera();
    for (const t of this.touched.values()) this.#showToken(t);
    this.touched.clear();
    showHud(this.hud, { fade: 0 });
    if (this.board) this.board.style.transform = "";
    try { this.fx.remove(); } catch { /* gone */ }
    try { channel().drop(this.id); } catch { /* gone */ }
    for (const o of [this.root, this.dark]) { try { o.parent?.removeChild(o); o.destroy({ children: true, texture: o === this.root, baseTexture: o === this.root }); } catch { /* gone */ } }
    this.resolveEnded();
  }

  status() {
    const D = this.D();
    return { tokenId: this.tokenId, D: +D.toFixed(2), label: deathTimeline(D).label, frames: this.frames, camera: this.plan ? (this.cameraReleased ? "released" : "3D") : "flat", ending: this.ending, black: +this.blackA.toFixed(3), released: this.releasedAt != null, resolved: this.resolved, finished: this.finished };
  }
}
