---
id: 2026-11-10-grappled-hold-handoff
title: Hand-off — Grappled hold: held unit dragged to its grappler, chain / tentacle grip (v1.0.579)
status: open
severity: info
reporter: onigensou
assignee: sarunphat
component: battle-director (new grapple-hold, grapple-grip-fx, grapple-rules; touched turn-start-cue, defeat-reactor, state-handlers, director-boot, status-pop), world actors Roper + Carlbero
introduced_in: v1.0.579
fixed_in:
---

# Grappled hold: what changed in code you also work in

Written for sarunphat and the Claude session that runs the pull. Nothing here needs action. It lists the
shared files this change touched, and two engine traps found on the way, so a merge or a later change
doesn't undo it by accident.

## 1. What it does

Grappled means the held unit shares its grappler's space, but nothing on screen showed that. Now:

- When Grappled lands, the held token **really moves** (like the turn step) into a slot beside its
  grappler: up to four slots. Its home spot is saved on the token: `flags.fabula-ultima-companion.grappleHold
  = { home, slot, by: <grappler token uuid> }`.
- It **follows** the grappler's own moves (turn step, step back, a formation re-form).
- It **walks home** when Grappled leaves for any reason, and at battle end / stop.
- A **grip** is drawn between them on every client: a chain by default, or the grappler's own skin from the
  actor flag `flags.fabula-ultima-companion.grappleSkin` (`chain`, `iron`, `tentacle`, `tentacle_green`).
- Approved look: claude.ai/artifact/FmUkx43vnEo8dtev1XjfyU (mockup v4).

**Rulings (onigensou, 2026-11-10):**
1. A defeated grappler releases everyone it holds (rule change: before, nothing removed Grappled then).
2. A held unit that is knocked out is released.
3. The splash stays one-way: effects on the grappler also hit the held unit; the held unit's own attacks don't.

## 2. Shared files touched

| File | Change |
|---|---|
| `turn-start-cue.js` | `stepOut`: a Grappled actor skips its turn step (it acts from where it is held). `startTurnCue`: after `returnSteppedTokens`, `reconcileGrapples(scene)` puts held units in their slot and freed ones home (rewind / reload / save-load). |
| `defeat-reactor.js` | `defeatReactor`: right after `emitCreatureDefeated`, `releaseGrappleOnDown(actor)` (rulings 1 + 2). Removes the Grappled AEs via `breakFree`; the hold module walks the tokens home. |
| `state-handlers.js` | `BATTLE_ENDING`: `releaseAllGrapples(scene)` next to `returnSteppedTokens`. |
| `director-boot.js` | Installs the hold (host GM) and grip (every client) on ready; `stopNow` calls `releaseAllGrapples` next to `returnSteppedTokens`. |
| `status-pop.js` | `popOnToken`: the pop now rides its token every frame, so "+Grappled" follows the drag. |

New files: `grapple-rules.js` (+ `.test.mjs`, pure: skins + slot geometry), `grapple-hold.js` (host GM only,
gated on the running director like `condition-adoption.js`), `grapple-grip-fx.js` (display only, no writes).

Token moves made by the hold carry the update option `fuGrapple: true` (and `oniBypassGate`), the same way the
turn step uses `fuTurnStep`.

## 3. Two traps worth knowing

- **`tokenDoc.x / .y` are in-between values while a move animates** (v12). Anything that computes from a token
  that may be mid-move should read `tokenDoc._source.x / .y`. The first follow implementation lagged one move
  behind because of this.
- **A new child of `canvas.primary` sorts BEFORE every sibling with equal sort keys** (`_lastSortedIndex` is 0),
  so "insert right after the mesh" does not survive the next sort. The grip uses `zIndex = mesh.zIndex ± 0.001`
  instead. `party-entrance-fx.js` / `pixel-entrance-fx.js` use the insert-after pattern (`placeAtTokenDepth`); if
  an entrance layer ever shows behind its token, this is why.

## 4. Verified

Staging World, real Roper fights through `sim.run` (GM + player Edge clients, 3D stage on): grab and pull,
four held at once (one slot each), follow on Roper's turn step, splash, a held unit's turn (no step), Break Free
and expiry release, held-unit KO release, defeated-grappler release, reload mid-hold, battle stop release, chain
and tentacle skins on both clients. `grapple-rules.test.mjs` 5/5.

Not live-tested: Carlbero's green palette (same code path as Roper's), the follow during a reinforcement
re-form, a natural battle end with a unit still held (same function as the tested stop path).

Note: Grappled already expires at the grappler's next turn (existing lifetime), so units get pulled in and walk
home often. Unchanged by this work.
