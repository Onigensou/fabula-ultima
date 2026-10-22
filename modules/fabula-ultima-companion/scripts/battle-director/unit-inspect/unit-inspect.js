// Battle Inspect — Alt+Click a unit in battle to read it without leaving the battle.
//
// Approved design (mockup claude.ai/artifact/52umGqFkM3KBB3AJvVWRBZ, 2026-10-14;
// the pedestal box was dropped the same day — it lifted the unit OUT of the
// battle): the camera zooms onto the unit (feet pinned to one floor line), the
// battlefield dims, the other units go darker still and the HUD darkens (solid, not see-through).
// The unit stays where it stands IN the world, lit by a spotlight from above,
// and a wide parchment card sits beside it in the screen's HUD-free band. The
// light and the unit live in a layer just above #board (under the HUD); the
// unit's own ground shadow is redrawn over the light pool when the actor uses
// the in-game shadow (sprite-shadow flag) — art with a painted-in shadow
// carries it in the sprite itself. The card: vitals / DEF & dice / affinities on the
// left, tabs on the right (Effects | Passive & gear for allies; Effects |
// Actions | Notes for enemies). What an enemy shows is gated by the Monster
// Encyclopedia — see inspect-model.js.
//
// Input — ONE combo everywhere (user, 2026-10-22): the same Alt+Click opens it
// outside targeting and while picking a target, where a plain click picks.
//   Alt + click a unit ............ open (or switch to it); stays open
//   hover a unit .................. peek card (also while choosing a target)
//   hold Alt over a unit .......... open while held; the click then pins it
//   Esc / right-click / empty click close        Tab / Shift+Tab  next / previous unit
//   Q / E ......................... previous / next tab
//
// Per client, read-only: no socket, no document writes (the darker units are a
// local mesh tint, put back on close). The camera move is
// local (canvas.animatePan) and is put back on close unless something else
// moved the camera meanwhile. Closes itself when the battle needs the screen:
// an action card, a reaction menu, a target picker (unless Alt-held), an action
// declared, the battle ending.

import { buildInspectModel, HP_RULE_SETTING } from "./inspect-model.js";
import { ROOT_ID, WORLD_ID, CARD_W, FRAME_H, renderFrame, renderPeek, injectStyles, tabsOf } from "./inspect-render.js";
import { hudScale, battleIsSettled } from "../director-player-hud.js";
import { hasSurface, getActiveSurfaces } from "../director-surfaces.js";
import { tokenCastsSpriteShadow } from "../../sprite-shadow/sprite-shadow-config.js";
import { shadowSpriteFor } from "../../sprite-shadow/sprite-shadow-renderer.js";

const NS = "fabula-ultima-companion";
const TAG = "[fu-inspect]";
const ZOOM = 2.2;             // relative to the view the player had
const PAN_MS = 560;
const CLICK_SLOP_PX = 6;
const CLICK_MAX_MS = 900;      // a click, not a hold; drags are caught by the slop
const OTHER_UNITS = 0.5;       // the other units' brightness, on top of the field dim
const CARD_GAP = 32;           // light pool edge -> card, at 1080p
const POOL_CORE = 2.5;         // light pool width = this x the body's core width

const S = {
  root: null,
  open: null,          // { tokenId, viaAlt, savedView, targetView }
  ui: { tab: "effects", filter: "all" },
  model: null,
  raf: 0,
  els: null,           // { place, world, light, shadow, sprite, ctx, lightKey, shadowTex, topLight }
  dark: new Map(),     // tokenId -> { token, base, applied }: mesh tints we darkened
  dimObservers: null,  // MutationObservers keeping new HUD panels darkened
  quiet: new Map(),    // tokenId -> { token, kids: Map(child -> wasVisible) }: token UI we hid
  peekId: null,
  down: null,          // pointerdown record
  hooks: [],
  altDown: false,
  eatContextMenu: false,
  asPlayer: false,     // GM: preview exactly what players see
};

// ── battle presence + roster ────────────────────────────────────────────────

function directorStateHere() {
  try { return canvas?.scene?.getFlag?.(NS, "directorState") ?? null; } catch { return null; }
}

function inBattle() {
  const st = directorStateHere();
  // A stopped battle can leave started:true with an empty roster; that is not a battle.
  if (st?.dCombat?.started && !st.dCombat.ended && st.dCombat.combatants?.length) return true;
  // The GM hosts the director; its scene flag can lag the first save.
  try { return !!globalThis.FUCompanion?.api?.experimental?.battleDirector?.isRunning?.(); } catch { return false; }
}

/** tokenId → side for every combatant on this scene; null when the roster is unknown. */
function rosterSides() {
  const list = directorStateHere()?.dCombat?.combatants;
  if (!Array.isArray(list) || !list.length) return null;
  const out = new Map();
  for (const c of list) {
    const id = String(c?.tokenUuid ?? "").split(".").pop();
    if (id) out.set(id, c.side === "enemy" ? "enemy" : "party");
  }
  return out;
}

function inspectable(token) {
  if (!token?.actor || !token.mesh || !token.visible || token.document?.hidden && !game.user?.isGM) return false;
  if (Number(token.document?.alpha ?? 1) <= 0.05) return false;
  const sides = rosterSides();
  return sides ? sides.has(token.id) : true;
}

