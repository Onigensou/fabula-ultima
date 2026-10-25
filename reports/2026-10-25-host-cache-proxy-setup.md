---
id: 2026-10-25-host-cache-proxy-setup
title: You host, so the reload fix needs a small proxy on your machine (plus where the new reload logs land)
status: open
severity: major
reporter: sarunphat
assignee: onigensou
component: process/hosting
introduced_in:
fixed_in:
---

# Not a bug: a setup step only the host can do

**Short version for Onigensou:** before the next session, run one small program on
your PC next to Foundry, open one more port on your router, and give players a link
with `:30080` instead of `:30000`. After that, when a player reloads mid-session, the
scripts and pictures load from their own computer instead of being downloaded from
yours again. Your Claude can do the setup with you. Everything it needs is below.

Nothing about Foundry, the world or your current setup changes. If anything goes
wrong, close the program and players use the old `:30000` link exactly as before.

## Why

On 2026-10-24, Rinri and Blumairwen reloaded **12 times each** without pressing F5
(see `modules/fabula-ultima-companion/docs/player-reload-investigation-2026-10-24.md`).
Each reload re-fetched everything from your home connection:

- **Files:** about 750 script files from our module alone (16 MB), plus Foundry's own
  scripts and the scene art.
- **Why it was slow:** Foundry tells browsers "don't keep anything without asking me
  first" (`Cache-Control: no-cache`), so every reload re-asks your PC about every
  file. One of those reloads took about 53 s over the slow route.

We still don't know *why* their pages reload; the logger below should tell us. The
proxy makes each reload far cheaper while we find out.

## What the proxy does

`modules/fabula-ultima-companion/docs/host-cache-proxy/host-cache-proxy.mjs`
(commit `d874e0a7`, with a README in the same folder) sits in front of Foundry. It
lets browsers keep static files (scripts, CSS, images, video, audio, fonts) for 6
hours.

These pass through unchanged:

- pages (`/game`, `/join`)
- `/api`
- uploads
- `.json` files
- error responses
- the game socket

It is one file with no dependencies. On my side it was tested against a live
Foundry v12.343: scripts get the 6 h header, `/api/status` keeps `no-cache`, and the
socket.io websocket handshake returns 101. **It has not yet carried a real
session**, so your session is the first real test.

It does **not** shrink the world data (~130–145 MB) that Foundry sends over the
socket on each join. That is a separate fix (the world trim).

## For your Claude: the setup

1. **Pull.** You need `d874e0a7` or later.
   `modules/fabula-ultima-companion/docs/host-cache-proxy/` must exist.
2. **Node.** Run `node --version`; any version 18 or newer works. If it's missing
   (for example, Foundry runs as the desktop app), install Node LTS. The proxy
   doesn't use Foundry's bundled runtime.
3. **Start it,** alongside Foundry, in a terminal that stays open for the whole
   session:
   ```
   node "modules/fabula-ultima-companion/docs/host-cache-proxy/host-cache-proxy.mjs"
   ```
   Expect the line `host-cache-proxy: :30080 → http://127.0.0.1:30000, static max-age 21600s`.
   Overrides: `PORT`, `TARGET` (if Foundry isn't on `127.0.0.1:30000`) and `MAX_AGE`
   (seconds).
4. **Check it locally:**
   ```
   curl -sI http://localhost:30080/scripts/foundry.js     # want: Cache-Control: public, max-age=21600
   curl -sI http://localhost:30080/api/status             # want: no-store (passed through; NOT public)
   ```
5. **Router:** forward **TCP 30080** to this PC, the same way 30000 is forwarded today.
   **Windows Firewall:** allow inbound TCP 30080 for `node.exe`. Windows usually asks
   on first run; answer "Allow" for private *and* public networks if players connect
   from outside.
6. **Players** join at `http://<your public IP>:30080` instead of `:30000`. The GM can
   stay on `:30000` locally; it doesn't matter.
7. **Optional:** set `"proxyPort": 30080` in Foundry's `Config/options.json` and
   restart Foundry, so the invite links on the setup screen show `:30080`. You can
   skip this and just tell players the new port.
8. **Confirm with one player:** F12 → Network, reload once, then reload again. On the
   second reload, most `.js` rows should say `(disk cache)` / `(memory cache)`
   instead of 200/304.

## The trade-off

If a code fix is pushed **during** a session, a player's browser keeps the old
scripts for up to 6 hours. A **Ctrl+F5** (hard reload) picks up the fix
immediately, so tell players to do that after a mid-session hot-fix. Starting the
proxy with `MAX_AGE=3600` shortens the window to 1 hour.

## The new reload logger: its logs land on YOUR disk

`scripts/client-health.js` (same commit) now runs on every client. It records why
each page reloaded:

- whether the previous page crashed or was closed normally;
- whether Chrome discarded the tab;
- memory before the reload;
- the last console errors;
- scene draw times.

It reports these to the main GM. The GM's browser saves them through Foundry's file
upload, which writes to the **host's** disk. So the files appear on your machine:

```
<your Foundry Data folder>/client-health-logs/fabula-ultima-2_<session-start>.json
```

That folder is gitignored, so **it will not come through git**. After the next
session, please send those JSON files over. On the GM console during play,
`FUCompanion.api.clientHealth.summary()` shows a per-player roll-up.

No player action is needed. Nobody has to keep F12 open any more.

## Notes

- 2026-10-25 (sarunphat's side): also committed `ee07bc2f`. It lifts the scene-change
  black screen on a failed draw (within about 2 s) or at a 90 s cap. Before, a failed
  draw stayed black forever, and players F5'd out of it.
