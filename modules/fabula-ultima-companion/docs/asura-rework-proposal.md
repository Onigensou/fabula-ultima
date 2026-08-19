# Asura — Rework Proposal

**Status: APPROVED + BUILT 2026-08-19. NOT LIVE-TESTED.**
Written and implemented against the live world (`Actor.0AwQ7wEDz4ISA9mA`, game
closed, via safe-edit). §9 records what actually shipped, including three
deviations from this proposal and one bug found during the build.

Everything from §1–§8 below is the reviewed design and was approved as written
(all five §7 questions resolved to the recommended option).

Target: turn the Valley of the Dragon's most direction-less monster into a formal,
tuned member of that dungeon's roster — a solo, partially-unique random encounter
whose stat block only balances *inside* the Lightning Storm.

---

## 1. Where it actually stands today

| | Live value |
|---|---|
| Level / rank / activations | 38 · elite · **2** |
| HP / MP | 420 / 60 (starts 0) |
| DEF / MDEF | 15 / 13 |
| Affinity | **VU light + earth** · RS fire + dark |
| Conditions | IM disarmed + frightened · RS slow + enraged |
| EF | sword/spear/bow/brawling **50** · arcane 125 · dagger/thrown 150 |
| Zenit | 350–450 |
| Items | Elemental Slash (2-tgt, bonus 62) · Elemental Slash: Overflow (All Enemy, bonus 30) · Elemental Slash (Arm) · Quad-Elemental Slash (60 MP) · Sword Enchant ×4 · Elemental Aspect (passive) · Four-Armed Fury (passive) |
| Encounter presence | **Enemies** table row 7; **Encounter** table (`1d23`) **row 19 = "Asura", alone** |

Two things worth stating up front, because they change what this proposal has to do:

- **The "one encounter group, fought alone" decision is already implemented.** Encounter
  row 19 is a solo Asura and nothing else lists it. No roll-table work is required —
  only the confirmation that we are locking it in.
- **Asura is already the folder's only multi-activation monster.** Gigas, Kirin,
  Obsidrax, Prism, Skizzik, Ampere, Mana Ray are all `activation: 1`. Going to 4
  makes that its unmistakable signature rather than a quirk.

### The direction-less diagnosis

The kit reads as three unrelated systems bolted together:

1. an **Aspect** state machine driven by what element last hit it,
2. an **MP clock** driven by self-harm Enchants,
3. a **2-target basic** doing mini-boss single-hit damage.

None of the three feeds the others, and the payoff — Quad-Elemental Slash — was
deliberately built *never to arrive* ("should NEARLY land but not be able to land").
A doomsday clock that by design never strikes noon has no gameplay condition, so the
player has nothing to play against. That is the actual source of the drift.

---

## 2. The Lightning Storm interaction — the headline finding

The brief says the current design "does not make use of it too much." The truth is
the inverse and it is worse: **the Storm currently dominates Asura in three ways, all
of which break it.** In a solo fight the Rod's behaviour is not incidental, it is
deterministic.

**Why it is deterministic here.** The Rod moves to whoever takes creature-dealt
damage, and it strikes at the start of its holder's turn — *once per activation*.
With Asura as the only legal target, every party attack hands the Rod straight back
to it; Asura's own attacks push it onto a PC; sides alternate. So Asura holds the Rod
at the start of roughly **3 of its 4 activations, every round**.

That is **~90 Bolt damage and ~90 MP per round, to Asura, automatically.**

| # | Consequence | Severity |
|---|---|---|
| 1 | **The MP clock is annihilated.** Quad costs 60 MP of a 60 pool. Two Rod strikes fill it. The "nearly but never lands" pacing survives exactly one activation. | breaks the design |
| 2 | **The Aspect machine is hijacked.** `Elemental Aspect`'s four rows fire on `creature_takes_damage` with **no `reaction_cause_filter`**, so the `hazard`-cause Rod strike (Bolt) trips the Bolt row. It is also the *last* damage before Asura acts. Asura is pinned in **Bolt Aspect permanently** and the party's element choice — the monster's whole identity — stops mattering. | breaks the identity |
| 3 | **~270 unpriced damage over a 3-round fight.** At NA bolt the Storm alone removes 64% of Asura's current 420 HP. Its HP was never budgeted for a fourth attacker. | breaks the length |

