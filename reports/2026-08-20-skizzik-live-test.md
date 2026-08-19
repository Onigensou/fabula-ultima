# Skizzik rework — live test report

**Date:** 2026-08-20 · **World:** fabula-ultima-2 · **Harness:** Automated Playtest Sim
**Encounter:** Valley of the Dragon row 6 — `Skizzik ×2`, conflict event `lightning-storm`
**Build under test:** `docs/skizzik-rework-proposal.md` §10 (HP 130 · Thunder Strike 30 ·
Overload Riposte · Static Buildup · storm-fed Chain Reaction)

**Verdict: 2 of 3 new mechanics work. The counter does not fire, and the cause is an
engine defect in shared card infrastructure — not in the monster's authoring.**

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
| **Overload Riposte** | ❌ **never fires** | 0 firings across all 4 runs; surfaces as `unavailable (Conditions not met)` |
| Lightning Storm itself | ✅ armed | journal: `conflict event: lightning-storm` |

**The `reaction_cause_filter` fix is confirmed working in a real battle.** That was the
half of the rework I was least able to verify offline, and it behaves exactly as the
Kirin precedent predicted.

---

## 2. The counter — root cause

Not the monster. The gate is correct; the engine loses it between two steps.

### The gate evaluates TRUE at scan time — measured

Temporary instrumentation captured every clause at the moment the CONFIRM scan builds
the payload. Three separate evaluations in one run had **all five clauses satisfied**:

```
reactorUuid === subjectUuid   (same token)  →  SUBJECT_IS_SELF        = 1
                                               INCOMING_DAMAGE        = 48
                                               ATTACK_CHECK_RESULT    = 26   (even)
                                               TRIGGER_DAMAGE_IS_BOLT = 0
```

Independently, calling `findPassiveCandidates` directly with a well-formed payload
returns `available: true`. **The authoring is right.**

### But it reaches the apply layer as unavailable

The sim's reaction-brain does not re-evaluate — it reads the `available` flag stamped on
the candidate (`sim/reaction-brain.js:447`). It consistently sees
`available: false, "Conditions not met"`.

So the reaction passes its gate during the CONFIRM scan and is nevertheless marked
unavailable by the time anything can apply it. The payload-only identifiers
(`ATTACK_CHECK_RESULT`, `INCOMING_DAMAGE`) read 0 in a later evaluation pass — and
`ATTACK_CHECK_RESULT > 0` then correctly fails, which is the guard doing its job on a
payload that should not have been empty. Run 1's journal shows a second pass explicitly
tagged `"phase":"ask"`, so multiple evaluation passes over the same candidate do happen.

`payloadAtFire` is threaded through `action-card.js` and `card-mutations.js` in a dozen
places, so the infrastructure exists; something on this path is not carrying it.

### Blast radius — this is not a Skizzik problem

Any reaction on `creature_targeted_by_action` whose gate depends on payload-only
identifiers has the same shape. **Ampere's Volt Counter is the same construction**
(`ATTACK_CHECK_RESULT % 2 == 0`, shipped content) and is very likely equally inert —
untested, but structurally identical. `Crossfire` (2 actors) spends MP equal to
`ATTACK_CHECK_RESULT` and is in the same family.

> This is the class of failure the live sim exists to catch, and the reason a clean
> offline result is never permission to skip it. Mindscape modelled the counter
> perfectly and scored it at 61% party HP; the engine never fires it.

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

**Fixed** — commit `6453744f`. Found only because Skizzik's counter never fired and half
this party attacks with Spells, so the trigger was rarely even reached.

---

## 4. Where the balance actually stands

**Unknown, and deliberately not estimated.** With ~half the monster's output not
happening, run 3's 75% measures a different monster than the one on the sheet. The three
prior estimates now read:

| Source | Party HP | What it was measuring |
|---|---|---|
| desk model | Pressure 0.62 | all mechanics working |
| Mindscape | 61% | all mechanics working (modelled) |
| **live** | **75–96%** | **counter absent** |

Mindscape and the desk model agree with each other and disagree with live in exactly the
way the missing counter predicts. **Re-run live once the counter fires before touching
any number.** The HP/damage cuts should not be revisited on this evidence.

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

1. **Decide how to make the counter fire.** Two options, materially different:
   - **(a) Pre-authorised fallback** (proposal §6): swap `riposte_strike` to a flat
     `deal_damage` 20 Bolt on `trigger_attacker`, matching Ampere's shape. Fast, but it
     inherits the same availability path — **verify it actually fires before trusting
     it**, since Volt Counter may be broken the same way.
   - **(b) Fix the engine** so the CONFIRM-time payload survives to the apply step.
     Larger, touches shared card infrastructure, but repairs Volt Counter and Crossfire
     too and keeps the riposte a real rolled attack.

   **(b) is the better fix** — (a) may not work, and the defect is shipped-content-wide.

2. **Audit Ampere's Volt Counter live.** If it is also inert, this is a long-standing
   content bug, not a regression.

3. **Re-run this encounter** once the counter fires, then compare against Mindscape's 61%
   to calibrate the reaction layer.

4. Not started: skill-regression (`--update` for 3 added + 2 modified rows), action
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
