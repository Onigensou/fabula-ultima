# Skill Forge — a skill-authoring system a non-programmer can use

Goal: let someone author a working skill without writing code, without Claude,
and without holding the 933 lines of authoring canon in their head.

This document records **decisions and how to reverse them**, so the work is
resumable by anyone (including a fresh Claude instance) without re-deriving the
reasoning. It is not a tutorial and not a status page.

---

## Why this is a data problem, not a UI problem

The declarative model is already complete. A skill's behaviour is
`effect_table` rows (799 across 513 items) addressed by `effect_label` and
wired by `chain_steps` / `target_ref` / `menu_option_refs`, plus
`reaction_config_table` rows that say when it fires. That is a dataflow graph
typed into a spreadsheet.

There is also **already a GUI** — the CSB sheet renders both tables, and
`template-field-registry.js` gates 106 columns per effect kind and self-heals
them at boot. The authoring guideline nonetheless says (I2) *"author via a data
migration or `CreateSkillFromSpec` — not the CSB UI."*

So the gap is not "no editor". The gap is that **the editor is not safe**:

| failure | what the author sees |
|---|---|
| write to an undeclared column | success, value vanishes |
| typo'd formula identifier | folds to `0` → gate blocks forever, still showing its authored reason |
| unparseable formula | returns the CALLER's fallback (`1`) → gate does not apply at all |
| blank `duration` | silently reads as Instantaneous |
| blank `skill_target` | skill self-locks |
| cost in both the legacy field and a `consume_resource` row | player charged twice |
| cloned `*_table` row | CSB deep-merges, leaking keys nobody authored |

None of these raise an error. A human cannot tell a working skill from a dead
one, which is why every stage below is ordered behind making failure loud.

---

## Status — all six stages have code + tests (2026-09-22)

| stage | module | suite | live-verified |
|---|---|---|---|
| 0 validator | `lint/skill-validator.js` + `-bridge.js` | 94 + 24 | ✗ |
| 1 graph editor | `skill-forge/graph-model.js` | 22 | ✗ |
| 2 patterns | `skill-forge/patterns.js` | 105 | ✗ |
| 3 conditions | `skill-forge/condition-builder.js` | 33 | ✗ |
| 4 test button | `skill-forge/test-runner.js` | 38 | ✗ |
| 5 publish | `skill-forge/publish.js` | 25 | ✗ |
| UI | `skill-forge/skill-forge-app.js` | — | ✗ |

341 assertions, all green. **Nothing has been exercised in a running Foundry.**
Both new esmodules are proven to *import* with the globals stubbed, so the
module will load — but no panel has been clicked, no skill created, no test
run. That is the outstanding work, and it is the kind of gap that hid for a
whole session last time: Stage 0 was declared complete while `module.json`
referenced the validator zero times.

Headline results worth keeping:
- **Graph round-trip**: 930 docs · 3323 rows · 1860 tables byte-identical. It
  failed first time on KEY ORDER, which is harmless to CSB but churns the
  export that world pushes are reviewed through.
- **Condition builder**: 571 of 778 authored gates representable (73%), 207
  declined to raw text, **0 altered**.
- **Patterns**: all 15 expand with zero validator findings.

## Stages

| stage | what | days | game |
|---|---|---|---|
| **0** | Validator — the pass/fail oracle everything else uses | 2–3 | no |
| 1 | Graph editor (rows as connected cards) | 10–15 | save path |
| 2 | Pattern library (~15 parameterised recipes) | 4–6 | for the harness leg |
| 3 | Condition builder (dropdowns instead of formula text) | 3–4 | no |
| 4 | Test button (wraps the director harness) | 4–5 | yes |
| 5 | Draft/publish safety | 1–2 | export leg |

Recommended slice is **0 + 2 + 4** (~11–15 days): a pattern picker, a validator
that speaks English, and a test button. Stage 1 is the expensive, highest-risk
piece and nothing else depends on it.

### Pre-work, measured — not a general refactor

`tools/csb-template/bin/visibility-audit.js` reports **0 broken gates**, which
is the class that would have forced one. What it does find:

- **41 data-only ROW keys / 275 cells** — uneditable, but *not* pruned, because
  no write path rebuilds a row from its rendered cells. **A graph editor is
  exactly such a write path**, so Stage 1 would CREATE a data-loss risk that
  does not exist today. → Decision below.
