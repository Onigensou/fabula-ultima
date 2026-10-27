# Case: player-reloads — Rinri's and Blumairwen's pages reload mid-session

**Status:** open, investigating. **Next:** a dedicated test with Rinri and Blumairwen, 2026-10-28 evening.
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
| Tab discard, then the player refocuses the tab | The discard kills the socket first and the reload comes later. Never seen. The logger also reads `document.wasDiscarded` directly |
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
- **Since 2026-10-25:** the cover lifts once a draw fails, or at a 90 s cap (`ee07bc2f`). Failed scene
  backgrounds retry in place (`bd4a273f`). A healthy *slow* draw still shows black with no progress.
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

### H3 — A browser feature reloads a live page *(Blumairwen's ~5½ min mode)*

- **For:**
  - 6 of her 12 reloads came 325–367 s after a draw: a 42 s spread over four hours. That's too
    regular for patience.
  - 5 minutes is a common threshold in browser power-saving features.
- **Against:** in Chrome's tab discard, the page dies first. The TCP watch says the page was alive
  until the new navigation.
- **Research (2026-10-28):** pending, filled in from sources below.
- **Confirm:**
  - The logger's `hidden` events just before these reloads.
  - `wasDiscarded`, or verdict `PAGE DIED`.
  - The player's browser and its power settings.
  - An alt-tab-away test (protocol step 6).

### H4 — Weak client hardware

- **For:** "weaker PCs" was the 2026-10-24 suspicion.
- **Confirm:**
  - The logger's `machine.gpu` shows software WebGL (SwiftShader / Basic Render Driver).
  - Low `deviceMemory`.
  - Long draw times, or heap and texture growth after a draw.

## What the logger can and can't see

`scripts/client-health.js` (co-dev, `d874e0a7`) is live on the host since 2026-10-26 (`21c0b61a`, v1.0.467).

**Verified 2026-10-27** with a local Edge 156 test client (logged in as Trinio):
- Boots, heartbeats, hide/show events and disconnects reached the GM across reloads.
- `performance.memory` moves minute to minute in Edge 156 and Electron 29.

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

**Proposed upgrades** (none built; they need a go-ahead, and the code is the co-dev's):
- **P1 reload attribution:** log F5 / Ctrl+R keys, the Esc-menu Reload click, `foundry.utils.debouncedReload`
  calls (with stack), and `beforeunload` (with visibility and time since last input), all into the heartbeat.
- **P2 boot phases:** mark `init` → `setup` → first draw → `ready`, so the next boot reports a page that
  never got there, and how far it got.
- **P3 network probes:** host and Forge round-trip time every 30 s, every 5 s during a draw, plus timeouts.
- **P4 per-draw slow resources:** the slowest assets (host, size, ms) for each draw. On a stall, the scene
  assets that haven't arrived yet.
- **P5 console tail:** drop deprecations, dedupe, keep errors in their own ring.
- **UX (separate decision):** show load progress on the black cover, and toasts above it. This helps
  players now, but it changes the behaviour being measured.

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
6. Replay the 10-24 sequence: Valley_Map002 → Dragonslayer Overworld → Midgard_Map001 → 002 → 003 → 006 → 007.
   - Stay **≥7 min** on three of them: Blumairwen's ~5½ min mode needs a scene to stay up that long.
   - On one scene, ask them to alt-tab away for 7 min (tests H3).
7. Keep an eye on `FUCompanion.api.clientHealth.summary()`.

**After:**
8. Players:
   - Screenshot `chrome://discards` or `edge://discards` (the Foundry tab's Discard count).
   - Screenshot `chrome://crashes`.
9. Host:
   - Run both tools on the window.
   - Write `sessions/2026-10-28-test.md`.
   - Append to `sessions.json`.
   - Update the hypotheses above and add a Notes line.

**Keep comparable with 10-24:** no cache proxy for this test (`reports/2026-10-25-host-cache-proxy-setup.md`
stays open), unless the host decides otherwise. Record it in `conditions` either way.

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
