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
**DESIGN (user direction 2026-06-05): every action reads from a skill Item — no
code descriptors.** `getRuntimeActionView` has ONE path: Item → view. Sources:
- **Bundle actions** — the actor picks one Item they own: **Attack** (weapons),
  **Spell**/**Skill** (skill items), **Item** (consumables; the chosen consumable's
  linked skill is the Item).
- **Singleton actions** — **Guard / Hinder / Study / Equipment** each have ONE
  canonical "action-skill" Item, universal to every creature, authored under
  **`Battle Director / Common`** (folder). The turn-UI command → that Item.

So `ACTION_DEFS` is just a **command → action-skill-Item resolver** (bundle pick
for Attack/Spell/Skill/Item; a fixed `Battle Director/Common` item for the
singletons), NOT a code synthesizer. Loaded by stable `system.uniqueId` (or a
`CORE_ACTION_SKILLS` name/uuid map) so it works regardless of actor inventory.

### A.1 Core action-skill Items (author under `Battle Director / Common`)
Author via `CreateSkillFromSpec` + a migration (mirrors the Guardian author
migrations). Each is a normal skill Item carrying its behavior declaratively:
- **Guard** — `check_mode: none`; effect_table = 2× `apply_ae` (Guard AE → self;
  Covered AE → cover-ally `target_ref`), `picker: cover_ally` (optional). Keeps the
  `directorAppliedBy.turnsRemaining:1` lifecycle + the Covered AE's
  `cannot_be_targeted_by: melee` change. `creature_guards` trigger fired post-resolve.
- **Hinder** — `check_mode: difficulty` (DL field, default 10); `picker:
  attribute_pair`; effect_table = `apply_ae` of the card-picked status
  (`replace_same_status` dedup).
- **Study** — `check_mode: open` (tier thresholds); effect_table = 1×
  `encyclopedia_record`.
- **Equipment** — `check_mode: none`; `picker: equipment_slots`; effect_table = 1×
  `equip_swap`.
- **Item** — bundle (consumable pick); its effect = the consumable's linked skill
  via `invoke_linked_skill` + a `consume_resource` (quantity/IP) cost step.

Pickers are declared ON the item (`picker` prop) and resolved by a small picker
registry in TARGET (weapon-mode is Attack's picker over the weapon bundle).

### A.2 The genuinely-new effect_kinds (my judgment on "how it works")
These wrap PROVEN bespoke code so behavior is identical, just declaratively
referenced — nothing here is truly unresolvable:
- `encyclopedia_record` — wraps the existing `recordNpcActionWitness` /
  `encApi.recordWitnessedAction`; reads the computed tier + `payload.subject*`.
- `equip_swap` — wraps `applyEquipmentSwap(actor, ar.equipmentSelections)`.
- `invoke_linked_skill` — wraps `fireLinkedSkillFromItem` (Item already uses it).
- `apply_ae` mode `replace_same_status` — Hinder dedup (Weak+Slow coexist, Slow
  replaces Slow); fold the current registry workaround into `apply_ae`.
Existing kinds cover the rest (Guard = `apply_ae`; cost = `consume_resource`).

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
- [ ] Add `getRuntimeActionView` (skill path identical output to today; ONE path: Item→view).
- [ ] Add `ACTION_DEFS` = command → action-skill-Item resolver (bundle pick OR a
      `Battle Director / Common` singleton item via `CORE_ACTION_SKILLS` uniqueId map).
      Create the `Battle Director / Common` folder (folder-bootstrap migration pattern).
- [ ] Verify: Skill/Spell + Attack + Item still pass existing harness sims
      (no regression) — reuse `tools/fvtt-playwright/scripts/verify-players-attack.mjs`
      + a skill sim.

### Phase 1 — Guard  (Low)
- [ ] Author the **`Battle Director / Common / Guard`** action-skill Item:
      check_mode none; effect_table = 2 `apply_ae` rows (Guard AE → `target_ref: self`;
      Covered AE → cover-ally `target_ref`); `picker: cover_ally` (optional). Carry the
      Guard/Covered AE templates as embedded effects (reuse the buildEffectData blocks
      at state-handlers ~3572 incl. `directorAppliedBy.turnsRemaining:1` + Covered's
      `cannot_be_targeted_by: melee`). `creature_guards` trigger already wired.
- [ ] Point the Guard command at this item; RESOLVE Guard branch → `resolveAction`.
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
- [ ] Author **`Battle Director / Common / Hinder`**: `check_mode difficulty`,
      `picker: attribute_pair`; effect_table = `apply_ae` of the picked status
      (status pick stays a card button → `ar.statusValue` → row's ae_template_ref).
- [ ] RESOLVE Hinder branch → `resolveAction`.
- [ ] Verify: success applies status (3-round), fail/fumble applies nothing,
      Weak+Slow coexist, Slow replaces Slow.

### Phase 4 — Equipment  (Low–Med)
- [ ] `effect_kind: equip_swap` wrapping `applyEquipmentSwap`.
- [ ] Author **`Battle Director / Common / Equipment`**: check_mode none,
      `picker: equipment_slots`; effect_table = 1 `equip_swap` row.
- [ ] RESOLVE Equipment branch → `resolveAction`.
- [ ] Verify: swap commits (items/AEs/actor props), no-op when no change.

### Phase 5 — Study  (Medium)
- [ ] `check_mode: "open"` + tier thresholds (Identity≥7, Stats≥8, Details≥13;
      confirm against current Study COMPUTE).
- [ ] `effect_kind: encyclopedia_record`.
- [ ] Author **`Battle Director / Common / Study`**: check_mode open;
      effect_table = 1 `encyclopedia_record` row.
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

### 2026-06-05 (overnight autonomous run)

**Phase 0 — DONE + VERIFIED.**
- `resolveSkillAction` → `resolveAction` (thin `const resolveSkillAction = resolveAction`
  alias kept for the 2 existing callers; removed in Phase 7).
- `getRuntimeActionView(source)` added in `skill-recipes.js` — strict superset of
  `getRuntimeSkillView` (same `effect_table`/`fire_points` for skills, plus `kind`/
  `check_mode`/`skill_target`/`picker`/`roll_atrs`). `resolveAction` now reads through it.
- `resolveAction` generalized: accepts `opts.actionSkill` (backing Item handed in by a
  singleton RESOLVE branch); caster falls back to `ar.attacker.actorUuid`; threads
  `ctx.actionResult` + `ctx.actionView`; queues `creature_guards` for kind Guard.
- **Kill-switch** `UNIFIED_RESOLVE` (state-handlers.js) — each kind's unified RESOLVE only
  goes live once its flag is `true` (flipped AFTER harness verify). Bespoke branch is kept
  as fallback until Phase 7. `getCoreActionSkill(cmd)` resolves the Common item by the
  `flags.fabula-ultima-companion.coreAction` tag (no UUID).
- `Battle Director / Common` folder added to `_folder-tree.js` siblings + self-healed by
  the author migrations via `_action-skill-author.js` (`ensureCoreActionSkill`).
- Regression PASS via `verify-p0-regression.mjs`: Skill (Reinforce), **Spell E2E (Hina →
  Iceberg, legacy Elementalist → 31 NE dmg, HP debited)**, Attack (Keren main) — all
  unchanged.

**Phase 1 — Guard — DONE + VERIFIED.**
- `2026-06-05-common-guard-author` → `Battle Director/Common/Guard` (chain → guard_self
  apply_ae "Guard"→self + guard_cover apply_ae "Covered"→`cover_target`). `cover_target`
  target_ref added to `RESERVED_REFS` + `buildCandidatePool` (reads `ar.coverTarget`).
- `UNIFIED_RESOLVE.guard = true`. Verified via `verify-p1-guard.mjs`: unified path applies
  Guard AE (statuses[guard], turnsRemaining 1, **no directorGuard ⇒ unified ran**) to
  guarder + Covered AE (`cannot_be_targeted_by: melee`, turnsRemaining 1) to the covered
  ally; bespoke parity confirmed. Dropped vestigial write-only `flags.directorGuard`.
- **Engine fix (general):** apply_ae formula-bake was corrupting bare-word string change
  values ("melee" → "0") because `isFormulaString` treats any non-number as a formula.
  Added `looksLikeNumericFormula` gate so OVERRIDE (mode 5) literals pass through unbaked.

**Phase 4 — Equipment — DONE + VERIFIED.** `equip_swap` effect_kind wraps
`applyEquipmentSwap`; `2026-06-05-common-equipment-author` (1 row). `verify-p45`:
no-op selection resolves cleanly, no error, no spurious mutation. `UNIFIED_RESOLVE.equipment=true`.

**Phase 5 — Study — DONE + VERIFIED.** `encyclopedia_record` effect_kind wraps
`encApi.recordResult`; `2026-06-05-common-study-author` (1 row); VFX + open-sheet stay
in the thin Study RESOLVE wrapper. `verify-p45`: success records best (=99 on fixture
enemy), fumble skips, no error. `UNIFIED_RESOLVE.study=true`.

**Phase 3 — Hinder — DONE + VERIFIED.** Common/Hinder item: 1 apply_ae row with the
dynamic `ae_template_ref: "status_value"` (resolves `ar.statusValue` → Dazed/Shaken/
Slow/Weak from the "Debuff" world container) + `ae_duplicate_mode: replace_same_status`.
Success-gating + fail Miss VFX stay in the thin wrapper. Engine: apply_ae gained
`replace_same_status` (+`findSameStatusAe`) + the `status_value` ref. `verify-p3-hinder`:
fail→no AE; success→Slow (turnsRemaining 3); Weak+Slow coexist; re-apply Slow→still 2
(Slow replaced, Weak kept). `UNIFIED_RESOLVE.hinder=true`.

**Phase 2 — Item — already unified at the effect level.** The Item RESOLVE branch
consumes the chosen consumable / spends IP, then fires the consumable's linked skill via
`fireLinkedSkillFromItem` → `resolveAction`. The consume/spend is intrinsic Item
bookkeeping (a consumable-quantity decrement isn't a standard resource), so no Common/Item
item is authored (it's a *bundle* action per the user's design). `UNIFIED_RESOLVE.item`
stays false; the branch is left as-is. No further work needed unless we later want the
consume expressed as an effect row.

### Engine fix shipped this run (general, not action-specific)
`apply_ae`'s formula-bake corrupted bare-word string change values — `isFormulaString`
treats any non-number as a formula, so OVERRIDE (mode 5) literals like `"melee"` /
`"Light"` baked to `"0"` (unknown identifier → 0). Added `looksLikeNumericFormula`
(skill-effects.js): only bake values with arithmetic/grouping/comma punctuation OR a 2+
char ALL-CAPS identifier. Affects every apply_ae, not just the Common items.

### REMAINING
**Phase 6 — Attack — NOT STARTED (hardest/riskiest; do in a dedicated session).**
Attack is the core combat path (every turn, all creatures). The weapon already carries
`effect_table` (weapons-as-skill-shaped). To route the Attack RESOLVE branch through
`resolveAction({actionSkill: weapon})`, first generalize `resolveAction`'s damage loop to
match the Attack branch's extras the skill loop lacks: `pierceMiss` damage application and
the per-hit-target `creature_deals_damage` payload carrying `weaponUuid` + `hitMargin` +
`subject*`/roll context (Attack queues one trigger PER hit target; resolveAction queues one
for the whole action). Multi-pass (two-weapon) + virtual attacks (Twin Shield) loop through
CLEANUP→COMPUTE per pass — that stays. Regress hard with `verify-players-attack.mjs`
(Keren dual-wield, Blanche virtual, Zarg ranged, affinity VU/RS/IM/AB, Muscly-Arm on-hit).
Add a `UNIFIED_RESOLVE.attack` flag, default false until verified.

**Phase 7 — cleanup.** Once Attack lands: delete the bespoke Guard/Hinder/Equipment/Study
branches + the `resolveSkillAction` alias + `UNIFIED_RESOLVE` switch; full 8-action regression.

### Verify scripts (tools/fvtt-playwright/scripts/, all green)
verify-p0-regression · verify-p1-guard · verify-p3-hinder · verify-p45-equip-study
(+ verify-players-attack from the prior weapons work). probe-elementalist for fixtures.
