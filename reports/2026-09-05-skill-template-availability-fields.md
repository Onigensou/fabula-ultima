---
id: 2026-09-05-skill-template-availability-fields
title: Skill template gained two declared fields (Usable When / Unavailable Reason) — the export shows only a version bump
status: verified
severity: minor
reporter: sarunphat
assignee: sarunphat
component: world-data / CSB skill template
introduced_in:
fixed_in:
---

# What changed, since the diff cannot show you

`_Skill Template` (`Item.j0F5Msw5RZ8aIB3j`, 2325 documents) gained two declared
header fields. **`world-export` strips `system.body` / `system.header`**, so this
whole change appears in the review surface as exactly one line:

```
-    "templateSystemUniqueVersion": 2788278388
+    "templateSystemUniqueVersion": 676985038
```

Filing this so that bump is not an unexplained mystery on the next pull.

## The fields

| key | label | visibility |
|---|---|---|
| `availability_formula` | **Usable When** | skill_type Active / Spell / Attack |
| `availability_reason` | **Unavailable Reason** | as above, AND only once a formula is set |

Placed immediately after `target_eligibility` ("Eligibility Filter") in the header
panel. That field is the existing gating formula and filters WHICH TARGETS are
legal; these filter WHETHER THE SKILL IS OFFERED AT ALL. Same class of decision,
so they sit together.

## Why it had to be done

Both props were **engine-read but undeclared on every template in this world**.
`skill-picker.js` reads `availability_formula` directly to grey a skill out and
show `availability_reason` as the explanation — but `reloadTemplate()` PRUNES every
undeclared prop, writing a persisted `system.props['-=key'] = true` marker.

Measured before the fix: calling `reloadTemplate()` on a gated skill dropped
exactly these two keys, every time. The failure direction is **permissive and
silent** — a pruned formula means no gate at all, so the skill becomes
always-clickable with no reason chip and nothing reports it.

Seven skills depended on it: Create Phantasm: Numen (one-Numen cap), Bimagus ×4
(arcane-weapon gate), Quaking Titan, Brainwave Discharge — plus Birth of the
Cruel: Dismiss. 13 documents carry the props in total.

## Verified after the change

- `availability_formula` is in the LIVE parsed component tree (`ctor: TextField`,
  label "Usable When") — a raw `system.body` write only counts if it registers,
  and only a render test shows that.
- `reloadTemplate()` on a gated skill now drops **nothing**; no `-=` markers persist.
- The picker still greys the skill with the authored reason after a reload.
- Create Phantasm: Numen's own gate is intact.
- **No mass backfill**: 2325 docs ride this template; 13 carry the props, and all
  13 author a real gate. CSB backfills a declared field's default only when a
  document's sheet is actually opened.

## Two things to know

1. **`_Skill Template (Copy)` (`Sodp3LYHuhrZI5xO`) was deliberately NOT patched.**
   It backs 0 documents and is a stale snapshot several generations behind — it has
   no `target_eligibility`, no `skill_tags`, no `action_keywords`. Adding one modern
   field to a dead template missing three others would be cargo-cult.
2. **One unrelated document is dirty in this diff: `Keren / See you later`.** Its
   sheet was opened while capturing screenshots, and CSB backfilled 18 template
   defaults onto it (`action_keywords`, `defense_target_type`, `reaction_config_table`,
   …) plus normalised `level: 1` → `"1"`. Verified key-by-key against HEAD:
   **zero keys lost**, purely additive. This is the standing "opening a sheet
   backfills defaults" behaviour, not a consequence of the new fields — any GM
   opening that sheet gets the same. Left as-is because reverting it only defers it.
