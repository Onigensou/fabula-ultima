---
id: 2026-11-01-action-gating-only-blocks-the-button
title: Paralyzed, Frightened, Confused and similar block the command button but not actions of that category offered elsewhere
status: open
severity: major
reporter: onigensou
assignee:
component: battle-director/reactions
introduced_in:
fixed_in:
---

# Deferred on purpose: this needs its own thread

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
