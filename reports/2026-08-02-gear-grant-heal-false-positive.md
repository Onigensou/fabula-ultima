---
id: 2026-08-02-gear-grant-heal-false-positive
title: healGearSkillGrantProjections() heals nothing — its predicate flags 45 healthy projections
status: open
severity: minor
reporter: onigensou
assignee: sarunphat
component: scripts/main.js
introduced_in: ef0650fb
fixed_in:
---

# The gear-grant heal is a no-op that costs CSB `prepareData()` on every boot

`ef0650fb` made `scripts/main.js` parse for the first time, so
`healGearSkillGrantProjections()` (`main.js:168`) started running at `ready`.
Measured against this world it heals **zero** projections and does a pile of
expensive work to get there.

## Symptom

On this world (290 actors) the predicate flags **45 projections across 37
items**. Every one is a false positive.

## Evidence

Categorised live via the test-bridge using the function's own `isBroken`
predicate, split by which arm fired:

```json
{ "missingUuid": 0, "templateId": 45, "both": 0 }
```

Representative entries:

```json
{ "actor": "Blanche",         "item": "Mega-Remedy",  "itemType": "consumable",
  "key":  "qGDOMAtenjvpbAeC", "id": "${item.id}",
  "uuid": "Actor.uJFaNQCSvwwsr2AW.Item.qGDOMAtenjvpbAeC" }

{ "actor": "EXFURSION Party", "item": "Swordbreaker", "itemType": "weapon",
  "key":  "JHpQYYXUNM3BHFmr", "id": "${item.id}",
  "uuid": "Actor.t6E3CQ0pGxwLgXrn.Item.JHpQYYXUNM3BHFmr" }
```

Mostly consumables/recipes on Blanche, Commodities Shade, Burning Hand and
EXFURSION Party, plus some equipment.

## Root cause

The predicate treats an unexpanded `${...}` in `e.id` as breakage:

```js
return Object.values(proj).some(
  (e) => e && (!e.uuid || /\$\{/.test(String(e.id ?? ""))),
);
```

But in this world's data those projections are **healthy**:

- `uuid` is fully resolved and correct,
- `key` already equals the real embedded item id (the tail of the uuid),
- only the cosmetic `id` field carries the literal string `"${item.id}"`.

Nothing reads `id` to resolve the grant — `uuid` does that. And `prepareData()`
cannot fix it anyway, because `${item.id}` is a **stored** CSB value, not a
derived one. So the heal loop re-detects the same 45 entries every boot,
`healed` stays 0, and the debug line never prints.

## Impact

Per client, per world load: a walk over 290 actors × all their items, plus **37
CSB `item.prepareData()` calls** that change nothing. CSB `prepareData` is
already this world's known lag source (measured 300-600ms per PC in the
scorched-tile investigation), so this is not free — it is pure boot cost for a
guaranteed-zero result.

Correctness is unaffected either way; the grants work.

## Suggested fix

Drop the `/\$\{/` arm and key the predicate on the thing that actually matters:

```js
return Object.values(proj).some((e) => e && !e.uuid);
```

On this world that yields 0 candidates and the loop exits immediately.

If the `${item.id}` literal *is* considered wrong data on your side, it wants a
one-time migration that rewrites the stored prop, not a `prepareData()` retry at
every `ready` — please say which, since the two readings imply different fixes.

## Notes

- Not urgent and not a regression; the function is read-only against the DB
  (`prepareData()` re-derives in memory, no writes), so there is no corruption
  risk from leaving it as-is.
