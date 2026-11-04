// ============================================================================
// Stop - Sequencer (Pipeline Version + PSEUDO step forward / step back)
// - Pseudo handles movement only (visual clone, no real token movement)
// - Sequencer handles ALL VFX + SFX
// - CHANGE: Caster VFX is centered on the PSEUDO clone position (not the real token)
// ============================================================================
(async () => {
const TAG = "[ONI][Anim][Stop]";
try {
if (!game.modules.get("sequencer")?.active) {
ui.notifications.error("Sequencer module is not active.");
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
// -----------------------------
// PSEUDO availability
// -----------------------------
const hasPseudo = !!game.ONI?.pseudo?.play;
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
if (hasPseudo) {
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
const baseMesh = casterToken.mesh ?? casterToken.icon;
const originalTokenVisible = casterToken.visible;
const originalMeshVisible = baseMesh?.visible ?? true;
let sprite;
try {
sprite = await createClone(casterToken);
// Hide real token visuals (local only) for the WHOLE session
if (baseMesh) baseMesh.visible = false;
casterToken.visible = false;
const startX = sprite.x;
const startY = sprite.y;
const outX = startX + dx;
const outY = startY;
// Move out
await animate(sprite, startX, startY, outX, outY, dur);
// Hold while Sequencer VFX/SFX plays
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
if (baseMesh) baseMesh.visible = originalMeshVisible;
casterToken.visible = originalTokenVisible;
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
} else {
// Fallback: real token movement (only if pseudo missing)
const original = { x: sourceToken.document.x, y: sourceToken.document.y };
await sourceToken.document.update({ x: original.x + dx, y: original.y });
// approximate “pos” for caster VFX (token center)
globalThis[pseudoPosKey] = { x: sourceToken.center.x, y: sourceToken.center.y };
globalThis[pseudoDoneKey] = true;
}
// -----------------------------
// 2) Sequencer timeline (VFX + SFX only)
// Start after the step-out finishes (+ tiny buffer)
// -----------------------------
await new Promise((r) => setTimeout(r, MOVE_DURATION + 30));
// IMPORTANT: cast VFX centered on the pseudo clone position
const casterVfxLoc = getCasterVfxLocation();
const casterSeq = new Sequence()
.sound()
.file(SFX_BEGIN)
.volume(0.9)
.effect()
.file(FX_CASTER)
.atLocation(casterVfxLoc) // <-- CHANGED: not sourceToken
.scaleToObject(1.5);
await casterSeq.play();
// Wait 2000ms (your requirement)
await new Promise((r) => setTimeout(r, POST_CAST_WAIT));
// Target icosahedron + poison sound, then WAIT UNTIL FINISHED
const targetSeq = new Sequence();
targetSeq.sound().file(SFX_POISON).volume(0.9);
targetSeq
.effect()
.file(FX_TARGET)
.atLocation(targetToken)
.scaleToObject(1.5)
.waitUntilFinished();
await targetSeq.play();
// -----------------------------
// Tighter animationEnd:
// wait for pseudo move-back to actually finish
// -----------------------------
if (hasPseudo) {
await waitForPseudoDone(12000);
} else {
// Fallback: return real token
const original = { x: sourceToken.document.x - dx, y: sourceToken.document.y };
await sourceToken.document.update({ x: original.x, y: original.y });
}
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
