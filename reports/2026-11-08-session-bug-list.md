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

- [ ] **1. Break Free picker opens on the GM, not the grappled player (cause found).**
  When Hina tried to break free from Grapple, the picker opened on the GM's screen. Rinri, her player, was online
  with a healthy client and saw nothing. The cause is that `state-handlers.js maybeRunBreakFree` calls
  `pickAttributePair`, and `attribute-pair-picker.js` says it is "client-local", so it runs on the battle host.
  That picker was built for Hinder, where the rules have the GM choose the pair. Break Free reuses it. This is a
  design decision: should it go to the grappled actor's owner, with the GM as fallback?
- [ ] **2. Hina's Protect prompt went to the GM instead of her player.**
  Not investigated. It may be another host-local prompt like item 1, so check them together.
- [ ] **3. Ripple triggered twice on one Bimagus cast. It should trigger once.**
  Likely Ripple reacts to each `creature_completes_spell`, and Bimagus casts two spells. It probably needs a
  once-per-action guard.
- [ ] **4. Bimagus showed a "FX: please select at least one token" notification and seemed stuck.**
  It went through on its own after a while. That text is not in `modules/` or in the world macros or items, so its
  source is unknown. Check what the Bimagus flow and its animation script run.
- [ ] **5. Roper was Provoked by Blanche but targeted Zarg.**
  Check which Roper action ran first. Its Reel or grapple follow-ups may not go through target choice by design, so
  read the Roper dossier before calling it a bug. Otherwise check the enemy AI's target filter for Provoked.
- [ ] **6. Blanche's Counter Pass only offers Muleta.** It should offer all her Pase skills. It is probably a
  hard-coded skill or a filter that matches only one skill.
- [ ] **7. Descabello is missing its half-level damage.**
  Its `damage_bonus` is `30 + floor(CHAR_LEVEL/2)`, but the hit landed without the half-level part (Blanche is
  Lv 44, so 22 was missing). Check that `CHAR_LEVEL` resolves on the BD damage path. Also, the skill text says the
  base becomes 40 at SL 20 and 50 at SL 40, but the formula is fixed at 30. The host should decide whether those
  enhancements apply.
- [ ] **8. Zarg's Quick Change to his bow didn't reach his battle menu.**
  The actor data showed the bow equipped and the staff unequipped, but Trinio's menu still showed the old weapon,
  even after `refreshTurnActions`. Check the snapshot and weapon cache after a mid-turn swap
  (`snapshot.js resolveAttackerWeapon`, `equipment-swap.js`) and the player HUD refresh.
  **Probably fixed by your v1.0.564 (`35bb8010`, "Mid-turn gear changes reach the Attack menu"), which arrived the
  morning after the session.** Leave it open until it is checked live in a real fight.
- [ ] **9. Rakshasa's Form Shift doesn't tell the table which weapon it switched to.**
  The stance effect (for example Throwing Stance) is applied, but nobody could see it. This answers the dossier's
  open question "is the stance readable at the table" with a no. Also, a GM-applied **Weak** (Rakshasa is RS to
  Weak) disappeared shortly after it was applied. Check whether Form Shift or something else removes it.
- [ ] **10. Keren's Life Transference formula may be wrong.** The player is **not sure**, so verify the formula
  against the skill text first.
- [x] **11. Study no longer shows the enemy's stealable items. This is a regression.**
  Check the Study card's read of steal data, and whether the 11-06 change that made Valley gacha items unstealable
  (`e9aed725`) touched the list it reads.

## Items and equipment

- [ ] **12. Potion Rain does nothing.** No MP was restored. The GM gave the MP by hand.
- [ ] **13. Maid Cap plus Zarg's heroic skill should make Create Elixir cost 1 IP. It charged 2.**
  Check how Create cost reductions stack.
- [ ] **14. Glacial Staff's spell isn't linked (data gap).**
  The description says "You may cast Icicle Lance", but the staff has no linked `_skill`, so equipping it adds
  nothing to the Spell menu. The world Glacial Staff (`FRwmrAhwe8xSLEXZ`) is missing the link. Zarg's copy was
  patched live, but that patch is not in the repo yet. It is worth sweeping all gear whose text says "cast the
  spell" for the same gap.
- [ ] **15. Paladin Armor needs automation (feature).**
- [ ] **16. Opportunity "Advantage" outside battle can't target a party member.**
  The picker only offers tokens on the canvas, and in dungeon mode the whole party is one token. The GM applied
  the effect by hand. Suggested fix: outside battle, pick from the party's members instead of canvas tokens.

## Dungeon

- [x] **17. A cleared Dirt tile still shows the Use button when the party steps back on.** Not investigated.

## Also seen (low priority)

- An assistant GM (GM II) saw no dungeon tiles on Valley_Map009 while the main GM and the spectator saw all of
  them. It was not traced.
- Level-up spends leave no lasting record. The level-up system only writes a console line, so working out which
  skills players bought needed item timestamps. A chat line or ledger entry would help.

## Notes

- 2026-11-08 onigensou: filed after the session. The host will take items during the week as time allows.
- 2026-11-08 onigensou: #17 fixed in e67f6634. The Use button now also checks that the tile isn't blank or spent. The authored `usable` flag stays, so a dungeon reset re-arms the tile. Sandbox-checked on the real Valley_Map009 tile.
- 2026-11-08 onigensou: #11 fixed in 9e9f9bdd and 58a3aab7. The stealables weren't lost from the data. The Study card (v1.0.512) replaced the journal page and never drew them. The Notes tab now has "Can be stolen", with icon, name, base steal rate and a "Nothing" row. Gated at Identity 7+. sarunphat: this touches your Battle Inspect files (inspect-model, inspect-render, unit-inspect).
- 2026-11-08 onigensou: not on the list, same branch. Holding Alt in battle no longer brings back Foundry's icons and bars (562c46e7). Battle tokens hide them from spawn, so the entrance no longer flashes them (562c46e7). Spectator Alt-to-inspect is hardened (85a7d9a0): Alt falls back to the sprite under the pointer, and a client that missed the GM's "settled" broadcast asks again (new `resyncBattlePhase` in director-player-hud.js). sarunphat: please check these too.
