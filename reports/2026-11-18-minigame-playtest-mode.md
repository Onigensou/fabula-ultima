# Minigame playtest mode (v1.0.630)

A way to play a minigame (Plasma Field Dash for now) as a sandbox, outside the story: for playtests with other people, without setting story switches, paying rewards or leaving demo state to clean up. Code only: no world data, no migration, no new `module.json` entries (a hard reload is enough, no server restart).

## How to start one
- **GM button:** token controls → **Minigame Playtest** (gamepad icon). The launcher has four seats (character + who plays it: any connected user, a GM too, or CPU), a start stage (1-3), and toggles for the practice yard, the opening camera pan, the quick course and the per-round time limit. The last setup is remembered in that browser's localStorage only.
- **API (primary GM):**
  ```js
  FUCompanion.api.minigame.playtest({
    game: "plasma-field",
    actors: ["Hina", "Zarg"],         // names or ids, 1-4; default = the current party
    seats: { "PlayerName": "Hina" },  // user name/id -> actor; others go to their usual player (cpu: true) or CPU (cpu: false)
    cpu: true, intro: "none", practice: true, quick: false, timeLimit: false, startStage: 1,
  });
  ```
  `openPlaytest()` opens the launcher.

## What it doesn't touch
No switches or variables, no Hako Coupons / Fabula Points, no chat card, no event hold; it runs on any scene. `payRewards` returns early for any offer marked `playtest`, whatever else the offer says. Everyone connected sees a "Playtest · nothing is saved" tag, and the results read "Playtest". The story path (Start Minigame event row, `minigame.run`) is unchanged.

## Code
- `mg-boot.js`: `playtest()`, `openPlaytest()`, token-controls button; `buildRoster` takes an actor list + seat users; `startOffer()` shared with `run()`; the host no longer waits on itself when the GM runs a seat; `seatFor` prefers the seat a user started in (custom seats survive a reload).
- `pf-game.js`: `env.playtest` = `{ quick, timeLimit, practice, startStage }`. Quick course in every rebuild; time limit from the option; practice off = new flow `race` (straight to the start line); a start stage of 2 or 3 puts the runners on the pillar plaza before it. "Play again" keeps the settings.

## Tests
- `pf-netsim.test.mjs` takes `PT=stage:N,quick,nopractice,gmruns,limit`. PASS: the story run, `stage:1`, `stage:3,nopractice`, `stage:2,quick,gmruns`, `nopractice,limit,gmruns`, and `stage:2,nopractice` with a player drop.
- Staging World (GM + 4 CPUs, worktree code): launcher → quick course from Stage 3 → results → leave. The Plasma Field switch, the party's Fabula Points, the actor/DB modified stamps and the chat count were unchanged; 0 console errors. A bad actor name throws before anything opens.

## Not verified yet
- A real table with several human players (seat picks, a player reloading mid-playtest).
