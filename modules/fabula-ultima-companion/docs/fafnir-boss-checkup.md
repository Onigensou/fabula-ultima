# ⭐️ Fafnir — fight design checkup

**Status:** REPORT ONLY — nothing in the world was changed. Every number is what is on
the actor today (2026-09-20).
**Actor:** `P1uCkpNnxLRBNqZr` — L50, `npc_rank: champion`, folder `Monster / Current Dungeon`.
**Why now:** Fafnir was built before `monster-balance-design.md` existed and has no design
doc of its own.

**Three design facts, supplied by the designer, that this pass is built on** (a first
draft of this report got all three wrong and reached the opposite verdict):

1. **4 turns a round is the champion standard**, not an outlier. Hilde-Fafnir should have
   it too; her `activation: "1"` is **un-entered data, not design**. See §1a — it means her
   published design numbers are all ×4 understated.
2. **Ruinous Breath is a fixed 300-point pool** divided among all *non-KO* enemies. It does
   not scale with party size; it is the same 300 against one PC or four.
3. **Dreadwyrm Descent is meant to be cured**, by the consumable that cleanses all debuffs
   on all allies. It costs the party **one action**, not three rounds of lockout.

**Constraints honoured:** **Dreadwyrm Descent** and **Ruinous Breath** are untouchable —
mechanic *and* numbers. Everything else keeps its mechanic; only numbers are proposed.

---

## 0. The one-paragraph version

**The fight holds up.** Benchmarked against Hilde-Fafnir at the same 4 activations, Fafnir
sits **below the final boss on every axis** and proportionately so for one tier down:
4-round Pressure **3.45 vs 3.83**, whole-fight AoE budget **1352 vs 2112**, effective HP
**2526 vs 2700**, printed HP **1824 vs 2400**. Ruinous Breath's fixed 300-point pool is
*more* conservative than Hilde's Wyrmbreath, which scales with headcount and lands 176
per cast at three times the casting rate. There is **no structural problem and no case
for a rebuild.** What is left is a short list of specific numbers and one real build gap:
**Condemn one-shots healthy PCs**, **`action_pattern_table` is empty so Fafnir has no AI
at all**, **IM dark + dagger EF 50% zeroes a dark-dagger user outright**, and **Cruel
Ultimatum is not a choice**. The single most important finding in this document is not
about Fafnir: **Hilde-Fafnir's activation is wrong on disk, and her design doc's Pressure
figures were computed from it.**

---

## 1. Stat block as built

| | |
|---|---|
| Level / rank | 50 / **champion** |
| HP / MP | **1824 / 400** |
| DEF / MDEF | 16 / 17 (`def_mod +4`, `mdef_mod +5`) |
| Attributes | DEX / INS / MIG / WLP all **d12** |
| Init | 14 |
| Turns per round | `activation: 4` ✅ standard |
| Max Zero / Ultima | 6 / 10 |
| Species / subtype | MONSTER / DRAGON, attribute LIGHTNING |
| Affinities | VU **light** · RS **air, bolt, fire** · IM **dark, earth** · NE rest |
| Weapon EF | **spear 200** · **dagger 50, thrown 50** · rest 100 |
| Status | IM ×11, RS charm/grappled |
| Items | 11 |
| Reward | 5000 zenit flat |

**Deployment:** the only table Fafnir sits on is **`Eisendrache Burning - Enemies`**
(`TjiTEPcFQ4esnpCr`, *RollTable / The Legend of Dragonslayer / Eisendrache City*),
formula **`1d4`**, range **[4,4]** — a **25%** random-battle roll, sharing the table with
Looker (L15, 50 HP), Voidog (L13, 55 HP) and Banestrix (L14, 40 HP). That is presumably
the early tease, but it is a rollable encounter rather than a scripted beat, and **the
tease and the L50 boss are the same actor** — every number here serves both. (⭐️ Bandit
Fafnir, `oVZvfkkXMdxmB3T9`, 9999 HP / DEF 111 with three "Ruinous Steal" actions, is a
separate scripted joke actor, not this fight.)

### 1a. ⚠ Hilde-Fafnir's activation is wrong on disk — and her design doc inherited it

`2SFrEMqLBfqzc7Nj` carries **`activation: "1"`**. Her design doc records that the
2026-08-29 build comment said "4 turns a round" and that the doc *corrected itself to 1*
because the actor said 1. **The build comment was right and the correction went the wrong
way.** Everything in `hilde-fafnir-boss-design.md` §8c and §9 was then measured on one
turn a round:

| Her doc says | At the intended 4 activations |
|---|---|
| 4-round fight, ordinary turns only: **Pressure 0.70** | **3.83** |
| With Lance of Ruin: **1.3** (4 rds) → **2.1** (6 rds) | **~4.4** → **~6.5** |
| "Wyrmbreath takes roughly half her non-Lance turns" | still true, but that is now ~2 casts a round, not ~0.5 |

Worth fixing before her next tuning pass, and worth re-reading §9 ("Tuning — deferred to
fight simulation") with these numbers instead.

---

## 2. The kit, and what each action is worth

Expected damage, Fafnir's 2d12 enumerated exactly. The neutral column is the one the
multi-party rule says to design against; the live column is tonight's table.

| Action | Shape | vs neutral DEF 13 | vs live L41 party (471 pool) |
|---|---|---|---|
| **Ruinous Breath** 🔒 | Spell, 100 MP, auto-hit, **300 total pool** split among non-KO enemies | **300** | **338 landed** (71.8%) |
| **Condemn** | Active, 20 MP, 2d12**+7** vs MDEF, HR+**100** Dark, Pierce, redirectable | **101.4** | **100.1** (21.2%) |
| **Rend** | Attack, 2d12+2 vs DEF, HR+**50** Physical, on-hit Bleed | **41.2** | 35.4 (7.5%) |
| **Zero Power: Cruel Ultimatum** | 6 ZP, party picks A) 300 Fire on one / B) 120 Bolt on all | A 300 / B 480 | **A → 0** · B → 540 (114.6%) |
| **Searing Brand** | Spell, 30 MP, 50 Fire when the bearer next takes damage, 3 rds, transferable | 50 | 0 / 25 / 25 / 25 |
| **Dreadwyrm Descent** 🔒 | Passive, auto-casts at conflict start — DL15 【MIG】+【WLP】 or Frightened + Paralyzed + Silence | — | 3.55 of 4 fail → **costs the party 1 Item action** |
| **Draconic Domination** | Spell, 30 MP, DL15 【WLP】+【MIG】 or Charmed + forced hostile action | — | same 85–93% fail rates |
| **Torment** | Active, 30 MP, all six basic debuffs on one target, redirectable | — | −2 to four attributes at once |
| **Summon Elemental Drake** | Active, free — Flame Drake (300 HP) + Lightning Drake (150 HP), L45 elite, 1 act each | +450 HP, +2 actions/round | same |
| **Storm Calm** | Spell, free, +50 MP to self | — | — |
| **Zero Trigger: Suffering** | Passive — +1 ZP at **any** turn start while an enemy is in Crisis | — | — |

🔒 = locked.

### 2a. Ruinous Breath — the fixed pool is the conservative choice

300, auto-hit, split across non-KO enemies. Two consequences:

- **It is the one AoE in the champion tier that does not reward a bigger party.** Hilde's
  Wyrmbreath is HR+44 *per target* — **202 neutral across four**, and it grows with
  headcount. Ruinous Breath is 300 whether it hits one PC or four. Per fight that is
  **1352 landed for Fafnir against 2112 for Hilde** (§3).
- **It concentrates as the party shrinks** — 75 a head at four, **300 on a lone
  survivor**. Locked, so this is a property to know rather than a thing to fix, but it is
  the mechanism by which a losing fight accelerates. Against the live party it lands 338
  rather than 300 because **Keren is VU bolt**: her 75 share becomes **150, 156% of her
  bar**, so she dies to it from full HP on every cast. That is her affinity, not Fafnir's
  number — the multi-party rule says size against neutral, and at neutral this move is
  correct.

### 2b. Dreadwyrm Descent — an action tax, and the cure is reachable

The three AEs it applies do gate real things:

| AE | `changes` | Duration |
|---|---|---|
| Frightened | `disable_action = Attack` | 3 charges |
| Paralyzed | `disable_action = Skill` | 3 charges |
| Silence | `disable_action = Spell` | 3 charges |

DL15 on 【MIG】+【WLP】 — this party's dump stats, so 85–93% fail (Hina 85 / Keren 93 /
Blanche 85 / Zarg 92) and ~3.55 of 4 go down with it.

