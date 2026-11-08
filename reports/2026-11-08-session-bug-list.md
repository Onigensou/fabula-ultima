---
id: 2026-11-08-session-bug-list
title: Bug and to-do list from the 2026-11-07 table session (17 items)
status: open
severity: major
reporter: onigensou
assignee:
component: several (see each item)
introduced_in:
fixed_in:
---

# Bugs and to-dos from the 2026-11-07 session

Written for sarunphat and the Claude session that runs the pull. These were reported by players during a live
session on v1.0.563. The host worked around each one at the table, so none of them blocks play. **No code was
changed for any of this.** Most items are only the reported symptom plus where we would look first. They have not
been reproduced in a sandbox yet.

**Taking an item:** tick it, then add your name and the commit in **Notes** at the bottom. Notes is append-only so
both sides can see who is doing what. Either side may take any item. Items marked **(cause found)** have been
traced in code.

## Battle

- [x] **1. Break Free picker opens on the GM, not the grappled player (cause found).**
  When Hina tried to break free from Grapple, the picker opened on the GM's screen. Rinri, her player, was online
  with a healthy client and saw nothing. The cause is that `state-handlers.js maybeRunBreakFree` calls
  `pickAttributePair`, and `attribute-pair-picker.js` says it is "client-local", so it runs on the battle host.
  That picker was built for Hinder, where the rules have the GM choose the pair. Break Free reuses it. This is a
  design decision: should it go to the grappled actor's owner, with the GM as fallback?
- [x] **2. Hina's Protect prompt went to the GM instead of her player (cause found).**
  Another pill's re-check reached Protect's pick before the Apply's own and opened it without routing. See Notes.
- [x] **3. Ripple triggered twice on one Bimagus cast. It should trigger once.**
  Likely Ripple reacts to each `creature_completes_spell`, and Bimagus casts two spells. It probably needs a
  once-per-action guard.
- [ ] **4. Bimagus showed a "FX: please select at least one token" notification and seemed stuck.**
  It went through on its own after a while. That text is not in `modules/` or in the world macros or items, so its
  source is unknown. Check what the Bimagus flow and its animation script run.
- [x] **5. Roper was Provoked by Blanche but targeted Zarg.**
  Check which Roper action ran first. Its Reel or grapple follow-ups may not go through target choice by design, so
  read the Roper dossier before calling it a bug. Otherwise check the enemy AI's target filter for Provoked.
- [x] **6. Blanche's Counter Pass only offers Muleta.** It should offer all her Pase skills. It is probably a
  hard-coded skill or a filter that matches only one skill.
- [x] **7. Descabello is missing its half-level damage.**
  Its `damage_bonus` is `30 + floor(CHAR_LEVEL/2)`, but the hit landed without the half-level part (Blanche is
  Lv 44, so 22 was missing). Check that `CHAR_LEVEL` resolves on the BD damage path. Also, the skill text says the
  base becomes 40 at SL 20 and 50 at SL 40, but the formula is fixed at 30. The host should decide whether those
  enhancements apply.
- [x] **8. Zarg's Quick Change to his bow didn't reach his battle menu.**
  The actor data showed the bow equipped and the staff unequipped, but Trinio's menu still showed the old weapon,
  even after `refreshTurnActions`. Check the snapshot and weapon cache after a mid-turn swap
  (`snapshot.js resolveAttackerWeapon`, `equipment-swap.js`) and the player HUD refresh.
  **Probably fixed by your v1.0.564 (`35bb8010`, "Mid-turn gear changes reach the Attack menu"), which arrived the
  morning after the session.** Leave it open until it is checked live in a real fight.
- [x] **9. Rakshasa's Form Shift doesn't tell the table which weapon it switched to.**
  The stance effect (for example Throwing Stance) is applied, but nobody could see it. This answers the dossier's
  open question "is the stance readable at the table" with a no. Also, a GM-applied **Weak** (Rakshasa is RS to
  Weak) disappeared shortly after it was applied. Check whether Form Shift or something else removes it.
- [ ] **10. Keren's Life Transference formula may be wrong.** The player is **not sure**, so verify the formula
  against the skill text first.
