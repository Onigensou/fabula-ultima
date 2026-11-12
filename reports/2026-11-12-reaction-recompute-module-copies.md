---
id: 2026-11-12-reaction-recompute-module-copies
title: Fixed — reaction recompute loaded a new skill-effects/action-profile copy every time (~120 MB/fight GM leak)
status: verified
severity: major
reporter: onigensou
assignee: sarunphat
component: battle-director/action-card.js (reaction recompute → card-mutations applyTargetSetMutation _cb)
introduced_in: 2282cf1b (2026-06-18, Fafnir T4–T5)
fixed_in: v1.0.595 (f3562cf6)
---

# Fix report: the reaction recompute made a new module copy every time (v1.0.595)

**Date:** 2026-11-12 · **Area:** Battle Director, `action-card.js` · **Status:** fixed and verified on the Staging World

Heads-up for sarunphat: this removes one line you wrote on 2026-06-18 (`2282cf1b`, Fafnir T4–T5). Nothing else changes.

## What was wrong

`action-card.js` (reaction recompute after a pill decision) called:

```js
cm.applyTargetSetMutation({ ..., _cb: Date.now(), ... })
```

`applyTargetSetMutation` turns `_cb` into `?cb=<_cb>` for two imports (`card-mutations.js` ~1967 and ~1971):

```js
await import("./skill-effects.js" + sfx);
await import("./action-profile.js" + sfx);
```

Every new URL is a new module copy, and the browser never unloads one. So each recompute added a fresh copy of `skill-effects.js` (~0.9 MB) and `action-profile.js` to the GM page. This is the same leak as `reports/2026-11-11-bd-module-copy-leak.md`, at a site that report's grep missed because the `Date.now()` is passed as an argument.

On the GM page in the Staging World, an Asura fight kept **~100–160 MB** after a forced cleanup, every fight (5 fights measured on v1.0.593, 99 copies of each file per fight).

## The fix

Removed `_cb: Date.now()` from that call and corrected the comment above it. The parameter's own doc already says `_cb` is test-only and production callers omit it. The CONFIRM path in `state-handlers.js` already omitted it, so the preview and the commit now load the same module instances. The director test harness still passes its own `_cb` and is untouched.

## Verified (snapshot runner, `--code` A/B: `f39e7ea3` vs the fix)

| Heap after forced cleanup | Before | After |
|---|---|---|
| Fresh | 227 MB | 227 MB |
| After Asura fight 1 | 281 (+54) | 262 (+35) |
| After fight 2 | 313 (+32) | 277 (+15) |
| After fight 3 | 349 (+36) | 292 (+15) |
| `?cb=` copies of skill-effects / action-profile per fight | 74–91 each | 0 (one load in fight 1) |

- `checks/sim-battle.js`: the same battle on both sides (all 10 actions, 13 resource writes, 11 AE adds, 11 AE removes).
- `checks/fx-leak.js` on the fix: ok, 0 leaks.
- Battle Director unit tests: 29/30. `crisis-keywords.test.mjs` fails the same way without the fix (`Hooks is not defined` under Node).
- The runner draws less than a real GM page, so its per-fight numbers are smaller than the Staging World's. The removed growth is the module copies, which are the same on both.

## Verified on the Staging World (real server, GM page in Edge, GPU)

Same setup as the 11-11 report: cache-bypassing reload, then Asura sims back to back (Valley_Battlemap002, lightning-storm, Kalina as guest). Heap after a forced cleanup. All fights were wins.

| | v1.0.593 (before) | v1.0.595 (fix) |
|---|---|---|
| Fresh page | 228 MB | 228 MB |
| After fight 1 | 361 (+133) | 272 (+44) |
| After fight 2 | 462 (+101) | 278 (**+6**) |
| After fight 3 | 548 (+86) | 291 (**+17**) |
| `?cb=` module copies per fight | 99 each | **0** |
| Peak during a fight | 538 / 580 MB | 530 / 457 MB |

Fight 1 still adds ~44 MB: the first-time cache of animation clips and textures (videos 6 → 85, then flat). After that, a fight keeps roughly 5–20 MB instead of ~100–130 MB. At that rate the GM page's ~4.4 GB limit is out of reach for any real session.

## Gameplay impact: none

- `_cb` only picks *which copy* of the module is loaded, never what the rules do. Both copies hold the same code, so damage, targets and reactions resolve the same way. The A/B battle above is identical stream by stream.
- If anything, it's more consistent: the reaction preview and the CONFIRM commit now run on the same module instances (before, the preview used a throwaway copy).
- **Not exercised:** a reaction whose redirect picker is routed to a *player's* screen (`remotePrompt`). The runner has no second client. It takes the same code path with the same change, so no difference is expected.

## Developer-only change

Live-editing `skill-effects.js` or `action-profile.js` while a game runs no longer reaches the reaction preview by itself. After an edit, run `FUCompanion.api.test.reloadHot()` or press F5, the same as every other Battle Director path since the 11-11 fix. Players never see this.

## What is left

- About +15 MB per fight in the runner. Part of that is the runner's own stand-in database (~2 MB per battle). PIXI `Texture` wrappers around cached animation clips also still grow (~+660 objects per fight on the Staging GM page). They're small; worth a look later.

## Check it stays fixed

```
grep -rn 'cb=" + Date.now()\|cb=${Date.now()}\|_cb: *Date.now()' modules/fabula-ultima-companion/scripts --include=*.js
```

Only comments, the lint `fetch()` lines and the test harness (`_test-harness-director.js`) should match.
