// ============================================================================
// Polymorph — the "POOF" transform (user ruling 2026-11-12, replaces the
// horizontal squash): an anime transformation poof. A Guilty Gear smoke puff
// (smoke_anim08, the same clip and size as Ninja Log's substitution) swallows
// the token, the art swaps under the cloud, and the new body POPS out as the
// smoke breaks up: a small squash-and-stretch overshoot plus a short white
// flash. Smoke Bomb sound. Same beat on revert.
//
// Runs on EVERY client and only changes what this client draws. The GM (core)
// broadcasts { type:"polymorph.fx", tokenIds, sceneId }, waits FX_SWAP_MS,
// then writes the token's new texture. Each client, per token:
//   0 ms      puff starts (first puff of the clip only, 0.7x) + sound (once)
//   70 ms     the live mesh is hidden (it is behind the cloud by then)
//   cloud     if the new texture has not arrived when the cloud is at its
//             densest frame, the puff PAUSES there (never reveal the old art)
//   reveal    texture swapped (or SWAP_WAIT_MS) and the cloud breaking up:
//             a copy of the NEW mesh pops in (0.78 → 1 with a stretch wobble)
//             under a white flash copy that fades out, then the live mesh shows
// The puff and copies re-read the live mesh's position/scale every frame, so
// the 3D battle stage's depth scaling and an idle bounce keep them in place.
// Every frame is guarded: a throw drops the effect and restores the mesh (a
// ticker throw would stop PIXI's whole frame loop).
// ============================================================================

const NS = "fabula-ultima-companion";
const CHANNEL = `module.${NS}`;
const TAG = "[Polymorph FX]";

const FORGE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb";
export const POOF_URL = `${FORGE}/Animation/Guilty%20Gear%20Strive/webm/smoke_anim08.webm`;
export const POOF_SFX = `${FORGE}/Sound/SmokeBomb.wav`;
const SFX_VOLUME = 0.55;

// smoke_anim08: 16 frames at 20 fps holding TWO puffs back to back. Frames 0-7
// are the first: dense 1-3, breaking into grey wisps 4-7.
const PUFF_RATE = 0.7;
const PUFF_END_S = 0.4;      // end of the first puff (source time)
const PUFF_HOLD_S = 0.16;    // the densest frame: hold here while the art is late
const PUFF_BREAK_S = 0.2;    // the cloud starts breaking up: the reveal can begin
const PUFF_SIZE = 1.39;      // cloud width = body size x this (Ninja Log swapPuff)

const HIDE_AT_MS = 70;
/** GM: write the new texture this long after the broadcast (cloud already covers). */
export const FX_SWAP_MS = 220;
const SWAP_WAIT_MS = 2500;
const POP_MS = 340;
const FLASH_MS = 320;

const easeOutBack = (t) => { const c = 1.7; const u = t - 1; return 1 + (c + 1) * u * u * u + c * u * u; };

const _running = new Map();   // tokenId -> cancel()
let _poofTex = null;          // the loaded master texture (each play clones its video)

async function poofTexture() {
  if (_poofTex?.valid) return _poofTex;
  _poofTex = await loadTexture(POOF_URL).catch(() => null);
  return _poofTex;
}

function playSfx() {
  try {
    const AH = foundry?.audio?.AudioHelper ?? globalThis.AudioHelper;
    AH?.play?.({ src: POOF_SFX, volume: SFX_VOLUME, autoplay: true, loop: false }, false);
  } catch (e) { console.warn(TAG, "sound failed", e); }
}

function liveMesh(tokenId) {
  const tok = canvas?.tokens?.get(tokenId);
  return tok && !tok.destroyed ? tok.mesh : null;
}

function addPrimary(texture, mesh, sortBump, name) {
  const sprite = new PrimarySpriteMesh({ texture, name });
  sprite.elevation = mesh.elevation ?? 0;
  sprite.sortLayer = PrimaryCanvasGroup.SORT_LAYERS.TOKENS;
  sprite.sort = (mesh.sort ?? 0) + sortBump;
  canvas.primary.addChild(sprite);
  return sprite;
}

