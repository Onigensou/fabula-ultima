---
id: 2026-07-31-director-simulate-hangs-resolve
title: runDirectorAttackSimulate / runDirectorSkillSimulate hang forever at RESOLVE
status: fixed
severity: major
reporter: onigensou
assignee: sarunphat
component: battle-director/_test-harness-director
introduced_in:
fixed_in: 841b3ba5
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

## Notes

**2026-08-23 — fixed; re-ran your repro and it returns.** Marked `fixed_in:
841b3ba5`, but read that as "the most recent of a chain", not a pinned
attribution — see below.

```
runDirectorAttackSimulate({ attacker: Zarg, targets: [Hellhound A],
                            mode:"main", force:{hit:true} })
  -> returned in 12.7 s
     ok: true, reason: null, resolveError: null
     perActorWrites: 2, captures: actorUpdates / itemUpdates / aeUpdates /
                                 aeCreates / aeDeletes / freeActions
```

Three separate harness fixes landed between your report and now, and any of them
could be the one that unblocked it — I did not bisect:

- `841b3ba5` — RESOLVE called `director.dCombat.addHitOnTarget(...)` behind a
  `director.dCombat && …` guard that a bare `{ round }` object PASSES, so every
  damaging action that HIT threw mid-resolve. Fixed with `makeHarnessCombat`.
- `26cd24ba` — a leaked write-capture patch silently ate every subsequent write.
  This is the mechanism your last section predicted: "if RESOLVE parks on an
  await that never settles" the `finally` never restores the prototypes.
- `fe6e3f7f` — settle before restoring, or writes are attributed to the wrong
  document.

⚠ **Only the ATTACK path is re-tested.** `runDirectorSkillSimulate` is named in
your symptom table and I did not run it: a Zarg skill containing an
`open_action_menu` chain is known to hang a headless run for ~76 minutes (the
list-picker gates on SimMode, not the headless flag), and a hang there would
leave the write-capture patch installed and void every later measurement in the
session. If you have a skill uuid that reproduced it, that is the cheapest way to
close the other half.

⚠ Also worth knowing when you re-verify: a suite that reads `captures` WITHOUT
checking `resolveError` saw damage and no post-damage AEs, so any assertion of
ABSENCE made against this harness before `841b3ba5` passed for the wrong reason.
