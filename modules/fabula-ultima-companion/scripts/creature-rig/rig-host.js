// ============================================================================
// creature-rig/rig-host.js — the Foundry side of a 3D creature rig (docs/creature-rig.md, "Host contract")
//
// Which tokens get a rig (a def whose match.src is the token's painted image), and for each one on THIS client:
// its own THREE.WebGLRenderer on an offscreen canvas, a RigModel (rig-model.js) and a RigAnimator
// (rig-motions.js). The token mesh's texture is swapped for a PIXI texture of that canvas; every effect that
// works on token.mesh (glow filter, tint, alpha fades, shake, depth scale, the 3D camera's placement) keeps
// working because the mesh itself is untouched.
//
// SIZING. The live texture keeps the painting's LOGICAL size (orig = trim = w x h of the painting) while its
// frame is the whole canvas, which may be smaller: Foundry's PrimarySpriteMesh sizes from texture.width/height
// (= orig) in resize() and its vertices span orig (trim) — so no anchor or size moves, while the canvas renders
// only as many pixels as the token covers on screen (x the renderer resolution, capped at native, in steps of
// 1/8 so a zoom does not resize it every frame; it grows at once and shrinks only after a steady second).
//
// UPLOAD. Each rendered frame bumps baseTexture.dirtyId instead of calling baseTexture.update(): update() emits
// "update" through the texture to the mesh, whose _onTextureUpdate() resets mesh.scale from its fitted size —
// that would undo the 3D camera's per-frame placement scale (it moves the mesh in prerender and restores it in
// postrender). PIXI re-uploads a texture whose dirtyId moved the next time it binds it (this frame).
//
// THE PAINTING WINS when the mesh shows anything else: a texture that is not the painting (battler-pose art,
// a walk cycle) leaves the rig paused until the painting comes back. A rig held at rest with the camera flat
// shows the painting itself (exact hand-off, nothing rendered). Hidden tokens (alpha 0, not visible / not
// renderable) are not rendered, but the animator still runs so motion promises resolve.
// ============================================================================

import { RigModel } from "./rig-model.js";
import { RigAnimator, CHANNELS } from "./rig-motions.js";
import { loadThree } from "../shared/three-loader.js";

const NS = "fabula-ultima-companion";
const SETTING = "creatureRig3d";
const TAG = "[fu creature-rig]";
const FRAME_MS = 1000 / 30 - 2;          // ~30 fps (a little slack so a 60 Hz display lands every other frame)
const Q_STEPS = 8;                        // render resolution steps (1/8 .. 8/8 of native)
const SHRINK_AFTER_MS = 1200;

const DEFS = new Map();                   // def id -> def
const recs = new Map();                   // token id -> rec
const failed = new Set();                 // token ids whose rig died (context lost / build error): no retry this scene
const waiters = new Map();                // token id -> Set<resolve>
const dataCache = new Map();              // def id -> Promise<rig.json data>
let hooked = false;
let onPre = null;
const PARK_HOLD_MS = 400;            // rest + flat camera must hold this long before the plain painting is shown
const debug = { noPark: false };     // tests: render the rest pose instead of parking on the painting
const liveHolds = new Map();         // token id -> count: a show draws this rig's live frame itself while the token is hidden

// ── paths ───────────────────────────────────────────────────────────────────

