# Equipment Design — Power Budget Guide

The yardstick a designer uses to answer *"is this item about as strong as its
rarity says, and will it still matter at level 50?"* before building it.

Status: **ADOPTED 2026-09-13. FORWARD-ONLY.** Applies to equipment designed from
this date. Existing equipment is left exactly as it is — see
[Legacy items](#part-7--legacy-items). Offline measurement:
`tools/mindscape --equip` (ruleset Part 6d), first item measured 2026-09-13.
**Pricing corrected 2026-09-13** from the measured reference ladder (Part 10, P1–P7
accepted). The house monster roster is the live environment every price reads; the
rulebook NPC formula is the base it is compared against.

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
**Baseline Action** `BA(L)` so the same item can be checked across the level
band **L20 → L50**.

```
BA(L)          ≈ 34 × 1.036^(L − 30)                 damage-equivalent per action
Output/fight   ≈ 2.5 × BA(L)                         one character, standard fight
Value %        = (extra damage-equivalent per fight × uptime) ÷ (2.5 × BA(L))
Pass           = Value % ≤ budget at L20   AND   ≥ ½ budget at L50
```

---

## Part 1 — The pillar: gear is horizontal

Classic JRPG gear is **vertical** — each town sells a strictly better sword and
the old one becomes vendor trash. This game rejects that: an item found early
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
> calibration source (Part 7). If the reference set (Part 8) shows the chassis
> reads weak at the table, apply **one uniform uplift** to the whole table.

Trades inside the chassis are allowed at the prices in Part 4 (e.g. −2 damage for
+1 accuracy is roughly even at low level and favours accuracy later).

### Layer 2 — Signature passive: the reason to own it

Most of the rarity budget lives here. **Word it in scaling terms** — %, skill
level, level, HR, MaxHP, Defense score, "an extra action" — so it holds its value
late. Flat numbers ("+5 damage") are allowed but pay for it in the level check.

### Layer 3 — Active skill: priced as surplus

An active replaces the action the wielder would otherwise take. It costs budget
**only for what it adds over what that action would have done**, per expected
use, minus any resource it spends (Part 4).

### Wording ruling — "when you attack with this weapon"

Means a **basic attack** with the weapon, and nothing else (ruling 2026-09-13). A
skill that swings the weapon does **not** trigger it. Two consequences:

- **A basic attack is small late.** Measured at L41: a chassis Flail swing is worth
  **~13 expected damage — about ¼ of one BA** — because BA is mostly skills, free
  actions and exploits. Anything riding a basic attack decays with level like a
  flat stat, even when it is phrased as a multiplier (Multi, +%).
- **The sim can only measure it on a weapon-only PC.** Mindscape's party swings
  the weapon only when no modelled skill is affordable (ruleset Part 6d).

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
and every budget is a percentage of that — equivalently, **extra damage per
action ÷ BA(L)**, which is how a sim result is read.

---

## Part 4 — Pricing effects

Price an effect as **expected** damage-equivalent per action ÷ `BA(L)` — the same number
as per fight ÷ `2.5 × BA(L)`. Defensive effects divide damage prevented per round by
**HP-per-BA(L) = 60 × BA(L) ÷ 34** (60 HP ≈ 1 BA at L30).

Corrected 2026-09-13 from the measured ladder (Part 10, P1–P6 **accepted**): every price
reads the **encounter** — the wearer's hit chance against the monsters, and the monsters'
hit chance against the wearer.

> **Use your monster's real numbers.** This table's own roster is the live environment.
> Price against the DEF, MDEF, accuracy and elements of the monsters the item will actually
> meet — the lookup tables below, or the monster's sheet. With no roster in mind, use the
> **house defaults: DEF 12, MDEF 11** (means of 23 house monsters: 12.2 / 10.7). The
> rulebook NPC formula is the **base** the house roster is compared to (Part 10), not a
> design target.

| Effect | How to value it | Scales with level? |
|---|---|---|
| **+1 damage on hit** (P1) | wearer's **hit chance** against the monster's DEF (MDEF for spells) ÷ `BA(L)` | **Decays ~2.1×** L20→L50 (below) |
| **+1 accuracy** (P2) | ≈ **½ × (hit-rate points gained ÷ current hit rate)** of the damage from affected attacks. Treat as a **ceiling**: against the house roster the sim measured 0.5–1.1× of it (median ≈ ⅔). Worth most against high-DEF monsters, near nothing against low ones | Only while monster DEF keeps pace |
| **+X % damage** | X % × share of output it applies to × uptime (the share already carries the hit rate) | Only as far as the attack it rides does |
| **Damage rider on a multi-target action** (P3) | the per-target value **× the targets it actually hits** (+X on a Burst that hits three = 3×) | As the action |
| **Extra action / free attack** | **1 BA** per occurrence | Yes |
| **Extra targets (Multi N)** | extra targets actually present × the rider attack's expected damage per target. **Full value — no split-damage discount** (measured, Part 9 D) | Only as far as the attack it rides does |
| **Deny an enemy action** (Paralyze, etc.) | up to **1 BA** per action denied; weak statuses far less in 2-round fights | Yes |
| **HP restored / prevented** | ~**60 HP ≈ 1 BA** at L30 (Remedy: 50 HP ≈ 0.8 actions); scale by `BA(L) ÷ 34` | Yes |
| **+1 DEF / MDEF** (P4) | (monster hit-rate points removed ÷ its hit rate) × the damage aimed at that defence that the wearer — **and anyone they protect** — takes per round, ÷ HP-per-BA. Price **party-wide**. Near zero on a character the monsters hit regardless | Only while the wearer's defence sits near the monsters' roll |
| **Resistance** (P5) | ½ × the damage the wearer takes × **that element's share** of it, ÷ HP-per-BA. Zero against a roster that never deals the element | With the roster's elements |
| **+ Max HP** (P6, open) | **not damage** — price by KO prevention, below | — |
| **MP cost** | 10 MP ≈ 25–35 damage ≈ **~0.9 BA** at L30 — subtract from the effect | — |
| **IP cost** | 3 IP ≈ 50 HP ≈ **~0.8 BA** — subtract; IP is contested with potions | — |

### Hit-chance lookup

Exact enumeration of the check (two dice, critical on doubles ≥ 6, fumble on double 1s), for
the blank-slate archetypes at table power (ruleset Part 6g). **+1 accuracy = read one column
left; −1 accuracy = one column right.** For a real PC, enumerate its own dice and bonus.

**Party → monster.** Striker weapon attack (DEX+MIG, Greatsword +1) against DEF:

| Level | Dice, bonus | 8 | 10 | 11 | **12** | 13 | 14 | 15 | 16 | 18 |
|---|---|---|---|---|---|---|---|---|---|---|
| 20 | d12+d8 +3 | 94% | 84% | 78% | **71%** | 63% | 54% | 46% | 39% | 24% |
| 30 | d12+d8 +4 | 97% | 90% | 84% | **78%** | 71% | 63% | 54% | 46% | 30% |
| 41 | d12+d10 +5 | 99% | 95% | 92% | **88%** | 83% | 77% | 70% | 63% | 47% |
| 50 | d12+d10 +6 | 99% | 98% | 95% | **92%** | 88% | 83% | 77% | 70% | 54% |

Caster spell (INS+WLP) against MDEF:

| Level | Dice, bonus | 8 | 10 | **11** | 12 | 13 | 14 | 15 | 16 | 18 |
|---|---|---|---|---|---|---|---|---|---|---|
| 20 | d12+d10 +2 | 92% | 83% | **77%** | 70% | 63% | 54% | 47% | 38% | 25% |
| 30 | d12+d10 +3 | 95% | 88% | **83%** | 77% | 70% | 63% | 54% | 47% | 32% |
| 41 | d12+d12 +4 | 98% | 93% | **90%** | 85% | 81% | 75% | 69% | 62% | 47% |
| 50 | d12+d12 +5 | 99% | 96% | **93%** | 90% | 85% | 81% | 75% | 69% | 55% |

Rulebook NPC defences sit at 8–10 at L35–50, where the party hits 93–99% and accuracy has
almost nothing left to buy. House monsters sit at 6–16.

**Monster → party (house roster).** Each monster's main attack against a defence of 10 / 13 /
16, and the rulebook NPC of the same level and rank against 13 for comparison:

| Dungeon | Monster | L | DEF | MDEF | Hit vs 10 / 13 / 16 | Rulebook @13 |
|---|---|---|---|---|---|---|
| The Wyrmwood | Centuaros | 40 | 14 | 12 | 95 / 83 / 63% | 77% |
| The Wyrmwood | Inferex | 40 | 15 | 12 | 98 / 88 / 70% | 77% |
| The Wyrmwood | Fire Slime | 30 | 6 | 6 | 83 / 42 / 8% | 63% |
| The Wyrmwood | Pyrefly | 32 | 16 | 11 | 75 / 55 / 33% | 63% |
| The Wyrmwood | Salamander | 35 | 11 | 11 | 98 / 84 / 56% | 63% |
| The Wyrmwood | Dryad | 34 | 11 | 12 | 85 / 64 / 37% | 63% |
| The Wyrmwood | Hellhound | 35 | 12 | 11 | 88 / 56 / 21% | 63% |
| The Wyrmwood | Marigold | 26 | 11 | 10 | 85 / 64 / 37% | 54% |
| Ancient Temple | O'zealot | 35 | 13 | 9 | 99 / 99 / 88% | 63% |
| Ancient Temple | O'lmek | 38 | 15 | 8 | 97 / 72 / 28% | 63% |
| Valley of the Dragon | Skizzik | 48 | 12 | 8 | 99 / 99 / 90% | 77% |
| Valley of the Dragon | Kirin | 50 | 14 | 15 | 99 / 96 / 81% | 83% |
| Valley of the Dragon | Ampere | 43 | 10 | 10 | 99 / 90 / 72% | 77% |
| Valley of the Dragon | Mana Ray | 45 | 11 | 10 | 99 / 93 / 74% | 77% |
| Valley of the Dragon | Drakoza | 43 | 11 | 10 | 99 / 90 / 71% | 77% |
| Valley of the Dragon | Mist Dragon | 45 | 14 | 13 | 99 / 96 / 85% | 77% |
| Valley of the Dragon | Obsidrax | 46 | 13 | 11 | 99 / 94 / 78% | 77% |
| Fafnir Castle | Imp | 50 | 15 | 14 | 90 / 65 / 35% | 83% |
| Fafnir Castle | Dragon Guard | 50 | 12 | 10 | 94 / 79 / 55% | 83% |
| Fafnir Castle | Dire Orc | 50 | 10 | 6 | 90 / 75 / 55% | 83% |
| Fafnir Castle | Death Gazer | 50 | 8 | 16 | 96 / 85 / 69% | 83% |
| Fafnir Castle | Succubus | 50 | 12 | 14 | 95 / 83 / 63% | 83% |
| Fafnir Castle | Iron Colossus | 52 | 14 | 8 | 96 / 85 / 69% | 83% |

"Hit vs" is against the defence that monster's main attack rolls at (DEF or MDEF). Rulebook
brute (the NPC formula's heaviest attacker) as the base:

| Level | DEF 7 | 10 | 12 | 13 | 15 | 18 |
|---|---|---|---|---|---|---|
| 20 | 94% | 78% | 63% | 54% | 39% | 18% |
| 30 | 97% | 84% | 71% | 63% | 46% | 24% |
| 41 | 99% | 92% | 83% | 77% | 63% | 38% |
| 50 | 99% | 95% | 88% | 83% | 70% | 47% |

Reading P4 off these tables: +1 DEF against an Iron Colossus on a DEF 13 wearer removes
about 5 points of an 85% hit rate — ~6% of the damage aimed at DEF. Against O'zealot, whose
attack lands 99% at DEF 13, it removes nothing.

### Max HP — KO prevention (P6, still open)
Max HP does not show up as damage prevented; its value is keeping the most-hit character
standing. +25 HP on that character cut their KO rate by **41–57 points against rulebook
enemies** at L35–50, but only **9–16 points against the house roster**, whose hits are
2–6× larger. Until P6 closes, judge it against **one typical hit of the monsters the item
will meet**: max HP smaller than one hit buys little.

> **On the split-damage discount.** Spreading damage "kills nothing sooner", so an
> earlier draft valued extra-target damage at 50 %. The Explosion Whip A/B found
> the extra hits landing at **full value and shortening fights** (3 targets: 7 → 5
> rounds). The practice dummies never attack, though, so the *survival* half of the
> argument — enemies living longer under spread damage — was not tested. Price at
> full value; revisit if a sim against attacking enemies shows otherwise.

### Flat values decay — the table that explains the whole guide

`+1 damage on hit` for the Striker, as a share of output (hit chance ÷ BA, P1):

| Against | L20 | L30 | L41 | L50 | L20 ÷ L50 |
|---|---|---|---|---|---|
| **House default, DEF 12** | 3.0 % | 2.3 % | 1.8 % | 1.3 % | 2.2× |
| Guide design point, DEF 13 | 2.6 % | 2.1 % | 1.7 % | 1.3 % | 2.1× |

The climbing hit rate softens the decay, but a flat bonus is still worth **about twice as
much at L20 as at L50** — right at the limit the level check allows, so a flat stat alone
just fails late. The passive, not the stat line, has to carry an item late.

Measured: against the rulebook base the sim reproduces this row exactly (1.00×). Against
the house spawn groups it lands at 0.6–1.2× (mean ≈ 0.9): 1.5 % per point in the Wyrmwood,
1.3 % in the Ancient Temple, 1.4 % in the Valley, 1.1 % in Fafnir Castle. Mixed-DEF groups
and affinities pull it below paper.

### Uses per fight (defaults)

| Trigger | Uses / standard fight |
|---|---|
| Weapon attack | 2.5 |
| Per-round trigger | 2 |
| Once per scene / conflict | 1 |
| "When you reduce an enemy to 0 HP" | ~1 in a 2-enemy fight — use 0.5 as uptime |
| "On even rounds" | uptime **0.45** (2-round fight 50 %, 3-round 33 %, boss ~50 %) |

### Encounter size (default mix)

Anything that depends on how many enemies are present uses this mix until
encounter sizes are measured across the dungeon rosters:

| Enemies | Share | Extra targets for Multi 2 | for Multi 3 |
|---|---|---|---|
| 1 (solo / boss) | 20 % | 0 | 0 |
| 2 | 30 % | 1 | 1 |
| 3+ | 50 % | 1 | 2 |
| **Expected** | | **0.8** | **1.3** |

### Uptime — the conditional discount

`uptime` = the fraction of fights (or attacks) where the condition is actually
true. A narrow condition is **cheap**, so it may be strong. Estimate it for a
**random roster** (`project_multiparty_randomized_runs`), not today's party.
Class- or skill-specific conditions ("Flail attacks", "Frenetic Footwork SL+2")
are what Magic: The Gathering calls **parasitic** — they need a specific other
piece to function — and usually have very low uptime.

**Species conditions: assume an even spread** across the 8 canonical species →
**12.5 % uptime per species named** (ruling 2026-09-13, until species frequency
across the rosters is measured).

---

## Part 5 — Rarity budgets and the level check

| Rarity | Budget (% of output / fight) | Complexity | Orbment slots |
|---|---|---|---|
| Common | **≤ 5 %** | chassis + at most one simple keyword | 1 |
| Uncommon | **≤ 10 %** | one conditional passive | 1 |
| Rare | **≤ 15 %** | a build-enabler, or an active | 2 |
| Legendary | **≤ 20–25 %** | breaks a rule; **must** carry a real drawback | 3 |

Budgets are **working values** (P7, accepted 2026-09-13), checked by full-loadout band
tests. In each test every member wears 3 × the budget, all as offense (Part 10).
- **Rulebook base:** no fight was won in one round at any rarity.
- **House roster:** one-round wins rise from 1% on basic gear to 9% at Uncommon and 17% at
  Legendary. Nearly all of them come from a few soft spawn groups, while the storm groups
  still beat most parties in full Legendary.
- **The gap between spawn groups is wider than the gap between rarities.** That is encounter
  design, not a budget problem.

The budgets stay. Re-check them with `reference-loadout.js --ladder` when a dungeon's
monster HP or damage changes.

The complexity column follows Magic's *New World Order*: simple effects live at
low rarity, so rarity means something besides a number. Budget the item **at +0
with empty slots** — refinement and orbment are power the player earns on top.

### The level check (power band L20 → L50)

The treasure roulette can drop an item at any point, so the check spans the band
instead of a drop level:

1. **L20 — not above budget.** Catches effects that are overwhelming early.
2. **L50 — at least half the budget.** Catches effects that fade into nothing.

The two checks allow at most a **2× decay** across the band. Scaling effects pass
on their own. Flat damage decays about **2.1×** (Part 4) and fails late by a hair;
anything riding a basic attack decays about **3×** (Part 9 D). Both need a scaling
component to pass.

> **Open question:** items that can drop **below L20**. At L5–L20 a strong rider
> one-shots small monsters and even bosses, and no budget in this table covers
> that. Until decided, treat the band as L20+ and keep early-dropping items modest.

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
- **Riders interact.** Two halves of one passive can be worth more together than
  apart: Explosion Whip's bonus lands on every extra target the Multi adds (Part
  9 D: 6.1 % + 5.3 % alone, 14.3 % together). Price the combination, not the parts.
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
  - round-conditional riders → condition on `ROUND` (`skill-formulas.js`). A
    round-conditional **target count** would need a formula `skill_target` that
    can read `ROUND` at target selection — **unverified**.
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
flavour tuning, run through Mindscape, then adjust the Part 5 percentages from the
result. Those items become the canon new designs are compared to.

**Method: offline sim only** (decided 2026-09-13) — `node bin/mindscape.js
--equip "<PC>=<item.json>"` swaps a weapon in memory; no real loadout changes.
Each run is an **A/B against a chassis arm** on the same seed; read the wielder's
row in `party output`. Specs live in `tools/mindscape/specs/equipment/`.

**Status (2026-09-13):**
- **Full loadouts DONE.** `--equip "<PC>[:<slot>]=<source>"` covers main, off, armor
  and both accessories, from a paper spec, a world item (`item:<name>`) or the PC's own
  inventory (`own:<name>`); the sheet is re-derived and set bonuses reconciled
  (ruleset Parts 6d–6f). A PC whose real kit does not rebuild is refused
  (`bin/verify-loadouts.js`).
- **The 0% chassis is real.** `--baseline-gear all` swaps every slot to its same-class
  basic item. Measure an item as *baseline + that item* against *baseline*, same seed.
- **Fight length is reported** in the non-boss bands (1 too easy · 2–3 standard · 4+ too
  long), from raw model rounds — read a model "3" as a live "2".
- **First read** (Inferex + Centuaros, seed `gear`, 2000 runs, raw model rounds):

  | Loadout | Verdict | Rounds 1 / 2–3 / 4+ | Party DPR | Enemy DPR |
  |---|---|---|---|---|
  | Real gear | 3 rounds, 50% party HP | 0% / 94% / 6% | 150 | 85 |
  | Baseline gear (all four) | **defeat 81%** | 0% / 15% / 85% | 61 | 165 |
  | Baseline + Zarg's own +5 bow | 4 rounds, 22% party HP | 0% / 23% / 77% | 93 | 143 |

  Gear is doing most of the work in this fight: it halves the damage the party takes
  (fire absorb/resist, Paladin MDEF, Protect from armor) and more than doubles the damage
  it deals. One refined weapon alone turns a wall into a close call. Judge gear against
  the encounter it meets, not in a vacuum.
- **Blank-slate parties DONE** (ruleset Part 6g). `--party-archetype <preset> --level N`
  builds a generic party by the character-creation rules at any level, and
  `--neutral-encounter` builds enemies by the rulebook NPC formula with no affinities. The
  **L20 and L50 checks can now be measured**, not only priced on paper. Default power
  `table` carries a skill layer calibrated to the real party on basic gear (k = 3.54).
  Baseline table: `tools/mindscape/expectations/archetype-sweep.json`.
- **Measure on archetypes first, the real party second.** An item's value is *archetype
  preset + item* vs *archetype preset* at the same level, power and seed, across the four
  presets — report the spread, because composition moves results more than level does.
  The real party is a cross-check for skill-specific interactions archetypes cannot show.
- **Reference ladder MEASURED and ACCEPTED (2026-09-13).** 24 plain items on archetypes,
  plus a full-loadout band test per rarity, first against rulebook enemies at L20/30/41/50,
  then against **13 real spawn groups from the house dungeons** with the rulebook base at the
  same levels beside them. Corrections P1–P7 are applied to Parts 4 and 5; results in
  Part 10.

Limits: archetypes have no class-skill identities (a rider that depends on a specific skill
needs the real party or the live sim); basic-attack riders measure best on the Striker or
Ranger (weapon-only kits); off-hand weapon attacks and Unarmed Strike unmodelled; the skill
layer is one L41 anchor, extrapolated to other levels.

---

## Part 9 — Worked examples

Re-priced 2026-09-13 with the accepted rules (Part 10, P1–P3): the wearer's **real hit
chance** against this table's typical monster defence, **DEF 12** (the live roster's mean is
12.2), read from the Part 4 hit-chance table. The earlier drafts used a flat 49% and read
flat bonuses too low.

