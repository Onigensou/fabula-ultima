# fvtt-playwright

Playwright **control-plane** harness for driving Foundry VTT (Fabula Ultima) gameplay tests.

## Why this exists

The file-IPC test-bridge is great for in-world reads/writes, but it can't do
browser-level things, and those are exactly the inconsistencies that hurt:

| Pain point | Bridge | This harness |
|---|---|---|
| Read data from the browser | file IPC + polling (racy) | `evaluate()` — synchronous, same page context as `evalGM` |
| F5 / refresh + ESM-cache bust | can't (reload doesn't bust ESM cache) | `hardReload()` — cache disabled at launch ⇒ true Ctrl+Shift+R |
| Restart world | can't drive `/setup` + `/join` | `connect()` walks setup → launch world → join |
| Blocking HUD/dialog button | racy `querySelector().click()` | Playwright auto-wait + actionable click |

It does **not** replace the director harness or the bridge for game *logic* —
you still call `FUCompanion.api.test.*` for mechanics. Playwright is the
orchestration around it.

## Setup (one time)

```powershell
cd tools\fvtt-playwright            # from your Foundry Data folder
npm install
npx playwright install chromium     # downloads the browser
Copy-Item config.local.example.json config.local.json
# then edit config.local.json and put in the GM password
```

`config.local.json` is gitignored — your password never gets committed. Every
field can also be supplied via env var (`FVTT_PASSWORD`, etc.).

## Starting the server (headless by default)

`connect()` boots the server itself when nothing is listening (`autoStartServer`),
or drive it by hand:

```powershell
node scripts/start-server.mjs              # headless node server (default)
node scripts/start-server.mjs --electron   # desktop GUI app instead
node scripts/stop-server.mjs               # only kills a headless server
node scripts/stop-server.mjs --force       # also kills the desktop app
```

Two launchers, set by `launcher` in `config.local.json` (or `FVTT_LAUNCHER`):

| | processes | RSS | window |
|---|---|---|---|
| `node` (default) | 1 | ~94 MB | none |
| `electron` | 5 | ~551 MB | yes |

**`node` is the default** because the harness brings its own Chromium — a desktop
window is dead weight, and the renderer it spawns is a TDR-BSOD risk on this
machine. It runs Foundry's `main.js` from the *existing desktop install's*
`resources/app` with the system Node; no separate download is needed. It also
starts from **any** process context, including the sandboxed Bash tool — the
electron launcher still requires an interactive shell.

Two things to know:

- A headless server **owns the port**, so the desktop app can't bind it
  afterwards. Run `stop-server.mjs` to hand the port back.
- `stop-server.mjs` **refuses to kill the Electron app** without `--force` — that
  is usually the human's live session, and a blind kill-by-port would yank a
  LevelDB writer out from under an open world.

`--port` / `--noupnp` are runtime-only (verified: `Config/options.json` is
byte-identical after a boot+shutdown), so they never mutate saved config.

## Run

Make sure the Foundry **server is running** on `baseURL` (the harness drives the
browser, not the server). Then:

```powershell
npm run smoke
```

`smoke.mjs` connects, reads world + canvas state, lists the director test
fixtures, dismisses any blocking dialog, hard-reloads, and saves a screenshot to
`shots/smoke.png`.

## Canvas drawing: `FVTT_CANVAS=full|low|off` (2026-11-03)

A **headless** client now draws **nothing** by default (`off`): the canvas renderer is a no-op
while the PIXI ticker keeps running (token animations, Foundry's CanvasAnimation, the battle
director's presentation clock). The reason: software GL was ~95% of a headless run. A seeded
3-round sim battle took 641 s drawing as the game does, 152 s at `low` (0.25 resolution) and
32 s at `off`, and came out the same battle every time.

- **Captures stay exact.** `page.screenshot()` (direct or `fvtt.screenshot()`) draws for real,
  at the real resolution, for the capture, then turns drawing off again. PIXI
  `renderer.extract.*` renders one real frame first (lighting and vision are drawn into
  intermediate textures during the main render) and extracts at the real resolution.
  Proven by `scripts/canvas-mode-test.mjs` (8 checks; run it with `FVTT_STAGING=1`).
- **An existing script, unchanged** (`scenario-provoke.mjs`, bridge-driven, on the Staging World):
  65 s with the host not drawing vs 865 s drawing. The drawing run hit the scenario's 14-min cap, and
  every assertion that ran passed in both.
- Bridge clients (`scripts/bridge.mjs`, `skill-regression/lib/bridge.js`, `test-bridge-client`) now honour
  `FVTT_STAGING=1`. Before, a script that never called `loadConfig()` wrote to the LIVE world's bridge.
- The mode survives reloads. Change it mid-script with `fvtt.setCanvas("full")`.
- `FVTT_CANVAS=full` draws as before. A visible window (`FVTT_HEADLESS=false`) or `FVTT_GPU=true`
  defaults to `full`.
- ⚠ Anything that reads the drawn canvas some other way (an extract with NO target object, a
  WebGL `readPixels`, a frame-rate measurement) needs `FVTT_CANVAS=full`.

## Use it in your own script

```js
import { connect } from "../lib/foundry.js";

const fvtt = await connect();
try {
  // logic: call the director harness over the wire
  const res = await fvtt.harness("runDirectorSkillSimulate", { skillUuid, casterTokenUuid, targetTokenUuids });

  // canvas/PIXI: read scene-graph state, no pixels
  const tint = await fvtt.evaluate(() =>
    canvas.tokens.placeables.find(t => t.name === "Test Target Enemy")?.mesh?.tint);

  // edit a cross-module file, then a TRUE hard reload to bust the ESM cache
  await fvtt.hardReload();

  await fvtt.screenshot("after.png");
} finally {
  await fvtt.close();
}
```

## Caveats

- **Single-session lock.** Foundry allows one session per world. This harness
  owns the browser it launches — don't have `fabula-ultima-2` open manually in
  another client at the same time.
- **Server lifecycle.** The harness assumes the Foundry server process is
  already up. Starting/stopping the server is out of scope (add it if you want
  fully-headless CI).
- **Selectors are Foundry v12-specific** (`coreVersion 12.343`). If you upgrade
  Foundry core, re-check the `/setup` and `/join` selectors in `lib/foundry.js`.
