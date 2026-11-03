// Smoke test: proves the four things the bridge does inconsistently.
//   1. Read data from the browser  -> synchronous evaluate(), no file IPC.
//   2. F5 / refresh                -> hardReload() with cache disabled.
//   3. Restart world               -> handled inside connect() (setup -> launch -> join).
//   4. Blocking HUD button         -> dismissBlockingDialogs() with auto-wait.
//
// Run:  npm run smoke     (from tools/fvtt-playwright/)
// Needs: Foundry server up on baseURL, config.local.json filled in.

import { connect } from "../lib/foundry.js";

const log = (...a) => console.log("[smoke]", ...a);

const fvtt = await connect();
try {
  // (1) READ — synchronous, in-page. Same access as evalGM, no inbox/outbox.
  const info = await fvtt.evaluate(() => ({
    world: game.world.id,
    user: game.user.name,
    ready: game.ready,
    scene: canvas.scene?.name ?? null,
    apiPresent: !!globalThis.FUCompanion?.api?.test,
  }));
  log("connected:", JSON.stringify(info));

  // (1b) Director harness over the wire — the logic layer, called via evaluate().
  if (info.apiPresent) {
    const fixtures = await fvtt.harness("getDirectorTestFixtures");
    const names = (fixtures?.actors ?? fixtures?.tokens ?? [])
      .map((a) => a?.name ?? a)
      .filter(Boolean);
    log("test fixtures:", names.length ? names.join(", ") : JSON.stringify(fixtures)?.slice(0, 200));
  } else {
    log("FUCompanion.api.test not present — is the module active in this world?");
  }

  // (1c) PIXI scene-graph read — token canvas state without touching pixels.
  const tokens = await fvtt.evaluate(() =>
    canvas.tokens.placeables.slice(0, 8).map((t) => ({
      name: t.name,
      x: Math.round(t.x),
      y: Math.round(t.y),
      visible: t.mesh?.visible ?? null,
      alpha: t.mesh?.alpha ?? null,
      statusIcons: [...(t.effects?.children ?? [])].length,
    }))
  );
  log("canvas tokens:", JSON.stringify(tokens));

  // (4) Dismiss any blocking dialog/HUD button, reliably (auto-wait, not racy).
  const dismissed = await dismissBlockingDialogs(fvtt.page);
  log("blocking dialogs dismissed:", dismissed);

  // (2) HARD RELOAD — cache disabled, so ESM modules re-fetch (true Ctrl+Shift+R).
  log("hard reloading…");
  await fvtt.hardReload();
  const after = await fvtt.evaluate(() => ({ ready: game.ready, scene: canvas.scene?.name ?? null }));
  log("after reload:", JSON.stringify(after));

  // Visual capture (WebGL canvas is included in the screenshot).
  const shot = await fvtt.screenshot("smoke.png");
  log("screenshot:", shot);

  log("OK ✅");
} finally {
  await fvtt.close();
}

/** Click any visible Foundry dialog confirm button so it stops blocking the flow. */
async function dismissBlockingDialogs(page) {
  const sel =
    '.dialog button.default, .dialog button[data-button="yes"], .dialog button[data-button="ok"], button.close';
  let n = 0;
  for (let i = 0; i < 5; i++) {
    const btn = page.locator(sel).first();
    if ((await btn.count()) === 0 || !(await btn.isVisible().catch(() => false))) break;
    await btn.click({ timeout: 3000 }).catch(() => {});
    n++;
    await page.waitForTimeout(250);
  }
  return n;
}