function inspectableTokens() {
  const sides = rosterSides();
  const toks = (canvas?.tokens?.placeables ?? []).filter(inspectable);
  // Tab order: enemies first, then the party; each side left→right, top→bottom.
  const sideOf = (t) => (sides?.get(t.id) ?? (t.document?.disposition === -1 ? "enemy" : "party"));
  return toks.sort((a, b) => (sideOf(a) === sideOf(b) ? (a.document.y - b.document.y) || (a.document.x - b.document.x) : sideOf(a) === "enemy" ? -1 : 1));
}

function sideOf(token) {
  return rosterSides()?.get(token.id) ?? (token.document?.disposition === -1 ? "enemy" : "party");
}

/** A target picker (or the JRPG targeting session) owns clicks right now. */
// The DOCKED picker (your plate's drawer, `.dhv-tcols`) has no banner — without
// it here, clicking a creature to pick it also opened this card over the pick.
function targetingActive() {
  return !!document.querySelector(".fud-target-banner")
    || !!document.querySelector(".dhv-tcols")
    || !!globalThis.__ONI_JRPG_TARGETING_ACTIVE__;
}

// ── layout: the screen band no HUD covers ───────────────────────────────────
// Measured on the 1080p battle screen (x 120–1810, y 128–722) and scaled the
// way the plate scales; the GM desk / plate tops pull the floor up when taller.

function band() {
  const k = hudScale();
  const W = window.innerWidth, H = window.innerHeight;
  let y1 = H - 358 * k;
  for (const sel of ["#fud-gm-desk", ".dhud-plate", ".dhud-take"]) {
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.top > H * 0.45) y1 = Math.min(y1, r.top - 12 * k);
    }
  }
  return { k, x0: 120 * k, x1: W - 110 * k, y0: 128 * k, y1, W, H };
}

// ── camera ──────────────────────────────────────────────────────────────────

function currentView() {
  return { x: canvas.stage.pivot.x, y: canvas.stage.pivot.y, scale: canvas.stage.scale.x };
}

function sameView(a, b) {
  return !!a && !!b && Math.abs(a.x - b.x) < 2 && Math.abs(a.y - b.y) < 2 && Math.abs(a.scale - b.scale) < 0.005;
}

/** Where the camera must sit so the unit's standing point lands on the stage's floor. */
function stageView(token, b, savedView) {
  const mb = token.mesh.getBounds();
  const s0 = canvas.stage.scale.x;
  const inv = (x, y) => canvas.stage.worldTransform.applyInverse(new PIXI.Point(x, y));
  const f = footing(token);
  const feet = inv(f.cx, f.fy);
  const worldW = mb.width / s0, worldH = mb.height / s0;
  const maxZoom = CONFIG.Canvas?.maxZoom ?? 3;
  let scale = Math.min(savedView.scale * ZOOM, maxZoom, (420 * b.k) / Math.max(1, worldH), (340 * b.k) / Math.max(1, worldW));
  scale = Math.max(scale, Math.min(savedView.scale, maxZoom));
  const enemy = sideOf(token) === "enemy";
  const ax = enemy ? b.x0 + 180 * b.k : b.x1 - 210 * b.k;
  const ay = b.y1 - 82 * b.k;
  // The light's left/right edges once the camera arrives (the card is placed
  // from these before the pan ends).
  const half = poolWidth(f.rawW * (scale / s0), b.k) / 2;
  return { x: feet.x - (ax - b.W / 2) / scale, y: feet.y - (ay - b.H / 2) / scale, scale, enemy, ax, lightX: [ax - half, ax + half] };
}

const poolWidth = (w, k) => Math.max(110 * k, Math.min(620 * k, w));

// ── where the unit stands ───────────────────────────────────────────────────
// The light centres on the unit as the eye reads it, not on its bounding box:
// tails, wings and weapons stick out to one side (Keren's tails, Kalina's
// spear). If the art has a shadow painted in, that shadow IS the artist's
// standing point; otherwise the centre of the body's mass. The width comes
// from the core of the body (10th–90th percentile of its mass), so a long tail
// does not widen the light either. Read at full resolution: a downscaled alpha
// map turns every hard pixel-art edge semi-transparent and fakes a shadow.

const _stand = new WeakMap();   // alpha data -> standing point (texture px)

function standingOf(tex) {
  const ad = TextureLoader.getTextureAlphaData(tex, 1);
  if (!ad || ad.maxX <= ad.minX || ad.maxY <= ad.minY) return null;
  let st = _stand.get(ad);
  if (st) return st;
  const W = ad.maxX - ad.minX, H = ad.maxY - ad.minY, d = ad.data;
  const cols = new Float64Array(W);
  let n = 0, by0 = H, by1 = -1;
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      if (d[row + x] < 128) continue;
      cols[x]++; n++;
      if (y < by0) by0 = y;
      if (y > by1) by1 = y;
    }
  }
  if (!n) return null;
  let m = 0, acc = 0, x10 = -1, x90 = -1;
  for (let x = 0; x < W; x++) {
    m += cols[x] * x; acc += cols[x];
    if (x10 < 0 && acc >= n * 0.1) x10 = x;
    if (x90 < 0 && acc >= n * 0.9) x90 = x;
  }
  let cx = m / n + 0.5, cy = by1 + 1 - (by1 - by0 + 1) * 0.04, painted = false;
  // Painted shadow: soft (semi-transparent) pixels in the bottom 30% of the body or below.
  const hist = new Uint32Array(W);
  let ns = 0, ySum = 0;
  for (let y = Math.max(0, by1 - Math.floor((by1 - by0) * 0.3)); y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const v = d[row + x];
      if (v >= 20 && v < 128) { hist[x]++; ns++; ySum += y; }
    }
  }
  if (ns >= Math.max(30, n * 0.02)) {
    let a = 0, p3 = -1, p97 = -1;
    for (let x = 0; x < W; x++) {
      a += hist[x];
      if (p3 < 0 && a >= ns * 0.03) p3 = x;
      if (p97 < 0 && a >= ns * 0.97) p97 = x;
    }
    cx = (p3 + p97 + 1) / 2; cy = ySum / ns + 0.5; painted = true;
  }
  const sx = tex.width / ad.width, sy = tex.height / ad.height;
  st = { cx: (ad.minX + cx) * sx, cy: (ad.minY + cy) * sy, coreW: (x90 - x10 + 1) * sx, painted };
  _stand.set(ad, st);
  return st;
}