- [x] **11. Study no longer shows the enemy's stealable items. This is a regression.**
  Check the Study card's read of steal data, and whether the 11-06 change that made Valley gacha items unstealable
  (`e9aed725`) touched the list it reads.

## Items and equipment

- [x] **12. Potion Rain does nothing.** No MP was restored. The GM gave the MP by hand.
- [ ] **13. Maid Cap plus Zarg's heroic skill should make Create Elixir cost 1 IP. It charged 2.**
  Check how Create cost reductions stack.
- [x] **14. Glacial Staff's spell isn't linked (data gap).**
  The description says "You may cast Icicle Lance", but the staff has no linked `_skill`, so equipping it adds
  nothing to the Spell menu. The world Glacial Staff (`FRwmrAhwe8xSLEXZ`) is missing the link. Zarg's copy was
  patched live, but that patch is not in the repo yet. It is worth sweeping all gear whose text says "cast the
  spell" for the same gap.
- [x] **15. Paladin Armor needs automation (feature).**
- [x] **16. Opportunity "Advantage" outside battle can't target a party member.**
  The picker only offers tokens on the canvas, and in dungeon mode the whole party is one token. The GM applied
  the effect by hand. Suggested fix: outside battle, pick from the party's members instead of canvas tokens.

## Dungeon

- [x] **17. A cleared Dirt tile still shows the Use button when the party steps back on.**

## Also seen (low priority)

- An assistant GM (GM II) saw no dungeon tiles on Valley_Map009 while the main GM and the spectator saw all of
  them. It was not traced.
- Level-up spends leave no lasting record. The level-up system only writes a console line, so working out which
  skills players bought needed item timestamps. A chat line or ledger entry would help.

## Notes

