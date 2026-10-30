# Treasure Chests on Exploration Maps

Placed treasure chests and item bags on exploration (walk) maps, the way a JRPG
does them. Rules set with the user on 2026-10-24; first rollout covers Ancient
Capital Midgard, Valley of the Dragon and Fafnir Castle. **Use the budgets and
bands below for every future zone.**

Dungeon (tile-path) maps do not get chests: their loot comes from loot TILES
and the zone's RollTables. Chests are for maps in `exploration` scene mode.

## JRPG conventions we follow

- **Fixed contents.** A chest holds the same thing every time. Random loot is
  the dungeon tiles' job.
- **Tier is readable at a glance** from the art, and better chests sound better.
- **Hidden chests reward looking around.** They hold things that cannot be
  bought or rolled.
- **Towns hold small things; the final dungeon has fewer chests worth more.**
- **No chest on a boss arena** before the fight, or where the party cannot walk.
- An opened chest stays opened for that party. (We have no open-lid art, so it
  disappears instead of showing an open lid.)

## Tiers

| Tier | Holds | Placement | Art (auto) |
|---|---|---|---|
| **Mundane** | Zenit or low-end consumables | Anywhere | Item bag |
| **Standard** | Common/Uncommon gear, more Zenit, or a costly consumable (Phoenix Feather, Mega-Elixir, Goddess Tear) | Anywhere; a side corner or dead end reads best | Silver chest for gear, item bag for Zenit/consumables |
| **Rare** | A lot of Zenit, or a Rare/Legendary item that is in no shop and no RollTable | Hidden: behind a building (foreground occluder), a dead end, a dark corner, behind a pillar | Gold chest |

**Art rule** (the user's addition): the treasure-chest graphics already in the
game are used for chests, and the **item bag** stands for a Zenit or consumable
chest. Assets: `Item Icon/bag.png`, `Item Icon/Silver_Chest.png`,
`Item Icon/Gold_Chest.png`. Other chest art in the library (`Green_Chest.png`,
`treas.png`, `tamateb.png`) can still be set by hand with Art = "Keep the tile's
own image".

## Zenit bands

Measured against the zone's `<Zone> - Zenit` RollTable **mean** result (a town
uses the table of the zone it leads into):

| Tier | Zenit |
|---|---|
| Mundane | 25–50% of the mean |
| Standard | 100–150% of the mean (item value + Zenit counts together) |
| Rare | at least the table's **max** |

Reference numbers: Valley table mean ≈ 920z, max 2,499z → Mundane 230–460z,
Standard 920–1,380z, Rare 2,500z+. Fafnir mean ≈ 1,100z, max 2,999z → Mundane
275–550z, Standard 1,100–1,650z, Rare 3,000z+.

## Budget per zone

| Zone kind | Chests | Mix |
|---|---|---|
| Town | 2–3 | Mundane and Standard only, no Rare |
| Dungeon chapter (its exploration maps) | ≈ 0.75 per exploration map | ≈ 35% Mundane / 50% Standard / 15% Rare; **exactly 1 Rare** per dungeon (2 if it has 10+ exploration maps) |
| Final dungeon | ≈ 1 per exploration map | at least 1 Rare; values from the top of the bands |

Zero chests on: maps with no reachable side space (an arrival platform among
walled-off islands), boss arenas, and pure cut-scene/theatre maps.

## Placement rules

- Place on walkable ground inside the wall outline, at least one grid from a
  warp tile and from an examine point, so the 🖐 button never stacks on another.
- Prefer spots the art already "explains": a painted coin pile, a painted
  chest, a dead-end landing, a side room.
- **Rare**: out of the obvious line of sight. On maps with foreground
  occluder data (towns, `occludersEnabled`), behind a building or wall the
  party can walk behind. On painted 3/4-view maps without occluders, a dark
  corner or the far side of a pillar, plus the proximity reveal (default 1.5
  grid). Never on the main path.
- **Blend it into the scene.** The icon art is clean and bright; at full size
  and opacity it pops out of a painted map. Size the tile about **0.4 × the
  scene's grid** (keep the art's aspect) and lower its opacity: **bag 0.5,
  chest 0.65**. These are the user's own values from the hand-placed chests on
  Ancient Temple and Wyrmwood. The Treasure tab's auto art sets the opacity
  when the tile is still at 1.

## How a chest is built

