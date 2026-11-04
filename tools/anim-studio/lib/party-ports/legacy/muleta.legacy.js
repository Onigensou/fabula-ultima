// ============================================================================
// Muleta - Sequencer (Pipeline Version + "Run to Front" + Return) — PSEUDO MOVE
// UPDATE:
// - Token movement is now done via ONI Pseudo Animation (everything except VFX)
// - VFX/SFX remain Sequencer (Piercing + Impact + Hit sound)
// - If CASTER disposition is NOT -1 (friendly), flip BOTH Piercing + Impact FX horizontally
// (mirrorX = true). If caster is hostile (-1), no flip.
// ============================================================================
(async () => {
const TAG = "[Muleta]";
try {
if (!game.modules.get("sequencer")?.active) {
ui.notifications.error("Sequencer module is not active.");
return;
}
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
const baseMesh = casterToken.mesh ?? casterToken.icon;
const originalTokenVisible = casterToken.visible;
const originalMeshVisible = baseMesh?.visible ?? true;
let sprite;
try {
sprite = await createClone(casterToken);
// hide real token locally
if (baseMesh) baseMesh.visible = false;
casterToken.visible = false;
const start = { x: sprite.x, y: sprite.y };
const out = { x: start.x + Number(params.dx ?? 0), y: start.y + Number(params.dy ?? 0) };
const outMs = Number(params.outMs ?? 280);
const holdMs = Number(params.holdMs ?? 0);
const backMs = Number(params.backMs ?? 480);
// move out
await animateXY(sprite, start, out, outMs);
// hold while Sequencer VFX plays
await wait(holdMs);
// return
await animateXY(sprite, out, start, backMs);
} finally {
if (sprite) { canvas.stage.removeChild(sprite); sprite.destroy(); }
if (baseMesh) baseMesh.visible = originalMeshVisible;
casterToken.visible = originalTokenVisible;
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
// --- MAIN SEQUENCER (VFX/SFX only) ---
// Start after the caster reaches the front.
const delayToHit = runMs + 30;
const seq = new Sequence()
.wait(delayToHit)
// 1) SFX + FX (Pierce + Impact together), wait for the pierce FX to finish
.sound()
.file(SFX_HIT)
.volume(0.95)
// Impact (quick, layered)
.effect()
.file(FX_IMPACT)
.atLocation(targetToken)
.scaleToObject(1.35)
.mirrorX(mirrorX)
.opacity(1.0)
// Pierce (main line)
.effect()
.file(FX_PIERCE)
.atLocation(targetToken)
.scaleToObject(3.5)
.mirrorX(mirrorX)
.opacity(1.0)
.waitUntilFinished();
await seq.play();
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