### A. A flat +5 damage passive on a Rare weapon (Striker-type wielder)

```
L20: 5 × 71 % ÷ BA(20) 23.8 = 14.9 %   ≤ 15 %  ✓ early
L50: 5 × 92 % ÷ BA(50) 68.9 =  6.7 %   < 7.5 % ✗ late (narrowly)
```
Still fails the late check, but only just: the hit rate climbing with level softens the
decay (2.1× across the band, not 2.9×). Swapping pure flat for part flat, part scaling
passes both ends — **"+3 + level ÷ 10"**: L20 (+5) 14.9 % ✓, L50 (+8) 10.7 % ✓. Pure
"+ level ÷ 10" does not: +2 at L20 (5.9 %) but only +5 at L50 (6.7 %) — the same late fail
as a flat +5.

### B. "+50 % damage vs Humanoid" on a weapon

```
+50 % × (share of output from attacks this applies to) × uptime (1 species = 12.5 %)
share 1.0 → 6.3 %          share ¼ (basic attacks only, L41) → 1.6 %
```
Unchanged by P1: a percentage of damage already carries the hit rate inside "share of
output". A weapon-user whose skills count sits comfortably in Uncommon; restricted to basic
attacks it is nearly free. It sits exactly at the provisional multiplier cap.

### C. Granted active — "Giga Slash: devastating damage, low accuracy"