- 2026-11-08 onigensou: filed after the session. The host will take items during the week as time allows.
- 2026-11-08 sarunphat (Claude): took 1 and 7, fixed locally, not committed yet. 1: Break Free goes to the grappled actor's player through `remotePick` (GM copy races it, GM-local when no owner is online); the player copy keeps DL 10 and refuses a pair without MIG or DEX. Also fixed: its chat line never posted (`rollObj` undefined). 7: Lv 20 / Lv 40 steps added on the world item, Matador and Blanche (Blanche Lv 45: 52 -> 72). The missing half level did NOT reproduce: compute gave 52 = 30 + 22 on her real actor before the edit, so what the table saw is still unexplained.
- 2026-11-08 sarunphat (Claude), Battle pass, local and not committed: 5 fixed (a Provoked creature's own effect rows, e.g. Reel, now reach only the provoker; action-level pins already held: seeded Roper battles, 0 provoked actions without Blanche). 6 fixed (Counter Pass lists all six Passes, short Adoration greyed; Verónica greyed as "Reaction only"). 9 fixed (stance icons + buff tag, so they show; Weak on an RS creature now pops "RESISTED", it still lasts 1 turn by rule). 11 fixed (Study card Notes tab: "Can be stolen"). 8 checked on the runner, all four gear-change cases fresh; still needs a real fight. 10 no change, formula and trigger match the text. Open: 2 (needs a 2-client repro), 3 (rider works in isolation, did not reproduce; a warning now logs when it is skipped), 4 (text is in no file we ship; Bimagus' animation already returns at once with no caster).
- 2026-11-08 sarunphat (Claude): item 1 verified with a GM + player client on the Staging World (7/7): the picker opens on Rinri's screen as a FREE CHECK with no DL row, refuses INS + WLP, her MIG + DEX reaches the GM, the chat line posts and the GM's copy closes. Item 2 not reproduced in 3 two-client runs: the enemy AI never made a multi-target attack on two of Hina's allies.
- 2026-11-08 sarunphat (Claude): item 2 fixed locally, not committed. Reproduced with a GM + Rinri client on the Staging World (a Bandit Mage forced to cast Umbra at Hina, Keren and Test Target Ally): the GM got the "which ally" picker and Rinri got none. Cause: when a player applies a reaction, the card re-checks every applied reaction, and another pill's Skip starts the same re-check at about the same time. That second re-check reached Protect's still-open pick first, and it carried no routing, so the pick opened on the GM only. The Apply's own pick then waited behind it. Fix: the routing is now stored on the reaction itself, and the pick opens only once. `card-mutations.js` (`resolveRedirectSubjects`, `pickRouteFor`, which also covers redirect destination, shield redirect and add_target) and `action-card.js` (`runPillDecision`). Verified: `tools/fvtt-playwright/scripts/_pv-protect.mjs` passes 13/13 with the other pills already answered, 13/13 with them still open, and 16/16 when Rinri presses Back and applies again. Regression check clean (494).
- 2026-11-08 sarunphat (Claude), rest of the list, local and not committed:
  - 12: the spread works. On the Staging World, Trinio applied Potion Rain on his own screen and Zarg and Hina each got 35 MP (`_pv-potion-rain.mjs`, 8/8); the runner sim agrees. One real defect found: when no other ally can be reached, Apply quietly reverted with no message. It now tells the player why (5/5). What went wrong at the table is not proven; please note who was in the fight next time.
  - 13: no bug. Zarg's Maid cap is not equipped in the world (his accessories are Apple o' Archer and Ninja Log). With it equipped, the card takes Elixir from 2 IP to 1 (Deep Pockets already makes the menu price 2). Separately, the Maid cap's passive carries a second -1 IP effect, named "Deep Pockets", that never applies. It was left alone; if it ever started applying, Zarg would get the discount twice.
  - 14: the world Glacial Staff now has its Icicle Lance linked, copied from Zarg's working copy (`HvZLpWcS87pzh7b8`). Verified on Staging: the staff shows the spell, and so does a fresh copy given to an actor. Sweep: 10 more gear items say they cast a spell but have no link: Nightmare Scepter, Lightning Wand, Shield of Egis, Adept Ice Wand, Curse Mallet, Fire Wand, Reaper Scythe, Fairy Ring, Ice Wand, Hypno Pendulum (that one has a use-effect but no related list). Not linked yet; that is authoring, so the host decides.
  - 16: outside a battle, Advantage now picks from the party's members (Hina, Keren, Blanche, Zarg) instead of tokens on the map. Tested on Staging: the effect landed on Blanche.
  - 17: once a tile is spent (cleared to blank), landing no longer shows Use. The tile keeps its "usable" setting, so a dungeon reset brings the button back. Checked in code only.
  - 3: still open. The Ripples free attack carries the "end the hex" step on every code path I traced, and I could not trigger Ripples headless. The two reports are probably one bug: if the hex isn't removed, the second Bimagus spell qualifies again. The warning data-92 added will say which part was missing next time.
  - 15: not started. There is no trigger for "after you Protect someone". It needs a new one, plus a free non-offensive spell locked onto that creature. Waiting for the host's go.
  - Regression check clean (494), formulas clean.
