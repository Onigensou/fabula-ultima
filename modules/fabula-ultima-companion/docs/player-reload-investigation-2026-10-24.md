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

### Client-side evidence (ask Rinri and Blumairwen next session)

1. **F12 → Console → ⚙ → "Preserve log".** At the next reload, capture the lines just above `Navigated to …`.
2. **Shift+Esc** (browser Task Manager): note the Foundry tab's memory right after a scene change, and again 5 min later.
3. **`chrome://discards`** or **`edge://discards`**: note the Foundry tab's *Discard count*.
4. Browser, RAM and GPU, and whether an "Aw, Snap!" page ever appeared.

### Code / content fixes (not started, need approval)

- **Screen transition:** add a safety timeout. Also lift the overlay below notifications, so a "lost connection" toast is visible.
  - Commit `1a330723` (co-dev, same night) already covers the **battle-shatter** path: `holdUntilDrawn` with a 90 s cap and a failed-draw poll.
  - The plain scene-change path (`cover()` on `canvasTearDown` → `reveal()` on `canvasReady`) still has no timeout. Build the fix on that commit's `holdUntilDrawn`/`STUCK_MS`.
- **Assets:** upload the 6 host-served JB2A webms to Forge and repoint the tiles.
- **World size:** shrink the payload, so each reload costs less.
- **Memory:** if step 2 shows growth, profile which `canvasReady` tickers keep allocating.
