---
id: 2026-11-10-condition-resist-table-structure
title: Design question — restructure the condition Resist/Immune table, and should we build our own Active Effect / status system?
status: open
severity: minor
reporter: onigensou
assignee: sarunphat
component: csb-template (actor templates) / shared/condition-affinity.js
introduced_in:
fixed_in:
---

# Not a bug: a structure question, asking for your call

Written for sarunphat. You reworked the CSB data structure last (shared actor layouts) and
made the game much faster, so this one is yours to judge. Nothing here is built yet, and
nothing in the current game is broken.

## Why this is coming up now

We are adding two general statuses, **Armor Break** (DEF -25%, round up) and **Magic
Break** (M.DEF -25%, round up), 3 turns, cleansable. They are statuses, so in the end
monsters (and gear) should be able to **Resist** or be **Immune** to them like any other
condition. For now we ship them **without** a Resist/Immune column on purpose, because
adding one means changing the actor templates, and that structure is part of the older
setup from before the vibe-coding era. We would rather ask you first than add two more
columns to something you may want to replace.

## How it works today

- Each actor has one flat prop per condition: `system.props.condition_<slug>` =
  `"NA"` / blank | `"RS"` | `"IM"`. There are **37** of them.
- **NPC template:** a dropdown per condition. **PC template:** read-only label fields
  (a direct `actor.update` reads back `""`), so PCs can only get RS/IM through an Active
  Effect change (e.g. Orbment augments write `condition_<status>` with OVERRIDE).
- One reader turns a status into a prop: `scripts/shared/condition-affinity.js`
  `getConditionAffinity()` (AE status id → `CONFIG.statusEffects` name → slug →
  `condition_<slug>`). Some names drifted from the prop slugs, so it carries an alias map
  (`doomed→doom`, `cursed→curse`, `charmed→charm`, `delay→delayed`,
  `suppressed→suppress`, `paralyze→paralyzed`).
- Users of that reader: `skill-effects.js` `apply_ae` (IM skips, RS clamps to 1 charge)
  and `battle-director/condition-adoption.js` (reshapes conditions applied mid-battle from
  the token menu or AEM). Both are Battle-Director only.
- A second, hand-kept list of the same 37 slugs lives in
  `scripts/encyclopedia/encyclopedia-core.js:452` (`CONDITIONS`) for the bestiary page.

## What makes it awkward

1. **Adding a status = a template change on two templates** (NPC dropdown + PC label),
   plus the encyclopedia list, plus maybe an alias. Template re-stamps have reset
   dropdowns before (CSB re-stamp trap), so every new status is a risky world edit.
2. **Some debuffs already have no column** and so can never be resisted: Break, Frozen,
   Provoked, Death (and Armor Break / Magic Break once added). `anomaly` has a column
   but no keyword-registry entry.
3. **Two sources of truth** for "which conditions exist": the template columns and the
   encyclopedia array, neither generated from the status library or the keyword registry.
4. **PC vs NPC shapes differ** (dropdown vs read-only label), so the same idea is written
   two different ways.
5. Every actor stores 37 mostly-`NA` values. Small per actor, but it is the same kind of
   repeated data the shared-layouts work removed.

## The bigger picture: the status/effect stack is mostly third-party

While adding the two statuses we traced how a status is registered and applied. Most of
the chain is other people's modules, not ours:

| Piece | Who owns it | What it does for statuses |
|---|---|---|
| `custom-system-builder.customStatusEffects` (world setting) | CSB | The status list. CSB copies it into `CONFIG.statusEffects` at `init`. Entries are `{ id, name, img, linkedEffectId }`. |
| Debuff library item (`Item.XVOWOq9oUmEECGrU`, `activeEffectContainer`) | CSB container + our data | Holds the template AE per status (charges, lifetime, changes). |
| `dfreds-convenient-effects` | Convenient Effects | Because it is active, CSB resolves `linkedEffectId` through CE's `findEffect`, not through its own container. Every template AE carries CE flags (`ceEffectId`, `isConvenient`). |
| `statuscounter`, `status-icon-tweaks` | third-party | Counter flags on every status AE; token icon tweaks. |
| `effectmacro` | third-party | Slow / Dazed etc. toggle `isSlow` / `isDazed` props through effect macros. |
| `combat-utility-belt`, `condition-lab-triggler` | third-party, **disabled** | Their `activeConditionMap` settings (~32 KB and ~61 KB) are still in the world, unused. |

Our own code then sits on top: `condition-affinity.js`, `condition-adoption.js`,
`skill-effects.js` lifetimes/charges, `status-classifier.js`, the AEM, the HUD pips and
the NPC status strip.

**What we did this time:** we did NOT edit `customStatusEffects`. That setting lives in
the `settings` store, which also carries per-session churn that world commits leave out.
Instead the two statuses are appended to `CONFIG.statusEffects` at `setup` by a new module
script, `scripts/csb-extensions/csb-extra-status-effects.js` (skips any id already in the
list). Their template AEs sit on the Debuff library like Bane. It is a stopgap, and it
means the status list now has two sources (the setting + that script).

## Questions for you

1. Do you think this table needs a restructure, or should we just add
   `condition_armor_break` / `condition_magic_break` to both templates the usual way?
2. If you would restructure: what shape fits the CSB setup you built? Ideas only, your
   call:
   - one map prop per actor that only stores the non-`NA` entries
     (e.g. `{ armor_break: "RS", frozen: "IM" }`), with the sheet's table built from the
     status library, so a new status needs no template change;
   - or keep the flat props but generate the template columns and the encyclopedia list
     from one registry.
3. Anything that reads `condition_*` outside the files above that we missed (macros, the
   sim, the dossier tools)? `tools/mindscape` does not read them today as far as we found.
4. **Should we build our own Active Effect / status system** instead of leaning on CSB's
   status setting + Convenient Effects + statuscounter + effectmacro? We are doing
   nothing about it now; onigensou is asking whether it is time to plan it. The user's
   standing preference is our own systems over third-party modules (we already replaced
   LockView and parts of the token UI). If yes, the Resist/Immune table above would
   naturally become part of it: one status registry (id, name, icon, template AE,
   rules journal, resist slug) that the token menu, AEM, Battle Director, keyword
   chips, bestiary and the Resist/Immune table all read. Your view on scope, order and
   what would break (CE flags on every template AE, effect-macro toggles, the 57-entry
   setting) would decide it.

## What we do meanwhile

Armor Break / Magic Break ship with no Resist/Immune support. `getConditionAffinity()`
returns `null` for a slug with no prop, so they always land in full. No template is
touched. Rakshasa keeps its own `Crippled` (DEF halved), unchanged, so its tuned fight is
not affected.

## Notes

- 2026-11-10 onigensou: filed; waiting for your read before we add any columns.
- 2026-11-10 onigensou: added the third-party status-stack section and question 4 (own
  Active Effect system?). No action planned until you have weighed in.