- **22 data-only TOP-LEVEL props / 545 cells** — these *are* pruned by
  `reloadTemplate`. A live liability today, independent of this plan. ~1 day.

---

## Applied to the world — 2026-09-22

`SKILL_TARGET_BLANK` backfill, 15 skills / 28 documents (masters + actor copies
together, or MASTER_COPY_FIELD_DRIFT trades one finding for another). Committed
as `976f79a8`. Targets were read off each skill's RAW text and checked against
the parser that consumes them. Verified safe-edit dry-run → apply → re-export →
28/28, export diff exactly 28 lines all `skill_target`, `world-export report`
0 added / 0 removed / 17 modified.

Findings: **49 → 21**, skills **23 → 8**. The 8 remaining carry `"-"`, which the
user asked to leave — 4 are `Generic … Template` docs whose value is inherited
by newly authored skills, so they need a human call.

⚠ Verification trap met on the way: `getDoc("Actor.X.Item.Y")` returns the
ACTOR, and the raw actor record does not expose embedded items as a plain
`items` array, so a hand-rolled read-back reported 15 false failures on writes
that were fine. Use `world-export` as the oracle for embedded documents.

## Stage 0 — decisions

### D1. Extend the existing lint; do not write a second one
`reaction-config-lint.js` has 1807 lines and 47 rule codes, none of which are
duplicated here. It cannot be a per-document pure function (classic-script IIFE
reading `game.items`), so the split is:

- `scripts/lint/reaction-config-lint.js` — world sweep, unchanged, **plus** one
  addition: the previously closure-private `lintItem` is exposed as
  `FUCompanion.api.lint.lintOneItem(item, ownerLabel)`.
- `scripts/lint/skill-validator.js` — **new**, pure ESM, Node-testable, adds
  only the checks the sweep has no coverage for.

Both emit the same finding shape, so a caller that wants everything
concatenates them.

*Reverse:* delete `skill-validator.js` and the `lintOneItem` block. Nothing
else references them yet.

### D2. The skip contract
Every rule needs a `ctx` input (vocabulary, declared columns, ...). When the
input is absent the rule is **skipped and named in `skipped`** — never silently
passed. A clean report that checked nothing is the exact silent-permissive
failure this layer exists to end.

*Reverse:* not advisable; this is the invariant the rest depends on.

### D3. Severity split, PROP vs ROW
- `PROP_UNDECLARED` is an **error** — `reloadTemplate` iterates `system.props`
  against the declared key set and deletes undeclared keys (the documented
  112-key loss). Data is destroyed.
- `ROW_COLUMN_UNDECLARED` is a **warning** — per visibility-audit's own header,
  the prune loop is shallow and a dynamic table contributes one key, so row
  keys survive. It is an *editability* defect, not a loss.

*Reverse:* one-line severity change in `RULES`.

### D4. Blank values are not findings
CSB stamps keys wholesale, so most undeclared keys carry `""`. Deleting `""`
loses nothing. Filtering blanks took the corpus from 438 → 302
(`ROW_COLUMN_UNDECLARED`) and 868 → 547 (`PROP_UNDECLARED`).

### D4a. ⚠ The visibility-audit cross-check was CIRCULAR — do not cite it
An earlier version of this doc claimed 547-vs-545 as independent agreement with
`tools/csb-template/bin/visibility-audit.js`. It is not: that tool carries a
byte-identical `PROP_TYPES` / `TABLE_TYPES` list, so the two agreed **by
construction**, including on the same two gaps —

