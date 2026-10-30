# Session 2026-10-30 — Rinri's turn on the forge-mirror test

**Status:** done. Rinri was the last of the four players ([the other three](2026-10-29-mirror-test.md)).
**Window:** 2026-10-30 20:30 → 20:45 (+07:00) · Foundry 12.343 · module 1.0.484 plus 4 local commits (89f8827a on
`feat/event-step-in-trigger`, not pushed at the time). The other three ran 1.0.482.
**Who:** Rinri, 20:36–20:39, route 124.122. On 10-24 and 10-28 he came from 171.100, so his address or connection has
changed. Not checked further: with the mirror, his route to Forge no longer matters.

**The value of this test:** Rinri is one of the two players whose pages reloaded on 10-24, and on 10-28 his fast cable
line stalled as long as anyone's. This is his first run with every file coming from the host.

**Conditions:**
- **Mirror:** on (`forgeMirror`). 3,120 files, 1,198 MB.
  - The sync before launch changed nothing (2 s).
  - After the GM logged in, `forgeMirror.exportNow()` and a second sync copied 8 more files (Keren's new `?v=2`
    sprites, 0.4 MB). See the launcher gap under Side findings.
- **Loading:** load indicator on (`loadIndicator`); scene pre-fetch on (`scenePrefetch`).
- **Network:** Foundry options as on 10-28 and 10-29 (`compressSocket` / `compressStatic` true). Port forward
  30000 → 192.168.1.100. Foundry reported the internet link reachable.
- **Launch:** as on 10-29 (`--disable-features=CalculateNativeWinOcclusion --world --mute-audio`, debug port 9225). GM
  auto-joined at 20:31.
- **Not running:** the session launcher and the stream.
- **Preflight (20:29):** 2 FAIL, the same two as on 10-28 and 10-29, both off the test maps. 374 WARN: one more than
  after the 10-29 test, for the new depth settings on Valley_Map003.

**Method:** the same driver and maps as 10-29: Eisendrache Kingdom → Vastwind_Field002 → Eisendrache Highroad →
Eisendrache Burning → Dragonslayer Title, 30 s on each, then the session-end prompt. A map's time runs from its
activation to the GM receiving the player's finished draw.

**One difference from 10-29:** with nobody else to wait for, the driver switched to the first map 2 s after Rinri
entered. The others got their first map 17 s to 3.7 min after entering. That moves work between maps; see below.

**Host-side capture (raw data, not in git: full IPs):**
- `Logs/ping-watch-2026-10-30_2033.log`: round trips every 2 s, with controls 192.168.1.1 (router) and 1.1.1.1.
- `Logs/debug.2026-10-30.log`: the server log.
- `Data/client-health-logs/fabula-ultima-2_2026-10-30-13-31.json`: the client-health log for this GM session.
- No tcp-watch.

## Numbers / what this session established

From `server-timeline.js` and `client-health-summary.js` on 10-30 20:30 → 20:46, the driver log, and the ping-watch
log. Raw tool output: `sessions.json` → `2026-10-30-rinri-mirror-test`.

**Rinri, Forge on 10-28 against the mirror tonight:**

| | 10-28 (Forge) | 10-30 (mirror) | his client's draw |
|---|---|---|---|
| world entry (Dragonslayer Title) | 79.6 s | **34.4 s** | |
| Eisendrache Kingdom | 223.5 s | **0.8 s** | 0.28 s |
| Vastwind_Field002 | 520.5 s | **5.5 s** | 5.37 s |
| Eisendrache Highroad | not recorded | 2.5 s | 2.33 s |
| Eisendrache Burning | 1.4 s (preloaded) | 2.0 s | 1.90 s |
| back to the Title | not recorded | 0.2 s | 0.02 s |

**All four players through the mirror:**

| | Blumairwen | Trinio | Silryantish | Rinri |
|---|---|---|---|---|
| world entry | 23.9 s | 31.3 s | 42.0 s | **34.4 s** |
| Eisendrache Kingdom | 4.5 s | 1.2 s | 2.1 s | **0.8 s** |
| Vastwind_Field002 | 5.0 s | 1.1 s | 3.1 s | **5.5 s** |
| Eisendrache Highroad | 1.1 s | 0.8 s | 2.0 s | **2.5 s** |
| Eisendrache Burning | 0.7 s | 1.0 s | 2.1 s | **2.0 s** |
| back to the Title | 0.2 s | 0.2 s | 0.2 s | **0.2 s** |
| files from the mirror / not mirrored / fell back to Forge | 285 / 0 / 0 | 279 / 0 / 0 | 277 / 0 / 0 | **279 / 0 / 0** |
| page loads / reloads | 1 / 0 | 1 / 0 | 1 / 0 | **1 / 0** |
| draw stalls / disconnects | 0 / 0 | 0 / 0 | 0 / 0 | **0 / 0** |
| sent off → pressed Leave now | 142 s | 10 s | 5 s | **15 s** |

**Rinri's other details:**
- Login → world data: 14 s (vend 4.1 s).
- Machine: Chrome 156, 8 cores, GTX 1660, 1920×1080.
- Tab hidden twice: 20:37:21–20:37:24 and 20:39:00–20:39:28.
- Round trips: no ping replies (his router drops them, as on 10-28).

**Server:** 5 activations, 0 errors, 5 warnings: 2 `gm-screen` deprecation notices at launch and 3 × the "2 embedded
effects records in ActiveEffect hN5IkJdmMjvuGmey" notice, one per vend. Both were already there on 10-29.

**Host uplink:** the router (max 16 ms) and 1.1.1.1 (max 14 ms) with 0 lost, 20:33–20:43.

