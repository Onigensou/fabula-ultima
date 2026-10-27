// unit-anchors.js — where a battle unit's head, waist and feet are ON SCREEN.
//
// One answer for every overlay that docks to a unit (NPC status strip and
// name label, status pop text, passive card, NPC HP bar; later the token
// cues). Anchors off token.mesh.getBounds(), the RENDERED sprite rect, like
// brand-mark / aspect-aura / domination-crest already do: the token's grid box
// is wrong on any monster with a non-1.0 token scale, which is most of them
// (measured 2026-10-27: Bandit x1.33 sprite overhangs its box by 23 px top and
// bottom; Gigas x2.45 by ~100 px).
//
// Screen (client) px, re-measured on every call, so pan / zoom / token scale /
// anchor / mirroring / pose swaps track for free. Falls back to the grid box
// when the mesh has no usable bounds.

/** Rendered sprite rect in client px, or null. */
export function spriteRect(token) {
  const view = globalThis.canvas?.app?.view;
  if (!view || !token || token.destroyed) return null;
  const rect = view.getBoundingClientRect();
  let b = null;
  try {
    const m = token.mesh;
    // Under the battle 3D camera the body is drawn away from its 2D spot:
    // drawnMeshBounds moves the rect there (plain getBounds() everywhere else).
    const drawn = globalThis.__ONI_BATTLE_STAGE_3D__?.drawnMeshBounds;
    if (m && !m.destroyed) b = drawn ? drawn(token) : m.getBounds();
  } catch { b = null; }
  if (!b || !(b.width > 0) || !(b.height > 0)) {
    try {
      const tl = token.toGlobal(new PIXI.Point(0, 0));
      const br = token.toGlobal(new PIXI.Point(token.w, token.h));
      b = { x: tl.x, y: tl.y, width: br.x - tl.x, height: br.y - tl.y };
    } catch { return null; }
  }
  const left = rect.left + b.x, top = rect.top + b.y;
  return { left, top, width: b.width, height: b.height, cx: left + b.width / 2, bottom: top + b.height };
}

/** Top-centre of the sprite (above the head). */
export function headPoint(token) {
  const r = spriteRect(token);
  return r ? { x: r.cx, y: r.top } : null;
}

/** Across the body, `f` of the way down from the top (0.58 = waist). */
export function waistPoint(token, f = 0.58) {
  const r = spriteRect(token);
  return r ? { x: r.cx, y: r.top + r.height * f } : null;
}

/** Bottom-centre of the sprite (the feet / painted ground shadow). */
export function feetPoint(token) {
  const r = spriteRect(token);
  return r ? { x: r.cx, y: r.bottom } : null;
}