- **`label`** is absent from both lists. `details_roller` is a label, CSB
  recomputes `props[key]` from derivedData on load, and it accounted for **424
  of the 547** errors. Not authored, not lost, and the finding text ("will
  delete it") was wrong on both halves.
- **`activeEffectContainer`** is absent from both. It extends `ExtensibleTable`,
  whose `getAllProperties()` returns `{[key]: undefined}`, so the prune loop
  keeps it. `skill_effect` (3 findings) was a hard false positive telling
  authors to migrate a container that was never at risk.

Fixed here; **`visibility-audit` still has both gaps.** After the fix the corpus
reports **120 findings across 20 key families**, which are the genuine losses.

**→ Queued for batch review: apply the same two type fixes to `visibility-audit`.**

### D5. `"-"` is an authored answer, not an omission — PER FIELD
The project writes `-` to mean "deliberately not applicable", and distinguishing
`""` ("nobody decided") from `-` ("somebody decided no") is most of these rules'
value. **But the engine does not honour it uniformly, so this is a per-field
judgement, not a global one:**

- `duration` — `skill-formulas.js:1243` treats `"-"` exactly like blank
  (`ACTION_DURATION` returns 0 for both). The exemption is arguably wrong here;
  2 generic NPC spells rely on it. **Open question below.**
- `skill_target` — `compose-action.js:903` computes
  `isSelf = !text || /^self$/i` so `"-"` is NOT self; it falls through to side
  classification and opens the **enemy** picker. 28 Active/Spell documents hold
  `"-"` and are currently exempted. **Open question below.**

The rule text must never *recommend* `-` for a field the engine does not read
that way — the authoring UI renders `fix` verbatim to a non-programmer.

### D6. Scope is the rule — `SKILL_TARGET_BLANK`
Unscoped it flags **258** documents, 212 of them Passives that never target and
are correct. Scoped to Active/Spell with no reaction wiring it flags **28
findings across 15 distinct skills**, which are skills a player can select and
fail to aim.

Known narrower than the engine: `skill-picker.js`'s `ACTIVE_SKILL_TYPES` is
`{attack, active, spell}`, so `Attack` (141 docs, 0 blank today) is out of
scope, as are two `Item` consumables with blank targets. See open questions.

*Reverse:* widen the scope test in `ruleSkillTarget`. Re-measure first.

### D7. Identifier threshold stays at 3 characters — for now
`identifiersIn` requires 3+ characters, inherited from `formula-audit`. That
leaves the real two-character identifiers **`SL` and `HR` unchecked**, so a
two-character typo of either passes.

Measured: `skill-validate --ident-min 2` produces **zero** new findings on the
corpus, so lowering it is safe *here*. Not changed unilaterally because
`formula-audit` would then disagree with this validator about the same formula,
and two tools giving different answers is worse than one blind spot.

**→ Queued for batch review: lower BOTH to 2 in one paired change.**

### D8. Two scopes in the driver — neither is right for all rules
`skill-validate` walks **every** document and picks the ctx per document:

- **Formula + required-field rules are template-independent.** A gate formula on
  a weapon is checked by the same vocabulary as one on a skill. Scoping these to
  one template sees 216 formulas where the corpus holds 714 — it silently skips
  two thirds.
- **Column + prop rules are template-specific by definition.** "Is this key
  declared?" only means anything against the template the document actually
  instantiates. Judging weapons against the skill template's 52 props produced
  **71,919** nonsense findings.

So off-template documents are validated with formula/contract inputs only, and
the skip contract (D2) leaves the column/prop rules unrun rather than guessing.

### D10. Behaviour lives in TWO homes, not one
`system.props` is the obvious carrier. The other is a `reactionConfig` blob on
an Active Effect's flags — and per the equipment policy **that is the mandated
carrier for gear behaviour**, so a gear item whose whole implementation is a
`transfer:true` AE lives entirely in the second.

Walking only the first made such an item validate CLEAN with an empty
`skipped`: "we checked and it's fine" where the truth was "we never looked".
The corpus holds **123 such AEs carrying 64 gate formulas and 189 effect rows**,
none of which were validated. Formula reach went 714 → **778** once fixed.

Note that `cannot_be_targeted_by_unless` — the only AE key the original walker
knew — has **0 occurrences in the corpus**, so that branch had never met real
data. A branch with no corpus coverage is not evidence of anything.

### D9. `$deleted` rows are tombstones — skip them
Reconciled against `formula-audit`: it reports **723** authored formulas, this
validator reached **714** before D10, and the difference is exactly **9 formulas
sitting on `$deleted` rows** (High Speed `[99]`, Hilde-Fafnir/Impalement, Rakshasa/Mace,
Rakshasa/Saber, …).

The engine never evaluates a tombstoned row, so a typo on one is not a defect.
**This validator is right and `formula-audit` over-scans.** Harmless today —
all 9 happen to be valid — but a typo there would surface as a finding on a row
that does nothing.

**→ Queued for batch review: teach `formula-audit` to skip `$deleted`.** A validator that reports that is
worth less than none.

---

## Stage 1 — the decision that must be made first

**The editor must read and write the raw table object, never the rendered
cells.** That is the whole mitigation for the 41 data-only row keys: a
cell-driven write path would silently drop 275 authored values that survive
today only because nothing rebuilds rows from cells.

Alternative if that proves impractical: register all 41 keys in
`template-field-registry.js` first (~41 lines; the boot sync ships the columns
everywhere). Do one or the other before the first line of editor code.

The load-bearing test is a **round-trip corpus test** — import all 799 authored
rows into the editor's model, re-emit, assert identical to source. Same oracle
`world-pack` uses for its LevelDB round-trip.

---

## Verification standard for this work

Three checks are mandatory for any rule added here, because "the suite is green"
is worth nothing on its own:

0. **Check that a cross-check is actually independent.** The first pass cited
   `visibility-audit` as confirmation and it shared this tool's source list —
   agreement by construction (D4a). Two tools built from the same list validate
   nothing but each other.

1. **Corpus backtest** — run over all instantiating documents and triage every
   finding. Cross-check the count against an independently-written tool where
   one exists (`visibility-audit` for the column/prop rules).
2. **Prove the rule can go red** — cripple its input and confirm it fires. A
   bogus vocabulary yields 322 `FORMULA_IDENT_UNKNOWN`; a bogus field contract
   yields 62 `REQUIRED_FIELD_MISSING`. Both report 0 on real data, and that
   zero is now known to mean *clean* rather than *dead*.

---

## Commands

```
# unit suite (no game)
node modules/fabula-ultima-companion/scripts/lint/skill-validator.test.mjs

# corpus backtest (game CLOSED — reads the template from LevelDB)
node tools/skill-validate/bin/skill-validate.js
node tools/skill-validate/bin/skill-validate.js --code PROP_UNDECLARED --limit 30
node tools/skill-validate/bin/skill-validate.js --ident-min 2      # D7 experiment
node tools/skill-validate/bin/skill-validate.js --json

# in game
FUCompanion.api.lint.lintOneItem(item)   // the 47 sweep rules, one document
```

## Related

- `skill-authoring-canon.md` / `skill-authoring-guideline.md` — the canon this
  validator is trying to make unnecessary to memorise.
- `tools/csb-template/bin/visibility-audit.js` — the column/prop oracle.
- `tools/skill-regression/lib/formula-audit.js` — the formula vocabulary this
  validator deliberately agrees with (see D7).

---

## Answered by the user — 2026-09-22

Review gate 1 raised three content questions. All three are settled; the rulings
are encoded in the validator and repeated here because they are judgements about
the GAME, not about the code, and a future reader cannot re-derive them.

### A1. `"-"` is allowed on `duration`, and NOT on `skill_target`
The dash sentinel is **per-field**, not global.

> *"[duration] depends on the skill. It is possible it is [a] passive that [is]
> always active, and normally Fabula Ultima [doesn't] define duration on
> passive."*

So `duration: "-"` stands. The `fix` text now warns that the engine ranks it as
Instantaneous (`skill-formulas.js:1243`), so a Scene-long spell must still say
so explicitly.

> *"There should be skill target on everything, even self. However, it might
> either be left over, or incomplete back filling."*

So `skill_target: "-"` is a **defect**, and the exemption is dropped. The engine
independently agrees: `compose-action.js:903` makes only blank-or-`/^self$/i`
mean self, so a dash routes to the **enemy** picker. This surfaced 21 findings —
4 generic authoring templates plus real content (`Adrenaline Rush` / `Endure`,
`Steal Life Force`, `Zero Power: Apex Arrow`).

### A2. ⚠ DESIGN DEBT — the action taxonomy was never designed
`SKILL_TARGET_BLANK` is scoped to `Active` / `Spell`, which is narrower than
`skill-picker.js`'s `ACTIVE_SKILL_TYPES` (`{attack, active, spell}`). Asked
whether to widen it to `Attack` and `Item`:

> *"Attack and Item are closer to being Command type. We didn't define these
> command early on so these action (Attack, Skill, Spell, Item, etc.) are not
> designed properly."*

`skill_type` therefore **conflates two different axes** — the player's COMMAND
(Attack / Skill / Spell / Item) and the skill's CATEGORY (Active / Passive /
Spell). `Spell` sits on both, which is why the set looks inconsistent.

**The rule is deliberately NOT widened.** Enforcing "a target on everything"
across `Attack` (141 docs), `Item` (25 with a dash) and `Other` (90) would
measure content against a taxonomy the project does not stand behind, and the
212 `Passive` dashes are correct as authored — FU passives do not target.

**This is the blocker to record:** a proper Command type is a prerequisite for
any further targeting enforcement, and for the Stage 2 pattern library, whose
patterns are naturally indexed BY command ("attack with a weapon", "cast a
spell", "use an item"). Worth resolving before Stage 2 rather than after.

## Paired changes — DONE 2026-09-22

All four shipped together, each touching both tools so they cannot drift:

1. **Identifier threshold 3 → 2** in `skill-validator.js` and `formula-audit.js`.
   `SL` and `HR` are real identifiers the old floor never checked. 0 new
   findings, so the change is safe and the blind spot is closed.
2. **`$deleted` tombstones skipped** in `formula-audit.js` (D9). It now reports
   **714**, matching the validator exactly.
3. **`label` + `activeEffectContainer`** (and `conditionalModifierList`,
   `picture`) added to `visibility-audit.js`'s type lists (D4a). Its [B]
   top-level count dropped **545 → 118 cells / 22 → 20 keys**; the 424
   `details_roller` false positives are gone from both tools.
4. **`LANGUAGE_WORDS` divergence dissolved** rather than synced. Both tools now
   strip CALL SYNTAX structurally — a lowercase word followed by `(` is a call,
   whatever its name — so `max(chance(50), randint(1,3))` reads as zero prose
   words while `chance roulette` still reads as two. Resolving the divergence by
   removing the need for the list beats keeping two lists aligned by hand.

Remaining known gap in both: `radioButton`'s `propertyKey` is its `_group`, not
its `key`, so the walkers record the wrong key in both directions. No corpus
hits; needs a read of the CSB component before either spelling is trusted.

### D11. `PROP_UNDECLARED` splits on engine readership
Both classes are "reloadTemplate deletes this", but only one loses something
that runs, and a 120-finding list that mixes them is a list people skim.
`ctx.engineReadProps` splits them: read → `PROP_UNDECLARED` (error), unread →
`PROP_UNDECLARED_UNREAD` (warning). Absent set ⇒ everything stays an error;
nothing is downgraded on missing input.

Getting the scan right took three passes, and the middle one is the cautionary
tale. Requiring the literal `props.<key>` marked `recipe_resource`,
`recipe_amount`, `recipe_target` and `picker` as DEAD — the engine reads them
through a local alias (`const p = …props; p.recipe_resource`,
skill-recipes.js:84). **A false "nothing uses this" is the one error that
destroys working content.** Matching `.key` on any receiver then marked all 30
as read, which is equally useless. The kept form matches the receivers this
codebase actually uses (`props`, `p`, `sp`, `pr`) plus the bracket form.

**Result: 20 of 20 undeclared prop keys are engine-read.** `PROP_UNDECLARED_UNREAD`
fires on nothing here — verified by spot-check (`menu_hidden` 6 source mentions,
`skill_description` 3, `undying_zp_cost` 2, `has_roulette` 1). That is a finding
in itself: every one of the 120 remaining prop findings is a real loss risk, not
a mix of live and abandoned fields. It strengthens step 1 of the taxonomy
proposal, since `action_command` is one of them.

## Harness contract corrections — DONE 2026-09-22

Stage 4 wraps the director harness, so its documented contract had to be true
first. Two of the guideline's three §I4 "blind spots" were **inverted, and each
produced the exact false negative it warned about**:

- `prePassives` **does not exist** anywhere in module source. Both simulate
  entries read `acceptReactions`.
- The result shape was backwards: `runDirectorSkillSimulate` returns a top-level
  `actionResult` (:2518); `runDirectorAttackSimulate` returns `passes[]`
  (:3122). The doc told skill authors to read `res.passes[0]` from the one
  function without it.

The third (bench dummy affinities) is accurate. Guideline corrected with line
citations; see the `feedback_harness_contract_docs_can_be_inverted` memory.

**Consequence for Stage 4:** the "Test button" must read its contract from the
harness source, not from the guideline, and the remaining harness work
(missing-payload-field detection) still needs a running game to verify.
