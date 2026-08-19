# Mindscape Ruleset — the offline combat model, specified

**Status: DRAFT v0.1 — spec only, no implementation. Review this before code is written.**

This document is the falsifiable artifact of the Mindscape sim. Every rule the offline
model implements is written here, with the engine source it was derived from. If a number
below is wrong, the model is wrong — and you can find that out by reading, without running
anything.

## What this answers, and what it does not

| | Mindscape | Live playtest sim |
|---|---|---|
| Question | *Is the math right?* Rounds, HP remaining, KO risk | *Does it actually work?* |
| Method | offline Node, real RNG, thousands of runs | the real engine, one run |
| Cost | seconds | ~570s/run, watched |
| Catches | HP/damage budgets, action economy, spread | absorb loops, unpayable skills, invisible preconditions, forfeited grants |
| Misses | **everything in the Not Modelled section** | nothing — it *is* the engine |

**Engine bugs are out of scope by design.** This models the rules *as designed*. The class
of failure that cost Asura its Aspect machine (`creature_takes_damage` silently dead on
items) is invisible here and always will be — that is the live sim's job. A clean Mindscape
result is permission to spend **one** live run instead of five, never permission to skip live.

---

## Part 1 — Check resolution

Source: `project_fu_core_math` + [check.js](../scripts/battle-director/check.js).

- Every check rolls **exactly 2 dice**, sized by two attributes (e.g. `[INS+WLP]`).
- **Result** = die A + die B + modifiers. **HR (High Roll)** = `max(dieA, dieB)`.
- An **Accuracy Check** succeeds when `Result ≥ DL`. In our game Accuracy and Magic checks
  are unified under one label — DL is the target's **DEF** for weapon attacks, **MDEF** for
  spells.
- **Critical**: both dice show the same face **≥ 6** → auto-success + Opportunity.
- **Fumble**: both dice show 1 → auto-failure; a PC gains 1 Fabula Point.
- Attribute die sizes: d6/d8/d10/d12 natural; d2 floor and d20 ceiling via modifiers.
  Step order: d2 → d4 → d6 → d8 → d10 → d12 → d14 → d16 → d20.
- NPC accuracy bonus = `floor(Level / 10)`.

> **Modelled as:** two real `randInt(1, size)` draws. Never an expected value — the
> distribution is the product, so the dice must actually be rolled.

## Part 2 — Damage

### 2a. Outgoing (attacker side)
`base = HR + damage_bonus`, where `damage_bonus` is the sheet total (weapon + accessory +
flat level bonus). NPC flat bonus by level: L1–19 `+0`, L20–39 `+5`, L40–59 `+10`, L60 `+15`.

