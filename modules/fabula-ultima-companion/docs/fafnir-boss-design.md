# ⭐️ Fafnir — Boss Design Notes

**Status:** Two-phase AI + Cruel Ultimatum fix **IMPLEMENTED and LIVE-TESTED 2026-09-20.**
**Actor:** `P1uCkpNnxLRBNqZr` — L50, `npc_rank: champion`, folder `Monster / Current Dungeon`.
**Build scripts:** `tools/safe-edit/bin/_fafnir-ai-aes.js` (the AE — run FIRST), then
`tools/safe-edit/bin/_fafnir-ai.js`.
**Companion doc:** `fafnir-boss-checkup.md` — the balance audit this work came out of.

Not to be confused with ⭐️ **Hilde-Fafnir** (`2SFrEMqLBfqzc7Nj`, L55, Fafnir Castle final
boss — her own doc) or ⭐️ **Bandit Fafnir** (`oVZvfkkXMdxmB3T9`, a scripted joke actor).

---

## 1. Concept — the storm that has to breathe

Fafnir is a **two-phase** boss, and the phases are driven by her own MP rather than by
an HP threshold or a script.

**Aggressive phase.** She attacks with everything. At 4 turns a round she generates more
pressure than anything else in her tier, spending MP freely on Ruinous Breath and her
debuff kit.

**Recovery phase.** When her magic runs dry she **breaks off**: summons her elemental
drakes to hold the line and spends her turns on Storm Calm recovering MP. She is not
attacking during this. It is the window the party is meant to play around — heal, revive,
reposition, or burn her down before she comes back.

When she has recovered enough power, she resumes the aggressive phase.

**Storm Calm and Summon Elemental Drake are recovery-phase actions only.** She never
spends an aggressive turn on either.

---

## 2. Stats (unchanged by this pass)

| Stat | Value |
|---|---|
| HP / MP | 1824 / 400 |
| DEF / MDEF | 16 / 17 |
| Attributes | DEX / INS / MIG / WLP all **d12** |
| Init | 14 |
| **Turns / round** | **4** (`activation: 4`) — the champion standard |
| Max Zero / Ultima | 6 / 10 |
| Affinities | VU light · RS air, bolt, fire · IM dark, earth |
| Weapon EF | spear 200 · dagger 50, thrown 50 |

> The checkup flags the affinity/EF profile (2 IM, 3 RS, and IM dark stacking with dagger
> 50% to zero out a dark-dagger user) and Condemn's damage as open questions. **Neither
> was changed in this pass** — they are still on the table.

---

## 3. The phase latch — how "phase" is actually expressed

This is the load-bearing mechanism, and the obvious implementations do not work.

**A phase is a STATE, not a threshold.** The first design gated Storm Calm on an `mp 0-24`
pattern condition. Simulated over 500 fights that produced *flickering*, not a phase: each
Storm Calm immediately pushes her back over the line, so she alternates attack / calm /
attack / calm. Only 9–14% of rounds read as recovery and **not one was clean**.

**A timer does not work either.** Every turn-ticked AE lifetime counts applier or bearer
*turns*, and `tickDirectorAEsForApplier` runs at every TURN_START with **no activation
gate** — so on a 4-activation champion a 2-charge marker is gone in half a round.
`round_end` is worse: it is swept at the end of the round it was applied in, which is a
partial round.

**What works: a latched marker with hysteresis.**

| | |
|---|---|
| **AE** | **Storm Gathering** (`StormGather01AE0`, in the shared Debuff container `XVOWOq9oUmEECGrU`) |
| Lifetime | `persistent_counter` — **never turn-ticked**, so it is immune to the activation-count problem entirely |
| Visibility | **viewable** — this is a tell. The party is meant to see she has gone defensive. |
| Dispel | `persistent_counter` AEs are skipped by tag sweeps unless a row opts in with `include_persistent`, so the party cannot Cleanse her out of her own phase |
| **Enters** | MP drops **below 100** — the moment she can no longer pay for Ruinous Breath |
| **Leaves** | MP reaches **300** — three casts banked |

Both edges are reaction rows on a new passive, **Storm Gathering** (`StormGatherPsv01`):

| Trigger | Filter | Condition | Effect |
|---|---|---|---|
| `creature_lose_resource` | `mp`, source self, force | `CUR_MP < 100` | `apply_ae` Storm Gathering → self (`skip` on duplicate) |
| `creature_gain_resource` | `mp`, source self, force | `CUR_MP >= 300` | `remove_ae` Storm Gathering → self (`include_persistent: true`) |

