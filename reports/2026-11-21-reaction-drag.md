# Reaction cards: drag and drop, ally holding glow, comet on confirm (v1.0.644)

The drag you deferred after v1.0.549 is built. It changes your reaction hand and landing files, so this note says what's different and why. Nothing here needs work from you. Read it before you next change `reaction-hand.js`, `reaction-landing.js` or the reaction-pill handlers in `action-card.js`.

Mockup the host approved: claude.ai/artifact/PRoeSXjL8cuiA8be4VEQ6K (forked from your Reaction Flight mockup).

## What you need to do
- Pull and restart the server (version bump), then reload. No world data, no migration, no new `module.json` entries (`reaction-drag.js` is imported by `reaction-hand.js`).

## What players see
- **Your own cards (Card mode, on an action card):** press and move 7 px and the card comes off the hand (Fabula Arcana's drag, ported). Click still works exactly as before.
  - Over the action card it gets a dashed, then solid, outline. The Reactions box opens with a dashed empty slot, and the held card leans toward it.
  - Dropped on target, it's the same Use as a click. The dragged copy parks there at 70% while the reaction's decision runs. When the host finalises it, your existing flight starts from the parked copy instead of the hand.
  - A miss, a cancelled pick or a refusal slides it home with Book1 (`Sound/Soundboard/Book1.ogg`). If it goes moot or is skipped while parked, it flies into the deck from where it is.
- **Standalone windows** (conflict, round or turn start, e.g. High Speed) stay click-only. There's no action card to drop on.
- **Allies:** while an ally holds a card, their small card lifts and slowly glows brighter and dimmer in their Foundry user colour. Nothing else shows on the board, so a long think or three allies at once stays clean.
  - When the host confirms an ally's reaction, your small-card flight is replaced by a particle comet in their colour, from their panel to the slot (520 ms, `bookLanding` spacing).

## What changed in code
- **New `reaction-drag.js`:** the drag engine: the 7 px slop, the held copy drawn in its own fixed layer (`#rxdg-layer`, z 121), tilt, magnet, park, `sendHome`. It only moves things. The caller decides everything through hooks.
- **`reaction-hand.js`:**
  - `makeCard` attaches the drag. `dragHooks` turns a drop into `clickPill(apply)` + `hold(c)`. `c.parked` holds the parked copy.
  - `leave("play")` hands it to `deckPlay`. The revert branch in `syncHand` calls `unpark`. `goAway` and `leave("back")` call `returnParkedToDeck`.
  - The preview slot (`showPreview` / `hidePreview`) adds `.rxh-preview` to the Reactions row and a `.rxh-slot-preview` placeholder. It isn't a pill class, so `readPills` ignores it.
  - `syncAllies` toggles `.is-holding` from the pill's `data-fud-reaction-holding` and calls `flyComet` for an applied ally reaction.
- **`reaction-landing.js`:**
  - `flyComet` (new), same contract as `flyToReactionBox`.
  - `takeOverPreview` lets a landing take over a box the preview already opened, so it doesn't open twice.
- **`action-card.js` + `intents.js`:**
  - New `INTENTS.REACTION_HOLD` (player → host).
  - The host relays it as a new menu kind, `action-card-pill-hold` (host → other players), which sets `data-fud-reaction-holding` on their mirror pill. Display only.
  - The host's `armHoldAwait` loop sits beside `armReactionAwait` and is aborted in `abortPendingAwaits`.
  - CSS: `.rxh-preview` exempts the row from the "no reaction in effect" `display: none`.

## The trap this walks next to (please keep it)
Two places treat an action or decision they don't recognise as **Skip**:
- `REACTION_CHOICE` on the host: `body.decision === "apply" ? "apply" : "skip"`.
- The two pill click handlers: `reactionBtn.dataset.fudReactionAction === "apply" ? "apply" : "skip"`, on the host card and the player mirror.

So the hold signal never travels as a reaction choice or a `pill-update`. Both click handlers now `return` on `hold` / `unhold` before their Skip line. An older host simply has no awaiter for `REACTION_HOLD`, and `director.dispatch` drops it. An older client ignores the unknown menu kind.

`reaction-drag.test.mjs` checks this from the source. It fails if a refactor moves the guard below a Skip fallback, or if "holding" ever goes out as a `pill-update` decision.

## Checked
- `reaction-drag.test.mjs` 7/7 (geometry, drop zone, comet colours, the Skip-trap guards). `reaction-tone.test.mjs` 19/19.
- Sandbox copy of the world: GM plus three real player clients (Hina, Keren, Blanche), Nox Hounds in ambush, Card mode.
  - Blanche held Protect: Hina's and Keren's screens showed her small card glowing in her colour. She let go off target: it went home, the glow cleared, no pill changed.
  - Hina dropped Protect: it parked, the box opened with the slot, the target picker opened, she picked Zarg. The flight started from the parked copy. On Keren's screen Hina's small card left.
  - Blanche dropped Protect: on Keren's screen her comet went out and the impact came 0.53 s later. No errors.
  - A parked card going moot flew into the deck (this was a bug, fixed in `134d4594`). A held-back apply plus a revert slid the parked card home.
  - Click-to-use unchanged. A standalone window's card can't be dragged. Reduced motion: no comet, the badge fades in.
- Not seen live: two ally comets confirmed within 0.5 s of each other. `flyComet` books its landing through the same `bookLanding` as your flights.

## Notes
- The parked copy sits over the action card's lower half while a target picker is open. It doesn't cover the board. If players find it in the way, sliding it beside the card is the agreed fallback.
