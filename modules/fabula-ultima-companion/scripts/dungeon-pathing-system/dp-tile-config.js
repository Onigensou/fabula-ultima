// ============================================================================
// Dungeon Pathing System — Tile Configuration Tab
// Injects a "Dungeon Configuration" tab into Foundry's Tile Config window.
//
// Per-tile flag stored at:
//   flags.fabula-ultima-companion.dungeonPathing.clearAfterTrigger
//   "" | undefined → system default (use registry clearAfterTrigger)
//   "true"         → always clear after trigger
//   "false"        → never clear after trigger (tile stays active)
// ============================================================================
(() => {
  const DP        = globalThis.DungeonPathing ??= {};
  const MODULE_ID = "fabula-ultima-companion";
  const TAG       = "[DungeonPathing][TileConfig]";
  const STYLE_ID  = "oni-dp-tile-config-style";
  const MARKER    = "data-oni-dp-tile";

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
      .oni-dp-tile-wrap { padding: 10px 8px; }
      .oni-dp-tile-wrap h3 { margin: 10px 0 6px; font-size: 1rem; }
      .oni-dp-tile-wrap h3:first-child { margin-top: 0; }
      .oni-dp-tile-wrap .form-group { margin-bottom: 10px; }
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

  function inject(app, html) {
    const root = getRoot(html, app);
    if (!root) return;
    if (root.querySelector(`[${MARKER}]`)) return;

    const tileDoc = app.object ?? app.document ?? null;

    const nav =
      root.querySelector(`nav.sheet-tabs.tabs[data-group="main"]`) ||
      root.querySelector(`nav.sheet-tabs.tabs`) ||
      root.querySelector(`nav.sheet-tabs`);
    if (!nav) { console.warn(TAG, "No nav found in TileConfig"); return; }

    const existingTab = root.querySelector(`.tab[data-group="main"]`) || root.querySelector(`.tab[data-tab]`);
    const tabParent   = existingTab?.parentElement
      ?? root.querySelector(".sheet-body")
      ?? root.querySelector("form");
    if (!tabParent) { console.warn(TAG, "No tab parent found"); return; }

    ensureStyle();

    const groupName = nav.dataset.group || "main";
    const TAB_ID    = "oni-dp-dungeon-config";

    // Nav button
    const tabBtn = document.createElement("a");
    tabBtn.className = "item";
    tabBtn.dataset.tab = TAB_ID;
    tabBtn.setAttribute(MARKER, "1");
    tabBtn.innerHTML = `<i class="fas fa-dungeon"></i> Dungeon`;
    nav.appendChild(tabBtn);

    // Read current flag values for prefill
    const scene        = tileDoc?.parent ?? null;
    const tileId       = tileDoc?.id ?? null;
    const persistFlag  = tileDoc?.getFlag(MODULE_ID, `${DP.PATHING_ROOT_KEY ?? "dungeonPathing"}.persistAfterTrigger`) ?? false;
    const initialType  = (scene && tileId) ? (DP.TileState?.getInitialType(scene, tileId) ?? "") : "";
    const currentType  = (scene && tileId) ? (DP.TileState?.getCurrentType(scene, tileId) ?? "") : "";
    const visitedTile  = (scene && tileId) ? (DP.TileState?.isVisited(scene, tileId) ?? false) : false;

    const persists = persistFlag === true || persistFlag === "true";

    // Tab content
    const tabPanel = document.createElement("div");
    tabPanel.className = "tab";
    tabPanel.dataset.tab = TAB_ID;
    tabPanel.dataset.group = groupName;

    tabPanel.innerHTML = `
      <div class="oni-dp-tile-wrap">
        <h3><i class="fas fa-dungeon"></i> Dungeon Configuration</h3>

        <div class="form-group">
          <label>Persist after trigger</label>
          <div class="form-fields">
            <input type="checkbox"
                   name="flags.${MODULE_ID}.${DP.PATHING_ROOT_KEY ?? "dungeonPathing"}.persistAfterTrigger"
                   data-dtype="Boolean"
                   ${persists ? "checked" : ""} />
          </div>
          <p class="notes">
            When checked, this tile stays active after its event fires and will not be blanked out.
            Use for persistent locations like camp sites or recurring encounters.
            Default: tile is cleared after triggering (one-shot).
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
            Use <b>Reset Dungeon</b> in Scene Config to restore all tiles.
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
            once the party has stepped on them.
          </p>
        </div>
      </div>
    `;

    tabParent.appendChild(tabPanel);

    // Rebind Foundry tab system
    try {
      const tabs = app?._tabs;
      if (Array.isArray(tabs)) tabs.forEach(t => t?.bind?.(root));
      else if (tabs) Object.values(tabs).forEach(t => t?.bind?.(root));
    } catch {}
  }

  Hooks.once("ready", () => {
    Hooks.on("renderTileConfig", (app, html) => {
      try { inject(app, html); } catch (e) { console.warn(TAG, "inject failed:", e); }
    });
  });
})();
