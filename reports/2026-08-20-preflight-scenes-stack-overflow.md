---
id: 2026-08-20-preflight-scenes-stack-overflow
title: preflight crashes with a stack overflow when scene goldens are far from the world
status: open
severity: minor
reporter: onigensou
component: tools/safe-edit/preflight
---

# `preflight run` dies instead of reporting when scene drift is large

```
preflight failed: Maximum call stack size exceeded
    at Object.run (tools/safe-edit/preflight/checks/scenes.js:138:11)
    at cmdRun (tools/safe-edit/bin/preflight.js:73:24)
```

`scenes.js:138` is:

```js
out.push(...compareSceneConfig(gold.full, scene, gold.name, gold.sceneId));
```

Spreading into `push` passes every element as a **function argument**, so once
`compareSceneConfig` returns roughly 100k+ findings it exceeds V8's argument limit
and throws `RangeError`. Nothing is wrong with the data — the check simply cannot
report drift past a certain size, which is exactly when you most want it to.

## How to hit it

Have scene goldens blessed against one world, then run against a materially
different one — e.g. after adopting a co-dev's world wholesale
(`git reset --hard origin/main`). Every full-capture golden then diffs against a
scene it was not blessed on, and the per-element config comparison (walls, lights,
ownership, …) explodes.

Hit on 2026-08-20 after the rebuild-on-their-tip sync. **It takes the whole run
down**, not just the scenes suite — `cmdRun` maps over `CHECKS` eagerly, so the four
healthy suites never report either. Verified by running them directly:

| suite | findings |
|---|---|
| refs | 352 WARN |
| scenes | **CRASH** |
| tiles | 10 INFO |
| tables | clean |
| automation | 41 WARN / 2 INFO |

`--only` does not help: it filters findings *after* every check has run.

## Suggested fixes

1. **The crash** — replace the spread with a non-variadic append:
   `for (const f of compareSceneConfig(...)) out.push(f);` (or
   `out = out.concat(...)`). One line, removes the ceiling entirely.
2. **Blast radius** — wrap each `c.run(...)` in `cmdRun` so one throwing suite
   degrades to a reported error for that suite instead of killing the run.
3. **Ergonomics** — cap per-scene config findings (e.g. first 50 + "and N more").
   A 100k-line scene diff is not actionable output even when it does print.

## Not a blocker for world pushes

Scene goldens are local state, and the drift here is expected rather than damage:
the pre-commit `world-export` gate (0 added / 0 removed) and the
`CURRENT → MANIFEST` integrity check both passed independently. Re-bless scenes
locally (`preflight bless`) to clear it — see the post-session bless-drift note.
