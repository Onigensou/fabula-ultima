---
id: 2026-08-11-skill-template-defense-target-type-default
title: Skill template defaults defense_target_type to "def", so every new spell is born hitting the wrong defence
status: fixed
severity: major
reporter: onigensou
assignee: sarunphat
component: csb-templates/_Skill Template
introduced_in:
fixed_in: 0b58c9be
---

# The 50-document mdef sweep will be needed again

`c1e2d5c3` corrected 50 documents from `def` to `mdef` and was right to. But it fixed the
instances, not the thing that produced them — so the same drift starts accumulating from
the next spell authored.

All three templates still declare the field this way, in the incoming binary as well as
the current one:

```json
{ "key": "defense_target_type",
  "type": "select",
  "label": "vs",
  "visibilityFormula": "and(isCheck, not(equalText(skill_type, 'Passive')))",
  "defaultValue": "def",
  "options": [ { "key": "def",  "value": "Defense" },
               { "key": "mdef", "value": "Magic Defense" } ] }
```

Verified by opening both LevelDBs directly (game closed, `classic-level`), reading the
current world and a clean extraction of `c1e2d5c3`'s `items` collection:

```
                        b3667075              c1e2d5c3
_Skill Template         defaultValue="def"    defaultValue="def"
_Skill Template (Copy)  defaultValue="def"    defaultValue="def"
_Action Template        defaultValue="def"    defaultValue="def"
```

Unchanged. So every skill created from these templates is born pointing at Defense,
including Spells, which under RAW resolve against Magic Defense.

## Why it stays wrong once it happens

Nobody has to mis-set anything for this to bite — the wrong value is the factory setting,
and three things stop it self-correcting:

1. **There is no neutral option.** The dropdown is `{def, mdef}` only.
2. **The engine's fallback is unreachable from the UI.** `resolvesVsMagicDefense`
   (`snapshot.js:196-201`) returns `isSpell` on a blank, which is the correct answer for a
   PC-cast Spell — but the field cannot be left blank, and as your commit notes, a sheet
   save writes `def` back over an out-of-set value.
3. **`def` is also the first option**, so anything out-of-set renders as Defense too.

This is the same mechanism as the `action_keyword` incident the field's own tooltip
records — *"The old default was 'pierce', which is how the Tinkerer's Vampire infusion
silently shipped as ignore-Resistance instead of Drain: the author never touched the
dropdown."* Different field, identical failure: a default nobody chose, shipping as if
someone had.

Filed `major` because it is not hypothetical — it has already put 50 shipped documents on
the wrong defence stat, silently, across the Elementalist offensive family, and the
mechanism that did it is still armed. Nothing is currently broken *because* you fixed the
instances; this is about the next 50.

## Suggested fix — genuinely not sure which way, so flagging rather than prescribing

The obvious move, flipping `defaultValue` to `"mdef"`, looks wrong to me: the same
templates back non-Spell Attacks, where `def` is the correct answer, so it trades one
silent wrong default for another.

A neutral third option is the intuitive fix, but it is not sufficient on its own. Blank
resolves to `isSpell`, and on the NPC pseudo-weapon path `isSpell` is false — which is
exactly the case your commit called out ("blank means DEF, not MDEF, on the NPC/weapon
path"). So a neutral option would silently mis-resolve monster magic, which is the larger
population. It would need the NPC path's spell classification fixed at the same time.

Options as I see them, in the order I'd weigh them:

- Add a neutral `""` / "Auto (by skill type)" option **and** make the NPC/weapon path
  infer `isSpell` correctly, so the fallback is trustworthy everywhere. Best end state,
  most work.
- Leave the default but add a lint that flags any `skill_type: "Spell"` carrying
  `defense_target_type: "def"`. Cheap, catches it at authoring time instead of in play.
  This is probably the best value-for-effort.
- Split the templates so spell-shaped and attack-shaped skills carry different defaults.
  Most invasive.

I have not touched any of it. Template edits are also the re-stamp risk that resets
dropdowns on authored documents, so this is not an edit I would make casually on your
component, or without you deciding the direction first.

## Notes

- Found while reviewing `c1e2d5c3` before pulling it; the pull has not been run on this
  side yet, so the 50 corrections are not in my world at time of filing.
- Related: `2026-08-11-effect-kind-label-still-says-pierce` — same class of defect
  (an authoring surface that points at the wrong value), different field.
- Worth stating plainly since it is easy to read this report the wrong way: your change
  is correct and I am not asking for it to be reverted. This is only about the default
  that produced the work in the first place.

---

## Fix (2026-08-31, sarunphat) - option 1 of the three you weighed

Went with the neutral option, but named it explicitly rather than blank:

    [Default (Spell -> MDEF), Defense, Magic Defense]    defaultValue: "default"

Your objection to a blank neutral was right and is why this is a NAMED option.
A blank resolves to isSpell, and you correctly flagged that the NPC/pseudo-weapon
path hardcodes isSpell:false - so a blank would have been an invisible trap for
monster magic. A labelled "Default (Spell -> MDEF)" sitting in the dropdown is a
value an author can SEE and override; a blank is not.

`default` is ordered FIRST deliberately. CSB's Dropdown falls back to
`option:first` for any value outside the option set, so the out-of-set case you
raised as point 3 now lands on the type-driven answer instead of Defense.

I did NOT fix the NPC-path isSpell classification. Your point stands, but it is a
behaviour change to the larger population and it is not needed for this: the 34
non-Spell actions that genuinely resolve vs MDEF (Soul Steal, Pillage,
Flamethrower, the enchanted Elemental Slashes) all carry an explicit `mdef`
today, and the explicit override remains for the next one. Filed as its own
concern rather than smuggled in here.

Measured before changing anything, over the authored export:

    skill_type  dtt     docs
    spell       def      177     <- upper bound; the field is hidden on non-check spells
    spell       mdef     119
    attack      mdef      17     <- deliberate non-Spell magic
    active      mdef      17     <- deliberate non-Spell magic

Scope: 3 documents declare the column (_Skill Template, _Skill Template (Copy),
_Action Template). Zero in actors, and embedded actor-items carry no
`system.body`, so there are no per-actor copies. Nothing migrates - existing
documents keep their explicit def/mdef.

Two things found on the way that are worth having on the record:

- The boot dropdown sync is a GENERAL data scan over every select column, not
  just the reaction/effect registries. The first document saved with "default"
  would have made it backfill the option labelled with the raw key. Pre-seeding
  the label avoids that; the sync is additive-only and never touches
  defaultValue.
- `world-export` strips `system.body`, so the world half of this fix produces a
  0/0/0 report and is invisible in the JSON companion. The reviewable half is
  0b58c9be. Worth knowing before you review 4d187d3a and conclude it is empty.

Commits: 0b58c9be (engine + the two shipped _Skill Template.json factories),
4d187d3a (the three live templates).

Still open, deliberately: `redirectVsMDef` in action-card.js hand-rolls
`skillType === 'spell' || dtt === 'mdef'` instead of calling
resolvesVsMagicDefense(), so a Spell carrying an explicit `def` disagrees between
the engine and the redirect card. Pre-existing, unaffected by this change, and
flipping it would move behaviour for up to 177 documents - so it is the user's
call, not a ride-along. Same drift class the helper's own comment claims to
prevent.

VERIFICATION STATUS: verified at the data layer (committed store re-opened,
2361 keys, all three templates read back correct), parity + census clean, export
loss-clean. NOT yet render-verified in game - a raw system.body write only
registers after a fresh page load, and the world was closed for this pass.
