// ============================================================================
// Map storm (Foundry half): distant lightning on a walk map, from the scene
// flag flags.fabula-ultima-companion.ambience.storm (see map-storm-core.js).
//
// - above (Sacrificial Altar): a forked bolt strikes in an open sky pocket,
//   drawn behind the tokens and cut out of the ground's outline, so it sits
//   behind the cliff. A soft violet glow lights the sky round it.
// - below (Fafnir Castle - Entrance): no bolts; the clouds under the map flare.
// - Both: the churning mist (exploration-parallax.js) lights up for the strike,
//   the screen flickers faintly, and thunder follows a moment later on the
//   Ambient channel (deeper and quieter below).
//
// Each client storms on its own (like the map-ambience motes); nothing is
// written or synced. Reduced-motion players get no screen flicker. A hidden
// tab skips strikes. Scene Config "Ambient FX" off stops it, as map-ambience.
// Approved in the Sacrificial Altar mockup (2026-11-19).
// ============================================================================

import { readStormConfig, nextDelayMs, pickStrike, patternFor, patternLength, levelAt, makeBolt, thunderFor } from "./map-storm-core.js";

const MODULE_ID = "fabula-ultima-companion";
const TAG = "[ONI][MapStorm]";
const SORT_BEHIND = -100000;      // with map-ambience's glows: over the map, behind tokens
const FLASH_ID = "oni-map-storm-flash";

const state = { cfg: null, layer: null, gfx: null, glowTex: null, strikes: [], nextAt: 0, tick: null, sceneId: null };
const reduceMotion = () => { try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; } };

function readCfg(scene) {
  const fu = scene?.flags?.[MODULE_ID];
  if (fu?.surfaceFx && fu?.oniFabula?.general?.surfaceFxEnabled !== true) return null;
  return readStormConfig(fu?.ambience?.storm);
}

function glowTexture() {
  if (state.glowTex && !state.glowTex.baseTexture?.destroyed) return state.glowTex;
  const c = document.createElement("canvas"); c.width = c.height = 128;
  const g = c.getContext("2d"), gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, "rgba(255,255,255,1)"); gr.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  state.glowTex = PIXI.Texture.from(c);
  return state.glowTex;
}

function flashEl() {
  let el = document.getElementById(FLASH_ID);
  if (!el) {
    el = document.createElement("div");
    el.id = FLASH_ID;
    // Over the board, under every window: the board canvas sits at z-index 0.
    el.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:1;background:rgb(200,188,255);mix-blend-mode:screen;opacity:0";
    document.body.appendChild(el);
  }
  return el;
}

function teardown() {
  if (state.tick) { try { canvas.app.ticker.remove(state.tick); } catch { /* */ } state.tick = null; }
  if (state.layer) { try { state.layer.parent?.removeChild(state.layer); state.layer.destroy({ children: true }); } catch { /* */ } }
  state.layer = state.gfx = null; state.strikes = []; state.cfg = null;
  document.getElementById(FLASH_ID)?.style.setProperty("opacity", "0");
  try { globalThis.FUCompanion?.api?.walkParallax?.setFlash?.(0); } catch { /* */ }
}

function build() {
  teardown();
  const scene = canvas?.scene;
  const cfg = readCfg(scene);
  state.sceneId = scene?.id ?? null;
  if (!cfg) return;
  state.cfg = cfg;

  const layer = new PIXI.Container();
  layer.elevation = 0; layer.sortLayer = PrimaryCanvasGroup.SORT_LAYERS.TOKENS; layer.sort = SORT_BEHIND - 1; layer.eventMode = "none";
  canvas.primary.addChild(layer);
  state.layer = layer;
  state.gfx = new PIXI.Graphics(); state.gfx.blendMode = PIXI.BLEND_MODES.ADD;
  layer.addChild(state.gfx);

  // The ground's outline cut out of the sky: bolts and their glow stay behind it.
  if (cfg.solid) {
    const d = canvas.dimensions, m = new PIXI.Graphics();
    m.beginFill(0xffffff);
    m.drawRect(d.sceneX - 400, d.sceneY - 400, d.sceneWidth + 800, d.sceneHeight + 800);
    m.beginHole(); m.drawPolygon(cfg.solid.flatMap(([x, y]) => [d.sceneX + x, d.sceneY + y])); m.endHole();
    m.endFill();
    layer.addChild(m);
    layer.mask = m;
  }

  state.nextAt = performance.now() + 2500;
  state.tick = tick;
  canvas.app.ticker.add(state.tick);
}

