// ============================================================================
// Terrarium — the throw (2026-11-12). Plays on EVERY client from the GM's
// broadcast (dp-terrarium.js). Approved mockup v4 beats:
//
//   lift   0     → 380   the new tile comes out of the pocket to over the party
//                        token's head (BattleCursor_2.wav)
//   hold   380   → 900   it bobs there so everyone reads which tile is coming
//   throw  900   → 1520  plain arc (no flip), a ground shadow slides to the target
//   land   1520         smoke puff (smoke_anim08, first puff, 0.7×) + Door1.ogg;
//                        the GM writes the tile under the cloud
//   jelly  1520  → 2200  deep squash, stretch, wobbles; anchored at the bottom edge
//   line   2200         System Message: "<who> used Terrarium: X. The A is now a B."
//
// Board-game feel: no magic VFX, no floating text. The jelly runs on a stand-in
// sprite over the hidden tile mesh, so it does not wait on the GM's texture
// write; the real mesh comes back once the tile shows the new art.
// ============================================================================

import { KIND_TEXTURE, KIND_NAME, typeLabel } from "./dp-terrarium-rules.js";

const DP    = (globalThis.DungeonPathing ??= {});
const TAG   = "[DungeonPathing][TerrariumFX]";
const FORGE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb";
export const SFX_LIFT = `${FORGE}/Sound/BattleCursor_2.wav`;
export const SFX_LAND = `${FORGE}/Sound/Soundboard/Door1.ogg`;
const PUFF_URL = `${FORGE}/Animation/Guilty%20Gear%20Strive/webm/smoke_anim08.webm`;

const T = Object.freeze({ LIFT: 380, HOLD: 520, THROW: 620, JELLY: 680 });
const PUFF_RATE = 0.7, PUFF_END_S = 0.4, PUFF_FADE_MS = 140, PUFF_SIZE = 1.8;
const ARC_LIFT = 85;          // px above the higher end of the throw
const RESTORE_TIMEOUT_MS = 4000;
const Z = 999997;             // above tokens, like the turn-start pulse
const JELLY = [               // [scaleX, scaleY, at] — mockup v3, user-approved squash
  [1.55, 0.42, 0], [1.5, 0.45, 0.1], [0.8, 1.3, 0.34], [1.16, 0.86, 0.56],
  [0.95, 1.07, 0.76], [1.02, 0.98, 0.9], [1, 1, 1],
];

const reduceMotion = () => !!globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const lerp = (a, b, t) => a + (b - a) * t;
const easeOut = (t) => 1 - (1 - t) * (1 - t);
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const easeThrow = (t) => t * t * (3 - 2 * t) * 0.4 + t * 0.6;   // gentle in, steady out
const _restore = new Map();   // tileId -> () => void (bring the mesh back)

function sfx(src, volume) {
  try {
    const AH = foundry?.audio?.AudioHelper ?? globalThis.AudioHelper;
    AH?.play?.({ src, volume, autoplay: true, loop: false }, false);
  } catch (e) { console.warn(TAG, "sound failed", e); }
}

function jellyAt(t) {
  for (let i = 1; i < JELLY.length; i++) {
    const [x1, y1, a1] = JELLY[i - 1], [x2, y2, a2] = JELLY[i];
    if (t <= a2) { const k = (t - a1) / Math.max(1e-6, a2 - a1); return [lerp(x1, x2, easeInOut(k)), lerp(y1, y2, easeInOut(k))]; }
  }
  return [1, 1];
}

/** Centre / size of a token mesh as drawn (world px). */
function tokenBox(token) {
  const m = token?.mesh;
  if (!m) return null;
  const w = Math.abs(m.width), h = Math.abs(m.height);
  return { x: m.x + (0.5 - m.anchor.x) * w * Math.sign(m.scale.x || 1), y: m.y + (0.5 - m.anchor.y) * h, w, h };
}

async function puffSprite() {
  try {
    const master = await loadTexture(PUFF_URL);
    const src = master && game.video.getVideoSource(master);
    if (!src) return null;
    const tex = await game.video.cloneTexture(src);
    const video = game.video.getVideoSource(tex);
    const s = new PIXI.Sprite(tex);
    s.anchor.set(0.5, 0.5);
    try { video.loop = false; video.playbackRate = PUFF_RATE; video.currentTime = 0; video.play().catch(() => {}); } catch {}
    return { s, video };
  } catch (e) { console.warn(TAG, "puff unavailable", e); return null; }
}

function systemLine({ by, kind, fromLabel }) {
  const SM = globalThis.FU?.SystemMessage;
  if (!SM?.show) return;
  try { SM.show(`${by || "The party"} used {w:${KIND_NAME[kind]}}. The ${fromLabel || "tile"} is now a {w:${typeLabel(kind)}}.`); }
  catch (e) { console.warn(TAG, "system message failed", e); }
}

