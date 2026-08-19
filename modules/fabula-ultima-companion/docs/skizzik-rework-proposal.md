# Skizzik Rework Proposal — "the one that acts twice"

`Actor.I2sSkVIQ4FCunZBE` · L48 ELEMENTAL **soldier** · Valley of the Dragon
Status: **BUILT 2026-08-20** — see [§10 As built](#10--as-built-2026-08-20).
Offline-verified; **not simmed, not live-tested.**

Balance frame: `docs/monster-balance-design.md` (Play Efficiency).
Party frame: L36, PartyHP **436** (`project_party_stat_snapshot`).
Hazard frame: `docs/lightning-storm-design.md`.

**Rev 2** — counter is **uncapped** per direction; Chain Reaction is fixed to
feed off the Lightning Storm. Rev 1's Pressure figures were computed with the
balance doc's closed form and were **too low** — see §2.

---

## 1. Where it stands today

| | |
|---|---|
| HP / MP | 195 / 60 (no MP costs anywhere in the kit) |
| DEF / MDEF | 12 / 8 |
| Init | **14 — highest in the dungeon** |
| Dice | DEX **d12** · INS d8 · MIG d8 · WLP d6 |
| Affinity | **AB bolt** · **VU earth** · IM poison |
| EF | bow 150 · thrown 125 · arcane 75 · rest 100 |
| Kit | **2 items.** Thunder Strike + Chain Reaction |

```
HR       = E[max(d12, d8)]  = 7.375
Damage   = HR + 48          = 55.375   Accuracy = 6.5 + 4.5 + 10 = 21.0
```

Hit rate vs the L36 party (vs DEF): Hina 100% · Zarg 100% · Keren 93.8% ·
Blanche 70.8% → mean **91.1%**. Expected **50.5 per swing**.

### It is over-statted on every axis at once

| Valley soldier | HP | best basic |
|---|---|---|
| Electro Slime | 45 | 32 |
| Mana Ray | 115 | 24 (paid Volt Stinger 40) |
| Ampere | 175 | 22 |
| Lightning Prism | 150 | 24 |
| Obsidrax | 180 | 38 |
| **Skizzik** | **195** | **48** |
| *Kirin (ELITE)* | *210* | *62 / 45* |

**Skizzik's free basic out-damages every other soldier's paid ability**, on the
dungeon's highest initiative, behind its second-highest HP pool. Its TP is
**1.18** where "Normal" is 0.70 and "Elite" is 1.50. This is an elite wearing a
soldier's rank — and it spends all of it on one button.

### Chain Reaction contributes nothing today

Fires a free Thunder Strike when **bolt** damage strikes it. But both rows carry
`reaction_cause_filter: "damage"`, which **excludes the `hazard` cause** — so the
Lightning Storm cannot feed it. And the party's only repeatable bolt is Hina's
Arc Wand, into a monster that *absorbs* bolt and telegraphs it in the study text.

So it fires essentially never. **Effectively a 1-item monster.** The "I hit a
lot" read is exactly right, and §4 fixes the cause filter.

---

## 2. ⚠ Correction — the current Pressure is 0.58, not 0.34

Rev 1 used the balance doc's `EnemyActions = R × (N+1)/2`. That formula
**undercounts turns for a first-in-initiative monster by 1.41×** here. Two
reasons, both real:

- rounds are **integers** — a monster alive at any point in round 3 gets a
  full round-3 turn, not a fraction;
- **init 14 means Skizzik acts before the party every round**, so it always
  collects its turn in the round it dies in.

Encounter row 6 (**Skizzik × 2**), 195 HP each, party 165 EffDPR concentrated:

| | round 1 | round 2 | round 3 | turns |
|---|---|---|---|---|
| Skizzik A | acts, → 30 HP | acts, dies | — | 2 |
| Skizzik B | acts | acts, → 60 HP | acts, dies | 3 |

**5 turns**, not `2.36 × 1.5 = 3.55`.

```
Pressure = 5 × 50.5 / 436 = 0.58      (closed form said 0.41 / 0.34)
Rounds   = 3                          (target for a standard fight: 1.5–2)
```

**So the monster is not too safe — it is at the top of the 0.40–0.60 band, and
it runs a round long.** That inverts Rev 1's conclusion: there is very little
room to add, and the redesign has to *redistribute* rather than *increase*.

> Worth folding back into `monster-balance-design.md`: the `(N+1)/2` term is a
> continuous-death approximation, and it is wrong in the unsafe direction for
> any monster that acts before the party. Flagging, not fixing, here.

And the 3-body rows are **already over the line today**:

| Encounter | current Pressure |
|---|---|
| Skizzik × 2 (row 6) | 0.58 |
| Skizzik × 3 proxy (rows 8 / 11 / 12) | **1.04** |

The 3-body pressure is a *table* problem that predates this rework. The goal
below is to hold it at roughly today's level, not to fix it here.

---

## 3. The uncapped counter — what it actually costs

> **Overload Riposte.** When the Skizzik is struck by damage and the Result of
> the attacker's Accuracy Check was an **even number**, it strikes back.
> No cap.

**P(even Accuracy Result) = exactly 0.500.** Every FU die has an even face
count, so each die is exactly 50/50 odd and a flat modifier shifts parity
without biasing it. True for every PC regardless of attribute array — a clean
coin, not an approximation.

### It doubles the monster's action economy

With `A` party damage instances landing on the Skizzik line per round:

```
counters/round = A × 0.95 (damaging) × 0.50 (even)
```

At A = 5 that is **2.4 counters per round against 1 activation.** Across the
fight the counter is **51% of every swing Skizzik takes.**

That is precisely the requested "further increasing its hit counts" — and it
means **everything else in the block has to come down by about half** to stay
in band. Uncapped at current stats:

| Build | Pressure (A=4 / A=5) |
|---|---|
| current kit, no counter | 0.58 / 0.58 |
| **+ uncapped counter at full Thunder Strike (48/48)** | **1.13 / 1.19** |
| + uncapped counter, riposte trimmed to 20 | 1.13 / 1.19 |
| + uncapped counter, riposte trimmed to 8 | 1.03 / — |

Trimming the *riposte* alone does not work: even a riposte dealing **zero bonus
damage** leaves it near 1.0, because the cost is the extra action, not the
number on it. **Thunder Strike and HP are the only dials with enough authority.**

### Two structural notes

**The counter fires pre-resolve (CONFIRM), so it fires on the killing blow.**
Its output scales with *party attacks*, not *enemy turns alive* — the focus-fire
discount does not apply to it. Usefully, this also means **low HP no longer
wastes its damage budget**: the usual glass-cannon penalty ("it dies before it
delivers") is half-defused, because half its output is reactive. That is what
makes the HP cut in §5 safe.

**It taxes multi-hit party strategies specifically.** Zarg's Barrage (two small
shots) hands over two coin flips; Keren's Numen→Detonate (one big hit) hands
over one. The uncapped counter creates a real, readable incentive to hit this
monster with *fewer, bigger* attacks — an anti-flurry flurry monster. Good
texture, and it is why the A=3 column matters below.

---

## 4. Chain Reaction × Lightning Storm — the fix is two blank fields

**Verified end to end.** This works exactly as intended and needs no new code.

The Rod's `rod_strike` row (on the shared `Lightning Rod` AE):

```json
{ "effect_kind": "deal_damage", "damage_amount": "30",
  "damage_element": "bolt", "damage_cause": "hazard", "target_ref": "self" }
```

That routes through the `deal_damage` handler, which calls
`fireResourceChangeTrigger` with the **true element** (`bolt`), the **cause**
(`hazard`), and a direction taken from the *actual committed HP delta*
(`skill-effects.js:5348`). Skizzik **absorbs** bolt → the delta is positive →
it emits **`creature_gain_resource`, resource `hp`, element `bolt`.**

Chain Reaction's row 1 already matches on every axis —
`creature_gain_resource` + `reaction_resource_filter: "hp"` +
`TRIGGER_DAMAGE_IS_BOLT == 1` + `SUBJECT_IS_SELF == 1`. It is blocked by exactly
one field.

**Fix: blank `reaction_cause_filter` on both rows** (`"damage"` → `""`).

This is the **Kirin precedent, verbatim** — Lightning Charge leaves the filter
blank so the hazard feeds it, and the storm doc calls that field out as
load-bearing. Prism's Overcharge sets it to `"damage"` deliberately, to
*exclude* the storm. Skizzik currently copies Prism when it wants Kirin.

### What a Rod strike is worth to Skizzik

Holding the Rod at its turn start, it takes 30 Bolt — which it **absorbs**:

| | |
|---|---|
| **+30 HP healed** | 23% of the recommended pool — extends the fight outright |
| **+30 MP** | **wasted.** Skizzik has no MP costs and a 60 MP pool |
| **+1 free Thunder Strike** | ← the fix. This is the "you managed it badly" hit |

And Skizzik is a **Rod magnet**: the Rod moves onto any creature that takes
creature-dealt damage, and since bolt is absorbed (no HP loss), *every attack
the party can usefully make on it hands it the Rod*. Under focus fire the last
party action of the round parks the Rod on Skizzik for its turn start.

**This becomes the dominant variance source in the fight** — which is the
requested behaviour:

| Rod strikes landing on a Skizzik | Pressure (recommended build) |
|---|---|
| 0 — storm played well | **0.46** — a comfortable fight |
| 1 — typical | **0.62** |
| 2 | **0.72** |
| 3 — storm played badly | **0.96** — near-lethal |

> **The wasted 30 MP is the one loose end.** The storm doc explicitly blesses
> this ("the wall banking useless MP is fine, arguably the point"), so leaving
> it is defensible. If you want it to bite, the natural sink is a costed
> follow-up — but that is a third mechanic and I'd hold it for a later pass.

---

## 5. Recommended build

Four numbers change. The counter stays uncapped as directed.

| | now | proposed | why |
|---|---|---|---|
| **HP** | 195 | **130** | TP 1.18 → **0.79**, a soldier's number. Elite HP on a soldier was the root over-stat |
| **Thunder Strike** `damage_bonus` | 48 | **30** | lands it beside Electro Slime (32) and Obsidrax (38), in the soldier band |
| **Overload Riposte** (new item) | — | **`damage_bonus` 12** | 19.4 avg — a jab, ~⅓ of a basic. Uncapped, so it must be small |
| **Static Buildup** (new passive) | — | **3 stacks → 30 Bolt**, single target | fires ~once per Skizzik per fight |
| Chain Reaction | filter `"damage"` | **blank** | §4 |
| DEF / MDEF / init / affinity / EF | — | **unchanged** | |

### Where it lands

```
                       R    Pressure   swings   detonations
current kit            3      0.58      5.0          0
recommended (A=5)      2      0.62      8.3          2
```

| | A=3 | A=4 | A=5 | A=6 |
|---|---|---|---|---|
| Pressure | 0.57 | 0.60 | **0.62** | 0.66 |
| swings | 6.9 | 7.8 | 8.3 | 9.2 |

- **Pressure 0.58 → 0.62.** Essentially held; a touch hotter, still inside the
  band, well clear of the 0.75 snowball line at every A.
- **Rounds 3 → 2.** Onto the 1.5–2 standard target. It was running long.
- **Swings 5 → 8.3.** A **1.7× action count** — the speed identity, delivered
  in actions rather than in a bigger number.
- **3-body proxy: 1.04 → 1.00.** The already-hot rows get *marginally cooler*,
  because the HP cut outweighs the added actions there.
- Detonation fires **twice per fight** (once per Skizzik) — the right cadence
  for a soldier's payoff.

### Why the HP cut is the load-bearing change

It is not a nerf to pay for the counter; it is the fix for the original problem.
195 HP + 48 damage + init 14 was an elite stat line, and the uncapped counter on
top of it is unaffordable at any riposte value. Cutting to 130 also:

- puts TP at 0.79, just above the "Normal 0.70" row — correct for a soldier;
- shortens the fight to the 1.5–2 target;
- makes **"fast and fragile"** coherent: the thing you want to kill first, that
  punishes you for how you kill it;
- is safe despite sitting at the ~130 spike ceiling, because the counter fires
  **pre-resolve** — a one-shot still buys a riposte, so the damage budget is not
  wasted (§3).

### If you want it hotter or cooler

| Variant | Pressure (A=5) | note |
|---|---|---|
| HP 195, TS 20, riposte 8 | 0.68 | keeps the wall, 12.2 swings — max flurry, but TS 20 reads weak on the sheet |
| HP 165, TS 24, riposte 10 | 0.72 | middle ground |
| **HP 130, TS 30, riposte 12** | **0.62** | **recommended** |
| HP 130, TS 30, riposte 8 | 0.59 | matches today exactly |

---

## 6. Implementation

All primitives verified present with working in-world precedent.

### Counter — Ampere's Volt Counter row, minus the cap

```json
"reaction_trigger":  "creature_targeted_by_action",
"reaction_source":   "self",
"condition_formula": "SUBJECT_IS_SELF == 1 && INCOMING_DAMAGE > 0
                   && ATTACK_CHECK_RESULT > 0 && ATTACK_CHECK_RESULT % 2 == 0
                   && TRIGGER_DAMAGE_IS_BOLT == 0",
"reaction_effect_ref": "riposte"
```

Reach the attacker with `target_ref` → a `targeting` row with
`candidate_source: "trigger_attacker"` (reads `payload.attackerTokenUuid`).

> ⚠ On this trigger **both `sourceActorUuid` and `subjectActorUuid` are the
> REACTOR.** `trigger_actor` resolves to Skizzik itself. `trigger_attacker` is
> the only correct source (`skill-authoring-guideline.md` G6; Pantie precedent).

**`TRIGGER_DAMAGE_IS_BOLT == 0` is not optional.** Without it, an even-accuracy
bolt attack fires the riposte *and* Chain Reaction — two free strikes plus a
heal off one action. The gate gives each passive its own lane: bolt → Chain
Reaction, everything else → riposte.

### Static Buildup — mutually exclusive rows, no ordering hazard

Both rows on `creature_deals_damage` (live fire site, fires **per hit target**,
post-resolve). Author the detonate row **first** and gate them so exactly one
can fire:

| Row | Gate | Effect |
|---|---|---|
| 0 — detonate | `AE_CHARGES_STATIC >= 2` | chain: `deal_damage` 30 bolt → `remove_ae` Static |
| 1 — build | `AE_CHARGES_STATIC < 2` | `apply_ae` Static, `add_charges`, 1 |

Mutually exclusive gates mean row 1's AE write is never read by row 0 in the
same fire — the read-after-write race that cost Asura a session cannot occur.

- `ae_lifetime_mode: "persistent_counter"` is **mandatory**, or
  `tickDirectorAEsForApplier` reaps the charges at Skizzik's next turn start.
- the `remove_ae` row needs `include_persistent: true`, or it is a **silent
  no-op** against a `persistent_counter` AE — the exact bug that nearly shipped
  on Asura.

### Two traps found while checking this

1. **`creature_hit_by_action` has no fire site.** Registered at
   `reaction-triggers.config.js:217`; nothing in the BD pipeline ever emits it.
   Do not build on it — and note the **PC Weaponmaster Counterattack
   (`Item.IEFFYKz9pycXYl7G`) is dead in BD today** for exactly this reason.
   Separate live bug; say the word and I'll file it under `reports/`.

2. **`ATTACK_CHECK_RESULT` is not stamped on `creature_lose_resource`.**
   `fireResourceChangeTrigger` threads `accuracyTotal`; the identifier reads
   `payload.checkTotal`. An even-parity gate there silently reads 0, and
   `0 % 2 == 0` is **true** — the counter would fire on *every* hit. This is why
   the counter must use `creature_targeted_by_action` and not the
   `creature_lose_resource` shape Chain Reaction uses. (One-line fix available
   at `skill-effects.js:2635` if you ever want the option.)

### One live-test risk

`free_action` fired from `creature_targeted_by_action` has **no in-repo
precedent** — Ampere uses `deal_damage` off this trigger, and every existing
`free_action` counter hangs off a *post*-resolve trigger. A nested action card
opening mid-card may misbehave.

**Fallback:** flat `deal_damage`, 20 Bolt, no roll, on `trigger_attacker`.
Loses the "another attack" flavour, moves Pressure by ~0.01, and is exactly what
Ampere already does successfully.

---

## 7. Still open from Rev 1 — your call

**Ampere already owns even-parity counters in this dungeon**, and row 15 is
literally `Ampere, Skizzik`. My read: keep it — repeated across a dungeon it
becomes a *motif* (the current discharges when the circuit closes evenly), and
the payloads stay distinct: Ampere throws an indiscriminate AoE 10 that hits its
own allies, Skizzik ripostes the attacker alone. Ampere is slow (init 9), Skizzik
is the fast one.

**Detonation target** — recommended as the creature it just damaged. The
all-enemies alternative collides with Electro Slime's death burst and Ampere's
Volt Counter, and would add ~90 to the fight (0.62 → **0.82**, out of band)
unless the flat 30 drops to ~12.

---

## 8. Checklist

- [x] TP 0.79 — soldier bracket (was 1.18, elite bracket)
- [x] Rounds 2 — on the 1.5–2 standard target (was 3)
- [x] Pressure 0.62 at A=5, ≤0.66 across A=3–6 — in band, clear of 0.75
- [x] 3-body rows not made worse (1.04 → 1.00)
- [x] Spike-ceiling exemption argued, not ignored (§5)
- [x] Exactly 1 VU (earth), 1 AB (bolt), 1 IM (poison, species-innate), no RS
- [x] EF unchanged: bow 150 / thrown 125 / arcane 75 — one bonus, one penalty
- [x] Unique factors adjust HP/rounds, never PE — PE stays 17% throughout
- [ ] **Not simmed.** Offline harness before live, per the usual order.

## 9. Open items

- `BaselineDPR = 110` is still the Asura-era estimate (`monster-balance-design.md`
  Migration step 1 undone). Every absolute number inherits that.
- `A` (party damage instances/round) is an estimate from the playbook's free-action
  and multi-target findings, not a measurement. It is the second-largest error term;
  §5 shows the A=3–6 spread is only ±0.05, so the conclusion is robust.
- The `(N+1)/2` undercount in §2 should be folded back into
  `monster-balance-design.md`.
- No placed Skizzik tokens exist — the world actor is the only copy, so no
  token↔world mirror pass is needed.
- The skill-regression golden gains rows for the new items and MODIFIES Thunder
  Strike + Chain Reaction; accept with `--update`.
- Action animations for the riposte and the detonation — deferred as usual.

---

## 10 — As built (2026-08-20)

`Actor.I2sSkVIQ4FCunZBE`, written offline via safe-edit (`db.put`, full replace —
never `patch`, which deep-merges and would have left the old tables live).
Backup: `tools/safe-edit/backups/20260820-010728-fabula-ultima-2-actors`.

| Doc | Id | Change |
|---|---|---|
| Skizzik | `I2sSkVIQ4FCunZBE` | HP 195 → **130**, study text, item list, passive mirrors |
| Thunder Strike | `vBuHp8f6NHuYNojr` | `damage_bonus` 48 → **30** |
| Chain Reaction | `IbE6lOJCeAs8Bb4n` | `reaction_cause_filter` → **blank** (both rows) |
| Thunder Strike (Riposte) | `SkzRiposteA02bR` | NEW · Attack, `damage_bonus` 12, **off `attack_list`** |
| Overload Riposte | `SkzRiposteP01aQ` | NEW · the uncapped counter |
| Static Buildup | `SkzStaticP03cT` | NEW · 2 rows, 5 effect rows |
| `Static` AE | `SkzStaticAE04dU` | NEW · `persistent_counter`, charges 1 / max 3, tag `static` |

DEF 12 / MDEF 8 / init 14 / affinities / EF / conditions — **untouched**.

### One code change was required

The `TRIGGER_DAMAGE_IS_BOLT == 0` gate could not work as authored:
`TRIGGER_DAMAGE_IS_<EL>` reads **only** `payload.element`, and
`creature_targeted_by_action` stamps the element as `damageType`. The gate
therefore **failed OPEN** — it would have excluded nothing, and an even-accuracy
bolt attack would have bought the party two free strikes plus a heal.

`element` is now stamped alongside `damageType` on that payload:

- `state-handlers.js` — the CONFIRM third-party scan
- `reaction-derive.js` — `buildTargetedPayload` (the sibling builder for mid-card
  new targets) **and** `TARGETED_PAYLOAD_KEYS` (the contract check that catches
  the two drifting apart)

**Audited before writing: 0 of 32 authored `creature_targeted_by_action` rows use
`TRIGGER_DAMAGE_IS_*`**, so this is a pure addition — no existing behaviour
changes. `reaction_damage_type` reads `damageType` before `element`, so that
filter is unaffected too. Latent bug fixed for every future author.

### Verification done

- **Gate smoke test** — `evaluateFormula(expr, buildSkillResolver(…))`, not the
  bare identifier resolver (which returns 0 for a whole expression and passes
  every assertion vacuously). 12/12 pass, including the two that matter:
  *even-accuracy **bolt** → does not fire* (proves the payload fix) and
  *no roll info → does not fire* (proves `ATTACK_CHECK_RESULT > 0` guards the
  `0 % 2 == 0` always-true failure mode).
- **Gate exclusivity** — detonate/build asserted mutually exclusive at
  0/1/2/3 charges and with no AE at all. Cadence: 9 damage instances → exactly
  3 discharges.
- **Reference integrity** — every `reaction_effect_ref`, `chain_step`,
  `target_ref` and `action_ref` resolves to a real label / item name.
- **`node --check`** on both edited ESM files (as `.mjs` — a `.js` check misses
  ESM syntax errors).
- **preflight** — zero Skizzik findings. The one FAIL is pre-existing post-play
  scene drift (`AncientTemple_Map002`, a Hina token), unrelated.
- **world-export report** — 5 added / 2 modified / **0 removed**. The export
  emits `Static Buildup → effects: ["Static"]`, which is the cheap tell that the
  AE is a real embedded doc and not the dropped-on-load inline-object trap.

### Still to do

1. **Live/sim test** — the one genuine unknown is `free_action` fired from
   `creature_targeted_by_action` (pre-resolve). No in-repo precedent: Ampere uses
   `deal_damage` off this trigger, and every other `free_action` counter hangs
   off a post-resolve trigger. **Fallback if the nested card misbehaves:** swap
   `riposte_strike` to `deal_damage` 20 Bolt on `riposte_target` — moves Pressure
   ~0.01 and is exactly Ampere's proven shape.
2. **skill-regression** — needs Foundry open. Will show 3 added rows + 2
   modified; accept with `--update`.
3. Action animations for the riposte and the discharge — deferred as usual.

---

Related: `project_lightning_surge_dungeon`, `docs/lightning-storm-design.md`,
`reference_bd_monster_automation`, `reference_monster_actor_setup`,
`project_monster_design_rules`, `project_fight_balance_playbook`,
`reference_common_aes`.
