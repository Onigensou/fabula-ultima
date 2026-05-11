// ============================================================================
// Dungeon Pathing System — Tile Configuration Tab
// Injects a "Fabula Configuration" tab into Foundry's Tile Config window.
// Other oni scripts (Treasure Config, Journal Config, Event Config) detect
// this tab and inject their own sections into it rather than creating separate
// tabs.
//
// Tab visibility is managed manually — the panel does NOT use class="tab"
// so Foundry's Tabs system never touches it.  We register a click handler on
// the Fabula button BEFORE calling bindTabs() so stopImmediatePropagation()
// prevents Foundry from trying (and failing) to activate a non-.tab panel.
//
// Per-tile flag stored at:
//   flags.fabula-ultima-companion.dungeonPathing.persistAfterTrigger
// ============================================================================

function installDungeonTileConfig() {
  const GLOBAL_KEY = "oni.DungeonTileConfig";
  if (window[GLOBAL_KEY]?.installed) return;
  window[GLOBAL_KEY] = { installed: true };

  const DP          = globalThis.DungeonPathing ??= {};
  const MODULE_ID   = "fabula-ultima-companion";
  const TAG         = "[DungeonPathing][TileConfig]";
  const STYLE_ID    = "oni-fabula-tile-config-style";
  const MARKER_ATTR = "data-oni-fabula-config";
  const TAB_ID      = "oni-fabula-config";

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
      /* Flex-wrap nav so tabs never overflow the window */
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

  function resizeTileConfigForTabs(app, root) {
    try {
      const nav = root?.querySelector("nav.sheet-tabs");
      if (!nav) return;
      const tabCount = nav.querySelectorAll(".item").length;
      app.setPosition({
        width:  Math.min(Math.max(760, tabCount * 96), 1180),
        height: "auto",
      });
    } catch {}
  }

  Hooks.on("renderTileConfig", async (app, html) => {
    try {
      ensureStyle();

      const root = getRoot(html, app);
      if (!root) return;
      if (root.hasAttribute(MARKER_ATTR)) return;
      root.setAttribute(MARKER_ATTR, "1");

      const tileDoc   = app?.document ?? app?.object;
      const tabsNav   = root.querySelector("nav.sheet-tabs");
      const sheetBody = root.querySelector(".sheet-body") || root.querySelector(".window-content form");
      if (!tabsNav || !sheetBody) {
        console.warn(TAG, "No tabsNav or sheetBody found.");
        return;
      }

      // ── Tab button ──────────────────────────────────────────────
      const tabButton = document.createElement("a");
      tabButton.className = "item";
      tabButton.dataset.tab = TAB_ID;
      tabButton.innerHTML = `<i class="fas fa-book-open"></i> Fabula Configuration`;
      tabsNav.appendChild(tabButton);

      // ── Tab panel ───────────────────────────────────────────────
      // Intentionally does NOT have class="tab" — Foundry's Tabs system
      // must not touch this panel.  We control visibility manually below.
      const tabPanel = document.createElement("div");
      tabPanel.dataset.tab = TAB_ID;
      tabPanel.style.display = "none";

      // ── Dungeon section content ─────────────────────────────────
      const scene       = tileDoc?.parent ?? null;
      const tileId      = tileDoc?.id ?? null;
      const pathingKey  = DP.PATHING_ROOT_KEY ?? "dungeonPathing";
      const persistFlag = tileDoc?.getFlag(MODULE_ID, `${pathingKey}.persistAfterTrigger`) ?? false;
      const initialType = (scene && tileId) ? (DP.TileState?.getInitialType(scene, tileId) ?? "") : "";
      const currentType = (scene && tileId) ? (DP.TileState?.getCurrentType(scene, tileId) ?? "") : "";
      const visitedTile = (scene && tileId) ? (DP.TileState?.isVisited(scene, tileId) ?? false) : false;
      const persists    = persistFlag === true || persistFlag === "true";

      const dungeonSection = document.createElement("div");
      dungeonSection.className = "oni-fabula-section";
      dungeonSection.innerHTML = `
        <h3><i class="fas fa-dungeon"></i> Dungeon Configuration</h3>

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

        <h3><i class="fas fa-info-circle"></i> Tracked State</h3>

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
          <label>Visited (Fast Travel)</label>
          <div class="form-fields">
            <input class="oni-dp-tile-info" type="text" readonly
                   value="${visitedTile ? "Yes — eligible for fast travel" : "No — not yet visited"}" />
          </div>
          <p class="notes">
            Landmark tiles (Camp, Event, Story, Final) become fast travel destinations
            once the party steps on them.
          </p>
        </div>
      `;

      tabPanel.appendChild(dungeonSection);
      sheetBody.appendChild(tabPanel);

      // ── Manual tab switching ────────────────────────────────────
      // Register BEFORE bindTabs() so our listener is first in queue and
      // stopImmediatePropagation() prevents Foundry from trying to activate
      // a panel that isn't a .tab element.
      tabButton.addEventListener("click", (ev) => {
        ev.stopImmediatePropagation();

        tabsNav.querySelectorAll(".item[data-tab]").forEach(i => i.classList.remove("active"));
        tabButton.classList.add("active");

        sheetBody.querySelectorAll(".tab").forEach(p => p.classList.remove("active"));

        tabPanel.style.display = "";
        try { app.setPosition({ height: "auto" }); } catch {}
      });

      // When a native tab is clicked: hide our panel
      tabsNav.addEventListener("click", (ev) => {
        const btn = ev.target.closest(".item[data-tab]");
        if (!btn || btn === tabButton) return;
        tabPanel.style.display = "none";
      });

      // Let Foundry manage the native tabs; our button is already handled above
      bindTabs(app, root);

      resizeTileConfigForTabs(app, root);
      console.debug(TAG, "Fabula Configuration tab injected.");
    } catch (e) {
      console.warn(TAG, "inject failed:", e);
    }
  });
}

Hooks.once("ready", () => {
  try { installDungeonTileConfig(); } catch (e) {
    console.error("[DungeonPathing][TileConfig] install failed:", e);
  }
});