/** Play one throw on this client. Resolves when the jelly is done. */
export async function play(fx = {}) {
  if (!canvas?.ready || canvas.scene?.id !== fx.sceneId) return false;
  const tileDoc = canvas.scene.tiles.get(fx.tileId);
  const tile = canvas.tiles?.get?.(fx.tileId);
  if (!tileDoc) return false;
  const hidden = document.visibilityState === "hidden";
  const fast = reduceMotion() || hidden;
  const D = fast ? { LIFT: 1, HOLD: 1, THROW: 1, JELLY: 1 } : T;

  const tex = await loadTexture(KIND_TEXTURE[fx.kind]).catch(() => null);
  if (!tex) { systemLine(fx); return false; }

  const w = Number(tileDoc.width) || 50, h = Number(tileDoc.height) || 50;
  const cx = Number(tileDoc.x) + w / 2, cy = Number(tileDoc.y) + h / 2;
  const box = tokenBox(canvas.tokens?.get?.(fx.tokenId));
  const from = box ? { x: box.x, y: box.y + box.h * 0.15 } : { x: cx, y: cy - h * 2 };
  const over = box ? { x: box.x, y: box.y - box.h / 2 - h * 0.6 } : { x: cx, y: cy - h * 3 };
  const feet = box ? { x: box.x, y: box.y + box.h / 2 } : { x: cx, y: cy };

  const root = new PIXI.Container();
  root.zIndex = Z;
  root.name = "oniTerrariumThrow";
  canvas.stage.sortableChildren = true;
  canvas.stage.addChild(root);

  const shadow = new PIXI.Graphics();
  shadow.beginFill(0x000000, 1).drawEllipse(0, 0, w * 0.42, h * 0.13).endFill();
  shadow.alpha = 0;
  const held = new PIXI.Sprite(tex);
  held.anchor.set(0.5, 0.5);
  root.addChild(shadow, held);
  const setHeld = (x, y, s, a) => { held.position.set(x, y); held.width = w * s; held.height = h * s; held.alpha = a; };

  if (!hidden) sfx(SFX_LIFT, 0.8);

  let puff = null, jelly = null, landedAt = 0;
  const restoreMesh = () => {
    if (tile?.mesh && !tile.mesh.destroyed) tile.mesh.renderable = true;
    _restore.delete(fx.tileId);
  };

  return new Promise((resolve) => {
    const t0 = performance.now();
    const ticker = canvas.app.ticker;
    const finish = () => {
      ticker.remove(step);
      restoreMesh();
      if (root.parent) root.parent.removeChild(root);
      if (puff?.s && !puff.s.destroyed) puff.s.destroy({ texture: true, baseTexture: true });
      root.destroy({ children: true });
      resolve(true);
    };
    const step = () => {
      if (!canvas?.ready || root.destroyed) { ticker.remove(step); restoreMesh(); return resolve(false); }
      const e = performance.now() - t0;

      // 1 · lift
      if (e < D.LIFT) {
        const k = easeOut(e / D.LIFT);
        setHeld(lerp(from.x, over.x, k), lerp(from.y, over.y, k), lerp(0.55, 1, k), k);
        return;
      }
      // 2 · hold (a small bob)
      if (e < D.LIFT + D.HOLD) {
        const k = (e - D.LIFT) / D.HOLD;
        setHeld(over.x, over.y - Math.sin(k * Math.PI) * h * 0.07, 1, 1);
        return;
      }
      // 3 · throw: a plain quadratic arc, no flip
      if (e < D.LIFT + D.HOLD + D.THROW) {
        const k = easeThrow((e - D.LIFT - D.HOLD) / D.THROW);
        const peakY = Math.min(over.y, cy) - ARC_LIFT;
        const x = lerp(over.x, cx, k);
        const y = (1 - k) * (1 - k) * over.y + 2 * (1 - k) * k * peakY + k * k * cy;
        setHeld(x, y, 1, 1);
        shadow.position.set(lerp(feet.x, cx, k), lerp(feet.y, cy + h * 0.38, k));
        shadow.alpha = 0.18 + 0.2 * k;
        shadow.scale.set(lerp(0.6, 1, k));
        return;
      }
      // 4 · land (once)
      if (!landedAt) {
        landedAt = performance.now();
        held.visible = false; shadow.visible = false;
        if (!hidden) sfx(SFX_LAND, 0.7);
        // the stand-in: new art, anchored at the bottom edge, over the hidden mesh
        jelly = new PIXI.Sprite(tex);
        jelly.anchor.set(0.5, 1);
        jelly.position.set(cx, cy + h / 2);
        jelly.width = w; jelly.height = h;
        root.addChild(jelly);
        if (tile?.mesh) { tile.mesh.renderable = false; _restore.set(fx.tileId, restoreMesh); }
        if (!fast) puffSprite().then((p) => {
          if (!p || root.destroyed) { p?.s?.destroy?.({ texture: true, baseTexture: true }); return; }
          puff = p;
          const size = Math.max(w, h) * PUFF_SIZE;
          p.s.width = p.s.height = size;
          p.s.position.set(cx, cy);
          root.addChild(p.s);
        });
      }
      // 5 · jelly + puff
      const j = Math.min(1, (performance.now() - landedAt) / D.JELLY);
      const [sx, sy] = jellyAt(j);
      jelly.width = w * sx; jelly.height = h * sy;
      if (puff?.s && !puff.s.destroyed) {
        const ct = puff.video?.currentTime ?? 0;
        if (ct >= PUFF_END_S || puff.video?.ended) {
          puff._fadeAt ??= performance.now();
          puff.s.alpha = Math.max(0, 1 - (performance.now() - puff._fadeAt) / PUFF_FADE_MS);
          if (puff.s.alpha <= 0) { try { puff.video.pause(); } catch {} puff.s.visible = false; }
        }
      }
      if (j < 1) return;
      // 6 · hand back to the real tile once it shows the new art (or give up)
      if (!jelly._lineShown) { jelly._lineShown = true; systemLine(fx); }
      const shows = tileDoc.texture?.src === KIND_TEXTURE[fx.kind] && tile?.mesh?.texture?.valid;
      const puffDone = !puff || puff.s.destroyed || !puff.s.visible;
      if ((shows && puffDone) || performance.now() - landedAt > RESTORE_TIMEOUT_MS) finish();
    };
    ticker.add(step);
  });
}

/** The GM finished writing (DONE broadcast). Nothing to force: play() polls the tile. */
export function landed() {}

DP.TerrariumFX = Object.freeze({ play, landed, SFX_LIFT, SFX_LAND });
