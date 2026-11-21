# Return to Ruhig + Fabula Arcana intro (v1.0.638)

The rebuilt Ruhig (`Ruhig_Village011`) gets its story: Rume welcomes the party back, Pomme minds Rume's shop, Geist has left a letter in the blue-tarp house (`Ruhig_Village008`), and Willy introduces Fabula Arcana. **Fabula Arcana is now locked until Willy's duel**: before that, players see no Card Duel or Challenge buttons, get no card drops and have no Cards tab.

## What you need to do
- Pull and restart the server (new script files in `module.json`).
- Nothing else for the world: the scenes and the new actor ship in the world data commit.
- **Your save slots:** a slot that holds `Ruhig_Village011` would, on Load, delete the new Pomme, door and welcome objects and put back Rume's and Willy's old talk rows. I patched my slot 1 (the only one of mine holding that scene). If one of yours holds it, say so and I'll send the merge (new tokens/tiles in, Rume and Willy token flags updated, nothing else touched). `Ruhig_Village008` isn't saved by slots, and actor flags merge on Load, so Willy keeps his duelist setup.

## In the game
| Where | What |
|---|---|
| Ruhig_Village011, spawn | Step-in welcome (once, switch `Ruhig Welcome`): Rume walks over from the plaza, welcome lines, Free narration, then she walks to the grape field and stays there. |
| Ruhig_Village011, Rume's token | Three talk lines at random. Her shop button is off on this token only (`flags.<mod>.noShopButton`); her actor is still a shop. |
| Ruhig_Village011, new Pomme token | Actor **Pomme (Ruhig)** (new): Rume's shop stock + Apple Juice, Pomme's clean sprite (`Image/NPCs/Pomme_Standard_NoShadow.png`, new Forge file). First talk 4 lines (self switch A), then one of 3 at random. Pomme's capital shop is untouched. |
| Ruhig_Village011, Willy's token | Willy's First Duel (below). Afterwards: his old line, and he takes rematches (`faDuelist`, needs `Fabula Arcana Unlocked`). |
| Ruhig_Village011, blue-tarp door | New step-in teleporter into Ruhig_Village008. |
| Ruhig_Village008 | Geist's letter on the bed + examine point (tier important), shown while `Geist Rescued` is ON and `Geist Letter Read` is OFF (Story Gate). The scene plays once: letter as Floating Text, then Rume walks in, finds the bed empty and storms out. A hidden Rume token lives on this scene for it. |
| Ruhig_Village008 exit | Was a Monk's teleporter straight to the old village; now our teleporter to the same spot, so the place redirect lands on whichever Ruhig is current. The Monk's tile is switched off, not deleted. |

**Willy's First Duel:** invite → Duel! / Not now / roleplay (the GM resolves it; "No branch" shows the menu again) → **Show Tutorial** "fabula-arcana" (6 pages) → every party member gets the starter set (once) → **Card Duel** vs Willy (Wolf / Salamander / Mana Ray, Casual, Best of 1) → win / loss / draw lines → `Fabula Arcana Unlocked` ON. Leaving the duel before it's decided cancels it: nothing unlocks, the next talk asks again.

## Code
- **System Tutorial** (`scripts/system-tutorial/`): the Conflict Event rules card is now a shared panel. `FUCompanion.api.systemTutorial.register(id, { title, kicker, accent, aspect, pages })`, `.open(id)`, `.showToEveryone(id, { waitFor })`. The Conflict Event panel uses it (same look, keys and sounds; I still closes it).
- **Event rows:** `Show Tutorial` (pick a registered tutorial; waits for the Main Controller) and `Card Duel` (opponent token, team, AI, Best of, quote; result variable 1 win / 2 loss / 3 draw / 0 cancelled).
- **Fabula Arcana:**
  - `fa-const.js` `UNLOCK_SWITCH` / `faUnlocked()` gate the NPC Card Duel and camp Challenge buttons, card drops (`rollCardDrops` returns nothing and counts no pity), and the party menu's Cards chip. The GM is never locked out.
  - `fa-event.js` `eventDuel()` / `grantStarterToParty()`. Event duels settle when their window closes, never count a leave as a loss, and show Leave only (no Rematch).
  - **Bug fix:** the starter gift could hand out Aero Gorger and Sylph (future unlocks, not in the bestiary). The pool is now the 10 launch commons.
- **Story Gate:** tiles take `shownWhen` / `hiddenWhen` like tokens (`openedBy` still wins). 4 new tests.
- **Shop:** `flags.<mod>.noShopButton` on a token hides that token's shop button.

## Checked
- Tests: story-gate (all pass, 4 new), fa-drops and fa-engine all pass.
- Sandbox copy of the world, GM + a player client (Blumairwen), everything driven as the player:
  - **Welcome:** fires on arrival through the Overworld door (the place redirect works), Free narration continue, Rume ends in the field, switch ON.
  - **Pomme:** first talk, then the random lines; shop lists all 11 items (Apple Juice 10 z ×10, 30 HP).
  - **Rume:** in the field, no shop button, random line.
  - **House:** door in, letter scene end to end (lines stack mid-screen, Rume's staging, Free narration). Afterwards `Geist Letter Read` ON, letter and examine point hidden, Rume's house token hidden again. Exit lands on the rebuild map.
  - **Willy:** Not now → short invite next time. Roleplay → No branch → menu again. Duel! → tutorial on both screens (Done closes both). Starter sets given once (3 cards each, a second run gave none). Duel cancelled → result 0, nothing unlocked. Duel won → win lines, switch ON, his row shows Talk / Shop / Card Duel.
  - **Locks:** with the switch OFF, a player has no Card Duel button and no Cards chip, and a battle drops no card; ON, all three come back.
  - **Conflict Event:** its pages render in the shared card and I closes it.

## Owed
- A real-table look: the welcome on a real arrival, the letter scene, Willy's duel with real players watching.
- No NPC duelists are set up in the world yet besides Willy.
