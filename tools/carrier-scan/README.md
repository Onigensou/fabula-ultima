# carrier-scan — "is this actually implemented?"

Answers the question with a command instead of from memory.

```
node tools/carrier-scan/bin/carrier-scan.js check <name…>     # full report for named docs
node tools/carrier-scan/bin/carrier-scan.js sweep [--owner X] # docs with NO carrier
node tools/carrier-scan/bin/carrier-scan.js partials          # numeric-only gear w/ prose mechanics
node tools/carrier-scan/bin/carrier-scan.js stats             # carrier totals
        --json          machine-readable
        --kind skill|gear
```

Game **CLOSED** — reads `worlds/<world>/_authored-export`, never the LevelDB, so
it can't collide with a session. Run `world-export export` first if the export
is stale.

## Why it exists

On 2026-08-09 a party content audit reported six implemented things as unbuilt:
Quick Summoning, Perfect Aim, Resourceful, Ritual Entropism, Ritual Spiritism,
Turbo Tonic. The audit applied the remembered rule — config rows, activate ref,
own damage, an AE, a linked `_skill`, plus stat props for gear.

Every one of those carriers is **local to the document**, and all six missed
cases were implemented in ways that put nothing on the document. The rule wasn't
misremembered; it was incomplete, and prose can't tell you that. So it lives
here as code.

## The nine carriers

| # | carrier | where |
|---|---|---|
| 1 | `reaction_config_table` rows | local |
| 2 | `effect_table` rows | local |
| 3 | `on_` / `pre_activate_effect_ref` | local |
| 4 | own damage (`type_damage` **+ a non-zero `damage_bonus`**) | local |
| 5 | AE `changes` / `reactionConfig` / any `flags[NS]` | local |
| 6 | a linked `_skill` child that itself carries something | local |
| 7 | gear stat props (`*_bonus`, `*_ef`, `condition_*`) **differing from default** | local |
| 8 | inbound `HAS_SKILL_<NAME>` / `AE_COUNT_<NAME>` from another doc | **not on the doc** |
| 9 | code-backed — engine looks it up by name | **not on the doc** |
| 10 | `implementation_note` — authored pointer, visible on the sheet | local |

Carrier 9 reads `scripts/shared/code-backed-content.js`, including the two
families that own their own registry (`CLEANSE_REGISTRY`, `DISCIPLINE`) — it
resolves those through each `DELEGATED` entry's `namesFrom`, so the names stay
in exactly one place.

## Traps this tool encodes (each one caused a false report)

- **`type_damage: "Physical"` is the consumable shell default** — 99 of 118
  consumables carry it and deal no damage. Carrier 4 requires a non-zero
  `damage_bonus`.
- **`<species>_ef = 100` is the affinity default** — every item has all ~27.
  Only a differing value counts.
- **Trailing parentheticals are stripped by the engine** (`ritual-actor.js`
  `normaliseName`), so "Ritual Arcanism (variant)" resolves to the registered
  "Ritual Arcanism". The scan mirrors that; a scan that normalises differently
  from the engine invents gaps.
- **A clean `sweep` is not a finished world.** Gear almost always carries
  numbers, so a weapon can never appear in `sweep` even when its prose mechanic
  is missing. `partials` covers that class (Venom Claw's Poisoned→Envenomed
  rider, Draconic Claw's Burn, …), and `sweep` prints the partial count in its
  footer rather than letting silence imply completeness.

## 🪤 If a grep comes back empty, suspect the tool

`skill-effects.js` once carried a single raw NUL byte. Ripgrep classifies a file
as binary on the first NUL and then **skips it silently** — "no matches", never
an error. The 10k-line core engine was absent from every content search, which
is how the code-backed implementations stayed invisible. Guarded now by
`tools/safe-edit/hooks/check-no-nul.js`, but the habit matters more than the
guard: when a search of a file you *know* contains the term returns nothing,
re-run it from Bash before believing it.

## Related

- `tools/skill-primitives` — "does this primitive already exist?" (the sibling
  question: vocabulary, not wiring)
- `tools/skill-regression` — "did behaviour change?" (487+ skills, needs the game OPEN)
- `modules/…/scripts/lint/engine-canon-lint.js` — flags *undeclared* code-backed
  name lookups; the registry is its allowlist
