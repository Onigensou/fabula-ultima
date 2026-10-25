# Player reload / long black screen — session 2026-10-24

**Status:** open. The server side has been ruled out. The cause is on the client and is still unconfirmed.
**Session window:** 2026-10-24 20:47 → 2026-10-25 02:28 (local), world `fabula-ultima-2`, module 1.0.448.
**Method:** read-only. Server `Logs/debug.*.log` was cross-checked against a live watch of TCP connections on port 30000, polled every 500 ms. Scene and world data were read from LevelDB snapshot copies, never the live DB.

## Symptom

Two players, **Rinri** and **Blumairwen**, sat on a long black screen or a "stuck at 99%" loading bar after map changes. **Trinio** and **Silryantish** loaded normally. All four play over cable.

## What the data shows

### 1. Two players silently reloaded 12 times each

Every `Vended World data to User [...]` line after the first join is a full page reload. Each reload re-sends the whole world.

| Player | World downloads | Reloads | Connection behaviour |
|---|---|---|---|
| Trinio | 1 | 0 | one socket, 20:47 → end |
| Silryantish | 1 | 0 | one socket, 20:47 → end |
| Rinri | 13 | **12** | socket replaced at every reload |
| Blumairwen | 13 | **12** | socket replaced at every reload |

The players say they never pressed F5.

### 2. The server is not the cause

- **Vend time** was 3.7–5.0 s for every player, all night, slow and fast players alike.
- **Compression is already on:** `compressSocket: true` and `compressStatic: true` in `Config/options.json`, passed through to socket.io as `perMessageDeflate`.
- **The server's `pingTimeout` is 600 s** (`dist/server/express.mjs`), so the server never drops a briefly-frozen client.
- **Nothing on our side sends a reload to players.**
  - `_test-bridge.js` reload is GM-only (`bootBridge` returns early for non-GM).
  - Core `socket.on("reload")` would reload *every* client. Trinio and Silryantish never reloaded.
  - `forge-vtt` reloads only on empty world data at boot.
  - The `theripper-premium-hub` reloads are GM troubleshooting actions.
  - No other active module calls `location.reload`.
- **Server errors that night were unrelated:** `Token "<id>" does not exist!` at 22:14 and 22:18, from deleted battle tokens.

### 3. Not a network cut

- When a reload happened, the old game socket **closed cleanly at the same second** the browser began a fresh page load.
- Foundry's own reconnect-reload path (`foundry.js` ~L8858: reconnect after a ≥5 s disconnect → `debouncedReload`) would first show a *new* socket, then the reload. That pattern was never seen.
- The slow pair do share an inter-ISP route from the host (`116.206.112.2 → 171.102.254.x`) that the fast pair don't use. Trinio stays inside the host's ISP at 12 ms. Silryantish exits via `58.64.111.x`. Treat this as a minor factor.

### 4. Timing: reloads follow scene changes

There were 32 scene activations in the session.

- **Rinri:** 9 of 12 reloads came **20–100 s after a scene change**. One socket lasted 75 min with no scene change, then reloaded 55 s after the next one.
- **Blumairwen:** 5 of 12 came within 60 s of a scene change. Another **5 came 325–400 s after a scene change**, a suspiciously fixed delay.
- `Midgard_Map001` (0 lights, 144 walls, 2739×2515) never triggered a reload in 4 loads.
- Light count did **not** correlate: `Midgard_Map004` has 10 lights and was clean.
- Several maps that triggered reloads (Midgard_Map002, 003, 007) serve **nothing** from the host. All their assets are on the Forge CDN. So the host's asset bandwidth isn't the trigger.

### Working hypothesis

Something on the weaker client machines fails when a scene is drawn. Two candidates:

- **Memory growth after the draw**, ending in a renderer crash (Chrome "Aw, Snap! / Out of memory") or a tab discard by Memory Saver / Sleeping Tabs.
- **The player clicking Reload on a crash page** without thinking of it as an F5.

The fixed ~5½–6½ min delay for Blumairwen points to memory growth from a per-frame ticker or similar after `canvasReady`. **This is not confirmed.** It needs client-side evidence.

## Things that make it look worse than it is

- **The black transition overlay hides everything.** `scripts/screen-transition/screen-transition.js` covers the screen on `canvasTearDown` and reveals only on `canvasReady`. It has **no timeout**, and it sits at `z-index: 99999`, the same value as Foundry's `--z-index-notification`. A hung draw or a "lost connection" toast just looks like black.
- **Each reload re-sends ~145 MB** (world payload measured from a 2026-10-24 snapshot): actors 80.6, scenes 34.4, items 14.2. That's ~24 extra full downloads from the host's home upload on this night.
- **Each page load fetches ~500 module script files.** The companion `module.json` lists 493 entries, about 19 MB across 58 active modules. On a lossy route this took ~53 s for one reload.
- **6 JB2A `.webm` tiles are served from the host**, not Forge, across 17 of 150 scenes. Example: `Fumes_02_Steam_White_400x400.webm` is on 12 scenes. Foundry holds the load bar at 99% until videos reach `canplaythrough`, as `scripts/scene-prefetch.js` already documents.

## Next steps

### Client-side evidence

