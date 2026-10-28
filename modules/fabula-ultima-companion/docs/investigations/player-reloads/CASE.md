# Case: player-reloads — Rinri's and Blumairwen's pages reload mid-session

**Status:** open, investigating. **Next:** a dedicated test with Rinri and Blumairwen, 2026-10-28 evening,
in two halves (protocol step 6).
**Tracking report:** `reports/2026-10-28-player-reload-investigation.md`
**Sessions:** [2026-10-24 game session](sessions/2026-10-24-game-session.md) (the baseline)
**Data:** [sessions.json](sessions.json) · **Tools:** [../_tools/](../_tools/) · **Deep-dive from that night:** [../../player-reload-investigation-2026-10-24.md](../../player-reload-investigation-2026-10-24.md)

## Symptom

Two of four players, Rinri and Blumairwen, get a long black screen or a load bar stuck at 99% after map
changes, and their page reloads. On 2026-10-24 that happened 12 times each in 5½ hours. They say they never
pressed F5. Trinio and Silryantish had 0 reloads.

## Current verdict (2026-10-28)

**The reload happens on a live page.** Something navigates it.

- Nothing in Foundry core, the 58 active modules or the world data silently reloads a single player.
- What remains: either the **player** reloads (toolbar ↻, F5, Esc → Reload Application) because the
  screen looks stuck, or a **browser feature** does it.
