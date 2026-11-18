# Rakshasa Defeated cutscene + Jump To "self:" and Vanish (v1.0.629)

After the party beats Rakshasa, a JRPG-style aftermath cutscene plays on the Feeding Pit: Rakshasa can't believe he lost, a flashback picture shows Fafnir recruiting him with the promise of a thousand-year feast, the players get a short answer menu, and the GM picks how he leaves. It is the counterpart of Asura Defeated (v1.0.627) and uses the same rows (pictures, message box, quiet return). The script and the staging were drafted with ChatGPT from the user's directions and approved by the user after a playable mockup. The only new code is two Jump To options.

World data: **one scene only**, the Feeding Pit (`Valley_Map020`, `XNTSewM1NcPG59L1`). The Victory and Defeat rows of both Rakshasa Start Battle rows are replaced: the one in the entrance tile's "Fight" choice and the one in the talk-prompt token's. No tokens, tiles or markers are added. The picture and Rakshasa's portrait are on Forge under `Campaign/The Legend of Dragonslayer/Image/CG/` (`Rakshasa_Flashback_1.webp`, `Rakshasa_Portrait.png`); Fafnir's portrait was already there.

## What happens in game

1. The battle ends and the fanfare plays. **The map is silent** through the whole cutscene ("After victory: no music until the event ends").
2. Rakshasa and the party turn to face each other, letterbox in, two-shot. Rakshasa (slow text, his portrait): "GRRRR...!" / "How could a mere mortal be so strong...?!" / "Lord Fafnir... you have doomed me...!" / "You... You promised I would never go hungry again...!"
3. **Flashback**: fade to black, the picture comes up full screen in "Faded memory" with a slow push-in, Darkness ambience and thunder. Rakshasa kneels before Fafnir's dragon shadow. Fafnir (6 lines, archaic) and Rakshasa (3 lines) in the see-through box; the picture darkens a little when she gloats.
4. Back to the present: "GRRR...! But now... what am I supposed to eat...?!" / "You... YOU ruined everything!!" (shout).
5. **Show Choices** for the players: **Threatened** / **Mercy** / **Do Something Else...** (the roleplay answer; the GM resolves it as either reaction or No branch). Each answer has two Rakshasa lines.
6. After every answer: **Pause for GM "Free narration"** with Continue, so the table can roleplay.
7. **Pause for GM "How does he leave?"**:
   - **Swayed: reluctant retreat**: 3 lines, he turns to the pit and leaps down into it.
   - **Enraged: vows revenge**: 2 shouts, roar, lightning flash, smoke slam, he leaps out of view upwards.
   - **Fearful: flees Fafnir**: 2 lines, a glance up the stair, then he crashes through the fence into the pit.
   - **Neutral: withdraws** (default): 2 lines, he jumps backward into the pit.
   Each ending sets the story switch `Rakshasa Outcome <Swayed|Enraged|Fearful|Neutral>` (nothing reads them yet), and every ending leaves his token hidden.
8. Letterbox out; the scene's storm ambience returns when the event ends.

If the party **loses**, the Defeat rows are a single Free narration pause with "Continue". `Rakshasa Defeated` stays OFF.

## New Jump To options (old rows behave as before)

| Option | What it does |
|---|---|
| Path line **`self:dx,dy`** | Like `party:dx,dy`, but measured from where the (first) jumper stands when the row starts. Accepts the same `@Token` mirror suffix. Needed here because Rakshasa lands beside the party wherever they dodged the hand, so the pit is never at a fixed spot. |
| **Vanish** (`fadeOut`, hop style) | The last hop fades out over its second part (from 65 % of the flight) and the token lands **hidden** in the same update, so it never pops back at the landing point. For jumps that leave downwards, like into a pit. |

`Jump.parsePartyOffset` now returns `{ anchor: "party" | "self", dx, dy[, mirrorRef] }`, and `Jump.resolvePoint` / `resolvePath` take the jumper as a new last argument. Event lint accepts `self:` lines.

## Note: Screen Effect flash has no strength
The flash always peaks at full opacity; a `strength` value on a flash row is ignored. This was already true for Asura Defeated. The lightning flashes here are kept short (0.25 s) instead. If a dim flash is ever wanted, that is a small option to add.

## Tests
- 113 test files: 112 pass. The one failure, `battle-director/crisis-keywords.test.mjs` ("Hooks is not defined"), was failing before this work.
- `token-jump-extras.test.mjs` extended: 81 checks (self: lines, Vanish on the last hop only, hidden in the same update, off by default).
- Sandbox playthrough (copy of the world): the full run, Threatened, Mercy, Do Something Else → No branch, the Free narration pause, and all four endings, with no failed rows. The event linter is clean on the scene (one older note about the entrance's Run Check).

## Not verified yet
- A real battle into this cutscene (the quiet return was measured on Asura's fight with the same option).
- A real player client: the Show Choices menu picked by the main controller, and the leap into the pit on a player screen.
- The party-loses path, live.
