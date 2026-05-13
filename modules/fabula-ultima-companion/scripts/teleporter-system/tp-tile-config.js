// ============================================================================
// Teleporter System — Tile Configuration Tab
//
// Injects a standalone top-level "Teleporter" tab into the Tile Config dialog,
// sibling to the native Basic / Overhead / Animation / Triggers tabs.
//
// Uses the same manual-visibility pattern as dp-tile-config.js:
//   • The panel does NOT have class="tab" so Foundry's Tabs system never
//     touches it.  We manage show/hide ourselves.
//   • The nav button is registered BEFORE bindTabs() so our
//     stopImmediatePropagation() call prevents Foundry from failing on a
//     non-.tab panel.
//
// ARM MODE ("Set Destination" button):
//   Minimizes the tile config window, shows a full-screen overlay with a
//   crosshair cursor.  The next canvas click records:
//     • a tile object  → destination { type:"tile", tileId, sceneId }
//     • canvas coords  → destination { type:"coords", x, y, sceneId }
//   Two-Way: also wires the destination tile back to this tile AND enables
//   the teleporter flag on BOTH tiles automatically.
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
  const MARKER_ATTR = "data-oni-tp-config";
  const TAB_ID    = "oni-tp-config";
  const DEFAULT_SFX = TP.DEFAULT_SFX
    ?? "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/SE_BTL_FootStepNormal_1.ogg";

  // ── Arm mode state ───────────────────────────────────────────────────────────
  const armState = window.__TP_ARM_STATE__ ??= {
    active: false, sourceTileId: null, sourceSceneId: null,
    appId: null, twoWay: false, clickHandler: null, escHandler: null,
  };
  window.__TP_ARM_STATE__ = armState;

  // ── CSS ──────────────────────────────────────────────────────────────────────
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
      /* ── Teleporter panel layout ── */
      [data-oni-tp-panel="1"] {
        padding: 10px 8px;
      }
      [data-oni-tp-panel="1"] h3 {
        margin: 10px 0 6px;
        font-size: 1rem;
      }
      [data-oni-tp-panel="1"] h3:first-child {
        margin-top: 0;
      }
      [data-oni-tp-panel="1"] .form-group {
        margin-bottom: 10px;
      }

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

  // ── Helpers ──────────────────────────────────────────────────────────────────
  function getRoot(html, app) {
    if (html instanceof HTMLElement) return html;
    if (html?.[0] instanceof HTMLElement) return html[0];
    if (app?.element?.[0] instanceof HTMLElement) return app.element[0];
    if (app?.element instanceof HTMLElement) return app.element;
    return null;
  }

  function bindTabs(app, root) {
    try {
      const tabs = app?._tabs;
      if (!tabs) return;
      if (Array.isArray(tabs)) tabs.forEach(t => t?.bind?.(root));
      else Object.values(tabs).forEach(t => t?.bind?.(root));
    } catch {}
  }

  // ── Arm mode overlay ─────────────────────────────────────────────────────────
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

  // ── Restore tile config app ───────────────────────────────────────────────────
  function restoreApp() {
    const existing = Object.values(ui.windows ?? {}).find(w => w.appId === armState.appId);
    if (existing) { existing.maximize?.().catch?.(() => {}); return; }
    const scene   = game.scenes.get(armState.sourceSceneId ?? canvas?.scene?.id);
    const tileDoc = scene?.tiles?.get?.(armState.sourceTileId);
    if (tileDoc) new TileConfig(tileDoc).render(true);
  }

  function cancelArmMode() {
    if (!armState.active) return;
    armState.active = false;
    const overlay = document.getElementById("oni-tp-arm-overlay");
    if (overlay && armState.clickHandler) overlay.removeEventListener("pointerdown", armState.clickHandler);
    hideArmOverlay();
    if (armState.escHandler) window.removeEventListener("keydown", armState.escHandler, true);
    armState.clickHandler = null;
    armState.escHandler   = null;
    restoreApp();
  }

  // ── World coordinate helpers ──────────────────────────────────────────────────
  function clientToWorld(clientX, clientY) {
    if (globalThis.DungeonPathing?.Graph?.clientToWorld) {
      return globalThis.DungeonPathing.Graph.clientToWorld(clientX, clientY);
    }
    const t    = canvas?.stage?.worldTransform;
    if (!t) return { x: clientX, y: clientY };
    const el   = canvas?.app?.view ?? canvas?.app?.renderer?.view;
    const rect = el?.getBoundingClientRect?.() ?? { left: 0, top: 0, width: 1, height: 1 };
    const cx   = ((clientX - rect.left) / rect.width)  * (el?.width  || rect.width  || 1);
    const cy   = ((clientY - rect.top)  / rect.height) * (el?.height || rect.height || 1);
    return { x: (cx - t.tx) / (t.a || 1), y: (cy - t.ty) / (t.d || 1) };
  }

  function findTileAt(worldX, worldY) {
    for (const tile of (canvas?.tiles?.placeables ?? [])) {
      const d = tile.document;
      if (worldX >= d.x && worldX <= d.x + d.width &&
          worldY >= d.y && worldY <= d.y + d.height) return tile;
    }
    return null;
  }

  // ── Destination persistence ───────────────────────────────────────────────────
  async function setDestination(tileDoc, dest, silent = false) {
    try {
      await tileDoc.setFlag(MODULE_ID, `${FLAG_ROOT}.destination`, dest);
      if (!silent) ui.notifications?.info?.(`Teleporter destination set: ${describeDestination(dest)}`);
    } catch (e) {
      console.warn(TAG, "setDestination failed:", e);
      if (!silent) ui.notifications?.error?.("Failed to save teleporter destination.");
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

  // ── Arm mode entry ────────────────────────────────────────────────────────────
  function enterArmMode(app, tileDoc, twoWay) {
    cancelArmMode();

    armState.active        = true;
    armState.sourceTileId  = tileDoc.id;
    armState.sourceSceneId = (tileDoc.parent ?? canvas?.scene)?.id;
    armState.appId         = app.appId;
    armState.twoWay        = twoWay;

    app.minimize?.().catch?.(() => {});
    showArmOverlay();

    armState.escHandler = (ev) => { if (ev.key === "Escape") cancelArmMode(); };
    window.addEventListener("keydown", armState.escHandler, true);

    const overlay = document.getElementById("oni-tp-arm-overlay");
    if (!overlay) { cancelArmMode(); return; }

    armState.clickHandler = async (ev) => {
      if (ev.button !== 0) return;

      // Reject clicks outside the canvas (e.g. on Foundry sidebar)
      const canvasEl = canvas?.app?.view ?? document.querySelector("#board canvas");
      const cr = canvasEl?.getBoundingClientRect?.();
      if (cr && (ev.clientX < cr.left || ev.clientX > cr.right ||
                  ev.clientY < cr.top  || ev.clientY > cr.bottom)) {
        ev.preventDefault(); ev.stopPropagation();
        ui.notifications?.warn?.("Click on the map to set a destination, or press Esc to cancel.");
        return;
      }

      ev.preventDefault(); ev.stopPropagation();

      // Clean up arm mode before async work
      overlay.removeEventListener("pointerdown", armState.clickHandler);
      window.removeEventListener("keydown", armState.escHandler, true);
      hideArmOverlay();
      armState.active = false;
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
          // Wire destination tile back to source tile
          const backDest = { type: "tile", tileId: tileDoc.id, sceneId };
          await setDestination(hitTile.document, backDest, true);
          // Auto-enable teleporter on both tiles
          await hitTile.document.setFlag(MODULE_ID, `${FLAG_ROOT}.enabled`, true)
            .catch(e => console.warn(TAG, "2-way: enable dest tile failed:", e));
          await tileDoc.setFlag(MODULE_ID, `${FLAG_ROOT}.enabled`, true)
            .catch(e => console.warn(TAG, "2-way: enable source tile failed:", e));
          ui.notifications?.info?.("Two-way link set: both tiles enabled and linked.");
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

      const root = getRoot(html, app);
      if (!root) return;

      // Don't double-inject
      if (root.hasAttribute(MARKER_ATTR)) return;
      root.setAttribute(MARKER_ATTR, "1");

      const tileDoc = app?.document ?? app?.object;
      if (!tileDoc) return;

      const tabsNav = root.querySelector("nav.sheet-tabs");
      const firstNativeTab = root.querySelector(".tab[data-tab]");
      const sheetBody = firstNativeTab?.parentElement
        ?? root.querySelector(".sheet-body")
        ?? root.querySelector(".window-content form");

      if (!tabsNav || !sheetBody) return;

      // ── Nav button ────────────────────────────────────────────────────────────
      const tabButton = document.createElement("a");
      tabButton.className   = "item";
      tabButton.dataset.tab = TAB_ID;
      tabButton.innerHTML   = `<i class="fas fa-exchange-alt"></i> Teleporter`;
      tabsNav.appendChild(tabButton);

      // ── Panel (no class="tab" — we manage visibility manually) ───────────────
      const tabPanel = document.createElement("div");
      tabPanel.dataset.tab = TAB_ID;
      tabPanel.setAttribute("data-oni-tp-panel", "1");
      tabPanel.style.display = "none";

      // Read current flags
      const flags       = tileDoc.getFlag?.(MODULE_ID, FLAG_ROOT) ?? {};
      const isEnabled   = flags.enabled     === true  || flags.enabled     === "true";
      const isConfirm   = flags.confirmMode !== false  && flags.confirmMode !== "false";
      const isTwoWay    = flags.twoWay      === true  || flags.twoWay      === "true";
      const destination = flags.destination ?? null;
      const sfxUrl      = typeof flags.sfxUrl === "string" ? flags.sfxUrl : "";

      tabPanel.innerHTML = `
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
            <b>On</b>: a dialog asks before teleporting.<br>
            <b>Off</b>: teleportation happens instantly.<br>
            <em>In Dungeon mode, the DP Confirm button already confirms the move;
            this adds a separate teleport-specific prompt.</em>
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
            When on and the destination is a tile object, automatically sets that tile's
            destination back to this tile and enables the teleporter on both tiles.
          </p>
        </div>

        <div class="form-group">
          <label>&nbsp;</label>
          <div class="form-fields">
            <button type="button" data-tp-set-dest="1" style="flex:1;">
              <i class="fas fa-crosshairs"></i> Set Destination
            </button>
          </div>
          <p class="notes">Click, then click a tile object or canvas point to record the destination.</p>
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
      tabPanel.querySelector("[data-tp-set-dest='1']")?.addEventListener("click", () => {
        const twoWayNow = tabPanel.querySelector("[data-tp-twoway='1']")?.checked ?? false;
        enterArmMode(app, tileDoc, twoWayNow);
      });

      // Refresh destination display when flags change (e.g. 2-way update from another tile)
      const hUpdateTile = Hooks.on("updateTile", (doc) => {
        if (doc.id !== tileDoc.id) return;
        const latest = tileDoc.getFlag?.(MODULE_ID, FLAG_ROOT)?.destination ?? null;
        const el = tabPanel.querySelector("[data-tp-dest-display='1']");
        if (el) el.value = describeDestination(latest);

        // Also refresh the enabled checkbox if it changed (2-way auto-enable)
        const enabledEl = tabPanel.querySelector(`[name="flags.${MODULE_ID}.${FLAG_ROOT}.enabled"]`);
        if (enabledEl) {
          const nowEnabled = tileDoc.getFlag?.(MODULE_ID, FLAG_ROOT)?.enabled;
          enabledEl.checked = nowEnabled === true || nowEnabled === "true";
        }
      });
      Hooks.once("closeApplication", (closedApp) => {
        if (closedApp?.appId === app.appId) Hooks.off("updateTile", hUpdateTile);
      });

      // Insert panel before the form footer
      const formFooter = sheetBody.querySelector("footer, .sheet-footer");
      if (formFooter) sheetBody.insertBefore(tabPanel, formFooter);
      else sheetBody.appendChild(tabPanel);

      // ── Tab click handler (BEFORE bindTabs so we can stopImmediatePropagation) ─
      tabButton.addEventListener("click", (ev) => {
        ev.stopImmediatePropagation();

        tabsNav.querySelectorAll(".item[data-tab]").forEach(i => i.classList.remove("active"));
        tabButton.classList.add("active");

        // Hide native .tab panels only (direct children of sheetBody)
        [...sheetBody.children]
          .filter(el => el.classList.contains("tab"))
          .forEach(p => p.classList.remove("active"));

        // Hide any other manually-managed panels (e.g. Fabula Configuration)
        sheetBody.querySelectorAll("[data-oni-fabula-panel='1']").forEach(p => { p.style.display = "none"; });

        tabPanel.style.display = "";
        try { app.setPosition({ height: "auto" }); } catch {}
      });

      // Hide our panel when any native tab is clicked
      tabsNav.addEventListener("click", (ev) => {
        const btn = ev.target.closest(".item[data-tab]");
        if (!btn || btn === tabButton) return;
        tabPanel.style.display = "none";
      });

      bindTabs(app, root);
      try { app.setPosition({ height: "auto" }); } catch {}
    } catch (e) {
      console.warn(TAG, "inject failed:", e);
    }
  });

  console.debug(TAG, "Tile config hook registered (IIFE).");
})();
