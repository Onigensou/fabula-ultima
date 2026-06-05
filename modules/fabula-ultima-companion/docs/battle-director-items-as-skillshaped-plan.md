# Items as skill-shaped — Item Action plan (B.2)

Status: **DESIGN — not yet implemented.** 2026-06-06.
Sibling of [battle-director-resolveaction-unification-plan.md](./battle-director-resolveaction-unification-plan.md)
and the weapons precedent (`project_weapons_as_skillshaped` memory).

## Goal

Make **consumables carry their own effect + targeting data directly on the item**
(skill-shaped), using the **same schema keys as Skill/Equipment/weapons**
(`skill_target`, `defense_target_type`, `effect_table`, fire-point refs). The
Item action then reads targeting from the chosen consumable, runs a target
picker, and resolves the consumable's effect through the single `resolveAction`
pipeline — finally routing **Item** through `resolveAction` (the last action that
isn't, post Phase 7).

User direction (2026-06-06): "each item should have its own target data, use the
same key as Equipment/Skill" + "effect lives directly on the item."

## Current state (measured live, 2026-06-06)

- Consumables today are **resource-only**: pick → debit quantity (use) / IP
  (create) → fire any *linked* skill **on self** (`fireLinkedSkillFromItem`
  hard-caps `targets:[casterSnap]`).
- **No consumable carries targeting data, and none has a linked skill** — every
  one probed (`Grape Juice`, `Decoy Doll`, `Phoenix Feather`, `Life Charm`, …)
  returned `skill_target/defense_target_type ABSENT` and `linkedSkills: []`.
  So there is nothing for a picker to read yet; the self-cap is moot.
- The `item-resource.js` header + the Item TARGET comment still say "skill
  invocation deferred to Phase B" — **stale**; linked-skill firing is wired
  (self-only). Update these comments as part of this work.

## Key architecture fact — the template surgery is (mostly) already done

Consumables and weapons are BOTH `equippableItem` on the **same `_Item Template`
(ZoiV53VaLzeRsEps)** (confirmed: `sameTemplate: true`). The
weapons-as-skillshaped migrations already added to that shared template:
- `skill_target` (textField, default "One Enemy") — **column exists**; weapons
  have values, consumables just never materialized it (they weren't
  `reloadTemplate`'d). No new surgery — author + reloadTemplate consumables.
- `skill_effects_panel` (→ `effect_table`) + `reaction_config_panel`
  (→ `reaction_config_table`) wrapping panels — **exist on the template**;
  empty dynamic tables simply don't appear in `system.props` until they have
  rows (same as skills). No new surgery — author rows.

**`defense_target_type` is ABSENT from `_Item Template` entirely** (weapons don't
use it — an attack derives DEF/MDEF from the weapon's attack profile). It is the
ONLY genuinely-new column, and is needed ONLY for *offensive/thrown* items that
roll against a defense. Recovery/remedy items target an ally/self with no Check,
so the MVP does **not** need it. → defer `defense_target_type` surgery to the
offensive-items phase.

Net: the common case (recovery on ally/self) needs **no template surgery** —
only a data-authoring migration + the Item-action picker. This also keeps us off
the AE-hub Items the parallel migration instance owns.

## Design

### Data shape on a skill-shaped consumable
A consumable carries, on the item itself:
- `skill_target` — "Self" | "One Ally" | "One Creature" | "One Enemy" | "Up to N …"
  (same vocabulary the Skill/weapon targeting resolver already parses).
- `isCheck: false` for auto-apply recovery (no roll); `true` later for offensive.
- `effect_table` rows — the actual effect (e.g. `grant` HP via a recipe, or
  `apply_ae` a remedy/cure), with an `on_activate_effect_ref` fire-point.
- Existing `type_damage`/`damage_bonus`/`rolled_atr1/2` stay for offensive items.
- (later, offensive only) `defense_target_type`.

The Item action's "effect" = the consumable's own `effect_table` (NOT a linked
skill). `gatherConsumables` stops needing `skillUuids`/`skillNames` for behavior
(keep them only for display of any legacy links, or drop).

### getRuntimeActionView
`getRuntimeActionView(consumableItem)` must classify a consumable to a kind the
Item RESOLVE path uses. Two options (pick in impl):
1. Keep `kind: "Item"` from the card; pass the consumable as `opts.actionSkill`
   to `resolveAction` so its `effect_table`/`skill_target` drive the resolve
   (mirrors how Guard/Hinder pass the Common item). **Preferred** — minimal view
   changes; Item stays its own kind for the card/cost step.
2. Classify consumables as a first-class view kind. More churn; not needed.

### Pipeline changes
- **TARGET** (`command === "Item"`): unchanged gather; do NOT auto-target self.
  Targeting is deferred to after the card pick (we don't know which item yet).
- **CONFIRM / card**: after the player picks a consumable, read its
  `skill_target`. If it targets others (not "Self"), invoke the existing JRPG
  picker (`requestTargeting` in `target-picker.js`/`jrpg-targeting-system`),
  honoring disposition (ally vs enemy) from `skill_target`. Stash
  `ar.itemTargetTokenUuids`. "Self" items skip the picker (no regression).
- **RESOLVE** (`ar.kind === "Item"`): keep the **cost step** (consume 1 quantity
  for use / `spendIp` for create — intrinsic Item bookkeeping), then call
  `resolveAction(director, ar, { actionSkill: consumableItem, skipCost: true })`
  with `ar.targets` = the picked targets. resolveAction fires the consumable's
  `effect_table`/damage against them — **Item now routes through resolveAction**.
- **`fireLinkedSkillFromItem`**: becomes legacy. Either delete (no items use
  linked skills) or keep behind a "linked skill present" check for backward
  compat. Drop the `targets:[casterSnap]` self-cap regardless.

### Cost model
- Use: consume 1 unit (`consumeOne`) — already correct.
- Create: `spendIp(cost)` — already correct.
- The effect then fires with `skipCost:true` (the item/IP WAS the cost), exactly
  like the current linked-skill call.

## Phases

**Phase I-1 — Recovery MVP (no surgery).**
- [ ] Migration `…-consumable-skillshape-author`: for each recovery/remedy
      consumable, set `skill_target` (default "One Ally"; "Self"-only where
      appropriate) + author an `effect_table` (`grant`/`apply_ae`) +
      `on_activate_effect_ref`; `reloadTemplate` touched consumables so sheets
      render. Idempotent; **world-data-free** (JS migration, never commit
      `worlds/` LDB — [[feedback_world_data_sharing_hazard]]). Include the
      version-sync stamp ([[feedback_csb_template_version_sync]]).
- [ ] TARGET: stop auto-self-targeting Item.
- [ ] CONFIRM: post-pick `requestTargeting` gated on `skill_target` ≠ Self.
- [ ] RESOLVE: cost step + `resolveAction({actionSkill: consumable})`.
- [ ] Update stale `item-resource.js` / TARGET comments.
- [ ] Verify (Playwright safe harness, on THROWAWAY targets per
      [[feedback-live-world-writes-via-playwright-hazard]]): use a recovery item
      on an ally → ally HP rises, quantity decrements, no commit leak; Self item
      skips picker; create spends IP + fires effect.

**Phase I-2 — Offensive/thrown items (adds the one new column).**
- [ ] Template surgery: add `defense_target_type` to `_Item Template`
      (+ version stamp). This is the only genuinely-new column.
- [ ] Author offensive consumables (`isCheck:true`, `defense_target_type`,
      `type_damage`/`damage_bonus`, perTargetResults via resolveAction's damage
      loop — already action-agnostic post-Phase-7).
- [ ] Multi-target items (`skill_target: "Up to N …"`) if desired.

## Open questions for the user
1. **Authoring source for consumable effects** — is there a canonical list of
   FU consumables + their effects (e.g. in `reference/`) to author from, or do we
   hand-author the party's current inventory (Grape Juice, Apple Juice, Decoy
   Doll, Phoenix Feather, Life Charm, Golem Soulstone, Polymorph Potion…)? Some
   of these are clearly homebrew (Love Potion, Spicy Cocktail) and need their
   intended effect specified.
2. **Phase I-2 now or later?** MVP (recovery/ally) needs no surgery; offensive
   items need the `defense_target_type` column.

## Coordination
- `defense_target_type` surgery (Phase I-2 only) touches `_Item Template`; the
  Phase I-1 MVP does not. Stay off the AE-hub Items owned by the parallel
  AE-migration instance.
- Ship all consumable data as JS migrations (create/patch + `reloadTemplate`),
  never as committed world data — same delivery model as BD skills
  ([[bd-skills-snapshot-restore]]) and the in-flight AE-migration system.
