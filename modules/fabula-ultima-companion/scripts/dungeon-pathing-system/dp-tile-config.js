// ============================================================================
// Dungeon Pathing System — Tile Configuration Tab
//
// ARCHITECTURE NOTE — hook registration order
// ============================================
// event-configUI.js (module.json line 180) is an IIFE that registers its
// renderTileConfig hook immediately at script-load time.
// If we used Hooks.once("ready", ...) here (line 128), our hook would be
// registered *after* event-configUI's, so event-configUI would fire first
// and never see the fabulaPanel.
//
// Solution: we are also an IIFE, and we load at line 128 — before line 180 —
// so our renderTileConfig hook is registered first and fires first.
//
// Tab visibility is managed manually — the panel does NOT use class="tab"
// so Foundry's Tabs system never touches it.  We register a click handler on
// the Fabula button BEFORE calling bindTabs() so stopImmediatePropagation()
// prevents Foundry from trying (and failing) to activate a non-.tab panel.
//
// SUB-TABS ARCHITECTURE
// =====================
// The Fabula panel contains a secondary nav (data-oni-fabula-sub-nav="1") and
// a content container (data-oni-fabula-sub-content="1").  Each system injects:
//   • one <a class="item" data-sub-tab="…"> button into the sub-nav
//   • one <div class="oni-fabula-sub-panel" data-sub-tab="…"> into sub-content
// The click delegation handler (set up here, on the sub-nav element) handles
// ALL sub-tab buttons, including those added later by event / treasure / journal.
//
// TRIGGERS BLANK BUG FIX
// ======================
// When the Fabula tab is clicked we must only strip .active from TOP-LEVEL
// tab panels (direct children of sheetBody), NOT from sub-tab panels inside
// the Triggers outer tab.  Using [...sheetBody.children].filter(…) instead of
// sheetBody.querySelectorAll(".tab") prevents that corruption.
//
// Per-tile flag stored at:
//   flags.fabula-ultima-companion.dungeonPathing.persistAfterTrigger
// ============================================================================
(() => {
  const GLOBAL_KEY  = "oni.DungeonTileConfig";
  if (window[GLOBAL_KEY]?.installed) return;
  window[GLOBAL_KEY] = { installed: true };

  const DP          = globalThis.DungeonPathing ??= {};
  const MODULE_ID   = "fabula-ultima-companion";
  const TAG         = "[DungeonPathing][TileConfig]";
  const STYLE_ID    = "oni-fabula-tile-config-style";
  const MARKER_ATTR = "data-oni-fabula-config";
  const TAB_ID      = "oni-fabula-config";

  // ── Debug flag ─────────────────────────────────────────────────
  const DEBUG = false;
  const dbg  = (...a) => DEBUG && console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);

  // Tile types that default to fast-travel eligible when the per-tile
  // flag hasn't been explicitly set by the developer yet.
  const FT_ELIGIBLE_TYPES = new Set(["camp", "event", "story", "final"]);

  // ── CSS ────────────────────────────────────────────────────────
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
      /* Flex-wrap outer nav so tabs never overflow the window */
      [data-oni-fabula-config="1"] nav.sheet-tabs {
        display: flex;
        flex-wrap: wrap;
        row-gap: 4px;
        column-gap: 8px;
        align-items: center;
      }
      [data-oni-fabula-config="1"] nav.sheet-tabs .item {
        flex: 0 0 auto;
        white-space: nowrap;
      }

      /* ── Sub-nav (secondary tab bar inside Fabula panel) ── */
      .oni-fabula-sub-nav {
        display: flex;
        flex-wrap: wrap;
        gap: 2px 4px;
        padding: 6px 8px 0;
        margin-bottom: 1px;
        border-bottom: 1px solid var(--color-border-light-primary, rgba(153,153,153,0.3));
        list-style: none;
      }
      .oni-fabula-sub-nav .item {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 4px 12px 5px;
        font-size: 12px;
        font-weight: 600;
        border-radius: 4px 4px 0 0;
        border: 1px solid transparent;
        border-bottom: none;
        cursor: pointer;
        opacity: 0.65;
        color: inherit;
        text-decoration: none;
        white-space: nowrap;
        transition: opacity 0.1s;
        position: relative;
        bottom: -1px;
      }
      .oni-fabula-sub-nav .item:hover {
        opacity: 0.9;
      }
      .oni-fabula-sub-nav .item.active {
        opacity: 1;
        border-color: var(--color-border-light-primary, rgba(153,153,153,0.3));
        background: var(--color-bg, rgba(0,0,0,0.04));
      }

      /* ── Sub-panels ── */
      .oni-fabula-sub-content {
        padding: 0;
      }
      .oni-fabula-sub-panel {
        padding: 10px 8px;
      }

      /* ── Legacy section styles (kept for non-subTab fallback) ── */
      .oni-fabula-section { padding: 10px 8px; }
      .oni-fabula-section h3 { margin: 10px 0 6px; font-size: 1rem; }
      .oni-fabula-section h3:first-child { margin-top: 0; }
      .oni-fabula-section .form-group { margin-bottom: 10px; }
      .oni-fabula-section-divider { margin: 4px 8px 0; border-color: rgba(255,255,255,0.15); }
      .oni-fabula-section-header  { margin: 0 8px 6px; font-size: 1rem; }

      .oni-dp-tile-info {
        font-family: monospace;
        font-size: 12px;
        padding: 4px 6px;
        background: rgba(0,0,0,0.12);
        border-radius: 4px;
        border: 1px solid rgba(255,255,255,0.1);
        opacity: .85;
        width: 100%;
      }
    `;
    document.head.appendChild(s);
  }

  // ── Helpers ────────────────────────────────────────────────────
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

  function resizeTileConfigForTabs(app) {
    // Only adjust HEIGHT — changing width triggers a full Foundry re-render
    // which fires renderTileConfig again with a fresh DOM (breaking markers).
    try {
      app.setPosition({ height: "auto" });
      dbg("resizeTileConfigForTabs — height:auto applied");
    } catch (e) {
      warn("resizeTileConfigForTabs failed:", e);
    }
  }

  // ── Main injection ─────────────────────────────────────────────
  Hooks.on("renderTileConfig", async (app, html) => {
    try {
      dbg("── renderTileConfig fired ──", {
        appId:  app?.appId,
        tileId: app?.document?.id ?? app?.object?.id,
      });

      ensureStyle();

      const root = getRoot(html, app);
      if (!root) { warn("No root found."); return; }

      dbg("root element", {
        tag:         root.tagName,
        id:          root.id,
        className:   root.className,
        alreadyDone: root.hasAttribute(MARKER_ATTR),
      });

      if (root.hasAttribute(MARKER_ATTR)) { dbg("Already injected; skipping."); return; }
      root.setAttribute(MARKER_ATTR, "1");

      const tileDoc   = app?.document ?? app?.object;
      const tabsNav   = root.querySelector("nav.sheet-tabs");
      // Locate where native tab panels actually live — some apps (e.g. Monks Active Tiles)
      // do not wrap panels in a .sheet-body div, so we walk up from the first .tab panel.
      const firstNativeTab = root.querySelector(".tab[data-tab]");
      const sheetBody = firstNativeTab?.parentElement
        ?? root.querySelector(".sheet-body")
        ?? root.querySelector(".window-content form");

      dbg("DOM query results", {
        tabsNavFound:   !!tabsNav,
        sheetBodyFound: !!sheetBody,
        sheetBodyTag:   sheetBody?.tagName,
        sheetBodyClass: sheetBody?.className,
        existingNavItems: tabsNav
          ? [...tabsNav.querySelectorAll(".item")].map(i => i.dataset.tab || i.textContent.trim()).join(" | ")
          : "(nav not found)",
        existingTabPanels: sheetBody
          ? [...sheetBody.querySelectorAll("[data-tab]")].map(p => p.dataset.tab).join(", ")
          : "(sheetBody not found)",
      });

      if (!tabsNav || !sheetBody) {
        warn("Missing tabsNav or sheetBody — aborting injection.");
        return;
      }

      // ── Outer tab button ────────────────────────────────────────
      const tabButton = document.createElement("a");
      tabButton.className = "item";
      tabButton.dataset.tab = TAB_ID;
      tabButton.innerHTML = `<i class="fas fa-book-open"></i> Fabula Configuration`;
      tabsNav.appendChild(tabButton);

      dbg("Tab button appended to nav", {
        navItemsAfter: [...tabsNav.querySelectorAll(".item")].map(i => i.dataset.tab || i.textContent.trim()).join(" | "),
      });

      // ── Outer tab panel ─────────────────────────────────────────
      // Does NOT have class="tab" — Foundry's Tabs system must not touch it.
      // data-oni-fabula-panel distinguishes the PANEL from the nav button;
      // both share data-tab="oni-fabula-config" but only the panel has this attr.
      // Other scripts (event/treasure/journal) query [data-oni-fabula-panel="1"]
      // instead of [data-tab="oni-fabula-config"] to avoid matching the nav button.
      const tabPanel = document.createElement("div");
      tabPanel.dataset.tab = TAB_ID;
      tabPanel.setAttribute("data-oni-fabula-panel", "1");
      tabPanel.style.display = "none";

      // ── Sub-nav (secondary tab bar) ─────────────────────────────
      // Other scripts append their own <a class="item" data-sub-tab="…"> here.
      // The click delegation handler (below) fires for all of them.
      const subNav = document.createElement("nav");
      subNav.className = "oni-fabula-sub-nav";
      subNav.setAttribute("data-oni-fabula-sub-nav", "1");

      const dungeonBtn = document.createElement("a");
      dungeonBtn.className = "item active";
      dungeonBtn.dataset.subTab = "dungeon";
      dungeonBtn.innerHTML = `<i class="fas fa-dungeon"></i> Dungeon`;
      subNav.appendChild(dungeonBtn);

      // ── Sub-content container ───────────────────────────────────
      // Other scripts append their own .oni-fabula-sub-panel here.
      const subContent = document.createElement("div");
      subContent.className = "oni-fabula-sub-content";
      subContent.setAttribute("data-oni-fabula-sub-content", "1");

      // ── Dungeon sub-panel ───────────────────────────────────────
      const dungeonSubPanel = document.createElement("div");
      dungeonSubPanel.className = "oni-fabula-sub-panel";
      dungeonSubPanel.dataset.subTab = "dungeon";
      // Dungeon is the first tab — shown by default

      const scene       = tileDoc?.parent ?? null;
      const tileId      = tileDoc?.id ?? null;
      const pathingKey  = DP.PATHING_ROOT_KEY ?? "dungeonPathing";
      const persistFlag     = tileDoc?.getFlag(MODULE_ID, `${pathingKey}.persistAfterTrigger`) ?? false;
      const usableFlag      = tileDoc?.getFlag(MODULE_ID, `${pathingKey}.usable`) ?? false;
      const skipConfirmFlag = tileDoc?.getFlag(MODULE_ID, `${pathingKey}.skipConfirm`) ?? false;
      const initialType     = (scene && tileId) ? (DP.TileState?.getInitialType(scene, tileId) ?? "") : "";
      const currentType     = (scene && tileId) ? (DP.TileState?.getCurrentType(scene, tileId) ?? "") : "";
      const visitedTile     = (scene && tileId) ? (DP.TileState?.isVisited(scene, tileId) ?? false) : false;
      const persists        = persistFlag === true || persistFlag === "true";
      const usable          = usableFlag  === true || usableFlag  === "true";
      const skipConfirm     = skipConfirmFlag === true || skipConfirmFlag === "true";

      const forceMoveDir   = tileDoc?.getFlag(MODULE_ID, `${pathingKey}.forceMoveDirection`) ?? "";
      const forceMoveSteps = Math.max(1, Number(tileDoc?.getFlag(MODULE_ID, `${pathingKey}.forceMoveSteps`) ?? 1));

      // eligibleForFastTravel: explicit tile flag, or type-based default when unset
      const rawEligible = tileDoc?.getFlag?.(MODULE_ID, `${pathingKey}.eligibleForFastTravel`);
      const isEligible  = (rawEligible === null || rawEligible === undefined)
        ? FT_ELIGIBLE_TYPES.has(initialType)
        : (rawEligible === true || rawEligible === "true" || rawEligible === 1);

      dbg("Tile flags read", { persistFlag, skipConfirmFlag, initialType, currentType, visitedTile, rawEligible, isEligible });

      dungeonSubPanel.innerHTML = `
        <div class="form-group">
          <label>Persist after trigger</label>
          <div class="form-fields">
            <input type="checkbox"
                   name="flags.${MODULE_ID}.${pathingKey}.persistAfterTrigger"
                   data-dtype="Boolean"
                   ${persists ? "checked" : ""} />
          </div>
          <p class="notes">
            When checked, this tile stays active after its event fires and will not be blanked out.
            Use for persistent locations like camp sites or recurring encounters.
          </p>
        </div>

        <div class="form-group">
          <label>Skip Confirm</label>
          <div class="form-fields">
            <input type="checkbox"
                   name="flags.${MODULE_ID}.${pathingKey}.skipConfirm"
                   data-dtype="Boolean"
                   ${skipConfirm ? "checked" : ""} />
          </div>
          <p class="notes">
            When checked, landing on this tile skips the confirmation dialog and triggers the tile event immediately.
          </p>
        </div>

        <div class="form-group">
          <label>Usable</label>
          <div class="form-fields">
            <input type="checkbox"
                   name="flags.${MODULE_ID}.${pathingKey}.usable"
                   data-dtype="Boolean"
                   ${usable ? "checked" : ""} />
          </div>
          <p class="notes">
            When checked, landing on this tile shows an extra <b>Use</b> button in the confirmation
            panel. Pressing <b>Use</b> triggers the tile's event. Pressing <b>Confirm</b> lands
            without triggering it, letting the player choose when to act.
          </p>
        </div>

        <div class="form-group">
          <label>Eligible for Fast Travel</label>
          <div class="form-fields">
            <input type="checkbox"
                   name="flags.${MODULE_ID}.${pathingKey}.eligibleForFastTravel"
                   data-dtype="Boolean"
                   ${isEligible ? "checked" : ""} />
          </div>
          <p class="notes">
            When ON and the tile has been visited, it appears as a Fast Travel destination.
            Defaults to <b>ON</b> for Camp, Event, Story, and Final tiles.
          </p>
        </div>

        <hr class="oni-fabula-section-divider" />
        <h3 style="margin: 10px 0 6px;"><i class="fas fa-arrows-alt"></i> Force Move Settings</h3>
        <p class="notes" style="margin: 0 0 8px; font-style: italic;">
          Only active when the tile type is <strong>Force Move</strong>.
        </p>

        <div class="form-group">
          <label>Direction</label>
          <div class="form-fields">
            <select name="flags.${MODULE_ID}.${pathingKey}.forceMoveDirection" data-dtype="String">
              <option value="" ${!forceMoveDir ? "selected" : ""}>— not set —</option>
              <option value="N"  ${forceMoveDir === "N"  ? "selected" : ""}>↑ North</option>
              <option value="NE" ${forceMoveDir === "NE" ? "selected" : ""}>↗ North-East</option>
              <option value="E"  ${forceMoveDir === "E"  ? "selected" : ""}>→ East</option>
              <option value="SE" ${forceMoveDir === "SE" ? "selected" : ""}>↘ South-East</option>
              <option value="S"  ${forceMoveDir === "S"  ? "selected" : ""}>↓ South</option>
              <option value="SW" ${forceMoveDir === "SW" ? "selected" : ""}>↙ South-West</option>
              <option value="W"  ${forceMoveDir === "W"  ? "selected" : ""}>← West</option>
              <option value="NW" ${forceMoveDir === "NW" ? "selected" : ""}>↖ North-West</option>
            </select>
          </div>
          <p class="notes">Direction to push the token when this tile triggers.</p>
        </div>

        <div class="form-group">
          <label>Steps</label>
          <div class="form-fields">
            <input type="number"
                   name="flags.${MODULE_ID}.${pathingKey}.forceMoveSteps"
                   data-dtype="Number"
                   value="${forceMoveSteps}"
                   min="1" max="10" step="1" />
          </div>
          <p class="notes">Number of tiles to push the token in the chosen direction.</p>
        </div>

        <h3 style="margin: 10px 0 6px;"><i class="fas fa-info-circle"></i> Tracked State</h3>

        <div class="form-group">
          <label>Initial type</label>
          <div class="form-fields">
            <input class="oni-dp-tile-info" type="text" readonly
                   value="${initialType || "(not tracked yet)"}" />
          </div>
          <p class="notes">Set when the Dungeon Pathing graph is first built for this scene.</p>
        </div>

        <div class="form-group">
          <label>Current type</label>
          <div class="form-fields">
            <input class="oni-dp-tile-info" type="text" readonly
                   value="${currentType || "(not tracked yet)"}" />
          </div>
          <p class="notes">
            Reflects the tile's live state. Changes to <b>blank</b> after the event is consumed.
          </p>
        </div>

        <div class="form-group">
          <label>Visited</label>
          <div class="form-fields">
            <input type="checkbox" data-oni-visited-toggle="1" ${visitedTile ? "checked" : ""} ${!game.user?.isGM ? "disabled" : ""} />
          </div>
          <p class="notes">
            Set automatically when the party first steps on this tile.
            Cleared by <b>Reset Dungeon</b>. Eligible tiles with this checked become Fast Travel destinations.
            ${game.user?.isGM ? "GMs can manually toggle this." : ""}
          </p>
        </div>
      `;

      // GM-only: wire visited toggle to TileState directly (not a Foundry tile flag)
      if (game.user?.isGM && scene && tileId) {
        const visitedCb = dungeonSubPanel.querySelector("[data-oni-visited-toggle]");
        if (visitedCb) {
          visitedCb.addEventListener("change", async () => {
            try {
              if (visitedCb.checked) {
                await DP.TileState.markVisited(scene, tileId);
              } else {
                await DP.TileState.unmarkVisited(scene, tileId);
              }
            } catch (e) {
              warn("visited toggle failed:", e);
              // Revert checkbox on failure
              visitedCb.checked = !visitedCb.checked;
            }
          });
        }
      }

      subContent.appendChild(dungeonSubPanel);

      tabPanel.appendChild(subNav);
      tabPanel.appendChild(subContent);

      // Insert BEFORE the footer so the panel sits alongside other tab panels,
      // not after the "Update Tile" submit button.
      const formFooter = sheetBody.querySelector("footer, .sheet-footer");
      if (formFooter) {
        sheetBody.insertBefore(tabPanel, formFooter);
      } else {
        sheetBody.appendChild(tabPanel);
      }

      dbg("Tab panel inserted into sheetBody", {
        tabPanelDisplay:  tabPanel.style.display,
        parentTag:        tabPanel.parentElement?.tagName,
        parentClass:      tabPanel.parentElement?.className,
        panelDataTab:     tabPanel.dataset.tab,
        insertedBefore:   formFooter?.tagName ?? "(appended — no footer found)",
      });

      // ── Sub-nav click delegation ────────────────────────────────
      // Registered on the sub-nav element so clicks on buttons added later
      // by event / treasure / journal scripts are handled automatically.
      subNav.addEventListener("click", (ev) => {
        const btn = ev.target.closest(".item[data-sub-tab]");
        if (!btn) return;
        const subTabId = btn.dataset.subTab;
        dbg("Sub-tab clicked:", subTabId);

        subNav.querySelectorAll(".item[data-sub-tab]").forEach(i => i.classList.remove("active"));
        btn.classList.add("active");

        subContent.querySelectorAll(".oni-fabula-sub-panel").forEach(p => {
          p.style.display = (p.dataset.subTab === subTabId) ? "" : "none";
        });

        try { app.setPosition({ height: "auto" }); } catch {}
      });

      // ── Outer tab click handler ─────────────────────────────────
      // Registered BEFORE bindTabs() — our listener is first in queue so
      // stopImmediatePropagation() prevents Foundry from trying to activate
      // a panel that doesn't have class="tab".
      tabButton.addEventListener("click", (ev) => {
        ev.stopImmediatePropagation();
        dbg("Fabula tab button clicked — showing panel");

        tabsNav.querySelectorAll(".item[data-tab]").forEach(i => i.classList.remove("active"));
        tabButton.classList.add("active");

        // TRIGGERS BUG FIX: only deactivate DIRECT-CHILD .tab panels of sheetBody.
        // Using querySelectorAll(".tab") would also strip .active from sub-tab panels
        // inside the Triggers outer tab, corrupting Foundry's sub-tab state there.
        [...sheetBody.children]
          .filter(el => el.classList.contains("tab"))
          .forEach(p => p.classList.remove("active"));

        // Hide any other manually-managed panels (e.g. Teleporter tab).
        // stopImmediatePropagation() prevents the TP's tabsNav listener from firing,
        // so we must explicitly hide its panel here — mirroring what tp-tile-config.js
        // does for [data-oni-fabula-panel] when the Teleporter tab is clicked.
        sheetBody.querySelectorAll("[data-oni-tp-panel='1']").forEach(p => { p.style.display = "none"; });

        tabPanel.style.display = "";
        try { app.setPosition({ height: "auto" }); } catch {}
      });

      // When any native tab is clicked: hide our panel
      tabsNav.addEventListener("click", (ev) => {
        const btn = ev.target.closest(".item[data-tab]");
        if (!btn || btn === tabButton) return;
        dbg("Native tab clicked — hiding Fabula panel", { clickedTab: btn.dataset.tab });
        tabPanel.style.display = "none";
      });

      bindTabs(app, root);
      dbg("bindTabs called", {
        tabsCount:     Array.isArray(app?._tabs) ? app._tabs.length : Object.keys(app?._tabs ?? {}).length,
        activeTabs:    Array.isArray(app?._tabs)
          ? app._tabs.map(t => t?.active).join(", ")
          : Object.values(app?._tabs ?? {}).map(t => t?.active).join(", "),
      });

      resizeTileConfigForTabs(app);
      dbg("── Fabula Configuration tab injection complete ──");
    } catch (e) {
      warn("inject failed:", e);
    }
  });

  dbg("renderTileConfig hook registered (IIFE, load-time).");
})();
