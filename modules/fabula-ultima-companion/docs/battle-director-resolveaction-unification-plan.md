# Battle Director — `resolveAction` Unification Plan

**Goal:** every turn-menu action (Attack, Skill, Spell, Guard, Hinder, Study,
Item, Equipment) flows through ONE pipeline:
1. **Read** the data (equipment / skill / built-in) via a single `getRuntimeActionView()`
2. **Select target** via `resolveActionTargets` (already shared)
3. **Produce an Action Card** (`postActionCard`, already shared)
4. **Resolve** via a single `resolveAction()` (renamed from `resolveSkillAction`)

This doc is the **execution spec for an autonomous overnight run.** It survives
compaction — read it + the `[[project_resolveaction_unification]]` memory first.

---

## Current state (already shipped, verified live, UNCOMMITTED)

- **Weapons are skill-shaped** ([[project_weapons_as_skillshaped]]): weapon Items
  carry `effect_table` + `reaction_config_table` + `skill_target`; on-hit effects
  fire via `creature_deals_damage` → `findPassiveCandidates` → `effect_table`.
- **Engine primitives added** (`skill-formulas.js`): `chance(N)` function +
  `HIT_MARGIN` identifier; attack per-target `creature_deals_damage` payload
  carries `total/hr/isCrit/hitMargin`.
- **3 migrations** live: `2026-06-05-weapon-skillshape-template` (clones the
  skill-effects + reaction-config PANELS into `_Item Template`),
  `-backfill`, `-onhit-convert`.
- Verified: all 4 players attack (Keren dual-wield, Blanche Twin Shield virtual,
  Hina, Zarg); HIT_MARGIN + chance gates work; sheets render the new tables.

**What's still bespoke** (the work this plan does): Guard / Hinder / Study /
Equipment have hand-written RESOLVE branches; Attack & Item run parallel paths
that share the engine but don't call the resolver. See the comparison table in
`battle-director-dev-guide.md` §Action-unification (or the chat that produced this).

---

## Target architecture

### A. `getRuntimeActionView(source, ctx)` — generalize `getRuntimeSkillView`
File: `scripts/battle-director/skill-recipes.js` (or a new `action-view.js`).
Returns a uniform view for ANY source:
```
{ source,                 // the Item (skill/weapon) or a built-in descriptor
  kind,                   // "Skill"|"Spell"|"Attack"|"Guard"|"Hinder"|"Study"|"Item"|"Equipment"
  effect_table,           // rows (authored, recipe-synthesized, or built-in)
  reaction_config_table,  // optional
  fire_points,            // { on_activate_effect_ref, post_damage_effect_ref }
  cost,                   // serialized cost map
  check_mode,             // "opposed"|"open"|"difficulty"|"none"
  roll_atrs,              // {A1,A2} when rolling
  defense_target_type,    // "def"|"mdef" (opposed only)
  skill_target }          // targeting text
```
- Skill/Spell → today's `getRuntimeSkillView` output mapped in.
- Weapon → weapon profile + its `effect_table`/`reaction_config_table`.
- Guard/Study/Hinder/Item/Equipment → **built-in descriptors** (a small registry,
  `ACTION_DEFS[kind]`) that synthesize the effect_table + check_mode. Mirrors how
  `skill-recipes` synthesizes rows — author once in code, no world data needed.

### B. `resolveAction(director, ar, opts)` — rename `resolveSkillAction`
File: `scripts/battle-director/state-handlers.js:258`.
- Keep the existing skill flow; generalize the reader to `getRuntimeActionView`.
- Steps: debit cost → `fireActivationEffect` → per-target damage (`applyDamageToTarget`)
  → `firePostDamageEffect` → walk remaining `effect_table` → queue post-resolve triggers.
- RESOLVE.onEnter's per-`kind` `switch` collapses to `await resolveAction(director, ar)`
  once each action is converted. Keep `resolveSkillAction` as a thin alias during
  migration; remove when all callers are gone.

