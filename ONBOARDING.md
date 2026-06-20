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
`worlds/fabula-ultima-2/data/`. While the world is open, Foundry holds
an exclusive `LOCK` on each collection.

**Probe game state first** before deciding how to inspect/edit:

```bash
node tools/safe-edit/bin/safe-edit.js check
```

- **Game closed** → use `tools/safe-edit` directly (see "Direct-disk
  edits" below).
- **Game running** → ask the user to run a console one-liner or a
  Foundry macro. (Direct disk writes are blocked by the LOCK — the tool
  refuses to write while the game is open.)

For read-only inspection while the world is open you can also fall back
to the LevelDB shard recipe — grep the shard for the id, copy to temp,
balanced-brace JSON extract — but expect Snappy-compressed values
mid-string. Prefer the macro/console route over wrestling with that.

Skills are stored as items with `type: "equippableItem"`. The actual
behavior fields live under `system.props.*` (e.g. `system.props.cost`,
`system.props.damage_bonus`, `system.props.custom_logic_action`).

## Direct-disk edits — `tools/safe-edit/`

A Node 18+ CLI and library for editing Foundry world data directly via
`classic-level` (the same LevelDB binding Foundry uses). Lets you make
surgical patches without opening Foundry, with backup + structural
validation + journal + rollback baked in.

**Hard requirement:** Foundry must be closed. The tool refuses to write
if any collection holds a `LOCK`.

**CLI:**

```bash
node tools/safe-edit/bin/safe-edit.js check
node tools/safe-edit/bin/safe-edit.js get Item.gTXdzJjV4Lmwfm7i
node tools/safe-edit/bin/safe-edit.js patch Item.gTXdzJjV4Lmwfm7i \
  --patch '{"system.props.damage_bonus": 12}' \
  --note "bump fire bolt damage"
node tools/safe-edit/bin/safe-edit.js log --limit 10
node tools/safe-edit/bin/safe-edit.js rollback 20260512-1430-abcd
```

**Library:**

```js
const { getDoc, safeEdit, rollback } = require("./tools/safe-edit/lib");
const before = await getDoc("Item.xxx");
const res = await safeEdit({
  uuid: "Item.xxx",
  patch: { "system.props.foo": 1 },
  note: "...",
  dryRun: false,
});
await rollback(res.entryId);
```

**Six safety layers per write:** LOCK check → backup → validate → write →
read-back hash verify (auto-rollback on mismatch) → journal append.

**Scope:**

- Top-level world docs only (Actor, Item, Scene, Macro, JournalEntry,
  RollTable, Playlist, Cards, Folder, User, ChatMessage, Combat, Setting,
  FogExploration).
- **Not supported:** true embedded documents (items on an actor, AEs on
  an item, combatants on a combat — they have their own LevelDB keys,
  use a Foundry macro), compendium packs (use Foundry CLI), runtime
  hooks (won't fire — Foundry re-prepares the doc next boot).
- "Embedded" vs "nested": nested JSON inside a `system.*` path on a
  top-level doc IS editable via flat-dotted patches (e.g.
  `{"system.props.reaction_config_table.0.reaction_trigger": "..."}`),
  because it's just JSON inside the parent's LevelDB value. True
  embedded Documents with their own `_id` are not.

**Default behaviour:** when the user asks for a world-doc inspection or
edit, probe `safe-edit check` up front. Don't reflexively prepare a
console snippet — direct-disk is cleaner if the game's closed.

## Submitting world data to a co-dev — `world-export` (READ BEFORE ANY PUSH)

World content is shared between developers by **committing the binary
LevelDB** under `worlds/<world>/data/`. Git can't diff binary, so content
loss is invisible — a stale world re-pushed wholesale silently clobbers the
other dev's authoring (this is how a fully-authored boss moveset was once
rolled back to empty shells with a 2-line textual diff).

`world-export` ([tools/safe-edit/WORLD-EXPORT.md](tools/safe-edit/WORLD-EXPORT.md))
fixes this with a **companion layer**: it exports every authored document to
its own readable JSON under `worlds/<world>/_authored-export/`, so changes are
reviewable and a removed skill shows up as a deleted file. The LevelDB still
ships and is still what Foundry loads — the JSON is a review surface + tripwire.

**Mandatory before any world-data commit/push** (game closed):

```bash
node tools/safe-edit/bin/world-export.js report   # diff vs HEAD; flags losses
```

Review the removals it prints. If anything unexpected would be removed, STOP —
your world is probably stale and you are about to clobber the other dev. Pull +
load the latest world first, or scope your push to only your changed documents.

**One-time setup (per clone — git config is not shared through the repo):**

```bash
git config core.hooksPath tools/safe-edit/hooks
```

This installs a pre-commit hook that blocks any world-data commit which would
lose content. Read [tools/safe-edit/WORLD-EXPORT.md](tools/safe-edit/WORLD-EXPORT.md)
for the full workflow (baselines, `--since-baseline` mid-session tracking, limits).

> **If you use Claude Code / an AI assistant in this repo:** add the line
> `@tools/safe-edit/WORLD-EXPORT.md` to your local `CLAUDE.md` so the workflow
> auto-loads every session, or just tell it once: *"read
> tools/safe-edit/WORLD-EXPORT.md and follow it before any world-data push."*

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
- `reaction_effect_table` — sibling table; each row defines what fires
  when a trigger matches (grant resource, apply AE, consume charge,
  redirect target, chain).
- `custom_logic_action` — author script run mid-pipeline.
- Charges are a separate concern at `FUCompanion.api.charges`.

**Canonical schema reference:**
`modules/fabula-ultima-companion/docs/reaction-config-schema.md`
documents every column of both tables, all 29 trigger keys grouped by
phase bucket, all 5 effect_kinds (`grant`, `apply_ae`, `consume_charge`,
`redirect_target`, `chain`) with per-kind fields, a subject/filter
matrix, and a worked Protect example. Read it before authoring
reaction-bearing skills.

If you're building a new reaction kind, the worked example is the
"Protect" skill (`Item.gTXdzJjV4Lmwfm7i`); it covers
trigger-registration, declarative grants, and the action-card
re-invocation flow.

## Skill authoring — use `CreateSkillFromSpec`

When you want a new skill — especially anything with a non-trivial
`reaction_config_table` — produce a JSON spec and run the
`CreateSkillFromSpec` macro. **Don't** ask the user to duplicate-and-edit
in the CSB UI.

**Why:** each reaction_config row is ~60-90s of CSB dynamic-table UI
clicking, and a complex reaction skill has 4-8 rows. Hand-clicking is
also typo-prone (a misspelled `reaction_trigger` is a silent runtime
bug). The macro accepts a single JSON, creates a fresh
`equippableItem` linked to `_Skill Template`
(`Item.j0F5Msw5RZ8aIB3j`, the structural `_equippableItemTemplate`),
calls CSB's `reloadTemplate()` to materialize the body, writes
`spec.props` on top of the defaults, and adds embedded AEs. It also
warns on unknown trigger keys / effect_kinds / dangling
`reaction_effect_ref` pointers so typos surface immediately.

**Invocation:**

```js
await game.macros.getName("CreateSkillFromSpec").execute({
  __AUTO: true,
  __PAYLOAD: {
    spec: {
      name: "Soulshield",
      img: "icons/svg/aura.svg",
      // templateUuid defaults to _Skill Template; omit unless you have
      // a custom CSB template.
      // actorUuid: "Actor.xxx",  // optional: create on a specific actor
      props: {
        skill_type: "Passive",
        isPassive: true,
        isReaction: true,
        reaction_config_table: { "0": { reaction_trigger: "...", reaction_effect_ref: "..." } },
        reaction_effect_table: { "0": { effect_label: "...", effect_kind: "grant", ... } }
      }
      // activeEffects: [...]  // optional embedded AEs
    }
  }
});
// → { ok, uuid, id, name, warnings: [...] }
```

**Source + JSDoc:**
`modules/fabula-ultima-companion/macros/Authoring/CreateSkillFromSpec.js`.

**Important detail:** the macro forces `system.uniqueId: ""` by default
— the new skill is its own content master. Without this, a future Item
Refresh would overwrite the skill's customizations back to whatever the
template defines. Override via `spec.uniqueId` only if you explicitly
want copy-of-master semantics.

**Limit:** the macro creates the skill but does NOT register it into
any actor's `skill_active_list` / `attack_list`. That's still a manual
drag-and-drop step (or future tooling if it becomes painful).

## Phantasm conventions

Phantasms (creatures summoned by "Create Phantasm: ..." skills) follow
two conventions:

1. **Kind marker:** the Phantasm NPC actor template sets
   `system.props.isPhantasm = true`. Parallels `system.props.isSummon`
   used by the initiative system.
2. **Ownership link:** when a Create Phantasm skill spawns a token, it
   calls `FUCompanion.api.phantasm.markSummon(tokenDoc, summonerActorUuid)`,
   which stamps `flags["fabula-ultima-companion"].summonedBy` on the
   TokenDocument. Reactions like "Phantasmal Echo" that should only fire
   for *the reactor's own* Phantasm read this flag and require it to
   match the reactor's actor UUID.

Helpers (`scripts/phantasm-api.js`):

| API | Purpose |
|-----|---------|
| `FUCompanion.api.phantasm.isPhantasm(actor)` | True if `actor.system.props.isPhantasm`. |
| `FUCompanion.api.phantasm.getSummoner(tokenOrDoc)` | Reads `summonedBy` flag; null if not set. |
| `FUCompanion.api.phantasm.markSummon(tokenDoc, summonerActorUuid)` | Stamps the flag; call once at spawn. |

When authoring reactions that should match "my own Phantasm shattered,"
gate on `isPhantasm` AND `getSummoner === reactorActorUuid`. See the
worked example in the `Phantasmal Echo` skill's custom_logic_action.

## Common recipes

- **Iterating on skill numbers** — use `runActionDryRun`, inspect
  `dryRunReport.damagePlan`.
- **"Why isn't this AE applying?"** — `runActionDryRun`, inspect
  `dryRunReport.aeWouldApply` per trigger (`on_attack` / `on_hit`).
- **Authoring a new skill (especially reaction-bearing)** — produce a
  JSON spec, run `CreateSkillFromSpec` (see "Skill authoring" section
  above). The macro defaults to `_Skill Template`; you only need
  `name` and `props` in the spec for the simplest case.
- **Adding a new payload field** — write it from the earliest stage
  (ADF or ADC), update `docs/action-payload-shape.md` in the same
  change, mirror to `meta` if downstream code shouldn't have to know
  where it lives.
- **Adding a new reaction trigger or effect_kind** — see the "Adding a
  new field" checklist at the bottom of `docs/reaction-config-schema.md`.
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
