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

**Phase 1 — split the record. ✅ DONE (2026-06-18).** Stop conflating who/what in
`perTargetResults`: keep `hit`/roll context as the resolution result; move
damage/heal/etc. into a per-target **effects** list keyed by kind. Behavior-neutral.

*What it actually took:* the structured rows (`target`=WHO, `outcome`=roll result,
`effects[]`=WHAT) already existed in `buildPerTarget`/`buildHealPerTarget` but were
**dead scaffolding** — `flattenRow` + the runtime readers consumed a parallel flat
`_parity` mirror. Phase 1 made `effects[]` load-bearing and retired `_parity`:
- `outcome` now carries WHO results (`crit`, `pierceMiss`); the damage `effects[]`
  entry carries the full WHAT (`overrideElement`, `keywords`, `bonusBreakdown`,
  `reactionParts`); the heal `effects[]` entry carries `resourceCur`/`resourceMax`/
  `vismagusSuppressed`.
- `flattenRow`, `repReactionParts`, `hitTokenUuids`, and `diffProfileAgainstActionResult`
  all migrated off `_parity`; both `_parity` emissions removed.
- Verified byte-identical: a synthetic branch-matrix equivalence test
  ([tools/fvtt-playwright/scripts/_parity-flattenrow.mjs](../../../tools/fvtt-playwright/scripts/_parity-flattenrow.mjs))
  + live e2e on real tokens (Attack crit/hit/real-miss across two weapons; Skill
  damage) — zero diffs, `hitTokenUuids` correct (hit→included, miss→excluded). Heal
  flatten covered by the synthetic matrix only (no non-prompting pure-heal skill was
  available on the test tokens for a live row). The 134 downstream `perTargetResults`
  consumers are untouched.

**Phase 2 — grants apply from the profile at RESOLVE, one path** (the heal-specific
win). Route RESOLVE's PRIMARY grant write to consume the computed `perTargetResults`
effects instead of re-running `grantApply`'s formula — mirroring the damage loop.
Collapses heal's dual path → one source. There is **no re-execute branch**: every
grant applies from the precomputed profile, same as damage.

**Why one path is correct (no exception branch).** The dice are the only randomness;
every other input is computable at COMPUTE. So a grant-affecting choice is never
*necessary* mid-chain — it's always expressible as a pre-card capture
(`pre_activate_effect_ref`, the Elemental Shard convention: runs in CAPTURE mode
BEFORE the card — `fireActivationEffectPre`, skill-effects.js:3142 — lands on
`payload._chainVars` / `preActivateVars`, state-handlers.js:3166, threads into
`computeActionProfile` via `ctx.chainVars` :3185, and is persisted so RESOLVE replays
the SAME pick, `preActivateDone:true` :3192). A pre-card VAR is frozen alongside the
dice → `preview == commit` by construction. The only thing the old re-execute branch
covered was an **authoring mistake**: a `prompt_number` placed in the RESOLVE-time
`effect_table` chain instead of pre-activate. We don't keep a branch to service a
mistake.

**Replace the branch with a fail-loud precondition guard (NOT a silent fallback).**
A removed branch + an unenforced assumption is a silent-wrong: a mid-chain `VAR_X` is
unset at COMPUTE → resolves to `0` → the grant precomputes wrong and RESOLVE applies
it with no error. So at COMPUTE, if a grant's `grant_amount` references a `VAR_*` with
no pre-card provider in `preActivateVars`, **throw** — "capture this choice at
`pre_activate_effect_ref`." Mirror it with a **canon-lint rule** (prompt-into-grant
outside pre-activate = lint error). This is a *validation*, not a computation branch:
one data path, with a tripwire on the precondition. It also converts what would have
been untested dead-code into a self-documenting, enforced invariant.

**This tightens the contract:** "all grant-affecting choices are captured pre-card"
becomes an ENFORCED invariant, not a convention. Aligned with the expectation that
future skills choose before the card.

**Verified current state (2026-06-18):** the old exception set was EMPTY on both axes,
so collapsing to one path changes no live behavior. Zero grant/restore rows reference
any `VAR_*` / prompt var (the only `VAR_ELEMENT`s are damage rows). No conditional
sub-grant mechanism exists — `describeGrant` → `grantApply` is a flat single-formula
path (formula + caster-sheet `restoreParts` + frozen `grantAdjust`), all pure. To
prove the guard fires, author a synthetic mid-chain `prompt_number`-into-grant skill
and assert it throws at COMPUTE + trips the lint.

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
- One apply path assumes all grants are pure. That assumption is ENFORCED, not
  assumed: the COMPUTE-time precondition guard + canon-lint (Phase 2) make a
  mid-chain prompt-into-grant a hard error, not a silent mis-apply. Without that
  guard, removing the re-execute branch would silently apply `0` for a mid-chain
  `VAR_*`. The guard is the load-bearing piece — ship it WITH the branch removal,
  not after.