### C. New `effect_kind`s (`skill-effects.js` `applyEffectRow` switch)
- `encyclopedia_record` — Study: write the studied tier to the target's encyclopedia
  (wrap `encApi.recordWitnessedAction` / the journal-page flag write at RESOLVE top,
  `recordNpcActionWitness`). Reads `payload.subject*` + the computed tier.
- `equip_swap` — Equipment: wrap `applyEquipmentSwap(actor, selections)` (equipment-swap.js).
  Reads selections from `ar.equipmentSelections`.
- Status apply = reuse `apply_ae`. Fold the Hinder same-status dedup
  (state-handlers.js Hinder branch ~3902) into `apply_ae`'s `ae_duplicate_mode`
  (add a `replace_same_status` mode) so Weak+Slow coexist but Slow replaces Slow.

### D. New `check_mode`s (COMPUTE roll resolver, `skill-formulas`/COMPUTE)
- `opposed` (default) — vs DEF/MDEF. Exists.
- `open` — Study: roll, compare total to fixed tier thresholds (no defense).
- `difficulty` — Hinder: roll vs a DL field (`check_difficulty_level`), success = total≥DL or crit, not fumble.
- `none` — Guard/Item/Equipment: no roll.
COMPUTE.onEnter's per-kind branches collapse to a `rollForCheckMode(view, ctx)` helper.

### E. Pre-COMPUTE parameter pickers (registry)
Weapon-mode (Attack), attribute-pair (Hinder/Study), item-pick (Item), cover-ally
(Guard) become entries in a small picker registry invoked in TARGET, results
stamped into `ctx`. (Most already exist as standalone pickers — just route them
through one seam.)

---

## Execution phases (easiest-first; verify each before the next)

### Phase 0 — infra (no behavior change)
- [ ] Rename `resolveSkillAction` → `resolveAction` (+ alias). Grep callers:
      `state-handlers.js` (Skill branch, fireLinkedSkillFromItem), `_test-harness-director.js`.
- [ ] Add `getRuntimeActionView` (skill path identical output to today).
- [ ] Add `ACTION_DEFS` registry skeleton.
- [ ] Verify: Skill/Spell + Attack + Item still pass existing harness sims
      (no regression) — reuse `tools/fvtt-playwright/scripts/verify-players-attack.mjs`
      + a skill sim.

### Phase 1 — Guard  (Low)
- [ ] `ACTION_DEFS.Guard`: check_mode none; effect_table = 2 `apply_ae` rows
      (Guard self AE → target_ref self; Covered AE → target_ref the cover ally).
      Carry the AE templates as built-in effectData (reuse the buildEffectData
      blocks at state-handlers ~3572). `creature_guards` trigger already wired.
- [ ] RESOLVE Guard branch → `resolveAction`.
- [ ] Verify: harness Guard (self AE stamped, Covered AE on ally, creature_guards
      fires, 1-turn expiry intact). Cover + no-cover cases.

### Phase 2 — Item  (Low)
- [ ] Formalize: cost = consume quantity (use) / IP (create) via a cost step;
      linked skill via existing `fireLinkedSkillFromItem` (already `resolveAction`).
- [ ] RESOLVE Item branch → `resolveAction` (the consume + invoke as effect rows).
- [ ] Verify: use (consumable count decrements, linked skill fires) + create (IP
      spent, linked skill fires).

