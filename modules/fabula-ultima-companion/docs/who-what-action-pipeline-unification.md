# Who/What action-pipeline unification (DESIGN — proposed)

**Status:** proposed / not started. Captured 2026-06-18 from a design discussion
while building Cognitive Focus's heal-amp. No code changes yet — Cognitive Focus
ships on a point-solution passive (see "Decision log").

## Thesis

Every turn action answers two independent questions:

1. **WHO is affected** — targeting + the accuracy/Magic check vs each defender →
   a **hit set**, plus the *resolution context* (`rA`, `rB`, `HR`, `isCrit`,
   `total`, per-target `hit`). This is the **only** place real randomness enters.
2. **WHAT they're affected with** — damage, heal/restore, status, shield, … applied
   to the hit set.

The **only irreducible state is the dice**. Everything else — per-target damage,
heal amounts, affinity, bonuses — is a **pure function of (frozen dice + board
state)** and should be produced by **one "what" computation** consumed by *both*
the action card and RESOLVE.

The current pipeline violates this in two ways:
- It **co-locates** "who" (`hit`) and one "what" (`damage`) in the same
  `perTargetResults` row, produced in the same pass — because damage reads `HR`
  off the roll. A data dependency ("what" reads an output of "who") got turned
  into structural coupling.
- **Heal/grant has TWO computations** — `buildHealPerTarget` (card preview) and a
  second, independent recompute in `grantApply` (RESOLVE). Damage has ONE
  (`computeActionProfile` → `perTargetResults`, applied at RESOLVE). Damage's
  single-source model is the right one; heal's dual path is the divergence (and
  the reason a per-target heal bonus must be wired into *both* spots via one shared
  helper to avoid drift).

## Why it matters (the concrete driver)

A "healing increase" effect that is **optional** ("you may…") or **costed**
("pay X to…"), decided **on the action card before it resolves** — uniform with how
`adjust_damage` / `adjust_accuracy` already work — is **not expressible today**.
- A passive (`per_target_grant_bonus`) is always-on + free (no decision point, no
  cost phase).
- A **post-recovery reaction** (`creature_gain_resource`, ask-mode + `consume_resource`)
  *does* give optionality + cost **today**, but the decision lands **after** the
  heal ("react to the recovery by adding more") — wrong moment for "pay up front to
  boost this heal."
- The **on-card, pre-resolve** heal choice can only be uniform with damage if heals
  resolve from the computed profile (this migration).

## Current architecture (anchors)

| Concern | COMPUTE | Card / reactions | RESOLVE |
|---|---|---|---|
| **Who** (targeting + check) | `computeActionProfile` → `computeCheck` (action-profile.js:565, :164) | card-mutations: `redirect_target`, `add_target`, `adjust_accuracy` mutate the target set / roll total (card-mutations.js `applyAcceptedCardMutations`:740) | hit/miss frozen in `perTargetResults` |
| **What: damage** | same pass → `perTargetResults` (one source) | `adjust_damage` / keywords recompute per-target from frozen dice (`recomputeActionProfile` action-profile.js:867) | **applies `perTargetResults`** (state-handlers.js ~386 "damage loop") |
| **What: heal/grant** | `buildHealPerTarget` (action-profile.js:473) — preview only | (no card-mutation reaches it) | **re-executes** `grantRun → grantApply` (skill-effects.js:3366,:3380) — recomputes formula, ignores the previewed `perTargetResults` |
| **What: apply_ae / chains** | preview via effect-kind preview registry | — | re-executes effect_table rows (`fireActivationEffect`) |

`perTargetResults` row conflates `hit` (who) + `damage`/`grantAmount` (what).

Point-solution in place (Cognitive Focus heal-amp): `resolvePerTargetGrantBonus`
(skill-formulas.js) is called from BOTH `buildHealPerTarget` AND `grantApply` so the
two heal computations can't drift — i.e. it manually patches the dual-path divergence.

## Target architecture