- `perTargetResults` is read in many places (card render, battle log, rewind
  snapshots) — Phase 1's record split must keep them working.

## Implementation status (2026-06-19) — branch `feat/action-who-what-unification`

DONE + committed + verified (6 commits): Phase 1 (WHAT record split, `_parity`
retired), Phase 2 (one WHO pass `resolveTargetOutcome` + single-roster merge
`attachHealEffects`), Phase 3 (#1 AE immunity gate fix + AE per-target on the
roster with immunity preview; #2 damage+heal → one `resource_delta` effect by
valence + `actionKind`), Phase 4 (#7 pre-card precondition guard that THROWS on a
grant amount reading a mid-chain VAR; apply primary grant from the profile at
RESOLVE — live-confirmed Remedy +50hp / Elixir +50mp). All behavior-neutral except
AE-immunity (now enforced) and verified via the parity harness + live simulate.

**Phase 5 plan (NOT started — feature build, 7 files):**
1. **#6 unify adjustments** — fold `adjust_accuracy` (card-mutations), `adjust_damage`
   (recompute ops), `adjust_grant` (`applyAdjustGrantEffect`) into ONE adjustment
   mechanism: `{ op, value, round, scope: per_action|per_target, targetKind }`.
   Code-unified; the three authoring kinds differ only at the UI/template layer.
   Parity-verifiable refactor — do this FIRST.
2. **Card-stage reaction for any effect kind** — extend the card-mutation/reaction
   framework so a reaction can offer an optional/costed adjustment against a chosen
   effect on the card (apply/skip + `consume_resource`), not just accuracy. The
   adjustment mutates the profile effect; Phase 4 means RESOLVE then applies the
   adjusted amount (no re-exec needed).
3. **THE DRIVER** — an on-card heal-boost reaction (e.g. "pay N MP: +X healing"),
   uniform with `adjust_damage`/`adjust_accuracy`. This is the feature the whole
   refactor exists for.
   Verification: the card interaction is a DOM overlay (not harness-visible), so
   needs live/Playwright UI testing — best taken with fresh context.

## Deferred / folded into Phase 6 (consumer migration)
- #4 one headline derived from effects[]; #8 selfEffects/appliedEffects → single
  effect-with-target_ref; #1b pure-status row creation (changes perTarget.count);
  migrate the 134 `perTargetResults` consumers + card off the flat shape, then
  delete `flattenRow` / flat `perTargetResults`.

## WHO model refinement + stage audit (decisions 2026-06-19)

**Refined WHO model (supersedes the 3-layer framing).** Targeting is two *stages*
over one *shared record*, not three stages:
- **Check (stage 1, OPTIONAL, pure):** roll → Accuracy → apply accuracy mods →
  compare vs DEF/MDEF. Output: frozen roll context `{HR, crit, fumble}` + per-target
  compare `{beats, margin}`. Computed ONCE. Knows nothing about effects, pierce, or
  the no-Check case.
- **Effects (stage 2):** each effect resolves its own `target_ref` and *interprets*
  the (optional) check result for itself (pierce → half on miss, on-miss apply,
  on-crit bonus, damage reads HR, etc.).
- **Shared record (not a stage — data):** the action's MUTABLE target set
  (`redirect_target`/`add_target` operate here, action-wide) + the frozen check
  result. Stage 1 writes the result; targeting-mutations write the set; stage 2 reads
  both. The "per-target outcome" is NOT its own stage — its scoring is in stage 1,
  its interpretation is in stage 2; what remained was just this shared record.
