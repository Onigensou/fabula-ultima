# Fabula Arcana character cards + playtest fixes (v1.0.609)

Follow-up to `2026-11-14-fabula-arcana-polish.md` (v1.0.606). It adds five ★★★ **character cards**, plus fixes from a friend playtest in the main world on 11-14. All changes are in the card game's files, plus small host logic in `fa-host.js`. No world data. No new `module.json` entries.

## New: character cards (please read)

These are PCs, NPCs and bosses as cards, always ★★★ (one per 5★ team). They are flagged `character:true` in `fa-catalog.js`, and they **never drop from monsters**: `fa-drops-core.js` `matchCard` skips them. Otherwise a fight against a boss named "Geist" would have dropped his card at 100%. They are given by hand for now (`fabulaArcana.grantCard`).

Stats were picked by bot sim (the scratch sim plus `fa-balance.mjs`). The table shows each card's win rate in random full 5★ teams with all five in the pool.

| Card | El | ATK/HP/DEF/SPD | Ability | Win % (casual / skilled) |
|---|---|---|---|---|
| Hina | Light | 4/11/1/1 | **Foretell**: while she is active, the opponent chooses first and her side sees that card | 55 / 52 |
| Zarg | Physical | 3/9/0/4 | **Barrage**: every attack also deals 2 to the benched enemy with the lowest HP | 42–45 / 49–52 |
| Raubens | Elementless | 3/10/1/2 | **Bandit King**: +1 ATK for the rest of the match per item the opponent uses while he is active | 56 / 57 |
| Geist | Dark | 3/5/1/3 | **The Blackest Night**: the first time he would hit 0 HP (any source, also on the bench) he rises at full HP; overflow is lost | 39 / 55 |
| Kalina | Air | 1/10/5/3 | **Jump**: a Pass = she Jumps (still attacks), then lands next round with ATK and DEF swapped | 49 / 53 |

SPD comes from each sheet's DEX die, as for monsters.

**Foretell changes the turn order. This is the one rule that touches the network flow:**
- Engine: `Match.needs` holds the Hina seat until the other seat has committed (`Engine.foretellSeat`). `Match.publicView` shows that committed card to the Hina seat only; spectators still see it hidden.
- Host: when the other side commits, `submit` calls `decide()` again, so the Hina player gets a fresh clock. It sends that seat a `state` (with the card) instead of `committed`.
- Stalling: it only burns the staller's own clock, and a timeout is an auto-Pass, which Hina then sees.
- If both active cards are Hina, the round is normal and simultaneous.
- An AI holding Hina plays the best one-round answer to the seen card (`foretellPick`).

**Art:**
- Card faces are stills of the battle sprites, on Forge at `Fabula Arcana/Character Cards/<Name>.png`.
- The board hologram plays the animated battle `.webm` (`HOLO_VIDEO` in `duel-assets.js`), mirrored because those sprites face left.
- They still have baked ground shadows (legacy art).

## Playtest fixes

- **Geist revive had no visual feedback.** Players saw "0 damage". It now plays a short version of the battle cinematic's rise (`battle-end/undying/blackest-night-cinematic.js`):
    - KO dim, two heartbeats, a flash;
    - an aura copy of the sprite scales out with a violet/red burst, `MG_DEATH_BLUR01.wav` and a shake;
    - the HP bar refills.
  `ev.revive` is mirrored for seat 1 in `View.resolvedForSeat`.
- **Cryo/Aero Explosion was invisible.** It now shows a −2 number and an ice/wind burst on the attacker, whose HP drop waits for it.
- **Roo dealt 1 on ordinary attacks.** Its normal attacks now deal 0: no min-1 floor and no element bonus. They no longer use up Thick Skin / Pyrophagy / Earthen Wire. Only the knife hurts. Re-sim: 44 / 48.
- **Zarg felt too strong:** HP 10 → 9. Cutting Barrage to 1 instead dropped him to 34–40% for the skilled AI.
- **Unready in team select** (foundryvtt-bf): new host op `unready`.
- **Watch boards now close** about 6 s after a duel ends for good: series over, surrender, leave or forfeit (`releaseSpectators()` in `fa-host.js`).
- **Test:** the Rock Golem test now follows the decided next-attack Wind Up timing (`WINDUP_NEXT=1`). `fa-engine.test.mjs` is 103/103.

## Verified

- Staging World, real two-player duels:
    - the Foretell lock and reveal, both views;
    - every ability firing in the log;
    - instrumented runs where revive/aura/burst play on both seats;
    - no client errors.
- Unready/spectate: `fa-unready.mjs` 13/13.
- Not yet seen at the real table: the revive and burst visuals.

Also in this push, unrelated to the card game: `b3e8f659`, a guard for legacy characters failing data preparation on load (`csb-derivation-perf.js` + `_restore-legacy-item-templates.js`).
