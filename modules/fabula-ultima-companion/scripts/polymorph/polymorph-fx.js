// ============================================================================
// Polymorph — the HORIZONTAL SQUASH transform (user ruling 2026-11-12):
// the base sprite squashes to a vertical line, the art swaps, and the new sprite
// stretches back out. Same beat in reverse on revert.
//
// Runs on EVERY client and only changes what this client draws. The GM (core)
// broadcasts { type:"polymorph.fx", tokenIds, sceneId }, waits SQUASH_OUT_MS,
// then writes the token's new texture. Each client:
//   1. hides the live mesh and squashes a COPY of it (old art) to scaleX 0;
//   2. waits for the token to redraw with the new texture (or a timeout — same
//      art, missing art, hidden token);
//   3. stretches a copy of the NEW mesh from scaleX 0 back to full, then shows
//      the live mesh again.
// The copy re-reads the live mesh's position/scale every frame, so the 3D battle
// stage's depth scaling and an idle bounce keep it in place. Pattern borrowed
// from event-rows-token.js (jump): every frame guarded, a throw drops the effect
// and restores the mesh — a ticker throw would stop PIXI's whole frame loop.
// ============================================================================

const NS = "fabula-ultima-companion";
const CHANNEL = `module.${NS}`;
const TAG = "[Polymorph FX]";

// Slow and readable (animation pacing rule: slow, 2×).
export const SQUASH_OUT_MS = 380;
export const STRETCH_IN_MS = 420;
const SWAP_WAIT_MS = 2500;

const easeIn = (t) => t * t;
const easeOutBack = (t) => { const c = 1.6; const u = t - 1; return 1 + (c + 1) * u * u * u + c * u * u; };

const _running = new Map();   // tokenId -> cancel()

function liveMesh(tokenId) {
  const tok = canvas?.tokens?.get(tokenId);
  return tok && !tok.destroyed ? tok.mesh : null;
}

function makeCopy(mesh) {
  const sprite = new PrimarySpriteMesh({ texture: mesh.texture, name: "oniPolymorphSquash" });
  sprite.anchor.set(mesh.anchor.x, mesh.anchor.y);
  sprite.tint = mesh.tint;
  sprite.elevation = mesh.elevation ?? 0;
  sprite.sortLayer = PrimaryCanvasGroup.SORT_LAYERS.TOKENS;
  sprite.sort = (mesh.sort ?? 0) + 1;
  canvas.primary.addChild(sprite);
  return sprite;
}

function follow(sprite, mesh, kx) {
  sprite.position.set(mesh.x, mesh.y);
  sprite.scale.set(mesh.scale.x * kx, mesh.scale.y);
  sprite.alpha = mesh.alpha ?? 1;
}

/** Play the squash on one token on this client. Resolves when finished. */
export function playSquash(tokenId) {
  return new Promise((resolve) => {
    if (document.visibilityState === "hidden" || !canvas?.ready) return resolve(false);
    const mesh0 = liveMesh(tokenId);
    if (!mesh0?.texture?.valid || !canvas.primary) return resolve(false);
    _running.get(tokenId)?.();

    const ticker = canvas.app.ticker;
    const oldTex = mesh0.texture;
    let sprite = makeCopy(mesh0);
    let phase = "out";
    let t0 = performance.now();
    let hidden = mesh0;
    hidden.renderable = false;

    const finish = (ok = true) => {
      ticker.remove(tick);
      _running.delete(tokenId);
      try { if (sprite && !sprite.destroyed) sprite.destroy(); } catch {}
      const m = liveMesh(tokenId);
      if (m && !m.destroyed) m.renderable = true;
      if (hidden && !hidden.destroyed) hidden.renderable = true;
      resolve(ok);
    };
    const tick = () => {
      try {
        const mesh = liveMesh(tokenId);
        if (!mesh || !sprite || sprite.destroyed) return finish(false);
        // A token redraw makes a new mesh: keep whichever is live hidden.
        if (mesh !== hidden) { if (hidden && !hidden.destroyed) hidden.renderable = true; hidden = mesh; }
        mesh.renderable = false;
        const el = performance.now() - t0;

        if (phase === "out") {
          const k = Math.max(0, 1 - easeIn(Math.min(1, el / SQUASH_OUT_MS)));
          follow(sprite, mesh, k);
          if (el >= SQUASH_OUT_MS) { phase = "wait"; t0 = performance.now(); sprite.scale.x = 0; }
        } else if (phase === "wait") {
          follow(sprite, mesh, 0);
          const swapped = mesh.texture?.valid && mesh.texture !== oldTex
            && mesh.texture.baseTexture !== oldTex.baseTexture;
          if (swapped || el >= SWAP_WAIT_MS) {
            sprite.destroy();
            sprite = makeCopy(mesh);
            follow(sprite, mesh, 0);
            phase = "in"; t0 = performance.now();
          }
        } else {
          const u = Math.min(1, el / STRETCH_IN_MS);
          follow(sprite, mesh, Math.max(0, easeOutBack(u)));
          if (u >= 1) return finish(true);
        }
      } catch (e) {
        console.warn(TAG, "frame failed; dropping the effect", e);
        finish(false);
      }
    };
    _running.set(tokenId, () => finish(false));
    ticker.add(tick);
  });
}

/** GM side: tell every client (and this one) to squash these tokens. */
export function broadcastSquash(tokenDocs) {
  const sceneId = canvas?.scene?.id ?? null;
  const ids = (tokenDocs ?? []).filter((t) => t?.parent?.id === sceneId).map((t) => t.id);
  if (!ids.length) return 0;
  try { game.socket.emit(CHANNEL, { type: "polymorph.fx", sceneId, tokenIds: ids }); } catch {}
  for (const id of ids) playSquash(id);
  return ids.length;
}

Hooks.once("ready", () => {
  game.socket.on(CHANNEL, (msg) => {
    if (msg?.type !== "polymorph.fx" || msg.sceneId !== canvas?.scene?.id) return;
    for (const id of msg.tokenIds ?? []) playSquash(id);
  });
  globalThis.FUCompanion = globalThis.FUCompanion || {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
  globalThis.FUCompanion.api.polymorphFx = { playSquash };
});