**Verified that the intended counterplay works:** `GATEABLE_ACTION_LABELS` lists
**`Item`** as its own action type, and none of the three AEs gates it — so the Item action
survives the opening. **Turbo Tonic** (`a9elI6g2FZ6qPY51`, consumable, Rare, 1200z) reads
*"Cure all Debuff from all ally"* and clears the whole thing for one action. Correct as
designed.

Two practical notes, not design problems:

- **The party does not currently carry one.** Hina has a **Super Tonic** (*"Cure all Debuff
  from target creature"* — single target, so it takes four actions to undo, not one) and
  Mega-Remedies; Blanche has Mega-Remedies. **Nobody has a Turbo Tonic.** If that is the
  intended answer to the opening, it should be somewhere the party can buy or find it
  before this fight.
- **Turbo Tonic carries no `effect_table`** — it is a description-only item, resolved by
  GM ruling. Fine at the table, but it means the answer to an automated opening is manual.

Worth noting the trap for anyone who reaches for the wrong tool: Hina's `Cleanse` is a
**Spell**, so Silence blocks it. Items are the only category that survives.

---

## 3. The benchmark — Fafnir vs the final boss at equal activation

Both champions, both all-d12, both at 4 turns a round, same enumeration, same party.

| | **Fafnir** (L50) | **Hilde-Fafnir** (L55) |
|---|---|---|
| Printed HP / MP | 1824 / 400 | 2400 / 500 |
| Mean incoming multiplier | ×0.72 | ×0.89 |
| **Effective HP** | **2526** | **2700** |
| Filler A (neutral) | Rend **41.2** | Scorched Claw **46.7** |
| Filler B (neutral) | Condemn **101.4** | Impalement **75.5** (151 w/ Execute) |
| Filler average | 71.3 | 61.1 |
| AoE per cast (neutral) | Ruinous Breath **300** | Wyrmbreath **202** |
| AoE cost / pool | 100 MP / 400 → **4 casts** | 40 MP / 500 → **12 casts** |
| **Whole-fight AoE budget** | **1352** | **2112** |
| Output per round (live party) | 1 AoE + 3 fillers = **541** (1.15 pools) | 2 AoE + 2 fillers = **451** (0.96 pools) |
| **4-round Pressure** | **3.45** | **3.83** ordinary, ~4.4 with the Lance |
| Party-wipe button | — | **Lance of Ruin** (all → 1 HP) |
| Zero Power | Cruel Ultimatum (party chooses) | Reinslaughter (60 → **454** vs a 1-HP target) |

**Fafnir is below the final boss on pressure, AoE budget, effective HP and printed HP,
and it lacks both of her finishers.** For a boss one tier down, that is where it should
be. The earlier alarm in this document came from benchmarking against **Asura** — a L38
*elite* with a 60 MP pool — which is the wrong tier entirely.

For context on how differently the tiers are built:

| | act | HP | mean incoming | effective HP |
|---|---|---|---|---|
| Hilde-Fafnir (champion) | 1 ⚠ should be 4 | 2400 | ×0.89 | 2700 |
| **Fafnir (champion)** | **4** | **1824** | **×0.72** | **2526** |
| Rakshasa (elite) | 4 | 1200 | ×1.00 | 1200 |
| Asura (elite, live-verified) | 4 | 900 | ×1.44 (four VUs) | 623 |

### What Mindscape says, and why it is not the evidence

`bin/mindscape.js` against a byte-faithful spec mirror of the live actor (verified to
reproduce the world-actor run exactly), 2000 runs, seed `fafnir-checkup-2026-09-20`:

| Arm | EnemyDPR | % pool/round | Outcome |
|---|---|---|---|
| Fafnir, live mirror | 144.5 | 31% | defeat 83% |
| **Asura — live-tested, party WON** | **149.3** | **32%** | **defeat 100%** |
| Fafnir, Condemn trimmed to HR+45 | 42.7 | 9% | party HP 56% |

**The control is the point.** Asura is a known-good fight and the model still calls it a
100% wipe — Mindscape is documented as ~2.4× pessimistic against a solo boss, and at these
damage levels both readings are *saturated* (the party dies either way, so the model can no
longer tell them apart). Fafnir reading 144.5 next to Asura's 149.3 means "its fillers are
elite-class", nothing more. Neither number is a verdict. The per-action arithmetic in §2
and §3 is what the conclusions rest on.

Two things the model genuinely does establish:

- **Neither locked move is in it.** Ruinous Breath is refused (auto-hit, and
  `300 / ACTION_TARGET_COUNT` needs runtime state) and Dreadwyrm Descent is an undeclared
  reaction — which conveniently means the 144.5 arm already reads *as if Dreadwyrm were
  cured*, matching the intended play pattern.
- **Party output in the baseline arm is measured on corpses.** It reports 13.6 party DPR;
  trim Condemn and nothing else, same seed, and Zarg goes **7.0 → 30.1/round**, Keren
  **2.6 → 12.2**. The "party does no damage" reading is an artefact of them being dead by
  round 2. §4 finding 1 is the cause.

---

## 4. Findings

Ordered by how much they matter. Nothing here is structural.

1. **Condemn one-shots healthy PCs.** 101.4 expected, max roll 112, at **85–99% hit rate**,
   Pierce (ignores resistance), **four times a round**. That exceeds Hina's 98 and Keren's
   96 bars outright. Compare the final boss: Impalement is **75.5**, and its ×2 Execute
   only applies to a target **already in Crisis** — "culling the weak" is the stated
   concept. Fafnir's filler deletes people from full HP with no precondition, which is a
   coin-flip on a character rather than pressure. It is also what makes Fafnir's filler
   spread lopsided (41 / 101) where Hilde's is flat (47 / 76).
2. **`action_pattern_table` is EMPTY — Fafnir has no AI.** `enemy-autopilot.js` returns
   null with no pattern (`"no pattern / nothing feasible → manual"`), so **the GM hand-drives
   all four turns every round**. This is the biggest build gap in the fight and it is also
   where Ruinous Breath's pacing has to live: with 400 MP and four turns, nothing but GM
   restraint stops four casts in round one (1200 raw, 2.5 party pools). Hilde's Lance of
   Ruin already demonstrates the pattern — a `round` A+B·X condition plus an HP gate.
3. **IM dark + dagger EF 50% is a full lane shutdown.** Keren's equipped weapon is a
   **Dark dagger**: immune element *and* halved efficiency, so her basic attack does
   literally nothing. Fafnir is the only boss in the sample carrying **any** IM — Hilde has
   none (two RS, dagger **60**, spear 150). The two IMs are also the bulk of the gap between
   Fafnir's ×0.72 and Hilde's ×0.89.
4. **Cruel Ultimatum is not a choice, and may be mis-wired.** Option A aimed at Hina is
   **0 damage** (she absorbs Fire); option B is **540**, 115% of the pool. So the party
   always picks A and a 6-Zero-Power finisher does nothing. Separately, reading the built
   `effect_table`: the `consume_resource` row for the 6 ZP sits **inside option A only**,
   and option B is a bare `deal_damage` whose `target_ref` points at a `cu_all` targeting
   row that nothing chains to. The design proposal specified `cu_unleash → chain(cu_cost,
   cu_choice)` with option B as `chain(cu_all, cu_120)`. **As built, option B looks like it
   costs no Zero Power and resolves an unbuilt target list** — verify live before believing
   an offline read, since runtime migrations can differ from disk.
5. **Zero Trigger: Suffering fills the gauge instantly.** +1 ZP at **any** turn start while
   an enemy is in Crisis. At 4 Fafnir turns + 4 PC turns that is up to **8 ZP a round** into
   a 6-point gauge — the Zero Power is permanently online one round after the first PC
   drops. Hilde's equivalent (Contempt) fires on discrete Crisis/KO *events* instead.
6. **Summon Elemental Drake is uncapped, and it buffs the locked move.** Lightning Drake's
   *Amplify Bolt* is **"boost all ally Bolt damage by 30"** — and Ruinous Breath is Bolt.
   Two drakes also add 450 HP (~+1.9 TP) and two actions a round. Nothing limits re-casting
   (the original proposal's Q7 explicitly left it uncapped).
7. **Turbo Tonic is the designed answer to the opening, and the party has none** (§2b).
   Hina's Super Tonic is single-target — four actions instead of one. The item also has no
   automation rows.
8. **Rend's Bleed is a healing debuff, not a DoT** (`heal_receiving_mod_all = −0.5`,
   3 charges). Against a fight the party has to out-heal that is stronger than it reads,
   and it rides on the always-available filler. Not a problem — worth knowing it is doing
   more work than the name suggests.
9. **The advertised weakness is unreachable by this party.** VU **light** and **spear 200%
   EF**: the party fields bow / brawling / arcane, no spear, and the only Light source is
   Hina's **Lunar Bow** (unequipped) and **Starfall Comet** (a gear skill currently gated
   off). Measured PE is ~0–8%, not the 17% design point. Legibility note rather than a
   defect — and arguably correct for a boss that is *supposed* to feel unanswerable the
   first time.

