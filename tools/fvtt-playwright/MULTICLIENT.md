# multiclient — drive N real Foundry clients and measure what each receives

The in-page emulation in the BD suite proves **correctness** (which client gets
which envelope) and gives exact byte counts, but it runs in a single process. It
cannot measure the thing players actually complain about: how long a card takes
to appear on a slow connection. This rig connects real browsers as real player
users, shapes each one's link independently, and records every battle-director
envelope that arrives.

## Files

| File | What it is |
|---|---|
| `lib/multiclient.js` | the rig — `openTable` / `closeTable` / `snapshot` / `summarize` |
| `lib/shape-proxy.js` | TCP bandwidth+latency shaper with live retuning |
| `scripts/multiclient-smoke.mjs` | connect a table, hold, dump per-client traffic |
| `scripts/multiclient-measure.mjs` | controlled payload-size sweep + validity gate |
| `scripts/multiclient-diag.mjs` | per-step timing when a connect hangs |
| `scripts/_proxy-isolate.mjs` | proves the shaper binds, without Foundry in the way |
| `scripts/_ws-path-check.mjs` | proves Foundry's socket traverses the proxy |
| `scripts/_wire-bytes.mjs` | capture real card-delta payloads + raw TCP bytes for the same window |
| `scripts/_wire-analyze.mjs` | offline deflate model of those captures — re-runnable without a battle |

## Run

```powershell
cd tools\fvtt-playwright            # from your Foundry Data folder
node scripts/multiclient-smoke.mjs   --users Rinri,Trinio --profiles lan,weak
node scripts/multiclient-measure.mjs --users Rinri,Trinio --profiles lan,weak --reps 5
```

Profiles: `lan`, `good`, `ok`, `weak`, `awful`, `mobile` (see `NETWORK_PROFILES`).

## Hard-won constraints — do not "simplify" these away

1. **CDP throttling does NOT shape Foundry traffic.** `Network.emulateNetworkConditions`
   does not apply to WebSocket frames, and Foundry carries all game traffic over
   one. Measured: a client "shaped" to 1.5 Mbps received a 512KB payload only
   ~0.7s slower than an unshaped one, when the link alone should have added
   ~2.8s. This is why `lib/shape-proxy.js` exists. `shaper: "cdp"` is kept only
   for comparison; the default is `"proxy"`.

2. **Boot unshaped, then clamp.** Foundry pushes a **~493MB world snapshot** on
   join. Through a 1.5 Mbps shaper that is ~40 minutes and blows `waitReady`'s
   timeout. `openTable` starts the proxy wide open, connects, then calls
   `proxy.setLimits(...)`. This also models the real case better: a player
   already in the session whose link is slow *during play*.

3. **Everything is compressed — measure wire bytes, not payload bytes.** HTTP is
   gzipped and the socket uses permessage-deflate. A `"x".repeat(n)` payload
   collapses to nothing on the wire, so a bandwidth-shaped link shows *no*
   effect — this produced a false negative on the first run. `multiclient-measure`
   now pads with random base36. Corollary for optimisation work: byte savings on
   highly-repetitive payloads (rendered HTML!) are worth less on the wire than
   raw `JSON.stringify().length` suggests.

4. **Kill orphaned browsers or the next run can't log in.** Foundry disables a
   user in the join dropdown while a session is live, and a hard-killed client
   holds its session. Symptom: `option being selected is not enabled`. Fix:
   `Get-Process chrome-headless-shell | Stop-Process -Force`, then confirm with
   the bridge that only `GM` is active.

   ⚠ **`chrome-headless-shell` ONLY — never add `chrome` to that list.** The rig
   launches the headless shell; `chrome` is the USER'S OWN BROWSER, and
   `Stop-Process -Force` closes their windows and tabs with no prompt and no
   recovery. Done once (2026-07-28, 18 processes killed) by "helpfully" widening
   the pattern. The headless shell is a separate image name precisely so this
   kill can be surgical — keep it that way. If you think you need to kill
   `chrome`, you don't: check `chrome-headless-shell` first, and if a real
   Chrome is somehow holding a Foundry session, close that ONE tab by hand.

5. **Clients are observers.** They join, listen, and measure; they take no game
   actions, which keeps the rig safe against a live world. If you ever want
   clients to *act*, point it at a copied world first.

6. **Connect sequentially.** Two simultaneous ~500MB world boots thrash memory
   and give misleading first-run timings. `openTable` is deliberately serial;
   budget ~60-75s per client.

## Validity gate

`multiclient-measure` runs a shaping-effectiveness check *before* reporting
anything, and says plainly when the numbers cannot be trusted. It has already
caught two distinct false-positive setups (CDP shaping; compressible padding).
**If the gate fails, do not quote the latency table.**

## Status

Individually proven:

- multi-client connect as distinct player users ✅
- per-client probe: per-envelope kind / bytes / arrival lag / addressed-to-me ✅
- TCP shaper binds (52× slowdown at 64KB/s vs unlimited, in isolation) ✅
- Foundry's socket.io traverses the proxy (`ioUri` = proxy port, ws transport) ✅

- real action-card broadcasts measured at the proxy, wire bytes not payload ✅
  (2026-07-28, `_wire-bytes.mjs` — see below)

### Wire bytes vs payload bytes, measured (2026-07-28)

Two runs (a free-running sim battle and a forced-Barrage run), 7 real card
deltas, each captured alongside the exact body dump the retired
`action-card-body-update` path would have shipped at that same instant:

| | delta | body dump | saving |
|---|---|---|---|
| payload (`JSON.stringify().length`) | 7.8 KB | 36.6 KB | **−78.8%** |
| wire, context takeover (ws default) | 1.0 KB | 2.8 KB | **−66.1%** |
| wire, no context takeover | 3.9 KB | 12.2 KB | −67.8% |

Compression ratio: delta **8.1×**, body dump **13.1×**. That gap is constraint 3
quantified — rendered HTML really does compress ~60% better than structured
JSON, so the wire saving lands ~12 points below the payload saving. **The saving
survives, it just isn't as large as the page-side number suggests.** `e059724c`'s
"−75%" is a payload figure and is fair as one (measured −78.8% here); the honest
wire figure for the same change is **≈ −66%**.

Method note: the model is `zlib.deflateRaw` with `Z_SYNC_FLUSH` per message,
which is what permessage-deflate does. It is a model, not a direct read of the
compressed frames — but it is bounded by the observed proxy counters, and the
counterfactual deliberately ignores the *second* (structured) emit the old path
also sent, so every number above is a conservative floor.

### The finding that actually matters for slow clients

Across both runs, ALL battle-director socket traffic was **1–2% of the client's
downlink** (28 KB of 1.5 MB; 105 KB of 14.3 MB). Optimising card envelopes
further is chasing a rounding error. Two bigger targets showed up in the probe:

- **the initial `action-card` open** — 11 KB each, 67.8 KB over 6 cards, i.e.
  ~9× the cost of all the deltas for those same cards combined;
- **24% of what a client received was addressed to someone else**
  (`wastedPct` 24 in the Barrage run) — fan-out that still filters client-side.

Open: what the other ~98% of the downlink actually is (HTTP assets vs core
Foundry socket). The proxy counts raw TCP and cannot split them; a
`page.on("response")` tally would.

### Where the envelope lag actually goes (`_lag-decompose.mjs`, 2026-07-28)

`IntentChannel._emitRaw` stamps `timestamp` on the line immediately before
`game.socket.emit`, so the probe's `lagMs` contains **no GM compose time** — it is
purely emit → client handler. A 500ms beacon run across idle / battle / tail:

| phase | beacon lag p50 | p95 | client main thread blocked |
|---|---|---|---|
| idle (no battle) | 370 ms | 713 ms | 97.8% |
| battle | 42,459 ms | 108,690 ms | 97.9% |
| tail (60s after) | 59,875 ms | 61,404 ms | 98.3% |

What this does and does not establish:

- **Not bandwidth, and not envelope size.** Over the whole battle the module
  channel carried **64 non-beacon messages / 290 KB** at 1.46 msg/s. Nothing that
  small queues for 100 seconds on loopback. Envelopes arrive and then wait.
- **Not GM-side.** GM drift p50 1 ms.
- **The backlog is unbounded and slow to drain** — still ~60 s behind a full
  minute after the battle ended.
- ⚠ **The magnitudes are NOT player-facing.** The client was already blocked
  **97.8% while idle**, before any battle — this headless client is not a
  representative browser, and disabling renderer backgrounding (below) probably
  made it worse by letting PIXI render unthrottled. Quote the *mechanism*, never
  these numbers.

`lib/foundry.js` now launches with `--disable-background-timer-throttling`,
`--disable-backgrounding-occluded-windows`, `--disable-renderer-backgrounding`.
Without them a headless page is never "visible", so Chromium clamps timers to
~1/sec — an idle 100 ms drift monitor reads ~800 ms of drift from the clamp
alone. **Timer drift cannot tell throttling from blocking**; use the `longtask`
PerformanceObserver, which the scheduler emits regardless of timer policy.

Decisive next test needs a **real, visible browser** (the user's own client), not
this rig — that is the only way to separate "Foundry clients stall during
battles" from "this box is running three Chromiums and an Electron host".

⚠ **The sim needs the Training Ground roster placed.** With the scene emptied,
`sim.run` produces a 0–1 round "inconclusive" battle and almost no card traffic.
Restore with `tools/test-bridge-client/_restore-training-roster.js` before a run,
and re-empty after.
