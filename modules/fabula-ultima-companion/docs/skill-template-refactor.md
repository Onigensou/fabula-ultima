# Skill template refactor — draft 1

> ⚠ **The width metric in this document is superseded.** It counts the UNION of
> columns across a skill's rows, which is stock `dynamicTable` behaviour;
> `effect_table` is a module-owned `compactDynamicTable` that renders per row and
> skips invisible chips entirely. See the SUPERSEDED METRIC box in
> [effect-kind-usability.md](effect-kind-usability.md) for the corrected
> per-row numbers and the two conclusions that invert.


Goal as briefed: make `_Skill Template` lighter and easier to use, dropping
fields that aren't needed.

## What the measurement actually found

The template is **46 top-level fields + 166 table columns** across 2242
instantiating documents. The obvious move — delete unused fields — turns out to
be nearly a dead end, and the real weight is somewhere else.

**Almost nothing is removable.** Of the 212 declared fields, only **28** are
never set in the entire corpus, and **25 of those 28 are read by the engine** —
they are live primitives waiting for their first author, not dead weight.
Deleting them would break the primitive, which the project's own standing rule
forbids. Exactly **three** are dead in both data and engine:

| field | where | status |
|---|---|---|
| `skill_animation_default` | top-level | 0 docs, 0 engine reads |
| `weapon_categories` | `effect_table` | 0 rows, 0 engine reads |
| `consume_vital` | `effect_table` | 0 rows, 0 engine reads — superseded by `on_empty: drain` + `consume_can_defeat` |

Three deletions will not make anything feel lighter. So "too many fields" was
the wrong diagnosis.

**The template is already well gated — the gating is just mis-wired.**
`effect_table` has 129 columns but only 6 render unconditionally; the rest are
hidden per `effect_kind`. The machinery is good. What's broken is what it's
wired to:

- **320 authored cells, across ~100 skills, are invisible in the sheet today.**
  The data is in the row; no human can see or edit it.
- **868 more cells sit in 50 row keys the template never declared a column for**
  — uneditable, and CSB prunes an undeclared prop on `reloadTemplate`, so a sheet
  save can silently delete them. `filter_tag` (76 cells) is in this set, despite
  a registry comment asserting it already had a column.
- `reaction_config_table` renders **15 of its 26 columns on every row**, most of
  them filters that can only ever apply to one family of trigger.

That is the real answer to "why is this hard to use": fields appear and vanish
unpredictably, and the ones you most want to edit aren't there at all.

### The two root causes

1. **`triggerNeeds` / `triggerHasSubject` treated "unregistered" as "declares
   nothing".** The trigger dropdown offers 47 keys; the registry defines 32. For
   rows on the other 15 — **176 of 542 rows, 32%** — every gated column
   evaluated to hidden. The file's own "Conservative defaults" docstring says an
   unknown key should *show* the cell; the code did the opposite.

2. **`reaction_passive_target` was gated on `reaction_isPassive`** — a legacy
   prop the reaction editor stopped writing when firing *mode* replaced the
   passive flag. **Zero** of 544 rows carry it, so all **142** authored values
   were hidden — while the reaction editor separately warns when an auto-firing
   row *lacks* one. Unfixable from the sheet, because the cell wasn't rendered.

## What this draft changes

**1 · Unknown trigger ⇒ show the cell** (`reaction-formulaFunctions.js`).
Distinguishes "registered, declares no filters" from "not registered". Restores
**178** cells and makes the code match its documented intent.

**2 · Trigger families** (`reaction-triggers.config.js`). A new
`TRIGGER_FAMILIES` map (`resource` / `status` / `action`) plus
`triggerInFamily()`, exposed to CSB formulas. The eight broad reaction filters
are now gated by family instead of rendering always. Per-trigger `filters:`
stays for the narrow payload filters — gating the broad ones that way would mean
~25 entry edits where one omission silently hides live config.

**3 · `reaction_passive_target` regated** to "visible unless the row is off",
and registry-owned so the fix reaches every template. Restores **142** cells.

