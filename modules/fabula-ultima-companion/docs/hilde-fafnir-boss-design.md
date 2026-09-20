# ⭐️ Hilde-Fafnir — Final Boss Design Notes

**Status:** DRAFT — benchmark, second pass (fillers reworked 2026-09-20). **Implemented in the world** 2026-09-20 as a benchmark kit;
**not final** — numbers are placeholders for fight simulation, more design passes to come.
**Benchmark:** 2026-09-20
**Actor:** `2SFrEMqLBfqzc7Nj` (champion, L55, Fafnir Castle final boss)
**Build scripts:** `tools/safe-edit/bin/_build-hilde-fafnir.js` (the 2026-08-29 base — do
NOT re-run on the live actor, it rebuilds from a donor) + the benchmark delta
`_hilde-benchmark-aes.js` then `_hilde-benchmark.js`.

---

## 1. Concept — Culling the Weak

Hilde-Fafnir's actions revolve around **killing characters who are weakened or near death
outright**. Heavy Crisis interaction: Execute finishes anyone already low, the Lance drops
the whole party to 1 HP, and her Zero gauge feeds on the party falling.

She is the **final boss of the game — go hard**. She tries to kill PCs. A KO is an
expected outcome, not a design bug, and there is deliberately **no recovery window**
after Lance of Ruin.

---

## 2. Stats (unchanged by the benchmark)

| Stat | Value |
|---|---|
| HP / MP | 2400 / 500 |
| DEF / MDEF | 18 / 18 |
| Init | 16 |
| Max Zero | 6 |
| Ultima Points | 5 |
| Turns / round | **1** (`activation: "1"`) — see §9 |
| VU | none (boss) |

The 2026-08-29 build comment and the first draft of this doc said "4 turns a round"; the
actor carries `activation: "1"` and the director reads exactly that.

---

## 3. Kit as built

| Action | Shape | AI row (priority ↓) |
|---|---|---|
| **Zero Power: Reinslaughter** | Active, Bolt, all enemies, 6 Zero Power — §6 | `zero_power` 100–100, **prio 20** |
| **Lance of Ruin** | Active, all enemies → 1 HP (`crush`), **150 MP** | `round` **2 / 3** (rounds 2, 5, 8 …), `hp_ceiling 60`, **prio 12** |
| **Wyrmbreath** | Spell, heavy Dark, all enemies, 40 MP (unchanged) | `mp` 20–100, **prio 5**, cooldown 1 |
| **Impalement** (was Dragoon Lance) | Attack, **devastating (+70)** Physical, **vs MDEF**, **Execute** (inherent keyword) | `enemy_has_status: Crisis`, focus `status_focus: Crisis`, **prio 4** |
| **Scorched Claw** (was Claw) | Attack, **heavy (+52) Fire**, **vs DEF**, **+25% of the target's max HP** | `always`, focus `auto` (spread), prio 3 |
| **Zero Trigger: Contempt** (new) | Passive — §5 | — |

**Filler rework (2026-09-20).** Cripple is gone: Scorched Claw is the single
always-on filler, and its bonus scales with the target's **maximum** HP, so it stays
relevant at any level and bites the big HP pools hardest (+17 vs 69 max, +24 vs 98,
+41 vs 166). Impalement sits ONE priority above it, so when a Crisis target exists the
picker splits ~**60/40** in its favour (weights 3 vs 2) rather than always taking it.
Wyrmbreath dropped 6 → 5 because the picker only keeps rows within **2** priority of
the best available one: at 6 it pushed the Claw (3) out of the window entirely.

With Cripple gone, nothing deliberately pushes healthy PCs into Crisis any more, so
**Contempt now charges almost entirely off Lance of Ruin** — the gauge fills in one
step and Reinslaughter follows the Lance.

---

## 4. Signature — Lance of Ruin (periodic)

- **Effect unchanged:** all enemies reduced to 1 HP, via `crush` (no DR, ignores immunity).
- **Periodic:** the AI's `round` condition (A + B·X) allows it on **rounds 2, 5, 8, …**,
  only below **60% HP**, only with **150 MP** to pay. A missed slot (above 60%, short on MP,
  or Reinslaughter took the turn) waits for the next one — it also keeps Lance and the
  Zero Power from landing back to back. The old once-per-conflict `Lance Spent` stamp is
  retired (row kept `$deleted`).
- **Tell — deliberately vague.** MP is not shown. Players who Study her see max MP and can
  estimate how many Lances she can afford, and can learn the "every few rounds" rhythm.
- Lance of Ruin **does** proc Contempt (§5): the whole party enters Crisis at once.

**Rotation intent:** Lance forces the whole party to 1 HP → a **healing check** that
breaks the party's tempo, with Reinslaughter looming over anyone left low.

---

## 5. Zero Trigger — Contempt

> Whenever an enemy **enters Crisis or is reduced to 0 HP**, Hilde-Fafnir gains 1 Zero Power.
> Reinslaughter does not feed it.

How it is built:
- Row 0 — `creature_status_applied`, status `Crisis`, source `enemy`, condition
  `TARGET_CURRENT_HP > 0 && AE_COUNT_CULLING == 0`.
- Row 1 — `creature_defeated`, source `enemy`, condition `AE_COUNT_CULLING == 0`.
- **One event per hit.** The crisis reactor applies Crisis even at 0 HP, so a one-shot
  fires both events; row 0 only counts a victim still standing, row 1 counts the KO.
- **Reinslaughter exclusion:** Crisis / defeat events carry no source skill, so
  Reinslaughter stamps an invisible **Culling** AE on her (1 charge — clears at the start
  of her next turn) and both rows are muted while she carries it.

---

