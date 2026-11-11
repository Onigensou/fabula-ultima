# Crafting System — Blueprints (v1.0.589)

Heads-up for sarunphat: this touches two shared files, `orbment/camp-forge.js` and `map-system/keyboard-interact.js` (details below). Everything else is new and self-contained in `scripts/crafting-system/`.

## What it is

Crafting combines materials (plus Zenit and/or IP) into one or more items, JRPG style: a crafter has a fixed list of known recipes.

- **Keyword: Blueprint** (Oni's choice, 2026-11-12). Recipe items (`item_type: "recipe"`, the in-battle Item → Create paid with IP) are a **different system** and are never read or changed by this.
- Blueprints live in **books**. Each place that crafts uses one book.
- **Three ways in:**
  - **Crafter NPC**: a Craft button joins the NPC's overhead row and the keyboard menu.
  - **Crafting table**: a Region flagged as a crafting spot shows the standard "!".
  - **Camp Forge → Craft**: makes one item from the camp book.

## Rules (Oni's rulings, 2026-11-12)

- **Who crafts:** the actor who opens the window.
  - Walk map: the Main Controller's party member. Only they (or a GM) see the buttons, like every party-wide prompt.
  - Camp map: each player's own member.
- **Who pays:** that actor pays the Zenit and IP.
- **Materials:** taken from the crafter's bag first, then the party stash (current game DB actor). They are matched by item name; equipped gear never counts.
- **Cost:** each Blueprint has a default cost. Each book has a multiplier per place (Crafter NPC / table / camp, e.g. camp × 0.5). A Blueprint can instead set an exact cost for one place.
- **Locking:** a Blueprint can be locked behind a story switch. It shows as "???" with a hint until the switch is ON.
- **Camp Forge:** one item, then the activity ends. A rest is Attune **or** Craft. Merchant, Tinkerer and Pilot.
- **Banner:** a result banner ("Zarg crafted Remedy ×3") goes to everyone, the crafter included.

## Data

- One world Item, `_Crafting Config`. Its flag `flags.fabula-ultima-companion.craftingConfig` holds `{ campBookId, books: [{ id, name, costRule, blueprints: [...] }] }`.
  - Books and Blueprints are **arrays**, so an update replaces them whole and a deleted book really goes.
  - The item is created the first time someone saves in the Blueprint Editor, with default ownership Observer (players read, GM writes).
  - **No config item exists yet:** nobody has made books, and no NPC is a Crafter. On a pull, the system is on but empty.
- **Crafter NPC flags:** `isCrafter`, `crafterBook`, `crafterQuote`.
- **Crafting spot Region flag:** `craftSpot = { enabled, bookId, name }`.

## For the GM (no code needed)

- **Game Settings → Configure Settings → FabulaUltimaCompanion → "Blueprint Editor"**, or `FUCompanion.api.crafting.openEditor()`.
  - **Books tab:** books, cost rules, Blueprints.
    - Drag items from the Items sidebar or type a name. A name shared with a recipe item picks the real item.
    - Per-place costs, unlock switch, hint, and "Try this book".
  - **Crafter NPCs tab:** drag an NPC actor in, pick its book, write its greeting.
  - **Help tab:** a plain explanation of the above.
- **Crafting table:** draw a Region, then Region Config → Identity → "Crafting spot".

## Code

- `crafting-system/` (loaded by a dynamic import in `director-boot.js`, next to Orbment; no `module.json` entry):
  - `crafting-data.js`: config read/write, cost per place, material counts, `evaluate()`.
  - `crafting-craft.js`: `executeCraft` on the **primary GM**. It re-checks everything, takes materials (`ItemTransferCore` actorToGm), charges Zenit (`adjustZenit`) and IP, and gives outputs (gmToActor, so carry limits overflow to the Party Bag). Players request over the module socket.
    - A camp craft is refused over the socket; only Camp Forge (on the GM, `internal`) can make one.
  - `crafting-window.js`: `CraftPanel` (list, preview, craft) and `CraftWindow` (Shop skin and Shop sounds).
  - `crafting-feedback.js`: the result banner, built on the Orbment banner.
  - `crafting-open.js`: Crafter NPC button, crafting-spot "!", Region Config section.
  - `blueprint-editor.js`: the GM editor and its settings-menu button.
- API: `FUCompanion.api.crafting` (`craft`, `open`, `openEditor`, `setCrafter`, `readConfig`, `saveConfig`, `feedback._test()`, …).

### Shared files touched

- **`orbment/camp-forge.js`:**
  - The `create` placeholder ("Craft basic gear — Soon") is now a working `craft` option.
  - The option buttons on the left are clickable for the operator while picking. The choice is mirrored to spectators in the existing `state` message (`option` and `craft` fields).
  - `runCampForge` loops on a craft request: a refused craft goes back to picking instead of ending the activity.
  - Attune is unchanged (regression-checked: tiles, sockets, Leave, operator reload).
- **`map-system/keyboard-interact.js`:** the overhead row now includes `.fu-alch-prox-btn` and `.fu-craft-prox-btn` (and their layers).
  - Row order: Talk, Shop, Refine, Alchemist, Craft, Inn.
  - **The Alchemist ⚗ button was not in the row before**: it used its own +44/+88 offsets, so it floated at a different height on Shop + Alchemist NPCs (Solveig).
  - The crafting-spot "!" joins the free-button row (rank 4).
- `camp-system/camp-constants.js` + `activities/activity-camp-forge.js`: description text only.

## Tested (private world copy, GM + player client "Trinio")

- **Craft results:** materials taken bag-then-stash, Zenit, IP, multi-output, locked, missing materials.
- **Refusals:** a player crafting for someone else's character; camp crafts outside Camp Forge.
- **Camp Forge:** player operator with the GM spectating (live mirror), operator reload mid-activity, Field Attune regression.
- **NPC row:** Solveig shows Shop, ⚗, Craft side by side; the keyboard menu lists Shop / Attune / Craft.
- **Crafting spot:** "!" shows; the Region Config section shows.
- **Save → craft → load** restores exactly.

**Not tested:** a real session, two GMs, a visible GPU run / listening to the sounds.
