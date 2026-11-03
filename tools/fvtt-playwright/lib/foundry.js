// Playwright control-plane harness for Foundry VTT (v12).
//
// Why this exists: the file-IPC test-bridge can't do browser-level things —
// hard-reload-with-cache-bust (the Ctrl+Shift+R / ESM-cache gotcha), driving
// the /setup + /join screens (world restart), reliable auto-waiting clicks on
// blocking HUD/dialog DOM, and synchronous reads. Playwright does all of that.
//
// Division of labor (unchanged from the bridge era):
//   - Game LOGIC  -> FUCompanion.api.test.* harness, called via page.evaluate().
//   - Canvas/PIXI -> read canvas.tokens / canvas.stage via page.evaluate().
//   - Visuals     -> page.screenshot() (captures WebGL) or PIXI extract.
// Playwright is the CONTROL PLANE around those, not a replacement for them.

import { chromium } from "playwright";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { ensureServerUp } from "./server.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

/** Load config.local.json, then layer env-var overrides on top. */
export function loadConfig() {
  const path = resolve(ROOT, "config.local.json");
  let cfg = {};
  if (existsSync(path)) {
    cfg = JSON.parse(readFileSync(path, "utf8"));
  } else {
    console.warn(
      `[fvtt] no config.local.json found at ${path} — relying on env vars / defaults.`
    );
  }
  const env = process.env;
  const out = {
    baseURL: env.FVTT_BASE_URL ?? cfg.baseURL ?? "http://localhost:30000",
    world: env.FVTT_WORLD ?? cfg.world ?? "fabula-ultima-2",
    user: env.FVTT_USER ?? cfg.user ?? "GM",
    password: env.FVTT_PASSWORD ?? cfg.password ?? "",
    adminKey: env.FVTT_ADMIN_KEY ?? cfg.adminKey ?? "",
    headless: env.FVTT_HEADLESS ? env.FVTT_HEADLESS === "true" : cfg.headless ?? false,
    slowMo: Number(cfg.slowMo ?? 0),
    readyTimeoutMs: Number(cfg.readyTimeoutMs ?? 120000),
    // Opt-in CDP Network domain (cache-disable). Off by default — see launch().
    cdpNetwork: env.FVTT_CDP_NETWORK ? env.FVTT_CDP_NETWORK === "true" : cfg.cdpNetwork ?? false,
    // Server auto-start (lib/server.js): boot Foundry if it's down before connecting.
    autoStartServer: env.FVTT_AUTOSTART ? env.FVTT_AUTOSTART === "true" : cfg.autoStartServer ?? true,
    // "node" = headless server (1 proc, ~94 MB, no GPU/renderer) — the default,
    // since the harness supplies its own Chromium. "electron" = desktop GUI app
    // (5 procs, ~551 MB), for when a human wants a window. See lib/server.js.
    launcher: env.FVTT_LAUNCHER ?? cfg.launcher ?? "node",
    foundryExe: env.FVTT_EXE ?? cfg.foundryExe ?? "",
    // Server entry point; derived from foundryExe when blank (node launcher).
    foundryMain: env.FVTT_MAIN ?? cfg.foundryMain ?? "",
    dataPath: env.FVTT_DATA_PATH ?? cfg.dataPath ?? "",
    // Skip UPnP router mapping on the headless server (runtime-only flag).
    noupnp: cfg.noupnp ?? true,
    serverStartTimeoutMs: Number(cfg.serverStartTimeoutMs ?? 120000),
    // LITE (2026-10-14): cap the canvas at FVTT_LITE_FPS (default 10) and take the
    // lowest performance mode after ready. Two software-GL clients drawing an
    // uncapped battle took ~80% of the user's CPU and crashed the GM page. Use it
    // for any multi-client run; off by default so timing probes keep full speed.
    lite: env.FVTT_LITE ? env.FVTT_LITE === "true" : cfg.lite ?? false,
    liteFps: Number(env.FVTT_LITE_FPS ?? cfg.liteFps ?? 10),
    // CANVAS DRAWING (2026-11-03): full | low | off — see useCanvasMode(). null = the
    // default: OFF for a headless software-GL client, FULL for a visible window or GPU.
    canvas: env.FVTT_CANVAS ?? cfg.canvas ?? null,
  };
  // FVTT_STAGING=1: target the Staging World (tools/staging-world) — its own headless server
  // on :30001, its own dataPath, world auto-launched. Explicit FVTT_* vars still win.
  // FVTT_LAB is the name it had while this was the "Battle Lab" (until 2026-11-03).
  if ([env.FVTT_STAGING, env.FVTT_LAB].some((v) => v === "1" || v === "true")) {
    const lab = JSON.parse(readFileSync(resolve(ROOT, "../staging-world/staging.config.json"), "utf8"));
    out.baseURL = env.FVTT_BASE_URL ?? `http://localhost:${lab.port}`;
    out.world = env.FVTT_WORLD ?? lab.worldId;
    out.dataPath = env.FVTT_DATA_PATH ?? resolve(ROOT, "../../../staging-server");
    out.launcher = "node";
    process.env.FVTT_WORLD ??= lab.worldId;   // so the bridge clients pick the Staging World's test-bridge too
  }
  out.baseURL = out.baseURL.replace(/\/+$/, "");
  return out;
}

