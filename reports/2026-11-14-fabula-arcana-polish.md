# Fabula Arcana polish (v1.0.606)

Follow-up to `2026-11-14-fabula-arcana.md` (v1.0.605). This round came from the user's own playtest in the main world. All changes sit in the card game's files, except one small bit of host logic in `fa-host.js`. No world data. No new `module.json` entries for the card game.

## Two rule changes (please read)

These were rules calls, made by the user after a bot simulation. The sim is kept at `tools/fabula-arcana-mockup/howl-windup-sim.mjs`. Each mode played a team with the card against a random legal team without it: 6,000 games with the casual AI and 3,000 with the skilled AI.

| Card | Rule | Win % (casual / skilled) |
|---|---|---|
| Wolf · Howl | ability off | 38.3 / 33.5 |
| | **same round (kept)** | **44.9 / 43.2** |
| | next attack (rejected) | 42.2 / 37.1 |
| Rock Golem · Wind Up | ability off | 41.7 / 39.6 |
| | same round (old) | 56.6 / 63.5 |
| | **next attack (new)** | **51.9 / 54.4** |

- **Wolf:** the rule is unchanged, and only the text is fixed. Passing means it attacks that same round with +1 ATK. The text now reads "When it Passes, its attack this round gets +1 ATK." Under "next attack", an already below-average card would get weaker.
- **Rock Golem:** Wind Up now arms at the end of the round it Passed and powers its next attack. While armed it shows a gold tile, so the opponent can answer it. It can also be combined with an item. This also brings an overpowered card back towards average.
- Both are per-card switches in `fa-catalog.js`: `CFG.HOWL_NEXT` (0) and `CFG.WINDUP_NEXT` (1). 0 = same round, 1 = next attack, 2 = off, which is for sims only. The rule is mirrored in the duel page's standalone engine copy (`duel.html`).

## What changed at the table

- **Challenge panel** (`fa-invite-ui.js`, new) replaces Foundry's Yes/No dialog.
  - It shows the challenger's portrait, a 20 s countdown bar, and Accept / Decline / **Block tonight**.
  - When the time runs out it closes itself. The host also withdraws it (op `invite-close`), so a late click can't answer an expired challenge.
  - The challenger hears the answer (op `invite-result`). Sounds: Bell3 when it appears, Item1 on accept, Down1 on decline.
- **Block tonight:** a User flag, `faBlock`, cleared by the host GM on `fabula.restPerformed`. The challenger reads "X isn't taking challenges tonight."
- **Lobby:** each player sees both players' status chips, "Choosing…" or "✓ Ready".
- **Round timer:** a full-width bar across the board's middle, with no number. It turns orange under 10 s, then red and pulsing under 5 s, and shakes under 3 s.
- **Banner API:** `FA_BANNER(text, { tone, sub, ms })` plays with a whoosh (Evasion2). It's used for KO / replacement, "Time's almost up!" (once per game) and "Battle Start!". The host can send it with the duel message `banner`.
- **Result screen:** Rematch / Next game / Leave sit on the VICTORY / DEFEAT screen itself.
  - A PvP rematch needs both players to press it (duel message `rematch`); host `rematch()` resets the series and rechecks the NPC prize.
  - If the opponent leaves, Rematch greys out.
- **Volume:** a 🔊 button with Music / Sound sliders. Each player's levels are saved in their own browser.
- **Status effects:** these are the battle mode "G + E" look, copied locally because the duel window is its own page.
  - Rounded-square tiles with Buff Icon art. The frame shows the tier: red debuff, green buff, gold glowing Ready, grey spent. A corner number shows stacks or rounds.
  - Tooltips use the battle layout.
  - Effects also appear on the hologram: Static sparks, Burn flames, a power glow, and Roo's dark pulse.
  - ATK and SPD show the current value, green when raised and red when lowered.
  - Tailwind shows as a field tile.
- **Passive card band:** a copy of the `battle-director/passive-card-ui` look. When an ability acts mid-round, a Bravely Default II band slides across that monster's waist and plays `passive_card.wav`.
  - Attacker abilities appear as the strike starts, defender abilities at impact, and after-effects once the hits land.
  - It's drawn from data the round already sends (each hit's breakdown line, `ev.direct`, `ev.after`), so nothing new goes over the network.
- **Start-of-game animation:**
  - The monsters slide into place, staggered. Both hands are dealt in from the side, with Book1 per card. Then "Battle Start!".
  - It plays on fresh games only; a reconnect doesn't replay it.
  - Host: `decide(s, extra)` adds `INTRO_MS` (2.4 s, +1.9 s in a series) to the first decision's timer and to the AI's delay.
- **Card reveal:** Book1 now plays for each card as it flips.

## Tested

- Staging World, real GM + 2 player windows:
  - challenge panel timeout, decline, block (and its clearing on rest), accept;
  - ready chips; fuse states; KO banners; PvP rematch both ways; opponent left; NPC rematch;
  - status tiles in a PvP duel; Howl / Wind Up / Thick Skin / Static bands;
  - the intro in NPC and PvP (the AI waits, and the timer starts at 31.5 s).
- The user played several duels in the main world on this build.
- Shareable mockup, built from `duel.html`: https://claude.ai/artifact/TPxjnLiPcs57dyEzEugaLX. Its build script is `tools/fabula-arcana-mockup/build.mjs`.

## Not verified yet

- Real session with real players (latency, two GMs).
- The `fabula.restPerformed` clear in a real camp rest. Only a simulated hook call was tested.

## v1.0.607: PvP disconnect + a timer bug

- **Disconnect grace** (`fa-host.js`): the host listens to Foundry's `userConnected` hook.
  - When a seated PvP player drops, they get 60 s (`GRACE_MS`). The round clock stops in `decide()`, which skips the timer while `s.away` is set, so nobody auto-plays the empty seat.
  - The opponent's window gets the duel message `opp-away` and shows a countdown strip.
  - **Back in time:** the opponent gets `opp-back` and a fresh clock, and the player's window reopens through `hello-client` as before.
  - **Not back:** the player forfeits the series. `opp-gone` makes the result read "X disconnected".
  - **Other cases:** during team select, or with both players gone, the duel is cancelled. An open invite from a player who goes offline is withdrawn, and a spectator who drops is removed. NPC duels are unchanged.
  - On a GM host reload, `restore()` restarts the grace for anyone still offline.
- **Bug fix** (`duel.html`): the in-game window still ran the standalone `tickTimer`, which auto-plays a Pass at 0. A window that redrew after a deadline (lag, a reconnect) sent that Pass, and it counted in the *next* round. The in-game window now uses `tick`, which only draws the fuse; the host owns timeouts.
- **Tested on the Staging World:**
  - drop and return at ~20 s;
  - drop and stay away, with the forfeit at 60 s;
  - a host submit trace, which shows no stray Pass;
  - the challenge / block / rematch regression.
- **Not tested:** a real network drop. The tests close the browser.
