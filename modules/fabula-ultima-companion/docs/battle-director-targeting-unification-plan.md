# Targeting / reaction-mutation unification — design plan

> Status: **DESIGN (not yet implemented)** · 2026-06-16
> Prereq context: the effect-kind preview/apply unification is done & committed
> (`feat/action-card-effect-unification`). This doc covers the *second* single-
> source axis: reaction-driven changes to the in-flight action (targets,
> accuracy, damage element/ops, negate).

## Problem

`computeActionProfile` / `buildPerTarget`
([action-profile.js](../scripts/battle-director/action-profile.js)) is the
single per-target derivation for the *initial* COMPUTE: it reads each target
snapshot's `defense` / `magicDefense` / `affinities[element]` / `conditions[]`
and produces hit / crit / affinity / HR / rawDamage / damage / `damageModParts`,
folding accepted damage ops via `opsMap` (keyed by `actorUuid`).

When a **reaction** then changes the action, that work is redone by **separate,
partial reimplementations** instead of re-running `buildPerTarget`:

| Path | File | What it duplicates |
|---|---|---|
| `recomputePerTargetForRedirect` | [card-mutations.js:117](../scripts/battle-director/card-mutations.js) | defense select, hit/crit/fumble, affinity slot + NA→NE, HR (crit/ignoreHR), rawDamage, finalDamage. **Omits** pierce, outgoing-damage mods, `damageModParts`; hard-codes `studied:false` |
| `recomputePerTargetDamages` | [skill-effects.js:1635](../scripts/battle-director/skill-effects.js) | re-applies damage ops (adjust_damage / change_damage_element / apply_action_keyword) + affinity to existing rows |
| `adjust_accuracy` recompute | [card-mutations.js:413](../scripts/battle-director/card-mutations.js) | rewrites the check total, re-derives hit/miss per target |

These are orchestrated by **`applyAcceptedCardMutations`**
([card-mutations.js:633](../scripts/battle-director/card-mutations.js)), which
imperatively patches the frozen `targets` / `perTargetResults` arrays in phases:
`negate → redirect → adjust_accuracy → add_target`.

### What's actually OK today

`applyAcceptedCardMutations` is called by **both** the card
([action-card.js:4135](../scripts/battle-director/action-card.js)) **and**
RESOLVE ([state-handlers.js:3977](../scripts/battle-director/state-handlers.js)),
so **card == apply** for these mutations — there is no "card lies about the
target" drift. The gap is **derivation duplication**: a redirected/added hit is
computed by *different rules* than `buildPerTarget` would use, so changing a
damage rule in `buildPerTarget` silently does not follow into the redirect path
(e.g. redirect drops pierce / outgoing mods / `damageModParts` today).

## Goal

Make `buildPerTarget` the **one** per-target derivation. Reaction changes become
**inputs** to `computeActionProfile`, not post-hoc patches:

- **redirect / add_target** change the **target set** (which token occupies a
  slot, or appends a slot); then `buildPerTarget` recomputes every slot —
  including the redirected reactor — through the same path as the original
  targets.
- **damage / accuracy ops** pass via the **`acceptedReactions`** parameter
  `computeActionProfile` already accepts (it already folds damage ops through
  `computeSenderDamageBonuses` → `opsMap`). `adjust_accuracy` extends the same
  channel for the check total.

`applyAcceptedCardMutations` collapses to: **(1)** resolve the new target set +
accepted ops (running pickers as needed), **(2)** re-run `computeActionProfile`
with `{ targets: newTargets, dice: <persisted>, acceptedReactions }`, **(3)**
project to the legacy ar shape. `recomputePerTargetForRedirect` and the inline
accuracy/damage recomputes disappear into `buildPerTarget`.

## Input contract (proposed `computeActionProfile` extensions)

`computeActionProfile` already takes `{ view, ar, attacker, weapon, targets,
dice, ctx, acceptedReactions }`. Extensions:

- **`targets`** — the mutation layer hands in the *post-redirect / post-add*
  snapshot array. Redirected slots carry the **reactor's** snapshot plus a
  `redirectedFrom: { actorUuid, name, via }` annotation (display only; the
  renderer reads it for the "via PD, originally Hina" label). Added slots are
  ordinary appended snapshots.
- **`acceptedReactions`** — already drives `computeSenderDamageBonuses`
  (damage ops). Extend the resolver to also surface an **accuracy override**
  (`adjust_accuracy`) so `computeCheck` reads the adjusted total instead of the
  card-mutations layer rewriting `ar.roll`.
- **`dice`** — the **persisted** rolled dice (`{rA, rB}`) so re-derivation does
  NOT re-roll. Already an input; the mutation layer must pass the COMPUTE dice.

### The snapshot requirement (key work item)

`buildPerTarget` reads `defense` / `magicDefense` / `affinities[element]` /
`conditions[]` off each target snapshot `e`. `recomputePerTargetForRedirect`
today reads these live off `reactor.system.props`. To route redirect/add through
`buildPerTarget` we must produce a **full target snapshot** for the
reactor/added token — the same shape TARGET builds via
`snapshotEligibleTargets` / `snapshotCombatant` ([snapshot.js](../scripts/battle-director/snapshot.js)).
**Action item:** factor a `snapshotTargetForToken(tokenDoc)` helper (or reuse
the existing snapshot path for a single token) so the mutation layer can build
one snapshot per redirected/added target.

