/**
 * [ONI] Event System — Effects among the tokens
 * Foundry VTT v12
 *
 * File:
 * scripts/event-system/event-worldFx.js
 *
 * What this does:
 * - Plays an image or video INSIDE the map's own drawing order, so it can be
 *   behind a token, or in front of a token and behind a tile. Play Animation's
 *   usual map layer is a web page element over the whole canvas, which is above
 *   everything by nature.
 * - Warms up the media an event will use, on every client, when the event
 *   starts. A clip's first play otherwise downloads while the moment passes
 *   (about half a second, measured on the Smoke Bomb, 2026-10-27).
 *
 * The order on the map, back to front:
 *     painting
 *     BEHIND_TOKENS   a bolt striking behind the characters
 *     tokens
 *     COPIES          a sprite copy leaving its token (Set Token's jump)
 *     OVER_TOKENS     smoke in front of the characters
 *     tiles at elevation 1 or more, such as a cliff edge the party stands behind
 * Foundry sorts by elevation first, then layer, then sort, so all of these stay
 * under any tile placed at elevation 1 (tested with parallax on, 2026-10-30).
 *
 * Every frame callback is guarded: a throw inside one stops PIXI's frame loop.
 *
 * Exposes API to:
 *   window.oni.EventSystem.WorldFx
 *
 * Requires:
 * - event-client.js
 */