---

## 5. Proposed numbers — NOT APPLIED

Deliberately short. Both locked moves untouched; HP, MP and activation all stay.

| # | Field | Now | Proposed | Why |
|---|---|---|---|---|
| 1 | Condemn `damage_bonus` | **100** | **70** | 73.4 neutral — lands exactly on Hilde's Impalement (75.5), max roll drops 112 → 82. Still crisis-es anyone it touches; stops deleting full-HP PCs. Brings the filler spread to 41/73 against Hilde's 47/76. |
| 2 | `affinity_4` (dark) | **IM** | **RS** | Removes the only full lane shutdown in the sample; Hilde carries no IM at all. |
| 3 | `affinity_5` (earth) | **IM** | **NA** | As above. #2+#3 move the mean multiplier ×0.72 → ×0.89 — **exactly Hilde's** — and effective HP 2526 → 2049, correctly under the final boss. |
| 4 | `dagger_ef` | **50** | **60** | Matches Hilde's dagger 60. With #2 it stops stacking immunity onto halved efficiency. |
| 5 | Cruel Ultimatum option B `damage_amount` | **120** | **60** | 540 landed is a guaranteed wipe, so B is never picked. At 60 (270 landed) the edict becomes "one of us dies" vs "all of us are gutted" — an actual decision. |
| 6 | `max_hp` / `max_mp` / `activation` | 1824 / 400 / 4 | **keep all three** | Correctly scaled against the final boss on every reading in §3. |
| 7 | `spear_ef` / Ruinous Breath / Dreadwyrm Descent | — | **keep** | Locked or correct. |

