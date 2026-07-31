---
id: 2026-07-31-csb-restamp-reset-effect-rows
title: Booting the world re-stamped item templates and reset two of your Tier S/A effect rows
status: verified
severity: major
reporter: onigensou
assignee: sarunphat
component: world-data / CSB item templates
introduced_in: 8af5796e
fixed_in: a5c14f31
---

# CSB re-stamp silently reset two authored dropdowns

Pulling `8af5796e` and **booting the world once** reset two `effect_kind` /
`grant_resource` selects on the new Exfursion items. Both were verified working on
your side, so the loss happened on the exchange, not in your authoring.

## Symptom

```
Wind Stone      effect_table.0.effect_kind    "deal_damage" -> "grant"
Golem Fragment  effect_table.0.grant_resource "shield"      -> ""
```

The sibling fields survived — Wind Stone still had `damage_amount 40` /
`damage_element air`, Golem Fragment still had `grant_amount 5`. Only the select
values were lost, which is what makes this dangerous: the row still *looks*
authored on the sheet, but a `grant` row with no resource and a former
`deal_damage` row that now says `grant` both do nothing.

## Why the loss gate did not catch it

`world-export report` was **clean the whole time**:

```
added docs: 0 · removed docs: 0 · modified docs: 2
✓ No removals detected — safe to submit.
```

Nothing was removed — a *value* changed. The removal gate and the `pre-commit`
hook only look for dropped documents and dropped embedded skills, so this class
is invisible to both. It only surfaced because the modified docs were diffed
field-by-field before committing.

That is the actual lesson here: on a world exchange, **"no removals" is not "no
regressions"** and the MODIFIED docs need a value-diff, not just a removal check.

## Root cause (partial)

The re-stamp rewrote each row with a wider field set than your export carried —
the same items gained `damage_ignore_affinity`, `emit_status`, `emit_trigger`,
`reaction_config_table`, `skill_tags`, `skill_target`, `refine_level`,
`ingredient_taste`, etc. The two selects whose values did not survive that rewrite
are the two that were reset. I did not chase which template version diverged.

It is *not* a template invalidation — both values are still perfectly legal here:

```
effect_kind    "deal_damage"       74 other uses world-wide (post-boot)
grant_resource "shield"            10 other uses world-wide (post-boot)
```

## Repair + durability

Restored via `safe-edit` in `a5c14f31`, then **booted a second time** and re-read
the live values to confirm the repair is not undone on every load:

```
windStone_effect_kind      "deal_damage"   windStone_amount 40   element air
golemFrag_grant_resource   "shield"        golemFrag_amount 5
```

So it was a one-time migration artifact, not a recurring reset.

## What I need from you

The world data is fixed on this side. The risk is on yours: **if you re-export
these items from a world that has not been booted through this migration, you may
re-ship the pre-stamp shape and reset them again.** Worth booting once and
diffing the two rows before your next world push.

## Benign re-stamp churn (deliberately kept, not a bug)

Listed so you do not chase them as regressions:

- `item_quantity` `1` -> `"1"` on three items (number/string coercion)
- Winter Kolossus `props.id` / `props.uuid` corrected from the stale folder-copy id
  `9BKhWjQctWsHbrie` to its real embedded id `mf5Cc0hGzVW9yyrT` — this is a fix
- Myrmidon Dance `skill_active_list.active_cost` `"10 MP"` -> `""`. All eight
  sibling dances and Myrmidon's own authored `cost` prop are already `""`, so the
  aggregate converged to the established pattern. Your `"10 MP"` looks like a stale
  artifact carried in from the Golem Dance clone. Flagging in case 10 MP was the
  intent — if so, no dance in the world currently encodes its cost.
