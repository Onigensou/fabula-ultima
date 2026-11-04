// ============================================================================
// [ONI][Anim][ZeroPower][Zarg] Meteor Shower
// Foundry VTT v12
//
// Core rule (per request):
// - PSEUDO Animation method for EVERYTHING visual (dimmer, cut-in, blackout, BG, clones, VFX, whiteout)
// - Sequencer is used ONLY for SFX
//
// Sections:
// - Intro
// - Sky BG (overlay bg)
// - Meteor Shower (back to the battlefield, volley vfx falls down)
//
// Updates (this version):
// - FIX: Screen dimmer now truly sits BELOW tokens by inserting it BEFORE TokenLayer in the parent container
// ============================================================================
(async () => {
const TAG = "[ONI][Anim][ZeroPower][Zarg][MeteorShower]";
const DBG = true;
// -----------------------------
// Assets
// -----------------------------
const CUTIN_URL =
"https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Campaign/The%20Legend%20of%20Dragonslayer/Image/Cut-in/Zarg_Cut-in002.png";
const SKY_BG_URL =
"https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Campaign/The%20Legend%20of%20Dragonslayer/Image/Map/Game%20Map/Zarg_Map001.png";
const CAST_VFX =
"modules/JB2A_DnD5e/Library/Generic/Cast/CastFire01_01_Regular_Orange_600x600.webm";
const ARROW_VFX =
"modules/JB2A_DnD5e/Library/Generic/Template/Line/Generic/Piercing_Generic01_01_Regular_Orange_1000x400.webm";
const EVOCATION_VFX =
"modules/JB2A_DnD5e/Library/Generic/Magic_Signs/EvocationCircleComplete_02_Regular_Red_800x800.webm";
const VOLLEY_VFX =
"modules/JB2A_DnD5e/Library/Generic/Template/Cone/Projectile/PF2e/VolleyProjectileArrow001_001_01_ConePF2e_OrangeYellow_30ft_800x1000.webm";
const EXPLOSION_VFX =
"modules/boss-loot-assets-free/artwork/05-spell/level3/fireaball/Fireball_1_CARTOON_EXPLOSION_ORANGE_1200x1200.webm";
// SFX (Sequencer only)
const OVERDRIVE_SFX =
"https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Overdrive.wav";
const GUN_SFX =
"https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Gun_Magnum.ogg";
const BLIND_SFX =
"https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Blind.ogg";
const METEOR_SFX =
"https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/FireSword.mp3";
const EXPLOSION_SFX =
"https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Amalthea_Explosion.ogg";
// -----------------------------
// Tuning knobs (USE YOUR CURRENT TUNING)
// -----------------------------
const T = {
dbg: true,
// Intro
dimFadeInMs: 200,
dimAlpha: 0.6,
cutinSlideInMs: 650,
cutinHoldMs: 850,
cutinSlideOutMs: 650,
cutinZ: 99990,
dimFadeOutAfterCutinMs: 250,
// Caster step forward
stepDx: -120,
stepMoveMs: 300,
// Cast
castVfxMs: 900,
castVfxScale: 1.25,
// Arrow
arrowDelayIntoCastMs: 200,
arrowVfxMs: 500,
arrowScale: 5.0,
arrowRotateDeg: 210,
// Sky transition
blackFadeInMs: 550,
skyRevealMs: 6000,
skyBlackMoveDownPx: 180,
// Evocation
evocationScale: 1.5,
evocationHoldMs: 2500,
evocationFadeOutMs: 350,
// Return transition
black2FadeInMs: 500,
black2MoveUpMs: 420,
// Return to battlefield
returnBlackFadeOutMs: 220,
// Meteor Shower
dim2FadeInMs: 180,
dim2Alpha: 0.6,
volleyScreenX: 603,
volleyScreenY: -29,
volleyScale: 4.0,
volleyRotateDeg: -45,
volleyFlipX: true,
volleyZ: 99995,
meteorHoldMs: 3000,
volleyBurstCount: 3,
volleyBurstIntervalMs: 500,
volleyLifeMs: 1200,
volleyRotSwingMin: 5,
volleyRotSwingMax: 10,
explosionScreenX: 674,
explosionScreenY: 358,
explosionScale: 2.0,
explosionLifeMs: 1800,
// Whiteout end
whiteFadeInMs: 1200,
whiteFadeOutMs: 650,
whiteZ: 999999,
// Layering
// (zDimmer no longer relies on zIndex for layering; we insert before TokenLayer)
zDimmer: 0,
zBlack: 99990,
zBg: 100,
};
// -----------------------------
// Helpers
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
const safeGetDisp = (t) => {
const d =
t?.document?.disposition ??
t?.document?.dispotion ??
t?.actor?.document?.disposition ??
null;
return d === -1 ? -1 : 1;
};
const isNonHiddenEnemy = (t) => safeGetDisp(t) === -1 && !t?.document?.hidden;
// -----------------------------
// MAIN
// -----------------------------
try {
if (!game.modules.get("sequencer")?.active) {
ui.notifications.error("Sequencer module is not active (needed for SFX).");
return;
}
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
ui.notifications.warn("No caster token found (payload missing AND no token selected).");
return;
}
const enemies = (canvas.tokens?.placeables ?? []).filter(isNonHiddenEnemy);
ONI.emit(
"oni:animationStart",
{
type: "zeroPower.zarg.meteorShower",
sourceTokenId: caster.id,
targetTokenIds: enemies.map((t) => t.id),
sceneId: canvas.scene?.id ?? null,
timestamp: Date.now(),
},
{ local: true, world: false }
);
// ------------------------------------------------------------
// SFX schedule (Sequencer only)
// ------------------------------------------------------------
const tIntro =
T.dimFadeInMs + T.cutinSlideInMs + T.cutinHoldMs + T.cutinSlideOutMs + T.dimFadeOutAfterCutinMs;
const tStep = T.stepMoveMs;
const tCastStart = tIntro + tStep;
const tBlack1 = tCastStart + T.castVfxMs;
const tEvocation = tBlack1 + T.blackFadeInMs + T.skyRevealMs;
const tBlack2 = tEvocation + T.evocationHoldMs + T.evocationFadeOutMs;
const tReturn = tBlack2 + Math.max(T.black2FadeInMs, T.black2MoveUpMs) + T.returnBlackFadeOutMs;
const tMeteor = tReturn + T.dim2FadeInMs;
const tExplosionInMeteor =
(T.volleyBurstIntervalMs * (T.volleyBurstCount - 1)) + T.volleyLifeMs;
const tExplosion = tMeteor + tExplosionInMeteor;
const sfx = new Sequence();
sfx.sound().file(OVERDRIVE_SFX).delay(0).volume(0.9);
sfx.sound().file(GUN_SFX).delay(Math.max(0, tCastStart)).volume(0.95);
sfx.sound().file(BLIND_SFX).delay(Math.max(0, tEvocation)).volume(0.95);
sfx.sound().file(METEOR_SFX).delay(Math.max(0, tMeteor)).volume(0.95);
sfx.sound().file(EXPLOSION_SFX).delay(Math.max(0, tExplosion)).volume(0.98);
sfx.play();
// ------------------------------------------------------------
// PSEUDO MASTER (ALL visuals)
// ------------------------------------------------------------
const pseudoMaster = `
const TAG = "${TAG}[PSEUDO][MASTER]";
const DBG = ${DBG ? "true" : "false"};
if (!canvas?.ready) throw new Error("Canvas not ready (MASTER).");
const wait = (ms) => new Promise(r => setTimeout(r, Math.max(0, ms)));
const clamp = (v,a,b) => Math.max(a, Math.min(b, v));
function log(...args){ if (DBG) console.log(TAG, ...args); }
function easeInOutCubic(t){
return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3)/2;
}
function animateNumber(setter, from, to, durMs){
return new Promise(resolve => {
const start = performance.now();
const tick = () => {
const raw = (performance.now() - start) / Math.max(1, durMs);
const t = clamp(raw, 0, 1);
const e = easeInOutCubic(t);
setter(from + (to - from) * e);
if (t >= 1) { canvas.app.ticker.remove(tick); resolve(); }
};
canvas.app.ticker.add(tick);
});
}
function animateXY(obj, from, to, durMs){
return new Promise(resolve => {
const start = performance.now();
const tick = () => {
const raw = (performance.now() - start) / Math.max(1, durMs);
const t = clamp(raw, 0, 1);
const e = easeInOutCubic(t);
obj.x = from.x + (to.x - from.x) * e;
obj.y = from.y + (to.y - from.y) * e;
if (t >= 1) { canvas.app.ticker.remove(tick); resolve(); }
};
canvas.app.ticker.add(tick);
});
}
function ensureSortable(container){
if (!container) return;
container.sortableChildren = true;
try { container.sortChildren(); } catch(_){}
}
// ------------------------------------------------------------
// IMPORTANT FIX (Ruinous Breath style): insert dimmer BEFORE TokenLayer
// ------------------------------------------------------------
function insertBelowTokens(displayObject){
const tokenLayer = canvas.tokens; // TokenLayer
const parent = tokenLayer?.parent ?? canvas.stage;
ensureSortable(parent);
if (parent?.addChildAt && tokenLayer && parent.getChildIndex) {
const idx = parent.getChildIndex(tokenLayer);
parent.addChildAt(displayObject, Math.max(0, idx));
} else {
// Fallback
parent.addChild(displayObject);
}
try { parent.sortChildren(); } catch(_){}
}
globalThis.__ONI_ZARG_ZP__ = globalThis.__ONI_ZARG_ZP__ ?? {};
const S = globalThis.__ONI_ZARG_ZP__;
S.pixi = S.pixi ?? [];
S.dom = S.dom ?? [];
function trackPixi(obj){ S.pixi.push(obj); return obj; }
function trackDom(id){ S.dom.push(id); return id; }
function removeDom(id){ try{ document.getElementById(id)?.remove(); } catch(_){ } }
function cleanupAll(){
const domIds = (S.dom ?? []).slice();
S.dom = [];
for (const id of domIds) removeDom(id);
const pix = (S.pixi ?? []).slice();
S.pixi = [];
for (const it of pix){
try{ it.parent?.removeChild(it); } catch(_){}
try{ it.destroy?.(); } catch(_){}
}
}
async function createFullScreenOverlay(colorHex, zIndex, { belowTokens=false } = {}){
const w = canvas.app.renderer.screen.width;
const h = canvas.app.renderer.screen.height;
const g = new PIXI.Graphics();
g.beginFill(colorHex, 1);
g.drawRect(0, 0, w, h);
g.endFill();
g.x = 0; g.y = 0;
g.alpha = 0;
g.zIndex = Number(zIndex);
if (belowTokens) insertBelowTokens(g);
else {
ensureSortable(canvas.stage);
canvas.stage.addChild(g);
try { canvas.stage.sortChildren(); } catch(_){}
}
trackPixi(g);
return g;
}
async function createFullScreenBGSprite(url, zIndex){
const tex = await loadTexture(url);
const s = new PIXI.Sprite(tex);
s.anchor.set(0);
s.x = 0; s.y = 0;
s.width = canvas.app.renderer.screen.width;
s.height = canvas.app.renderer.screen.height;
s.alpha = 1;
s.zIndex = Number(zIndex);
ensureSortable(canvas.stage);
canvas.stage.addChild(s);
canvas.stage.sortChildren();
trackPixi(s);
return s;
}
async function fadePixiAlpha(obj, fromA, toA, durMs){
obj.alpha = fromA;
await animateNumber((v) => obj.alpha = v, fromA, toA, durMs);
}
function createCutinDOM({ url, slideInMs, holdMs, slideOutMs, zIndex }){
const id = "oni-zarg-cutin-" + Date.now() + "-" + Math.floor(Math.random()*100000);
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
trackDom(id);
return { id, wrap, img, slideInMs, holdMs, slideOutMs };
}
async function runCutinDOM(c){
const { img, slideInMs, holdMs, slideOutMs, wrap } = c;
img.style.transition = "left " + slideInMs + "ms ease-out";
void img.offsetHeight;
img.style.left = "0%";
await wait(slideInMs);
await wait(holdMs);
img.style.transition = "left " + slideOutMs + "ms ease-in";
img.style.left = "120%";
await wait(slideOutMs + 30);
try{ wrap.remove(); }catch(_){}
}
function sceneToScreenXY(sceneX, sceneY){
const pt = canvas.stage.toGlobal(new PIXI.Point(sceneX, sceneY));
const rect = canvas.app.view.getBoundingClientRect();
return { x: rect.left + pt.x, y: rect.top + pt.y };
}
function spawnMediaDOMAtScreenXY({ url, screenX, screenY, w=220, h=220, zIndex=99990, opacity=1, rotateDeg=0, flipX=false }){
const id = "oni-zarg-media-" + Date.now() + "-" + Math.floor(Math.random()*100000);
const wrap = document.createElement("div");
wrap.id = id;
Object.assign(wrap.style, {
position: "fixed",
left: (screenX - w/2) + "px",
top: (screenY - h/2) + "px",
width: w + "px",
height: h + "px",
zIndex: String(zIndex),
pointerEvents: "none",
opacity: String(opacity),
border: "none",
outline: "none",
boxShadow: "none",
background: "transparent",
willChange: "left, top, opacity, transform",
transformOrigin: "center center",
});
const lower = String(url || "").toLowerCase();
const isWebm = lower.endsWith(".webm");
let el;
if (isWebm){
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
border: "none",
outline: "none",
boxShadow: "none",
background: "transparent",
});
wrap.appendChild(el);
document.body.appendChild(wrap);
trackDom(id);
const sx = flipX ? -1 : 1;
wrap.style.transform = "rotate(" + Number(rotateDeg || 0) + "deg) scaleX(" + sx + ")";
return { id, wrap, el, w, h };
}
async function fadeDomOpacity(domObj, fromA, toA, durMs){
const { wrap } = domObj;
wrap.style.opacity = String(fromA);
await new Promise(resolve => {
const start = performance.now();
const tick = () => {
const raw = (performance.now() - start) / Math.max(1, durMs);
const t = clamp(raw, 0, 1);
const e = easeInOutCubic(t);
wrap.style.opacity = String(fromA + (toA - fromA) * e);
if (t >= 1) { canvas.app.ticker.remove(tick); resolve(); }
};
canvas.app.ticker.add(tick);
});
}
async function createTokenCloneSprite(tokenPlaceable, xy, zIndex, scaleMul=1){
const src = tokenPlaceable?.document?.texture?.src;
if (!src) return null;
const texture = await loadTexture(src);
const spr = new PIXI.Sprite(texture);
spr.anchor.set(0.5);
spr.x = xy.x;
spr.y = xy.y;
spr.zIndex = Number(zIndex);
const mesh = tokenPlaceable.mesh ?? tokenPlaceable.icon ?? null;
if (mesh?.width && mesh?.height){
spr.width = mesh.width * scaleMul;
spr.height = mesh.height * scaleMul;
} else {
const grid = canvas.grid?.size ?? 100;
const w = (tokenPlaceable.document.width ?? 1) * grid * scaleMul;
const h = (tokenPlaceable.document.height ?? 1) * grid * scaleMul;
spr.width = w;
spr.height = h;
}
ensureSortable(canvas.stage);
canvas.stage.addChild(spr);
canvas.stage.sortChildren();
trackPixi(spr);
return spr;
}
async function playSceneAnchoredVfxOnSpriteCenter({ url, sprite, sizePx, ms, zIndex, rotateDeg=0, flipX=false }){
const screen = sceneToScreenXY(sprite.x, sprite.y);
const dom = spawnMediaDOMAtScreenXY({
url,
screenX: screen.x,
screenY: screen.y,
w: sizePx,
h: sizePx,
zIndex,
opacity: 1,
rotateDeg,
flipX
});
await wait(ms);
removeDom(dom.id);
}
async function playArrowVfxFromSprite({ url, sprite, lengthPx, thicknessPx, ms, zIndex, rotateDeg }){
const screen = sceneToScreenXY(sprite.x, sprite.y);
const dom = spawnMediaDOMAtScreenXY({
url,
screenX: screen.x + Math.round(lengthPx * 0.18),
screenY: screen.y - Math.round(thicknessPx * 0.18),
w: lengthPx,
h: thicknessPx,
zIndex,
opacity: 1,
rotateDeg,
flipX: false
});
await wait(ms);
removeDom(dom.id);
}
function randInt(min, max){
const a = Math.ceil(min);
const b = Math.floor(max);
return Math.floor(Math.random() * (b - a + 1)) + a;
}
function randSign(){
return Math.random() < 0.5 ? -1 : 1;
}
// ------------------------------------------------------------
// Resolve caster token
// ------------------------------------------------------------
const casterToken = ctx.casterToken;
if (!casterToken) throw new Error("Missing ctx.casterToken");
const home = { x: casterToken.center.x, y: casterToken.center.y };
// ======================================================================
// Intro
// ======================================================================
log("=== Intro START ===");
// Dimmer BELOW tokens (THIS is the key)
const dimmer = await createFullScreenOverlay(0x000000, Number(ctx.params.zDimmer), { belowTokens: true });
await fadePixiAlpha(dimmer, 0, Number(ctx.params.dimAlpha), Number(ctx.params.dimFadeInMs));
const cutin = createCutinDOM({
url: String(ctx.params.cutinUrl),
slideInMs: Number(ctx.params.cutinSlideInMs),
holdMs: Number(ctx.params.cutinHoldMs),
slideOutMs: Number(ctx.params.cutinSlideOutMs),
zIndex: Number(ctx.params.cutinZ),
});
await runCutinDOM(cutin);
await fadePixiAlpha(dimmer, Number(dimmer.alpha ?? 0), 0, Number(ctx.params.dimFadeOutAfterCutinMs));
log("=== Intro END ===");
// ======================================================================
// Caster action
// ======================================================================
log("Caster action: clone + step forward + cast");
const baseMesh = casterToken.mesh ?? casterToken.icon ?? null;
const originalMeshVisible = baseMesh?.visible ?? true;
const originalTokVisible = casterToken.visible;
let casterClone = null;
try {
casterClone = await createTokenCloneSprite(casterToken, { x: home.x, y: home.y }, 5000, 1.0);
if (baseMesh) baseMesh.visible = false;
casterToken.visible = false;
const out = { x: home.x + Number(ctx.params.stepDx), y: home.y };
await animateXY(casterClone, { x: casterClone.x, y: casterClone.y }, out, Number(ctx.params.stepMoveMs));
const castSize = Math.round(380 * Number(ctx.params.castVfxScale));
const castPromise = playSceneAnchoredVfxOnSpriteCenter({
url: String(ctx.params.castVfx),
sprite: casterClone,
sizePx: castSize,
ms: Number(ctx.params.castVfxMs),
zIndex: 99992,
rotateDeg: 0,
flipX: false
});
await wait(Number(ctx.params.arrowDelayIntoCastMs));
const arrowLen = Math.round(740 * Number(ctx.params.arrowScale));
const arrowThk = Math.round(220 * Number(ctx.params.arrowScale));
await playArrowVfxFromSprite({
url: String(ctx.params.arrowVfx),
sprite: casterClone,
lengthPx: arrowLen,
thicknessPx: arrowThk,
ms: Number(ctx.params.arrowVfxMs),
zIndex: 99993,
rotateDeg: Number(ctx.params.arrowRotateDeg)
});
await castPromise;
} finally {
try {
if (casterClone) { canvas.stage.removeChild(casterClone); casterClone.destroy?.(); }
} catch(_){}
try {
if (baseMesh) baseMesh.visible = originalMeshVisible;
casterToken.visible = originalTokVisible;
} catch(_){}
}
// ======================================================================
// Sky BG (overlay bg)
// ======================================================================
log("=== Sky BG START ===");
const black = await createFullScreenOverlay(0x000000, Number(ctx.params.zBlack));
await fadePixiAlpha(black, 0, 1, Number(ctx.params.blackFadeInMs));
const bg = await createFullScreenBGSprite(String(ctx.params.skyBgUrl), Number(ctx.params.zBg));
const startY = 0;
const endY = Number(ctx.params.skyBlackMoveDownPx);
black.y = startY;
const revealMs = Number(ctx.params.skyRevealMs);
await Promise.all([
animateNumber((v) => black.alpha = v, 1, 0, revealMs),
animateNumber((v) => black.y = v, startY, endY, revealMs)
]);
log("Sky reveal complete");
const evoSize = Math.round(820 * Number(ctx.params.evocationScale));
const evoDom = spawnMediaDOMAtScreenXY({
url: String(ctx.params.evocationVfx),
screenX: window.innerWidth / 2,
screenY: window.innerHeight / 2,
w: evoSize,
h: evoSize,
zIndex: 99994,
opacity: 1,
rotateDeg: 0,
flipX: false
});
await wait(Number(ctx.params.evocationHoldMs));
await fadeDomOpacity(evoDom, 1, 0, Number(ctx.params.evocationFadeOutMs));
removeDom(evoDom.id);
log("=== Sky BG END ===");
// ======================================================================
// Transition back
// ======================================================================
log("Return transition: blackout from south");
const black2 = await createFullScreenOverlay(0x000000, Number(ctx.params.zBlack));
black2.alpha = 0;
black2.y = canvas.app.renderer.screen.height;
await Promise.all([
animateNumber((v) => black2.alpha = v, 0, 1, Number(ctx.params.black2FadeInMs)),
animateNumber((v) => black2.y = v, canvas.app.renderer.screen.height, 0, Number(ctx.params.black2MoveUpMs))
]);
try { canvas.stage.removeChild(bg); bg.destroy?.(); } catch(_){}
try { canvas.stage.removeChild(black); black.destroy?.(); } catch(_){}
await fadePixiAlpha(black2, 1, 0, Number(ctx.params.returnBlackFadeOutMs));
try { canvas.stage.removeChild(black2); black2.destroy?.(); } catch(_){}
log("Back to battlefield");
// ======================================================================
// Meteor Shower
// ======================================================================
log("=== Meteor Shower START ===");
// Dimmer BELOW tokens (same fix)
const dimmer2 = await createFullScreenOverlay(0x000000, Number(ctx.params.zDimmer), { belowTokens: true });
await fadePixiAlpha(dimmer2, 0, Number(ctx.params.dim2Alpha), Number(ctx.params.dim2FadeInMs));
const volleyW = Math.round(800 * Number(ctx.params.volleyScale));
const volleyH = Math.round(1000 * Number(ctx.params.volleyScale));
const burstCount = Number(ctx.params.volleyBurstCount);
const burstInterval = Number(ctx.params.volleyBurstIntervalMs);
const volleyLife = Number(ctx.params.volleyLifeMs);
const swingMin = Number(ctx.params.volleyRotSwingMin);
const swingMax = Number(ctx.params.volleyRotSwingMax);
const volleyBaseRot = Number(ctx.params.volleyRotateDeg);
for (let i = 0; i < burstCount; i++){
const swing = randInt(swingMin, swingMax) * randSign();
const rot = volleyBaseRot + swing;
log("Meteor volley spawn", { i, rot, swing });
const v = spawnMediaDOMAtScreenXY({
url: String(ctx.params.volleyVfx),
screenX: Number(ctx.params.volleyScreenX),
screenY: Number(ctx.params.volleyScreenY),
w: volleyW,
h: volleyH,
zIndex: Number(ctx.params.volleyZ),
opacity: 1,
rotateDeg: rot,
flipX: Boolean(ctx.params.volleyFlipX)
});
(async () => {
await wait(volleyLife);
removeDom(v.id);
})();
if (i < burstCount - 1) await wait(burstInterval);
}
// after burst, explosion
const totalBurstMs = (burstInterval * (burstCount - 1)) + volleyLife;
await wait(volleyLife);
log("Meteor explosion play");
const expSize = Math.round(1200 * Number(ctx.params.explosionScale));
const exp = spawnMediaDOMAtScreenXY({
url: String(ctx.params.explosionVfx),
screenX: Number(ctx.params.explosionScreenX),
screenY: Number(ctx.params.explosionScreenY),
w: expSize,
h: expSize,
zIndex: Number(ctx.params.volleyZ) + 1,
opacity: 1,
rotateDeg: 0,
flipX: false
});
await wait(Number(ctx.params.explosionLifeMs));
removeDom(exp.id);
// keep total meteor timing unchanged
const holdTotal = Number(ctx.params.meteorHoldMs);
const used = totalBurstMs + Number(ctx.params.explosionLifeMs);
const remain = holdTotal - used;
if (remain > 0) await wait(remain);
log("=== Meteor Shower END ===");
// ======================================================================
// Whiteout end
// ======================================================================
log("Whiteout end transition");
const white = await createFullScreenOverlay(0xFFFFFF, Number(ctx.params.whiteZ));
await fadePixiAlpha(white, 0, 1, Number(ctx.params.whiteFadeInMs));
try { dimmer2.parent?.removeChild(dimmer2); dimmer2.destroy?.(); } catch(_){}
await fadePixiAlpha(white, 1, 0, Number(ctx.params.whiteFadeOutMs));
try { white.parent?.removeChild(white); white.destroy?.(); } catch(_){}
cleanupAll();
log("MASTER DONE");
return true;
`;
await (game.ONI?.pseudo?.play?.({
scriptId: "oni.zarg.zeroPower.meteorShower.master",
scriptSource: pseudoMaster,
casterTokenUuid: caster.document.uuid,
params: {
// Intro
dimFadeInMs: T.dimFadeInMs,
dimAlpha: T.dimAlpha,
cutinUrl: CUTIN_URL,
cutinSlideInMs: T.cutinSlideInMs,
cutinHoldMs: T.cutinHoldMs,
cutinSlideOutMs: T.cutinSlideOutMs,
cutinZ: T.cutinZ,
dimFadeOutAfterCutinMs: T.dimFadeOutAfterCutinMs,
// Caster action
stepDx: T.stepDx,
stepMoveMs: T.stepMoveMs,
castVfx: CAST_VFX,
castVfxMs: T.castVfxMs,
castVfxScale: T.castVfxScale,
arrowVfx: ARROW_VFX,
arrowDelayIntoCastMs: T.arrowDelayIntoCastMs,
arrowVfxMs: T.arrowVfxMs,
arrowScale: T.arrowScale,
arrowRotateDeg: T.arrowRotateDeg,
// Sky BG
skyBgUrl: SKY_BG_URL,
blackFadeInMs: T.blackFadeInMs,
skyRevealMs: T.skyRevealMs,
skyBlackMoveDownPx: T.skyBlackMoveDownPx,
evocationVfx: EVOCATION_VFX,
evocationScale: T.evocationScale,
evocationHoldMs: T.evocationHoldMs,
evocationFadeOutMs: T.evocationFadeOutMs,
// Return transition
black2FadeInMs: T.black2FadeInMs,
black2MoveUpMs: T.black2MoveUpMs,
returnBlackFadeOutMs: T.returnBlackFadeOutMs,
// Meteor Shower
dim2FadeInMs: T.dim2FadeInMs,
dim2Alpha: T.dim2Alpha,
volleyVfx: VOLLEY_VFX,
volleyScreenX: T.volleyScreenX,
volleyScreenY: T.volleyScreenY,
volleyScale: T.volleyScale,
volleyRotateDeg: T.volleyRotateDeg,
volleyFlipX: T.volleyFlipX,
volleyZ: T.volleyZ,
meteorHoldMs: T.meteorHoldMs,
volleyBurstCount: T.volleyBurstCount,
volleyBurstIntervalMs: T.volleyBurstIntervalMs,
volleyLifeMs: T.volleyLifeMs,
volleyRotSwingMin: T.volleyRotSwingMin,
volleyRotSwingMax: T.volleyRotSwingMax,
explosionVfx: EXPLOSION_VFX,
explosionScreenX: T.explosionScreenX,
explosionScreenY: T.explosionScreenY,
explosionScale: T.explosionScale,
explosionLifeMs: T.explosionLifeMs,
// Whiteout
whiteFadeInMs: T.whiteFadeInMs,
whiteFadeOutMs: T.whiteFadeOutMs,
whiteZ: T.whiteZ,
// Layers
zDimmer: T.zDimmer,
zBlack: T.zBlack,
zBg: T.zBg,
},
meta: { source: "ZargMeteorShower" },
}) ?? Promise.resolve());
ONI.emit(
"oni:animationEnd",
{
type: "zeroPower.zarg.meteorShower",
sourceTokenId: caster.id,
targetTokenIds: enemies.map((t) => t.id),
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
{ type: "zeroPower.zarg.meteorShower", error: true, timestamp: Date.now() },
{ local: true, world: false }
);
} catch (_) {}
ui.notifications.error("Zarg Zero Power animation crashed. Check console for details.");
}
})();
