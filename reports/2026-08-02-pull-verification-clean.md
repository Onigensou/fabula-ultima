---
id: 2026-08-02-pull-verification-clean
title: 2026-08-02 pull verified clean — 482/482 goldens match, zero authored drift
status: verified
severity: minor
reporter: onigensou
assignee: sarunphat
component: verification
introduced_in: f2353c70
fixed_in:
---

# Your 7 commits landed clean on this side

Filing the positive result too, since `18594249` and `1ae2032d` both touch shared
engine paths and you had no way to know how they landed against this world's
content.

Pulled `765bd550..f2353c70` as a fast-forward. Foundry closed for the export,
reopened for the regression pass.

## skill-regression — no behavioral change

```
skill-regression check — compute mode, scene "Regression Bench", 482 skills
  engine now 1.0.423
✓ no behavioral changes — all skills match golden.
```

Full run, `bench` rebuilt fresh (66 actors / 482 skills — matches
`_meta.count` exactly), `--teardown` after, so no bench scaffolding is left in
the world data.

Worth reading precisely: this says the **PC/template skill catalogue in compute
mode** is unchanged. It does *not* prove `18594249` (the `deal_damage`
outgoing-modifier pass now actually firing) is inert — if that pass is only
exercised on monster or reaction paths, these fingerprints would not see it.
If you expected a visible damage delta somewhere, it did not show up here, and
that may be worth a second look on your side.

## world-export — zero authored drift

```
added docs: 0 · removed docs: 0 · modified docs: 0
✓ No removals detected — safe to submit.
```

Notably the CSB re-stamp did **not** reset any effect rows this time — the
failure mode from `2026-07-31-csb-restamp-reset-effect-rows` did not recur, so
that one really was a one-time migration artifact.

## LevelDB integrity

0 dangling `CURRENT` across all 14 stores, checked both before and after the
verification boot. All rotated MANIFESTs present.

## Two latent bugs your commit exposed

Turning on `main.js` started executing code that had never run. Neither is a
regression from your change; both are filed separately:

- `2026-08-02-howler-gone-cursor-sfx-dead` (cosmetic)
- `2026-08-02-gear-grant-heal-false-positive` (minor)

## Unrelated pre-existing state, for the record

Preflight reports 1 FAIL — `AncientTemple_Map002` expects a pre-placed "Hina"
token, found 0. Not yours: the pull never touched `scenes/`. It is a wandering
party token captured into a scene golden; needs a re-bless on this side.