> **Confidence.** #1 and #3 are arithmetic. #2 is traced, not live-run:
> `apply-damage-core.js` fires `creature_takes_damage` "in the same batch" as the
> crisis/defeated emitters on every HP-write path, `creature_takes_damage` sits in the
> `resource` filter family (so `reaction_cause_filter` applies to it), and Prism's
> Overcharge already sets `reaction_cause_filter: "damage"` for exactly this reason.
> **Confirm with a sim run before building.**

### The fix, and why it is the good kind

Do not suppress the Storm — **split it**, so each half of the Rod pays into a
different part of the kit:

| Rod half | Feeds | Wiring |
|---|---|---|
| **30 Bolt damage** → the *Bolt mark* | the clock, one of four elements handed over free | Mark rows keep `reaction_cause_filter` **blank** |
| **30 Bolt damage** → *not* the Aspect | the party keeps ownership of what element Asura's blades wear | Aspect rows get `reaction_cause_filter: "damage"` |
| **+30 MP** | pays Quad's cost, so the ult arrives ~1 round sooner here than anywhere else | no change — the cost gate does the work |
| **the damage itself** | the party's silent fourth attacker | priced into HP (§5) |

That is a single new field on four existing rows plus one new mark system, and it
makes the fight *measurably different inside this dungeon* — which is precisely what
"formal member of the dungeon roster" should mean.

---

## 3. Locked-in decisions from the brief

| Decision | Value |
|---|---|
| Theme | four arms / four swords / four elements; stack-collecting DPS; doomsday clock with a real gameplay condition |
| Rank | **elite** (unchanged) |
| Stat budget | **champion** (N=4) |
| Activations | **4** |
| Encounter groups | **exactly one — Asura alone**, on the Valley of the Dragon random encounter table |
| Lore | a Demi-God seeking glorious battle and ever-increasing strength |
| Kit | robust — no neighbour to cover its gaps, so it must cover its own |
| New immunity | **IM Fatigue** |

**Fatigue** = *"Allows only single target actions"* (journal `J4fv0XKFy678UIn8`). IM
Fatigue is therefore exactly the right guard for a monster whose whole payoff is AoE.
No engine work needed — `condition_fatigue: "IM"`.

**Rank/activation independence is already proven.** `director-combat.readRank` and
`system.props.activation` are separate reads, and `readActivations` has no cap. Elite
at 4 activations is legal. Two consequences to accept knowingly:

- **auto-defeat stays ON** (elite/soldier only) — correct for a random encounter.
- **battle-end rewards stay ×1.5**, not champion's ×3.0. A 4-activation, ~900 HP solo
  fight that replaces a whole encounter group is under-rewarded by the rank multiplier.
  → **Raise `zenit_reward` by hand** (§5). Flagged as your call.

---

## 4. The rework — one clock, one identity

> **Asura collects elements, not numbers.** Every element that touches it is a mark it
> keeps forever, each mark makes it stronger, and the fourth one unlocks the kill move.
> The Storm gives it Bolt for free.

