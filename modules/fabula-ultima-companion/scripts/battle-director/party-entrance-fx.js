// ============================================================================
// Party entrance FX — draws a party style (party-entrance-styles.js) for ONE
// member on THIS client. The caller (director-init.js dashInParty) owns the
// stagger and the broadcast; Blanche's 50/50 arrives already rolled.
//
// DEPTH: the whole entrance (behind effects, the sprite, front effects) is ONE
// layer at the member's own depth: a PIXI sprite in `canvas.primary` with the
// token mesh's elevation / sortLayer / sort / zIndex, inserted right after the
// mesh, so the group's stable sort keeps it exactly where the token draws.
// Never an overlay above every token.
//
// The layer is a 2D canvas, drawn each frame in "mock units": the approved
// mockup's own coordinates (BOX = 158 = the standard sprite's height, feet at
// 0,0), mapped to the scene by the token's real art scale. That keeps the port
// of claude.ai/artifact/C1vS3jyg2nRHXFuB8Rco4E (v21) line for line.
//
// Art is the character's own: the token's live battle video (the same element
// the token plays, so the hand-off at the end is seamless), plus the actor's
// sprite_* props (standard, walk, hurt, KO, crisis) on their own <video>s.
// Nothing is squashed or bent except Zarg's battle sprite on his landing.
//
// The real token is held invisible (locally) for the whole entrance and
// revealed at the end, under the layer; nothing is written to the document.
// ============================================================================

import { warn } from "./logger.js";
import { playSfx } from "./director-sfx.js";
import {
  PARTY_ENTRANCE_STYLES, OUTCOME_SUCCESS, outcomeFor, partyTotalMs, partyLandMs, partySfx,
} from "./party-entrance-styles.js";
import { shadowSpriteFor, STYLE as SHADOW_STYLE } from "../sprite-shadow/sprite-shadow-renderer.js";

// An entrance gates the battle: it may never hold it longer than its own
// length plus this.
const FAILSAFE_MS = 2000;
// A client that receives the broadcast before its canvas has drawn the token
// waits this long for it.
const TOKEN_WAIT_MS = 1500;
// How long the start may wait for the clips to be playable (they are
// preloaded behind the curtain; this only matters on a cold cache). Past it
// the entrance starts on time anyway and each clip joins as it arrives (until
// then the battle sprite stands in), so a slow load cannot break the stagger.
const CLIP_WAIT_MS = 250;
const SHADOW_IN_MS = 300;
// Layer resolution: device px per scene px, capped (four layers upload a
// frame each, every frame).
const MAX_RES = 1.5;

// The mockup's units.
const BOX = 158;          // the standard sprite's height on the map
const PX = BOX / 251;     // mock units per art pixel (Blanche_Standard: 251 px = BOX)
const TAU = Math.PI * 2;

// Drawing bounds per style, mock units around the feet: [x0, y0, x1, y1].
const BOUNDS = {
  mirror:      [-260, -330, 260, 130],
  foxfire:     [-290, -340, 290, 170],
  fiftyFifty:  [-220, -210, 620, 25],
  warningShot: [-210, -610, 670, 60],
};

/**
 * Play `style` for the party token on this client. Resolves when the member is
 * standing on the field (token revealed), or when it had to give up.
 *   { tokenId, style, outcome, sceneId }
 */
export function playPartyEntranceLocal({ tokenId, style, outcome = null, sceneId = null } = {}) {
  return new Promise((resolve) => {
    const cfg = PARTY_ENTRANCE_STYLES[style];
    if (!cfg || !BUILDERS[style] || typeof PIXI === "undefined" || !canvas?.ready) { resolve(); return; }
    if (sceneId && canvas.scene?.id !== sceneId) { resolve(); return; }
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(); } };
    const total = partyTotalMs(style, outcome);
    const failsafe = setTimeout(() => {
      const t = canvas?.tokens?.get?.(tokenId);
      if (t) showToken(t);
      finish();
    }, total + TOKEN_WAIT_MS + CLIP_WAIT_MS + FAILSAFE_MS);
    waitForToken(tokenId)
      .then((token) => (token ? run(token, style, outcomeFor(style, outcome)) : null))
      .catch((e) => {
        warn(`party-entrance: "${style}" threw`, e);
        const t = canvas?.tokens?.get?.(tokenId);
        if (t) showToken(t);
      })
      .finally(() => { clearTimeout(failsafe); finish(); });
  });
}

/** Start loading a member's clips early (each client; idempotent per run). */
export function preparePartyEntrance(tokenId, style) {
  try {
    const token = canvas?.tokens?.get?.(tokenId);
    const cfg = PARTY_ENTRANCE_STYLES[style];
    if (!token || !cfg) return Promise.resolve(null);
    return loadClips(token, cfg.clips ?? []);
  } catch { return Promise.resolve(null); }
}

async function waitForToken(tokenId) {
  const t0 = performance.now();
  for (;;) {
    const t = canvas?.tokens?.get?.(tokenId);
    if (t && !t.destroyed && t.mesh) return t;
    if (performance.now() - t0 > TOKEN_WAIT_MS) return null;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/* ── Art ─────────────────────────────────────────────────────────────────── */

const VIDEO_RE = /\.(webm|mp4|m4v|ogv)(\?|#|$)/i;
// tokenId -> Promise<{ [prop]: art }>, so preparing early and running share
// one load.
const _clipLoads = new Map();

function loadClips(token, props) {
  const key = `${token.id}|${props.join(",")}`;
  if (_clipLoads.has(key)) return _clipLoads.get(key);
  const actor = token.actor;
  const p = Promise.all(props.map(async (prop) => {
    const url = String(actor?.system?.props?.[prop] ?? "").trim();
    if (!url) return [prop, null];
    try { return [prop, VIDEO_RE.test(url) ? await loadVideo(url) : await loadImage(url)]; }
    catch (e) { warn(`party-entrance: ${prop} failed to load (${url})`, e); return [prop, null]; }
  })).then((pairs) => Object.fromEntries(pairs));
  _clipLoads.set(key, p);
  // Unclaimed (the run never came): let it go.
  setTimeout(() => { if (_clipLoads.get(key) === p) _clipLoads.delete(key); }, 30000);
  return p;
}

// A run owns its <video>s (it restarts and pauses them): take the load out of
// the cache so the next battle gets fresh elements.
function takeClips(token, props) {
  const p = loadClips(token, props);
  _clipLoads.delete(`${token.id}|${props.join(",")}`);
  return p;
}

function loadImage(url) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.crossOrigin = "anonymous";
    im.onload = () => res({ src: im, w: im.naturalWidth, h: im.naturalHeight, video: false });
    im.onerror = () => rej(new Error("image load failed"));
    im.src = url;
  });
}