**What this session established:**

1. **The mirror works for all four players.** Every file Rinri's client asked for came from the host: 279, with 0 not
   mirrored and 0 fallbacks to Forge.
2. **His map switches went from minutes to seconds.** Kingdom 223.5 s → 0.8 s, Vastwind_Field002 520.5 s → 5.5 s.
3. **His world entry more than halved,** 79.6 s → 34.4 s. The slowest file took 1.3 s, so what's left is the page, its
   scripts and the world data, as for the other three.
4. **It held close to the hour he says is worst.** The round ran 20:37–20:39; he reported the worst around 21:00. A
   single evening, so this is one data point.
5. **Still no reloads, but only 3 minutes on.** As on 10-29, this says nothing about mid-session reloads. That needs a
   full session.
6. **The session-end prompt worked on a background tab.** His tab was hidden when the prompt arrived at 20:39:18. He
   came back at 20:39:28 and pressed Leave now at 20:39:32.

**Reading Kingdom's 0.8 s and Vastwind_Field002's 5.5 s:**
- Most likely the order, not the maps. The other three had 112–138 files load up to their Kingdom draw, because it came
  later after entry: mostly one-time files that any first map pulls. Rinri had 13 there, then 160 up to
  Vastwind_Field002, whose background took 5.3 s among them.
- Kingdom's 0.8 s is a real first load. His browser can't have held that file: the only map art he had loaded from the
  host before tonight was the 10-28 trial's Castle and Colosseum backgrounds and one test image. That trial gave similar
  times (a first-time Colosseum in 1.2 s, draw 0.4 s).
- His 2.0–2.5 s on Highroad and Burning are the fairer picture of a normal first load on his line.

**Side findings:**
- **The session launcher's sync runs too early for new art.** `wanted.json` is written by the GM client 60 s after
  login, but the launcher syncs before Foundry opens.
  - So world art added since the last session stays unmirrored for that whole session and loads from Forge, the slow
    path this mirror exists to avoid.
  - Tonight: the sync before launch copied 0 files; after `exportNow()`, one copied 8. Without that, Keren's new sprites
    would have come from Forge.
  - **Fixed the same evening:** once the GM client is in, the launcher asks it for a fresh list and syncs again, before
    the spectator and any player load. Tried on a real GM client: 5 s in all (`session-mode/mirror-refresh.mjs`).
- **Four token images were never mirrored.** The GM scanner cuts URLs with raw spaces short: `NPCShade_Inn.png`,
  `Villager_005.png`, `Bandit_Back.png`, `Generic_Farmer_Standing_001.png`, all on real scenes. Any map using them would
  have waited on Forge. Added to `wanted.json`'s runtime list and mirrored; the scanner itself isn't fixed yet.
- **Load Game can bring back URLs the mirror dropped.** Slot 1 (saved 10-25) holds Keren's 8 sprites and
  `Valley_Map015.png` without the `?v=2` the world uses now, so after a load they would have missed the mirror. Added to
  the runtime list too; the manifest now serves both forms.
- **A non-player connection to port 30000** at 20:35:35 from Google Cloud (35.227.x.x), held 6 s, a minute before Rinri
  logged in. It fits Discord's link preview, as on 10-29. The server log has only the expected logins.
- **The "Gigas A" token deleted from Training Ground on 10-29 was back in the world.** That delete was never committed.
  Not on the test path. Deleted again and committed this time (ef3032ed).

**Demo cleanup after the test** (Foundry open, then checked offline):
- Rinri's join moved the movement controller to Rinri / Hina, and the party token's prototype art to Hina. Both restored
  to the pre-test values (Blumairwen / Keren, with their original timestamps).
- `data/` was copied before launch and compared after closing, key by key, in every store:
  - **Changed:** the Field actor's five wellspring effects (the same five, new ids and order, as on 10-29) and
    `theripper-premium-hub.lastGitCheck`, that module's own timestamp.
  - **`_stats` only:** Current Game, EXFURSION Party, the five test maps and two core settings.
  - **Identical:** fog, messages, users, combats, journal, items, tables, playlists, folders, macros, cards, and every
    token and tile.
- Preflight afterwards matches the 20:29 run line for line. The active scene is the Title.

**Test tools off before the real session of 10-31** (host's request, same evening):
- **The driver** only ever ran when started by hand, from a scratch folder. It has finished, and nothing in the game or
  the launcher refers to it, so a player signing in gets the normal title screen.
- **The test bridge was armed** on the GM client, and it re-arms itself on every boot. Now off; a real boot confirmed it
  (not running, no heartbeat writes). The launcher now disarms it at every start.
- **Settings from earlier tests:**
  - the 10-28 camp demo had overwritten `campPhase`, `campReturnPoint` and `campSaveChoice`; back to the values from the
    end of the last session (the same values HEAD holds);
  - the 10-27 test battle had left `bdRewardSnapshot`, `bdPreBattleViewport` and `bdBattleSceneViewport` set; back to
    null, and committed in ef3032ed.
- **Staying on, on purpose:** the mirror, the load indicator, scene pre-fetch and the client-health logger. The
  session-end prompt only runs when the GM calls it.

**Player comments:** none relayed yet.

**Open:**
- **A full session with everyone:** are the mid-session reloads gone, and what are the numbers with everyone loading at
  once? The logger is always on, so the first full session measures it.
- From the 10-29 record, still open: the `client-health-summary` sample-gap fix, forge-mirror's GM scanner and URLs with
  raw spaces, whether to keep `scenePrefetch`, and whether the ~21:00 measurements are still wanted.