## 6. Zero Power — Reinslaughter (version 1, revised)

> Deal devastating Bolt damage to all enemies. Damage increases the lower the target's HP.
> A creature that takes the hit in another's place takes it as that creature would have.

- **Damage:** base **60** + `floor(400 × (1 − ORIGINAL_TARGET_CURRENT_HP / ORIGINAL_TARGET_MAX_HP))`
  — +0 at full HP, **+394 against a 69-HP target on 1 HP (454 total)**. Folded into the
  card as a force-mode `creature_will_deal_damage` rider.
- **No Execute keyword** — the missing-HP curve is the execute.
- **Counterplay costs a life.** `ORIGINAL_TARGET_*` (engine, commit `c8fa00d9`) reads the
  creature a Protect / Prophetic Defender slot was **originally aimed at**, so the defender
  takes the covered ally's hit. A defender holding several slots reads the lowest HP% among
  them, and — because the damage pass merges one token's slots — **every slot on that
  defender carries that value, their own slot included**.
- **Affinity** applies as the system does today (Hina's Bolt RS halves 454 → 227 per slot).
  Intent for later tuning: a final-boss Zero Power should not be shut down by absorb.
- No accuracy roll — an Active, like every shipped Zero Power (Meteor Impact).

**Rejected — version 2** ("Crisis targets reduced to 0 HP automatically"): no counterplay
once it lands, and it overlaps Death Gaze in the same dungeon.

---

## 7. Animation concept (NOT implemented)

**Reinslaughter** — **effort: Highest.**
Hilde-Fafnir flies up into the sky, raising large swirling stormclouds, then looses
thousands of lightning arrows that rain down across the battlefield.

---

## 8. Verification — 2026-09-20 (live client, harness + engine calls)

| Check | Result |
|---|---|
| Impalement Execute (keyword-driven) | 81 vs full HP, **162** vs Crisis — and 81 vs a healthy target in the SAME volley |
| Scorched Claw max-HP scaling | +17 / +24 / +41 against 69 / 98 / 166 max HP (raw 80 / 87 / 100) |
| Migrated Execute elsewhere | Kirin Horn Rush **146** vs Crisis / 73 vs healthy, with 0 riders left on the item |
| Reinslaughter curve | 60 vs full HP, **454** vs 1 HP; applies Culling to self |
| Redirect (engine path) | Hina covering a 1-HP ally: +394 on her slots; Protect by a full-HP ally: +394; no redirect: +0 on the full-HP target |
| Contempt gates | Crisis alive → fires · Crisis at 0 HP → blocked · KO → fires · while Culling → both blocked · her own ally / other status → no match |
| Contempt grant | +1 ZP per fire on the token actor |
| Lance of Ruin | both targets → 1 HP; no Lance Spent stamp |
| AI picks | R2 & R5 below 60% → Lance · R3 / 70% HP / 100 MP → no Lance · ZP 6 → Reinslaughter |
| AI fillers | nobody in Crisis: **only** Scorched Claw, spread 6/6 · one in Crisis (24 runs): Impalement **58%** aimed at them, Claw 42% |
| Linters | `runReactionLint` / `runTemplateEngineEnums`: nothing on her content |
| skill-regression | 487/487 match golden — engine change moved no other skill |

**Not yet covered:** a full live battle (Contempt dispatch inside a real settle, Lance's
Crisis emit, Culling clearing on her next turn). Harness limits hit on the way are fixed
in `02c51038` (attack simulate ignored `npcAttackItemUuid`; targeted probe could not fold
a performer rider with a redirect).

---

## 8b. Execute / Cripple are engine keywords now (2026-09-20)

The ×2 used to be authored per item as a `creature_will_deal_damage` rider scoped by
`reaction_source_skill` — the rule fired because the skill was **named** a certain thing,
which broke silently on rename and left the keyword itself inert. Engine commits
`43d5f077` + `2a2ebc39`: any action whose `action_keywords` carries `execute` doubles
against a target already in Crisis, `cripple` against one that is not, read from the same
inherent-keyword union as pierce/crush.

- Authoring is now typing the keyword. Impalement carries `execute` and **no rider**.
- The 5 items that already declared the keyword AND carried a rider were migrated
  (`_migrate-execute-cripple-keyword.js`) — Rakshasa ×4, Kirin Horn Rush. All had live
  riders, so damage is unchanged; a leftover row would have stacked to ×4.
- `Beyond the Realms of Death` (PC skill, 4 copies) keeps its rider: it declares no
  keyword and carries extra clauses of its own.
- ⚠ The card badge still comes from the **description link**, not from `action_keywords`.
  Author both, exactly as Rakshasa/Kirin do.

## 9. Tuning — deferred to fight simulation

- **Pace at 1 turn/round.** Wyrmbreath (now prio 5, cooldown 1) still takes roughly half
  her non-Lance turns while she has ≥20% MP (measured 11/20 and 15/20), so the fillers
  fill the rest — and Wyrmbreath's 40 MP still eats into the Lance budget.
- **⚠ Scorched Claw is FIRE and this party answers Fire hard: Hina ABSORBS it (the Claw
  heals her) and Blanche RESISTS it (100 → 50).** With spread targeting her only
  always-on filler is a heal roughly a quarter of the time. Options: change the element,
  switch the row to `by_affinity` focus, or accept it as earned counterplay. Open.
- Reinslaughter curve (base 60, +400 ceiling).
- Filler damage: Impalement ×2 = ~162 kills essentially any Crisis PC (intended). Scorched
  Claw 80–100 raw is ~77% of Hina's bar and ~60% of Blanche's before affinity.
- Lance of Ruin cost (150) and schedule (2 / 3).
- Absorb interaction for Reinslaughter.
