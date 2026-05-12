# Onboarding — Fabula Ultima Companion (FoundryVTT)

Quick orient for Claude working in this repo. Read once before answering
questions; cite the deeper docs as needed.

## What this repo is

A Foundry VTT data folder. The primary module under active development is
`modules/fabula-ultima-companion/` — adds custom hooks and gameplay
functionality for the Fabula Ultima TTRPG system on top of CSB
(Compendium System Builder).

**Versions to assume:** Foundry **12.343** + CSB **4.8.5**. Confirm any
API claim against these.

## Where to edit (important)

- **Live runtime/raw data** lives under `worlds/` (currently
  `worlds/fabula-ultima-2/`). When updating templates or raw data, edit
  files in `worlds/` only.
- Files under `modules/fabula-ultima-companion/Game Object/Template/` are
  **placeholders** that ship with the module. They are not loaded by the
  running world and edits to them have no effect on gameplay.
- Exception: if a change is specifically about the module's shipped sample
  template (the starting point for a new world), say so explicitly before
  editing.

See `CLAUDE.md` at the repo root for the canonical rule.

## Where the code lives

All module source is under `modules/fabula-ultima-companion/`:

- `scripts/` — JS modules loaded on world boot via `module.json`.
- `macros/` — Foundry world macros. **Sourced from disk**: every boot,
  `scripts/_module-boot.js` walks `macros/_manifest.json` and upserts
  each macro from its source file into the world's macro directory.
  Edit the **source files**, not the live macros in the Foundry UI —
  manual edits get overwritten on next boot. (Hidden escape hatch:
  `globalThis.__FU_DISABLE_MACRO_SYNC__ = true` in console before reload.)
- `docs/` — module-specific documentation (e.g. action payload shape).
- `Game Object/` — placeholder templates (see above; don't edit for
  gameplay changes).

## Key subsystem: action pipeline

When a player clicks a skill button, the request flows through:

```
ActionDataFetch (ADF) → ActionDataComputation (ADC) → Targeting →
CustomLogic-Action → ApplyActiveEffect → ResourceGate → CreateActionCard
→ (user confirms) → action-execution-core.execute() → AdvanceDamage /
ApplyActiveEffect / reaction emits.
```

A single `cardPayload` object threads through every step. **The schema
grew organically and is non-obvious** — fields live at top-level vs.
`meta` vs. `advPayload` somewhat inconsistently.

**Canonical schema doc:**
`modules/fabula-ultima-companion/docs/action-payload-shape.md` lists
every field with its location, writer, readers, type, and notes. Read it
before guessing where a field lives. When adding a new field, update the
doc in the same change.

## Dry-run harness — use this when iterating on skills

`FUCompanion.api.test.runActionDryRun({ skillUuid, attackerUuid?,
targets? })` runs the same ADF → ADC → execute() pipeline a real action
takes, but **skips every world-mutating call** (MP/IP spend, item
consume, AE apply, damage apply, animations, chat cards, reaction
emits) and returns a structured `dryRunReport` describing what *would*
have happened.

**When to use:** any time you're debugging skill behavior — damage
formulas, accuracy, AE directives, resource costs, target resolution.
Default to the harness rather than asking the user to click through the
UI to reproduce. Each cycle drops from minutes of manual repro to
seconds of automated call.

**Invocation:**

```js
await FUCompanion.api.test.runActionDryRun({
  skillUuid: "Actor.xxx.Item.yyy",      // required
  attackerUuid: "Scene.aaa.Token.bbb",  // optional, defaults to selected token
  targets: ["Scene.aaa.Token.ccc"]      // optional, defaults to user targets
});
// Returns:
// {
//   ok, dryRun, executionMode,
//   executionCoreResult: { hitUUIDs, missUUIDs, savedTargetUUIDs, ... },
//   dryRunReport: {
//     resourceSpendPlan, itemConsumePlan,
//     aeWouldApply: [{ trigger, directives, targetUUIDs, ... }],
//     damagePlan, missPlan, animationPlan,
//     reactionEmitsPlan, skipped: [...]
//   }
// }
```

**V1 limits:**
- Skill branch only (no Weapon attacks, no Item-fastpath consume).
- Resolution-phase author scripts skipped — if a skill mutates the
  payload in `CustomLogic-Resolution` to compute damage, the dry-run
  won't reflect those tweaks.
- Accuracy is rolled fresh each call; no seed API.
- GM only.

Source + JSDoc: `modules/fabula-ultima-companion/scripts/_test-harness.js`.

## Looking up skill / item / actor data

Foundry stores world data as **locked LevelDB shards** under
`worlds/fabula-ultima-2/data/`. They're not human-readable while the
world is open. Recipe to inspect a specific skill/item/actor by id:

1. Grep the shard files in `worlds/fabula-ultima-2/data/items/` (or
   `actors/`, etc.) for the id.
2. Copy the matching `.ldb` shard to a temp location.
3. Read it and run a balanced-brace JSON extract starting at the matched
   id — LevelDB shards are concatenated JSON blobs with binary
   separators.

Skills are stored as items with `type: "equippableItem"`. The actual
behavior fields live under `system.props.*` (e.g. `system.props.cost`,
`system.props.damage_bonus`, `system.props.custom_logic_action`).

## Reaction system

Subsystem that lets passive/declarative skill effects fire in response
to in-world events (turn start, creature hits zero HP, check outcome
flipped, etc.).

Main entry points:
- `scripts/reaction-system/reaction-triggers.config.js` — registry of
  trigger keys and their subject resolvers.
- `scripts/reaction-system/reaction-triggerCore.js` — dispatch.
- `scripts/reaction-system/reaction-grant.js` — declarative-grant
  dispatch (data-driven reaction effects, replacing custom_logic).
- `scripts/passive-system/passive-modifier-engine.js` — passive
  auto-fire.

Per-skill authoring lives in the skill item's `system.props`:
- `reaction_config_table` — declares which triggers the skill subscribes to.
- `custom_logic_action` — author script run mid-pipeline.
- Charges are a separate concern at `FUCompanion.api.charges`.

If you're building a new reaction kind, the worked example is the
"Protect" skill (`Item.gTXdzJjV4Lmwfm7i`); it covers
trigger-registration, declarative grants, and the action-card
re-invocation flow.

## Common recipes

- **Iterating on skill numbers** — use `runActionDryRun`, inspect
  `dryRunReport.damagePlan`.
- **"Why isn't this AE applying?"** — `runActionDryRun`, inspect
  `dryRunReport.aeWouldApply` per trigger (`on_attack` / `on_hit`).
- **Adding a new payload field** — write it from the earliest stage
  (ADF or ADC), update `docs/action-payload-shape.md` in the same
  change, mirror to `meta` if downstream code shouldn't have to know
  where it lives.
- **Adding a new macro** — drop the source file under
  `macros/<category>/`, add an entry to `macros/_manifest.json`. Next
  boot, `_module-boot.js` will upsert it into the world.

## What's not in scope here

- This repo isn't the place to edit the CSB system itself —
  `systems/csb/` is a vendored Foundry system, modify only if a feature
  genuinely requires it.
- The various `modules/` subdirectories other than
  `fabula-ultima-companion/` are upstream Foundry modules; treat them
  as read-only.