/** The unit's standing point and its light on screen: cx/fy, the pool's raw
 *  width (rawW), its clamped width (poolW) and the pool's edges (x0, x1). */
function footing(token) {
  const mesh = token.mesh, mb = mesh.getBounds(), k = hudScale();
  let st = null;
  try { st = standingOf(mesh.texture); } catch { /* texture not ready */ }
  let cx, fy, rawW;
  if (!st) {
    cx = mb.x + mb.width / 2; fy = mb.y + mb.height - 6; rawW = mb.width * 0.9;
  } else {
    const tex = mesh.texture;
    // SpriteMesh local space = texture px offset by the anchor (sprite-shadow-renderer.js).
    const P = (x, y) => mesh.toGlobal(new PIXI.Point(x - tex.width * mesh.anchor.x, y - tex.height * mesh.anchor.y));
    const c = P(st.cx, st.cy), e = P(st.cx + st.coreW, st.cy);
    cx = c.x; fy = c.y; rawW = Math.abs(e.x - c.x) * POOL_CORE;
  }
  const poolW = poolWidth(rawW, k);
  return { cx, fy, rawW, poolW, x0: cx - poolW / 2, x1: cx + poolW / 2 };
}

// ── the other units: darker than the dimmed field ───────────────────────────
// A plain mesh tint (free on the GPU, unlike a filter per token). Foundry and
// token-tint.js re-stamp mesh.tint on refresh, so a tint that is no longer ours
// becomes the new base and is darkened again.

const tintNum = (v) => { const n = Number(v); if (Number.isFinite(n)) return n; try { return new PIXI.Color(v).toNumber(); } catch { return 0xffffff; } };
const mulTint = (n, k) => (Math.round(((n >> 16) & 255) * k) << 16) | (Math.round(((n >> 8) & 255) * k) << 8) | Math.round((n & 255) * k);

function restoreTint(id) {
  const rec = S.dark.get(id);
  if (!rec) return;
  S.dark.delete(id);
  try { const m = rec.token?.mesh; if (m && !rec.token.destroyed && tintNum(m.tint) === rec.applied) m.tint = rec.base; } catch { /* */ }
}

function darkenOthers(exceptId) {
  restoreTint(exceptId);
  for (const t of canvas?.tokens?.placeables ?? []) {
    const m = t.mesh;
    if (t.id === exceptId || !m || t.destroyed) continue;
    const cur = tintNum(m.tint);
    const rec = S.dark.get(t.id);
    if (rec && cur === rec.applied) continue;
    const applied = mulTint(cur, OTHER_UNITS);
    S.dark.set(t.id, { token: t, base: cur, applied });
    m.tint = applied;
  }
}

function restoreAllTints() {
  for (const id of [...S.dark.keys()]) restoreTint(id);
}

// ── token UI (name, bars, effect icons, border) off while the light is on ──
// It sits on the token placeable, NOT on the mesh (that lives in canvas.primary),
// so hiding it leaves every unit drawn. voidMesh / detectionFilterMesh are render
// plumbing, and the placeable's own hitArea keeps clicks (target picks) working.
// Foundry re-shows these on hover/refresh, so this re-asserts every frame.

function quietTokenUI() {
  for (const t of canvas?.tokens?.placeables ?? []) {
    if (t.destroyed) continue;
    let rec = S.quiet.get(t.id);
    for (const c of t.children ?? []) {
      if (c === t.voidMesh || c === t.detectionFilterMesh || !c.visible) continue;
      if (!rec) { rec = { token: t, kids: new Map() }; S.quiet.set(t.id, rec); }
      if (!rec.kids.has(c)) rec.kids.set(c, true);
      c.visible = false;
    }
  }
}

function restoreTokenUI() {
  for (const { token, kids } of S.quiet.values()) {
    if (token.destroyed) continue;
    for (const [c, was] of kids) if (!c.destroyed) c.visible = was;
    try { token.renderFlags.set({ refreshState: true }); } catch { /* */ }
  }
  S.quiet.clear();
}

// ── the unit, its light and its shadow follow the real mesh every frame ─────

