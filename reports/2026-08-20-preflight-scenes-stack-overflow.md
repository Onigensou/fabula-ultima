---
id: 2026-08-20-preflight-scenes-stack-overflow
title: preflight crashes with a stack overflow when scene goldens are far from the world
status: fixed
severity: minor
reporter: onigensou
component: tools/safe-edit/preflight
---

> **FIXED same day.** Root cause was not "stale goldens" as first written — it was a
> **6.2 MB `directorHistory` blob** the Battle Director persists on the scene, which
> flattened to 215,751 leaf paths. See [Root cause](#root-cause-the-first-diagnosis-was-incomplete)
> and [Fix](#what-was-actually-changed). Training Ground: **214,899 findings → 201**.

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

## Root cause — the first diagnosis was incomplete

The initial write-up blamed stale goldens generally. Measuring per scene showed it
was one scene and one field:

| scene | findings |
|---|---|
| **Training Ground** | **214,899** |
| Loading Screen | 102 |
| AncientTemple_Map009 | 102 |
| …95 others | ≤ 99 |

Training Ground's golden flattens to **852** scalar leaf paths; the live scene to
**215,751**. The entire difference is
`flags.fabula-ultima-companion.directorHistory` — Battle Director per-battle save
snapshots (`schemaVersion` / `dCombat` / `actors` / `pendingAction` /
`runtimeContinuation` …), **50 entries totalling 6.18 MB**, on that scene alone
because it is the sim bench. It grows by one entry per battle and is never
authored, so comparing it is pure noise — the same category as the
`dungeonPathing` maps already listed in `VOLATILE_PATHS`.

## What was actually changed

1. **`scene-diff.js` — root cause.** `flags.fabula-ultima-companion.directorHistory`
   added to `VOLATILE_PATHS`.
2. **`checks/scenes.js:138` — the crash.** `out.push(...arr)` → `for (const f of arr) out.push(f)`.
   Removes the argument-count ceiling entirely.
3. **`checks/automation.js:99`** — same spread, same fix. Bounded today (220 drifts),
   but it grows with content and the failure mode is a hard crash.
4. **`scene-diff.js` — defence in depth.** `MAX_FINDINGS_PER_SCENE = 200`, applied
   **after** the structural checks so a genuine FAIL (an embedded collection
   shrank — the thing this suite exists to catch) can never be pushed out of the
   report by a flood of scalar WARNs. Truncation is announced, never silent.
5. **`bin/preflight.js:73` — blast radius.** Each `c.run(...)` is wrapped; a throwing
   suite degrades to its own FAIL finding instead of taking the run down.

## Result

```
Training Ground findings   214,899  →  201   (200 shown + 1 cap notice)
preflight run              CRASH    →  1 FAIL · 443 WARN · 523 INFO, exit 1
```

The surviving FAIL is the pre-existing post-play token drift on
`AncientTemple_Map002`, which is what the suite is supposed to report.

Verified the cap cannot mask a FAIL: a synthetic scene with one `walls dropped
10 → 0` FAIL buried under 5,000 scalar WARNs still returns the FAIL first, bounded
to cap + 1 findings, with the truncation notice attached.

## Follow-up worth considering (not done here)

**6.2 MB of `directorHistory` living on a scene document** is a payload concern in
its own right — see the world-payload-limit note. Excluding it from the diff stops
the noise; it does not stop the growth. Worth a retention cap (keep the last N
battles) if it keeps climbing.
