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
 *       spores: { preset: "gas" | "crystal" | "ember", points: [[x, y]] }
 *                                                    rising specks (Underground Decor mockup):
 *                                                    "gas" rise out of the surface mask,
 *                                                    "crystal" mostly from the points
 *       puffs:  true                                 gas belches rising from the mask (behind tokens)
 *       drips:  true                                 drops falling onto the mask, rings spreading
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
    cand: null, spores: [], puffs: [], drips: [], dripGfx: null, puffT: 0, dripT: 0, buildId: 0 };
  let dotTex = null, glowTex = null, sporeTex = null, puffTex = null;

  // Numbers from the Underground Decor mockup (stepParticles / drawFx).
  const SPORE = {
    gas: { cap: 90, rate: 40, vy: [22, 55], color: 0xc8ff82, fromPoints: 0 },
    crystal: { cap: 46, rate: 14, vy: [10, 26], color: 0xd7afff, fromPoints: 0.7 },
    // Valley camp mockup (2026-11-06): sparks off a campfire, bright at birth, fading out.
    ember: { cap: 10, rate: 5, vy: [22, 42], color: 0xffa64d, fromPoints: 1, jitter: [12, 5], life: [1.4, 2.8], size: [8, 14], fadeOut: true },
  };
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
    for (const c of [state.glowLayer, state.frontLayer, state.wisp]) { try { c?.parent?.removeChild(c); c?.destroy({ children: true }); } catch (_) {} }
    state.glowLayer = state.frontLayer = state.wisp = null;
    state.glows = []; state.motes = []; state.cfg = null;
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

    // spores, belches, drips (Underground Decor)
    if (!still && (cfg.spores || cfg.puffs || cfg.drips)) {
      makeParticleTextures();
      if (cfg.puffs || cfg.drips || cfg.spores?.preset === "gas") loadCandidates(scene, state.buildId);
      if (cfg.drips) { state.dripGfx = new PIXI.Graphics(); state.glowLayer.addChild(state.dripGfx); }
    }

    state.last = performance.now();
    state.tick = tick;
    canvas.app.ticker.add(state.tick);
  }

  // The mock's stepParticles + drawFx, on PIXI sprites. Map px throughout.
  function stepUnderground(dt, v) {
    const cfg = state.cfg;

    // spores (in front of tokens)
    const sp = cfg.spores ? SPORE[cfg.spores.preset] : null;
    if (sp && state.spores.length < sp.cap && Math.random() < dt * sp.rate) {
      let p = null;
      const pts = Array.isArray(cfg.spores.points) ? cfg.spores.points : [];
      if (sp.fromPoints > 0) {
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
        state.spores.push({ s, x: p[0], y: p[1], vy: rnd(sp.vy[0], sp.vy[1]), ph: rnd(0, 6.28), life: 0, max: rnd(life[0], life[1]), fadeOut: !!sp.fadeOut });
      }
    }
    state.spores = state.spores.filter((p) => {
      p.life += dt; p.y -= p.vy * dt; p.x += Math.sin(p.life * 1.3 + p.ph) * 8 * dt;
      if (p.life >= p.max) { p.s.destroy(); return false; }
      const k = p.life / p.max;
      p.s.position.set(p.x, p.y);
      p.s.alpha = p.fadeOut
        ? Math.max(0, Math.min(1, (1 - k) * 1.6) * (0.75 + 0.25 * Math.sin(p.life * 13 + p.ph)))
        : Math.max(0, Math.sin(Math.PI * k) * (0.55 + 0.45 * Math.sin(p.life * 5 + p.ph)) * 0.75);
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
      if (state.dripT <= 0) { state.dripT = rnd(1.0, 2.6); const p = pickCand(v); if (p) state.drips.push({ x: p[0], y: p[1], life: 0 }); }
      gfx.clear();
      state.drips = state.drips.filter((d) => {
        d.life += dt;
        if (d.life >= 2.2) return false;
        if (d.life < 0.35) {
          const k = d.life / 0.35, y = d.y - 140 * (1 - k * k);
          gfx.lineStyle(1.4, 0xc8cdff, 0.55); gfx.moveTo(d.x, y - 9); gfx.lineTo(d.x, y);
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

  window.oni.MapAmbience = { installed: true, rebuild: build, FLAG };
  console.debug(TAG, "Installed. API: window.oni.MapAmbience");
})();
