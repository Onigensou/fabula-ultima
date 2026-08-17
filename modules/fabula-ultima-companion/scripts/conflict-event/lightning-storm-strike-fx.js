// ============================================================================
// Lightning Storm — the strike cinematic.
//
// When the Rod holder's turn begins, the battlefield darkens around them, a
// bolt comes down, thunder cracks, and the lights come back up — and only then
// does the 30 Bolt damage land. The mechanic was already correct before this;
// it just happened silently in a log line, which is why it read as arbitrary.
//
// ── Where it hooks, and why the ordering works ──────────────────────────────
//
// events/lightning-storm.js runs this from `onTurnStart`, which the conflict
// event runtime dispatches from STANDALONE_REACTION_WINDOW's forced phase —
// AWAITED, and BEFORE the forced reaction pass that fires the Rod AE's own
// `rod_strike` row. So the whole cinematic plays out, then the damage resolves
// and the damage number pops on an un-dimmed screen.
//
// The alternative seam — reacting to the resource-ledger event the strike
// emits — fires post-resolve, which would have put the damage number on screen
// BEFORE the lightning that caused it.
//
// ── Dimming the battlefield without dimming the UI ──────────────────────────
//
// The dim is a PIXI layer on `canvas.stage`, not a DOM overlay: chat, the HUD,
// the sidebar and any open sheet stay lit, and only the canvas darkens.
//
// Exempting the struck token is done by CLONING it above the dim rather than
// by punching a hole (a hole would reveal the map background, not the token).
// The clone copies `token.mesh`'s transform wholesale, which is what makes it
// correct for scaled, mirrored, Contain-fitted and off-center-anchored tokens
// — and for animated .webm token art, which keeps playing because the clone
// shares the live video texture.
//
// The dim itself is drawn in WORLD coordinates over an inflated scene rect, so
// a camera pan or zoom mid-strike stays correct with no per-frame work.
//
// ── The watchdog is load-bearing ────────────────────────────────────────────
//
// A stranded dim is the one failure here that ruins a session, so the layer
// carries an unconditional self-destruct timer from the moment it mounts. If
// the timeline throws, if a client is mid-strike when it F5s, if anything at
// all goes wrong, the battlefield comes back on its own.
// ============================================================================

import { playSfx } from "../battle-director/director-sfx.js";
import { playImpactFxLocal } from "../battle-director/damage-numbers/director-impact-fx.js";
import { shouldRender } from "../battle-director/presentation-clock.js";

const MODULE_ID = "fabula-ultima-companion";
const TAG = "[FU][LightningStorm][FX]";
const ACTION_STRIKE = "FU_LIGHTNING_STORM_STRIKE";

const log = (...a) => console.debug(TAG, ...a);
const warn = (...a) => console.warn(TAG, ...a);

const STRIKE_WEBM =
  "modules/JB2A_DnD5e/Library/Generic/Lightning/LightningStrike01_01_Regular_Blue_800x800.webm";
const THUNDER_SFX =
  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Thunder10.ogg";

// Timing (ms) and look. Everything tunable lives here — edit and F5.
const CFG = {
  dimInMs: 250,       // battlefield fades down
  holdMs: 150,        // beat of darkness before the bolt
  strikeMs: 1100,     // bolt on screen
  dimOutMs: 300,      // lights back up
  dimAlpha: 0.78,     // how dark the battlefield gets
  dimColor: 0x02000A,
  strikeScale: 2.2,   // bolt size relative to the token's on-screen footprint
  sfxVolume: 0.85,
  zIndex: 99500,      // above every canvas group, below the cut-in layer
};

/** Total wall time of one strike, used for the watchdog and by callers. */
export const STRIKE_TOTAL_MS = CFG.dimInMs + CFG.holdMs + CFG.strikeMs + CFG.dimOutMs;

let _socket = null;
let _layer = null;       // the live PIXI container, if a strike is on screen
let _watchdog = null;

