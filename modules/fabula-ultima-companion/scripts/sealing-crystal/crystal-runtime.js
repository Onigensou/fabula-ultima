// ============================================================================
// Sealing Crystal — the in-game host (every client).
//
// Any token flagged `flags.fabula-ultima-companion.sealingCrystal` (on the token
// or its actor) is drawn as the 3D pixel crystal the user approved (mockup v33,
// docs/nidhogg-boss-design.md §7): its own token art, as a live texture, so it
// works with Battle depth Off and under the 3D camera alike (§7a). The token's
// mesh stays (targeting, hit areas) but is drawn invisible.
//
// WHERE: the crystal's feet are the token's feet, where the 3D camera draws them
// (battle-stage-3d drawnMap) or the token's bottom centre when flat. One effect
// pixel = PX scene px at drawn scale 1 (2 px on a 110 px grid: the mockup's
// "pixel size 2", ~3x a PC on the Great Seal). It sits at the token's own depth.
//
// STATE (read from the token's actor each frame, nothing written):
//   - crack stage from HP: <= 75 / 50 / 25 % -> stage 1 / 2 / 3 (§3, §7b). A new
//     stage on this client plays its crack reveal + beam burst + a hit.
//   - an HP drop -> a hit (struck facets flash, glass debris, soul sparks).
//
// COST: the painting runs in a Worker (crystal-worker.js); this thread only
// uploads two textures per frame. At most one frame is in flight, so a slow
// machine simply gets a lower crystal frame rate, never a long main-thread
// frame. No Worker (blocked, failed to load) -> painted here at LOCAL_HZ.
// Rate: the "Effects frame rate" client option (60 / 30), as the Soul Tithe FX.
//
// OUT OF PLAY (battle-director/out-of-play.js): not drawn at all (Nidhogg's body
// while the dragon fights). A SHOW may take the crystal over meanwhile
// (holdCrystal: Nidhogg's fall fades it in solid and flashes it clear, or pops it
// in): the show's state wins over out-of-play until the show lets go.
// THE VOID (arena-void.js, the Crystal Round's black): no floor, so its light is
// no longer clipped at the floor line.
// ============================================================================

import { warn, log } from "../battle-director/logger.js";
import { shouldRender } from "../battle-director/presentation-clock.js";
import { getClientOption } from "../shared/client-options.js";
import { FRAME } from "./crystal-painter.js";
import { channel, channelMode, placeAfter, holdShadow, bufferSprite, takeFrame } from "./crystal-host-lib.js";
import { CrystalDeathShow } from "./crystal-death-show.js";
import { registerExternalDefeat } from "../battle-director/defeat-fx.js";
import { preloadSfx } from "../battle-director/director-sfx.js";
import { DEATH_SFX_URLS } from "./crystal-death-sfx.js";
import { isOutOfPlay } from "../battle-director/out-of-play.js";
import { voidUp, initArenaVoid } from "./arena-void.js";
import { SOUL_UP_FX } from "./nidhogg-fall.js";
import { crackStage } from "./crack-stage.js";

const MODULE_ID = "fabula-ultima-companion";
export const CRYSTAL_FLAG = "sealingCrystal";
/** Scene px per effect px at drawn scale 1, on a 110 px grid (the Great Seal's). */
const PX_AT_110 = 2;
const pxNow = () => PX_AT_110 * ((canvas.grid?.size || 110) / 110);
/** Main-thread fallback rate: the painting costs 8-19 ms, so keep it rare. */
const LOCAL_HZ = 15;

