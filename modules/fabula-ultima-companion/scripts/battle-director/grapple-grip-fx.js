// grapple-grip-fx.js — the grip drawn between a grappler and the unit it holds.
//
// Approved look: claude.ai/artifact/FmUkx43vnEo8dtev1XjfyU (mockup v4, 2026-11-10).
// The SKIN comes from the grappler (grapple-rules.js SKINS; actor flag
// flags.fabula-ultima-companion.grappleSkin, default "chain"):
//   chain     a taut chain from the grappler's hand to a chain wrapped around the
//             held unit's body, soft glow per link, no travelling glint (user).
//   tentacle  a tapered tentacle with suckers to two coils at the waist
//             (Roper: "tentacle", Carlbero: "tentacle_green").
// Beats: on Grappled the grip shoots out and wraps on (the hold module pulls the
// token ~0.7 s later); while held the wrap turns slowly and squeezes every few
// seconds; when Grappled leaves it snaps (shards), or goes slack and fades when
// the grappler is down or gone.
//
// HOW
//   - Two PIXI layers per held unit in canvas.primary, with the held token mesh's
//     own depth keys: the BACK of the wrap just before the mesh, the FRONT (and
//     the tether) just after it, so the chain passes behind the body and a back-
//     row hold never paints over a front unit.
//   - Drawn every frame from the meshes' bounds. Under the 3D battle camera the
//     meshes sit at their drawn spot only inside a render, so the layers are
//     redrawn again on its "fu-stage3d-drawn" hook (prerender) — the grip rides
//     the displaced, rescaled battlers like the sprite shadow does.
//   - Hidden outside battle, during full-takeover cinematics (fuBattleMarksHidden),
//     and while the held token's mesh is hidden (the live board paints a copy).
//
// Per client, display only: no socket, no document writes.

import { log, warn } from "./logger.js";
import { battleActive } from "./battle-focus.js";
import { isGrappled, grapplerOf } from "./grappled.js";
import { resolveSkin } from "./grapple-rules.js";

const NS = "fabula-ultima-companion";
const DRAWN_HOOK = "fu-stage3d-drawn";      // battle-stage-3d-camera.js
const REF_H = 165;                          // sprite height the link sizes were tuned at
const LASH_MS = 240, WRAP_MS = 460, WRAP_AT = 200;
const SQUEEZE_EVERY = 2600, SQUEEZE_MS = 460;
const SNAP_MS = 650, SLACK_MS = 900;

const G = new Map();                        // held token id -> grip
let _hidden = false, _installed = false, _tick = null;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const eBack = (x) => { const c1 = 1.6, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };

// ───────── who holds whom
function grapplerTokenOf(actor) {
  const by = grapplerOf(actor);
  if (!by) return null;
  let doc = null;
  try { doc = by.tokenUuid ? fromUuidSync(by.tokenUuid) : null; } catch { doc = null; }
  if (doc?.object && doc.parent === canvas.scene) return doc.object;
  return canvas.tokens?.placeables?.find((t) => t.actor?.uuid === by.actorUuid) ?? null;
}
const isDown = (token) => { const hp = Number(token?.actor?.system?.props?.current_hp); return Number.isFinite(hp) && hp <= 0; };

function refresh({ instant = false } = {}) {
  if (!canvas?.ready || !canvas.tokens) return;
  const want = new Map();
  for (const t of canvas.tokens.placeables) {
    if (t.destroyed || !t.actor || !isGrappled(t.actor) || isDown(t)) continue;   // a downed unit is not held
    const g = grapplerTokenOf(t.actor);
    if (g) want.set(t.id, g);
  }
  for (const [id, grip] of G) {
    if (grip.exit) continue;
    if (!want.has(id)) beginExit(grip);
    else { grip.grappler = want.get(id); grip.skin = resolveSkin(grip.grappler.actor?.getFlag?.(NS, "grappleSkin")); }
  }
  for (const [id, g] of want) {
    const live = G.get(id);
    if (live && !live.exit) continue;
    if (live) dispose(live);
    G.set(id, makeGrip(canvas.tokens.get(id), g, instant));
  }
  ensureTicker();
}

