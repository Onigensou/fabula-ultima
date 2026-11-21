# Nox Legion: mixed Defense targets (v1.0.645)

A small monster change on top of the Nox Legion tuning (`reports/2026-11-20-nox-legion-tuning.md`, `reports/2026-11-21-nox-viper-counter-ticker-fix.md`). No engine code and no world data are in this push.

## What you need to do
- Pull and restart the server (version bump), then load the world as GM once.
- The existing idempotent migration `2026-11-20-nox-legion-tuning.js` re-runs because its source changed, and applies pass 6 below.

## New design rule (from the user)
Every monster mixes attacks against **Defense** and against **Magic Defense**, so the players can't lock a monster out with one defense stat. The only exception is a niche monster that is meant to be exploited once the players catch on.

What prompted it: an exact hit-chance check of every Nox attack against the party's sheet Defense and Magic Defense. Blanche (Defense 19) was hit by the Ghoul's Poison Blade only 15% of the time, and the Ghoul is the most-used Nox attacker.

## Pass 6 (migration `2026-11-20-nox-legion-tuning.js`)
| Monster | Move | Before | After |
|---|---|---|---|
| Nox Ghoul | Poison Blade | vs Defense, +4 | **vs Magic Defense**, +4 |
| Nox Hound | Zombie Bite | vs Defense, +8 | **vs Magic Defense, +6** |

- Each monster keeps one attack against Defense: the Ghoul's Grave Claw and the Hound's Rending Fangs.
- Dice are unchanged.
- Zombie Bite's Zombie rider is `HIT_MARGIN >= 0` (on a hit), so it follows whichever defense the move targets.
- The Nox Wraith stays Magic-Defense-only (Soul Ripper is its only check). That's on purpose: it's the niche monster.

## Hit chance (exact dice math, sheet numbers, Hina / Keren / Blanche / Zarg)
- **Poison Blade:** before 96 / 81 / 15 / 55%, after 55 / 65 / 45 / 88%. Average 62% → 63%.
- **Zombie Bite:** before 99 / 99 / 54 / 90%, after 78 / 84 / 71 / 97%. Average 85% → 83%.

## Balance batch (snapshot runner, branch code, 2 runs per encounter)
All 26 fights were won. Rows 1–9 ran 3–4.5 rounds and ended with the PCs at 39–86% HP, in line with v1.0.643. One finding for you:
- **Row 12 (Ghoul, Roo, Ghoul) reads "inconclusive" twice.** In both runs the combat ended in round 3 with no enemy left in the combatants list and no PC down, so `sim.run` did not call it a victory. It was a victory on v1.0.643's code. It looks like Roo leaving the battle (the Roo Approach rework?) rather than a balance issue. Worth a look on your side.
