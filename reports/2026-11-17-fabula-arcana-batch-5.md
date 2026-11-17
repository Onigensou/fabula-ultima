# Fabula Arcana: batch 5 (Geist +1, Kalina rework, Hako, Golem Fragment rule)

One new ★★★ character card (Hako), a full rework of Kalina, a buff for Geist, and a rule change for Golem Fragment. No world data. Branch `feat/fa-batch5`.

## Cards

| Card | Element / Role | ATK/HP/DEF/SPD | Ability |
|---|---|---|---|
| **Geist** ★★★ (changed) | Dark Guardian | 3/5/2/3 (unchanged) | **The Blackest Night**: as before, plus **+1 ATK for the rest of the match once he has risen**. |
| **Kalina** ★★★ (reworked) | Air **Pivot** (was Combo) | **2/11/2/3** (was 1/11/6/3) | **Skyfall Dive**: after she attacks she always hops out, and a benched ally of your choice steps in. If she struck first, that ally takes the enemy's attack. She is then **Dive Ready**: the next time she is switched in or sent in after a KO, she drops on the enemy card for **2** damage (ignores DEF and items). The old Jump (ATK/DEF swap) is gone. |
| **Hako** ★★★ (new) | Elementless Support | 3/12/0/2 | **Trusty Supplier**: at the start of each round, if Hako is your active card and **3 or more** of your item cards are used up, one of them (random) comes back to your hand. |

- Kalina hops only when she actually attacked and is still standing, and only if an ally is alive. A plain Switch out of her gives no Dive Ready.
- The card that hops in counts as "switched in" this round. So Fulgimite's Evasion and Roper's Entangle react to it, as for any voluntary switch-in.
- Hako's art is `Character/Hako/Hako Standard.png` with the baked shadow removed, uploaded as `Fabula Arcana/Character Cards/Hako.png`. Her SPD 2 comes from her DEX d8.

## Rule change: Golem Fragment is a real +3 DEF

- Golem Fragment now adds 3 to the card's DEF before damage. Like any DEF, a hit always does at least 1. **It can no longer block a hit to 0.**
- Smoke Bomb still ignores it.
- Bruce V's "ignore 2 DEF" now counts against Golem's +3 too, so 4 ATK vs Wolf + Golem = 3.
- This is the change deferred on 11-16. It was needed to stop a Hako stall-lock: loop Golem Fragment every round behind Hako and run out the 20-round cap.

## How Kalina's hop works

- The player picks who steps in **when they play their card**, not mid-round.
- With two allies standing, a banner asks "Kalina hops out after her attack: who steps in?" (Back cancels). With one ally it's automatic.
- The choice goes with the commit as `{ action, hop: rosterIndex }`.
- If it's missing (timeout, AI) or no longer valid (that ally fell), the engine picks the ally that takes the least from the enemy's attack.
- The round animation shows her strike, then a leap out of view, then the ally coming in, then the rest of the round.

## Code

- **fa-catalog.js:**
  - the three cards, and Hako's SPD
  - Golem Fragment's text is now "+3 DEF this round"
  - `CFG.GEIST_BN 1 / DIVE 2 / SUPPLY_MIN 3`
- **fa-engine.js:**
  - `calcAttack`: Geist's bonus; Golem Fragment in the DEF total; the Jump landing is removed.
  - `resolveRound`: the hop after Kalina's strike (`ev.hop: [{ s, from, to, at }]`, where `at` = how many strikes happened first, or `null` when both hit together), and the Dive on a voluntary switch-in (`ev.dive`).
  - `resolve()`:
    - The Dive on a KO replacement. It can KO the enemy card, which then replaces.
    - Hako's restock as the next round begins (`ev.supply: [{ s, k }]`). Replacement steps now carry an `ev` too.
  - `Match.validate` / `submit` take the optional `hop`, and `View.resolvedForSeat` flips the new events for seat 1.
  - AI hints: bring Kalina back to finish a card at 2 HP or less, send Hako in once 3+ items are spent, take her out once the hand is restocked.
- **Duel window:**
  - the hop banner, the hop animation, and the Skyfall Dive landing: leap, falling streak, impact flash and dust, hard shake, damage pop, and she lands back in her spot. No floating words.
  - a Dive Ready tile on Kalina, a Trusty Supplier tile (n / 3 items used) on Hako, and the restocked item flying back to the item strip
  - Geist's risen tile shows "+1 ATK", and the bonus appears in his ATK stat
- **Tests:** `fa-engine.test.mjs` 173 pass. Added:
  - Kalina:
    - hop when faster and when slower
    - no hop as the last card standing
    - no Dive Ready from a plain switch
    - a stale hop target falls back to another ally
    - Dive on a switch-in, and on a replacement (including a KO), plus seat-1 mirroring
    - hop validation
  - Hako: no restock at 2 spent; 1 of 3 at 3 spent; nothing while benched; mirroring
  - Geist: +1
  - Golem: a hit floors at 1, and Bruce pierces it

  The pool is now 39 cards. `fa-drops.test.mjs` passes.

## Balance

fa-balance, 6000 casual / 3000 skilled, seeds 11 and 23:

| Card | Casual | Skilled |
|---|---|---|
| Geist | 61–66% | 74–77% |
| Kalina | 51–61% | 52–59% |
| Hako | 25–28% | 40–49% |

- Round cap 1.2–3.6%; draws 1.4–3.3%.
- **Geist +1 is the strongest card in the pool.** The user chose it ("keep for now"). The fallback is 2/5/2 with +2 after the revive (55% / 66%).
- Hako plays much better in skilled hands than casual ones. The casual AI under-uses the restock loop, so a real player should land nearer the skilled number.
- **Stall checks.** A scripted bot that parks Hako in front and loops items wins 36–40% under the final rules, and games almost never reach the cap. Before the rules were final it was much worse:
  - unlimited restock, today's Golem rule: 75–90% wins, or 70–84% forced draws at 0 ATK
  - restock at 2 spent: still a Golem + Remedy lock
  - Hako with 1 ATK and more bulk: a "chip 1 a round, win on cards standing" lock

  DEF 0 + the Golem min-1 rule + "3 spent" kills all of these.

## Heads-up

- The duel window was checked headless: net mode, the real engine in the page as host. Checked: the hop banner and its commit, the hop, a Dive on a switch-in and after a KO, Hako's restock, Geist's +1, the art, and the facing.
- It was **not** run on the Staging World. The host code is unchanged, and the commit object passes through the bridge untouched.
- Not yet looked at at a real table.
