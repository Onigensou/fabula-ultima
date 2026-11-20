# Reaction cards: drag and drop, ally holding glow, comet on confirm (v1.0.644)

The drag you deferred after v1.0.549 is built. It changes your reaction hand and landing files, so this note says what's different and why. Nothing here needs work from you. Read it before you next change `reaction-hand.js`, `reaction-landing.js` or the reaction-pill handlers in `action-card.js`.

Mockup the host approved: claude.ai/artifact/PRoeSXjL8cuiA8be4VEQ6K (forked from your Reaction Flight mockup).

## What you need to do
- Pull and restart the server (version bump), then reload. No world data, no migration, no new `module.json` entries (`reaction-drag.js` is imported by `reaction-hand.js`).

## What players see
- **Your own cards (Card mode, on an action card):** press and move 7 px and the card comes off the hand (Fabula Arcana's drag, ported). Click still works exactly as before.
  - Over the action card it gets a dashed, then solid, outline. The Reactions box opens with a dashed empty slot, and the held card leans a little toward it (magnet 0.12; the host tried 0 / 0.12 / 0.35 live and picked this).
  - Dropped on target, it's the same Use as a click. The card shrinks onto its icon inside the slot and stays there as a see-through, blinking badge while the reaction's decision runs (a target pick, the host). Nothing covers the action card's text while you pick a target.
  - When the host finalises it, the badge lands right there: the real icon takes the spot and gets your usual hit and sound, with no flight. The hand card goes to its pile as before.
  - A miss, a cancelled pick or a refusal grows the card back out of the slot and slides it home with Book1 (`Sound/Soundboard/Book1.ogg`). If it goes moot or is skipped while waiting, the badge goes and the hand card goes into the deck the usual way.
- **Standalone windows** (conflict, round or turn start, e.g. High Speed) stay click-only. There's no action card to drop on.
- **Allies:** while an ally holds a card, their small card lifts and slowly glows brighter and dimmer in their Foundry user colour. Nothing else shows on the board, so a long think or three allies at once stays clean.
  - When the host confirms an ally's reaction, your small-card flight is replaced by a particle comet in their colour, from their panel to the slot (520 ms, `bookLanding` spacing).

## What changed in code
- **New `reaction-drag.js`:** the drag engine: the 7 px slop, the held copy drawn in its own fixed layer (`#rxdg-layer`, z 121), tilt, magnet, tuck (into the slot, via the `parkAt` hook; parks at 70% only if there's no slot), `sendHome`. It only moves things. The caller decides everything through hooks.
- **`reaction-hand.js`:**
  - `makeCard` attaches the drag. `dragHooks` turns a drop into `clickPill(apply)` + `hold(c)`, and `parkAt` marks the slot `.is-pending` with the card's icon (the badge). `c.parked` holds the tucked copy.
  - `leave("play")` calls `deckPlay(el, { inPlace: true })` for a tucked card. The revert branch in `syncHand` calls `unpark`. `goAway` and `leave("back")` call `returnParkedToDeck`.
  - The preview slot (`showPreview` / `hidePreview`) adds `.rxh-preview` to the Reactions row and a `.rxh-slot-preview` placeholder. It isn't a pill class, so `readPills` ignores it.
  - `syncAllies` toggles `.is-holding` from the pill's `data-fud-reaction-holding` and calls `flyComet` for an applied ally reaction.
- **`reaction-landing.js`:**
  - `flyComet` (new), same contract as `flyToReactionBox`.
  - `landInPlace` (new): no flight, the pill takes the badge's spot and gets `land()`'s hit. Booked through `bookLanding` like the flights. `reaction-deck.js` `deckPlay` takes `inPlace` to use it.
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
- `reaction-drag.test.mjs` 9/9 (geometry, the tuck lands the icon on the slot, magnet value, drop zone, comet colours, the Skip-trap guards). `reaction-tone.test.mjs` 19/19.
- Sandbox copy of the world: GM plus three real player clients (Hina, Keren, Blanche), Nox Hounds in ambush, Card mode.
  - Blanche held Protect: Hina's and Keren's screens showed her small card glowing in her colour. She let go off target: it went home, the glow cleared, no pill changed.
  - Hina dropped Protect: the box opened with the slot, the target picker opened, she picked Zarg, and it played. On Keren's screen Hina's small card left.
  - After the badge change: Blanche dropped Protect, it tucked into the slot as the badge and landed there on confirm, the card went to SPENT. Hina dropped Prophetic Defender with its choice held back: the badge waited in the slot, then the revert grew the card back home, host and client both undecided again.
  - Blanche dropped Protect: on Keren's screen her comet went out and the impact came 0.53 s later. No errors.
  - A dropped card going moot went into the deck (this was a bug, fixed in `134d4594`).
  - Click-to-use unchanged. A standalone window's card can't be dragged. Reduced motion: no comet, the badge fades in.
- Not seen live: two ally comets confirmed within 0.5 s of each other. `flyComet` books its landing through the same `bookLanding` as your flights.

## Notes
- The first build parked the dropped card over the action card's lower half while a target picker was open, which made the card look frozen. The host asked for the see-through badge in the slot instead, and that's what shipped.
