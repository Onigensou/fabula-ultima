# host-cache-proxy

**Purpose:** cut the cost of a player's reload by letting their browser keep Foundry's static files between loads.

## Why

Foundry sends `Cache-Control: no-cache` on every static file, over HTTP/1.1, so every page load re-asks the host about every file. A measurement on 2026-10-25 found:

- **This module alone:** 749 files per load (16 MB raw, 4.8 MB gzipped).
- **The other 57 active modules** add more on top of that.

On a lossy route, one reload took about 53 s. See [player-reload-investigation-2026-10-24.md](../player-reload-investigation-2026-10-24.md).

The proxy changes that header to `public, max-age=21600` (6 h) on successful GETs of static file types: scripts, styles, images, video, audio and fonts. A player who reloads within those 6 hours loads all of them from their own disk, with no request to the host.

Everything else passes through unchanged:

- pages (`/game`, `/join`)
- `/api`
- uploads
- `.json` files
- error responses
- the game socket (websocket upgrades are piped through as raw TCP)

It does **not** shrink the world data (~130–145 MB) that Foundry sends over the socket on each join. Making the world smaller is the fix for that.

## Run it (on the machine that hosts Foundry)

```
node host-cache-proxy.mjs
```

The defaults are `PORT=30080`, `TARGET=http://127.0.0.1:30000` and `MAX_AGE=21600`. It needs nothing beyond Node, which already runs Foundry on this machine.

- Players join on **:30080** instead of :30000. Forward that port on the router the same way :30000 is forwarded today.
- Foundry itself is unchanged, so the test bridge and local tools keep using :30000.
- Optional: set `"proxyPort": 30080` in `Config/options.json`, so Foundry's invite links show the proxy port.

## Trade-off

A code fix pushed **during** a session reaches a player only after 6 hours, or after they press **Ctrl+F5** (hard reload). Tell the players when you hot-fix mid-session. To shorten the window, use `MAX_AGE=3600` (1 h).

## Verified (2026-10-25, against the local Foundry v12.343)

- Module and core scripts get the 6 h cache header.
- Foundry's gzip passes through.
- `/api/status`, `.json` files and 404 responses keep `no-cache`.
- Conditional requests are still answered.
- The socket.io websocket handshake returns `101`.

**Not yet tested:** a real player joining and playing through the proxy.
