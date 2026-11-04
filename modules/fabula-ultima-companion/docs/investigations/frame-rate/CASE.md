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

**Hina's recalculation, explained (second sandbox, idle machine, 2026-11-01).** The 908–1,074 ms above was measured while
another session's Foundry sandbox was running; alone it is **445–500 ms** (Zarg 390, Blanche 232, Keren 199, King Gorger
17). Against the July note's 211 ms at 100 items, the growth is two removable overheads plus scale, not a regression:

| in one Hina recalculation (502 ms) | ms | share |
|---|---|---|
| 548 formula evaluations | 191 | 38% |
| of which the item-container **filter** formulas (`equalText(item.item_type, "weapon")` and the like, each run once per item per container: 45 × 7 for items, 38 × 3 for skills) | ~160 | 32% |
| cloning the shared item-sheet layout for every item (`csb-template-layout-dedup.js`: 111 clones, 20 MB, per recalculation) | 72 | 14% |
| everything else: CSB component maps, prop clones, item plumbing | ~240 | 48% |

- Both overheads are in sarunphat's `csb-extensions` patches. The dedup clone could be kept once per item (a per-item cached
  copy, as the stored copy was before dedup) instead of re-cloned every pass; the container filters are trivially
  recognizable, like the row columns `csb-derivation-perf.js` already fast-paths. Together about 230 ms of 500. Their
  code: report, don't fix.
- The slowest single formula is 17.8 ms for all 38 of its evaluations, so nothing to trim on the template side.
- **An A/B against July's code (a3696f57) on today's data was confounded:** the server keeps its module manifest, so the page
  loaded the current script list with July's file contents, logged 3 errors and took 1,140 ms. It rules out a shared-engine
  regression (current code is faster on the same data); it can't split the rest.
- Replacing CSB isn't indicated by any of this.

**The per-frame search: FIXED, `f641d17e` (local).** `layoutOverheadRows` now searches only the four layers the buttons are
mounted in (`#oni-event-ui-layer`, `#fu-shopopen-layer-v1`, `#fu-innopen-layer-v1`, `#fu-refineopen-layer-v1`), four id lookups
per frame instead of a page walk. Sandbox check on Midgard_Map001: two fake buttons on one token laid out centred over its head,
44 px apart, same height; a button outside the layers untouched. Not yet measured on a real GM page; the next session's `fps`
records are that measurement.

**King Gorger's tokens: DELETED 2026-11-01 (host's approval).** Only the four scene records and the token documents themselves
referred to the ids; no tile, macro, journal, setting or cutscene file did, and no save but slot 1 held them. Deleted live in the
real world (70 s, no players connected), slot 1 patched to match, full token documents and the pre-patch slot backed up in
`save-backups/2026-11-01-pre-kg-tokens/` (outside git). For re-placing a town copy: the plaza token stood at **1438, 2312 on
Midgard_Map001**, visible; the three "King Gorger A" copies were hidden at 614,631 (005), 1018,1472 (006), 635,790 (007).

