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

## Transform-into visual: white-silhouette MORPH (Oni, 2026-11-12)

- **What it looks like:**
  1. The bearer's sprite turns white (320 ms).
  2. The white silhouette morphs into the form's silhouette (950 ms, ease in-out, a soft blurred glow).
  3. The white overlay fades off the creature (420 ms).
- **How the morph works:** `polymorph-sdf.js` (pure, with 6 offline tests) gives each alpha mask a signed distance field on one shared grid (360 cells on the long side, exact EDT). Each frame draws the zero line of the blended field, so it works for any pair of sprites with no setup.
- **Fallbacks:**
  - If the art can't be read (CORS), the effect is a plain white fade.
  - If no new art arrives, the token simply shows again.
- **Sound:** `Sound/Charm.ogg` (Oni's pick).
- **Revert keeps the smoke poof below.**

## Revert visual: smoke POOF (Oni, 2026-11-12; replaces the squash below)

- **What it looks like:** an anime transformation poof. Guilty Gear `smoke_anim08` (Ninja Log's clip: the first puff only, 0.7x, about 1.4x the body) swallows the token with `Sound/SmokeBomb.wav`.
- **The swap:** the art swaps under the cloud. The clip holds its densest frame, breathing gently, if the new art is late.
- **The reveal:** the new body pops out as the smoke breaks up: 0.78 → 1.07 → 1 with a stretch wobble, under a white flash that fades over 320 ms. About 0.7 s in total. Revert plays the same beat.
- **Two speed traps fixed** (the cloud hung for about 1 s):
  - Token art is written with `animate: false`, because Foundry v12 otherwise crossfades a token's texture over about 1 s.
  - The art is written in parallel with the form build, and every client starts loading the incoming art when the poof starts (`preload` in the socket message).
- The Form effect is created and deleted with `animate: false` too, so there's no core "+(Polymorph: X)" scrolling text.

## Phases 3–5 (same branch): visuals, UI, potions

- ~~**Horizontal squash**~~ (`polymorph-fx.js`), since REPLACED by the poof above.
  - Every client squashes a copy of the token mesh to scaleX 0, the art swaps, and the new mesh stretches back.
  - The copy follows the live mesh every frame, so 3D-stage depth scaling works.
  - It's guarded per frame and always restores the mesh. Verified at 2.5 FPS headless: it finishes with no leftover copies.
- **Token art:** the form's texture is written after the squash closes.
  - The footprint (width/height) stays the bearer's. The texture scale absorbs the size difference, and the facing sign is kept.
  - Originals are stored as a **list** (uuid-keyed objects get their dots expanded by flag updates) and restored on revert.
- **Sprite props:** the Form effect overrides every `sprite_*` prop that the pose, walk and camp sprite systems read, so a transformed PC never flashes their own art.
- ⚠ **Sheet bake-in guard:** a CSB sheet submits its inputs on close, and those inputs hold the effect-applied values.
  - Closing a transformed PC's sheet wrote DEX 10 / MIG 12 / max HP 132 / AB / blank sprites into the PC's **source** permanently (runner-proven).
  - `preUpdateActor` (every client) now drops writes to form-overridden keys while the form is on.
  - **Possibly pre-existing for equipment AEs too:** Keren's source `bonus_defense` was already 3. Worth a look.
- **Polymorph Potions:** code-backed **by name** (`Polymorph Potion: <Monster>`, declared in `code-backed-content.js`), so world items and every handed-out copy work.
  - There are 12 potions, and only 5 monsters exist (Inferex, Drakoza, Bandit Berserker, Mist Dragon, Bandit). A missing form is refused and the potion isn't used up.
  - **Party menu → Use** (outside battle) opens a "who becomes the X?" picker over the active party, then calls `polymorph.usePotion` (GM-relayed; the holder's owner may give it to a willing ally).
  - **BD Item action:**
    - `potionTargetText` gives the potion "One Ally" (compose + TARGET).
    - DECLARE refuses a missing form.
    - RESOLVE transforms first and consumes only if a transform landed.
  - `sim/scripted-action.js`: a scripted consumable with no linked skill is now an Item action (it mirrors the real menu).
- **UI** (`polymorph-ui.js`):
  - **Form Plate** in the HudDock stack (order 25, every mode including Theatre): form art with the PC's face, time left, "Reverts to X/Y HP", and Revert (owner/GM, outside battle).
  - The same line as a banner on the actor sheet.
- **Event system:** new condition **"Polymorph form"**: any or every party member is / is not in a form tagged X (blank = any form). It's also offered in "Available when".
- **Wording migration** `2026-11-12-polymorph-potion-wording` (idempotent): rewrites only the duration line to Oni's sentence on world items, actor copies and unlinked token copies.
  - In the runner, 21/22 copies were updated. The copy on "St. Reefesia" has no description prop, so it was left alone.

**Verified (runner):**
- Squash seen; art and props swapped and restored; the plate and banner render.
- Potion used up 2→1. The Walrog potion was refused and kept.
- Event condition: beast yes / aquatic no / all-beast no.
- **In-battle potion through the real Item action:** Keren drinks → transform (counter from next round) → Blast Breath ×3 → reverts with reason `turns`. Potion 2→1.
- **Regression:** skill fingerprints are 486/486 identical between main and the branch. The seeded sim battle is identical on main and the branch (10 actions, same resource and effect counts).

## Demo follow-ups (Oni, 2026-11-12)

- **Gear suspended, for real.** The item gate missed reactions that ride an item's *transferred* effect: Keren's Stubborn Scion (a quirk) still fired on the Inferex when it was targeted.
  - Now every effect transferred from one of the bearer's own items is **suppressed** while a form is on. This is a patch on `ActiveEffect#isSuppressed` in `polymorph-core.js` (rule in `polymorph-gates.polymorphSuppressesEffect`).
  - Gear stat bonuses and quirk/passive reactions are off. Statuses on the actor, the Form effect and the form's own items stay live.
  - It writes nothing (the equip system's `disabled` flags are untouched), and revert re-prepares the actor.
  - **Runner:** Keren as Inferex reads DEX 10 / MIG 12 / DEF 15 / MDEF 12, exactly the Inferex. 20 → 0 live item effects, all back after revert. Scion stays quiet in battle.
- **In battle the Form Plate hides** (it sat on the GM desk). The form shows as a **buff pip with its turns left** on the GM desk and the player HUD:
  - `status-classifier` returns BUFF for the polymorph effect (display only, no `buff` tag);
  - `ae-lifetime.describe` reports "N turns left in this form" from the bearer's counter.
- ⚠ The pip tooltip lists the Form effect's raw changes. "DEF set to 5" is the offset over DEX, not the final DEF. It's cosmetic.

## Not done yet / not verified

- **Revert picked from the real Octopath menu** (the free return to the menu) is not run end to end. It uses the same `skill_free_action` path as BotC Dismiss.
- Gear stat bonuses are now suspended (see above). Gear checked BY NAME in code (not via effects) is not covered. Species is not overridden, on purpose (the PC/NPC discriminator); read `getForm().species`.
- **Missing form monsters (7 of 12 potions):** Ice Ring, Lava Golem, Walrog, Hunger, Crazy Merman, Scaldra, Centauros. These are Oni's to design.
- **Traversal tags** (`aquatic`, `flying`…) come from `flags.fabula-ultima-companion.polymorphTags` on the monster plus its species. No monster has the flag yet, so only species tags (beast, elemental…) exist until someone authors them.
- **Never seen with real eyes:** the squash on a real GPU canvas or in the 3D battle stage, the walk-sprite fallback while moving, the party-menu picker clicked by a player, and a 2-GM table.