function drawLoop() {
  S.raf = 0;
  const o = S.open;
  if (!o || !S.els) return;
  const token = canvas?.tokens?.get(o.tokenId);
  if (!token?.mesh || token.destroyed) { close(); return; }
  const mesh = token.mesh;
  const b = mesh.getBounds();
  const { sprite, ctx } = S.els;
  const tex = mesh.texture;
  const src = tex?.baseTexture?.resource?.source ?? null;
  const fr = tex?.frame;
  if (src && fr && fr.width > 0) {
    if (sprite.width !== Math.round(fr.width) || sprite.height !== Math.round(fr.height)) {
      sprite.width = Math.round(fr.width); sprite.height = Math.round(fr.height);
      S.els.topLight = null;
    }
    ctx.clearRect(0, 0, sprite.width, sprite.height);
    ctx.save();
    if (mesh.worldTransform.a < 0) { ctx.translate(sprite.width, 0); ctx.scale(-1, 1); }
    try { ctx.drawImage(src, fr.x, fr.y, fr.width, fr.height, 0, 0, sprite.width, sprite.height); } catch { /* not ready */ }
    ctx.restore();
    // The spotlight catches the top of the body (painted only where the unit is).
    if (!S.els.topLight) {
      const gr = ctx.createLinearGradient(0, 0, 0, sprite.height);
      gr.addColorStop(0, "rgba(255,240,205,0.22)"); gr.addColorStop(0.5, "rgba(255,240,205,0)");
      S.els.topLight = gr;
    }
    ctx.globalCompositeOperation = "source-atop";
    ctx.fillStyle = S.els.topLight;
    ctx.fillRect(0, 0, sprite.width, sprite.height);
    ctx.globalCompositeOperation = "source-over";
    sprite.style.width = `${b.width}px`; sprite.style.height = `${b.height}px`;
    sprite.style.transform = `translate(${b.x}px, ${b.y}px)`;
    sprite.style.opacity = String(Math.max(0.15, mesh.worldAlpha ?? 1));
  }
  placeLight(token);
  drawShadow(token);
  darkenOthers(o.tokenId);
  quietTokenUI();
  S.raf = requestAnimationFrame(drawLoop);
}

/** The spotlight: a soft beam from the top of the screen down to a pool at the feet. */
function placeLight(token) {
  const { light } = S.els;
  const k = hudScale();
  const f = footing(token);
  const poolW = f.poolW;
  const poolH = poolW * 0.3;
  const pad = 30 * k;
  const W = poolW + pad * 2, H = f.fy + poolH / 2 + pad;
  const left = f.cx - W / 2;
  // Re-lay the SVG only when it really moved (an idle bob would re-raster it every frame).
  const key = [left, W, H].map((v) => Math.round(v / 2)).join(",");
  if (key === S.els.lightKey) return;
  S.els.lightKey = key;
  const topW = poolW * 0.45, botW = poolW, c = W / 2;
  light.setAttribute("width", String(W)); light.setAttribute("height", String(H));
  light.setAttribute("viewBox", `0 0 ${W} ${H}`);
  light.style.transform = `translate(${left}px, 0px)`;
  light.querySelector(".fuw-beam").setAttribute("points", `${c - topW / 2},0 ${c + topW / 2},0 ${c + botW / 2},${f.fy} ${c - botW / 2},${f.fy}`);
  const pool = light.querySelector(".fuw-pool");
  pool.setAttribute("cx", String(c)); pool.setAttribute("cy", String(f.fy));
  pool.setAttribute("rx", String(poolW / 2)); pool.setAttribute("ry", String(poolH / 2));
  light.querySelector(".fuw-soft feGaussianBlur")?.setAttribute("stdDeviation", String(Math.max(3, poolW * 0.035)));
}

/** In-game ground shadow (sprite-shadow flag ON): redraw it OVER the light pool.
 *  Art with a painted-in shadow needs nothing: it is part of the sprite copy. */
function drawShadow(token) {
  const el = S.els.shadow;
  const s = tokenCastsSpriteShadow(token) ? shadowSpriteFor(token.id) : null;
  if (!s || s.destroyed || !s.visible || !s.renderable || !s.texture?.valid) { el.style.display = "none"; return; }
  if (S.els.shadowTex !== s.texture) {
    try {
      const c = canvas.app.renderer.extract.canvas(s.texture);
      el.width = c.width; el.height = c.height;
      const cx = el.getContext("2d");
      cx.clearRect(0, 0, el.width, el.height);
      cx.drawImage(c, 0, 0);
      S.els.shadowTex = s.texture;
    } catch (e) { console.warn(TAG, "shadow copy failed", e); el.style.display = "none"; return; }
  }
  const b = s.getBounds();
  el.style.display = "";
  el.style.width = `${b.width}px`; el.style.height = `${b.height}px`;
  el.style.transform = `translate(${b.x}px, ${b.y}px)${s.scale.x < 0 ? ` translateX(${b.width}px) scaleX(-1)` : ""}`;
  el.style.opacity = String(s.worldAlpha ?? s.alpha ?? 1);
}

// ── open / close ────────────────────────────────────────────────────────────

function ensureRoot() {
  if (S.root?.isConnected) return S.root;
  injectStyles();
  const root = document.createElement("div");
  root.id = ROOT_ID;
  root.addEventListener("click", onRootClick);
  document.body.appendChild(root);
  S.root = root;
  return root;
}

/** The light + the unit: right after #board, so under every HUD element. No
 *  z-index on purpose: the beam's mix-blend-mode must reach the canvas, which a
 *  stacking context of our own would cut off. */
// ── the HUD: darkened, solid ─────────────────────────────────────────────────
// A CSS filter makes its element the containing block of every position:fixed
// (and absolute) descendant. On a full-screen panel that changes nothing, but on
// a 0x0 wrapper (Theatre Inserts' #theatre-group, the player plate's root) it
// would throw its children across the screen. So each top-level element is
// darkened, its positioned boxes measured before and after (synchronously, so
// nothing paints in between), and if anything moved the filter goes one level
// down to its children instead. Children a wrapper adds later are dimmed by an
// observer.

const DIM = "fu-inspect-dim";
const HUD_SKIP = new Set(["board", "tooltip", ROOT_ID, WORLD_ID]);

