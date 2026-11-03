# snapshot-runner — the Snapshot Runner: fast, serverless, throwaway test runs

**Purpose:** the fast workhorse. Each run boots a snapshot of the world (read from disk),
runs a test with the real engine and throws the run away. No server, no world launch,
nothing saved. Trusted only where the **Staging World** (`tools/staging-world`, the
real-server referee) has confirmed it. Named the "Battle Sandbox" until 2026-11-03.

The runner runs the **real** Foundry client, CSB and our module in a browser page.
The only fake is the **server**: `www/fake-io.js` replaces the socket.io client and
answers what the server would (world data, templates, document writes, file browse).
The world data comes from a snapshot file, so there is no world, no LevelDB and no
server process. A tiny static file server (`bin/server.mjs`, :30101) serves Foundry's
own client files and our `Data/` tree.

Why the server and not Foundry: the battle code calls Foundry hundreds of times, and
its numbers come from CSB's formula engine. Faking those would mean testing the fakes.
The server, by contrast, speaks a small protocol (about 8 socket events matter).

## Pilot result (2026-11-02): compute stage, whole Regression Bench

| | real engine (live world) | runner |
|---|---|---|
| skills fingerprinted | 487 | 487 |
| identical fingerprints | — | **487 / 487** |
| ok / damage / heal / rolled / hits / total damage | 434 / 81 / 16 / 93 / 121 / 2835 | same |

Negative controls (the comparison must be able to fail):
- `--control affinity` (dummy made vulnerable to everything, written through the stand-in
  server; CSB re-derived it live) → **69 diffs**, e.g. Descabello 55 → 110.
- `--control dice` (forced roll 1/1) → **93 diffs**: exactly the 93 rolling skills.
- items pruned to the 1,275 that anything references (`--profile lean`) → still 487/487.

Boot to `game.ready` (fresh headless browser, software GL): ~22–33 s for the 70-actor
bench (53 MB), **~14 s** for a one-scene battle (`--profile battle`, 49 actors). It costs
what the same data costs in Foundry: the gain is no server and no world, not raw speed.

The runner reproduces the real world's own boot errors too, e.g. "Failed data
preparation for Actor.… reading 'warn'" (a pre-existing bug, logged by the real boot).

## No world launch (2026-11-03)

