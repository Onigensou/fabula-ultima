/**
 * scripts/scene-prefetch.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Pre-warms the browser HTTP cache for video tile assets before PIXI tries to
 * initialize them, preventing the loading bar from stalling at 99%.
 *
 * Why this is needed:
 *   Foundry's loading bar reaches 99% while PIXI waits for every tile texture
 *   and video resource to reach a "ready" state. For .webm / .mp4 tiles hosted
 *   on a CDN (e.g. The Forge), the first request in a session hits a cold edge
 *   cache — the video has to be fetched from origin at full latency. The player's
 *   browser then races to download + buffer enough of the video for the
 *   HTMLVideoElement to fire "canplaythrough", which is what PIXI is waiting on.
 *   Slow connections or unlucky CDN routing lose that race and get stuck.
 *
 * How this fixes it:
 *   1. On world "ready": pre-fetch every video asset from all navigation-bar
 *      scenes. These are the scenes the GM is most likely to activate during a
 *      session. By the time anyone transitions, the CDN edge is warm and the
 *      browser has the asset in its HTTP cache.
 *   2. On each "canvasInit": pre-fetch the current scene's video tiles as a
 *      safety net for non-navigation scenes. This races with PIXI's own load,
 *      but on repeated scene visits (and with partial cache hits) it still helps.
 *
 * Applies to all users (GM and players) since anyone can get stuck at 99%.
 */
(() => {
  const TAG = "[FUCompanion][ScenePrefetch]";
  const VIDEO_EXT = /\.(webm|mp4|ogg)$/i;

  function collectVideoSrcs(scene) {
    const srcs = new Set();
    const bg = scene.background?.src;
    if (bg && VIDEO_EXT.test(bg)) srcs.add(bg);
    const fg = scene.foreground;
    if (fg && VIDEO_EXT.test(fg)) srcs.add(fg);
    for (const tile of (scene.tiles?.contents ?? [])) {
      const src = tile.texture?.src;
      if (src && VIDEO_EXT.test(src)) srcs.add(src);
    }
    return srcs;
  }

  async function prefetchUrls(srcs, label) {
    if (!srcs.size) return;
    console.info(`${TAG} pre-fetching ${srcs.size} video asset(s) for ${label}`);
    const t0 = Date.now();
    const results = await Promise.allSettled(
      [...srcs].map(src =>
        fetch(src, { cache: "force-cache" })
          .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return src; })
      )
    );
    const ok = results.filter(r => r.status === "fulfilled").length;
    const fail = results.filter(r => r.status === "rejected");
    console.info(`${TAG} pre-fetch done (${ok} ok, ${fail.length} failed, ${Date.now() - t0}ms) for ${label}`);
    if (fail.length) {
      console.warn(`${TAG} failed srcs:`, fail.map(r => r.reason?.message ?? r.reason));
    }
  }

  // Primary mitigation: warm the cache for all navigation-bar scenes on world
  // load, well before any scene transition happens.
  // Active scene is fetched first (highest priority) so the GM can activate
  // immediately without racing the rest of the nav-scene batch.
  Hooks.once("ready", async () => {
    try {
      const activeScene = game.scenes.active;
      const navScenes = game.scenes.filter(s => s.navigation && s !== activeScene);

      // Active scene first — done before iterating the rest.
      if (activeScene) {
        await prefetchUrls(collectVideoSrcs(activeScene), `active scene "${activeScene.name}"`);
      }

      // Remaining nav scenes in parallel.
      const allSrcs = new Set();
      for (const scene of navScenes) {
        for (const src of collectVideoSrcs(scene)) allSrcs.add(src);
      }
      await prefetchUrls(allSrcs, `${navScenes.length} other navigation scene(s)`);
    } catch (e) {
      console.warn(`${TAG} ready-hook pre-fetch failed (non-fatal)`, e);
    }
  });

  // Safety net: pre-fetch the current scene's videos on canvas init. This fires
  // at the same moment PIXI starts loading, so it's a race — but it still helps
  // on repeated visits and when assets are partially cached.
  Hooks.on("canvasInit", async (canvas) => {
    try {
      const scene = canvas.scene;
      if (!scene) return;
      const srcs = collectVideoSrcs(scene);
      await prefetchUrls(srcs, `scene "${scene.name}"`);
    } catch (e) {
      console.warn(`${TAG} canvasInit pre-fetch failed (non-fatal)`, e);
    }
  });
})();