/** Launch Chromium with HTTP cache DISABLED — this is what makes hardReload() a true hard reload. */
export async function launch(cfg) {
  // ⚠ OPT-IN ONLY — see the TDR hazard note below. A headless page is never
  // "visible", so Chromium clamps its timers to ~1/sec and deprioritises the
  // renderer. That poisons timing measurements (an idle 100ms drift monitor
  // reads ~800ms of drift purely from the clamp), so `noThrottle` exists to turn
  // the three background policies off for a measurement run.
  //
  // It is OFF BY DEFAULT because it also lets PIXI render unthrottled: a
  // "backgrounded" Foundry client then pegs a GPU/CPU core continuously
  // (measured 97.8% main-thread busy while idle). On this machine that load
  // provokes a pre-existing VIDEO_TDR_ERROR (0x116) GPU-driver bugcheck — a
  // fault that predates this tool by months, but which multiple concurrent
  // WebGL renderers reliably trigger. Only enable it for a short measured run,
  // and never with several clients connected at once.
  const noThrottle = process.env.FVTT_NO_THROTTLE === "true" || cfg.noThrottle === true;
  // SOFTWARE GL BY DEFAULT (2026-09-28): two machine restarts in one night while a
  // single headless client + authoring agents ran. Headless Chromium on Windows
  // still drives the real GPU through ANGLE/D3D11, and that is the TDR trigger
  // class. SwiftShader gives WebGL on the CPU only — slower canvas, zero GPU.
  // Opt back into the GPU with FVTT_GPU=true (or cfg.gpu) for a short visual run.
  const useGpu = process.env.FVTT_GPU === "true" || cfg.gpu === true;
  // chrome-headless-shell falls back to SwiftShader unless --enable-gpu is passed
  // (measured 2026-10-31: [] -> SwiftShader, ["--enable-gpu"] -> RTX 3060 Ti / D3D11).
  const gpuArgs = useGpu ? ["--enable-gpu"] : ["--disable-gpu", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"];
  const browser = await chromium.launch({
    headless: cfg.headless,
    slowMo: cfg.slowMo,
    args: [
      ...gpuArgs,
      ...(noThrottle ? [
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
      ] : []),
    ],
  });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await context.newPage();
  const client = await context.newCDPSession(page);
  // CDP-flood hypothesis (2026-06-06): the FU world boot historically crashed the
  // pipe transport with ERR_STRING_TOO_LONG (>512MB single CDP frame at
  // game.ready). The Network domain is the only CDP feature we turn on, and a
  // Network domain firehose during the world-data load is the prime suspect.
  // Our scripts already cache-bust per dynamic import (`?cb=Date.now()`), so
  // ESM freshness does NOT require Network.setCacheDisabled. Default to NOT
  // enabling the Network domain; opt back in with FVTT_CDP_NETWORK=true if a
  // true full-page hardReload (vs per-import bust) is ever needed.
  if (cfg.cdpNetwork) {
    await client.send("Network.enable");
    await client.send("Network.setCacheDisabled", { cacheDisabled: true });
  }
  return { browser, context, page, client };
}

// ── Canvas drawing: full | low | off ────────────────────────────────────────
// A headless client draws with software GL (SwiftShader), and that, not the game,
// is where a headless run's time goes. Measured 2026-11-03 on a seeded 3-round sim
// battle (tools/snapshot-runner/checks/sim-battle-profile.js): 641 s drawing as the
// game does, 99% of it main-thread long tasks at ~one per frame; 152 s at 0.25
// resolution; 32 s with no drawing. CSB data prep was ~1%. The battle came out the
// same in every mode: drawing changes no rules.
//
//   full  draw as the game does
//   low   the canvas at 0.25 resolution (a 16th of the pixels)
//   off   no canvas drawing: the PIXI ticker still runs (token animations, Foundry's
//         CanvasAnimation, our presentation clock), only renderer.render is a no-op
//
// Captures stay exact in every mode. page.screenshot() switches to real drawing at
// the real resolution for the capture (a couple of frames) and back, and PIXI
// renderer.extract.* renders through the real render() at the real resolution. So
// a screenshot or a pixel measurement is never of a blank or a low-res canvas.
// The mode survives reloads (an init script re-applies it on every navigation).
export const CANVAS_MODES = ["full", "low", "off"];

/** Runs IN THE PAGE (init script + evaluate). Self-contained on purpose. */
function installCanvasMode(argMode) {
  const KEY = "fvttCanvasMode";
  let mode = argMode;
  try { mode = sessionStorage.getItem(KEY) ?? argMode; sessionStorage.setItem(KEY, mode); } catch { /* */ }
  const S = (globalThis.__fvttCanvas ??= {});
  S.mode = mode;
  if (!S.installed) {
    S.installed = true;
    const LOW = 0.25;
    const fit = (r) => { try { r.resize(globalThis.innerWidth, globalThis.innerHeight); } catch { /* */ } };
    S.apply = () => {
      const r = globalThis.canvas?.app?.renderer;
      if (!r) return false;
      if (!r.__fvttReal) {
        r.__fvttReal = { render: r.render, resolution: r.resolution };
        const ex = r.extract;
        for (const k of ["image", "base64", "canvas", "pixels"]) {
          if (typeof ex?.[k] !== "function") continue;
          const orig = ex[k].bind(ex);
          ex[k] = (...a) => {
            const prev = { render: r.render, resolution: r.resolution };
            r.render = r.__fvttReal.render;
            // One real frame first, at the real size: Foundry draws lighting / vision /
            // occlusion into intermediate render textures DURING the main render, so with
            // drawing off those are stale and an extract reads a darker, out-of-date stage.
            if (r.resolution !== r.__fvttReal.resolution) { r.resolution = r.__fvttReal.resolution; fit(r); }
            try { globalThis.canvas?.app?.render?.(); } catch { /* */ }
            const back = () => {
              r.render = prev.render;
              if (r.resolution !== prev.resolution) { r.resolution = prev.resolution; fit(r); }
            };
            try { const v = orig(...a); if (v && typeof v.then === "function") return v.finally(back); back(); return v; }
            catch (e) { back(); throw e; }
          };
        }
      }
      const real = r.__fvttReal;
      if (S.mode === "full") {
        r.render = real.render;
        if (r.resolution !== real.resolution) { r.resolution = real.resolution; fit(r); }
      } else {
        if (r.resolution !== LOW) { r.resolution = LOW; fit(r); }
        r.render = S.mode === "off" ? function () {} : real.render;
      }
      return true;
    };
    // Real drawing for a capture; resolves after two frames have been drawn.
    S.enterCapture = async () => {
      const r = globalThis.canvas?.app?.renderer;
      if (!r?.__fvttReal) return false;
      r.render = r.__fvttReal.render;
      if (r.resolution !== r.__fvttReal.resolution) { r.resolution = r.__fvttReal.resolution; fit(r); }
      const frames = Number(S.captureFrames ?? 6);
      for (let i = 0; i < frames; i++) await new Promise((res) => requestAnimationFrame(() => res()));
      return true;
    };
    const hook = () => { try { Hooks.on("canvasReady", () => S.apply()); return true; } catch { return false; } };
    if (!hook()) { const t = setInterval(() => { if (hook()) clearInterval(t); }, 200); }
  }
  if (!S.apply()) { const t = setInterval(() => { if (S.apply()) clearInterval(t); }, 200); }
  const r = globalThis.canvas?.app?.renderer;
  return { mode: S.mode, applied: !!r?.__fvttReal, resolution: r?.resolution ?? null, rendering: S.mode !== "off" };
}

/** Set how much this page's canvas draws (full | low | off). Safe to call again to change it. */
export async function useCanvasMode(page, mode) {
  if (!CANVAS_MODES.includes(mode)) throw new Error(`canvas mode must be one of ${CANVAS_MODES.join("|")}, got "${mode}"`);
  if (!page.__fvttCanvas) {
    page.__fvttCanvas = { mode };
    await page.addInitScript(installCanvasMode, mode);
    const shot = page.screenshot.bind(page);
    page.screenshot = async (opts) => {
      if (page.__fvttCanvas.mode === "full") return shot(opts);
      await page.evaluate(() => globalThis.__fvttCanvas?.enterCapture?.()).catch(() => {});
      try { return await shot(opts); }
      finally { await page.evaluate(() => globalThis.__fvttCanvas?.apply?.()).catch(() => {}); }
    };
  }
  page.__fvttCanvas.mode = mode;
  await page.evaluate((m) => { try { sessionStorage.setItem("fvttCanvasMode", m); } catch { /* */ } }, mode).catch(() => {});
  return page.evaluate(installCanvasMode, mode);
}

/** The mode a client gets when nobody chose one. */
export function defaultCanvasMode(cfg) {
  const gpu = process.env.FVTT_GPU === "true" || cfg.gpu === true;
  return cfg.headless && !gpu ? "off" : "full";
}

/** Lite client: cap the canvas frame rate and drop to the lowest performance mode. */
export async function applyLite(page, fps = 10) {
  await page.evaluate(async (fps) => {
    try { await game.settings.set("core", "performanceMode", CONST.CANVAS_PERFORMANCE_MODES.LOW); } catch { /* */ }
    try { await game.settings.set("core", "maxFPS", fps); } catch { /* */ }
    try { canvas.app.ticker.maxFPS = fps; } catch { /* */ }
    // Monk's Player Settings asks a fresh browser to sync with the account's saved
    // client settings. Close it WITHOUT answering: Yes/No/Ignore all write to the
    // real user's account flags.
    for (let i = 0; i < 12; i++) {
      const w = Object.values(ui.windows).find((a) => a.title === "Data Sync");
      if (w) { try { await w.close(); } catch { /* */ } break; }
      await new Promise((r) => setTimeout(r, 250));
    }
  }, fps);
}

/** Wait until Foundry's game object reports ready (canvas + documents loaded). */
export async function waitReady(page, cfg) {
  await page.waitForFunction(() => globalThis.game?.ready === true, null, {
    timeout: cfg.readyTimeoutMs,
  });
}

/** Detect which Foundry screen we're on. */
async function detectScreen(page) {
  return page.evaluate(() => {
    if (document.querySelector('select[name="userid"]')) return "join";
    if (document.querySelector('input[name="adminPassword"]')) return "auth";
    if (document.querySelector('#worlds-list, section[data-tab="worlds"], li.package[data-package-id]'))
      return "setup";
    if (globalThis.game?.ready === true || document.querySelector("#board")) return "game";
    return "unknown";
  });
}

/** If the setup screen demands the admin access key, supply it. No-op otherwise. */
async function passAdminAuthIfPresent(page, cfg) {
  const input = page.locator('input[name="adminPassword"]');
  if ((await input.count()) === 0) return;
  if (!cfg.adminKey) {
    throw new Error(
      "[fvtt] /setup is asking for an admin access key but config.adminKey is empty."
    );
  }
  await input.fill(cfg.adminKey);
  await page.locator('button[type="submit"], button[name="adminAuth"]').first().click();
  await page.waitForLoadState("domcontentloaded");
}

/** On the /setup screen, launch the configured world and wait for the /join redirect. */
async function launchWorldFromSetup(page, cfg) {
  await passAdminAuthIfPresent(page, cfg);

  const tile = page.locator(`li.package[data-package-id="${cfg.world}"]`);
  await tile.waitFor({ state: "visible", timeout: 30000 });

  // v12's "Backups Overview" TOUR overlay sits above the package list and
  // swallows pointer events. `click({force:true})` skips actionability checks
  // but still dispatches a real mouse event at coordinates, so the overlay
  // still eats it and this hangs until the /join timeout. Exit the tour, drop
  // the overlay nodes, then dispatch the click in-page (no coordinates, so
  // nothing can intercept it). This is what scripts/launch-world-js.mjs did as
  // a standalone workaround.
  const clicked = await page.evaluate((worldId) => {
    try { globalThis.game?.tours?.active?.exit?.(); } catch {}
    document.querySelectorAll(".tour-fadeout, .tour-overlay, #tooltip.tour").forEach((n) => n.remove());
    const btn = document.querySelector(
      `li.package[data-package-id="${worldId}"] [data-action="worldLaunch"]`);
    if (!btn) return false;
    btn.click();
    return true;
  }, cfg.world);

  // Fall back to the pointer click only if the in-page control wasn't found.
  if (!clicked) {
    const playBtn = tile.locator('a[data-action="worldLaunch"], a.control.play, button[data-action="worldLaunch"]').first();
    await playBtn.click({ force: true });
  }

  // A confirmation dialog can appear (e.g. system migration / "launch anyway").
  // Click any visible primary confirm if present, but don't fail if there isn't one.
  try {
    await page.locator('button.yes, button[data-button="yes"], .dialog button.default').first()
      .click({ timeout: 4000 });
  } catch { /* no dialog — normal path */ }

  await page.waitForSelector('select[name="userid"]', { timeout: 60000 });
}

/** On the /join screen, select the user, enter the password, and join. */
async function joinAsUser(page, cfg) {
  const userSelect = page.locator('select[name="userid"]');
  await userSelect.waitFor({ state: "visible", timeout: 30000 });
  await userSelect.selectOption({ label: cfg.user });

  if (cfg.password) {
    await page.locator('input[name="password"]').fill(cfg.password);
  }
  await page.locator('button[name="join"]').click();
}

/**
 * Full connect: launch browser -> reach game -> ensure world active -> login -> wait ready.
 * Returns a handle with convenience helpers bound to the page.
 */
export async function connect(overrides = {}) {
  const cfg = { ...loadConfig(), ...overrides };

  // Closed -> open autonomy: if no server is listening, boot one before we try
  // to drive the browser. No-op when a server (the human's, or a prior run's)
  // is already up. Opt out with autoStartServer:false / FVTT_AUTOSTART=false.
  if (cfg.autoStartServer) {
    const { started } = await ensureServerUp(cfg);
    if (started) console.log(`[fvtt] started Foundry server at ${cfg.baseURL}`);
  }

  const { browser, context, page, client } = await launch(cfg);

  page.on("pageerror", (e) => console.error("[page error]", e.message, process.env.FVTT_STACK ? (e.stack ?? "").split("\n").slice(0, 6).join(" | ") : ""));

  await page.goto(cfg.baseURL, { waitUntil: "domcontentloaded" });

  // Walk whatever screen we land on through to a ready game.
  for (let i = 0; i < 6; i++) {
    const screen = await detectScreen(page);
    if (screen === "game") break;
    if (screen === "auth") { await passAdminAuthIfPresent(page, cfg); continue; }
    if (screen === "setup") { await launchWorldFromSetup(page, cfg); continue; }
    if (screen === "join") {
      await joinAsUser(page, cfg);
      await waitReady(page, cfg);
      break;
    }
    await page.waitForTimeout(1000); // "unknown" — let the SPA settle, re-detect
  }
  await waitReady(page, cfg);
  if (cfg.lite) await applyLite(page, cfg.liteFps);
  const canvasMode = cfg.canvas ?? defaultCanvasMode(cfg);
  if (canvasMode !== "full") {
    const st = await useCanvasMode(page, canvasMode);
    console.log(`[fvtt] canvas drawing: ${st.mode}${cfg.canvas ? "" : " (headless default)"} — FVTT_CANVAS=full to draw; screenshots and PIXI extract always draw for real`);
  }

  const handle = {
    cfg,
    browser,
    context,
    page,
    client,
    /** Run a function in the page (same context as the bridge's evalGM). Must return serializable data. */
    evaluate: (fn, arg) => page.evaluate(fn, arg),
    /** True hard reload: cache is already disabled, so modules re-fetch fresh. */
    hardReload: () => hardReload(page, cfg),
    /** Viewport screenshot (captures the WebGL canvas, drawn for real whatever the canvas mode). */
    screenshot: (name) => screenshot(page, name),
    /** Change how much the canvas draws: "full" | "low" | "off" (survives reloads). */
    setCanvas: (mode) => useCanvasMode(page, mode),
    /** Call FUCompanion.api.test.<method>(args) in the page and return the result. */
    harness: (method, args) =>
      page.evaluate(
        ({ m, a }) => {
          const api = globalThis.FUCompanion?.api?.test;
          if (!api?.[m]) throw new Error(`FUCompanion.api.test.${m} is not available`);
          return api[m](a);
        },
        { m: method, a: args }
      ),
    close: async () => {
      // director stop() clears the scenes' saved battle state WITHOUT awaiting it.
      // Closing at once dropped that write, so the next GM load resumed the
      // stopped battle (and re-created its tokens). Give it up to 5 s to land.
      try {
        await page.evaluate(async () => {
          const ns = "fabula-ultima-companion";
          if (globalThis.FUCompanion?.api?.experimental?.battleDirector?.isRunning?.()) return;
          for (let i = 0; i < 20; i++) {
            if (!game.scenes.some((s) => s.getFlag(ns, "directorState"))) return;
            await new Promise((r) => setTimeout(r, 250));
          }
        });
      } catch { /* page already gone */ }
      await browser.close();
    },
  };
  return handle;
}

/** Reload the page (cache already disabled at launch) and wait for game ready. */
export async function hardReload(page, cfg = loadConfig()) {
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitReady(page, cfg);
}

/** Save a viewport screenshot under shots/ and return its absolute path. */
export async function screenshot(page, name = "shot.png") {
  const dir = resolve(ROOT, "shots");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = resolve(dir, name);
  await page.screenshot({ path });
  return path;
}
