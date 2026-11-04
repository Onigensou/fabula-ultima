---
id: 2026-11-03-fast-test-tools-handoff
title: Hand-off — the fast test tools now ship (Snapshot Runner, warm runner, Staging World), plus the v1.0.516 battle-stop fix
status: open
severity: minor
reporter: sarunphat
assignee: onigensou
component: process/tooling (tools/snapshot-runner, tools/staging-world, tools/fvtt-playwright), battle-director
introduced_in:
fixed_in:
---

# Not a bug: a hand-off for the fast test tools

Written for onigensou, and for the Claude session that runs the pull. It covers what the new
tools are, the one-time setup, and the commands you will actually use. Close it as described
at the end.

## 1. What you get

Until now a skill test or a sim battle ran in the live world: about 30 s to reload, and
minutes per battle. Three tools, all in this repo now, run the same engine (Foundry + CSB +
our module) on a copy of the world instead, so they never touch your live world:

| Tool | What it is | Use it for |
|---|---|---|
| `tools/snapshot-runner` | The real client in a headless browser, with the **server faked**. The world is read from disk. | Skill logic, simulate, seeded sim battles, the regression check |
| `tools/snapshot-runner/bin/warm.mjs` | **The warm runner.** One runner page stays open and takes test after test. | Fast authoring loops |
| `tools/staging-world` | A slim copy of the world on its own **real** headless server (:30001). | The referee for the runner, and anything that needs a real server or several clients |
| `tools/fvtt-playwright` | The headless client both of them drive. | Shared plumbing |

The runner is only trusted where the Staging World agrees with it. Every number below was
checked against a Staging World recording ("the referee").

## 2. One-time setup (about 5 minutes)

```
cd tools/safe-edit && npm install                   # you may already have this (world-export)
cd tools/fvtt-playwright && npm install && npx playwright install chromium
copy config.local.example.json config.local.json    # then fill in: password, foundryExe, dataPath
```

`config.local.json` is the only file that holds your machine's paths and the GM password. It
is gitignored.

**Check that it works.** Run this from `tools/fvtt-playwright`, with the game closed or open
(the runner never opens your world):

```
node ../snapshot-runner/bin/build-snapshot.mjs --profile duel --snapshot snap-duel
node ../snapshot-runner/bin/run.mjs --snapshot snap-duel --port 30102 --fast --mode simulate --seed 1 --compare ../snapshot-runner/capture/oracle-simulate-duel.json
```

It should end with `"identical":66`. If it does not, see "If something is off" below before
trusting any result.

One side effect to know about: `tools/skill-regression`'s Stop hook already tries
`check --runner` whenever Foundry is closed. Until now it deferred on your machine because the
runner was missing. After this setup it will actually run (about 40 s per turn that edits engine
code).

## 3. How to use it

### Test one skill, fast: the warm runner

Start one daemon and leave it running. It is the one headless client.

```
node ../snapshot-runner/bin/warm.mjs start --snapshot snap-duel --port 30108 --profile duel --fast
```

Then, from another terminal, as often as you like:

```
node ../snapshot-runner/bin/warm.mjs collect --port 30108 --skills "Provoke" --caster Blanche
node ../snapshot-runner/bin/warm.mjs collect --port 30108 --mode simulate --seed 1 --skills "Muleta" --caster Blanche
node ../snapshot-runner/bin/warm.mjs stop --port 30108
```

- `collect` is the skill-regression collector: `compute` shows what the skill would do, and
  `simulate` also captures what it writes, with nothing committed.
- Add `--compare <reference.json>` to diff against a referee or a golden.
- Before each test, the warm runner puts the world back to how it was after boot.
- If you edit **module code**, the next test reloads the page by itself (~20 s).
- If you edit **world data** (author in your live world), the next test re-reads the world
  from disk and pushes in only the documents that changed (~5 s).

Use one daemon per profile:

| Profile | What it stages | Start flags |
|---|---|---|
| `duel` | Skills: the party against the dummy on Training Ground | — |
| `battle` | Sim battles: Training Ground, the party, Hellhound and Imp | — |
| `regression` | The whole catalog | add `--bench` (builds the Regression Bench once, at startup) |

### A whole seeded sim battle

```
node ../snapshot-runner/bin/build-snapshot.mjs --profile battle --snapshot snap-battle
node ../snapshot-runner/bin/warm.mjs start --snapshot snap-battle --port 30109 --profile battle --fast
node ../snapshot-runner/bin/warm.mjs battle --port 30109 --dump out.json
node ../snapshot-runner/bin/compare-battle.mjs ../snapshot-runner/capture/oracle-sim-battle.json out.json
```

### One-shot runs (no daemon)

`run.mjs` boots, runs one thing, then exits. Add `--fast` (no canvas drawing, timers ×20, a
small page) for any logic test.

### The Staging World (a real server)

