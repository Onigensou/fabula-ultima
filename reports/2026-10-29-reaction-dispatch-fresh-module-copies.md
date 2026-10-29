---
id: 2026-10-29-reaction-dispatch-fresh-module-copies
title: Every reaction event loads fresh copies of standalone-reactions + skill-effects (~50 ms each, never freed)
status: open
severity: minor
reporter: onigensou
assignee: sarunphat
component: battle-director/standalone-reactions
introduced_in: c34d87b7
fixed_in:
---

# Not fixed on our side — yours to decide

**Onigensou's note:** the reaction system is yours, so this is filed instead of fixed.
Nothing in the dispatch path was changed. Decide whether and how to act on it.

Found while measuring the new Chain N multi-hit (branch `feat/chain-multi-hit`). A Chain
fires one reaction event per strike, which made the per-event cost easy to see. The cost
itself is not Chain-specific: every reaction event in the game pays it.

## Symptom

- A settle with ~45 reaction events took ~7 s.
- About 2.3 s of that was spent re-importing two modules, before any reaction logic ran.

## Measurements (sandbox world copy, Foundry v12, GM client, 2026-10-29)

| call | cost each |
|---|---|
| `import("./standalone-reactions.js?cb=" + Date.now())` | 11 ms |
| `import("./skill-effects.js?cb=" + Date.now())` (737 KB) | 37 ms |
| `firePassiveTriggers(...)` for a trigger with **no** matching reaction | 50 ms |

The ~50 ms baseline is almost entirely the two imports. Browsers never release module
records, so every call also adds two module instances to the page for the rest of the
session. Heap growth looked small per call, but I could not measure it cleanly (the test
page was already inflated by skill-regression runs), so treat the memory side as
unquantified.

## Root cause

- `skill-effects.js:2973` (`firePassiveTriggers`) does
  `await import("./standalone-reactions.js?cb=" + Date.now())` on **every** call.
- That fresh copy's `getSkillEffectsExtras()` (`standalone-reactions.js:204`) caches
  `_seExtraModule` **per copy**. Every fresh copy therefore imports a fresh
  `skill-effects.js?cb=<now>` the first time it needs it. `getReactionMenu()` (`:210`)
  does the same for `reaction-menu.js`.
- The pattern dates from `c34d87b7` and is there so a live edit is picked up without a
  hard reload.

Other per-call `Date.now()` cache-busts on runtime paths:
- `standalone-reactions.js`: 1304
- `state-handlers.js`: 103, 4058, 6487, 6631, 7091, 7275
- `director-boot.js`: 1503
- `skill-effects.js`: 954 (cached once, harmless)
- `action-card.js`: 8120/8121, 8307/8308, 8537, 8691/8692, 9323, 9394, and five
  `invoke-worker.js` imports (9548, 9698, 10100, 10932, 10982)

## Side effect: module state is split across copies

Each copy has its own module-level state, so the FSM path (`SE()` → the boot instance)
and the reaction path (a fresh copy per event) do not see each other's:

- `reaction-menu.js:58` and `reaction-indicator.js:30` keep a `_instances` registry of
  open menus/indicators. With a fresh copy per dispatch, a teardown can only see the menus
  its own copy opened.
- `skill-effects.js:211` `_damageReactionAskDecider` is set by the sim harness
  (`sim/sim-mode.js:193`) on one instance; the reaction-path copies never see it.
- Hit live: the Chain branch first kept its per-action state in a module-level `Map` in
  skill-effects. Reaction effects ran in a fresh copy with an empty map, so it silently did
  nothing. It now lives on `globalThis.__FU_CHAIN_AE_COALESCE__` (`skill-effects.js:6670`).
  That is a workaround; it does not change your dispatch.
- Editing a file mid-session and NOT hard-reloading mixes versions. Fresh copies load the
  new file, and its static imports resolve to the old cached modules. Symptom: every settle
  drain throws `SyntaxError: ... does not provide an export named ...`, which the BD logger
  prints as `{}` (`JSON.stringify(Error)`).

## Repro

1. Any battle with a passive that fires on a common trigger (Hina's Absorb MP on
   `creature_lose_resource`).
2. In the GM console, run `performance.getEntriesByType("resource").filter((e) => /skill-effects\.js\?cb=/.test(e.name)).length`
   before and after an action that fires several reactions. The count grows by about one
   per reaction event.
3. Or time it directly: `await firePassiveTriggers({ director, casterActor, trigger: "creature_guards", payload: {} })`
   costs ~50 ms with nothing to fire.

## Suggested fix (a suggestion only, not applied)

Route these hops through the existing hot-reload registry token (`hot-reload.js`,
`currentHotToken()`), not `Date.now()`:

- token 0 (a normal session): the bare specifier, i.e. the boot instance.
- token N (after `FUCompanion.api.test.reloadHot()` or a harness bump): `?cb=N`, one shared
  fresh copy per bump.

```js
// hot-reload.js
export function hotSpecifier(rel) {
  const t = currentHotToken();
  return t ? `${rel}?cb=${t}` : rel;
}
// skill-effects.js firePassiveTriggers — resolved relative to the caller, as today
const mod = await import(hotSpecifier("./standalone-reactions.js"));
```

What it gives:
- No per-event fetch/parse.
- No module pile-up.
- One instance per file, so the registries above are shared again.
- The harness keeps working (it bumps the token).

The trade-off: a live edit takes effect after `reloadHot()` (or a hard reload), not on the
next reaction event.

I audited module-level state in `standalone-reactions`, `reaction-menu`,
`reaction-indicator`, `card-mutations`, `reaction-derive` and `invoke-worker`. Nothing
relies on being fresh per call; what is there is caches, open-UI registries, an
install-once guard and the sim decider.

## Notes
- 2026-10-29 (onigensou): filed, deferred to sarunphat.
