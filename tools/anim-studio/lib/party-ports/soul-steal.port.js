// ── PORT shim (party-ports/_port-shim.js): PORT.sound / PORT.effect / PORT.wait ──
// GM-side helpers; sound via Foundry AudioHelper (broadcast), effects via game.ONI.pseudo.play.
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
let __restore = null;
try {
sprite = await createClone(casterToken); try { oni.depthFollow(sprite, casterToken); } catch (e) {}
__restore = oni.hideToken(casterToken);
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
if (__restore) __restore();
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
// SFX at arrival (after the run-in), broadcast to every client.
dbg("Starting SFX.");
setTimeout(() => PORT.sound(SOUND_SRC, SOUND_VOLUME), MOVE_OUT_MS);
// Wait for the whole cinematic window before ending.
await PORT.wait(MOVE_OUT_MS + HOLD_MS + MOVE_BACK_MS + 80);
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