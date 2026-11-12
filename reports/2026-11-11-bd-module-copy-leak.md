# Error report: the battle page keeps ~500 MB per fight (module copy leak)

**Date:** 2026-11-11 · **Area:** Battle Director (shared code) · **Status:** fixed in code, see "Result" and "Still open"

Heads-up for sarunphat: the fix touches `hot-reload.js`, `action-card.js`, `state-handlers.js`, `skill-effects.js`, `standalone-reactions.js` and `director-boot.js`. One dev-workflow change, explained under "What changes for development".

## Symptom

- During an Asura sim on the Staging World, the GM browser tab crashed with **"Out of Memory"**.
- After that, every fight left memory behind that a forced cleanup could not free:

| Page state (after forced cleanup) | JS heap |
|---|---|
| Fresh page | 225 MB |
| After 1 Asura fight | 784 MB |
| After 2 fights | ~1,240 MB |
| After 3 fights | ~1,800 MB (live, before cleanup) |

- Chrome's limit for one page here is about 4.4 GB, so the GM page would run out after roughly 6–8 fights of this size without an F5.
- **Not demo-only.** The sim drives the same card, reaction and damage code as a real battle. The first crash was worse because a heavy test logger also ran during that fight.

## Cause

Many places in the Battle Director loaded a module with a new timestamp on every call:

```js
const se = await import("./skill-effects.js?cb=" + Date.now());
```

- The browser treats every distinct URL as a **new module instance** and never unloads one.
- So every action card, reaction check and passive trigger kept one more full copy of that module.
- Measured cost per copy:

| Module | Per copy |
|---|---|
| `skill-effects.js` (780 KB source) | **~0.9 MB** |
| `card-mutations.js` | ~0.19 MB |
| `standalone-reactions.js` | ~0.11 MB |
| `invoke-worker.js`, `reaction-derive.js` | ~0 |

- The copies cascade. A fresh `skill-effects.js` copy starts with an empty `_formulaModulePromise`, so it also loads its own fresh `skill-formulas.js`. A Chrome allocation sample during a fight showed many distinct `skill-effects.js?cb=…` and `skill-formulas.js?cb=…` instances.
- 26 sites did this: 14 in `action-card.js`, 6 in `state-handlers.js`, 3 in `standalone-reactions.js`, 2 in `skill-effects.js` and 1 in `director-boot.js`.
- The 2 lint files (`reaction-config-lint.js`, `skill-raw-drift-lint.js`) `fetch()` text with a timestamp. Fetched text is freed normally, so they are not part of the leak and were left alone.

**Side effect of the old pattern, also fixed:** module-level state was split across copies.
- The sim's damage-reaction decider (`setDamageReactionAskDecider`) is set on the plain `skill-effects.js` instance.
- Damage resolved through a fresh copy could not see it.

## Fix

New helper in `battle-director/hot-reload.js`:

```js
export function hotUrl(spec) { return `${spec}?cb=${LOAD_STAMP}-${currentHotToken()}`; }
// usage, in the consuming file:  await import(hotUrl("./skill-effects.js"))
```

- `LOAD_STAMP` is set once per page load (`globalThis.__FU_LOAD_CB`). `currentHotToken()` is the existing `globalThis.__FU_CB`, which is 0 until a dev bump.
- **Normal play:** the URL is the same on every call, so each module is loaded **once per page load**, not once per call.
- **Kept on purpose:**
  - The page-load stamp still forces a fetch past a stale browser cache after a module update. That was the stated reason for these imports ("loads cleanly against module caches that pre-date these exports").
  - The test harness and `FUCompanion.api.test.reloadHot()` still get fresh code: they bump `__FU_CB`, which changes the URL.
- All 26 sites now call `hotUrl(...)`. The test-only `_cb` parameter of `applyTargetSetMutation` is unchanged.

**Checked before switching to one shared copy per page:** module-level state in the affected modules.

| State | Verdict |
|---|---|
| `_riderLinkageInstalled`, `_onRemoveFollowupInstalled` | install-once guards, only called from boot |
| `_damageReactionAskDecider` | null in live play; the sim now reaches it from every path |
| `_formulaModulePromise`, `_seExtraModule`, `_rmModule` | memos |
| `_arcanumTemplateIdCache` | cache |
| `*_WARNED` sets | warn-once |
| `reaction-menu` / `reaction-indicator` `_instances` | one registry instead of one per copy |

Nothing relied on starting fresh on every call.

## What changes for development

- **Before:** an edited file took effect at the next card, because every card loaded a fresh copy.
- **Now:** run `FUCompanion.api.test.reloadHot()` (or a page reload) after editing. That's the same rule the hot-reload map already documents for HOT-EDGE modules. The harness bumps the token per run as before.

## Result

Staging World, GM page after a cache-bypassing reload, then two Asura sims back to back (Lightning Storm, Kalina as guest). Heap measured after a forced cleanup each time:

| | Before the fix | After the fix |
|---|---|---|
| Fresh page | 225 MB | 225 MB |
| After fight 1 | 784 MB (**+560**) | 350 MB (**+125**) |
| After fight 2 | ~1,240 MB (**+460**) | 468 MB (**+118**) |
| Peak during a fight | 849 MB / 1,897 MB | 514 MB / 663 MB |

- About 75% less memory kept per fight.
- At ~120 MB per fight, the 4.4 GB limit is now roughly 30+ fights away, instead of 6–8.
- Both fights were wins. Every Battle Director unit test passes except `crisis-keywords.test.mjs`, which already failed before this change (`Hooks is not defined` under Node).