- 2026-11-08 sarunphat (Claude): 3 fixed locally, not committed. Reproduced in a real battle on the Snapshot Runner and on the Staging World (Hina's Bimagus, Iceberg then Glacies, at a hexed Test Target Enemy, with Blanche's Ripples). Bimagus queued its second spell at the card, before the first spell's damage set off Ripples, so the second spell went first: it got the hex bonus, Ripples queued a second time, and only then did the first Ripples attack end the hex. Fix: `free-action-queue.js` lets a free action that follows a finished spell (`creature_completes_spell`; Bimagus is the only one in the world) wait behind the reactions to that spell. Now: Ripples once, hex ends, Glacies without the hex bonus and with no second Ripples. If the Ripples attack misses, the hex stays and Glacies can set Ripples off again; that is the rule. Regression check clean (494), formulas clean.
- 2026-11-08 sarunphat (Claude), last pass, v1.0.568 + a world commit:
  - 15 Paladin Armor, built. "When you Cover or Protect another creature, you may cast a non-offensive spell targeting that creature as a Free Action" is a transfer AE "Paladin Armor" on the world armor and on Blanche's +5 copy (nothing on the gear's own props). After Blanche applies Protect, a "Paladin Armor" pill appears on the same card; after a Guard that covers an ally, it appears on the Guard card. Applying it gives her a free Spell action whose list holds only non-offensive spells and whose target must include that creature. Engine: the "after a skill" cascade now knows which creature a redirect acted for, free-action lists accept `kind:non_offensive`, and a free spell can be locked onto a creature. Tested in real sim battles on the Snapshot Runner (Protect, Cover, Guard without cover: 3/3), plus the picker, the target pin and the server-side refusal of an offensive spell. Both review gates ran. Not tested in a real two-client battle: the spell list and the pin on the player's own screen.
  - 14 sweep: 6 of the 10 linked. Exact copies: Lightning Wand (Fulgur), Ice Wand (Glacies), Fire Wand (Ignis). Built to the item's own text: Adept Ice Wand (Glacies Alta, 20 × T MP, HR + 20, Opportunity Slow), Curse Mallet (Hex, 5 × the target's status effects, × 3 from round 7), Reaper Scythe (Death, 20% to drop a non-Undead, non-Champion creature to 0 HP). Shield of Egis, Fairy Ring and Hypno Pendulum were already linked (Aegis Field, Charm, Sleep). Roselie's own Hypno Pendulum copy has no Sleep. **Not done: Nightmare Scepter.** Its spell needs two things the engine doesn't have: damage of 15% of the target's max HP, and damage that doesn't wake a sleeping target. Hex and Death count as "aid" spells, like Solar Beam does today, so "when an enemy harms an ally" reactions such as Protect don't trigger against them. Fixing that rule would change 19 shipped skills, so it is left for its own pass.
  - 8 checked on the Staging World (real server, GM client only) through the same four gear-change cases: fresh at every declaration, 4/4. It was a sim-driven fight, not a human clicking the menu.
  - 4 not found. The text "FX: please select at least one token" is in no file under Data/: not the modules, the world's macros, items, actors, scenes, journals, settings or users, and not any compendium pack (JB2A's macros only say it in comments). It is not in Foundry's own language file either. The session ran on the host's machine, so it may come from something installed only there. Every warning or error toast is now logged with the code that raised it, as "notice" entries in the client-health log (`FUCompanion.api.clientHealth.log().filter(e => e.kind === "notice")`). The next time it appears, the log will show where it came from.
  - Low priority: level-up spends now leave a record. Each spend, refund, Heroic pick and unlearn posts a chat line whispered to the GMs ("Level-up ledger"), checked on Staging. GM II's missing tiles on Valley_Map009 were not reproduced. Those 54 tiles are ordinary visible tiles with Forge textures, and nothing in the dungeon code draws differently for a second GM. Any texture-load failure will now reach the client-health log.
- 2026-11-08 onigensou (Claude): merged with v1.0.566/567. #17: sarunphat's fix is kept (`isSpentTile`); my identical one (e67f6634) was dropped in the merge. It was sandbox-checked on the real Valley_Map009 tile: spent shows no Use, re-armed shows Use, cleared again shows none.
- 2026-11-08 onigensou (Claude): #11: both of us built "Can be stolen" in the same spot. The merge keeps my version (9e9f9bdd, 58a3aab7) because the host asked for the steal rate: icon, name, base rate %, a "Nothing" row for the (Empty) share (hidden at 0%), and the item text in the keyword hover instead of inline. Your `steal` line in inspect-model and `stealSection` in inspect-render were replaced by it. Gated at Identity 7+ the same way. Base odds only (Andvaranaut's shift depends on the stealer).
- 2026-11-08 onigensou (Claude): not on the list. Holding Alt in battle no longer brings back Foundry's icons and bars (562c46e7). Battle tokens hide them from spawn, so the entrance no longer flashes them (562c46e7). Spectator Alt-to-inspect is hardened (85a7d9a0): Alt falls back to the sprite under the pointer, and a client that missed the GM's "settled" broadcast asks again (new `resyncBattlePhase` in director-player-hud.js). sarunphat: these touch your Battle Inspect and player HUD files.
- 2026-11-08 onigensou (Claude): world, scenes only (bdb4c11f): 45 loot tiles looted under the old roulette (art blanked, `trTileConsumed` set, state still loot) were marked spent the way clearTile does now. Hideout_Map003 21, AncientTemple_Map008 7, AncientTemple_Map009 3, Wyrmwood 14. Script: `tools/safe-edit/bin/_mark-legacy-looted-tiles-spent.js`.
