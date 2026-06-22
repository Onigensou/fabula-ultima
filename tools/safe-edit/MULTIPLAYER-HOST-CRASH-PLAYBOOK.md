# Multiplayer Host-Crash Playbook (fabula-ultima-2)

Reference for debugging "the local Foundry desktop app (the host) crashes/closes"
during multiplayer. Written 2026-06-22 after diagnosing four distinct issues that
all *looked* like the same crash. **The #1 lesson: "host crashed" has several
unrelated causes — always get the failure signature before theorizing.**

---

## TL;DR — the four problems we found & fixed

| # | Symptom | Real cause | Fix | Status |
|---|---------|-----------|-----|--------|
| 1 | Host closes when **≥2 clients log in at the same time** | **Windows GPU-compositor fail-fast** in `CoreMessaging.dll` (`0xc0000602`), triggered by Chromium's native window-occlusion check during the module's overlay/animation churn | Launch with **`--disable-features=CalculateNativeWinOcclusion`** (baked into the **"Foundry VTT (Fixed)"** desktop shortcut) | ✅ Fixed |
| 2 | World near the **512 MB boot ceiling** ("world won't boot", `RangeError: Invalid string length`) | World JSON exceeded V8's max **string** length (536,870,888 chars). Hog = save-system slot blobs (~102 MB) stored in **world settings**, which are vended to every client | Moved save blobs to **disk files** (`worlds/<world>/fu-saves/`), out of the vended payload. Tools: `tools/safe-edit/_migrate-saves-to-disk.js` | ✅ Fixed (512→410 MB) |
| 3 | Host closes when **"Reload All Clients"** macro runs with 3 clients | **V8 heap OOM** (`FATAL ERROR: … JavaScript heap out of memory`). 3 clients reconnecting at once = 3 concurrent world vends, each a ~410 MB JSON string + Buffer → heap exhausted. 2 concurrent fit, 3 don't | **Stagger** reloads ~one vend apart (`STAGGER_MS = 20000` in the macro; `reload-broadcast.js` spaces clients by `index*staggerMs`) so vends run one at a time | ✅ Fixed |
| 4 | (latent) host re-serializes the world during **combat** | `ONI.emit` broadcast on the **reserved core `"world"` socket event**, which the server routes into `World.requestWorldData` | Moved the bus to `module.fabula-ultima-companion` | ✅ Fixed (not a login-crash cause) |

---

## Decision tree — start here when the host crashes in multiplayer

