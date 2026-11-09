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

## HUD: the burned Max HP (design chosen 2026-11-09, not built yet)

The player panel's HP bar (`battle-director/director-player-hud.js`, the plate's
`.dhud-hp` and each ally card's) shows what the Soul Tithe took. Mockup, playable:
https://claude.ai/artifact/Bv2PgqZ4PSggFumPJP7j2A (source `tools/soul-tithe-fx-mock/hp-burn/`,
local only).

- **Scale.** The bar keeps its full length: Max HP now + what was taken. The green fill
  is current HP. The taken part sits at the right end. The numbers stay as today
  (current / Max now).
- **The taken part** is charred: near-black soul green (`SOUL[0]`/`SOUL[1]`) with a few
  `SOUL[3]` cinders fixed in place. It holds still. A bright `SOUL[5]` edge, 2 px on the
  plate and 1 px on a card, marks where the Max HP still held ends.
- **The fire: "Burning front".** One narrow soul fire (`makeSoulFlame`) sits on the first
  few px of the taken part, at the split, and is drawn **over** the bar (`cover: true`: a
  fire bed on the bar, tongues and sparks across it). Width: **4 px** (the user's pick,
  2026-11-09). Breeze to the right:
  `{ wind: 0.5, smoke: false, cover: true, k: 1.6, lift: 14 }`, k and lift scaled ×0.6 on
  the ally cards. A soot mark on the paper sits behind it: an ellipse round the front,
  0.78 of the v5 size (horizontal radius `0.78 × max(front/2 + 6, up + 4)`, height ×
  `(up + 6) / that`, `up = 14 × scale + 4`), so it stays a little larger than the light.
- **The fire's light on the scorch.** A soft `SOUL[5]` wash over the inner part of the
  soot (radius 0.62 of the v5 scorch size, so inside the 0.78 soot, round the flame's base, 3 px × wind downwind): 100% at
  the centre, 78% at 0.35, 32% at 0.7, 0 at the rim. It must be easily seen (the user's
  call after two fainter passes), flickering 0.78–1.0 with the fire and up to ×1.6 with a flare.
  It is painted as a tint (source-over), never added: additive light on the pale paper
  read as grey discs.
- **The wind follows the front.** While the split moves, the wind blows against the way it
  moves, so the flame trails behind it: wind = 0.5 − 0.8 × (split speed in bar widths per
  second), clamped to ±1.5 and smoothed over 0.06 s, set each frame with
  `flame.setWind(w, t)`. The Tithe and the Calling push it to about 1.2 (hard right); the
  Destroyed push swings it to about −0.4 (left). It settles back to 0.5 in about 0.3 s.
- **The trail.** The flame's place is fed each frame with `flame.setOrigin(x, t)`, so a
  lick, puff or ember stays where it was let go while the front moves on: the trail shows
  on the side opposite the movement. One `makeFlameMotion()` per bar is shared by the
  flames that take over as the front narrows (`o.motion`), and `trailPad: 70` widens the
  frame so the trail is not cut off.
- **Motion.** The split and the numbers move with a quartic ease out
  (`1 − (1 − u)^4`): fastest at the start, then slowing.
- **On the light panel**, unlike the battlefield: no light layer (it is additive light
  and showed as grey discs), no smoke, and the fire's two coolest teals (`FH[7]`,
  `FH[8]`) and pixels under alpha 160 are dropped.
