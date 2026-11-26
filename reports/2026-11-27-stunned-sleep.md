---
id: 2026-11-27-stunned-sleep
title: Heads-up — Stunned (new) + Sleep rework touch TURN_START, FREE_ACTION_WINDOW and apply_ae
status: open
severity: minor
reporter: onigensou
assignee: sarunphat
component: battle-director/state-handlers, battle-director/skill-effects, battle-director/snapshot
introduced_in: 34217e61
fixed_in:
---

Not a bug: a design onigensou approved on 2026-11-26 that touches your files.
Read-only for you unless something looks wrong. Close it (`status: verified`) once
you've had a look.

## The rules

| | Stunned (new) | Sleep (reworked) |
|---|---|---|
| While on | cannot act or perform reactions | same |
| Turn start | free DL 10 **MIG + WLP** Check: pass = ends, you act; fail = turn lost | DL 10 **INS + WLP**: pass = ends |
| Also ends | end of your next turn (1 charge, bearer turn end) | any damage, except skills tagged `dream` (Nightmare); 3 rounds (was 1 charge) |
| Reapply | no reapply, no refresh while on | same |
| Cleanse | yes (`debuff` tag) | yes |

## What changed in code

1. **New `scripts/battle-director/status-recovery.js`**: data-driven off the AE flag
   `flags.fabula-ultima-companion.recoveryCheck = { attr1, attr2, dl }`. Uses the BD
   `rollCheck` + `checkVsThreshold` (crit always passes, fumble always fails) and posts
   the dice to chat like the Grappled break-free does.
2. **TURN_START** (`state-handlers.js`): `maybeRunRecoveryChecks` runs right after
   `maybeRunBreakFree`. On a failed check the turn_start window still runs, but
   `standaloneAfter` is `CLEANUP` instead of `DECLARE`, so the turn is spent through the
   normal CLEANUP → TURN_END path (the activation is used, bearer-turn-end ticks run).
3. **FREE_ACTION_WINDOW**: a performer carrying a recovery-check status is handled
   before `freeActions.set`. A **turn-less summon** (`turnsPerRound === 0`) rolls its
   check right then: pass = acts; fail = the request is dropped and one charge is spent
   (its own turn never comes to tick it). Anyone else with the status just loses the
   granted free action.
4. **apply_ae** (`skill-effects.js`): template flag `noReapply: true` → a creature that
   already has the AE is skipped (any duplicate mode except `remove`).
5. **`disable_action: All`** (`snapshot.js` `expandAllLabels`): expands to every
   `GATEABLE_ACTION_LABELS` entry in `getBlockedActionLabels` and
   `getActionLabelBlockers`. That is how both statuses block ask-reactions (via
   `getReactionGate`) and every menu. Automatic (on/force) rows are untouched.
6. **`fireResourceChangeTrigger`** payload gains `skillTags` (from a new optional
   `skillTags` arg, else the origin item's `skill_tags`), so `SKILL_HAS_TAG_<X>` works on
   `creature_lose_resource` / `creature_gain_resource` rows. No existing resource row read
   it (checked against the authored export).
7. Sleep's old turn_start row `modify_turns −1` is **removed** by the migration. It had no
   `target_ref` (so it never fired), and at turn start it would only have cut a *later*
   activation, costing a multi-turn boss an extra turn.

UI: status id `StunnedStatId001` (csb-extra-status-effects.js), debuff tier + `stun` cue
(three circling stars, status-cues.js), keyword chips for Sleep + Stunned, journal link
icon, Effects tab labels `disable_action` as "Can't use".

Migration `2026-11-27-stunned-sleep`: Stunned AE `StunnedAE0000001` on the Debuff library,
Sleep reworked on the library and every live copy, Nightmare `skill_tags += dream`,
Sleep's journal rewritten, Stunned journal `StunnedKeyword01` created.

## Tests

- `scripts/battle-director/status-recovery.test.mjs` (9 cases, no Foundry).
- Runner check `tools/snapshot-runner/checks/stun-sleep.js`: 20/20, including real sim
  turns (pass, fail → turn lost, Sleep woken by a hit, reactions blocked).
- skill-regression `check --runner` on the branch: 0 changed / 502.
- **Not live-tested:** the turn-less summon path (3 above).