## How to check if it comes back

On the GM page, with nothing running:

1. Force a cleanup and read the heap. Through CDP: `HeapProfiler.collectGarbage` three times, then `performance.memory.usedJSHeapSize`. In DevTools: the Memory tab's bin icon, then the heap figure.
2. Run one fight, then force a cleanup and read it again. Repeat once.
3. Healthy: the second fight adds little over the first. Leaking: each fight adds hundreds of MB.
4. To find what is kept, a Chrome allocation sample (`HeapProfiler.startSampling` before the fight, `getSamplingProfile` after a cleanup) lists surviving memory by code site. Many `<file>.js?cb=<different numbers>` entries mean this pattern is back.
5. Code check: `grep -rn 'cb=" + Date.now()\|cb=${Date.now()}' modules/fabula-ultima-companion/scripts --include=*.js` should only list the two lint `fetch()` lines.

## Still open

- **~120 MB per fight is still kept.** It's a much slower leak, not solved. Object counts after one fight before the fix (fresh → after) also grew in:
  - video elements: 6 → 95, with only 1 on the page
  - PIXI textures: 167 → 983
  - PIXI base textures: 136 → 309
  - WebGL textures: 38 → 110
  - Maps: about +1,200

  Animation clips, textures or caches are the likely place to look next. The allocation sample put most surviving memory under native "(V8 API)" allocations, not under a module's code site, so it may be video or texture memory held from JS.
- **Players' pages were not measured.** Only the GM page was. Cards and reactions run their code on the GM, so the GM page is where this leak lived, but player pages have not been checked for growth over a session.
- **Workaround if a long session gets slow:** the GM presses F5 between fights. The Battle Director restores a running battle after a reload.
- **The first crash** happened within one fight. That run also had a test logger watching every page change, which added its own memory. Without the logger, the same fight peaked at about 850 MB before this fix.

## Re-check after v1.0.593 (2026-11-12)

Same setup as above: Staging World, GM page in Edge (GPU), cache-bypassing reload, then Asura sims back to back (Valley_Battlemap002, lightning-storm, Kalina as guest). Heap after a forced cleanup each time. All 5 fights were wins.

| | 11-11 (after the fix) | 11-12 (v1.0.593) |
|---|---|---|
| Fresh page | 225 MB | 228 MB |
| After fight 1 | 350 MB (+125) | 361 MB (+133) |
| After fight 2 | 468 MB (+118) | 462 MB (+101) |
| After fight 3 | | 548 MB (+86) |
| After fight 4 | | 713 MB (+164, allocation sampler running) |
| After fight 5 | | 837 MB (+124) |

**The ~120 MB per fight is still there.** sarunphat's v1.0.590–593 leak fixes (animations, Bar Brawl bars, charge badges, 3D camera) did not change it. Those fixes target other leaks.

### The cause: one more module-copy site

`action-card.js:9205` (reaction recompute after a pill decision) calls

```js
cm.applyTargetSetMutation({ ..., _cb: Date.now(), ... })
```

and `applyTargetSetMutation` (`card-mutations.js:1760`) turns `_cb` into `?cb=<_cb>` for two imports:

```js
await import("./skill-effects.js" + sfx);   // card-mutations.js:1967
await import("./action-profile.js" + sfx);  // card-mutations.js:1971
```

So every recompute loads a new copy of `skill-effects.js` (~0.9 MB) and `action-profile.js`. That is the same leak as above, at a site the first fix missed: the `Date.now()` is passed as an argument, so the "How to check" grep never matched it. The line dates from 2026-06-18 (`2282cf1b`), so this residual is old, not new in v1.0.593. The parameter's own comment says `_cb` is test-only and production callers omit it. The two `state-handlers.js` callers do omit it; this one doesn't.

Evidence from fight 5:
- Writes to the hot-reload token `__FU_CB`: **0** (the token isn't involved).
- Fresh module fetches: **99 × `skill-effects.js?cb=…`, 99 × `action-profile.js?cb=…`**, each with a different stamp.
- The fight-4 allocation sample lists many `skill-effects.js?cb=<different numbers>` / `action-profile.js?cb=…` entries, plus `applyTargetSetMutation @ card-mutations.js:1759` (1.8 MB).

### Videos and textures: mostly cache warm-up, not this leak

- Videos 6 → 93 after 2 fights, then only +5 by fight 3. 86 of them are detached `blob:` videos made by PIXI's asset loader (`PIXI.Assets.load` of a webm), one per clip URL. They stop growing once each clip has been seen. A tagging run in fight 3 kept 9 of 148 created videos, 2 of them new blobs.
- Base textures level off the same way (226 → 231). WebGL textures went down (83 → 62).
- PIXI `Texture` objects still climb (155 → 1602 → 2264, ~+660 per fight), as many small wrappers around a few clips (e.g. 92 for `twinkle_anim02.webm`, ~40 per Asura `px_double-slash_*`). They're small, but they're a second, smaller growth worth a look after the module copies are fixed.

### Fix: APPLIED in v1.0.595 (f3562cf6)

Staging after the fix: +44 / +6 / +17 MB over 3 fights, 0 module copies. Details: `reports/2026-11-12-reaction-recompute-module-copies.md`.

Original suggestion:

Remove `_cb: Date.now()` from `action-card.js:9205` (or pass it only under the test harness). Then add the parameter form to the "How to check" grep, e.g. `grep -rn '_cb: *Date.now()\|cb: *Date.now()' modules/fabula-ultima-companion/scripts`.
