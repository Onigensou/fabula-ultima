# Effect kinds: what actually makes them hard to use

> ## ⚠ SUPERSEDED METRIC — read this before any number below
>
> Every "columns per skill" figure in this document (19.6 / 21.7 / p90 / worst,
> and the "+11% wider" headline) measures the **union of columns across a
> skill's rows**. That is how CSB's stock `dynamicTable` renders — it ORs
> visibility across rows (`DynamicTable.js:276`) and collapses a hidden cell to
> zero width.
>
> **`effect_table` is not a `dynamicTable`.** It is `compactDynamicTable`, a
> module-owned subclass that renders each row as flex chips and SKIPS an
> invisible field outright (`CompactDynamicTable.js`, `if (!visible) continue;`).
> There is no union and no zero-width cell. The union path survives only in the
> template-BUILDER view (`isBuilderTemplateSystem` defers to `super`), so the
> old numbers were real — they just described the template editor, not the sheet
> an author works in.
>
> The unit that matters is **per ROW**. Measured with
> `tools/csb-template/bin/row-width.js`:
>
> | table | chips rendered | filled | visible when folded |
> |---|---|---|---|
> | `effect_table` | 13.6 | 4.9 | **5.0 (-63%)** |
> | `reaction_config_table` | 20.4 | 5.1 | **5.2 (-74%)** |
>
> Two conclusions in this document invert under the correct model:
> - **"Reordering `rowLayout` measures nothing"** is WRONG — chip order *is*
>   `rowLayout` order in a flex row.
> - **Un-gating a cross-kind field costs 1 chip on EVERY row**, not one column
>   per skill — which is why `target_ref` and `count` were ungated only after
>   the fold made an empty chip free.
>
> The merge/redundancy analysis below stands; the width arithmetic does not.


Companion to [skill-template-refactor.md](skill-template-refactor.md). That pass
fixed fields that were *invisible*. This one tests the next hypothesis: the
effect kinds are hard to use — too many sub-fields each, and probably the same
field re-declared under different names per kind. Is that true, and is fixing it
what would make the system easier?

Measured over **2221 authored effect rows / 708 skills / 46 kinds / 129 columns**.

## The re-declaration is real

Grouping the `effect_table` columns by the *job* each does finds nine roles
implemented over and over:

| role | distinct columns | e.g. |
|---|---|---|
| magnitude | 15 | `damage_amount` `grant_amount` `charge_amount` `cost_amount` `accuracy_amount` `consume_amount` `defense_amount` `check_buff_amount` `turns_delta` `chance_percent` … |
| name / label | 13 | `menu_title` `confirm_title` `opportunity_title` · `menu_description` `confirm_message` `notify_message` |
| operation | 13 | `damage_operation` `grant_operation` `charge_operation` `cost_operation` `accuracy_operation` `defense_operation` |
| ref | 11 | `target_ref` `action_ref` `destination_ref` `performer_ref` … |
| resource | 6 | `grant_resource` `cost_resource` `consume_resource` `damage_resource` |
| cap / floor | 6 | `charge_max` `prompt_max` `summon_max` `ae_initial_charges_max` · `prompt_min` `turns_floor` |

Collapsing the verified-safe clusters would take **129 columns → ~97**.

Row-level safety (does any single row carry two members?) is clean for most:

```
operation 6→1 ✓   cap 4→1 ✓   floor 2→1 ✓   element 2→1 ✓   title 3→1 ✓   body_text 3→1 ✓
resource  4→1 ✗ 14 rows   magnitude 10→1 ✗ 14 rows   — the same rows both times
```

Those 14 rows are 4 skills (Dance, Follow my lead, Avatar of Vengeance: Dismiss,
Barrage) × their class-template and per-actor copies, each carrying both
`consume_*` and `cost_*` with identical values — the inert duplicate data the
previous pass identified. Any cleanup must sweep **all 14**, not the 4
template copies; half-migrating leaves the trap (the visible pair is the one the
engine ignores) live on the actor-embedded rows.

⚠ **Row-level collision is not the only blocker, and the cluster is less uniform
than it looks.** The operation cluster is *not* "the same six-option enum six
times": `damage_operation` and `charge_operation` are that select,
`grant_operation` and `accuracy_operation` are free **textFields**, and
`cost_operation` / `defense_operation` have **no column at all**. Merging also
forces type and option decisions the collision test cannot see:

- `grant_amount` is a **numberField** while every other magnitude field is a
  textField — numberField strands formula values like `20 + 5*(CASTER_LEVEL>=20)`,
  textField silently re-widgets 208 authored rows.
- `grant_resource` offers 8 resources, `damage_resource` offers 2 — a merged
  select would offer `zenit` on a `deal_damage` row, which that path cannot do.

## But merging is not what would make it easier

