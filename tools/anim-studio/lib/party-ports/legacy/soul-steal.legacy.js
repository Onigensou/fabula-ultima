(async () => {
const TAG = "[ONI][Anim][RunFront-SFX-Return]";
const payload = globalThis.__PAYLOAD ?? {};
const DEBUG = true;
const SOUND_SRC = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/SE_manto.wav";
const SOUND_VOLUME = 0.5;
const MOVE_OUT_MS = 320;
const HOLD_MS = 1500; // wait after SFX before running back
const MOVE_BACK_MS = 320;
const APPROACH_GAP = 70;
function dbg(...args) {
if (!DEBUG) return;
console.log(TAG, ...args);
}
function warn(...args) {
console.warn(TAG, ...args);
}
function err(...args) {
console.error(TAG, ...args);
}
globalThis.ONI = globalThis.ONI ?? {};
if (!ONI.emit) {
ONI.emit = (eventName, eventPayload = {}, options = {}) => {
const { local = true, world = false } = options;
if (local) Hooks.callAll(eventName, eventPayload);
if (world) game.socket.emit("world", { action: eventName, payload: eventPayload });
};
}
async function toTokenPlaceable(ref) {
if (!ref) return null;
if (typeof ref === "string") {
const byId = canvas.tokens?.get(ref);
if (byId) return byId;
try {
const doc = await fromUuid(ref);
if (!doc) return null;
return doc.object ?? doc.token?.object ?? doc;
} catch (e) {
warn("toTokenPlaceable failed fromUuid:", ref, e);
return null;
}
}
return ref.object ?? ref.token?.object ?? ref ?? null;
}
function uniq(arr) {
return [...new Set(arr.filter(Boolean))];
}
function summarizeToken(tok) {
if (!tok) return null;
return {
id: tok.id ?? null,
name: tok.name ?? tok.document?.name ?? null,
uuid: tok.document?.uuid ?? null,
center: tok.center ? { x: tok.center.x, y: tok.center.y } : null,
x: tok.x ?? null,
y: tok.y ?? null
};
}
async function resolveSourceToken() {
const candidates = [
payload.casterTokenUuid,
payload.sourceTokenUuid,
payload.performerTokenUuid,
payload.tokenUuid,
payload.sourceTokenId,
payload.casterTokenId,
globalThis._token?.document?.uuid,
globalThis.token?.document?.uuid
];
dbg("resolveSourceToken candidates:", candidates);
for (const c of candidates) {
const tok = await toTokenPlaceable(c);
if (tok) return tok;
}
return canvas.tokens?.controlled?.[0] ?? null;
}
async function resolveTargetTokens() {
const raw = uniq([
...(Array.isArray(payload.targetTokenUuids) ? payload.targetTokenUuids : []),
...(Array.isArray(payload.targetUUIDs) ? payload.targetUUIDs : []),
...(Array.isArray(payload.originalTargetUUIDs) ? payload.originalTargetUUIDs : []),
...(Array.isArray(payload.targets) ? payload.targets : []),
...(Array.from(game.user?.targets ?? []).map(t => t?.document?.uuid))
]);
dbg("resolveTargetTokens raw refs:", raw);
const out = [];
for (const r of raw) {
const tok = await toTokenPlaceable(r);
if (tok) out.push(tok);
}
return out;
}
let resolvedSourceToken = null;
let resolvedTargets = [];
try {
if (!game.modules.get("sequencer")?.active) {
ui.notifications.error("Sequencer module is not active.");
return;
}
const sourceToken = await resolveSourceToken();
const targets = await resolveTargetTokens();
const firstTarget = targets[0] ?? null;
resolvedSourceToken = sourceToken;
resolvedTargets = targets;
dbg("Resolved source token:", summarizeToken(sourceToken));
dbg("Resolved targets:", targets.map(summarizeToken));
dbg("Payload snapshot:", payload);
if (!sourceToken) {
ui.notifications.warn("No caster token found.");
return;
}
if (!firstTarget) {
ui.notifications.warn("No target token found.");
return;
}
ONI.emit("oni:animationStart", {
type: "oni.runFrontSfxReturn",
sourceTokenId: sourceToken.id,
targetTokenIds: targets.map(t => t.id),
sceneId: canvas.scene?.id ?? null,
timestamp: Date.now()
}, { local: true, world: false });
const scriptSource = `
const { casterToken, targetTokens, params } = ctx;
if (!casterToken) throw new Error("Need casterToken");
function easeInOutCubic(t) {
return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
function animateXY(obj, from, to, durMs) {
return new Promise(resolve => {
const start = performance.now();
const ticker = canvas.app.ticker;
const update = () => {
const raw = (performance.now() - start) / durMs;
const t = Math.min(Math.max(raw, 0), 1);
const e = easeInOutCubic(t);
obj.x = from.x + (to.x - from.x) * e;
obj.y = from.y + (to.y - from.y) * e;
if (t >= 1) {
ticker.remove(update);
resolve();
}
};
ticker.add(update);
});
}
function getNativeFlipX(token) {
const values = [
token?.document?.texture?.scaleX,
token?.mesh?.scale?.x,
token?.icon?.scale?.x
].filter(v => typeof v === "number");
if (values.some(v => v < 0)) return true;
const mirrorX = token?.document?.texture?.mirrorX;
if (typeof mirrorX === "boolean") return mirrorX;
return false;
}
function setSpriteFlipX(sprite, flipped) {
const sx = Math.abs(sprite.scale.x || 1);
sprite.scale.x = flipped ? -sx : sx;
}
async function createClone(token) {
const baseObj = token.mesh ?? token.icon;
const texture = baseObj?.texture ?? await loadTexture(token.document.texture.src);
const sprite = new PIXI.Sprite(texture);
sprite.anchor.set(0.5);
const home = { x: token.center.x, y: token.center.y };
sprite.x = home.x;
sprite.y = home.y;
if (baseObj) {
sprite.width = Math.abs(baseObj.width);
sprite.height = Math.abs(baseObj.height);
sprite.alpha = baseObj.worldAlpha ?? 1;
sprite.rotation = baseObj.rotation ?? 0;
}
sprite.zIndex = Number(params.zIndex ?? 5000);
canvas.stage.sortableChildren = true;
canvas.stage.addChild(sprite);
canvas.stage.sortChildren();
setSpriteFlipX(sprite, getNativeFlipX(token));
return sprite;
}
const baseMesh = casterToken.mesh ?? casterToken.icon;
const originalTokenVisible = casterToken.visible;
const originalMeshVisible = baseMesh?.visible ?? true;
const originalFlipX = getNativeFlipX(casterToken);
const home = { x: casterToken.center.x, y: casterToken.center.y };
const target = targetTokens?.[0] ?? null;
let sprite;
try {
sprite = await createClone(casterToken);
if (baseMesh) baseMesh.visible = false;
casterToken.visible = false;
let front = {
x: home.x + Number(params.fallbackDx ?? -120),
y: home.y
};
if (target) {
const targetCenter = target.center ?? { x: home.x, y: home.y };
const approachDir = home.x >= targetCenter.x ? 1 : -1;
const gap = Number(
params.approachGap ??
Math.max(casterToken.w ?? 100, target.w ?? 100) * 0.6
);
front = {
x: targetCenter.x + (approachDir * gap),
y: targetCenter.y
};
}
// Run in
setSpriteFlipX(sprite, originalFlipX);
await animateXY(
sprite,
home,
front,
Number(params.moveOutMs ?? 320)
);
// Hold while the external SFX window plays
if (Number(params.holdMs ?? 0) > 0) {
await wait(Number(params.holdMs ?? 0));
}
// Flip for the run back
setSpriteFlipX(sprite, !originalFlipX);
await animateXY(
sprite,
front,
home,
Number(params.moveBackMs ?? params.moveOutMs ?? 320)
);
} finally {
if (sprite) {
canvas.stage.removeChild(sprite);
sprite.destroy();
}
if (baseMesh) baseMesh.visible = originalMeshVisible;
casterToken.visible = originalTokenVisible;
}
`;
dbg("Starting pseudo movement session.");
game.ONI.pseudo.play({
scriptId: "oni.runFrontSfxReturn.flipAware",
scriptSource,
casterTokenUuid: sourceToken.document.uuid,
targetTokenUuids: [firstTarget.document.uuid],
params: {
moveOutMs: MOVE_OUT_MS,
holdMs: HOLD_MS,
moveBackMs: MOVE_BACK_MS,
approachGap: APPROACH_GAP,
fallbackDx: sourceToken.center.x >= firstTarget.center.x ? -120 : 120,
zIndex: 5000
},
meta: {
source: "RunFrontSfxReturn",
soundSrc: SOUND_SRC
}
});
// Sequencer handles SFX only.
dbg("Starting Sequencer SFX.");
const sfxSeq = new Sequence();
sfxSeq
.wait(MOVE_OUT_MS)
.sound()
.file(SOUND_SRC)
.volume(SOUND_VOLUME);
sfxSeq.play();
// Wait for the whole cinematic window before ending.
await wait(MOVE_OUT_MS + HOLD_MS + MOVE_BACK_MS + 80);
dbg("Animation wait window finished.");
} catch (e) {
err("Animation crashed:", e);
} finally {
try {
ONI.emit("oni:animationEnd", {
type: "oni.runFrontSfxReturn",
sourceTokenId: resolvedSourceToken?.id ?? null,
targetTokenIds: resolvedTargets.map(t => t.id),
sceneId: canvas.scene?.id ?? null,
timestamp: Date.now()
}, { local: true, world: false });
dbg("Emitted oni:animationEnd.", {
sourceTokenId: resolvedSourceToken?.id ?? null,
targetTokenIds: resolvedTargets.map(t => t.id)
});
} catch (e) {
err("Failed to emit animationEnd:", e);
}
}
})();