- The **network is back in scope**. Not as what kills the socket (that's ruled out), but as what makes
  these two players' draws *look* stuck: they share a route from the host that the others don't.

## Ruled out

| cause | proof |
|---|---|
| Server performance | World-data vends took 3.7–5.0 s for every player all night (server log) |
| Network cut / dropped socket | In all 9 reloads the TCP watch caught, the old game socket stayed open until the new page's first connection opened. It closed ≤1 s later, with no DROP gap |
| Foundry's reconnect→reload path (reload after a ≥5 s disconnect) | That path leaves a seconds-old reconnected socket. The sockets that closed at reload had lived **4–84 min** |
| Renderer crash, then a "Reload" click | The socket would close at the crash, then a gap until the click. Never seen |
| Any automatic browser reload: tab discard, Memory Saver, memory-pressure discard, crashed-tab reload | Each kills the page first and reloads later, and the TCP watch never saw that. Also:<br>• Memory Saver only discards tabs hidden **2–6 h**, and never a window's active tab, even a minimized one<br>• memory-pressure discards spare tabs hidden <10 min<br>• desktop browsers don't auto-reload crashed tabs<br>Sources S2, S4, S5, S15 in Research below. The logger also reads `document.wasDiscarded` directly |
| A broadcast reload | Would reload *every* client, and Trinio and Silryantish never reloaded. Covers: core `"reload"` socket, the "Reload All Clients" macro, world-setting `onChange` reloads in cursor-hider / theatre / gm-screen / LockView / tokenmagic |
| Any code path that silently reloads one client | Checked 2026-10-28:<br>• Foundry 12.343 `foundry.js` has exactly 5 reload sites: reconnect ≥5 s, session-id mismatch, `"reload"` broadcast, Esc-menu Reload, settings prompt<br>• all 58 active modules<br>• 643 world macros (only "Reload All Clients")<br>• 6,852 scene records (none)<br>Monk's Player Settings asks the player first ("Reload the browser?") |
| Heavy maps | The reload-linked maps are 1254² to 2739×2515, with Forge backgrounds and only PNG tokens. Midgard_Map002/003 serve nothing from the host |

## Hypotheses

Each hypothesis lists what would confirm or refute it. Move them between *open / weakened / ruled out*
as sessions come in. Don't delete them.

### H1 — A slow or stuck draw, then the player reloads *(leading)*

- **For:**
  - The transition cover (`screen-transition.js`, z 99999, `pointer-events: all`) hides Foundry's
    load bar (`#loading`, z 1) and its toasts for the **whole** draw. To the player, slow looks
    exactly like hung.
  - Players reported a "long black screen / stuck at 99%".
  - Quick-mode delays (11–97 s after a draw) look like human impatience.
  - Rinri's 4-page reload loop came after Valley_Map002, which has a host-served video tile. Foundry
    holds the bar at 99% until videos reach `canplaythrough` (`scripts/scene-prefetch.js`).
  - "Stuck at 99%" can only be *seen* on a fresh page load, before the cover exists.
- **Against:**
  - The players say they never pressed F5. The toolbar button or the Esc menu may not count as "F5" to them.
  - It doesn't explain Blumairwen's tight 325–367 s cluster on its own.
- **H1b, a black map rather than a black screen:** Foundry 12 retries a failed map image twice, then
  finishes the draw *without* it, leaving tokens on a black map. From the player's chair this looks
  the same.
- **Since 2026-10-25:**
  - The cover lifts once a draw fails, or at a 90 s cap (`ee07bc2f`).
  - Failed scene backgrounds retry in place (`bd4a273f`), with a toast: *"The map image didn't load.
    Retrying automatically — no need to reload."*
  - A healthy *slow* draw still shows black with no progress.
- **Confirm:**
  - Logger verdict `RELOAD DURING DRAW`, or a `boot gap` (a first draw stuck before `ready`).
  - A player saying "I refreshed because it was black".
- **Refute:** reloads with `drawing: false`, long after `canvasReady`, with the player at the keyboard
  and not touching anything.

### H2 — The two players' shared route makes their draws slow *(why it's only them)*

- **For:**
  - The 2026-10-24 deep-dive found both on an inter-ISP route from the host
    (`116.206.112.2 → 171.102.254.x`) that Trinio and Silryantish don't use.
  - They reloaded ≤60 s apart after the same scene change three times. Once, the new page loads were
    2 s apart, 10–12 s after the change.
- **Mixed:** only Blumairwen's link is clearly slow.
  - Her page loads took 9–53 s; Rinri's took 10–11 s.
  - At session start, login → world vend took Trinio 8 s, Rinri 17 s, Silryantish 18 s, Blumairwen 28 s.
- **Against:** maps come from Forge. Only the world data, the ~750 module scripts and the module's
  own assets cross the host route, plus the 12 KB King Gorger token and the Fumes webm.
- **Confirm:**
  - Slow assets in per-draw resource timing, and which host served them.
  - Host round-trip time vs Forge round-trip time during a stall.
  - `pathping` to their IPs during the test.
- **Refute:** stalls while host and Forge both answer fast. Or the same stalls on a better route
  (mobile hotspot test).

### H3 — A 5-minute tab freeze, then a manual reload *(Blumairwen's ~5½ min mode)*

- **For:**
  - 6 of her 12 reloads came 325–367 s after a draw: a 42 s spread over four hours. That's too
    regular for patience alone.
  - Two power features **freeze** a hidden tab after 5 min:
    - Chrome Energy Saver freezes CPU-heavy tabs when it's on, e.g. on battery [S14].
    - Edge Sleeping Tabs at maximum efficiency [S7, S8]. Edge's own pages disagree on the default
      timeout (15 min vs 2 h).
  - A frozen page keeps its socket open. Foundry's server waits 600 s for a ping reply, and that
    matches the TCP evidence.
  - Suppose she tabs away while a map loads, and comes back to a page that's still thawing. "5 min
    + 25–67 s to come back" is exactly 325–367 s, and the reload would be hers.
- **Ruled out inside H3:** an automatic browser reload. See the table above: each of those kills the
  page first.
- **Open:** Opera GX's RAM limiter in hard-limit mode "drops non-active tabs" from memory. Users report
  tabs reloading or going black [S18, S19]. How it works isn't documented.
- **Confirm:**
  - A `visible` event with ≥5 min hidden just before the reload. `client-health-summary` prints
    "tab hidden N s".
  - A SAMPLE GAP > 150 s after a draw, meaning the page ran no timers: frozen.
  - Her answers: laptop on battery? Energy Saver, Efficiency mode or the GX limiter on? Does she
    alt-tab while maps load?
  - Protocol step 6: alt-tab away for 7 min.
- **Refute:** sixMin reloads with the tab visible the whole time and no sample gap.

### H4 — Weak client hardware, or a GPU reset

- **For:** "weaker PCs" was the 2026-10-24 suspicion.
- **GPU reset path:**
  - A driver reset (TDR) or GPU-process crash loses every WebGL context.
  - If a site loses its context twice within 2 min, Chrome blocks WebGL for it. The canvas stays
    dead (a "sad canvas") until a **user** reload; a script's `location.reload()` doesn't clear the
    block [S28, S29].
  - To the player that reads as "it went black, so I reloaded".
- **Dual-GPU laptops:** Windows can run the browser on the integrated GPU. A Forge forum thread traced
  lost scene assets to this. The fix was setting the browser to "High performance" in Windows
  graphics settings [S39].
- **Confirm:**
  - The logger's `machine.gpu` shows software WebGL, or an integrated GPU (Intel UHD etc.).
  - `CONTEXT_LOST_WEBGL` in the console lines before a reload.
  - On the player's PC: Event Viewer → System → **Event ID 4101** (display driver reset) at a reload
    time [S46].
  - `chrome://gpu` log lines such as "The GPU process crashed". Same browser session only [S27, S48].
  - Low `deviceMemory`, long draw times, or heap and texture growth after a draw.

## What the logger can and can't see

`scripts/client-health.js` (co-dev, `d874e0a7`) is live on the host since 2026-10-26 (`21c0b61a`, v1.0.467).

**Verified 2026-10-27** with a local Edge 156 test client (logged in as Trinio):
- Boots, heartbeats, hide/show events and disconnects reached the GM across reloads.
- `performance.memory` moves minute to minute in Edge 156 and Electron 29. It's precise on desktop
  (site-isolated renderers), but it covers the **JS heap only**, not GPU memory; `textures` is the
  GPU proxy [S21, S26].

**Gaps:**
1. **It can't tell who reloaded.** A player's F5 and a script reload both read "clean exit, reload".
2. **A page stuck on its first draw leaves no heartbeat.** Foundry 12 fires `ready` only after the
   first scene draw (`setupGame` awaits `canvas.initializing` → `scene.view()`), and the logger starts
   at `ready`. It shows up only as a `boot gap` on the next boot (`client-health-summary` flags it; seen
   on the 10-27 test client: 248 s), or as a server vend with no boot report.
3. **Deprecation warnings flood the console tail.** `globalThis.getProperty` is 108 of the captured
   lines, so a real error can drop out of the 15-line window. The summary tool drops them.
4. **`prev.hidden` on a clean exit means nothing.** It's the page's own state during unload, not
   whether the player had tabbed away. Use the `hidden` / `visible` events instead.
5. **No network timing.** Draw *duration* is recorded, but not which asset was slow or from which host.
6. **Some "disconnects" are the page's own unload.** A disconnect ≤3 s before a clean pagehide is
   that, not a network event. The summary tool marks these.
7. **A GM "died" verdict on the Foundry desktop app** is the app closing (no pagehide), e.g. 10-26 12:16.
8. **Timer drift is lost at reload.** The pagehide beat resets `driftMs` to 0, so a freeze that ended
   just before a reload leaves no drift in `prev`. The `visible` event's `hiddenMs` and the sample gaps
   still show it.

**Proposed upgrades** (P4 and the UX item are built; the rest need a go-ahead, and the code is the co-dev's):
- **P1 reload attribution:** log F5 / Ctrl+R keys, the Esc-menu Reload click, `foundry.utils.debouncedReload`
  calls (with stack), and `beforeunload` (with visibility and time since last input), all into the heartbeat.
  Keep the worst timer drift through the pagehide beat.
- **P2 boot phases:** mark `init` → `setup` → first draw → `ready`, so the next boot reports a page that
  never got there, and how far it got.
- **P3 network probes:** host and Forge round-trip time every 30 s, every 5 s during a draw, plus timeouts.
- **P4 per-draw slow resources:** the slowest assets (host, size, ms) for each draw. On a stall, the scene
  assets that haven't arrived yet.
  - **Built 2026-10-28** inside the load indicator, through `clientHealth.record()`:
    - `load-progress`, for every load over 2 s: total ms, `texturesMs` (download vs map build), the
      slowest files and their origin;
    - `load-waiting`, at 30 s and 60 s: the files still pending. These survive a reload.
- **P5 console tail:** drop deprecations, dedupe, keep errors in their own ring.
- **P6 WebGL context events:** log `webglcontextlost` / `webglcontextrestored` on the canvas, so a GPU
  reset becomes a logged event instead of a guess.
- **UX (separate decision):** show load progress on the black cover, and toasts above it. This helps
  players now, but it changes the behaviour being measured.
  - **Built 2026-10-28** (v1.0.473): `scripts/screen-transition/load-indicator.js`.

## Next test — protocol

**Before (host):**
1. Launch from the "Foundry VTT (Fixed)" shortcut.
2. Start `_tools/tcp-watch.ps1`. Not run yet: auto mode blocked launching it with `-ExecutionPolicy Bypass`.
3. On the GM console, confirm `FUCompanion.api.clientHealth.summary()` answers.
4. Write down the window start.

**Ask each player before they join** (the answers go in the session record):
- Browser and version.
- Extensions: tab suspenders, auto-refresh, ad blockers.
- Power settings:
  - Chrome: Settings → Performance → Memory Saver / Energy Saver.
  - Edge: Settings → System and performance → Sleeping tabs / Efficiency mode.
- Hardware acceleration: does `chrome://gpu` or `edge://gpu` say "Hardware accelerated"?
- RAM; Wi-Fi or cable.
- Laptop or desktop? On battery while playing? Two GPUs? (Windows Settings → Display → Graphics: is
  the browser set to "High performance"?)
- Opera GX: is the RAM limiter on, with "Hard limit"?
- Free disk space. Foundry's KB says under 4 GB free breaks image loading [S34].
- **Before joining:** turn on crash reporting, so `chrome://crashes` lists crashes. In Chrome:
  Settings → Privacy → "Help improve Chrome's features and performance" [S43].
- Is Foundry the only tab in its window? Do they alt-tab to Discord during play?
- **Last time, how did the page reload?**
  - F5?
  - The ↻ button?
  - Esc → Reload Application?
  - Closed the tab and reopened the link?
  - Or did it reload while they were just watching?

**During:**
5. Tell them: *if it goes black or freezes, don't reload. Say so on voice, note the time, wait 2 minutes.
   If it's still stuck, take a screenshot of F12 → Console, then reload.*
   - Also: *read out any message that pops up*, e.g. "The map image didn't load…" or "You have lost
     connection to the server…".
   - And: *say whether you see a black screen, or tokens on a black map.*
   - **New since v1.0.473:** after 2 s the black screen shows a loading indicator. World entry shows it
     too, from the moment the game's scripts start until the world is ready. Have them read out:
     - the percentage;
     - "1 file left · from Forge / the game host" (no file names on screen; the names are in the
       console and in the client-health log);
     - "Preparing the map";
     - whether the timer is still counting. A stopped timer with a turning spinner means the page has hung.
6. Change maps the way 10-24 did, but **only on maps the players have already seen** (host's rule,
   2026-10-28): Eisendrache, the Vastwind fields, The Wyrmwood.
   - **Not** Valley of the Dragon or Fafnir Castle maps: those are content they haven't reached.
   - No token of a monster that isn't in the bestiary (the Monster Encyclopedia).
   - Prefer the big-background maps. The 10-24 stalls were on the map background, the largest file.
   - Stay **≥7 min** on three of them: Blumairwen's ~5½ min mode needs a scene to stay up that long.
   - On one scene, ask them to alt-tab away for 7 min (tests H3).
   - **Run it in two halves** (agreed 2026-10-28), so one night can show both the cause and the cure:
     - **First half, as-is:** no preloading, and scene pre-fetch on (the default). Include the *video
       maps*. Each has a video tile served from the host, as Valley_Map002 did on 10-24:
       - the Fumes steam webm (699 KB): Eisendrache Kingdom, Eisendrache Burning, Vastwind_Field009,
         Wyrmwood_Map012;
       - the Wind Lines webm (271 KB): Eisendrache Highroad, Vastwind_Field002.
     - **Halftime (GM):** Configure Settings → FabulaUltimaCompanion → turn off **"Pre-fetch scene
       videos"**. It applies from the next map change, with no reloads. **Write down the time:** it's the
       line between the halves in the logs. On video maps each client's console then logs
       `[FUCompanion][ScenePrefetch] off (world setting); skipped N video asset(s)`.
     - **Second half, with mitigations:** before each map change, right-click the next map in the top
       navigation bar → **Preload Scene**. It's GM-only and goes out to every client. Wait about 30 s, or
       until both players say Foundry's thin top bar has gone, then switch. Revisit the same video maps.
       - A map that isn't in the navigation bar can be preloaded from the GM console:
         `game.scenes.preload(game.scenes.getName("Eisendrache Kingdom").id, true)`.
       - While it preloads, players see Foundry's own top bar over the current map; the load indicator
         only covers map changes. The bar reads "Loading <the map's navigation name>" if they have at
         least Limited permission on that map, otherwise "Loading ...". Fine for tonight's safe maps.
     - **Compare the halves:** reloads, `load-progress` times, `load-waiting` lines and what the players
       read out. Problems in the first half that stop in the second give the cause and the cure in one
       night. Both mitigations change together, so if the second half is clean, a later test separates
       them: preload alone, pre-fetch off alone.
7. Keep an eye on `FUCompanion.api.clientHealth.summary()`.

**After:**
8. Players:
   - Screenshot `chrome://discards` or `edge://discards` (the Foundry tab's Discard count).
   - Screenshot `chrome://crashes`.
   - Screenshot the `chrome://gpu` / `edge://gpu` log section, *before* closing the browser.
   - Windows Event Viewer → Windows Logs → System → filter **Event ID 4101** (display driver resets)
     for the session window [S46].
9. Host:
   - Run both tools on the window.
   - Write `sessions/2026-10-28-test.md`.
   - Append to `sessions.json`.
   - Update the hypotheses above and add a Notes line.

**Keep comparable with 10-24:** no cache proxy for this test (`reports/2026-10-25-host-cache-proxy-setup.md`
stays open), unless the host decides otherwise. Record it in `conditions` either way.

**The load indicator IS live for this test** (v1.0.473): record `loadIndicator: true` in `conditions`.
- If it misbehaves, the GM turns it off under Configure Settings → "Loading indicator on the black
  screen". It takes effect at once, with no reloads.
- Its records come out of `client-health-summary` as the "slow load" table and the "still loading" lines.

**Scene pre-fetch has a switch for the halves** (v1.0.475): world setting `scenePrefetch`, default on, under
Configure Settings → "Pre-fetch scene videos". Record both halves in `conditions`, with the halftime, e.g.
`scenePrefetch: "on; off from 21:40"` and `preloadScene: "second half, from 21:40"`.

## Research (2026-10-28)

Web research by a Claude subagent. Each claim came tagged as stated by a source or inferred; only
sourced claims are used above.

| ref | source | used for |
|---|---|---|
| S2 | [chromium: memory_saver_mode_policy.cc](https://github.com/chromium/chromium/blob/main/chrome/browser/performance_manager/policies/memory_saver_mode_policy.cc) | Memory Saver discards only tabs hidden 6 h / 4 h / 2 h (Moderate / Balanced / Maximum) |
| S4 | [chromium: discard_eligibility_policy.cc](https://github.com/chromium/chromium/blob/main/chrome/browser/performance_manager/policies/discard_eligibility_policy.cc) | Never discarded: visible tabs, a window's active tab ("even if the window is not visible"), tabs audible in the last minute, pinned tabs, tabs with DevTools open |
| S5 | [chromium: urgent_page_discarding_policy.cc](https://github.com/chromium/chromium/blob/main/chrome/browser/performance_manager/policies/urgent_page_discarding_policy.cc) | Memory-pressure discards spare tabs hidden <10 min |
| S7, S8 | [Edge performance features](https://support.microsoft.com/en-us/topic/learn-about-performance-features-in-microsoft-edge-7b36f363-2119-448a-8de6-375cfd88ab25) · [SleepingTabsTimeout policy](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-browser-policies/sleepingtabstimeout) | Sleeping Tabs *freeze* the page and don't reload it; 5 min at maximum efficiency |
| S12 | [Page Lifecycle API](https://developer.chrome.com/docs/web-platform/page-lifecycle-api) | `document.wasDiscarded`; no handlers run at discard |
| S14 | [Freezing on Energy Saver](https://developer.chrome.com/blog/freezing-on-energy-saver) | Chrome freezes CPU-heavy tabs hidden >5 min while Energy Saver is on; never reloads them |
| S15 | [chromium: content/common/features.cc](https://github.com/chromium/chromium/blob/main/content/common/features.cc) | The crashed-frame reload exists only for hidden tabs, and is on by default only on Android |
| S18, S19 | [Opera GX Control](https://www.opera.com/gx/features/gx-control) · [Opera forum](https://forums.opera.com/post/208170) | The GX hard limit drops non-active tabs; users report reloading or black tabs |
| S21, S26 | [chromium: memory_info.cc](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/core/timing/memory_info.cc) · [web.dev](https://web.dev/articles/monitor-total-page-memory-usage) | `performance.memory` is precise for site-locked renderers (all of desktop); JS heap only |
| S27, S28, S29 | [chromium: gpu_process_host.cc](https://github.com/chromium/chromium/blob/main/content/browser/gpu/gpu_process_host.cc) · [gpu_data_manager_impl_private.cc](https://github.com/chromium/chromium/blob/main/content/browser/gpu/gpu_data_manager_impl_private.cc) · [webgl_rendering_context_base.cc](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/modules/webgl/webgl_rendering_context_base.cc) | GPU resets lose all contexts; a second loss within 2 min blocks WebGL for the site until a user reload |
| S34 | [Foundry KB: scene loading](https://foundryvtt.com/article/ts-scene-loading) | Black screens come mostly from modules or huge images; hardware acceleration is required; <4 GB free disk breaks image loading |
| S38, S39 | [Forge: maps won't load](https://forums.forge-vtt.com/t/maps-wont-load/18124) · [Forge: lost scene assets](https://forums.forge-vtt.com/t/screen-flickers-then-i-lose-all-scene-assets-maps-tokens-etc/14999) | Black maps fixed by turning off Memory Saver (huge maps); integrated-GPU browsers fixed via "High performance" |
| S43 | [chromium: crash_strings.grdp](https://chromium.googlesource.com/chromium/src/+/HEAD/components/crash_strings.grdp) | `chrome://crashes` doesn't list crashes from while crash reporting was off |
| S46 | [Event ID 4101](https://learn.microsoft.com/en-us/archive/technet-wiki/1462.event-id-4101-display-driver-timeout-detection-and-recovery) | Display driver resets are logged in Windows' System log |

No 2023–26 Foundry community report matches "player tabs reload on scene change". The closest,
[foundryvtt#11069](https://github.com/foundryvtt/foundryvtt/issues/11069), is a v12 client using 25+ GB
of RAM; it was closed as not planned.

## Notes (append-only)

- **2026-10-24:** incident. Server-log and TCP-watch analysis that night; deep-dive doc written.
- **2026-10-25 (co-dev):**
  - Cover watchdog `ee07bc2f`, background retry `bd4a273f`, logger and cache proxy `d874e0a7`,
    world payload trim `18c54c16`.
  - Proxy setup filed to the host (`reports/2026-10-25-host-cache-proxy-setup.md`).
- **2026-10-26:** logger live on the host (merge `21c0b61a`, v1.0.467).
- **2026-10-28:** case opened. Re-derived the baseline with `_tools/`.
  - **New since the deep-dive:** the page-alive proof covers the reconnect path too (socket ages); the
    paired reloads; Blumairwen's 325–367 s cluster measured from her last *draw*; the cover hiding the
    load bar; the logger gaps.
  - **Corrections:**
    - Midgard_Map001 did precede a reload.
    - "Nothing from the host" on Midgard_Map007 was wrong: its King Gorger token PNG is host-served.
  - **No real-player data in the logger yet.** Rinri's and Blumairwen's logins since 10-25 were host
    test clients (`::1`).
- **2026-10-28 (later):** web research folded in (see the table above).
  - H3 is now "a 5-minute freeze, then a manual reload".
  - Memory Saver, memory-pressure discards and crashed-tab auto-reload moved to Ruled out.
  - H4 gained the GPU-reset path.
  - `client-health-summary` now flags sample gaps (>150 s) and long hides.
  - Showing load progress on the black cover (option 5) is being written up as a proposal for the
    host to review.
- **2026-10-28 (host decision):** option 5 is approved in principle, to be **built after** the
  2026-10-28 test, so that test stays comparable.
  - It must feel like a PS1/PS2 console JRPG, built on the house Loading Screen convention:
    black, with the breathing title logo and Momonga bottom-right.
  - Interactive mockup, not an implementation: https://claude.ai/artifact/FoNRX5xfK5UBMGQJgzk3TN
  - **Build note:** `UI/DRG_LoadingIcon.webm` is 4.2 MB, too heavy to show reliably during a slow
    load. Ship a small preloaded version, or the static logo with a CSS breathing fade.
- **2026-10-28 (later, host changed the plan):** build it **before** the test, with guardrails.
  - **Built:** `load-indicator.js`, v1.0.473. It is the Corner layout in Signika, with:
    - CRT scanlines and dither on the black only;
    - tips (three stand-ins);
    - the stuck file named;
    - load records sent to client-health;
    - toasts lifted above the black.
  - **Mascots:** a random one per load from Momonga, Slime, Sylph, Prickle Boar and Shroomy, each
    with its own idle and poke reaction.
  - **Logo:** the new `UI/DRG_LoadingLogo.webp` (31 KB, white Title_UI) on Forge and in the host's art folder.
  - **Live-tested** in a sandbox Foundry: a copy of the world through `--dataPath`, port 30001, a
    throttled network, PIXI workers off so the throttle applies.
    - All stages were seen.
    - The GM switch worked mid-load.
    - The records reached the GM's log file.
    - One load took 106 s, all of it downloading (`texturesMs` 106.4 s) — the H2 signature.
  - **Commits:** `8ae307cf` + `da05f789`, made on `feat/zp-dishes` (another session's branch, which
    was checked out at the time). `main` was moved onto that branch before the push.
- **2026-10-28 (night, host's call): it became the game's full loading screen.**
  - **World entry:** a black cover from `init` with the indicator at once, faded out at `ready`. Before,
    the first draw showed Foundry's bar with the scene's name, and about 30 s of setup showed nothing.
  - **Foundry's `#loading` bar is never drawn while a map loads.** Its label goes to the console.
  - **No names on screen:** "1 file left · from Forge / the game host". Names stay in the console and the log.
  - **Mascots:** Momonga always; the others only once the Monster Encyclopedia has their page. That's
    Prickle Boar today; Slime, Sylph and Shroomy join when met.
  - **Switch off** = Foundry's plain behaviour, world entry included.
  - **Sandbox-tested:**
    - entry ON and OFF;
    - a throttled map change on Eisendrache_Map004;
    - Foundry's bar never set on;
    - entry records reach the log, including a "load-waiting" mark during the ~30 s setup.
- **2026-10-28 (evening, before the test):** reviewed the older preload scripts.
  - `animation-asset-cache.js` (Apr 2026) is active: the Battle Director's pre-battle preload sits on it.
    The GM waits only 8 s (`combatPrepareTimeoutMs`) for each client's "preload done", so on a slow route
    a battle can start while that client is still downloading up to 250 files. The likely cost is slower
    battle starts, not reloads; the 10-24 battle had no reloads around it.
  - The `[BattleEnd: Transition]` macro (Dec 2025) is superseded by the Battle Director. The
    `[SAMPLE] Preload Image` macros (Oct 2025) are samples.
  - `scene-prefetch.js` (May 2026) targets "stuck at 99%". Fix or retire it after the test, because:
    - its world-entry warm-up waits for `ready`, which comes after the first draw;
    - its map-change fetch races PIXI's own download, so on a slow route it may fetch the same video
      twice at once (not verified).
  - **Plan:** observe first, in two halves (protocol step 6). The pre-fetch got an on/off switch,
    `scenePrefetch` (default on, v1.0.475), so the second half can run without it. Checked in a Node
    harness with stubbed Foundry globals (14 checks), not in a live Foundry.
