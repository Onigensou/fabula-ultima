// grapple-rules.js — pure data + geometry for the Grappled hold (no Foundry).
//
// Grappled = the held unit shares the grappler's space. The hold module
// (grapple-hold.js) moves the held token to a SLOT beside its grappler; the
// grip visuals (grapple-grip-fx.js) draw a SKIN between them. Approved look:
// claude.ai/artifact/FmUkx43vnEo8dtev1XjfyU (mockup v4, 2026-11-10).
//
// Everything here is plain numbers so it can be unit-tested
// (grapple-rules.test.mjs).

// ───────── Skins
// A skin = how the grip is drawn (type) + its palette. "chain" is what every
// grappler gets; a monster picks another with the actor flag
// flags.fabula-ultima-companion.grappleSkin = "<skin id>".
//   out / main / hi  outline, body and highlight of the links or tentacle
//   back             the part of the wrap behind the body (darker)
//   glow             "r,g,b" soft glow per link, or null
//   sucker           tentacle only: the dots along its underside
export const DEFAULT_SKIN = "chain";
export const SKINS = Object.freeze({
  chain:          { type: "chain",    out: 0x3a1a04, main: 0xffae4a, hi: 0xfff1c8, back: 0xa8581a, glow: 0xff8c28 },
  iron:           { type: "chain",    out: 0x121418, main: 0x8f97a2, hi: 0xeef2f7, back: 0x4c525b, glow: null },
  tentacle:       { type: "tentacle", out: 0x1a0809, main: 0x6a2027, hi: 0xb4565c, back: 0x3e1216, glow: null, sucker: 0xd7898c },
  tentacle_green: { type: "tentacle", out: 0x0b1708, main: 0x3d6a27, hi: 0x94c96a, back: 0x22401a, glow: null, sucker: 0xe27aa9 },
});

/** The skin a grappler's flag names; the chain for no flag or an unknown id. */
export function resolveSkin(flagValue) {
  const id = String(flagValue ?? "").trim().toLowerCase();
  return { id: SKINS[id] ? id : DEFAULT_SKIN, ...(SKINS[id] ?? SKINS[DEFAULT_SKIN]) };
}

// ───────── Slots
// Where a held unit stands, in the reference stage px the mockup was tuned in
// (grid 110). Slot 0 is in front of the grappler's body; a multi-target grab
// fans the others out around it. [dx toward the held side, dy down-screen].
export const SLOTS = Object.freeze([[0, 18], [92, -74], [-14, 84], [120, 6]]);
export const MAX_SLOTS = SLOTS.length;
export const REF_GRID = 110;
export const DEFAULT_OVERLAP = 0.3;   // share of the held unit's width inside the grappler's space
export const DEFAULT_EDGE = 0.22;     // grappler body edge, as a share of its drawn sprite width

/** First slot index not in `taken` (array of numbers); the last slot when all are taken. */
export function freeSlot(taken = []) {
  const used = new Set(taken.map(Number));
  for (let i = 0; i < MAX_SLOTS; i++) if (!used.has(i)) return i;
  return MAX_SLOTS - 1;
}

/**
 * Token document {x, y} for a held unit.
 *   grappler  { cx, feetY, spriteW }   its 2D centre x, sprite feet y, drawn sprite width
 *   held      { spriteW, spriteH, boxW, boxH }   drawn sprite size + token box size (px)
 *   side      +1 = the held unit stands to the grappler's right, -1 = left
 *   index     slot index
 *   grid      scene grid size (px)
 * The held sprite is centred on its token box (anchor 0.5), so its feet sit at
 * box centre + spriteH / 2.
 */
export function slotPosition({ grappler, held, side = 1, index = 0, grid = REF_GRID, overlap = DEFAULT_OVERLAP, edge = DEFAULT_EDGE }) {
  const k = grid / REF_GRID;
  const [sx, sy] = SLOTS[Math.max(0, Math.min(MAX_SLOTS - 1, index))];
  const s = side < 0 ? -1 : 1;
  const cx = grappler.cx + s * (grappler.spriteW * edge + held.spriteW * (0.5 - overlap) + sx * k);
  const feetY = grappler.feetY + sy * k;
  const cy = feetY - held.spriteH / 2;
  return { x: Math.round(cx - held.boxW / 2), y: Math.round(cy - held.boxH / 2) };
}

/** Which side of the grappler the held unit comes from (its home spot vs the grappler). */
export function sideOf(heldCx, grapplerCx) { return heldCx >= grapplerCx ? 1 : -1; }

/** True when a token is already (within tol px) at a position. */
export function isAt(doc, pos, tol = 3) {
  return Math.abs(Number(doc?.x) - pos.x) <= tol && Math.abs(Number(doc?.y) - pos.y) <= tol;
}
