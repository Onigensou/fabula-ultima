/**
 * Fabula Ultima Companion - Map ambience (wisps, motes, sparks, crystal glows)
 * Foundry VTT v12
 *
 * File:
 * scripts/map-system/map-ambience.js
 *
 * What this does:
 * - Draws a walk map's living details exactly as the approved Maelstrom
 *   Confluence mockup drew them, from one scene flag:
 *     flags.fabula-ultima-companion.ambience = {
 *       wisps:  { alpha: 0.2 }                       near mist drifting over everything
 *       motes:  { count: 70 }                        specks rising and twinkling round the view
 *       sparks: [{ x, y, rx, ry }]                   some motes rise from these (the living sigils)
 *       glows:  [[x, y, r]]                          soft pulsing glows on painted crystals
 *     }
 * - Layers: glows sit among the tokens' layer but behind them (over the island
 *   and stone tiles); motes and sparks in front of the tokens; wisps over all.
 * - A glow inside a bobbing tile (tile-bob.js) rides that tile.
 *
 * Client-only, writes nothing. Reduced-motion players get the glows, still,
 * and no wisps or motes. A hidden tab skips the work.
 */

(() => {
  const TAG = "[ONI][MapAmbience]";
  const MODULE_ID = "fabula-ultima-companion";
  const FLAG = "ambience";

  window.oni = window.oni || {};
  if (window.oni.MapAmbience?.installed) return;

  // Numbers from the mockup (scratchpad maelstrom.src.html: WISP_FRAG, drawMotes, drawCrystals).
  const MOTE = { sigilShare: 0.3, color: 0xd6aaff, alpha: 0.5, sigilColor: 0xffd6ff, sigilAlpha: 0.75, sway: 6, spreadX: 1.1 };
  const SORT_BEHIND = -100000;   // event-worldFx.js SORT.BEHIND_TOKENS
  const SORT_FRONT = 1000000;    // SORT.OVER_TOKENS

  const reduceMotion = () => matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;

  const WISP_VERT = `
attribute vec2 aVertexPosition;
uniform mat3 projectionMatrix;
uniform mat3 translationMatrix;
varying vec2 vWorld;
void main() {
  vWorld = aVertexPosition;
  gl_Position = vec4((projectionMatrix * translationMatrix * vec3(aVertexPosition, 1.0)).xy, 0.0, 1.0);
}`;
  const WISP_FRAG = `
precision highp float;
varying vec2 vWorld;
uniform vec2 uCam;
uniform vec2 uMap;
uniform float uTime;
uniform float uAlpha;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) { vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y); }
float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; } return v; }
void main() {
  vec2 q = vWorld + (uCam - uMap * 0.5) * 0.35;   // a near layer: drifts faster than the camera
  float n = fbm(q * 0.0038 + vec2(uTime * 0.03, uTime * 0.008));
  float n2 = fbm(q * 0.0085 - vec2(uTime * 0.018, -uTime * 0.006));
  float a = smoothstep(0.56, 0.9, n * 0.72 + n2 * 0.44) * uAlpha;
  gl_FragColor = vec4(vec3(0.8, 0.62, 0.96) * a, a);
}`;

  const state = { cfg: null, root: null, glowLayer: null, frontLayer: null, wisp: null, glows: [], motes: [], tick: null, t0: performance.now(), last: performance.now() };
  let dotTex = null, glowTex = null;

  function makeTextures() {
    if (!dotTex) {
      const c = document.createElement("canvas"); c.width = c.height = 32;
      const g = c.getContext("2d"); g.fillStyle = "#fff"; g.beginPath(); g.arc(16, 16, 15, 0, Math.PI * 2); g.fill();
      dotTex = PIXI.Texture.from(c);
    }
    if (!glowTex) {
      const c = document.createElement("canvas"); c.width = c.height = 128;
      const g = c.getContext("2d"), gr = g.createRadialGradient(64, 64, 2, 64, 64, 64);
      gr.addColorStop(0, "rgba(226,170,255,1)"); gr.addColorStop(0.45, "rgba(178,108,255,0.5)"); gr.addColorStop(1, "rgba(150,70,240,0)");
      g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
      glowTex = PIXI.Texture.from(c);
    }
  }

  function readCfg(scene) {
    const raw = scene?.flags?.[MODULE_ID]?.[FLAG];
    return raw && typeof raw === "object" ? raw : null;
  }

  function layer(sort) {
    const c = new PIXI.Container();
    c.elevation = 0;
    c.sortLayer = PrimaryCanvasGroup.SORT_LAYERS.TOKENS;
    c.sort = sort;
    c.eventMode = "none";
    canvas.primary.addChild(c);
    return c;
  }

  function teardown() {
    if (state.tick) { try { canvas.app.ticker.remove(state.tick); } catch (_) {} state.tick = null; }
    for (const c of [state.glowLayer, state.frontLayer, state.wisp]) { try { c?.parent?.removeChild(c); c?.destroy({ children: true }); } catch (_) {} }
    state.glowLayer = state.frontLayer = state.wisp = null;
    state.glows = []; state.motes = []; state.cfg = null;
  }

  // The view the camera shows, in map px.
  function view() {
    const s = canvas.stage.scale.x || 1;
    const scr = canvas.screenDimensions ?? [window.innerWidth, window.innerHeight];
    return { x: canvas.stage.pivot.x, y: canvas.stage.pivot.y, w: scr[0] / s, h: scr[1] / s };
  }

  function seedMote(m, anywhere) {
    const v = view(), sparks = state.cfg.sparks ?? [];
    const sig = sparks.length && Math.random() < MOTE.sigilShare ? sparks[Math.floor(Math.random() * sparks.length)] : null;
    if (sig) {
      const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random());
      m.x = sig.x + Math.cos(a) * sig.rx * 0.8 * r; m.y = sig.y + Math.sin(a) * sig.ry * 0.8 * r;
      m.sig = true; m.vy = 10 + Math.random() * 12; m.life = 2.2 + Math.random() * 1.6;
    } else {
      m.x = v.x + (Math.random() - 0.5) * v.w * MOTE.spreadX;
      m.y = anywhere ? v.y + (Math.random() - 0.5) * v.h : v.y + v.h * (0.25 + Math.random() * 0.35);
      m.sig = false; m.vy = 6 + Math.random() * 9; m.life = 4 + Math.random() * 6;
    }
    m.max = m.life; m.sz = 0.9 + Math.random() * 1.6; m.sw = 0.6 + Math.random() * 0.8; m.ph = Math.random() * Math.PI * 2;
    m.sprite.tint = m.sig ? MOTE.sigilColor : MOTE.color;
    const d = 2 * m.sz * (m.sig ? 1.2 : 1);
    m.sprite.width = m.sprite.height = d;
  }

  // A glow inside a bobbing tile rides it.
  function bobOffset(x, y) {
    for (const tile of canvas.tiles?.placeables ?? []) {
      const d = tile.document;
      if (!d.flags?.[MODULE_ID]?.bob || !tile.mesh) continue;
      if (x >= d.x && x <= d.x + d.width && y >= d.y && y <= d.y + d.height) return tile;
    }
    return null;
  }

  function build() {
    teardown();
    const scene = canvas?.scene;
    const cfg = readCfg(scene);
    if (!cfg) return;
    state.cfg = cfg;
    makeTextures();
    const still = reduceMotion();

    // glows
    state.glowLayer = layer(SORT_BEHIND);
    (cfg.glows ?? []).forEach(([x, y, r], i) => {
      const s = new PIXI.Sprite(glowTex);
      s.anchor.set(0.5); s.width = s.height = r * 2; s.position.set(x, y);
      s.blendMode = PIXI.BLEND_MODES.ADD;
      state.glowLayer.addChild(s);
      state.glows.push({ s, x, y, i, tile: bobOffset(x, y) });
    });

    // motes and sparks
    state.frontLayer = layer(SORT_FRONT);
    if (!still && cfg.motes) {
      for (let i = 0; i < (Number(cfg.motes.count) || 70); i++) {
        const sprite = new PIXI.Sprite(dotTex);
        sprite.anchor.set(0.5); sprite.blendMode = PIXI.BLEND_MODES.ADD;
        state.frontLayer.addChild(sprite);
        const m = { sprite }; seedMote(m, true); state.motes.push(m);
      }
    }

    // wisps
    if (!still && cfg.wisps) {
      const d = canvas.dimensions;
      const r = { x: d.sceneX, y: d.sceneY, w: d.sceneWidth, h: d.sceneHeight };
      const geom = new PIXI.Geometry()
        .addAttribute("aVertexPosition", [r.x, r.y, r.x + r.w, r.y, r.x + r.w, r.y + r.h, r.x, r.y + r.h], 2)
        .addIndex([0, 1, 2, 0, 2, 3]);
      const shader = PIXI.Shader.from(WISP_VERT, WISP_FRAG, { uCam: [0, 0], uMap: [r.w, r.h], uTime: 0, uAlpha: Number(cfg.wisps.alpha) || 0.2 });
      const mesh = new PIXI.Mesh(geom, shader);
      mesh.elevation = 0; mesh.sortLayer = PrimaryCanvasGroup.SORT_LAYERS.TOKENS; mesh.sort = SORT_FRONT + 1;
      mesh.eventMode = "none";
      canvas.primary.addChild(mesh);
      state.wisp = mesh;
    }

    state.last = performance.now();
    state.tick = tick;
    canvas.app.ticker.add(state.tick);
  }

  function tick() {
    try {
      const now = performance.now();
      const dt = Math.min(0.05, (now - state.last) / 1000);
      state.last = now;
      if (document.visibilityState === "hidden") return;
      const t = (now - state.t0) / 1000;
      const still = reduceMotion();

      for (const g of state.glows) {
        const a = still ? 0.16 : 0.16 + 0.12 * Math.sin(t * (1.1 + (g.i % 5) * 0.17) + g.i * 1.9);
        g.s.alpha = a + 0.12;
        const tile = g.tile;
        const by = tile?.mesh ? tile.mesh.y - (tile.document.y + tile.document.height / 2) : 0;
        g.s.y = g.y + by;
      }

      for (const m of state.motes) {
        m.y -= m.vy * dt;
        m.x += Math.sin(t * m.sw + m.ph) * MOTE.sway * dt;
        m.life -= dt;
        if (m.life <= 0) seedMote(m, false);
        const u = m.life / m.max, fade = Math.min(1, u * 3) * Math.min(1, (1 - u) * 4), tw = 0.6 + 0.4 * Math.sin(t * 5 + m.ph * 3);
        m.sprite.position.set(m.x, m.y);
        m.sprite.alpha = (m.sig ? MOTE.sigilAlpha : MOTE.alpha) * fade * tw;
      }

      if (state.wisp && !state.wisp.destroyed) {
        const un = state.wisp.shader.uniforms;
        un.uCam[0] = canvas.stage.pivot.x - canvas.dimensions.sceneX;
        un.uCam[1] = canvas.stage.pivot.y - canvas.dimensions.sceneY;
        un.uTime = t;
      }
    } catch (e) {
      console.warn(TAG, "Frame failed; ambience off until the scene is redrawn.", e);
      teardown();
    }
  }

  Hooks.on("canvasReady", () => { try { build(); } catch (e) { console.warn(TAG, "build failed", e); } });
  Hooks.on("canvasTearDown", () => teardown());
  Hooks.on("updateScene", (scene, change) => {
    // After the update settles: the same update may also redraw the canvas.
    if (scene?.id === canvas?.scene?.id && change?.flags?.[MODULE_ID]?.[FLAG] !== undefined) {
      setTimeout(() => { try { if (canvas?.ready) build(); } catch (e) { console.warn(TAG, "build failed", e); } }, 250);
    }
  });

  window.oni.MapAmbience = { installed: true, rebuild: build, FLAG };
  console.debug(TAG, "Installed. API: window.oni.MapAmbience");
})();
