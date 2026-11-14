# Fabula Arcana card minigame (v1.0.605)

Heads-up for sarunphat: a new, self-contained minigame. **Fabula Arcana** is a three-card monster duel played at camp or against NPC duelists. Everything new lives in `scripts/fabula-arcana/` and `assets/fabula-arcana/`. The only existing file touched is `party-menu/party-menu-inventory.js`, which gains a **Cards** category and filter (2 lines). No world data changes, no migrations.

Approved mockup and rules: https://claude.ai/artifact/TPxjnLiPcs57dyEzEugaLX

## What it does at the table

- **Duels.** Each side builds a team of 3 monster cards within a 5★ budget. Each round both sides secretly play one card: an item, Pass or Switch. Then both cards reveal and the monsters fight. Knock out all three to win. Best of 1, 3 or 5.
- **Ways in** (proximity buttons on the shared overhead row, `window.oni.Interact`, same as Shop / Craft):
  - **Card Duel** on an NPC whose actor has the `faDuelist` flag. On a walk map, the Main Controller's party member plays. An optional story switch gates it (`requiresSwitch`, read with `window.oni.GameState.getSwitch`).
  - **Challenge** on another player's character, camp scenes only. The other player gets an Accept / Decline prompt.
  - **Watch** near anyone who is dueling. It opens a read-only board.
  - While a duel runs, a small cards icon floats over both duelists on every client.
- **Collection.** A card is an item in a character's **own** inventory (`item_type: "card"`, `flags.fabula-ultima-companion.faCard = { cid }`, one copy each). The party bag doesn't count. A character with fewer than 3 cards gets a starter set of commons on their first duel.
- **Ante.** An NPC duelist can put up a prize card. Winning the series gives the winner that card. The NPC keeps its own lineup.

## Architecture

- **Rules**: `fa-catalog.js` (cards, tuning) + `fa-engine.js` (pure match state machine, AI, seat-mirrored views). These are classic scripts on `globalThis.FabulaArcana`. Node tests: `node scripts/fabula-arcana/fa-engine.test.mjs` (84 checks). Balance tool: `fa-balance.mjs`.
- **Host** (`fa-host.js`): one client runs every session.
  - That client is `game.users.activeGM`. For an NPC duel with no GM online, it is the challenger's own client.
  - The host owns the AI seat, the 30 s PvP decision timer, Best-of series and the ante.
  - It sends each participant a view from **their own seat**.
  - Sessions persist in the world setting `faSessions`, so a GM reload resumes the duel.
- **Transport** (`fa-net.js`): addressed envelopes on `module.fabula-ultima-companion`, with `type: "ONI_FABULA_ARCANA_V1"`. Window→host messages use op `duel-in`; host→window messages use op `duel`. They must stay distinct because the GM client is both host and player.
- **Window** (`fa-client.js`): a full-screen same-origin iframe, `assets/fabula-arcana/duel.html?net=1`, built from the mockup.
  - Scene music is ducked locally while it is open, and the duel plays its own theme.
  - Art, SFX and BGM are **Forge URLs** (`duel-assets.js`); no ripped assets are in git. `board.webp` is generated art.
- **API** `FUCompanion.api.fabulaArcana`: `challengeNpc`, `challengePlayer`, `practice`, `setDuelist`, `spectate`, `grantCard`, `grantStarter`, `ownedCards`, `cardItemData`, `sessions`, `closeAll`, `current`, `Catalog`, `Engine`.

## Making an NPC a duelist (GM)

```js
FUCompanion.api.fabulaArcana.setDuelist(actor, {
  teams: [["roper", "kirin", "cryo"]],  // one is picked per duel; each must be legal (5★)
  diff: "casual",                        // or "skilled"
  style: null,                           // or "aggressive" | "defensive" | "trickster"
  bestOf: 1, quote: "Cards on the table.", prize: "gigas", requiresSwitch: "",
});
FUCompanion.api.fabulaArcana.setDuelist(actor, false);  // remove
```

This writes an actor flag, which is world data on the first save.

## Tested

The tests ran in a sandbox copy of the Staging World on :30003, with headless clients:
- GM practice Best of 3 against the AI: the full series, Next game, Leave.
- PvP Best of 3 between two player clients:
  - invite and accept;
  - starter gifts;
  - one player reloads mid-game and the window comes back at the same round;
  - surrender ends the series;
  - Leave closes both windows.
- GM spectates a duel.
- The GM (host) reloads mid-duel: the session restores, and the match continues for the player and the spectator.
- A player beats an NPC duelist and gets its ante card as an item. The NPC keeps its lineup.

Bugs found and fixed during the playtest:
- The `duel` op was shared by host and client, so the GM never received the window's hello.
- A starter set wasn't preselected.
- Watch failed when the client's status list lagged.

## Not verified yet

- The proximity buttons and overhead icons on a drawn canvas. The tests ran with the canvas off, so this needs a real-session look.
- A no-GM NPC duel (the player's client hosts it).
- The end panel sits below the fold on short windows (about 900 px tall). It is the same layout as the mockup.
