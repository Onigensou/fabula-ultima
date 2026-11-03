// Launch the world from /setup via a direct JS click (bypasses the tour
// overlay that intercepts pointer events), then wait for the /join redirect.
import { loadConfig, launch } from "../lib/foundry.js";
const cfg = loadConfig();
const { browser, page } = await launch(cfg);
try {
  await page.goto(cfg.baseURL + "/setup", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(3000);
  // Exit any active tour first, then JS-click the world's launch control.
  const clicked = await page.evaluate((worldId) => {
    try { globalThis.game?.tours?.active?.exit?.(); } catch {}
    document.querySelector(".tour-fadeout, .tour-overlay, #tooltip.tour")?.remove?.();
    const btn = document.querySelector(`li.package[data-package-id="${worldId}"] [data-action="worldLaunch"]`);
    if (!btn) return "no-button";
    btn.click();
    return "clicked";
  }, cfg.world);
  console.log("[launch-world]", clicked);
  // The launch may pop a confirmation dialog — accept it if present.
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    const yes = [...document.querySelectorAll("dialog button, .dialog button, .window-app button")]
      .find((b) => /launch|yes|confirm/i.test(b.textContent ?? ""));
    yes?.click?.();
  });
  await page.waitForSelector('select[name="userid"]', { timeout: 120000 });
  console.log("[launch-world] world launched — /join reached");
} finally {
  await browser.close();
}
