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
 *               or { x, y, r, color: 0xffb46e, flicker: true, alpha: 0.45 }
 *                                                    a coloured glow; flicker = a candle's
 *                                                    fast uneven flicker instead of the pulse
 *                                                    (Fafnir Castle - Entrance)
 *       shafts: { items: [[x, w, phase]], length: 820, lean: -150, alpha: 0.1, color: 0xdccdff }
 *                                                    light shafts falling from the map's top
 *                                                    edge at x (w wide there, 2.4 w at the
 *                                                    foot), shimmering and swaying slowly
 *       clouds: { layers: [{ s, spin, dx, dy, a }], pivot: [x, y], density: 1, flash: 0.7 }
 *                                                    the Sacrificial Altar mockup's cloud sea,
 *                                                    ported as is: soft fbm noise sheets (made
 *                                                    here, 256 px, the mockup's colours) that
 *                                                    turn round pivot (map px) at spin rad/s and
 *                                                    drift dx, dy px/s, s = map px per noise px,
 *                                                    a = alpha; drawn only where the walk-depth
 *                                                    weight map's green says mist; a lightning
 *                                                    strike (map-storm.js) lifts them additively
 *       motes:  { count: 60, fromMist: true, ember: 0.2 }
 *                                                    fromMist: the specks rise out of the
 *                                                    walk-parallax mist (the weight map's
 *                                                    green), a share of them warm embers
 *       spores: { preset: "gas" | "crystal" | "ember" | "dust", points: [[x, y]] }
 *                                                    rising specks (Underground Decor mockup):
 *                                                    "gas" rise out of the surface mask,
 *                                                    "crystal" mostly from the points,
 *                                                    "dust" pale specks hanging anywhere in view
 *                                                    (a list of these runs several presets at once)
 *       puffs:  true                                 gas belches rising from the mask (behind tokens)
 *       drips:  true                                 drops falling onto the mask, rings spreading
 *       drips:  { points: [[x, y]], fall: [min, max], land: "dust" | "rings" }
 *                                                    drops falling from these ceiling points,
 *                                                    landing min..max px lower in a dust puff
 *                                                    (Cave Dwelling) or rings
 *       clips:  [{ base, x, y, w, alpha }]           looping pixelfx decor clips (fireflies…):
 *                                                    <base>_back.webm behind tokens,
 *                                                    <base>_front.webm over them,
 *                                                    <base>_light.webm over them, blend ADD.
 *                                                    x, y = the clip's bottom-centre on the map,
 *                                                    w = width in map px. A single file instead:
 *                                                    { src, x, y, w, alpha, blend: "add", front }
 *     }
 *   spores/puffs/drips spawn from the surface FX mask
 *   (assets/surface-fx/<background>.webp, see map-surface-fx.js).
 *   Scene Config "Ambient FX" set to OFF (surfaceFxEnabled false) stops all of it.
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

  const state = { cfg: null, root: null, glowLayer: null, frontLayer: null, wisp: null, glows: [], motes: [], tick: null, t0: performance.now(), last: performance.now(),
    cand: null, spores: [], puffs: [], drips: [], dripGfx: null, puffT: 0, dripT: 0, buildId: 0,
    clipVideos: [], clipTextures: [], shafts: [], mistCand: null, clouds: null, flash: 0 };
  let dotTex = null, glowTex = null, sporeTex = null, puffTex = null, whiteGlowTex = null, shaftTex = null;
  const WEIGHT_DIR = "modules/fabula-ultima-companion/assets/walk-depth";
  const EMBER = 0xffaa64;
  // A candle's flicker: three uneven sines (Sacrificial Altar mockup, flick()).
  const flick = (t, ph) => 0.78 + 0.12 * Math.sin(t * 10.3 + ph * 3) + 0.08 * Math.sin(t * 24.4 + ph * 7) + 0.06 * Math.sin(t * 4.3 + ph);
  // A glow entry, array or object, as one shape.
  function glowEntry(e) {
    if (Array.isArray(e)) return { x: +e[0], y: +e[1], r: +e[2] };
    if (e && typeof e === "object") return { x: +e.x, y: +e.y, r: +e.r, color: Number.isFinite(+e.color) ? +e.color : null, flicker: e.flicker === true, alpha: Number.isFinite(+e.alpha) ? +e.alpha : null };
    return null;
  }

  // Numbers from the Underground Decor mockup (stepParticles / drawFx).
  const SPORE = {
    gas: { cap: 90, rate: 40, vy: [22, 55], color: 0xc8ff82, fromPoints: 0 },
    crystal: { cap: 46, rate: 14, vy: [10, 26], color: 0xd7afff, fromPoints: 0.7 },
    // Valley camp mockup (2026-11-06): sparks off a campfire, bright at birth, fading out.
    ember: { cap: 10, rate: 5, vy: [22, 42], color: 0xffa64d, fromPoints: 1, jitter: [12, 5], life: [1.4, 2.8], size: [8, 14], fadeOut: true },
    // Cave Dwelling mockup (2026-11-07): slow pale dust hanging in the room light.
    dust: { cap: 40, rate: 9, vy: [-3, 4], color: 0xd2c8be, anywhere: true, life: [5, 9], size: [5, 10], alpha: 0.35, sway: 4 },
  };
  const sporeList = (cfg) => (Array.isArray(cfg?.spores) ? cfg.spores : cfg?.spores ? [cfg.spores] : [])
    .filter((s) => s && SPORE[s.preset]);
  const pointDrips = (cfg) => (cfg?.drips && typeof cfg.drips === "object" && Array.isArray(cfg.drips.points) && cfg.drips.points.length ? cfg.drips : null);
  const MASK_DIR = "modules/fabula-ultima-companion/assets/surface-fx";
  const rnd = (a, b) => a + Math.random() * (b - a);

  function makeParticleTextures() {
    if (!sporeTex) {   // the mock's spore gradient: a, a*.35 at 35%, 0 at the edge
      const c = document.createElement("canvas"); c.width = c.height = 64;
      const g = c.getContext("2d"), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      gr.addColorStop(0, "rgba(255,255,255,1)"); gr.addColorStop(0.35, "rgba(255,255,255,0.35)"); gr.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
      sporeTex = PIXI.Texture.from(c);
    }
    if (!puffTex) {    // the mock's belch gradient at full strength; sprite alpha carries the mock's a
      const c = document.createElement("canvas"); c.width = c.height = 128;
      const g = c.getContext("2d"), gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
      gr.addColorStop(0, "rgba(150,235,95,1)"); gr.addColorStop(0.55, "rgba(95,190,60,0.5)"); gr.addColorStop(1, "rgba(60,140,40,0)");
      g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
      puffTex = PIXI.Texture.from(c);
    }
  }

  function backdropKey(src) {
    if (typeof src !== "string" || !src) return null;
    let s = src.split(/[?#]/)[0];
    s = s.slice(s.lastIndexOf("/") + 1);
    try { s = decodeURIComponent(s); } catch (_) { /* keep raw */ }
    const dot = s.lastIndexOf(".");
    return (dot > 0 ? s.slice(0, dot) : s) || null;
  }

  // Spawn points where the surface mask is solid (the mock's candidate rule).
  function loadCandidates(scene, id) {
    const key = backdropKey(scene?.background?.src);
    if (!key) return;
    const img = new Image();
    img.onload = () => {
      if (id !== state.buildId) return;
      try {
        const w = img.naturalWidth, h = img.naturalHeight, c = document.createElement("canvas"); c.width = w; c.height = h;
        const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(img, 0, 0);
        const px = g.getImageData(0, 0, w, h).data, d = canvas.dimensions;
        const kx = d.sceneWidth / w, ky = d.sceneHeight / h, out = [];
        for (let i = 0; i < w * h; i++) {
          if (px[i * 4] > 0.85 * 255 && i % 3 === 0) out.push([d.sceneX + ((i % w) + Math.random()) * kx, d.sceneY + (Math.floor(i / w) + Math.random()) * ky]);
        }
        state.cand = out;
      } catch (e) { console.warn(TAG, "mask read failed; no gas/drip spawns", e); }
    };
    img.onerror = () => { if (id === state.buildId) console.warn(TAG, `no surface mask for ${key}; puffs/drips/gas spores off`); };
    img.src = `${MASK_DIR}/${key}.webp`;
  }

  function inView(v, x, y, pad = 80) { return Math.abs(x - v.x) < v.w / 2 + pad && Math.abs(y - v.y) < v.h / 2 + pad; }
  function pickCand(v) {
    const L = state.cand; if (!L || !L.length) return null;
    for (let i = 0; i < 12; i++) { const p = L[(Math.random() * L.length) | 0]; if (inView(v, p[0], p[1])) return p; }
    return null;
  }

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
    if (!whiteGlowTex) {   // for coloured glows: the tint carries the colour
      const c = document.createElement("canvas"); c.width = c.height = 128;
      const g = c.getContext("2d"), gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
      gr.addColorStop(0, "rgba(255,255,255,1)"); gr.addColorStop(0.35, "rgba(255,255,255,0.38)"); gr.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
      whiteGlowTex = PIXI.Texture.from(c);
    }
    if (!shaftTex) {       // a light shaft: bright at the top, gone at the foot
      const c = document.createElement("canvas"); c.width = 8; c.height = 256;
      const g = c.getContext("2d"), gr = g.createLinearGradient(0, 0, 0, 256);
      gr.addColorStop(0, "rgba(255,255,255,1)"); gr.addColorStop(0.6, "rgba(255,255,255,0.62)"); gr.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = gr; g.fillRect(0, 0, 8, 256);
      shaftTex = PIXI.Texture.from(c);
    }
  }

  // The mockup's cloud noise (altar.js NOISE): 256 px tileable fbm, 4 octaves, lavender,
  // alpha from a smoothstep of the noise. Random each load, as in the mockup.
  let cloudTex = null;
  function cloudTexture() {
    if (cloudTex && !cloudTex.baseTexture?.destroyed) return cloudTex;
    const N = 256, c = document.createElement("canvas"); c.width = c.height = N;
    const x = c.getContext("2d"), img = x.createImageData(N, N);
    const lerp = (a, b, t) => a + (b - a) * t, sm = (t) => t * t * (3 - 2 * t);
    const octs = [4, 8, 16, 32].map((p) => ({ p, L: Array.from({ length: p * p }, Math.random) }));
    const val = (o, xx, yy) => {
      const f = o.p / N, gx = xx * f, gy = yy * f, x0 = Math.floor(gx), y0 = Math.floor(gy), tx = sm(gx - x0), ty = sm(gy - y0), P = o.p;
      const at = (i, j) => o.L[((j % P + P) % P) * P + ((i % P + P) % P)];
      return lerp(lerp(at(x0, y0), at(x0 + 1, y0), tx), lerp(at(x0, y0 + 1), at(x0 + 1, y0 + 1), tx), ty);
    };
    for (let yy = 0; yy < N; yy++) for (let xx = 0; xx < N; xx++) {
      let v = 0, a = 0.5, tot = 0; for (const o of octs) { v += val(o, xx, yy) * a; tot += a; a *= 0.5; } v /= tot;
      const k = Math.max(0, Math.min(1, (v - 0.38) / 0.42)), al = k * k * (3 - 2 * k), i = (yy * N + xx) * 4, lift = 0.75 + 0.45 * v;
      img.data[i] = Math.min(255, 150 * lift); img.data[i + 1] = Math.min(255, 134 * lift); img.data[i + 2] = Math.min(255, 186 * lift); img.data[i + 3] = 255 * al;
    }
    x.putImageData(img, 0, 0);
    cloudTex = PIXI.Texture.from(c);
    cloudTex.baseTexture.wrapMode = PIXI.WRAP_MODES.REPEAT;
    return cloudTex;
  }

  // The clouds: two stacks of the same sheets (normal, and additive for a strike), each
  // masked by the weight map's mist, between the storm's bolts and the glows.
  function buildClouds(scene, cfg, id) {
    const key = backdropKey(scene?.background?.src);
    if (!key) return;
    const img = new Image();
    img.onload = () => {
      if (id !== state.buildId) return;
      try {
        const w = img.naturalWidth, h = img.naturalHeight, c = document.createElement("canvas"); c.width = w; c.height = h;
        const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(img, 0, 0);
        const d = g.getImageData(0, 0, w, h);
        for (let i = 0; i < w * h; i++) { const m = d.data[i * 4 + 1]; d.data[i * 4] = d.data[i * 4 + 1] = d.data[i * 4 + 2] = m; d.data[i * 4 + 3] = 255; }
        g.putImageData(d, 0, 0);
        const maskTex = PIXI.Texture.from(c);
        const dim = canvas.dimensions, tex = cloudTexture();
        const layers = (Array.isArray(cfg.layers) ? cfg.layers : []).map((L) => ({ s: +L.s || 2, spin: +L.spin || 0, dx: +L.dx || 0, dy: +L.dy || 0, a: Number.isFinite(+L.a) ? +L.a : 0.4 }));
        const pivot = Array.isArray(cfg.pivot) ? [+cfg.pivot[0], +cfg.pivot[1]] : [dim.sceneWidth / 2, dim.sceneHeight * 0.9];
        const stack = (add) => {
          const box = new PIXI.Container();
          box.elevation = 0; box.sortLayer = PrimaryCanvasGroup.SORT_LAYERS.TOKENS; box.sort = SORT_BEHIND - 0.5; box.eventMode = "none";
          box.position.set(dim.sceneX, dim.sceneY);
          const sprites = layers.map((L) => {
            const t = new PIXI.TilingSprite(tex, dim.sceneWidth, dim.sceneHeight);
            t.alpha = L.a * (Number(cfg.density) || 1);
            if (add) t.blendMode = PIXI.BLEND_MODES.ADD;
            box.addChild(t);
            return t;
          });
          const mask = new PIXI.Sprite(maskTex); mask.width = dim.sceneWidth; mask.height = dim.sceneHeight;
          box.addChild(mask); box.mask = mask;
          canvas.primary.addChild(box);
          return { box, sprites };
        };
        state.clouds = { layers, pivot, normal: stack(false), lit: stack(true), flashK: Number.isFinite(+cfg.flash) ? +cfg.flash : 0.7, maskTex };
        state.clouds.lit.box.alpha = 0;
        placeClouds((performance.now() - state.t0) / 1000);
      } catch (e) { console.warn(TAG, "clouds failed", e); }
    };
    img.onerror = () => { if (id === state.buildId) console.warn(TAG, `no weight map for ${key}; no clouds`); };
    img.src = `${WEIGHT_DIR}/${key}.webp`;
  }

  // The mockup's pattern transform: translate(P) rotate(spin t) translate(-P + drift t) scale(s).
  function placeClouds(t) {
    const C = state.clouds; if (!C) return;
    const still = reduceMotion(), sec = still ? 0 : t;
    C.layers.forEach((L, i) => {
      const th = sec * L.spin, cs = Math.cos(th), sn = Math.sin(th);
      const ex = sec * L.dx - C.pivot[0], ey = sec * L.dy - C.pivot[1];
      const px = C.pivot[0] + cs * ex - sn * ey, py = C.pivot[1] + sn * ex + cs * ey;
      for (const st of [C.normal, C.lit]) {
        const sp = st.sprites[i]; if (!sp || sp.destroyed) continue;
        sp.tileTransform.position.set(px, py);
        sp.tileTransform.rotation = th;
        sp.tileTransform.scale.set(L.s, L.s);
      }
    });
    C.lit.box.alpha = Math.min(1, state.flash * C.flashK);
  }

  // Where the walk-parallax mist is (the weight map's green), for motes that rise out of it.
  function loadMistCandidates(scene, id) {
    const key = backdropKey(scene?.background?.src);
    if (!key) return;
    const img = new Image();
    img.onload = () => {
      if (id !== state.buildId) return;
      try {
        const w = img.naturalWidth, h = img.naturalHeight, c = document.createElement("canvas"); c.width = w; c.height = h;
        const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(img, 0, 0);
        const px = g.getImageData(0, 0, w, h).data, d = canvas.dimensions;
        const kx = d.sceneWidth / w, ky = d.sceneHeight / h, out = [];
        for (let i = 0; i < w * h; i += 3) if (px[i * 4 + 1] > 0.55 * 255) out.push([d.sceneX + ((i % w) + Math.random()) * kx, d.sceneY + (Math.floor(i / w) + Math.random()) * ky]);
        state.mistCand = out;
      } catch (e) { console.warn(TAG, "mist read failed; motes rise anywhere", e); }
    };
    img.onerror = () => { if (id === state.buildId) console.warn(TAG, `no weight map for ${key}; motes rise anywhere`); };
    img.src = `${WEIGHT_DIR}/${key}.webp`;
  }

  function readCfg(scene) {
    // Scene Config "Ambient FX" off — only on scenes set up for surface FX: an unticked
    // box saves false on every scene, and Maelstrom's ambience has no such switch.
    const fu = scene?.flags?.[MODULE_ID];
    if (fu?.surfaceFx && fu?.oniFabula?.general?.surfaceFxEnabled !== true) return null;
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
    for (const c of [state.glowLayer, state.frontLayer, state.wisp, state.clouds?.normal?.box, state.clouds?.lit?.box]) { try { c?.parent?.removeChild(c); c?.destroy({ children: true }); } catch (_) {} }
    try { state.clouds?.maskTex?.destroy(true); } catch (_) {}
    state.clouds = null; state.flash = 0;
    state.glowLayer = state.frontLayer = state.wisp = null;
    for (const v of state.clipVideos) { try { v.pause(); v.removeAttribute("src"); v.load(); } catch (_) {} }
    for (const t of state.clipTextures) { try { t.destroy(true); } catch (_) {} }
    state.clipVideos = []; state.clipTextures = [];
    state.glows = []; state.motes = []; state.cfg = null; state.shafts = []; state.mistCand = null;
    state.spores = []; state.puffs = []; state.drips = []; state.dripGfx = null; state.cand = null; state.buildId++;
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
    const mc = state.cfg.motes?.fromMist ? state.mistCand : null;
    let mp = null;
    if (mc?.length) for (let i = 0; i < 12 && !mp; i++) { const p = mc[(Math.random() * mc.length) | 0]; if (inView(v, p[0], p[1], 120)) mp = p; }
    if (mp) {
      // rising out of the cloud: faster, a share of them warm embers (Fafnir Castle - Entrance)
      m.x = mp[0]; m.y = mp[1]; m.sig = false; m.vy = 45 + Math.random() * 40; m.life = 3 + Math.random() * 2.5;
      m.max = m.life; m.sz = 0.8 + Math.random() * 1.3; m.sw = 1 + Math.random(); m.ph = Math.random() * Math.PI * 2;
      m.ember = Math.random() < (Number(state.cfg.motes.ember) || 0);
      m.sprite.tint = m.ember ? EMBER : MOTE.color;
      m.sprite.width = m.sprite.height = 2 * m.sz;
      return;
    }
    m.ember = false;
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
    (cfg.glows ?? []).map(glowEntry).filter((e) => e && Number.isFinite(e.x) && Number.isFinite(e.y) && e.r > 0).forEach((e, i) => {
      const { x, y, r } = e;
      const s = new PIXI.Sprite(e.color !== null && e.color !== undefined ? whiteGlowTex : glowTex);
      s.anchor.set(0.5); s.width = s.height = r * 2; s.position.set(x, y);
      s.blendMode = PIXI.BLEND_MODES.ADD;
      if (e.color !== null && e.color !== undefined) s.tint = e.color;
      state.glowLayer.addChild(s);
      state.glows.push({ s, x, y, i, tile: bobOffset(x, y), flicker: e.flicker === true, peak: e.alpha });
    });

    // the cloud sea (Sacrificial Altar mockup), still for reduced motion
    if (cfg.clouds && Array.isArray(cfg.clouds.layers) && cfg.clouds.layers.length) buildClouds(scene, cfg.clouds, state.buildId);

    // light shafts from the top edge
    if (cfg.shafts && Array.isArray(cfg.shafts.items)) {
      const d = canvas.dimensions, sh = cfg.shafts;
      for (const [x, w, ph] of cfg.shafts.items) {
        const plane = new PIXI.SimplePlane(shaftTex, 2, 2);
        plane.blendMode = PIXI.BLEND_MODES.ADD; plane.tint = Number.isFinite(+sh.color) ? +sh.color : 0xdccdff;
        state.glowLayer.addChild(plane);
        state.shafts.push({ plane, x: d.sceneX + +x, top: d.sceneY, w: +w || 80, ph: +ph || 0, len: +sh.length || 820, lean: Number.isFinite(+sh.lean) ? +sh.lean : -150, alpha: Number.isFinite(+sh.alpha) ? +sh.alpha : 0.1 });
      }
    }

    // motes and sparks
    state.frontLayer = layer(SORT_FRONT);
    if (!still && cfg.motes) {
      if (cfg.motes.fromMist) loadMistCandidates(scene, state.buildId);
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

    // spores, belches, drips (Underground Decor)
    if (!still && (cfg.spores || cfg.puffs || cfg.drips)) {
      makeParticleTextures();
      if (cfg.puffs || (cfg.drips && !pointDrips(cfg)) || sporeList(cfg).some((s) => s.preset === "gas")) loadCandidates(scene, state.buildId);
      if (cfg.drips) { state.dripGfx = new PIXI.Graphics(); state.glowLayer.addChild(state.dripGfx); }
    }

    // looping decor clips (pixelfx exports)
    if (!still && Array.isArray(cfg.clips) && cfg.clips.length) loadClips(cfg.clips, state.buildId);

    state.last = performance.now();
    state.tick = tick;
    canvas.app.ticker.add(state.tick);
  }

  // One looping webm as a sprite with its own <video> (a clone of Foundry's cached
  // texture, so nothing else that shows this file is yanked around).
  async function loopSprite(url, id) {
    const tex = await loadTexture(url);
    const src = tex?.baseTexture?.resource?.source;
    if (id !== state.buildId || !(src instanceof HTMLVideoElement) || !game.video?.cloneTexture) return null;
    const texture = await game.video.cloneTexture(src);
    const video = texture?.baseTexture?.resource?.source;
    if (id !== state.buildId || !video) { try { texture?.destroy(true); } catch (_) {} return null; }
    video.muted = true; video.loop = true;
    state.clipVideos.push(video); state.clipTextures.push(texture);
    return { sprite: new PIXI.Sprite(texture), video };
  }

  async function loadClips(list, id) {
    for (const c of list) {
      const parts = c.src
        ? [{ url: c.src, front: c.front !== false, add: c.blend === "add" }]
        : [{ url: `${c.base}_back.webm`, front: false }, { url: `${c.base}_front.webm`, front: true }, { url: `${c.base}_light.webm`, front: true, add: true }];
      try {
        const made = (await Promise.all(parts.map(async (p) => ({ p, s: await loopSprite(p.url, id) })))).filter((m) => m.s);
        if (id !== state.buildId) return;
        for (const { p, s } of made) {
          const tex = s.sprite.texture, w = Number(c.w) || tex.width;
          s.sprite.anchor.set(0.5, 1);
          s.sprite.width = w; s.sprite.height = w * (tex.height / (tex.width || 1));
          s.sprite.position.set(Number(c.x) || 0, Number(c.y) || 0);
          s.sprite.alpha = c.alpha ?? 1;
          if (p.add) s.sprite.blendMode = PIXI.BLEND_MODES.ADD;
          (p.front ? state.frontLayer : state.glowLayer)?.addChild(s.sprite);
        }
        // start the layers of one clip together so they stay in step
        for (const { s } of made) { try { s.video.currentTime = 0; } catch (_) {} s.video.play().catch(() => {}); }
      } catch (e) { console.warn(TAG, "clip failed", c, e); }
    }
  }

  // The mock's stepParticles + drawFx, on PIXI sprites. Map px throughout.
  function stepUnderground(dt, v) {
    const cfg = state.cfg;

    // spores (in front of tokens), one or more presets
    for (const entry of sporeList(cfg)) {
    const sp = SPORE[entry.preset];
    if (state.spores.filter((q) => q.preset === entry.preset).length < sp.cap && Math.random() < dt * sp.rate) {
      let p = null;
      const pts = Array.isArray(entry.points) ? entry.points : [];
      if (sp.anywhere) p = [v.x + rnd(-0.5, 0.5) * v.w, v.y + rnd(-0.5, 0.5) * v.h];
      else if (sp.fromPoints > 0) {
        const [jx, jy] = sp.jitter ?? [20, 10];
        if (pts.length && Math.random() < sp.fromPoints) { const c = pts[(Math.random() * pts.length) | 0]; p = [c[0] + rnd(-jx, jx), c[1] + rnd(-jy, jy)]; }
        else if (sp.fromPoints < 1) p = [v.x + rnd(-0.5, 0.5) * v.w, v.y + rnd(-0.5, 0.5) * v.h];
      } else p = pickCand(v);
      if (p) {
        const s = new PIXI.Sprite(sporeTex);
        s.anchor.set(0.5); s.blendMode = PIXI.BLEND_MODES.ADD; s.tint = sp.color;
        state.frontLayer.addChild(s);
        s.width = s.height = sp.size ? rnd(sp.size[0], sp.size[1]) : rnd(1.4, 3.2) * 3.2 * 2;
        const life = sp.life ?? [3.5, 7];
        state.spores.push({ s, x: p[0], y: p[1], vy: rnd(sp.vy[0], sp.vy[1]), ph: rnd(0, 6.28), life: 0, max: rnd(life[0], life[1]),
          fadeOut: !!sp.fadeOut, preset: entry.preset, peak: sp.alpha ?? 0.75, sway: sp.sway ?? 8 });
      }
    }
    }
    state.spores = state.spores.filter((p) => {
      p.life += dt; p.y -= p.vy * dt; p.x += Math.sin(p.life * 1.3 + p.ph) * p.sway * dt;
      if (p.life >= p.max) { p.s.destroy(); return false; }
      const k = p.life / p.max;
      p.s.position.set(p.x, p.y);
      p.s.alpha = p.fadeOut
        ? Math.max(0, Math.min(1, (1 - k) * 1.6) * (0.75 + 0.25 * Math.sin(p.life * 13 + p.ph)))
        : Math.max(0, Math.sin(Math.PI * k) * (0.55 + 0.45 * Math.sin(p.life * 5 + p.ph)) * p.peak);
      return true;
    });

    // gas belches (behind tokens)
    if (cfg.puffs) {
      state.puffT -= dt;
      if (state.puffT <= 0) {
        state.puffT = rnd(0.7, 1.8);
        const p = pickCand(v);
        if (p) {
          const s = new PIXI.Sprite(puffTex);
          s.anchor.set(0.5); s.blendMode = PIXI.BLEND_MODES.SCREEN;
          state.glowLayer.addChild(s);
          state.puffs.push({ s, x: p[0], y: p[1], r: rnd(50, 130), life: 0, max: rnd(4.5, 7), vy: rnd(28, 55) });
        }
      }
    }
    state.puffs = state.puffs.filter((p) => {
      p.life += dt; p.y -= p.vy * dt;
      if (p.life >= p.max) { p.s.destroy(); return false; }
      const k = p.life / p.max, rr = p.r * (0.6 + 1.1 * k);
      p.s.position.set(p.x, p.y); p.s.width = rr * 2; p.s.height = rr * 1.6;
      p.s.alpha = Math.sin(Math.PI * k) * 0.24;
      return true;
    });

    // drips + rings (behind tokens)
    const gfx = state.dripGfx;
    if (cfg.drips && gfx && !gfx.destroyed) {
      state.dripT -= dt;
      const pd = pointDrips(cfg);
      if (state.dripT <= 0) {
        state.dripT = rnd(1.0, 2.6);
        if (pd) {
          // From a ceiling point, landing fall[0]..fall[1] px lower (Cave Dwelling mockup).
          const c = pd.points[(Math.random() * pd.points.length) | 0], f = Array.isArray(pd.fall) ? pd.fall : [160, 360];
          const x = c[0] + rnd(-20, 20), y0 = c[1], y = y0 + rnd(f[0], f[1]);
          if (inView(v, x, y)) state.drips.push({ x, y, y0, life: 0, fallT: 0.45, dust: pd.land === "dust" });
        } else { const p = pickCand(v); if (p) state.drips.push({ x: p[0], y: p[1], y0: p[1] - 140, life: 0, fallT: 0.35 }); }
      }
      gfx.clear();
      state.drips = state.drips.filter((d) => {
        d.life += dt;
        if (d.life >= d.fallT + 1.85) return false;
        if (d.life < d.fallT) {
          const k = d.life / d.fallT, y = d.y0 + (d.y - d.y0) * k * k;
          gfx.lineStyle(1.4, 0xc8cdff, 0.55); gfx.moveTo(d.x, y - 9); gfx.lineTo(d.x, y);
        } else if (d.dust) {
          const k = (d.life - d.fallT) / 1.2;
          if (k < 1) { const r = 8 + 18 * k; gfx.lineStyle(0); gfx.beginFill(0xbeaac8, 0.3 * (1 - k)); gfx.drawEllipse(d.x, d.y, r, r * 0.45); gfx.endFill(); }
        } else {
          for (let i = 0; i < 2; i++) {
            const k = (d.life - 0.35 - i * 0.28) / 1.6; if (k <= 0 || k >= 1) continue;
            const rx = 4 + 30 * k;
            gfx.lineStyle(1.2, 0xbec3ff, 0.42 * (1 - k)); gfx.drawEllipse(d.x, d.y, rx, rx * 0.42);
          }
        }
        return true;
      });
    }
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
        if (g.flicker) {
          g.s.alpha = (g.peak ?? 0.42) * (still ? 0.85 : flick(t, g.i));
        } else {
          const a = still ? 0.16 : 0.16 + 0.12 * Math.sin(t * (1.1 + (g.i % 5) * 0.17) + g.i * 1.9);
          g.s.alpha = g.peak !== null && g.peak !== undefined ? g.peak * (a + 0.12) / 0.4 : a + 0.12;
        }
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
        m.sprite.alpha = (m.ember ? 0.8 : m.sig ? MOTE.sigilAlpha : MOTE.alpha) * fade * tw;
      }

      placeClouds(t);

      for (const s of state.shafts) {
        if (s.plane.destroyed) continue;
        const a = still ? s.alpha : s.alpha * (0.5 + 0.5 * (0.5 + 0.5 * Math.sin(t / 2.6 + s.ph)));
        const sway = still ? 0 : Math.sin(t / 5.2 + s.ph) * 18, bx = s.x + s.lean + sway, by = s.top + s.len, w1 = s.w * 2.4;
        const buf = s.plane.geometry.getBuffer("aVertexPosition");
        buf.data.set([s.x - s.w / 2, s.top, s.x + s.w / 2, s.top, bx - w1 / 2, by, bx + w1 / 2, by]);
        buf.update();
        s.plane.alpha = a * 1.6;
      }

      if (!still && state.glowLayer && state.frontLayer) stepUnderground(dt, view());

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

  window.oni.MapAmbience = {
    installed: true, rebuild: build, FLAG,
    /** A lightning strike's light on the clouds right now, 0..1 (map-storm.js, every frame of a strike). */
    setFlash: (v) => { state.flash = Math.max(0, Math.min(1.5, Number(v) || 0)); }
  };
  console.debug(TAG, "Installed. API: window.oni.MapAmbience");
})();