function dimmable(el) {
  return !!el && !HUD_SKIP.has(el.id) && !/^(SCRIPT|STYLE|CANVAS|TEMPLATE|LINK|META)$/.test(el.tagName)
    && !el.classList.contains("fu-inspect-keep") && !String(el.id).startsWith("fud-react-menu-");
}

function positionedBoxes(el) {
  const out = [];
  for (const d of el.querySelectorAll("*")) {
    const pos = getComputedStyle(d).position;
    if (pos !== "fixed" && pos !== "absolute") continue;
    const r = d.getBoundingClientRect();
    out.push(r.left, r.top, r.width, r.height);
  }
  return out;
}

function dimSafely(el, depth = 0) {
  if (!dimmable(el)) return;
  const before = positionedBoxes(el);
  el.classList.add(DIM);
  const after = positionedBoxes(el);
  if (before.length === after.length && before.every((v, i) => Math.abs(v - after[i]) < 0.5)) return;
  el.classList.remove(DIM);
  if (depth >= 3) return;
  for (const c of el.children) dimSafely(c, depth + 1);
  const mo = new MutationObserver((recs) => { for (const r of recs) for (const n of r.addedNodes) if (n.nodeType === 1) dimSafely(n, depth + 1); });
  mo.observe(el, { childList: true });
  S.dimObservers.push(mo);
}

function dimHud() {
  if (S.dimObservers) return;   // already dimmed (switching units)
  S.dimObservers = [];
  for (const el of [...document.body.children]) dimSafely(el);
  // Panels created at the top level while inspecting.
  const mo = new MutationObserver((recs) => { for (const r of recs) for (const n of r.addedNodes) if (n.nodeType === 1) dimSafely(n); });
  mo.observe(document.body, { childList: true });
  S.dimObservers.push(mo);
}

function undimHud() {
  for (const mo of S.dimObservers ?? []) mo.disconnect();
  S.dimObservers = null;
  for (const el of document.querySelectorAll(`.${DIM}`)) el.classList.remove(DIM);
}

function ensureWorld() {
  let w = document.getElementById(WORLD_ID);
  if (w) return w;
  w = document.createElement("div");
  w.id = WORLD_ID;
  w.className = "fu-inspect-keep";
  w.innerHTML = `<svg class="fuw-light" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="fuw-beam-g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#ffe6b4" stop-opacity="0.04"/><stop offset="0.4" stop-color="#ffe6b4" stop-opacity="0.16"/><stop offset="1" stop-color="#ffe6b4" stop-opacity="0.42"/>
        </linearGradient>
        <radialGradient id="fuw-pool-g"><stop offset="0" stop-color="#fff0cc" stop-opacity="1"/><stop offset="0.55" stop-color="#ffdca0" stop-opacity="0.55"/><stop offset="1" stop-color="#ffd890" stop-opacity="0"/></radialGradient>
        <filter class="fuw-soft" id="fuw-soft" x="-20%" y="-5%" width="140%" height="110%"><feGaussianBlur stdDeviation="8"/></filter>
      </defs>
      <polygon class="fuw-beam" fill="url(#fuw-beam-g)" filter="url(#fuw-soft)"/>
      <ellipse class="fuw-pool" fill="url(#fuw-pool-g)"/>
    </svg><canvas class="fuw-shadow"></canvas><canvas class="fui-sprite"></canvas>`;
  const board = document.getElementById("board");
  if (board?.parentElement === document.body) board.after(w);
  else document.body.appendChild(w);
  return w;
}

// `pane`: how the tab content arrives when it changes — "r" / "l" slides in from
// that side (a tab to the right / left), "fade" just fades. Live refreshes pass
// nothing and swap without motion.
function renderCard({ pane = null } = {}) {
  if (!S.open || !S.els) return false;
  const token = canvas?.tokens?.get(S.open.tokenId);
  if (!token) return false;
  try {
    S.model = buildInspectModel(token, { side: sideOf(token), asPlayer: S.asPlayer });
    if (!S.model) return false;
    const html = renderFrame(S.model, { ...S.ui, alt: !!S.open.viaAlt && !S.open.sticky });
    const frame = S.els.place.querySelector(".fui-frame");
    if (!frame) { S.els.place.innerHTML = html; return true; }
    // Already open: swap only the parts that changed, inside the frame that is
    // already there. Re-writing the whole frame replayed its entrance fade, so
    // every tab change blinked the entire card.
    const t = document.createElement("template");
    t.innerHTML = html.trim();
    const next = t.content.querySelector(".fui-frame");
    for (const sel of [".fui-head", ".fui-left", ".fui-tabs", ".fui-foot"]) {
      const a = frame.querySelector(sel), b = next?.querySelector(sel);
      if (a && b && a.innerHTML !== b.innerHTML) a.replaceWith(b);
    }
    const pa = frame.querySelector(".fui-pane"), pb = next?.querySelector(".fui-pane");
    if (pa && pb && pa.innerHTML !== pb.innerHTML) {
      if (pane) pb.classList.add(pane === "r" ? "is-in-r" : pane === "l" ? "is-in-l" : "is-in");
      pa.replaceWith(pb);
    }
    return true;
  } catch (e) {
    console.error(TAG, "render failed", e);
    return false;
  }
}

