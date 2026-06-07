# Battle Director — ActionProfile Contract

Status: **design agreed 2026-06-08. PHASE 0 IMPLEMENTED + parity-verified
2026-06-08** (additive — no FSM caller switched yet). This is the COMPUTE-side
single-source design for the Action Card, the twin of the RESOLVE-side
`resolveAction` unification (see `battle-director-resolveaction-unification-plan.md`).

## Implementation status — COMPUTE single-source COMPLETE (Phases 0–4, 2026-06-08)
All Action-Card actions that derive a damage/effects preview (Attack, Skill, Spell,
Item) now flow through ONE source — `computeActionProfile` — at both pre-roll and
post-roll. The pre-roll/post-roll/recompute three-site divergence is gone; ~390
net lines of duplicated derivation removed from `state-handlers.js`.

- **Phase 1 — pre-roll Attack card** routes through `computeActionProfile(dice=null)`:
  fixes the reported pre-roll bugs (Hawkeye take-aim +SL×2 now shown via auto-fired
  `creature_will_deal_damage` reaction folding; RWM accuracy folded; HR-as-0 grant
  collapses the range). Fully fallback-guarded.
- **Phase 2 — Skill/Spell/Item post-roll COMPUTE** derives the whole ar from the
  profile + `projectProfileToActionResult`. Item action (BD-verified effect_table
  grant, legacy `type_damage` synthesis, carrier→activation link) all covered.
- **Phase 3 — Attack post-roll COMPUTE** likewise (grant check/damage/HR-as-0,
  baseParts breakdown, pierce, forced-VU, Guard-RS all folded into the profile).
- **Phase 4 — cleanup**: dead COMPUTE locals/imports removed. Basic actions
  (Guard/Equipment no-roll; Hinder threshold; Study open) intentionally keep their
  own branches — no damage/effects preview divergence; `computeCheck` already models
  their modes for a future route.
- **Verification (gitignored harness):** `verify-profile-projection.mjs` (9 cases,
  full-field zero-diff) + `verify-attack-projection.mjs` (16 cases) gated each switch;
  `verify-action-profile-parity.mjs` (10/10 live) + `verify-preroll-profile.mjs`
  (Hawkeye/RWM/HR-as-0/grant-dmg) + `verify-simulate-smoke.mjs` (COMPUTE→RESOLVE
  commits) confirm post-switch behavior.

