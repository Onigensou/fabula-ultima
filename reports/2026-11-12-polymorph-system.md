# Polymorph system: core + battle (branch `feat/polymorph`, not merged)

Heads-up for sarunphat: this touches five Battle Director files with small, gated edits (listed below). All other changes are in the new `scripts/polymorph/` folder. **When nobody is transformed, every gate is a no-op.**

## What it is

Polymorph Potions turn a PC into a monster. There are six potions in the world: Ice Ring, Inferex, Bandit Berserker, Mist Dragon, Lava Golem and Drakoza.

- **Architecture:** the form is a layer on the PC (like PF2e Battle Form or WoW druid forms). It is never an actor swap.
  - Identity, the party roster, saves and EXP all stay on the PC.
  - The monster actor is a read-only template and is never written to.
- **API:** `FUCompanion.api.polymorph`
  - `transform` / `revert` / `revertAll`
  - `getForm` / `isTransformed` / `hasTag` / `listTransformed`
  - `noteTurnEnded` / `noteConflictStart`
  - Hooks: `fuPolymorphTransformed` and `fuPolymorphReverted`.

## Rules (Oni's rulings, 2026-11-12)

- **HP and MP: Form Multiplier.** `m = 1 + (form max ÷ own max − 1) ÷ 2`, clamped to ×1–×2.
  - Form max = own max × m. The bar keeps its fill.
  - On revert only what changed in form carries back. Damage rounds in the player's favour and healing rounds down, so a round trip with no damage is exact and HP can't be farmed.
- **Fully that creature:**
  - The form's attributes, DEF/MDEF, affinities, actions and passives replace the PC's.
  - Class skills, gear-granted skills and the PC's item-borne reactions are dormant.
  - **The form keeps the PC's activation count** (never Elite/Champion turns).
- **Duration:** "Lasts until the end of the scene or your next 3 turns during a conflict."
  - Scene end = the GM activates a map (`updateScene` with `active: true`). Entering a battle therefore ends a form, so there's no pre-buffing.
  - In a conflict the counter ticks **at most once per round** at the end of the bearer's own turn, and the drink turn doesn't count.
  - Extra turns and free actions (Acceleration) are bonus form actions. A turn removed by Stop isn't counted.
- **Also ends on:** 0 HP (the bearer stays KO'd), removal of the effect, or **Revert**.
- **Revert** is a FREE Objective option, granted only by the form.

## How it's built

- **One Form effect on the bearer.** It uses OVERRIDE changes at priority 200 on:
  - `<attr>_base`, `bonus_defense` and `bonus_magic_defense` (as offsets over DEX/INS),
  - `affinity_1..9`,
  - `max_hp` / `max_mp`,
  - plus `grant_objective: revert_form` (CUSTOM mode).
  - It is flagged `directorPermanent` (no BD sweep or tick) and `uncleansable` (tag or `*` dispels never end it).
  - ⚠ An ADD on `skill_hp`/`skill_mp` is **ignored** by the PC sheet. A label OVERRIDE works.
- **The form's skill items are copied onto the bearer** with the flag `polymorphItem`, and deleted again on revert. Every BD path then runs on the bearer's own items.
  - To keep an item out of forms, tag it `no_polymorph` (a prop, a `skill_tags` entry, or `flags.<ns>.noPolymorph`).
- **State** is stored in `flags.fabula-ultima-companion.polymorph`.

## BD files touched (all gated by `polymorph-gates.js`, which has no dependencies)

| File | Change |
|---|---|
| `actor-shape.js` | `getActorKind` returns `"npc"` while transformed (Attack uses the form's attacks); `getNpcAttackItems` returns form items only |
| `skill-picker.js` | `gatherSkillsForActor`: form items only, gear grants skipped |
| `skill-effects.js` | `weaponReactionInPlay`: the bearer's non-form items are not in play; new effect kind **`polymorph_revert`** (awaited) |
| `state-handlers.js` | TURN_END calls `polymorph.noteTurnEnded` after the bearer ticks. DECLARE backstop refuses an own skill or attack item that isn't part of the form (not the Item command, not world core actions) |
| `sim/player-brain.js` | Generic profile while transformed; no weapon swing; NPC attack only from form items |

New migration `2026-11-12-polymorph-revert-objective` (idempotent) authors `Battle Director/Common/Revert` (`objective:revert_form`, scope `none`, `skill_free_action: true`).

## Verified

- **Offline:** `polymorph-math.test.mjs` 41/41. All 96 suites pass except `crisis-keywords`, which fails the same way on main (missing `Hooks` stub).
- **Snapshot Runner, Keren:**
  - **Stats:** as Drakoza, 63/85 → 84/113, with stats and affinities exact. As Inferex: 132 HP / 80 MP.
  - **Menus:** while transformed, attacks are Flamethrower / Blast Breath / Chomp and skills are Inferex's 5 only. Objectives gain Revert. Phantasmal Echo is dormant and Voracious is live. Revert restores all 29 skills and leaves the monster untouched.
  - **Endings:** KO, effect delete, map activation and replacing a form all revert cleanly.
- **Runner battle** (sim vs Mist Dragon):
  - Keren casts Psychokinesis and transforms after her turn (counter starts next round).
  - She uses Blast Breath ×3 in rounds 2–4, then reverts with reason `turns`.

## Not done yet / not verified

- **Revert picked from the real Octopath menu** (the free return to the menu) is not run end to end. It uses the same `skill_free_action` path as BotC Dismiss.
- Gear that raises attributes (`bonus_<attr>`) still applies. Species is not overridden, on purpose (the PC/NPC discriminator); read `getForm().species`.
- **Later phases:**
  - token/sprite visuals (horizontal squash), party menu / sheet / HUD / Theatre ribbon,
  - potion item wiring (out-of-battle Use, using it on an ally), event-system tag condition.
- **World data:** there are no "Lava Golem" or "Ice Ring" monster actors yet.
