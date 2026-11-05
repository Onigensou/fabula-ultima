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

// ── Port helper (this script only) ──────────────────────────────────────────
// PORT.effect resolves as soon as the broadcast is sent; the old player's play()
// resolved when its effects finished. To keep the legacy end timing, read the
// clip length here on the GM (metadata only) and wait it out explicitly.
function __fxDurMs(file, fallback) {
  return new Promise((res) => {
    const v = document.createElement('video');
    let done = false;
    const fin = (d) => { if (done) return; done = true; try { v.removeAttribute('src'); v.load(); } catch (e) {} res(d); };
    v.preload = 'metadata'; v.muted = true;
    v.onloadedmetadata = () => fin(isFinite(v.duration) && v.duration > 0 ? v.duration * 1000 : fallback);
    v.onerror = () => fin(fallback);
    setTimeout(() => fin(fallback), 4000);
    v.src = file;
  });
}
// ============================================================================
// Stop - PORT shim (Pipeline Version + PSEUDO step forward / step back)
// - Pseudo handles movement only (visual clone, no real token movement)
// - PORT.effect / PORT.sound handle ALL VFX + SFX (old effect player removed)
// - CHANGE: Caster VFX is centered on the PSEUDO clone position (not the real token)
// ============================================================================
(async () => {
const TAG = "[ONI][Anim][Stop]";
try {
// Minimal ONI.emit helper
globalThis.ONI = globalThis.ONI ?? {};
if (!ONI.emit) {
ONI.emit = function (eventName, payload = {}, options = {}) {
const { local = true, world = false } = options;
if (local) Hooks.callAll(eventName, payload);
if (world) game.socket.emit("world", { action: eventName, payload });
};
}
// -----------------------------
// TUNING KNOBS
// -----------------------------
const MOVE_DURATION = 350; // ms (caster step forward/back)
const STEP_SQUARES = 0.35; // how far to step (in grid squares)
const POST_CAST_WAIT = 2000; // ms
const EST_CAST_VFX_MS = 900;
const EST_TARGET_VFX_MS = 1800;
const EXTRA_BUFFER_MS = 250;
const HOLD_FORWARD_MS =
EST_CAST_VFX_MS + POST_CAST_WAIT + EST_TARGET_VFX_MS + EXTRA_BUFFER_MS;
// -----------------------------
// Assets
// -----------------------------
const FX_CASTER =
"modules/JB2A_DnD5e/Library/Generic/Cast/CastShapeSquare01_01_Regular_Blue_600x600.webm";
const FX_TARGET =
"modules/JB2A_DnD5e/Library/Generic/Energy/IcosahedronRoll_01_Regular_Blue_600x600.webm";
const SFX_BEGIN =
"https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Beginspell.mp3";
const SFX_POISON =
"https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Condition_Poison.ogg";
// -----------------------------
// Payload resolve
// -----------------------------
const payload = globalThis.__PAYLOAD ?? {};
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
const sourceRef =
payload.sourceTokenUuid ??
payload.sourceTokenId ??
payload.casterTokenUuid ??
payload.casterTokenId ??
payload.attackerTokenUuid ??
payload.attackerTokenId ??
null;
const targetRefs = pickTargetsFromPayload(payload);
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
ui.notifications.warn("Stop: No caster token (payload missing and nothing selected).");
return;
}
if (!targets.length) {
ui.notifications.warn("Stop: No targets (payload missing and nothing targeted).");
return;
}
const targetToken = targets[0];
// -----------------------------
// Disposition -> step direction
// -----------------------------
const casterDisposition =
sourceToken?.actor?.document?.disposition ?? sourceToken?.document?.disposition ?? 0;
const casterMoveRight = casterDisposition === -1;
const offsetPx = (canvas.grid.size ?? 100) * STEP_SQUARES;
const dx = casterMoveRight ? +offsetPx : -offsetPx;
// -----------------------------
// Emit START
// -----------------------------
ONI.emit(
"oni:animationStart",
{
type: "stop",
sourceTokenId: sourceToken.id,
targetTokenIds: [targetToken.id],
sceneId: canvas.scene?.id ?? null,
timestamp: Date.now(),
},
{ local: true, world: false }
);
// Used to tighten animationEnd timing
const pseudoDoneKey = `oni.stop.pseudoDone.${Date.now()}.${foundry.utils.randomID()}`;
globalThis[pseudoDoneKey] = false;
// NEW: live position key for the pseudo clone center (canvas coords)
const pseudoPosKey = `oni.stop.pseudoPos.${Date.now()}.${foundry.utils.randomID()}`;
globalThis[pseudoPosKey] = null;
const waitForPseudoDone = async (timeoutMs = 12000) => {
const start = performance.now();
while (!globalThis[pseudoDoneKey]) {
if (performance.now() - start > timeoutMs) break;
await new Promise((r) => setTimeout(r, 25));
}
};
// Helper to read the pseudo clone position (fallback to token center)
const getCasterVfxLocation = () => {
const p = globalThis[pseudoPosKey];
if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return { x: p.x, y: p.y };
return { x: sourceToken.center.x, y: sourceToken.center.y };
};
// -----------------------------
// 1) Pseudo session: move out -> HOLD -> move back
// -----------------------------
{
const pseudoScriptSource = `
const { casterToken, params } = ctx;
if (!casterToken) throw new Error("StopPseudo: casterToken missing");
const dx = Number(params.dx ?? 0);
const dur = Number(params.dur ?? 300);
const hold = Number(params.hold ?? 0);
const doneKey = String(params.doneKey ?? "");
const posKey = String(params.posKey ?? "");
function easeInOutCubic(t) {
return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3)/2;
}
function writePos(obj) {
if (!posKey) return;
globalThis[posKey] = { x: obj.x, y: obj.y };
}
function animate(obj, fromX, fromY, toX, toY, durMs) {
return new Promise(resolve => {
const startTime = performance.now();
const ticker = canvas.app.ticker;
const update = () => {
const raw = (performance.now() - startTime) / durMs;
const t = Math.min(Math.max(raw, 0), 1);
const e = easeInOutCubic(t);
obj.x = fromX + (toX - fromX) * e;
obj.y = fromY + (toY - fromY) * e;
writePos(obj);
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
writePos(sprite); // initial position publish
return sprite;
}
let __restore = () => {};
let sprite;
try {
sprite = await createClone(casterToken); try { oni.depthFollow(sprite, casterToken); } catch (e) {}
// Hide real token visuals (local only) for the WHOLE session (guarded hide)
__restore = oni.hideToken(casterToken);
const startX = sprite.x;
const startY = sprite.y;
const outX = startX + dx;
const outY = startY;
// Move out
await animate(sprite, startX, startY, outX, outY, dur);
// Hold while the VFX/SFX plays
if (hold > 0) {
// keep publishing position during hold (in case other code reads it later)
writePos(sprite);
await wait(hold);
writePos(sprite);
}
// Move back
await animate(sprite, outX, outY, startX, startY, dur);
} finally {
if (sprite) {
writePos(sprite); // final publish
canvas.stage.removeChild(sprite);
sprite.destroy(); // IMPORTANT: no "true"
}
__restore();
// Signal completion back to macro (local flag)
if (doneKey) globalThis[doneKey] = true;
}
`;
game.ONI.pseudo.play({
scriptId: "stop.pseudoSession",
scriptSource: pseudoScriptSource,
casterTokenUuid: sourceToken.document.uuid,
targetTokenUuids: [targetToken.document.uuid],
params: {
dx,
dur: MOVE_DURATION,
hold: HOLD_FORWARD_MS,
doneKey: pseudoDoneKey,
posKey: pseudoPosKey, // <-- NEW
},
meta: { source: "Stop" },
});
}
// Clip lengths (GM-side metadata): the old player's play() resolved when
// each effect finished, so the timeline waits them out explicitly.
const casterFxDurP = __fxDurMs(FX_CASTER, EST_CAST_VFX_MS);
const targetFxDurP = __fxDurMs(FX_TARGET, EST_TARGET_VFX_MS);
// -----------------------------
// 2) VFX + SFX timeline
// Start after the step-out finishes (+ tiny buffer)
// -----------------------------
await new Promise((r) => setTimeout(r, MOVE_DURATION + 30));
// IMPORTANT: cast VFX centered on the pseudo clone position
const casterVfxLoc = getCasterVfxLocation();
// scaleToObject(1.5) at a bare point = 1.5 grid squares (600px native file)
PORT.sound(SFX_BEGIN, 0.9);
PORT.effect({ file: FX_CASTER, at: casterVfxLoc, scale: 1.5, fileGrid: 600 }); // <-- CHANGED: not sourceToken
await PORT.wait(await casterFxDurP);
// Wait 2000ms (your requirement)
await new Promise((r) => setTimeout(r, POST_CAST_WAIT));
// Target icosahedron + poison sound, then WAIT UNTIL FINISHED
// scaleToObject(1.5) on the target = 1.5 x target width (600px native file)
PORT.sound(SFX_POISON, 0.9);
PORT.effect({ file: FX_TARGET, at: targetToken, scale: 1.5 * targetToken.w / canvas.grid.size, fileGrid: 600 });
await PORT.wait(await targetFxDurP);
// -----------------------------
// Tighter animationEnd:
// wait for pseudo move-back to actually finish
// -----------------------------
await waitForPseudoDone(12000);
// Cleanup
try { delete globalThis[pseudoDoneKey]; } catch (_) {}
try { delete globalThis[pseudoPosKey]; } catch (_) {}
// -----------------------------
// Emit END (tight)
// -----------------------------
ONI.emit(
"oni:animationEnd",
{
type: "stop",
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
try {
globalThis.ONI?.emit?.(
"oni:animationEnd",
{ type: "stop", error: true, timestamp: Date.now() },
{ local: true }
);
} catch (_) {}
}
})();
