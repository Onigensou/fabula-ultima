---
id: 2026-11-01-csb-recalculation-overheads
title: Two removable overheads in the CSB extension patches — ~230 ms of a 500 ms PC recalculation
status: open
severity: minor
reporter: onigensou
assignee: sarunphat
component: csb-extensions (csb-template-layout-dedup, csb-derivation-perf)
introduced_in:
fixed_in:
---

# Where a player character's recalculation goes, measured

Players and the host reported low frame rate in the 2026-10-31 session. Nothing logged frame rate, so I
built it (below) and benchmarked in a sandbox. Every freeze in a battle lines up with `prepareData` on an
actor, on every client: one Hina recalculation is **445–500 ms** on the host's machine (i7, idle), and
a battle write to a PC costs that on every connected client. The two items here are in your
`csb-extensions` patches, so this is a report, not a fix. Full case:
`modules/fabula-ultima-companion/docs/investigations/frame-rate/CASE.md`.

## Evidence

One `Hina.prepareData()` (111 items, 6 effects, 375 props), sandbox, 2026-11-01, `Formula.prototype.computeStatic`
wrapped and timed at the outermost call only:

| | ms | share |
|---|---|---|
| whole recalculation | 502 | |
| 548 formula evaluations | 191 | 38% |
| of which **item-container filter formulas** | ~160 | 32% |
| **layout clones** for the 111 items (`csb-template-layout-dedup.js`) | 72 | 14% |
| everything else (CSB component maps, prop clones, item plumbing) | ~240 | 48% |

The top formulas, all container filters, each evaluated once per item per container:

```
 17.8 ms   38 x  and(switchCase(item.skill_type, 'Active', true, 'Passive', true, 'Other', true, false), and(...
 17.2 ms   45 x  equalText(item.item_type, "material")
 16.6 ms   38 x  and(and(equalText(item.skill_type, "Spell"), not(item.isOffensiveSpell)), or(equalText(item.class, ...
 16.1 ms   45 x  equalText(item.item_type, "accessory")
 16.1 ms   45 x  equalText(item.item_type, "key")
 15.7 ms   45 x  equalText(item.item_type, "shield")
 15.7 ms   45 x  equalText(item.item_type, "consumable")
 15.6 ms   45 x  equalText(item.item_type, "weapon")
 15.5 ms   45 x  equalText(item.item_type, "armor")
```

No single formula is heavy: the slowest is 17.8 ms for all 38 of its evaluations. It is the count: 45
equipment items × 7 containers + 38 skills × 3 containers, each a `new Formula(...)` parsed by mathjs
(`systems/custom-system-builder/module/sheets/components/ItemContainer.js:760`, `filterItems`), on
every recalculation. `filterItems` runs from `_getRowEntries` (`:458`, inside `getComputeFunctions`)
and again at render (`_getElement`, `:129`).

Other PCs, same run: Zarg 390 ms (78 items), Blanche 232, Keren 199. King Gorger 17.

## 1. Layout clones: `csb-template-layout-dedup.js:138-142`

The READ patch hands CSB a `deepClone` of the master's `body` and `header` **for every item on every
recalculation**: 111 clones, 20.4 MB, per Hina pass (measured alone: 72 ms; 51 on Zarg, 36 Blanche,
28 Keren). The clone is load-bearing (your note: a live master reference lets CSB mutate the master),
but it does not have to be fresh each pass. Before dedup, the stored copy on the item was mutated the
same way and simply lived on the document.

**Suggested fix:** keep one clone per item instance, e.g. a `WeakMap<item, {body, header, masterRev}>`
in the READ patch, re-cloned only when the master's layout changes (compare `master.system.body` by
identity or `_stats.modifiedTime`). Same semantics as the pre-dedup stored copy, 72 ms → ~0 on Hina.

## 2. Container filter formulas: `csb-derivation-perf.js:133-181`

Your row-column fast path (`planForField`) already recognizes trivial formulas and emits closures. The
container *filters* are the same shape and are not covered: `equalText(item.X, "literal")`, plus
`and`/`or`/`not` of those and `switchCase(item.X, lit, bool, ...)`. They dominate the formula time above.

**Suggested fix:** in the same file, patch `ItemContainer.prototype.filterItems` (or `_getRowEntries`)
to plan `this._itemFilterFormula` once per container (memoised on the component like `PLAN`), and for
a recognized shape test `item.system.props[X]` directly instead of `new Formula().computeStatic`.
Anything not recognized falls back to CSB's path, as the row patch does. Expected: most of ~160 ms on
Hina, and it also speeds up sheet render, which calls the same `filterItems`.

Together these are about 230 of 500 ms per Hina recalculation, on every client, per write.

## Repro

Sandbox or live GM console, any PC:

```js
const a = game.actors.getName("Hina");
let t = performance.now(); for (let i = 0; i < 5; i++) a.prepareData(); (performance.now() - t) / 5;
```

Per-formula timing: wrap `Formula.prototype.computeStatic` from
`/systems/custom-system-builder/module/formulas/Formula.js` and bucket by `this._raw`; the script I used
is described in the case file. **Measure with no other Foundry process running** — my first numbers
(900–1,074 ms) were contention from a second sandbox.

## FYI — the rest of the optimization work (mine, already committed locally)

- `scripts/client-health.js` now reports `fps` per client about once a minute of visible canvas time
  (avg, worst frame, slow-frame counts, Battle depth setting); `client-health-summary.js` prints it per
  scene and setting. Adds one ticker listener, so the logged `tickers` count reads one higher.
- `map-system/keyboard-interact.js` `layoutOverheadRows` ran a document-wide `querySelectorAll` every
  frame; on the GM's ~24k-element page that was 14–22% of the main thread. Now scoped to the four
  button layers.
- King Gorger's four stale **unlinked** tokens (plaza + three roleplay copies) were deleted: each write
  to his actor rebuilt all four on every client (104 of a traced battle's recalculations). Lesson for
  recruitables: the town copy should be a separate stage-prop actor, not the party-member actor.
- Battle depth `camera` (3D) costs **Firefox** about 40% of its frame rate on the Valley battle maps
  (35–37 fps vs 58 in Full/Depth only/Off); Chromium holds 58–59 in every mode. Your 3D camera
  (`battle-stage-3d-camera.js`) re-uploads its full-window canvas to PIXI every frame; a Firefox
  fallback to Full, or a cheaper upload, is the likely fix. The host has deferred this one; noted
  here so you know before touching that file.

## Notes

- 2026-11-01 (onigensou): filed from the frame-rate case after the 10-31 session.
