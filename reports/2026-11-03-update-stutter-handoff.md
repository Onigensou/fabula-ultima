---
id: 2026-11-03-update-stutter-handoff
title: Hand-off — actor updates no longer stutter (CSB recalculation + Foundry update path + rewind history, v1.0.519–520)
status: verified
severity: minor
reporter: sarunphat
assignee: onigensou
component: process/merge-handoff (csb-extensions, syntax-extender, battle log)
introduced_in:
fixed_in: 1.0.520
---

# Not a bug: a hand-off note for the v1.0.519 and v1.0.520 pulls

Written for onigensou, and for the Claude session that runs the pull. Nothing in the game
rules changed. Please skim it before touching CSB internals, Active Effect syntax code or the
battle log, then close it as described at the end.

## 1. What changed and why

**The problem:** every write to an actor (an HP, MP or status change) made every client
recalculate that actor and all its items, on the thread that draws. Battle animations
stuttered on each write. On the Snapshot Runner, one HP write on Hina (111 items) took 273 ms.

**Now:** the same write takes about 13 ms (19 ms under the profiler). Keren, Blanche and
Zarg take about 7 ms. An Active Effect create plus delete on Hina went from 58 ms to 22 ms.

| Change | Where |
|---|---|
| Foundry 12 prepared every item twice per actor update; now once | `csb-derivation-perf.js` (4) |
| An item that did not change keeps its derived data across an actor update | `csb-derivation-perf.js` (5) |
| A formula whose inputs did not change returns its last result | `csb-formula-memo.js` |
| Each calculation pass copies only the props it writes, not all of them | `csb-derivation-perf.js` (6) |
| **Our own copy of CSB's calculation loop:** a formula is skipped when it reads the same values as last time | `csb-derivation-perf.js` (7) |
| **Foundry's `game.data` copy of an updated document is made only when something reads it** | `csb-derivation-perf.js` (8) |
| The Active Effect gate does its trace-only work only while tracing | `syntaxExtender-conditionalChangeGate.js` |
| Battle log rows queue during a battle and reach the party actor once, at battle end | `director-battle-log.js` |

**Measured on a seeded battle (same battle, same result):** time spent recalculating went
from 4.56 s to 0.32 s, and long tasks went from 10.2 s to 1.9 s. The worst single freeze is
still about 300 ms, and recalculation does not cause it. That is the next lead.

## 2. What you might notice

- **The party sheet's battle log table fills in at battle end, not during the battle.** A
  tool that followed the log live should listen to the hook `fu-battle-log-append`
  (`{ entries, rows }`) instead.
- **An entry of `game.data.actors` / `game.data.items` for a document updated since load is
  a Proxy.** It makes the usual `toObject()` copy the first time anything other than `_id`
  is read, and behaves like that copy afterwards. Prefer the document (`game.actors.get(id)`)
  over `game.data` in code anyway.
- **CSB internals are patched.** Each patch checks that CSB 4.8.5's code is the shape it was
  written against. On any other CSB version it does not install and prints a console warning
  that starts with `[CSB-DerivationPerf]` or `[CSB-FormulaMemo]`. Recheck them on a CSB upgrade.

## 3. Rules for your side (and for your Claude)

- **An error thrown while an actor is being prepared is swallowed by Foundry**
  (`_safePrepareData`). Props just go missing, and the update looks faster. When you test
  anything that runs during prepare, listen to `Hooks.on("error", …)`.
- **Adding a CSB formula function that reads anything besides its arguments** (another
  document, a registry, randomness): add its name to `EXTERNAL` in `csb-formula-memo.js`.
  If it reads the document's own props by a computed name, add it to `SELF_ONLY` instead.
  Otherwise its result is reused while its arguments are unchanged.
- **Code that writes into an actor's or item's `system.props` directly, without an update**,
  is not seen by the recalculation of an unchanged item. Write through `update` (or
  `updateSource`) as before.

## 4. Kill switches

All are world settings of `fabula-ultima-companion`, on by default. Turning one off needs a
reload. Example:

```js
await game.settings.set('fabula-ultima-companion', 'csbIncrementalPrepare', false)
```

| Setting | Turns off |
|---|---|
| `csbFormulaMemo` | the formula memo |
| `csbItemReuse` | keeping unchanged items |
| `csbItemPrepareOnce` | preparing items once per update |
| `csbPassSnapshot` | the copy-on-write pass snapshot (6) |
| `csbIncrementalPrepare` | our calculation loop (7) and the component-map cache |
| `foundryLazyDataMirror` | the lazy `game.data` copy (8) |

