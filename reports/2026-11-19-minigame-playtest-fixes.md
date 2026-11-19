# Plasma Field Dash: playtest fixes + perf recorder (v1.0.631)

Follow-up to the 11-18 playtests (3 humans, then a second group). Code only: no world data, no migration, no new `module.json` entries (a hard reload is enough, no server restart).

## Performance recorder (playtest mode only)
- Every client sends a 2 s sample to the host while a playtest runs: fps, frame p95/p99/max, long frames, ping (last clock-sync RTT), snapshot/world gaps, interpolation stalls, errors, mode and stage, hidden flag.
- Chrome/Edge also send the slowest frames (Long Animation Frames API, ≥100 ms) with the scripts that caused them. Firefox and the GM Electron (Chrome 122) send numbers only.
- The host keeps the last 10 runs in its localStorage (`fabula-ultima-companion.minigamePerfLogs`). When the session closes it shows a summary (per player per phase, colour-coded, slowest frames, devices) with a Download JSON button.
- API: `minigame.perfLogs()`, `perfSummary(i)`, `perfDownload(i)`.
- 11-18 readings: network fine (ping 17-42 ms); a GTX 980 Firefox client held 51-57 fps; occasional 150-180 ms freezes in Stage 3 on players only. No adaptive resolution for now.

## Fixes
- **Victory pose:** on the GM screen the winner could stay in the zapped pose while Hako was already charred (a remote runner's shock never ended during the finale). Remote shocks now end after 560 ms in the finale.
- **Perfect dodge + stamina:** a dash that empties stamina no longer makes you Winded straight away; Winded waits until the dash ends and is cancelled if the dash was a perfect dodge (which refunds stamina).
- **Hidden / minimised windows:** a player whose window is hidden for 1.5 s while racing (or in countdown) is handed to a CPU, with a toast; when the window comes back, the seat is handed back. The host doesn't send this. The launcher now reminds the GM not to minimise the host window (covering it is fine).
- **Stage 3 warm-up:** on load, all images, character canvases, tutorial pictures and clips are decoded and drawn once off-screen (capped at a few seconds). Live: 64 images + 20 clips in ~660 ms.
- **Recorder fixes:** frame time measured uncapped; no sample taken while hidden; a CPU standing still no longer counts as a stall.

## Scoring: Stage 3 counts double
- Stages 1-2: 4 / 3 / 2 / 1. Stage 3: **8 / 6 / 4 / 2**. Tie-break unchanged; end rewards (coupons, Fabula Points by final place) unchanged.
- Rules slide gains one sentence; a "Final stage: double points!" notice shows at the Stage 3 countdown.

## Tests
`pf-netsim.test.mjs` PASS: base, `PT=stage:3,quick,nopractice`, `AWAY=1` (player hides in Stage 2 → CPU within 2.5 s, back within 1.5 s), drop, `PT=stage:1,gmruns`, `PT=stage:2,quick,nopractice,limit`. New checks: perfWindow fields, winner not stuck zapped on any screen, perfect vs plain dash stamina. The victory-pose check fails without the fix.

## Not verified yet
- Restoring a really minimised window firing "back" on its own (only a hand-sent message was tested live).
- Whether the warm-up removes the Stage 3 freezes: the next playtest's "Slowest frames" list will say.
- The new slide text and Stage 3 notice in a live game.
