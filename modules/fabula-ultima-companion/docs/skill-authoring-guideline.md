# Skill & Equipment Authoring Guideline

A distilled, reviewable rule list for authoring skills and equipment in this
world, derived from the verified skills/equipment already shipped. This is the
**quick checklist**; the deep rationale lives in
[skill-authoring-canon.md](skill-authoring-canon.md) (structure/canon) and
[battle-director-dev-guide.md](battle-director-dev-guide.md) (onboarding). Read
this before authoring; consult those two when a rule needs its "why".

Each rule names a real, verified example so it stays grounded.

---

## A. Where behavior lives (structure)

- **A1 — All conditional / triggered / passive behavior goes in
  `reaction_config_table` + `effect_table` rows, never top-level
  `system.props.*` fields.** The Skill Effects panel exposes only
  `On-Activate Effect Ref`. Deprecated homes: `post_damage_effect_ref`,
  `passive_check_bonus_formula`, `passive_damage_bonus`, `<class>_passive: true`.

- **A2 — Walk the decision tree to pick the home.** Turn-menu activation →
  `on_activate_effect_ref`; external event → reaction row; buff/debuff on
  another creature → AE with `reactionConfig`; N-uses / duration → AE with
  charges; always-on-while-owned → `transfer:true` AE, no reaction.
  *(Dodge's `bonus_defense += ${level}$` is a pure transfer-AE passive.)*

- **A3 — A true passive is an AE that just BE's, not a `turn_start` force-reaction
  that re-applies a self-AE.** Spending a trigger dispatch on an always-on bonus
  is a canon violation.

- **A4 — Scope a skill row to its own item with
  `reaction_source_skill: "<exact name>"` when it should fire ONLY when that
  skill/weapon acts.** Without it the row is *ambient* and fires on every
  qualifying action (it will leak onto basic attacks). `skill_type` does NOT
  gate reactions.

## B. Cost / resources

- **B1 — One cost source of truth, never two.** Either legacy
  `system.props.cost = "10 MP"` (parsed at CONFIRM) **or** a `consume_resource`
  row in the chain — never both, or the player is charged twice. There is no
  engine guard.

- **B2 — On a reaction skill, `cost` is display-only.** Reactions never reach the
  action-card debit phase; the real debit is `consume_resource` in the chain.
  *(High Speed: `cost:"10 MP"` for the tooltip, `consume_resource` does the work.)*

- **B3 — A rider that BUYS something on someone else's action bills with
  `adjust_cost`, not `consume_resource`.** "Spend 10 MP to target one additional
  creature" is part of what THAT action costs: an `adjust_cost` row
  (`cost_resource`/`cost_operation: add`/`cost_amount`) folds into the action's
  cost, shows on the card's cost bullet, and is debited once at RESOLVE. A
  `consume_resource` row debits immediately when the reaction fires, so the player
  pays before the action commits and the card never shows the real total. A
  POSITIVE delta may seed a resource the action doesn't natively charge (a
  surcharge on a free Attack); a discount / waive still can't conjure one.
  *(Barrage; Cataclysm's overcharge; Hypercognition's discount is the same row
  with a negative amount.)* Affordability for such a purchase is gated where the
  player commits to it, since no in-chain debit remains to abort on an empty pool.

## C. Reactions & UI phase

- **C1 — The trigger's phase picks the UI, not the author.** Pre-resolve
  (manipulates the pending action) → pills on the action card. Post-resolve
  (Counterattack, Absorb MP, Painful Lesson) and standalone (turn/round
  start/end) → token-anchored menu.

- **C2 — Add a missing trigger as a new canonical trigger** (with subject side +
  filter matrix + template dropdown entry) rather than hardcoding behavior in the
  engine.

## D. Player choices & UX

- **D1 — A choice that feeds an effect AMOUNT must be captured pre-card
  (`pre_activate_effect_ref`), never mid-chain.** Pre-card picks are frozen with
  the dice, so preview == commit; a mid-chain `VAR_` read at COMPUTE resolves to
  0 and the engine throws. *(Elemental Shard / Meteor Shower:
  `prompt_element` → pre_activate.)*

- **D2 — Options / pickers surface before the action card**
  (`open_action_menu`, element/number prompts). Mid-chain prompts are allowed
  ONLY when their value never feeds an effect amount.

- **D3 — AE naming = skill name verbatim; multi-option uses `Skill (Option)`.**
  "Aura" not "Aura'd"; "Reinforce (Dazed)".

## E. Active Effects

- **E1 — AEs fired via `apply_ae` set `transfer:false`;** only always-on passives
  use `transfer:true`.

- **E2 — AEs need a non-empty `statuses:["fud-<slug>"]`** or the token-icon ring
  won't render.