The world data is read **straight from the LevelDB on disk** (`bin/read-world.mjs`, ~3 s,
from a temp copy, so the live world's files are never opened). The /game page is generated
from the package manifests with the server's own ordering rule. Proven against a capture of
the running world: every document identical (order included), the page's 731 tags identical,
and the referee **487 / 487** on a snapshot built from disk.

Server rules the reader reproduces (each one was a real diff against the capture):
- documents come in **name order** (code units, stable), messages by timestamp, users GMs
  first; journal / macros / settings in key order. Order is observable (`getName` returns
  the first of two same-named docs).
- an embedded doc its parent does **not list** is not part of the document (6 such scene
  tokens/tiles and a hand-written item effect exist as bare keys today). Note: world-export
  DOES include those, so its JSON can show content the game never loads.
- package paths: package folder first, then core `public/scripts` (a module's
  `greensock/...` resolves to core's copy); `./` dropped; `"library": "false"` is false;
  modules for another game system are not listed at all.

Only properties of the Foundry INSTALL come from a one-time capture (`shell/`: release,
data model, page skeleton, pack indexes). Refresh after a Foundry/system upgrade:
`capture.mjs` then `read-world.mjs --init-shell`.

## Code A/B (no world)

`--code <gitref>` makes the server serve OUR module as it was at that commit (extracted
once per commit into `code/<sha>/`; the page's tags follow that commit's manifest). So a
code change is checked runner-against-runner:

```
node ../snapshot-runner/bin/run.mjs --code HEAD --collect ../snapshot-runner/results/fp-head.json   # before
node ../snapshot-runner/bin/run.mjs --compare ../snapshot-runner/results/fp-head.json               # after (working tree)
```

## Small staged battles (`--profile duel`)

`"place"` copies tokens from another scene onto a kept scene (positions laid out fresh),
so a profile can stage exactly one fight. `runner.duel.json`: the party vs the bench dummy
on Training Ground, items cut to the referenced ones: **47 actors, 31.5 MB, ready in ~10 s**.
Its 66 party fingerprints are identical to the real engine's (capture/oracle.json); the
dice control turns 14 of them red.

## Setup on a new machine (once)

The code, `shell/` and the referees (`capture/oracle*.json`) are in the repo; every snapshot,
capture and result is generated locally and stays out of git.

```
cd tools/safe-edit && npm install                 # classic-level: reading the world's LevelDB
cd tools/fvtt-playwright && npm install && npx playwright install chromium
copy config.local.example.json config.local.json  # set password, foundryExe, dataPath
```

The runner finds Foundry's client files from `foundryExe` in that file (or `FVTT_APP`, the
`resources/app` folder). `shell/` was captured on Foundry 12.343 with this module list; after a
Foundry or system upgrade re-capture it (`capture.mjs` on a running world, then
`read-world.mjs --init-shell`). Check the setup: build the `duel` snapshot and run the
simulate referee (README section "RESOLVE stage"); it must say 66 / 66.

## Commands

Run from `tools/fvtt-playwright` (Playwright resolves from there).

```
# 1. (once per Foundry install) capture from a running real world: the /game page, the raw
#    payload and the referee fingerprints. Read-only on the world. Then init the shell.
node ../snapshot-runner/bin/capture.mjs [--scene "Regression Bench"] [--dummy "Test Target Enemy"] [--no-oracle]
node ../snapshot-runner/bin/read-world.mjs --init-shell

# 2. cut the snapshot (no game needed; reads the world from disk first).
#    Profiles layer runner.<name>.json over runner.config.json.
node ../snapshot-runner/bin/build-snapshot.mjs [--profile battle|lean|duel] [--source disk|capture]

# 3. boot the runner (starts/stops its own server) …
node ../snapshot-runner/bin/run.mjs                       # boot report -> run-report.json
node ../snapshot-runner/bin/run.mjs --compare             # + collector, diff vs capture/oracle.json -> compare.json
node ../snapshot-runner/bin/run.mjs --collect <f> | --compare <f> | --code <gitref>   # A/B of code
node ../snapshot-runner/bin/run.mjs --compare --control affinity|dice   # negative controls
node ../snapshot-runner/bin/run.mjs --eval some-code.js   # run code in the booted page
node ../snapshot-runner/bin/server.mjs                    # just the server; open http://localhost:30101/game
```

## What the stand-in server does (www/fake-io.js)

| event | answer |
|---|---|
| `session` | pushed on connect: session + the captured user id (GM II) |
| `world` | `snapshot/world.json` |
| `template` | the file over HTTP |
| `time` / `getWorldStatus` | now / true |
| `modifyDocument` | create (assigns ids), update, delete echoed back like the server; `get` returns `[]` and is **logged** |
| `manageFiles` | browse lists the real directory; uploads go to `runtime/` only |
| everything else | logged in `window.__runner.unknown` (module broadcasts are dropped: nobody else is connected) |

Gaps are recorded, never silently answered: read `run-report.json` → `state.runner`.
Known: compendium reads (`modifyDocument.get`) return nothing (one so far, a token-mold
table); writes are not validated the way the server validates them; there is no second
client, so player-routed prompts and socket broadcasts are untested here.

## Checks (checks/, run with `run.mjs --eval <file> [--dump <out.json>]`)

- `derived-dump.js` — every document's CSB-derived data + 21 rendered sheets. Diff two
  dumps (e.g. a setting off vs on). **Runner only**: rendering a sheet writes to the document.
- `write-cost.js` — median ms of an HP update on each party member (what a battle pays per write).
- `template-edit.js` — a template layout edit must reach an instance after `reloadTemplate`.
- `aem-registry.js` — the Active Effect registry as built at startup + refresh time (A/B it).

`--world-setting ns.key=<json>` overrides a world setting for one boot (A/B a kill switch).
`bin/profile-boot.mjs <out>` profiles a runner load (phase marks + CPU profile);
`RUNNER_SETTINGS='{...}'` and `NO_CPU=1` for repeated A/B loads.

## Rules

- The world is renamed `snapshot-runner`, so anything the code writes under
  `worlds/<id>/` lands in `runtime/`, never in the real world folder.
- `capture/` holds a full copy of the world payload (130 MB): local only. Only the referees
  (`capture/oracle*.json`) and the code ship; see "Setup on a new machine".
- Fidelity is whatever the referee says it is. Before trusting a new kind of test here,
  capture the real engine's answer for it and diff.

## Sharing the tool: `--snapshot <dir>` + `--port <n>`

`snapshot/` and :30101 are one slot. Two sessions that each `build-snapshot` swap each
other's world mid-run. `build-snapshot --snapshot <dir>` writes elsewhere, and
`run.mjs --snapshot <dir> --port <n>` serves it. Reports (run-report, compare*, results-*)
then go to that dir. The server's `/api/status` names its snapshot, and `run.mjs` refuses a
server that serves a different one. With no flags, everything works as before.
The CPU rule still applies: one headless client at a time.

## RESOLVE stage (simulate) — refereed by the Staging World (2026-11-03)

`run.mjs --mode simulate` runs the collector's simulate mode: COMPUTE, then RESOLVE with
every Actor / Item / AE write captured and nothing committed. Fingerprints add `writes`
(prop patches, AEs applied / removed) and `cardHtml`.

The referee is `bin/referee-staging.mjs`. It runs the same collector on the **Staging World**
(`tools/staging-world`, a real Foundry server on a disposable copy of the live world, :30001),
so the live world is never launched. It stages the same fight the `duel` profile stages
(linked tokens of the party + Test Target Enemy on Training Ground).

```
node ../staging-world/bin/staging-world.mjs build && node ../staging-world/bin/staging-world.mjs start
node ../snapshot-runner/bin/referee-staging.mjs --mode simulate --seed 1 --out ../snapshot-runner/capture/oracle-simulate-duel.json
node ../staging-world/bin/staging-world.mjs stop
node ../snapshot-runner/bin/build-snapshot.mjs --profile duel --snapshot snap-x
node ../snapshot-runner/bin/run.mjs --snapshot snap-x --port 30102 --mode simulate --seed 1 --compare ../snapshot-runner/capture/oracle-simulate-duel.json
```

| | result |
|---|---|
| runner vs real engine, `--seed 1` | **66 / 66 identical** (writes + card HTML included) |
| without `--seed` | 65 / 66: Draconic Roar picks its debuff from an `ae_name_pool` with Math.random, which forced dice do not pin; it flips between runs of the real engine too |
| `--control hp` (dummy at half HP) | 14 diffs, **only** in `writes` (13) / `cardHtml` (5): the RESOLVE-only part goes red while COMPUTE stays green |
| `--control dice` | 12 diffs (`roll`, `perTarget`, `cardHtml`, `writes`): the 12 rolling skills |

~5 min for the 66 duel skills: RESOLVE costs about as much here as in the lab.
Re-capture the referee after the engine or the world changes (`labBuiltAt` / `engineVersion`
are stamped in the file).

## skill-regression on the runner (game closed)

`node tools/skill-regression/bin/skill-regression.js check --runner` uses the `regression`
profile (every actor, Training Ground) and `run.mjs --bench`, which builds the Regression Bench
in the page with skill-regression's own `build-bench.js`. It checks the whole catalog in ~40 s:
**487 / 487** against `goldens/skills.json` and against `capture/oracle.json`. The Stop-hook gate
runs it automatically when Foundry is closed. See the skill-regression README, "Game CLOSED".

## Fixes the new test kinds found in the stand-in server

- **The token's ActorDelta id.** The server mints the ids of embedded docs that arrive without one,
  the ActorDelta above all (it exists server-side even for a linked token). fake-io echoed them
  with a null id, so every write to a *runtime-created* unlinked token's synthetic actor went to
  "…Token.X.ActorDelta." and failed with "reading 'createDocument'". In a sim battle the Hellhound
  never got Provoked or Element Gorge. Repro: `checks/unlinked-ae.js`. Snapshot tokens and
  `place`d tokens were never affected.
- **Ids no longer come from Math.random.** The real server mints ids on its side, and drawing from
  the page's Math.random shifted a seeded run's random stream on every document create.
- **Persistent summons are kept.** They point AT their owner
  (`flags.<ns>.summonOwnerActorUuid`), so the id closure never reached them. Blanche's King
  Gorger was missing from every profile.

## Whole battles (sim runner) — refereed by the Staging World (2026-11-03)

`checks/sim-battle.js` plays a whole hands-free battle with the sim runner
(`sim.testSkill`: Blanche, Provoke, vs Hellhound, 3 rounds; King Gorger joins as her
persistent summon). It records four streams by name: actions (`fu-director-action`),
HP / MP / IP writes, AE adds and AE removes. The same file runs in the runner
(`run.mjs --eval`) and on the Staging World (`referee-staging.mjs --eval`), and
`bin/compare-battle.mjs <ref> <run>` diffs them. Profile: `battle`.

```
node ../snapshot-runner/bin/build-snapshot.mjs --profile battle --snapshot snap-b
node ../snapshot-runner/bin/run.mjs --snapshot snap-b --port 30102 --eval ../snapshot-runner/checks/sim-battle.js --dump ../snapshot-runner/results/sim-battle-sbx.json
node ../snapshot-runner/bin/referee-staging.mjs --eval ../snapshot-runner/checks/sim-battle.js --out ../snapshot-runner/capture/oracle-sim-battle.json   # lab started
node ../snapshot-runner/bin/compare-battle.mjs ../snapshot-runner/capture/oracle-sim-battle.json ../snapshot-runner/results/sim-battle-sbx.json
```

**Result: the same battle.** Outcome, rounds, all 10 actions, all 13 resource writes and all 12 AE
adds are identical. The 11 AE removes are the same events in another order (≈): the
end-of-battle sweep deletes concurrently. ~9 min per side.

**How it became reproducible:** `seed` (default 1) pins the battle's randomness, and that took
more than seeding Math.random:
- **Visual code draws from Math.random too:** pseudo-animation scripts (eval'd, so their frames
  are `<anonymous>`), the theme, Sequencer, damage numbers, pixi, and the **3D stage (three.js)**,
  which the lab's client rendered and the runner's did not (156 draws in one battle). Those
  draws are timing-driven, so they get their own unseeded stream. Only the engine's draws
  (weightedPick, enemy-autopilot, initiative, apply_ae pools, chance rows, the sim's forced
  dice) use the seeded one. `traceDraws: true` logs every draw with its caller. In the matched
  run, all 97 engine draws came in the same order on both sides.
- **The Field reseeds its scene effects at `ready`.** On the real server that landed inside the
  battle window, so the check waits for it to settle first.

**Control:** the runner with `seed: 2` against the seed-1 referee (see below).

Order of the fixes that got it there: King Gorger missing (snapshot), no AEs on the
Hellhound (ActorDelta id), fake-io drawing ids from Math.random, visual draws in the
seeded stream, and the Field reseed race. Each one showed up as a battle that went
differently from the lab's.

## Next steps (not built)

- Referee `--full` / the `wide` golden on the runner.
- The skill-regression **simulate** golden on the runner (`check --runner --mode simulate`
  works mechanically; the bench-scale simulate referee has not been captured).

Control result (2026-11-03): the runner with `seed: 2` against the seed-1 referee → **red**,
3 problems. The 10 actions came out the same, but damage differs (Hellhound HP 76 vs 82),
Element Gorge rolled Ice instead of Earth, and there was one AE add / remove more.
So a different random stream plays a visibly different battle, and the comparison sees it.

## Drawing is the cost: `--canvas full|low|off` (2026-11-03)

A headless client draws with software GL, and on every test kind that, not the engine, was
nearly all of the wall time. `bin/canvas-mode.mjs` is used by `run.mjs` and `referee-staging.mjs`.
`off` is the default (as for every headless harness client, see `fvtt-playwright/lib/foundry.js` useCanvasMode); screenshots and PIXI extract still draw for real.

| test | full | low (0.25 res) | off (no drawing) |
|---|---|---|---|
| seeded 3-round sim battle | 641 s | 152–162 s | **32 s** |
| simulate, 66 duel skills (collector) | ~316 s | — | **38 s** (30 s of it is one interactive-skill timeout) |
| compute, 487 bench skills (collector) | 17 s | — | **6.5 s** (whole `check --runner` 35 s; boot ~20 s of it) |

- `off` keeps the PIXI ticker, so animations and the presentation clock still advance, and
  makes `renderer.render` a no-op.
- Simulate stays 66/66 identical to the referee at `off`.
- The battle at `off` matched in actions, resource writes and AE adds. It had ONE extra AE
  remove: Blanche's Counter Pass, an engine race fixed on 2026-11-03 (see "Time warp" below).
- Profile any battle: `checks/sim-battle-profile.js` gives time per FSM state, render ms,
  CSB `prepareData` ms, long tasks and event-loop lag.
- What is left is boot (~10–20 s per run), which is why a warm runner is the next lever.

## Time warp, viewport and `--fast` (2026-11-03)

Once the canvas stops drawing, what is left is waiting on timers, and painting the HTML UI in
software. Measured on the seeded 3-round battle; every run below was compared with the Staging
World's recording.

| run | wall | main-thread busy | vs referee |
|---|---|---|---|
| `--canvas off` | 31–33 s | 26 s | same battle except the Counter Pass race (below) |
| + `--time-warp 20` (timers ×20) | 23 s | 23 s | **same battle** |
| + `--warp-clocks` | 23 s | — | **same battle** (no extra gain) |
| + `--viewport 800x450` | **17.7 s** | 15.4 s | **same battle** |
| + `--viewport 400x225` | 15.5 s | 12.8 s | the Counter Pass race again |

- `--fast` = `--canvas off --time-warp 20 --viewport 800x450`. A battle that took 641 s takes ~18 s.
- JS itself is only ~1.5–2 s of the busy time. The rest is mostly painting the HTML UI in software,
  which is why a smaller page helps.
- **The one difference ever seen was an engine race, not the runner. Fixed 2026-11-03.** The sim
  stopped an over-budget battle from outside, from a 400 ms poll, while round 4's round_start
  reactions were still running. Blanche's Counter Pass refresh then raced the end-of-battle AE sweep:
  a slow client applied it after the sweep (residue), a fast one before (swept). Two engine fixes:
  - `boot.stop()` now halts the FSM and lets its current step finish BEFORE the sweep
    (`Director.halt`; queued intents are dropped after a stop). Any outside stop gets this.
  - A sim's round budget now ends the battle INSIDE the FSM, at ROUND_START, before anything of the
    new round runs, so where the battle ends no longer depends on client speed.
  - Re-refereed: the Staging World at `--canvas full` (763 s, the slowest client) and the runner
    at `--fast` (17.7 s) now play the same battle, with no Counter Pass granted at all.
    `capture/oracle-sim-battle.json` is that new recording; the old one is `.pre-race-fix.json`.

## Warm runner: one page, many tests (2026-11-03)

`bin/warm.mjs` keeps ONE runner page open and takes requests, so a test stops paying the ~20 s
boot. Between tests the world goes back to how it was right after boot (`www/warm.js`):

- fake-io now records the id of every document the page writes. Before each test, only those
  documents (with everything embedded in them) are diffed against the baseline and put back. The
  changes go in as a server-pushed `modifyDocument`, as if another user had made them, so Foundry
  and the module react the way they would in play. It repeats while hooks keep writing.
- **Code change** on disk (our module) → the next test reloads the page first (~15–20 s). Only a
  newer mtime counts: Windows reports files the page merely read as changed.
- **World-data change** on disk → the next test first re-reads the world (~5 s) and pushes only
  the changed documents; what Foundry makes of them becomes their new baseline. Anything outside
  the document collections (modules, packs) reloads the page. `--no-auto-sync` turns this off.
- `verify` diffs EVERY document against the baseline (the reset's own check).

```
# one daemon per profile (leave it running; it is the one headless client)
node ../snapshot-runner/bin/build-snapshot.mjs --profile duel --snapshot snap-w
node ../snapshot-runner/bin/warm.mjs start --snapshot snap-w --port 30108 --profile duel --fast
#   regression profile: add --bench (the Regression Bench is built once, in the baseline)

node ../snapshot-runner/bin/warm.mjs collect --port 30108 --skills "Provoke" --caster Blanche
node ../snapshot-runner/bin/warm.mjs collect --port 30108 --mode simulate --seed 1 --compare ../snapshot-runner/capture/oracle-simulate-duel.json
node ../snapshot-runner/bin/warm.mjs battle  --port 30108 --dump out.json      # battle profile
node ../snapshot-runner/bin/warm.mjs eval <check.js> | sync | reset | verify | reload | status | stop
```

Requests are served one at a time on the runner port + 1000. `collect` takes run.mjs's collector
flags plus `--skills` (names, uuids or "Caster / Skill"; a filtered run is compared only on the
keys it ran). `battle --sim-opts '{"seed":2}'` sets the battle's options for that request only.

- The control port listens before the page starts, and every request waits for the boot, so a
  caller that finds the daemon starting waits instead of launching its own headless client.
- Between requests the page is **quiet**: PIXI tickers and CSS animations stopped
  (`__warm.quiet()` / `wake()`) and the page frozen through CDP. Idle went from ~75% of one
  core to ~15–30%; the page holds ~1.4 GB. `--no-freeze` keeps it live.
- `--idle-exit <min>` makes the daemon leave after that many unused minutes.
- skill-regression's `check --runner` (and so the Stop hook) uses a warm runner of its own
  on :30103 / :31103, started by its first cold check; see the skill-regression README.

Validated against the existing referees, all in ONE page each, with resets between:

| test | warm | before (run.mjs) | vs referee |
|---|---|---|---|
| one skill, compute | **~0.7 s** wall (7 ms in page) | ~35 s | identical |
| one skill, simulate | **~0.7 s** wall (6–18 ms in page) | ~35 s | identical |
| 66 duel skills, simulate | 4.3 s | 38 s + boot | **66 / 66**; dice control 12 red |
| 487 bench skills, compute | **~1.1 s** wall (0.3–0.4 s in page) | 35–40 s | **487 / 487** vs oracle and golden; dice control 93 red |
| seeded 3-round sim battle | 14–15 s + 0.2 s reset | ~35 s | same battle, 6 times in a row |
| boot / code-change reload | 15–32 s (bench included) | every run | — |

Controls that prove the reset and the push can fail: a seed-2 battle → red; Hellhound's HP pushed
to 50 as changed world data → red, then pushed back → the same battle again. `verify` after each
series: 0 documents differ.

Traps found while building it:
- `sim-battle.js` reads `globalThis.__SIM_OPTS`, which outlives a request in a warm page: a seed-2
  control turned the next default battle into seed 2. `battle` now always sets it.
- The baseline is a JSON copy, so a key whose value is `undefined` in `_source`
  (`User.passwordSalt`) is an absent key, not a difference.
- A test that views another scene must find the baseline already on it, or every reset flips
  the scene back and costs the next test a scene load (the bench daemon bases on the bench).
- `build-snapshot`'s `place` minted random token ids, so every rebuild looked like a changed
  scene. They are now derived from the actor id.

Not covered: in-memory module state that is not a document (registries, caches) is not reset. The
referee runs above are the evidence that it does not leak between these tests; a new test kind
should repeat that (run it twice in one page, then compare with a fresh run.mjs).
