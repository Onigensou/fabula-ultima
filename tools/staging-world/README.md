# staging-world — the Staging World: a real world on a real server, for refereeing and multiplayer

**Purpose:** a slim, disposable copy of the live world on its own Foundry server (:30001).
Use it as the real-engine **referee** for the Snapshot Runner (`tools/snapshot-runner`), and
for anything that needs a real server: several clients, a human player, socket broadcasts,
state that must persist across reloads. Named the "Battle Lab" until 2026-11-03.

The live world sends **~134 MB** to every client on each load and takes **~27–30 s**
to reload (measured 2026-11-02). About 80 % of that scales with world size:
the server packing the data, the browser decoding it, and CSB preparing 321
actors, 154 scenes and 1,936 items. The battle system needs only a small part
of that.

`staging-world` builds `worlds/staging-world/`, a **disposable copy** of the live world
that keeps the full battle stack (all items, macros, tables, journals, settings,
users, CSB templates, the party, test fixtures, a few enemies and Training
Ground) and drops the rest. It runs on **its own headless server on :30001**, so
it can be up while your real world is open on :30000.

| | live world | Staging World |
|---|---|---|
| world payload | 134 MB | ~37 MB |
| GM reload (headless client) | ~27.5 s | ~11.8 s |
| server start + world launch | ~9 s + launch via /setup | ~9 s total (world auto-launches) |
| actors / scenes | 321 / 154 | ~56 / 1 |

## Commands

```
node tools/staging-world/bin/staging-world.mjs plan     # what would be copied, and why (no writes)
node tools/staging-world/bin/staging-world.mjs build    # (re)build worlds/staging-world (~2 s)
node tools/staging-world/bin/staging-world.mjs start    # headless staging server on :30001
node tools/staging-world/bin/staging-world.mjs stop     # stop it (only ever kills the Staging World's own process)
node tools/staging-world/bin/staging-world.mjs status
```

`build` refuses while the staging server is running (it holds the Staging World's LevelDB
lock): `stop` → `build` → `start`. It reads the live world from a **temporary
file copy**, so it works with the real world open or closed and can never write
to it. Rebuild whenever the live world has changed in a way your test needs.

## Driving it

Every fvtt-playwright script works against the Staging World with one env var:

```
FVTT_STAGING=1 node tools/fvtt-playwright/scripts/<script>.mjs
```

`FVTT_STAGING=1` sets the base URL (:30001), world id, and dataPath, and points the
bridge clients at `worlds/staging-world/test-bridge/`. The bridge clients
(`fvtt-playwright/scripts/bridge.mjs`, `test-bridge-client/bridge-eval.mjs`,
`skill-regression/lib/bridge.js`) also accept `FVTT_WORLD=staging-world` directly.
The bridge boots dormant as usual: call `FUCompanion.api.testBridge.start()`
(as `_hold-bridge.mjs` does) before using it.

A human can open it too: browse to <http://localhost:30001> and log in.

## What gets copied (staging.config.json)

- **Whole collections:** items, folders, journal, macros, tables, playlists,
  cards, settings, users (CSB per-user UI state pruned to the docs the Staging World has).
  World packs are copied.
- **Scenes:** `scenes` (Training Ground). The `activeScene` is made the only
  active scene, every user views it, and stale `directorState` is stripped.
- **Actors:** CSB templates (`_template`), the `Field` actor, the `Template` /
  `UI` / `Companion` folders, the named actors, **plus everything they reference
  by id** (followed to a fixpoint) from settings, kept actors, kept scenes and
  **ids hard-coded in module code** (db-resolver's Current Game, boss scripts…).
  `plan` prints the reason each actor came along.
- **Left out:** the other actors and scenes, chat messages, combats, fog.

Users are NOT followed for references: CSB stores per-document sheet state on
each user, so following them pulls in almost every actor (292 of 321).

To add an enemy or scene for a test, edit `actors.names` / `scenes` in
`staging.config.json` and rebuild. `maxActors` (80) stops the build if a new
reference drags in half the world.

## Rules

- The Staging World is **disposable**. Nothing in it flows back to the live world, and it
  must never be committed (`/worlds/*` is already gitignored; only
  `fabula-ultima-2` is un-ignored). Author content in the live world, then
  rebuild the Staging World.
- Lab writes are free: test residue (AEs, clones, bestiary pages) stays in the
  lab and is wiped by the next `build`.
- Results are only as good as the copy: anything the Staging World left out reads as
  "not found". If a test fails in the Staging World, check that the doc it needs is in
  `worlds/staging-world/STAGING-MANIFEST.json` before blaming the code.

## How the server side works

`start` creates `../staging-server/` next to `Data/` (outside the repo):
`Config/license.json` (copied), `Config/options.json` (port 30001,
`world: staging-world` so the world launches on boot, `compressSocket: false`
since it is localhost-only), and `Data` as a **junction to the real `Data/`**.
Both servers therefore serve the same modules and systems, so a code edit is
live in both; each server only locks its own world's LevelDB.
`stop` kills only a `foundry-node` process whose command line names
`staging-server`, then removes the stale `options.json.lock` a killed server leaves.

## Test + measurement scripts (kept here)

Run from `tools/fvtt-playwright` so Playwright resolves; prefix `FVTT_STAGING=1` for the Staging World.

- `profile-boot.mjs <outDir>` — where a GM reload spends its time: phase marks, per-hook
  handler times, the `world` socket message size, resource buckets, plus a CDP CPU profile
  split by phase (`boot.cpuprofile` opens in Chrome DevTools → Performance).
  `node ../staging-world/callers.cjs <outDir>/boot.cpuprofile` attributes hot functions to callers.
- `staging-battle-test.mjs <outDir>` — connect, then a real hands-free battle (sim `testSkill`,
  Blanche Provoke vs Hellhound) with screenshots of the battle UI and a console-error tally.
- `staging-harness-test.mjs` — director harness compute + simulate. **It places the three test
  fixture tokens on Training Ground first** — the live world's Training Ground has none, so
  `getDirectorTestFixtures()` returns no token uuids there (true in the live world too). Staging World only:
  it also writes to Training Ground.

Results from the 2026-11-02 build are in `results/` (`prof1` = live world, `prof-lab1` = lab,
`bt-lab2` = lab battle run, `lab-test-lab-1.png` = the battle desk mid-fight in the Staging World).
