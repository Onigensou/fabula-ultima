---
id: 2026-11-10-battle-grade-v2
title: Heads-up — Battle Grade v2 (new battle rank, MVP, Bonus Board, MVP Prize) touches battle-end + BD events
status: open
severity: info
reporter: onigensou
assignee: sarunphat
component: battle-director (battle-end orchestrator/rank/summary, director-battle-log, director-boot, skill-effects grantApply payload, new battle-grade/*), scripts/battle-end summary UI listener
introduced_in: v1.0.586
fixed_in:
---

# Battle Grade v2: what changed in code you also work in

Written for sarunphat and the Claude session that runs the pull. Nothing here needs action unless you
object to a shared-file change in section 2. Sections 1–4 were written before the build; section 5 is
what shipped.

## 1. What it does

The Victory screen's rank was a fun summary (Speed 50 + Damage 20 + Heal 9 + Tactics − Mistakes) that
read the battle log table, which only keeps the last 30 rows. It is being rebuilt so the rank means
something:

- **Five gauges**, each measured against the encounter: Tempo (rounds vs a Par from FU ranks), Exploit
  (weak hits, crits, statuses landed, per action), Precision (misses, resisted/immune/absorbed choices),
  Guard (KOs, enemy hits taken, damage taken vs prevented, heals on allies in Crisis), Teamwork
  (buffs, debuffs, Cover, items on allies).
- **Harder S**: 92+, no ally KO, and a fight that isn't trivial for the party's level. Trivial fights cap at B.
- **MVP**: share of each lane (Offense, Exploit, Guard, Support) weighted by how much the lane mattered.
  One title per character.
- **Bonus Board** (party, EXP only): +1 slot per gauge ≥90% beyond the first two, −1 per gauge <50%,
  −2 per KO; cleared by a wipe or fleeing; resets at session open. Perks +5/+10/+15% EXP, applied
  through `computeExpAward`'s existing `mult` at PREP.
- **MVP Prize** on S only, rotating bag: Fabula +1 (through the Fabula Ledger), Zero Power +1,
  Hako Coupon ×1 (party pool, `grantCoupons`), Zenit max(250, 10% of party battle Zenit).
- Victory screen: same layout and timings, plus a title row per card, MVP ribbon, a radar chart left of
  the totals, a board strip and the prize reel. Everything stays left of ~690 px (token zone).
- Approved mockup: claude.ai/artifact/BPgneV83ziwzd8UeNfkWoL.

## 2. Shared files that will change

| File | Change |
|---|---|
| `battle-director/director-battle-log.js` | **Already done** (e24d85bd): a compact every-row battle record beside the capped queue, so rank + totals read the whole battle, not the last 30 rows. |
| `battle-director/battle-end/battle-end-orchestrator.js` | Reads the record; runs the new grade; updates the board; pays the MVP Prize; clears the board on escape/defeat. |
| `battle-director/battle-end/battle-end-rank.js` | Replaced by the new grade (old score kept in the log for comparison while tuning). |
| `battle-director/battle-end/battle-end-summary-ui.js` | Payload grows (gauges, MVP, titles, board, prize). |
| `battle-director/battle-end/battle-end-rewards.js` | Passes the board's EXP multiplier to `computeExpAward`. |
| `battle-director/director-boot.js` | `start()` clears the per-battle record/tally (fresh battles only; resume untouched). |
| `battle-director/skill-effects.js` | **Additive payload only**: `grantApply`'s `creature_gain_resource` event gains `preValue`, `overheal`, `wasInCrisis` so heals can be judged. No behaviour change. |
| `scripts/battle-end/battleEnd-summaryUI-listener.js` | Victory screen additions (compact layout). |

New files: `battle-director/battle-grade/` (pure grade math + tests, the per-battle tally collector, board/prize state).

## 3. How the tally listens (no new dispatch)

- A builtin reactor (`registerBuiltinReactor`) for ledger-family events: `creature_lose_resource`,
  `creature_gain_resource`, `creature_status_applied`, `creature_defeated` path (via lose_resource).
- `fu-director-trigger` for `creature_hit_by_action`, `creature_miss_action`, `creature_guards`.
- `fu-director-action` / `fuBattleActionResolved` for per-character action counts.
- Sides come from `dCombat.combatants[].side`. The tally is stored in a world setting (survives F5), and
  rows from rounds undone by a rewind are dropped on the `fu-director-stopped {reason:"rewind"}` → resume.

## 4. Things noticed on the way (not fixed, your call)

- Battle-log rows never carry sides: `buildDamageRow`/`buildMissRow` hard-code `dealer.disposition:
  "neutral"` and the hit path never passes `targetDisposition` (`state-handlers.js` logContext). The rank
  has always worked out sides by name.
- Most heals write no battle-log row; only AB-absorb and Drain do. Total Healing on the Victory screen has
  therefore under-counted spells like Heal/Cure. v2's tally counts them.
- A rewind does not trim `battleLogPending`, so undone actions stay in the battle log.

## 5. As shipped (v1.0.586)

**Numbers that changed during the build** (all constants in `battle-grade/grade-core.js` `G`):
- Guard: -10 per ally KO; up to -6 as enemy hits land, measured as a share of the hits expected for the
  fight (enemy activations x Par), not a flat -1 per hit (that made S impossible); up to -9 for damage
  taken vs party max HP; up to +4 back from Guard/Cover and heals on allies in Crisis.
- Only Tempo, Precision and Guard can get a cross (under 50%). Exploit and Teamwork only earn stars.
- Hard/Boss bonus +3 (was +5 in the plan): calibrated on real sandbox fights.
- Teamwork counts full when a fight ends within round 1 before every party member acted (a one-turn
  wipe has no time for support). Guests / summons don't count.
- MVP support-lane weight = support share of actions, capped 0.6.
- Effects applied before the first action (conflict-start passives) are not counted.

**Also shipped:**
- `battleEnd-summaryUI-listener.js`: while the Victory screen plays, `body.oni-sum-focus` hides
  #hotbar / #players / #controls / #logo / #navigation / dev tools. BATTLE_ENDING destroys the GM desk
  (and Battle Focus) before the summary runs, so they came back under the screen. On a window shorter
  than ~1000 px the overlay scales down so the board strip stays in view (1080p unchanged).
- Console: `FUCompanion.api.battleGrade` = `{ readTally, clearTally, readBoard, boardExpMultiplier, last }`.
  `last` holds the last battle's roster, events, rows and grade ("why did we get B?").

**Verification:** 50 node tests (`node scripts/battle-director/battle-grade/grade-core.test.mjs`).
16 real Battle Director fights in a private sandbox with the full battle end (sim party, prompt
auto-confirmed): grades, board moves, all four prize types, titles, the Victory screen (watched on GPU).
Checked: a new Ledger session resets the board; fleeing clears it with no rank; F5 mid-battle keeps the
tally. Not yet seen live: a rewind trimming the tally, a player client's view, two GMs (the prize is
paid on the BD host; FP goes through the Ledger's own primary-GM forward).
