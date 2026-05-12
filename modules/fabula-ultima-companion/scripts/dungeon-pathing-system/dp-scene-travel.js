// ============================================================================
// Dungeon Pathing System — Scene Travel
//
// Lets players travel between Town / Dungeon / Overworld scenes they have
// previously visited.  Activated by the travel button shown in Exploration
// and Dungeon scene modes when Fast Travel is enabled.
//
// Flow:
//   1. Player clicks travel button → showDialog()
//   2. JRPG-styled dialog lists visited Town + Dungeon scenes as panel buttons
//   3. Player clicks or presses Enter on a destination → confirmation prompt
//   4. Gryphon pick-up animation → GM activates scene + places token at spawn
//   5. On arrival: token hidden → gryphon drops token off → gryphon flies away
//
// Scene flags (all under oniFabula.general.*):
//   isOverworld, isTown, isDungeon  — explicit type tags (set in Scene Config)
//   sceneVisited                   — auto-set true on first activation
//   spawnPoint = { x, y }          — manual spawn; falls back to scene centre
//   navigationName                 — custom name shown in the Travel dialog
//
// Socket messages (raw game.socket):
//   DP_MARK_SCENE_VISITED  — non-GM → GM: mark a scene as visited
//   DP_SCENE_TRAVEL        — player → GM: set up token + activate destination
//   DP_TRAVEL_ARRIVING     — broadcast before scene switch: prime drop-off anim
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
    if (g.isDungeon)   return "dungeon";
    if (g.isTown)      return "town";
    if (g.isOverworld) return "overworld";
    // Fallback: infer from sceneMode when explicit type flags are not set
    if (g.sceneMode === "dungeon")     return "dungeon";
    if (g.sceneMode === "exploration") return "town";
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
    const w = scene?.width  ?? scene?.dimensions?.width  ?? 3000;
    const h = scene?.height ?? scene?.dimensions?.height ?? 3000;
    return { x: w / 2, y: h / 2 };
  }

  function getNavigationName(scene) {
    const name = general(scene)?.navigationName?.trim?.();
    return (name && name.length) ? name : (scene?.name ?? "");
  }

  // Emoji shown on the travel button — dungeon→🏘️ (town icon), everything else→⛰️
  function getTravelEmoji(scene) {
    const type = getSceneType(scene ?? canvas?.scene);
    return type === "dungeon" ? "🏘️" : "⛰️";
  }

  // ── Eligible destinations ───────────────────────────────────────────────────
  // Overworld tracked but not shown in dialog (reserved for future systems).
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

  // ── JRPG dialog styles ──────────────────────────────────────────────────────
  const TRAVEL_STYLE_ID = "oni-dp-travel-dialog-styles";

  function injectTravelStyles() {
    if (document.getElementById(TRAVEL_STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = TRAVEL_STYLE_ID;
    s.textContent = `
/* === ONI JRPG Travel Dialog === */
.oni-jrpg-travel-dialog.dialog .window-header {
  background: linear-gradient(90deg,
    #3b1a06 0%, #6b3410 25%, #7a3c12 50%, #6b3410 75%, #3b1a06 100%) !important;
  border-bottom: 3px solid #2a1200 !important;
  color: #f5e2b4 !important;
  text-shadow: 0 1px 4px rgba(0,0,0,0.9);
  letter-spacing: 1px;
  font-family: serif;
}

.oni-jrpg-travel-dialog.dialog .window-content {
  background:
    radial-gradient(ellipse at 5% 95%, rgba(160,100,50,0.2) 0%, transparent 50%),
    radial-gradient(ellipse at 95% 5%, rgba(120,80,30,0.14) 0%, transparent 50%),
    linear-gradient(165deg, #f7eacc 0%, #ede1b6 35%, #e8d9a8 65%, #f0e4c0 100%) !important;
  border-top: none !important;
  box-shadow: inset 0 0 28px rgba(100,60,20,0.18) !important;
}

.oni-jrpg-travel-dialog.dialog .dialog-buttons {
  background: rgba(80,42,10,0.18) !important;
  border-top: 2px solid rgba(90,50,15,0.35) !important;
  padding: 8px !important;
}

.oni-jrpg-travel-dialog.dialog .dialog-buttons button {
  background: linear-gradient(180deg, #6e3712 0%, #4a2008 100%) !important;
  color: #f5e2b4 !important;
  border: 1px solid #3b1a06 !important;
  border-radius: 5px !important;
  font-family: serif !important;
  letter-spacing: 0.5px !important;
  text-shadow: 0 1px 2px rgba(0,0,0,0.8) !important;
}

.oni-jrpg-travel-dialog.dialog .dialog-buttons button:hover {
  background: linear-gradient(180deg, #804020 0%, #5a2e10 100%) !important;
  filter: brightness(1.08) !important;
}

/* Category labels */
.oni-travel-category {
  font-family: serif;
  font-size: 11px;
  font-weight: 700;
  color: #5a2d0c;
  text-transform: uppercase;
  letter-spacing: 2px;
  padding: 6px 4px 4px;
  border-bottom: 1px solid rgba(90,45,12,0.35);
  margin: 8px 0 7px;
}
.oni-travel-category:first-child { margin-top: 2px; }

/* Destination panel buttons */
.oni-travel-dest {
  position: relative;
  width: 100%;
  height: 72px;
  border: 2px solid #8b5a2b;
  border-radius: 8px;
  background: linear-gradient(135deg,
    rgba(248,235,198,0.97) 0%, rgba(232,214,172,0.93) 100%);
  overflow: hidden;
  cursor: pointer;
  padding: 0;
  display: flex;
  align-items: center;
  margin-bottom: 8px;
  box-shadow:
    0 2px 8px rgba(0,0,0,0.22),
    inset 0 1px 0 rgba(255,255,255,0.55),
    inset 0 -1px 0 rgba(0,0,0,0.08);
  transition:
    filter 150ms ease,
    transform 120ms ease,
    border-color 150ms ease,
    box-shadow 150ms ease;
  text-align: left;
}
.oni-travel-dest:last-child { margin-bottom: 0; }
.oni-travel-dest:hover,
.oni-travel-dest.oni-travel-focused {
  filter: brightness(1.06);
  border-color: #c4852e;
  transform: translateY(-2px);
  box-shadow:
    0 0 0 2px rgba(196,133,46,0.4),
    0 6px 16px rgba(0,0,0,0.3),
    inset 0 1px 0 rgba(255,255,255,0.55);
}
.oni-travel-dest:active {
  transform: translateY(0);
  filter: brightness(0.95);
  box-shadow: 0 1px 4px rgba(0,0,0,0.22);
}

/* Left: name */
.oni-dest-left {
  position: relative;
  z-index: 2;
  padding: 0 12px 0 16px;
  flex: 0 0 auto;
  max-width: 56%;
}
.oni-dest-name {
  font-family: serif;
  font-size: 21px;
  font-weight: 900;
  color: #3d1f00;
  line-height: 1.15;
  text-shadow: 0 1px 0 rgba(255,255,255,0.65);
  word-break: break-word;
}

/* Right: scene thumbnail */
.oni-dest-thumb {
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  width: 65%;
  background-size: cover;
  background-position: center;
  opacity: 0.28;
  -webkit-mask-image: linear-gradient(
    to right,
    transparent 0%,
    rgba(0,0,0,0.45) 28%,
    rgba(0,0,0,0.85) 65%,
    #000 100%);
  mask-image: linear-gradient(
    to right,
    transparent 0%,
    rgba(0,0,0,0.45) 28%,
    rgba(0,0,0,0.85) 65%,
    #000 100%);
}
    `;
    document.head.appendChild(s);
  }

  // ── Travel dialog ───────────────────────────────────────────────────────────
  async function showDialog() {
    const currentScene = canvas?.scene;

    if (!isFtEnabled(currentScene)) {
      ui.notifications?.warn?.("Travel is disabled for this scene.");
      return;
    }

    const api = globalThis.__ONI_MOVEMENT_CONTROL_API__;
    if (api?.isCurrentUserMainController) {
      const isCtrl = await api.isCurrentUserMainController().catch(() => false);
      if (!isCtrl) {
        ui.notifications?.warn?.("Travel is only available to the Main Controller.");
        return;
      }
    }

    const { towns, dungeons } = getEligibleDestinations();
    const all = [...towns, ...dungeons]; // overworlds excluded from dialog

    if (!all.length) {
      ui.notifications?.info?.("No visited scenes available to travel to. Explore more first!");
      return;
    }

    DP.Sound?.playFastTravelOpen?.();

    let content = `<div class="oni-travel-list" style="padding:2px 0;">`;

    const addGroup = (label, icon, items) => {
      if (!items.length) return;
      content += `<div class="oni-travel-category"><i class="${icon}"></i> ${label}</div>`;
      for (const e of items) {
        const navName = getNavigationName(e.scene);
        const thumb   = e.scene.thumb ?? e.scene.background?.src ?? "";
        const thumbEl = thumb
          ? `<div class="oni-dest-thumb" style="background-image:url('${thumb}');"></div>`
          : "";
        content += `
          <button type="button" class="oni-travel-dest" data-scene-id="${e.id}" tabindex="-1">
            <div class="oni-dest-left">
              <div class="oni-dest-name">${navName}</div>
            </div>
            ${thumbEl}
          </button>`;
      }
    };

    addGroup("Towns",    "fas fa-city",    towns);
    addGroup("Dungeons", "fas fa-dungeon", dungeons);
    content += `</div>`;

    const selectedId = await new Promise(resolve => {
      let resolved = false;
      let focusedIdx = 0;
      let keyHandler = null;

      const d = new Dialog(
        {
          title:   "🗺️ Travel",
          content,
          buttons: {
            cancel: {
              label:    "✕ Cancel",
              callback: () => {
                DP.Sound?.playCancel?.();
                if (!resolved) { resolved = true; resolve(null); }
              },
            },
          },
          default: "cancel",
          render:  (html) => {
            const container = html[0];
            const btns = Array.from(container.querySelectorAll(".oni-travel-dest"));
            if (!btns.length) return;

            const setFocus = (idx, sound = true) => {
              btns.forEach(b => b.classList.remove("oni-travel-focused"));
              focusedIdx = ((idx % btns.length) + btns.length) % btns.length;
              btns[focusedIdx]?.classList.add("oni-travel-focused");
              if (sound) DP.Sound?.playHover?.();
            };

            // Auto-select first button (no sound on init)
            setFocus(0, false);

            btns.forEach((btn, i) => {
              btn.addEventListener("mouseenter", () => setFocus(i));
              btn.addEventListener("click", () => {
                if (resolved) return;
                resolved = true;
                DP.Sound?.playConfirm?.();
                d.close();
                resolve(btn.dataset.sceneId ?? null);
              });
            });

            keyHandler = (ev) => {
              if (ev.key === "ArrowDown" || ev.key === "ArrowRight") {
                ev.preventDefault(); ev.stopPropagation();
                setFocus(focusedIdx + 1);
              } else if (ev.key === "ArrowUp" || ev.key === "ArrowLeft") {
                ev.preventDefault(); ev.stopPropagation();
                setFocus(focusedIdx - 1);
              } else if (ev.key === "Enter") {
                ev.preventDefault(); ev.stopPropagation();
                const btn = btns[focusedIdx];
                if (btn && !resolved) {
                  resolved = true;
                  DP.Sound?.playConfirm?.();
                  d.close();
                  resolve(btn.dataset.sceneId ?? null);
                }
              }
              // Escape propagates naturally to Dialog's built-in close handler
            };
            window.addEventListener("keydown", keyHandler, true);
          },
          close: () => {
            if (keyHandler) {
              window.removeEventListener("keydown", keyHandler, true);
              keyHandler = null;
            }
            if (!resolved) { resolved = true; DP.Sound?.playCancel?.(); resolve(null); }
          },
        },
        { classes: ["oni-jrpg-travel-dialog", "dialog"], width: 420 }
      );
      d.render(true);
    });

    if (!selectedId) return;
    const destScene = game.scenes.get(selectedId);
    if (!destScene) return;

    const navName   = getNavigationName(destScene);
    const confirmed = await Dialog.confirm({
      title:   "Confirm Travel",
      content: `<p style="text-align:center;padding:8px;">Travel to <b>${navName}</b>?</p>`,
    });
    if (!confirmed) {
      DP.Sound?.playCancel?.();
      return;
    }

    await executeTravelTo(destScene).catch(e => console.error(TAG, "executeTravelTo failed:", e));
  }

  // ── Execute travel ──────────────────────────────────────────────────────────
  async function executeTravelTo(destScene) {
    // Capture source scene BEFORE any scene switch
    const fromSceneId = canvas?.scene?.id ?? null;
    const dpState     = globalThis.__ONI_DUNGEON_PATHING__?.state ?? null;

    // Resolve party token: dungeon state first, then canvas fallback for exploration/town mode
    // (in non-dungeon scenes, bootstrap calls deactivate() which nulls state.partyToken)
    let token = dpState?.partyToken ?? null;
    if (!token && canvas?.ready) {
      token = await DP.Graph?.resolvePartyToken?.().catch(() => null) ?? null;
    }

    const spawn   = getSpawnPoint(destScene);
    const actorId = token?.actor?.id ?? token?.document?.actorId ?? null;

    // Play gryphon pick-up animation if there is a party token on the current canvas
    if (token && canvas?.ready) {
      const gSize = Number(canvas?.grid?.size ?? 100) || 100;
      const tw    = Number(token.document?.width  ?? 1) * gSize;
      const th    = Number(token.document?.height ?? 1) * gSize;
      const tkCX  = Number(token.document.x) + tw / 2;
      const tkCY  = Number(token.document.y) + th / 2;
      canvas.animatePan?.({ x: tkCX, y: tkCY, duration: 400 });
      game.socket.emit(SOCKET_CH, { type: "DP_FT_PAN", payload: { x: tkCX, y: tkCY } });
      await new Promise(r => setTimeout(r, 450));

      game.socket.emit(SOCKET_CH, { type: "DP_ST_ANIM", payload: { userId: game.user?.id } });
      await DP.FastTravel?.runGryphonAnimation?.(token).catch(() => null);
    }

    // Install drawToken guard BEFORE the scene switch so the destination token is hidden
    // the instant Foundry draws it — prevents any flash of the visible token during loading.
    let drawGuardId = null;
    if (actorId) {
      drawGuardId = Hooks.on("drawToken", (tp) => {
        if (tp.document?.actorId !== actorId) return;
        tp.alpha = 0;
        Hooks.off("drawToken", drawGuardId);
      });
    }

    // Prime drop-off animation on all clients before scene switch
    const dropOffPayload = { sceneId: destScene.id, actorId };
    window.__ONI_DP_DROPOFF_SCENE__ = { ...dropOffPayload, guardId: drawGuardId };
    game.socket.emit(SOCKET_CH, { type: "DP_TRAVEL_ARRIVING", payload: dropOffPayload });

    if (game.user?.isGM) {
      await setupTokenAndActivate(destScene, actorId, spawn.x, spawn.y, fromSceneId);
    } else {
      game.socket.emit(SOCKET_CH, {
        type:    MSG_TRAVEL,
        payload: { toSceneId: destScene.id, actorId, spawnX: spawn.x, spawnY: spawn.y, fromSceneId },
      });
    }
  }

  // ── GM: ensure token on destination + activate scene ───────────────────────
  async function setupTokenAndActivate(destScene, actorId, spawnX, spawnY, fromSceneId = null) {
    if (!game.user?.isGM) return;

    const gSize = destScene.grid?.size ?? 100;

    if (actorId) {
      const actor = game.actors.get(actorId);
      if (actor) {
        // Cleanup-first: delete any stale token for this actor at destination before creating fresh.
        // This guarantees a clean single-token state regardless of how many times you travel.
        const existingAtDest = destScene.tokens.find(t => t.actorId === actorId);
        if (existingAtDest) {
          await existingAtDest.delete()
            .catch(e => console.warn(TAG, "cleanup dest stale token:", e));
        }

        // Always create a fresh token at the spawn position
        const tokenData  = actor.prototypeToken.toObject();
        tokenData.x      = Math.round(spawnX - (tokenData.width  ?? 1) * gSize / 2);
        tokenData.y      = Math.round(spawnY - (tokenData.height ?? 1) * gSize / 2);
        tokenData.actorId = actorId;
        await destScene.createEmbeddedDocuments("Token", [tokenData])
          .catch(e => console.warn(TAG, "token create failed:", e));
      }
    }

    await destScene.activate().catch(e => console.error(TAG, "scene activate failed:", e));

    // Background cleanup: delete party token from source scene after we've already switched
    if (fromSceneId && actorId && fromSceneId !== destScene.id) {
      const fromScene = game.scenes.get(fromSceneId);
      const oldToken  = fromScene?.tokens?.find?.(t => t.actorId === actorId);
      if (oldToken) {
        oldToken.delete().catch(e => console.warn(TAG, "cleanup source token:", e));
      }
    }
  }

  // ── Scene-visited tracking ──────────────────────────────────────────────────
  async function markSceneVisited(scene) {
    if (!scene || !game.user?.isGM) return;
    if (isSceneVisited(scene)) return;
    await scene.setFlag(MODULE_ID, `${FABULA_ROOT}.${GEN_KEY}.sceneVisited`, true)
      .catch(e => console.warn(TAG, "markSceneVisited failed:", e));
    console.debug(TAG, `Scene "${scene.name}" marked as visited.`);
  }

  // ── Drop-off animation trigger (called from canvasReady) ────────────────────
  // By the time this runs, the drawToken guard installed in executeTravelTo has already fired
  // and set token.alpha = 0 as the token was drawn.  This function reinforces that hiding,
  // pans the camera, and then plays the drop-off animation.
  async function triggerDropOff(actorId, sceneMode) {
    if (!actorId) return;

    // Re-apply hiding in case the token was drawn before our guard was installed
    let token = canvas.tokens?.placeables?.find?.(t => t.document?.actorId === actorId) ?? null;
    if (token) token.alpha = 0;

    if (sceneMode === "dungeon") {
      // Wait for dungeon pathing standby (graph rebuilt + party token assigned, max 5 s)
      await new Promise(resolve => {
        let done = false;
        const timer = setTimeout(() => { if (!done) { done = true; resolve(); } }, 5000);
        Hooks.once("dungeonPathing.standbyStart", () => {
          if (!done) { done = true; clearTimeout(timer); resolve(); }
        });
      });
      // Prefer the dp-state token reference (most current after rebuild)
      const dpToken = globalThis.__ONI_DUNGEON_PATHING__?.state?.partyToken ?? null;
      if (dpToken) { token = dpToken; }
      if (token) token.alpha = 0; // re-apply in case rebuild refreshed the token ref

      if (token && canvas?.ready) {
        const gSize = Number(canvas?.grid?.size ?? 100) || 100;
        const tw    = Number(token.document?.width  ?? 1) * gSize;
        const th    = Number(token.document?.height ?? 1) * gSize;
        canvas.animatePan?.({ x: Number(token.document.x) + tw / 2, y: Number(token.document.y) + th / 2, duration: 300 });
        await new Promise(r => setTimeout(r, 350));
        token.alpha = 0;
        await DP.FastTravel?.runDropOffAnimation?.(token).catch(() => { if (token) token.alpha = 1; });
      }
    } else {
      if (token && canvas?.ready) {
        const gSize = Number(canvas?.grid?.size ?? 100) || 100;
        const tw    = Number(token.document?.width  ?? 1) * gSize;
        const th    = Number(token.document?.height ?? 1) * gSize;
        canvas.animatePan?.({ x: Number(token.document.x) + tw / 2, y: Number(token.document.y) + th / 2, duration: 400 });
        await new Promise(r => setTimeout(r, 450));
        token.alpha = 0;
        await DP.FastTravel?.runDropOffAnimation?.(token).catch(() => { if (token) token.alpha = 1; });
      }
    }
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
        const { toSceneId, actorId, spawnX, spawnY, fromSceneId } = msg.payload ?? {};
        const dest = game.scenes.get(toSceneId);
        if (!dest) { console.warn(TAG, "travel: destination not found:", toSceneId); return; }
        await setupTokenAndActivate(dest, actorId, spawnX, spawnY, fromSceneId ?? null)
          .catch(e => console.error(TAG, "setupTokenAndActivate (socket) failed:", e));
        return;
      }

      // Prime drop-off animation on non-initiating clients
      if (msg?.type === "DP_TRAVEL_ARRIVING") {
        const { sceneId, actorId: aId } = msg.payload ?? {};
        // Install drawToken guard so the token is hidden the instant Foundry draws it
        let gId = null;
        if (aId) {
          gId = Hooks.on("drawToken", (tp) => {
            if (tp.document?.actorId !== aId) return;
            tp.alpha = 0;
            Hooks.off("drawToken", gId);
          });
        }
        window.__ONI_DP_DROPOFF_SCENE__ = { sceneId, actorId: aId, guardId: gId };
        return;
      }

      // Pick-up animation broadcast from the controller
      if (msg?.type === "DP_ST_ANIM") {
        if (msg.payload?.userId === game.user?.id) return;
        const tkn = globalThis.__ONI_DUNGEON_PATHING__?.state?.partyToken ?? null;
        if (tkn) {
          DP.FastTravel?.runGryphonAnimation?.(tkn, { waitForUpdate: true }).catch(() => {
            tkn.alpha = 1;
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
    getNavigationName,
    isSceneVisited,
    isFtEnabled,
    getEligibleDestinations,
    markSceneVisited,
  };

  // ── Bootstrap ───────────────────────────────────────────────────────────────
  Hooks.once("ready", () => {
    injectTravelStyles(); // pre-inject so first dialog open is instant
    setupSocketListener();

    Hooks.on("canvasReady", async () => {
      const scene = canvas?.scene;

      // Drop-off animation — token should already be hidden by the pre-installed drawToken guard.
      const dropOff = window.__ONI_DP_DROPOFF_SCENE__;
      if (dropOff?.sceneId === scene?.id) {
        window.__ONI_DP_DROPOFF_SCENE__ = null;
        // Clean up the drawToken guard (it has already fired or is no longer needed)
        if (dropOff.guardId != null) Hooks.off("drawToken", dropOff.guardId);
        triggerDropOff(dropOff.actorId, general(scene).sceneMode).catch(() => null);
      }

      // Auto-mark scene as visited when it becomes the active scene.
      // Only marks scenes with a sceneMode set to avoid marking every scene.
      if (!scene?.active) return;
      const sceneMode = general(scene).sceneMode;
      if (!sceneMode || sceneMode === "none") return;

      if (game.user?.isGM) {
        await markSceneVisited(scene);
      } else {
        game.socket.emit(SOCKET_CH, { type: MSG_VISITED, payload: { sceneId: scene.id } });
      }
    });

    console.debug(TAG, "Scene Travel System loaded.");
  });
})();