function makeGrip(token, grappler, instant) {
  const back = new PIXI.Graphics(), front = new PIXI.Container(), fg = new PIXI.Graphics(), glow = new PIXI.Graphics();
  glow.blendMode = PIXI.BLEND_MODES.ADD; front.addChild(fg, glow);
  back.eventMode = front.eventMode = "none";
  const grip = { token, grappler, back, front, fg, glow, skin: resolveSkin(grappler.actor?.getFlag?.(NS, "grappleSkin")),
    t0: performance.now() - (instant ? 5000 : 0), exit: null, shards: [], last: null };
  place(grip);
  return grip;
}

function beginExit(grip) {
  grip.exit = { kind: (!grip.grappler || grip.grappler.destroyed || isDown(grip.grappler)) ? "slack" : "snap", t0: performance.now() };
  if (grip.exit.kind === "snap" && grip.last) {
    const { cx, wy, s } = grip.last;
    for (let i = 0; i < 18; i++) { const a = Math.random() * Math.PI * 2, v = (0.15 + Math.random() * 0.3) * s;
      grip.shards.push({ x: cx, y: wy, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 0.2 * s, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.02, size: (4 + Math.random() * 6) * s }); }
  }
}

function dispose(grip) {
  for (const o of [grip.back, grip.front]) { try { o.parent?.removeChild(o); o.destroy({ children: true }); } catch { /* gone */ } }
  for (const [id, g] of G) if (g === grip) G.delete(id);
}

// ───────── depth: same keys as the held mesh, back right before it, front right after
// A new child sorts BEFORE everything with equal keys (its _lastSortedIndex is
// 0), so insertion order does not hold: the halves sit a hair either side of the
// mesh on zIndex instead (measured 2026-11-10: both landed behind the body).
const Z_EPS = 0.001;
function place(grip) {
  const mesh = grip.token?.mesh, prim = canvas.primary;
  if (!mesh || mesh.destroyed || !prim) return;
  copyKeys(grip.back, mesh, -Z_EPS); copyKeys(grip.front, mesh, Z_EPS);
  prim.addChild(grip.back); prim.addChild(grip.front);
  prim.sortDirty = true;
}
function copyKeys(o, mesh, dz) {
  const z = (mesh.zIndex ?? 0) + dz;
  if (o.elevation !== mesh.elevation || o.sortLayer !== mesh.sortLayer || o.sort !== mesh.sort || o.zIndex !== z) {
    o.elevation = mesh.elevation; o.sortLayer = mesh.sortLayer; o.sort = mesh.sort; o.zIndex = z;
    if (canvas.primary) canvas.primary.sortDirty = true;
  }
}

// The mesh's rendered rect in primary space (where it is drawn this moment).
function rectOf(token) {
  const mesh = token?.mesh, prim = canvas.primary;
  if (!mesh || mesh.destroyed || !prim) return null;
  try {
    const b = mesh.getBounds(false);
    if (!b || !(b.width > 0) || !(b.height > 0)) return null;
    const tl = prim.worldTransform.applyInverse(new PIXI.Point(b.x, b.y));
    const br = prim.worldTransform.applyInverse(new PIXI.Point(b.x + b.width, b.y + b.height));
    return { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y, cx: (tl.x + br.x) / 2, feet: br.y };
  } catch { return null; }
}
const meshShown = (token) => !!(token && !token.destroyed && token.visible && token.mesh && !token.mesh.destroyed && token.mesh.visible && token.mesh.worldAlpha > 0.05);