**4 · The registry can now fix existing columns** (`_module-boot.js`). The boot
sync only ever *added* missing columns, so a corrected gate or tooltip written in
the registry never reached a column that already existed — which is why fix #3
could not otherwise ship. One flag, `reconcileVis: true`, governs the whole
entry: without it nothing is pushed onto an existing column, not even a tooltip
(prose that describes an over-narrow gate is wrong in the same way the gate is —
see `grant_resource` below). `type` and `options` are never touched, and a
type mismatch now logs instead of silently skipping.

**5 · Thirteen data-only fields registered** — `filter_tag`, `consume_resource`,
`consume_amount`, the `cost_*` trio, the `substitute_cost` five,
`menu_description`, `menu_color`. ~640 of the 868 uneditable cells, with kind
gates taken from measured usage rather than from each handler's doc comment.
Resource dropdowns are derived from `RESOURCE_REGISTRY` rather than hand-copied,
so `resources.js`'s "add a row and that's it" contract stays true.

**6 · Three tooltips corrected.** They named the wrong triggers, and gating from
them would have hidden live data — `reaction_source_skill` says
"creature_completes_skill" but 49 of its 58 live rows are on the damage triggers.

**7 · New audit** — `tools/csb-template/bin/visibility-audit.js` (game closed,
~2 s). Reports [A] gates referencing a field no column supplies, [B] data-only
keys, [C] registry gates **narrower** than real usage — each marked `latent`
(inert), `ARMED` (opted in), or `ON-CREATE` (a new column, whose gate applies
whatever the flag says) — and [D] registry gates **broader** than the live
column, which is pure upside. [D] exists because [C] alone made the process
lopsided: it listed every dangerous opt-in and none of the valuable ones, so the
single biggest pocket of hidden config was invisible to the very check that
gates arming. [D] also flags `TYPE-FIX` rows, where a type divergence means the
reconcile would skip and the promised win would not actually ship.

**8 · The AE reaction editor was carrying the same two bugs** and is now aligned
(`ActiveEffectManager-reaction-ui.js`): it had its own copies of
`triggerHasSubject` / `triggerNeeds` with the old hide-on-unregistered rule, and
showed `reaction_passive_target` only on auto-fire modes — hiding it on the 40
live rows that pair a Passive Target with `ask`.

**9 · `_apply-column-sync.mjs`** (the tool that lands a registry change on a
running world) now strips `reconcileVis` like boot does; it would otherwise have
persisted the registry's bookkeeping flag into `system.body` permanently. ⚠ That
file lives under `tools/fvtt-playwright/`, which `.gitignore` keeps local — so
the fix protects this machine only. Anyone else with their own copy of that
script needs the same one-line strip. (`visibility-audit.js` is under
`tools/csb-template/`, which is un-ignored, so the audit itself does ship.)

**10 · Five more gates armed, off the back of [D]** — `condition_formula` (203
cells), `prompt_var` (14), `damage_bonus_formula` (10), `check_bonus_formula`
(9), `menu_title` (7). The correct gates were already written in the registry and
simply never reached the template; all five restore cells and hide none.
`condition_formula` alone is a bigger pocket than the `passive_target` fix that
motivated this work: the live column gates it to `apply_action_keyword`, while
`applyEffectRow` evaluates it for *every* kind outside
`DISPATCH_CONDITION_EXEMPT_KINDS`.

## Why `reconcileVis` is opt-in

Making the registry authoritative is what fix #3 needs, and it is also the
single most dangerous change here. Auditing every registry gate against live
data found **20 gates narrower than actual usage** — `grant_amount` is declared
`adjust_grant`-only but authored on 177 `grant` rows; `count` is declared
`trigger_opportunity`-only but authored on 127 `targeting` rows. They are
harmless *only* because the sync never touched existing columns. Reconciling
unconditionally would have armed all 20 at once and hidden **~750 authored
cells** — trading a 320-cell bug for a 750-cell one.

