---
id: 2026-11-04-phoenix-ko-targeting
title: Hand-off — Phoenix Feather targets a KO ally (KO target pools; your targeting + set_resource code)
status: open
severity: major
reporter: onigensou
assignee: sarunphat
component: battle-director/targeting (snapshot, target-survey, compose-action, state-handlers), skill-effects set_resource, defeat-reactor
introduced_in: cf50c729
fixed_in: 20f4da67
---

# Phoenix Feather can target a knocked-out ally

Written for sarunphat, and for the Claude session that runs the pull. The code commit changes five of your
files. The world commit changes the target text on 11 Phoenix Feather docs.

## 1. What was broken

Since cf50c729 (2026-06-03), both pool builders (`snapshotEligibleTargetsFromDCombat`,
`snapshotEligibleTargets`) skip creatures at 0 HP. In battle, Phoenix Feather ("One Ally") could therefore never
reach a downed ally. The picker offered only the living, and the Item step filtered the pick down to an empty
list. The action then resolved on nobody, and the feather was still used up.

## 2. What changed (20f4da67)

| File | Change |
|---|---|
| snapshot.js | `targetsKnockedOut(text)` is true for a target text containing the word KO. Both pool builders take `defeated: "exclude"` (the default, unchanged) or `"only"` (the downed only, same side rules). |
| target-survey.js | `surveyActionTargets` (the AI and the TARGET stage) uses the KO pool for a KO text. `extractTargetCountFromText` drops the KO qualifier, so "One KO Ally" counts as 1. It used to log an evaluateFormula warning. |
| state-handlers.js | DECLARE bakes `downedAllies` / `downedEnemies` next to the living lists, both in the local compose and in the broadcast `menuSpec.eligible`, because a player's client has no dCombat. The Item TARGET branch records `pickedTargetCount`, and `resolveAction` doesn't use up an item that reached none of its picked targets. |
| compose-action.js | `resolveTargetsForSource` swaps in the downed lists for a KO text. The GM's live recompute in `composeAction` builds them too. |
| skill-effects.js (`set_resource`) + defeat-reactor.js | `set_resource` writes HP outside the resource ledger, so the defeat reactor never saw a revive. The ally kept the KO status and the KO pose until her next HP event. A revive from 0 HP now calls `settleRevive(actor)` right after the write. That runs the same step as the Auto-Life branch: the KO status comes off, and the pose with it. |

## 3. World data (400aba95)

`skill_target` "One Ally" → "One KO Ally" on the 2 world Phoenix Feather items and all 9 carried copies
(EXFURSION Party, Hina, Sigrun and Zarg ×2 each, Hako ×1). Hako's consumable `exVAwWwaIvNcyuwc` has no target text
and defers to its linked skill, so it's unchanged. Raise Dead already reads "One KO Creature" and gets the KO pool
from the same code. The actors store also carries the Field actor's Wellspring churn from our Nov 3 world open
(its 5 field effects re-created for the newly active scene).

## 4. Your call (not changed)

`set_resource` is the one HP writer that doesn't put its change on the resource ledger. `grant` does, since your
280292997. So apart from the KO status, which we now settle directly:

- The crisis and derived-status reactors don't reconcile after it. For example, Placebo Energy raising HP over
  half leaves Crisis on until the next HP event.
- `creature_gain_resource` reactions never fire for it. Heart Stone, Stitched-Up Jacket, Elemental Overflow and
  the Consume skills listen for gains.

Calling `fireResourceChangeTrigger` (cause `grant`) from `set_resource`, the way `grant` does, would close both.
It would also change what fires for its 11 users: Phoenix Feather, Placebo Energy, Heart Stone, Ring of
Defiance, Shooting Star Crystal / Fragment, Robe of Flesh, Faithful Companion, Life / Mana Residue, Birth of the
Cruel. Heart Stone also both listens for gains and uses `set_resource`. That's why we stopped at the KO status. If
you add the emit, `settleRevive` becomes redundant but stays harmless, because it is idempotent.

## 5. How it was checked

- **Sandbox copy of our world, real server, real battle** (party vs Skizzik + Lightning Prism):
  - GM menus (desk Take Turn → Item → Phoenix Feather): the picker offered only the downed Blanche, with no foes.
    The revive took her from 0 → 86 HP, the KO status came off at once (pose ko → crisis), and the feather was
    used up.
  - Player path: the `menuSpec` the GM broadcast at DECLARE, JSON round-tripped, run through
    `resolveTargetsForSource` with `director: null`. It showed the same single row and returned Blanche.
  - Sim (AI): the survey offered only downed allies. A scripted pick on a standing ally logged "not used up" and
    left the feather.
- **Snapshot Runner:** `skill-regression check --runner` 487/487. Unit tests 57/58 (crisis-keywords, which was
  already stale).
- **Not tested:** a real second client as the player (the player path ran on the GM's client with no director),
  Raise Dead in battle, and the legacy no-dCombat pool path.

## Closing this

Pull, open the world as GM, knock an ally down and use a Phoenix Feather in battle, ideally from a player's own
client. If the picker offers only the downed ally and they stand up, set `status: verified` and push. Put your
section 4 decision under Notes.

## Notes
