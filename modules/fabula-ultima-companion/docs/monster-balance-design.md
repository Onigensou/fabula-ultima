# Monster & Encounter Balance — Play Efficiency

The math a designer uses to answer *"how long will this fight take, and will it
hurt?"* before anyone rolls a die.

Status: **RULING SETTLED 2026-08-14. NOT APPLIED TO EXISTING MONSTERS.**
See [Migration](#migration) — the published HP tables need a one-time re-anchor
and every existing monster needs a Threat Point value computed.

Supersedes the **"60% Efficiency Principle"** in the monster design rules. That
principle was correct in spirit and unusable in practice: its label ("60%"), its
description ("1–2 of 4 members hitting weakness") and its number (135 DPR) were
three different quantities that never agreed. See
[What happened to 60%](#what-happened-to-60).

---

## The one-paragraph version

A monster's HP is derived from **its own** target survival time, never from the
encounter it sits in. That survival time, expressed in rounds of full party
focus, is its **Threat Point** cost. An encounter is *assembled* by filling a TP
budget, never by dividing a pool. **Play Efficiency (PE)** is the dial that says
how well you assume the party plays; it converts a TP into an HP number.

```
M(PE)  = 1 + 3 × PE                              PE = (M − 1) / 3
HP     = TP × BaselineDPR × RD × M(PE)
Rounds = ( Σ TP ) / Spread(N)
```

---

## Part 1 — Party Constants

Six numbers. **Measured once per party tier, never touched by a monster
designer.** Re-derive them when the roster changes materially.

| Constant | Meaning | Current value |
|---|---|---|
| `BaselineDPR` | Party damage/round, **strict**: 4 actors × 1 action each, neutral affinity, no free actions, single target | **90** ⚠ |
| `RD` | Round Density — actions per round ÷ headcount | **1.00** ⚠ placeholder |
| `Spread(N)` | AoE output gain at N enemies | `1 + 0.20 × (N−1)`, cap **1.60** |
| `AoE_per_target` | Damage one AoE action lands on one target | **~19** |
| `SpikeCeiling` | Largest single action the party can produce | **~110–130** |
| `PartyHP` | Total party HP pool | **436** (L36) |

> ⚠ **These are L30-era estimates and the party is L36.** `PartyHP` is live; the
> rest are not. Every absolute HP number in this document inherits that error.
> Re-measure before precise balance work — see [Migration](#migration).

> ⚠ **`BaselineDPR` must be re-derived under the strict definition above.** The
> legacy 90 was estimated without stating whether free actions were included. If
> they were, multiplying by `RD` double-counts them. Do this **once, first** —
> every number downstream inherits it.

### Estimating Round Density

An actor has one action per round; effects grant more. That set is short and
enumerable, so RD is counted from the party sheet, not measured per fight.
For a party of four, **each recurring free action per round is +0.25**:

| Party | RD |
|---|---|
| Everyone gets exactly one action | 1.00 |
| One member reliably gets a bonus action (Acceleration, Barrage, Counter Pass…) | 1.25 |
| Two members do | 1.50 |

Free actions were the **#2 lever** in live sim runs. RD is how rounds stay the
authoring unit without lying about them.

---

## Part 2 — Play Efficiency

### Definition

PE measures how much of the damage multiplier stack the party is standing on:

```
FinalDmg = (HR + bonus) × affinity × WeaponEF/100
```

The ceiling is **×4.0** — Vulnerable (×2.0) stacked with 200% Weapon Efficiency
(×2.0). The floor is **×1.0**, neutral. So:

```
M(PE) = 1 + 3 × PE          PE = (M − 1) / 3
```

`M(PE) = 1 + PE(C−1)` is simultaneously two readings — linear interpolation
between neutral and ceiling, **and** "PE = the fraction of party actions that
landed the ideal hit." They are algebraically identical, which is why this is
the right functional form: intuitive to a designer, and directly measurable from
a combat log.

### The ceiling is absolute, and deliberately unreachable

**×4.0 is anchored on the rules, not on any party.** A four-person party cannot
all stand on one monster's single VU *and* its single 200% EF type — by the
[affinity design rules](#affinity--ef-recap), each monster has exactly one of
each. The ceiling is a **benchmark**, not a target.

This is the point. Rosters and loot are randomised every run
(`project_multiparty_randomized_runs`), so a ceiling defined as "what this party
can attain" would go stale every campaign and make historical monsters
incomparable. An absolute ceiling means **a PE written today means the same
thing in three campaigns.**

The cost: **realistic designs live at 8–33%.** That is normal. A monster reading
17% is not under-tuned.

### The landmark table — read this before typing a number

| Party state (4 PCs) | Multiplier | **PE** |
|---|---|---|
| Nobody exploiting | ×1.00 | **0%** |
| 1 of 4 hitting VU | ×1.25 | **8%** |
| **2 of 4 hitting VU** | **×1.50** | **17%** ← **default design point** |
| 3 of 4 hitting VU | ×1.75 | **25%** ← hard encounter |
| All 4 hitting VU | ×2.00 | **33%** ← ceiling of realistic play |
| Half the party double-exploiting (VU + 150% EF) | ×2.00 | **33%** |
| All 4 double-exploiting at max EF | ×4.00 | **100%** — benchmark only |

**Design at 17%. Use 25% for a fight meant to punish sloppy play.** Anything
above 33% describes play that has not happened at this table.

> ⚠ **The 75% trap.** "3 rounds at 75%" gives `M = 3.25` → 292 DPR → **877 HP**.
> The published *standard boss* pool — 5.5–6 rounds, phases, limbs and minions
> included — is 743–810. A 75% assumption builds a bigger wall than a boss and
> kills it in half the time. 75% is a **speedrun benchmark**: a number to measure
> a finished fight against, never a number to design one with.

### What PE measures, and what it doesn't

PE measures **your assumption about play**, not the monster's exploitability.
Two monsters both designed at 17% play differently if one's VU is reachable by
the party's kit and the other's isn't. If that matters for a specific monster,
note it by hand on that monster — same as [unique factors](#part-5--unique-factors).

---

## Part 3 — Per-Monster Design

### HP is intrinsic. Always.

**A monster's HP never depends on what it is standing next to.** Deriving HP by
dividing an encounter pool is the one architectural mistake this document exists
to prevent, because:

```
Contribution = DPS × TurnsAlive          and       TurnsAlive ∝ HP
```

**HP is the delivery mechanism for DPS, not a parallel axis.** Halve a monster's
HP and you have halved its damage contribution too — you did not trade one
resource for another, you spent the same one twice. A high-DPS monster whose HP
got squeezed to fit next to a tank is a stat block that lies: balanced on paper,
hollow at the table.

Worse, players **hunt** that monster. A glass cannon is the single most likely
thing on the field to die on round 1, every time.

### Threat Points

The portable unit is **Time-To-Kill under full party focus**. It is
neighbour-independent, so a monster's contribution is identical in every troop it
appears in.

```
1 TP = one round of full party focus
HP   = TP × BaselineDPR × RD × M(PE)
TP   = HP / (BaselineDPR × RD × M(PE))
```

At the default design point (`RD 1.00`, `PE 17%` → 135 effective DPR):

| Role | TP | HP |
|---|---|---|
| Chaff | 0.45 | ~60 |
| Normal | 0.70 | ~95 |
| Elite | 1.50 | ~200 |
| Mini-boss | 3.00 | ~405 |
| Boss | 5.5–7.5 | 740–1010 |

Compute a monster's TP **once**. It is a property of the monster, like its HP.

### The one-shot floor

One threshold is **absolute** — not relative to the encounter, not scaled by
anything:

| Monster HP | Turns it actually gets | What its DPS stat is worth |
|---|---|---|
| **< 1 spike (~130)** | 0–1 | **Decorative — do not invest here** |
| 1–2 spikes | 1–2 | Real, but front-loaded |
| 2–4 spikes | 2–4 | Fully delivered |
| > 4 spikes | whole fight | Boss pacing |

> **Rule: a monster whose design assumes ≥2 turns of damage must have HP above
> the spike ceiling.** Otherwise you are paying a DPS budget for turns that will
> never happen.

This generalises the existing rule *"Elite HP must be ≥110 to survive a ×4
spike"* from a special case into the governing constraint.

### Two currencies — why chaff is still fine

The floor sounds like it condemns every low-HP monster. It doesn't, because
damage is not the only thing an enemy contributes:

| Currency | Requires | Earned by |
|---|---|---|
| **Damage delivered** = `DPS × TurnsAlive` | survival | tanks, elites, bosses |
| **Party actions consumed** ≈ `TP × ActionsPerRound` | *existence only* | chaff |

A 60 HP monster that eats one PC action is worth ~34 damage of denial whether or
not it ever acts. Note both currencies reduce to TP — which is why TP is the
right unit.

> **Rule: budget chaff in the denial currency and give it a cheap DPS stat.**
> Never build a low-HP monster with a big damage number. That specific
> combination is the one that lies.

### Affinity & EF recap

Unchanged from the monster design rules, restated because PE depends on them:

- Exactly **1 VU** per monster (creates the "right answer" signal)
- **1–2 RS**, never more (no party member fully shut out)
- EF: **1 type at 150–200%**, **1 type at 50–75%**, rest 100%

The ×4.0 ceiling is only coherent while these hold. A monster with two VUs or
three 200% EF types breaks the scale's meaning.

---

## Part 4 — Encounter Design

### Assemble to a budget; never divide a pool

```
TP_budget = TargetRounds × Spread(N)
```

Fill it by **selection and count**. The encounter designer never edits a stat
block. If you need a smaller version of a monster, that is a **separate actor**
(Fire Imp / Fire Imp Elite) — which is already how the world works.

*Example: a 3-round fight at N=5 → `3 × 1.60 = 4.80 TP` → one mini-boss (3.00) +
four chaff (4 × 0.45 = 1.80) = 4.80* ✓

### Spread(N) — the AoE discount

An AoE action hits N targets, so party output rises with enemy count — but less
than intuition says. AoE deals less per target than single-target (Glacies ≈ 19
vs Iceberg's 28), it has target caps (Glacies stops at 3), and some characters
have no repeatable AoE at all.

Derived from the party's actual kit, each PC contributing
`max(single-target, AoE total)`:

| N | Hina | Zarg | Keren | Blanche | Total | **Spread** |
|---|---|---|---|---|---|---|
| 1 | 28 | 18 | 21 | 20 | 87 | **1.00** |
| 2 | 38 | 36 | 21 | 24 | 119 | **1.37** |
| 3 | 57 | 36 | 21 | 30 | 144 | **1.65** |
| 4 | 57 | 36 | 21 | 34 | 148 | **1.70** |

N=1 lands at 87 against a 90 baseline — the model reproduces the existing
number, which is the validation gate. It **saturates hard after N=3**, hence the
1.60 cap.

> ⚠ **The discount is smaller than intuition.** Two monsters each carrying
> 3-round HP is 6.0 TP → `6.0 / 1.20` = **5.0 rounds, not 4.** Real, but ~15–20%,
> not a third.

**Spread = 1.00 against a single boss.** AoE buys nothing there — which is why
boss targets are 5.5–6 rounds while a 4-monster fight is 1.5–2 on a comparable
pool.

### Pressure — the danger check

Encounters have a property single monsters don't: **kill order**. With focus
fire, monster *i* dies at `iR/N`, so total enemy turns delivered is:

```
Focused:  R × (N+1)/2                Spread damage:  R × N
```

At N=4 that is **2.5R vs 4R — focus fire eats 37.5% less incoming damage.** This
is the arithmetic behind the live-sim finding that focus fire took a fight from
**9 rounds to 4**.

```
EnemyActions = R × (N+1)/2 × TurnsPerEnemy        (elite ×1, champion ×N)
Pressure     = EnemyActions × AvgDamage × HitRate / PartyHP
```

| Pressure | Verdict |
|---|---|
| < 0.40 | The fight never happened |
| **0.40 – 0.60** | **Target — hurts, doesn't threaten** |
| > 0.75 | KO-snowball risk — the actual loss condition |

> **Elites take one turn per round.** Only Champions act multiple times. Getting
> `TurnsPerEnemy` wrong is the fastest way to a wrong Pressure number.

### The AoE choice gate

**AoE kills nothing.** Spreading damage means every monster survives to the end,
so the party eats the full `R × N` instead of `R × (N+1)/2`. AoE buys speed and
pays in damage taken; focus fire buys safety and pays in rounds.

A good encounter makes that a **real choice**. It breaks when one side dominates,
and the lever is monster HP relative to `AoE_per_target`:

| Monster HP | Outcome |
|---|---|
| ≤ 2× AoE/target (≤ ~40) | AoE sweeps it — fine for trash, dead fight otherwise |
| **2–4× (~40–80)** | **Real choice — design here** |
| ≥ 4× (≥ ~80) | AoE can't close; focus fire mandatory, AoE is dead weight |

> When you raise per-monster HP for a longer fight, re-check this. It is the
> point where a fight quietly stops having a decision in it.

### The contribution audit

Under **pure focus fire** (`Spread = 1.00`, the conservative case for any single
monster), monster killed *j*-th has been alive for `Σ(TP of everything killed
before it) + its own`. Multiply by its DPS and turns-per-round.

> **If any monster contributes < 10% of the troop's total pressure, it is
> decorative.** Cut it, merge it into a bigger unit, or raise it over the spike
> ceiling — unless it is chaff earning in the denial currency, which is exempt.

*Length uses Spread (realistic mixed play); the audit uses pure focus fire (worst
case for the monster being audited). Two lenses, deliberately different.*

### Secondary consequences

- **The last monster is dead time.** Focus fire means the final enemy faces all
  four PCs alone — decided, but not over. Either run fewer/tougher enemies, or
  give the last one a crisis effect.
- **Champions invert the profile.** One target (Spread 1.00) taking N turns
  (Pressure ×N) — the opposite of a swarm, and why bosses need their own length
  targets rather than falling out of this model.

---

## Part 5 — Unique Factors

Most monsters won't have one. Those that do get **reviewed individually** — a
flag and a one-line note on the monster, not a formula.

> **Rule: unique factors adjust HP or rounds. They never adjust PE.**

Folding a regen or a flat damage reduction into PE breaks the one property that
justified the absolute ceiling — cross-monster comparability. Keep PE clean.

For the hand-review, the only thing worth memorising is where each kind lands:

| Kind | Example | Adjusts |
|---|---|---|
| **Damage-line** | RS / IM / AB, EF values | the multiplier |
| **Mitigation** | flat reduction/turn, damage caps, shields | **HP** |
| **Economy** | regen, undying, summons, extra turns | **HP** (regen ≈ heal × (R−1)) or the round budget |

Flat reduction does not compose with a multiplicative scale at all — **−20 flat
is ×0.33 against a 30-damage hit and ×0.80 against a 100-damage spike.** That is
exactly why it belongs in the HP column and not in PE.

```
PrintedHP = TP × EffectiveDPR − Regen×(R−1) − FlatReduction×ExpectedHits − Shields
```

---

## Part 6 — Worked Examples

All at `RD 1.00`, `PE 17%` → `EffectiveDPR = 90 × 1.00 × 1.50 = 135`.

### A. Single elite, 3-round Long fight

```
N=1 → Spread 1.00 → Σ TP = 3.00
HP = 3.00 × 135 = 405
```
- One-shot floor: 405 ≫ 130 ✓ full DPS delivered
- Pressure: `3 × (1+1)/2 × 1 × 55 × 0.70 / 436` = **0.26**

**Verdict: too safe.** Below the 0.40 band — correctly diagnosing the known rule
that *a single enemy left is a fight already won*. Add a second body or raise its
damage.

### B. Four normals, standard fight

```
Target 1.75 rounds, N=4 → Spread 1.60 → Σ TP = 2.80 → 0.70 TP each
HP = 0.70 × 135 = ~95 each        (pool 380)
```
- One-shot floor: 95 < 130 → **still one-shot chaff.** Correct per the
  two-currency rule: budget them in denial, keep DPS cheap.
- AoE gate: 95 ÷ 19 = 5.0× → **above the choice band**, focus fire is mandatory.
  Drop to ~75 HP each if the fight should reward AoE.
- Pressure: `1.75 × 2.5 × 1 × 47 × 0.70 / 436` = **0.33**

Note the published table says 55–65 HP here. The difference is the Spread
re-anchor — see [Migration](#migration).

### C. Mixed troop, 3-round fight

```
N=5 → Spread 1.60 → TP budget = 4.80
Mini-boss 3.00 TP (405 HP) + 4 chaff 0.45 TP (61 HP each) = 4.80 ✓
```
Contribution audit under pure focus fire (chaff dies first — lowest TP):

| Unit | Dies at | Turns | DPS | Contribution | Share |
|---|---|---|---|---|---|
| Chaff ×4 | 0.45 / 0.90 / 1.35 / 1.80 r | 1/1/2/2 | 25 | 150 | 33% |
| Mini-boss | 4.80 r | ~5 | 60 | 300 | 67% |

Individual chaff land at 7–11% — right at the audit line, and **exempt**: they
are earning in the denial currency, which is what chaff is for.

### D. Anti-example — the 75% trap

```
"3 rounds at 75%"  →  M = 3.25  →  292 DPR  →  877 HP
```
Larger than a full boss pool, for a 3-round fight. **Do not design here.**

---

## What PE Does Not See

The metric is deliberately imprecise — good enough to stop the wandering, not
good enough to trust blindly. Its blind spots:

- **Focus fire / kill order.** Took a real fight 9 rounds → 4. Larger than the
  entire VU multiplier. PE is a **single-target** number; multi-monster round
  counts read long.
- **KO snowball.** One PC down costs a quarter of the party's actions while
  incoming damage holds steady. Not modelled — and it is the actual loss
  condition.
- **Resource attrition.** MP only bites past ~5 rounds. PE says nothing about
  long fights.
- **The messy middle.** The model assumes clean focus fire or clean AoE, not the
  realistic mix.
- **Interaction bugs.** Absorb loops, unpayable costs, forfeited free actions,
  preconditions living outside the item. **Only the live sim finds these.**

> Use the model to pick an HP/TP budget. Use the live sim to find out whether the
> fight actually *works*.

---

## What happened to 60%

The legacy principle stated three things that should have been one number:

| Stated as | Implies |
|---|---|
| the label — *"60%"* | never derived from anything |
| the description — *"1–2 of 4 members hitting weakness"* | 1.5 of 4 at ×2 → **M = 1.375** |
| the DPR — *"135"* | **M = 1.50**, which is exactly **2 of 4** |

The authoritative anchor is **M = 1.50 = 2 of 4 hitting VU = PE 17%**. The DPR
and the HP tables built on it were playtested, so they win; the description was
one member short and the label was a vibe.

**The number 60 is retired from balance work.** The legacy quantity was a
*participation rate* (how many members exploit), not an efficiency — different
concept, different name, no collision:

> 2 of 4 members exploiting = **PE 17%** = the default design point.

---

## Migration

Not yet applied. Three passes, in order:

1. **Re-derive `BaselineDPR`** under the strict definition (4 actors × 1 action,
   neutral, single target, no free actions) at **L36**, and measure `RD`.
   Everything downstream inherits this — do it first.
2. **Re-anchor the published HP tables** for `Spread`. The current pools were
   computed without it, so multi-monster pools rise ~1.6×
   (4× Normal Standard: 240 → ~380). This corrects in the **known-error
   direction** — the live sim found fights ran *too easy*, i.e. real party output
   exceeded the model. This is the old discrepancy finally getting a name, not a
   new one.
3. **Compute TP for every existing monster** — mechanical:
   `TP = HP / (BaselineDPR × RD × M(PE))`. Then run the one-shot floor check and
   flag any monster whose DPS budget assumes turns it will never get.

## Recommended next step: measure realized PE

As written, PE is a design-time *assumption* — unfalsifiable, like every
heuristic that quietly drifts.

The BD damage pipeline already computes `affinity_mult` and Weapon EF per hit,
and the sim harness already runs whole fights. So **realized PE is measurable
post-hoc**: log per-hit (base, affinity, EF), emit a fight-level number.

Then the loop closes — *"you designed this for 17%; the table played it at 9%."*
Without it, this document is a third heuristic sitting beside the fight-duration
targets and the HP tables, with nothing to say which one is lying.

---

## Quick Reference

```
M(PE)        = 1 + 3 × PE                       PE 17% = default,  25% = hard
EffectiveDPR = BaselineDPR × RD × M(PE)         90 × 1.00 × 1.50 = 135
HP           = TP × EffectiveDPR                TP = HP / EffectiveDPR
Spread(N)    = 1 + 0.20 × (N−1),  cap 1.60      1.00 vs a single boss
TP_budget    = TargetRounds × Spread(N)
Rounds       = ( Σ TP ) / Spread(N)
Pressure     = R × (N+1)/2 × Turns × Dmg × HitRate / PartyHP     target 0.40–0.60
```

**Per monster:** HP intrinsic · above the spike ceiling if it needs ≥2 turns ·
chaff earns in denial, keep its DPS cheap.
**Per encounter:** assemble to a TP budget · check Pressure · check the AoE
choice band (2–4× AoE/target) · audit for <10% contributors.
**Never:** divide a pool into HP · fold a unique factor into PE · design above
PE 33%.

---

See `project_monster_design_rules` for the NPC construction formula, creature
ranks, DEF/MDEF targets and the affinity rules; `project_fight_balance_playbook`
for what the live sim actually observed; `project_sim_playtest` for the harness.
