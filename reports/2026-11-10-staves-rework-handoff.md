---
id: 2026-11-10-staves-rework-handoff
title: Hand-off — v1.0.580 Glacial Staff + Sunflower Staff rework, a once-per-action reaction cap, Pierce on spells, oni.pxfx mirror fix
status: open
severity: info
reporter: onigensou
assignee: sarunphat
component: battle-director (skill-effects, action-profile, reaction-deck, template-field-registry), anim-studio (oni-helpers), world items
introduced_in: 272b4871..fc065a52
fixed_in:
---

# v1.0.580: Glacial Staff and Sunflower Staff rework, and three small engine changes

Written for sarunphat and the Claude session that runs the pull. Nothing to do beyond a normal pull and reload
(no new script files in `module.json`). Two of the changed files are shared battle code you also work in
(`skill-effects.js`, `action-profile.js`), so this lists every change there.

## 1. What players see

- **Glacial Staff** (Zarg): Uncommon; its swing now targets Magic Defense, as its text always said.
  **Icicle Lance** is now single target, 15 MP, HR + 25, Pierce. A glacier lance flies from the caster and lands
  with the standard Ice hit.
- **Sunflower Staff** (Hina) has a new contained passive, **Sunflower Staff (Passive)**. Whenever one action deals
  Light damage to any creature, Hina gains 1 **Solar Charge** (max 5); light streams into her staff and a
  five-petal sunflower over her lights a petal. **Solar Beam** hits all enemies for 15 per charge, split evenly
  (rounded down), so 75 at 5 charges. It is dimmed with "No Solar Charge" when she has none. A sun swells at the
  staff, a horizontal beam swells across the field, the screen whites out to the enemies' black silhouettes, and the
  damage lands on the white frame.
- **Dragontrap Bow**: a hit on a Flying target now grounds it automatically (was a prompt), until the end of the round.
- **Ancient Bone** / **Slayer's Blood**: their internal name field said "Eisendrache Seal"; fixed.
- Text tidy to the house convention: Dragonskull Helm, Draconic Roar, Punishment (+ Passive), The Wasp, Turbo Tonic.

## 2. Shared code that changed

- `battle-director/skill-effects.js`
  - **`reaction_max_scope: "action"`**: N fires per damage instance, whoever was hit (one Lux on three enemies is
    one instance). Keyed by `payload.damageInstance`. Added to `REACTION_MAX_SCOPES`, `CAP_REASONS`, `capRefFor`,
    `reactionRoundCountKey` and the no-subject guard in `reactionRoundCapReached`. Existing scopes are unchanged.
  - **`reaction_origin_filter: "!Name"`**: a leading `!` means "any origin EXCEPT Name". Without the `!`, it behaves
    exactly as before. Used so Solar Beam's own Light hits don't refill the clock.
- `battle-director/action-profile.js` `flattenRow`: Skill/Spell rows now carry `pierceMiss` when it is true.
  **This is a bug fix.** RESOLVE already deals half damage on a Pierce miss for any action (see the comment above
  `!r.hit && !r.pierceMiss` in `state-handlers.js`), but the flag was dropped for non-Attack rows, so a missed Pierce
  spell dealt 0. Rows without a Pierce miss keep their exact shape.
- `battle-director/template-field-registry.js`: the Max Scope dropdown gains "Per action card or tick, whoever was
  hit". `battle-director/reaction-deck.js`: the matching quota wording.
- `anim-studio/oni-helpers.js` `pxfx()`: a mirrored clip no longer flips twice. `vfx()` already mirrors by flipping
  `scale.x` around the anchor; pxfx also moved the anchor to `1 - x`, so an asymmetric clip landed on the wrong side
  of its point (Solar Beam fired into the party). **Lunar Bow's arrow tip now sits on its path**, so it looks slightly
  different from v1.0.572. Centred clips (impacts) are unaffected.

## 3. World data

Built by `tools/safe-edit/bin/_build-staves-2026-11-10.js` (every copy: world item + actor copies on Zarg, Hina,
Keren, Hako, Drakoza, Masked Girl, the EXFURSION Party stash). New items: `Sunflower Staff (Passive)`
(world `sQHr84bvUjSIMLXO`, Hina's copy `MiubBGsMjclX0IGa`). world-export: 24 modified, 1 added, 0 removed.
Animation sources: `tools/anim-studio/{glacial-icicle-lance,sunflower-solar-beam,sunflower-solar-charge}.js`.
Clips on Forge: `Animation/pixelfx/pxfx_ice_glacial_lance_*`, `pxfx_light_solar_charge_*`, `pxfx_light_solar_cannon_*`.

## 4. Tested

Staging World, real BD sims: Lux on 3 targets = 1 charge, a second Lux = 2; non-Light damage ignored; Solar Beam
(1 charge vs 3 enemies) = 5 each, charges cleared, its own hits excluded; Icicle Lance hit = HR + 25, a clear miss =
half with `[Pierce]`. Watched GPU run of Icicle Lance and Solar Beam; the beam direction was fixed after it.

Not tested yet: Dragontrap's automatic grounding in a fight, the "No Solar Charge" dim, a full 5-charge beam, a
player client, a real session. `crisis-keywords.test.mjs` fails the same way before and after (stale on main,
`Hooks is not defined`).

## Notes