// ───────── drawing
function bez(A, c1, c2, B, t) { const u = 1 - t; return { x: u*u*u*A.x + 3*u*u*t*c1.x + 3*u*t*t*c2.x + t*t*t*B.x, y: u*u*u*A.y + 3*u*u*t*c1.y + 3*u*t*t*c2.y + t*t*t*B.y }; }
function pathPts(A, B, p, s, limp, now, arc, n) {
  const dx = B.x - A.x, dy = B.y - A.y, len = Math.hypot(dx, dy), wave = Math.sin(now / 420) * 5 * s * (arc < 1 ? .3 : 1);
  const c1 = { x: A.x + dx * .3, y: A.y + dy * .3 - (8 + len * .12) * s * arc + wave + limp * 70 * s };
  const c2 = { x: A.x + dx * .72, y: A.y + dy * .72 - (10 + len * .06) * s * arc - wave + limp * 90 * s };
  const pts = []; for (let i = 0; i <= n; i++) pts.push(bez(A, c1, c2, B, p * i / n)); return pts;
}
// oval links every few px along a path, alternating face-on rings and edge-on bars
function drawChain(gF, gB, glow, pts, s, K, alpha) {
  const step = 8.6 * s; let acc = 0, next = step * .5, idx = 0;
  for (let i = 1; i < pts.length; i++) { const a = pts[i - 1], b = pts[i], seg = Math.hypot(b.x - a.x, b.y - a.y); if (!seg) continue;
    const ang = Math.atan2(b.y - a.y, b.x - a.x), ca = Math.cos(ang), sa = Math.sin(ang);
    while (next <= acc + seg) { const u = (next - acc) / seg, x = lerp(a.x, b.x, u), y = lerp(a.y, b.y, u), front = b.front !== false;
      const g = front ? gF : (gB || gF), main = front ? K.main : K.back, odd = idx++ % 2;
      if (!odd) { const ring = []; for (let j = 0; j <= 12; j++) { const t = j / 12 * Math.PI * 2, lx = Math.cos(t) * 6.2 * s, ly = Math.sin(t) * 3.9 * s; ring.push(x + lx * ca - ly * sa, y + lx * sa + ly * ca); }
        g.lineStyle(4.4 * s, K.out, alpha); g.drawPolygon(ring); g.lineStyle(2.4 * s, main, alpha); g.drawPolygon(ring);
        if (front) { g.lineStyle(s, K.hi, alpha); g.moveTo(x - 4 * s * ca + .6 * s * sa, y - 4 * s * sa - .6 * s * ca); g.lineTo(x + 2 * s * ca + 2.6 * s * sa, y + 2 * s * sa - 2.6 * s * ca); } }
      else { const x0 = x - 5.6 * s * ca, y0 = y - 5.6 * s * sa, x1 = x + 5.6 * s * ca, y1 = y + 5.6 * s * sa;
        g.lineStyle(4.8 * s, K.out, alpha); g.moveTo(x0, y0); g.lineTo(x1, y1); g.lineStyle(2.7 * s, main, alpha); g.moveTo(x0, y0); g.lineTo(x1, y1);
        if (front) { g.lineStyle(s, K.hi, alpha); g.moveTo(x0 + .8 * s * sa, y0 - .8 * s * ca); g.lineTo(x1 + .8 * s * sa, y1 - .8 * s * ca); } }
      if (front && K.glow != null && glow) { glow.lineStyle(0); glow.beginFill(K.glow, .14 * alpha); glow.drawCircle(x, y, 9 * s); glow.endFill(); }
      next += step; }
    acc += seg; }
}
function drawTentacle(g, pts, s, K, alpha) {
  const n = pts.length - 1;
  for (const [col, kw, off] of [[K.out, 1, 0], [K.main, .72, 0], [K.hi, .22, -.32]]) {
    for (let i = 1; i <= n; i++) { const w = Math.max(1.2, lerp(16, 6, i / n) * s); g.lineStyle(w * kw + (kw === 1 ? 3 : 0), col, alpha);
      g.moveTo(pts[i - 1].x, pts[i - 1].y + off * w); g.lineTo(pts[i].x, pts[i].y + off * w); }
  }
  g.lineStyle(0);
  for (let i = 4; i < n - 1; i += 4) { const w = lerp(16, 6, i / n) * s; g.beginFill(K.sucker ?? K.hi, alpha); g.drawCircle(pts[i].x, pts[i].y + w * .3, Math.max(1, w * .13)); g.endFill(); }
}
function drawCoils(g, cx, wy, rx, s, k, sq, K, alpha) {
  const r = rx * lerp(1.8, 1, eBack(clamp(k, 0, 1))) * (1 - .1 * sq), ry = r * .34, a = alpha * clamp(k * 2.5, 0, 1);
  for (const [oy, tilt] of [[-11 * s, -.22], [5 * s, .12]]) for (const [col, w, o] of [[K.out, 8.5, 0], [K.main, 5.5, 0], [K.hi, 1.6, -1.4]]) {
    g.lineStyle(w * s, col, a); const pts = [];
    for (let j = 0; j <= 16; j++) { const t = lerp(.02, .98, j / 16) * Math.PI, lx = Math.cos(t) * r, ly = Math.sin(t) * ry;
      pts.push({ x: cx + lx * Math.cos(tilt) - ly * Math.sin(tilt), y: wy + oy + o * s + lx * Math.sin(tilt) + ly * Math.cos(tilt) }); }
    g.moveTo(pts[0].x, pts[0].y); for (const p of pts) g.lineTo(p.x, p.y);
  }
}

