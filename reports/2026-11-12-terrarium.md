# Terrarium (v1.0.598)

Heads-up for sarunphat: this adds a new dungeon consumable family and touches shared dungeon files: `dp-tile-state.js` (new place/undo path, `ensure()` and both reset paths), `dp-bootstrap.js` (two click guards, `rebuild()` on the dev API, the button hook in `applyForScene`), `dp-fast-travel.js` (one line) and the Party Menu's `useItem` / `useRefusal`. Nothing existing changes behaviour unless a Terrarium has been placed.

Approved mockup (v4): https://claude.ai/artifact/Sg95izKw5SLo32vd2E53wD

## What it is (Oni's rulings, 2026-11-12)

- Five consumables, all named **Terrarium: <Tile Type>**: Blank, Healing, Gathering, Camp, Random Battle. Dungeon Mode only.
- The **main controller** throws one onto a **tile next to the party**. That tile's **current** type and art change. Its **origin** (`tileStates.initialType` / `initialTexture`) is never written, so a future "origin" feature and the GM dungeon reset still see the map as built.
- **Free:** no step, the turn does not end.
- **Can't change:** Door / any teleporter (by type, Monk's teleport/scene action, or an enabled `teleporter` flag — Valley_Map006 has a Blank-art tile that is really a teleporter, and it is locked), Story, Final Story, Event, Travel, Camp (authored or placed), Fishing ("Fishing spots reset on a new day, so they can't change."), Settlement, and authored fights / switches (`fixedEncounter`, `storyBattle`, `clearedSwitch`, `travelThreat`). Same type as the Terrarium is refused. Arrow / Gusty / Slippery / Vertigo are allowed.
- **New day:** a tile with "Reset on rest" goes back to its origin on rest, Terrarium or not (origin wins). The picker warns before placing on one.
- **Camp** is a normal, permanent Camp and shows in **Fast Travel** once visited.
- Save / Load: nothing new. Saves already carry `tileStates` and the tile documents, so loading an older save brings the old tile back, and saving after the throw keeps it.

## How it plays

- **🌱 button** in the dungeon row, HudDock slot 25 (after ❤️ Healing), with a count. Grey for everyone but the main controller, or when the party has none.
- **Fan:** one orb per type held, rising from the button. Same look, keys and sounds as the camp Summon picker, except the move sound is `BattleCursor_2.wav` (Oni's pick). It sits above HudDock's stack so it clears the controller badge.
- **Picker:** gold rings on the tiles next to the party, a lock badge on the ones that can't change, a ghost of the new tile on the focused one, and a cream bubble ("Random Battle Tile → Healing Tile", the lock reason, or the new-day warning). ←/→ cycle, Z place, X back. Place / Go Back use the landing-panel buttons.
- **Party Menu → Items → Use** on a Terrarium (any active member's bag or the Party Bag) closes the menu and opens the picker with that item armed.
- **Watchers** (other players, the spectator, other GMs) get a read-only copy over MirrorPrompt `dungeon.terrarium`, then the throw.
- **The throw** (every client): BattleCursor_2 as the tile comes out of the pocket, it is held over the party token's head, flies on a plain arc with a ground shadow, lands with the polymorph smoke puff (`smoke_anim08`, first puff, 0.7×, drawn BEHIND the tile) and `Soundboard/Door1.ogg`, then a deep jelly squash. A System Message line names who used what. No magic VFX, no floating text. The party token's own sprite does not hop (several runtimes already move token meshes).

## Code

- New, all in `module.json` esmodules: `dp-terrarium-rules.js` (pure; +18 tests in `dp-terrarium-rules.test.mjs`), `dp-terrarium.js` (stock, checks, GM request over the raw module socket, primary GM only, serialized with `DP.gmSerialize`), `dp-terrarium-fx.js`, `dp-terrarium-ui.js`.
- `dp-tile-state.js`: `terraform(scene, tileId, kind, meta)` and `unTerrarium()`. A tile's behaviour lives on its TILE DOCUMENT (Use, skipConfirm, effectConfig…) and the effect engine runs `effectConfig` after every dispatch whatever the type, so placing swaps in the target type's behaviour (`PROFILES` in the rules file, measured from the world's tiles) and **clears the tile's Monk's actions** (4 Trap tiles still fire "Trap Damage" from Monk's). The old values are kept on the tile doc in `dungeonPathing.terrarium.backup`. Writes delete first, then set, because Foundry merges nested objects on update. `ensure()` honours the stamp (current type and origin texture survive a lost scene-flag entry, like `consumed`). `restoreEntry` (dungeon reset) and `resetOnRestTiles` undo the swap.
- `dp-bootstrap.js`: dungeon hover/click ignored while `DP.TerrariumUI.isOpen`; `__ONI_DUNGEON_PATHING__.rebuild()`; show/hide the 🌱 button in `applyForScene`.
- `dp-fast-travel.js`: `landmarkType()` treats a standing placed Camp as a Camp.
- `dp-tile-config.js`: a "Terrarium" section, **Can be changed**: Default / Always lock / Always allow (`dungeonPathing.terrariumRule`), plus who placed what on this tile.
- Party Menu: `useRefusal` / `useItem` Terrarium branch and four refusal texts.

## World data

- Items: the three legacy items renamed in place (ids kept), Camp `TerrariumCamp001` (500 z Rare) and Random Battle `TerrariumRBattle` (150 z Common) created. Each carries `flags.fabula-ultima-companion.terrarium = "<kind>"`. Flavour text empty for now (Oni).
- St. Reefesia's copy of Terrain Destroyer and her `consumable_list` row; the "Vastwind Field - Consumable" table text (rows 2 and 3).
- Script: `tools/safe-edit/bin/_terrarium-items-2026-11-12.js` (dry run by default).
- No save-slot patch needed.

## Verified (Staging World, Valley_Map006)

- GM logic run, 54/54: stock and button; every lock; the Blank-art teleporter locked; each of the five types placed; Healing actually heals on landing; Blank on a Trap turns its damage off; Camp in Fast Travel; a placed tile placed again keeps the first backup; a lost state entry rebuilds as placed; refusals spend nothing; a new day restores a Healing tile exactly; fan keys; save → throw → load; GM reset restores every tile's flags and Monk's actions exactly.
- GM + Blumairwen (main controller) + Spectator, 17/17: the player drives with real clicks/keys, the spectator's button is grey and it sees the fan, rings and bubble read-only, all three clients end with the same tile and graph and nothing left on the board, one item spent once, and a forged spectator request is refused.
- GPU beat captures of the throw (held, arc, landing, squash visible over the smoke).

## Not tested

- A real session. Two GMs at once (the request is primary-GM gated like the other dungeon raw messages).
- Landing on a placed Camp → camp scene → Set Out; landing on a placed Random Battle starting a fight; a placed Gathering's material roll (same handlers as authored tiles, only the flags were checked).
- The Party Menu Use flow end to end through the menu UI (the refusal logic is tested).