CSB decides column visibility **per table, not per row** (`DynamicTable.js`:
`columnsVisibility[key].visible ||= canBeRendered(row)`), and a hidden cell
collapses to `width: 0` with its content in a `display:none` wrapper. So the
table you edit is as wide as the **union** of every column any of its rows needs
— and role-cluster members are kind-disjoint, so a skill's union already contains
only the one member it uses.

| scenario | mean columns rendered | median | p90 | worst |
|---|---|---|---|---|
| before this workstream | 19.6 | 15 | 34 | 55 |
| the whole 129→97 merge | **~19.4** ⚠est | 15 | 34 | 53 |

**The merge buys ~0.2 columns per skill.** It is a vocabulary and maintenance
win — one `amount` concept instead of fifteen names to choose between — not a
usability one. Against that it rewrites ~1500 authored cells, every engine read
site, and forces the type/option decisions above. Recommendation: **do not merge
now**; schedule it as a deliberate naming-consistency migration if at all.

⚠ That merge row is an **estimate** — the one figure here not produced by the
evaluator, which models pre/live/after only. The direction is structural
(merging kind-disjoint columns can only help a skill that mixes kinds), but
re-measure before leaning on the magnitude.

Two other intuitions also failed measurement, recorded so they are not retried:

- **Tightening every gate to observed usage** *raises* the per-row mean, because
  some kinds are currently **denied** fields they use — that is the
  over-narrow-gate backlog, not surface bloat. ⚠ The figures behind this
  (14.7 → 15.7) came from the flawed model described below; the direction is
  sound but re-run it with the evaluator before citing the numbers.
- **Reordering `rowLayout`** to cluster each kind's fields looked like a large win
  (mean span 91 → 34 columns) until the CSS showed hidden cells occupy zero
  width. Visible cells are already adjacent; the span metric measured nothing.

## What was shipped, and what it actually costs

⚠ **This pass makes effect tables WIDER, and that is the correct outcome.**
Two earlier drafts of this document got the sign wrong — first claiming a 16%
reduction, then "net-neutral". Both came from a model that pattern-matched gate
formulas instead of evaluating them; it counted the table node itself as a
column, read any `not(...)` as always-visible (so `count` scored visible
everywhere), and used a regex that missed the one-argument `sameRow("effect_kind")`
form `target_prompt` actually uses. Measured with a real evaluator against the
live template and the parsed registry:

| | mean | median | p90 | worst |
|---|---|---|---|---|
| before this workstream | 19.6 | 15 | 34 | 55 |
| after the boot sync applies this registry | 21.7 | 17 | 35 | 58 |

**+2.1 columns per skill (+11% wider).** Zero authored cells that are visible
today become hidden. The per-column breakdown is the honest story:

```
 +708  menu_description       0 → 708   NEW column, ungated (see §4)
 +708  menu_color             0 → 708   NEW column, ungated (see §4)
 +700  condition_formula      8 → 708   un-gated: the engine evaluates it for EVERY kind
 +303  target_prompt        144 → 447   WIDENED to targeting + apply_ae (see §2)
 +307  9 more data-only fields          made editable for the first time
 −704  from_resource        708 → 4     the one genuinely ungated noise column
 −704  to_resource          708 → 4     ditto
```

The only real narrowing available was `from_`/`to_resource`, and every other
line is a correctness fix that *must* cost a cell: **you cannot make invisible
config editable without rendering something**. ~800 previously-uneditable cells
become editable, and 11 columns are added. The honest trade is "11% wider in exchange for the config becoming
reachable", not any kind of surface win.

Shipped:

**1 · `from_resource` / `to_resource` gated** to `substitute_cost`. These were the
only two genuinely ungated noise columns: rendered on all 708 skills to serve 4
rows. (`target_prompt` and `ae_duplicate_mode` were already gated live — an
earlier draft wrongly listed all four as ungated.)

