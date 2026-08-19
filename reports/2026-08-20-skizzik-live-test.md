# Skizzik rework — live test report

**Date:** 2026-08-20 · **World:** fabula-ultima-2 · **Harness:** Automated Playtest Sim
**Encounter:** Valley of the Dragon row 6 — `Skizzik ×2`, conflict event `lightning-storm`
**Build under test:** `docs/skizzik-rework-proposal.md` §10 (HP 130 · Thunder Strike 30 ·
Overload Riposte · Static Buildup · storm-fed Chain Reaction)

**Verdict: all 3 new mechanics fire. The counter works but is RARE and mis-targets.**

> ## ⚠ CORRECTION (same day, after user challenge)
> **An earlier revision of this report said the counter never fires. That was wrong.**
> `Thunder Strike (Riposte)` was captured resolving live (§2). The error was
> methodological and worth recording:
>
> - I concluded "0 firings" from the sim journal showing no riposte entries plus four
>   `Overload Riposte unavailable (Conditions not met)` notes.
> - **The journal does not log enemy free actions at all.** Control: `Chain Reaction`
>   fired at 21:17:20.206 and grants a free Thunder Strike — and produced **no**
>   `free-action` entry, while the same journal logged `free-action` for Zarg, Blanche
>   and Kalina. Absence of evidence, treated as evidence of absence.
> - The "unavailable" notes were real but partial: the counter *is* correctly gated off
>   on odd-accuracy hits. I read a partial record as a complete one.
> - The battle log could not arbitrate either — it stores `sourceType`, not item names.
>
> Settled by instrumenting the once-per-action resolve point to capture the item name.
> **Check what a log does not record before concluding from its silence.**

---

## 1. Results

Four runs. Runs 1–2 were invalid as balance data (see §5); runs 3–4 are the real ones.

| # | Config | Rounds | Party HP | Verdict |
|---|---|---|---|---|
| 1 | guests ON (a 498 HP guest joined) | 2 | 100% | invalid — not the encounter |
| 2 | guests off, pre-Spell-fix | 2 | 92% | TRIVIAL |
| 3 | guests off, post-Spell-fix | **3** | **75%** | **too easy — no real pressure** |
| 4 | as 3, instrumented | 2 | 96% | TRIVIAL |

**Live lands at 75–96% party HP. Mindscape predicted 61%.** The fight is not dangerous,
and the reason is mechanical rather than numerical: **roughly half the monster's intended
output never happens.**

### Which mechanics actually fired

| Mechanic | Live | Evidence |
|---|---|---|
| **Static Buildup** | ✅ **works** | 4–7 `reaction-fired` entries per run. Both gate rows evaluate, exactly one is available each time — the mutual-exclusion design holds under real conditions |
| **Chain Reaction (storm-fed)** | ✅ **works** | run 1: `Lightning Rod [turn_start]` → `Chain Reaction [creature_gain_resource]`. The absorbed Rod strike buys the free Thunder Strike, exactly as designed |
| **Overload Riposte** | ⚠️ **fires, but rare + mis-targets** | captured live as `Thunder Strike (Riposte)`; **1 of 6** Skizzik actions in the measured run |
| Lightning Storm itself | ✅ armed | journal: `conflict event: lightning-storm` |

**The `reaction_cause_filter` fix is confirmed working in a real battle.** That was the
half of the rework I was least able to verify offline, and it behaves exactly as the
Kirin precedent predicted.

---

## 2. The counter — it fires, and here is the captured proof

Instrumenting the once-per-action resolve point to record the resolving item name gave
the full Skizzik action list for one run:

| # | item resolved | targets | damage |
|---|---|---|---|
| 1 | Thunder Strike | Keren | 41 |
| 2 | Thunder Strike | Blanche, Fox fire | 0, 39 |
| 3 | **Thunder Strike (Riposte)** | **Blanche, Fox fire** | **1, 14** |
| 4 | Thunder Strike | Keren | 36 |
| 5 | Thunder Strike | Keren | 82 |
| 6 | Thunder Strike | Keren | 74 |

**The riposte resolves.** Two problems remain, and both are real:

### 2a. It is far rarer than designed — 1 of 6 actions

The proposal budgeted the counter at **~51% of the monster's swings** (roughly 4–6 per
fight); it delivered **one**. The gate is verifiably correct — instrumentation measured
all five clauses TRUE at CONFIRM scan time
(`SUBJECT_IS_SELF 1 · INCOMING_DAMAGE 48 · ATTACK_CHECK_RESULT 26 · TRIGGER_DAMAGE_IS_BOLT 0`)
on three separate evaluations in one run, and `findPassiveCandidates` returns
`available: true` in isolation. Yet the four `unavailable (Conditions not met)` notes are
also real. So the gate passes sometimes and is rejected other times under conditions that
look equivalent — **the firing rate, not the wiring, is the open question.**

