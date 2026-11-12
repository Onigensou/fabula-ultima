# Slayer follow-up: Lockdown fix, species pick on learn, kill guard (v1.0.600–601)

Hand-off for sarunphat. This follows `2026-11-13-zarg-slayer-reconfig.md`. Three of the changes touch shared code (1, 2 and 3).

## 1. Engine: AE-carried reactions read the applying skill's SL (v1.0.600, shared)

`battle-director/skill-effects.js` `computeSenderDamageBonuses` (~2880). For an **AE carrier**, `carrierSkill` was `null`, so `SL` (and every other skill-scoped identifier) read 1. Lockdown SL 2 cut 2 damage instead of SL × 2 = 4.

It now uses the skill recorded on the AE (`flags.fabula-ultima-companion.directorAppliedBy.skillUuid`), the same way `card-mutations.js` already does for AE carriers. If that's missing, it falls back to the AE's parent item. Verified on the Staging World: the locked Bite went from 47 to 43.

**Who else is affected:** every reaction carried on an AE whose damage formula uses `SL` (or another skill-scoped value) now reads the real level instead of 1. If any of your AE riders were tuned around SL reading 1, they will hit harder now.

## 2. Level-up: per-level choices ("Each time you take this Skill, choose …") (v1.0.601, shared)

- **Registry:** new `levelup-system/levelup-choices.js` with a code-side registry, `LEVEL_CHOICES`. Bane Oils is the only entry: `effectPrefix "Bane Oils: "`, label "Species", 1 per level.
  - The options are the skill's own effects whose names start with the prefix. Choosing one switches it on; giving it back switches it off.
  - No world data is needed. Another skill with the same kind of choice is one more entry.
- **Spend:** spending a level asks for a species. It's strict, like Facets: closing the picker means the level isn't taken.
- **Refund:** refunding a level asks which species to hand back. Refunding to 0 stashes the skill with nothing chosen, so a re-take asks again.
- **Catch-up:** if a skill holds fewer picks than its level, the skill row shows a "Choose Species (n)" button. It costs no point and is hidden in Character Creation. It runs through the new socket pair `levelup.choose.req/res`, with the same gate, owner and subject checks as spend, plus a ledger line. It's also reachable as `FUCompanion.api.levelUp.chooseOptions`.
- `getState` now returns `skill.choice = { label, noun, perLevel, held, owed, options }`.
- **Character Creation** opens the same level-up species picker, with the same strict rule.
  - Picks are stored on the draft row that bought the level (`choiceKeys` / `choiceLabels`). Removing a level gives its pick back, last in first out, the same way Facets work; dropping the class gives them all back.
  - Finalize passes `choiceKeys` to `spendPoint`.
  - The summaries read "Bane Oils 2 (Beast, Monster)".
  - Shared helper: `choiceViewOf` in `levelup-choices.js`, used by `levelup-api.js` and `cc-class-state.js`.
  - Files touched: `cc-api`, `cc-class-state`, `cc-step-classes`, `cc-step-summary`, plus a comment in `cc-draft`.
- **Tests:**
  - New suites: `levelup-choices.test.mjs` 34/34 and `cc-choices.test.mjs` 19/19.
  - Existing suites still pass: `levelup-reset` 43/43 and all 9 other CC suites.
  - Staging World UI runs:
    - level-up: catch-up (Zarg: Beast + Monster), spend (Undead) and refund (gave back Undead);
    - a full CC creation: cancel adds no level, Beast then Monster, the refund gives Monster back, and the new character starts with exactly Beast + Monster.

## 3. Data: kill guard on the hit reactions (world data, Oni-authored)

`&& TARGET_CURRENT_HP > 0` was added to the reaction condition of:
- Lockdown: the world item, the Slayer class copy and Zarg's copy;
- the eight "Bane Oils (<Species>)" effects, on each of the same three copies.

When the hit kills the target, neither one prompts any more. Before, the player got the prompt and then "nothing to choose from". This uses the same identifier as Voracious and Chomp. Verified on the Staging World: both were offered on a live target and blocked on a dead one.

## 4. Zarg

Trinio picked **Beast + Monster** for Bane Oils. Those two effects are on in the world data, and Oni's slot 1 is patched to match.

## Not changed (rulings)

- **Lockdown** stays as written: only **Attack** and **Spell** actions can be locked. "Active" moves are Skills and don't count.
- **Bane Oils' hit:** we keep your "attacker picks one of Slow / Weak / lose a Resistance". The Dark Fantasy v0.2 text in `reference/skills.json` says "loses one of its damage Resistances **and** becomes weak". We didn't change the item.
- **Animations** for all three are mocked up and approved, and will be ported in a later push. The menus will use your plate-drawer `pickDocked` for players.
