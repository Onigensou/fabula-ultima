// PORTED (Batch C, 2026-11-05): old effect-player calls replaced by the PORT shim
// (_port-shim.js, header comment trimmed). Same look and timing as the legacy script.
// PORT.sound = AudioHelper broadcast; PORT.effect = webm via game.ONI.pseudo.play; PORT.wait.
// Pseudo inners hide tokens with oni.hideToken (guarded), never by toggling visibility.
const PORT = (() => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  function sound(src, volume) {
    if (!src) return;
    try {
      const AH = (foundry && foundry.audio && foundry.audio.AudioHelper) || globalThis.AudioHelper;
      AH.play({ src: src, volume: volume == null ? 0.8 : volume, autoplay: true, loop: false }, true);
    } catch (e) { console.warn('[PORT] sound failed', src, e); }
  }
  const INNER = [
    "const p = ctx.params || {};",
    "const vid = document.createElement('video'); vid.src = p.file; vid.muted = true; vid.playsInline = true; vid.crossOrigin = 'anonymous';",
    "let tex; try { tex = await loadTexture(p.file); } catch (e) { tex = null; }",
    "if (!tex) return;",
    "const v = tex.baseTexture && tex.baseTexture.resource && tex.baseTexture.resource.source;",
    "const spr = new PIXI.Sprite(tex); spr.anchor.set(0.5, 0.5);",
    "const nw = (v && v.videoWidth) || tex.width || 100, nh = (v && v.videoHeight) || tex.height || 100;",
    "const k = (p.scale || 1) * (canvas.grid.size / (p.fileGrid || 200));",
    "spr.width = nw * k; spr.height = nh * k; if (p.mirrorX) spr.scale.x *= -1; if (p.mirrorY) spr.scale.y *= -1;",
    "spr.angle = -(p.rotate || 0); spr.x = p.x; spr.y = p.y; spr.alpha = p.fadeIn ? 0 : (p.opacity == null ? 1 : p.opacity);",
    "spr.zIndex = p.below ? 50 : 100500; canvas.stage.sortableChildren = true; canvas.stage.addChild(spr); canvas.stage.sortChildren();",
    "const op = p.opacity == null ? 1 : p.opacity;",
    "if (v) { try { v.loop = false; v.currentTime = 0; v.playbackRate = p.rate || 1; await v.play(); } catch (e) {} }",
    "const dur = p.duration || ((v && isFinite(v.duration) ? v.duration * 1000 / (p.rate || 1) : 1000));",
    "const t0 = performance.now();",
    "await new Promise((res) => { const tick = () => { const e = performance.now() - t0; let a = op; if (p.fadeIn && e < p.fadeIn) a = op * e / p.fadeIn; if (p.fadeOut && e > dur - p.fadeOut) a = op * Math.max(0, (dur - e) / p.fadeOut); spr.alpha = a; if (e >= dur) { canvas.app.ticker.remove(tick); res(); } }; canvas.app.ticker.add(tick); });",
    "try { spr.destroy(); } catch (e) {} try { if (v) v.pause(); } catch (e) {}",
  ].join("\n");
  function fileGrid() { return 100; } // raw file path default: native px x scale x (scene grid / 100)
  async function effect(o) {
    let x = 0, y = 0;
    const at = o.at && o.at.center ? o.at.center : (o.at || { x: 0, y: 0 });
    x = at.x + ((o.offset && o.offset.x) || 0); y = at.y + ((o.offset && o.offset.y) || 0);
    const params = { file: o.file, x, y, scale: o.scale, mirrorX: !!o.mirrorX, mirrorY: !!o.mirrorY, rotate: o.rotate || 0, fadeIn: o.fadeIn || 0, fadeOut: o.fadeOut || 0, below: !!o.below, opacity: o.opacity, duration: o.duration || 0, rate: o.rate || 1, fileGrid: o.fileGrid || fileGrid(o.file) };
    try { await game.ONI.pseudo.play({ scriptId: 'port.effect', scriptSource: INNER, casterTokenUuid: null, targetTokenUuids: [], params }); } catch (e) { console.warn('[PORT] effect failed', o.file, e); }
  }
  return { sound, effect, wait };
})();
// ============================================================================
// [ONI][Anim][ZeroPower][Hina] A Million Possibility (Foundry VTT v12)
// STABLE BASE + FULL UPDATE PASS (FIXED SYNTAX)
//
// UPDATE in this pass (Intro timing):
// 1) Intro cut-in finishes FIRST.
// 2) After cut-in: start camera pan/zoom AND trigger full-screen blackout MID-pan
// (blackout does NOT wait for camera pan to finish).
//
// Everything else unchanged.
// ============================================================================
(async () => {
const TAG = "[ONI][Anim][ZeroPower][Hina][MillionPossibility]";
const DBG = true;
// -----------------------------
// Assets
// -----------------------------
const CUTIN_URL =
"https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Campaign/The%20Legend%20of%20Dragonslayer/Image/Cut-in/hina_Cut-in002.png";
// NEW (Parallel Future / Zoom portrait cut-in)
const FUTURE_CUTIN_URL =
  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Campaign/The%20Legend%20of%20Dragonslayer/Image/Cut-in/hina_Cut-in003.png";
const OVERDRIVE_SFX =
"https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Overdrive.wav";
const BG_URL =
"https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Campaign/The%20Legend%20of%20Dragonslayer/Image/Map/Game%20Map/Hina_Map001.png";
const POLLEN_SFX =
"https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Pollen.ogg";
const METAL_SHING_SFX =
"https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Metal_Shing.mp3";
const OUTRO_VFX_WEBM =
"modules/JB2A_DnD5e/Library/Generic/Template/Circle/Aura/Aura003/Aura003Part02_Outward_Complete_003_Blue_1000x1000.webm";
const OUTRO_SFX =
"https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Teleport.ogg";
// -----------------------------
// Tuning knobs (keep yours)
// -----------------------------
const T = {
// Intro
dimFadeInMs: 200,
dimAlpha: 0.55,
camPanMs: 1000,
camScale: 2.5,
// NEW: how long after pan starts before blackout begins (mid-zoom)
// (Default: 45% into the pan duration)
blackoutStartDelayMs: Math.floor(1000 * 0.45),
cutinSlideInMs: 650,
cutinHoldMs: 850,
cutinSlideOutMs: 650,
cutinZ: 99990,
// Blackout / reveal BG
blackoutFadeInMs: 650,
blackoutHoldMs: 250,
revealFadeOutMs: 650,
// Parallel Future
futureTotalMs: 4000,
futureSpawnEveryMs: 350,
futureLingerMs: 1500,
futureFadeOutMs: 250,
futureOpacity: 0.5,
// Zoom-out reveal (your tuning)
zoomStartScale: 10,
zoomEndScale: 1.0,
zoomDownMs: 150,
zoomHoldMs: 2500,
// NEW (zoom portrait tuning knobs)
zoomImgScaleMul: 1.0,   // multiplier applied to BOTH start/end zoom scales
zoomOffsetX: 0,         // px, +right / -left
zoomOffsetY: -250,         // px, +down / -up
// NEW: outro cut-in START position offset (px) for the initial (big) scale
zoomStartOffsetX: 1500,      // px, +right / -left
zoomStartOffsetY: -250,   // px, +down / -up
// NEW: scale the overlay BG down alongside the zoom cut-in
overlayBgZoomStartScale: 1.0,
overlayBgZoomEndScale: 0.1,
    // NEW: where the overlay BG shrinks into (px offset from screen center)
    overlayBgShrinkOffsetX: -150,
    overlayBgShrinkOffsetY: 300,
    // NEW: duration for overlay BG shrink-out (ms). If null/0, uses zoomDownMs.
    overlayBgShrinkMs: 400,
// Whiteout (DOM overlay)
whiteFadeInMs: 2500,
whiteFadeOutMs: 850,
whiteDomZ: 99999999,
// Outro VFX
outroHoldBeforeFadeMs: 4000,
outroFadeOutMs: 900,
outroX: 850,
outroY: 500,
outroWidthCss: "140vw",
outroHeightCss: "140vh",
outroVfxScaleMultiplier: 2.5,
// Outro VFX opacity
outroVfxOpacity: 0.3,
};
// -----------------------------
// Caster resolve
// -----------------------------
const parseTokenIdFromUuid = (uuid) => {
if (!uuid || typeof uuid !== "string") return null;
const m = uuid.match(/\.Token\.([A-Za-z0-9]+)$/);
if (m?.[1]) return m[1];
if (uuid.length <= 32 && !uuid.includes(".")) return uuid;
return null;
};
const resolveCasterToken = () => {
const p = globalThis.__PAYLOAD ?? {};
const idA = p?.casterTokenId;
const idB = parseTokenIdFromUuid(p?.casterTokenUuid);
const idC = parseTokenIdFromUuid(p?.attackerUuid);
const idD = parseTokenIdFromUuid(p?.attackerTokenUuid);
const idE = parseTokenIdFromUuid(p?.sourceTokenUuid);
const idF = p?.sourceTokenId;
const pickId = idA || idB || idC || idD || idE || idF || null;
const tok =
(pickId ? canvas.tokens?.get(pickId) : null) ??
canvas.tokens?.controlled?.[0] ??
null;
if (DBG) {
console.log(TAG, "Payload caster resolve", {
casterTokenId: idA,
casterTokenUuid: p?.casterTokenUuid,
attackerUuid: p?.attackerUuid,
attackerTokenUuid: p?.attackerTokenUuid,
sourceTokenUuid: p?.sourceTokenUuid,
pickId,
resolvedName: tok?.name ?? null,
resolvedId: tok?.id ?? null,
});
}
return tok;
};
const getStagePivotSnapshot = () => ({
x: canvas.stage.pivot.x,
y: canvas.stage.pivot.y,
scale: canvas.stage.scale.x,
});
try {
if (!canvas?.ready) {
ui.notifications.warn("Canvas not ready yet.");
return;
}
globalThis.ONI = globalThis.ONI ?? {};
if (!ONI.emit) {
ONI.emit = (eventName, payload = {}, options = {}) => {
const { local = true, world = false } = options;
if (local) Hooks.callAll(eventName, payload);
if (world) game.socket.emit("world", { action: eventName, payload });
};
}
const caster = resolveCasterToken();
if (!caster) {
ui.notifications.warn(
"No caster token found (payload missing AND no token selected)."
);
return;
}
const priorView = getStagePivotSnapshot();
if (DBG) console.log(TAG, "Camera priorView:", priorView);
ONI.emit(
"oni:animationStart",
{
type: "zeroPower.hina.millionPossibility",
sourceTokenId: caster.id,
targetTokenIds: [],
sceneId: canvas.scene?.id ?? null,
timestamp: Date.now(),
},
{ local: true, world: false }
);
// ======================================================================
// PSEUDO MASTER SCRIPT (runs on each client)
// ======================================================================
const pseudoMaster = `
const TAG = "${TAG}[PSEUDO][MASTER]";
const DBG = ${DBG ? "true" : "false"};
if (!canvas?.ready) throw new Error("Canvas not ready (MASTER).");
const wait = (ms) => new Promise(r => setTimeout(r, Math.max(0, ms)));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
function log(...args){ if (DBG) console.log(TAG, ...args); }
function warn(...args){ if (DBG) console.warn(TAG, ...args); }
function easeInOutCubic(t){ return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3)/2; }
function fadeAlphaPIXI(obj, fromA, toA, durMs){
return new Promise(resolve => {
const start = performance.now();
const tick = () => {
const raw = (performance.now() - start) / Math.max(1, durMs);
const t = clamp(raw, 0, 1);
const e = easeInOutCubic(t);
obj.alpha = fromA + (toA - fromA) * e;
if (t >= 1) { canvas.app.ticker.remove(tick); resolve(); }
};
canvas.app.ticker.add(tick);
});
}
function stagePivotToPanXY(pivotX, pivotY) {
const center = canvas.screenDimensions
? { x: canvas.screenDimensions.width / 2, y: canvas.screenDimensions.height / 2 }
: { x: canvas.app.renderer.width / 2, y: canvas.app.renderer.height / 2 };
return { x: pivotX + center.x, y: pivotY + center.y };
}
async function restoreCamera(prior, durationMs){
try{
const xy = stagePivotToPanXY(Number(prior?.x ?? 0), Number(prior?.y ?? 0));
const scale = Number(prior?.scale ?? 1);
await canvas.animatePan({ x: xy.x, y: xy.y, scale, duration: Math.max(0, Number(durationMs ?? 650)) });
canvas.stage.pivot.set(Number(prior?.x ?? 0), Number(prior?.y ?? 0));
canvas.stage.scale.set(scale, scale);
} catch(e){
warn("Camera restore failed", e);
}
}
async function panToToken(token, durationMs, scale){
try{
await canvas.animatePan({ x: token.center.x, y: token.center.y, scale, duration: Math.max(1, durationMs) });
} catch(e){
warn("Camera pan failed", e);
}
}
// ------------------------------------------------------------
// Shared state
// ------------------------------------------------------------
globalThis.__ONI_MILP__ = globalThis.__ONI_MILP__ ?? {};
const S = globalThis.__ONI_MILP__;
S.dom = S.dom ?? [];
S.pixi = S.pixi ?? [];
S.keep = S.keep ?? {};
function domRemove(id){ try{ document.getElementById(id)?.remove(); } catch(_){} }
function domTrack(id){ S.dom.push(id); }
function domCleanupAll(){
const ids = (S.dom ?? []).slice();
S.dom = [];
for (const id of ids) domRemove(id);
}
function createFullScreenDiv({ id, bg = "black", z = 99990, opacity = 0, transition = "opacity 500ms ease" }){
const d = document.createElement("div");
d.id = id;
Object.assign(d.style, {
position: "fixed",
left: "0px",
top: "0px",
width: "100vw",
height: "100vh",
zIndex: String(z),
pointerEvents: "none",
background: bg,
opacity: String(opacity),
transition
});
document.body.appendChild(d);
domTrack(id);
return d;
}
async function fadeDomOpacity(el, fromA, toA, durMs){
el.style.transition = "opacity " + Math.max(1, durMs) + "ms ease-in-out";
el.style.opacity = String(fromA);
void el.offsetHeight;
el.style.opacity = String(toA);
await wait(Math.max(1, durMs) + 30);
}
function createCutin({ url, slideInMs, holdMs, slideOutMs, zIndex }){
const id = "oni-milp-cutin-" + Date.now() + "-" + Math.floor(Math.random()*100000);
const wrap = document.createElement("div");
wrap.id = id;
Object.assign(wrap.style, {
position: "fixed",
left: "0px",
top: "0px",
width: "100vw",
height: "100vh",
zIndex: String(zIndex),
pointerEvents: "none",
overflow: "hidden",
});
const img = document.createElement("img");
img.src = url;
Object.assign(img.style, {
position: "absolute",
left: "-120%",
bottom: "0%",
height: "92vh",
width: "auto",
objectFit: "contain",
border: "none",
outline: "none",
boxShadow: "none",
background: "transparent",
display: "block",
willChange: "left, opacity, transform",
});
wrap.appendChild(img);
document.body.appendChild(wrap);
domTrack(id);
return { id, wrap, img, slideInMs, holdMs, slideOutMs };
}
async function runCutin(cutin){
const { img, slideInMs, holdMs, slideOutMs, wrap, id } = cutin;
img.style.transition = "left " + slideInMs + "ms ease-out";
void img.offsetHeight;
img.style.left = "0%";
await wait(slideInMs);
await wait(holdMs);
img.style.transition = "left " + slideOutMs + "ms ease-in";
img.style.left = "120%";
await wait(slideOutMs + 30);
try{ wrap.remove(); } catch(_){}
log("Cut-in removed", id);
}
function getViewport(){
return {
w: window.innerWidth || canvas.app.renderer.width,
h: window.innerHeight || canvas.app.renderer.height
};
}
function spawnFutureFrame(url, { opacity = 0.5, z = 99970 } = {}){
const id = "oni-milp-future-" + Date.now() + "-" + Math.floor(Math.random()*100000);
const { w, h } = getViewport();
const pad = 60;
const left = randInt(pad, Math.max(pad, w - pad));
const top = randInt(pad, Math.max(pad, h - pad));
const size = randInt(180, 420);
const rot = randInt(-18, 18);
const flipX = Math.random() < 0.5 ? -1 : 1;
const wrap = document.createElement("div");
wrap.id = id;
Object.assign(wrap.style, {
position: "fixed",
left: left + "px",
top: top + "px",
width: size + "px",
height: size + "px",
transform: "translate(-50%, -50%) rotate(" + rot + "deg) scaleX(" + flipX + ")",
transformOrigin: "center center",
zIndex: String(z),
pointerEvents: "none",
opacity: "0",
transition: "opacity 180ms ease-out",
background: "transparent",
willChange: "opacity, transform",
});
const isWebm = (url || "").toLowerCase().endsWith(".webm");
let el;
if (isWebm) {
el = document.createElement("video");
el.src = url;
el.autoplay = true;
el.loop = true;
el.muted = true;
el.playsInline = true;
} else {
el = document.createElement("img");
el.src = url;
}
Object.assign(el.style, {
width: "100%",
height: "100%",
objectFit: "contain",
display: "block",
background: "transparent",
border: "none",
outline: "none",
boxShadow: "none",
});
wrap.appendChild(el);
document.body.appendChild(wrap);
domTrack(id);
void wrap.offsetHeight;
wrap.style.opacity = String(opacity);
return { id, wrap };
}
async function fadeOutAndRemoveFutureFrame(frame, fadeOutMs){
const { wrap, id } = frame;
wrap.style.transition = "opacity " + fadeOutMs + "ms ease-in";
wrap.style.opacity = "0";
await wait(fadeOutMs + 30);
domRemove(id);
}
// PIXI overlay helpers
async function createFullScreenPIXIOverlay({ color = 0x000000, z = 99990 } = {}){
const w = canvas.app.renderer.screen.width;
const h = canvas.app.renderer.screen.height;
const g = new PIXI.Graphics();
g.beginFill(color, 1);
g.drawRect(0, 0, w, h);
g.endFill();
g.x = 0; g.y = 0;
g.alpha = 0;
g.zIndex = Number(z);
canvas.stage.sortableChildren = true;
canvas.stage.addChild(g);
canvas.stage.sortChildren();
S.pixi.push(g);
return g;
}
async function createScreenBGSprite(bgUrl, z){
const tex = await loadTexture(bgUrl);
const w = canvas.app.renderer.screen.width;
const h = canvas.app.renderer.screen.height;
// Put the BG inside a centered container so scaling happens around the screen center
const c = new PIXI.Container();
c.x = w / 2;
c.y = h / 2;
const s = new PIXI.Sprite(tex);
s.anchor.set(0.5);
s.x = 0; s.y = 0;
s.width = w;
s.height = h;
c.addChild(s);
c.alpha = 1;
c.zIndex = Number(z);
canvas.stage.sortableChildren = true;
canvas.stage.addChild(c);
canvas.stage.sortChildren();
S.pixi.push(c);
return c;
}
function scalePIXI(obj, s){
try{ obj.scale.set(Number(s), Number(s)); } catch(_){}
}
function animateScalePIXI(obj, fromS, toS, durMs){
return new Promise(resolve => {
const start = performance.now();
const tick = () => {
const raw = (performance.now() - start) / Math.max(1, durMs);
const t = clamp(raw, 0, 1);
const e = easeInOutCubic(t);
const v = fromS + (toS - fromS) * e;
scalePIXI(obj, v);
if (t >= 1) { canvas.app.ticker.remove(tick); resolve(); }
};
canvas.app.ticker.add(tick);
});
}
function cleanupPIXI(){
const items = (S.pixi ?? []).slice();
S.pixi = [];
for (const it of items){
try{ canvas.stage.removeChild(it); } catch(_){}
try{ it.destroy?.(); } catch(_){}
}
}
async function createDimmer(alphaTarget, fadeInMs){
const g = await createFullScreenPIXIOverlay({ color: 0x000000, z: 50 });
await fadeAlphaPIXI(g, 0, alphaTarget, fadeInMs);
return g;
}
function createZoomReveal(url, z){
const id = "oni-milp-zoom-" + Date.now() + "-" + Math.floor(Math.random()*100000);
const wrap = document.createElement("div");
wrap.id = id;
Object.assign(wrap.style, {
position: "fixed",
left: "50%",
top: "50%",
width: "160vw",
height: "160vh",
transform: "translate(-50%, -50%) scale(1)",
transformOrigin: "center center",
zIndex: String(z),
pointerEvents: "none",
overflow: "hidden",
opacity: "1",
background: "transparent",
willChange: "transform, opacity",
});
const img = document.createElement("img");
img.src = url;
Object.assign(img.style, {
width: "100%",
height: "100%",
objectFit: "contain",
display: "block",
border: "none",
outline: "none",
boxShadow: "none",
background: "transparent",
});
wrap.appendChild(img);
document.body.appendChild(wrap);
domTrack(id);
return { id, wrap };
}
function playOutroVfxHoldThenFade({
webmPath,
x,
y,
widthCss,
heightCss,
scaleMul,
opacity,
holdBeforeFadeMs,
fadeOutMs,
z
}){
const id = "oni-milp-outroVfx-" + Date.now() + "-" + Math.floor(Math.random()*100000);
const wrap = document.createElement("div");
wrap.id = id;
Object.assign(wrap.style, {
position: "fixed",
left: x + "px",
top: y + "px",
width: widthCss,
height: heightCss,
transform: "translate(-50%, -50%) scale(" + Number(scaleMul || 1) + ")",
transformOrigin: "center center",
zIndex: String(z),
pointerEvents: "none",
opacity: String(opacity ?? 1),
transition: "opacity " + fadeOutMs + "ms ease-in",
background: "transparent",
});
const vid = document.createElement("video");
vid.src = webmPath;
vid.autoplay = true;
vid.loop = true;
vid.muted = true;
vid.playsInline = true;
Object.assign(vid.style, {
width: "100%",
height: "100%",
objectFit: "contain",
display: "block",
background: "transparent",
border: "none",
outline: "none",
boxShadow: "none",
});
wrap.appendChild(vid);
document.body.appendChild(wrap);
domTrack(id);
(async () => {
await wait(Math.max(0, holdBeforeFadeMs));
wrap.style.opacity = "0";
await wait(Math.max(0, fadeOutMs) + 40);
domRemove(id);
})();
return id;
}
function playSfx(url, vol=0.9){
try{
if (!url) return;
// PORTED: local playback (this inner already runs on every client)
if (FAudioHelper && FAudioHelper.play) FAudioHelper.play({ src: url, volume: vol, autoplay: true, loop: false }, false);
else { const a = new Audio(url); a.volume = vol; a.play().catch(() => {}); }
}catch(e){ warn("SFX failed", e); }
}
function buildDynamicFuturePool(){
const out = [];
const seen = new Set();
const add = (u) => {
if (!u || typeof u !== "string") return;
const url = u.trim();
if (!url) return;
if (seen.has(url)) return;
seen.add(url);
out.push(url);
};
const tokens = canvas?.tokens?.placeables ?? [];
for (const tok of tokens){
const doc = tok?.document;
if (!doc) continue;
if (doc.hidden) continue;
add(doc.texture?.src);
const a = tok.actor;
add(a?.system?.props?.sprite_standard);
add(a?.system?.props?.sprite_battle);
}
if (!out.length && ctx?.casterToken?.document?.texture?.src) {
add(ctx.casterToken.document.texture.src);
}
log("Dynamic future pool built:", { size: out.length, preview: out.slice(0, 8) });
return out;
}
// ------------------------------------------------------------
// Resolve caster token
// ------------------------------------------------------------
const casterToken = ctx.casterToken;
if (!casterToken) throw new Error("Missing ctx.casterToken");
// ======================================================================
// Intro
// (UPDATED ORDER)
// - Dimmer
// - Overdrive SFX + Cut-in (finish fully)
// - Then: start camera pan/zoom AND trigger blackout MID-pan (no waiting)
// ======================================================================
log("=== Intro START ===");
const dimmer = await createDimmer(Number(ctx.params.dimAlpha), Number(ctx.params.dimFadeInMs));
S.keep.dimmer = dimmer;
// Cut-in FIRST
playSfx(String(ctx.params.overdriveSfx), 0.9);
const cutin = createCutin({
url: String(ctx.params.cutinUrl),
slideInMs: Number(ctx.params.cutinSlideInMs),
holdMs: Number(ctx.params.cutinHoldMs),
slideOutMs: Number(ctx.params.cutinSlideOutMs),
zIndex: Number(ctx.params.cutinZ),
});
await runCutin(cutin);
// Now start pan/zoom (do NOT await)
const panPromise = panToToken(casterToken, Number(ctx.params.camPanMs), Number(ctx.params.camScale))
.catch(e => warn("Pan promise error", e));
// Wait a bit so blackout happens mid-zoom
await wait(Number(ctx.params.blackoutStartDelayMs));
log("=== Intro END ===");
// ======================================================================
// Blackout transition (UPDATED: starts while pan might still be running)
// ======================================================================
log("=== Blackout Transition START ===");
const black = await createFullScreenPIXIOverlay({ color: 0x000000, z: 99990 });
S.keep.black = black;
// Fade to full black NOW (mid-pan)
await fadeAlphaPIXI(black, 0, 1, Number(ctx.params.blackoutFadeInMs));
// Once fully black, we can safely restore camera (this will override remaining pan)
await restoreCamera(ctx.params.priorView, 650);
// Fade out dimmer while black
if (S.keep.dimmer) await fadeAlphaPIXI(S.keep.dimmer, Number(S.keep.dimmer.alpha ?? 0), 0, 220);
await wait(Number(ctx.params.blackoutHoldMs));
// Background under black
const bg = await createScreenBGSprite(String(ctx.params.bgUrl), 100);
S.keep.bg = bg;
// Reveal scene by fading black away
await fadeAlphaPIXI(black, 1, 0, Number(ctx.params.revealFadeOutMs));
// (optional) ensure pan promise won't throw later
await panPromise;
log("=== Blackout Transition END ===");
// ======================================================================
// Parallel Future
// ======================================================================
log("=== Parallel Future START ===");
// pollen at start
playSfx(String(ctx.params.pollenSfx), 0.9);
const totalMs = Number(ctx.params.futureTotalMs);
const spawnEvery = Number(ctx.params.futureSpawnEveryMs);
const lingerMs = Number(ctx.params.futureLingerMs);
const fadeOutMs = Number(ctx.params.futureFadeOutMs);
const opacity = Number(ctx.params.futureOpacity);
const pool = buildDynamicFuturePool();
if (!pool.length) {
warn("Dynamic pool is empty; skipping Parallel Future frames.");
} else {
const tStart = performance.now();
while ((performance.now() - tStart) < totalMs) {
const url = pick(pool);
const f = spawnFutureFrame(url, { opacity, z: 99970 });
(async () => {
await wait(lingerMs);
await fadeOutAndRemoveFutureFrame(f, fadeOutMs);
})();
await wait(spawnEvery);
}
await wait(Math.max(0, lingerMs - spawnEvery));
}
log("=== Parallel Future END ===");
// ======================================================================
// Outro
// ======================================================================
log("=== Outro START ===");
// Zoom portrait
// NEW: "Crystal Orb" reveal — overlay_bg shrinks away to reveal the cut-in image underneath
// 1) Create a solid black background behind everything (so we never reveal the real scene)
const orbBlackId = "oni-milp-orbBlack-" + Date.now() + "-" + Math.floor(Math.random()*100000);
createFullScreenDiv({
  id: orbBlackId,
  bg: "black",
  z: 99982,
  opacity: 1,
  transition: "opacity 0ms linear",
});
S.keep.orbBlackId = orbBlackId;
// 2) Create the cut-in image (scale-in animation returns)
// - Starts BIG and scales down into the current final size/position
// - Runs at the SAME TIME as the overlay_bg shrink reveal
const zoomZ = 99985;
const zoom = createZoomReveal(String(ctx.params.zoomUrl), zoomZ);
S.keep.zoomId = zoom.id;
const offXEnd = Number(ctx.params.zoomOffsetX ?? 0);
const offYEnd = Number(ctx.params.zoomOffsetY ?? 0);
const offXStart = Number(ctx.params.zoomStartOffsetX ?? offXEnd);
const offYStart = Number(ctx.params.zoomStartOffsetY ?? offYEnd);
const mul  = Number(ctx.params.zoomImgScaleMul ?? 1);
const startS = Number(ctx.params.zoomStartScale) * mul;
const endS   = Number(ctx.params.zoomEndScale) * mul;
const trStart = (s) =>
  "translate(calc(-50% + " + offXStart + "px), calc(-50% + " + offYStart + "px)) scale(" + s + ")";
const trEnd = (s) =>
  "translate(calc(-50% + " + offXEnd + "px), calc(-50% + " + offYEnd + "px)) scale(" + s + ")";
// Duration shared with overlay shrink
const shrinkX  = Number(ctx.params.overlayBgShrinkOffsetX ?? 0);
const shrinkY  = Number(ctx.params.overlayBgShrinkOffsetY ?? 0);
const shrinkMs = Number(ctx.params.overlayBgShrinkMs ?? 0) || Number(ctx.params.zoomDownMs);
// Set initial states (no animation), then trigger both animations together
zoom.wrap.style.transition = "none";
zoom.wrap.style.transform = trStart(startS);
// 3) Create overlay_bg ABOVE the cut-in, then shrink it down until it disappears
const overlayZ = 99986;
const overlay = createZoomReveal(String(ctx.params.bgUrl), overlayZ);
S.keep.overlayBgId = overlay.id;
// Overlay starts fullscreen (scale 1 around center)
overlay.wrap.style.transition = "none";
overlay.wrap.style.transform = "translate(-50%, -50%) scale(1)";
overlay.wrap.style.opacity = "1";
// Force layout so transitions apply properly on next write
void overlay.wrap.offsetHeight;
// Trigger BOTH animations at the same time
zoom.wrap.style.transition = "transform " + shrinkMs + "ms ease-in-out";
zoom.wrap.style.transform = trEnd(endS);
overlay.wrap.style.transition =
  "transform " + shrinkMs + "ms ease-in-out, opacity " + Math.max(1, Math.floor(shrinkMs * 0.8)) + "ms ease-in-out";
overlay.wrap.style.transform =
  "translate(calc(-50% + " + shrinkX + "px), calc(-50% + " + shrinkY + "px)) scale(0)";
overlay.wrap.style.opacity = "0";
// Wait for overlay to finish shrinking, then remove it (reveals the cut-in)
await wait(shrinkMs + 40);
domRemove(overlay.id);
// Metal shing right when the reveal happens
playSfx(String(ctx.params.metalShingSfx), 0.95);
await wait(Number(ctx.params.zoomHoldMs));
// WHITEOUT (DOM, absolute top)
const whiteId = "oni-milp-whiteout-" + Date.now() + "-" + Math.floor(Math.random()*100000);
const white = createFullScreenDiv({
id: whiteId,
bg: "white",
z: Number(ctx.params.whiteDomZ),
opacity: 0,
transition: "opacity " + Number(ctx.params.whiteFadeInMs) + "ms ease-in-out",
});
await fadeDomOpacity(white, 0, 1, Number(ctx.params.whiteFadeInMs));
// cleanup under full white
try{
domRemove(S.keep.zoomId);
domCleanupAll();
cleanupPIXI();
} catch(e){
warn("Cleanup during whiteout error", e);
}
// fade out white
white.style.transition = "opacity " + Number(ctx.params.whiteFadeOutMs) + "ms ease-in-out";
white.style.opacity = "0";
await wait(Number(ctx.params.whiteFadeOutMs) + 30);
domRemove(whiteId);
// Outro VFX + sfx
playSfx(String(ctx.params.outroSfx), 0.9);
playOutroVfxHoldThenFade({
webmPath: String(ctx.params.outroVfx),
x: Number(ctx.params.outroX),
y: Number(ctx.params.outroY),
widthCss: String(ctx.params.outroWidthCss),
heightCss: String(ctx.params.outroHeightCss),
scaleMul: Number(ctx.params.outroVfxScaleMultiplier),
opacity: Number(ctx.params.outroVfxOpacity),
holdBeforeFadeMs: Number(ctx.params.outroHoldBeforeFadeMs),
fadeOutMs: Number(ctx.params.outroFadeOutMs),
z: 99980
});
await wait(Number(ctx.params.outroHoldBeforeFadeMs) + Number(ctx.params.outroFadeOutMs) + 120);
log("=== Outro END ===");
log("MASTER DONE");
return true;
`;
await (
game.ONI?.pseudo?.play?.({
scriptId: "oni.hina.millionPossibility.master",
scriptSource: pseudoMaster,
casterTokenUuid: caster.document.uuid,
params: {
// Intro
dimFadeInMs: T.dimFadeInMs,
dimAlpha: T.dimAlpha,
camPanMs: T.camPanMs,
camScale: T.camScale,
// NEW
blackoutStartDelayMs: T.blackoutStartDelayMs,
cutinUrl: CUTIN_URL,
overdriveSfx: OVERDRIVE_SFX,
cutinSlideInMs: T.cutinSlideInMs,
cutinHoldMs: T.cutinHoldMs,
cutinSlideOutMs: T.cutinSlideOutMs,
cutinZ: T.cutinZ,
// Blackout / BG
blackoutFadeInMs: T.blackoutFadeInMs,
blackoutHoldMs: T.blackoutHoldMs,
revealFadeOutMs: T.revealFadeOutMs,
bgUrl: BG_URL,
// Camera snapshot
priorView,
// Parallel Future
futureTotalMs: T.futureTotalMs,
futureSpawnEveryMs: T.futureSpawnEveryMs,
futureLingerMs: T.futureLingerMs,
futureFadeOutMs: T.futureFadeOutMs,
futureOpacity: T.futureOpacity,
pollenSfx: POLLEN_SFX,
// Zoom-out
zoomUrl: FUTURE_CUTIN_URL,
zoomStartScale: T.zoomStartScale,
zoomEndScale: T.zoomEndScale,
zoomDownMs: T.zoomDownMs,
zoomHoldMs: T.zoomHoldMs,
zoomImgScaleMul: T.zoomImgScaleMul,
zoomOffsetX: T.zoomOffsetX,
zoomOffsetY: T.zoomOffsetY,
          // NEW: outro cut-in START position offset
          zoomStartOffsetX: T.zoomStartOffsetX,
          zoomStartOffsetY: T.zoomStartOffsetY,
// NEW: overlay BG scale sync with zoom cut-in
overlayBgZoomStartScale: T.overlayBgZoomStartScale,
overlayBgZoomEndScale: T.overlayBgZoomEndScale,
          // NEW: overlay BG shrink-to-point reveal
          overlayBgShrinkOffsetX: T.overlayBgShrinkOffsetX,
          overlayBgShrinkOffsetY: T.overlayBgShrinkOffsetY,
          overlayBgShrinkMs: T.overlayBgShrinkMs,
metalShingSfx: METAL_SHING_SFX,
// Whiteout
whiteFadeInMs: T.whiteFadeInMs,
whiteFadeOutMs: T.whiteFadeOutMs,
whiteDomZ: T.whiteDomZ,
// Outro
outroVfx: OUTRO_VFX_WEBM,
outroSfx: OUTRO_SFX,
outroX: T.outroX,
outroY: T.outroY,
outroWidthCss: T.outroWidthCss,
outroHeightCss: T.outroHeightCss,
outroVfxScaleMultiplier: T.outroVfxScaleMultiplier,
outroVfxOpacity: T.outroVfxOpacity,
outroHoldBeforeFadeMs: T.outroHoldBeforeFadeMs,
outroFadeOutMs: T.outroFadeOutMs,
},
meta: { source: "HinaMillionPossibility" },
}) ?? Promise.resolve()
);
ONI.emit(
"oni:animationEnd",
{
type: "zeroPower.hina.millionPossibility",
sourceTokenId: caster.id,
targetTokenIds: [],
sceneId: canvas.scene?.id ?? null,
timestamp: Date.now(),
},
{ local: true, world: false }
);
if (DBG) console.log(TAG, "END (success)");
} catch (err) {
console.error(TAG, "Animation crashed:", err);
try {
globalThis.ONI?.emit?.(
"oni:animationEnd",
{ type: "zeroPower.hina.millionPossibility", error: true, timestamp: Date.now() },
{ local: true, world: false }
);
} catch (_) {}
ui.notifications.error("Hina: A Million Possibility animation crashed. Check console for details.");
}
})();