**For a future campaign (host's question):** the town appearance of a recruitable character should be a separate *stage-prop*
actor (an unlinked NPC that is never written in battle), placed in the plaza as authored content and hidden by story progress;
the party-member actor is a different document, and recruitment hides the prop. That is how a console game does it, it costs
nothing per write, and a fresh save never inherits companion state. Today's recruitment reused the companion actor for the
town token, which is what made it expensive. Also: no "new game" baseline save exists yet; slots 2 and 3 predate the plaza
token. Authoring a chapter-start slot would make a fresh playthrough a Load, not a git archaeology job.

**Firefox + 3D, no code needed for one player.** Battle depth is per-user, and the fallback path to Full already exists for
backdrops without a 3D model.

## Notes (append-only)

- **2026-11-01:** case opened. Logging added and benchmark run the same morning. The first guess, the 3D mode as the main
  cause, was wrong for the freezes and for Chromium, and right for Firefox.
- **2026-11-01:** traced what each fix takes. Calling the actor cost "not traced" was too quick: the June and July notes had
  already measured it.
- **2026-11-01 (later):** the "4× slower" reading was contention from another sandbox; alone, Hina is 445–500 ms. Formula-level
  timing found the two overheads above. Page-search fix committed. **Rule for this case: never benchmark while another Foundry
  process is running** (check `Win32_Process` first), and drive CDP from Bash, not PowerShell, which strips the quotes out of
  JSON arguments silently (the first A/B attempt never reloaded the page).
- **2026-11-03 (sarunphat's session, uncommitted):** two cuts to the per-write cost, both measured on the Snapshot Runner.
  (a) **Foundry 12 prepares every item twice per actor update** (once when the actor re-initializes its items, again in
  `prepareEmbeddedDocuments`). `csb-derivation-perf.js` patch (4) skips the first pass: item prepares halve (4,914 → 2,457
  over 204 actors), derived data identical on all 204 actors and their 2,457 items, HP write −15–26% (Hina 358–406 → 268–300 ms).
  Kill switch `csbItemPrepareOnce`. (b) **Battle log writes no longer touch an actor mid-battle:** rows queue in the world
  setting `battleLogPending` (~1 ms vs ~200 ms per action) and reach the EXFURSION Party actor once, at the start of
  `runBattleEndSequence`. Seeded battle identical to HEAD; simulate 486/487 vs HEAD (the 1 is a timeout flake that also fails on HEAD).
- **2026-11-03 (later): where an undrawn frame goes.** Live world, headless GM, drawing off, CPU profile of the seeded
  Blanche-vs-Hellhound battle (10 actions, 35 s). 96 stretches of ≥50 ms with no frame, 7.5 s in total. 59 of them,
  most of the time, began in `DOMWebSocket.onmessage`: an incoming document update is handled in ONE task on the
  thread that draws, so nothing is drawn until it finishes. Inside those stretches: CSB recalculation 32%, browser
  native work (parsing etc.) 16%, socket message decoding 7.5%, Foundry copying the whole document (diff backup,
  field re-init, game.data mirror via `toObject`: each a `deepClone` of the full actor with every item) 13%, GC 4%,
  our module code ~10% (`_console-tap.js` 3%, `forge-mirror.js` 2%), UI re-render 1%, idle-but-late 9%.
  Conclusion: the stall is the update pipeline as a whole, proportional to the SIZE of the document written; no
  single listener to remove. Zero needs battle writes to stop being writes to big documents.
- **2026-11-03 (later still): fixing the update pipeline in place.** Formula memo (`csb-formula-memo.js`: a formula whose
  inputs are unchanged returns its cached result; anything impure is still evaluated) + item reuse
  (`csb-derivation-perf.js` (5): an unchanged, self-contained item keeps its derived data across an actor update). Hina HP
  write 273 → 95 ms; seeded battle: recalculation 4.56 → 1.58 s, long tasks 10.2 → 4.8 s, same battle. Parity: 322 actors,
  354 change scenarios vs a full rebuild, 487/487 regression, simulate 485/487 vs HEAD (2 flakes that also flip on HEAD).
- **2026-11-03 (night): recalculate only what changed.** `csb-derivation-perf.js` (7) is CSB 4.8.5's `_prepareEntityData`
  (same passes, order, pass-start reads, Active Effects, modifiers, attribute bars) that compares the values each phrase
  reads with what it read last time on that document and reuses the result, "not computable yet" included; impure
  phrases are evaluated every time. Also: arrays instead of `for…in` + `delete` (~3.5 ms alone), one prop-name list per
  pass, no dotted-key scan per reset merge, binary-search item-container reset, component map kept per layout tree.
  (8) the `game.data` mirror copy (`DocumentCollection#set` → `toObject`) is made only when read. AE gate: trace-only
  snapshots and gate listing skipped unless tracing; condition effects collected once per prepare; pass data copied
  top-level only. Hina HP write 51 → 19 ms under the profiler (same 12-write script), ~13 ms unprofiled (Keren/Blanche/Zarg ~7; AE
  create+delete 58 → 22 with (7)+(8) toggled live). Seeded battle: CSB
  prepare 0.66 → 0.32 s (6 ms a call), long tasks 2.2 → 1.9 s, worst lag 312 → 309 ms (not CSB), same battle. Parity
  430/430 vs a full rebuild with all patches off (incl. 36 input edits), 0 `game.data` mismatches, 487/487 regression,
  simulate 487/487 vs `aaf77aa3`. Left in Hina's ~13 ms: setup of the compute list (item-container rows, resets) ~3 ms,
  Active Effect applies ~2 ms, Foundry's update backup `deepClone` in `#updateData` ~1.6 ms (private, not patchable),
  DataModel re-init ~0.9 ms. Kill switches `csbIncrementalPrepare`, `foundryLazyDataMirror`.
- **2026-11-04: what is left in a battle, and the rewind history.** CPU profile of the seeded battle (scratchpad
  `battle-profile.mjs` + `lt-sum.mjs`): every mid-battle long task was a Scene update. Cause: the rewind history
  (`directorHistory`, one array flag on the scene, rewritten per save point) reached 1.6 MB in 10 actions, and every scene
  save made each client deep-copy all scene flags (`#updateData` backup). Each save point is now its own hidden JournalEntry
  (`persistence.js`, History store). Scene stays < 60 KB; long tasks 2.15 → 1.05 s; same battle; live rewind verified.
  Left: battle start (token actors' first prepare ~140–230 ms, `prewarmShatter` ~170–230 ms, sprite-shadow `readPixels`
  ~300 ms under software GL), and 50–95 ms UI tasks (round banner `refreshTurnActions`, a `settings.get` in
  monks-little-details). Item containers also keep unchanged rows now: Hina's HP write ~13 → ~10 ms.
- **2026-11-04 (later): battle start and the first turn, on a real GPU.** First real-GPU runs (one headless client,
  `FVTT_GPU=true`, persistent browser profile so the shader disk cache behaves like a player's). The sprite-shadow
  `readPixels` ~300 ms was a software-GL artifact (15–50 ms on the GPU). The real cost was SHADER COMPILES: 9 programs
  compiled during the first battle, 440–460 ms on a fresh profile; on a warm profile the turn-glow outline (115–156 ms)
  and a ColorMatrixFilter (80–97 ms) still recompiled every session, because PIXI names each program
  `pixi-shader-<counter>` and the counter follows creation order, so the source (the cache key) changed. Most of that
  time was waiting on GPU work already queued in the same frame (a `getError` probe: 60–80 ms before the compile).
  Fixes: `perf/pixi-stable-shader-names.js` (name = hash of the source), `perf/pixi-shader-prewarm.js` (turn-glow,
  sprite-shadow bake, ColorMatrix drawn once on a small render texture while idle after a scene loads; 5–17 ms warm,
  ~250 ms total on a never-seen profile). In-battle compiles: 440 → 56 ms (fresh profile), 230–300 → 11 ms (warm).
  Also: `prewarmShatter` spread over ≤ 8 ms idle slices (was one 170–230 ms task; panes identical to HEAD);
  `perf/client-setting-memo.js` (client-scope `settings.get` built a Setting document per call: 184 ms per battle);
  bare `getProperty` in the player HUD hit Foundry's deprecated-global getter (a compat warning per read, 68 ms);
  GM desk rows forced a layout per row per repaint (78 ms); the chat-button layout built a debug snapshot with
  `getComputedStyle` on every schedule (109 ms); rewind save points re-rendered the Journal sidebar per action
  (`render: false`); component map shared per layout tree. Seeded battle, real GPU, warm profile, after a 4 s settle:
  long tasks 838–1242 → 281 ms (2 tasks, both the sim's actor/token creation at t=0), worst lag 284–309 → 156 ms.
  Software runner A/B vs HEAD (2 runs each): long tasks ~1.0 s → ~0.65 s. Same battle, 487/487 compute, simulate
  487/487 vs HEAD, parity 430/430.
  Left: new documents at battle start (each is constructed and prepared twice by Foundry: preCreate + create;
  ~160 + 60 ms in the sim), sprite-shadow `getTextureAlphaData` (~50 ms GPU), forced layouts in
  `npc-status-strip` `layout()` when the DOM is dirty, 30–45 ms director turn tasks (`onEnter`, round banner,
  `previewEnemyActionOdds`, handlebars renders).