Read as ×2 of a basic swing's damage, −2 accuracy, once per fight, at L41 vs DEF 12:

```
basic attack  1.0 × 88 % = 0.88 of a basic swing
Giga Slash    2.0 × 77 % = 1.54 of a basic swing        (−2 accuracy ≈ DEF 14)
gain          +0.66 basic swings, once per fight
value         a basic swing ≈ ¼ BA at L41 → +0.17 BA ÷ 2.5 ≈ 6.6 % at L41
```
With a high base hit rate the accuracy penalty costs little (P2 in reverse), so "devastating"
survives: an Uncommon-sized active. Against a high-DEF monster (DEF 16: 63 % → 47 % with the
penalty, exact enumeration) the same active drops to ~3 %. Price actives against the defence of the monsters they will
actually meet.

### D. Explosion Whip — measured (2026-09-13)

*Uncommon, Flail chassis (+8, DEX+DEX), Fire. On even rounds, basic attacks deal
10 bonus damage and gain Multi 3.*

**Setup.** Mindscape, L41 party, Zarg wielding each arm (his modelled kit is
weapon-only, so every swing is a basic attack), vs 1/2/3 neutral non-attacking
practice dummies (200 HP, DEF 13), 1000 runs, same seed per enemy count.

| Zarg damage / round | 1 enemy | 2 enemies | 3 enemies |
|---|---|---|---|
| Chassis whip (control) | 23.5 | 24.5 | 25.4 |
| **Explosion Whip** (Multi 3, +10) | 29.2 | 41.1 | 52.5 |
| Scaled (Multi 2, + level ÷ 5) | 27.9 | 39.0 | 42.0 |
| Multi 2 only | 23.5 | 30.8 | 33.1 |
| level ÷ 5 bonus only | 27.9 | 29.8 | 30.5 |