1. **Get the Windows fault signature first** (PowerShell):
   ```powershell
   Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='Application Error'} -MaxEvents 20 |
     Where-Object { $_.Message -match 'Foundry' } |
     Select-Object TimeCreated, @{N='Msg';E={($_.Message -split "`n")[0..6] -join ' | '}} | Format-List
   ```
   - **Faulting module `CoreMessaging.dll`, code `0xc0000602`** → it's **Problem #1** (GPU/occlusion). Confirm the host launched via the **Fixed** shortcut (the plain Start-Menu icon lacks the flag → crash returns).
   - **No event at all** → it's likely a **V8 OOM** (Problem #3) or a clean process exit. OOM `abort()` does NOT log an Application Error. Go to step 2.

2. **Run the memory sampler during a repro** (`tools/_crash-mem-sampler.ps1`):
   ```powershell
   powershell -ExecutionPolicy Bypass -File "<Data>\tools\_crash-mem-sampler.ps1"
   ```
   Watch the `[main]` (server) process:
   - **Climbs to ~4 GB then dies, no drops** → OOM from concurrent vends (Problem #3). Reduce concurrency (stagger).
   - **Healthy "sawtooth"** (rises ~2.6 GB per vend, drops back to ~190 MB) → memory is fine; look elsewhere.

3. **Capture the actual V8 fatal message** — launch from a terminal so stderr is visible:
   ```powershell
   & "E:\Program Files\Foundry Virtual Tabletop\Foundry Virtual Tabletop.exe" --disable-features=CalculateNativeWinOcclusion --js-flags="--max-old-space-size=8192"
   ```
   `FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed - JavaScript heap out of memory`
   with `v8::String::Utf8Length → node::Buffer::New` in the stack = world-vend OOM.

4. **Cross-check Foundry's own logs** at `<Data>/../Logs/debug.<date>.log`:
   - `Vended World data to User [..] in NNNNms` — vend durations (~9-10 s solo, balloon to 15 s+ when concurrent). Log just ending mid-vend = host died there.

---

## Key facts / gotchas (save yourself the re-discovery)

- **`--max-old-space-size` is IGNORED by the Foundry *desktop* app.** We confirmed an OOM at ~2 GB old space despite `--js-flags="--max-old-space-size=8192"`. The lever for OOM is **reducing concurrency**, not raising the heap. (A dedicated Node server *would* honor it.)
- **Concurrent world vends:** 2 fit (a normal 2-player simultaneous login peaks ~3 GB and survives); **3 OOM** (~4.6 GB). Ceiling is ~4 GB.
- **One vend ≈ baseline (~190 MB) + ~820 MB** (a ~410 MB JSON string + a ~410 MB Buffer for the socket). Serialized, peak stays ~2.6 GB → safe.
- **The host = server + GM renderer in one Electron process.** When `[main]` (server) dies, all child processes die with it → "the whole app vanishes." A renderer-only crash would show "Aw, Snap", not vanish.
- **Two crash classes, two signatures:** GPU/occlusion fault → **logs** a Windows Application Error (`CoreMessaging.dll 0xc0000602`). V8 OOM → **no** Windows event (it `abort()`s); only visible via the sampler or terminal stderr.
- **The occlusion flag is a startup switch, always-on for the session** — no per-window/active-window requirement; it only disables one buggy browser optimization, with zero visual/feature loss for host or players. The only manual requirement is *launch via the Fixed shortcut*.
- **World size still trends up** (actors 207 MB + items 120 MB = genuine content, not removable bloat). Check headroom before bulk writes: `tools/safe-edit/_measure-world-payload.js` (vs the 512 MB string ceiling) and `_measure-settings.js` (per-key).
- **Module scripts can be cache-served** by Electron/browsers on reload. After changing a module script that must take effect on reconnect, a *fresh boot* loads it; a soft reload may serve the stale copy.

---

## The diagnostic toolkit (all under `<Data>/tools/`)

| Tool | Purpose |
|------|---------|
| `_crash-mem-sampler.ps1` | Samples every Foundry process once/sec (tags main/renderer/gpu by `--type`), flags a PID vanishing. The single most useful tool for OOM-vs-not. |
| `safe-edit/_measure-world-payload.js` | Per-collection serialized JSON size vs the V8 max-string limit. Run before any bulk write. |
| `safe-edit/_measure-settings.js` | Settings collection broken down by key / namespace. |
| `safe-edit/_analyze-doc-bloat.js` | Top actor/item docs by size + flag-namespace totals (is the bloat removable or genuine content?). |
| `safe-edit/_migrate-saves-to-disk.js` | Move save-system slot blobs out of settings onto disk (dry-run by default; `--apply`). |
| Windows Event Log (`Get-WinEvent`) | Hard Windows faults (GPU/occlusion). |
| Terminal launch + `--js-flags` | Capture the V8 fatal stderr; test whether more heap helps (it won't, on desktop). |

---

## The "Reload All Clients" design (Problem #3 detail)

A macro can only run on the GM's machine, so reloading everyone is two halves:
- **Macro** (`Macro.VzLoDAM7jRvWPTRN`) — broadcasts `FU_RELOAD_CLIENTS` and reloads the GM itself, scheduled **last** at `gmDelay = DELAY_MS + activePlayers*STAGGER_MS`.
- **`scripts/reload-broadcast.js`** — runs on every client; on receipt, reloads *that* client at `DELAY_MS + (its index among active non-initiator users, ordered by id) * STAGGER_MS`.

`STAGGER_MS = 20000` (≈ one full vend + GC headroom) so clients reconnect one at a
time → the host serializes the world for only one client at once → no concurrent-vend
OOM. Cost: ~`DELAY_MS + N*20s` total (≈41 s for 3 clients, ≈61 s for 4). Tune
`STAGGER_MS` in the macro for party size; it must exceed the worst-case vend time.

Verified 2026-06-22 (1 GM + 2 players): `[main]` sawtoothed to ~2.6 GB per vend and
dropped back to ~190 MB each time — no crash.

---

## Permanent fixes in place

- **Launch:** desktop shortcut **"Foundry VTT (Fixed)"** carries `--disable-features=CalculateNativeWinOcclusion`. *(The ProgramData Start-Menu shortcut still lacks it — needs an elevated re-save; avoid launching from it.)*
- **Saves on disk:** `worlds/fabula-ultima-2/fu-saves/{slot-N,index}.json`; settings cleared. New saves write there automatically (`save-storage.js`).
- **Reload stagger:** macro `STAGGER_MS=20000` + `reload-broadcast.js` index spacing.
- **Code** on branch `fix/reload-all-clients-stagger` (and earlier crash work merged to `main`). Live world-macro patches applied via safe-edit and journaled.
