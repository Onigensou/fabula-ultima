# Session 2026-10-29 — real-player test of the forge mirror (Blumairwen, Trinio, Silryantish)

**Status:** done. Cut off by the host on 10-30 at 11:20. Rinri's turn came that evening:
[2026-10-30 record](2026-10-30-rinri-mirror-test.md).
**Window:** 2026-10-29 21:39 → 2026-10-30 11:35 (+07:00) · Foundry 12.343 · module 1.0.482 (this test's local build;
the session-end prompt reached origin as 1.0.483, because sarunphat's Ally watch took 1.0.482 there)
**Who** (one at a time, whenever each could come):
- Blumairwen 21:57–22:07 (route 27.145, as on 10-24 and 10-28).
- Trinio 22:08–22:11 (route 223.205). The logger's first data for Trinio.
- Silryantish 02:04–02:07 (route 27.130). The logger's first data for Silryantish.
- Rinri couldn't come (a blackout at home, then the night ran out).

**The value of this test:** the first real-player check of the forge mirror, which had only been tested in the
sandbox. Compared with 10-28's Forge numbers on the same maps.

**Conditions:**
- **Mirror:** on (`forgeMirror`). 3,120 files, 1,198 MB. The sync before launch had nothing to change (2 s).
- **Loading:** load indicator on (`loadIndicator`); scene pre-fetch on (`scenePrefetch`).
- **Network:** Foundry options as on 10-28 (`compressSocket` / `compressStatic` true). Port forward
  30000 → 192.168.1.100.
- **Launch:** like the Fixed shortcut (`--disable-features=CalculateNativeWinOcclusion --world`), plus
  `--mute-audio` and a debug port (9225). GM auto-joined at 21:39; world vend 4.3 s.
- **Not running:** the session launcher and the stream.
- **Test bridge:** active on the GM client (`state.json` every 30 s, localhost only).
- **New since 10-28:** the session-end prompt (v1.0.483, below).
- **Preflight (21:47):** 2 FAIL, the same two as on 10-28 and both off the test maps (Ruhig_Village011 is missing
  Keren's token, Dragonslayer Overworld the party token). 373 WARN.
- **Before players joined,** at the host's request: deleted a stray "Gigas A" token (unlinked, not in the blessed
  snapshot) from Training Ground.

**Method:**
- A CDP driver on the GM page (a scratch script, not in git) waited for each player, then ran their round as soon as
  they finished entering: Eisendrache Kingdom → Vastwind_Field002 → Eisendrache Highroad → Eisendrache Burning →
  Dragonslayer Title, 30 s on each.
- Every field map was a first-time load for every player, through the mirror. Kingdom and Vastwind_Field002 are the
  two maps that stalled on 10-28.
- A map's time runs from its activation to the GM receiving the player's finished draw. In Foundry v12 that arrives
  as a `userActivity` socket message with `sceneId`, not as a User update.
- After the round, the session-end prompt sent the player off.

**Session-end prompt (new, v1.0.483, `scripts/session-end/session-end.js`):**
- The GM sends a parchment prompt with a bell.
- The player presses **Leave now**. Otherwise a 3-minute countdown, with a second bell at 1 minute left, logs them
  out.
- Dry run on the Spectator user first (21:46–21:47): both the countdown and the button logged out.

**Host-side capture (raw data, not in git: full IPs):**
- `Logs/ping-watch-2026-10-29_2152.log`: host → player round trips every 2 s, with controls 192.168.1.1 (router)
  and 1.1.1.1 (public).
- `Logs/debug.2026-10-29.log` and `debug.2026-10-30.log`: the server log.
- `Data/client-health-logs/fabula-ultima-2_2026-10-29-14-39.json`: the client-health log for this GM session.
- No tcp-watch this time.

## Numbers / what this session established

From `server-timeline.js` and `client-health-summary.js` on 10-29 21:30 → 10-30 11:30, the driver log, and the
ping-watch log. Raw tool output: `sessions.json` → `2026-10-29-mirror-test`.

| | Blumairwen | Trinio | Silryantish |
|---|---|---|---|
| page loads / reloads | 1 / **0** | 1 / **0** | 1 / **0** |
| login → world data | 9 s (vend 4.1 s) | 15 s (vend 4.5 s) | 17 s (vend 3.7 s) |
| world entry (Dragonslayer Title) | **23.9 s** | **31.3 s** | **42.0 s** |
| Eisendrache Kingdom | **4.5 s** (draw 4.2)¹ | **1.2 s** (1.1) | **2.1 s** (1.8) |
| Vastwind_Field002 | **5.0 s** (4.9) | **1.1 s** (1.0) | **3.1 s** (3.0) |
| Eisendrache Highroad | 1.1 s (0.9) | 0.8 s (0.7) | 2.0 s (1.9) |
| Eisendrache Burning | 0.7 s (0.6) | 1.0 s (0.9) | 2.1 s (2.0) |
| back to the Title | 0.2 s | 0.2 s | 0.2 s |
| files from the mirror / not mirrored / fell back to Forge | 285 / 0 / 0 | 279 / 0 / 0 | 277 / 0 / 0 |
| draw stalls / disconnects | 0 / 0 | 0 / 0 | 0 / 0 |
| tab hidden | in the background from 21:58 through her round | never | never |
| machine | Chrome 156, 12 cores, RTX 5060 | Firefox 159, 16 cores, GTX 980 | Edge 156, 16 cores, RTX 4060 Ti |
| round trip (ping-watch) | no ping replies (router drops them) | median 13 ms, max 26 ms, 0 lost | no ping replies (router drops them) |
| sent off → pressed Leave now | 22:05:17 → 22:07:39 (142 s) | 22:11:06 → 22:11:16 (10 s) | 02:07:09 → 02:07:14 (5 s) |

Map times: activation → the GM receives the finished draw. (draw) = the player's own canvas draw.
¹ Taken from her client's draw record: the driver's draw detection was fixed during this switch.

**The same maps on 10-28, from Forge:**

| | 10-28 (Forge) | 10-29 (mirror) |
|---|---|---|
| Blumairwen world entry | 317 s | **23.9 s** |
| Blumairwen Eisendrache Kingdom | 345.7 s | **4.5 s** |
| Blumairwen Vastwind_Field002 | 520.5 s | **5.0 s** |
| Rinri (entry / Kingdom / Vastwind_Field002) | 80 / 223.5 / 520.5 s | 34.4 / 0.8 / 5.5 s (on 10-30, [record](2026-10-30-rinri-mirror-test.md)) |

**Server:** 15 activations, 0 errors, 9 warnings:
- 2 `gm-screen` deprecation notices at launch;
- 7 × "2 embedded effects records in ActiveEffect hN5IkJdmMjvuGmey were undefined", one per world vend. It's in every
  server log back to 10-08, the oldest kept, so it isn't from tonight.

**Host uplink:** the router and 1.1.1.1 never went above 27 ms, with 0 lost, over 13.5 hours.

**What this session established:**

1. **The mirror works with real players.** Every file all three clients asked for came from the host: 277–285 each,
   with 0 not mirrored and 0 fallbacks to Forge.
2. **Map switches went from minutes to seconds.** The two maps that stalled 3.7–8.7 min on 10-28 took 1.1–5.0 s on a
   first load. Blumairwen, the slowest on 10-28, went from 345.7 s to 4.5 s and from 520.5 s to 5.0 s.
3. **World entry went from minutes to under a minute.** Blumairwen went from 317 s to 23.9 s. What's left is the page,
   its scripts and the world data: each entry's slowest texture took 0–2 s.
4. **The players now differ by seconds, not minutes:** about 1 s per map for Trinio, about 2 s for Silryantish, and
   0.6–4.9 s for Blumairwen on her shared Wi-Fi with the tab in the background.
5. **No reloads, stalls or disconnects.** But each player was on for only 3–10 minutes, so this says nothing yet about
   mid-session reloads, the case's symptom. That needs a full session.
6. **The session-end prompt worked for all three.** Everyone pressed Leave now, after 142 s, 10 s and 5 s. The forced
   logout was never needed.

**Capacity with everyone online (not measured tonight):**
- Players loaded one at a time, so no sharing of the host's upload was measured.
- **Per-map download,** measured on the GM page (every media file the scene references, sized on the host):
  - Kingdom 3.28 MB, Vastwind_Field002 3.21 MB, Title 2.92 MB;
  - Highroad 2.51 MB (2.23 MB new after the earlier maps), Burning 3.00 MB (2.31 MB new).
  - The first map after entry also pulls one-time extras: 112–138 mirror requests on Kingdom, against 3 scene files.
- **Host upload 6.1 MB/s** (measured 10-28): four players × ~3 MB ≈ 12 MB ≈ 2 s for everyone. The largest
  backgrounds (~5 MB) would take ≈ 4 s.
- **Repeat visits cost no upload.** The host sends `Cache-Control: no-cache` with an ETag on mirror, module, system
  and core files, so browsers keep each file and revalidate it (304, no body).
- **Not measured:** everyone entering the world at once, and a stream sharing the upload.

**Side findings:**
- **`client-health-summary` raised a false SAMPLE GAP** ("no timers for 240 s" for Blumairwen at 22:02:41).
  - Her raw samples ran every 60–90 s, normal for a hidden tab.
  - The tool compared her 22:02:41 sample with 22:06:41 across four map draws, and each draw restarts the logger's
    once-a-minute samples.
  - Fix proposed (compare only samples taken after the same draw); not changed yet.
- **Non-player connections to port 30000** (ping-watch). None logged in: the server log has only the expected logins.
  - Two from Google Cloud: one just before Blumairwen joined, one in the same second as Silryantish. That fits
    Discord's link preview fetching the posted join link.
  - Two at 23:00 and 23:07 with nobody online: most likely internet scanners.
- **Demo cleanup after the test** (Foundry still open, then checked offline):
  - Each joining player took the movement controller in turn (Blumairwen → Trinio → Silryantish). The party token's
    prototype art followed each controller's character (Keren → … → Blanche). Restored both to the pre-test values
    (Blumairwen / Keren, with HEAD's timestamps).
  - **Activating the Title rebuilds the Field actor's wellspring effects.** It's the same five wellsprings as HEAD,
    with new ids and order. Left as is; `world-export report` shows it as 1 modified doc.
  - The five test maps match HEAD, and no fog was saved.
  - An offline sweep of every store found nothing else written by the test: no journal pages, messages, users or
    combats.
  - Preflight afterwards matches the 21:47 run line for line.

**Player comments (relayed by the host):** Blumairwen was astonished by the load speed. Silryantish said it felt like
a benchmark, like being a game tester.

**Open:**
- **Rinri:** done on 10-30 ([record](2026-10-30-rinri-mirror-test.md)).
- **A full session with everyone:** are the mid-session reloads gone, and what are the numbers with everyone loading at
  once? The logger is always on, so the first full session measures it.
- **The players' ~21:00 measurements** (speed test + Incognito image test) were meant to probe the True ↔ Forge path.
  With the mirror, players no longer fetch from Forge. Host's call whether they're still needed.
- **The `client-health-summary` sample-gap fix** (above).
- **forge-mirror's GM world scanner** cuts URLs that contain raw spaces short (its pattern stops at the space). The
  runtime miss report heals it. A small fix, not urgent.
- **Scene pre-fetch** (`scenePrefetch`) is still on. CASE.md planned to fix or retire it after the test; with the
  mirror its job is smaller.
