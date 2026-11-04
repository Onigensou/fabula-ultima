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
// Protect - PORT shim (Pipeline Version + PSEUDO "Move to Front" + Return + Conditional Flip)
// PORTED: the old effect player is gone; FX/SFX go through PORT.effect / PORT.sound.
//
// Change requested:
// ✅ Everything that's NOT VFX/SFX is now handled via ONI Pseudo Animation
// - Caster moves to "front of target" using pseudo clone (X + Y)
// - Optional flip happens on the pseudo clone AFTER arriving, then flips back AFTER returning
// - No token document movement, so snap guarantee removed
//
// VFX/SFX done by the PORT shim:
// - Protect FX + sound
//
// UPDATE NOTE:
// Your header says "Protect FX scale = 1"
// Your code uses .scale(0.3) with a comment "requested scaling"
// I preserved your ACTUAL code behavior: scale(0.3).
// If you want scale(1), change that one line.
//
// ============================================================================
(async () => {
const TAG = "[Protect]";
try {
// --- Require ONI Pseudo Animation API ---
if (!game.ONI?.pseudo?.play) {
ui.notifications.error("ONI Pseudo Animation API not found (game.ONI.pseudo.play).");
console.error(TAG, "Missing game.ONI.pseudo.play");
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
// --- Resolve caster & targets ---
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
ui.notifications.warn("Protect: No caster token (payload missing and nothing selected).");
return;
}
if (!targets.length) {
ui.notifications.warn("Protect: No targets (payload missing and nothing targeted).");
return;
}
// Single-target
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
// --- "Front of target" (JRPG side rule) ---
// Target hostile (-1) is on LEFT and faces RIGHT => front is RIGHT of target
// Target friendly (not -1) is on RIGHT and faces LEFT => front is LEFT of target
const frontIsRightOfTarget = targetHostile;
// --- Movement (X + Y, fast) ---
const squares = 0.60; // tweak
const offsetPx = canvas.grid.size * squares;
const destFront = {
x: targetToken.document.x + (frontIsRightOfTarget ? +offsetPx : -offsetPx),
y: targetToken.document.y,
};
const moveOutMs = 220;
const moveBackMs = 220;
// --- Conditional flip rule ---
// "friendly unit protect a hostile target" => caster friendly AND target hostile AND differ
const shouldFlipCaster =
(casterDisposition !== -1) && (targetDisposition === -1) && (casterDisposition !== targetDisposition);
// Mirror state of the REAL token (for reference / logging only)
const originalMirrorX = sourceToken.document.mirrorX ?? false;
// --- Broadcast start ---
ONI.emit(
"oni:animationStart",
{
type: "skillProtect",
sourceTokenId: sourceToken.id,
targetTokenIds: [targetToken.id],
sceneId: canvas.scene?.id ?? null,
timestamp: Date.now(),
meta: { casterHostile, targetHostile, frontIsRightOfTarget, shouldFlipCaster },
},
{ local: true, world: false }
);
// --- Assets ---
const FX_PROTECT =
"modules/JB2A_DnD5e/Library/Generic/Conditions/Boon01/ConditionBoon01_012_Green_600x600.webm";
const SFX_PROTECT = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Shield2.wav";
// --- PSEUDO: move to front -> (optional flip) -> hold -> move back -> (optional unflip) ---
// Hold should cover: FX start + your scripted wait(2000) + moveBack time window.
// We'll keep pseudo "holding in front" for exactly 2000ms (your original hold),
// and the VFX is timed so it plays while the pseudo clone is in front.
const holdMs = 2000;
const scriptSource = `
const { casterToken, params } = ctx;
if (!casterToken) throw new Error("Need casterToken");
function easeInOutCubic(t) {
return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3)/2;
}
function animate(obj, fromX, fromY, toX, toY, durMs) {
return new Promise(resolve => {
const start = performance.now();
const ticker = canvas.app.ticker;
const update = () => {
const raw = (performance.now() - start) / durMs;
const t = Math.min(Math.max(raw, 0), 1);
const e = easeInOutCubic(t);
obj.x = fromX + (toX - fromX) * e;
obj.y = fromY + (toY - fromY) * e;
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
const toX = Number(params.toX);
const toY = Number(params.toY);
const moveOutMs = Number(params.moveOutMs ?? 220);
const holdMs = Number(params.holdMs ?? 0);
const moveBackMs = Number(params.moveBackMs ?? 220);
const shouldFlip = Boolean(params.shouldFlip ?? false);
let __restore = () => {};
let sprite;
try {
sprite = await createClone(casterToken);
// Hide real token locally (guarded hide; Foundry refresh cannot re-show it)
__restore = oni.hideToken(casterToken);
const homeX = sprite.x, homeY = sprite.y;
// Move OUT (X + Y)
await animate(sprite, homeX, homeY, toX, toY, moveOutMs);
// Flip AFTER arriving (only on pseudo clone)
if (shouldFlip) sprite.scale.x = -Math.abs(sprite.scale.x);
// Hold in front
if (holdMs > 0) await wait(holdMs);
// Flip back BEFORE returning (so return looks normal)
if (shouldFlip) sprite.scale.x = Math.abs(sprite.scale.x);
// Move BACK
await animate(sprite, toX, toY, homeX, homeY, moveBackMs);
} finally {
if (sprite) { canvas.stage.removeChild(sprite); sprite.destroy(); }
__restore();
}
`;
// Convert destFront token-doc coords -> stage (center) coords for the sprite.
// Token center = document x/y + (w/2,h/2) grid pixels
const wPx = (sourceToken.document.width ?? 1) * canvas.grid.size;
const hPx = (sourceToken.document.height ?? 1) * canvas.grid.size;
const frontCenterX = destFront.x + wPx / 2;
const frontCenterY = destFront.y + hPx / 2;
game.ONI.pseudo.play({
scriptId: "oni.protect.moveToFrontHoldReturn",
scriptSource,
casterTokenUuid: sourceToken.document.uuid,
targetTokenUuids: [targetToken.document.uuid],
params: {
toX: frontCenterX,
toY: frontCenterY,
moveOutMs,
holdMs,
moveBackMs,
shouldFlip: shouldFlipCaster,
},
meta: { source: "Protect", shouldFlipCaster, originalMirrorX },
});
// --- MAIN TIMELINE (VFX/SFX only) ---
const fxDurP = __fxDurMs(FX_PROTECT, 1000);
// Wait until pseudo arrival completes, then play FX/SFX (matches original "after arriving")
await PORT.wait(moveOutMs);
const fxStart = performance.now();
// FX on target + sound
PORT.sound(SFX_PROTECT, 0.95);
PORT.effect({
file: FX_PROTECT,
at: targetToken,
scale: 0.3, // ⬅ preserved from your code; change to 1.0 if you want header behavior
opacity: 1.0,
});
// Hold (same as your original)
await PORT.wait(holdMs);
// Wait the remainder of pseudo return time so animationEnd happens after everything is done
await PORT.wait(moveBackMs);
// The old player also waited for the FX clip itself to finish
const fxLeft = (await fxDurP) - (performance.now() - fxStart);
if (fxLeft > 0) await PORT.wait(fxLeft);
// --- Broadcast end ---
ONI.emit(
"oni:animationEnd",
{
type: "skillProtect",
sourceTokenId: sourceToken.id,
targetTokenIds: [targetToken.id],
sceneId: canvas.scene?.id ?? null,
timestamp: Date.now(),
},
{ local: true, world: false }
);
console.log(TAG, "END", { moveOutMs, holdMs, moveBackMs, shouldFlipCaster });
} catch (err) {
console.error(`${TAG} Animation crashed:`, err);
// Still emit animationEnd so pipeline won't hang
try {
globalThis.ONI?.emit?.(
"oni:animationEnd",
{ type: "skillProtect", error: true, timestamp: Date.now() },
{ local: true }
);
} catch (_) {}
}
})();
