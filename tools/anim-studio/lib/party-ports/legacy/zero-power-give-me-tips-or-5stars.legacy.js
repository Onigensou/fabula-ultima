// ============================================================================
// [ONI][Anim][ZeroPower][Blanche] Give me review or 5star
// Foundry VTT v12 — Sequencer + ONI Pseudo Animation
//
// UPDATE v5 (requested adjustments):
// - Cafe SFX: play Eating.mp3 during Cafe Sequence (Sequencer, inside pseudo for multi-client)
// - Blackout: reset camera to original position during blackout + extend blackout by +1000ms
// - Whiteout SFX: play Item2.ogg at the end during whiteout (Sequencer, inside pseudo)
//
// Notes:
// - Requires Sequencer module.
// - Requires your ONI Pseudo Animation system: game.ONI.pseudo.play(...)
// - All spawned visuals are cleaned up during the full-white screen.
// ============================================================================
(async () => {
const TAG = "[ONI][Anim][ZeroPower][Blanche][5star]";
const DBG = true;
// -----------------------------
// Assets
// -----------------------------
const CUTIN_URL =
"https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Campaign/The%20Legend%20of%20Dragonslayer/Image/Cut-in/Blanche_Cut-in002.png";
const OVERDRIVE_SFX =
"https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Overdrive.wav";
const BG_URL =
"https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Campaign/The%20Legend%20of%20Dragonslayer/Image/Map/Game%20Map/Blanche_Map001.png";
const CAFE_EATING_SFX =
"https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Eating.mp3";
const WHITEOUT_END_SFX =
"https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Item2.ogg";
const GIF_POOL = [
"https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Emotes%20Icon/RO/GIF/Lov.gif",
"https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Emotes%20Icon/RO/GIF/Heh.gif",
"https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Emotes%20Icon/RO/GIF/Ok.gif",
];
// -----------------------------
// Timeline tuning knobs
// -----------------------------
const T = {
// Screen dim (Pseudo)
dimFadeInMs: 200,
dimAlpha: 0.6,
// Camera
camPanMs: 700,
camScale: 1.2,
// Cut-in (Pseudo DOM)
cutinSlideInMs: 650,
cutinHoldMs: 850,
cutinSlideOutMs: 650,
cutinZ: 99990,
// Black overlay before cafe (DOM)
blackFadeInMs: 500,
blackAlpha: 1.0,
// NEW: extra blackout hold (requested +1s)
blackExtraHoldMs: 0,
// BG fade in (sprite)
bgFadeInSec: 0.6,
// Reveal fades (fade black + dim away)
revealFadeOutMs: 450,
// Movement
runMoveMs: 650,
runHoldMs: 250,
// Cafe sequence loops
cafeLoops: 2,
// GIF behavior
gifScaleToAlly: 0.75, // scales GIF relative to ally clone size
gifMinPx: 44,
gifMaxPx: 180,
gifFadeInMs: 120,
gifFadeOutMs: 180,
gifOnScreenMs: 900,
gifOffset: { x: 120, y: -60 },
// White out
whiteFadeInMs: 2500,
whiteFadeOutMs: 650,
};
// -----------------------------
// Fixed staging coordinates (scene coords)
// -----------------------------
const ALLY_SPOTS = [
{ x: 220, y: 191 },
{ x: 1114, y: 449 },
{ x: 883, y: 171 },
];
const CASTER_HOME = { x: 639, y: 330 };
const RUN_PATH = [
{ x: 332, y: 231 },
{ x: 779, y: 218 },
{ x: 988, y: 399 },
];
// ======================================================================
// Payload → caster resolve (MATCH stable behavior)
// ======================================================================
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
if (DBG)
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
return tok;
};
// ======================================================================
// Camera helpers (SAFE)
// ======================================================================
const getStagePivotSnapshot = () => ({
x: canvas.stage.pivot.x,
y: canvas.stage.pivot.y,
scale: canvas.stage.scale.x,
});
const stagePivotToPanXY = (pivotX, pivotY) => {
const center = canvas.screenDimensions
? { x: canvas.screenDimensions.width / 2, y: canvas.screenDimensions.height / 2 }
: { x: canvas.app.renderer.width / 2, y: canvas.app.renderer.height / 2 };
return { x: pivotX + center.x, y: pivotY + center.y };
};
const safeSequencerPanToToken = async (token, { duration = 700, scale = 1.2 } = {}) => {
try {
const seq = new Sequence();
const pan = seq.canvasPan();
if (typeof pan.atLocation === "function") pan.atLocation(token);
else if (typeof pan.to === "function") pan.to(token.center);
else if (typeof pan.position === "function") pan.position(token.center);
if (typeof pan.duration === "function") pan.duration(duration);
if (typeof pan.scale === "function") pan.scale(scale);
if (typeof pan.ease === "function") pan.ease("easeInOutCubic");
await seq.play();
return true;
} catch (e) {
if (DBG) console.warn(TAG, "Sequencer canvasPan failed, using animatePan fallback", e);
await canvas.animatePan({ x: token.center.x, y: token.center.y, scale, duration });
return false;
}
};
const safeRestoreCamera = async (prior, { duration = 650 } = {}) => {
try {
const seq = new Sequence();
const pan = seq.canvasPan();
const approxXY = stagePivotToPanXY(prior.x, prior.y);
if (typeof pan.to === "function") pan.to(approxXY);
else if (typeof pan.position === "function") pan.position(approxXY);
if (typeof pan.duration === "function") pan.duration(duration);
if (typeof pan.scale === "function") pan.scale(prior.scale);
if (typeof pan.ease === "function") pan.ease("easeInOutCubic");
await seq.play();
} catch (e) {
if (DBG) console.warn(TAG, "Restore via Sequencer failed, using animatePan fallback", e);
const approxXY = stagePivotToPanXY(prior.x, prior.y);
await canvas.animatePan({ x: approxXY.x, y: approxXY.y, scale: prior.scale, duration });
}
// Snap exact
try {
canvas.stage.pivot.set(prior.x, prior.y);
canvas.stage.scale.set(prior.scale, prior.scale);
} catch (_) {}
};
// ======================================================================
// Main
// ======================================================================
try {
if (!game.modules.get("sequencer")?.active) {
ui.notifications.error("Sequencer module is not active.");
return;
}
if (!canvas?.ready) {
ui.notifications.warn("Canvas not ready yet.");
return;
}
// Minimal ONI.emit helper
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
// Friendly allies (exclude caster) – up to 3
const friendlies = canvas.tokens.placeables
.filter((t) => t?.document?.disposition === 1)
.filter((t) => t?.id !== caster.id)
.slice(0, 3);
if (DBG) {
console.log(TAG, "Caster:", caster?.name, caster?.id);
console.log(TAG, "Friendly allies (max 3):", friendlies.map((t) => t.name));
}
ONI.emit(
"oni:animationStart",
{
type: "zeroPower.blanche.5star",
sourceTokenId: caster.id,
targetTokenIds: friendlies.map((t) => t.id),
sceneId: canvas.scene?.id ?? null,
timestamp: Date.now(),
},
{ local: true, world: false }
);
// ======================================================================
// STEP 1) PSEUDO: Dim screen (tokens stay above)
// ======================================================================
const pseudoDimScript = `
const TAG = "${TAG}[PSEUDO][DIM]";
const DBG = ${DBG ? "true" : "false"};
if (!canvas?.ready) throw new Error("Canvas not ready (DIM).");
globalThis.__ONI_B5STAR__ = globalThis.__ONI_B5STAR__ ?? {};
const S = globalThis.__ONI_B5STAR__;
const g = new PIXI.Graphics();
const w = canvas.app.renderer.width;
const h = canvas.app.renderer.height;
g.beginFill(0x000000, 1);
g.drawRect(0, 0, w, h);
g.endFill();
g.alpha = 0;
g.position.set(0, 0);
g.zIndex = 5;
canvas.stage.sortableChildren = true;
canvas.stage.addChild(g);
canvas.stage.sortChildren();
S.dim = { g };
if (DBG) console.log(TAG, "Created dimmer", { w, h, zIndex: g.zIndex });
const fadeMs = Number(ctx.params.dimFadeInMs ?? 200);
const targetAlpha = Number(ctx.params.dimAlpha ?? 0.6);
await new Promise((resolve) => {
const start = performance.now();
const tick = () => {
const t = Math.min(1, (performance.now() - start) / Math.max(1, fadeMs));
g.alpha = targetAlpha * t;
if (t >= 1) { canvas.app.ticker.remove(tick); resolve(); }
};
canvas.app.ticker.add(tick);
});
if (DBG) console.log(TAG, "Dimmer faded in", { alpha: g.alpha });
return true;
`;
await (game.ONI?.pseudo?.play?.({
scriptId: "oni.blanche.5star.dim",
scriptSource: pseudoDimScript,
casterTokenUuid: caster.document.uuid,
params: { dimFadeInMs: T.dimFadeInMs, dimAlpha: T.dimAlpha },
meta: { source: "Blanche5Star" },
}) ?? Promise.resolve());
// ======================================================================
// STEP 2) Sequencer: Camera pan to caster
// ======================================================================
const priorView = getStagePivotSnapshot();
if (DBG) console.log(TAG, "Camera priorView:", priorView);
await safeSequencerPanToToken(caster, { duration: T.camPanMs, scale: T.camScale });
// ======================================================================
// STEP 3) Cut-in (Pseudo DOM) + SFX (Sequencer)
// ======================================================================
new Sequence().sound().file(OVERDRIVE_SFX).volume(0.9).play();
const pseudoCutinScript = `
const TAG = "${TAG}[PSEUDO][CUTIN]";
const DBG = ${DBG ? "true" : "false"};
const URL = String(ctx.params.cutinUrl);
const slideInMs = Number(ctx.params.slideInMs);
const holdMs = Number(ctx.params.holdMs);
const slideOutMs = Number(ctx.params.slideOutMs);
const z = Number(ctx.params.zIndex);
globalThis.__ONI_B5STAR__ = globalThis.__ONI_B5STAR__ ?? {};
const S = globalThis.__ONI_B5STAR__;
const id = "oni-b5star-cutin-" + Date.now() + "-" + Math.floor(Math.random()*100000);
S.cutinId = id;
const wrap = document.createElement("div");
wrap.id = id;
Object.assign(wrap.style, {
position: "fixed",
left: "0px",
top: "0px",
width: "100vw",
height: "100vh",
zIndex: String(z),
pointerEvents: "none",
overflow: "hidden",
});
const img = document.createElement("img");
img.src = URL;
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
willChange: "left, opacity",
});
wrap.appendChild(img);
document.body.appendChild(wrap);
if (DBG) console.log(TAG, "Cut-in DOM created", { id, URL });
const wait = (ms) => new Promise(r => setTimeout(r, Math.max(0, ms)));
img.style.transition = "left " + slideInMs + "ms ease-out";
void img.offsetHeight;
img.style.left = "0%";
await wait(slideInMs);
await wait(holdMs);
img.style.transition = "left " + slideOutMs + "ms ease-in";
img.style.left = "120%";
await wait(slideOutMs + 30);
try { wrap.remove(); } catch(_) {}
if (DBG) console.log(TAG, "Cut-in removed", { id });
return true;
`;
await (game.ONI?.pseudo?.play?.({
scriptId: "oni.blanche.5star.cutin",
scriptSource: pseudoCutinScript,
casterTokenUuid: caster.document.uuid,
params: {
cutinUrl: CUTIN_URL,
slideInMs: T.cutinSlideInMs,
holdMs: T.cutinHoldMs,
slideOutMs: T.cutinSlideOutMs,
zIndex: T.cutinZ,
},
meta: { source: "Blanche5Star" },
}) ?? Promise.resolve());
// ======================================================================
// STEP 4+) Cafe scene (Pseudo)
// - Black overlay fades in (screen fully black)
// - While black: RESET camera back to original + HOLD +1000ms (requested)
// - BG fade in
// - Clone allies + caster
// - Reveal (fade out black + dim)
// - Caster runs loops + emoji pops
// - Whiteout to cleanup (plays Item2 SFX at full white)
// ======================================================================
const pseudoCafeScript = `
const TAG = "${TAG}[PSEUDO][CAFE]";
const DBG = ${DBG ? "true" : "false"};
const wait = (ms) => new Promise(r => setTimeout(r, Math.max(0, ms)));
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function pick(arr) { if (!Array.isArray(arr) || arr.length === 0) return null; return arr[Math.floor(Math.random() * arr.length)]; }
function easeInOutCubic(t) { return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3)/2; }
function animateXY(obj, from, to, durMs) {
return new Promise(resolve => {
const start = performance.now();
const ticker = canvas.app.ticker;
const update = () => {
const raw = (performance.now() - start) / Math.max(1, durMs);
const t = Math.min(Math.max(raw, 0), 1);
const e = easeInOutCubic(t);
obj.x = from.x + (to.x - from.x) * e;
obj.y = from.y + (to.y - from.y) * e;
if (t >= 1) { ticker.remove(update); resolve(); }
};
ticker.add(update);
});
}
// ------------------------------------------------------------
// PATCH: Normalize token UUID result to Token PLACEABLE
// ------------------------------------------------------------
async function resolveTokenPlaceable(uuid) {
const docOrObj = await fromUuid(uuid);
if (!docOrObj) return null;
// placeable Token
if (docOrObj?.document && docOrObj?.center) return docOrObj;
// TokenDocument
const doc = docOrObj?.documentName === "Token" ? docOrObj : docOrObj?.document;
if (doc) {
const placeable =
doc.object ??
canvas.tokens?.get(doc.id) ??
canvas.tokens?.placeables?.find(t => t?.id === doc.id) ??
null;
return placeable;
}
// wrapper with .object
if (docOrObj?.object?.document && docOrObj?.object?.center) return docOrObj.object;
return null;
}
async function createTokenCloneSprite(tokenPlaceable, xy, zIndex) {
if (!tokenPlaceable?.document) throw new Error("createTokenCloneSprite: tokenPlaceable missing .document");
const src = tokenPlaceable.document.texture?.src;
if (!src) throw new Error("createTokenCloneSprite: token has no document.texture.src");
const texture = await loadTexture(src);
const s = new PIXI.Sprite(texture);
s.anchor.set(0.5);
s.x = xy.x;
s.y = xy.y;
s.zIndex = zIndex;
const mesh = tokenPlaceable.mesh ?? tokenPlaceable.icon ?? null;
if (mesh?.width && mesh?.height) {
s.width = mesh.width;
s.height = mesh.height;
} else {
const grid = canvas.grid?.size ?? 100;
const w = (tokenPlaceable.document.width ?? 1) * grid;
const h = (tokenPlaceable.document.height ?? 1) * grid;
s.width = w;
s.height = h;
}
canvas.stage.sortableChildren = true;
canvas.stage.addChild(s);
canvas.stage.sortChildren();
if (DBG) console.log(TAG, "Clone sprite created", {
name: tokenPlaceable?.name ?? tokenPlaceable?.document?.name,
src,
x: s.x, y: s.y, zIndex: s.zIndex,
w: s.width, h: s.height
});
return s;
}
// scene→screen helper for DOM overlays
function sceneToScreen(x, y) {
const pt = canvas.stage.toGlobal(new PIXI.Point(x, y));
const rect = canvas.app.view.getBoundingClientRect();
return { left: rect.left + pt.x, top: rect.top + pt.y };
}
// compute GIF size in SCREEN pixels based on ally sprite size
function computeGifSizePxFromAllySprite(allySprite, scaleToAlly, minPx, maxPx) {
const stageScale = canvas.stage?.scale?.x ?? 1;
const allySizeStage = Math.min(Number(allySprite?.width ?? 0), Number(allySprite?.height ?? 0));
const approxScreen = allySizeStage * stageScale * Number(scaleToAlly ?? 0.75);
const clamped = Math.max(Number(minPx ?? 44), Math.min(Number(maxPx ?? 180), approxScreen));
return Math.round(clamped);
}
function showGifAtSceneXY(gifUrl, sceneX, sceneY, opts) {
const { sizePx = 120, fadeInMs = 120, fadeOutMs = 180, durationMs = 900, zIndex = 99999 } = opts ?? {};
const id = "oni-b5star-gif-" + Date.now() + "-" + Math.floor(Math.random()*100000);
const pos = sceneToScreen(sceneX, sceneY);
const wrap = document.createElement("div");
wrap.id = id;
Object.assign(wrap.style, {
position: "fixed",
left: (pos.left - sizePx/2) + "px",
top: (pos.top - sizePx/2) + "px",
width: sizePx + "px",
height: sizePx + "px",
zIndex: String(zIndex),
pointerEvents: "none",
opacity: "0",
transition: "opacity " + fadeInMs + "ms ease-out",
border: "none",
outline: "none",
boxShadow: "none",
background: "transparent",
});
const img = document.createElement("img");
img.src = gifUrl;
Object.assign(img.style, {
width: "100%",
height: "100%",
objectFit: "contain",
imageRendering: "auto",
border: "none",
outline: "none",
boxShadow: "none",
background: "transparent",
display: "block",
});
wrap.appendChild(img);
document.body.appendChild(wrap);
void wrap.offsetHeight;
wrap.style.opacity = "1";
(async () => {
await wait(Math.max(0, durationMs - fadeOutMs));
wrap.style.transition = "opacity " + fadeOutMs + "ms ease-in";
wrap.style.opacity = "0";
await wait(fadeOutMs + 30);
try { wrap.remove(); } catch(_) {}
})();
return id;
}
// Camera restore helper (from prior pivot snapshot)
function stagePivotToPanXY(pivotX, pivotY) {
const center = canvas.screenDimensions
? { x: canvas.screenDimensions.width / 2, y: canvas.screenDimensions.height / 2 }
: { x: canvas.app.renderer.width / 2, y: canvas.app.renderer.height / 2 };
return { x: pivotX + center.x, y: pivotY + center.y };
}
async function restoreCameraDuringBlackout(priorView, durationMs) {
try {
const approxXY = stagePivotToPanXY(Number(priorView?.x ?? 0), Number(priorView?.y ?? 0));
const scale = Number(priorView?.scale ?? 1);
await canvas.animatePan({ x: approxXY.x, y: approxXY.y, scale, duration: Math.max(0, Number(durationMs ?? 650)) });
// snap exact
try {
canvas.stage.pivot.set(Number(priorView?.x ?? 0), Number(priorView?.y ?? 0));
canvas.stage.scale.set(scale, scale);
} catch(_) {}
if (DBG) console.log(TAG, "Camera restored during blackout", { approxXY, scale });
} catch (e) {
if (DBG) console.warn(TAG, "Camera restore during blackout failed", e);
}
}
// -----------------------------
// Shared state bucket
// -----------------------------
globalThis.__ONI_B5STAR__ = globalThis.__ONI_B5STAR__ ?? {};
const S = globalThis.__ONI_B5STAR__;
S.sprites = S.sprites ?? [];
S.domIds = S.domIds ?? [];
// ======================================================================
// A) Black overlay (above tokens) — fade in
// ======================================================================
const blackId = "oni-b5star-black-" + Date.now() + "-" + Math.floor(Math.random()*100000);
const black = document.createElement("div");
black.id = blackId;
Object.assign(black.style, {
position: "fixed",
left: "0px",
top: "0px",
width: "100vw",
height: "100vh",
zIndex: "99980",
pointerEvents: "none",
background: "black",
opacity: "0",
transition: "opacity " + Number(ctx.params.blackFadeInMs) + "ms ease-out",
});
document.body.appendChild(black);
S.domIds.push(blackId);
void black.offsetHeight;
black.style.opacity = String(Number(ctx.params.blackAlpha ?? 1));
if (DBG) console.log(TAG, "Black overlay fade in start", { blackId });
await wait(Number(ctx.params.blackFadeInMs) + 30);
// ======================================================================
// A2) While screen is BLACK:
// - Restore camera to original view (requested)
// - Hold blackout extra +1000ms (requested)
// ======================================================================
await restoreCameraDuringBlackout(ctx.params.priorView ?? null, Number(ctx.params.blackCamRestoreMs ?? 650));
await wait(Number(ctx.params.blackExtraHoldMs ?? 0));
// ======================================================================
// A3) Start Cafe SFX during Cafe Sequence (requested)
// ======================================================================
try {
const sfx = String(ctx.params.cafeEatingSfx ?? "");
if (sfx && globalThis.Sequence) {
new Sequence().sound().file(sfx).volume(0.85).play();
if (DBG) console.log(TAG, "Cafe SFX started", { sfx });
}
} catch (e) {
if (DBG) console.warn(TAG, "Cafe SFX failed", e);
}
// ======================================================================
// B) BG overlay sprite (maid cafe map) — fades in
// ======================================================================
const bgUrl = String(ctx.params.bgUrl);
const tex = await loadTexture(bgUrl);
const bgSprite = new PIXI.Sprite(tex);
const w = canvas.dimensions.sceneWidth;
const h = canvas.dimensions.sceneHeight;
bgSprite.position.set(0, 0);
bgSprite.width = w;
bgSprite.height = h;
const bgContainer = new PIXI.Container();
bgContainer.name = "ONI_B5STAR_BG_CONTAINER";
bgContainer.zIndex = 15; // BG below clones, above nothing else
bgSprite.alpha = 0;
bgContainer.addChild(bgSprite);
canvas.stage.sortableChildren = true;
canvas.stage.addChild(bgContainer);
canvas.stage.sortChildren();
S.bg = { bgContainer, bgSprite };
const fadeSec = Number(ctx.params.bgFadeInSec ?? 0.6);
if (globalThis.gsap) gsap.to(bgSprite, { alpha: 1, duration: fadeSec, ease: "power2.out" });
else bgSprite.alpha = 1;
// ======================================================================
// C) Clone allies (below black overlay, ABOVE BG)
// ======================================================================
const allyUuids = Array.isArray(ctx.params.allyTokenUuids) ? ctx.params.allyTokenUuids : [];
const allySpots = Array.isArray(ctx.params.allySpots) ? ctx.params.allySpots : [];
const allies = [];
for (let i = 0; i < Math.min(allyUuids.length, allySpots.length); i++) {
const placeable = await resolveTokenPlaceable(allyUuids[i]);
if (!placeable) {
if (DBG) console.warn(TAG, "Could not resolve ally placeable", allyUuids[i]);
continue;
}
allies.push(placeable);
}
const CLONE_Z = 25; // above BG (15), below DOM overlays
const allyCloneSprites = [];
for (let i = 0; i < allies.length; i++) {
const spot = allySpots[i];
const spr = await createTokenCloneSprite(allies[i], spot, CLONE_Z);
S.sprites.push(spr);
allyCloneSprites.push(spr);
}
// ======================================================================
// D) Clone caster at home spot
// ======================================================================
const casterUuid = String(ctx.params.casterTokenUuid);
const casterPlaceable = await resolveTokenPlaceable(casterUuid);
if (!casterPlaceable) throw new Error("Caster placeable missing for cafe scene");
const casterHome = ctx.params.casterHome;
const casterSprite = await createTokenCloneSprite(casterPlaceable, casterHome, CLONE_Z + 1);
S.sprites.push(casterSprite);
// ======================================================================
// E) Reveal cafe: fade OUT black + fade OUT dim screen
// ======================================================================
const revealMs = Number(ctx.params.revealFadeOutMs ?? 450);
black.style.transition = "opacity " + revealMs + "ms ease-in";
black.style.opacity = "0";
const dimG = S.dim?.g;
if (dimG) {
await new Promise((resolve) => {
const start = performance.now();
const fromA = Number(dimG.alpha ?? 0);
const tick = () => {
const t = Math.min(1, (performance.now() - start) / Math.max(1, revealMs));
dimG.alpha = fromA * (1 - t);
if (t >= 1) { canvas.app.ticker.remove(tick); resolve(); }
};
canvas.app.ticker.add(tick);
});
} else {
await wait(revealMs + 10);
}
if (DBG) console.log(TAG, "Cafe reveal complete", {
allies: allies.length,
loops: Number(ctx.params.cafeLoops ?? 3),
});
// ======================================================================
// F) Caster runs path — MULTI LOOPS — and emoji pops multiple times
// ======================================================================
const runPath = Array.isArray(ctx.params.runPath) ? ctx.params.runPath : [];
const moveMs = Number(ctx.params.runMoveMs ?? 650);
const holdMs = Number(ctx.params.runHoldMs ?? 250);
const cafeLoops = Math.max(1, Number(ctx.params.cafeLoops ?? 3));
const gifPool = Array.isArray(ctx.params.gifPool) ? ctx.params.gifPool : [];
const off = ctx.params.gifOffset ?? { x: 120, y: -60 };
const scaleToAlly = Number(ctx.params.gifScaleToAlly ?? 0.75);
const minPx = Number(ctx.params.gifMinPx ?? 44);
const maxPx = Number(ctx.params.gifMaxPx ?? 180);
function popGifForAllyIndex(allyIdx) {
if (allyIdx < 0 || allyIdx >= allyCloneSprites.length) return;
const allySpr = allyCloneSprites[allyIdx];
const spot = allySpots[allyIdx];
const gifUrl = pick(gifPool) ?? null;
if (!gifUrl) return;
const sizePx = computeGifSizePxFromAllySprite(allySpr, scaleToAlly, minPx, maxPx);
const gifId = showGifAtSceneXY(
gifUrl,
spot.x + Number(off.x ?? 0),
spot.y + Number(off.y ?? 0),
{
sizePx,
fadeInMs: Number(ctx.params.gifFadeInMs ?? 120),
fadeOutMs: Number(ctx.params.gifFadeOutMs ?? 180),
durationMs: Number(ctx.params.gifOnScreenMs ?? 900),
zIndex: 99999,
}
);
S.domIds.push(gifId);
if (DBG) console.log(TAG, "GIF pop", {
allyIdx, sizePx, gifUrl, scene: { x: spot.x, y: spot.y }
});
}
for (let loop = 0; loop < cafeLoops; loop++) {
if (DBG) console.log(TAG, "Run loop start", { loop: loop + 1, cafeLoops });
for (let i = 0; i < runPath.length; i++) {
const to = runPath[i];
const from = { x: casterSprite.x, y: casterSprite.y };
await animateXY(casterSprite, from, to, moveMs);
if (allyCloneSprites.length > 0) {
const idxA = (i + loop) % allyCloneSprites.length;
popGifForAllyIndex(idxA);
// extra random pop ~35% chance for more lively spam
if (Math.random() < 0.35 && allyCloneSprites.length > 1) {
const idxB = randInt(0, allyCloneSprites.length - 1);
if (idxB !== idxA) popGifForAllyIndex(idxB);
}
}
await wait(holdMs);
}
// return to home between loops
if (loop < cafeLoops - 1) {
await animateXY(
casterSprite,
{ x: casterSprite.x, y: casterSprite.y },
ctx.params.casterHome,
Math.max(350, Math.floor(moveMs * 0.7))
);
await wait(Math.max(120, Math.floor(holdMs * 0.6)));
}
}
// ======================================================================
// G) White fade in (covers EVERYTHING)
// - When fully white: play Item2 SFX (requested)
// - Then cleanup while white
// ======================================================================
const whiteId = "oni-b5star-white-" + Date.now() + "-" + Math.floor(Math.random()*100000);
const white = document.createElement("div");
white.id = whiteId;
Object.assign(white.style, {
position: "fixed",
left: "0px",
top: "0px",
width: "100vw",
height: "100vh",
zIndex: "99995",
pointerEvents: "none",
background: "white",
opacity: "0",
transition: "opacity " + Number(ctx.params.whiteFadeInMs) + "ms linear",
});
document.body.appendChild(white);
S.domIds.push(whiteId);
void white.offsetHeight;
white.style.opacity = "1";
await wait(Number(ctx.params.whiteFadeInMs) + 30);
// Play end SFX during whiteout (requested)
try {
const sfx = String(ctx.params.whiteoutEndSfx ?? "");
if (sfx && globalThis.Sequence) {
new Sequence().sound().file(sfx).volume(0.95).play();
if (DBG) console.log(TAG, "Whiteout end SFX played", { sfx });
}
} catch (e) {
if (DBG) console.warn(TAG, "Whiteout end SFX failed", e);
}
if (DBG) console.log(TAG, "White screen reached — cleaning up spawned visuals");
// Cleanup sprites (ally clones + caster clone)
try {
for (const spr of (S.sprites ?? [])) {
try { canvas.stage.removeChild(spr); } catch(_) {}
try { spr.destroy(); } catch(_) {}
}
} catch (e) {
console.warn(TAG, "Sprite cleanup error:", e);
}
S.sprites = [];
// Cleanup BG
try {
S.bg?.bgContainer?.removeChild(S.bg?.bgSprite);
S.bg?.bgSprite?.destroy?.({ children: true, texture: false, baseTexture: false });
S.bg?.bgContainer?.destroy?.({ children: true });
} catch (_) {}
S.bg = null;
// Remove black overlay
try { document.getElementById(blackId)?.remove(); } catch(_) {}
// Remove dimmer
try {
if (S.dim?.g) {
canvas.stage.removeChild(S.dim.g);
S.dim.g.destroy();
}
} catch(_) {}
S.dim = null;
// Remove any DOM overlays EXCEPT the white overlay (keep white for fade-out)
const domIds = (S.domIds ?? []).slice();
S.domIds = [whiteId];
for (const id of domIds) {
if (id === whiteId) continue;
try { document.getElementById(id)?.remove(); } catch(_) {}
}
// ======================================================================
// H) Fade out white → return to battlefield view
// ======================================================================
const outMs = Number(ctx.params.whiteFadeOutMs ?? 650);
white.style.transition = "opacity " + outMs + "ms ease-in";
white.style.opacity = "0";
await wait(outMs + 30);
try { white.remove(); } catch(_) {}
S.domIds = [];
if (DBG) console.log(TAG, "Cafe scene complete");
return true;
`;
await (game.ONI?.pseudo?.play?.({
scriptId: "oni.blanche.5star.cafe",
scriptSource: pseudoCafeScript,
casterTokenUuid: caster.document.uuid,
params: {
// black overlay + timing
blackFadeInMs: T.blackFadeInMs,
blackAlpha: T.blackAlpha,
blackExtraHoldMs: T.blackExtraHoldMs,
// NEW: pass prior camera + restore timing so pseudo can reset during blackout
priorView,
blackCamRestoreMs: 650,
// cafe sfx
cafeEatingSfx: CAFE_EATING_SFX,
// whiteout end sfx
whiteoutEndSfx: WHITEOUT_END_SFX,
// bg
bgUrl: BG_URL,
bgFadeInSec: T.bgFadeInSec,
// clones
allyTokenUuids: friendlies.map((t) => t.document.uuid),
allySpots: ALLY_SPOTS.slice(0, Math.max(0, friendlies.length)),
casterTokenUuid: caster.document.uuid,
casterHome: CASTER_HOME,
// reveal + movement
revealFadeOutMs: T.revealFadeOutMs,
runPath: RUN_PATH,
runMoveMs: T.runMoveMs,
runHoldMs: T.runHoldMs,
cafeLoops: T.cafeLoops,
// gifs
gifPool: GIF_POOL,
gifScaleToAlly: T.gifScaleToAlly,
gifMinPx: T.gifMinPx,
gifMaxPx: T.gifMaxPx,
gifFadeInMs: T.gifFadeInMs,
gifFadeOutMs: T.gifFadeOutMs,
gifOnScreenMs: T.gifOnScreenMs,
gifOffset: T.gifOffset,
// whiteout
whiteFadeInMs: T.whiteFadeInMs,
whiteFadeOutMs: T.whiteFadeOutMs,
},
meta: { source: "Blanche5Star" },
}) ?? Promise.resolve());
// ======================================================================
// STEP 5) (Optional safety) Restore camera again + emit animationEnd
// - Camera should already be restored during blackout, but we keep this
// for safety in case a client missed the pseudo restore.
// ======================================================================
await safeRestoreCamera(priorView, { duration: 350 });
ONI.emit(
"oni:animationEnd",
{
type: "zeroPower.blanche.5star",
sourceTokenId: caster.id,
targetTokenIds: friendlies.map((t) => t.id),
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
{ type: "zeroPower.blanche.5star", error: true, timestamp: Date.now() },
{ local: true, world: false }
);
} catch (_) {}
ui.notifications.error("Blanche 5star animation crashed. Check console for details.");
}
})();