function strike() {
  const cfg = state.cfg, d = canvas.dimensions;
  const s = pickStrike(cfg);                       // map-local px
  s.bolt = cfg.mode === "above" && !s.sheet ? makeBolt(s.x, s.y) : null;
  if (s.bolt) for (const line of [s.bolt.main, ...s.bolt.branches]) for (const p of line) { p[0] += d.sceneX; p[1] += d.sceneY; }
  s.x += d.sceneX; s.y += d.sceneY;              // canvas px from here on
  s.t0 = performance.now();
  s.pat = patternFor(cfg, s);
  const glow = new PIXI.Sprite(glowTexture());
  glow.anchor.set(0.5); glow.blendMode = PIXI.BLEND_MODES.ADD; glow.tint = 0xbaa6ff; glow.alpha = 0;
  const r = cfg.mode === "below" ? 300 : s.sheet ? 260 : 380;
  glow.width = glow.height = r * 2;
  glow.position.set(s.x, cfg.mode === "below" ? s.y + 60 : d.sceneY + (s.y - d.sceneY) * 0.7);
  state.layer.addChildAt(glow, 0);
  s.glow = glow;
  state.strikes.push(s);

  const th = thunderFor(cfg, s);
  const sceneId = state.sceneId;
  setTimeout(() => {
    if (canvas?.scene?.id !== sceneId || !state.cfg) return;
    try {
      const playing = foundry.audio.AudioHelper.play({ src: th.src, volume: th.volume, loop: false, channel: "environment" }, false);
      Promise.resolve(playing).then((sound) => {
        const p = sound?.sourceNode?.playbackRate;
        if (p && typeof p.value === "number") p.value = th.rate;
      }).catch(() => {});
    } catch (e) { console.warn(TAG, "thunder failed", e); }
  }, th.delayMs);
}

function tick() {
  try {
    const cfg = state.cfg, gfx = state.gfx;
    if (!cfg || !gfx || gfx.destroyed) return;
    const now = performance.now();
    if (document.visibilityState !== "hidden" && now >= state.nextAt) { strike(); state.nextAt = now + nextDelayMs(cfg); }

    gfx.clear();
    let flash = 0;
    state.strikes = state.strikes.filter((s) => {
      const ms = now - s.t0;
      if (ms > patternLength(s.pat) + 40) { s.glow?.destroy(); return false; }
      const k = levelAt(s.pat, ms);
      flash = Math.max(flash, k * (s.sheet && cfg.mode === "above" ? 0.55 : 1));
      s.glow.alpha = (cfg.mode === "below" ? 0.22 : s.sheet ? 0.3 : 0.38) * k;
      if (s.bolt && k > 0.01) {
        const line = (pts, w, color, a) => { gfx.lineStyle({ width: w, color, alpha: a, join: "round", cap: "round" }); gfx.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) gfx.lineTo(pts[i][0], pts[i][1]); };
        line(s.bolt.main, 10, 0xb496ff, 0.25 * k);               // outer glow
        line(s.bolt.main, 4, 0xe8deff, 0.9 * k);
        for (const b of s.bolt.branches) line(b, 2, 0xe8deff, 0.6 * k);
        line(s.bolt.main, 1.5, 0xffffff, k);
      }
      return true;
    });

    try { globalThis.FUCompanion?.api?.walkParallax?.setFlash?.(flash * cfg.mist); } catch { /* */ }
    const el = cfg.flash > 0 && !reduceMotion() ? flashEl() : null;
    if (el) el.style.opacity = String(flash * cfg.flash);
  } catch (e) {
    console.warn(TAG, "Frame failed; storm off until the scene is redrawn.", e);
    teardown();
  }
}

Hooks.on("canvasReady", () => { try { build(); } catch (e) { console.warn(TAG, "build failed", e); } });
Hooks.on("canvasTearDown", () => teardown());
Hooks.on("updateScene", (scene, change) => {
  if (scene?.id === canvas?.scene?.id && change?.flags?.[MODULE_ID]?.ambience !== undefined) {
    setTimeout(() => { try { if (canvas?.ready) build(); } catch (e) { console.warn(TAG, "build failed", e); } }, 250);
  }
});

Hooks.once("ready", () => {
  globalThis.FUCompanion ??= {};
  globalThis.FUCompanion.api ??= {};
  globalThis.FUCompanion.api.mapStorm = {
    /** Strike now (testing / a scripted moment). */
    strike: () => { if (state.cfg && state.layer) strike(); return !!state.cfg; },
    status: () => ({ on: !!state.cfg, cfg: state.cfg, strikes: state.strikes.length })
  };
});