✅ **Automatic since 2026-10-25:** [scripts/client-health.js](../scripts/client-health.js) records this on every client.

- **How the last page ended.** It reads the navigation type, Chrome's `document.wasDiscarded`, and whether `pagehide` ran. A reload with no `pagehide` means the page died: a crash, a killed tab or a discard.
- **The previous page's last heartbeat.** It is written every 30 s and holds:
  - memory, GPU texture count, ticker count, DOM size and timer drift;
  - the scene and the time since it was drawn;
  - the last 15 console warnings and errors.
- **During play:** each scene draw, any draw that stalls, memory samples every minute for 10 min after a draw (then every 5 min), tab hide/show, and socket disconnects with their reason.

Reports queue in localStorage, so they survive the reload, and go to the primary GM. The GM writes them to `Data/client-health-logs/<world>_<session>.json` every 2 min. On the GM console, `FUCompanion.api.clientHealth.summary()` gives a roll-up per player.

The manual checks below are now only a fallback. The browser's discard count (step 3) is the one thing the logger can't see directly; `wasDiscarded` covers the same case.

1. **F12 → Console → ⚙ → "Preserve log".** At the next reload, capture the lines just above `Navigated to …`.
2. **Shift+Esc** (browser Task Manager): note the Foundry tab's memory right after a scene change, and again 5 min later.
3. **`chrome://discards`** or **`edge://discards`**: note the Foundry tab's *Discard count*.
4. Browser, RAM and GPU, and whether an "Aw, Snap!" page ever appeared.

### Code / content fixes

- **Screen transition:** add a safety timeout. Also lift the overlay below notifications, so a "lost connection" toast is visible.
  - Commit `1a330723` (co-dev, same night) already covers the **battle-shatter** path: `holdUntilDrawn` with a 90 s cap and a failed-draw poll.
  - ✅ **Done 2026-10-25:** the plain scene-change path now watches the draw too. `cover()` starts the same poll (`watchDraw`, shared with `holdUntilDrawn`). It reveals once `canvas.loading` clears without a `canvasReady`, which covers Foundry's texture-load failure, group-draw failure and blank-draw returns. On a draw that never ends, it reveals at the 90 s `STUCK_MS` cap. A healthy slow draw still stays black until `canvasReady`. This was verified in a fake-clock simulation, not in a live game yet.
  - Still open: lifting the overlay below notifications. Several overlays are tuned against z 99999 (the area panel, the camp GM panel, and the glass "under the glass" ordering), so this needs its own pass.
- **Assets:** upload the 6 host-served JB2A webms to Forge and repoint the tiles. These are JB2A Free (CC BY-NC-SA). The list below was read from a scenes snapshot on 2026-10-25, about 4.8 MB in total:

  | File (`modules/JB2A_DnD5e/Library/…`) | Size | Tiles | Scenes |
  |---|---|---|---|
  | `Generic/Smoke/Fumes_02_Steam_White_400x400.webm` | 699 KB | 26 | Eisendrache_Battlemap003, Eisendrache Burning, Eisendrache Kingdom, Ruhig_Village001/005/011, Valley_Map001/002, Wyrmwood_Map012, Dragonslayer Overworld, Vastwind_Field009 |
  | `Generic/Smoke/SmokePlumes01_01_Regular_Grey_400x400.webm` | 970 KB | 2 | Ruhig_Village001, Ruhig_Village011 |
  | `Generic/Wind/WindLines01_01_Regular_White_500x500.webm` | 271 KB | 2 | Eisendrache Highroad, Vastwind_Field002 |
  | `1st_Level/Sleep/SleepSymbol01_01_Regular_Pink_400x400.webm` | 160 KB | 1 | Valley_Map001 |
  | `Generic/Wind/WindStreams_01_White_20OPA_1200x1200.webm` | 1819 KB | 1 | Vastwind_Battlemap001 |
  | `Generic/Fire/Campfire/Campfire03_02_Orange_Loop_400x600.webm` | 889 KB | 1 | Hideout_Map005 |

  Our Forge key is read-only, so the upload needs Forge write access. Repointing the 33 tiles is a world-data write.
- **Static-file caching:** ✅ [docs/host-cache-proxy/](host-cache-proxy/README.md) has a no-dependency Node proxy. Foundry sends `Cache-Control: no-cache` on all static files over HTTP/1.1, so every reload re-asks the host about each file. The proxy lets browsers keep scripts and assets for 6 h, so a mid-session reload costs only the world data. It was verified against the local server; a real player join through it has not been tested.
- **Script bundling (measured 2026-10-25):** this module loads **749 files per page**:
  - 376 classic scripts;
  - 117 ES module entries, which pull in 280 more through imports;
  - 2 stylesheets.

  That is 16.0 MB raw, 4.8 MB gzipped. The largest are `skill-effects.js` (709 KB), `action-card.js` (618 KB) and `state-handlers.js` (465 KB). Test-only files such as `_test-harness-director.js` (187 KB) load on players' clients too. With the proxy in place, bundling mainly helps the **first** load. Do it after the entrance work lands, because it changes the shipped file list. The development build must stay unbundled for the harness's cache-busting.
- **World size:** shrink the payload, so each reload costs less.
- **Memory:** if step 2 shows growth, profile which `canvasReady` tickers keep allocating.
