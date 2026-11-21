# Nox Legion tuning (v1.0.642)

Balance pass on the six Sealed Cavern monsters (Valley_Map010), plus the engine fixes the playtests turned up. The target is 3-4 rounds per fight, since this is a secret end-game area. Monster background: `reports/2026-11-20-nox-legion.md` (v1.0.636). The animations shipped separately in v1.0.639 / v1.0.640.

## What you need to do
- Pull and restart the server (version bump), then load the world as GM once. One migration runs on GM boot: `data-migrations/2026-11-20-nox-legion-tuning.js`. It is idempotent and finds the Nox by their `noxLegion` flag.
- No world data in this push: the migration applies the numbers in each world. After your boot, your world data changes; ship it with the usual world-export procedure whenever you next commit the world.
- The animation session's builder accepts both Gravis / Gravis Alta and Revive / Resurrection, so a later `_build-dungeon-animations.js --write` still finds the renamed skills. The rename keeps each item, so its animation script stays on it.

## Numbers (the migration)
- **HP:** Ghoul 300, Hound 190, Wraith 260, Viper 230, Priest 450, Executioner 480. Battler scale adjusted.
- **Damage:** Nox attack damage went up twice (+20%, then +25%) through the HR bonuses. Lux Finis and Soul Sever are unchanged.
- **Gravis → Gravis Alta:** 50% of current HP to everyone, never KOs (floor). It has no AI cooldown: the players' answer is Prophetic Defender / Protect / Illusory Shield (see the intent fix below).
- **Revive → Resurrection:** the item, its sheet name, the Priest's AI row and the spell list entry. It only targets a Zombie'd or Undead creature.
- **Beheading:** the line moves from 15% to 25%.
- **Affinities:** Hound loses its Light weakness and gains Fire VU; Viper loses Light and gains Ice VU. Priest, Executioner, Ghoul and Wraith keep their Light weakness, so Light is no longer the answer to everything. The Study hints were updated to match.
- **Weapon efficiency:** Viper sword 150 / brawling 75, Wraith arcane 150 / bow 75, Executioner flail 150 / dagger 75. Ghoul, Hound and Priest already had theirs.
- **Targets and AI:**
  - Coil and Zombie Bite target players only.
  - Devour Soul and Soul Sever wait for a fragment marked "Called".
  - Zombie counts down on the victim's own turns, so it outlives the Priest.
  - Nidhogg carries `reviveKillImmune`.

## Engine changes (some in your files)
- **`skill-intent.js`: more skills classify as harmful.**
  - Step 6b now matches "Enemies" as well as "Enemy".
  - New step 6c: a skill that targets enemies and has a `deal_damage` row aimed at its action targets is harmful.
  - Before this, Gravis Alta read as "aid", so harmful-intent reactions (Prophetic Defender, Protect, Illusory Shield) were never offered against it.
  - 14 world skills flip from aid to harmful: Gravis Alta, Soul Sever, Resurrection, Zombie Plague, Stinky Breath, Death Gaze, Rahu's Eclipse, War Howl, Brainwave Discharge (Esper, Keren and the world item), Shatter, Mean Look, Lance of Ruin.
  - Tests: `skill-intent.test.mjs` (11).
  - Please check that none of those 14 should stay "aid" for a reason I missed.
- **`target-survey.js`: AI heals skip creatures the heal would hurt.**
  - New `restoresHp(action)` and `withoutHealReversed()`.
  - The AI provider's `surveyTargets` drops Zombie'd and Undead creatures from a heal's pool.
  - The player picker is untouched.
  - Seen in a playtest: Kalina's Remedy landed on a Zombie'd Keren as damage.
  - Tests: `heal-target-filter.test.mjs` (9).
- **`skill-formulas.js` / `skill-effects.js` / `snapshot.js`:** `isReviveKillImmune()` and `isReviveKillTarget()`. An immune creature is never offered as a revive target, and a revive cast on it does nothing.
- **`soul-tithe.js` (your system):**
  - A fragment that has Called gets a visible "Called" status (`soulCalledMark`, conflict-scoped).
  - `soulCalledRound` stays the source of truth; the marker only mirrors it.
  - The F5 path re-adds the marker.
- **`defeat-reactor.js` + new `defeat-removal-gate.js`:** the defeat removal waits for its settle pass. That fixes the "Token … does not exist!" toasts. Tests: `defeat-removal-gate.test.mjs`.
- **`sprite-shadow-airborne.js`:** the airborne lift skips tokens that are being deleted.
- **`sim/sim-run.js`:** clone cleanup only deletes clones still in the world. Before, a summon clone killed in the fight made the whole delete batch fail and left [SIM] actors behind.
- **`sim/reaction-brain.js`:**
  - The sim's Hina takes a can't-KO hit (`floor(CUR_HP * x)` only, no typed damage) with Prophetic Defender when it covers 2 or more allies.
  - The ally pool falls back to `ar.targets` when there are no per-target results.

## Fast balance batches (tools)
- **Snapshot runner, `--profile nox`:**
  - `checks/nox-fight.js` plays one Sealed Cavern fight.
  - `bin/nox-batch.mjs` runs the 13 groups on a warm runner.
  - It needs **FVTT_GPU=true**: in software GL a Valley fight did not finish round 1 in 300 s, while on the GPU a fight takes about 35-45 s.
  - Close other Foundry clients first (the TDR warning in `fvtt-playwright/lib/foundry.js`).
  - `RUNNER_CODE=<branch>` serves a branch's code, so its migration applies inside the runner world.
  - Details: snapshot-runner README, "Balance batches".
- **Mindscape `--world-dir <dir>`:** reads a copy of another world's data, such as a sandbox. Mindscape is **not** usable for Nox fights yet: it models about 40% of the party's actions, none of their reactions, and not Soul Tithe.

## Results (runner, 2 runs per encounter, PC-only HP)
| # | Group | Rounds | PC HP |
|---|---|---|---|
| 1 | Ghoul, Ghoul, Hound, Hound | 3.0 | 49% |
| 2 | Hound, Viper, Hound | 2.0 | 79% |
| 3 | Ghoul, Wraith, Ghoul | 3.0 | 64% |
| 4 | Ghoul, Viper, Ghoul | 4.0 | 61% |
| 5 | Hound, Wraith, Ghoul | 3.0 | 78% |
| 6 | Hound, Priest, Hound | 3.5 | 66% |
| 7 | Ghoul, Priest, Hound | 3.0 | 30% (1 run) |
| 8 | Hound, Executioner, Hound | 3.0 | 39% (1 run) |
| 9 | Ghoul, Executioner, Ghoul | 3.5 | 57% |
| 10 | Obsidrax, Viper, Obsidrax | 2.0 | 94% |
| 11 | Hound, Kurona ×2, Hound | 2.0 | 92% |

Every finished fight was a win. Keren's max HP is 85 in the live world (Grave Toll −45).

## Open
- **Runner:** fights with Roo or Carlbero (rows 12 and 13) run slowly, with PC turns taking 30-80 s, and hit the 4-minute limit. Rows 7, 10 and 11 were also slow. One Executioner fight stalled at a round-2 turn start. Not yet investigated.
- **Runner:** start the warm daemon with `--profile nox`. Its auto-sync rebuilt the snapshot without a profile when the world changed mid-batch, and that fight failed.
- **Later design calls (user):**
  - a global Undead guard list;
  - 27 other Debuff templates still on the applier-turn lifetime;
  - passive heal riders reversing on Zombie'd bearers (by rule).