function drawGrip(grip, now) {
  const { back, fg, glow, token } = grip;
  back.clear(); fg.clear(); glow.clear();
  const R = rectOf(token);
  const show = battleActive() && !_hidden && R && meshShown(token);
  back.visible = grip.front.visible = !!show;
  if (!show) return;
  copyKeys(back, token.mesh, -Z_EPS); copyKeys(grip.front, token.mesh, Z_EPS);
  const K = grip.skin, t = now - grip.t0, s = R.h / REF_H;
  let alpha = 1, limp = 0;
  if (grip.exit) { const u = (now - grip.exit.t0) / (grip.exit.kind === "snap" ? SNAP_MS : SLACK_MS);
    if (u >= 1) { dispose(grip); return; }
    if (grip.exit.kind === "slack") { limp = u; alpha = 1 - u; } else alpha = 0; }
  const p = clamp(t / LASH_MS, 0, 1), k = clamp((t - WRAP_AT) / WRAP_MS, 0, 1);
  const ph = t % SQUEEZE_EVERY, sq = !grip.exit && t > WRAP_AT + WRAP_MS && ph < SQUEEZE_MS ? Math.sin(ph / SQUEEZE_MS * Math.PI) : 0;
  const wy = R.feet - R.h * .43;
  grip.last = { cx: R.cx, wy, s };
  // the wrap
  let end = { x: R.cx, y: wy };
  if (alpha > 0 && K.type === "chain" && k > 0) {
    const top = R.feet - R.h * .64, bot = R.feet - R.h * .25, span = (bot - top) * (1 - .1 * sq);
    const rx = R.w * .2 * lerp(1.9, 1, eBack(k)) * (1 - .12 * sq) * (1 + limp * .7), ry = rx * .3;
    const wound = Math.min(1, k * 1.3), spin = now / 1300, pts = [];
    for (let i = 0; i <= 140; i++) { const u = i / 140 * wound, th = u * 2.75 * Math.PI * 2 + spin;
      pts.push({ x: R.cx + rx * Math.cos(th), y: bot - span * u + ry * Math.sin(th) + limp * R.h * .2 * u, front: Math.sin(th) > -.05 }); }
    drawChain(fg, back, glow, pts, s * .95, K, alpha * clamp(k * 3, 0, 1));
    end = pts[pts.length - 1];
  }
  // the tether from the grappler
  const gr = grip.grappler && !grip.grappler.destroyed && meshShown(grip.grappler) ? rectOf(grip.grappler) : null;
  if (gr && alpha > 0 && p > 0) {
    const face = R.cx >= gr.cx ? 1 : -1;
    const A = { x: gr.cx + face * gr.w * .17, y: gr.feet - gr.h * .38 };
    if (K.type === "tentacle") drawTentacle(fg, pathPts(A, { x: R.cx, y: wy }, p, s * .9, limp, now, 1, 30), s * .9, K, alpha);
    else drawChain(fg, null, glow, pathPts(A, end, p, s * .9, limp, now, .35, 80), s * .9, K, alpha);
  }
  if (alpha > 0 && K.type === "tentacle" && k > 0) drawCoils(fg, R.cx, wy, R.w * .19, s, k, sq, K, alpha);
  // snap shards
  if (grip.exit?.kind === "snap") {
    const u = (now - grip.exit.t0) / SNAP_MS, dt = Math.min(50, now - (grip.exit.last ?? now)); grip.exit.last = now;
    fg.lineStyle(0);
    for (const sh of grip.shards) { sh.vy += .0012 * dt; sh.x += sh.vx * dt; sh.y += sh.vy * dt; sh.r += sh.vr * dt;
      const c = Math.cos(sh.r), si = Math.sin(sh.r), z = sh.size, pt = (lx, ly) => [sh.x + lx * c - ly * si, sh.y + lx * si + ly * c];
      fg.beginFill(K.main, 1 - u); fg.drawPolygon([...pt(0, -z), ...pt(z * .6, 0), ...pt(0, z * .9), ...pt(-z * .5, 0)]); fg.endFill(); }
  }
}

