# Soul Tithe — Sealed Cavern Hazard Design

The conflict event of the **Sealed Cavern** (`Valley_Map010`) in the Valley of the
Dragon. "Soul Tithe" is the name of the mechanic. Every other underground map keeps
[Lightning Crystal](lightning-crystal-design.md).

Status: **BUILT and tested on a real server and on one real player client (2026-11-08).
Not played by a person, and its numbers are unvalidated for balance.** Ruling settled with
the user 2026-11-07.

---

## The ruling

At the end of each round, in this order:

1. **Calling.** Every Soul Fragment already on the field steals Max HP from its
   owner equal to its current HP, then adds what it stole to its own Max HP and
   current HP. It cannot be blocked or evaded and it is not damage. It does **not**
   heal the fragment to full, so damage dealt to it sticks.
2. **The lock.** A wounded player's Max HP drops to their current HP, and they
   become **Soul-Torn**. What they lost goes into **\<Player\>'s Soul Fragment** on
   the enemy side, which is spawned if they have none.

**Destroying a fragment** gives its owner back all the stolen Max HP, plus the same
amount of current HP.

### Edge rulings

| Case | Ruling |
|---|---|
| New wounds when a fragment exists | Added to it. A player has one fragment at most. |
| The round a fragment appears | It does not Call until the next round. |
| Calling would take Max HP to 0 | It stops at 1. |
| Owner is KO'd at round end | No lock, no Calling. The fragment waits. |
| Fragment destroyed while its owner is KO'd | Max HP returns. The owner stays down. |
| Who is affected | Player characters only, not guests or summons. |
| All real enemies die, fragments remain | Victory. Fragments vanish and Max HP returns; current HP stays where it is. |
| Fragment defenses | DEF 6 / MDEF 6, immune to statuses. Resists Physical, and every weapon family except Arcane is 50% efficiency; the user chose to stack them (2026-11-08), so a non-Arcane physical weapon hit lands at 25% and an Arcane one at 50%. |
| On-kill passives | Do not trigger. A fragment is not a creature. |
| Rank totals | Damage dealt to a fragment counts. The user ruled this 2026-11-08, and no code excludes it. |

---

## How it plays

Hina at 120 HP takes one 30-damage hit, and the fragment is ignored:

| End of round | Hina | Fragment |
|---|---|---|
| 1 | 90/90 | 30/30 (new, no Calling) |
| 2 | 60/60 | 60/60 |
| 3 | 1/1 | 119/119 |

**An ignored fragment doubles every round.** Killing that 119 HP fragment returns
Hina to 120/120, at about four actions of 34 damage.

**Partial damage sticks.** A 60/60 fragment hit for 50 is 10/60. It steals 10 and
ends at 20/70. Dealing half its current HP each round holds its current HP steady,
but it keeps stealing, so only a kill stops the drain.

**A wound and a Calling overlap.** Calling comes first and takes Max HP from the
missing part of the bar first, so a player loses the larger of the two, not both.
With a 30 HP fragment and a 20 HP wound they lose 30. Healing a player whose wound
is smaller than their fragment's HP does nothing for their Max HP that round.

**Healing happens before the round ends.** Everyone starts each round at "full" HP,
so a heal does nothing until they are hurt again.

The invariant: a fragment's Max HP always equals what its owner has lost.

---

## Implementation

Selected on the battle map at Scene Config → Fabula Configuration → General →
Conflict Event. Set on `Valley_Battlemap004`, a copy of `Valley_Battlemap002` with
the same art and walls. `Valley_Map010` is the only map that fights there.

`stageAmbientNoArcs` on that scene keeps the backdrop's crystal glow and drops its
lightning arcs. The 3D preset and depth map are keyed by the art's file name, so
the copy inherits them with no further data.

### State

An event holds no state, so:

| What | Where |
|---|---|
| What a player has lost | `Soul-Torn` AE on the player: `max_hp` add `-N`, total in `flags.soulStolen` |
| A fragment's HP | `max_hp` / `current_hp` on its token actor |
| Spawn round, last Calling round, refund paid | `Soul Fragment` mark AE on its token actor: `soulSpawnRound`, `soulCalledRound`, `soulReturned` |
| Its owner | Token flag `soulFragmentOwner`, which never changes |

Rounds are not token flags because a surviving token keeps its flags through a
rewind, so a replayed round would skip its Calling.

Both AEs are `directorPermanent` so nothing ticks them, and `conflictScoped`, which
makes `isTransientAE` still let the scene-end sweep remove them, makes a rewind
restore them whole, and keeps a save load from holding on to them. `onConflictStart`
also clears any left by a fight that died before its teardown. A player must never
keep a shorter HP bar after a battle.

