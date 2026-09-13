# Equipment Design — Power Budget Guide

The yardstick a designer uses to answer *"is this item about as strong as its
rarity says, and will it still matter at level 50?"* before building it.

Status: **ADOPTED 2026-09-13. FORWARD-ONLY.** Applies to equipment designed from
this date. Existing equipment is left exactly as it is — see
[Legacy items](#part-7--legacy-items).

> **Intention.** This is a **guide, not a precise model.** It will not tell you
> the exact numbers of an item. It gives a developer a shared currency and a
> handful of checks, so two people designing a "Rare sword" land in the same
> neighbourhood and nobody ships something that dominates a category forever.
> When the guide and a well-argued design instinct disagree, write down why and
> keep the instinct — then check it in the sim.

Companion to `monster-balance-design.md` (Play Efficiency). That document prices
**enemies** in rounds of party focus; this one prices **gear** in shares of a
character's output. Both hang off the same party constants.

---

## The one-paragraph version

Gear is **horizontal**: an item changes *how* a character plays, and stays
useful at every level. Characters are **vertical**: levels, classes and skills
make them stronger, and refinement/orbment make a *chosen* item stronger. Every
item is a **chassis** (standard stats for its category, free) plus a **budget**
set by rarity, spent on stats above the chassis, a signature passive, and an
active. Budget is measured in **% of the wielder's output per fight**, using the
**Baseline Action** `BA(L)` so the same item can be checked at its earliest drop
level and at L50.

```
BA(L)          ≈ 34 × 1.036^(L − 30)                 damage-equivalent per action
Output/fight   ≈ 2.5 × BA(L)                         one character, standard fight
Value %        = (extra damage-equivalent per fight × uptime) ÷ (2.5 × BA(L))
Pass           = Value % ≤ budget at earliest drop   AND   ≥ ½ budget at L50
```

---

## Part 1 — The pillar: gear is horizontal

Classic JRPG gear is **vertical** — each town sells a strictly better sword and
the old one becomes vendor trash. This game rejects that: an item found at L1
should still be a real choice at L50.

The model is Dark Souls / Elden Ring: almost any weapon can finish the game,
because progression comes from **upgrading the weapon you chose**, not from
finding a bigger one. This game already has that path:

| Layer of growth | Source | Nature |
|---|---|---|
| Character | levels, classes, skill levels | vertical |
| Item investment | refinement (`refinement-config.js`), orbment slots | vertical, **player-chosen** |
| Item drop | the item itself | **horizontal** — options, not power |

> **A drop gives options. Investment gives power.**

Consequence for design: an item's *drop* power stays inside a narrow band per
rarity, and the interesting difference between items is **what they do**, not
how big their number is (Sid Meier's "interesting decisions" — two swords that
differ only by +2 damage are not a decision).

*Open question, out of scope:* refinement currently adds **flat** damage/HP/DR,
which decays with level exactly like a flat item stat (Part 3). Changing it would
alter every existing refined item, so it needs its own decision.

---

## Part 2 — Anatomy: three layers, three jobs

### Layer 1 — Chassis (stats): standard, free, low variance

The stat line says **what kind of weapon it is**, not how good this one is. It
costs no budget. Chassis = the **Fabula Ultima basic item** for that category
(rules-anchored, so it never drifts with whatever the world happens to contain):

| Category | 1H damage | 2H damage | Accuracy |
|---|---|---|---|
| Arcane | — | +6 | WLP+WLP / INS+INS |
| Bow | — | +8 | DEX+DEX / DEX+INS |
| Brawling | +6 | — | DEX+MIG |
| Dagger | +4 | — | DEX+INS **+1** |
| Firearm | +8 | — | DEX+INS |
| Flail | — | +8 | DEX+DEX |
| Heavy | +6 / +10 | +14 | MIG+MIG |
| Spear | +8 | +12 | DEX+MIG |
| Sword | +6 | +10 | DEX+MIG / DEX+INS **+1** |
| Thrown | +4 | — | DEX+INS |

RAW conversions stay free: 2H→1H −4 damage, 1H→2H +4. Armor and shields use the
basic armor/shield table (`project_fu_item_design`). **Accessories have no
chassis** — their whole identity is budget.

> ⚠ Legacy weapons in this world run roughly **+2–4 above** these chassis
> values. That is *not* evidence the chassis is wrong — legacy is not a
> calibration source (Part 7). If the reference set (Part 6) shows the chassis
> reads weak at the table, apply **one uniform uplift** to the whole table.

Trades inside the chassis are allowed at the prices in Part 4 (e.g. −2 damage for
+1 accuracy is roughly even at low level and favours accuracy later).

### Layer 2 — Signature passive: the reason to own it

Most of the rarity budget lives here. **Word it in scaling terms** — %, skill
level, HR, MaxHP, Defense score, "an extra action" — so it holds its value late.
Flat numbers ("+5 damage") are allowed but pay for it in the level check.

### Layer 3 — Active skill: priced as surplus

An active replaces the action the wielder would otherwise take. It costs budget
**only for what it adds over a basic attack with the same item**, per expected
use, minus any resource it spends (Part 4).

---

## Part 3 — The unit: Baseline Action

`BA(L)` = one character's damage-equivalent per action at level `L`, in a
standard fight, as the table actually plays.

| Level | BA | Source |
|---|---|---|
| 10 | ~17 | extrapolated |
| 20 | ~24 | extrapolated |
| 30 | **34** | resource map anchor (135 party DPR ÷ 4, PE 17%) |
| 41 | **~50** | **live**: Inferex (178) + Centuaros (200) = 378 HP in a median 2 rounds → 189 DPR → 47/PC; solo Asura 900 HP in ~4 rounds → 225 DPR → 56/PC |
| 50 | ~69 | extrapolated |

Growth between the two anchors is **≈3.6 % per level — doubling roughly every 20
levels**, and the formula above just continues that line.

**Why it must grow with level.** Fight lengths are fixed in *rounds*
(`project_monster_design_rules`), so as monsters gain HP the value of one action
has to rise with it. The world's soldier-rank monsters agree on direction:
median max HP 31 (L10s) → 49 (L20s) → 58 (L30s) → 140 (L40s) → 180 (L50s). They
grew *faster* than BA, so BA is if anything conservative late.

**Cross-check.** Mindscape vs a neutral single target (no affinities, all EF 100,
DEF/MDEF 13, 2026-09-13, seed `equip-metric-neutral`) measured **BaselineDPR
100.5, RD 1.11** at L41. Through the documented solo-target bias (×2.25,
`tools/mindscape/expectations/asura-solo.json`) that is **≈226** — agreeing with
the live Asura figure.

> ⚠ **Precision.** The L30 anchor is a PE-17% estimate with RD 1.00; the L41
> anchor is live play including free actions, exploits, Zero Power and invokes.
> They are not the same definition, and L10/L20/L50 are extrapolated. That is
> acceptable for a guide — the checks below are coarse on purpose. Re-anchor when
> a party at another tier is live-tested.

**Per-fight output.** A character takes about **2.5 actions per standard fight**
(`project_fu_resource_map`). So one character's output per fight ≈ `2.5 × BA(L)`,
and every budget is a percentage of that.

---

## Part 4 — Pricing effects

Always price an effect as **expected** damage-equivalent per fight, then divide by
`2.5 × BA(L)`. Hit rates come from the party table
(`project_party_stat_snapshot`, L41): DEF 12 → 57.7 %, 13 → 49.2 %, 14 → 40.5 %,
15 → 32.6 %, 16 → 25.7 %. **Default target: DEF 13, 49 % hit.**

| Effect | How to value it | Scales with level? |
|---|---|---|
| **+1 damage on hit** | +0.49 expected per attack → ≈ `0.49 ÷ BA(L)` of output for a weapon user | **No — decays** (below) |
| **+1 accuracy** | +8.5 pp hit rate ≈ **+17 %** of the damage from affected attacks at DEF 13, **+24 %** at DEF 15 | Yes (relative) |
| **+X % damage** | X % × share of output it applies to × uptime | Yes — but see the multiplier rule |
| **Extra action / free attack** | **1 BA** per occurrence | Yes |
| **Deny an enemy action** (Paralyze, etc.) | up to **1 BA** per action denied; weak statuses far less in 2-round fights | Yes |
| **HP restored / prevented** | ~**60 HP ≈ 1 BA** at L30 (Remedy: 50 HP ≈ 0.8 actions); scale by `BA(L) ÷ 34` | Yes |
| **+1 DEF / MDEF** | treat as roughly **−15–20 %** of the damage from attacks aimed at that defence (mirror of accuracy; the enemy-side table is not tabulated) | Yes (relative) |
| **MP cost** | 10 MP ≈ 25–35 damage ≈ **~0.9 BA** at L30 — subtract from the effect | — |
| **IP cost** | 3 IP ≈ 50 HP ≈ **~0.8 BA** — subtract; IP is contested with potions | — |

### Flat values decay — the table that explains the whole guide

`+1 damage on hit`, for a character attacking with the item, as a share of their
output per fight:

| L10 | L20 | L30 | L41 | L50 |
|---|---|---|---|---|
| 2.9 % | 2.0 % | 1.4 % | 1.0 % | 0.7 % |

A flat bonus is worth **four times as much at L10 as at L50.** This is why the
passive, not the stat line, has to carry an item late.

### Uses per fight (defaults)

| Trigger | Uses / standard fight |
|---|---|
| Weapon attack | 2.5 |
| Per-round trigger | 2 |
| Once per scene / conflict | 1 |
| "When you reduce an enemy to 0 HP" | ~1 in a 2-enemy fight — use 0.5 as uptime |

### Uptime — the conditional discount

`uptime` = the fraction of fights (or attacks) where the condition is actually
true. A narrow condition is **cheap**, so it may be strong. Estimate it for a
**random roster** (`project_multiparty_randomized_runs`), not today's party.
Class- or skill-specific conditions ("Flail attacks", "Frenetic Footwork SL+2")
are what Magic: The Gathering calls **parasitic** — they need a specific other
piece to function — and usually have very low uptime.

*Not yet measured:* species frequency across the dungeon rosters. Until it is,
state the assumed uptime on the item.

---

## Part 5 — Rarity budgets and the level check

| Rarity | Budget (% of output / fight) | Complexity | Orbment slots |
|---|---|---|---|
| Common | **≤ 5 %** | chassis + at most one simple keyword | 1 |
| Uncommon | **≤ 10 %** | one conditional passive | 1 |
| Rare | **≤ 15 %** | a build-enabler, or an active | 2 |
| Legendary | **≤ 20–25 %** | breaks a rule; **must** carry a real drawback | 3 |

Budgets are **placeholders until the reference set (Part 6) calibrates them.**
The complexity column follows Magic's *New World Order*: simple effects live at
low rarity, so rarity means something besides a number. Budget the item **at +0
with empty slots** — refinement and orbment are power the player earns on top.

### The level check (power band)

Evaluate the item at its **earliest drop level** and at **L50**:

1. **Early — not above budget.** Catches flat effects that are overwhelming at
   low level.
2. **Late — at least half the budget.** Catches flat effects that fade into
   nothing.

Scaling effects pass on their own. Flat-heavy items get caught — which is the
point.

---

## Part 6 — Design rules

Each rule is short; the reference is why it exists.

- **No strictly-better items.** Schreiber & Romero (*Game Balance*) distinguish
  *transitive* balance — A simply beats B — from intransitive. In a horizontal
  game a transitively better item is permanent, because nothing outlevels it.
  Every new item needs an answer to **"when would I not use this?"**
- **Count shadow costs and shadow benefits** (Schreiber). A drawback that does
  not bite the likely wielder refunds nothing. Synergy is a benefit the budget
  cannot see — note it.
- **Multipliers compound; additions don't.** VU (×2) and Weapon EF (up to ×2)
  already stack to the ×4 ceiling in `monster-balance-design.md`. A new "+% damage"
  passive multiplies on top and raises `SpikeCeiling`, which sets the monster
  one-shot floor. **Provisional:** cap a conditional damage multiplier at **+50 %**,
  and count every one when `SpikeCeiling` is re-measured.
- **Prefer effects anyone in the slot can use.** Parasitic effects are cheap but
  mostly dead for a randomised roster.
- **Mechanise new items.** A budget is only checkable on an effect the engine
  runs — reaction rows, AEs, props. The sim harness can measure a mechanised item;
  it cannot measure GM-adjudicated text. ("Water finds a crack" — Soren Johnson:
  players find the dominant interaction a budget sheet cannot. Only play finds it.)
- **Engine routes worth knowing:**
  - species-conditional damage → an `adjust_damage` rider using
    `TARGET_SPECIES_IS_<X>` (the orbment Hunter augment is the reference). The
    `humanoid_ef` / `beast_ef` … props on a weapon are **not read** by the
    Battle Director — weapon efficiency is read off the *target* (`sword_ef`).
  - a paired `<Name> (gear skill)` sub-item carries mechanised passives
    (Cursed Sword is the reference).

---

## Part 7 — Legacy items

Equipment created before 2026-09-13 was not designed against this guide.

- **Left untouched.** Read its data freely; do not edit it under this guide.
- **Never calibrate against it.** The danger is not that a legacy outlier exists
  (Energy Sniper Rifle: Common, +40 damage, +3 accuracy). It is that a new,
  in-budget item looks weak beside it and the fix drifts toward matching the
  outlier — the classic start of power creep.
- **Mark what follows the guide.** Recommended: an item flag
  `flags['fabula-ultima-companion'].equipmentDesign = { version: 2, … }` — flags,
  like orbment's storage, so no CSB template column and no prune on
  `reloadTemplate` — plus a dedicated folder. Not yet implemented.
- **New content draws from new items.** Loot is hand-authored (nothing picks items
  by `item_rarity`), so separation is a table-authoring rule, not code.
- *Optional, later:* score legacy items read-only, to know which outliers to keep
  out of new tables. Not a retrofit.

---

## Part 8 — Calibration: the reference set

Magic's cost curve is anchored by vanilla creatures with no abilities. Do the
same: **4–6 plain items per rarity**, built straight from this guide with no
flavour tuning, run through Mindscape and the live sim at two party levels, then
adjust the Part 5 percentages from the result. Those items become the canon new
designs are compared to.

**Status: NOT DONE.** Equipping a test item changes a real actor's loadout, so
the method (cloned actors / offline sim / snapshot-and-restore) is decided before
it starts.

---

## Part 9 — Worked examples

All at DEF 13 (49 % hit) unless stated.

### A. A flat +5 damage passive on a Rare weapon

```
L10: 5 × 0.49 × 2.5 ÷ (2.5 × 17) = 14.4 %   ≤ 15 %  ✓ early
L50: 5 × 0.49 × 2.5 ÷ (2.5 × 69) =  3.6 %   < 7.5 % ✗ late
```
Fails the late check. Rephrase in scaling terms (e.g. "+15 % damage") or pair it
with something that scales.

### B. "+50 % damage vs Humanoid" on a weapon

```
+50 % × (share of output from this weapon ≈ 1.0) × uptime
uptime 0.25 → 12.5 %     uptime 0.40 → 20 %
```
At 25 % uptime it fits a Rare on its own and passes both level checks (it scales).
It sits exactly at the provisional multiplier cap. The uptime is an assumption
until species frequency is measured — write it on the item.

### C. Granted active — "Giga Slash: devastating damage, low accuracy"

Read as ×2 damage, −2 accuracy, once per fight:

```
basic attack  1.0 × 49.2 % = 0.49
Giga Slash    2.0 × 32.6 % = 0.65        (−2 accuracy ≈ DEF 15)
gain          +0.16 of an attack ≈ +0.16 BA, once per fight
value         0.16 ÷ 2.5 ≈ 6.5 %         (same at every level — relative)
```
Low accuracy eats most of "devastating". On its own this is an Uncommon-sized
active; paired with a Rare passive it needs a small cost or a smaller passive.

---

## Authoring an item — what to hand the designer

```
<Item name>
Rarity: <Common|Uncommon|Rare|Legendary>   Earliest drop level: <L>
Chassis: <category>, <1H|2H>
Role / fantasy: <one line>
Damage: <Low|Standard|High|Very High>   Type: <element>   Accuracy: <Low|Standard|High>
Passive: <text>
Active: <text>            (optional)
Drawback: <text>          (optional)
Automation: <engine | GM-adjudicated>
```

Word bands relative to the chassis: damage **Low −2 · Standard 0 · High +4 ·
Very High +8** (Very High expects a drawback); accuracy **Low −1 · Standard 0 ·
High +1**. The answer is a stat line, a budget sheet against the rarity, the level
check at earliest drop and L50, the assumed uptimes, the engine route, and final
item text.

---

## What this guide does not see

- **Interactions and combos** — the thing players find first. Sim it.
- **Party composition** — a support item is worth more in a party with no support.
- **Utility outside combat** (tracking, crafting, social checks) — unpriced;
  keep it flavourful and cheap.
- **Absolute precision** — `BA` is a two-anchor line. It is meant to stop
  wandering, not to settle arguments to the decimal.

## Quick reference

```
BA(L)        ≈ 34 × 1.036^(L−30)        L10 17 · L20 24 · L30 34 · L41 50 · L50 69
Output/fight ≈ 2.5 × BA(L)
Value %      = expected dmg-equivalent/fight × uptime ÷ (2.5 × BA(L))
Budgets      Common 5 · Uncommon 10 · Rare 15 · Legendary 20–25 (+ drawback)   [placeholders]
Level check  ≤ budget at earliest drop · ≥ ½ budget at L50
+1 dmg       0.49 ÷ BA(L)  (decays)        +1 acc  +17 % (DEF 13) … +24 % (DEF 15)
1 BA         extra action · denied enemy action · ~60 HP at L30
```
**Never:** calibrate against legacy items · ship a strictly-better item ·
count refinement/orbment inside the budget.