// ── boot: socket registration ───────────────────────────────────────────────
// Idempotent. Call once on every client after socketlib is up (boot `ready`).
export function initLightningStormFx() {
  try {
    if (typeof socketlib === "undefined" || !game.modules.get("socketlib")?.active) {
      warn("socketlib unavailable — the strike cinematic stays GM-local");
      return;
    }
    _socket = socketlib.registerModule(MODULE_ID);
    _socket.register(ACTION_STRIKE, playLightningStrikeLocal);
    log("socket registered");
  } catch (e) {
    warn("init failed", e);
  }
}

/**
 * GM-side emit — run the cinematic here AND on every other client.
 *
 * Awaited by the caller so the Rod's damage lands after the lights come back
 * up. The local run is what we await; the broadcast is fire-and-forget, which
 * means a client whose window is hidden simply skips its own show (see
 * `shouldRender`) rather than holding up the battle for everyone else.
 */
export async function emitLightningStrike(payload = {}) {
  try { _socket?.executeForOthers?.(ACTION_STRIKE, payload); }
  catch (e) { warn("broadcast failed", e); }
  try { await playLightningStrikeLocal(payload); }
  catch (e) { warn("local render threw", e); }
}

// Token UUID ("Scene.X.Token.Y") → placeable on the active canvas, or null.
function canvasTokenFromUuid(tokenUuid) {
  const tokenId = String(tokenUuid ?? "").split(".Token.").pop();
  return tokenId ? (canvas?.tokens?.get?.(tokenId) ?? null) : null;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Linear alpha tween on the shared ticker. Resolves when it lands. */
function tweenAlpha(obj, to, ms) {
  return new Promise((resolve) => {
    if (!obj || ms <= 0) { try { if (obj) obj.alpha = to; } catch { /* destroyed */ } resolve(); return; }
    const from = obj.alpha ?? 0;
    let elapsed = 0;
    const ticker = PIXI.Ticker.shared;
    const step = () => {
      // The object can be destroyed under us by the watchdog or a canvas
      // teardown; bail rather than throw inside the shared ticker.
      if (!obj || obj.destroyed) { try { ticker.remove(step); } catch { /* gone */ } resolve(); return; }
      elapsed += ticker.deltaMS;
      const t = Math.min(elapsed / ms, 1);
      obj.alpha = from + (to - from) * t;
      if (t >= 1) { try { ticker.remove(step); } catch { /* gone */ } resolve(); }
    };
    ticker.add(step);
  });
}

/**
 * A sprite that reproduces the token's rendered art, in world space.
 *
 * Copies `token.mesh`'s transform rather than deriving one from the grid
 * square: scale, mirroring, rotation, Contain fit and off-center anchors are
 * all baked into the mesh and all matter. Falls back to nominal grid geometry
 * when the mesh isn't available (a placeable still drawing, mostly).
 */
function cloneTokenSprite(token) {
  const mesh = token?.mesh ?? null;
  const texture = mesh?.texture ?? null;
  if (!texture) return null;

  const spr = new PIXI.Sprite(texture);
  try {
    if (mesh.anchor) spr.anchor.set(mesh.anchor.x, mesh.anchor.y);
    else spr.anchor.set(0.5);
    spr.position.set(mesh.position.x, mesh.position.y);
    spr.scale.set(mesh.scale.x, mesh.scale.y);
    spr.rotation = mesh.rotation ?? 0;
    spr.alpha = mesh.alpha ?? 1;
    spr.tint = mesh.tint ?? 0xFFFFFF;
  } catch (e) {
    // Nominal geometry fallback — centered on the token, sized to its footprint.
    warn("mesh transform copy failed, falling back to grid geometry", e);
    try {
      spr.anchor.set(0.5);
      spr.position.set(token.center.x, token.center.y);
      const s = (token.h ?? 100) / (texture.height || 1);
      spr.scale.set(s, s);
    } catch { return null; }
  }
  return spr;
}

/** Tear the layer down. Safe to call any number of times, from anywhere. */
function destroyLayer() {
  if (_watchdog) { try { clearTimeout(_watchdog); } catch { /* fired */ } _watchdog = null; }
  const layer = _layer;
  _layer = null;
  if (!layer) return;
  try { layer.parent?.removeChild(layer); } catch { /* already detached */ }
  // The clone shares the token's live texture — destroying it must NOT take
  // that texture with it, or the real token goes blank.
  try { layer.destroy({ children: true, texture: false, baseTexture: false }); } catch { /* already destroyed */ }
}

/**
 * Mount the dim + the spotlit clone. Returns the dim graphic (for the tween)
 * or null if the canvas isn't in a state to render.
 */
function mountLayer(token) {
  // A second strike while one is on screen is not a real case (the Rod is a
  // singleton), but a rewind or a double-dispatch could produce one. Tear the
  // old layer down rather than stacking dims.
  destroyLayer();

  const stage = canvas?.stage;
  if (!stage) return null;
  stage.sortableChildren = true;

  const layer = new PIXI.Container();
  layer.zIndex = CFG.zIndex;
  layer.sortableChildren = true;
  layer.interactiveChildren = false;
  layer.eventMode = "none";

  // World-space dim. Inflated x3 around the canvas rect so a zoomed-out camera
  // can't see past its edges; fixed in world coordinates, so panning is free.
  const r = canvas.dimensions?.rect ?? { x: 0, y: 0, width: 10000, height: 10000 };
  const dim = new PIXI.Graphics();
  dim.beginFill(CFG.dimColor, 1)
    .drawRect(r.x - r.width, r.y - r.height, r.width * 3, r.height * 3)
    .endFill();
  dim.alpha = 0;
  dim.zIndex = 0;
  layer.addChild(dim);

  const clone = cloneTokenSprite(token);
  if (clone) {
    clone.zIndex = 1;
    layer.addChild(clone);
  } else {
    log("no mesh texture to clone — dimming without a spotlight");
  }

  stage.addChild(layer);
  _layer = layer;

  // Unconditional self-destruct. See the header — this is the safety valve.
  _watchdog = setTimeout(() => {
    warn("watchdog fired — clearing a strike layer that outlived its timeline");
    destroyLayer();
  }, STRIKE_TOTAL_MS + 2000);

  return dim;
}

/**
 * The cinematic. Runs identically on every client (socket handler + the GM's
 * own local call).
 */
export async function playLightningStrikeLocal({ tokenUuid } = {}) {
  try {
    // Nobody is watching (hidden tab, occluded window, sim run) — skip the
    // show, never the rules. Damage is applied by the caller regardless.
    if (!shouldRender()) return;
    if (globalThis.FUCompanion?.api?.vfxSuppressed?.()) return;
    if (typeof PIXI === "undefined" || !canvas?.ready) return;

    const token = canvasTokenFromUuid(tokenUuid);
    if (!token || token.destroyed) { log("target token not on canvas, skipping"); return; }

    const { setRodCursorHiddenLocal } = await import("./lightning-rod-cursor.js");
    setRodCursorHiddenLocal(true);

    const dim = mountLayer(token);
    if (!dim) { setRodCursorHiddenLocal(false); return; }

    await tweenAlpha(dim, CFG.dimAlpha, CFG.dimInMs);
    await wait(CFG.holdMs);

    // The bolt is the existing director impact renderer — a screen-space DOM
    // <video> above everything, already zoom-relative and already guarded.
    // LOCAL, not the emitting variant: this whole timeline is per-client, so
    // broadcasting from inside it would fan out once per client.
    try {
      playImpactFxLocal({
        tokenUuid,
        file: STRIKE_WEBM,
        scale: CFG.strikeScale,
        durationMs: CFG.strikeMs,
      });
    } catch (e) { warn("bolt render threw", e); }
    try { playSfx(THUNDER_SFX, CFG.sfxVolume); }
    catch (e) { warn("thunder SFX threw", e); }

    await wait(CFG.strikeMs);
    await tweenAlpha(dim, 0, CFG.dimOutMs);
  } catch (e) {
    warn("cinematic threw (cleaning up)", e);
  } finally {
    destroyLayer();
    try {
      const { setRodCursorHiddenLocal } = await import("./lightning-rod-cursor.js");
      setRodCursorHiddenLocal(false);
    } catch { /* module never loaded */ }
  }
}