### Original Phase 0 record
- **Phase 0 — DONE (additive, verified).**
  - `scripts/battle-director/action-profile.js` — `computeActionProfile(input)`
    (Target → Check → Effects), `describePrimary` (synthesizes the primary
    damage/heal descriptor from stat fields), `diffProfileAgainstActionResult`
    (parity helper). Builds the full contract below.
  - `scripts/battle-director/skill-effects.js` — `EFFECT_KIND_PREVIEW` registry
    + `previewEffectRow(row, pctx)`: the pure preview() twin of every
    EFFECT_KIND_DISPATCH apply() handler. Exported.
  - **Parity proof:** `tools/fvtt-playwright/scripts/verify-action-profile-parity.mjs`
    runs the real Skill/Spell + Attack COMPUTE (forced dice) and diffs the
    builder's output against the live `actionResult`. 7/7 cases zero-diff:
    dmgSpell hit/crit/miss, heal, attack hit/crit/miss (check total/hr/crit/
    fumble + per-target hit/damage/rawDamage/affinity/grant).
  - **NO caller switched** — `computeActionProfile` is not yet invoked by the FSM;
    the existing COMPUTE handlers are untouched. Phase 1 routes Attack through it.
  - Parity note baked into the builder: forced-VU (status→element) and Guard's
    blanket Resistance are ATTACK-only in COMPUTE today; `buildPerTarget` gates
    them to `kind === "Attack"` to match. Revisit when unifying (a Skill dealing
    physical damage arguably *should* respect forced-VU — that's a Phase 2 call).
- Phases 1–4 — pending (see Phasing section).

## Why
The Action Card's accuracy/damage/effects are derived in **three** divergent
places today — the pre-roll card build (`state-handlers` TARGET ~2449), the
post-roll COMPUTE branches (Attack ~2887, Skill/Spell ~2517), and the card-side
`recomputeTargetPreviews` (`action-card.js`). Each carries a *different subset*
of modifiers, so every new modifier (RWM accuracy, Hawkeye damage, HR-as-0) has
to be wired into 2–3 places and one is always missed. Same class as the
effect-kind dispatch map and the template-field registry: collapse N hand-kept
derivations into ONE source.

## The model
- **One preparation pass** produces everything the card shows; the card is a
  **pure renderer** of its output (computes nothing). Runs at pre-roll
  (`roll=null` → ranges), post-roll (`roll` set → finals), and on any
  reaction/decision toggle (re-prepare).
- The pass is **Target → Check → Effects**, driven by **data attributes, never
  by kind**:
  1. **Target** is resolved first (FSM TARGET state) and is an *input* — checks
     are per-target, so targeting precedes them.
  2. **Check** — read `isCheck`/mode/attrs/defense from data. `isCheck=false` ⇒
     **auto-hit**.
  3. **Effects** — per hit-target (and self): a list of typed effects.
- **Full taxonomy:** every `effect_kind` gets a pure **`preview(row, ctx)`**
  (what the card shows) alongside its existing **`apply(row, ctx)`** (the write).
  `computeActionProfile` = walk effects in *preview*; `resolveAction` = walk the
  same effects in *apply*. Card and commit cannot disagree.
- **A reaction is an action.** It carries its own previewed effects + a
  host-mutation describing how it alters *this* action. Running a reaction (auto
  or manual) adds it to the ordered `acceptedReactions` set; the profile is
  **recomputed** (FIFO, re-gate after each) — idempotent on toggle; preview≡commit.
- **The adapter** (`getRuntimeActionView`, extended) reads the action's shape
  from ANY source (weapon / skill / spell / Common action-skill item) into one
  normalized view, and **synthesizes the primary damage/heal as a `deal_damage`/
  `heal` effect from the stat fields** — because today Attack weapon damage AND
  spell heal/damage (Heal, Lux, offensive spells all have empty `effect_table`)
  live in stat fields, not effect_kinds. It also gathers effects from
  `effect_table` + fire-points (`on_activate_effect_ref` / `post_damage_effect_ref`).

## Validation (ran the contract against all 48 BD masters + basic actions)
Most map cleanly (apply_ae, grant/heal, remove_tagged_ae, equip_swap,
encyclopedia_record, add_target, adjust_accuracy, redirect_target, adjust_damage,
AoE/ally/self targeting, auto/manual/third-party reactions). **Nothing is
impossible**, but five gaps forced the contract to grow beyond "check vs static
defense" (each folded into the contract below):
1. **Check modes** — `vs_defense` (Attack/Spell), `opposed` (Hinder), `threshold`
   (Study, graded by tier), `open` (targetless). Plus a per-target **graded
   outcome**, not just `hit:bool`.
2. **Primary damage/heal is field-driven** (Heal/Lux/offensive spells have
   `EF[]`, like weapon damage) → adapter synthesizes it into the taxonomy.
3. **Non-deterministic effects** — `roll_loot_table` (Soul Steal), Gamble →
   `random` EffectPreview variant (preview = possibility set, resolve = one branch).
4. **`open_action_menu` is a pending choice** (Awaken/Reinforce/Torpor/Warning
   Shot/High Speed) → model as a **Decision** node, same pending→resolve→fold
   mechanism as reactions.
5. **Host-mutation enum** must include `substituteCost` (Vismagus) and incoming
   `adjustIncomingDamage` (Mercy/Unbreakable clamp the damage a *target* takes),
   beyond accuracy/targets/redirect/nullify.
Related: effects can live outside `effect_table` (See You Later `EF[]`,
fire-points) — the adapter gathers from all sites or the card renders empty.

## The contract

```
ActionProfile = {
  action: { kind, name, icon, descriptor,
            actor: { actorUuid, tokenUuid, name, img, disposition } },

  check: {
    required,                       // false => auto-hit, no accuracy panel
    mode,                           // "vs_defense" | "opposed" | "threshold" | "open"
    attrs: { A1, A2, dA, dB },
    bonusParts: [{ source, amount }],   // weapon + actor-status(RWM) + grant + accepted reactions (provenance)
    // resolved (post-roll) only:
    rA, rB, hr, total, isCrit, isFumble,
    thresholds,                     // graded ladder for mode "threshold" (Study tiers)
    blocked, blockedBy,             // accuracy-override reaction (Crossfire)
  },

  perTarget: [{
    target: { actorUuid, tokenUuid, name, img, disposition, studied, defenseShown },
    outcome: {
      kind,                         // "auto" | "hit" | "miss" | "graded" | "pending"
      hit,                          // bool | null (null = pre-roll & check required)
      margin,                       // total - defense, when known
      tier,                         // for threshold/graded (Study)
      source,                       // provenance if forced (e.g. "Crossfire")
    },
    effects: [ EffectPreview ],
  }],

  selfEffects: [ EffectPreview ],   // costs, self-buffs, equip swaps

  decisions: [ Decision ],          // PENDING menu choices (open_action_menu)
  reactions: { pending, candidates: [ ReactionCandidate ] },

  gate: { canRoll, canConfirm, reason },   // pending decisions/reactions block commit
}

EffectPreview = { id, valence:"harmful"|"beneficial"|"neutral", source, targetRef } & ONE of:
  | { type:"damage", element, resource:"hp"|"mp"|"shield", damageClass,
      breakdown:[{label, add?, mult?, value}], preAffinity, affinity,
      value | range:{min,max} }            // synthesized primary OR a deal_damage row
  | { type:"heal",    resource, value | range }
  | { type:"status",  status, valence, duration?, dupMode? }   // apply_ae
  | { type:"cleanse", filter }                                  // remove_tagged_ae
  | { type:"cost",    resource, amount }                        // consume_resource / consume_charge
  | { type:"equip",   change }                                  // equip_swap
  | { type:"reveal",  aspect, tier }                            // encyclopedia_record (Study)
  | { type:"grant",   what, amount }                            // resource/charge/extra-action grant
  | { type:"random",  label, possibilities:[ ... ] }           // roll_loot_table / Gamble (resolves to one)

Decision = {                         // a pending choice; resolves like a reaction
  id, kind:"menu", title, subtitle,
  pickCount,                         // number OR formula (Perfect Aim => "1 + HAS_SKILL_PERFECT_AIM")
  options: [{ ref, label, description, previewEffects:[ EffectPreview ] }],
  chosen: [ref] | null,              // null = pending (gates commit)
}

ReactionCandidate = {
  id, carrier:{ name, icon, uuid, kind:"item"|"ae" },
  reactor:{ actorUuid, tokenUuid, name },     // may differ from actor (third-party)
  mode:"ask"|"on"|"force"|"off",
  decision:"pending"|"applied"|"skipped"|"auto",
  available, unavailableReason,
  selfEffects:[ EffectPreview ],              // its own cost/status → Effect panel
  hostMutation: {                             // how accepting it transforms THIS action
    accuracy?:{ op:"set"|"add"|"subtract", amount },   // Crossfire (set 0 = blocked)
    addTargets?:[ ... ],                                // Barrage
    redirect?:{ fromTargetUuid, toTargetUuid },         // Protect / Prophetic Defender
    nullifyDamage?,                                      // Warning Shot
    adjustIncomingDamage?:{ op, amount, stage:"incoming", targetUuid },  // Mercy / Unbreakable
    substituteCost?:{ fromResource, toResource },        // Vismagus
  },
}
```

## Data flow / FSM
- TARGET resolves targets → PRE_ROLL: `computeActionProfile(action, targets, roll=null, accepted=[auto reactions], grant)` → pre-roll card (ranges).
- COMPUTE: same call with the roll → post-roll card (finals).
- Pill/menu toggle: re-call with updated `acceptedReactions` / `decisions`.
- CONFIRM → RESOLVE: `resolveAction` replays the SAME accepted set + chosen decisions in apply-mode (writes). One walk, two verbs.

## Phasing (verify each; hot path; keep verify-* scripts as the net)
0. ✅ DONE — Build `computeActionProfile` + the primary damage/heal synthesis
   (`describePrimary`) + a `preview()` for each effect_kind + gather effect
   sites. **No caller switched** — parity-tested against current COMPUTE output
   (verify-action-profile-parity.mjs, 7/7 zero-diff).
1. ✅ DONE — Route **Attack PRE-ROLL** through it → fixed the pre-roll Hawkeye
   damage/accuracy + HR-as-0. (commit bc588a1)
2. ✅ DONE — Route **Skill/Spell + Item** post-roll COMPUTE (projection gated by
   verify-profile-projection.mjs, 9 cases zero-diff). (commit 779d99f)
3. ✅ DONE — Route **Attack** post-roll COMPUTE (projection gated by
   verify-attack-projection.mjs, 16 cases zero-diff). (commit 9bd34f1)
4. ✅ DONE — Deleted the bespoke Skill+Attack derivation branches + dead imports
   (~390 net lines). (commits 779d99f / 9bd34f1 / 6da7070) **Basic actions
   (Guard/Equipment/Hinder/Study) intentionally NOT routed** — no damage/effects
   preview divergence; left on their own (correct) branches.

### Remaining (not blocking; future)
- Route Hinder/Study through `computeCheck` (modes already supported) if a unified
  basic-action card is ever wanted — needs a Hinder/Study projection (dl/success,
  tier/previousBest/improved). Low value; deferred.
- The card-recompute reaction path (`recomputeTargetPreviews`) still uses
  `computeSenderDamageBonuses` directly; it could call `computeActionProfile` with
  `acceptedReactions` for full symmetry. Functionally correct today.
- MP-burn skill projection is logic-mirrored but had no live fixture to test (no MP
  skill in the world) — spot-check when one exists.

## Open decisions (resolved in discussion)
- Two functions (computeActionProfile preview + resolveAction apply) sharing the
  adapter — NOT merged (preview must not write). ✔
- Reactions applied via recompute-from-ordered-set (idempotent toggle, FIFO inside). ✔
- Effect *config* schema (collapsing `damage_amount`/`grant_amount`→one `amount`)
  is a SEPARATE concern, deferred — this doc is about compute/data prep, not
  effect storage. (User flagged it as out of scope for now.)
