# forge-mirror — Forge files served from the host

Players load the Forge files the game uses from the host's PC instead of from Forge.

**Why:** `docs/investigations/player-reloads` (2026-10-28 test).
- For players on some ISPs, the first Forge download of a map took 4–9 minutes; the same file from the host
  took ~1 s.
- Forge's CDN keeps copies ~8 minutes and never caches audio, so most map changes and every sound paid that again.

**What doesn't change:**
- Forge stays the source of truth. World data and code keep their Forge URLs, and new art is uploaded to
  Forge as before.
- A machine without a mirror behaves exactly as before: everything loads from Forge.

## The parts

| part | where | what |
|---|---|---|
| sync tool | `tools/forge-mirror/sync.mjs` | keeps `Data/forge-mirror/` an exact copy (MD5 = Forge's) of every Forge file the game uses |
| client | `modules/fabula-ultima-companion/scripts/forge-mirror/forge-mirror.js` | on every client, loads a Forge URL from the mirror when the mirror holds that exact file; falls back to Forge if the copy fails |
| session start | `FoundryVTT/session-mode/Start-SessionApps.ps1` (host's PC, not in git) | runs the sync after preflight, before Foundry. Once the GM client is in, asks it for a fresh `wanted.json` (`mirror-refresh.mjs`) and syncs again, so art added since the last session is mirrored before players load. Each sync is capped at 3 minutes; neither blocks the session |
| switch | world setting **"Serve Forge files from the game host"** | off = everything from Forge, for the next file loaded; nobody reloads |

## Run the sync

```
node tools/forge-mirror/sync.mjs                # Foundry open or closed
node tools/forge-mirror/sync.mjs --dry-run      # count only, write nothing
node tools/forge-mirror/sync.mjs --verify       # re-check every file and every known-broken reference against Forge
node tools/forge-mirror/sync.mjs --prune        # forget files nothing references any more
```

Options: `--data <Data dir>` (default: two folders up), `--local <dir>` (repeatable), `--concurrency 12`.

- **First run on the host:** 3,120 files, 1.2 GB, in under 2 minutes.
- **Later runs:** only new or changed files, usually a second or two.

## What gets mirrored

- **`forge-mirror/wanted.json`**, written by the **primary GM's client**:
  - every Forge URL in the world data: a full scan 60 s after login and every 30 min (sliced, so the game doesn't
    stall), plus the current scene at each map draw;
  - Forge URLs any client met at runtime that weren't mirrored yet, e.g. the image a wildcard token picked.
    Clients report these to the GM within ~30 s, and the GM writes them within ~2 min.
- **Forge URLs in the module's scripts,** including simple `BASE + "path"` and `` `${BASE}/path` `` forms.
- **Everything already in `manifest.json`,** until `--prune`.

## How a file gets in

1. `HEAD` the Forge URL. Forge's etag is the MD5 of the stored file; files are kept in B2 behind Cloudflare.
2. If a **local original** has the same file name **and** the same MD5, copy it. Local roots come from
   `--local` or `forge-mirror/config.json` (`{ "localRoots": ["E:/Art(New Com)/DND", ...] }`, per machine).
   A name alone never counts: different pictures often share a name.
3. Otherwise download it from Forge.

## How the client redirects

A URL is redirected only if the manifest holds that exact path and its `?v=`. These are the load paths it covers:

- **`PIXI.Assets.load`** (maps, tiles, tokens, status icons, video tiles): the Forge URL becomes an *alias* of the
  mirror file, so Foundry's texture cache, `getTexture()` and unloading keep working under the Forge URL.
- **`fetch`:** audio decoded into memory, Sequencer, the module's own downloads.
- **`src` of `<img>`/`<video>`/`<audio>`/`<source>`,** set by property or by `setAttribute`: streamed music,
  battle-animation and cut-in videos, image preloads.

**Not covered yet:** images inside HTML that Foundry renders (sheets, journals, chat). They still load from Forge.

**Fallback:** if a mirror copy fails, each path loads the Forge copy. The PIXI path has to do this itself,
because the Forge module turns Foundry's own cache-bust retry off for Forge URLs (`TextureLoader.getCacheBustURL`
returns `false` for them).

**Logging:** client-health records, shown by `docs/investigations/_tools/client-health-summary.js` as a
"forge mirror:" line per player:
- `forge-mirror` at world entry;
- `forge-mirror-draw` per map draw (hits / misses / fallbacks).

## Files (all under `Data/forge-mirror/`, ignored by git)

| file | |
|---|---|
| `<account>/<path>` | the files, at the same path as on Forge |
| `_case/<hash>.<ext>` | files that can't live at their natural path on Windows: paths that differ from another only by letter case (`Item Icon/boot.png` vs `Boot.png`, different pictures), and names ending in a dot or space or reserved (`CON`, `NUL`…). The manifest's `file` field points here. |
| `manifest.json` | `{ files: { "<account>/<path>": { size, md5, qs, file? } } }`. `qs` = every `?v=` the world uses for that file. An unseen `?v=` may be a re-upload, so it loads from Forge until the next sync re-checks it. |
| `broken.json` | references whose Forge file no longer exists (404). Re-checked only with `--verify`. |
| `wanted.json` | written by the GM client (see above) |
| `config.json` | per-machine settings (`localRoots`) |

**Not mirrored:**
- wildcard token paths (`.../NPCs/Bandit/*`), which are folders, not files; the client records the images
  actually picked;
- paths Windows can't store at all.

## Another machine (e.g. the co-dev's)

Nothing is needed. Without `Data/forge-mirror/manifest.json`, the client does nothing and everything loads from
Forge.

To mirror there too:
1. Run the sync once. It creates the folder from the code's URLs.
2. Start a GM session. The GM client writes `wanted.json` about a minute after login, and only when the folder
   exists.
3. Run the sync again.