The **gap between 100 and 300 is the phase**. A single threshold has no gap and therefore
flickers; the gap is what makes recovery last long enough to read at the table.
It is also **independent of her activation count** — change `activation` later and the
phase still behaves.

⚠ `include_persistent: true` on the exit row is **required**, not decorative:
`selectAEsOnActor` skips `persistent_counter` AEs without it, so the phase would latch on
and never release.

---

## 4. The action pattern table

She had **none**. `enemy-autopilot.js` returns null with no pattern (`"no pattern /
nothing feasible → manual"`), so until now the GM hand-drove all four of her turns every
round.

| # | Action | Condition | v1 / v2 | Prio | CD |
|---|---|---|---|---|---|
| 0 | Zero Power: Cruel Ultimatum | `zero_power` | 100 / 100 | **20** | 0 |
| 1 | Summon Elemental Drake | `self_has_status` "Storm Gathering" | | **10** | 4 |
| 2 | Storm Calm | `self_has_status` "Storm Gathering" | | **9** | 0 |
| 3 | **Ruinous Breath** | `round` | **1 / 2** | **7** | **1** |
| 4 | Condemn | `always` | | 5 | 0 |
| 5 | Rend | `always` | | 5 | 0 |
| 6 | Torment | `always` | | 5 | 3 |
| 7 | Searing Brand | `always` | | 5 | 2 |
| 8 | Draconic Domination | `always` | | 5 | 2 |

**The priorities are the design.** The picker keeps only candidates within **2** of the
top passing priority (weights 3 / 2 / 1) and drops the rest:

- **10 / 9 sit ≥3 above the fillers.** While Storm Gathering is up, the window is 8–10 and
  nothing but Summon and Storm Calm is reachable — that is what makes recovery *exclusive*
  rather than a preference.
