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
// ============================================================================
// Muleta - (Pipeline Version + "Run to Front" + Return) — PSEUDO MOVE
// UPDATE:
// - Token movement is now done via ONI Pseudo Animation (everything except VFX)
// - VFX/SFX via PORT shim (Piercing + Impact + Hit sound), broadcast to all clients
// - If CASTER disposition is NOT -1 (friendly), flip BOTH Piercing + Impact FX horizontally
// (mirrorX = true). If caster is hostile (-1), no flip.
// ============================================================================
(async () => {
const TAG = "[Muleta]";
try {
if (!game.ONI?.pseudo?.play) {
ui.notifications.error("ONI Pseudo Animation API is not available (game.ONI.pseudo.play).");
return;
}
// Minimal ONI.emit helper
globalThis.ONI = globalThis.ONI ?? {};
if (!ONI.emit) {
ONI.emit = function (eventName, payload = {}, options = {}) {
const { local = true, world = false } = options;
if (local) Hooks.callAll(eventName, payload);
if (world) game.socket.emit("world", { action: eventName, payload });
};
}
// --- Payload ---
const payload = globalThis.__PAYLOAD ?? {};
// --- Helpers ---
const isUuid = (v) => typeof v === "string" && v.includes(".");
async function resolveToken(ref) {
if (!ref) return null;
if (ref?.document && ref?.object) return ref;
if (ref?.id && canvas.tokens?.get(ref.id)) return canvas.tokens.get(ref.id);
if (isUuid(ref)) {
const doc = await fromUuid(ref);
if (!doc) return null;
if (doc.object) return doc.object;
if (doc.document?.object) return doc.document.object;
return null;
}
if (typeof ref === "string") return canvas.tokens.get(ref) ?? null;
return null;
}
function pickTargetsFromPayload(p) {
if (Array.isArray(p.targetTokenIds) && p.targetTokenIds.length) return p.targetTokenIds;
if (Array.isArray(p.targets) && p.targets.length) {
const out = [];
for (const t of p.targets) {
if (typeof t === "string") out.push(t);
else if (t?.tokenId) out.push(t.tokenId);
else if (t?.tokenUuid) out.push(t.tokenUuid);
}
return out.filter(Boolean);
}
if (Array.isArray(p.rows)) {
const out = [];
for (const r of p.rows) {
if (r?.targetTokenId) out.push(r.targetTokenId);
if (r?.targetTokenUuid) out.push(r.targetTokenUuid);
}
if (out.length) return out;
}
return [];
}
// --- Resolve caster & target ---
const sourceRef =
payload.sourceTokenUuid ??
payload.sourceTokenId ??
payload.casterTokenUuid ??
payload.casterTokenId ??
payload.attackerTokenUuid ??
payload.attackerTokenId ??
null;
const targetRefs = pickTargetsFromPayload(payload);
// Fallbacks for testing
const fallbackSource = canvas.tokens.controlled?.[0] ?? null;
const fallbackTargets = Array.from(game.user.targets ?? []);
const sourceToken = (await resolveToken(sourceRef)) ?? fallbackSource;
const targets = [];
for (const r of targetRefs) {
const tok = await resolveToken(r);
if (tok) targets.push(tok);
}
if (!targets.length && fallbackTargets.length) targets.push(...fallbackTargets);
if (!sourceToken) {
ui.notifications.warn("Muleta: No caster token (payload missing and nothing selected).");
return;
}
if (!targets.length) {
ui.notifications.warn("Muleta: No targets (payload missing and nothing targeted).");
return;
}
const targetToken = targets[0];
// --- Dispositions ---
const casterDisposition =
sourceToken?.actor?.document?.disposition ??
sourceToken?.document?.disposition ??
0;
const targetDisposition =
targetToken?.actor?.document?.disposition ??
targetToken?.document?.disposition ??
0;
const casterHostile = casterDisposition === -1;
const targetHostile = targetDisposition === -1;
// Flip rule you requested:
// If caster is NOT hostile (-1) => flip FX horizontally
const mirrorX = !casterHostile;
// --- Target disposition => decides where "front" is ---
const frontIsRightOfTarget = targetHostile;
// --- Movement (Pseudo: center-based) ---
const squares = 0.65;
const offsetPx = canvas.grid.size * squares;
const home = { x: sourceToken.center.x, y: sourceToken.center.y };
const front = {
x: targetToken.center.x + (frontIsRightOfTarget ? +offsetPx : -offsetPx),
y: targetToken.center.y,
};
const dx = front.x - home.x;
const dy = front.y - home.y;
const runMs = 280;
const walkBackMs = 480;
// Hold window (covers the Piercing VFX timeline before returning)
// If your Piercing file is longer/shorter, tune this number.
const HOLD_MS = 1000;
// --- Broadcast start ---
ONI.emit(
"oni:animationStart",
{
type: "skillMuleta",
sourceTokenId: sourceToken.id,
targetTokenIds: [targetToken.id],
sceneId: canvas.scene?.id ?? null,
timestamp: Date.now(),
meta: { casterDisposition, targetDisposition, mirrorX, frontIsRightOfTarget },
},
{ local: true, world: false }
);
// --- Assets ---
const FX_PIERCE =
"modules/JB2A_DnD5e/Library/Generic/Template/Line/Generic/Piercing_Generic01_01_Regular_Orange_1000x400.webm";
const FX_IMPACT =
"modules/JB2A_DnD5e/Library/Generic/Impact/Impact_09_Regular_Orange_400x400.webm";
const SFX_HIT =
"https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/HitSlashS.ogg";
// --- PSEUDO MOVE (run to front -> hold -> return) ---
const pseudoScriptSource = `
const { casterToken, params } = ctx;
if (!casterToken) throw new Error("Muleta pseudo: missing casterToken");
function easeInOutCubic(t) {
return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3)/2;
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
if (t >= 1) { ticker.remove(update); resolve(); }
};
ticker.add(update);
});
}
async function createClone(token) {
const baseObj = token.mesh ?? token.icon;
const texture = baseObj?.texture ?? await loadTexture(token.document.texture.src);
const sprite = new PIXI.Sprite(texture);
sprite.anchor.set(0.5);
sprite.x = token.center.x;
sprite.y = token.center.y;
if (baseObj) { sprite.width = baseObj.width; sprite.height = baseObj.height; }
sprite.zIndex = 5000;
canvas.stage.sortableChildren = true;
canvas.stage.addChild(sprite);
canvas.stage.sortChildren();
return sprite;
}
let __restore = null;
let sprite;
try {
sprite = await createClone(casterToken);
// hide real token locally
__restore = oni.hideToken(casterToken);
const start = { x: sprite.x, y: sprite.y };
const out = { x: start.x + Number(params.dx ?? 0), y: start.y + Number(params.dy ?? 0) };
const outMs = Number(params.outMs ?? 280);
const holdMs = Number(params.holdMs ?? 0);
const backMs = Number(params.backMs ?? 480);
// move out
await animateXY(sprite, start, out, outMs);
// hold while the VFX plays
await wait(holdMs);
// return
await animateXY(sprite, out, start, backMs);
} finally {
if (sprite) { canvas.stage.removeChild(sprite); sprite.destroy(); }
if (__restore) __restore();
}
`;
game.ONI.pseudo.play({
scriptId: "oni.muleta.runToFrontReturn",
scriptSource: pseudoScriptSource,
casterTokenUuid: sourceToken.document.uuid,
targetTokenUuids: [targetToken.document.uuid],
params: {
dx,
dy,
outMs: runMs,
holdMs: HOLD_MS,
backMs: walkBackMs,
},
meta: { source: "Muleta" },
});
// --- MAIN VFX/SFX (PORT shim) ---
// Start after the caster reaches the front.
const delayToHit = runMs + 30;
// scaleToObject(S) on a token = effect width fitted to token width x S (aspect kept).
// PORT.effect scales native px x scale x (grid / fileGrid); with fileGrid = grid the
// grid factor cancels, so scale = tokenWidth x S / native file width (from file name).
const tW = targetToken.w ?? ((targetToken.document?.width ?? 1) * canvas.grid.size);
await PORT.wait(delayToHit);
// 1) SFX + FX (Pierce + Impact together), wait for the pierce FX to finish
PORT.sound(SFX_HIT, 0.95);
// Impact (quick, layered) - not waited, as in the legacy
PORT.effect({ file: FX_IMPACT, at: targetToken, scale: (tW * 1.35) / 400, fileGrid: canvas.grid.size, mirrorX, opacity: 1.0 });
// Pierce (main line) - waitUntilFinished
await PORT.effect({ file: FX_PIERCE, at: targetToken, scale: (tW * 3.5) / 1000, fileGrid: canvas.grid.size, mirrorX, opacity: 1.0 });
// --- Broadcast end ---
ONI.emit(
"oni:animationEnd",
{
type: "skillMuleta",
sourceTokenId: sourceToken.id,
targetTokenIds: [targetToken.id],
sceneId: canvas.scene?.id ?? null,
timestamp: Date.now(),
},
{ local: true, world: false }
);
console.log(TAG, "END");
} catch (err) {
console.error(`${TAG} Animation crashed:`, err);
// Still emit animationEnd so pipeline won't hang
try {
globalThis.ONI?.emit?.(
"oni:animationEnd",
{ type: "skillMuleta", error: true, timestamp: Date.now() },
{ local: true }
);
} catch (_) {}
}
})();