```
ACTION
 ├─ WHO  (resolution)  → { hitSet, dice(rA,rB), HR, isCrit, total, per-target hit }   ← freeze ONLY the dice
 │     mutations: redirect_target, add_target, adjust_accuracy
 └─ WHAT (application)  → one per-target effect computation, reads the WHO context
       kinds: damage, heal/restore, shield, status-preview, …
       mutations/adjustments: adjust_damage, adjust_grant, per-target/per-action bonuses
       ► used by BOTH the card AND RESOLVE (single source; RESOLVE applies it, doesn't recompute)
```

- **Damage stops being special.** It's a "what" that happens to read `HR`. Heal is a
  "what" that doesn't. Symmetric.
- **Adjustments unify.** A damage bonus and a heal bonus are the same shape
  (per-target or per-action scope), and can carry the same optionality + cost +
  reaction-pill machinery — because both modify the single "what" computation that
  RESOLVE honors.

## Migration plan (phased, each shippable)

**Phase 1 — split the record.** Stop conflating who/what in `perTargetResults`:
keep `hit`/roll context as the resolution result; move damage/heal/etc. into a
per-target **effects** list keyed by kind. (Mostly a refactor; behavior-neutral.)

**Phase 2 — grants apply from the profile at RESOLVE** (the heal-specific win).
Route RESOLVE's PRIMARY grant write to consume the computed `perTargetResults`
effects instead of re-running `grantApply`'s formula — mirroring the damage loop.
Collapses heal's dual path → one source. **Exception (must stay re-executed):**
chain-coupled grants whose amount depends on a prior `prompt_number` / `prompt_element`
/ `VAR_*` or a conditional sub-grant are NOT pure functions of the frozen inputs;
those keep re-executing. Detect by "row references a chain var / is mid-chain."

**Phase 3 — unify "what" adjustments + reactions.** Generalize the adjustment
system (`adjust_scope: per_action | per_target`, already prototyped for accuracy)
across damage/heal, and let a reaction modify the "what" profile on the card
(apply/skip + `consume_resource`) for ANY effect kind — heals included. This is what
delivers the optional/costed, on-card, pre-resolve heal choice + the reaction pill,
uniform with accuracy.

## Payoffs
- Optional / costed / pill'd healing adjustments decided on the card (the driver).
- One "what" computation → preview == commit by construction (no shared-helper
  band-aids like the current heal-amp).
- `redirect`/`add_target`/`adjust_accuracy` cleanly = "who"; `adjust_damage`/heal
  bonuses cleanly = "what".

## Risks
- Touches the grant RESOLVE path for **every** skill (large regression surface;
  needs the full skill regression + parity harness).
- Chain-coupled grants are a genuine exception — the migration must not assume all
  grants are pure (it'll mis-apply a prompt-driven grant if it does).
- `perTargetResults` is read in many places (card render, battle log, rewind
  snapshots) — Phase 1's record split must keep them working.

## Decision log
- **2026-06-18 (later):** Cognitive Focus's heal-amp is marked **PENDING / provisional**
  (user request). The passive stays in place as the interim, but it's NOT final — it's
  to be reworked onto this who/what model (on-card, optional/costed-capable) when this
  migration is picked up. Treat the heal-amp as the first concrete consumer of Phase 2/3.
- **2026-06-18:** Cognitive Focus heal-amp shipped as the always-on passive
  (`per_target_grant_bonus` + `resolvePerTargetGrantBonus`) — RAW-correct (no choice,
  no cost), verified. Migration **deferred**: not justified for an always-on skill,
  and the general optional/costed need is mostly covered by post-recovery reactions
  (mechanism #2). **Trigger to do this work:** the first skill that needs an
  *on-card, pre-resolve* optional-or-costed **healing** adjustment.

Related: [[project_damage_unification]] (Gen-3 damage migration — adjacent), the
ActionProfile refactor (one `computeActionProfile` pre+post-roll), card-mutations.js
phase model, and `reference_unified_effect_targeting`.
