# Nox Legion: the Sealed Cavern's own monsters (v1.0.636)

Six new Undead monsters for the Sealed Cavern (Valley_Map010), with the battle engine and Soul Tithe changes they need. Soul Tithe heads-up (read first): `reports/2026-11-19-soul-tithe-fragment-eater.md`.

## What you need to do
- Restart the server (version bump), then load the world as GM once. Two one-time migrations run on GM boot:
  - `2026-11-20-nox-legion-author.js`: creates the 6 actors (Nox Ghoul, Hound, Priest, Viper, Wraith, Executioner) with kits, AI, art, plus the Corroded status and the cavern's own 13-row encounter table. Valley_Map010 switches to it. Re-running is safe (it matches by the `noxLegion` flag).
  - `2026-11-20-template-options-soul-fragment-destroyed.js`: adds the new trigger to the reaction template's options.
- Your world data changes after that boot; commit it with the usual world-export procedure.
- Art is already on Forge: `Beastiary/Nox*_Standard.png` and `_Battle_Idle.webm`.

## Battle engine
- **Healing hurts the Undead, full amount.** Any HP heal on a creature whose species is Undead, or that has Zombie, deals that much damage instead (can KO). It covers skills, items and the out-of-combat healing HUD. A heal row with `heal_ignore_undead: true` heals normally (the Wraith's Devour Soul). Soul Fragment refunds are not heals and are unaffected. `skill-formulas.js`, `skill-effects.js`, `healing-system/`.
- **Revive kills the Undead.** Phoenix Feather (and any KO-ally revive) can now target a living Undead or Zombie'd creature, and defeats it outright, elites included. A Zombie'd player counts too. `snapshot.js`, `compose-action.js`, `target-survey.js`, `skill-effects.js`.
- **`target_sort`** on targeting rows: `lowest_hp`, `highest_hp`, `lowest_hp_pct`, applied before `exact`/`up_to`. `skill-targeting.js`.
- **`action_pattern_chance`** on AI rows (0–100, blank = 100). action-reader.
- Registered sheet fields `ae_name_pool_alt`, `ae_pool_alt_condition`, `conflict_pick` so sheet saves keep them.

## Soul Tithe (sarunphat's system)
- **Eaten ledger:** `soulEaten` on the Soul-Torn effect. Fragment Max HP = owner's loss − eaten. Round-end re-squaring respects it; battle end gives eaten HP back with everything else.
- **`consumeFragment`** conflict action (pick `largest` or `trigger_subject_owner`; only fragments that have Called). Removes it with no refund; `CONSUMED_FRAGMENT_HP` is readable by later rows.
- **`titheWound`** conflict action: lowers a player's Max HP straight into their fragment (spawns one if needed).
- **New trigger `soul_fragment_destroyed`** (formula word `FRAGMENT_HP`), fired for every destroy except battle-end cleanup. `defeat-reactor.js`, `reaction-triggers.config.js`.
- A conflict action returning `false` now counts as not done (the chain row fails closed).
- Design doc: new "Fragment Eater" section in `docs/soul-tithe-design.md`.

## Tests
- `soul-tithe-eater.test.mjs` 53/53, `undead-heal-reversal.test.mjs`, `target-sort.test.mjs`, `pattern-chance.test.mjs` all pass (rerun after rebasing onto v1.0.635).
- Existing suites pass except `crisis-keywords`, which already fails on main.
- Sandbox world: authored kits checked live (Soul Sever, Devour Soul, Beheading, Feeding Coil, Ghoul's counter, heal reversal, Parry, Bile Spew, riders, Revive, Gravis).

## Known gaps
- On a monster's Attack, the "damage dealt" value reads 0, so monster add-on effects that use it never fire (old monsters too). Soul Ripper works around it.
- The AI can't see whether a fragment has Called; the Wraith and Executioner may waste a turn on a fresh one. A visible marker in `soul-tithe.js` would fix it.
- Heals through reactions and dungeon heal tiles aren't reversed on the Undead yet.
- `action_pattern_chance` has no column on the NPC sheet; saving those AI rows by hand may drop it.
- Hope has no effect data yet (description only).

## Owed
- A real-table look at the Sealed Cavern fights.
