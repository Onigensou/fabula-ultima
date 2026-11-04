// ============================================================================
// Descabello — Blackout Spotlight Blink-Rush Behind Target
// Foundry V12 / Oni Action Pipeline
//
// Visuals: ONI Pseudo Animation
// SFX: Sequencer sound only
//
// Suggested Damage Timing:
// animation_damage_timing_options = "offset"
// animation_damage_timing_offset = 2785
// ============================================================================
return (async () => {
const TAG = "[ONI][Anim][Descabello]";
// ─────────────────────────────────────────────────────────────
// TUNING KNOBS
// ─────────────────────────────────────────────────────────────
const PRE_RUSH_DELAY_MS = 2500;
const FLASH_IN_MS = 55;
const FLASH_OUT_MS = 110;
const RUSH_MS = 120;
const AFTERIMAGE_INTERVAL_MS = 18;
const AFTERIMAGE_LIFE_MS = 240;
const HOLD_AFTER_IMPACT_MS = 2000;
const BLACKOUT_FADE_IN_MS = 320;
const BLACKOUT_FADE_OUT_MS = 550;
const RETURN_JUMP_MS = 520;
const RETURN_JUMP_HEIGHT = 90;
const BEHIND_TARGET_DISTANCE = 125;
const TARGET_KNOCKBACK_DISTANCE = 42;
const TARGET_FEEDBACK_MS = 420;
const IMPACT_VFX = "modules/JB2A_DnD5e/Library/Generic/Impact/Impact_04_Regular_Blue_400x400.webm";
const IMPACT_VFX_SCALE = 2;
const IMPACT_VFX_MS = 900;
const BLACKOUT_START_SFX = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Battle3.ogg";
const BLACKOUT_START_SFX_VOLUME = 0.75;
const IMPACT_SFX = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Hit_SlashingB.wav";
const IMPACT_SFX_VOLUME = 0.9;
const SPOTLIGHT_CASTER_RADIUS_PX = 115;
const SPOTLIGHT_TARGET_RADIUS_PX = 130;
const BLACKOUT_OPACITY = 0.88;
// z-index stack inside PIXI canvas.
// Blackout is intentionally below all skill VFX.
const Z_BLACKOUT = 7000;
const Z_CASTER = 8000;
const Z_AFTERIMAGE = 7999;
const Z_TARGET_FEEDBACK = 8100;
const Z_IMPACT = 8200;
const Z_DOM_FLASH = 2147483000;
const IMPACT_AT_MS = PRE_RUSH_DELAY_MS + FLASH_IN_MS + FLASH_OUT_MS + RUSH_MS;
const TOTAL_MS =
IMPACT_AT_MS +
HOLD_AFTER_IMPACT_MS +
BLACKOUT_FADE_OUT_MS +
RETURN_JUMP_MS +
350;
// ─────────────────────────────────────────────────────────────
// Basic helpers
// ─────────────────────────────────────────────────────────────
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
globalThis.ONI = globalThis.ONI ?? {};
if (!ONI.emit) {
ONI.emit = function (eventName, payload = {}, options = {}) {
const { local = true, world = false } = options;
if (local) Hooks.callAll(eventName, payload);
if (world) game.socket.emit("world", { action: eventName, payload });
};
}
function toTokenPlaceable(x) {
if (!x) return null;
if (x?.document?.documentName === "Token") return x;
if (x?.documentName === "Token") return x.object ?? null;
if (x?.object?.document?.documentName === "Token") return x.object;
return null;
}
async function tokenFromUuidish(uuidish) {
if (!uuidish || typeof uuidish !== "string") return null;
try {
const doc = await fromUuid(uuidish);
if (!doc) return null;
if (doc.documentName === "Token") return doc.object ?? null;
if (doc.documentName === "Actor") {
return doc.getActiveTokens?.(true, true)?.[0] ?? null;
}
if (doc.actor?.getActiveTokens) {
return doc.actor.getActiveTokens(true, true)?.[0] ?? null;
}
return toTokenPlaceable(doc);
} catch (err) {
console.warn(TAG, "Could not resolve token from UUID:", uuidish, err);
return null;
}
}
async function resolveCasterToken(p) {
const refs = [
p?.sourceTokenUuid,
p?.casterTokenUuid,
p?.tokenUuid,
p?.tokenUUID,
p?.meta?.sourceTokenUuid,
p?.meta?.casterTokenUuid,
p?.attackerUuid,
p?.attackerActorUuid,
p?.meta?.attackerUuid,
p?.meta?.attackerActorUuid
].filter(Boolean);
for (const ref of refs) {
const tok = await tokenFromUuidish(ref);
if (tok) return tok;
}
return null;
}
async function resolveTargetToken(p, rawTargets) {
const directTargets = Array.isArray(rawTargets) ? rawTargets : [];
for (const t of directTargets) {
const direct = toTokenPlaceable(t);
if (direct) return direct;
const uuid =
typeof t === "string"
? t
: t?.document?.uuid ?? t?.uuid ?? null;
const tok = await tokenFromUuidish(uuid);
if (tok) return tok;
}
const refs = [
...(Array.isArray(p?.targetTokenUuids) ? p.targetTokenUuids : []),
...(Array.isArray(p?.targets) ? p.targets : []),
...(Array.isArray(p?.originalTargetUUIDs) ? p.originalTargetUUIDs : []),
...(Array.isArray(p?.meta?.targetTokenUuids) ? p.meta.targetTokenUuids : []),
...(Array.isArray(p?.meta?.originalTargetUUIDs) ? p.meta.originalTargetUUIDs : [])
].filter(Boolean);
for (const ref of refs) {
const tok = await tokenFromUuidish(ref);
if (tok) return tok;
}
return null;
}
const p = payload ?? globalThis.__PAYLOAD ?? {};
const sourceToken = await resolveCasterToken(p);
const targetToken = await resolveTargetToken(p, targets ?? globalThis.__TARGETS ?? []);
if (!sourceToken) {
ui.notifications?.warn?.("Descabello animation: could not resolve caster token from payload.");
return false;
}
if (!targetToken) {
ui.notifications?.warn?.("Descabello animation: could not resolve target token from payload.");
return false;
}
if (!game.ONI?.pseudo?.play) {
ui.notifications?.error?.("Descabello animation: ONI Pseudo Animation API not found.");
return false;
}
ONI.emit("oni:animationStart", {
type: "descabello",
sourceTokenId: sourceToken.id,
targetTokenIds: [targetToken.id],
sceneId: canvas.scene?.id ?? null,
timestamp: Date.now()
}, { local: true, world: false });
try {
if (game.modules.get("sequencer")?.active) {
new Sequence()
.sound()
.file(BLACKOUT_START_SFX)
.delay(0)
.volume(BLACKOUT_START_SFX_VOLUME)
.sound()
.file(IMPACT_SFX)
.delay(IMPACT_AT_MS)
.volume(IMPACT_SFX_VOLUME)
.play();
} else {
console.warn(TAG, "Sequencer is not active, SFX skipped.");
}
const scriptSource = `
const { casterToken, targetTokens, params } = ctx;
const targetToken = targetTokens && targetTokens.length ? targetTokens[0] : null;
if (!casterToken) throw new Error("Descabello pseudo: missing casterToken.");
if (!targetToken) throw new Error("Descabello pseudo: missing targetToken.");
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
function clamp01(v) {
return Math.max(0, Math.min(1, Number(v) || 0));
}
function easeInOutCubic(t) {
t = clamp01(t);
return t < 0.5
? 4 * t * t * t
: 1 - Math.pow(-2 * t + 2, 3) / 2;
}
function easeOutCubic(t) {
t = clamp01(t);
return 1 - Math.pow(1 - t, 3);
}
function tokenCenter(token) {
return {
x: token.center?.x ?? token.x ?? 0,
y: token.center?.y ?? token.y ?? 0
};
}
function getDisp(token) {
const d =
token?.document?.disposition ??
token?.actor?.document?.disposition ??
token?.actor?.prototypeToken?.disposition ??
1;
return d === -1 ? -1 : 1;
}
function rushDirectionFromCaster(token) {
return getDisp(token) === -1 ? 1 : -1;
}
function getBaseDisplayObject(token) {
return token.mesh ?? token.icon ?? token.children?.[0] ?? null;
}
function getTokenFacingSigns(token, base = null) {
const tex = token?.document?.texture ?? {};
const baseScaleX = Number(base?.scale?.x ?? 1);
const baseScaleY = Number(base?.scale?.y ?? 1);
const docScaleX = Number(tex?.scaleX ?? 1);
const docScaleY = Number(tex?.scaleY ?? 1);
const mirrorX =
docScaleX < 0 ||
baseScaleX < 0 ||
tex?.mirrorX === true ||
tex?.mirrorHorizontal === true ||
tex?.mirroredX === true;
const mirrorY =
docScaleY < 0 ||
baseScaleY < 0 ||
tex?.mirrorY === true ||
tex?.mirrorVertical === true ||
tex?.mirroredY === true;
return {
x: mirrorX ? -1 : 1,
y: mirrorY ? -1 : 1
};
}
function applyFacingSigns(sprite, signs) {
if (!sprite || !signs) return;
sprite.scale.x = Math.abs(sprite.scale.x || 1) * (signs.x < 0 ? -1 : 1);
sprite.scale.y = Math.abs(sprite.scale.y || 1) * (signs.y < 0 ? -1 : 1);
sprite.__oniFacingSigns = {
x: signs.x < 0 ? -1 : 1,
y: signs.y < 0 ? -1 : 1
};
}
function copySpriteFacingSigns(targetSprite, sourceSprite) {
if (!targetSprite || !sourceSprite) return;
const signs = sourceSprite.__oniFacingSigns ?? {
x: Math.sign(sourceSprite.scale?.x || 1) || 1,
y: Math.sign(sourceSprite.scale?.y || 1) || 1
};
applyFacingSigns(targetSprite, signs);
}
function hideTokenVisual(token) {
const base = getBaseDisplayObject(token);
const state = {
token,
tokenVisible: token.visible,
base,
baseVisible: base?.visible
};
if (base) base.visible = false;
token.visible = false;
return state;
}
function restoreTokenVisual(state) {
if (!state?.token) return;
if (state.base) state.base.visible = state.baseVisible;
state.token.visible = state.tokenVisible;
}
async function makeTokenSprite(token, zIndex) {
const base = getBaseDisplayObject(token);
const texture = base?.texture ?? await loadTexture(token.document.texture.src);
const signs = getTokenFacingSigns(token, base);
const sprite = new PIXI.Sprite(texture);
sprite.anchor.set(0.5);
const c = tokenCenter(token);
sprite.x = c.x;
sprite.y = c.y;
if (base) {
sprite.width = Math.abs(base.width || token.w || 100);
sprite.height = Math.abs(base.height || token.h || 100);
sprite.rotation = base.rotation ?? 0;
} else {
sprite.width = token.w ?? 100;
sprite.height = token.h ?? 100;
}
applyFacingSigns(sprite, signs);
sprite.alpha = 1;
sprite.zIndex = zIndex;
canvas.stage.sortableChildren = true;
canvas.stage.addChild(sprite);
canvas.stage.sortChildren();
return sprite;
}
function removeSprite(sprite) {
if (!sprite || sprite.destroyed) return;
try {
if (sprite.parent) sprite.parent.removeChild(sprite);
sprite.destroy();
} catch (_) {}
}
function fadeAlpha(obj, from, to, durMs) {
return new Promise(resolve => {
const start = performance.now();
obj.alpha = from;
const tick = () => {
const t = clamp01((performance.now() - start) / Math.max(1, durMs));
const e = easeInOutCubic(t);
obj.alpha = from + (to - from) * e;
if (t >= 1) {
canvas.app.ticker.remove(tick);
resolve();
}
};
canvas.app.ticker.add(tick);
});
}
function animateXY(obj, fromX, fromY, toX, toY, durMs, onFrame = null) {
return new Promise(resolve => {
const start = performance.now();
const tick = () => {
const t = clamp01((performance.now() - start) / Math.max(1, durMs));
const e = easeOutCubic(t);
obj.x = fromX + (toX - fromX) * e;
obj.y = fromY + (toY - fromY) * e;
if (onFrame) onFrame(t, e, obj);
if (t >= 1) {
canvas.app.ticker.remove(tick);
resolve();
}
};
canvas.app.ticker.add(tick);
});
}
function animateJump(obj, fromX, fromY, toX, toY, durMs, height) {
return new Promise(resolve => {
const start = performance.now();
const tick = () => {
const t = clamp01((performance.now() - start) / Math.max(1, durMs));
const e = easeInOutCubic(t);
obj.x = fromX + (toX - fromX) * e;
const baseY = fromY + (toY - fromY) * e;
const arc = Math.sin(Math.PI * t) * Number(height || 0);
obj.y = baseY - arc;
if (t >= 1) {
canvas.app.ticker.remove(tick);
resolve();
}
};
canvas.app.ticker.add(tick);
});
}
function getWorldViewBounds(pad = 1000) {
const screen = canvas.app.renderer.screen;
const inv = canvas.stage.worldTransform.clone().invert();
const p1 = inv.apply(new PIXI.Point(0, 0));
const p2 = inv.apply(new PIXI.Point(screen.width, screen.height));
const x = Math.min(p1.x, p2.x) - pad;
const y = Math.min(p1.y, p2.y) - pad;
const w = Math.abs(p2.x - p1.x) + pad * 2;
const h = Math.abs(p2.y - p1.y) + pad * 2;
return { x, y, w, h };
}
function screenPxToWorld(px) {
const scale = Math.abs(canvas.stage.scale?.x || 1);
return Number(px || 0) / Math.max(0.0001, scale);
}
function createSpotlightOverlay() {
const container = new PIXI.Container();
container.zIndex = Number(params.zBlackout ?? 7000);
container.alpha = 0;
container.sortableChildren = true;
const gfx = new PIXI.Graphics();
container.addChild(gfx);
canvas.stage.sortableChildren = true;
canvas.stage.addChild(container);
canvas.stage.sortChildren();
fadeAlpha(container, 0, 1, Number(params.blackoutFadeInMs ?? 320));
return { container, gfx };
}
function updateSpotlight(overlay, casterObj, targetToken) {
if (!overlay?.gfx) return;
const gfx = overlay.gfx;
const bounds = getWorldViewBounds(1800);
const casterR = screenPxToWorld(params.spotlightCasterRadiusPx ?? 115);
const targetR = screenPxToWorld(params.spotlightTargetRadiusPx ?? 130);
const targetCenter = tokenCenter(targetToken);
gfx.clear();
// Blackout layer drawn in PIXI, below all skill VFX.
// beginHole/endHole creates transparent spotlight windows.
gfx.beginFill(0x000000, Number(params.blackoutOpacity ?? 0.88));
gfx.drawRect(bounds.x, bounds.y, bounds.w, bounds.h);
gfx.beginHole();
gfx.drawCircle(casterObj.x, casterObj.y, casterR);
gfx.drawCircle(targetCenter.x, targetCenter.y, targetR);
gfx.endHole();
gfx.endFill();
}
async function fadeOutSpotlightOverlay(overlay) {
if (!overlay?.container) return;
await fadeAlpha(
overlay.container,
overlay.container.alpha ?? 1,
0,
Number(params.blackoutFadeOutMs ?? 550)
);
}
function removeSpotlightOverlay(overlay) {
if (!overlay?.container) return;
try {
if (overlay.container.parent) overlay.container.parent.removeChild(overlay.container);
overlay.container.destroy({ children: true });
} catch (_) {}
}
async function whiteFlash() {
const div = document.createElement("div");
Object.assign(div.style, {
position: "fixed",
inset: "0",
width: "100vw",
height: "100vh",
background: "white",
opacity: "0",
zIndex: String(params.zDomFlash ?? 2147483000),
pointerEvents: "none",
transition: "opacity " + Number(params.flashInMs ?? 55) + "ms linear"
});
document.body.appendChild(div);
requestAnimationFrame(() => {
div.style.opacity = "1";
});
await wait(Number(params.flashInMs ?? 55));
div.style.transition = "opacity " + Number(params.flashOutMs ?? 110) + "ms ease-out";
div.style.opacity = "0";
await wait(Number(params.flashOutMs ?? 110) + 20);
try { div.remove(); } catch (_) {}
}
function spawnAfterimage(sourceSprite, spawnedList) {
const ghost = new PIXI.Sprite(sourceSprite.texture);
ghost.anchor.set(sourceSprite.anchor.x, sourceSprite.anchor.y);
ghost.x = sourceSprite.x;
ghost.y = sourceSprite.y;
ghost.width = Math.abs(sourceSprite.width);
ghost.height = Math.abs(sourceSprite.height);
ghost.rotation = sourceSprite.rotation;
copySpriteFacingSigns(ghost, sourceSprite);
ghost.alpha = 0.42;
ghost.tint = 0x9edfff;
ghost.zIndex = Number(params.zAfterimage ?? 7999);
canvas.stage.addChild(ghost);
canvas.stage.sortChildren();
spawnedList.push(ghost);
const life = Number(params.afterimageLifeMs ?? 240);
fadeAlpha(ghost, ghost.alpha, 0, life).then(() => removeSprite(ghost));
}
async function playImpactVfxAt(token) {
const center = tokenCenter(token);
const texture = await loadTexture(params.impactVfx);
const sprite = new PIXI.Sprite(texture);
sprite.anchor.set(0.5);
sprite.x = center.x;
sprite.y = center.y;
sprite.scale.set(Number(params.impactVfxScale ?? 2));
sprite.alpha = 1;
sprite.zIndex = Number(params.zImpact ?? 8200);
canvas.stage.addChild(sprite);
canvas.stage.sortChildren();
try {
const video = texture?.baseTexture?.resource?.source;
if (video?.play) {
video.currentTime = 0;
video.loop = false;
video.muted = true;
video.play().catch(() => {});
}
await wait(Number(params.impactVfxMs ?? 900));
} finally {
removeSprite(sprite);
}
}
async function playTargetFeedback(token, dirSign) {
const state = hideTokenVisual(token);
let sprite = null;
try {
sprite = await makeTokenSprite(token, Number(params.zTargetFeedback ?? 8100));
const start = tokenCenter(token);
const knock = Number(params.targetKnockbackDistance ?? 42);
const dur = Number(params.targetFeedbackMs ?? 420);
await new Promise(resolve => {
const t0 = performance.now();
const tick = () => {
const t = clamp01((performance.now() - t0) / Math.max(1, dur));
const out = t < 0.45;
if (out) {
const e = easeOutCubic(t / 0.45);
sprite.x = start.x + dirSign * knock * e;
} else {
const e = easeInOutCubic((t - 0.45) / 0.55);
sprite.x = start.x + dirSign * knock * (1 - e);
}
sprite.y = start.y;
sprite.alpha = (Math.floor(t * 10) % 2 === 0) ? 1 : 0.35;
if (t >= 1) {
canvas.app.ticker.remove(tick);
resolve();
}
};
canvas.app.ticker.add(tick);
});
} finally {
removeSprite(sprite);
restoreTokenVisual(state);
}
}
let overlay = null;
let casterSprite = null;
let casterState = null;
let rafId = null;
const spawned = [];
function cleanup() {
if (rafId) cancelAnimationFrame(rafId);
removeSpotlightOverlay(overlay);
for (const s of spawned) removeSprite(s);
if (casterSprite) removeSprite(casterSprite);
restoreTokenVisual(casterState);
}
try {
canvas.stage.sortableChildren = true;
const dirSign = rushDirectionFromCaster(casterToken);
const start = tokenCenter(casterToken);
const targetCenter = tokenCenter(targetToken);
const behindX = targetCenter.x + dirSign * Number(params.behindTargetDistance ?? 125);
const behindY = targetCenter.y;
casterState = hideTokenVisual(casterToken);
casterSprite = await makeTokenSprite(casterToken, Number(params.zCaster ?? 8000));
overlay = createSpotlightOverlay();
const spotlightLoop = () => {
updateSpotlight(overlay, casterSprite, targetToken);
rafId = requestAnimationFrame(spotlightLoop);
};
spotlightLoop();
await wait(Number(params.preRushDelayMs ?? 2500));
await whiteFlash();
spawnAfterimage(casterSprite, spawned);
let lastAfterimageAt = 0;
await animateXY(
casterSprite,
start.x,
start.y,
behindX,
behindY,
Number(params.rushMs ?? 120),
() => {
const now = performance.now();
const interval = Number(params.afterimageIntervalMs ?? 18);
if (now - lastAfterimageAt >= interval) {
lastAfterimageAt = now;
spawnAfterimage(casterSprite, spawned);
}
}
);
spawnAfterimage(casterSprite, spawned);
playImpactVfxAt(targetToken).catch(err => console.warn("[Descabello pseudo] impact VFX failed:", err));
playTargetFeedback(targetToken, dirSign).catch(err => console.warn("[Descabello pseudo] target feedback failed:", err));
await wait(Number(params.holdAfterImpactMs ?? 2000));
await fadeOutSpotlightOverlay(overlay);
await animateJump(
casterSprite,
casterSprite.x,
casterSprite.y,
start.x,
start.y,
Number(params.returnJumpMs ?? 520),
Number(params.returnJumpHeight ?? 90)
);
} finally {
cleanup();
}
`;
game.ONI.pseudo.play({
scriptId: "oni.descabello.blackoutSpotlightBlinkRush",
scriptSource,
casterTokenUuid: sourceToken.document.uuid,
targetTokenUuids: [targetToken.document.uuid],
params: {
preRushDelayMs: PRE_RUSH_DELAY_MS,
flashInMs: FLASH_IN_MS,
flashOutMs: FLASH_OUT_MS,
rushMs: RUSH_MS,
afterimageIntervalMs: AFTERIMAGE_INTERVAL_MS,
afterimageLifeMs: AFTERIMAGE_LIFE_MS,
holdAfterImpactMs: HOLD_AFTER_IMPACT_MS,
blackoutFadeInMs: BLACKOUT_FADE_IN_MS,
blackoutFadeOutMs: BLACKOUT_FADE_OUT_MS,
returnJumpMs: RETURN_JUMP_MS,
returnJumpHeight: RETURN_JUMP_HEIGHT,
behindTargetDistance: BEHIND_TARGET_DISTANCE,
targetKnockbackDistance: TARGET_KNOCKBACK_DISTANCE,
targetFeedbackMs: TARGET_FEEDBACK_MS,
impactVfx: IMPACT_VFX,
impactVfxScale: IMPACT_VFX_SCALE,
impactVfxMs: IMPACT_VFX_MS,
spotlightCasterRadiusPx: SPOTLIGHT_CASTER_RADIUS_PX,
spotlightTargetRadiusPx: SPOTLIGHT_TARGET_RADIUS_PX,
blackoutOpacity: BLACKOUT_OPACITY,
zBlackout: Z_BLACKOUT,
zCaster: Z_CASTER,
zAfterimage: Z_AFTERIMAGE,
zTargetFeedback: Z_TARGET_FEEDBACK,
zImpact: Z_IMPACT,
zDomFlash: Z_DOM_FLASH
},
meta: {
source: "Descabello"
}
});
await wait(TOTAL_MS);
return true;
} catch (err) {
console.error(TAG, "Animation crashed:", err);
return false;
} finally {
ONI.emit("oni:animationEnd", {
type: "descabello",
sourceTokenId: sourceToken?.id ?? null,
targetTokenIds: targetToken ? [targetToken.id] : [],
sceneId: canvas.scene?.id ?? null,
timestamp: Date.now()
}, { local: true, world: false });
}
})();