The spawn comes before the player's loss is written, so nobody loses Max HP to
something that is not on the field. The beat saves at its end. `onRoundEnd` starts by
taking back any stray fragment an F5 left off the roster and squaring every fragment's
Max with what its owner lost, so a re-run lands correctly.

### The round-end beat

`onRoundEnd` is a new handler on the event contract. It is **not** dispatched from
the standalone window's lifecycle call, because that runs before the `round_end`
reactions, and a Late Actor's dive should still count as this round's wound.
`ROUND_START` calls it when `dCombat.pendingRoundWrap` is set, which means a round
just ended and everything in it has settled. It does not run if the fight ended.

### The fragment

An actor flagged `conflictObject: "soul-fragment"`, `bdObject: true` and
`bdObjectHpBar: true`, kept with the Lightning Crystal in the `Conflict Objects` Actor folder
(players own neither), floating through the standard `idleAnimation.float` flag, spawned mid-stage with one staggered slot per player
(`exactCenter`, since the enemy formation would otherwise pick the spot and stack them
in one column). Its token takes the owner's sprite, tinted and translucent.

`bdObject` already gives it no turns, no EXP, no AI targeting, and no hold on the
side wipe. New for an object that can actually die:

- `director-hp-bar.js`: `bdObjectHpBar` shows the bar, with no Study needed.
- `defeat-reactor.js`: no `creature_defeated` for an object, and an object never
  holds back the last-foe finisher.
- `crisis-reactor.js`: an object is never in Crisis.
- `soul-fragment-badge.js`: its current HP stays on screen, because that is what the
  next Calling steals.

Destruction arrives through `onObjectDestroyed`, which `defeat-reactor.js` calls ahead
of the removal: on a path with nothing to animate the removal lands at once, and the
ledger reactor would find no combatant. `firedKeys` and the mark's `soulReturned` make
it once-only. A fragment at 0 HP with no HP event is refunded at the next round end.

The refund writes HP and Max in the order that keeps Crisis from flickering. A player
who ends clear of Crisis gets HP first, because at their old HP under the full bar they
would enter Crisis for a moment, and anything listening would fire for someone being
healed. A player who ends in Crisis gets Max first, so they never leave it and return.

A refund can finish after an F5. The mark records the HP before and after, worked out
once, and says when it is done. A re-run pays only if the owner's HP has not moved since,
so it can neither heal them twice nor raise someone who has since been KO'd. The same re-run pulls an owner back inside their bar if an F5 caught them between a Max
write and an HP write.

### HP writes

Calling writes HP directly, which the event system's rule 1 normally forbids. That
rule exists so damage picks up affinity, absorb and the trigger cascade, and Calling
must have none of those. Crisis follows through the standing `updateActor` hook.

### Sim

`hazard-brain.js` `soulFragmentTarget` sends the sim party at the fragment with the
most HP, ranked with the Rod: below finishing a kill, above focus-fire inertia.

---

## Testing

```
node scripts/conflict-event/events/soul-tithe.test.mjs
```

In an automated battle, on Training Ground or anywhere else:

```js
FUCompanion.api.experimental.sim.run({ enemies: [...], conflictEvent: "soul-tithe" });
```

A sim does not run teardown, so cleanup has to be checked in a real battle. That is
`tools/staging-world/soul-tithe-real-rounds.mjs`: a real start, real rounds, real
hits, rewind, F5, KO, victory and the Battle End dialog, on the Staging World.

```
FVTT_STAGING=1 FVTT_NO_THROTTLE=true FVTT_CANVAS=low node soul-tithe-real-rounds.mjs <outDir>
```

`FVTT_CANVAS` must not be `off`: a real battle start waits on a drawn frame.
`tools/staging-world/lightning-crystal-control.mjs` fights a crystal battle to victory,
as a control for the shared edits to `defeat-reactor.js`.
`tools/staging-world/soul-tithe-player-client.mjs` adds Hina's player as a second client:
the plate's Max HP, the badge, the HP bar with no Study, Calling's namecard, the player's
own attack at a fragment, and the refund, all read on the player's page.

---

## Open

- **Balance.** Damage output against a full party's wounds is the main question.
- **Presentation.** Calling is the action namecard and a moving HP number, with no
  effect of its own yet. The ruling panel's pages have no images yet.
- **Nidhogg.** The user ruled 2026-11-08 that Nidhogg uses Soul Tithe. Nidhogg is not
  built yet and is fought on `Valley_Battlemap003` (The Great Seal). That scene also
  hosts The Great Seal's random battles, which stay on Lightning Crystal, so the scene
  setting does not change. Proposed wiring, to be confirmed: Nidhogg's battle payload
  carries `context.conflictEventId: "soul-tithe"`, which `resolveConflictEventId`
  already reads ahead of the scene's setting.
