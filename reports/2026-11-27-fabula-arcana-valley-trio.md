# Fabula Arcana: Valley trio cards — Asura, Rakshasa, Deva (v1.0.692)

2026-11-27 · branch `feat/fa-valley-trio`. Three ★★★ monster cards for the Valley story elites, so the cards drop
when the party beats them. Designed and approved on the card ledger (round 1 picks, round 2: Rakshasa SPD 1,
Deva switches Light/Dark). The pool grows from 51 to 54 cards.

## The cards (ATK / HP / DEF / SPD · win % vs random full teams, casual / skilled, 2 seeds × 3000 / 1500)

| Card | | Stats | Ability | Win % |
|---|---|---|---|---|
| Asura | ★★★ Physical Combo | 4/10/0/3 | **Ascension:** After an attack of a new element damages this unit: +1 ATK for the rest of the match (max +3). Elementless doesn't count. | 49.3 / 55.4 |
| Rakshasa | ★★★ Dark Guardian | 4/14/0/1 | **Weapon Read:** Takes −1 DMG from the card that damaged this unit last. | 48.9 / 45.0 |
| Deva | ★★★ Light/Dark Striker | 3/12/1/2 | **Celestial Discipline:** Odd rounds: this unit is Light and gains +1 DEF. Even rounds: this unit is Dark and gains +1 ATK. | 50.5 / 51.5 |

Each card is a small version of its boss's gimmick: Asura collects elements, Rakshasa reads the weapon that keeps
hitting it, Deva has Guard and Offense rounds and her weakness flips like her Fury / Focus forms.

## How players get them

- **A sure drop.** They are elites (normally a 40% roll), but these are one-off story fights, so a card marked
  `dropAlways` rolls like a champion: every PC who doesn't own it gets it on the win, shown on the Victory screen.
  The card is found by the actor's name (Asura, Rakshasa, Deva); no world change.
- **No spoilers.** `noRandom` keeps them out of `randomTeam()`, the team an NPC with no deck of its own gets. Starter
  gifts are commons only, and the Cards tab and team builder list owned cards only.

## Code

| File | Change |
|---|---|
| `fa-catalog.js` | 3 cards + SPD; `ASCENSION_MAX 3`, `WEAPON_READ 1`, `DISCIPLINE 1`; card marks `dropAlways`, `noRandom`, `elEven` (Deva's element on even rounds) |
| `fa-engine.js` | `elOf(m)` = a card's element right now (the chart in attacks, Apple Bomb, Wildfire Kiss and the AI read it); Ascension marks + ATK; Weapon Read; Celestial Discipline (ATK on even rounds, DEF on odd); `randomTeam()` skips `noRandom` cards; log lines for all three |
| `fa-drops.js` | a `dropAlways` card rolls as a champion |
| `duel.html` | `elNow(m)` (same rule as the engine): Deva's frame, coin and stat badge flip with the round; live stats and status tiles (Ascension marks, Weapon Read target, Guard / Offense round) |
| `duel-assets.js`, `fa-const.js` | card stills `Fabula Arcana/Monster Cards/<Name>.png` (Forge, uploaded 11-27, shadow-free first frames of the battle idles); holograms play the battle idles, Deva's Fury clip on Light rounds and Focus clip on Dark rounds |
| `fa-balance.mjs` | ability-fired patterns |
| tests | engine pool 54 + 4 new checks; drops: name match + sure drop for every PC who lacks the card |

## Tests

- Engine **215 pass**, drops pass.
- Seeded sims through this branch's engine match the design harness exactly (same seed, same numbers).
- Whole pool (4000 / 2000 games): round cap 3.2% / 1.2% (before 4.0% / 1.6%), draws 3.2% / 1.7% (before 3.5% / 1.9%).
- Lab (headless server on a world copy, this branch's module): drops granted all three to Hina and Zarg from elite
  rolls at 0.999, none again on a second win, card items use the new stills; two practice duels through the real host
  and duel window ran to the end with the ability lines in the log (Deva vs Rakshasa: Discipline ×4, Weapon Read ×4;
  Asura: Ascension ×5); the board showed Deva's Dark frame + Focus clip on round 2. No page errors from our code
  (the only one was the Forge module asking the unsigned lab to log in). Lab removed.

## Not verified

- A real battle win against the actual bosses (drops were driven through `rollCardDrops` with the real actors).
- How the holograms look on a GPU client at the table (the lab ran without a canvas; the duel window is DOM).

## Side finding (not acted on)

All-card focused sims (1500 / 700, seed 11): Geist 66 / 82, Gryphon 58 / 64, Carlbero 54 / 62, Hako 27 / 48,
Roper 43 / 39 sit outside 40–60%. They are on the card ledger for tuning.