function placeFrame() {
  if (!S.open || !S.els) return;
  const b = band();
  const token = canvas?.tokens?.get(S.open.tokenId);
  if (!token?.mesh) return;
  // While the camera is still travelling, place by where the unit WILL stand;
  // once it has arrived, by where it actually is (the pan may have been clamped).
  let [x0, x1] = S.open.lightX ?? [0, 0];
  if (S.open.targetView || !S.open.lightX) { const f = footing(token); x0 = f.x0; x1 = f.x1; }
  const frameW = CARD_W * b.k, gap = CARD_GAP * b.k;
  // The card on the open side of the light, the same gap for every unit, kept in the band.
  let left = S.open.enemy ? x1 + gap : x0 - gap - frameW;
  left = Math.max(b.x0, Math.min(b.x1 - frameW, left));
  const top = Math.max(b.y0, b.y1 - FRAME_H * b.k - 18 * b.k);
  S.els.place.style.transform = `translate(${left}px, ${top}px) scale(${b.k})`;
}

// When Inspect may open — the guideline: while the battle is SETTLED (waiting on
// someone: a turn pick, an action menu, a target pick, an action card, a
// reaction window), never while it is MOVING (rolling, animating, resolving,
// changing turns). An action card that is up is a settled moment: reading the
// field is how a player decides whether to react. Moving also includes this
// client's own transient animations (damage numbers, cut-ins, impact FX).
// Beyond that, only modal dialogs that own the keyboard block it, and a plain
// click while picking a target (Alt opens it there).
const BLOCKING = ["attribute-pair-picker", "passive-manager"];

function battleSettledHere() {
  try { if (!battleIsSettled()) return false; } catch {}
  try { return !getActiveSurfaces({ category: "animation" }).length; } catch { return true; }
}

function blocked(viaAlt) {
  try {
    if (!battleSettledHere()) return true;
    if (BLOCKING.some((k) => hasSurface(k))) return true;
    return !viaAlt && targetingActive();
  } catch { return false; }
}

export async function open(token, { viaAlt = false } = {}) {
  if (!token || !inspectable(token) || !inBattle() || blocked(viaAlt)) return false;
  hidePeek();
  const root = ensureRoot();
  const savedView = S.open?.savedView ?? currentView();
  S.ui = { tab: "effects", filter: "all" };
  const b = band();
  const view = stageView(token, b, savedView);
  S.open = { tokenId: token.id, viaAlt: !!viaAlt, savedView, targetView: null, enemy: view.enemy, ax: view.ax, lightX: view.lightX };

  if (!S.els) {
    root.insertAdjacentHTML("beforeend", `<div class="fui-place"></div>`);
    const world = ensureWorld();
    const sprite = world.querySelector(".fui-sprite");
    S.els = { place: root.querySelector(".fui-place"), world, light: world.querySelector(".fuw-light"), shadow: world.querySelector(".fuw-shadow"),
      sprite, ctx: sprite.getContext("2d"), lightKey: null, shadowTex: null, topLight: null };
  }
  S.els.light.classList.remove("on");   // switches on when the camera arrives
  S.els.shadowTex = null;
  if (!renderCard()) { close({ restoreCamera: false }); return false; }
  document.body.classList.add("fu-inspecting");
  dimHud();
  placeFrame();
  if (!S.raf) S.raf = requestAnimationFrame(drawLoop);

  const myToken = token.id;
  try {
    await canvas.animatePan({ x: view.x, y: view.y, scale: view.scale, duration: PAN_MS });
  } catch (e) { console.warn(TAG, "animatePan failed", e); }
  if (S.open?.tokenId !== myToken) return true;   // switched/closed mid-pan
  S.open.targetView = currentView();
  placeFrame();                                     // the camera may have been clamped
  S.els?.light.classList.add("on");
  return true;
}

export function close({ restoreCamera = true } = {}) {
  const o = S.open;
  if (!o) return;
  S.open = null;
  if (S.raf) cancelAnimationFrame(S.raf);
  S.raf = 0;
  try { S.root?.querySelectorAll(".fui-place").forEach((el) => el.remove()); } catch { /* */ }
  try { document.getElementById(WORLD_ID)?.remove(); } catch { /* */ }
  restoreAllTints();
  restoreTokenUI();
  S.els = null;
  S.model = null;
  document.body.classList.remove("fu-inspecting");
  undimHud();
  // Put the camera back — unless something else (a cinematic, the player's
  // wheel) has moved it since we arrived.
  if (restoreCamera && canvas?.ready && o.savedView && (!o.targetView || sameView(currentView(), o.targetView))) {
    canvas.animatePan({ ...o.savedView, duration: PAN_MS * 0.8 }).catch(() => {});
  }
}

export const isOpen = () => !!S.open;

function step(dir) {
  const list = inspectableTokens();
  if (!list.length || !S.open) return;
  const i = Math.max(0, list.findIndex((t) => t.id === S.open.tokenId));
  const sticky = !!S.open.sticky;
  open(list[(i + dir + list.length) % list.length], { viaAlt: !!S.open.viaAlt })
    .then((ok) => { if (ok && sticky && S.open) { S.open.sticky = true; renderCard(); } });
}

function cycleTab(dir) {
  if (!S.model) return;
  const tabs = tabsOf(S.model).map((t) => t.key);
  const i = Math.max(0, tabs.indexOf(S.ui.tab));
  S.ui.tab = tabs[(i + dir + tabs.length) % tabs.length];
  S.ui.filter = "all";
  renderCard({ pane: dir > 0 ? "r" : "l" });
}
// Which side a newly picked tab lies on, relative to the current one.
function tabSide(key) {
  if (!S.model) return "fade";
  const tabs = tabsOf(S.model).map((t) => t.key);
  const d = tabs.indexOf(key) - tabs.indexOf(S.ui.tab);
  return d > 0 ? "r" : d < 0 ? "l" : null;
}

