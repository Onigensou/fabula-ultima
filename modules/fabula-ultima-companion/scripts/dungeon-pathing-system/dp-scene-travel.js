// ============================================================================
// Dungeon Pathing System — Scene Travel
//
// Lets players travel between Town / Dungeon / Overworld scenes they have
// previously visited.  Activated by the 🗺️ travel button (shown in Exploration
// and Dungeon scene modes when Fast Travel is enabled).
//
// Flow:
//   1. Player clicks travel button → showDialog()
//   2. Dialog lists visited typed scenes (Town / Dungeon / Overworld)
//   3. Player picks destination → confirmation prompt
//   4. Gryphon animation plays (same as Fast Travel) → GM activates scene
//      and ensures the party token exists at the destination spawn point
//
// Scene flags used (all under oniFabula.general.*):
//   isOverworld, isTown, isDungeon  — scene-type tags (set in Scene Config)
//   sceneVisited                   — auto-set true on first activation
//   spawnPoint = { x, y }          — manual spawn; falls back to scene centre
//
// Socket message (raw game.socket):
//   DP_MARK_SCENE_VISITED — non-GM → GM: mark a scene as visited
//   DP_SCENE_TRAVEL       — player → GM: set up token + activate destination
// ============================================================================
(() => {
  const DP        = globalThis.DungeonPathing ??= {};
  const MODULE_ID = "fabula-ultima-companion";
  const TAG       = "[DungeonPathing][SceneTravel]";

  const FABULA_ROOT = DP.FABULA_ROOT_KEY ?? "oniFabula";
  const GEN_KEY     = DP.GENERAL_KEY     ?? "general";
  const SOCKET_CH   = `module.${MODULE_ID}`;
  const MSG_VISITED = "DP_MARK_SCENE_VISITED";
  const MSG_TRAVEL  = "DP_SCENE_TRAVEL";
  const GUARD       = "__ONI_DP_ST_SOCKET__";

  // ── Scene-flag helpers ──────────────────────────────────────────────────────
  function general(scene) {
    return scene?.flags?.[MODULE_ID]?.[FABULA_ROOT]?.[GEN_KEY] ?? {};
  }

  function getSceneType(scene) {
    const g = general(scene);
    if (g.isDungeon)  return "dungeon";
    if (g.isTown)     return "town";
    if (g.isOverworld) return "overworld";
    return null;
  }

  function isSceneVisited(scene) {
    return !!general(scene).sceneVisited;
  }

  function isFtEnabled(scene) {
    const raw = general(scene ?? canvas?.scene).fastTravelEnabled;
    return raw !== false && raw !== "false" && raw !== 0;
  }

  function getSpawnPoint(scene) {
    const sp = general(scene).spawnPoint;
    if (sp && typeof sp.x === "number" && typeof sp.y === "number") return sp;
    // Auto: centre of the scene canvas
    const w = scene?.width  ?? scene?.dimensions?.width  ?? 3000;
    const h = scene?.height ?? scene?.dimensions?.height ?? 3000;
    return { x: w / 2, y: h / 2 };
  }

  // Emoji shown on the travel button based on which scene type we're currently in.
  // "From dungeon → show town icon".  "From town/overworld → show mountain icon".
  function getTravelEmoji(scene) {
    const type = getSceneType(scene ?? canvas?.scene);
    if (type === "dungeon")  return "🏘️";
    if (type === "town")     return "🏔️";
    if (type === "overworld") return "🏙️";
    return "🗺️";
  }

  // ── Eligible destinations ───────────────────────────────────────────────────
  function getEligibleDestinations() {
    const current = canvas?.scene;
    const towns = [], dungeons = [], overworlds = [];

    for (const scene of game.scenes ?? []) {
      if (scene.id === current?.id) continue;
      if (!isSceneVisited(scene)) continue;

      const type = getSceneType(scene);
      if (!type) continue;

      const entry = { id: scene.id, name: scene.name, scene, type };
      if      (type === "town")      towns.push(entry);
      else if (type === "dungeon")   dungeons.push(entry);
      else if (type === "overworld") overworlds.push(entry);
    }
    return { towns, dungeons, overworlds };
  }

  // ── Travel dialog ───────────────────────────────────────────────────────────
  async function showDialog() {
    const currentScene = canvas?.scene;

    // Feature gate: Fast Travel must be enabled
    if (!isFtEnabled(currentScene)) {
      ui.notifications?.warn?.("Travel is disabled for this scene.");
      return;
    }

    // Controller check (same guard as fast travel)
    const api = globalThis.__ONI_MOVEMENT_CONTROL_API__;
    if (api?.isCurrentUserMainController) {
      const isCtrl = await api.isCurrentUserMainController().catch(() => false);
      if (!isCtrl) {
        ui.notifications?.warn?.("Travel is only available to the Main Controller.");
        return;
      }
    }

    const { towns, dungeons, overworlds } = getEligibleDestinations();
    const all = [...towns, ...dungeons, ...overworlds];

    if (!all.length) {
      ui.notifications?.info?.("No visited scenes available to travel to. Explore more first!");
      return;
    }

    // Build radio-button list grouped by type
    let content = `<div style="padding:4px 0;">`;

    const addGroup = (label, icon, items, emoji) => {
      if (!items.length) return;
      content += `<p style="font-weight:600;margin:8px 0 4px;"><i class="${icon}"></i> ${label}</p>`;
      for (const e of items) {
        content += `
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;
                        padding:5px 8px;border:1px solid rgba(200,200,200,0.2);
                        border-radius:4px;margin-bottom:3px;">
            <input type="radio" name="oni-st-dest" value="${e.id}" />
            ${emoji} ${e.name}
          </label>`;
      }
    };

    addGroup("Towns",      "fas fa-city",          towns,      "🏘️");
    addGroup("Dungeons",   "fas fa-dungeon",        dungeons,   "🏔️");
    addGroup("Overworld",  "fas fa-mountain",       overworlds, "🗺️");
    content += `</div>`;

    const selectedId = await new Promise(resolve => {
      const d = new Dialog({
        title:   "Travel",
        content,
        buttons: {
          travel: {
            label:    "<i class='fas fa-paper-plane'></i> Travel",
            callback: (html) => {
              const checked = html[0].querySelector("input[name='oni-st-dest']:checked");
              resolve(checked?.value ?? null);
            }
          },
          cancel: { label: "Cancel", callback: () => resolve(null) }
        },
        default: "travel",
        render:  (html) => {
          // Auto-select first option so the button is never a no-op
          const first = html[0].querySelector("input[name='oni-st-dest']");
          if (first) first.checked = true;
        }
      });
      d.render(true);
    });

    if (!selectedId) return;
    const destScene = game.scenes.get(selectedId);
    if (!destScene) return;

    const type  = getSceneType(destScene);
    const emoji = type === "dungeon" ? "🏔️" : type === "town" ? "🏘️" : "🗺️";
    const confirmed = await Dialog.confirm({
      title:   "Confirm Travel",
      content: `<p style="text-align:center;padding:8px;">Travel to <b>${emoji} ${destScene.name}</b>?</p>`,
    });
    if (!confirmed) return;

    await executeTravelTo(destScene).catch(e => console.error(TAG, "executeTravelTo failed:", e));
  }

  // ── Execute travel ──────────────────────────────────────────────────────────
  async function executeTravelTo(destScene) {
    const dpState = globalThis.__ONI_DUNGEON_PATHING__?.state ?? null;
    const token   = dpState?.partyToken ?? null;
    const spawn   = getSpawnPoint(destScene);

    // Play gryphon animation if there is a party token visible on the current canvas
    if (token && canvas?.ready) {
      // Snap all viewports to the party token before the animation
      const gSize = Number(canvas?.grid?.size ?? 100) || 100;
      const tw    = Number(token.document?.width  ?? 1) * gSize;
      const th    = Number(token.document?.height ?? 1) * gSize;
      const tkCX  = Number(token.document.x) + tw / 2;
      const tkCY  = Number(token.document.y) + th / 2;
      canvas.animatePan?.({ x: tkCX, y: tkCY, duration: 400 });
      // Broadcast pan to non-controller clients
      game.socket.emit(SOCKET_CH, { type: "DP_FT_PAN",  payload: { x: tkCX, y: tkCY } });
      await new Promise(r => setTimeout(r, 450));

      // Broadcast animation request to other clients (they reuse the FT anim listener)
      game.socket.emit(SOCKET_CH, { type: "DP_ST_ANIM", payload: { userId: game.user?.id } });
      await DP.FastTravel?.runGryphonAnimation?.(token).catch(() => null);
    }

    // Determine actor for token placement on destination scene
    const actorId = token?.actor?.id ?? token?.document?.actorId ?? null;

    if (game.user?.isGM) {
      await setupTokenAndActivate(destScene, actorId, spawn.x, spawn.y);
    } else {
      game.socket.emit(SOCKET_CH, {
        type:    MSG_TRAVEL,
        payload: { toSceneId: destScene.id, actorId, spawnX: spawn.x, spawnY: spawn.y },
      });
    }
  }

  // ── GM: ensure token on destination + activate scene ───────────────────────
  async function setupTokenAndActivate(destScene, actorId, spawnX, spawnY) {
    if (!game.user?.isGM) return;

    const gSize = destScene.grid?.size ?? 100;

    if (actorId) {
      const actor = game.actors.get(actorId);
      if (actor) {
        const existing = destScene.tokens.find(t => t.actorId === actorId);
        if (existing) {
          const tw = Number(existing.width  ?? 1) * gSize;
          const th = Number(existing.height ?? 1) * gSize;
          await existing.update(
            { x: Math.round(spawnX - tw / 2), y: Math.round(spawnY - th / 2) },
            { animate: false }
          ).catch(e => console.warn(TAG, "token reposition failed:", e));
        } else {
          const tokenData = actor.prototypeToken.toObject();
          tokenData.x = Math.round(spawnX - (tokenData.width  ?? 1) * gSize / 2);
          tokenData.y = Math.round(spawnY - (tokenData.height ?? 1) * gSize / 2);
          tokenData.actorId = actorId;
          await destScene.createEmbeddedDocuments("Token", [tokenData])
            .catch(e => console.warn(TAG, "token create failed:", e));
        }
      }
    }

    await destScene.activate().catch(e => console.error(TAG, "scene activate failed:", e));
  }

  // ── Scene-visited tracking ──────────────────────────────────────────────────
  async function markSceneVisited(scene) {
    if (!scene || !game.user?.isGM) return;
    if (isSceneVisited(scene)) return;
    await scene.setFlag(MODULE_ID, `${FABULA_ROOT}.${GEN_KEY}.sceneVisited`, true)
      .catch(e => console.warn(TAG, "markSceneVisited failed:", e));
    console.debug(TAG, `Scene "${scene.name}" marked as visited.`);
  }

  // ── Socket listener ─────────────────────────────────────────────────────────
  function setupSocketListener() {
    if (window[GUARD]) return;
    window[GUARD] = true;

    game.socket.on(SOCKET_CH, async (msg) => {
      // Mark scene visited (non-GM → GM)
      if (msg?.type === MSG_VISITED) {
        if (!game.user?.isGM) return;
        const scene = game.scenes.get(msg.payload?.sceneId);
        if (scene) await markSceneVisited(scene);
        return;
      }

      // Cross-scene travel request (player → GM)
      if (msg?.type === MSG_TRAVEL) {
        if (!game.user?.isGM) return;
        const { toSceneId, actorId, spawnX, spawnY } = msg.payload ?? {};
        const dest = game.scenes.get(toSceneId);
        if (!dest) { console.warn(TAG, "travel: destination not found:", toSceneId); return; }
        await setupTokenAndActivate(dest, actorId, spawnX, spawnY)
          .catch(e => console.error(TAG, "setupTokenAndActivate (socket) failed:", e));
        return;
      }

      // Animation broadcast from another client running executeTravelTo
      if (msg?.type === "DP_ST_ANIM") {
        if (msg.payload?.userId === game.user?.id) return; // ignore self
        const tkn = globalThis.__ONI_DUNGEON_PATHING__?.state?.partyToken ?? null;
        if (tkn) {
          DP.FastTravel?.runGryphonAnimation?.(tkn, { waitForUpdate: true }).catch(() => {
            const mesh = tkn.mesh ?? tkn.icon ?? null;
            if (mesh) mesh.alpha = 1;
          });
        }
        return;
      }
    });

    console.debug(TAG, "Socket listener installed.");
  }

  // ── Public API ──────────────────────────────────────────────────────────────
  DP.SceneTravel = {
    showDialog,
    getSceneType,
    getTravelEmoji,
    isSceneVisited,
    isFtEnabled,
    getEligibleDestinations,
    markSceneVisited,
  };

  // ── Bootstrap ───────────────────────────────────────────────────────────────
  Hooks.once("ready", () => {
    setupSocketListener();

    // Auto-mark scene as visited when it becomes the active scene for all clients.
    // Only marks scenes with a sceneMode set (exploration / dungeon) to avoid
    // accidentally marking every scene in the world.
    Hooks.on("canvasReady", async () => {
      const scene = canvas?.scene;
      if (!scene?.active) return; // only truly activated scenes (shown to all players)
      const mode = general(scene).sceneMode;
      if (!mode || mode === "none") return;

      if (game.user?.isGM) {
        await markSceneVisited(scene);
      } else {
        game.socket.emit(SOCKET_CH, { type: MSG_VISITED, payload: { sceneId: scene.id } });
      }
    });

    console.debug(TAG, "Scene Travel System loaded.");
  });
})();
