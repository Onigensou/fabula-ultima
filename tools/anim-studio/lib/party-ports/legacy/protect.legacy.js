// ============================================================================
// Protect - Sequencer (Pipeline Version + PSEUDO "Move to Front" + Return + Conditional Flip)
//
// Change requested:
// ✅ Everything that's NOT VFX/SFX is now handled via ONI Pseudo Animation
// - Caster moves to "front of target" using pseudo clone (X + Y)
// - Optional flip happens on the pseudo clone AFTER arriving, then flips back AFTER returning
// - No token document movement, so snap guarantee removed
//
// VFX/SFX still done by Sequencer:
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
if (!game.modules.get("sequencer")?.active) {
ui.notifications.error("Sequencer module is not active.");
return;
}
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
// and Sequencer will time its VFX so it plays while the pseudo clone is in front.
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
const baseMesh = casterToken.mesh ?? casterToken.icon;
const originalTokenVisible = casterToken.visible;
const originalMeshVisible = baseMesh?.visible ?? true;
let sprite;
try {
sprite = await createClone(casterToken);
// Hide real token locally (once)
if (baseMesh) baseMesh.visible = false;
casterToken.visible = false;
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
if (baseMesh) baseMesh.visible = originalMeshVisible;
casterToken.visible = originalTokenVisible;
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
// --- MAIN SEQUENCE (VFX/SFX only) ---
const seq = new Sequence();
// Wait until pseudo arrival completes, then play FX/SFX (matches original "after arriving")
seq.wait(moveOutMs);
// FX on target + sound
seq.sound()
.file(SFX_PROTECT)
.volume(0.95);
seq.effect()
.file(FX_PROTECT)
.atLocation(targetToken)
.scale(0.3) // ⬅ preserved from your code; change to 1.0 if you want header behavior
.opacity(1.0);
// Hold (same as your original)
seq.wait(holdMs);
// Wait the remainder of pseudo return time so animationEnd happens after everything is done
seq.wait(moveBackMs);
await seq.play();
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
