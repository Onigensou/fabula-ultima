# Multiplayer scene mode + Plasma Field Dash (v1.0.623)

A new scene mode, **Multiplayer**, and its first minigame: **Plasma Field Dash**, the Hako rescue on the Valley of the Dragon. The user approved it after a playable mockup (v4.19); this is that mockup ported into the module, with networking.

Nothing here needs a world import. The world content arrives as a **one-time seed migration** on the GM's next boot (`data-migrations/2026-11-17-plasma-field-world.js`). It only creates what is missing, so a hand-edited scene or token is never overwritten.

## What happens in game

1. Waterfall Trail (`Valley_Map007`): the blank tile `A8FxNTihukxgXCkZ` is now a **Story tile**. It leads to **Plasma Field** (`Valley_Map028`, new, Multiplayer mode).
2. On arrival, Hako, caught in a root cradle, calls for help. The event's **Start Minigame** row then opens the game on every connected client.
3. Each player runs their own party character; absent members are CPUs. Practice is in a yard, and walking up onto the starting line means Ready. Then come three stages, the finale and the results.
4. **First clear only:** Hako Coupons 10/8/5/2 by place go into the shared pool. Fabula Points 4/3/2/1 go to the runners; a runner at the cap of 10 passes the excess to the next place. A chat card lists who got what.
5. Hako hops down, thanks the party and asks to stay somewhere safe (switch `HakoAtValleyCamp`). The party goes back to Waterfall Trail.
6. From then on, Hako stands in **both Valley camps** (surface `Valley_Map004`, underground `Valley_Map024`). She has **Shop** (her actor is a shop) and **Talk**: "Don't mind me, I like watching people sleep".
7. Replays (switch `PlasmaFieldCleared` on) skip the opening and pay nothing; there is a 3-minute limit per stage.

## Code

- `scripts/minigame-system/mg-boot.js`: the session, the socket transport, the overlay, the roster and the rewards. The API is `FUCompanion.api.minigame.run({ game, intro, firstClear, replay })` (primary GM only).
- `scripts/minigame-system/plasma-field/pf-game.js`: the game itself. It was generated from the mockup; the generator and the mockup source are kept outside the repo, and the file says where.
- `scripts/event-system/event-rows-minigame.js`: the **Start Minigame** row (category Flow). Its fields are the game, the opening (full or none), and the rewards switch.
- `scripts/minigame-system/plasma-field/pf-netsim.test.mjs`: a headless network test. Run `node scripts/minigame-system/plasma-field/pf-netsim.test.mjs [humans] [latency] [jitter] [drop]`.

### How the networking works (relevant if you touch it)

- **Who decides what.** The primary GM's client is the host: it spawns every hazard, shot and monster, runs the CPUs, and decides places and the round flow. Each player's client owns its own runner, so movement and the hits it takes are judged there and a dash timed on your screen counts on your screen.
- **Messages.** Runners broadcast about 20 snapshots a second, or 2 a second when standing still. Remote runners are drawn about 110 ms behind, interpolated. Everything rides one message type, `fu.mg`, on the module channel, scoped by a session id.
- **No database writes during a race.** The only writes are the payout, once, after the results.
- **The overlay.** It is a full-screen 2D canvas, and the Foundry board's ticker is paused while it is up. Measured on 3 clients at full HD: 60 fps, game work p95 at most 6.7 ms, 0 errors.
- **Drops and rejoins.** A player who goes completely silent for 4.5 s is taken over by a CPU. The clock ping keeps running in background tabs, so alt-tabbing doesn't count as silent. A reloading player watches, then gets the runner back at the next round break (straight away during practice).

## Shared files touched (please read)

- **`event-system/event-executeCore.js` (`gmExecuteEventTile`)**: an NPC **Talk** in a **camp** was always refused as `noPartyToken`. A camp walks each member on their own token and has no party token, and the GM looked only for that. When no party token resolves, the GM now uses the requesting player's own character token on the scene it is viewing. No camp had a Talk NPC before, so nothing else changes.
- **`custom-ui/dungeon-configuration-ui.js`**: the scene-mode list gains `minigame` (label "Multiplayer (Minigame)") in the options and in both allowed-mode lists.
- **Walker and camera gates** (`movementControl-bootstrap/cameraRuntime/controllerBadge/passDialog`, `camera-follow-actor`, `camera-authority` `NO_PARTY_FOCUS_MODES`): a `minigame` scene doesn't follow or walk the party token, the same as `stealth`.
- **`module.json`**: two new entries, `event-rows-minigame.js` and `minigame-system/mg-boot.js`. This needs a **server restart**, not just a reload.

## Owed / known limits

- No real-table session yet. The tests ran in a sandbox copy of the world on one machine, with 3 clients plus a headless sim of 2 to 4 players at 60 to 320 ms latency.
- If the **GM** reloads mid-game, the game can't resume. Players get "Lost contact with the GM", and the overlay closes after 30 s. Running the event again restarts the game.
- Stages 2 and 3 reuse the Stage 1 ground art (the ChatGPT ground strip). Separate strips per stage were optional and weren't made.
- **Balance note:** strikes aim at a random runner still out, so once others finish, the last runner took every strike meant for four. One test straggler needed 6 minutes. Spawn pacing now stretches with fewer runners out (up to 2.5×), keeping per-runner pressure the same.

## Tuning pass (v1.0.624)

- **Catch-up rules** (`CATCHUP` table at the top of the catch-up section in `pf-game.js`, so all the numbers are in one place):
  - Ground strikes: after a strike is aimed at a runner, they rest for 3 spawn intervals, with at most 2 strikes on the way at once. New strikes go to whoever has the fewest.
  - Once half the pack is home, "mercy" starts: Kirin and Skizzik attack half as often, the Gigas chases at 1.3× walk speed and rests longer after a slam, and Earthen Wire stops redirecting lightning.
  - Second wind: the runner in last place refills stamina 1.35× faster and starts refilling sooner.
  - Headless sim, with one runner held back 40 s in each stage: its running time is 0.92–1.04× the pack's (worst 1.31×, was 1.57×), and it takes no more hits per minute than the pack. With nobody held back, the pack's numbers are unchanged.
- **The scene looks like the game.** Migration `2026-11-17-plasma-field-scene-v2` makes `course.webp` the scene background. It's a still of the course drawn by the game itself (`renderStill`), at grid 128 so tokens match the runners' size, with rain.
  - One opening: the arrival event pans up the course, then the game opens straight to practice.
  - After the race, the party and Hako stand beside the cradle where the finale left them.
  - The game layer fades to and from black, with a 0.9 s black curtain while the event moves everyone underneath.
  - The migration only applies while the scene still has the first layout's background.
- **Hako's in-game sprite** is 96 units instead of 128, so she stands about as tall as a runner (user's call).