function loadVideo(url) {
  return new Promise((res, rej) => {
    const v = document.createElement("video");
    v.crossOrigin = "anonymous";
    v.muted = true; v.loop = true; v.playsInline = true; v.preload = "auto";
    const done = () => res({ src: v, w: v.videoWidth, h: v.videoHeight, video: true });
    v.onloadeddata = () => (v.videoWidth ? done() : rej(new Error("video has no size")));
    v.onerror = () => rej(new Error("video load failed"));
    v.src = url;
    v.load();
  });
}

// The token's own (battle) art: the very element its mesh plays.
function tokenArt(token) {
  const bt = token.mesh?.texture?.baseTexture;
  const src = bt?.resource?.source ?? null;
  if (!src) return null;
  const video = typeof HTMLVideoElement !== "undefined" && src instanceof HTMLVideoElement;
  const w = video ? src.videoWidth : (src.naturalWidth ?? src.width ?? bt.realWidth);
  const h = video ? src.videoHeight : (src.naturalHeight ?? src.height ?? bt.realHeight);
  if (!(w > 0 && h > 0)) return null;
  if (video && src.paused) { try { src.loop = true; src.muted = true; src.play?.()?.catch?.(() => {}); } catch { /* ignore */ } }
  return { src, w, h, video };
}

/* ── Runner ─────────────────────────────────────────────────────────────── */