let FX_HZ = 60;
let _frozen = false;   // rigs: stop asking for frames (the last one stays)
function applyRateOption() {
  const v = Number(getClientOption("fxFrameRate"));
  FX_HZ = v === 30 || v === 60 ? v : 60;
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export function isCrystalDoc(doc) {
  return doc?.flags?.[MODULE_ID]?.[CRYSTAL_FLAG] === true || doc?.actor?.flags?.[MODULE_ID]?.[CRYSTAL_FLAG] === true;
}
// The crack stage rule lives in a leaf (crack-stage.js) so the boss rule's BOSS_STAGE reads the same thresholds.
export { crackStage };
function hpOf(token) {
  const p = token?.actor?.system?.props ?? {};
  return { hp: Number(p.current_hp), max: Number(p.max_hp) };
}

/* ── One crystal ────────────────────────────────────────────────────────── */

let _uid = 0;
const _hosts = new Map();   // tokenId -> CrystalHost

class CrystalHost {
  constructor(token) {
    this.token = token; this.id = `c${++_uid}:${token.id}`;
    this.ready = false; this.inflight = false; this.seq = 0; this.frames = 0; this.shown = false;
    this.lastTick = -1; this.spare = { color: null, light: null };
    this.stage = null; this.stageT = -1e9; this.hitT = null; this.hitSide = 1; this.lastHp = null;
    this.override = null;       // rigs: { stage }
    this.showFn = null;         // a show's hold (holdCrystal): (nowMs) -> null (hidden) | { alpha, reveal, opaque, sweep, flameK, scale, hitAge, debris }
    this.cost = new Float32Array(240); this.costAt = 0; this.costN = 0;
    this.recv = new Float32Array(240); this.recvAt = 0; this.recvN = 0;   // main thread: taking a frame in (copy + flag)
    this.deathT = null;
    const { W, H } = FRAME;
    this.root = new PIXI.Container();
    this.root.name = `fud-sealing-crystal:${token.id}`; this.root.eventMode = "none"; this.root.visible = false;
    this.color = bufferSprite(W, H); this.light = bufferSprite(W, H);
    this.light.sp.blendMode = PIXI.BLEND_MODES.ADD;
    for (const s of [this.color.sp, this.light.sp]) { s.position.set(-FRAME.CX, -FRAME.FLOOR); this.root.addChild(s); }
    canvas.primary.addChild(this.root);
    channel().init(this.id, FRAME, undefined, (m) => this.#onMessage(m));
  }
  #onMessage(m) {
    if (m.type === "ready") { this.ready = true; this.inflight = false; return; }
    if (m.type === "restart") { this.ready = false; this.inflight = false; channel().init(this.id, FRAME, undefined, (x) => this.#onMessage(x)); return; }
    if (m.type === "error") { this.inflight = false; return; }
    if (m.type !== "frame" || this.destroyed) return;
    this.inflight = false;
    const r0 = performance.now();
    try {
      takeFrame(this.color, m.color, m.cRect, FRAME.W);
      takeFrame(this.light, m.light, m.lRect, FRAME.W);
    } catch (e) { warn("sealing-crystal: upload failed", e); }
    this.spare = { color: m.color, light: m.light };
    this.recv[this.recvAt] = performance.now() - r0; this.recvAt = (this.recvAt + 1) % this.recv.length; if (this.recvN < this.recv.length) this.recvN++;
    this.shown = true; this.frames++;
    this.cost[this.costAt] = m.ms ?? 0; this.costAt = (this.costAt + 1) % this.cost.length; if (this.costN < this.cost.length) this.costN++;
  }
  /** Every display frame: hide the mesh, ride the feet, take the state, ask for the next frame on a tick. */
  step(now) {
    const token = this.token, mesh = token?.mesh;
    if (!token || token.destroyed || !mesh || mesh.destroyed) return;
    try { mesh.alpha = 0; } catch { /* gone */ }
    holdShadow(token, 0);
    const map = globalThis.__ONI_BATTLE_STAGE_3D__?.drawnMap?.(token) ?? null;
    const fx = map ? map.bx : token.x + token.w / 2, fy = map ? map.by : token.y + token.h, m = map ? map.m : 1;
    const px = pxNow();
    // a show's hold wins over out-of-play; a pop scales it about its soul
    const show = this.showFn ? (() => { try { return this.showFn(now); } catch { return null; } })() : undefined;
    const sc = show ? Math.max(0.01, Number(show.scale) || 1) : 1, up = SOUL_UP_FX * px * m;
    this.root.position.set(fx, fy - up + up * sc);
    this.root.scale.set(px * m * sc);
    placeAfter(this.root, mesh);
    const gone = show !== undefined ? !show || !(show.alpha > 0.001) : isOutOfPlay(token.actor);
    const vis = token.visible !== false && shouldRender() && !gone;
    // dying: its death show (its own painter and sprites) has taken over
    this.root.visible = vis && this.shown && !this.dying;
    this.root.alpha = show ? Math.min(1, show.alpha) : token.document?.hidden ? 0.5 : 1;
    this.#readState(now);
    if (!vis || !this.ready || this.inflight || _frozen || this.dying) return;
    const hz = channelMode() === "local" ? LOCAL_HZ : FX_HZ, tick = Math.floor((now / 1000) * hz);
    if (tick === this.lastTick) return;
    this.lastTick = tick;
    this.inflight = true;
    const st = { stage: this.stage, stageT: this.stageT, hitT: this.hitT, hitSide: this.hitSide, deathT: this.deathT, floorClip: this.deathT == null && !voidUp() };
    if (show) {
      st.reveal = show.reveal ?? 1; st.opaque = show.opaque ?? 0; st.sweep = show.sweep ?? null; st.flameK = show.flameK ?? 1;
      if (show.debris === false) st.debris = false;
      if (show.hitAge != null) { st.hitT = tick / hz - show.hitAge; st.hitSide = 1; }
    }
    const { color, light } = this.spare;
    this.spare = { color: null, light: null };
    channel().draw(this.id, ++this.seq, tick / hz, st, color, light);
  }
  #readState(now) {
    const s = now / 1000, { hp, max } = hpOf(this.token);
    const stage = this.override?.stage ?? crackStage(hp, max);
    if (this.stage == null) this.stage = stage;                 // as it is when first seen: no reveal
    else if (stage !== this.stage) {
      if (stage > this.stage) { this.stageT = s; this.#hit(s); }
      this.stage = stage;
    }
    if (Number.isFinite(hp)) {
      if (this.lastHp != null && hp < this.lastHp && this.stageT !== s) this.#hit(s);
      this.lastHp = hp;
    }
  }
  #hit(s) { this.hitT = s; this.hitSide = Math.random() < 0.5 ? -1 : 1; }
  hit() { this.#hit(performance.now() / 1000); }
  destroy() {
    this.destroyed = true;
    channel().drop(this.id);
    try { this.root.parent?.removeChild(this.root); this.root.destroy({ children: true, texture: true, baseTexture: true }); } catch { /* gone */ }
    const token = this.token;
    if (token && !token.destroyed) {
      try { if (token.mesh) token.mesh.alpha = token.alpha ?? 1; } catch { /* gone */ }
      holdShadow(token, 1);
      try { token.renderFlags?.set?.({ refreshState: true }); } catch { /* older core */ }
    }
  }
  status() {
    const stat = (r, n) => { const a = Array.from(r.subarray(0, n)).sort((x, y) => x - y); return a.length ? { avg: +(a.reduce((q, v) => q + v, 0) / a.length).toFixed(2), p95: +a[Math.floor(a.length * 0.95)].toFixed(2) } : null; };
    return {
      tokenId: this.token?.id, name: this.token?.name, stage: this.stage, frames: this.frames, ready: this.ready, dying: this.deathT != null,
      visible: this.root.visible, paintMs: stat(this.cost, this.costN), recvMs: stat(this.recv, this.recvN),
    };
  }
  resetCost() { this.costN = 0; this.costAt = 0; this.recvN = 0; this.recvAt = 0; }
}

/**
 * A show takes this crystal over (every client plays its own show): fn(nowMs) -> null (hidden) or its state
 * { alpha, reveal, opaque, sweep, flameK, scale, hitAge, debris }. Returns the release; the crystal then follows its
 * token again (out of play = hidden). A crystal whose token is not drawn yet is held once it is.
 */
const _pendingHolds = new Map();   // tokenId -> fn (the token was not drawn yet)
export function holdCrystal(tokenId, fn) {
  const h = _hosts.get(tokenId);
  if (h) h.showFn = fn; else _pendingHolds.set(tokenId, fn);
  if (_hosts.size) startTicker();
  return () => {
    if (_pendingHolds.get(tokenId) === fn) _pendingHolds.delete(tokenId);
    const host = _hosts.get(tokenId);
    if (host && host.showFn === fn) host.showFn = null;
  };
}
/** The crystal host's frame size and where its feet are drawn now (for a show that places effects round it). */
export function crystalPlace(tokenId) {
  const h = _hosts.get(tokenId), token = h?.token ?? canvas.tokens?.get(tokenId);
  if (!token) return null;
  const map = globalThis.__ONI_BATTLE_STAGE_3D__?.drawnMap?.(token) ?? null;
  const fx = map ? map.bx : token.x + token.w / 2, fy = map ? map.by : token.y + token.h, m = map ? map.m : 1, px = pxNow();
  return { feet: { x: fx, y: fy }, m, px, soul: { x: fx, y: fy - SOUL_UP_FX * px * m }, root: h?.root ?? null };
}

/* ── The death ─────────────────────────────────────────────────────────── */

const _shows = new Map();   // tokenId -> CrystalDeathShow (outlives the token)

/**
 * Play the crystal's death on this client. Resolves when the token may go: the white has cleared (ending "clear"), or
 * the screen has gone black (ending "black": the battle's last foe, the battle end runs on black until the scene
 * changes or releaseCrystalBlack). opts.clock: a stepped clock for rigs; opts.ending: "clear" (default) | "black".
 * A client that draws nothing resolves at once.
 */
export function playCrystalDeath(token, opts = {}) {
  if (!token || token.destroyed || !canvas?.ready || typeof PIXI === "undefined" || !shouldRender()) return Promise.resolve();
  const old = _shows.get(token.id);
  if (old && !old.finished) return old.done;
  const host = _hosts.get(token.id);
  let show;
  try {
    show = new CrystalDeathShow({ token, stage: Math.max(3, host?.stage ?? 3), stageT: host?.stageT ?? -1e9, px: pxNow(), clock: opts.clock ?? null, ending: opts.ending === "black" ? "black" : "clear" });
  } catch (e) { warn("sealing-crystal: the death could not start", e); return Promise.resolve(); }
  if (host) host.dying = true;
  _shows.set(token.id, show);
  show.ended.then(() => { if (_shows.get(token.id) === show) _shows.delete(token.id); });
  startTicker();
  return show.done;
}

/**
 * Let go of the ending's black on this client (and, from the GM, on every client): it fades back to whatever is under
 * it. The scene change normally takes it away first (canvasTearDown); this covers a battle end that stays on the
 * battle scene (the prompt cancelled, no return scene, a rewind).
 */
const RELEASE_MSG = "FU_CRYSTAL_DEATH_RELEASE";
export function releaseCrystalBlack({ broadcast = false } = {}) {
  if (broadcast) { try { game.socket.emit(`module.${MODULE_ID}`, { type: RELEASE_MSG }); } catch (e) { warn("sealing-crystal: release broadcast failed", e); } }
  for (const sh of _shows.values()) { try { sh.release(); } catch (e) { warn("sealing-crystal: release threw", e); } }
}

/* ── Ticker + sync ──────────────────────────────────────────────────────── */

let _ticker = null, _tickerOwner = null;
function startTicker() {
  const tk = canvas?.app?.ticker ?? PIXI.Ticker.shared;
  if (_ticker && _tickerOwner === tk) return;
  if (_ticker) { try { _tickerOwner.remove(_ticker); } catch { /* gone */ } }
  _ticker = () => {
    if (!canvas?.ready || (!_hosts.size && !_shows.size)) return;
    for (const sh of _shows.values()) { try { sh.step(); } catch (e) { warn("sealing-crystal: death step threw", e); } }
    const now = performance.now();
    for (const h of _hosts.values()) { try { h.step(now); } catch (e) { warn("sealing-crystal: step threw", e); } }
  };
  _tickerOwner = tk;
  // just before the render, after Foundry's token refreshes (a hidden mesh cannot flash back for a frame)
  tk.add(_ticker, null, (PIXI.UPDATE_PRIORITY?.LOW ?? -25) + 1);
}

function syncCrystals() {
  if (!canvas?.ready || typeof PIXI === "undefined") return;
  const seen = new Set();
  for (const t of canvas.tokens?.placeables ?? []) {
    if (!isCrystalDoc(t.document)) continue;
    seen.add(t.id);
    const h = _hosts.get(t.id);
    if (h && h.token !== t) { if (h.showFn) _pendingHolds.set(t.id, h.showFn); h.destroy(); _hosts.delete(t.id); }   // a redrawn token keeps its show's hold
    if (!_hosts.has(t.id)) {
      const h = new CrystalHost(t);
      if (_pendingHolds.has(t.id)) { h.showFn = _pendingHolds.get(t.id); _pendingHolds.delete(t.id); }
      _hosts.set(t.id, h); log(`sealing-crystal: drawing ${t.name}`);
    }
  }
  for (const [id, h] of _hosts) if (!seen.has(id)) { h.destroy(); _hosts.delete(id); }
  if (_hosts.size) startTicker();
}
function dropAll() { for (const h of _hosts.values()) h.destroy(); _hosts.clear(); }

/* ── Boot ───────────────────────────────────────────────────────────────── */

let _hooked = false;
export function initSealingCrystal() {
  if (_hooked) return;
  _hooked = true;
  applyRateOption();
  initArenaVoid();
  preloadSfx(DEATH_SFX_URLS).catch(() => {});
  Hooks.on("fuClientOptionChanged", ({ key } = {}) => { if (key === "fxFrameRate") applyRateOption(); });
  const later = () => setTimeout(() => { try { syncCrystals(); } catch (e) { warn("sealing-crystal: sync threw", e); } }, 0);
  Hooks.on("canvasReady", () => { dropAll(); later(); });
  Hooks.on("canvasTearDown", () => { dropAll(); for (const sh of [..._shows.values()]) sh.finish(); });
  // the director's defeat of a crystal (its actor's defeatStyle "crystal_death") plays the death on every client;
  // the token is removed when it resolves (the white has cleared)
  // the token is removed when it resolves (the white has cleared, or as the last foe: the screen is black)
  registerExternalDefeat("crystal-death", ({ token, lastFoe }) => playCrystalDeath(token, { ending: lastFoe ? "black" : "clear" }));
  // the battle is over on the GM (any way: the result screen and the scene change done, the prompt cancelled, a
  // rewind): nothing may stay black
  // (broadcast even when this GM draws nothing: the players may still be holding it)
  Hooks.on("fu-director-stopped", () => { if (game.user?.isGM) releaseCrystalBlack({ broadcast: true }); });
  game.socket?.on?.(`module.${MODULE_ID}`, (msg) => { if (msg?.type === RELEASE_MSG) releaseCrystalBlack(); });
  Hooks.on("drawToken", (t) => { if (isCrystalDoc(t?.document)) later(); });
  Hooks.on("createToken", (doc) => { if (isCrystalDoc(doc)) later(); });
  Hooks.on("updateToken", (doc, ch) => { if (isCrystalDoc(doc) || ch?.flags?.[MODULE_ID]?.[CRYSTAL_FLAG] !== undefined) later(); });
  Hooks.on("deleteToken", (doc) => { const h = _hosts.get(doc?.id); if (h) { h.destroy(); _hosts.delete(doc.id); } });
  globalThis.__FU_SEALING_CRYSTAL__ = {
    status: () => ({ mode: channelMode(), fxHz: FX_HZ, crystals: [..._hosts.values()].map((h) => h.status()), deaths: [..._shows.values()].map((s) => s.status()) }),
    /** Play the death on THIS client (no director): resolves when the white has cleared (opts.ending "black": when black). */
    playDeath: (tokenId, opts) => playCrystalDeath(canvas.tokens.get(tokenId), opts),
    /** Let go of the ending's black on this client. */
    release: () => releaseCrystalBlack(),
    /** Rigs: the running death show of a token (seek(D), D(), status()). */
    __death: (tokenId) => _shows.get(tokenId) ?? null,
    /** Rigs / console: strike it now (the hit look), or pin a crack stage (null = from HP again). */
    hit: (tokenId) => _hosts.get(tokenId)?.hit(),
    setStage: (tokenId, stage) => { const h = _hosts.get(tokenId); if (h) h.override = stage == null ? null : { stage: clamp(Math.round(stage), 0, 3) }; },
    sync: () => syncCrystals(),
    /** Rigs: the crystal frame rate (Hz; null = the client option again), the death's timeline on / off, cost meters reset. */
    setRate: (hz) => { if (Number(hz) > 0) FX_HZ = Number(hz); else applyRateOption(); return FX_HZ; },
    setDeath: (tokenId, on = true) => { const h = _hosts.get(tokenId); if (h) h.deathT = on ? performance.now() / 1000 : null; },
    resetCost: () => { for (const h of _hosts.values()) h.resetCost(); },
    freeze: (on = true) => { _frozen = !!on; },
    /** Rigs: the host itself (its buffer sprites: color / light { sp, u8 }). */
    __host: (tokenId) => _hosts.get(tokenId) ?? null,
  };
  if (canvas?.ready) later();
}