- **Changes:**

  | Change | Starts | What the bar does |
  |---|---|---|
  | Soul Tithe | at the tear, 0.5 s | The fire lights at the bar's end with a flare and burns left across the empty part to current HP. Burned pixels glow `SOUL[5]`→`[4]`→`[3]` over 0.45 s, then char. Max counts down. |
  | Calling | at the first bead, 0.6 s | The front burns further left. If HP is above the new Max it eats into the fill, and both numbers count down. |
  | Fragment destroyed | at the first flamelet, 0.5 s | The front is pushed right in one ease-out move, the flame leaning back against it. The fill regrows with a pale flash. Once 90% of the way is covered (about 0.22 s in, while the front is still fast, not after the ease out's slow crawl), the flame **disperses** in the same frame: that frame's pixels replace the flame, all move at once (no hold; the top a little faster) and fly on to the right with the front's momentum (35% of it, at most 160 px/s; the momentum takes the front's speed and dies away over 0.35 s), rising a little, then cool `SOUL[4]`→`[3]`→`[2]` and go out over 0.35–0.75 s, with 4 sparks. |
  | Battle ends | at once, gone by ~2.2 s | (Mockup v8, the user's pick "A · Ash drifts off", 2026-11-09; was: fire out 0.4 s + char cools 0.9 s.) The fire **disperses** at once like the refund's, pushed right by the breeze (80 px/s × 35%) since the front is still, with 4 sparks. Over 0.25 s the char's soul colours turn to **black ash** (three tones from the same cinder hash: dark / mid / fleck). Each ash pixel then lets go at 0.18 + 0.5·u + 0.45·random − 0.06·(1 − v) s (u: 0 at the fire, 1 at the bar's end; v: row, 0 top), so the part by the fire goes first and the top rows a little earlier. A flake drifts right (12–34 art px/s, + 14 px/s² push), lifts (4–15 px/s × the kind's scale, 6 px/s² fall), flutters ±1.2 px, and pales through three greys over 0.8–1.4 s before it is gone; the bar's own empty track shows where the ash left, because current HP stays. A bar nobody draws ends its ash after 3.2 s. |

- `makeSoulFlame` gained, for this: `smoke` and `wind` options, `cover` (burn on the
  silhouette, not round it), `setWind(w, t)` (a live wind: tongues lean with the wind
  now, particles drift with the wind averaged over their own life, so a change never makes
  them jump), `setOrigin(x, t)` (a moving fire leaves its particles behind), `motion`
  (`makeFlameMotion()`, shared history) and `trailPad`. All are off by default, and a
  still fire in a steady wind draws exactly as before.

### Built (2026-11-09)

- `scripts/conflict-event/soul-fx/soul-hp-burn.js`. The HUD loads it the first time a
  bar has anything taken (`director-player-hud.js` `syncSoul`), so other fights never
  load the fire code. The HUD reads the taken amount from the Soul-Torn AE
  (`soulStolen`), scales the bar, the damage trail and the cost preview to Max + taken,
  glides the Max number, and calls `syncSoulBurn(card, { v, m, stolen }, first)` before it
  moves the fill. A first read (page load, F5, a rebuilt card) shows the bar as it is.
- Which change a read is: more taken → Tithe (fire was out) or Calling (it was lit).
  Less taken with the HP up in the last 1.5 s, or within 0.25 s after → refund (the rules
  pay HP and Max in either order to keep Crisis from flickering). Less taken and no HP
  → the end of the fight (also a refund to a KO'd owner, whose HP stays at 0).
- Two canvases per bar on the art grid (6 art px on the plate, 4 on a card, at any
  screen size): the char inside the bar (its rounded border clips it), and the soot,
  light, fire, sparks and disperse over the card (`z-index: 4`, no pointer events).
  One rAF loop for every bar; asleep when nothing burns. Changes redraw at the
  "Effects frame rate" option, a bar that is only burning at 30 fps.
- A refund grows the fill with the front's own ease out (the bar's usual 240 ms ease
  starts slower, which showed a gap of empty track behind the front).
- Tests: `node scripts/conflict-event/soul-fx/soul-hp-burn.test.mjs` (the model and the
  flame options); real HUD: `tools/staging-world/soul-hp-burn-hud.mjs`.
- Also on the **GM desk** (2026-11-09): its unit rows call the same `syncSoul` with a
  row handle `{ el, kind: "card", hpFill: .bar .fl }`, and scale the fill and trail to
  Max + taken (`gm-desk.js` `paintRow`); rig `tools/staging-world/soul-hp-burn-desk.mjs`.
  The desk's Take Turn tiles are not covered. **Spectators** get all-compact party cards,
  which run `syncSoul` like any player's.

---

## Open

- **Balance.** Damage output against a full party's wounds is the main question.
- **Presentation.** The ruling panel's pages have no images yet.
- **Nidhogg.** The user ruled 2026-11-08 that Nidhogg uses Soul Tithe. Nidhogg is not
  built yet and is fought on `Valley_Battlemap003` (The Great Seal). That scene also
  hosts The Great Seal's random battles, which stay on Lightning Crystal, so the scene
  setting does not change. Proposed wiring, to be confirmed: Nidhogg's battle payload
  carries `context.conflictEventId: "soul-tithe"`, which `resolveConflictEventId`
  already reads ahead of the scene's setting.