Zarg took 1.8–1.9 turns per round in every arm (Acceleration), so the gain per
action ÷ BA(41) gives the budget share; weighted by the encounter mix (Part 4):

| Arm | 1 | 2 | 3 | **Weighted** | Budget read |
|---|---|---|---|---|---|
| Explosion Whip | 6.3 % | 17.6 % | 28.5 % | **20.8 %** | ~2× Uncommon; Legendary-sized |
| Scaled | 4.9 % | 15.4 % | 17.3 % | **14.3 %** | Rare |
| Multi 2 only | 0 % | 6.7 % | 8.1 % | **6.1 %** | Uncommon |
| Bonus only | 4.9 % | 5.6 % | 5.3 % | **5.3 %** | Common / low Uncommon |

Across the level band (paper, from the L41 measurement: a basic swing stays about
the same while BA grows; the level bonus grows with it):

| Arm | L20 | L41 | L50 | Check |
|---|---|---|---|---|
| Multi 2 only | ~13 % | 6.1 % | ~4.4 % | Uncommon: slightly over early, slightly under late |
| Bonus only (level ÷ 5) | ~5.5 % | 5.3 % | ~4.8 % | flat across the band ✓ |
| Scaled (both) | ~21 % | 14.3 % | ~12 % | Rare: over early, ✓ late |

