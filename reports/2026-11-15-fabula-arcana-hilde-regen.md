# Fabula Arcana: Princess Hilde Royal Grace = Regen field (v1.0.614)

Balance change to one character card. No world data. Commit `968e62c2` (was `a6df6664` on `feat/fa-hilde-regen`).

## Why

Under the old Royal Grace (mode 3: benched at round end, the active card heals 2, max 8 uses), Princess Hilde ★★★ won about 30%, against the 45–55% target. Self-heal versions stalled into Pass loops (62–83% win, 5–7% round cap), so Hilde herself must never be healed.

## Change

- **Royal Grace (GRACE_MODE 4):** when Hilde Passes, her side raises **Regen**, a field like Tailwind. From the NEXT round, for 4 rounds, the active card heals 3 at the end of each round.
  - Hilde herself is never healed.
  - Passing again restarts the 4 rounds.
  - Regen keeps running after Hilde leaves or falls.
- **Hilde stats:** HP 13 → 14 (2 / 14 / 1 / SPD 3).
- **Engine:** `CFG.REGEN = 3`, `CFG.REGEN_ROUNDS = 4`, events `ev.regen` and `ev.grace {regen: true}`. AI: Pass to raise it, then hand off to the best attacker.
- **Duel window:** a Regen field tile with a tooltip (same pending / re-raise display as Tailwind), a "+3 Regen" heal pop, and a band with sparkles when Hilde raises it.
- **Tests:** 7 Royal Grace checks replace the old mode-3 ones. `fa-engine.test.mjs` ALL PASS.

## Balance

fa-balance, 6000 casual / 3000 skilled, seed 11:

| Princess Hilde | Win rate | Draws | Round cap |
|---|---|---|---|
| Casual | **47.1%** (was ~30%) | 3.2% | 4.2% |
| Skilled | **48.2%** | 2.4% | 2.4% |

Round cap is about baseline.

## Heads-up

The UI was checked headless only (duel window + in-page engine), not on the Staging World or at a real table yet.
