# Fabula Arcana: elemental affinity feedback + one vocabulary (v1.0.611)

Follow-up to `2026-11-15-fabula-arcana-batch-2-3.md` (v1.0.610). UI and wording only: **no rule, number or balance change**, no world data. Files: `assets/fabula-arcana/duel.html`, `assets/fabula-arcana/duel-assets.js`, `scripts/fabula-arcana/fa-engine.js` (log text only), `scripts/fabula-arcana/fa-engine.test.mjs` (one message string).

## Why

Playtest 11-15: a Rock Golem sat in front of an Air monster for two rounds and nobody noticed it was taking the element bonus. A +2 or −2 hit looked and sounded exactly like a neutral one; the only sign was a 12px word under the damage number.

## What changed

### Hit feel (duel window, `fxClash` + `popFor`)

| The target… | Damage | Looks / sounds like |
|---|---|---|
| is **Weak** to the attack | +2 | Short hit-stop, harder shake (`shake-hard`), the defender's sprite flashes red, orange burst, `aff_weak` SFX (SE_BTL_HitCritical) on top of the element sound. Big orange number (44px) with a red **Weak** badge. |
| **Resists** the attack | −2 | No shake, grey glance ring, `aff_resist` SFX (SE_GUARDC) instead of the element sound. Small grey number (22px) with a slate **Resist** badge. |
| neutral | — | Unchanged. |

Elementless hits (Elemental Shard) and Absorb keep their old popups.

### One vocabulary everywhere

Affinity words now always describe **the monster being hit**: **Weak** = it takes +2, **Resist** = it takes −2. "Strong" is gone. Before this, the log's "Weak" meant the *attacker* was weak, the opposite of the new popup.

| Where | Before | Now |
|---|---|---|
| Battle log (`fa-engine.js` + the copy in `duel.html`) | `Strong vs Earth +2` / `Weak vs Air -2` | `Weak: Earth takes +2 from Air` / `Resist: Air takes −2 from Earth` |
| Rules panel | strong +2, weak −2 | a target **Weak** to the attack takes **+2**, one that **Resists** it takes **−2** |
| Element chart caption | arrow = strong against (+2), reverse = weak (−2) | the arrow points at the element that is **Weak** to it (+2); the other way round it **Resists** (−2) |
| Light/Dark, Poison/Physical hint | each strong vs the other | each is **Weak** to the other |
| Match report (`AFFN`) | ADV Strong / DIS Weak | ADV Weak / DIS Resist |

Internal names follow the words: `.pop.vu` / `.pop.rs`, `isVu` / `isRs`, SFX keys `aff_weak` / `aff_resist`. The engine's `aff` codes (`ADV` / `DIS`) are untouched.

## Heads-up

- If anything of yours parses the log line text for `Strong` / `Weak`, it needs the new strings. Nothing in the module does.
- Tried and dropped: per-card matchup pills on the board (the user didn't want them).

## Tested

- `fa-engine.test.mjs`: all pass.
- Standalone duel window (headless): forced Rock Golem vs Aero Gorger, then 3 full matches vs the skilled AI on the final code (7 Weak/Resist popups among 47 hits). 0 page errors.
- Staging World, watched live (GPU window, practice duel): Golem vs Gorger, a switch to Pyrefly, and Pyrefly vs Gorger. Popups and log lines read as in the table above. 0 page errors.
- Not yet seen at the real table.
