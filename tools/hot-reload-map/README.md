# hot-reload-map — "will editing this module need a page reload?"

A pure static analyzer for the Battle Director ESM graph. Before you edit a
module, it tells you whether the change will be picked up **without a full page
reload** — ending the recurring guess that the CLAUDE.md dev-guide spends
paragraphs on.

No Foundry, no bridge, no runtime — just reads the source. Safe to run anytime.

```bash
cd tools/hot-reload-map
node bin/hot-reload-map.js report            # classify every battle-director module
node bin/hot-reload-map.js file skill-formulas   # verdict for one module + how to make it hot
```

## The three verdicts

- **HOT-EDGE** — registered via `registerHotModule`; `FUCompanion.api.test.reloadHot()`
  re-imports it live. Edit → `reloadHot()` → done, no reload. (Today: `skill-effects.js`.)
- **HARNESS-FRESH** — re-imported by the test harness's `loadDeps()` on every
  `runDirectorSkill*` call, so edits show up in the next harness run with no
  reload. (Today: the 8 harness roots — `state-handlers`, `action-profile`,
  `action-card`, `skill-intent`, `snapshot`, `states`, `intents`, `skill-effects`.)
- **RELOAD-REQUIRED** — reached only through a plain static `import`; a real page
  reload is the only way to see the edit. (Today: the other ~103 modules,
  including leaf logic like `skill-formulas`, `skill-cost`, `skill-targeting`.)

## The key gotcha it encodes

**Cache-bust is not transitive.** Re-importing a HARNESS-FRESH/HOT-EDGE module
with a fresh token does *not* refresh the modules it statically imports — those
resolve to their already-cached URLs. So `skill-effects.js` is hot, but the
`skill-formulas.js` it imports is RELOAD-REQUIRED. For a reload-required module,
`file <name>` names the fresh importer you'd route it through (via the registry
accessor pattern) to make it hot without a reload.

## Why most modules are reload-required (and why widening is expensive)

Making a module hot means its importers must call it **through an accessor**
(`SE().fn()`), not via a static binding. Converting a leaf like `skill-formulas`
means rewriting every bare-name call site in its importers — 119 of them in
`skill-effects.js` alone. That's why coverage is deliberately narrow: the payoff
per conversion is bounded and the call-site churn in core files is real. This
tool at least makes the current boundary explicit so you never waste an
edit-then-wonder cycle.