**Reading.**
- **Multi 3 is the expensive part**, and it grows with enemy count: +107 % of the
  control's damage against three enemies.
- **Paper and sim agree** once the split-damage discount is dropped: paper at full
  value said 19.6 % / 12.2 % for the original / scaled; the sim says 20.8 % / 14.3 %.
- **The level bonus is the only part that holds its share** across the band. Multi
  on a basic attack decays about 3×, more than the check allows.
- **The sim fights run long** (3–7 rounds; the test party lost Zarg's real bow), so
  even rounds come up slightly more often than in a 2–3 round live fight. Read the
  shares as a few percent high.

**Options** for the designer — pick by identity, not by the decimals:

| Version | Where it lands |
|---|---|
| Even rounds: basic attacks gain **Multi 2** | Uncommon; strong early, fading late |
| Even rounds: basic attacks gain **Multi 2** and **+ level ÷ 5** | Rare |
| Even rounds: basic attacks deal **+ level ÷ 3** (single target) | Uncommon, flat across the band — but loses the splash identity |

---

## Part 10 — Measured reference ladder (2026-09-13)

**Status: MEASURED. Corrections P1–P7 ACCEPTED 2026-09-13** and applied to Parts 4 and 5.
This part keeps the evidence: first the rulebook bench the corrections came from, then the
same ladder against the house roster (the live environment), with the rulebook base at the
same levels beside it.

### Method
- **Items:** `tools/mindscape/specs/equipment/reference-set.json`. 24 plain items, each the
  wearer's own basic item plus ONE effect, in a ladder of magnitudes, because some effects
  are lumpy: +1 accuracy was already priced near a Rare.
- **Party:** the four archetype presets, table power (k 3.54), at L20 / 30 / 41 / 50.
- **Enemies:** the neutral rulebook "normal" encounter (four soldiers) at **DEF/MDEF 13, the
  guide's own design point**. Rulebook dice defences were run as a sensitivity check
  (`reference-set-dice.json`); every conclusion below holds there too.
- **Runs:** 1000 per arm, as an A/B against the same party without the item, same seed.
- **Pricing:**
  - **Offense %** = extra damage per wearer action ÷ BA(L).
  - **Defense %** = damage prevented per round **across the whole party** ÷ HP-per-BA(L).
    Party-wide, because a protector that gains DEF steps in front of *more* hits.
- **Reproduce:** `node bin/reference-set.js --out …` · `node bin/reference-loadout.js --out …`

### Results — mean across presets (paper price in brackets)
| Item | L20 | L30 | L41 | L50 |
|---|---|---|---|---|
| Weapon +10 damage (Striker) | 27.3% (20.5) | 22.0% (14.4) | 17.0% (9.8) | 12.9% (7.1) |
| Weapon +1 accuracy (Striker) | 7.7% (17) | 6.0% (17) | 2.9% (17) | 1.9% (17) |
| Spell +5 damage (Caster) | 30.9% (10.3) | 26.9% (7.2) | 18.2% (4.9) | 15.9% (3.6) |
| +3 DEF on the Tank | 6.6% (9.3) | 3.3% (6.3) | 2.4% (6.2) | 1.1% (4.1) |
| +3 DEF on the most-hit (a Caster) | 3.1% (10.3) | 1.9% (9.5) | 0.8% (7.7) | 0.4% (6.7) |
| +3 MDEF on the most MDEF-hit | 2.9% (7.6) | 2.0% (6.3) | 1.2% (5.9) | 0.9% (5.0) |
| Physical resistance (all-physical enemies) | 19.9% (16.3) | 14.0% (12.8) | 12.8% (11.6) | 11.8% (9.6) |
| +25 max HP on the most-hit | wearer KO rate −38 pts | −40 | −43 | −54 |

Every ladder is linear within its noise. Full tables: `tools/mindscape/expectations/reference-set.json`.

### What the numbers say
1. **The flat-damage row is right; its hit rate is not.** The Striker hits DEF 13 at
   63 / 71 / 83 / 88% (exact enumeration), not the 49% the row assumes. Paper × (hit ÷ 49%)
   reproduces the sim at every level: 2.64 vs 2.73, 2.09 vs 2.2, 1.66 vs 1.7, 1.28 vs 1.29 %
   per point. Flat damage decays **2.1×** from L20 to L50, not the 2.9× the Part 4 table
   implies, because the hit rate climbs with level.
2. **Accuracy is worth what is left to miss.** +1 accuracy adds 8 / 7 / 5 / 4 hit-rate points
   on 63 / 71 / 83 / 88% bases. The sim lands at about half of even that ratio. The +17%
   row only holds near a 50% hit rate, and at this table's power level accuracy fades to
   ~2% by L50 unless the monsters' DEF climbs faster than the party's skill layer.
3. **A damage bonus on a multi-target action counts once per target.** +X on a Burst that
   hits three soldiers measured 3–4.5× the single-target paper price.
4. **DEF/MDEF buys far less than the table says.** The rulebook enemies' accuracy climbs
   (a brute hits DEF 15 39% of the time at L20 and 70% at L50), so a +3 DEF armor goes from
   6.6% to 1.1% on a Tank, and near zero on a low-DEF Caster, who gets hit regardless.
   Defense concentrates on characters whose DEF already sits near the enemy's roll.
5. **Resistance at full uptime matches the paper price** (half the damage it applies to).
6. **Max HP does not show up as damage.** Its value is keeping the most-hit character
   standing: +25 HP cut that character's KO rate by 38–54 points.

### Full loadouts — the budget-size check (Part 5)
Every member wears **3 × the rarity budget**, all spent as offense (the upper bound, since
offense is what shortens fights), sized from the measured curves. The same enemies, standard
preset:

| Mean model rounds | Basic | Common | Uncommon | Rare | Legendary |
|---|---|---|---|---|---|
| L20 | 5.41 | 4.83 | 4.04 | 3.89 | 3.58 |
| L30 | 4.64 | 4.22 | 3.64 | 3.26 | 3.32 |
| L41 | 4.81 | 4.00 | 3.40 | 3.04 | 2.77 |
| L50 | 4.22 | 3.54 | 3.11 | 2.83 | 2.56 |

- **No preset, level or encounter ever ended in one round** — 0% in the 1-round band in all
  160 rows, including full Legendary loadouts.
- **The Part 4 fight-length formula holds.** rounds ÷ (1 + 3 × budget) predicts the measured
  rounds within ~10% (L41: 3.70 / 3.32 / 2.87 predicted vs 3.40 / 3.04 / 2.77 measured).
- **Composition dominates.** The physical preset needs Rare gear just to reach the 2–3 round
  band that double-caster reaches on Common.

### Corrections (ACCEPTED 2026-09-13, applied to Parts 4–5)
| # | Where | Proposal |
|---|---|---|
| P1 | Part 4, "+1 damage on hit" | Use the **wearer's hit chance against the expected DEF**, not a fixed 49%. |
| P2 | Part 4, "+1 accuracy" | Value ≈ ½ × (hit-rate points gained ÷ current hit rate); +17% only near a 50% hit rate. |
| P3 | Part 4 | A damage rider on a multi-target action is worth × the targets it actually hits. |
| P4 | Part 4, "+1 DEF / MDEF" | Price from the **enemy's** hit chance against the wearer's defence, party-wide; roughly ⅔ of the current row at L20, falling to ⅕–¼ by L41–50 against rulebook accuracy. |
| P5 | Part 4 | Keep Resistance at ½ × exposure; scale by the element's share of incoming damage. |
| P6 | Part 4 | Price max HP by KO prevention (actions kept), not as damage — still open. |
| P7 | Part 5 | Keep the rarity budgets as working values: a whole party in full Legendary offense stays out of the 1-round band here. |

### The house roster — the live environment
**Setup.**
- **Items and party:** the same 24 items and four presets, table power.
- **Encounters:** 13 spawn groups copied from the dungeons' Encounter tables
  (`tools/mindscape/specs/encounters/house-set.json`), each at its own level (L35–50) and
  under its conflict event (the Valley's lightning storm). 1000 runs per arm.
- **Rulebook base:** the same ladder against rulebook NPCs at the same levels (35 / 38 / 40 /
  46 / 48 / 50, dice defences), 500 runs per arm. It shows how far the game has grown from
  the book.
- Outputs: `expectations/reference-set-house.json` and `reference-set-rulebook.json`
  (ruleset Part 6i).

**How far the roster has moved from the book.** Each monster against the rulebook NPC of
the same level and rank (23 monsters), dungeon means:

| Dungeon | HP × book | DEF vs book | MDEF vs book | Accuracy vs book | Damage bonus × book | Monster hit vs DEF 13 (book) |
|---|---|---|---|---|---|---|
| The Wyrmwood | 0.58× | +3.3 | +2.1 | +1.1 | 3.1× | 67% (65%) |
| Ancient Temple | 0.92× | +7.0 | +2.5 | +5.5 | 5.8× | 85% (63%) |
| Valley of the Dragon | 0.98× | +3.0 | +1.9 | +4.0 | 2.6× | 94% (78%) |
| Fafnir Castle | 1.45× | +3.2 | +2.7 | −0.3 | 2.2× | 79% (83%) |

The roster keeps HP near book size (0.96× overall) but hits **2–6× harder**, sits about **+3
DEF / +2 MDEF** above the book (the Temple +7 DEF), and lands more often in the Temple and
the Valley. Every difference below follows from that.

**Per point, by dungeon** — % of output per point; the rulebook base at the same levels in
brackets:

| Effect | Wyrmwood L35–40 | Ancient Temple L38–40 | Valley L46–50 | Fafnir L50 |
|---|---|---|---|---|
| Weapon +1 damage (Striker) | 1.50 (2.2) | 1.32 (2.1) | 1.41 (1.5) | 1.06 (1.4) |
| Weapon +1 accuracy (Striker) | **3.33** (0.66) | **2.49** (0.67) | 1.57 (0.37) | 1.03 (0.24) |
| Spell +1 damage (fire Caster) | 1.11 (4.8) | 4.17 (4.2) | 2.78 (3.1) | 2.76 (3.1) |
| +1 DEF on the Tank | **2.11** (0.69) | 0.46 (0.67) | 0.61 (0.41) | **1.82** (0.35) |
| +1 DEF on the most DEF-hit | 1.52 (0.47) | 0.57 (0.43) | 0.67 (0.21) | 1.69 (0.13) |
| +1 MDEF on the most MDEF-hit | 1.49 (0.52) | 1.11 (0.55) | 0.13 (0.36) | 0.39 (0.31) |
| Physical resistance (one item) | 11.5% (15.6) | −2.0% (15.0) | 0.5% (13.3) | 13.6% (11.7) |
| +25 max HP, most-hit KO rate | −9 pts (−48) | −9 pts (−48) | −13 pts (−52) | −16 pts (−49) |
| Basic-gear baseline | 3.3 rds, **50% loss** (4.7, 0%) | 3.9 rds, **49%** (4.7, 0%) | 2.7 rds, **73%** (4.7, 0%) | 5.9 rds, **52%** (4.7, 0%) |

Spread across presets is in the output; the defence rows swing most with composition.

**What the house numbers say**
1. **Accuracy is worth 4–5× more here than against the book.** The roster's DEF leaves the
   party real misses to convert: +1 accuracy is worth 3.3% in the Wyrmwood and 1.0% in
   Fafnir Castle, against 0.2–0.7% in the base. P2 read against each group's real DEF
   predicts the house values within 0.5–1.1× (median ≈ ⅔).
2. **Flat damage lands a little under paper** (0.6–1.2× of P1, mean 0.9) and under the base
   at the same level, because the party hits house monsters less often. P1 already carries it.
3. **Spell damage is worth what its element does in the dungeon.** The archetype Caster casts
   fire. A Wyrmwood group of fire absorbers gives it 0.0% per point, and the Temple group
   with an Inferex 0.4%, while the O'zealot group gives 7.9%. Price offensive elements with
   the P5 share, exactly like resistances.
4. **DEF and MDEF are worth 2–10× the base wherever the roster rolls against them.** That
   means DEF in the Wyrmwood and Fafnir Castle, and MDEF in the Wyrmwood and the Temple. They
   are worth next to nothing where attacks land anyway (O'zealot hits DEF 13 99% of the time)
   or roll the other defence (Valley MDEF 0.13).
5. **Resistance follows the element mix (P5).** Physical resistance is worth 20–30% in
   physical-heavy groups: Centuaros + Inferex 23.5%, Hellhound + Salamander + Marigold 20.3%,
   the Dire Orcs 29.9%. It is worth nothing in the elemental Temple and Valley groups.
6. **Max HP buys a fifth of the KO prevention.** House hits are 2–6× larger than book hits,
   so +25 HP rarely decides whether a hit knocks someone out.
7. **Gear is expected here.** On basic gear the archetypes lose about half of house fights (the
   Valley 73%) and none of the book's. The roster is tuned for a party wearing real
   equipment, and that is the environment the budgets have to fit.

### Full loadouts against the house roster
The Part 5 check on the 13 spawn groups: every member in 3 × the rarity budget, all offense,
500 runs per row. Each cell reads **mean model rounds · fights won in one round · fights lost**,
averaged over the four presets. Output: `expectations/reference-loadout-house.json`.

| Encounters | Basic | Common | Uncommon | Rare | Legendary |
|---|---|---|---|---|---|
| The Wyrmwood | 3.3 · 1% · 49% | 3.1 · 2% · 40% | 2.9 · 8% · 35% | 2.7 · 10% · 30% | 2.4 · 22% · 19% |
| Ancient Temple | 3.8 · 5% · 49% | 3.5 · 6% · 39% | 3.1 · 20% · 29% | 2.9 · 23% · 24% | 2.5 · 23% · 14% |
| Valley of the Dragon | 2.7 · 0% · 74% | 2.6 · 2% · 65% | 2.4 · 11% · 50% | 2.4 · 13% · 43% | 2.2 · 19% · 34% |
| Fafnir Castle | 5.9 · 0% · 51% | 5.5 · 0% · 30% | 4.9 · 0% · 19% | 4.2 · 3% · 6% | 3.5 · 4% · 2% |
| **All house groups** | 3.8 · 1% · 57% | 3.5 · 2% · 45% | 3.2 · 9% · 35% | 3.0 · 11% · 28% | 2.6 · 17% · 19% |
| Rulebook base, same levels | 4.4 · 0% · 0% | 3.6 · 0% · 0% | 3.2 · 0% · 0% | 2.9 · 0% · 0% | 2.4 · 0% · 0% |

"Too easy" counts **won** fights only (ruleset Part 6i). A short Valley fight on basic gear
is usually a wipe.

- **The book stays in band at every rarity.** No one-round wins; full Legendary lands 99% in
  2–3 rounds.
- **The roster leaves the band in both directions, whatever the gear.**
  - *Too easy:* one-round wins come from a few soft groups. Pyrefly + Salamander + Dryad
    (HP 0.19–0.66× book) wins in one round 17% of the time for the standard preset at
    Uncommon. Drakoza + Skizzik: 28%. Salamander + Dryad + Inferex: 38%. The double-caster
    preset already wins O'zealot + O'lmek + O'zealot in one round 36% of the time on
    basic gear.
  - *Too hard:* the storm groups Skizzik + Kirin + Skizzik and Ampere + Mana Ray + Kirin still
    beat the standard preset 73–79% of the time in full Legendary offense, and Centuaros +
    Inferex 80%. The real party beats Centuaros + Inferex with fire-resistant gear (Part 8).
    Element-matched defensive gear is what the roster rewards, and all-offense loadouts do
    not test it.
  - *Too long:* Succubus + Iron Colossus + Succubus runs 5–9 model rounds at every rarity
    (Iron Colossus has 2.1× book HP).
- **For gear, the budgets hold.** Rarity moves a group's result by less than the groups
  differ from each other, so no budget change fixes that spread. Take the named groups to
  `monster-balance-design.md` as prompts for a look, not verdicts: these are generic
  archetypes, not the real party.

### What this does not establish
- Model rounds read about one long vs live.
- Generic archetype kits: no class skills, a fire Caster, one L41 calibration anchor.
- No interactions between different effects (every item carries exactly one).
- 13 spawn groups, not every Encounter-table row. Bosses and champions are excluded.
- Passives the sim does not model are listed per group in the ladder output.

## Authoring an item — what to hand the designer

```
<Item name>
Rarity: <Common|Uncommon|Rare|Legendary>
Chassis: <category>, <1H|2H>
Role / fantasy: <one line>
Damage: <Low|Standard|High|Very High>   Type: <element>   Accuracy: <Low|Standard|High>
Passive: <text>
Active: <text>            (optional)
Drawback: <text>          (optional)
Automation: <engine | GM-adjudicated>
```

Word bands relative to the chassis: damage **Low −2 · Standard 0 · High +4 ·
Very High +8** (Very High expects a drawback; "moderate" = Standard); accuracy
**Low −1 · Standard 0 · High +1**. The answer is a stat line, a budget sheet
against the rarity, the level check at L20 and L50, the assumed uptimes and
encounter mix, the engine route, and final item text — plus a measured check.

### Measuring it — `check-item`
Write the item as a spec file (any slot), then run from `tools/mindscape`:

```
node bin/check-item.js --item my-item.json [--wearer caster] [--rarity rare]
```

- **Spec shape:** an item document.
  - `system.props`: `item_type`, `item_rarity`, and for weapons the chassis fields.
  - `effects`: stat passives as Active Effect changes, e.g.
    `{ "key": "bonus_defense", "mode": 2, "value": "2" }`.
  - `items`: gear skills — passives and actives as sub-items.
  - Examples: `specs/equipment/`.
- **What it prints:**
  - value % per dungeon on the house roster, and the rulebook base at L20 and L50
  - offense and defense, fight share kept standing, KO and loss deltas
  - the level check against the rarity budget
- **Read "What the model sees" first.** A passive with no registry entry, an active the model
  cannot parse, or an effect it cannot read measures as **0%**. That is a gap to fill or to
  price on paper (Part 4), not a verdict on the item.
- **Weapons** are measured against the basic weapon of their own category (Part 2 chassis).
  Everything else is measured against the preset's basic kit.
- Pick the wearer the item is *for*: a spell accessory on the caster, a guard armor on the
  most-hit.

---

## What this guide does not see

- **Interactions and combos** — the thing players find first. Sim it.
- **Party composition** — a support item is worth more in a party with no support.
- **Utility outside combat** (tracking, crafting, social checks) — unpriced;
  keep it flavourful and cheap.
- **Survival effects of spread damage** — the whip A/B used non-attacking dummies.
- **Absolute precision** — `BA` is a two-anchor line. It is meant to stop
  wandering, not to settle arguments to the decimal.

## Quick reference

```
BA(L)        ≈ 34 × 1.036^(L−30)        L20 24 · L30 34 · L41 50 · L50 69
Output/fight ≈ 2.5 × BA(L)              offence % = extra damage per action ÷ BA(L)
HP-per-BA    = 60 × BA(L) ÷ 34          defence % = damage prevented per round, party-wide ÷ HP-per-BA
Budgets      Common 5 · Uncommon 10 · Rare 15 · Legendary 20–25 (+ drawback)   [working values, P7]
Level check  ≤ budget at L20 · ≥ ½ budget at L50   (allows 2× decay)
Encounter    price against the monsters the item meets — house default DEF 12 · MDEF 11
+1 dmg       hit chance ÷ BA(L); Striker vs DEF 12: 3.0 % L20 → 1.3 % L50 (2.2× decay)
+1 acc       ≤ ½ × hit points gained ÷ hit rate (measured ≈ ⅔ of it); ~0 vs low DEF
Rider        on a multi-target action × targets actually hit
+1 DEF/MDEF  monster hit points removed ÷ its hit rate × damage aimed at that defence
Resistance   ½ × damage taken × element share; offensive elements price the same way
Max HP       KO prevention, not damage; weigh against one typical monster hit (P6 open)
Multi N      extra targets × attack damage, full value; mix 20/30/50 → +0.8 (M2) / +1.3 (M3)
Basic swing  ≈ ¼ BA at L41 — riders on it decay ~3× across the band
Species      even spread → 12.5 % uptime per species
1 BA         extra action · denied enemy action · ~60 HP at L30
```
**Never:** calibrate against legacy items · ship a strictly-better item ·
count refinement/orbment inside the budget.