Live stats for a quick look in the console: `__fuFormulaMemo`, `__fuItemReuse`,
`__fuPassSnapshot`, `__fuIncPrepare`, `__fuLazyMirror`.

## 5. How it was checked

All on the Snapshot Runner (the real client, CSB and module, with the world read from disk):

| Check | Result |
|---|---|
| Every world and unlinked-token actor, plus HP, input, item and effect edits on the party, against a full recalculation with every patch off | **430/430 identical** |
| `game.data` entries against `toObject()` | **0 differences** |
| Errors during prepare | **0** |
| Regression bench, compute | **487/487** |
| Regression bench, simulate, against the code before this work | **487/487** |
| Seeded battle | **same battle** |

The user played a 4-PC + guest battle on the first two rounds of this work and said it
"feels great".

## 6. Added in v1.0.520

- **The GM rewind history moved off the battle scene.** It was one `directorHistory` array
  flag that grew with every save point (1.6 MB after 10 actions in the seeded battle;
  preflight once met a 6.2 MB one). Every scene save sent the whole array to every client,
  and each client copied it, so stalls grew as the battle went on. Now each save point is
  its own hidden JournalEntry (ownership NONE) in the folder **⚙ Battle Director (rewind
  points)**, flagged `flags.fabula-ultima-companion.directorHistoryEntry = { sceneId, seq, entry }`.
  Rewind works as before: same 50-point window, shared, survives a reload, any GM. The entries
  and the folder are deleted when the battle stops.
  - **What you will see:** that folder in the Journal sidebar while a battle runs. Leave it
    alone; deleting an entry there deletes that rewind point.
  - **Code or tools that read `scene.getFlag(…, "directorHistory")`** must use
    `getHistory(scene)` from `battle-director/persistence.js` (or the API's `history()`).
    The old flag is still read, and a battle saved on an older version moves its points into
    documents on the first new save.
  - **Measured on the seeded battle:** the scene document stays under 60 KB (it reached
    1.6 MB). Long tasks went from 2.15 s to 1.05 s, and the 60–130 ms stalls that came with
    each scene save are gone. Same battle. A live rewind to "Battle Start" kept exactly that
    point and resumed the fight.
- **Item containers keep the rows of unchanged items** (`csb-derivation-perf.js` (1), under
  `csbIncrementalPrepare`). Hina's HP write: ~13 → ~10 ms.

## Closing this

Pull, open the world once as GM, and check in the console:

```js
[__fuIncPrepare?.on, __fuLazyMirror?.on, __fuFormulaMemo?.on, __fuItemReuse?.on]
```

It should print `[true, true, true, true]`, and there should be no `[CSB-DerivationPerf]` or
`[CSB-FormulaMemo]` warnings in the console. Then play one battle (the rewind folder should appear in the Journal sidebar and vanish
when the battle ends), set `status: verified`, and push.

## Notes

- 2026-11-04 (onigensou): **verified on our world** (merged with our passive card work, pushed as v1.0.521).
  - Snapshot Runner, on a copy of our world: every actor's derived data came out identical with your six
    switches on and all off. That held for 5,341 documents at load, and for all 322 actors after each of
    28 edits on the party (HP, MP, an effect deleted and re-created, an armour refine level up and back).
    The `game.data` entries of the edited actors match `toObject()`, with 0 prepare errors. Regression
    `check --runner` 487/487. Boot console errors are the same 98 before and after the merge. An HP write
    on our world: Hina 357 -> 16 ms, Keren / Blanche / Zarg 166-224 -> 10-12 ms.
  - Sandbox copy on a real server: all nine patch pieces log "installed", with no `[CSB-*]` warnings. Save
    points show up as hidden journal entries in their folder and are deleted on stop. Log rows wait in
    `battleLogPending`, and `flushBattleLog()` writes them to the party actor.
  - Two things for you. (1) The closing check's 4th value, `__fuItemReuse?.on`, reads `null` right after
    load: `itemReuse.on` is only resolved on first use, so it reads `null` until the first actor update and
    `true` after. (2) `stop()` neither flushes nor clears `battleLogPending`, so a stopped battle's rows
    reach the party log at the end of the NEXT battle, ahead of that battle's own rows. Your call whether
    stop should flush or clear them.
  - Not checked: rank / summary reading the flushed rows at a natural battle end. Our demo could not end its
    battle naturally, so stop + `flushBattleLog()` were checked directly.