- No-Check is the *absence of a gate*, interpreted per-effect (affect all of the
  effect's `target_ref` targets) — not a special layer.
- heal/AE "use the same targeting code" = they read the same shared record and
  interpret it themselves, exactly like damage. No intermediate stage they route
  through — a record they all reference.

**Stage audit — what's a real stage vs what collapses (decided 2026-06-19):**
1. **apply_AE → per-target effect, SAME path as damage/heal.** Status must be
   per-target because immunity is per-target (an enemy can be immune to a specific
   effect) — directly analogous to damage affinity (IM/AB): a per-target gate on the
   effect. Replaces today's action-level `appliedEffects` flat list (`gatherEffectPreviews`,
   per-target fan-out unfinished). AE reads the shared roster; `immune → skip` per target.
   **Immunity data (confirmed 2026-06-19):** `actor.system.props.condition_<status>`
   ∈ `NA | IM | …` — parallel to the `affinity_N` element slots, distinct from the
   `<status>_status` active counters. The per-target gate reads
   `condition_<status> === "IM"` → skip. (Engine does not read this yet — that's this
   item's job.) Test fixture: BD Dummy Enemy has `condition_slow:"IM"`,
   `condition_poisoned:"IM"` on Training Ground.
2. **damage + heal → ONE resource-delta effect kind**, parameterized (sign /
   affinity-applies / reads-HR). MUST retain provenance (which action type it came
   from) so consumers + UI can differentiate. **HR is OPTIONAL** — present only for a
   certain group of actions (damage/attack-style); heal-style omit it.
3. **flattenRow / flat `perTargetResults`** — adapter scaffolding, nothing to inspect;
   exists only to feed the 134 legacy consumers and dissolves once they read the
   structured `profile.perTarget`. Leave as-is until then.
4. **Headline objects** (`damageObj`/`healingObj`, Attack-vs-non-Attack) → collapse to
   ONE headline derived from `effects[]`.
5. **Pre-roll range vs post-roll final** → unify (one effect evaluated over an HR
   domain — point or interval). ⚠ **GATED: ping the user before starting this.**
6. **`adjust_accuracy` vs `adjust_damage`/`adjust_grant`** → ONE adjustment mechanism
   in code; differ only at the UI/template level.
7. **Phase 2 precondition guard** — a tripwire, not a stage. ⚠ **GATED: ping the user
   when Phase 2 becomes relevant.**
8. **`selfEffects` / `appliedEffects` / per-target buckets** → a single thing (an
   effect with a `target_ref`; no separate buckets).

## Decision log
- **2026-06-19 (heal-amp MIGRATED — done):** Cognitive Focus's heal-amp moved OFF
  the standing `per_target_grant_bonus` passive ONTO a card-stage `adjust_grant`
  reaction, uniform with `adjust_accuracy`. New `applyAdjustGrantMutation`
  (card-mutations.js) reads `readAdjustment(row,"grant")`, applies `applyGrantAdjust`
  per matching target (gated per-target by `condition_formula` with the target as
  subject), records `ctx.grantOverride`; `recomputeActionProfile` re-applies each
  token's op on the rebuilt grant so the boost survives recompute (mirror of the
  accuracy override re-apply); RESOLVE applies it from the frozen profile (Phase 4 —
  no re-exec). RETIRED: `per_target_grant_bonus` effect_kind + `resolvePerTargetGrantBonus`
  walker + its two call-sites (buildHealPerTarget / grantApply). Data: Cognitive Focus
  effect row `cf_heal` → `adjust_grant add "SL * 2"` (condition `TARGET_HAS_MY_FOCUS == 1`,
  `grant_scope` defaults per_target) + a new force reaction
  (`creature_performs_action`/self, `ANY_TARGET_HAS_MY_FOCUS == 1` → cf_heal).
  Bridge-verified (SL3): focus +6, non-focus/other-applier untouched, itemized parts;
  accuracy path regression-clean. NOTE: this is the always-on/FREE variant — the
  optional/costed on-card heal DRIVER (Phase 5 step 3) is still unbuilt; this migration
  proves the per_target `adjust_grant` mechanism it will reuse. ⚠ Live e2e (Keren
  actually healing her focus) pending a heal source (Life Transference unbuilt).
- **2026-06-18 (branch removal):** Decided to REMOVE the re-execute branch entirely
  rather than keep it as a backstop. Rationale: the dice are the only randomness, so
  every grant-affecting choice is expressible pre-card; a mid-chain prompt-into-grant
  is an authoring mistake, not a capability. Phase 2 collapses to ONE apply path and
  replaces the branch with a COMPUTE-time fail-loud precondition guard (`VAR_*` with
  no pre-card provider → throw) + a canon-lint rule. Net: zero divergent paths;
  "all grant-affecting choices captured pre-card" becomes an enforced invariant.
- **2026-06-18 (verification):** Audited the exception. Both axes EMPTY today
  (no VAR/prompt-driven grants; no conditional sub-grant mechanism). Refined the
  exception boundary from "references a chain var / is mid-chain" to **"reads a var
  captured mid-chain / post-card."** Pre-card captures (`pre_activate_effect_ref`,
  the Elemental Shard convention) are frozen + replayed and are NOT exceptions —
  they're safe for single-source apply. Expectation: most future skills choose
  before the card, keeping the divergent path empty by construction.
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
