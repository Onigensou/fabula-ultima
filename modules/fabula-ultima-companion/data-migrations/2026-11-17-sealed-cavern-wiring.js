/**
 * Migration: 2026-11-17-sealed-cavern-wiring  (Nether Bridge / Sealed Cavern / Great Seal)
 * ---------------------------------------------------------------------------
 * The route the user designed (2026-11-17):
 *
 *   Underground Area  --south door pS0b-->  Nether Bridge SOUTH (1036, 2860)
 *   Nether Bridge north arch WMEx (behind the barrier: "Great Seal Open")
 *                     -->  Sealed Cavern, on its door cfJK
 *   Sealed Cavern door cfJK   -->  Nether Bridge NORTH (1036, 830)
 *   Sealed Cavern event 7Vot  -->  The Great Seal (Nidhogg, 420, 930)
 *   The Great Seal way back tQxR  -->  Sealed Cavern, on 7Vot
 *
 * The world still had the old order (cfJK -> Underground, 7Vot -> Nether
 * Bridge south, the arch straight to the Great Seal, the Great Seal back to the
 * bridge). Also clears the Sealed Cavern's sceneVisited (set by a GM visit,
 * no tile ever stepped on): with it set, the Travel menu would offer the cavern
 * as soon as the arch leads there, and Travel ignores the barrier switch.
 *
 * ONE-TIME and careful: each teleporter is changed only while it still points
 * at its old destination, so a tile fixed by hand is left alone. The visited
 * flag is cleared only while no Sealed Cavern tile has been stepped on.
 */

export const key = "2026-11-17-sealed-cavern-wiring";
export const description = "Nether Bridge north arch -> Sealed Cavern -> Great Seal, and the ways back.";

const M = "fabula-ultima-companion";
const BRIDGE = "sEaLbRiDgEvM0250";
const CAVERN = "52LLgHZIyAXBrbMq";
const SEAL   = "MWQBX1ZnbjcFkvq2";

const CHANGES = [
  { label: "Nether Bridge north arch -> Sealed Cavern (door)",
    scene: BRIDGE, tile: "WMExuzmV2SGf5q1k",
    was: d => d?.sceneId === SEAL,
    to: { type: "tile", sceneId: CAVERN, tileId: "cfJKWaLaIe2DddtM" } },
  { label: "Sealed Cavern door -> Nether Bridge north",
    scene: CAVERN, tile: "cfJKWaLaIe2DddtM",
    was: d => d?.sceneId === "09CApvaBfOesGfbp",
    to: { type: "coords", sceneId: BRIDGE, x: 1036, y: 830 } },
  { label: "Sealed Cavern event -> The Great Seal",
    scene: CAVERN, tile: "7Votn2FymkL4dw9l",
    was: d => d?.sceneId === BRIDGE,
    to: { type: "coords", sceneId: SEAL, x: 420, y: 930 } },
  { label: "The Great Seal way back -> Sealed Cavern (event)",
    scene: SEAL, tile: "tQxRoT3vP0uywd5F",
    was: d => d?.sceneId === BRIDGE,
    to: { type: "tile", sceneId: CAVERN, tileId: "7Votn2FymkL4dw9l" } },
];

export async function migrate(game, log) {
  const out = [];
  for (const c of CHANGES) {
    const tile = game.scenes.get(c.scene)?.tiles?.get(c.tile);
    if (!tile) { out.push(`${c.label}: not in this world`); continue; }
    const tp = tile.flags?.[M]?.teleporter;
    if (!c.was(tp?.destination)) { out.push(`${c.label}: already changed, left as is`); continue; }
    // Replace the destination object whole (type tile <-> coords carry different keys).
    await tile.update({ [`flags.${M}.teleporter.-=destination`]: null });
    await tile.update({ [`flags.${M}.teleporter.destination`]: c.to });
    out.push(`${c.label}: done`);
  }

  const cavern = game.scenes.get(CAVERN);
  if (cavern) {
    const visitedTiles = cavern.flags?.[M]?.dungeonPathing?.visitedTiles ?? {};
    const vis = cavern.flags?.[M]?.oniFabula?.general?.sceneVisited;
    if ((vis === true || vis === "true") && !Object.keys(visitedTiles).length) {
      await cavern.setFlag(M, "oniFabula.general.sceneVisited", false);
      out.push("Sealed Cavern: visited flag cleared");
    } else {
      out.push("Sealed Cavern: visited flag left as is");
    }
  }
  log?.(out.join(" | "));
  return { applied: true, summary: out.join("; ") };
}
