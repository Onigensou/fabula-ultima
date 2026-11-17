# Place badge, Helper hand nudge, Sealed Cavern wiring (v1.0.625)

Dungeon tiles that teleport to a place the party can come back to (an exploration map) now carry a small **Place badge**. The Helper-mode hand cursors now nudge. The Nether Bridge / Sealed Cavern / Great Seal teleporters are wired to the designed route.

Nothing here needs a world import. The world changes arrive as **two one-time migrations** on the GM's next boot. Both only fill in or change what still has its old value, so hand edits are left alone. **Restart the Foundry server after pulling:** `module.json` has a new script.

## Place badge

- A pill under the tile: a gold map pin + **LOCATION** in normal view. In **Helper** (on the tiles you can step to) and **Scan** (every tile), it shows the place name once visited, **????** before. Fog / shroud and hidden passages hide it.
- The hover bubble reads the place name (or ????) with "Location · <tile type>" underneath.
- **Tile Config → Fast Travel section → Place badge:** Off / On / After visit. Stored at `flags.fabula-ultima-companion.dungeonPathing.placeBadge` (`""`, `"on"`, `"afterVisit"`).
  - **After visit** = no badge until the party has gone through *this* tile. Use it on surprise doors (the Nether Bridge door).
  - The badge needs a working teleporter to **another** scene, because that is where the name comes from (`DP.FastTravel.landmarkLabel`, the same name the travel prompt uses).
- The **tile presets** Event, Story, Final Story and Settlement come with **On**. Door and Teleporter presets have nothing set.
- World map: threat dice and ✓ Cleared stamps hide while Scan is on, so the place names don't crowd them.
- Code: `scripts/dungeon-pathing-system/dp-place-badge.js` (new), plus small hooks in `dp-look.js`, `dp-scan-mode.js`, `dp-bootstrap.js`, `dp-tile-config.js` and `dp-worldmap.js`.

Migration `2026-11-17-place-badge` sets the presets and 20 existing tiles (the user's audit and calls). It also expires Winding Trail's Maelstrom Confluence tile (already played) and makes it a real Story tile, since it was a blank tile given Story art by hand.

## Helper hand nudge

`dp-helper-mode.js`: the hands slide right by 18% of their size and ease back on a 1.1 s loop. One shared ticker drives them, and it is removed when Helper turns off. Under `prefers-reduced-motion` they stand still.

## Sealed Cavern wiring

Migration `2026-11-17-sealed-cavern-wiring`. The route the user designed:

| From | To |
|---|---|
| Underground Area door `pS0b` | Nether Bridge south (unchanged) |
| Nether Bridge north arch `WMEx` (still behind `Great Seal Open`) | Sealed Cavern, on its door `cfJK` |
| Sealed Cavern door `cfJK` | Nether Bridge north (1036, 830) |
| Sealed Cavern event `7Vot` | The Great Seal (Nidhogg, 420, 930) |
| The Great Seal way back `tQxR` | Sealed Cavern, on `7Vot` |

It also clears the Sealed Cavern's `sceneVisited`, which a GM visit had set although no tile was ever stepped on. With it set, the Travel menu would offer the cavern as soon as the arch leads there, and Travel doesn't check the barrier switch.

## Tested

In a sandbox copy of the live world:
- Migration results, and Normal / Helper / Scan labels on the Underground Area.
- ???? before a visit; the After-visit door stays unmarked.
- The hover bubble, and a Tile Config save round trip.
- The hand ticker is removed when Helper turns off.
- Overworld Scan names.
- The Sealed Cavern route, both locked and unlocked.

Not yet seen at a real table.
