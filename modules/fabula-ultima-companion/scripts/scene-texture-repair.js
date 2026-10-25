/**
 * scripts/scene-texture-repair.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Self-repairs a scene background / foreground image that failed to download,
 * in place — no page reload and no canvas redraw.
 *
 * Why this is needed:
 *   Foundry v12's TextureLoader tries a failed image twice (plain, then with a
 *   cache-bust query) while the scene loads, then draws the scene WITHOUT it:
 *   PrimaryCanvasGroup#drawSceneMesh gets a null texture, assigns
 *   PIXI.Texture.EMPTY and hides the mesh. The player sees their tokens on a
 *   black map, with no retry and no message. The tokens are usually already
 *   cached from earlier scenes, while each scene's background is a fresh
 *   multi-MB download — so a flaky connection loses exactly the background.
 *   Players then press F5, which re-downloads the whole world from the host.
 *
 * How this fixes it:
 *   On every canvasReady, check whether the scene names a background /
 *   foreground image whose mesh came out empty. If so, keep retrying the
 *   download with backoff while that scene stays on screen, and on success put
 *   the texture straight into the existing mesh (same sizing as Foundry's own
 *   drawSceneMesh). Tokens, tiles and anything running on the canvas are not
 *   touched. The player is told it is retrying, so they wait instead of F5.
 */
(() => {
  const TAG = "[FUCompanion][SceneTextureRepair]";
  const RETRY_MS = [1000, 3000, 6000, 12000, 20000];   // then every RETRY_TAIL_MS
  const RETRY_TAIL_MS = 30000;
  const GIVE_UP_MS = 10 * 60 * 1000;

  // Bumped on every draw/teardown so a repair loop for a scene that is gone stops.
  let drawSeq = 0;

  function isMissing(mesh) {
    const tex = mesh?.texture;
    return !tex || tex === PIXI.Texture.EMPTY || !tex.baseTexture?.valid;
  }

  function findMissing() {
    const scene = canvas.scene;
    if (!scene || !canvas.primary) return [];
    const out = [];
    // canvas.sceneTextures can supply a ready PIXI.Texture (e.g. a generated
    // background); only plain URL sources are ours to re-download.
    const bg = canvas.sceneTextures?.background ?? scene.background?.src;
    if (typeof bg === "string" && bg && isMissing(canvas.primary.background)) out.push({ key: "background", src: bg });
    const fg = canvas.sceneTextures?.foreground ?? scene.foreground;
    if (typeof fg === "string" && fg && isMissing(canvas.primary.foreground)) out.push({ key: "foreground", src: fg });
    return out;
  }

  // Mirrors PrimaryCanvasGroup#drawSceneMesh for the texture-dependent parts.
  // width/height must be re-applied AFTER the texture swap: the setters turn
  // them into a scale against the CURRENT texture size, which was EMPTY's 1x1.
  function applyTexture(key, texture) {
    const mesh = canvas.primary[key];
    const d = canvas.dimensions;
    mesh.texture = texture;
    mesh.visible = true;
    mesh.position.set(d.sceneX, d.sceneY);
    mesh.width = d.sceneWidth;
    mesh.height = d.sceneHeight;
    const video = game.video.getVideoSource(mesh);
    if (video) {
      canvas.primary.videoMeshes.add(mesh);
      game.video.play(video, { volume: game.settings.get("core", "globalAmbientVolume") });
    }
  }

  async function repair(seq, sceneId, { key, src }) {
    const t0 = Date.now();
    let notified = false;
    for (let attempt = 0; ; attempt++) {
      const wait = RETRY_MS[attempt] ?? RETRY_TAIL_MS;
      await new Promise((r) => setTimeout(r, wait));
      if (seq !== drawSeq || canvas.scene?.id !== sceneId) return;   // scene changed
      if (!isMissing(canvas.primary[key])) return;                    // fixed elsewhere

      // loadTexture (Foundry global) logs its own error and returns null on failure.
      const texture = await loadTexture(src);
      if (seq !== drawSeq || canvas.scene?.id !== sceneId) return;

      if (texture?.baseTexture?.valid) {
        applyTexture(key, texture);
        console.info(`${TAG} ${key} restored after ${attempt + 1} retr${attempt ? "ies" : "y"} (${Date.now() - t0}ms): ${src}`);
        if (notified) ui.notifications?.info("Map image restored.");
        return;
      }

      console.warn(`${TAG} ${key} retry ${attempt + 1} failed: ${src}`);
      if (!notified) {
        notified = true;
        ui.notifications?.warn("The map image didn't load. Retrying automatically — no need to reload.");
      }
      if (Date.now() - t0 > GIVE_UP_MS) {
        ui.notifications?.error("The map image still can't be downloaded. Please tell the GM.", { permanent: true });
        console.error(`${TAG} giving up on ${key} after ${attempt + 1} retries: ${src}`);
        return;
      }
    }
  }

  Hooks.on("canvasTearDown", () => { drawSeq++; });

  Hooks.on("canvasReady", () => {
    const seq = ++drawSeq;
    const missing = findMissing();
    if (!missing.length) return;
    console.warn(`${TAG} scene "${canvas.scene.name}" drew without:`, missing.map((m) => `${m.key} ${m.src}`));
    for (const m of missing) repair(seq, canvas.scene.id, m);
  });
})();