**2 · `target_prompt` widened, not narrowed** — to `targeting` **+ `apply_ae`**.
Despite the name and despite all 3 authored cells being on `targeting` rows,
`applyApplyAeEffect` reads it (the Heart of Darkness "choose a creature you can
see" flow). Gating to observed usage would have been the same class of bug as
`reaction_passive_target`.

**3 · `ae_duplicate_mode`** gated to the kinds that *read* it (`apply_ae`,
`redirect_target`, `open_action_menu`), restoring 10 hidden cells. `transfer_ae`
was dropped from an earlier draft of this gate — zero authored cells and zero
engine reads, i.e. pure headroom. Its option list now mirrors the live column
exactly (11 options, default `replace`); an earlier draft added `ask`, which
resolves to a GM dialog and silently degrades to `skip` for a player, so the boot
option-sync would have made one authored row behave differently per viewer.

**4 · `menu_description` / `menu_color` registered UNGATED** — and that is
+2 columns on every skill, the single largest line in the table above. A draft
gated them on the row carrying a `menu_label`, since all 149 + 80 authored
cells do. Review showed that correlation is an artifact: `skill-effects.js`
documents per-option `menu_label` as the LEGACY shape and resolves label /
description / colour through three INDEPENDENT fallbacks, so a row whose label
comes positionally from the parent's `menu_option_labels` is an ordinary
option — **196 of the 376 referenced option rows are exactly that**. The gate
would have hidden their description and colour cells, fixable only by typing a
redundant `menu_label` the engine ignores. The rule the engine implements —
"this row is named in some other row's `menu_option_refs`" — is not
expressible in a per-row CSB formula, so ungated is the honest answer.

⚠ **The reason for registering them is EDITABILITY, not data loss.** An earlier
draft justified the cost with "CSB prunes undeclared props on `reloadTemplate`,
so leaving them unregistered risks losing them". That is true of a TOP-LEVEL
prop and false of a row cell: the prune loop is
`for (const prop in system.props)` — shallow — and a dynamic table contributes
exactly one key to the declared set (`ExtensibleTable.getAllProperties` returns
`{effect_table: undefined}`), so the table object survives whole and
`effect_table.7.menu_color` is never iterated. No other write path rebuilds a
row from its rendered cells. The documented 112-key loss was all top-level props.

So the real trade is: 229 authored cells that **no human can edit** against two
columns on every skill. Worth paying here — but not a blank cheque, since **40
row keys / 272 cells are still data-only** and registering all of them would add
40 columns to every skill.

The criterion is not "how many documents use it" — that ranks `attacker_name`
(12 cells, 9 docs, a display record nobody retunes) above `chance_percent` (10
cells, 3 docs, a proc rate retuned constantly). It is **what the column costs**,
which the per-column table above measures directly:

- **Kind-gateable → just register it.** The cost is only the skills that use the
  kind: `filter_tag` +74, the `cost_*` trio +35 each, `multiplier` +4. All
  nine cheap registrations in this pass are this class.
- **Cross-kind and ungateable → costs a column on every skill.** Register only
  when a human genuinely has to edit it and currently cannot. Both expensive
  registrations here are this class (`menu_description` / `menu_color`, +708
  each, 229 uneditable cells between them) and they are the whole bill.

`summon_actor` is the clearest outstanding case: 20 cells, data-only, kind-
gateable, and REQUIRED by the engine's own guard — cheap and obviously right.

**5 · `skill-primitives fields <kind>`** — the shape-of-a-kind reference.

A row fills 3.4 cells out of ~12.5 rendered and nothing indicates which matter.
CSB structurally cannot mark this: a column has one `colName`/`tooltip` for the
whole table, while `target_ref` is required for `apply_ae` and optional for six
other kinds — required-ness is a property of the *(kind, field)* pair. So the
signal lives in the tool:

```
$ node tools/skill-primitives/bin/skill-primitives.js fields summon
summon   20 authored row(s) across 8 doc(s)

  REQUIRED BY THE ENGINE — the handler refuses the row without these
    summon_actor               (85% of rows set it)

  SET ON EVERY ROW — the shape everyone uses (not proof the engine requires it)
    100%   20/20  summon_count
  …
  WORKED EXAMPLE — <a real authored row, fields and values>
```

**The REQUIRED block is read out of the engine, not inferred.** Each handler
already states its own contract in a machine-readable warning —
`skill-effects.summon: missing summon_actor`,
`skill-effects.transfer_ae: needs ae_template_ref or filter_tag` — so the card
harvests those 10 declarations instead of guessing. It is a FLOOR, not the whole contract, and says so: handlers also refuse via reason codes (`no-ae-ref`, `no-charge-key`, `no-filter-tag`, …) that name no field, so the card prints the handler location rather than pretending to completeness. `needs A or B` is kept
distinct from `missing A`, so it never calls half a choice "required", and a
required field that **no** authored row sets is called out explicitly (a
frequency table cannot show it at all).

That block exists because frequency alone was actively misleading. `summon`
sets `summon_count` on 100% of rows and `summon_actor` on 85% — and
`summon_actor` is the one the handler refuses without. An earlier draft
labelled the top frequency band "REQUIRED — the row does nothing without it",
which stated the exact opposite of the truth for that kind. Frequency is now
demoted to what it honestly is: a shape hint, printed below the contract.

Two further guards, also added after review found them wrong on arrival:

- **A shared tooltip is flagged when it was written for another kind.** On
  `grant` — the second-biggest kind — all three top fields carry `adjust_grant`
  prose. Presenting that as grant's guidance would have contradicted the very
  argument that motivates the tool.
- **Small samples are called out** (`trigger_status` has n=1), because "100%"
  over one row is not evidence.
- **Aliased kinds inherit the contract.** The harvest keys off the warning text,
  which names one kind, but the dispatch map decides which handler runs:
  `remove_ae` and `remove_tagged_ae` share `applyRemoveTaggedAeEffect` and only
  the former is named in the warn. Keyed by string, the alias with 3.5× the rows
  (66 vs 19) was told it had no contract. Requirements now propagate across every
  kind sharing a handler — that pair is the only one today.

`fields` with no argument lists all 46 kinds by row count.

## 10 authored rows are dead right now

The engine-required harvest immediately found rows the handler **rejects**, which
is the clearest evidence that the missing required/optional signal costs real
content. `fields <kind>` now prints these:

| kind | missing field | rows | e.g. |
|---|---|---|---|
| `grant` | `grant_resource` | 9 | Cognitive Focus `[cf_acc]`, `[cf_heal]` · Follow my lead `[fml_add]` · Inferex / Chomp `[chomp_pierce]` |
| `chain` | `chain_steps` | 1 | Quaking Titan `[qt_gate]` |

`grant` with a blank `grant_resource` falls through to
`RESOURCE_PROPS[""] === undefined` and hard-rejects as `unknown-resource` — the
word "missing" never appears, so nothing in the tooling saw it either. Several
of the nine are `grant` rows carrying `damage_*` / `accuracy_*` config, which
suggests they were meant to be `adjust_damage` / `adjust_accuracy` and the kind
is simply wrong.

Verifying and fixing these is content work, not engine work, and is left for a
deliberate pass rather than folded in here.

## Two process failures this pass exposed

**`node --check` cannot syntax-check an ES module, and 416 files under
`modules/fabula-ultima-companion` contain `import`/`export`.** Node picks the
parse goal from the extension, so `--check` parses a `.js` file as a CommonJS
script and returns 0 on module-goal syntax errors. This registry shipped with
five missing commas, unparseable, while every check I ran reported green — the
whole pass was inert and nothing said so. The repo already has the right gate,
`node tools/check-esm.js <files>` (it copies to a temp `.mjs`), and it catches
the exact failure. It was not used. **Use it, not `--check`, on anything under
`modules/`.**

**Importing a script to check it can execute it.** An `import()` of
`tools/fvtt-playwright/scripts/_apply-column-sync.mjs` — intended only to see
whether it parsed — started a Foundry server and added 54 columns across 4
templates in the live world. Non-destructive (it only adds), and it applied
correctly, but it was unintended, and it means the "before" state in the table
above had to be reconstructed rather than measured. That file now carries a loud
header. `check-esm` parses without executing; `import()` does not.

**And a gap it revealed:** `world-export report` showed **0 modified docs** after
that write. The export strips `system.body`, so **template column changes are
invisible to the loss-proof layer** — the same class of blind spot
`WORLD-EXPORT.md` exists to close, for a document type it does not cover.

## Open

1. **`count` is gated live and hides 100+ authored cells.** Its live gate is
   `targeting (mode≠all) or consume_charge`, but it is authored on 10 kinds —
   `remove_tagged_ae` 57, `remove_ae` 9, `apply_ae` 9, `transfer_ae` 3 … all
   uneditable. Bigger and more concrete than the "count is overloaded" question,
   and it should be fixed before that one is debated.
2. **`target_prompt_filter` / `_title` / `_message`** are read by the same
   apply_ae handler and have no column at all. Shapes need confirming before
   registering — deliberately not guessed at.
3. **The 129 → 97 merge** — green on row-collisions apart from the 14 rows above,
   but blocked behind the type/option decisions in §1. Vocabulary win only.
4. **The 14 duplicate `adjust_cost` rows** (`consume_*` shadowing `cost_*`):
   delete the dead half across *all* copies. Unblocks two merges and removes a
   live trap.
5. **The widest tables are wide because they mix kinds**, not because of
   redundancy: Thermokinesis 7 kinds / 55 columns, Gadgets 8 kinds / 48.
6. **444 authored cells sit in 25 undeclared TOP-LEVEL props — and those really
   are prunable.** Splitting the audit's [B] report (row keys are safe, top-level
   props are not) relocated the data-loss risk rather than removing it. The list
   includes `details_roller` (304 cells / 252 docs), `skill_description` (37),
   `animation_preload_urls` (20), `action_keywords` (17 — live behaviour, e.g.
   Flare / Thunderbolt), `availability_formula` (7 — Bimagus), and
   `reaction_effect_table` (14 docs), which is an entire undeclared *table*. The
   mechanism has already fired once, for 112 keys. Not this pass's job, but this
   pass is what made it visible.
7. **`fields` aggregates rows from 3 templates but checks column declaration
   against `_Skill Template` only.** `ZoiV53VaLzeRsEps` (60 docs) lacks 11 of its
   columns, so for those docs some fields are data-only and the card stays quiet.
   No false positive today; 5 further docs point at a template that no longer
   resolves at all, which is worth a separate look.