## Picker-pick threading (so re-derivation doesn't re-prompt)

Redirect/add already resolve interactive picks and **cache** them on the
candidate (`cand.pickedDestActorUuid`, `cand.pickedSubjectUuids`, etc.).
Re-derivation must be **pick-stable**:

- First pass: resolve picks (may prompt), cache on the candidate, build the new
  target set.
- Re-derive: `computeActionProfile` runs over the resolved target set — **no
  picker calls inside `computeActionProfile`**. All targeting prompts stay in
  the mutation/resolution layer; the profile builder is pure given its inputs.
- This already holds for damage ops (`acceptedReactions` are pre-accepted). The
  new requirement is that redirect/add resolve their target picks **before**
  the re-derive and pass only resolved tokens in `targets`.

## FSM / call-site touch-points

- **Card render** — `action-card.js:4135` calls `applyAcceptedCardMutations`
  on the frozen snapshot to show the post-reaction card. Becomes: build new
  target set → `computeActionProfile` → project → render.
- **RESOLVE** — `state-handlers.js:3977` (and `applyAddTargetSplices` at
  `:3687` for FORCE pre-card splices) does the same on the live ar. Must use the
  **same** new-target-set + re-derive path so card == apply is preserved by
  construction (today it's preserved because both call the same patcher; after,
  both call the same re-derive).
- **Persisted dice** — confirm the COMPUTE dice survive on `ar.roll` through
  CONFIRM/RESOLVE so re-derivation is deterministic (no re-roll).

## Migration strategy (incremental, parity-safe)

1. **Snapshot helper** — add `snapshotTargetForToken`; unit-check its output
   matches a TARGET-built snapshot for the same token (defense/affinities/conds).
2. **Redirect first** — rewrite `applyRedirectTargetMutation` to (a) resolve the
   destination token (existing picker), (b) swap a fresh snapshot into
   `ctx.targets[idx]` with `redirectedFrom`, (c) re-run `buildPerTarget` for the
   whole `ctx.targets` instead of `recomputePerTargetForRedirect`. Delete
   `recomputePerTargetForRedirect`. Verify: a Protect redirect's damage now
   includes pierce / outgoing mods (parity vs a direct attack on the reactor).
3. **add_target** — same shape (append snapshot, re-derive).
4. **adjust_accuracy** — move the total override into `acceptedReactions` →
   `computeCheck`; drop the inline hit/miss recompute.
5. **damage ops** — `recomputePerTargetDamages` is already op-based and shared
   with `buildPerTarget`'s `foldOps`; evaluate whether it can be retired in favor
   of always re-running `buildPerTarget` with the full `opsMap` (may already be
   redundant post-step-2).
6. **negate_action** — leave as a Phase-0 flag (it's a gate, not a per-target
   derivation).

Each step keeps card and RESOLVE on the **same** code path and is independently
verifiable via the bridge (compute a redirected/added action, compare the
per-target rows against a direct action on the same reactor) + the projection
parity harness.

## Test plan

- **Bridge, per step:** `runDirectorSkillCompute` / `runDirectorSkillSimulate`
  on a redirect skill (Protect / Prophetic Defender), an add_target skill
  (Grappled shared-space), and an adjust_accuracy skill (Crossfire). Assert the
  redirected/added per-target row == what `buildPerTarget` produces for a direct
  action on that same target (this is the anti-drift assertion).
- **Projection parity:** extend `verify-profile-projection.mjs` with a
  redirect/add case so projection==compute stays zero-diff.
- **Live battle:** Protect (single + multi-target redirect), a forced add_target
  splash, Crossfire accuracy bump — confirm card matches applied outcome.

## Risks / open questions

- **Snapshot fidelity.** `buildPerTarget` may read snapshot fields the redirect
  path never populated (e.g. `studied`, `affinities` map vs single code). The
  snapshot helper must produce the *complete* shape or `buildPerTarget` will
  read undefined. Mitigation: reuse the exact TARGET snapshot path.
- **Behavior change is intended but visible.** Redirected hits will start
  including pierce / outgoing mods / `damageModParts` they previously dropped.
  Confirm with design whether "Protect takes the *full* attack as the attacker
  would deal it" is the desired RAW reading (it almost certainly is).
- **Picker ordering.** Multi-candidate redirect + add_target in one window must
  resolve all picks before the single re-derive; verify no double-prompt.
- **Performance.** Re-running `computeActionProfile` per accepted reaction is
  heavier than patching one row, but it's once per confirm, not per frame —
  negligible.

## Net

Targeting is currently **consistent (card==apply)** but **not single-source**
(three partial clones of `buildPerTarget`). This plan makes `buildPerTarget` the
one derivation by turning reaction changes into `computeActionProfile` inputs —
the same move that fixed the effect-kind side, applied to the per-target axis.
