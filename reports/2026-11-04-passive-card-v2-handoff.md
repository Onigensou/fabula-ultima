---
id: 2026-11-04-passive-card-v2-handoff
title: Hand-off — passive card v2, and three fixes in your reaction code (v1.0.521)
status: open
severity: minor
reporter: onigensou
assignee: sarunphat
component: process/merge-handoff (battle-director/passive-card-ui, action-card, card-mutations)
introduced_in:
fixed_in: 1.0.521
---

# Not a bug: a hand-off for the v1.0.521 pull

Written for sarunphat, and for the Claude session that runs the pull. Three of the commits below change your
files (action-card.js, card-mutations.js, and the shared hook in skill-effects.js). Please skim this before
touching reaction decisions or card mutations, then close it as described at the end.

## 1. Passive card v2 (e1932124, ed484b4b)

The band that appears when a passive fires now sorts passives into tiers and paces itself on each client.

- **Tiers:** Spotlight, Offense, Defense, Support, Ready, Points, Background. A passive that acts on someone,
  makes something Ready or changes tracked points gets a card. A party setup passive that only adds a status
  stays quiet (its status pop shows it).
- **Paced on every client:** the GM decides and broadcasts at once. Each client then joins repeated lines (×N),
  retires older cards, waits for round and turn plates, and drops cards while its tab is hidden.
- **Sound and colour by tier.** The points readout ("+1 Grave Point (1/5)") is off.
- **Knobs:** `scripts/battle-director/passive-card-ui/passive-card-config.js`.
- **Files:** new `passive-card-classify.js` and `passive-card-config.js`; `director-passive-card-ui.js` rewritten;
  `director-passive-card-queue.js` deleted (`passiveCardQueue` is still exported, now from the UI module).
- **Shared hook in skill-effects.js** (`firePreAcceptedCandidate`): `beginPassiveCard` before
  `applyEffectByLabel`, `settle(r)` after, both fire-and-forget. `fuPassiveCardShown` still fires, now only for
  cards actually shown.
- **Debug:** `FUCompanion.api.passiveCards.decisions()` lists why each passive got a card or stayed quiet.

## 2. Three fixes in your reaction code

| Commit | File | What changed |
|---|---|---|
| 59f68534 | action-card.js | `snapshotReactionDecisions` carries `carrierImg`. RESOLVE fires from those records, so an accepted card reaction's passive card showed 📜 instead of its icon. |
| efd7304e | action-card.js | A reaction a mid-card injector adds (a creature dragged into the targets, or a cascade) now starts from the same decision a card-build candidate does: `on`/`force` are accepted, then get the spawn pass's menu and recompute. Before, the pill read "Active" with no decision, so CONFIRM snapshotted it as "skip" and it never fired. The card-build seeding is now `seedReactionDecisions` and the spawn pass `runAutoReactionPass`. The follow-up is queued, never awaited, because the targeted injector runs inside `recomputeTargetPreviews`. |
| 04da1a8f | card-mutations.js | `adjust_defense` / `adjust_damage` change the reactor's own row, but Phase 2 runs before the Phase 3 splash and before the GM's added targets. A creature brought in by either lost that change while its chain's cost still ran at RESOLVE. The change now comes back `unplaced` and is placed after Phase 3, and again right after the GM's added rows are built. That is before the GM's own DEF edits and hand-set damage, which still win. |

The case that found the last two: a GM edit moved Skizzik's Lightning Blitz from Keren onto Zarg. Before,
Ninja Log never fired and the damage landed. With efd7304e alone, Ninja Log was spent and the 18 damage still
landed. With 04da1a8f as well, the card reads "Zarg NULLIFIED", 0 damage lands and Ninja Log is spent.

## 3. What you might notice

- A GM rollback of any reaction on a card now also un-decides accepted injected `on`/`force` reactions. Your
  derived-pill retraction (reconcileGmReactions) turns them into Apply/Skip, the same as other derived pills.
- After Ninja Log's own nullify lands, the new-target re-scan logs `condition_formula ... → 0 (falsy)` for it,
  because INCOMING_DAMAGE now reads the post-reaction 0. Harmless: the candidate is already accepted, and the
  re-gate only looks at pending ask pills.
- `skill-regression structure` shows 17 changed + 1 new docs, all Life Charm and Phoenix Feather. That is our
  v1.0.518 work (staged revive, revive animation), which your refreshed golden predates. We'll re-baseline it.

## 4. Your call (not changed)

`recomputeTargetPreviews` serializes with `if (_previewInFlight) await _previewInFlight;`, which waits only for
the recompute already running. Two callers queued behind the same one both start when it ends and run together,
and the first to finish nulls `_previewInFlight` while the other still runs. efd7304e queues one more recompute
after an injection, so this can come up a little more often. A `while` loop, or chaining each call onto the
previous promise, would close it. Not seen in testing.

## 5. How it was checked

- **Sandbox copy of our world, on a real server:** the GM move above (Zarg 113 → 113, card with its log icon), a
  direct hit on Zarg (17 → 0), and the v2 cards through several Valley battles played by onigensou.
- **Snapshot Runner, on our world:** `skill-regression check --runner` 487/487 with all of the above.
- **Not tested:** a redirect destination with its own `on`/`force` reaction (nobody in our party redirects onto
  Zarg), the Phase 3 splash path, and `adjust_defense` on a GM-added target. They go through the same placement
  as the GM case.

## Closing this

Pull, open the world once as GM and play one battle: passives that act on someone show a card, and setup ones
stay quiet. If section 2 reads right to you, set `status: verified` and push. Anything else goes under Notes.

## Notes