- **E3 — Buffs/debuffs self-tag** `system.tags:["buff"|"debuff"]`. Untagged =
  "Other" — not cleansable, doesn't count toward status counts.

- **E4 — Read actor stats with `${fetchFromParent('prop')}$`; read the bearing
  skill's SL with bare `${level}$`.** `target.X` / `ref()` / bare names are
  unreliable for actor props.

- **E5 — Limited-use behavior uses the existing `charges` / `chargesMax` /
  `chargeKey` + `consume_charge`,** never a per-skill counter prop. The AE
  auto-deletes at 0.

- **E6 — To SHOW a charge count on the token, rely on the AEM charges-badge —
  do NOT touch the `statuscounter` module.** `ActiveEffectManager-charges-badge.js`
  auto-renders `flags["fabula-ultima-companion"].charges` as a number in the
  **top-right** of the AE's token icon whenever `chargesMax !== 1` (hidden for
  `chargesMax === 1`, an on/off effect). So a count-carrying AE just needs
  `chargeKey` + `charges` + `chargesMax (>1 or unset)` **and** a non-empty
  `statuses` (E2 — no icon, no badge). Setting `flags.statuscounter.visible:true`
  renders a SECOND, duplicate badge in the **bottom-right** — never do this for a
  charge count. (The statuscounter module also resets its own flag to defaults
  inside preCreate, so seeding it via create data doesn't stick anyway.) Store a
  rolled/derived value as a charge with `apply_ae` + `ae_initial_charges: "<formula>"`
  (formulas allowed; reads chain VARs), then read it back as `AE_CHARGES_<NAME>`.
  *(Geist's Shadow Strike: roll d12 → apply "Shadow Strike" AE with
  `ae_initial_charges: "VAR_MIG_DIE"` → the roll shows top-right, read later as
  `AE_CHARGES_SHADOW_STRIKE`.)*

## F. Equipment / gear

- **F1 — Gear (weapon / armor / shield / accessory) NEVER carries
  `reaction_config_table` / `effect_table` on its own `system.props`.** Behavior
  lives on a carried `transfer:true` AE (the Ninja Log pattern) **or** a linked
  `_skill` (`system.container = <gearId>`). This holds for weapons too. Sheet
  editors are now visibility-gated off gear item types.

- **F2 — A weapon-scoped `_skill` row sets `reaction_requires_weapon_used:true`**
  so it fires only when that weapon is the acting one (covers the two-weapon and
  monster-attack cases; monsters are `isEquipped:false`).

- **F3 — Never call `reloadTemplate()` after `-=` prop deletions on a
  stored-props gear item** — it re-projects to template defaults and wipes stored
  props. The `-=` update alone removes the key cleanly.

## G. Formulas & previews

- **G1 — In `deal_damage`, victim-relative ids (`MAX_HP` / `CUR_HP` / affinity)
  resolve against the TARGET; in `grant`, against the CASTER.** Preview must use
  the same resolver per kind, or the card shows one number and apply deals
  another. *(Flame Claw once previewed 22 and dealt 11.)*

- **G2 — Two formula evaluators exist** (BD = `skill-formulas.js`; passive AE =
  `oni.ReactionFormula`). Authoring a formula on the wrong side silently yields 0.

## H. Engine philosophy

- **H1 — Prefer reusing / generalizing an existing primitive over a new narrow
  engine field.** Decision order: (1) existing effect_kind / AE / identifier via
  authoring alone; (2) generalize an existing mechanism by one knob; (3) last
  resort, a new field — and then grep EVERY seam that reads the concept (display
  headline AND mechanics AND downstream payload). *(Ripples' `element_override`
  had a second headline seam that silently diverged.)*

- **H2 — No-hardcode test:** if you can't build a similar skill without engine
  edits, build the declarative knob first. No per-skill custom JS, no engine
  branching on skill name / UUID.

## I. Process

- **I1 — RAW text comes from `reference/skills.json` first** — never re-grep the
  PDFs; surface any drift back into the JSON.

- **I2 — Author via a data migration** (idempotent, BD-tree, edit master → sync
  copies) or `CreateSkillFromSpec` — not the CSB UI.

- **I3 — Add template columns before writing new props** (writes to undeclared
  columns are silently stripped): one line in `template-field-registry.js`, with
  the mandatory CSB version bump.

- **I4 — Verify with the director harness before asking for a playtest**
  (`runDirectorSkillCompute` / `runDirectorSkillSimulate`). Don't launch a combat
  for what the harness can model.

- **I5 — Set `level:1`, an explicit `max_level`, and `isHeroic:true` for
  heroics** — never rely on template defaults.

- **I6 — Share by pushing world data on the USER's call, not via migrations;** run
  `world-export report` before any `worlds/` commit.