function frame() {
  if (!G.size) return stopTicker();
  const now = performance.now();
  for (const grip of [...G.values()]) {
    try { if (!grip.token || grip.token.destroyed) { dispose(grip); continue; } drawGrip(grip, now); }
    catch (e) { warn("[grapple-grip] draw failed", e); dispose(grip); }
  }
}
function ensureTicker() {
  if (_tick || !G.size || !canvas?.app?.ticker) return;
  _tick = () => frame();
  canvas.app.ticker.add(_tick, null, PIXI.UPDATE_PRIORITY.LOW);
}
function stopTicker() { if (_tick) { try { canvas.app.ticker.remove(_tick); } catch { /* gone */ } _tick = null; } }

/** Install once on ready (every client). */
export function installGrappleGripFx() {
  if (_installed) return;
  _installed = true;
  const soon = foundry.utils.debounce(() => { try { refresh(); } catch (e) { warn("[grapple-grip] refresh threw", e); } }, 30);
  for (const h of ["createActiveEffect", "deleteActiveEffect", "updateActiveEffect", "createToken", "deleteToken", "updateActor"]) Hooks.on(h, soon);
  Hooks.on("canvasReady", () => { for (const g of [...G.values()]) dispose(g); stopTicker(); try { refresh({ instant: true }); } catch (e) { warn("[grapple-grip] refresh threw", e); } });
  Hooks.on("canvasTearDown", () => { for (const g of [...G.values()]) dispose(g); stopTicker(); });
  // the 3D camera has just moved the meshes to their drawn spot: redraw on them
  Hooks.on(DRAWN_HOOK, () => { if (G.size) frame(); });
  Hooks.on("fuBattleMarksHidden", (hidden) => { _hidden = !!hidden; });
  if (canvas?.ready) refresh({ instant: true });
  globalThis.FUCompanion = globalThis.FUCompanion || {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
  globalThis.FUCompanion.api.grappleGrip = { refresh, grips: () => [...G.entries()].map(([id, g]) => ({ id, grappler: g.grappler?.id, skin: g.skin.id, exit: g.exit?.kind ?? null })) };
  log("[grapple-grip] installed");
}