That single sentence does all the work the current three-systems build fails to do:
it is the stack-collector, the doomsday clock, the "ever-increasing strength" lore, and
the elemental theme — and it gives the party a lever (*don't feed it new elements*)
that is real without being a hard lock, because the Sword Enchants let Asura
self-collect at the cost of an activation.

### 4.1 The clock — Elemental Marks (0 → 4)

A **permanent, never-expiring** mark per element. Four flag AEs (`Mark: Fire` / `Bolt`
/ `Ice` / `Air`, applied `ae_duplicate_mode: "skip"`, each gated
`AE_COUNT_MARK_<X> == 0` so an element can never be collected twice) plus one stacking
`Ascension` counter AE for the `effect_stacks` read.

**Marks are gained when:**
- Asura takes damage of that element from a creature — *the party's own attacks arm it*;
- the **Lightning Rod strikes** it (Bolt) — cause filter blank, so the hazard counts;
- a **Sword Enchant** cuts it with that element — its self-collection route.

**Each mark grants +8 damage** on every attack, permanently. Asura visibly gets
stronger every round; that escalation *is* the lore.

**At 4 marks it is Ascended**, and Quad-Elemental Slash unlocks.

### 4.2 The gameplay condition — and how it is actually gated

`action_pattern_table` rows carry exactly **one** condition each, so the AND is built
out of three different mechanisms on a single row:

| Gate | Mechanism | Who controls it |
|---|---|---|
| four elements collected | `action_pattern_condition: effect_stacks`, string `Ascension`, min 4 | **the party** (which elements they use) + the Storm (Bolt, free) |
| 60 MP banked | the item's `cost: "60 MP"` — the action reader's feasibility check skips the row when unaffordable | **the Storm** (+30/strike) and the Enchants (+15 each) |
| once per round, as the finisher | `action_pattern_cooldown: 3` (turns, so at most one firing per 4 activations) | pacing |

Priority ≥3 above every other row so it is exclusive when live.

> Consider `action_pattern_condition: "activation"` with `4-4` instead of the cooldown
> if you want the ult **guaranteed to land on the last activation of the round** — the
> official *Devastation* rule, and it gives the party a full round of visible warning.
> Cost: it can then no longer AND with `effect_stacks`, so the mark gate would have to
> move onto the item as a self-targeting no-op reaction. **Recommendation: cooldown 3.**
> Flagged as your call.

### 4.3 Kit

| Skill | Type | Target | Base bonus | avg / target | per activation |
|---|---|---|---|---|---|
| **Elemental Slash** | Attack | **One Creature** *(was: two)* | **32** (+8/mark, +10 aspect) | 39 → 71 | 39 → 71 |
| **Elemental Slash: Overflow** | Attack, 30 MP *(was: free)* | All Enemy | **20** (+8/mark) | ~27 → ~51 | ~108 → ~204 |
| **Quad-Elemental Slash** | Active, 60 MP | **All Enemy ×4 beats** *(was: 4 single-target arms)* | ~8/beat | ~60 (all four beats) | **~240** |
| **Sword Enchant** ×4 | Active | Self | — | 10 self-damage · buff · **+15 MP** · **+1 mark** | — |
| **Elemental Aspect** | Passive | — | retypes Slash, +10, adds the element's rider | | |
| **Four-Armed Fury** | Passive | — | "acts four times each round, enters every conflict with no MP" | | |

HR avg 7.15 (DEX d10 + MIG d10). Damage figures are averages before hit rate.

**Three changes carry the weight, and all three follow from the activation count:**

1. **Elemental Slash goes single-target.** A 2-target basic at 4 activations is *eight*
   target-hits per round. That is the number that turns this monster into a round-1
   TPK — at the live bonus 62 it would be ~632 damage per round against a 471 HP party.
   Breadth now belongs to Overflow and Quad, where it can be gated.
2. **Overflow costs 30 MP.** Free All-Enemy at 4 activations is up to 4 casts/round.
   The MP cost paces it and gives the Rod's MP grant a second job.
3. **Quad becomes All-Enemy ×4 elemental beats** instead of four single-target arms.
   This closes the open issue in `project_asura_monster` ("all four into one PC = 316,
   a delete"): the arms can no longer stack onto one victim, targeting needs no
   enforcement, and **every PC eats all four elements**, so whoever is VU to one of them
   pays double on that beat. It is more devastating *and* more thematic — four blades
   sweeping the field — while being deterministic and safe to tune.

`Elemental Slash (Arm)` becomes dead and should be deleted with Quad's rewrite.

### 4.4 The 4-activation rotation

Four activations only avoid reading as four identical swings if they are choreographed.
Proposed shape — *sharpen, strike, strike, execute*:

| Slot | Intent | Row |
|---|---|---|
| 1 | **Sharpen** — Sword Enchant (self-cut → mark, buff, +15 MP) | gated `self_lacks_status: "Whetted"`; the Enchant applies `Whetted` for one round so **at most one Enchant per round** |
| 2–3 | **Pressure** — Elemental Slash, or Overflow if Fire Aspect and 30 MP | `always` @ low priority |
| 4 | **Execute** — Quad if Ascended, else Elemental Slash | the gates in §4.2 |

The `Whetted` lock matters: without it, four Enchant rows can each fire on a different
activation and Asura self-collects all four marks in round 1 for zero party input. One
per round means self-collection alone takes four rounds, so the party's element choices
and the Storm's free Bolt are what actually set the pace.

### 4.5 Robustness — what it already has, and what to add

The brief asks for a kit that stands alone. Two of the three legs are already there:

- ✅ **Off-element answer.** Elemental Slash is base Physical and only retypes when an
  Aspect is live, so an all-RS-elemental party does not shut it down. This is the exact
  failure that cost Kirin a redesign — Asura is already immune to it. **Keep it.**
- ✅ **Self-sufficiency.** The Sword Enchants let it manufacture its own Aspect and its
  own marks with no party cooperation.
- ➕ **Missing: a Crisis identity.** A demi-god *seeking glorious battle* should get
  better as it dies. The marks already escalate it, but nothing fires at Crisis.
  **Recommendation:** at Crisis, Elemental Slash regains its second target. One
  `creature_enter_crisis` row, and it lands exactly where the fight needs a spike.

  *(A `bonus_activation` bump at Crisis is tempting — the prop exists, is documented as
  an accumulator and is re-read at the next round boundary. But no effect kind writes
  arbitrary actor props, so it would need a build spike. **Not recommended for v1.**)*

---

## 5. Numbers

### 5.1 Assumptions, stated because they are the weak link

| Constant | Value used | Confidence |
|---|---|---|
| Party | **L41**, pool **471** (Hina 98/DEF 8 · Zarg 111/14 · Keren 96/15 · Blanche 166/19) | **live-read today** ✓ |
| `BaselineDPR` | **110** (est.) | ⚠ the doc's 90 is L30-era; Migration step 1 is still not done |
| `RD` | **1.25** | Acceleration counts; **Barrage does not** — Multi(+1) adds a *distinct* target and is worth nothing solo |
| `M(PE 17%)` | 1.50 | default design point |
| `EffectiveDPR` | **206** | 110 × 1.25 × 1.50 |
| `Spread(1)` | 1.00 | solo — the party's entire AoE kit is dead weight here |
| Hit rate | 0.70 | |

> ⚠ **`BaselineDPR = 110` is an estimate, not a measurement.** Every HP number below
> inherits it. If you want these numbers to be trustworthy rather than directionally
> right, the cheapest fix is one sim-harness run before building.

### 5.2 HP — and the dungeon dependency

Target **3.0 rounds** (12 Asura activations). Not the 5.5–6 boss band: this is an elite
on a *random encounter* table, and a six-round solo grind on a random roll is a bad
experience regardless of how good the monster is.

```
base        3.0 TP × 206 EffDPR                   = 618
+ Storm     ~3 Rod strikes/round × 30 Bolt × 3 r   = 270   (negative regen → raises printed HP)
+ Enchants  10 self-damage × 1/round × 3 r         =  30
                                                    -----
                                                    ~918  →  HP 900
```

> ### ⚠ This stat block only balances inside the Lightning Storm.
> The Storm is 30% of Asura's effective HP. **Without the Conflict Event selected on
> the scene, 900 HP is a 4.4-round grind.** The lightning-storm doc records that
> *"no arena scene exists yet"* for Valley of the Dragon.
>
> **This is a hard build dependency, and I am proposing we embrace it rather than
> design around it** — it is the strongest possible reading of "formal member of the
> dungeon roster." But it must be written on the monster, and the Valley arena scene
> must carry the event before Asura is ever rolled.
>
> If you would rather Asura be portable, size it at **780** and accept ~2.5 rounds
> with the Storm (which risks Quad never landing — the exact failure we are fixing).

For reference in-folder: Gigas 800 HP @ 1 activation (the anti-synergy wall), Kirin 210
@ 1. Asura at 900 @ 4 activations is a clearly different weight class, which is what
champion budget buys.

### 5.3 Damage and Pressure

Nominal per round, before hit rate:

| Round | Marks | Actions | Damage |
|---|---|---|---|
| 1 | 0 → 1 (Storm gives Bolt) | Enchant + 3 Slash @ ~45 | ~135 |
| 2 | 1 → 3 | 3 Slash @ ~58 (1 may be Overflow) | ~175 |
| 3 | 3 → 4, Ascended | 2 Slash @ ~66 + **Quad ~240** | ~370 |
| | | **total nominal** | **~680** |
| | | **× 0.70 hit rate** | **~477** |

```
Pressure = 477 / 471 = ~1.01
```

> ### ⚠ This is a deliberate departure from the published 0.40–0.60 band.
> Two reasons, and you should push back if you disagree:
> 1. **The published band does not describe the built roster.** Kirin alone runs
>    ~0.85 as one of two or three monsters in an encounter. The band is
>    explicitly unvalidated in `monster-balance-design.md`; the roster is playtested.
> 2. **A solo enemy is the most survivable damage profile per point of damage.** There
>    is no swarm to snowball, the party has full healing uptime with nothing else to
>    kill, and Blanche's Protect eats single-target attacks at DEF 19.
>
> Pressure ~1.0 means **the party must heal and must win the race.** That is the
> intended experience of a unique demi-god. It is also close enough to a TPK that it
> should not go live on my arithmetic alone — **run it through the sim harness first.**

### 5.4 Affinity, EF, conditions

| Field | Now | Proposed | Why |
|---|---|---|---|
| bolt | NA | **NA — keep** | Deliberate. The Storm's 30/strike is the party's silent fourth attacker and is priced into the 900. RS would halve the dungeon interaction we are building the monster around. |
| light / earth | VU + VU | **keep both** | Two VUs breaks the 1-VU rule, but solo the "no party member shut out" concern is *stronger*, not weaker — Asura is the only target for the whole fight. Both sit outside the fire/bolt/ice/air mark set, so the right answers can never feed the clock. |
| fire / dark | RS + RS | **keep** | Two RS, compliant. |
| **sword / spear / bow / brawling** | **all 50** | **sword 50 · bow 150 · rest 100** | ⚠ **The current EF table is the clearest outright bug.** Four categories at 50% means Zarg (bow) *and* Blanche (brawling) fight at half output for an entire solo fight with no other target to switch to. Restores the house pattern (one at 150–200, one at 50–75, rest 100), and "a four-sword demon shrugs off swords" reads. |
| arcane | 125 | **100** | EF is inert for spells (`damage-ruleset.js` L150) — `arcane_ef` only touches staff/tome/wand *weapon attacks*. The 125 is decoration. |
| dagger / thrown | 150 | **100** | Keren rarely swings a dagger; the reward lands on nobody. |
| `condition_fatigue` | NA | **IM** | Per brief. Fatigue = "allows only single target actions" — the direct counter to the whole kit. |
| `activation` | 2 | **4** | |
| `max_hp` / `current_hp` | 420 | **900** | |
| `zenit_reward` | 350–450 | **700–900** | Elite rank pays ×1.5, not champion's ×3.0. Replaces a whole encounter group. |
| `unique` / `isBoss` | false / false | **unverified — leaving alone** | "Partially unique" is a design statement; I have not traced what these two flags actually drive. Worth a check before we touch them. |

---

## 6. Change summary

**Keep** — the Aspect state machine and its four riders · Sword Enchant ×4 and the
self-harm identity · Physical-by-default Slash · IM disarmed/frightened, RS slow/enraged ·
VU light + earth, RS fire + dark · sprite/portrait/token scale 2.25 · Encounter row 19.

**Change**
1. `activation` 2 → **4**; Four-Armed Fury's text follows.
2. HP 420 → **900**; zenit → **700–900**.
3. `condition_fatigue` → **IM**.
4. EF table → **bow 150 · sword 50 · rest 100**.
5. Elemental Slash → **single target**, bonus 62 → **32**.
6. Overflow → **30 MP**, bonus 30 → **20**.
7. Quad → **All Enemy × 4 elemental beats** (~60/PC total); delete `Elemental Slash (Arm)`.
8. **`reaction_cause_filter: "damage"` on Elemental Aspect's four Aspect rows** — stops the Rod pinning Bolt Aspect.
9. Rebuild `action_pattern_table` to the four-slot rotation.

**Add**
10. **Elemental Marks** — four skip-mode flag AEs + an `Ascension` stacking counter; +8 damage per mark; mark rows keep a blank cause filter so the Rod feeds them.
11. **`Whetted`** — one-round self-AE locking Sword Enchants to one per round.
12. **Crisis effect** — Elemental Slash regains a second target at Crisis.
13. Study text rewrite: demi-god lore, and the Storm-feeds-it tell (per the hazard doc's "the Rod feeds whoever holds it" requirement).

---

## 7. Open questions for you

1. **The dungeon dependency (§5.2).** Lock Asura to the Storm at 900 HP, or keep it
   portable at 780 and accept ~2.5 rounds? *I recommend 900 + locking it.*
2. **Pressure ~1.0 (§5.3).** Deliberate departure from the published band. Accept, or
   pull damage back toward ~0.75?
3. **Quad's slot (§4.2).** `cooldown 3` (flexible, ANDs with the mark gate) or
   `activation 4-4` (guaranteed round-ending telegraph, needs the mark gate rehomed)?
   *I recommend cooldown 3.*
4. **Zenit 700–900**, or leave the elite ×1.5 to under-reward it?
5. `unique` / `isBoss` flags — worth tracing what they drive, or leave as-is?

## 8. Risks before build

- **`BaselineDPR = 110` is estimated.** One sim run would replace the weakest number
  in this document.
- **Finding #2 (Aspect hijack) is traced, not observed.** Confirm the Rod strike fires
  `creature_takes_damage` before relying on the cause-filter fix.
- **Pressure ~1.0 is close to a TPK.** Sim before live, not after.
- **No Valley of the Dragon arena scene exists**, so the Storm cannot yet be selected —
  which is also the only environment this stat block is valid in.
- **Every skill item needs its sheet-list mirror re-synced** (`attack_list`,
  `skill_active_list`, `skill_passive_list` hold their own copy of the description),
  and Asura's token/world actor must both be written.

---

## 9. As built (2026-08-19)

All five §7 questions were resolved to the recommended option: **900 HP + locked
to the Storm · Pressure ~1.0 accepted · Quad on `cooldown 3` · zenit 700–900 ·
`unique`/`isBoss` left alone.**

### 9.1 A bug found during the build — the Aspects were evaporating

Not in the original diagnosis, and it was live in the 2-activation build too.

The four Aspect AEs carried `charges: 1` with **no `lifetimeMode`**, and Asura
applies them to itself. `tickDirectorAEsForApplier` (skill-effects.js) decrements
every default-mode charge counter at the start of the applier's next turn, and
`UNTICKED_LIFETIME_MODES` is `{round_end, on_activation, persistent_counter}` —
none of which applied. So each Aspect ticked 1 → 0 and was **deleted at Asura's
very next activation**, before the retyped Elemental Slash it exists to power.

At 4 activations this would have made the Aspect system almost entirely inert.
**Fixed:** all four Aspect AEs now carry `lifetimeMode: "persistent_counter"`,
as do the five new clock AEs. The Aspect now persists until another element
replaces it, which is what the design always said it did.

### 9.2 Three deviations from the proposal

1. **`Elemental Slash (Arm)` was repurposed, not deleted** → renamed
   **`Elemental Slash (Sweep)`**, `All Enemy`, `damage_bonus 8`. Quad's beats need
   *some* component item to point `action_ref` at, and reusing this one keeps the
   item id stable and avoids a delete-plus-create round trip through the embedded-AE
   two-pass trap. It stays off `attack_list`, so it is invisible on the sheet.
2. **Quad's status riders were dropped.** The proposal kept Paralyzed / Disarmed /
   Silence from the old four-arm version. With the beats now All-Enemy that is three
   lockout statuses on all four PCs in a single action, on top of ~240 damage — the
   party would have no legal turn afterwards. The riders remain on **Elemental
   Slash**, where they are single-target and Aspect-driven, which is where they were
   always the interesting part.
3. **The Crisis effect is +20 flat damage, not a second target.** §4.5 proposed
   "regains a second target"; that needs a target-count mutation on a reaction,
   which the proposal itself flagged as the higher-risk path. Shipped instead as an
   `adjust_damage` +20 on Elemental Slash and Overflow, gated `AE_COUNT_CRISIS > 0`,
   hosted on **Four-Armed Fury**. Same intent, no new engine surface.

Also, unlisted in the proposal: **`init` 11 → 13** (champion +4 rather than
elite +2), for consistency with the champion budget.

### 9.3 Corrected number

**Pressure is ~1.10, not the ~1.01 in §5.3.** The round-by-round walk there
under-counted the Aspect's existing +10 on Elemental Slash. Still inside the
deliberate departure §5.3 argues for, but it is the top of that range, not the
middle — which makes the sim run in §9.5 more load-bearing, not less.

### 9.4 What changed on disk

Snapshot before the first write:
`tools/safe-edit/backups/20260819-145224-fabula-ultima-2-actors`.

| | |
|---|---|
| Actor props | `activation` 4 · HP 900 · `init` 13 · `condition_fatigue` IM · EF bow 150 / sword 50 / rest 100 · zenit 700–900 · new `study_text` |
| Rewritten tables | `action_pattern_table` 12 → **7** rows · Quad `effect_table` 8 → **5** rows · all three sheet mirrors rebuilt from the live items |
| Item edits | Elemental Slash → One Creature, bonus 32 · Overflow → 30 MP, bonus 20 · Arm → **Sweep**, All Enemy, bonus 8 |
| New item | **`Ascension`** `Item.0bN7A6pXFG2cX2q9` — 6 reaction rows, 10 effect rows, 5 embedded AEs |
| New AEs | Fire / Bolt / Ice / Air **Mark** + **Ascension** counter (all `persistent_counter`) · **Whetted** on each of the four Enchants (`round_end`) |
| Fixed | four Aspect AEs → `persistent_counter` (§9.1) · four Aspect rows → `reaction_cause_filter: "damage"` |
| Enchants | each chain gained an `apply_ae Whetted` step |
| Four-Armed Fury | 2 Crisis reaction rows + 1 `adjust_damage` row |

Tables were written by full `db.put` replacement, never `safe-edit patch` — a
merge-patch cannot delete rows and would have left the old 12-row pattern table
and Quad's three rider rows as live stale rows.

### 9.5 Verification done — and what is still missing

Done:
- **51/51 formula assertions green**, through `evaluateFormula(expr, resolver)`
  (not the bare resolver, which passes vacuously). Includes an explicit
  non-vacuity probe, the full 4×4 element × mark-row exclusivity matrix, the
  self-closing check (a held mark shuts its own row), the storm hook
  (`element: bolt` → Bolt row fires), and cross-contamination both ways between
  Marks and Aspects.
- **Reference integrity audit clean** — every `reaction_effect_ref`,
  `chain_steps`, `on_activate_effect_ref`, `ae_template_ref`, `action_ref`,
  `reaction_source_skill`, action-pattern skill name and sheet-mirror id resolves;
  every item is on exactly one sheet list except the Sweep component.
- **Preflight**: zero Asura findings. The one FAIL is the known post-session
  scene-bless drift, unrelated.
- **world-export**: `added 0 / removed 0 / modified 2` — the MANIFEST and Asura's
  actor. Nothing else in the world was touched.
- **Embedded AEs survive the authored export** (5 on Ascension, 1 on each
  Enchant, 4 on Elemental Aspect) — the cheap tell for the inline-AE trap.
- No placed Asura tokens exist, so the world actor is the only copy and there is
  no token mirror to re-sync.

**Still missing, in priority order:**
1. **No live or sim battle.** Nothing here has resolved a real action. The
   Aspect-hijack fix (§2 #2) is still *traced*, not observed.
2. **`BaselineDPR = 110` is still an estimate**, so 900 HP inherits that error.
3. **No Valley of the Dragon arena scene exists**, so the Lightning Storm conflict
   event cannot yet be selected — and this stat block is only valid with it on.
4. Two build-time assumptions worth watching in the first run: that a `free_action`
   whose `action_ref` is an `All Enemy` item targets the whole party (rather than
   collapsing to one), and that the Rod's ~3-strikes-per-round estimate holds.
5. Loot / steal tables and action animations, deferred as usual.

---

Related: [monster-balance-design.md](monster-balance-design.md) ·
[lightning-storm-design.md](lightning-storm-design.md) ·
[reaction-config-schema.md](reaction-config-schema.md) ·
`project_asura_monster` · `project_lightning_surge_dungeon` ·
`reference_monster_actor_setup` · `project_fight_balance_playbook` ·
`project_multiparty_randomized_runs`