- **Ruinous Breath at 7 with the fillers at 5** keeps them inside its window (gap 2), which
  is the *only* reason its cooldown functions. **A cooldown on a row that is alone in its
  window does nothing** — the all-blocked fallback restores the unadjusted weights and it
  fires every round (measured on Kirin's Rail Stream, 6 rounds out of 6). Priority 8 would
  have silently broken the gate.
- `round 1 / 2` is A + B·X → **rounds 1, 3, 5, …**; `cooldown 1` caps it at **one cast per
  round**, which is what stops four casts and 400 MP disappearing in round one.
- Affordability is filtered **before** the window, so "if she can pay for it" needs no
  condition of its own.

### Measured behaviour — LIVE (Training Ground, real combat, 2026-09-20)

Eight rounds, four activations each, memory persisted across rounds:

```
R1 breath=1 :: Rend, Ruinous Breath, Rend, Searing Brand
R2 breath=0 :: Condemn, Torment, Rend, Condemn
R3 breath=1 :: Rend, Rend, Ruinous Breath, Condemn
R4 breath=0 :: Searing Brand, Rend, Draconic Domination, Rend
R5 breath=1 :: Ruinous Breath, Torment, Condemn, Rend
R6 breath=0 :: Condemn, Rend, Draconic Domination, Searing Brand
R7 breath=1 :: Rend, Ruinous Breath, Rend, Condemn
R8 breath=0 :: Draconic Domination, Torment, Searing Brand, Condemn
```

**Rounds 1/3/5/7, exactly once each, never twice, never on an even round.**
Recovery phase, 12 consecutive picks with Storm Gathering up: **Summon Elemental Drake
once (cd 4), then Storm Calm every remaining turn** — nothing else reachable.

⚠ This only works because of the engine fix below. **Ruinous Breath’s cooldown was
inert before it** (measured 6/20 picks with the memory seeded vs 7/20 with none), so she
could and did fire it twice in one round.

### Offline prediction (replica of the picker, 500 ten-round fights)

| | |
|---|---|
| Ruinous Breath fires on | **81% of odd rounds** |
| Rounds with more than one cast | **0** |
| Recovery phases per fight | **2.6**, ~1.3 rounds each |
| 4-round Pressure | **2.28** (was 3.45 ungated) |
| Pools per round | **~0.58** |

Hilde-Fafnir at the same 4 activations reads **3.83**, so Fafnir stays correctly under the
final boss.

Lower than the raw arithmetic predicts, for a reason worth recording: **three of the five
fillers — Torment, Searing Brand and Draconic Domination — deal no direct damage.** Once
the AI spreads her turns across the whole kit instead of always reaching for the biggest
number, she trades raw damage for status pressure.

---


## 4b. Engine fix this depended on — `action_pattern_cooldown` was dead

Found while live-testing this kit, 2026-09-20. **Every authored cooldown in the world was
inert** — 29 rows across 14 actors, none of which had ever fired.

`applyAntiRepeat` read the cooldown off `getCandidateProps(candidate)` — the **item's**
`system.props` — but `action_pattern_cooldown` is a **pattern-row** column. The lookup
always returned `undefined`, so `toInteger(..., 0)` gave cooldown 0 and the hard-block
branch never ran. `readActionReaderPatternTable` did not normalise the column either.

Fix: normalise `cooldown` on the row (beside `priority` / `hpReserve` / `hpCeiling`) and
read `candidate.row.cooldown` in the anti-repeat pass.

**Blast radius — 24 of the 29 rows now enforce**, across Asura, Living Shadow, O'lmek,
O'zealot, Rakshasa, Fafnir, Geist, Hilde-Fafnir and Wandering Flame. The other 5 are
priority-EXCLUSIVE rows, where the pre-existing "all blocked, ignore cooldown this turn"
fallback still un-blocks them; that older trap is unchanged and still real.

Every change is in the same direction — **a repeated move becomes a paced one** — so
pressure goes DOWN, never up. Two consequences worth chasing:

- **Asura is the balance model's calibration anchor**, and it was live-tested with both of
  its cooldowns inert. Quad-Elemental Slash (cd 3) and Overflow (cd 2) are now rate-limited,
  so that datapoint is slightly optimistic about Asura's output.
- **Hilde-Fafnir's §8c figures** were measured with Wyrmbreath's cd 1 inert (her doc records
  an 11/20 and 15/20 Wyrmbreath share). Her real Wyrmbreath rate — and therefore her
  Pressure — is now lower than published.

## 5. Summon Elemental Drake — capped

`summon_max: "2"` on the summon row. The handler counts the caster's own live summons of
that kind and refuses past the cap, so **she cannot stack a second pair while the first is
alive**. 2 = one Flame Drake + one Lightning Drake.

⚠ The cap is a shared generic pool, not per-actor (phantasms and Numen have their own
kinds; a plain row counts own summons that are neither). So if **one** drake dies she will
top the pair back up on her next recovery phase rather than refusing outright.

⚠ **Lightning Drake's *Amplify Bolt* is "boost all ally Bolt damage by 30" — and Ruinous
Breath is Bolt.** Summoning buffs her own signature move. Left as-is; noted so it is not
rediscovered as a bug.

---

## 6. Zero Power: Cruel Ultimatum — rebuilt

> Offer the enemy a vile edict. The enemy chooses: one target enemy takes 300 Fire damage
> (their choice who), or all enemies take 120 Bolt damage.
> **This damage ignores immunities and absorption.**

**The first diagnosis of this skill was wrong in both halves**, and the record matters
because the "fix" made things worse before `runReactionLint` caught it:

- *"Option B costs nothing"* — **false.** `system.props.cost = "6 Zero Power"` is the
  LEGACY cost path: the action-card pipeline parses that string and debits at CONFIRM,
  before the menu branches. B was always charged.
- *"Option B's target list never resolves"* — **false.** `target_ref` does not require the
  row to be chained. `resolveTargetRef` falls through to `findTargetingRow`, which looks a
  `targeting` row up by its `effect_label` anywhere in `effect_table`.

**The actual bug was the opposite.** Option A carried its own `consume_resource` row ON TOP
of the cost field, so picking A debited **12** Zero Power, not 6. The first rebuild hoisted
that row into the main chain, which spread the double-charge to BOTH branches — flagged by
the linter as `COST_DOUBLE_CHARGE`.

Correct shape, per `skill-authoring-canon.md` branch 1 ("Cost rule — one source of truth,
never two"): keep the **legacy path**. `cost` stays, there is **no `consume_resource` row
anywhere reachable from `on_activate_effect_ref`**, and both branches are charged exactly
6 once, at CONFIRM. `on_activate_effect_ref` points straight at `cu_choice`.

**Both damage rows now carry `damage_keywords: "ignore_absorption"`.** A Zero Power should
not be a free pass. The clamp collapses **RS, IM and AB to NE**; **VU is untouched** (a
bypass strips defence, it must not cancel a vulnerability) and **shields are untouched**.

> ⚠ **The ladder is cumulative — there is no "immunity + absorption but keep resistance"
> rank.** `ignore_absorption` necessarily also collapses resistance. Accepted by the
> designer 2026-09-20; it is the only rank that closes the absorb hole.

What that changes against the current L41 party (471 pool):

| Branch | Before | After |
|---|---|---|
| A — 300 Fire on one | **0** onto the fire-absorber, 150 onto anyone else | **300** onto anyone |
| B — 120 Bolt to all | 540 | **600** |

Option A used to be a literal zero because the party simply pointed it at their fire
absorber. It now kills whoever is chosen outright (300 vs a 166 max bar).

> **Open:** the checkup proposes **option B 120 → 60** so the edict becomes a real dilemma
> ("one of us dies" vs "all of us are gutted") rather than "A, obviously". Not applied.

---

## 7. CSB dropdown refresh

Fafnir's stamped sheet body predated `self_has_status` — her `action_pattern_condition`
select listed 17 options against the live template's 25, and `action_pattern_target_focus`
5 against 10.

**Left alone, a sheet re-stamp would have silently reset the two phase rows to the
fallback** (the Dryad regression). Both option arrays were copied from the live template
`yegF6R8aaymhrvCg` **surgically, by path** — deliberately *not* via `reloadTemplate()`,
which **prunes every prop the template does not declare** (it stripped 60 props off
Hilde-Fafnir when it was called as a probe).

Verified after the write: **207 props before, 207 after; zero removed keys** at a
key-level flatten of the export against HEAD.

⚠ `system.body` is **not** part of `_authored-export`, so this change is invisible in the
export report. It lives in the LevelDB and travels with the whole-world push.

---

## 8. Verification — 2026-09-20 (live client)

| Check | Result |
|---|---|
| Ruinous Breath cadence, 8 rounds x 4 activations | **R1/3/5/7 exactly once each; R2/4/6/8 zero** |
| Cooldown blocks a second cast in the same round | 0/24 picks after a seeded use (was 6/24 before the engine fix) |
| Cooldown releases two rounds later | round 5 after a round-3 use: available again |
| Recovery window is exclusive | 12 consecutive picks: Summon once, then Storm Calm only |
| `summon_max` | Summon fires once, then blocked while the pair is alive |
| Storm Gathering AE | `persistent_counter`, viewable, never turn-ticked |
| `runReactionLint` on Fafnir | 0 issues from this work (4 pre-existing, listed below) |
| `runTemplateEngineEnums` on Fafnir | 0 issues |
| Cruel Ultimatum double-charge | `COST_DOUBLE_CHARGE` cleared (world total 315 -> 314) |
| Co-dev content after the replay | King Gorger / Field / _Field Template / Field Effects all intact |

**Pre-existing lint on Fafnir, NOT from this work and NOT fixed:**
`OFFENSIVE_SPELL_NO_CHECK` on Ruinous Breath (by design — it is a locked auto-hit move),
`REACTION_FLAG_MISSING` on Searing Brand, and `TARGET_REF_MISSING` on Condemn and Torment
(both `redirect_target` rows want a `target_ref`).

## 9. Not yet done

- **No full battle.** The picker, the cooldown, the recovery window and the AE were all
  exercised against a real combat on Training Ground, but no turn was actually RESOLVED —
  the phase latch firing off the live resource ledger (`creature_lose_resource` /
  `creature_gain_resource` at `CUR_MP` 100 / 300) is still verified by construction, not by
  watching her spend MP in anger.
- **`skill-regression` not re-run** — it needs the game open and the co-dev's commit moved
  `goldens/skills.json`.
- **Open from the checkup, unchanged:** Condemn at HR+100 (one-shots healthy PCs), the two
  IM affinities, dagger EF 50, Cruel Ultimatum option B's number, and Zero Trigger:
  Suffering granting on *any* turn start (up to 8 ZP/round at 4 activations).
- **Deployment question:** Fafnir sits on `Eisendrache Burning - Enemies` at `1d4` range
  [4,4] — a 25% random roll in an early-game area, alongside three L13-15 soldiers. The
  tease and the L50 boss are the same actor, so these numbers serve both.
