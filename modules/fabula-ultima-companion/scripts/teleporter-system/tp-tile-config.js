// ============================================================================
// Teleporter System — Tile Configuration UI
//
// Injects a "Teleporter" sub-tab into the "Fabula Configuration" outer tab
// that dp-tile-config.js creates.  Runs after dp-tile-config.js (later in
// module.json), so the Fabula panel + sub-nav/sub-content DOM already exists
// by the time our renderTileConfig hook fires.
//
// Architecture: same sub-tab pattern as dungeon pathing —
//   • append <a class="item" data-sub-tab="teleporter"> to [data-oni-fabula-sub-nav]
//   • append <div class="oni-fabula-sub-panel" data-sub-tab="teleporter"> to
//     [data-oni-fabula-sub-content]
//   The existing click-delegation on the sub-nav handles show/hide automatically.
//
// "Set Destination" ARM MODE:
//   Minimizes the tile config window, shows a full-screen overlay, waits for
//   the user to click on the canvas.  If the click lands on a tile object that
//   tile becomes the destination; otherwise the world coordinates are recorded.
//   With "Two-Way" enabled, the targeted tile is also wired back to this tile.
// ============================================================================
(() => {
  const GUARD = "oni.TeleporterTileConfig";
  if (window[GUARD]?.installed) return;
  window[GUARD] = { installed: true };

  const TP        = globalThis.TeleporterSystem ??= {};
  const MODULE_ID = TP.MODULE_ID ?? "fabula-ultima-companion";
  const FLAG_ROOT = TP.FLAG_ROOT ?? "teleporter";
  const TAG       = "[TeleporterSystem][TileConfig]";
  const STYLE_ID  = "oni-tp-tile-config-style";
  const DEFAULT_SFX = TP.DEFAULT_SFX
    ?? "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/SE_BTL_FootStepNormal_1.ogg";

  // ── Arm mode state (persisted on window so cleanup survives re-runs) ─────────
  const armState = window.__TP_ARM_STATE__ ??= {
    active:        false,
    sourceTileId:  null,
    sourceSceneId: null,
    appId:         null,
    twoWay:        false,
    clickHandler:  null,
    escHandler:    null,
  };
  window.__TP_ARM_STATE__ = armState;

  // ── CSS ──────────────────────────────────────────────────────────────────────
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
      .oni-tp-section .form-group { margin-bottom: 10px; }
      .oni-tp-section h3 { margin: 10px 0 6px; font-size: 1rem; }
      .oni-tp-section h3:first-child { margin-top: 0; }

      .oni-tp-dest-display {
        font-family: monospace;
        font-size: 12px;
        padding: 4px 6px;
        background: rgba(0,0,0,0.12);
        border-radius: 4px;
        border: 1px solid rgba(255,255,255,0.1);
        opacity: .85;
        width: 100%;
      }

      /* ── Arm mode overlay ── */
      #oni-tp-arm-overlay {
        position: fixed;
        inset: 0;
        z-index: 9998;
        cursor: crosshair;
        background: rgba(60, 20, 160, 0.10);
      }
      #oni-tp-arm-label {
        position: fixed;
        top: 14px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 9999;
        background: rgba(20, 5, 60, 0.90);
        color: #c8aaff;
        border: 1px solid rgba(140, 90, 255, 0.55);
        border-radius: 8px;
        padding: 9px 20px;
        font-size: 13px;
        font-weight: 700;
        pointer-events: none;
        letter-spacing: 0.4px;
        white-space: nowrap;
        box-shadow: 0 4px 18px rgba(0,0,0,0.5);
      }
    `;
    document.head.appendChild(s);
  }

  // ── Arm mode overlay helpers ─────────────────────────────────────────────────
  function showArmOverlay() {
    if (!document.getElementById("oni-tp-arm-overlay")) {
      const el = document.createElement("div");
      el.id = "oni-tp-arm-overlay";
      document.body.appendChild(el);
    }
    if (!document.getElementById("oni-tp-arm-label")) {
      const el = document.createElement("div");
      el.id = "oni-tp-arm-label";
      el.textContent = "🎯  Click a tile or canvas location to set teleporter destination   [Esc to cancel]";
      document.body.appendChild(el);
    }
  }

  function hideArmOverlay() {
    document.getElementById("oni-tp-arm-overlay")?.remove();
    document.getElementById("oni-tp-arm-label")?.remove();
  }

  // ── Restore tile config app after arm mode ───────────────────────────────────
  function restoreApp() {
    const { appId, sourceTileId, sourceSceneId } = armState;

    const existing = Object.values(ui.windows ?? {}).find(w => w.appId === appId);
    if (existing) {
      existing.maximize?.().catch?.(() => {});
      return;
    }

    // App was closed — re-open the tile config
    const scene   = game.scenes.get(sourceSceneId ?? canvas?.scene?.id);
    const tileDoc = scene?.tiles?.get?.(sourceTileId);
    if (tileDoc) new TileConfig(tileDoc).render(true);
  }

  // ── Cancel arm mode (Escape) ─────────────────────────────────────────────────
  function cancelArmMode() {
    if (!armState.active) return;
    armState.active = false;

    const overlay = document.getElementById("oni-tp-arm-overlay");
    if (overlay && armState.clickHandler) {
      overlay.removeEventListener("pointerdown", armState.clickHandler);
    }
    hideArmOverlay();

    if (armState.escHandler) window.removeEventListener("keydown", armState.escHandler, true);
    armState.clickHandler = null;
    armState.escHandler   = null;

    restoreApp();
  }

  // ── World coordinate conversion ──────────────────────────────────────────────
  function clientToWorld(clientX, clientY) {
    if (globalThis.DungeonPathing?.Graph?.clientToWorld) {
      return globalThis.DungeonPathing.Graph.clientToWorld(clientX, clientY);
    }
    const t   = canvas?.stage?.worldTransform;
    if (!t) return { x: clientX, y: clientY };
    const el   = canvas?.app?.view ?? canvas?.app?.renderer?.view;
    const rect = el?.getBoundingClientRect?.() ?? { left: 0, top: 0, width: 1, height: 1 };
    const elW  = el?.width  || rect.width  || 1;
    const elH  = el?.height || rect.height || 1;
    const cx   = ((clientX - rect.left) / rect.width)  * elW;
    const cy   = ((clientY - rect.top)  / rect.height) * elH;
    return {
      x: (cx - t.tx) / (t.a || 1),
      y: (cy - t.ty) / (t.d || 1),
    };
  }

  // ── Find tile under world point ──────────────────────────────────────────────
  function findTileAt(worldX, worldY) {
    for (const tile of (canvas?.tiles?.placeables ?? [])) {
      const d = tile.document;
      if (worldX >= d.x && worldX <= d.x + d.width &&
          worldY >= d.y && worldY <= d.y + d.height) {
        return tile;
      }
    }
    return null;
  }

  // ── Save destination flag ────────────────────────────────────────────────────
  async function setDestination(tileDoc, dest, silent = false) {
    try {
      await tileDoc.setFlag(MODULE_ID, `${FLAG_ROOT}.destination`, dest);
      if (!silent) ui.notifications?.info?.(`Teleporter destination set: ${describeDestination(dest)}`);
    } catch (e) {
      console.warn(TAG, "setDestination failed:", e);
      if (!silent) ui.notifications?.error?.("Failed to set teleporter destination.");
    }
  }

  function describeDestination(dest) {
    if (!dest) return "Not set";
    const isCurScene = !dest.sceneId || dest.sceneId === canvas?.scene?.id;
    const sceneLabel = isCurScene ? "" : ` → scene ${dest.sceneId?.slice(0, 8)}…`;
    if (dest.type === "tile")   return `Tile ${dest.tileId?.slice(0, 8)}…${sceneLabel}`;
    if (dest.type === "coords") return `(${Math.round(dest.x ?? 0)}, ${Math.round(dest.y ?? 0)})${sceneLabel}`;
    return "Unknown";
  }

  // ── Enter arm mode ───────────────────────────────────────────────────────────
  function enterArmMode(app, tileDoc, twoWay) {
    cancelArmMode(); // clean up any stale arm mode

    armState.active        = true;
    armState.sourceTileId  = tileDoc.id;
    armState.sourceSceneId = (tileDoc.parent ?? canvas?.scene)?.id;
    armState.appId         = app.appId;
    armState.twoWay        = twoWay;

    app.minimize?.().catch?.(() => {});
    showArmOverlay();

    // Escape key cancels
    armState.escHandler = (ev) => {
      if (ev.key !== "Escape") return;
      cancelArmMode();
    };
    window.addEventListener("keydown", armState.escHandler, true);

    const overlay = document.getElementById("oni-tp-arm-overlay");
    if (!overlay) { cancelArmMode(); return; }

    armState.clickHandler = async (ev) => {
      if (ev.button !== 0) return;

      // Reject clicks outside the canvas element (e.g. on Foundry UI panels)
      const canvasEl = canvas?.app?.view ?? document.querySelector("#board canvas");
      const cr = canvasEl?.getBoundingClientRect?.();
      if (cr) {
        const outside = ev.clientX < cr.left || ev.clientX > cr.right
                     || ev.clientY < cr.top  || ev.clientY > cr.bottom;
        if (outside) {
          ev.preventDefault(); ev.stopPropagation();
          ui.notifications?.warn?.("Click on the map canvas to set the destination, or press Esc to cancel.");
          return;
        }
      }

      ev.preventDefault();
      ev.stopPropagation();

      // Clean up arm mode state before async work
      overlay.removeEventListener("pointerdown", armState.clickHandler);
      window.removeEventListener("keydown", armState.escHandler, true);
      hideArmOverlay();
      armState.active       = false;
      armState.clickHandler = null;
      armState.escHandler   = null;

      const worldPt = clientToWorld(ev.clientX, ev.clientY);
      const hitTile = findTileAt(worldPt.x, worldPt.y);
      const sceneId = canvas?.scene?.id;

      if (hitTile && hitTile.document.id !== tileDoc.id) {
        // Destination is a tile object
        const dest = { type: "tile", tileId: hitTile.document.id, sceneId };
        await setDestination(tileDoc, dest);

        if (twoWay) {
          const backDest = { type: "tile", tileId: tileDoc.id, sceneId };
          await setDestination(hitTile.document, backDest, true);
          ui.notifications?.info?.("Two-way link set: both tiles now point to each other.");
        }
      } else {
        // Destination is canvas coordinates
        const dest = { type: "coords", x: Math.round(worldPt.x), y: Math.round(worldPt.y), sceneId };
        await setDestination(tileDoc, dest);
      }

      restoreApp();
    };

    overlay.addEventListener("pointerdown", armState.clickHandler);
  }

  // ── Main injection ────────────────────────────────────────────────────────────
  Hooks.on("renderTileConfig", async (app, html) => {
    try {
      ensureStyle();

      const root = (html instanceof HTMLElement) ? html
        : html?.[0] instanceof HTMLElement        ? html[0]
        : app?.element?.[0]                       ?? app?.element ?? null;
      if (!root) return;

      // Wait for dp-tile-config to inject the Fabula panel first
      const subNav     = root.querySelector("[data-oni-fabula-sub-nav='1']");
      const subContent = root.querySelector("[data-oni-fabula-sub-content='1']");
      if (!subNav || !subContent) return;

      // Don't double-inject
      if (subNav.querySelector("[data-sub-tab='teleporter']")) return;

      const tileDoc = app?.document ?? app?.object;
      if (!tileDoc) return;

      // ── Nav button ────────────────────────────────────────────────────────────
      const navBtn = document.createElement("a");
      navBtn.className      = "item";
      navBtn.dataset.subTab = "teleporter";
      navBtn.innerHTML      = `<i class="fas fa-exchange-alt"></i> Teleporter`;
      subNav.appendChild(navBtn);

      // ── Panel ────────────────────────────────────────────────────────────────
      const panel = document.createElement("div");
      panel.className      = "oni-fabula-sub-panel oni-tp-section";
      panel.dataset.subTab = "teleporter";
      panel.style.display  = "none";

      // Read current flags
      const flags       = tileDoc.getFlag?.(MODULE_ID, FLAG_ROOT) ?? {};
      const isEnabled   = flags.enabled   === true  || flags.enabled   === "true";
      const isConfirm   = flags.confirmMode !== false && flags.confirmMode !== "false";
      const isTwoWay    = flags.twoWay     === true  || flags.twoWay     === "true";
      const destination = flags.destination ?? null;
      const sfxUrl      = typeof flags.sfxUrl === "string" ? flags.sfxUrl : "";

      panel.innerHTML = `
        <h3 style="margin-top:0;"><i class="fas fa-exchange-alt"></i> Teleporter Settings</h3>

        <div class="form-group">
          <label>Enable Teleporter</label>
          <div class="form-fields">
            <input type="checkbox"
                   name="flags.${MODULE_ID}.${FLAG_ROOT}.enabled"
                   data-dtype="Boolean"
                   ${isEnabled ? "checked" : ""} />
          </div>
          <p class="notes">When checked, the party token stopping inside this tile triggers teleportation.</p>
        </div>

        <div class="form-group">
          <label>Ask for Confirmation</label>
          <div class="form-fields">
            <input type="checkbox"
                   name="flags.${MODULE_ID}.${FLAG_ROOT}.confirmMode"
                   data-dtype="Boolean"
                   ${isConfirm ? "checked" : ""} />
          </div>
          <p class="notes">
            <b>On</b>: a dialog asks the player before teleporting.<br>
            <b>Off</b>: teleportation happens instantly.<br>
            <i>In Dungeon mode the DP confirm button already serves as confirmation;
            this adds an extra teleport-specific prompt.</i>
          </p>
        </div>

        <h3><i class="fas fa-map-marker-alt"></i> Destination</h3>

        <div class="form-group">
          <label>Current Destination</label>
          <div class="form-fields">
            <input class="oni-tp-dest-display" type="text" readonly
                   data-tp-dest-display="1"
                   value="${describeDestination(destination)}" />
          </div>
        </div>

        <div class="form-group">
          <label>Two-Way Link</label>
          <div class="form-fields">
            <input type="checkbox"
                   name="flags.${MODULE_ID}.${FLAG_ROOT}.twoWay"
                   data-dtype="Boolean"
                   data-tp-twoway="1"
                   ${isTwoWay ? "checked" : ""} />
          </div>
          <p class="notes">
            When on and the destination is a tile object, the targeted tile is also
            configured to teleport back to this tile.
          </p>
        </div>

        <div class="form-group">
          <label>&nbsp;</label>
          <div class="form-fields">
            <button type="button" data-tp-set-dest="1" style="flex:1;">
              <i class="fas fa-crosshairs"></i> Set Destination
            </button>
          </div>
          <p class="notes">
            Click, then click a tile or canvas point on the map to record the destination.
          </p>
        </div>

        <h3><i class="fas fa-volume-up"></i> Sound Effect</h3>

        <div class="form-group">
          <label>SFX URL</label>
          <div class="form-fields">
            <input type="text"
                   name="flags.${MODULE_ID}.${FLAG_ROOT}.sfxUrl"
                   value="${sfxUrl}"
                   placeholder="${DEFAULT_SFX}" />
          </div>
          <p class="notes">Leave blank to use the default teleport sound.</p>
        </div>
      `;

      // Wire "Set Destination" button
      panel.querySelector("[data-tp-set-dest='1']")?.addEventListener("click", () => {
        const twoWayNow = panel.querySelector("[data-tp-twoway='1']")?.checked ?? false;
        enterArmMode(app, tileDoc, twoWayNow);
      });

      // Refresh destination display after flags update from outside
      // (e.g. 2-way setFlag call on this tile from another tile's arm mode)
      const refreshDestDisplay = () => {
        const latest = tileDoc.getFlag?.(MODULE_ID, FLAG_ROOT)?.destination ?? null;
        const el = panel.querySelector("[data-tp-dest-display='1']");
        if (el) el.value = describeDestination(latest);
      };

      const hUpdateTile = Hooks.on("updateTile", (doc) => {
        if (doc.id !== tileDoc.id) return;
        refreshDestDisplay();
      });
      // Clean up listener when this particular app instance closes
      Hooks.once(`closeApplication`, (closedApp) => {
        if (closedApp?.appId === app.appId) Hooks.off("updateTile", hUpdateTile);
      });

      subContent.appendChild(panel);

      try { app.setPosition({ height: "auto" }); } catch {}
    } catch (e) {
      console.warn(TAG, "inject failed:", e);
    }
  });

  console.debug(TAG, "Tile config hook registered.");
})();
