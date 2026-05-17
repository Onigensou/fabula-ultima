# Sample Objects — live world data snapshots

This folder holds JSON exports of real Items and Actors from the running
world. They exist so a fresh Claude instance can inspect actual live game
data — `system.props`, `custom_logic_*` bodies, embedded `effects[]`,
reaction configs, etc. — without spinning up the test-bridge or
brace-walking LevelDB shards.

## When to read these files

- You need to see the *real* shape of a skill's `system.props` (e.g. what
  `reaction_config_table`, `post_damage_effect_ref`, `custom_logic_resolution`
  look like as authored data) and the world is closed or the bridge is
  asleep.
- You want to compare a world Item against its actor-embedded copy.
- You're writing a migration and need a real-world fixture to validate
  against.

For *live* state (current HP, applied effects, recent rolls), use the
test-bridge instead — these snapshots are point-in-time and drift the
moment the user saves an edit in Foundry.

## What's in this folder

| Filename pattern                       | What it is                                           |
| -------------------------------------- | ---------------------------------------------------- |
| `[Item] <Name>.json`                   | A world Item (`game.items` master copy).             |
| `[Item] <Name> (Embedded Object).json` | The actor-embedded copy of the same logical skill.   |
| `[Actor] <Name>.json` / `Actor_<Name>.json` | A full Actor export (items, effects, props, ...).   |

Draconic Roar is committed twice on purpose — the pair documents the
**world master vs. actor-embedded copy** distinction. Compare:

- `[Item] Draconic Roar.json` → `_id` `g3r4oZYBrA3O9ssW`, no `container`,
  `system.uniqueId === _id` (self-referential = master).
- `[Item] Draconic Roar (Embedded Object).json` → different `_id`, has
  `container` (the parent actor's folder id), `system.uniqueId` points to
  its own `_id` not the master. Ownership defaults differ too.

The "Foundry works on copies" memory and `reference_skill_template_links`
both apply here — actor copies are loosely linked to their master via
`system.template` + `system.uniqueId`, but each is its own document with
its own id.

## How to read the JSON

These are standard Foundry document exports — same shape that
`document.toCompendium()` and right-click → Export Data produce.

Important fields for FU Companion work:

- `system.props.*` — where the companion stores skill mechanics
  (`reaction_config_table`, `custom_logic_action`,
  `custom_logic_resolution`, `effect_table`, `post_damage_effect_ref`,
  `animation_script`, the passive-bonus formulas, etc.).
- `effects[]` — embedded ActiveEffects on the document. Each has its own
  `flags["fabula-ultima-companion"].reactionConfig` if it's a reaction
  AE.
- `_stats` — Foundry creation/modification timestamps. Useful for spotting
  stale snapshots (compare to `git log` for the file).

### Rich-text fields are HTML-encoded

`custom_logic_action`, `custom_logic_resolution`, `animation_script`, and
any other field authored via a CSB rich-text editor are stored as HTML:
`<p>...</p>` wrappers with `&amp;`, `&lt;`, `&gt;`, `&quot;` entities. To
actually read the embedded JavaScript:

1. Strip `<p>` / `</p>` tags (each line is wrapped).
2. Un-escape the HTML entities (`&gt;` → `>`, `&lt;` → `<`, `&amp;` → `&`,
   `&quot;` → `"`).

A quick PowerShell helper:

```powershell
$raw = (Get-Content '[Item] Draconic Roar.json' -Raw | ConvertFrom-Json).system.props.custom_logic_resolution
[System.Web.HttpUtility]::HtmlDecode($raw) -replace '</?p>', "`n"
```

## How a new dump gets produced

**Manual (current workflow).** In Foundry's sidebar:

1. Right-click the Item or Actor → **Export Data**.
2. Browser downloads `fvtt-Item-<Name>.json` (or `fvtt-Actor-...`).
3. Move the file into this folder.
4. Rename to the convention above: `[Item] <Name>.json` for a world Item,
   `[Item] <Name> (Embedded Object).json` for an actor-embedded copy,
   `[Actor] <Name>.json` for a full actor.
5. Commit. (`git add` the new file; a co-Claude in another session can
   read it on the next pull.)

**Programmatic alternative** (when the bridge is awake). The test-bridge
`evalGM` handler can dump a document by id directly to a file you specify
in the eval body. Useful if the user asks for "all skills with
`post_damage_effect_ref`" rather than one specific skill. See
`reference_test_bridge` and the bridge protocol in
[modules/fabula-ultima-companion/scripts/_test-bridge.js](../../scripts/_test-bridge.js).

## Gotchas

- **Snapshots drift.** If the user edited the Item in Foundry after the
  JSON was committed, the file is stale. Cross-check `_stats.modifiedTime`
  in the JSON against the file's `git log` — if the user's session is
  more recent, ask them to re-export.
- **Don't edit these files to "fix" gameplay.** They're snapshots, not
  source of truth. Per [CLAUDE.md](../../../../CLAUDE.md), live data
  lives under `worlds/`. Edits here change nothing in the running world.
- **ActiveEffect UUIDs inside custom-logic bodies are world-specific.**
  Strings like `"Item.XVOWOq9oUmEECGrU.ActiveEffect.nGDTBPQ9omhKG3rM"`
  reference documents in *this* world. If you're authoring a new skill
  for a different world, those ids won't resolve.