### Phase 3 — Hinder  (Medium)
- [ ] `check_mode: "difficulty"` + `check_difficulty_level` (default 10).
- [ ] `apply_ae` `replace_same_status` dedup mode (fold the registry workaround).
- [ ] `ACTION_DEFS.Hinder`: effect_table = `apply_ae` of the picked status
      (status pick stays a card button → `ar.statusValue` → row's ae_template_ref).
- [ ] RESOLVE Hinder branch → `resolveAction`.
- [ ] Verify: success applies status (3-round), fail/fumble applies nothing,
      Weak+Slow coexist, Slow replaces Slow.

### Phase 4 — Equipment  (Low–Med)
- [ ] `effect_kind: equip_swap` wrapping `applyEquipmentSwap`.
- [ ] `ACTION_DEFS.Equipment`: check_mode none; effect_table = 1 `equip_swap` row.
- [ ] RESOLVE Equipment branch → `resolveAction`.
- [ ] Verify: swap commits (items/AEs/actor props), no-op when no change.

### Phase 5 — Study  (Medium)
- [ ] `check_mode: "open"` + tier thresholds (Identity≥7, Stats≥8, Details≥13;
      confirm against current Study COMPUTE).
- [ ] `effect_kind: encyclopedia_record`.
- [ ] `ACTION_DEFS.Study`: effect_table = 1 `encyclopedia_record` row.
- [ ] RESOLVE Study branch → `resolveAction`.
- [ ] Verify: tier recorded on the target's encyclopedia; fumble blocks record;
      best-tier-improves logic intact.

### Phase 6 — Attack  (Hardest; last)
- [ ] `getRuntimeActionView` for a weapon → view with damage + on-hit `effect_table`.
- [ ] Weapon-mode = source picker; two-weapon = `multi_pass` count on the view
      (the CLEANUP→COMPUTE loop reads it); virtual attacks = a source variant.
- [ ] Keep affinity / forced-VU / pierce in the shared damage step (they already
      apply to spells too).
- [ ] RESOLVE Attack branch → `resolveAction`.
- [ ] Verify (the big one): single-target, dual-wield (Keren), virtual (Blanche),
      ranged (Zarg), AoE weapon (skill_target "All Enemies"), on-hit effects
      (Muscly Arm Conquer, Poison chance), affinity (VU/RS/IM/AB), pierce-on-miss.

### Phase 7 — regression + cleanup
- [ ] Remove the now-dead per-kind RESOLVE/COMPUTE branches + `resolveSkillAction` alias.
- [ ] Full regression bundle: all 8 actions × the 4 players / enemies, compare to
      pre-unification behavior (damage numbers, AEs applied, triggers fired).
- [ ] Update `battle-director-dev-guide.md` §9 ("where to look first") + the action
      comparison table. Update memory.

---

## Verification protocol (every phase)

- Driver: `tools/fvtt-playwright/` (headless, GM has NO password). Server must be
  running; GM seat free (overnight = user not logged in).
- Use `runDirectorSkillSimulate` / `runDirectorAttackSimulate` (COMPUTE+RESOLVE
  with `Actor/Item/AE.prototype` write-capture — **nothing commits**) to assert
  effects without mutating the world. For built-in actions add harness entry
  points if needed (`runDirectorActionSimulate({kind,...})`).
- Pattern: write `scripts/verifyN-<action>.mjs`, run, read JSON, assert. Reuse the
  `verify-players-attack.mjs` shape.
- **Cross-module edits** (state-handlers ↔ skill-effects) need a true hard reload
  (`fvtt.hardReload()`) — Playwright launches cache-disabled, so its reload busts
  the ESM cache (the bridge reload does NOT).
- Per-action gate: the unified path must reproduce the bespoke path's result
  (same damage/AEs/triggers) before deleting the bespoke branch.

## Safety / constraints

- **Never commit world LevelDB** ([[feedback_world_data_sharing_hazard]]). Module
  code + migrations only, and only when the user asks.
- One action at a time; keep the bespoke branch until its unified path is verified,
  then remove (so a failure is isolated + revertible).
- Migrations idempotent; built-in ACTION_DEFS are code (no world data needed),
  reducing migration risk.
- If the GM seat is held (user logged in), pause Playwright verification and
  continue code work; note it and resume when free.
- Syntax-check every edited file (`node --check`) before any live reload.

## Progress log (update as you go)
- (not started) — begin at Phase 0.