(() => {
  const INSTALL_TAG = "[ONI][EventSystem][WorldFx]";

  window.oni = window.oni || {};
  window.oni.EventSystem = window.oni.EventSystem || {};

  if (window.oni.EventSystem.WorldFx?.installed) {
    console.debug(INSTALL_TAG, "Already installed; skipping.");
    return;
  }

  const Client = window.oni.EventSystem.Client;
  if (!Client) {
    console.error(INSTALL_TAG, "Missing Client. Check load order.");
    return;
  }

  const KIND_PRELOAD = "media.preload";

  const SORT = { BEHIND_TOKENS: -100000, COPIES: 500000, OVER_TOKENS: 1000000 };

  const READY_TIMEOUT_MS = 4000;
  const CAP_MS = 30000;
  const IMAGE_DEFAULT_MS = 2000;

  const isVideo = (src) => /\.(webm|mp4|m4v|ogv)(\?.*)?$/i.test(String(src || ""));
  const isAudio = (src) => /\.(ogg|oga|mp3|wav|flac|m4a|opus)(\?.*)?$/i.test(String(src || ""));
  const hiddenTab = () => globalThis.FUCompanion?.api?.vfxSuppressed?.() === true;

  // ------------------------------------------------------------
  // Warming up
  // ------------------------------------------------------------
  // Loaded videos waiting for their first play: src -> [video]. A copy is taken
  // once; a later play of the same clip loads a new one, by then from the cache.
  const pool = new Map();

  function makeVideo(src, loop = false) {
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.loop = loop;
    video.playsInline = true;
    video.preload = "auto";
    video.src = src;
    return video;
  }

  function takeVideo(src) {
    const waiting = pool.get(src);
    return waiting?.length ? waiting.pop() : makeVideo(src);
  }

  function emptyPool() {
    for (const list of pool.values()) {
      for (const video of list) {
        try { video.pause(); video.removeAttribute("src"); video.load(); } catch (_) {}
      }
    }
    pool.clear();
  }

  Client.register(KIND_PRELOAD, (data, info) => {
    for (const { src, copies = 1 } of data.media ?? []) {
      if (!src) continue;

      if (isAudio(src)) {
        window.oni.EventSystem.RowsMedia?.preloadSound?.(src);
      } else if (isVideo(src)) {
        if (!pool.has(src)) pool.set(src, []);
        const list = pool.get(src);
        while (list.length < copies) list.push(makeVideo(src));
      } else {
        Promise.resolve(loadTexture(src)).catch(() => {});
      }
    }
    Client.addCleanup(info.sourceId, "worldFx.pool", emptyPool);
  });

  // Called once when an event starts. rows: the whole event.
  function preloadEvent(sourceId, rows) {
    const EventRegistry = window.oni.EventSystem.EventRegistry;
    if (!EventRegistry?.walkRows) return;

    const counts = new Map();
    EventRegistry.walkRows(rows, (row) => {
      const def = EventRegistry.peek(row?.type);
      for (const src of def?.mediaOf?.(row) ?? []) {
        const clean = String(src ?? "").trim();
        if (clean) counts.set(clean, (counts.get(clean) ?? 0) + 1);
      }
    });

    if (counts.size) {
      Client.run(sourceId, KIND_PRELOAD, { media: [...counts].map(([src, copies]) => ({ src, copies })) });
    }
  }

  // ------------------------------------------------------------
  // Playing
  // ------------------------------------------------------------
  // Clips playing on this client: sourceId -> Set of stop functions.
  const playing = new Map();

  function track(sourceId, stop) {
    if (!playing.has(sourceId)) playing.set(sourceId, new Set());
    playing.get(sourceId).add(stop);
    Client.addCleanup(sourceId, "worldFx", () => {
      for (const fn of [...(playing.get(sourceId) ?? [])]) fn();
      playing.delete(sourceId);
    });
  }

  function whenReady(video) {
    if (video.readyState >= 3) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), READY_TIMEOUT_MS);
      const done = (ok) => { clearTimeout(timer); resolve(ok); };
      video.addEventListener("canplay", () => done(true), { once: true });
      video.addEventListener("error", () => done(false), { once: true });
    });
  }

  /**
   * Plays once at a point on the map, on this client. Resolves when it is over.
   *   src, x, y      file and map position
   *   sourceId       the event, so that its end removes whatever is still playing
   *   width          map px wide (height follows the file), or scale: of the file's own size
   *   anchorX/Y      which point of the picture sits on x, y (default the centre)
   *   sort           one of SORT
   *   alpha, tint    0-1, and a number such as 0xb9a9cc
   *   additive       glowing light rather than solid paint
   *   mirror         flip left to right
   *   durationMs     for an image, or to cut a video short
   */
  async function play({
    src, x, y, sourceId,
    width = 0, scale = 1, anchorX = 0.5, anchorY = 0.5,
    sort = SORT.OVER_TOKENS, alpha = 1, tint = null, additive = false, mirror = false,
    durationMs = 0
  } = {}) {
    if (!src || !canvas?.ready || hiddenTab()) return false;

    const sceneId = canvas.scene?.id;
    const video = isVideo(src) ? takeVideo(src) : null;

    let texture = null;
    try {
      if (video) {
        if (!await whenReady(video)) return false;
        texture = PIXI.Texture.from(video);
      } else {
        texture = await loadTexture(src);
      }
    } catch (e) {
      console.warn(INSTALL_TAG, `Could not load "${src}".`, e);
      return false;
    }

    // The scene may have changed while it loaded.
    if (!texture || !canvas?.ready || canvas.scene?.id !== sceneId) return false;

    const mesh = new PrimarySpriteMesh({ texture, name: "oniEventWorldFx" });
    mesh.anchor.set(anchorX, anchorY);
    const fileWidth = video ? video.videoWidth : texture.width;
    const fileHeight = video ? video.videoHeight : texture.height;
    const drawnWidth = width > 0 ? width : fileWidth * scale;
    mesh.width = drawnWidth * (mirror ? -1 : 1);
    mesh.height = drawnWidth * (fileHeight / Math.max(1, fileWidth));
    mesh.position.set(x, y);
    mesh.elevation = 0;
    mesh.sortLayer = PrimaryCanvasGroup.SORT_LAYERS.TOKENS;
    mesh.sort = sort;
    mesh.alpha = alpha;
    if (tint !== null) mesh.tint = tint;
    if (additive) mesh.blendMode = PIXI.BLEND_MODES.ADD;
    canvas.primary.addChild(mesh);

    return new Promise((resolve) => {
      let timer = null;
      let stopped = false;

      const stop = () => {
        if (stopped) return;
        stopped = true;
        clearTimeout(timer);
        playing.get(sourceId)?.delete(stop);
        try { mesh.destroy(); } catch (_) {}
        if (video) {
          try { video.pause(); } catch (_) {}
          try { texture.destroy(true); } catch (_) {}
          try { video.removeAttribute("src"); video.load(); } catch (_) {}
        }
        resolve(true);
      };

      track(sourceId, stop);

      if (video) {
        video.addEventListener("ended", stop, { once: true });
        video.addEventListener("error", stop, { once: true });
        try { video.currentTime = 0; } catch (_) {}
        video.play().catch(stop);
      }

      timer = setTimeout(stop, Math.min(CAP_MS, durationMs > 0 ? durationMs : (video ? CAP_MS : IMAGE_DEFAULT_MS)));
    });
  }

  window.oni.EventSystem.WorldFx = {
    installed: true,
    SORT,
    play,
    preloadEvent
  };

  console.debug(INSTALL_TAG, "Installed. API: window.oni.EventSystem.WorldFx");
})();
