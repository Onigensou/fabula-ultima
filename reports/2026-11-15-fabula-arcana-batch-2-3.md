# Fabula Arcana: batches 2-3 + rule changes (v1.0.610)

Follow-up to `2026-11-15-fabula-arcana-character-cards.md` (v1.0.609). Everything is in the card game's own files (`scripts/fabula-arcana/*`, `assets/fabula-arcana/*`), plus host timer logic in `fa-host.js`. No world data. No new `module.json` entries.

## Rule changes (please read)

- **Hina's Foretell is now a window, not a turn order.**
    - Both sides choose at the same time again. When the opponent's card lands, it flips face up for the Hina player (host message `foretold`; the window keeps that player's half-made pick).
    - That player always gets at least `CFG.FORETELL_S` (10 s) after it: a per-seat deadline in the host (`s.fore`). The other side's timeout fires first, so their auto-Pass opens the window. Stalling gains nothing.
    - Hina may also play first, blind. An AI holding Hina waits for the card.
- **Smoke Bomb:** this round's attack ignores DEF: printed DEF, Kalina's landing DEF, and Golem Fragment.
- **Golem Fragment:** now worded "+3 DEF". The numbers are unchanged: it still counts after the element bonus and can block a hit to 0.
- **SPD max 5 (`CFG.SPD_MAX`).** Printed SPD still tops out at 4. Café au Lait and Sylph's Tailwind can push a card to 5.
- **Roo** is unchanged from v1.0.609 (its ordinary attacks deal 0).

## Retunes

| Card | Change | Why |
|---|---|---|
| Gigas | ATK 4 → 5 | 32% (skilled) after the Smoke change |
| Rock Golem | HP 9 → 11 | Smoke Bomb now counters its DEF 2 |
| Kalina | DEF 5 → 6, HP 10 → 11 (landing hit ATK 6) | Boss cards ~55-60% (user) |
| Geist | DEF 1 → 2 | Same |

## New cards

The 9 character cards (`character:true`) never drop from monsters.

| Card | Cost · El · Role | ATK/HP/DEF/SPD | Ability |
|---|---|---|---|
| Blanche | ★★★ Phys Support | 3/12/2/2 | Pass as active: lowest-HP benched ally heals 2 |
| Keren | ★★★ Fire Striker | 1/12/0/3 | Fox Fire: +2 ATK per KO'd card (either side, max +6), counted while benched. The AI holds her back. |
| Gryphon | ★★★ Air Guardian | 3/11/1/4 | Slipstream: +2 DEF vs an attacker slower **this round** |
| Love | ★★★ Light Support | 1/11/2/3 | Switching Love out: the incoming card gets +2 ATK / +2 DEF for 4 rounds |
| Jack | ★★ Poison Hunter | 3/10/0/3 | Attacks ignore DEF · Twin: +1 ATK if Jill falls |
| Jill | ★★ Phys Guardian | 3/12/0/2 | Berserk at ≤ half HP: +3 ATK, takes +1 · Twin: +1 ATK if Jack falls |
| Princess Hilde | ★★★ Light Support | 2/13/1/3 | End of round while active: benched allies heal 2 (weak on purpose, the user's call) |

Jack and Jill are ★★ and keep two abilities: a story exception from the user.

**Carlbero changed:**
- It now joins the pool as a regular monster card, so it **can drop**.
- New design: ★★★ Poison Punisher 3/10/1/2. Stinking Breath: −1 ATK, −1 DEF and −1 SPD for 3 rounds. This replaces the unused "Fortify" design.

## Balance

Bot sim, 3000 casual / 1500 skilled games, with all cards in the pool:
- Cards win 25-63%. Princess Hilde is the bottom by design.
- Round-cap games: 3.9% casual / 1.4% skilled (baseline 1.4-1.8%). Draws 1.7-3.3%.
- An anti-stall pass replaced a proposed sudden-death rule (the user rejected it).

## Verified

- `fa-engine.test.mjs`: 128/128.
- Staging two-player duels for every batch. All new effects fired and there were no client errors.
- Not yet seen at the real table: the new status tiles and heal/buff beats.