function onRootClick(ev) {
  const el = ev.target?.closest?.("[data-action]");
  if (!el || !S.open) return;
  const a = el.dataset.action;
  if (a === "close") close();
  else if (a === "prev") step(-1);
  else if (a === "next") step(1);
  else if (a === "tab") { const pane = tabSide(el.dataset.key); S.ui.tab = el.dataset.key; S.ui.filter = "all"; renderCard({ pane }); }
  else if (a === "filter") { S.ui.filter = el.dataset.key; renderCard({ pane: "fade" }); }
  else if (a === "bestiary") {
    const token = canvas?.tokens?.get(S.open.tokenId);
    close();
    try { globalThis.FUCompanion?.api?.encyclopedia?.openEncyclopediaForToken?.(token?.document?.uuid); } catch { /* */ }
  }
}

// ── hover peek ──────────────────────────────────────────────────────────────

function showPeek(token) {
  if (S.open || !inBattle() || !inspectable(token)) return;
  const m = buildInspectModel(token, { side: sideOf(token), asPlayer: S.asPlayer });
  if (!m) return;
  const root = ensureRoot();
  let wrap = root.querySelector(".fui-peekwrap");
  if (!wrap) { root.insertAdjacentHTML("beforeend", `<div class="fui-peekwrap"></div>`); wrap = root.querySelector(".fui-peekwrap"); }
  const hint = { key: "Alt+Click", text: targetingActive() ? "Inspect. A plain click still picks the target." : "Zoom in and inspect" };
  wrap.innerHTML = renderPeek(m, hint);
  S.peekId = token.id;
  const b = band();
  const mb = token.mesh.getBounds();
  const w = 276 * b.k, h = wrap.firstElementChild?.getBoundingClientRect().height || 180 * b.k;
  const enemy = sideOf(token) === "enemy";
  let x = enemy ? mb.x + mb.width + 14 : mb.x - w - 14;
  x = Math.max(b.x0, Math.min(b.x1 - w, x));
  const y = Math.max(b.y0, Math.min(b.y1 - h, mb.y + 6));
  wrap.style.transform = `translate(${x}px, ${y}px) scale(${b.k})`;
}

function hidePeek() {
  S.peekId = null;
  S.root?.querySelector(".fui-peekwrap")?.remove();
}

// ── input ───────────────────────────────────────────────────────────────────

function hoveredToken() {
  const h = canvas?.tokens?.hover;
  if (h && inspectable(h)) return h;
  // Foundry's hover can be empty for a player over a token they don't own.
  const p = S.peekId ? canvas?.tokens?.get(S.peekId) : null;
  return p && inspectable(p) ? p : null;
}

/** The unit drawn under a screen point (the sprite's box; the front-most one wins). */
function tokenAt(x, y) {
  const view = canvas?.app?.view?.getBoundingClientRect?.();
  const px = x - (view?.left ?? 0), py = y - (view?.top ?? 0);
  const hits = inspectableTokens().filter((t) => {
    const b = t.mesh.getBounds();
    return px >= b.x && px <= b.x + b.width && py >= b.y && py <= b.y + b.height;
  });
  hits.sort((a, b) => (b.mesh.getBounds().bottom - a.mesh.getBounds().bottom));
  return hits[0] ?? null;
}

function onPointerDown(ev) {
  if (ev.button !== 0) {
    // Right-click is Back: consume it entirely so Foundry's own right-click
    // (token HUD, ping) does not also run, then eat the contextmenu that follows.
    if (ev.button === 2 && S.open) { ev.preventDefault(); ev.stopImmediatePropagation(); S.eatContextMenu = true; close(); }
    return;
  }
  S.down = { x: ev.clientX, y: ev.clientY, t: performance.now(), token: hoveredToken() ?? tokenAt(ev.clientX, ev.clientY) };
}

function onPointerUp(ev) {
  const d = S.down;
  S.down = null;
  const why = !d ? "no-down" : ev.button !== 0 ? "button" : !inBattle() ? "no-battle"
    : Math.hypot(ev.clientX - d.x, ev.clientY - d.y) > CLICK_SLOP_PX ? "moved"
    : performance.now() - d.t > CLICK_MAX_MS ? "slow"
    : targetingActive() && !ev.altKey ? "targeting" : "";
  if (globalThis.__fuInspectDebug) console.debug(TAG, "pointerup", why || "click", d?.token?.name ?? null);
  if (why) return;                             // targeting: the click picks a target
  const tok = d.token ?? hoveredToken();
  // A plain click never opens it; on empty ground it is still a way out.
  if (!ev.altKey) { if (!tok && S.open) close(); return; }
  // Alt+Click — the one way in, during targeting too (the picker lets Alt clicks
  // through, target-picker.js). Pressing Alt over the creature may already have
  // opened it (hold-to-peek); the click PINS it, so letting go of Alt keeps it.
  if (!tok) return;
  if (S.open?.tokenId === tok.id) { S.open.sticky = true; renderCard(); }
  else open(tok, { viaAlt: true }).then((ok) => { if (ok && S.open?.tokenId === tok.id) { S.open.sticky = true; renderCard(); } });
}

function typing(ev) {
  const t = ev.target;
  return !!t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName ?? ""));
}

