# Asura and Rakshasa entrance cutscenes (v1.0.621)

Two boss entrance cutscenes, approved by the user after a playable mockup and a sandbox playthrough. They are built entirely from Event rows (no one-off script). The rows they needed were added as general options that any event can use.

World data: **two scenes only**, Abandoned Monastery Interior (`Valley_Map017`, `YnGINTK5qxtt0rnO`) and Feeding Pit (`Valley_Map020`, `XNTSewM1NcPG59L1`). Each gets new tiles, hidden tokens, event rows and a `storyBgm` flag. No actor or item changes.

## What happens in game

**Asura** (party walks up the hall past the elephant statues):
1. The party gets a "!" emote, the Storm2 ambience stops, and the camera pans up to a new Buddha statue.
2. The lights dim and a slash flurry plays. The cut lines hang for a moment, then a sheathe click and a flash, and the statue is sliced: the top falls apart and the stump stays.
3. Asura fades in behind the rubble and leaps out of the frame. The camera whips down and he crashes in front of the party, with Guilty Gear dust.
4. A Fabula Point is awarded (Villain Entrance). Awaken starts, a boss banner pushes in on his face, he roars, and he speaks three shout lines.
5. GM choice: **Fight** starts the boss battle, and Awaken carries on into it. **They talk Asura down** sets the switch `Asura Spared`.

**Rakshasa** (party reaches the north landing, where the chest is):
1. The party gets a "!" emote, a rumble starts, and the camera pans down into the pit. A giant Yaksha hand rises out of it.
2. The hand bursts up beside the party and the screen tints red while everyone rolls DEX + INS against DL 11.
3. The hand smashes down and the whole party leaps aside. Anyone who failed takes 30 physical damage, with no damage card. A critical counts as a dodge and opens the usual Opportunity picker; the event waits for it.
4. Rakshasa's black silhouette leaps out of the pit and lands beside the party. Its tint fades away to reveal it, a Fabula Point is awarded, and then come the banner and four slow lines.
5. GM choice: **Fight** or **Leave it standing** (`Rakshasa Spared`).
6. The hand appears on the side the party came from (mirrored when they arrive from the left), and the dodge and landing follow it.

**After sparing a boss:** while `<Boss> Spared` is on, that scene's music is Awaken instead of Storm2, so it is still playing when the party leaves and comes back. Talking to the boss (the "!" button on its token) repeats its lines and the GM choice. A victory turns `Spared` off and `<Boss> Defeated` on, and hides the token.

## New and changed Event rows (all optional; old rows behave as before)

| Row | Change |
|---|---|
| Play Animation | **Hold the last frame** (`hold`, `holdName`) until a Stop Animation row or the end of the event. **Mirror** when the party stands left of a named token (`mirrorLeftOf`). |
| Stop Animation | New row. Removes a held animation by name. |
| Screen Effect | `letterboxIn` / `letterboxOut` bars, and `untint` (lifts a dim or tint but keeps fades and letterbox bars). |
| Camera Pan | `twoShot` mode frames the party plus a named token. With no name it holds on the party alone at the row's zoom. |
| Set Token | Show with a fade, a rise and a crouch (`fadeMs`, `risePx`, `crouch`). Tint fade (`tintFadeMs`). |
| Set Facing | `towardParty` / `towardToken`. |
| Jump To | `style`: hop, leapOut or dropIn. `dust`: Guilty Gear dust on take-off and/or landing. Path lines `party:dx,dy` and `party:dx,dy@Token` (dx turns round when the party is left of that token). |
| Set Tile | New row: show / hide / opacity / image / slice. Tiles get a "Tile name" field. A slice is saved as a mask flag on the tile, so the broken statue stays broken after reloads and saves. |
| Run Check | Remembers who passed and who failed. New targets: "Failed the last check" and "Passed the last check". The GM chip shows "Opportunity: X is choosing". |
| Deal Damage | `quiet`: no damage card or numbers. |
| Show Text | Style (normal / shout / think) is now kept on save. New slow text speed. |
| Boss Banner | New row: a name card plus a push-in on the boss's face. The next row waits until the card has gone. |

## Other changes

- **Show Text portrait:** a token whose art is a video (a battle idle `.webm`) now shows the actor's picture as its portrait instead of a broken image.
- **Battle music (`director-vfx.js` `playBattleBgm`):** if the battle's track is already playing, it carries on instead of restarting from the top. Other tracks still stop.
- **Opportunity system:** `processCheckCrits` fires `oniOpportunityCheckOffer` (open / closed) around each picker.
- **Event lint:** knows the new Jump To forms, and warns on a Start Battle with no battle map or no enemies.

## New Forge files

- `Campaign/The Legend of Dragonslayer/Image/Map/Game Map/Valley_Map024_BuddhaStatue.webp`
- `Animation/Event VFX/Slash_Flurry_White.webm`
- `Animation/Event VFX/Yaksha_Hand_Rise.webm`
- `Animation/Event VFX/Yaksha_Hand_Loom.webm` (referenced as `?v=2`)
- `Animation/Event VFX/Yaksha_Hand_Slam.webm` (referenced as `?v=2`)
- `Sound/Slash_Flurry.ogg`

## Tests

- Node: event-kit 177/177, plus new suites media-extras, tile-slice, token-jump-extras and check-text-banner (131 checks), all passing.
- Sandbox world (GM, view as player), user watched live:
  - Both cutscenes end to end.
  - Both GM choices, and the talk-again loop.
  - Fight starts the battle on the Valley battle map with Awaken carrying on.
  - Only the people who failed take the damage.
  - An Opportunity picker mid-check: the event waits, then resumes.
  - The hand and landing from both sides.
  - The story music swaps to Awaken.
  - Event lint is clean.

## Heads-up

- **Pull:** please pull and import the world. The two scenes' new tiles and tokens are world data.
- **Bar Brawl:** the hidden boss tokens are created with empty Bar Brawl bars, matching the party token.
- **Not yet seen at a real table with player clients.**