So a gate ships only when it has been checked against the corpus — the check is
`visibility-audit` [C] (does it hide anything?) and [D] (does it restore
anything?). Current state: **13 opted in, 0 regressions, 19 latent gates left as
findings** (below).

The flag is doing real work in both directions: it withholds `grant_amount`
(would hide 177 `grant` rows) while letting `condition_formula` through (restores
203, hides 0) — two entries that look identical until you measure them.

## Verification

**Net: 561 authored cells go from invisible to editable, and 0 visible cells are
lost** — 318 on the reaction side, 243 on `effect_table`.

Replaying all 544 reaction rows against old vs new gates:

```
authored cells HIDDEN before : 321
authored cells HIDDEN after  : 3
RESTORED: reaction_source 153 · reaction_passive_target 142
          reaction_action_target 14 · reaction_damage_source 8 · reaction_action_intent 1
REGRESSIONS (visible before, hidden now): 0
```

The 3 still hidden are correct: `reaction_source` on `conflict_start` /
`round_end`, which have no subject. Those rows are authoring mistakes worth
cleaning separately.

Re-run against a **freshly regenerated** `_authored-export` (the first pass used
one ~9 h stale): identical numbers, so the counts are current.

Deliberately hidden on create, all inert: `consume_resource` / `consume_amount`
on 15 `adjust_cost`/`chain` rows that carry an ignored duplicate of `cost_*`, and
`filter_tag` on 2 `grant` rows (Chomp, Blast Breath). Audit [C] lists them as
`ON-CREATE` rather than burying them.

`parity` and `census` both pass. `skill-regression check` needs the game open
and has not run yet — nor has a boot, so the reconcile's convergence (second boot
should log "all registry columns present and in sync") is unverified.

## Not done — follow-ups, in priority order

1. **19 over-narrow registry gates** (list: `visibility-audit` check [C], the
   `latent` rows). Each needs widening to its measured kinds before it can be
   opted in. ~745 cells — `count` (257) and `grant_amount`/`grant_resource`
   (371 between them) are the bulk.
2. **7 columns whose registry TYPE diverges from the live template** —
   `grant_amount` and `count` and `max_mp_cost` (numberField vs textField),
   `auto_target` (checkbox vs select), `grant_operation` / `grant_round` /
   `accuracy_operation` (textField vs select). The reconcile skips these and now
   warns; check [D] marks them `TYPE-FIX`. **34 cells of otherwise-safe restore
   are stuck behind this** (`max_mp_cost` 13, `grant_round` 11, plus the mixed
   rows). Each needs a real decision — the registry's 3-way `auto_target` select
   cannot be expressed as the live checkbox, so this is a data migration, not a
   type edit. The create path is also un-type-guarded, so a fresh or restored
   template would get the registry's shape while the four live ones keep theirs.
3. **37 remaining data-only row keys** (~230 cells) — notably the `summon_*`
   family, `disable_ui_type` / `disabled_reason`, `chance_*`.
4. **15 unregistered triggers.** Fix #1 stops them hiding cells, but a missing
   `subjectFrom` may also weaken *runtime* `reaction_source` filtering. Not
   investigated; worth confirming before trusting a source filter on
   `creature_will_deal_damage` (70 rows).
5. **The 3 dead fields** above — removal needs a prune path the registry lacks.
6. **7 lifecycle triggers belong to no family** (conflict/round/turn start-end,
   `pre_turn_end`), so the family-gated filters are unauthorable on them. The
   engine's `passesMatchFilters` is trigger-agnostic and applies those filters on
   *any* trigger, several failing closed on a missing payload field — so hiding
   the cells is the safer half of a real engine/UI mismatch, but the mismatch
   itself is unresolved. Documented in the config; worth settling properly.
7. **42 always-visible top-level fields**, several very rare (`gadget_*` = 3
   fields / 1 doc). Header decluttering is untouched by this draft.
8. **`flags.custom-system-builder.templateHistory` is 320 KB** — CSB undo history
   shipped in every commit and export, ~1/3 of the template document.