function onKeyDown(ev) {
  if (typing(ev)) return;
  if (ev.key === "Alt" && !ev.repeat) {
    S.altDown = true;
    if (!S.open) {
      const tok = hoveredToken();
      if (tok && inBattle()) { ev.preventDefault(); open(tok, { viaAlt: true }); }
    }
    return;
  }
  if (!S.open) return;
  const eat = () => { ev.preventDefault(); ev.stopImmediatePropagation(); };
  if (ev.key === "Escape") { eat(); close(); }
  else if (ev.key === "Tab") { eat(); step(ev.shiftKey ? -1 : 1); }
  else {
    // Q / E by physical key: while Alt is held (Alt mode) ev.key is not "q".
    const dir = ev.code === "KeyQ" ? -1 : ev.code === "KeyE" ? 1 : 0;
    if (dir && !ev.ctrlKey && !ev.metaKey && (!ev.altKey || S.open.viaAlt)) { eat(); cycleTab(dir); }
  }
}

function onKeyUp(ev) {
  if (ev.key !== "Alt") return;
  S.altDown = false;
  if (S.open?.viaAlt && !S.open.sticky) close();
}

// Right-click anywhere is Back, the same as in the Party Menu (text fields keep
// their native menu).
function onContextMenu(ev) {
  if (S.eatContextMenu) { S.eatContextMenu = false; ev.preventDefault(); ev.stopImmediatePropagation(); return; }
  if (!S.open || typing(ev)) return;
  ev.preventDefault();
  ev.stopImmediatePropagation();
  close();
}

// ── lifecycle ───────────────────────────────────────────────────────────────

// A new action card or reaction window only ever follows a MOVING stretch, which
// already closed us (fu-battle-phase below); these are the dialogs that take
// the keyboard on their own.
const CLOSE_ON_SURFACE = new Set(["attribute-pair-picker", "passive-manager"]);

function bindCanvas() {
  const view = canvas?.app?.view;
  if (!view || view.__fuInspectBound) return;
  view.__fuInspectBound = true;
  view.addEventListener("pointerdown", onPointerDown, true);
  view.addEventListener("pointerup", onPointerUp, true);
}

function init() {
  try {
    game.settings.register(NS, HP_RULE_SETTING, {
      name: "Battle Inspect: enemy HP",
      hint: "What players see of an enemy's HP on the battle Inspect card. 'Exact from Identity' shows numbers once the party has studied it to 7+ (a bar until then).",
      scope: "world", config: true, type: String, default: "identity",
      choices: { identity: "Exact from Identity (Study 7+)", bar: "Bar only", crisis: "Crisis marker only" },
    });
  } catch (e) { console.warn(TAG, "setting register failed", e); }

  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  window.addEventListener("contextmenu", onContextMenu, true);
  window.addEventListener("blur", () => { S.altDown = false; if (S.open?.viaAlt) close(); });
  window.addEventListener("resize", () => { if (S.open) placeFrame(); });

  Hooks.on("canvasReady", () => { bindCanvas(); });
  Hooks.on("canvasTearDown", () => { close({ restoreCamera: false }); hidePeek(); });
  if (canvas?.ready) bindCanvas();

  Hooks.on("hoverToken", (token, hovered) => {
    if (hovered) { if (!S.open) showPeek(token); }
    else if (S.peekId === token.id) hidePeek();
  });
  Hooks.on("fu-director-surface-change", ({ action, entry } = {}) => {
    if (action !== "add" || !S.open) return;
    const kind = entry?.kind;
    if (CLOSE_ON_SURFACE.has(kind) || (kind === "target-picker" && !S.open.viaAlt)) close();
  });
  Hooks.on("fu-director-action", () => close());
  // The battle starts moving (a roll, an animation, a turn change): step aside.
  Hooks.on("fu-battle-phase", ({ settled } = {}) => { if (!settled && S.open) close(); });
  Hooks.on("fu-director-stopped", () => { close({ restoreCamera: false }); hidePeek(); });
  // Players never see the GM-local director hooks; the scene flag is their signal.
  Hooks.on("updateScene", (scene) => {
    if (scene?.id !== canvas?.scene?.id || inBattle()) return;
    close({ restoreCamera: false }); hidePeek();
  });
  // Live data: re-render the open card when its actor or effects change.
  const refresh = (doc) => {
    if (!S.open) return;
    const token = canvas?.tokens?.get(S.open.tokenId);
    const a = token?.actor;
    if (!a) return;
    const actor = doc?.documentName === "ActiveEffect" ? (doc.parent?.documentName === "Item" ? doc.parent.parent : doc.parent) : doc;
    if (actor === a || actor?.id === a.id || doc?.parent?.id === a.id) renderCard();
  };
  for (const h of ["updateActor", "createActiveEffect", "updateActiveEffect", "deleteActiveEffect"]) Hooks.on(h, refresh);
  Hooks.on("updateJournalEntryPage", () => { if (S.open?.enemy) renderCard(); });

  globalThis.FUCompanion ??= { api: {} };
  globalThis.FUCompanion.api ??= {};
  globalThis.FUCompanion.api.unitInspect = {
    open: (tokenOrId, opts) => open(typeof tokenOrId === "string" ? canvas?.tokens?.get(tokenOrId) : tokenOrId, opts),
    close, isOpen, peek: (t) => showPeek(typeof t === "string" ? canvas?.tokens?.get(t) : t), hidePeek,
    model: (t) => buildInspectModel(typeof t === "string" ? canvas?.tokens?.get(t) : t, { asPlayer: S.asPlayer }),
    setAsPlayer: (on) => { S.asPlayer = !!on; if (S.open) renderCard(); },
    state: () => ({ open: S.open ? { ...S.open } : null, ui: { ...S.ui }, peekId: S.peekId }),
  };
}

Hooks.once("ready", init);
