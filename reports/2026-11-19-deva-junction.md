# Deva junction: The Kneeling Colossus, Deva's entrance and Deva Defeated (v1.0.632)

The last of the trio. A new exploration map, **The Kneeling Colossus** (`Valley_Map029`, art `Valley_Map035.png`), sits at the Crossroads junction. A ruined, faceless statue kneels over a sealed gate north to Fafnir's domain. Three rings on the gate show the **Threefold Seal**: Asura (crimson), Deva (gold) and Rakshasa (violet). Deva guards the gate. She chases the party off on their first visit, fights them once Asura and Rakshasa are both beaten, and after her defeat a flashback shows how a benevolent goddess learned to kneel to dragons. The script and staging were drafted with ChatGPT from the user's directions, over 9 rounds of a playable mockup, and approved by the user.

## World data

**New scene** `Valley_Map029` "The Kneeling Colossus" in the Valley of the Dragon folder:
- Exploration mode, grid 110, Storm2 ambience, the Valley camp, tables and wellsprings (copied from the Abandoned Monastery Interior).
- 29 movement walls: a first-pass outline of the plaza and paths for the GM to tune.
- One Ground footstep region.
- Deva's token, hidden on the statue's shoulder, plus hidden marker tokens: Deva Perch, Deva Palm, Gate Shot, Statue Shot and Shoulder Shot.
- 3 seal ring tiles. Each uses Story Gate and hides when its switch turns on: `Asura Defeated`, `Rakshasa Defeated`, and `Threefold Seal Broken` for Deva's ring.
- One step-in event tile on the plaza.
- 4 exit warps (door button):
  - west → West Ridge tile;
  - east → the camp tile;
  - south → the tile below the junction;
  - north (the gate) → the trail north, needs `Deva Defeated`.

**Crossroads** (`Valley_Map013`):
- Link Pgdl–E2sF (the tile below the junction to the camp) is removed.
- Link 6MGz–E2sF (the junction to the camp) is added.
- Link 6MGz–mOP1 (the junction to the north trail) now needs `Deva Defeated`.
- The junction tile **6MGz** is now an **Event tile**. Landing on it teleports straight into the new map, with no prompt and a LOCATION badge. The party arrives **by direction**: from the west branch at the west entry, from the east at the east entry, and so on.

The Crossroads and the Valley theatre scene both list the new map in their networks.

**Forge** (new files, nothing overwritten):
- `Campaign/The Legend of Dragonslayer/Image/Map/Game Map/`:
  - `Valley_Map035.png`
  - `Valley_Map035_SealRing_{Asura,Deva,Rakshasa}.png`
- `Campaign/The Legend of Dragonslayer/Image/CG/`:
  - `Deva_Flashback_1.webp` (a ruined Hindu temple mural)
  - `Deva_Flashback_2.webp`
  - `Deva_Flashback_3.webp`
  - `Deva_Portrait.png`

## What happens in game

The step-in event never runs again once `Deva Defeated` is on. Before that, it does one of two things.

**First visit** (only while `Deva Introduced` is off):
1. The camera goes to the gate. The rings pulse, and the barrier flares and knocks the party back.
2. "Halt." Deva appears on the statue's shoulder. Storm2 stops and **Ambush** plays.
3. She **teleports** down in two hops, to the palm and then in front of the party. Each hop squeezes her into a thin line of gold light.
4. 7 lines, ending with "So long as the three of us stand, this gate shall never yield to you!".
5. She **levitates** straight up while the camera follows her, and a white flash with Flash1.ogg takes her.
6. Ambush fades and the storm returns.

Walking back in plays nothing until both guardians are beaten.

**The fight** (once `Asura Defeated` and `Rakshasa Defeated` are both on):
1. Only the gold ring is left. Deva appears on the shoulder: "So... both have fallen."
2. The same teleport hops bring her down. "...defend it with my very life!"
3. **Awaken** starts with the boss banner **KEEPER OF THE OATH / DEVA** (gold) and carries into the fight.
4. "NOT ONE STEP FURTHER!" → Start Battle against Deva on the Valley battle map. After victory there is no music until the event ends.

**Deva Defeated** (Victory rows):
1. `Deva Defeated` on. She can't believe mortals beat her, then her inner thoughts start, shown in the new thought box.
2. **Flashback**, in 3 pictures:
   - **the mural**: the goddess her people worshipped;
   - **the first conqueror**: the black dragon "???" takes the mountain. She resists, and the picture darkens as the centuries pass ("At last... I learned to kneel.");
   - **Fafnir's offer**: she swears herself to Fafnir.
3. Back in the present: "Lord Fafnir... forgive me..." / "...You are still here."
4. **Show Choices**: **Challenge Her** / **Show Mercy** / **Do Something Else...**. After every answer, a Pause for GM "Free narration".
5. **Pause for GM "How does she leave?"**:
   - **Shaken: loyalty unbroken**
   - **Defiant: loyalty unbroken**
   - **Honorable: respectful warning**
   - **Neutral: cold withdrawal** (default)

   She never lets them pass. Each ending finishes with her levitating away and sets `Deva Outcome <name>`.
6. **The seal breaks** against her will: a flash, the Break sound and `Threefold Seal Broken`, so the gold ring disappears and the north warp opens. Three floating narration lines follow.

If the party **loses**, the Defeat rows are a Free narration pause.

## New engine options (old rows and tiles behave as before)

| Where | Option |
|---|---|
| Show Text | **Think** in the message box is now an inner monologue: see-through, dashed edge, italic, with the name line "*Name* (thoughts)". Bubbles are unchanged. |
| Jump To | **Teleport** style. Along the path lines, the token squeezes into a line of light (170 ms), is gone 140 ms, then un-squeezes at the next point (210 ms), with a gold beam and sparks at both ends. Vanish on the last line lands it hidden. |
| Jump To | **Levitate** style, no path. The token floats straight up (default 1150 px over 2.6 s) with a gold glow, and players' cameras follow it. Near the top, a screen flash (colour field, empty = none) and the landing sound take it, and it is hidden where it stood. |
| Camera | `RowsCamera.followPoint()` lets an effect hold the camera on a moving point. The event's end hands the camera back, as after a pan. |
| Teleporter | **Arrive by direction**: `teleporter.destinationByFrom = { "<neighbour tile id>": <destination> }`. Fast Travel, a missing entry, or an older teleporter all use the plain destination. |
| Dungeon tiles | An **Event** tile now has a landing handler that does nothing to the tile (no grey-out). Landing on one used to log "Unknown tile type". |

## Tests
- 113 test files: 112 pass. `battle-director/crisis-keywords.test.mjs` ("Hooks is not defined") was already failing before this work.
- `message-box.test.mjs`: the thought box name and plain bubbles (54 checks).
- `token-jump-extras.test.mjs`: Teleport along a path with Vanish, and Levitate's flash, sound and hide (90 checks).
- Sandbox playthrough (copy of the world):
  - a real dungeon step from the west tile onto the junction landed at the west entry;
  - the full first visit;
  - the fight lead-in up to Start Battle;
  - the full Deva Defeated with Show Mercy → Continue → Honorable → seal break, with 0 failed rows.
- The event linter has 0 errors.

## Not verified yet
- The Deva battle itself, running into the cutscene.
- A real player client: the menu picked by the main controller, and the camera following the levitate.
- The other three endings and the party-loses path, live. They share the rows that were tested.
- The walls by eye. The arrival from the east, south and north entries, which use the same code as the west.

## Notes
- There is no kneel pose: a thud and a shake stand in when she falls.
- Her roleplay default line "My duty remains... even in defeat." sits in the Free narration note for the GM to read out.