/** A copy of the token mesh (its current texture). */
function makeCopy(mesh, sortBump = 1, name = "oniPolymorphCopy") {
  const s = addPrimary(mesh.texture, mesh, sortBump, name);
  s.anchor.set(mesh.anchor.x, mesh.anchor.y);
  s.tint = mesh.tint;
  return s;
}

/** Copy follows the live mesh, scaled by (kx, ky) around its anchor. */
function follow(sprite, mesh, kx = 1, ky = 1) {
  sprite.position.set(mesh.x, mesh.y);
  sprite.scale.set(mesh.scale.x * kx, mesh.scale.y * ky);
  sprite.alpha = mesh.alpha ?? 1;
}

/** Centre and size of the mesh as drawn (world px). */
function drawnBox(mesh) {
  const w = Math.abs(mesh.width), h = Math.abs(mesh.height);
  return { x: mesh.x + (0.5 - mesh.anchor.x) * w * Math.sign(mesh.scale.x || 1), y: mesh.y + (0.5 - mesh.anchor.y) * h, w, h };
}

function whiteFilter() {
  const f = new PIXI.ColorMatrixFilter();
  // every visible pixel -> white, alpha kept
  f.matrix = [0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0];
  return f;
}

/** Play the poof on one token on this client. Resolves when finished. */
export async function playPoof(tokenId) {
  if (document.visibilityState === "hidden" || !canvas?.ready) return false;
  const mesh0 = liveMesh(tokenId);
  if (!mesh0?.texture?.valid || !canvas.primary) return false;
  _running.get(tokenId)?.();

  const master = await poofTexture();
  let puffTex = null, video = null;
  try {
    const src = master && game.video.getVideoSource(master);
    if (src) { puffTex = await game.video.cloneTexture(src); video = game.video.getVideoSource(puffTex); }
  } catch (e) { console.warn(TAG, "puff clip unavailable", e); }

  return new Promise((resolve) => {
    const ticker = canvas.app.ticker;
    const oldTex = mesh0.texture;
    const box0 = drawnBox(mesh0);
    // the cloud keeps the size it started with (the old body), at least the new one's
    let puffW = Math.max(box0.w, box0.h) * PUFF_SIZE;
    let puff = null;
    if (puffTex) {
      puff = addPrimary(puffTex, mesh0, 3, "oniPolymorphPoof");
      puff.anchor.set(0.5, 0.5);
      try { video.loop = false; video.playbackRate = PUFF_RATE; video.currentTime = 0; video.play().catch(() => {}); } catch {}
    }
    let pop = null, flash = null;
    let hidden = null, swappedAt = 0, popStart = 0, held = false;
    const t0 = performance.now();

    const finish = (ok = true) => {
      ticker.remove(tick);
      _running.delete(tokenId);
      for (const s of [puff, pop, flash]) { try { if (s && !s.destroyed) s.destroy(); } catch {} }
      try { video?.pause(); if (video) { video.removeAttribute("src"); video.load(); } } catch {}
      try { puffTex?.destroy(true); } catch {}
      const m = liveMesh(tokenId);
      if (m && !m.destroyed) m.renderable = true;
      if (hidden && !hidden.destroyed) hidden.renderable = true;
      resolve(ok);
    };

    const tick = () => {
      try {
        const mesh = liveMesh(tokenId);
        if (!mesh) return finish(false);
        const el = performance.now() - t0;
        const vt = video ? video.currentTime : (el / 1000) * PUFF_RATE;
        const swapped = mesh.texture?.valid && mesh.texture !== oldTex && mesh.texture.baseTexture !== oldTex.baseTexture;
        if (swapped && !swappedAt) {
          swappedAt = el;
          puffW = Math.max(puffW, Math.max(Math.abs(mesh.width), Math.abs(mesh.height)) * PUFF_SIZE * 0.9);
        }
        const artReady = swappedAt || el >= SWAP_WAIT_MS;

        // the cloud: on the body's centre, depth-scaled with the mesh
        if (puff && !puff.destroyed) {
          const b = drawnBox(mesh);
          const depth = Math.abs(mesh.scale.y) / Math.abs(mesh0.scale.y || 1);
          puff.position.set(b.x, b.y);
          puff.width = puffW * depth; puff.height = puffW * depth;
          // fade over the last 30% of the first puff
          const u = vt / PUFF_END_S;
          puff.alpha = u > 0.7 ? Math.max(0, (1 - u) / 0.3) : 1;
          // never reveal the old art: hold the densest frame until the new one is in
          if (video && !artReady && vt >= PUFF_HOLD_S && !video.paused) { video.pause(); held = true; }
          if (video && held && artReady) { held = false; video.play().catch(() => {}); }
          if (vt >= PUFF_END_S || (video && video.ended)) { puff.destroy(); puff = null; }
        }

        // hide the body once the cloud covers it (a redraw makes a new mesh: keep the live one hidden)
        if (el >= HIDE_AT_MS && !popStart) {
          if (mesh !== hidden) { if (hidden && !hidden.destroyed) hidden.renderable = true; hidden = mesh; }
          mesh.renderable = false;
        }

        // the reveal: the new body pops out as the smoke breaks up
        if (!popStart && artReady && el >= HIDE_AT_MS && (vt >= PUFF_BREAK_S || !puff)) {
          popStart = el;
          pop = makeCopy(mesh, 1, "oniPolymorphPop");
          flash = makeCopy(mesh, 2, "oniPolymorphFlash");
          flash.filters = [whiteFilter()];
        }
        if (popStart) {
          if (mesh !== hidden) { if (hidden && !hidden.destroyed) hidden.renderable = true; hidden = mesh; }
          mesh.renderable = false;
          const pe = el - popStart;
          const u = Math.min(1, pe / POP_MS);
          const s = 0.78 + 0.22 * easeOutBack(u);
          const wob = 0.09 * Math.sin(u * Math.PI * 2) * (1 - u);   // stretch up, then squash, settle
          if (pop.texture !== mesh.texture) pop.texture = mesh.texture;
          if (flash.texture !== mesh.texture) flash.texture = mesh.texture;
          follow(pop, mesh, s * (1 - wob), s * (1 + wob));
          follow(flash, mesh, s * (1 - wob), s * (1 + wob));
          flash.alpha = 0.6 * Math.max(0, 1 - pe / FLASH_MS);
          if (u >= 1 && pe >= FLASH_MS && !puff) return finish(true);
        }
        if (el > SWAP_WAIT_MS + 3000) return finish(false);   // hard stop, whatever happened
      } catch (e) {
        console.warn(TAG, "frame failed; dropping the effect", e);
        finish(false);
      }
    };
    _running.set(tokenId, () => finish(false));
    ticker.add(tick);
  });
}

