# Eisendrache capital: ruined state cleanup (v1.0.647)

## What was wrong

Since the Fafnir attack, the party can fast-travel back to the capital. The town
square was already consistent (ruined art and music, survivor lines on every
villager, festival NPCs and stalls hidden). Inside the buildings, and in a few
other places, the capital still read as the festival town:

- Every NPC inside the shops, the inn, the castle rooms and the houses had no
  dialogue at all.
- Pomme still ran the capital item shop, although she has moved to Ruhig
  (Return to Ruhig, v1.0.638).
- "RaiRai Party A", the Zenit Crisis save's party token, was standing in the
  ruined square. It was placed there before the save/load system existed.
- The castle gate guard still said "His Majesty is expecting you" after the
  audience was over.
- King Seigfried stood silent in the throne room after the audience.

## What changed (world data only, scenes store)

- **21 interior NPCs** (Wagner's weapon shop, Roselie's accessory shop, the item
  shop, Thomas's inn, the castle library and kitchen, three houses) each have one
  survivor line. The talk event is offered only while the switch
  **Eisendrache Destroyed** is ON, so the festival state is unchanged. Shopkeepers
  keep their shop button.
- **Throne room knights A and C** have one generic line each.
- **King Seigfried** (throne room) has a Story Gate: shown on **King Summon**,
  hidden on **Rescue Hilde**. The audience event now fades out before it sets
  Rescue Hilde and fades back in, so the King leaves off-screen.
- **Pomme A** (capital item shop) has a Story Gate: hidden on
  **Eisendrache Destroyed**. In the ruined state the capital has no item shop.
- **RaiRai Party A** token deleted from Eisendrache Kingdom.
- **Castle gate guard**: once Rescue Hilde is ON he says "You may pass. His
  Majesty's orders still stand for you." and still lets the party in.
- The 11 changed scenes were re-blessed (preflight goldens).

Also in this push: the Valley trio commit (story Start Battle rows for Asura /
Rakshasa / Deva now load arenas 005 / 006 / 007). It lives in the same scenes
store, so it cannot travel separately.

## What you need to do

- **No restart needed.** No new scripts.
- **Your save slots:** a slot snapshot holds full token data for the capital and
  its shop/inn interiors. Loading an older slot puts RaiRai back and removes the
  new NPC lines and gates on those tokens. After loading one, re-save it, or ask
  us for the patch script (it updates slot JSON offline).

## Tested

Sandbox copy of the world (headless GM): all 23 lines are offered in the ruined
state; Pomme and the King are hidden; RaiRai is gone. Played live: Thomas,
Wagner, both knights, and the gate guard (new line, then fade into the throne
room with no King). Not played: the audience fade (it can't trigger once Rescue
Hilde is ON). Not tested on a player client.