```
node ../staging-world/bin/staging-world.mjs build && node ../staging-world/bin/staging-world.mjs start
FVTT_STAGING=1 node scripts/scenario-provoke.mjs
node ../staging-world/bin/staging-world.mjs stop
```

Never author in it: it is rebuilt from the live world. The full references are each tool's
README. The warm runner's section is "Warm runner" in `tools/snapshot-runner/README.md`.

## 4. How much faster

| Test | Before | Now |
|---|---|---|
| One skill, compute or simulate | ~35 s (one runner boot per run) | **~0.7 s** (warm) |
| Whole catalog, 487 skills, compute | 35–40 s (`check --runner`) | **~1 s** (warm, `regression --bench`) |
| 66 duel skills, simulate | ~5 min with the canvas drawing | **4.3 s** (warm) |
| Seeded 3-round sim battle | 641 s | **~15 s** (warm) / ~35 s (`run.mjs --fast`) |

Each result is identical to the referee: 487/487, 66/66, and the same battle six times in a
row in one page. Deliberate breakages (forced dice, another seed, an enemy pushed to half HP)
go red, so the comparison can still fail.

## 5. In the module: v1.0.516, a battle stopped from outside no longer leaves effects behind

Making slow and fast clients agree turned up a real engine race.

- **The race:** `api.stop()` cleared the battle's temporary effects while the director was
  still in the middle of a step. An effect granted by that step could land after the cleanup
  and survive the fight. This happened to Blanche's Counter Pass at the start of a sim's
  over-budget round.
- **The fix:**
  - `stop()` now halts the director and lets its current step finish first (`Director.halt`).
  - A sim battle past its round budget ends inside the director, at ROUND_START.
- **What did not change:** End Battle through the GM prompt was already ordered correctly.

`check --runner` gives 487/487 on v1.0.516.

## 6. If something is off

- `cannot find Foundry's resources/app`: set `foundryExe` in `config.local.json`, or set
  `FVTT_APP` to your `resources/app` folder.
- The setup check is not 66/66:
  - The referees were captured from this repo's world on Foundry 12.343. If your Foundry, CSB
    or module list differs, re-capture `shell/` (snapshot-runner README, "Setup on a new
    machine") and tell me.
  - A changed world (yours ahead of mine) also shows as differences. That is expected; re-run
    after you pull.
- Run **one headless client at a time**. Each one costs a lot of CPU in software rendering.

## Closing this

When the setup check reads 66/66 on your machine, set `status: verified`, add a line under
Notes, and push. If it does not, add what you saw under Notes and leave it open.

## Notes

- 2026-11-03 (sarunphat): **the automatic regression check now uses a warm runner.** With
  Foundry closed, the first `check --runner` (the Stop hook's) is a normal ~40 s cold run, and it
  leaves a warm runner behind on :30103 / :31103. After that, a check costs ~1 s when nothing
  changed, ~7 s after a world-data edit, and ~38 s after a module code edit (the page has to
  reload, the same as a cold run). Still 487/487. The runner idles quietly (~15–30% of one
  core, ~1.4 GB) and leaves after 30 unused minutes. `SKILL_REGRESSION_WARM=0` turns it off.
  Details: tools/skill-regression/README.md, "Game CLOSED".

- 2026-11-03 (sarunphat): **please fix your hook paths (2 lines, `.claude/settings.json`, not
  tracked).** If your two skill-regression hooks are written as `node tools/skill-regression/hooks/...`
  they fail with "Cannot find module" whenever your session is working in a subfolder, and fail
  silently. On my machine, over 7 days, 158 of 336 end-of-turn checks and 418 of 421 after-edit
  markers failed this way, so most engine edits were never checked. Change both commands to:

  ```
  node "$CLAUDE_PROJECT_DIR/tools/skill-regression/hooks/on-skill-edit.js"
  node "$CLAUDE_PROJECT_DIR/tools/skill-regression/hooks/regression-gate.js"
  ```

  Full snippet: tools/skill-regression/README.md, "Enforcement: auto-run after skill edits". After
  the change you will see more automatic checks, because they now actually run.

- 2026-11-04 (onigensou): **set up on our machine, still open.** playwright 1.60 + Chromium, and
  `config.local.json` with `foundryExe` + `dataPath` only (no password; `autoStartServer` off so nothing
  starts a real server on the live data path). The setup check cannot build here: `--profile duel` (and
  `rakshasa`) copies tokens from a saved "Regression Bench" scene, and our world never keeps one (our gate
  always builds the bench with `--teardown`), so build-snapshot stops at `place.from: no scene "Regression
  Bench"`. What we ran instead, on a copy of our world: `check --runner` 487/487, and a whole-world parity
  of your six update switches on vs off (see the update-stutter hand-off). Could the duel profile build its
  bench in the page, the way `--profile regression` does? Leaving this open until the 66/66 check can run.