function playBatch(ids) {
  if (!ids?.length || document.visibilityState === "hidden") return;
  playSfx();
  for (const id of ids) playPoof(id);
}

/** GM side: tell every client (and this one) to poof these tokens. */
export function broadcastPoof(tokenDocs) {
  const sceneId = canvas?.scene?.id ?? null;
  const ids = (tokenDocs ?? []).filter((t) => t?.parent?.id === sceneId).map((t) => t.id);
  if (!ids.length) return 0;
  try { game.socket.emit(CHANNEL, { type: "polymorph.fx", sceneId, tokenIds: ids }); } catch {}
  playBatch(ids);
  return ids.length;
}

Hooks.once("ready", () => {
  game.socket.on(CHANNEL, (msg) => {
    if (msg?.type !== "polymorph.fx" || msg.sceneId !== canvas?.scene?.id) return;
    playBatch(msg.tokenIds ?? []);
  });
  // warm the clip and the sound so the first poof is not late (27 KB + one wav)
  poofTexture().catch(() => {});
  try { (foundry?.audio?.AudioHelper ?? globalThis.AudioHelper)?.preloadSound?.(POOF_SFX); } catch {}
  globalThis.FUCompanion = globalThis.FUCompanion || {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
  globalThis.FUCompanion.api.polymorphFx = { playPoof };
});
