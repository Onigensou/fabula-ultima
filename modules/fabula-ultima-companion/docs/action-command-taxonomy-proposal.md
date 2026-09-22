# Proposal — give actions a Command type

*Written for: the developers on this project (you and the co-dev). It asks for a
decision, not a review of code that already exists.*

**Status: proposal. Nothing here has been implemented.** Raised because
`SKILL_TARGET_BLANK` could not be scoped correctly without it, and confirmed as
real: *"Attack and Item are closer to being Command type. We didn't define these
command early on so these action (Attack, Skill, Spell, Item, etc.) are not
designed properly."* (2026-09-22)

---

## The problem: `skill_type` carries two axes at once

| value | docs | what it really says |
|---|---|---|
| Passive | 953 | **category** — never performable |
| Active | 722 | **category** — performable |
| Spell | 319 | **both** — a category AND a menu |
| Attack | 141 | **command** — the Attack menu |
| Item | 135 | **command** — the Item menu |
| Other | 90 | neither; a dumping ground |
| *(blank)* | 6 | — |

`Spell` sitting on both axes is why the set looks arbitrary. It is also why
`skill-picker.js`'s usable set is `{attack, active, spell}` — three values drawn
from two different questions.

### The engine already grew a shadow taxonomy to compensate

This is the strongest evidence that the field is doing the wrong job.
`skill-picker.js` cannot ask "is this performable?" so it *infers* it, and says
so in its own comments (lines 80-115):

> *"Such items have no active turn-action, yet they still carry skill_type
> 'Active'/'Spell' (e.g. Protect, Illusory Shield, High Speed, Cognitive Focus).
> **The skill_type label filter alone therefore lets them leak into the
> Skill/Spell action menu, where picking one spends the turn-action on a no-op**
> (empty body → Miss card)."*

To patch that, the picker carries `hasReactionRows()`, `hasSureHitDamageBody()`
and `hasActiveBody()` — three heuristics reconstructing what one declared field
should have stated. Every one is a place a new skill can be mis-sorted, and the
symptom is a player losing their turn to a no-op.

`skill-intent.js` runs a parallel inference for intent, with `skill_type` as
rules 3, 7 and 8 of an 8-rule ladder.

---

## The seed already exists — and it is currently at risk

`action_command` **is already a prop, and the engine already reads it**
(`domination.js:143`, `state-handlers.js:340`, `skill-recipes.js:221`,
`skill-effects.js:4495` for `check_buff_action`). It is populated on exactly 5
documents — the FU Common Actions:

```
Study :: study        Hinder :: hinder      Escape :: escape
Domination :: domination                    Recovery :: recovery
```

All 5 are `skill_type: "Active"`, so the two axes are *already* being used
together on those documents. The command axis is not a new idea here; it is a
half-finished one.

⚠ **`action_command` is an UNDECLARED prop.** It is one of the 20 key families
`skill-validate` reports as `PROP_UNDECLARED` — the template declares no field
for it, so `reloadTemplate` deletes it. An engine-read prop that any template
reload can silently destroy is a live bug independent of this proposal.

---

## Proposal

### 1. Declare `action_command` on the template (do this regardless)
One entry; fixes the prune risk on the 5 existing documents. Cheap, additive,
reversible, and it is a bug fix whether or not the rest of this is adopted.

### 2. Adopt the turn menu's own vocabulary
`turn-ui.js:30-40` already defines the canonical set:

```
Actions:  Attack · Guard · Skill · Spell · Item
System:   Equipment · Study · Hinder · Objective · Passive
```

plus the Common actions already in `action_command` (`escape`, `domination`,
`recovery`). The vocabulary is not a design question — the menu answers it.

### 3. Keep the two axes separate, and DO NOT rename `skill_type`

| axis | field | answers |
|---|---|---|
| **command** | `action_command` | which menu blade offers this, and how is it performed |
| **category** | `skill_type` | Active / Passive — is it performable at all |

`skill_type` is read in **14+ engine files** (`state-handlers` ×17,
`skill-picker` ×11, `skill-effects` ×11, `class-registry` ×7, the passive
engine, both autopilots, the sim brain, the harness). A rename is a
high-blast-radius change with no upside; leaving it as the category axis costs
nothing and keeps every existing read valid.

### 4. Let the heuristics retire, don't rip them out
Once `action_command` is populated, `hasActiveBody()` and friends become a
fallback rather than the source of truth: *performable iff `action_command` is
set* — with the heuristic retained for documents that have not been backfilled.
Retire them only when the backfill is complete and measured.

---

## Migration path (additive at every step, no destructive rename)

1. **Declare the field.** Template column + `template-field-registry.js` entry.
2. **Backfill from `skill_type`**, which is mechanical for the unambiguous
   values: `Attack` → `attack` (141), `Item` → `item` (135), `Spell` → `spell`
   (319). These are already commands wearing the wrong field.
3. **Backfill `Active` (722)** — the only real work. `Active` means "a
   performable something", so each needs its command chosen: mostly `skill`,
   some `spell`, a few Common actions.
4. **Triage `Other` (90) and blank (6).** `Other` is the dumping ground; expect
   both real content and dead rows.
5. **Add a validator rule** — `ACTION_COMMAND_MISSING` on any performable
   document. This is the rule that makes step 3 self-checking rather than a
   hand-audit, and it can run game-closed.
6. **Then** narrow `skill_type` to `{Active, Passive}` and widen
   `SKILL_TARGET_BLANK` to "every document with an `action_command`", which is
   the check that could not be written today.

Steps 1-2 are safe and mechanical. Step 3 is a content pass — the user's call on
when, and the kind of thing the Stage 0 validator exists to make checkable.

---

## Why this is worth doing before Stage 2

The pattern library is **indexed by command**. Its patterns are "attack with a
weapon", "cast a spell", "use an item", "take a Common action" — if
`skill_type` cannot answer *what command is this*, the pattern picker has
nothing sound to key on, and a non-programmer's first question ("what kind of
thing am I making?") has no field that answers it.

Building Stage 2 first means building it against the shadow taxonomy, then
rebuilding it. Doing this first also makes Stage 2 smaller, because the pattern
list falls out of the command list instead of being invented.

## Sizing

| step | effort | game |
|---|---|---|
| 1. declare the field | ~1 h | closed |
| 2. mechanical backfill (595 docs) | ~half day | open (write path) |
| 3. `Active` triage (722 docs) | 1-2 days | open |
| 4. `Other` triage (96) | ~half day | open |
| 5. validator rule | ~1 h | closed |
| 6. narrow + widen | ~half day | closed |

Step 1 and step 5 can be done immediately and independently. Everything from
step 2 on writes world data, so it is the user's call.

## Related

- `skill-forge-design.md` — A2 records the ruling this proposal comes from.
- `skill-picker.js:80-115` — the shadow heuristics, with their own account of
  why they exist.
- `turn-ui.js:30-40` — the canonical command vocabulary.
