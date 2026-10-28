# forge-mirror — Forge files served from the host

Keeps `Data/forge-mirror/` an exact local copy of every Forge file the game uses, so players can load
them from the host instead of from Forge.

**Why:** `docs/investigations/player-reloads` (2026-10-28 test). For players on some ISPs, the first Forge
download of a map took 4–9 minutes; the same file from the host took ~1 s.

**What doesn't change:**
- Forge stays the source of truth. World data and code keep their Forge URLs, and new art is uploaded to
  Forge as before.
- A machine without a mirror (no `Data/forge-mirror/manifest.json`) behaves exactly as before: everything
  loads from Forge.

## Run

```
node tools/forge-mirror/sync.mjs                # Foundry open or closed
node tools/forge-mirror/sync.mjs --dry-run      # count only, write nothing
node tools/forge-mirror/sync.mjs --verify       # re-check every file and every known-broken reference against Forge
node tools/forge-mirror/sync.mjs --prune        # forget files nothing references any more
```

Options: `--data <Data dir>` (default: two folders up), `--local <dir>` (repeatable), `--concurrency 12`.

- **First run on the host:** 3,119 files, 1.2 GB, in under 2 minutes.
- **Later runs:** only new or changed files, usually a second or two.

## What it mirrors

- **`forge-mirror/wanted.json`**, written by the primary GM's client during sessions (forge-mirror client):
  - every Forge URL in the world data;
  - Forge URLs clients met at runtime that weren't mirrored yet (e.g. the image a wildcard token picked).
- **Forge URLs in the module's scripts,** including simple `BASE + "path"` and `` `${BASE}/path` `` forms.
- **Everything already in `manifest.json`,** until `--prune`.

## How a file gets in

1. `HEAD` the Forge URL. Forge's etag is the MD5 of the stored file; files are kept in B2 behind Cloudflare.
2. If a **local original** has the same file name **and** the same MD5, copy it. Local roots come from
   `--local` or `forge-mirror/config.json` (`{ "localRoots": ["E:/Art(New Com)/DND", ...] }`, per machine).
   A name alone never counts: different pictures often share a name.
3. Otherwise download it from Forge.

## Files (all under `Data/forge-mirror/`, ignored by git)

| file | |
|---|---|
| `<account>/<path>` | the files, at the same path as on Forge |
| `_case/<hash>.<ext>` | Forge paths that differ from another only by letter case (`Item Icon/boot.png` vs `Boot.png`, different pictures). Windows can't keep both in one folder; the manifest's `file` field points here. |
| `manifest.json` | `{ files: { "<account>/<path>": { size, md5, q, file? } } }`. `q` is the URL's `?v=` (a re-uploaded file) |
| `broken.json` | references whose Forge file no longer exists (404). Re-checked only with `--verify`. |
| `wanted.json` | written by the GM client (see above) |
| `config.json` | per-machine settings (`localRoots`) |

**Not mirrored:**
- wildcard token paths (`.../NPCs/Bandit/*`), which are folders, not files; the client records the images
  actually picked;
- paths Windows can't store.