### 2b. Incoming — the canonical order
Source: [damage-ruleset.js:142-230](../scripts/battle-director/damage-ruleset.js#L142-L230)
(`computeIncomingDamage`). **This order is normative and differs from the shorthand in the
design docs.** Applied in sequence, each step feeding the next:

| # | Step | Math |
|---|---|---|
| 0 | seed | `v = max(0, ceil(base))` |
| 1 | damage reduction (flat + %) | `resolveIncomingReduction` — skipped under Crush |
| 2 | **weapon efficiency** | `v = ceil(v × effPct/100)` — family `_ef` prop, default 100 |
| 3 | additive per-element bump | `v += damage_taken_increased_<element>` |
| 4 | **element affinity** | VU `ceil(v×2)` · RS `ceil(v/2)` · IM `0` · AB heals |
| 5 | damage-class affinity | strike/magic flags, same ladder |
| 6 | universal multiplier | `v = ceil(v × damage_taken_mult)` |
| 7 | clamp | `max(0, ceil(v))` |

Two things the shorthand `ceil((HR+bonus) × affinity × EF/100)` gets wrong and this does not:
**weapon efficiency is applied BEFORE affinity** (step 2 vs 4), and **RS is `ceil(v/2)`, not
floor** ([snapshot.js:98-106](../scripts/battle-director/snapshot.js#L98-L106)). With the
intermediate `ceil` at each step the order is observable, not cosmetic.

- **Status-forced VU** overrides the sheet: Oil → fire, and friends. Applied after reading
  sheet affinity ([snapshot.js:71-87](../scripts/battle-director/snapshot.js#L71-L87)).
- **Crush** steps affinity down exactly one rung `AB→IM→RS→NE` and skips DR + reducing EF.
  VU is never touched. A Crush hit into Immune is still Resistant, not full.
- **Affinity bypass** (`ignore_resistance` / `ignore_immunity` / `ignore_absorption`) is a
  *clamp*, not a step: everything at or below the named rung collapses to NE.

### 2c. The PC modifier systems
Three sheet-driven modifier families sit outside the damage pipeline proper and were
each worth a large share of the first calibration failure:

| Family | Props | Applies |
|---|---|---|
| Accuracy | `check_mod_all` · `_accuracy` · `_melee` · `_ranged` · `_magic` | `all` + `accuracy` always, then one contextual term: `magic` when the action resolves vs MDEF, else `melee`/`ranged` by the weapon's own `weapon_range` |
| Outgoing damage | `extra_damage_mod_all` · `_spell` · `_<element>` · `_<family>` | added to the base before the incoming pipeline |
| Incoming reduction | `damage_receiving_mod_all` · `_<element>` | feeds step 1 (flat DR) |

Live values: Zarg carries accuracy 3 + ranged 4 = **+7** on a bow shot, Hina magic **+6**
on a spell, Keren reduces every physical hit by **5**, Blanche reduces everything by **4**.
Ignoring these made the party both miss constantly and die far too fast.

**Weapon family comes from the equipped item's `category`**, not the actor sheet. Without
it the weapon-efficiency axis never fires — and it is worth ±50–75% (Zarg's bow is 150%
into Centuaros and 75% into Inferex).

## Part 3 — Combat structure

- Rounds; within a round each combatant takes its turns.
- **Turns per round comes from `props.activation` + `props.bonus_activation`**, never from
  rank. Mirrors [director-combat.js:31-69](../scripts/battle-director/director-combat.js#L31-L69).
  An explicit `0` is meaningful (an effect can zero a creature's turn); only a blank value
  falls through to the default of 1.

  > **Verified against the world, and it overturns the rank rule.** Every boss checked is
  > rank `elite` — Asura `activation=4`, but Kirin, Gigas, Inferex and Centuaros all `=1`.
  > A rank-derived rule would read Asura as 1 turn/round and under-rate that fight fourfold.
  > Rank is *descriptive*; activation is *authoritative*.
- **Free actions are actions.** Acceleration, High Speed, Dance, Counter Pass, Barrage's free
  attack. This is the model's single most important structural rule: the live sim's headline
  finding is that fights are decided on **action economy, not DPR**, and a model that counts
  headcount instead of actions will overrate every monster line-up
  (`project_fight_balance_playbook`).
- **A dead enemy stops acting.** The marginal value of the first kill is much larger than the
  second, so removal rate must be modelled, not just cumulative damage.
- HP / Crisis (`HP ÷ 2`) / KO at 0. Revives restore to ~50%.

## Part 4 — Party policy

**Transcribed from [profiles.js](../scripts/battle-director/sim/profiles.js), not reinvented.**
This is what closed the live sim from 8 rounds to 3–4, and it is already declarative. Every
constant below must equal its source; a diverged constant silently rebuilds the original
drift problem and is the first thing to check when calibration fails.

### 4a. TUNING constants — [profiles.js:36-117](../scripts/battle-director/sim/profiles.js#L36-L117)

| Constant | Value | Meaning |
|---|---|---|
| `strongHitFraction` | 0.30 | a hit worth spending a defensive reaction on |
| `strongHitFractionEndgame` | 0.12 | …once one enemy is left |
| `safeDamageFraction` | 0.10 | "she can take it" ceiling |
| `protectPerRound` | 1 | Blanche's Protect budget |
| `propheticMinTargets` | 2 | Hina redirects only a multi-target action |
| `healKoRiskFraction` | 0.30 | an ally at/below this could be KO'd |
| `healWorthItFraction` | 0.60 | "hurt enough to be worth a heal slot" |
| `healMinTargets` | 2 | wait for this many before spending the turn |
| `healEmergencyFraction` | 0.15 | …unless someone is this low, then go now |
| `healMaxTargets` | 3 | Heal's own cap |
| `icebergKoHp` | 60 | "can Iceberg finish them?" threshold |
| `glaciesMinWeak` | 2 | ice-VU enemies that make Glacies pay |
| `glaciesMaxTargets` | 3 | Glacies' cap |
| `accelerationPriority` | Zarg, Keren | damage dealers, not the tank |
| `stopMaxEnemies` | 1 | Stop only worth it against a lone enemy |
| `itemIpReserve` | 4 | IP held back for augments (two Gadgets) |
| `gadgetIpCost` | 2 | |
| `warningShotRounds` | [1] | an opener only |
| `mpItemThreshold` | 0.30 | an ally under this wants a top-up |
| `mpItemsPerRound` / `hpItemsPerRound` | 1 / 1 | at most one caddy turn each per round |
| `potionPriority` | Zarg | Potion Rain makes his consumable hit everyone |
| `zeroPowerCost` | 6 | standard limit-break price |
| `zeroPowerHealFraction` | 0.55 | Blanche fires hers at this hurt level |
| `focusLowHpFraction` | 0.70 | below this an enemy is a magnet |
| `focusRespectAffinity` | true | peel off rather than feed an absorb |

### 4b. Focus fire — [profiles.js:249-333](../scripts/battle-director/sim/profiles.js#L249-L333)
The single biggest lever, and it costs nothing (9 rounds → 4 in live runs). One called target
shared by all brains, in strict precedence:

1. **Finisher** — any enemy at ≤ `focusLowHpFraction` HP. Among the wounded, prefer one the
   party can *exploit* (has any VU) over the merely lower-HP one.
2. **Hazard displacement** — move the Lightning Rod off the party (ranked above inertia,
   below the finisher).
3. **Standing call**, if still alive.
4. **Fresh call** — prefer an enemy with an exploitable VU; else lowest current HP.

`focusFor(element)` lets a character peel off the call when it would feed an **AB/IM**, or
when someone *else* is VU to what they're throwing. Focus fire prevents *spreading*; it is
not a reason to hit for half.

> The party "knows" enemy HP. That is a deliberate call: at a real table, descriptions,
> damage numbers and counting give players a good enough read, and modelling fog would add
> noise to a balance signal.

### 4c. Per-character turns — [profiles.js:494-705](../scripts/battle-director/sim/profiles.js#L494-L705)

Party-wide policies run **before** any individual profile, in order: **revive → MP item →
HP item → own policy → rotation → basic attack → Guard**.

- **Revive** ([391-413](../scripts/battle-director/sim/profiles.js#L391-L413)) — only when
  *nobody still standing* is at KO risk. Reviving while another ally is one hit from joining
  them trades one corpse for another.
- **Hina** — heal (last resort, fully gated) → Acceleration (only if nobody's hurt and nobody
  already has the AE) → Stop (≤1 enemy) → ice. Ice choice: Iceberg if it can finish someone;
  else Glacies if ≥2 enemies are ice-VU; else Iceberg on the called target. **No Zero Power**
  — hers is a gimmick, not a nuke.
- **Zarg** — *just shoots*. His kit is augments that ride the shot (Barrage, Warning Shot,
  Gadgets, High Speed), all handled as reactions. **An empty rotation is correct**; declaring
  an augment as a turn action burns the turn and does nothing.
- **Keren** — alternates Create Phantasm ↔ Detonate Phantasm. Detonate requires a phantasm on
  the field (a precondition that exists nowhere on the item) and costs 20 MP.
- **Blanche** — Zero Power party-heal at `zeroPowerHealFraction`, else Heal at 0.5, else
  Muleta. Her damage skills cost Adoration and stay thin on purpose.

### 4d. Reaction policy — [reaction-brain.js:181-431](../scripts/battle-director/sim/reaction-brain.js#L181-L431)
Reactions are a large share of the party's real output, so they are modelled, not skipped.

| Carrier | Rule |
|---|---|
| **Protect** (Blanche) | ≤1/round; only on a hit ≥ `strongHitFraction` of victim max HP; only if she can take it; **never in front of a summon**; covers whoever is closest to dying. Endgame drops the bar to 0.12. |
| **Prophetic Defender** (Hina) | only a ≥2-target action, and only when she takes *nothing* from it |
| **Thermokinesis / Gadgets** | element swap — **never fires without naming the element**. Scored `VU 3 · NE 1 · RS 0.4 · IM 0 · AB −5`. |
| **For Whom the Bell Tolls / Warning Shot** | damage riders — skip if every target is IM/AB/RS |
| **Barrage** | buys *reach*, not just damage → fire whenever payable |
| **Potion Rain** | always — free, and only ever rides an item he was already using |

**Standalone reactions (turn_start / turn_end / conflict_start / round_*) are always taken.**
A real party takes its free actions; there is no version of "playing well" that declines them.

## Part 5 — Enemy policy
Monsters act from their `action_pattern_table` rows: condition gating, cost feasibility,
affinity-aware targeting, anti-repeat, cooldowns. Same reader the live sim gives the party.
Enemies **decline** Opportunities.

## Part 6 — Deliberate simplifications

All of these make the party read **weaker** than it is, so a fight Mindscape calls *hard* is
genuinely hard. That asymmetry is intentional — the model errs toward over-tuning the party's
difficulty, never toward declaring a fight safe.

- Opportunities always take Advantage (+4); cleverer options never chosen
- skill option-menus take the first entry unless a policy hints
- no mid-fight equipment swaps
- costs the engine can't price (Adoration) are treated as unaffordable

## Part 6b — Reactions (added 2026-08-20)

Until this part existed, `skill_type: "Passive"` rows were extracted, counted in the
coverage printout, and **never consulted** — `engine.js` had no notion of a reaction.
The consequence was structural, not cosmetic: a monster whose kit lives in
`reaction_config_table` was evaluated on its HP and its base attack alone, so a rework
that *adds* reactions and pays for them with HP and damage read as a **pure nerf**.
Measured on Skizzik: 89% party HP with the layer off, 75% with it on, 60% with the
Lightning Storm as well.

Reactions are **declared** in `lib/reactions.js`, for the same reason utility actions
are: what a reaction does is structural (grant an attack, accumulate a counter, burst)
and none of it is legible from the sheet. Undeclared passives are reported on their own
line — they are **not** folded into the turn-spendable coverage bar, because a reaction
is not turn-spendable and folding it in would change what that percentage means.

### Trigger points
A deliberately short list — three real hook points in `resolveAction`, not a
transcription of the live engine's trigger taxonomy (whose distinctions this model has
no way to honour). Mapping a live trigger onto one of these is a modelling decision and
is recorded in the registry entry's `note`.

| trigger | fires on | context |
|---|---|---|
| `on_targeted` | the DEFENDER, once the check is rolled | `accuracyResult, hit, damage, element, attacker` |
| `on_deal_damage` | the ATTACKER, per damaged victim | `victim, element, damage` |
| `on_take_element` | the DEFENDER when an element moves its HP — **including a heal from an absorb** | `element, damage, direction, cause` |

### Two properties that are deliberate, not incidental
- **`on_targeted` is COLLECTED before the HP write.** The live counter fires
  pre-resolve, so it lands on the killing blow; collecting after the write would
  silently delete the property that makes such a counter immune to the focus-fire
  discount (its output scales with party *attacks*, not enemy *turns alive*).
- **`on_take_element` fires on a heal.** An absorbed hit is still an element event.
  This is the entire Chain Reaction / Lightning Rod interaction: measured 0.00 firings
  per run without the storm, 0.86 with it — exactly matching the 0.86 Rod strikes that
  land on the absorbing monster.

### Recursion
A free attack can deal damage and fire further reactions. Real chains terminate, but a
registry edit could introduce a loop, and an infinite loop inside a 2000-run Monte Carlo
is indistinguishable from a hang. Depth is capped at **2**.

## Part 6c — Conflict events (added 2026-08-20)

Layered scene rules, in `lib/conflict-events.js`. **Never auto-read from the scene** —
passed with `--conflict-event`, matching `sim.run()`'s explicit-only behaviour. Omitting
it means the hazard is silently absent, which for the Valley of the Dragon roster
evaluates a different monster than the one on the sheet.

**Lightning Storm** implements the five rules in `lightning-storm-design.md`. The
exclusion that matters most: the Storm's own strike carries the `hazard` cause and
therefore does **not** move the Rod. With it defaulted to `damage` the holder keeps the
Rod forever and eats 30 Bolt every turn — a spec violation that inflates a squishy PC's
down-rate. The strike resolves through the normal incoming pipeline, so an absorbing
holder is healed and still registers a bolt event for its passives.

## Part 7 — NOT MODELLED

**This section is load-bearing.** The previous log-only attempt failed by *silently
approximating*; the coverage manifest exists to make that impossible. Anything here is
reported as an explicit warning line at run time, and a fight whose unmodelled share crosses
the threshold **refuses to emit a verdict** rather than returning a plausible number.

- **Clock mechanics** — Asura's element collection, any `clock-system` boss gate
- **Summon lifecycles** beyond Keren's phantasm (Birth of the Cruel's minions, overrides)
- **Undying / revive bosses** (Geist's Blackest Night) — changes the shape of the end
- **Conflict events / hazard tiles** — except the Lightning Storm (Part 6c); hazard tiles remain unmodelled
- **Boss Ultima actions**, Dominance Points, Super Armor
- **Positioning / range** — the engine has no grid combat, but reach-gated skills exist
- **Shields** as a separate resource band
- **Status effects beyond the six die-steppers** and the damage-relevant ones
- **Multi-phase transitions**
- **Reactions not declared in the registry** — reported per-actor, never silently skipped (Part 6b)
- **Every engine bug, by construction** (Part 0)

## Part 8 — Calibration targets

The model is worth exactly its calibration. These are encoded as expectations and **must
pass before any new number is read**. Out of tolerance = the model is wrong, not the encounter.

| Encounter | Expected | Source |
|---|---|---|
| Inferex + Centuaros vs party | **2–3 rounds**, party at **85–100% HP** | live sim, matched to the real table |
| any win at >70% party HP | flagged *"the fight never happened"* | `project_fight_balance_playbook` |
| any win at ≥85% | flagged *trivial* | same |

Additional expectations to be added from the Lightning Surge and Asura live-test reports.

**Constants to re-derive and feed back** into
[monster-balance-design.md](monster-balance-design.md), whose own inputs are flagged
untrustworthy (`BaselineDPR` 90 is an L30 estimate against an L36 party; `RD` is a
placeholder `1.00` while free actions demonstrably dominate):

- `BaselineDPR` — damage dealt ÷ rounds, strict definition
- `RD` (Round Density) — actions taken ÷ (headcount × rounds). **Must come out > 1.00.**
  Exactly 1.00 means the counter isn't wired, not that the party has no free actions.
- `Spread(N)` — output gain at N enemies

---

---

## Appendix — what loading the real world corrected

Findings from running the loader against `fabula-ultima-2` with the game closed. Each one
would have silently skewed the model.

| Assumption | Reality |
|---|---|
| one party | **two** — "EXFURSION Party" (Hina/Keren/Blanche/Zarg) and "Zenit Crisis Party" (RaiRai/Surtur/Varan/Moses), on **different sheet templates** |
| party is L30 / L36 | **L41** — every published constant is two tiers stale |
| turns/round from rank | from `props.activation` (see Part 3) |
| PC `max_hp` derivable | **not derivable** — the formula undershoots by 17–60 HP (Hina: formula 81, sheet 98) because class-list and equipment bonuses aren't in props. Read the stored value; refuse when absent |
| attributes at `dex` / `dex_current` | `dex_base` … `wlp_base`; status die-steps live in `is<Status>` flags |
| DEF/MDEF at `def` / `mdef` | `defense` / `magic_defense` (+ base/bonus/override components) |

**Party affinities are not what the coverage map says.** Hina **absorbs fire** and is
**VU to ice** — her own primary element. Keren is **VU to bolt**. All four carry weapon
efficiency 100 across every family, so EF is a monster-side stat in practice.

The loader **refuses** to load the older-template party rather than substituting a derived
maximum. That refusal is the coverage principle applied to data loading: a plausible number
from an incomplete sheet is worse than an error.

## Settled decisions

### D1 — The party is resolved dynamically, never named
The party under test is whatever the **Current Game** sheet points at:

```
"Current Game" actor (DMpK5Bi119jIrCFZ) → props.game_id → DB actor → member_id_1..8
```

An offline mirror of `FUCompanion.api.getCurrentGameDb`
([db-resolver.js:56-86](../scripts/db-resolver.js#L56-L86)). Today that resolves to
*"The Legend of Dragonslayer" → EXFURSION Party*, but no party name is baked into the tool —
the campaign is multi-party and the pointer is the authority. An explicit `partyName`
override exists for deliberately modelling a different roster.

### D2 — `icebergKoHp` becomes a real projection, not a threshold
**Deliberate divergence from `profiles.js`, and the only one.** The constant exists because
the live sim *cannot* project damage before COMPUTE runs, so `60` is a proxy for "can Iceberg
finish them?". At L41 against 900 HP bosses that proxy never fires.

The offline model has no such limitation — it computes damage itself — so it asks the real
question: **is the target's current HP at or below Iceberg's projected damage against
that target?** (projection through the full Part 2 pipeline, so affinity and EF count).

Two guards keep this honest:
- Use the **average** roll, never the maximum, so the finisher fires only when it reliably
  lands. Over-firing would make the party stronger than the live sim and break the
  "simplifications read weaker" asymmetry in Part 6.
- This divergence is **the** thing to check first if calibration drifts on a fight where
  Hina is landing kills.

### D3 — `BaselineDPR` excludes free actions; `RD` carries them
The strict definition in `monster-balance-design.md` already says *"4 actors × 1 action each,
no free actions"* — the legacy `90` simply may not have honoured it. Keeping the two separate
is the right call because:

- `RD` stays a **meaningful, inspectable number** — "the party takes 1.4× its headcount in
  actions per round" is diagnostic on its own.
- Folding free actions into DPR forces `RD = 1.0` and destroys the ability to see action
  economy as a lever — which is the single most important finding from live runs.

**The model therefore counts two action classes separately**: actions from base `activation`,
and actions from grants. `BaselineDPR` is derived from the first only; `RD` is
`(base + granted) / (headcount × rounds)`. Double-counting is structurally impossible rather
than merely discouraged.
