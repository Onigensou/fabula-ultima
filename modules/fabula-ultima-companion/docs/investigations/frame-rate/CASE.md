# Case: frame-rate — low frame rate on the GM app and in battles

**Status:** open, **causes located** (sandbox benchmark 2026-11-01). No fix is made yet; each needs the host's go-ahead.
**First report:** the 2026-10-31 game session: the host's GM app was slow while the Spectator stayed smooth, and a player
("trio" in the host's message, read as Trinio; not confirmed) reported low frame rate in a Valley battle.
**Session record:** [../player-reloads/sessions/2026-10-31-game-session.md](../player-reloads/sessions/2026-10-31-game-session.md)
**Logging:** `client-health.js` reports `fps` about once a minute of visible canvas time, from 2026-11-01. The
`client-health-summary` tool prints a frame-rate table per scene and Battle depth setting. The next real session is the
first with real numbers.

## Findings

Three separate causes, biggest felt effect first. All from the benchmark below.

### 1. Freezes in battle: one actor re-derive takes 0.3–2 s

Every dip in a real battle lines up with `prepareData` on an actor, and it happens on every client.

- One re-derive of a player character took **0.3–0.8 s on the GM and up to 1.95 s on the player client**. A single PC can
  freeze a page for that long, several times in a row.
- **King Gorger re-derived 9–27 times in 5 s**, on both clients, at about the same moments.
- In those 5 s windows the page falls to 6–18 fps, with long tasks totalling 3–4.7 s.
- Between them, the same battle runs at 60 fps with the same camera, HUD and tokens.
- **The Battle depth setting doesn't change this:** Off and Depth only had the same dips.
- Profile: `csb-template-layout-dedup.js` 12.6% and `csb-formula-compat.js` 6.2% of the battle opening, mostly `deepClone`.
- **Not traced:** why a PC costs this much, and why King Gorger re-derives so often. See `project_scorched_tile_lag_rootcause`
  (CSB prepareData per write) and `reference_foundry_token_update_cost` (unlinked rebuild per base update) in the host's
  notes: both are possible leads.

### 2. The GM page: one search of the whole page every frame

`layoutOverheadRows` in `map-system/keyboard-interact.js:437` runs `document.querySelectorAll` with four class selectors
every frame, on every scene, even where no NPC button is showing.

- It is **14–22% of the GM page's main-thread time**, all session long.
- Its cost scales with page size, and the GM page has twice the elements (about 23,700 against 12,100).
- **Measured:** answering that one selector with an empty list took the GM page from **46.2% to 22.9% main-thread busy**,
  and script time from 36.6% to 11.6%.
- Also worth a look: `badgeTick` in `conflict-event/lightning-crystal-countdown.js:232` calls `getBoundingClientRect` every
  frame, 3% in a Lightning Crystal battle.

### 3. Firefox: the default 3D mode costs about 40% of the frame rate

| Firefox, player | `camera` (3D, default) | `full` | `scale` | `off` |
|---|---|---|---|---|
| `Valley_Battlemap001` | **37.0 fps** | 57.7 | 57.8 | 57.7 |
| `Valley_Battlemap002` | **34.9 fps** | 57.8 | 57.7 | 57.7 |
| `Vastwind_Battlemap001` (no 3D preset) | 57.7 | 57.7 | 57.7 | 57.8 |

- Chromium browsers show no such drop here (Edge and the Electron app hold 58–59 fps in every mode). They use more of the
  graphics card for it: Edge reads 40–45% with 3D against 23–30% with Off on the Valley maps, on a GTX 1070 Ti.
- Likely mechanism: `battle-stage-3d-camera.js` `#frame` draws a second WebGL context, then re-uploads its full-window canvas
  to PIXI every frame (`pixiTex.baseTexture.update()`). Not confirmed by a Firefox profile.
- **Reading Trinio's GPU:** the logger's "GTX 980, or similar" is what Firefox reports, not the real card: this machine has
  a GTX 1070 Ti and Firefox reported the same string. Their real card is unknown.

## What's ruled out

| suspect | proof |
|---|---|
| Battle depth as the cause of the freezes | Off and Depth only dip the same way as 3D |
| Battle depth as a frame-rate cost on Chromium | 58–59 fps in every mode on Edge and the Electron app |
| A memory leak | Heap falls back after peaks, and the GM's typical heap rose only about 230 MB in 5 hours |
| The host machine | 19–42% CPU and 15–17 GB RAM free during the real session |

## Benchmark, 2026-11-01

**Setup:** sandbox world copy, code at `cc86de8b` plus the fps logging; GTX 1070 Ti, 16 threads, 1920×1080; muted; nothing else
in Foundry running; no Streamlabs. Maps had 6 tokens for the idle runs. Each idle run is 18–25 s after a 4 s settle. Main-thread
figures come from CDP `Performance.getMetrics`.

**Idle on a battle map, no battle running:**

| client | Battle depth | fps | main thread busy | page elements |
|---|---|---|---|---|
| GM, Electron 29 | all | 58.6 (one 53.2, one 57.4) | 41–54% | 23,700 |
| GM, Electron 29, search removed | Off | 58.7 | **22.9%** | 23,700 |
| GM, Edge 156 | Off | 58.5–58.7 | 29–38% | 23,600 |
| GM, Edge 156 | 3D | 57.6–58.7 | 38–50% | 23,600 |
| player, Edge 156 | all | 58.6–58.7 | 20–27% | 12,100 |
| player, Firefox 155 | see table above | 35–58 | not measurable | |

**A real battle:** `Valley_Battlemap002`, 4 PCs + guests against 3 Tempered Lookers, on the GM (Electron) and a player (Edge) at
once. Five runs: 3D three times (one with nobody passing prompts, so it sat at the first one), Off, Depth only.

- **Opening (first 30 s):** 1–50 fps in 5 s windows on both, worst single frames 0.9–2.9 s.
- **Attacks (`RESOLVE`):** falls to 6–30 fps when actors re-derive, with frames of 0.5–2.1 s.
- **Waiting at a menu or card:** 60 fps on the GM.

**Limits of this benchmark:**
- One machine, a mid-range card, and no real players' network or Streamlabs. It doesn't show what a weaker card does.
- **The steady slow frame rate you saw on the GM app wasn't reproduced:** here it held 60 between dips. Dips, and a real
  session's larger load, are the likely match, but only the new logging can confirm it.
- **The player client locked to exactly 30 fps whenever the GM app was also drawing on the same desktop,** and ran at 58.7
  alone. That's two windows sharing one screen here, so it isn't a real player's condition. It may matter for the host's GM +
  Spectator pair. Not checked.
- Firefox ran 155 here; Trinio's reports 159. No Firefox battle or profile.

## Fix options

The host decides. Cheapest first.

1. **The per-frame search.** Use live collections (`getElementsByClassName`), so nothing searches the page unless buttons
   exist. Small, and in the host's own code.
2. **Firefox and 3D.** Fall back from 3D to Full on Firefox automatically, or try lowering the 3D canvas's upload cost. Until
   then, a Firefox player can set Party Menu → Config → Graphic → Battle depth to Full. The 3D camera is sarunphat's and the
   host's shared work (`df496436`), so talk to sarunphat first.
3. **Actor re-derives.** Biggest felt gain, biggest job: find why one PC takes this long and why King Gorger re-derives so
   often, then coalesce the writes. Needs its own investigation.

## What each fix would take (traced 2026-11-01)

A 110 s battle on the GM client spent 17.2 s in actor recalculation (another session's sandbox was also running, so read these
as shares, not absolute times):

| actor | recalculations | avg | total |
|---|---|---|---|
| King Gorger's 4 unlinked tokens | 104 | 51 ms | 5.3 s |
| Hina (111 items) | 5 | 901 ms | 4.5 s |
| Blanche | 4 | 523 ms | 2.1 s |
| Keren | 4 | 452 ms | 1.8 s |
| EXFURSION Party (battle log writes) | 2 | 702 ms | 1.4 s |
| Zarg | 1 | 897 ms | 0.9 s |

**King Gorger, a data cleanup.** He is linked now, but 4 old unlinked tokens of his actor remain, on `Midgard_Map001`, `005`,
`006` and `007`. Each write to his actor rebuilds each of them twice, on every client, on any scene: 13 writes made 104 rebuilds.
Without them a write costs about 43 ms instead of about 450 ms. No code changes. Check first whether events use those tokens,
and patch or re-save slot 1 if it holds them.

**Battle-start status effects, a small code change to check.** `skill-effects.js:7587` creates an effect directly when no batch
is open, so Hina's 4 at the battle's opening (Prophecy Point, Protect, Flying, Lucky Seven Ready) are 4 recalculations of about
0.9 s. `flushAeBatch` already batches effects inside a skill chain. Not traced: which caller lacks the batch, and whether those
effects may safely land together.

**Hina's recalculation itself, unexplained.** It took 908–1,074 ms here. The July note in `csb-derivation-perf.js` measured
211 ms at 100 items. Items only explain about a third (361 ms), and the layout clones 148 ms. Something has slowed it about 4×
since then, on a machine that wasn't idle. Worth finding before considering anything bigger. Replacing CSB isn't indicated.

**The per-frame search, about 5 lines.** Replace the `querySelectorAll` in `layoutOverheadRows` with live
`getElementsByClassName` collections. Needs a check on an NPC with two or more buttons.

**Firefox + 3D, no code needed for one player.** Battle depth is per-user, and the fallback path to Full already exists for
backdrops without a 3D model.

## Notes (append-only)

- **2026-11-01:** case opened. Logging added and benchmark run the same morning. The first guess, the 3D mode as the main
  cause, was wrong for the freezes and for Chromium, and right for Firefox.
- **2026-11-01:** traced what each fix takes. Calling the actor cost "not traced" was too quick: the June and July notes had
  already measured it.