Part of the shortfall is legitimate: an odd Accuracy Result correctly suppresses it, which
is half of all attacks by design.

### 2b. It targets the wrong creatures — the actual defect

Row 3 hit **Blanche + Fox fire** — the *previous* action's target pair — not the creature
that attacked Skizzik. A counter must strike its attacker and nothing else.

`riposte_target` is a `targeting` row with `candidate_source: "trigger_attacker"`, which
reads `payload.attackerTokenUuid`. On a free action spawned from the card the resolved
token list is evidently not being applied — the spawned attack inherited the parent
action's targets instead. Its damage (1 and 14) is also below the riposte's own profile.

**This is the higher-priority fix**: a mis-targeting counter is worse than a missing one,
because it silently converts a single-target riposte into a second AoE.

### Where the earlier wrong conclusion came from

Recorded because the method matters more than the result: the sim journal **does not log
enemy free actions**, and I read its silence as absence. See the correction box at the
top.

---

## 3. A real bug found and fixed on the way

`creature_targeted_by_action` **never fired for `Spell`-kind actions.** `Spell` is a
distinct `ar.kind`, and it was missing from the scan's fire condition, which listed only
`Attack | Item | Skill`.

**23 authored rows ride that trigger**, including **Protect on 4 actors**, Verónica,
Prophetic Defender, Illusory Shield, Crossfire, and Fafnir's Condemn/Torment. All of
them were inert against every enemy spell in the game — the party's core defensive tool
did not exist against a caster.

The sibling damage-window scan (`state-handlers.js:4714`) already had
`(Skill || Spell)`, which is what identifies this as an oversight rather than a rule.

**Fixed** — commit `6453744f`. Found only because Skizzik's counter was firing far less
than designed, and half this party attacks with Spells — so for those attacks the trigger
was never reached at all. Real bug, found for a partly wrong reason.

---

## 4. Where the balance actually stands

**Still not safe to re-tune.** The counter fires roughly **1/5th as often as designed**,
so live is measuring a weaker monster than the sheet — just not a counter-less one.

| Source | Party HP | What it was measuring |
|---|---|---|
| desk model | Pressure 0.62 | counter at ~51% of swings |
| Mindscape | 61% | counter at ~51% of swings (modelled) |
| **live** | **74–96%** | **counter at ~17% of swings, mis-targeted** |

Across six runs live spans 74–96% party HP — consistently "trivial" to "too easy". The
desk model and Mindscape agree with each other and sit well below live, which is the
direction a 5× under-firing counter predicts.

**Fix the targeting and the firing rate first, then re-measure.** The HP/damage cuts were
sized against a counter carrying half the monster's output; judging them now would
re-tune against a bug. Note the offline models are *not* discredited — they modelled the
design faithfully; the engine is under-delivering it.

---

## 5. Harness notes (cost two runs)

- **`guests: true` is the default** and fielded **Kalina, 498 HP** — larger than the rest
  of the party combined. Pass `guests: false` for encounter balance work.
- **`quantity: 2` does spawn two**, despite the result's `combatants` array listing one.
  The journal header (`4 PC(s) vs Skizzik×2`) and two `decide` entries per round are the
  reliable check; the summary snapshot drops the one that died.
- The party fields **Fox fire**, a Keren phantasm, as a 5th body — expected, not a fault.

---

## 6. Recommended next steps

1. **Fix the riposte's targeting** (highest priority). A free action spawned from a card
   reaction is not applying its `targeting` row's resolved token — it inherits the parent
   action's target list. Start at the `free_action` grant's `target_ref` handling and how
   the spawned action composes targets. A mis-targeting counter is worse than a missing
   one: it turns a single-target riposte into an unintended second AoE.

2. **Find why the firing rate is ~1/5th of design.** The gate provably passes at scan
   time on evaluations that then read `unavailable`. Instrument `evaluateAvailability`
   (`skill-effects.js:1831`) to log which of the two gates rejects it, and on which pass.

3. **Then re-run and re-measure.** Only after 1 and 2 is the live number comparable to
   Mindscape's 61% — and only then should the HP/damage numbers be revisited.

4. **Add enemy free actions to the sim journal.** Their absence is what produced the wrong
   conclusion in the first revision of this report; PC free actions are already logged.

5. Not started: skill-regression (`--update` for 3 added + 2 modified rows), action
   animations.

---

## Appendix — what changed on disk

| Commit | |
|---|---|
| `6453744f` | `creature_targeted_by_action` now fires for Spell-kind actions |
| `e66f2aed` | Mindscape reaction layer + Lightning Storm (earlier today) |

Skizzik's world data is **unchanged by this session** — verified after the temporary
stat-flips used for comparison runs (`bin/_build-skizzik.js` dry-run reports
`130 → 130`, `30 → 30`). All temporary instrumentation removed; non-world tree clean.
Foundry closed cleanly; safe-edit confirms the LevelDB lock is released.
