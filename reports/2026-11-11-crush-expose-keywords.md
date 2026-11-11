# Crush rework + new Expose keyword (v1.0.587)

Heads-up for sarunphat: this changes shared damage code (`battle-director/damage-ruleset.js`).

## The rules (Oni's ruling, 2026-11-11)

- **Crush** = the action bypasses Immunity and damage reduction effects.
  - Resistant, Immune and Absorb all count as Neutral. Vulnerable stays Vulnerable.
  - It still skips flat and % damage reduction, a weapon efficiency below 100%, and a damage-taken multiplier below 1.
  - Shields still absorb it.
  - **Changed:** Crush used to step down one rung only (Immune → Resistant, Absorb → Immune), so a Crush hit on an Immune target was still halved. Now it does full damage.
- **Expose** (new) = the target's affinity against this action is one stage lower.
  - Absorb → Immune → Resistant → Neutral → Vulnerable. Vulnerable is the floor.
  - It does not skip damage reduction.
  - Attack/spell immunity (`affinity_class_strike` / `affinity_class_magic`, such as Ghostly Sheet) also drops one stage, but never below Neutral, so one hit can't be Vulnerable twice (×4).
- **Both:** Crush applies first, then Expose. Crush + Expose = Vulnerable against anything.

| Target | Crush | Expose | Both |
|---|---|---|---|
| Vulnerable | ×2 | ×2 | ×2 |
| Neutral | ×1 | ×2 | ×2 |
| Resistant | ×1 | ×1 | ×2 |
| Immune | ×1 | ×½ | ×2 |
| Absorb | ×1 | 0 | ×2 |

## Code

- `damage-ruleset.js`: `applyKeywordAffinity(code, keywords)` is the single pass (Crush → Expose → the existing `ignore_*` clamps). It's also exported: `exposeAffinity`, `hasExpose`. `crushAffinity` now maps Resistant/Immune/Absorb to Neutral.
  - `applyClassAffinityAndMult` gains an `expose` option.
- `action-profile.js` (card / attack path): `hitKeywords` = inherent keywords + reaction-granted keywords, worked out before damage reduction. Fixes found along the way:
  - On attacks, Crush did not skip a reducing weapon efficiency, attack/spell immunity, or a multiplier below 1.
  - A reaction-granted Crush (Chomp, Lucky Mallet) did not skip damage reduction.
- `card-mutations.js`: a Protect redirect now applies the action's keywords to the new target's affinity. It ignored them before.
- `template-field-registry.js`: `apply_action_keyword` gains `expose`; tooltips updated.
- `keyword-registry.js`: Expose term `ExposeKeyw0rdA1c` (Trick Attack icon); Crush description reworded.

## World data

- Keyword Repository: new **Expose** journal entry; the **Crush** page text now reads "bypasses Immunity and damage reduction effects".
- `crush` added to `action_keywords` where the text promised it but the data never had it:
  - Descabello (world, Blanche, Matador)
  - Explosion (world, Pyromancer)
  - God Hand (also `pierce`, which was also text-only)
  - Morning Star
  - Give me money or else... (Elite Bandit)
  - Greataxe - Behemoth (Rauben)
- Left alone:
  - **Anchor Smash** (Pirate) and **Big FXXking Bullet** (Revolver) are facets with no damage wiring, so a keyword does nothing until they're built.
  - **Lucky Mallet** already grants Crush through its Passive.

## Verified

- Staging World, Bandit attacking a test target: every affinity × {none, Crush, Expose, both} on the action-card path and on `computeIncomingDamage`. The two match in every case.
- A Ghostly-style "immune to attacks" effect: no keyword 0, Crush full, Expose half, both ×2.
- Not run live: a Protect redirect (it uses the same function), and a real table session.