A plain tile with the Treasure tab of Tile Config (Fabula Configuration →
Treasure) filled in. Flags, `flags.oni-treasure-chest`:

| Field | Meaning |
|---|---|
| `isTreasureChest` | true |
| `tier` | `mundane` / `standard` / `rare` (empty = a chest from before tiers) |
| `itemUuid`, `itemName`, `itemImg`, `quantity` | the item (drag an Item onto the tab) |
| `zenit` | Zenit, 0 = none; a chest may hold both |
| `artMode` | `auto` (sets the tile image by the art rule on Save) or `custom` |
| `revealRadius` | Rare only: grid squares within which players see the chest |

Runtime (`scripts/treasure-chest-system/treasureChest-core.js`):

- 🖐 button within 1.25 grid of the party; keyboard Confirm works through
  `window.oni.Interact`. Only the party's main controller (or a GM) opens.
- The primary GM opens it: marks it opened, plays the sound (bag = pickup,
  gear/Rare = treasure jingle), grants Zenit to the party, then the item:
  **gear** goes through the dungeon loot screens (who carries it, equip now?)
  via `TreasureRoulette Flow.awardFixed()`; consumables go to Party Inventory.
- **Opened state is per party**: Event System memory on the party database
  actor (`flags.fabula-ultima-companion.eventState.<sceneId>.<tileId>.erased`).
  The save system carries it; the tile document is never changed. Players stop
  seeing an opened chest; a GM sees it faded. A tile `hidden` in the world
  counts as opened (that is how v3 marked chests, the 28 older chests keep it).
- To reset one chest for the current party (testing):
  `oni.GameState.resetEvent(sceneId, tileId)`.

## Checking a zone

`await FUCompanion.api.lint.runTreasureChestLint()` (GM, in game). Budgets live
in `AREA_BUDGETS` in `scripts/lint/treasure-chest-lint.js`, keyed by scene
folder name — **add the new zone's budget there** when it gets chests. It
reports over/under budget, empty chests, missing items, chests on non-exploration
maps, Rare items that are also rolled or sold, and Zenit outside the band.

## Chapter rollout — Midgard / Valley / Fafnir (2026-10-24)

Budgets: Midgard 3 (2 Mundane, 1 Standard) — set by the user; Valley and
Fafnir were placed at 6 (2/3/1) and 3 (1/1/1), then the user removed the
Great Seal chest and both Rare chests (Eye of Skadi in the Monastery
Interior, Balmung in the Treasure Hoard). Current: Valley 5 (2 Mundane /
3 Standard), Fafnir 2 (1 / 1), no Rare in this chapter. Coordinates are
scene pixels (tile centre), first pass.

| Zone | Map | Tier | Spot | Contents |
|---|---|---|---|---|
| Midgard | Midgard_Map001 Plaza | Mundane | west terrace among the fallen columns (300, 1150) | 300z |
| Midgard | Midgard_Map007 Cellar | Mundane | north-east cell by the cages (1060, 130) | Liquid Hope ×1 |
| Midgard | Midgard_Map006 Castle | Standard | east armoury, weapon-rack wall (1700, 1100) | Rune Blade |
| Valley | Valley_Map003 Valley Entrance | Mundane | bulge east of the path (700, 1650) | 300z |
| Valley | Valley_Map023 Thunder Pillar | Mundane | foot of the stone columns, west of the pillar (520, 1515), past the event band (2026-10-31) | Mixed Juice ×1 |
| Valley | Valley_Map012 Ancient Mural | Standard | dead-end stair landing, top right (1400, 310) | Phoenix Feather ×1 + 300z |
| Valley | Valley_Map020 Feeding Pit | Standard | by the cauldron, north rim (1240, 190) | Beowulf + 500z |
| Valley | Valley_Map016 Abandoned Monastery | Standard | behind the fallen pillar by the lion statue (1000, 640) | Goddess Tear ×1 |
| Fafnir | FafnirCastle_Map001 Entrance | Mundane | spilled coin pile by the toppled armour (80, 1500) | 450z |
| Fafnir | FafnirCastle_Map004 Hatchery | Standard | painted chest by the east door (1040, 1100) | Lux Shield + 500z |

No chest on Maelstrom Confluence (walled-apart islands), Sacrificial Altar
(boss arena), The Great Seal or the Treasure Hoard (user, 2026-10-24). Contents are a first pass picked by these rules; the user owns
the balance call. Beowulf (a dragon-slayer) was picked for theme.
