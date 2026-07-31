---
id: 2026-07-31-director-simulate-hangs-resolve
title: runDirectorAttackSimulate / runDirectorSkillSimulate hang forever at RESOLVE
status: open
severity: major
reporter: onigensou
assignee: sarunphat
component: battle-director/_test-harness-director
introduced_in:
fixed_in:
---

# The simulate harnesses never return

Hit while trying to verify the Adrenaline card preview. `compute` is fine;
anything that proceeds into RESOLVE never resolves its promise.

## Symptom

```
runDirectorAttackCompute  ({attacker, targets, force:true})   -> ok, 27 dmg, ~1s
runDirectorAttackSimulate ({attacker, targets, force:true})   -> never returns
runDirectorSkillSimulate  ({skillUuid, caster, targets})      -> never returns
```

Reproduced on 4 separate calls across 2 boots (`sedrsq3R3x6yPzqk`,
`r7mh1UcfAfERbwII`), with both a PC target (Hina) and an NPC target
(Salamander A), and with `acceptPassives: true` and unset. The baseline call with
**no AE and no reaction involved** hangs too, so it is not reaction-specific.

## It is not the obvious causes

Checked each while a call was hung:

- **Not a blocking modal** — `ui.windows` is `{}` and there is no `.dialog` in the
  DOM at hang time.
- **Not a frozen renderer** — a CDP `Runtime.evaluate` answers instantly while the
  call is outstanding (`{alive:true, windows:0}`).
- **Not hidden-tab rAF suppression** — `document.hidden false`,
  `visibilityState "visible"`, `FUCompanion.api.vfxSuppressed() === false`.
- **Not the bridge** — a `ping` sent during the hang answers normally, and later
  `evalGM` calls (including AE create/delete and 10 chained computes) all work.

## The odd part

Wrapping the call in `Promise.race` against a 60 s `setTimeout` **also** never
came back:

```js
const R = await Promise.race([
  T.runDirectorAttackSimulate({...}),
  new Promise(r => setTimeout(() => r({__timeout:true}), 60000)),
]);
```

The bridge wrote no response at all for that request, while the renderer stayed
responsive to CDP. So whatever stalls is upstream of the `await` returning —
consistent with the harness swallowing the continuation rather than the game
locking up. `installWriteCaptures()` monkey-patches the document prototypes and
restores them in a `finally`; if RESOLVE parks on an await that never settles,
that `finally` never runs either.

## Repro

Game open, GM joined, any scene with an armed attacker and any target:

```js
const T = FUCompanion.api.test;
await T.runDirectorAttackCompute ({attackerTokenUuid: A, targetTokenUuids:[B], force:true}); // ok
await T.runDirectorAttackSimulate({attackerTokenUuid: A, targetTokenUuids:[B], force:true}); // hangs
```

Attacker needs an equipped main weapon or compute bails early with
`no_main_weapon` (that path returns correctly).

## Impact

`skill-regression` is unaffected — it runs **compute** mode, and 482/482 still
pass. What is blocked is any end-to-end verification that needs RESOLVE or
CONFIRM, which is exactly the surface your own `8af5796e` KNOWN GAP asked for. I
got the Adrenaline preview verified by calling `applyAcceptedCardMutations`
directly instead (see `2026-07-31-adrenaline-card-preview-verified`), but that
only works because the mutation is separable — a real CONFIRM-path test has no
route right now.

Possibly related to the four UI gates you answered in `3a72c7db`; this looks like
a fifth, or a regression of the same class.

## Notes

- Not investigated: whether `runDirectorScenarios` (which drives both simulate
  functions, `_test-harness-director.js:1506,1513`) is equally affected. If it is,
  the scenario suite is dead too and that would raise this to blocker.
