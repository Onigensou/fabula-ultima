---
id: 2026-11-01-action-gating-only-blocks-the-button
title: Paralyzed, Frightened, Confused and similar block the command button but not actions of that category offered elsewhere
status: fixed
severity: major
reporter: onigensou
assignee: onigensou
component: battle-director/reactions
introduced_in:
fixed_in: v1.0.527
---

# Fixed in v1.0.527

Commits 12bc8cae, e2e836a9 and 0838542e. Seen again in a real session: Paralyzed Zarg could not
Dance, but could still add Barrage to his attack.

**Heads-up, sarunphat:** `findPassiveCandidates` (and `findTargetOwnedCandidates`) now run a shared
gate, `getReactionGate` in `skill-effects.js`. If you have work in flight on reaction scanning,
please rebase onto this. A gated row comes back with `available: false` and either:
- the new `unavailableKind: "blocked"`, shown dimmed with the debuff's name, like `"cost"`; or
- `"condition"`, hidden and never fired. This one is used for Suppressed passives.

## The rules (Onigensou's rulings, all uniform; no per-skill cases)

Active and Passive come from each row's `reaction_passive_mode`, not from `skill_type` (Barrage and
Cheap Shot are both typed Passive):

- **Active** (`ask`): the player or GM chooses to use it. Only the command debuffs block these:
  - **Check A, where it comes from.** The carrier item is sorted into a command: gear-granted is
    Equipment (Disarmed), a consumable is Item (Panic), skill_type Spell is Spell (Silence), and
    anything else is Skill (Paralyzed). Rows carried by an AE, or granted by someone else's skill,
    skip this check.
  - **Check B, what it lets you do.** Blocked when the whole payload is free actions and every one
    of them is blocked (Frightened stops Counterattack). A grant is sorted by what it COUNTS AS:
    a Skill grant limited to tag:inventory is an Item action, so Panic stops Emergency Item.
- **Passive** (`on` / `force`): fires by itself. Only **Suppressed** blocks these, through the new
  AE change `disable_passive`, which is now on the Debuff hub's Suppressed. It applies to players
  and monsters alike: rows of a non-gear skill labelled Passive that has no `ask` row. Gear is
  never suppressed. A skill with an `ask` row counts as Active, so its automatic rows keep running
  (Dance's cost row). Suppressed does not remove what a passive already granted.
- No reaction is ever blocked by both families. Domination State and `ignore_gating_<ae>` tags
  still exempt. Only the label gates feed this; the Charm-style intent filter stays per entry.

`resolveDamageReactions` needed no change: it walks only AE rows, and those never grant actions.

Tests: `tools/snapshot-runner/checks/reaction-gating.js` and `reaction-gating-barrage.js` (7 actors ×
11 debuff scenarios). skill-regression check 487/487 unchanged; parity and census clean. Not yet
seen in a live session.

---

# History: deferred on 2026-11-01

Written for whoever picks this up. Nothing has been fixed. Owner not decided yet.

## The ruling (Onigensou)

Paralyzed and other conditions that block an action, such as Frightened and Confused, should not only
block that command button. They should block the use of any action that would categorize under that
command category, regardless of where it is offered, such as in a reaction.

## Symptom

Zarg fails Dreadwyrm Descent's save and gets Frightened, Paralyzed and Silence. High Speed still opens
at conflict start, and he can pay 10 MP for a free Hinder. Seen in a sandbox battle on the Unleash
branch.

## Root cause

`disable_action` and `enable_action_only` feed `getBlockedActionLabels` (`snapshot.js`), which the turn
menu, the DECLARE backstop and the AI read. `findPassiveCandidates` (`skill-effects.js`) and the
reaction dispatch paths never check it.

## Questions to settle first

- Does this cover `force` and `on` passive rows, or only reactions a player chooses? Force rows also
  carry bookkeeping and monster gimmicks (phase latches, markers, refills), so blocking them can
  desync state.
- What decides a reaction's category: the carrier's `skill_type`, or the action it grants? High Speed
  is a Skill that grants Attack or Hinder.
- Do reactions carried by an Active Effect count?
- The `Innate` keyword ("cannot be disabled") is text only today. The real exemptions are
  `ignore_gating_<ae>` skill tags and Domination State.
- There are many fire paths. `findPassiveCandidates` looks like the shared seam, but
  `resolveDamageReactions` walks its own rows.

## Please don't

Patch single skills with `ACTION_BLOCKED_SKILL` conditions in the meantime. That formula exists, and
adding it to High Speed would work, but the rule is meant to be general.

Feasibility was only partly checked before this was deferred.
