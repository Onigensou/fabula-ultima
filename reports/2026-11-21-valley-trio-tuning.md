# Valley trio: story-fight tuning, Missile Fist fixes, one engine fix (v1.0.648)

Asura, Rakshasa and Deva are about to be met in the story, so the host had them playtested (about 300 automated Battle Director fights in the snapshot runner) and tuned to a 5–6 round fight. This note lists what changed and why. One change is in shared engine code (`target-survey.js`). Please read that section before you touch performer matching.

Playtest report (207 baseline fights): claude.ai/artifact/9p5j7QET429pChy5FPpzPx

## What you need to do
- Pull and restart the server (version bump), then reload. No migration and no new `module.json` entries.
- World data ships in this push: the **actors** store (the three bosses and Missile Fist) and the **scenes** store (the story Start Battle rows, already in v1.0.647).

## Story fights now use the boss arenas (already shipped in v1.0.647)
The Start Battle rows for Asura (Map017 tile + token), Rakshasa (Map020 tile + token) and Deva (Map029 tile) pointed at the generic `Valley_Battlemap001`. The row's own map wins over the scene's `oniDungeon.battleMap` link, so the arenas built on 11-20 were never used. They now load `Valley_Battlemap005 / 006 / 007`. The Lightning Storm is unchanged; the arenas carry it.

## Boss numbers

| | HP | Damage / accuracy |
|---|---|---|
| Asura | 1200 → **1800** | unchanged |
| Rakshasa | 1200 → **1600** | Saber 60 → 80, Mace 40 → 60, Chakram 20 → 45, Rain of Arrows 15 → 40, Executioner's Volley 18 → 42, Rending Orbit 22 → 48, Devour 45 → 75 (`damage_bonus` and the `dv_bite` row). Severing Verdict stays 162, check +5 → +8 |
| Deva | 1000 → **1400** | Vajra Fist / Mudra Lance 38 → 52, Double Slap 25 → 36, Ground Slam 30 → 45, Fists of Fury 28 → 42, Fists of Focus 12 → 18 (drain `3 * (HR + 18)`), Surya Palm 62 → 78, Kala Strike 25 → 38. Every attack check +4 → +6 |

- **Never targets summons or guests** (your `IS_SUMMON == 0 && IS_GUEST == 0` from v1.0.634, as `target_eligibility`): Severing Verdict, Surya Palm, Kala Strike. Summon protection (Cover-style) still works, per the host's ruling.
- Runner result with these numbers: Asura about 6 rounds, Rakshasa 5.2, Deva 5.2. All three get the party to roughly half HP in a hard fight. The move descriptions use words ("heavy", "colossal"), not numbers, so no text changed.
- `_build-rakshasa.js` and `_build-deva.js` now carry these numbers. The world is still the source of truth: diff against it before any `--apply`.
- Every change is logged in the dossiers (`tools/mindscape/dossiers/asura.md`, `rakshasa.md`, new `deva.md`).

## Missile Fist (Deva's summons): three fixes
1. **Detonate hit the other fist.** Its victim row used `category: "enemy"`, which is relative to the acting token, and `matchesCategory` fails open when a fist acts without one. It is now `category: "party"` (absolute side). In tests every detonation hit the party side.
2. **The second fist lost its turn. This was the engine bug.** See below.
3. **Re-summon replaced live fists.** Deva summoned a new pair every Guard round (`summon_max` 2), which replaced fists before their fuse-2 Detonate whenever she acted first. Celestial Discipline's `round_start` Guard row now splits on `OWN_SUMMON_COUNT`: `== 0` runs `guard` (lays Fist Ready, so she summons), `> 0` runs the new `guard_nf` (same chain without Fist Ready). The host picked this: ignored fists always explode, broken fists come back next Guard round.

## Engine change: `target-survey.js` `resolvePerformerSnapshot`
- **Before:** one pass, `token OR actor` match. Two combatants that are copies of one actor (both Missile Fists, or any summon on the field twice) share the actor id, so every copy resolved to the first copy. The second fist's Self action (Hover / Detonate) then had no performer in its survey pool: `[ActionReader][BuildAndPickTargets] Self target rule found no performer token in candidate pool`. The fist lost its turn.
- **After:** two passes, token first, actor only as a fallback. That is what the function's own comment already said. The legacy Foundry-combat roster gets the same treatment.
- **Verified:** 15 runner fights with 0 self-target errors (it used to be 1–2 a fight). Unit tests 37/38; `crisis-keywords.test.mjs` fails before this change too.

## Also verified live (no change)
- Rakshasa Adaptive Defense reads weapon families round by round: Zarg's bow drops to 25% from round 1.
- Asura's element marks flip VU → RS and back after Asura Strike.
- The sim party never swaps weapons, so a real party will beat Rakshasa a little faster than the tests.

## Known, not fixed
- In the sim, Hina's Heal still targets Keren's undead Gigas summon and damages it. This is the heal-reversal AI issue, and the host scoped it out of this work.
