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
 *   1. On world "ready":
 *      - All clients pre-fetch the active scene (the one PIXI will load next).
 *      - GM only pre-fetches the remaining nav-bar scenes. Players connect after
 *        the GM and don't need to bulk-warm scenes they haven't navigated to yet.
 *        Having every player client hammer the local Foundry server with the full
 *        nav-scene batch at the same moment they sign in can crash the server when
 *        two or more players connect simultaneously.
 *   2. On each "canvasInit": pre-fetch the current scene's video tiles as a
 *      safety net for non-navigation scenes and scene switches mid-session.
 *
 * Concurrency:
 *   Fetches are issued in batches of MAX_CONCURRENT rather than all at once to
 *   avoid saturating the local server's file I/O on scenes with many video tiles.
 *
 * On/off switch (world setting `scenePrefetch`, default on):
 *   Read at every hook and between batches, so turning it off takes effect at
 *   the next map load (and stops a warm-up in progress) without a reload.
 *   Added 2026-10-28 for the player-reload case
 *   (docs/investigations/player-reloads): the canvasInit fetch runs alongside
 *   PIXI's own load and may download the same video twice on a slow route, so a
 *   test can compare maps loaded with and without it.
 */
(() => {
  const TAG = "[FUCompanion][ScenePrefetch]";
  const MODULE_ID = "fabula-ultima-companion";
  const SETTING = "scenePrefetch";
  const VIDEO_EXT = /\.(webm|mp4|ogg)$/i;
  const MAX_CONCURRENT = 2;

  function enabled() {
    try { return game.settings.get(MODULE_ID, SETTING) !== false; } catch { return true; }
  }

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
    const srcList = [...srcs];
    console.info(`${TAG} pre-fetching ${srcList.length} video asset(s) for ${label}`);
    const t0 = Date.now();
    let ok = 0;
    const fail = [];
    for (let i = 0; i < srcList.length; i += MAX_CONCURRENT) {
      if (!enabled()) {
        console.info(`${TAG} turned off (world setting); stopped after ${i} of ${srcList.length} for ${label}`);
        break;
      }
      const chunk = srcList.slice(i, i + MAX_CONCURRENT);
      const results = await Promise.allSettled(
        chunk.map(src =>
          fetch(src, { cache: "force-cache" })
            .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return src; })
        )
      );
      ok += results.filter(r => r.status === "fulfilled").length;
      fail.push(...results.filter(r => r.status === "rejected"));
    }
    console.info(`${TAG} pre-fetch done (${ok} ok, ${fail.length} failed, ${Date.now() - t0}ms) for ${label}`);
    if (fail.length) {
      console.warn(`${TAG} failed srcs:`, fail.map(r => r.reason?.message ?? r.reason));
    }
  }

  Hooks.once("init", () => {
    try {
      game.settings.register(MODULE_ID, SETTING, {
        name: "Pre-fetch scene videos",
        hint: "Downloads a map's video files with a separate request as the map starts loading, and the active map's at world entry (the GM also warms every navigation map). Turn it off to let Foundry load videos on its own; it takes effect at the next map change and nobody needs to reload.",
        scope: "world",
        config: true,
        type: Boolean,
        default: true,
      });
    } catch (e) {
      console.warn(`${TAG} setting registration failed (pre-fetch stays on)`, e);
    }
  });

  Hooks.once("ready", async () => {
    if (!enabled()) {
      console.info(`${TAG} off (world setting); skipped the world-entry pre-fetch`);
      return;
    }
    try {
      const activeScene = game.scenes.active;

      // All clients: warm the active scene so PIXI doesn't race the first fetch.
      if (activeScene) {
        await prefetchUrls(collectVideoSrcs(activeScene), `active scene "${activeScene.name}"`);
      }

      // GM only: warm all other nav-bar scenes. The GM is already connected
      // before players arrive, so this never races with a simultaneous login.
      // Players fetch any new scene on-demand via the canvasInit hook below.
      if (game.user?.isGM) {
        const navScenes = game.scenes.filter(s => s.navigation && s !== activeScene);
        const allSrcs = new Set();
        for (const scene of navScenes) {
          for (const src of collectVideoSrcs(scene)) allSrcs.add(src);
        }
        await prefetchUrls(allSrcs, `${navScenes.length} other navigation scene(s)`);
      }
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
      if (!enabled()) {
        if (srcs.size) console.info(`${TAG} off (world setting); skipped ${srcs.size} video asset(s) for scene "${scene.name}"`);
        return;
      }
      await prefetchUrls(srcs, `scene "${scene.name}"`);
    } catch (e) {
      console.warn(`${TAG} canvasInit pre-fetch failed (non-fatal)`, e);
    }
  });
})();
