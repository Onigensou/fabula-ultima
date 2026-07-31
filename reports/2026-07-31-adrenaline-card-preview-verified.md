---
id: 2026-07-31-adrenaline-card-preview-verified
title: Adrenaline Potion card-preview half verified — your KNOWN GAP is closed
status: verified
severity: minor
reporter: onigensou
assignee: sarunphat
component: battle-director/card-mutations
introduced_in: 8af5796e
fixed_in: 8af5796e
---

# The −15 card preview works, including dedup and the no-spend-on-preview rule

`8af5796e` shipped with:

> KNOWN GAP: the card-preview half is not yet verified in play.
> runDirectorSkillSimulate does not exercise CONFIRM, so the -15 rendering on the
> card still needs one live battle.

Verified. No live battle was needed — the mutation is reachable directly.

## How

`applyAcceptedCardMutations` was driven against a **real computed action**
(Zarg's +5 Bow → Salamander via `runDirectorAttackCompute`), with the Adrenaline AE
live on the target and a candidate matching what the reaction pipeline builds:

```js
const cand = { carrierUuid: ae.uuid, carrierKind: "ae", carrierName: "Adrenaline",
               ref: "adr_soak", reactorActorUuid: actor.uuid, reactorTokenUuid: TGT };
const res = await cm.applyAcceptedCardMutations(ar, [cand]);
```

## Result

```
before             [{ dmg: 28, hit: true }]
after              [{ dmg: 13, hit: true }]     delta exactly 15
mutationsApplied   1
carrierConsumes    [{ aeUuid: "…ActiveEffect.HT4lLceAqc3vxGnZ",
                      count: 1, deleteWhenEmpty: true }]
dedup (cand x2)    1 consume queued          (expected 1)
AE after preview   present, charges still 1
```

All four properties you designed for hold:

1. **The −15 lands on `perTargetResults`** — the numbers the card renders.
2. **The consume is recorded, never written** — the AE is still at `charges: 1`
   after the preview pass, so a cancelled action spends nothing.
3. **Dedup by carrier uuid works** — passing the same candidate twice still queues
   exactly one consume.
4. **Single surface, no double-soak** — one `mutationsApplied` for one row.

Combined with the spend half you already proved (1/1 → 0, `deleted: true`), the
whole Apply → Preview → Spent chain is now covered.

## Sanity check that this was the right layer

The soak does **not** appear at COMPUTE — correct, and worth recording so nobody
"fixes" it later. 10 paired compute runs with and without the AE:

```
without AE  [26,25,30,29,30,27,33,26,30,27]  mean 28.3
with AE     [29,33,33,27,29,28,26,27,31,30]  mean 29.3   delta -1 (noise)
```

Bow damage varies per roll, so a single A/B pair is meaningless here — my first
one showed a 5-point "drop" that was pure variance. The card surface is the only
place the soak applies, exactly as designed.

## Not covered

The CONFIRM drain writing the consume was not re-run — you proved that half, and
it is blocked here by a separate harness problem filed as
`2026-07-31-director-simulate-hangs-resolve`.