### Build work these assume (no design change, but not free)

8. **Author `action_pattern_table`** (finding 2). At minimum: Ruinous Breath on a `round`
   A+B·X gate (the Lance of Ruin pattern), Storm Calm behind a low-MP condition, Summon
   Elemental Drake capped at once per conflict, Condemn and Rend as the fillers.
9. **Scope Zero Trigger: Suffering** (finding 5) — one grant per round, or Fafnir's own
   turn start only. Flagged as a question below because it edges into mechanic.
10. **Verify Cruel Ultimatum option B live** (finding 4) — does it debit 6 ZP, and does its
    target list resolve?
11. **Put a Turbo Tonic where the party can get one** before this fight (finding 7).

---

## 6. Questions for you

1. **Hilde-Fafnir's `activation`** — confirm it should be **4**, and should I fix the actor
   and re-do the Pressure figures in her design doc? Her §9 tuning notes were all written
   against the 1-turn reading.
2. **Zero Trigger: Suffering** — is narrowing the grant window (item 9) a number change or
   a mechanic change in your reading?
3. **Is the 1-in-4 roll on `Eisendrache Burning - Enemies` the intended delivery of the
   tease?** It is a real encounter at ~25%, not a scripted beat — and the same actor is the
   L50 boss, so the two cannot currently be tuned apart.
4. **Condemn at 70 — or leave it?** It is the only finding that changes how the fight feels
   rather than how it is built, and "a filler that can delete a PC" may be the intended
   dread. Everything else on the list is a defect or a gap.

---

## Method notes

- World read offline via `tools/safe-edit`, game closed; no writes.
- Mindscape run from a spec mirror of the live actor so numbers could be swept without
  touching the world; the mirror reproduces the world-actor run exactly.
- ⚠ A Mindscape run rotates the actors store's LevelDB MANIFEST. The worktree shows the
  usual `CURRENT` / `MANIFEST-*` churn under `worlds/`. Content-neutral — do not revert it,
  and prove it with `world-export report` before any world push.
- Party constants: EXFURSION Party, **L41**, pool **471** (Hina 98 / Keren 96 / Blanche 166
  / Zarg 111). Neutral column uses the equipment guide's reference **DEF/MDEF 13**.
- Blank-slate cross-check (`--party-archetype standard --level 50`, 415 HP, basic gear) was
  run and is not quoted: it saturates the same way the Asura control does, so it
  distinguishes nothing at this damage level.
