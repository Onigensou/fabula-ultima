# ⭐️ Hilde-Fafnir — Final Boss Design Notes

**Status:** DRAFT — benchmark. **Implemented in the world** 2026-09-20 as a benchmark kit;
**not final** — numbers are placeholders for fight simulation, more design passes to come.
**Benchmark:** 2026-09-20
**Actor:** `2SFrEMqLBfqzc7Nj` (champion, L55, Fafnir Castle final boss)
**Build scripts:** `tools/safe-edit/bin/_build-hilde-fafnir.js` (the 2026-08-29 base — do
NOT re-run on the live actor, it rebuilds from a donor) + the benchmark delta
`_hilde-benchmark-aes.js` then `_hilde-benchmark.js`.

---

## 1. Concept — Culling the Weak

Hilde-Fafnir's actions revolve around **killing characters who are weakened or near death
outright**. Heavy Crisis interaction: Cripple pushes targets into Crisis, Execute finishes
them, and her Zero gauge feeds on the party falling.

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
| **Wyrmbreath** | Spell, heavy Dark, all enemies, 40 MP (unchanged) | `mp` 20–100, prio 6, cooldown 1 |
| **Dragoon Lance** | Attack, **devastating (+70)** Physical, **vs MDEF**, **Execute** | `enemy_has_status: Crisis`, focus `status_focus: Crisis`, prio 3 |
| **Claw** (new) | Attack, **devastating (+70)** Physical, **vs DEF**, **Cripple** | `enemy_lacks_status: Crisis`, focus `status_avoid: Crisis`, prio 3 |
| **Zero Trigger: Contempt** (new) | Passive — §5 | — |

The loop: **Claw pushes a PC into Crisis → Contempt charges → Dragoon Lance or
Reinslaughter culls them.** Between the two fillers one is always legal (someone is in
Crisis, or someone isn't).

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
| Dragoon Lance Execute | 81 vs full HP, **162** vs Crisis |
| Claw Cripple | **162** vs full HP, 81 vs Crisis |
| Reinslaughter curve | 60 vs full HP, **454** vs 1 HP; applies Culling to self |
| Redirect (engine path) | Hina covering a 1-HP ally: +394 on her slots; Protect by a full-HP ally: +394; no redirect: +0 on the full-HP target |
| Contempt gates | Crisis alive → fires · Crisis at 0 HP → blocked · KO → fires · while Culling → both blocked · her own ally / other status → no match |
| Contempt grant | +1 ZP per fire on the token actor |
| Lance of Ruin | both targets → 1 HP; no Lance Spent stamp |
| AI picks | R2 & R5 below 60% → Lance · R3 / 70% HP / 100 MP → no Lance · ZP 6 → Reinslaughter · fillers split 6/6 by Crisis state, each aimed correctly |
| Linters | `runReactionLint` / `runTemplateEngineEnums`: nothing on her content |
| skill-regression | 487/487 match golden — engine change moved no other skill |

**Not yet covered:** a full live battle (Contempt dispatch inside a real settle, Lance's
Crisis emit, Culling clearing on her next turn). Harness limits hit on the way are fixed
in `02c51038` (attack simulate ignored `npcAttackItemUuid`; targeted probe could not fold
a performer rider with a redirect).

---

## 9. Tuning — deferred to fight simulation

- **Pace at 1 turn/round.** Wyrmbreath (prio 6, cooldown 1) takes every other non-Lance
  turn while she has ≥20% MP, so the Claw / Dragoon Lance fillers appear only on the
  alternate turns — and Wyrmbreath's 40 MP also eats into the Lance budget.
- Reinslaughter curve (base 60, +400 ceiling).
- Filler damage (+70 devastating ×2 = ~160 per Execute/Cripple hit can one-shot a ~100-HP
  PC from full on a Claw).
- Lance of Ruin cost (150) and schedule (2 / 3).
- Absorb interaction for Reinslaughter.
