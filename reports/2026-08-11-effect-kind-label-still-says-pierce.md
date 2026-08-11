---
id: 2026-08-11-effect-kind-label-still-says-pierce
title: effect_kind dropdown still reads "Apply Action Keyword (Pierce, …)" — the one keyword that row cannot grant
status: open
severity: minor
reporter: onigensou
assignee: sarunphat
component: battle-director/skill-effects
introduced_in: 12ed3f1e
fixed_in:
---

# The authoring dropdown still advertises Pierce

`755f2deb` corrected the registry's *comments* to say `apply_action_keyword` cannot
grant Pierce. Agreed on the mechanism, and thank you — it explained a constraint I had
written down wrong on my side. But the fix stopped one layer short of the surface an
author actually reads.

`EFFECT_KIND_LABELS` still names Pierce as *the* example of this effect kind:

```js
// skill-effects.js:4122
apply_action_keyword: "Apply Action Keyword (Pierce, …)",
```

That string is not a code comment. `_module-boot.js:180` feeds `EFFECT_KIND_LABELS`
straight into the CSB `effect_kind` registry:

```js
registries.effect_kind = se.SUPPORTED_EFFECT_KINDS.map((k) => ({ key: k, value: se.EFFECT_KIND_LABELS?.[k] ?? k }));
```

so it is the literal text in the dropdown at authoring time. An author picking the
effect kind is told to reach for Pierce, and only finds out otherwise if they then read
the `action_keyword` tooltip — which, correctly, does not offer Pierce at all
(`template-field-registry.js:245-248`: `drain`, `crush`, no default).

## Why this is worth a report rather than a shrug

This is the same failure mode your own tooltip already documents:

> NO DEFAULT ON PURPOSE — an unset row applies no keyword. The old default was 'pierce',
> which is how the Tinkerer's Vampire infusion silently shipped as ignore-Resistance
> instead of Drain: the author never touched the dropdown.

The default was removed; the *advertisement* was not. The failure is silent in both
directions — a row authored with `action_keyword: pierce` writes fine, saves fine, and
simply never applies, because `pierce` is read at PRIMARY:

```js
// action-profile.js:174, :238
pierce: !!weapon?.hasPierce || attackKeywords.includes("pierce"),
pierce: keywords.includes("pierce"),
```

and the reaction path deliberately no longer touches affinity:

```js
// action-profile.js:611-614 (comment)
// A reaction-granted `pierce` no longer touches affinity (see the inherent path
// above): affinity-bypass is `crush`, pierce is the miss-for-half rule only.
```

## Timeline

| commit | date | effect |
|---|---|---|
| `92e8ee09` | 2026-06-12 | label added — Pierce **was** a valid option then, so it was correct |
| `12ed3f1e` | 2026-08-03 | "canon-only Pierce" removes `pierce` from the dropdown — label becomes stale here |
| `755f2deb` | 2026-08-10 | comments corrected; label missed |

## Suggested fix

One line, naming a keyword the row can actually apply:

```js
apply_action_keyword: "Apply Action Keyword (Drain / Crush — NOT Pierce, see tooltip)",
```

I have not touched it — the file is yours and I did not want to collide with in-flight
work. Happy to push the one-liner if you would rather I did.

## Audit — no content was affected

Before filing I checked whether anything on our side had been authored against the old
advice. Scanned the world **LevelDB directly** (5373 documents / 2150 embedded items),
not `_authored-export`, and the export agreed exactly:

- **Zero** `apply_action_keyword` rows grant `pierce`. Nothing needs repair on either side.
- All 8 rows in the world use implemented keywords: `crush` — Chomp (gated
  `FINAL_DAMAGE >= 100`) and Lucky Mallet; `drain` — Gadgets ×3 and Blood Sword;
  `benign` — The Tormentor ×2. Branches confirmed at `action-profile.js:616` (crush),
  `:651` (benign), `state-handlers.js:851` (drain).
- Pierce is declared the correct way in all 4 places it exists: `action_keywords` on
  **Rail Stream** (Qilin), **Iceberg** (`"pierce, ignore_resistance"`) and **Create
  Phantasm: Strike**; plus **Chomp** via `has_pierce: true` → the NPC pseudo-weapon path
  (`actor-shape.js:148` → `action-profile.js:174`), which is also read at PRIMARY and is
  therefore fine.

So this is purely a foot-gun for *future* authoring, which is why it is `minor`. It is
also why it is worth closing: the trap is now the only thing left that still points the
wrong way.

## Notes

- `benign` is in use but is not in the `action_keyword` dropdown either. It works —
  `action-profile.js:651` reads it, and it is legitimate as a reaction keyword because it
  is a hit-time cap rather than a PRIMARY-stage decision. Flagging it only so you know
  the dropdown and the implemented set have drifted apart in two places, not one. If the
  dropdown is meant to be the authoritative list, `benign` probably belongs in it.
- No world data involved — repo code only. Nothing committed or pushed from my side.
