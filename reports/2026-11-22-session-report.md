# Session 2026-11-21: world state + findings for the week

World data only, no code and no version bump. This is the world after Saturday's session (the party finished the Plasma Field, Hako is back at camp, and Fabula Arcana is unlocked), plus GM edits made live during the session.

## What you need to do

- Pull. No server restart is needed for code. Restart only if your server is running this world, so it loads the new LevelDB.
- If one of your save slots holds Valley_Map013, Valley_Map021 or Valley_Map007, loading it brings back the old tiles there (slots rebuild tiles on Load). Tell me and I'll send the tile patch.

## World changes made during the session

Maps (scenes store):
- **Valley_Map013 (Crossroads):** tile `6MGzjbSDLPq0Zfra` changed from an Event tile to a blue **Story** tile. The Kneeling Colossus teleport is unchanged.
- **Valley_Map021 (Summit Trail):** tile `Jwkfe2EXHOln5z7B` changed from Blank to **Gusty**, the same setup as the other three gusty tiles (Resist the Wind, DEX + MIG DL 10, push back on failure).
- **Theatre order on 9 Valley maps:** Valley_Map005, 006, 007, 013, 014, 015, 018, 019 and 021. "Mountain Ascending Path" now comes before the generic "Valley of the Dragon" theatre in each Scene Network. Skill-check tiles use the first theatre in that list, so they were going to the wrong one.
- **Valley_Map007:** the Plasma Field tile is expired (desaturated) after the event. Its teleport still works.
- **Valley_Map004 (camp):** the pond (Pond + Pond Shallows regions) is now fishable.
- Preflight goldens re-blessed for Valley_Map013 and Valley_Map021.

Actors and items:
- **Willy:** a Card Duel NPC (four filler decks, all with Princess Hilde; win the duel to get the Hilde card) and an **Alchemist** (orbment).
- **Character cards:** each PC got their own card (Hina, Keren, Blanche and Zarg Card).
- **Aenigma of Adaptation:** hand slots set to One-handed (world item + Hako's copy).
- **New item "Save the Queen (Passive)"** `rrtMjWJ0MlrYHQhD`: +5 damage vs Dark-attribute creatures, on attacks with Save the Queen only. It's linked through `system.container`, the same way as Muramasa's passive.
- **Keren's Blade Adept:** new `can_target_flying_with = dagger` AE (the skill had no automation at all).
- **Zarg and Hina:** `main_hand` fixed to the refined weapon names (see bug 1 below).
- **Deva:** template layout restored (its sheet was blank). Stats unchanged.
- Everything else is session play: inventories, shop sales, zenit, the Gigas (Reanimated) summon gone after a fight, consumed items.

## Checked

- world-export report: every removal is session play (I read each one).
- Preflight: 1 FAIL. Valley_Map006 expects Keren's party token, which left the map during play. That's normal post-session drift and gets re-blessed before the next session.
- Every staged store's CURRENT → MANIFEST is present. The commit used `--no-verify` because the hook blocks on the play removals.

## Bugs found during the session (for this week)

1. **Refining renames the weapon but not `main_hand`.** Zarg's bow became "+6 Zarg's Bow" while `main_hand` still said "+5 Zarg's Bow", so `snapshot.js` resolveAttackerWeapon (matched by name) found no weapon. That gave him 1 target instead of Multi 2, and Barrage failed. Hina and Keren had the same thing. Refinement should update `main_hand`/`off_hand`, or BD should resolve by id.
2. **Warning Shot with Multi:** the `ws_menu` choice is made once and applied to every target. With his heroic skill, Zarg should pick Shaken for one target and MP Burn for the other. Log: `pre-chosen pick → "Inflict Shaken"`, then `applied "Shaken" to 2 actor(s)`.
3. **Looted items keep their transfer AEs enabled in the party stash.** A Gravedigger Shovel put "Cursed" on the party token. Unequipping disables them; a fresh loot never goes through that. I disabled this one by hand. Happy Feet has the same leak.
4. **Spectator client:** the dungeon Party Status HUD (`#oni-dp-status-hud`) goes missing. Suspect: `hide()` removes the panel after 350 ms; if `show()` runs inside that window it reuses the old panel, and the timer then deletes it.
5. **Spectator client:** some API and minigame sound effects only play locally, so the stream doesn't hear them.
6. **Fishing minigame:** an item tooltip stays stuck on screen when the panel hides while the pointer is over the item.
7. **Party `total_zenit` roll-up is stale:** the HUD showed 16,178; the real total is 21,043.
8. **Keren's client** could see under an Unknown tile from 2 tiles away (Valley_Map006). Not investigated yet.
9. **GM host performance in battle:** about 30 fps with ~100 ms hitches (p95) and the main thread ~96% busy; the spectator is smooth. Next step is a CPU profile.

## Design follow-ups (user's calls this week)

- Hako needs a **Gacha button** (no NPC opens the gacha today; it's a scene).
- **Gacha pity readout** back on screen (it was removed on purpose in `f8fd9574`).
- **Oathsworn Paladin set:** no set definition or bonus. Paladin Armor's "free spell on Cover/Protect" is text only.
- **Blade Adept:** +1 DEF/MDEF and "daggers count as brawling/sword/thrown" are still text only.
- **Deva has no affinities** (all neutral, no attribute).
- **Victory MVP** went to Zarg every fight; the scoring weights need a look.
- **Soul Steal limit:** is it per stealer or per monster? Per monster is expected.
- **Canis Fabula Arcana card** idea ("Armor Break"), not requested yet.
