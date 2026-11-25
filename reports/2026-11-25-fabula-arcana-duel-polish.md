# Fabula Arcana: duel dialogue, obtained-card messages, exit transition (v1.0.675)

2026-11-25 · branch `feat/fa-duel-polish` · phase 1 of the town-duelists plan (review page approved by the user).

## What players see

1. **Challenge, FF8/FF9 style.** Pressing Card Duel at an NPC duelist makes the NPC say its challenge line in a bubble
   over its token. A parchment box then asks "Card duel with Willy?" with **Duel!** / **Not now**, and a small line
   under the question: the ante ("Ante: Princess Hilde card", or "Friendly match" once you own everything they offer)
   and the rules ("Standard 5★ · Best of 1"). Not now → the NPC's decline line. Once the party has beaten that NPC, the
   rematch line replaces the challenge line.
2. **Card-player mark.** A small card mark floats over NPC duelists within 8 grid squares of the party; at the NPC's
   feet it gives way to the Card Duel button.
3. **Exit (≈3.5 s, skippable).** Leave on the result screen: the result panel slides out, every card flips face down
   and flies home (holograms fold into a scanline), the won card rises and glints, the board dims, the duel theme
   fades, black. The client then holds black, removes the duel window and lifts the black over the map (movement
   locked meanwhile). Leaving mid-match, a cancel or a host close is a 0.4 s fade instead of a snap.
4. **Outro on the map.** The NPC's win or loss line over its token, then a System Message line:
   "Keren won the [card] Princess Hilde card!" (item link: card art icon, hover opens the card; held 3.5 s).
5. **Battle drops** get the same line after the return to the map ("Hina obtained the Wolf card!"); the Victory
   screen's Drops page is unchanged. **Starter sets** now announce in the System Message box instead of a corner toast.

Measured in the sandbox: window gone 1.85 s after Leave, NPC line at 3.1 s, reward line at 3.9 s.

## Code

| File | Change |
|---|---|
| `scripts/fabula-arcana/fa-feedback.js` (new) | line wording (`cardLine`, `starterLine`, `say` with a 3.5 s hold), party "beaten" record (`flags.<mod>.faBeaten.<npcActorId>` on `oni.GameState.partyActor()`), drop relay on `fu.battleEnd` |
| `fa-entry.js` | `duelTalk()` before `challengeNpc` sends; `setDuelist` keeps `declineQuote`, `npcWinQuote`, `playerWinQuote`, `rematchQuote`; card-player mark (`markMap`, 8 grid) |
| `fa-host.js` | `s.lines` + `s.earned` per NPC session; `markBeaten` on a series win; `leave()` sends `close {outro}` to the player (line only if the series was finished by play; event duels get none); starter gift → `say(starterLine)` |
| `fa-client.js` | `exitWindow("teardown"|"fade")` (veil, hold, lift, movement lock, never closes a window opened meanwhile); `close` waits for the exit, then `playOutro` |
| `assets/fabula-arcana/duel.html` | `exitDuel()` teardown (net mode), both Leave buttons; reduced motion → straight out |
| `fa-collection.js` | `grantCard` returns `{ ok, created, uuid }` (was `{ ok, created }`) |
| `fa-drops.js` | drop entries carry `uuid`; `noteDrops(out)` for the after-battle line |
| `data-migrations/2026-11-25-fa-duel-dialogue.js` | fills Willy's 4 new lines (only empty fields) |

### Heads-up: shared teleporter prompt (`teleporter-system/tp-bootstrap.js`)

`TeleporterSystem.askYesNo(text, opts)` gains three **optional** settings; nothing changes when they are absent:
`labels { yes, no }` (button words), `note` (small line under the question), `place: "low"` (box at top 74% instead
of 42%, so a speaker at the camera's centre stays visible). The mirror payload carries them to watchers. One global
tweak: the two buttons are `white-space: nowrap` ("Not now" wrapped onto two lines).

## Tests

- Engine + drops unit tests: all pass. Every changed module `node --check`ed as `.mjs`.
- Sandbox (today's world copy, module junctioned to the branch, headless, port 30011): **26/26** — migration wrote
  Willy's lines; prompt text, labels, note; challenge/decline/rematch bubbles; a won duel (NPC cards at 1 HP, moves =
  engine auto choice through the real bridge) with the prize item uuid; teardown in the window (cards home, prize
  card); window removed under black at ~1.85 s; NPC line then reward line; veil gone; beaten record; Friendly match
  once the prize is owned; drop line after `fu.battleEnd` with the item link; starter wording. 0 related console errors.
- Screenshots checked: prompt placement (low), mark at distance vs button at the feet, reward line.

## Not in this push

Per-token duelist setups, prize order, the other NPCs' lines (phase 5), card text (phase 3), new cards (phase 4),
add-to-hand API (phase 2).
