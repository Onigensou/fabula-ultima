# csb-template — edit & validate CSB template trees

A Custom System Builder (CSB) **template** is just a document whose `system.body`
and `system.header` hold a **component tree** — a DOM, basically. Each node is
`{ type, key, …config, contents[] | rowLayout[] }`. This tool lets you edit that
tree like HTML and **verify the edit is valid before it ships**, because CSB
itself validates late and thinly (the only hard failure on load is an
unrecognized `type`; the real rules run only in the editor UI). A malformed tree
persists silently and then misbehaves — this tool is the guardrail.

## The model (what you're editing)

```
system.body   = { type:"panel", key:"custom_body",   contents:[ …nodes… ] }
system.header = { type:"panel", key:"custom_header", contents:[ …nodes… ] }
```

- **Input components** (`textField numberField checkbox select radioButton textArea`)
  each own one `system.props.<key>` → their keys must be **globally unique**.
- **Tables** (`dynamicTable compactDynamicTable itemContainer`) hold COLUMN defs
  in `rowLayout[]`. A table's row data lives at `system.props.<tableKey>.<row>.<col>`,
  so **column keys are scoped to their table** — a column named `category` does
  NOT collide with a top-level `category` field.
- **Containers** (`panel tab tabbedPanel table`) nest children in `contents[]`.
  `tab` is parsed by its `tabbedPanel`, not the component factory.

## Commands

```
node tools/csb-template/bin/csb.js lint      <Item.ID | id | file.json> [--bridge]
node tools/csb-template/bin/csb.js show       <ref> [--key K] [--type T] [--bridge]
node tools/csb-template/bin/csb.js verify     <ref> --bridge      # game OPEN
node tools/csb-template/bin/csb.js roundtrip  <ref> --bridge      # game OPEN
```

**Read source, by game state:**
- default → world **LevelDB** (game CLOSED).
- `--bridge` → live world via test-bridge (game OPEN). On the bridge, `lint` also
  pulls the live `componentFactory` registry so module-added types aren't false
  unknowns.
- `file.json` → a snapshot (`_template-backups/*.json`, module
  `Game Object/Template/*.json`); no DB needed, `lint`/`show` only.

## Two-tier validation

1. **`csb-lint` (offline, exhaustive).** Reproduces CSB's rules and reports
   **every** problem at once: unknown type, bad/missing key, duplicate top-level
   prop key, duplicate column key, missing required config, malformed
   options/rowLayout/contents.
2. **`csb verify` (in-game, authoritative).** Runs CSB's own
   `componentFactory.createOneComponent` on the proposed tree (throws on the
   first unknown type, exactly like load) and lists `getAllProperties()` so you
   can confirm new field keys actually materialize.
3. **`csb roundtrip`** parses → re-serializes both roots and diffs the kept
   top-level field set against the offline model, surfacing any key CSB would
   silently drop.

Use lint as the fast pre-check; verify/roundtrip as the gold-standard gate
before writing.

## Editing as a library (DOM-like)

```js
const { CsbTree, build } = require("./tools/csb-template/lib/tree");
const tree = new CsbTree(doc);                 // doc = whole template object

tree.insertChild("set_panel", build.textField("set_tier", { label: "Tier", colName: "Tier" }));
tree.addColumn("set_bonus_table", build.column("pieces", "numberField", { colName: "Pieces" }));
tree.addOption("skill_type", { key: "Set", value: "🥼 Set" });
tree.setConfig("set_name", { tooltip: "Joins pieces to a Set Definition" });
tree.remove("legacy_field");

const patch = tree.patch();                    // { "system.body":…, "system.header":…, version-bumped }
```

`patch()` always rewrites the **whole** changed top-level field (the only safe
way to persist array edits — flat-dotted paths can't splice arrays) and bumps
`templateSystemUniqueVersion`.

## Writing & the compile caveats (read before you apply)

Persisting the patch is easy; making CSB **render** it has two traps verified in
CSB 4.8.5 source:

1. **A new field/table only compiles after a full page reload (F5).** A template
   master caches its parsed tree (`customBody`) for the session; a raw `update`
   doesn't clear it (`TemplateSystem.prepareData` only rebuilds when it's
   undefined). Bridge `reload` is unreliable — ask the user to F5.
2. **Never call `saveTemplate()` between a raw edit and that reload.** It
   re-serializes the *stale cached* tree and clobbers your edit
   (`TemplateSystem.saveTemplate`).
3. **Data-only props get stripped.** Any `system.props.<x>` with no backing field
   is pruned on `reloadTemplate`. The lint `coverage()` helper cross-checks
   authored/engine-read prop names against the template's field set to catch this.

After writing a master, version-stamp every copy (`system.template === masterId`,
world items + actor-embedded) so they re-derive on reload. `bridge.applyViaBridge`
does the write + stamp (+ optional copy reload) in one in-page pass.

## Game state

The world LevelDB is single-process: **direct (LevelDB) tools need the game
closed; bridge tools need it open.** Check the bridge heartbeat
(`worlds/<world>/test-bridge/state.json` `ready` + fresh `lastHeartbeat`) — but a
running Foundry process holds the LevelDB lock regardless, so a `LEVEL_LOCKED`
error means "use `--bridge` instead."