function normSrc(p) {
  if (typeof p !== "string" || !p) return "";
  let s = p.trim().replace(/\\/g, "/");
  s = s.split(/[?#]/)[0];
  try { s = decodeURIComponent(s); } catch { /* keep */ }
  s = s.replace(/^[a-z]+:\/\/[^/]+/i, "");          // origin
  try {                                               // a route prefix (foundry behind a path)
    const r = globalThis.foundry?.utils?.getRoute?.("/") ?? "/";
    if (r && r !== "/" && s.startsWith(r)) s = s.slice(r.length);
  } catch { /* none */ }
  return s.replace(/^\/+/, "");
}
// "worlds/<any world>/x" -> "x": a copied world (the Staging World) keeps its art at the same world-relative path
const worldRel = (s) => { const m = /^worlds\/[^/]+\/(.+)$/.exec(s); return m ? m[1] : null; };

function srcMatches(def, src) {
  const s = normSrc(src);
  if (!s || !def?.match?.src?.length) return false;
  const sw = worldRel(s);
  for (const m of def.match.src) {
    if (m === s) return true;
    const mw = worldRel(m);
    if (mw && sw && mw === sw) return true;
  }
  return false;
}

function srcOfTexture(tex) {
  const bt = tex?.baseTexture, r = bt?.resource;
  return r?.url ?? r?.src ?? bt?.cacheId ?? bt?.textureCacheIds?.[0] ?? "";
}

// ── defs ────────────────────────────────────────────────────────────────────

/** Register (or replace) a rig definition: { id, base, match: { src: [..] }, onEntrance }. */
export function registerRigDef(def) {
  if (!def?.id || !def?.base) throw new Error(`${TAG} a rig def needs an id and a base folder`);
  const base = def.base.endsWith("/") ? def.base : `${def.base}/`;
  const src = [...new Set((def.match?.src ?? []).map(normSrc).filter(Boolean))];
  const d = { ...def, base, match: { ...(def.match ?? {}), src } };
  DEFS.set(d.id, d);
  dataCache.delete(d.id);
  if (hooked && globalThis.canvas?.ready) syncAll();
  return d;
}

function rigDataOf(def) {
  let p = dataCache.get(def.id);
  if (!p) {
    p = (async () => {
      const res = await fetch(foundry.utils.getRoute(`${def.base}rig.json`));
      if (!res.ok) throw new Error(`${def.base}rig.json -> HTTP ${res.status}`);
      const data = await res.json();
      // the rig's own match list joins the def's (authored once, in export_rig.py)
      for (const s of data.match?.src ?? []) { const n = normSrc(s); if (n && !def.match.src.includes(n)) def.match.src.push(n); }
      return data;
    })();
    p.catch(() => dataCache.delete(def.id));
    dataCache.set(def.id, p);
  }
  return p;
}

function enabled() {
  try { return game.settings.get(NS, SETTING) !== false; } catch { return true; }
}

function flagOf(token) {
  const f = (doc) => doc?.flags?.[NS]?.creatureRig;
  return f(token?.actor) ?? f(token?.document) ?? null;
}

function defForToken(token) {
  const doc = token?.document;
  if (!doc) return null;
  const flag = flagOf(token);
  if (flag === "off") return null;
  if (typeof flag === "string" && DEFS.has(flag)) return DEFS.get(flag);
  const src = doc.texture?.src;
  for (const d of DEFS.values()) if (srcMatches(d, src)) return d;
  return null;
}

// ── lookups ─────────────────────────────────────────────────────────────────

function tokenOf(ref) {
  if (!ref) return null;
  if (typeof ref === "string") {
    const id = ref.includes(".") ? ref.split(".").pop() : ref;
    return globalThis.canvas?.tokens?.get?.(id) ?? null;
  }
  if ((globalThis.Token && ref instanceof globalThis.Token) || (ref.document && "mesh" in ref)) return ref;   // Token placeable
  if (ref.object) return ref.object;                                    // TokenDocument
  if (ref.id) return globalThis.canvas?.tokens?.get?.(ref.id) ?? null;
  return null;
}
const idOf = (ref) => {
  if (!ref) return null;
  if (typeof ref === "string") return ref.includes(".") ? ref.split(".").pop() : ref;
  return ref.document?.id ?? ref.id ?? null;
};

/** Does a def match this token's painted image (even before its rig has built)? False when this client has rigs off. */
export function isRiggedToken(token) {
  const t = tokenOf(token);
  if (!t || !enabled()) return false;
  if (failed.has(t.document?.id)) return false;
  return !!defForToken(t);
}

/** The live, built rig of this token on THIS client, or null. */
export function rigFor(tokenOrId) {
  const rec = recs.get(idOf(tokenOrId));
  return rec && rec.state === "live" ? rec.instance : null;
}

/** Resolves with the token's rig once it is built (null: not rigged, timed out, or it died). */
export function whenRig(tokenOrId, timeoutMs = 8000) {
  const id = idOf(tokenOrId);
  const now = rigFor(id);
  if (now) return Promise.resolve(now);
  const t = tokenOf(tokenOrId) ?? globalThis.canvas?.tokens?.get?.(id);
  if (!id || (t && !isRiggedToken(t))) return Promise.resolve(null);
  if (t && !recs.has(id)) ensure(t);
  return new Promise((resolve) => {
    let set = waiters.get(id);
    if (!set) waiters.set(id, (set = new Set()));
    const done = (v) => { clearTimeout(timer); set.delete(done); resolve(v); };
    const timer = setTimeout(() => done(null), Math.max(0, timeoutMs));
    set.add(done);
  });
}
function settle(id, value) {
  const set = waiters.get(id);
  if (!set) return;
  waiters.delete(id);
  for (const fn of [...set]) { try { fn(value); } catch { /* none */ } }
}

/** The ORIGINAL painting texture of this token: read his pixels from this, never from token.mesh.texture. */
export function paintedTexture(token) {
  const t = tokenOf(token) ?? token;
  const mesh = t?.mesh;
  const rec = recs.get(t?.document?.id);
  const own = t?.texture;
  if (rec && mesh && (mesh.texture === rec.pixiTex) && own?.valid) return own;
  return mesh?.texture ?? own ?? null;
}

/**
 * Keep this token's rig rendering while its token is HIDDEN (mesh alpha 0): for a show that hides the token and draws
 * its live frame (token.mesh.texture) in its own layer (the battle opening's roar inside Nidhogg's return smoke).
 * Returns the release (once). Off a rig it is a harmless no-op.
 */
export function keepRigLive(tokenOrId) {
  const id = idOf(tokenOrId);
  if (!id) return () => {};
  liveHolds.set(id, (liveHolds.get(id) ?? 0) + 1);
  let done = false;
  return () => {
    if (done) return; done = true;
    const n = (liveHolds.get(id) ?? 1) - 1;
    if (n > 0) liveHolds.set(id, n); else liveHolds.delete(id);
  };
}

/** Every rig on this client (debug). */
export function list() {
  return [...recs.values()].map((r) => ({
    id: r.id, name: r.token?.name, def: r.def.id, state: r.state, parked: r.parked, yielded: r.yielded,
    size: r.el ? [r.el.width, r.el.height] : null, frames: r.frames, steps: r.steps, costMs: Math.round(r.costMs * 1000) / 1000,
    busy: r.animator.busy, resting: r.animator.resting,
  }));
}

// ── one rig ─────────────────────────────────────────────────────────────────

function makeInstance(rec) {
  const clock = () => performance.now() / 1000;
  return {
    get id() { return rec.id; },
    get token() { return rec.token; },
    get def() { return rec.def; },
    get animator() { return rec.animator; },
    get busy() { return rec.animator.busy; },
    play(name, opts = {}) { rec.dirty = true; return rec.animator.play(name, opts ?? {}, clock()); },
    rest(ms = 250) { rec.animator.rest(ms); rec.dirty = true; },
    release(ms = 400) { rec.animator.release(ms); rec.dirty = true; },
  };
}

function ensure(token) {
  const id = token?.document?.id;
  if (!id || recs.has(id) || failed.has(id) || !enabled()) return;
  const def = defForToken(token);
  if (!def) return;
  const rec = {
    id, token, def, animator: new RigAnimator(), state: "building", el: null, renderer: null, model: null,
    bt: null, pixiTex: null, W: 0, H: 0, q: 0, shrinkSince: 0, lastRender: 0, lastPose: null, lastYaw: 0,
    dirty: true, parked: false, yielded: false, frames: 0, steps: 0, costMs: 0, onLost: null,
  };
  rec.animator.sample(performance.now() / 1000);
  rec.instance = makeInstance(rec);
  recs.set(id, rec);
  build(rec).catch((e) => {
    console.warn(TAG, `rig "${def.id}" for ${token.name} could not build; the painting stays`, e);
    failed.add(id);
    dispose(rec);
  });
}

async function build(rec) {
  const THREE = await loadThree();
  const data = await rigDataOf(rec.def);
  if (rec.state !== "building") return;
  const W = data.w, H = data.h;
  const el = document.createElement("canvas");
  el.width = W; el.height = H;
  const renderer = new THREE.WebGLRenderer({ canvas: el, alpha: true, antialias: false, premultipliedAlpha: true });
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x000000, 0);
  renderer.setSize(W, H, false);
  Object.assign(rec, { el, renderer, W, H, q: 1 });
  rec.onLost = (e) => {
    e?.preventDefault?.();
    console.warn(TAG, `WebGL context lost for ${rec.token?.name ?? rec.id}; back to the painting (no retry this scene)`);
    failed.add(rec.id);
    dispose(rec, { lost: true });
  };
  el.addEventListener("webglcontextlost", rec.onLost, false);
  const base = rec.def.base;
  const model = new RigModel(THREE, data, (name) => foundry.utils.getRoute(`${base}${name}?v=${data.hash || "0"}`));
  rec.model = model;
  await model.build();
  if (rec.state !== "building") return;      // disposed while loading (dispose() cleaned up what was there)

  const bt = new PIXI.BaseTexture(el);
  // logical size = the painting's (orig + trim), frame = the whole canvas (follows its size: noFrame)
  const tex = new PIXI.Texture(bt, undefined, new PIXI.Rectangle(0, 0, W, H), new PIXI.Rectangle(0, 0, W, H));
  rec.bt = bt; rec.pixiTex = tex;
  rec.state = "live";
  rec.dirty = true;
  settle(rec.id, rec.instance);
}

function setMeshTexture(mesh, tex) {
  if (!mesh || mesh.destroyed || mesh.texture === tex) return;
  const old = mesh.texture, sx = mesh.scale.x, sy = mesh.scale.y;
  const same = old?.orig && tex?.orig && old.orig.width === tex.orig.width && old.orig.height === tex.orig.height;
  mesh.texture = tex;
  // same logical size: keep whatever scale is on the mesh this frame (the 3D camera's, between its pre/postrender)
  if (same) mesh.scale.set(sx, sy);
}

/** Is `tex` the token's painting (ours to replace), as opposed to pose / walk art? */
function isPainting(rec, tex) {
  if (!tex || tex === PIXI.Texture.EMPTY || !tex.valid) return false;
  const own = rec.token.texture;
  if (tex === own) return true;
  if (own?.baseTexture && tex.baseTexture === own.baseTexture) return true;
  return srcMatches(rec.def, srcOfTexture(tex));
}

function wantQ(rec) {
  const wt = rec.token.mesh?.worldTransform;
  if (!wt) return rec.q || 1;
  const res = globalThis.canvas?.app?.renderer?.resolution || globalThis.devicePixelRatio || 1;
  const k = Math.hypot(wt.a, wt.b) * res;                // screen px per painting px
  return Math.min(1, Math.max(1 / Q_STEPS, Math.ceil(k * Q_STEPS - 1e-3) / Q_STEPS));
}

function resize(rec, q) {
  const w = Math.max(2, Math.round(rec.W * q)), h = Math.max(2, Math.round(rec.H * q));
  rec.q = q;
  if (rec.el.width === w && rec.el.height === h) return;
  rec.renderer.setSize(w, h, false);
  const mesh = rec.token.mesh, sx = mesh?.scale.x, sy = mesh?.scale.y;
  rec.bt.resource.resize(w, h);                          // -> baseTexture.setRealSize -> the texture's frame follows
  if (mesh && !mesh.destroyed && mesh.texture === rec.pixiTex) mesh.scale.set(sx, sy);
  rec.dirty = true;
}

function samePose(a, b) {
  if (!a || !b) return false;
  for (const c of CHANNELS) if (Math.abs(a[c] - b[c]) > 0.01) return false;
  return Math.abs(a.tail) < 0.01 || Math.abs(a.tailPhase - b.tailPhase) < 1e-3;
}

function step(rec, nowMs, yaw) {
  const token = rec.token;
  if (!token || token.destroyed || !token.document || token.document.id !== rec.id) { dispose(rec, { restore: false }); return; }
  rec.steps++;
  const pose = rec.animator.sample(nowMs / 1000);       // always: motion promises resolve even while hidden
  if (rec.state !== "live") return;
  const mesh = token.mesh;
  // A FLIPPED token (texture scaleX < 0: Nidhogg faces the party, right, while the painting faces left) shows the
  // render mirrored, so the turn that matches the camera is the opposite one: unflipped, the camera swinging right
  // brings his tail (painting right) nearer; flipped, his head (painting left, shown on the right) must come nearer.
  // Found 2026-11-19 on the battle opening's 35-degree shot from his face side: he turned his tail to the camera.
  if (mesh && !mesh.destroyed && mesh.scale.x < 0) yaw = -yaw;
  if (!mesh || mesh.destroyed) return;
  const cur = mesh.texture;
  const own = token.texture?.valid ? token.texture : null;

  if (cur !== rec.pixiTex && !isPainting(rec, cur)) { rec.yielded = true; rec.dirty = true; return; }   // pose art wins
  rec.yielded = false;

  // at rest with the camera flat: the painting itself (exact; nothing to render)
  // (held for PARK_HOLD_MS first: a swaying camera passes yaw 0 every few seconds, and a one-frame swap to the
  // sharper painting and back read as a flicker)
  const parkNow = !debug.noPark && rec.animator.resting && Math.abs(yaw) < 0.01 && !!own;
  if (!parkNow) rec.parkSince = 0; else if (!rec.parkSince) rec.parkSince = nowMs;
  const park = parkNow && (rec.parked || nowMs - rec.parkSince >= PARK_HOLD_MS);
  if (park) {
    if (cur !== own) setMeshTexture(mesh, own);
    rec.parked = true; rec.dirty = true;
    return;
  }
  rec.parked = false;

  const shown = (token.visible !== false && mesh.visible && mesh.renderable !== false && mesh.alpha > 0.002) || liveHolds.has(rec.id);
  if (!shown) { rec.dirty = true; if (cur !== rec.pixiTex) setMeshTexture(mesh, rec.pixiTex); return; }

  const due = rec.dirty || nowMs - rec.lastRender >= FRAME_MS;
  if (!due) { if (cur !== rec.pixiTex) setMeshTexture(mesh, rec.pixiTex); return; }

  // render resolution: grow at once, shrink once steady
  const q = wantQ(rec);
  if (q > rec.q) { rec.shrinkSince = 0; resize(rec, q); }
  else if (q < rec.q) {
    if (!rec.shrinkSince) rec.shrinkSince = nowMs;
    else if (nowMs - rec.shrinkSince > SHRINK_AFTER_MS) { rec.shrinkSince = 0; resize(rec, q); }
  } else rec.shrinkSince = 0;

  if (rec.dirty || !samePose(pose, rec.lastPose) || Math.abs(yaw - rec.lastYaw) > 0.01) {
    const t0 = performance.now();
    rec.model.pose(pose);
    rec.model.setYaw(yaw);
    rec.model.render(rec.renderer);
    rec.bt.dirtyId++;                                    // re-uploaded when PIXI binds it this frame (see header)
    const dt = performance.now() - t0;
    rec.costMs = rec.frames ? rec.costMs * 0.9 + dt * 0.1 : dt;
    rec.frames++;
    rec.lastRender = nowMs; rec.lastPose = { ...pose }; rec.lastYaw = yaw; rec.dirty = false;
  }
  if (mesh.texture !== rec.pixiTex) setMeshTexture(mesh, rec.pixiTex);
}

function dispose(rec, { restore = true, lost = false } = {}) {
  if (rec.state === "dead") return;
  rec.state = "dead";
  if (recs.get(rec.id) === rec) recs.delete(rec.id);
  try { rec.animator.rest(0); } catch { /* none */ }      // resolves every running motion ("rest")
  const token = rec.token, mesh = token?.mesh;
  if (restore && mesh && !mesh.destroyed && rec.pixiTex && mesh.texture === rec.pixiTex) {
    const own = token.texture?.valid ? token.texture : PIXI.Texture.EMPTY;
    setMeshTexture(mesh, own);
  } else if (mesh && !mesh.destroyed && rec.pixiTex && mesh.texture === rec.pixiTex) {
    try { mesh.texture = PIXI.Texture.EMPTY; } catch { /* gone */ }
  }
  try { rec.pixiTex?.destroy(false); } catch { /* none */ }
  try { rec.bt?.destroy(); } catch { /* none */ }
  try { rec.model?.dispose(); } catch { /* none */ }
  if (rec.el && rec.onLost) rec.el.removeEventListener("webglcontextlost", rec.onLost, false);
  if (rec.renderer) {
    try { rec.renderer.renderLists?.dispose?.(); } catch { /* none */ }
    try { rec.renderer.dispose(); } catch { /* none */ }
    if (!lost) { try { rec.renderer.forceContextLoss(); } catch { /* none */ } }
  }
  if (rec.el) { rec.el.width = 1; rec.el.height = 1; }
  rec.pixiTex = rec.bt = rec.model = rec.renderer = rec.el = null;
  settle(rec.id, null);
}

// ── all of them ─────────────────────────────────────────────────────────────

function disposeAll() { for (const rec of [...recs.values()]) dispose(rec); }

function syncToken(token) {
  if (!token || token.destroyed) return;
  const id = token.document?.id;
  const rec = recs.get(id);
  const want = isRiggedToken(token);
  if (rec && (!want || rec.token !== token || defForToken(token) !== rec.def)) dispose(rec);
  if (want && !recs.has(id)) ensure(token);
}

function syncAll() {
  if (!globalThis.canvas?.ready) return;
  if (!enabled()) { disposeAll(); return; }
  for (const t of canvas.tokens?.placeables ?? []) syncToken(t);
  for (const rec of [...recs.values()]) if (rec.token?.destroyed || !canvas.tokens?.get(rec.id)) dispose(rec, { restore: false });
}

function attachFrameLoop() {
  const r = globalThis.canvas?.app?.renderer;
  if (!r || onPre) return;
  onPre = () => {
    if (!recs.size) return;
    if (r.renderingToScreen === false) return;          // a render-texture pass, not the screen frame
    const nowMs = performance.now();
    let yaw = 0;
    try { yaw = -(Number(globalThis.__ONI_BATTLE_STAGE_3D__?.cameraYaw?.()) || 0); } catch { /* none */ }
    for (const rec of [...recs.values()]) {
      try { step(rec, nowMs, yaw); } catch (e) { console.warn(TAG, `frame failed for ${rec.token?.name ?? rec.id}; rig off for this token`, e); failed.add(rec.id); dispose(rec); }
    }
  };
  r.on("prerender", onPre);
}
function detachFrameLoop() {
  try { globalThis.canvas?.app?.renderer?.off?.("prerender", onPre); } catch { /* none */ }
  onPre = null;
}

// ── boot ────────────────────────────────────────────────────────────────────

/** Boot (call at init): the client setting, the hooks, the built-in defs. */
export function initCreatureRigs() {
  if (hooked) return;
  hooked = true;
  try {
    game.settings.register(NS, SETTING, {
      name: "3D animated creatures",
      hint: "Some large creatures (Nidhogg) are drawn as a live 3D rig that breathes and roars instead of a flat image. " +
        "Uses the GPU (one small WebGL view per creature on screen). Turn off on a slow machine: they show as their painting.",
      scope: "client", config: true, type: Boolean, default: true,
      onChange: () => syncAll(),
    });
  } catch (e) { console.warn(TAG, "setting not registered", e); }

  registerRigDef({
    id: "nidhogg",
    base: `modules/${NS}/assets/creature-rigs/nidhogg/`,
    match: { src: ["worlds/fabula-ultima-2/assets/Beastiary/Nidhoggr_Standard.png"] },
    onEntrance: "roar",
  });

  Hooks.on("canvasReady", () => { failed.clear(); detachFrameLoop(); attachFrameLoop(); syncAll(); });
  Hooks.on("canvasTearDown", () => { disposeAll(); failed.clear(); detachFrameLoop(); });
  Hooks.on("drawToken", (token) => { try { syncToken(token); } catch (e) { console.warn(TAG, "drawToken sync failed", e); } });
  Hooks.on("destroyToken", (token) => { const rec = recs.get(token?.document?.id); if (rec && rec.token === token) dispose(rec, { restore: false }); });
  Hooks.on("deleteToken", (doc) => { const rec = recs.get(doc?.id); if (rec) dispose(rec, { restore: false }); });
  Hooks.on("updateToken", (doc, change) => {
    if (!foundry.utils.hasProperty(change, "texture.src") && !foundry.utils.hasProperty(change, `flags.${NS}.creatureRig`)) return;
    const t = doc?.object; if (t) setTimeout(() => syncToken(t), 0);
  });
  Hooks.on("updateActor", (actor, change) => {
    if (!foundry.utils.hasProperty(change, `flags.${NS}.creatureRig`) && !foundry.utils.hasProperty(change, `flags.${NS}.-=creatureRig`)) return;
    for (const t of canvas?.tokens?.placeables ?? []) if (t.actor === actor || t.actor?.id === actor.id) syncToken(t);
  });
  if (globalThis.canvas?.ready) { attachFrameLoop(); syncAll(); }

  globalThis.__ONI_CREATURE_RIG__ = { rigFor, whenRig, list, paintedTexture, isRiggedToken, defs: () => [...DEFS.values()],
    _debug: { flags: debug, rec: (ref) => recs.get(idOf(ref)) ?? null } };
}