async function run(token, style, outcome) {
  const cfg = PARTY_ENTRANCE_STYLES[style];
  hideToken(token);
  holdShadow(token, 0);
  // Filled in place as the clips arrive; the builders read it every frame.
  const clips = {};
  let over = false;
  const clipsP = takeClips(token, cfg.clips ?? []).then((c) => {
    if (over) disposeClips(c);
    else Object.assign(clips, c ?? {});
  });
  await Promise.race([clipsP, new Promise((r) => setTimeout(r, CLIP_WAIT_MS))]);
  const battle = tokenArt(token);
  const geo = battle ? meshGeometry(token) : null;   // in the primary group's (scene) space
  if (!battle || !geo) { over = true; disposeClips(clips); showToken(token); return; }
  const s = geo.h / battle.h;          // scene px per art px
  const k = s / PX;                    // scene px per mock unit
  const flip = geo.flip;
  const res = Math.max(0.5, Math.min(MAX_RES, (canvas.stage?.scale?.x || 1) * (window.devicePixelRatio || 1)));
  const [bx0, by0, bx1, by1] = BOUNDS[style];
  const q = k * res;                   // device px per mock unit

  const cv = document.createElement("canvas");
  cv.width = Math.max(4, Math.ceil((bx1 - bx0) * q));
  cv.height = Math.max(4, Math.ceil((by1 - by0) * q));
  const ctx = cv.getContext("2d");
  const tex = PIXI.Texture.from(cv);
  const layer = new PIXI.Sprite(tex);
  layer.name = `fud-party-entrance:${token.id}`;
  layer.eventMode = "none";
  layer.position.set(geo.x + bx0 * k, geo.y + by0 * k);
  layer.scale.set(1 / res);
  placeAtTokenDepth(layer, token.mesh);

  const env = { ctx, q, flip, battle, clips, outcome, art: makeArt(ctx, q) };
  const fx = BUILDERS[style](env);
  const total = partyTotalMs(style, outcome);
  const land = partyLandMs(style, outcome);
  const sfx = partySfx(style);

  try {
    await new Promise((done) => {
      const t0 = performance.now();
      const tick = (now) => {
        const t = now - t0;
        if (token.destroyed || layer.destroyed) { done(); return; }
        hideToken(token);
        holdShadow(token, clamp((t - land) / SHADOW_IN_MS, 0, 1));
        while (sfx.length && t >= sfx[0].atMs) { const c = sfx.shift(); playSfx(c.url, c.volume); }
        keepDepth(layer, token.mesh);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, cv.width, cv.height);
        ctx.setTransform(q, 0, 0, q, -bx0 * q, -by0 * q);
        const tt = Math.min(t, total);
        try { fx.back(tt); fx.char(tt); fx.front(tt); }
        catch (e) { warn(`party-entrance: "${style}" frame threw`, e); done(); return; }
        try { tex.baseTexture.update(); } catch { /* gone */ }
        if (t >= total) done();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  } finally {
    // Reveal the real token under the layer (it shows the same battle frame),
    // then drop the layer on the next frame so there is no gap.
    showToken(token);
    await new Promise((r) => requestAnimationFrame(r));
    try { layer.parent?.removeChild(layer); layer.destroy({ texture: true, baseTexture: true }); } catch { /* gone */ }
    try { fx.dispose?.(); } catch { /* ignore */ }
    over = true;
    disposeClips(clips);
  }
}

// Release a run's own <video>s (never the token's).
function disposeClips(clips) {
  for (const a of Object.values(clips ?? {})) {
    if (a?.video) { try { a.src.pause(); a.src.removeAttribute("src"); a.src.load(); } catch { /* ignore */ } }
  }
}

// The mesh's feet (bottom centre), height and facing, in primary space.
function meshGeometry(token) {
  const mesh = token.mesh;
  const prim = canvas.primary;
  try {
    const b = mesh.getBounds(false);
    if (b && b.height > 0) {
      const tl = prim.worldTransform.applyInverse(new PIXI.Point(b.x, b.y));
      const br = prim.worldTransform.applyInverse(new PIXI.Point(b.x + b.width, b.y + b.height));
      return { x: (tl.x + br.x) / 2, y: br.y, h: br.y - tl.y, flip: (mesh.scale?.x ?? 1) < 0 ? -1 : 1 };
    }
  } catch { /* fall through */ }
  const h = Math.abs(mesh.height) || token.h;
  return { x: token.center.x, y: token.center.y + h / 2, h, flip: (mesh.scale?.x ?? 1) < 0 ? -1 : 1 };
}

// Same depth keys as the mesh, and right after it in the group: its sort is
// stable on equal keys (_lastSortedIndex), so nothing can come between.
function placeAtTokenDepth(layer, mesh) {
  const prim = canvas.primary;
  layer.elevation = mesh.elevation;
  layer.sortLayer = mesh.sortLayer;
  layer.sort = mesh.sort;
  layer.zIndex = mesh.zIndex;
  const i = prim.children.indexOf(mesh);
  if (i >= 0) prim.addChildAt(layer, i + 1);
  else prim.addChild(layer);
  prim.sortDirty = true;
}

function keepDepth(layer, mesh) {
  if (!mesh || mesh.destroyed) return;
  if (layer.elevation !== mesh.elevation || layer.sortLayer !== mesh.sortLayer || layer.sort !== mesh.sort || layer.zIndex !== mesh.zIndex) {
    layer.elevation = mesh.elevation; layer.sortLayer = mesh.sortLayer; layer.sort = mesh.sort; layer.zIndex = mesh.zIndex;
    canvas.primary.sortDirty = true;
  }
}

// The sprite shadow keeps its own copy of the mesh's alpha (`fudBase`) and
// re-applies it every frame, so hiding the mesh does not reach it.
function holdShadow(token, k) {
  const sh = shadowSpriteFor(token.id);
  if (!sh || sh.destroyed) return;
  const a = SHADOW_STYLE.alpha * k;
  if (sh.fudBase) sh.fudBase.alpha = a;
  sh.alpha = a;
}
function hideToken(token) {
  if (token.destroyed) return;
  try { token.alpha = 0; } catch { /* gone */ }
  try { if (token.mesh) token.mesh.alpha = 0; } catch { /* gone */ }
}
function showToken(token) {
  if (token.destroyed) return;
  try { token.alpha = 1; } catch { /* gone */ }
  try { if (token.mesh) token.mesh.alpha = 1; } catch { /* gone */ }
  // No refreshState here: it re-reads the document's alpha, still 0 until the
  // GM persists alpha 1 after the whole entrance (the dash reveals the same way).
}

/* ── maths (the mockup's) ───────────────────────────────────────────────── */

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const seg = (t, a, b) => clamp((t - a) / (b - a), 0, 1);
const lerp = (a, b, k) => a + (b - a) * k;
const smooth = (x) => x * x * (3 - 2 * x);
const eOut = (x) => 1 - Math.pow(1 - x, 3);
const eIn = (x) => x * x * x;
const eIO = (x) => x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
const eBack = (x) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };
const bell = (t, a, p, b) => t <= a || t >= b ? 0 : t < p ? smooth((t - a) / (p - a)) : smooth((b - t) / (b - p));
// seeded random, so every client (and every frame) draws the same
function R(seed) {
  let s = seed | 0;
  const next = () => { s = s + 0x6D2B79F5 | 0; let x = Math.imul(s ^ s >>> 15, 1 | s); x = x + Math.imul(x ^ x >>> 7, 61 | x) ^ x; return ((x ^ x >>> 14) >>> 0) / 4294967296; };
  return (a = 0, b = 1) => a + (b - a) * next();
}

/* ── drawing primitives (bound to one layer's ctx) ──────────────────────── */

function makeArt(ctx, q) {
  // tint: the art's own silhouette filled with a colour (Hina's shadow)
  const tc = document.createElement("canvas");
  const tx = tc.getContext("2d");
  function tinted(art, rgb, a, w, h) {
    const W = Math.max(1, Math.ceil(w * q)), H = Math.max(1, Math.ceil(h * q));
    if (tc.width !== W || tc.height !== H) { tc.width = W; tc.height = H; } else tx.clearRect(0, 0, W, H);
    tx.globalCompositeOperation = "source-over";
    tx.drawImage(art.src, 0, 0, W, H);
    tx.globalCompositeOperation = "source-atop";
    tx.fillStyle = `rgba(${rgb},${a})`; tx.fillRect(0, 0, W, H);
    tx.globalCompositeOperation = "source-over";
    return tc;
  }
  // draw art standing on (fx, fy); scale / rotate about the feet.
  // o.h = drawn height (mock units); default: its own pixels at the art scale.
  function sprite(art, fx, fy, o = {}) {
    const im = art?.src ?? o.img;
    if (!im) return;
    const h = o.h ?? art.h * PX, w = (o.w ?? art.w) * h / art.h;
    if (!(w > 0 && h > 0)) return;
    const src = o.tint ? tinted(art, o.tint, o.ta ?? 1, w, h) : im;
    ctx.save(); ctx.globalAlpha = clamp(o.a ?? 1, 0, 1); ctx.translate(fx, fy);
    if (o.rot) ctx.rotate(o.rot);
    if (o.skew) ctx.transform(1, 0, o.skew, 1, 0, 0);   // bend: the top shifts sideways, the feet stay put
    ctx.scale((o.sx ?? 1) * (o.flip ?? 1), o.sy ?? 1);
    try { ctx.drawImage(src, -w / 2, -h, w, h); } catch { /* frame not ready */ }
    ctx.restore();
  }
  function glow(x, y, r, rgb, a) {
    if (!(a > 0) || !(r > 0)) return;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${rgb},${a})`); g.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
  }
  function star4(x, y, r, rgb, a, rot = 0) {
    if (!(a > 0) || !(r > 0)) return;
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.globalAlpha = clamp(a, 0, 1); ctx.fillStyle = `rgb(${rgb})`;
    ctx.beginPath(); for (let i = 0; i < 8; i++) { const an = i * Math.PI / 4, rr = i % 2 ? r * .2 : r; ctx.lineTo(Math.cos(an) * rr, Math.sin(an) * rr); }
    ctx.closePath(); ctx.fill(); ctx.restore();
  }
  function heart(x, y, s, fill, a) {
    if (!(a > 0) || !(s > 0)) return;
    ctx.save(); ctx.translate(x, y); ctx.scale(s, s); ctx.globalAlpha = clamp(a, 0, 1);
    ctx.beginPath(); ctx.moveTo(0, .35); ctx.bezierCurveTo(-1.1, -.35, -.55, -1.05, 0, -.5); ctx.bezierCurveTo(.55, -1.05, 1.1, -.35, 0, .35);
    ctx.fillStyle = fill; ctx.fill(); ctx.lineWidth = .14; ctx.strokeStyle = "rgba(255,255,255,.9)"; ctx.stroke();
    ctx.restore();
  }
  const additive = (fn) => { ctx.save(); ctx.globalCompositeOperation = "lighter"; fn(); ctx.restore(); };
  return { sprite, glow, star4, heart, additive };
}

// A clip on its own <video>: started from its first frame when a segment
// begins, paused to hold a frame. Natural playback, not seeking: a seek per
// frame is far too slow to keep up.
function clipPlayer(getArt) {
  let started = null;
  return {
    get art() { return getArt(); },
    // Play from the start the first time `key` asks; returns the art to draw.
    at(key, rate = 1) {
      const art = getArt();
      if (!art?.video) return art;
      const v = art.src;
      if (started !== key) {
        started = key;
        try { v.playbackRate = rate; v.currentTime = 0; v.play?.()?.catch?.(() => {}); } catch { /* ignore */ }
      }
      return art;
    },
    hold() { const art = getArt(); if (art?.video && !art.src.paused) { try { art.src.pause(); } catch { /* ignore */ } } return art; },
  };
}

/* ── the four entrances (ports of the mockup) ───────────────────────────── */

// ── HINA · Mirror ──
function buildMirror(env) {
  const { ctx, q, flip, battle, clips } = env;
  const { sprite, glow, star4, additive } = env.art;
  let stdSil = null;   // the standard sprite as a flat silhouette (made once it has loaded)
  const H_SPIN = [80, 1000], H_SWEEP = [1050, 1300], H_CRACK = 1340, H_BREAK = 1480, H_OUT = 1640, H_BACK = 1900;
  // her shadow: in the mirror it sits close behind her like an ordinary
  // shadow; after the shatter it stays exactly there but deepens
  const SH_NEAR = { dx: BOX * .1, dy: -BOX * .02, s: 1, a: .5 }, SH_FAR = { ...SH_NEAR, a: .88 };
  const MW = BOX * .34, MH = BOX * .6, M_DX = 0, M_DY = -BOX * .56;
  const M = { x: M_DX, y: M_DY };
  const hBattle = (o = {}) => sprite(battle, o.x ?? 0, o.y ?? 0, { flip, ...o });
  // the mirror face, drawn into its own canvas so it can be turned and cut
  // into shards; LW × LH in mock units, q device px each
  const LW = Math.ceil(MW * 2 + 8), LH = Math.ceil(MH * 2 + 8);
  const MC = document.createElement("canvas"); MC.width = Math.ceil(LW * q); MC.height = Math.ceil(LH * q);
  const mx = MC.getContext("2d");
  const hSpin = (t) => TAU * 2 * (1 - Math.pow(1 - seg(t, H_SPIN[0], H_SPIN[1]), 3));
  const H_CRACKS = (() => {
    const r = R(777), out = [];
    for (let i = 0; i < 11; i++) {
      const an = i / 11 * TAU + r(-.25, .25), pts = [[0, -MH * .2]];
      let x = 0, y = -MH * .2;
      for (let k = 0; k < 6; k++) { const step = r(.15, .28) * MH, a2 = an + r(-.35, .35); x += Math.cos(a2) * step * 1.4; y += Math.sin(a2) * step; pts.push([x, y]); }
      out.push(pts);
    }
    return out;
  })();
  function drawMirror(band, crack) {
    const c = mx;
    c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, MC.width, MC.height);
    c.setTransform(q, 0, 0, q, 0, 0); c.translate(LW / 2, LH / 2);
    c.save(); c.beginPath(); c.rect(-MW, -MH, MW * 2, MH * 2); c.clip();
    {
      const g = c.createLinearGradient(0, -MH, 0, MH); g.addColorStop(0, "rgb(44,40,92)"); g.addColorStop(1, "rgb(22,18,48)");
      c.fillStyle = g; c.fillRect(-MW, -MH, MW * 2, MH * 2);
      // the reflection: her shadow, then Hina in her base sprite, where they will stand
      const std = clips.sprite_standard;
      if (std?.src) {
        const hh = std.h * PX, ww = std.w * hh / std.h, feetX = -M_DX, feetY = -M_DY;
        c.save(); c.globalAlpha = SH_NEAR.a;
        c.drawImage(stdSil ?? (stdSil = silhouette(std, "20,10,46")), feetX + SH_NEAR.dx - ww / 2, feetY + SH_NEAR.dy - hh, ww, hh);
        c.restore();
        try { c.drawImage(std.src, feetX - ww / 2, feetY - hh, ww, hh); } catch { /* not ready */ }
      }
      c.fillStyle = "rgba(150,140,230,.12)"; c.fillRect(-MW, -MH, MW * 2, MH * 2);
      // hard light: two sharp-edged diagonal bands at `band` (-1 … 1 across the glass)
      if (band != null) {
        c.save(); c.globalCompositeOperation = "lighter"; c.rotate(-.5);
        for (const [off, w, a] of [[0, MW * .26, .5], [MW * .36, MW * .09, .38]]) {
          c.fillStyle = `rgba(255,255,255,${a})`; c.fillRect(band * MW * 1.7 + off - w / 2, -MH * 2, w, MH * 4);
        }
        c.restore();
      }
      if (crack > 0) {
        c.strokeStyle = "rgba(255,255,255,.95)"; c.lineWidth = 1.4; c.lineJoin = "round";
        for (const pts of H_CRACKS) {
          const n = Math.max(1, Math.round(crack * (pts.length - 1)));
          c.beginPath(); pts.slice(0, n + 1).forEach(([x, y], k) => k ? c.lineTo(x, y) : c.moveTo(x, y)); c.stroke();
        }
      }
    }
    c.restore();
    // no frame: only the faint light on the glass edge that tells you it is a pane
    c.strokeStyle = "rgba(255,255,255,.28)"; c.lineWidth = 1; c.strokeRect(-MW + .5, -MH + .5, MW * 2 - 1, MH * 2 - 1);
  }
  // the standard sprite as a flat silhouette (a still image: made once)
  function silhouette(art, rgb) {
    const c = document.createElement("canvas"); c.width = art.w; c.height = art.h;
    const x = c.getContext("2d"); x.drawImage(art.src, 0, 0); x.globalCompositeOperation = "source-atop";
    x.fillStyle = `rgb(${rgb})`; x.fillRect(0, 0, c.width, c.height);
    return c;
  }
  // shards: a jittered grid over the pane, two triangles per cell (mirror-canvas units)
  const H_SHARDS = (() => {
    const cols = 7, rows = 8, r = R(4343), v = [], x0 = 4, y0 = 4, Wc = MW * 2, Hc = MH * 2;
    for (let y = 0; y <= rows; y++) { v.push([]); for (let x = 0; x <= cols; x++) { const edge = x === 0 || y === 0 || x === cols || y === rows; v[y].push([x0 + (x + (edge ? 0 : r(-.35, .35))) / cols * Wc, y0 + (y + (edge ? 0 : r(-.35, .35))) / rows * Hc]); } }
    const out = [];
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const a = v[y][x], b = v[y][x + 1], c = v[y + 1][x + 1], d = v[y + 1][x];
      for (const tri of (r() < .5 ? [[a, b, c], [a, c, d]] : [[a, b, d], [b, c, d]])) {
        const cx = (tri[0][0] + tri[1][0] + tri[2][0]) / 3 - LW / 2, cy = (tri[0][1] + tri[1][1] + tri[2][1]) / 3 - LH / 2;
        const rr = R(out.length * 17 + 3);
        out.push({ tri, cx, cy, sp: rr(.7, 1.5), up: rr(.1, .6), spin: rr(-8, 8) });
      }
    }
    return out;
  })();
  return {
    back(t) {
      // her shadow: exactly where the mirror showed it, deepening, then snaps back into her
      if (t < H_BREAK || t > H_BACK + 160) return;
      const o = eOut(seg(t, H_BREAK + 40, H_OUT)), r = eIn(seg(t, H_BACK, H_BACK + 150));
      const k = (f) => lerp(SH_NEAR[f], SH_FAR[f], o) * (1 - r);
      const s = 1 + (lerp(SH_NEAR.s, SH_FAR.s, o) - 1) * (1 - r);
      hBattle({ x: k("dx"), y: k("dy"), sx: s, sy: s, tint: "20,10,46", ta: 1, a: lerp(SH_NEAR.a, SH_FAR.a, o) * (1 - r) });
    },
    char(t) { if (t >= H_BREAK) hBattle(); },
    front(t) {
      if (t < H_BREAK) {
        // appears from thin air: a point of light, then the pane opens out of a hairline
        const app = eOut(seg(t, 0, 220));
        if (t < 260) additive(() => { glow(M.x, M.y, BOX * .25, "220,210,255", .8 * (1 - seg(t, 120, 260))); star4(M.x, M.y, BOX * .3 * bell(t, 0, 60, 200), "255,255,255", 1); });
        const th = hSpin(t), cs = Math.cos(th);
        const band = t < H_SPIN[1] ? ((th / TAU) % 1) * 2 - 1 : t >= H_SWEEP[0] && t <= H_SWEEP[1] ? lerp(-1.1, 1.1, eIO(seg(t, H_SWEEP[0], H_SWEEP[1]))) : null;
        drawMirror(band, eOut(seg(t, H_CRACK, H_CRACK + 120)));
        const jit = t >= H_CRACK ? Math.sin(t * 1.3) * 1.2 : 0;
        ctx.save(); ctx.translate(M.x + jit, M.y); ctx.scale((cs < 0 ? -1 : 1) * Math.max(.02, Math.abs(cs)) * app, .1 + .9 * app);   // a clear pane: from behind, mirrored
        ctx.drawImage(MC, -LW / 2, -LH / 2, LW, LH); ctx.restore();
        // side-on: a hard white flash runs the height of the edge
        const edge = t > H_SPIN[0] && t < H_SPIN[1] ? 1 - Math.min(1, Math.abs(cs) / .22) : 0;
        if (edge > 0) additive(() => {
          ctx.fillStyle = `rgba(255,255,255,${edge})`; ctx.fillRect(M.x - 1.5, M.y - MH * app, 3, MH * 2 * app);
          star4(M.x, M.y - MH * app, 9 * edge, "255,255,255", edge); star4(M.x, M.y + MH * app, 9 * edge, "255,255,255", edge);
        });
        return;
      }
      // the shatter: the cracked pane breaks into shards that fly out and fall
      if (t < H_BREAK + 560) {
        drawMirror(null, 1);
        const dt = (t - H_BREAK) / 1000, a = 1 - seg(t, H_BREAK, H_BREAK + 560);
        if (a > 0) for (const s of H_SHARDS) {
          const d = Math.hypot(s.cx, s.cy) || 1, vx = s.cx / d * BOX * s.sp, vy = s.cy / d * BOX * s.sp * .5 - BOX * s.up;
          ctx.save(); ctx.globalAlpha = a; ctx.translate(M.x + s.cx + vx * dt, M.y + s.cy + vy * dt + .5 * BOX * 3.4 * dt * dt);
          ctx.rotate(s.spin * dt); ctx.translate(-s.cx - LW / 2, -s.cy - LH / 2);
          ctx.beginPath(); s.tri.forEach(([x, y], k) => k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.closePath();
          ctx.save(); ctx.clip(); ctx.drawImage(MC, 0, 0, LW, LH); ctx.restore();
          ctx.lineWidth = .8; ctx.strokeStyle = `rgba(255,255,255,${.6 * a})`; ctx.stroke(); ctx.restore();
        }
      }
      const fl = 1 - seg(t, H_BREAK, H_BREAK + 140);
      if (fl > 0) additive(() => glow(M.x, M.y, BOX * .8, "235,230,255", .8 * fl));
    },
  };
}

// ── KEREN · Foxfire ──
function buildFoxfire(env) {
  const { ctx, flip, battle } = env;
  const { sprite, glow, star4, heart, additive } = env.art;
  const FOX = "255,92,40", FOXC = "255,226,160";
  const K_MERGE = 700, K_BURST = 880, K_WINK = 1450;
  const C = { x: 0, y: -BOX * .5 };
  const kBattle = () => sprite(battle, 0, 0, { flip });
  // her eye, as a fraction of the battle art (measured on Keren_Battler002)
  const ey = { x: (.49 - .5) * battle.w * PX * flip, y: -battle.h * PX * (1 - .238) };
  function kWisp(t, i) {
    const p = seg(t, 0, K_MERGE), rad = BOX * 1.5 * (1 - eIn(p));
    const an = i * Math.PI / 3 + p * 3.2 * Math.PI + p * p * 2 * Math.PI;
    return { x: C.x + Math.cos(an) * rad, y: C.y + Math.sin(an) * rad * .38 };
  }
  function flame(x, y, s, a, t, i, tall = 1.2) {
    if (!(a > 0)) return;
    const f = 1 + .14 * Math.sin(t * .05 + i * 1.3);
    glow(x, y, s * 2.6, FOX, .45 * a);
    ctx.save(); ctx.translate(x, y); ctx.scale(s * f, s * f * tall); ctx.globalAlpha = clamp(a, 0, 1);
    const g = ctx.createLinearGradient(0, -1.3, 0, .9); g.addColorStop(0, `rgba(${FOX},.2)`); g.addColorStop(.55, `rgb(${FOX})`); g.addColorStop(1, `rgb(${FOXC})`);
    ctx.beginPath(); ctx.moveTo(0, -1.4); ctx.bezierCurveTo(.85, -.4, .8, .6, 0, .9); ctx.bezierCurveTo(-.8, .6, -.85, -.4, 0, -1.4);
    ctx.fillStyle = g; ctx.fill(); ctx.restore();
  }
  return {
    back() {},
    char(t) { if (t >= K_BURST) kBattle(); },   // there behind the flame from the burst on
    front(t) {
      additive(() => {
        // the six wisps and their trails
        if (t < K_MERGE + 20) for (let i = 0; i < 6; i++) for (let j = 6; j >= 0; j--) {
          const p = kWisp(Math.max(0, t - j * 18), i);
          flame(p.x, p.y, BOX * .07 * (1 - j * .1), seg(t, 0, 150) * (j ? (1 - j / 7) * .45 : 1), t, i);
        }
        // one flame: swells from the merge to the burst
        if (t >= K_MERGE && t < K_BURST + 40) {
          const g = eIn(seg(t, K_MERGE, K_BURST));
          flame(C.x, C.y + BOX * .1, BOX * (.08 + .2 * g), .9, t * 1.6, 0, 1.6);
        }
        // the burst: a flare and a column of flame that burns away upward, uncovering her
        const b = seg(t, K_BURST, K_BURST + 520);
        if (b > 0 && b < 1) {
          glow(C.x, C.y, BOX * (.5 + .9 * eOut(b)), FOX, .85 * (1 - b));
          glow(C.x, C.y, BOX * .55 * (1 - b), "255,250,230", (1 - b) * (1 - b));
          for (let i = 0; i < 9; i++) {
            const r = R(1200 + i), d = seg(t, K_BURST + r(0, 120), K_BURST + r(380, 520));
            if (d <= 0 || d >= 1) continue;
            flame(C.x + r(-.3, .3) * BOX, C.y + BOX * r(.05, .4) - BOX * r(.5, 1) * eOut(d), BOX * r(.07, .11) * (1 - d * .5), (1 - d) * .85, t, i, 2.6);
          }
        }
        // a few embers drifting up after it
        for (let i = 0; i < 6; i++) {
          const r = R(1300 + i), e = seg(t, K_BURST + 100 + i * 40, K_BURST + 900 + i * 40);
          if (e <= 0 || e >= 1) continue;
          glow(C.x + r(-.4, .4) * BOX + Math.sin(e * 6 + i) * 6, C.y - BOX * .2 - BOX * r(.5, 1) * e, 4, FOXC, .9 * (1 - e));
        }
      });
      // the wink: a glint on her eye, and the heart blows out of it, growing as it drifts up and out
      additive(() => star4(ey.x, ey.y, BOX * .12 * bell(t, K_WINK, K_WINK + 70, K_WINK + 240), "255,240,250", 1, .3));
      const hp = seg(t, K_WINK + 60, K_WINK + 900), ha = 1 - seg(t, K_WINK + 600, K_WINK + 900);
      if (hp > 0 && ha > 0) {
        const m = eOut(hp), hx = ey.x + BOX * .38 * m + Math.sin(hp * 7) * 2.5, hy = ey.y - BOX * .42 * m + BOX * .08 * Math.sin(Math.PI * Math.min(1, hp * 2.2));
        heart(hx, hy, 14 * eBack(seg(t, K_WINK + 60, K_WINK + 300)), "rgb(255,96,170)", ha);
      }
    },
  };
}

// ── BLANCHE · 50/50 ──
// Her own sprites only, no added effects. The outcome was rolled once on the
// host. Clip rates and lengths are the mockup's (walk 25 fps × 15 frames).
function buildFiftyFifty(env) {
  const { ctx, q, flip, battle, clips, outcome } = env;
  const { sprite } = env.art;
  const walk = clipPlayer(() => clips.sprite_walk ?? null);
  const hurt = clipPlayer(() => clips.sprite_hurt ?? null);
  const ko = clipPlayer(() => clips.sprite_ko ?? null);
  const crisis = clipPlayer(() => clips.sprite_crisis ?? null);
  const H = outcome === OUTCOME_SUCCESS;
  const B_RUN = 650;
  const WALK = { n: 15, fps: 25 };
  // walk art is drawn on the standing sprite's canvas, so it takes the
  // standing sprite's height on the map
  const walkH = () => (clips.sprite_standard?.h ?? battle.h) * PX;
  // frames of the walk, captured as they play during the run, for the
  // backwards step to the mark (reversed playback by seeking is too slow)
  const walkFrames = new Map();
  function captureWalk() {
    const a = walk.art;
    if (!a?.video || a.src.readyState < 2) return;
    const i = Math.floor(a.src.currentTime * WALK.fps + 1e-3) % WALK.n;
    if (walkFrames.has(i)) return;
    const w = Math.max(1, Math.ceil(walkH() * a.w / a.h * q)), h = Math.max(1, Math.ceil(walkH() * q));
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    try { c.getContext("2d").drawImage(a.src, 0, 0, w, h); walkFrames.set(i, c); } catch { /* not ready */ }
  }
  function walkBack(ms, x) {
    const k = Math.floor(Math.max(0, ms) / 1000 * WALK.fps) % WALK.n, i = WALK.n - 1 - k;
    let f = walkFrames.get(i);
    if (!f && walkFrames.size) {   // nearest captured frame
      let best = null, bd = Infinity;
      for (const [j, c] of walkFrames) { const d = Math.min(Math.abs(j - i), WALK.n - Math.abs(j - i)); if (d < bd) { bd = d; best = c; } }
      f = best;
    }
    const a = walk.art;
    if (f && a) return sprite({ src: f, w: a.w, h: a.h }, x, 0, { h: walkH(), flip });
    if (a) return sprite(walk.at("back"), x, 0, { h: walkH(), flip });
  }
  const runX = (t) => { const p = seg(t, 0, B_RUN); return H ? lerp(540, 0, 1 - Math.pow(1 - p, 2.2)) : lerp(540, 30, p); };
  const runFrame = (t, x, o = {}) => {
    if (!walk.art) return bat({ x, ...o });   // no walk art: her battle sprite stands in
    if (t < B_RUN) { walk.at("run", 2); captureWalk(); }
    else walk.hold();
    sprite(walk.art, x, 0, { h: walkH(), flip, ...o });
  };
  const bat = (o = {}) => sprite(battle, o.x ?? 0, 0, { flip, ...o });
  // a pose clip, or her battle sprite when the clip is missing
  const pose = (p, key) => (p.art ? p.at(key) : battle);
  return {
    back() {},
    front() {},
    char(t) {
      if (t < B_RUN) return runFrame(t, runX(t));
      if (H) {
        if (t < 800) return runFrame(t, -6 * eOut(seg(t, B_RUN, 800)), { rot: .12 * Math.sin(Math.PI * seg(t, B_RUN, 800)) });   // skid, leaning back
        if (t < 1300) {   // one full twirl; halfway round, facing away, the battle sprite takes over
          const p = eIO(seg(t, 800, 1300)), sx = Math.cos(TAU * p);
          return p < .5 ? runFrame(t, 0, { sx }) : bat({ sx });
        }
        return bat();
      }
      walk.hold();
      if (t < 780) {   // trip: the hurt flinch, pitching forward, still moving
        const p = seg(t, B_RUN, 780);
        return sprite(pose(hurt, "trip"), lerp(30, -40, p), -BOX * .1 * Math.sin(Math.PI * p), { rot: -.35 * p, flip });
      }
      if (t < 1550) return sprite(pose(ko, "down"), lerp(-75, -100, eOut(seg(t, 780, 1050))), 0, { flip });   // face down, sliding to a stop
      if (t < 1850) return sprite(pose(crisis, "up"), -85, 0, { flip });   // back up: her crisis sprite, untouched
      if (t < 2450) return walkBack(t - 1850, lerp(-85, 0, eIO(seg(t, 1850, 2450))));   // steps back to the mark, still facing the enemy
      return bat();
    },
    dispose() { walkFrames.clear(); },
  };
}

// ── ZARG · Warning Shot ──
function buildWarningShot(env) {
  const { ctx, flip, battle } = env;
  const { sprite, glow, additive } = env.art;
  const Z_HIT = 80, Z_OUT = 760, Z_IN = 800, Z_GLINT = 1150;
  const A = { x0: 620, y0: -560, x1: -BOX * .05, y1: 2 };
  // his eye, as a fraction of the battle art (measured on Zarg_Battler002)
  const E = { x: (.575 - .5) * battle.w * PX * flip, y: -battle.h * PX * (1 - .184) };
  function zSpeedLines(x, y, a, seed, t) {
    if (!(a > 0)) return;
    ctx.save(); ctx.globalAlpha = clamp(a, 0, 1); ctx.strokeStyle = "rgb(255,252,240)"; ctx.lineCap = "round";
    for (let i = 0; i < 9; i++) {
      const r = R(seed + i), lx = x + r(-.32, .32) * BOX, len = BOX * r(.35, .8), top = y - BOX * r(.2, 1.3) - ((t * r(.9, 1.6)) % (BOX * .4));
      ctx.lineWidth = r(1, 2.2); ctx.beginPath(); ctx.moveTo(lx, top); ctx.lineTo(lx, top + len); ctx.stroke();
    }
    ctx.restore();
  }
  function zLeaf(t, i) {
    const r = R(500 + i), t0 = 100 + i * 9, qq = seg(t, t0, t0 + 560);
    if (qq <= 0 || qq >= 1) return null;
    const an = r(0, TAU) + (t - t0) * .009, rad = BOX * (.85 - .5 * qq), hh = BOX * r(1.3, 2.1);
    return { x: Math.cos(an) * rad, y: -6 + Math.sin(an) * rad * .35 - lerp(hh, BOX * .08, eIO(qq)), an, a: seg(qq, 0, .1) * (1 - seg(qq, .82, 1)), c: i % 3 };
  }
  function leaf(x, y, rot, a, c) {
    if (!(a > 0)) return;
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.globalAlpha = clamp(a, 0, 1);
    ctx.fillStyle = ["rgb(96,170,70)", "rgb(146,198,88)", "rgb(64,128,58)"][c]; ctx.beginPath(); ctx.ellipse(0, 0, 7, 3, 0, 0, TAU); ctx.fill();
    ctx.strokeStyle = "rgba(30,60,20,.6)"; ctx.lineWidth = .8; ctx.beginPath(); ctx.moveTo(-6, 0); ctx.lineTo(6, 0); ctx.stroke(); ctx.restore();
  }
  function arrowShape(L) {   // drawn pointing along +x, tip at 0
    ctx.strokeStyle = "rgb(110,74,40)"; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-L, 0); ctx.stroke();
    ctx.fillStyle = "rgb(200,200,210)"; ctx.beginPath(); ctx.moveTo(4, 0); ctx.lineTo(-8, -5); ctx.lineTo(-8, 5); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "rgb(70,150,80)"; ctx.beginPath(); ctx.moveTo(-L + 12, 0); ctx.lineTo(-L - 2, -7); ctx.lineTo(-L + 2, 0); ctx.lineTo(-L - 2, 7); ctx.closePath(); ctx.fill();
  }
  // the glint: a long horizontal hairline with a short vertical one, blips
  // twice, then pulls back into the eye
  function zGlint(g) {
    if (g < 0 || g > 560) return;
    const len = BOX * 1.15 * eOut(seg(g, 0, 110)) * (1 - eIn(seg(g, 390, 540)));
    const blip = 1 - .65 * (bell(g, 165, 195, 230) + bell(g, 290, 320, 355));
    const a = blip * (1 - seg(g, 470, 560));
    additive(() => {
      glow(E.x, E.y, 9 + 4 * blip, "255,214,120", .8 * a);
      for (const [dx, dy, l] of [[1, 0, len], [0, 1, len * .2]]) {
        if (!(l > 0)) continue;
        for (const [wid, al, col] of [[5, .22, "255,200,90"], [1.6, 1, "255,250,235"]]) {
          const g2 = ctx.createLinearGradient(E.x - dx * l, E.y - dy * l, E.x + dx * l, E.y + dy * l);
          g2.addColorStop(0, `rgba(${col},0)`); g2.addColorStop(.5, `rgba(${col},${al * a})`); g2.addColorStop(1, `rgba(${col},0)`);
          ctx.strokeStyle = g2; ctx.lineWidth = wid; ctx.beginPath(); ctx.moveTo(E.x - dx * l, E.y - dy * l); ctx.lineTo(E.x + dx * l, E.y + dy * l); ctx.stroke();
        }
      }
      glow(E.x, E.y, 3.5, "255,255,255", a);
    });
  }
  return {
    back(t) {
      for (let i = 0; i < 26; i++) { const l = zLeaf(t, i); if (l && Math.sin(l.an) < 0) leaf(l.x, l.y, l.an * 2, l.a, l.c); }
    },
    char(t) {
      if (t < Z_IN) return;
      // lands in his battle sprite: a firm crouch-and-lean on impact, one rise
      // just past upright, then settled. No second bounce.
      const p = seg(t, Z_IN, Z_IN + 280), a = p < .4 ? eOut(p / .4) : 1, b = p < .4 ? 0 : smooth((p - .4) / .6);
      const sq = lerp(lerp(-.13, .04, a), 0, b), bend = lerp(lerp(-.12, .03, a), 0, b);
      sprite(battle, 0, 0, { flip, sy: 1 + sq, sx: 1 - sq * .6, skew: bend * flip });
    },
    front(t) {
      const dir = Math.atan2(A.y1 - A.y0, A.x1 - A.x0), L = BOX * .42;
      // the flash arrow: a hairline streak, then the shaft standing in the ground
      if (t < Z_HIT + 200) additive(() => {
        const p = seg(t, 0, Z_HIT), tx = lerp(A.x0, A.x1, p), ty = lerp(A.y0, A.y1, p), fade = 1 - seg(t, Z_HIT, Z_HIT + 200);
        const g = ctx.createLinearGradient(tx, ty, A.x0, A.y0);
        g.addColorStop(0, `rgba(255,246,220,${.95 * fade})`); g.addColorStop(1, "rgba(255,246,220,0)");
        ctx.strokeStyle = g; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(A.x0, A.y0); ctx.stroke();
      });
      if (t >= Z_HIT && t < Z_IN + 240) {
        // stuck in the ground; flickers and leaves a torn, see-through afterimage as it warps out
        const quiv = Math.sin((t - Z_HIT) * .07) * .08 * Math.exp(-(t - Z_HIT) / 160);
        const flick = t >= Z_OUT && t < Z_IN ? (Math.floor((t - Z_OUT) / 13) % 2 ? .25 : 1) : 1;
        const ghost = t >= Z_IN, a = ghost ? .45 * (1 - seg(t, Z_IN, Z_IN + 240)) : flick;
        ctx.save(); ctx.globalAlpha = a;
        ctx.translate(A.x1 + Math.cos(dir) * 6 + (ghost ? Math.sin(t * .09) * 3 : 0), A.y1 + Math.sin(dir) * 6);
        ctx.rotate(dir + quiv); ctx.beginPath(); ctx.rect(-L - 20, -20, L + 20, 40); ctx.clip();   // the head is buried
        arrowShape(L); ctx.restore();
      }
      zSpeedLines(0, 0, bell(t, Z_OUT, Z_IN + 20, Z_IN + 220) * .85, 600, t);
      for (let i = 0; i < 26; i++) { const l = zLeaf(t, i); if (l && Math.sin(l.an) >= 0) leaf(l.x, l.y, l.an * 2, l.a, l.c); }
      if (t >= Z_IN && t < Z_IN + 550) {   // leaves thrown out as he arrives
        const p = seg(t, Z_IN, Z_IN + 550);
        for (let i = 0; i < 12; i++) {
          const r = R(800 + i), an = r(0, TAU), d = BOX * (.2 + .9 * eOut(p)) * r(.6, 1);
          leaf(Math.cos(an) * d, -4 + Math.sin(an) * d * .35 - BOX * .25 * Math.sin(Math.PI * p) * r(.5, 1), an + p * 6, 1 - p, i % 3);
        }
      }
      zGlint(t - Z_GLINT);
    },
  };
}

const BUILDERS = {
  mirror: buildMirror,
  foxfire: buildFoxfire,
  fiftyFifty: buildFiftyFifty,
  warningShot: buildWarningShot,
};
