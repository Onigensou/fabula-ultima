// ============================================================================
// FabulaUltimaCompanion — Fabula Configuration UI (Scene Config Tab) [Module]
// ----------------------------------------------------------------------------
// File: scripts/custom-ui/dungeon-configuration-ui.js
//
// What it does:
// - Adds a "Fabula Configuration" tab into Scene Configuration (Foundry v12)
// - Inside that tab, adds 3 SUB-TABS:
//     1) General                (NEW: general map settings)
//     2) Dungeon Configuration  (your existing UI, unchanged)
//     3) Scene Network          (dynamic Name/ID table)
//
// Stores data into Scene flags under THIS MODULE scope:
// - Dungeon data (unchanged):
//     flags.fabula-ultima-companion.oniDungeon.*
//
// - Scene Network (new):
//     flags.fabula-ultima-companion.oniFabula.sceneNetwork
//   Stored as a JSON string for reliability with Foundry form serialization.
//   (Your future scripts can parse it into an array.)
//
// Backward compatibility (Dungeon):
// - Prefill reads from (in order):
//   1) flags.fabula-ultima-companion.oniDungeon (new)
//   2) flags.world.oniDungeon (from your macro v2/v3)
//   3) flags.oniDungeon (legacy v1)
// - When GM presses "Save Changes", values are saved into module scope.
//
// Notes:
// - "Scene Network" table rows are NOT saved until you press "Save Changes",
//   same as everything else in Scene Config.
// ============================================================================

(() => {
  const MODULE_ID = "fabula-ultima-companion";

  // Existing dungeon storage (UNCHANGED)
  const DUNGEON_ROOT_KEY  = "oniDungeon"; // flags.<MODULE_ID>.oniDungeon

  // New Fabula root for extra config (Scene Network)
  const FABULA_ROOT_KEY   = "oniFabula";  // flags.<MODULE_ID>.oniFabula
  const SCENE_NET_KEY     = "sceneNetwork"; // stored inside oniFabula as JSON string

  // General settings stored inside oniFabula.general
  const GENERAL_KEY        = "general";
  const CAMERA_FOLLOW_KEY  = "cameraFollowToken"; // legacy — kept for backward-compat read
  const SCENE_MODE_KEY     = "sceneMode";          // new: "none" | "exploration" | "dungeon"
  const SCAN_RADIUS_KEY    = "scanRadius";          // world-unit clamp radius for scan mode
  const FT_ENABLED_KEY     = "fastTravelEnabled";   // boolean: allow fast travel in dungeon mode
  const IS_OVERWORLD_KEY   = "isOverworld";         // boolean: scene is an overworld map
  const IS_TOWN_KEY        = "isTown";              // boolean: scene is a town map
  const IS_DUNGEON_KEY     = "isDungeon";           // boolean: scene is a dungeon map
  const SCENE_VISITED_KEY       = "sceneVisited";         // boolean: set true when scene activated once
  const SPAWN_POINT_KEY         = "spawnPoint";           // { x, y } — manual spawn for scene travel
  const NAV_NAME_KEY            = "navigationName";       // string: display name in Travel dialog
  const DISABLE_TRANSITION_KEY  = "disableTransition";    // boolean: skip screen-fade when entering this scene
  // Conflict Event — the additional rule layered onto conflicts fought on this
  // scene. Only meaningful when sceneMode === "conflict"; one event per scene,
  // default "none". Choices come from the runtime registry via
  // FUCompanion.api.conflictEvents (this file is a classic IIFE and cannot
  // import). Mirrors FLAG_KEY in scripts/conflict-event/conflict-event-binding.js
  // — keep the two in step.
  const CONFLICT_EVENT_KEY      = "conflictEvent";         // string: registered conflict-event id
  // Invoker wellsprings present on this scene. Per-element boolean under general
  // (`wellspring_<elem>`); UNSET/true → available, false → absent. Read by the
  // WELLSPRING_<ELEM>_AVAILABLE formula identifier (Invocation menu gating).
  const WELLSPRING_ELEMS = ["air", "earth", "fire", "bolt", "ice"];

  // Main (parent) tab in Scene Config
  const FABULA_TAB_ID     = "oni-fabula-config";

  // Subtabs inside the Fabula Configuration tab
  const SUBTAB_GENERAL_ID = "subtab-general";
  const SUBTAB_DUNGEON_ID = "subtab-dungeon";
  const SUBTAB_NETWORK_ID = "subtab-network";

  const STYLE_ID = "oni-fabula-config-style";
  const MARKER_ATTR = "data-oni-fabula-config";
  const SAVE_MOVED_ATTR = "data-oni-save-moved";

  const DEBUG = false;
  const log  = (...a) => DEBUG && console.log("[FabulaConfigUI]", ...a);
  const warn = (...a) => DEBUG && console.warn("[FabulaConfigUI]", ...a);

  // -----------------------------
  // CSS
  // -----------------------------
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      a.item[${MARKER_ATTR}] i { margin-right: 6px; }

      .oni-fabula-wrap { padding: 10px 8px; }
      .oni-fabula-wrap h3 { margin: 10px 0 6px; }
      .oni-fabula-wrap h3:first-child { margin-top: 0; }

      .oni-fabula-subtle {
        opacity: .85;
        font-size: 12px;
        margin: 6px 0 10px;
      }

      /* ---------------------------
         Subtabs (inside our tab)
         --------------------------- */
      .oni-fabula-subtabs {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
        border-bottom: 1px solid var(--color-border-light-primary, #9993);
        padding-bottom: 6px;
        margin-bottom: 10px;
      }

      .oni-fabula-subtab {
        cursor: pointer;
        padding: 6px 10px;
        border-radius: 6px;
        border: 1px solid var(--color-border-light-primary, #9993);
        user-select: none;
        opacity: .9;
      }

      .oni-fabula-subtab.active {
        opacity: 1;
        font-weight: 600;
        border-color: var(--color-border-highlight, #d9d7cb);
        box-shadow: 0 0 0 1px var(--color-border-highlight, #d9d7cb) inset;
      }

      .oni-fabula-subpanel { display: none; }
      .oni-fabula-subpanel.active { display: block; }

      /* Inputs full width inside our tab */
      .oni-fabula-wrap .form-group .form-fields input[type="text"] { width: 100%; }

      .oni-fabula-actions {
        display:flex;
        gap:8px;
        flex-wrap:wrap;
        margin-top: 10px;
      }

      .oni-save-footer {
        margin-top: 12px;
        padding-top: 10px;
        border-top: 1px solid var(--color-border-light-primary, #9993);
      }

      /* ---------------------------
         Scene Network table
         --------------------------- */
      .oni-net-header-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 10px;
        margin: 8px 0 6px;
      }

      .oni-net-table {
        width: 100%;
        border: 1px solid var(--color-border-light-primary, #9993);
        border-radius: 8px;
        overflow: hidden;
      }

      .oni-net-row {
        display: grid;
        grid-template-columns: 1fr 1fr auto;
        gap: 8px;
        padding: 8px;
        border-top: 1px solid var(--color-border-light-primary, #9993);
        align-items: center;
        background: rgba(0,0,0,0.02);
      }

      .oni-net-row:first-child { border-top: 0; }

      .oni-net-row input[type="text"] {
        width: 100%;
      }

      .oni-net-row .oni-net-remove {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 30px;
        height: 30px;
        border-radius: 6px;
        border: 1px solid var(--color-border-light-primary, #9993);
        cursor: pointer;
      }

      .oni-net-row .oni-net-remove:hover {
        filter: brightness(1.05);
      }

      .oni-net-add {
        display: inline-flex;
        align-items: center;
        gap: 8px;
      }

      /* Invoker wellspring toggle chips */
      .oni-wellspring-row {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        width: 100%;
        justify-content: flex-start;
      }
      /* Deselected = readable colored OUTLINE on a dark fill (full contrast, no
         whole-chip opacity). Selected = SOLID element-color fill + dark text + glow. */
      .oni-wellspring-chip {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        padding: 6px 14px 6px 11px;
        border-radius: 999px;
        cursor: pointer;
        font-weight: 600;
        font-size: 12px;
        letter-spacing: .02em;
        line-height: 1;
        color: var(--ec, #ccc);
        border: 1.5px solid var(--ec, #ccc);
        background: rgba(0,0,0,0.35);
        transition: background .12s ease, color .12s ease, box-shadow .12s ease;
        user-select: none;
      }
      .oni-wellspring-chip input { display: none; }
      .oni-wellspring-chip i { font-size: 12px; width: 13px; text-align: center; opacity: .9; }
      .oni-wellspring-chip:hover { filter: brightness(1.12); }
      .oni-wellspring-chip:has(input:checked) {
        color: #14110c;
        background: var(--ec, #ccc);
        border-color: var(--ec, #ccc);
        box-shadow: 0 0 9px -1px var(--ec, #ccc);
      }
      .oni-wellspring-chip:has(input:checked) i { opacity: 1; }
    `;
    document.head.appendChild(style);
  }

  // -----------------------------
  // Utility
  // -----------------------------
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
      if (!tabs) return { ok: false, reason: "no app._tabs" };
      if (Array.isArray(tabs)) tabs.forEach(t => t?.bind?.(root));
      else Object.values(tabs).forEach(t => t?.bind?.(root));
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e?.message ?? String(e) };
    }
  }

  function safeGet(obj, path, fallback = "") {
    try {
      const parts = path.split(".");
      let cur = obj;
      for (const p of parts) cur = cur?.[p];
      return (cur === undefined || cur === null) ? fallback : cur;
    } catch {
      return fallback;
    }
  }

  // Escape a string for interpolation into innerHTML. Used by the Conflict
  // Event dropdown, whose labels come from the runtime registry.
  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }

  function normalizeBoolean(raw, fallback = false) {
    if (raw === true || raw === false) return raw;
    if (raw === 1 || raw === 0) return !!raw;
    if (typeof raw === "string") {
      const s = raw.trim().toLowerCase();
      if (s === "true" || s === "1" || s === "yes" || s === "y" || s === "on") return true;
      if (s === "false" || s === "0" || s === "no" || s === "n" || s === "off") return false;
    }
    return fallback;
  }

  // -----------------------------
  // Dungeon (existing) data read
  // -----------------------------
  function readDungeonData(scene) {
    const mod = scene?.flags?.[MODULE_ID]?.[DUNGEON_ROOT_KEY];
    if (mod && Object.keys(mod).length) return mod;

    const world = scene?.flags?.world?.[DUNGEON_ROOT_KEY];
    if (world && Object.keys(world).length) return world;

    const legacy = scene?.flags?.[DUNGEON_ROOT_KEY];
    if (legacy && Object.keys(legacy).length) return legacy;

    return {};
  }

    function fillDungeonFromFlags(scene, dungeonPanel) {
    const data = readDungeonData(scene);

    // Battle
    dungeonPanel.querySelector(`input[name="flags.${MODULE_ID}.${DUNGEON_ROOT_KEY}.encounterTable"]`).value = safeGet(data, "encounterTable", "");
    dungeonPanel.querySelector(`input[name="flags.${MODULE_ID}.${DUNGEON_ROOT_KEY}.enemiesTable"]`).value   = safeGet(data, "enemiesTable", "");
    dungeonPanel.querySelector(`input[name="flags.${MODULE_ID}.${DUNGEON_ROOT_KEY}.battleMap"]`).value      = safeGet(data, "battleMap", "");
    dungeonPanel.querySelector(`input[name="flags.${MODULE_ID}.${DUNGEON_ROOT_KEY}.battleBGM"]`).value      = safeGet(data, "battleBGM", "");
    dungeonPanel.querySelector(`input[name="flags.${MODULE_ID}.${DUNGEON_ROOT_KEY}.bossBGM"]`).value        = safeGet(data, "bossBGM", "");

    // Blank is meaningful here: DP.RandomBattle reads an unset value as the
    // default bias of 1, so don't substitute a number the GM never chose.
    const noveltyInput = dungeonPanel.querySelector(`input[name="flags.${MODULE_ID}.${DUNGEON_ROOT_KEY}.encounterNoveltyBias"]`);
    if (noveltyInput) noveltyInput.value = safeGet(data, "encounterNoveltyBias", "");

    // Event
    dungeonPanel.querySelector(`input[name="flags.${MODULE_ID}.${DUNGEON_ROOT_KEY}.event.skillCheckEvent"]`).value = safeGet(data, "event.skillCheckEvent", "");
    dungeonPanel.querySelector(`input[name="flags.${MODULE_ID}.${DUNGEON_ROOT_KEY}.event.clockEvent"]`).value      = safeGet(data, "event.clockEvent", "");

    // Loot
    dungeonPanel.querySelector(`input[name="flags.${MODULE_ID}.${DUNGEON_ROOT_KEY}.loot.weapon"]`).value     = safeGet(data, "loot.weapon", "");
    dungeonPanel.querySelector(`input[name="flags.${MODULE_ID}.${DUNGEON_ROOT_KEY}.loot.armor"]`).value      = safeGet(data, "loot.armor", "");
    dungeonPanel.querySelector(`input[name="flags.${MODULE_ID}.${DUNGEON_ROOT_KEY}.loot.accessory"]`).value  = safeGet(data, "loot.accessory", "");
    dungeonPanel.querySelector(`input[name="flags.${MODULE_ID}.${DUNGEON_ROOT_KEY}.loot.consumable"]`).value = safeGet(data, "loot.consumable", "");
    dungeonPanel.querySelector(`input[name="flags.${MODULE_ID}.${DUNGEON_ROOT_KEY}.loot.item"]`).value       = safeGet(data, "loot.item", "");
    dungeonPanel.querySelector(`input[name="flags.${MODULE_ID}.${DUNGEON_ROOT_KEY}.loot.zenit"]`).value      = safeGet(data, "loot.zenit", "");
    dungeonPanel.querySelector(`input[name="flags.${MODULE_ID}.${DUNGEON_ROOT_KEY}.loot.treasure"]`).value   = safeGet(data, "loot.treasure", "");
    dungeonPanel.querySelector(`input[name="flags.${MODULE_ID}.${DUNGEON_ROOT_KEY}.loot.material"]`).value    = safeGet(data, "loot.material", "");

    // Threat level prefill
    const threatSelect = dungeonPanel.querySelector(`select[name="flags.${MODULE_ID}.${DUNGEON_ROOT_KEY}.threatLevel"]`);
    if (threatSelect) threatSelect.value = safeGet(data, "threatLevel", "medium");
  }

  // -----------------------------
  // Fabula data (Scene Network)
  // -----------------------------
  function readFabulaData(scene) {
    const mod = scene?.flags?.[MODULE_ID]?.[FABULA_ROOT_KEY];
    if (mod && Object.keys(mod).length) return mod;
    return {};
  }

  function normalizeSceneNetwork(raw) {
    // Accept: array, json string, object keyed by numbers
    if (!raw) return [];

    if (Array.isArray(raw)) {
      return raw
        .map(r => ({ name: String(r?.name ?? ""), id: String(r?.id ?? "") }))
        .filter(r => (r.name || r.id));
    }

    if (typeof raw === "string") {
      const s = raw.trim();
      if (!s) return [];
      try {
        const parsed = JSON.parse(s);
        return normalizeSceneNetwork(parsed);
      } catch {
        // If it isn't valid JSON, treat it as empty
        return [];
      }
    }

    if (typeof raw === "object") {
      // If stored as {0:{name,id},1:{...}}
      const entries = Object.entries(raw)
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([, v]) => ({ name: String(v?.name ?? ""), id: String(v?.id ?? "") }))
        .filter(r => (r.name || r.id));
      return entries;
    }

    return [];
  }

  function toSceneNetworkJSON(rows) {
    const clean = (rows || [])
      .map(r => ({ name: String(r?.name ?? "").trim(), id: String(r?.id ?? "").trim() }))
      .filter(r => (r.name || r.id));
    return JSON.stringify(clean);
  }

  // -----------------------------
  // Move "Save Changes" (submit) to bottom of the window
  // -----------------------------
  function moveSaveToBottom(root) {
    try {
      const form = root.querySelector("form");
      if (!form) return { ok: false, reason: "no form" };

      if (form.querySelector(`[${SAVE_MOVED_ATTR}="1"]`)) return { ok: true, reason: "already moved" };

      const submitBtn = root.querySelector(`button[type="submit"]`);
      if (!submitBtn) return { ok: false, reason: "no submit button found" };

      let wrapper =
        submitBtn.closest(".form-group") ||
        submitBtn.closest(".form-fields") ||
        submitBtn.closest("header") ||
        submitBtn.closest("section") ||
        submitBtn.closest("div") ||
        submitBtn;

      wrapper.setAttribute(SAVE_MOVED_ATTR, "1");
      wrapper.classList?.add?.("oni-save-footer");
      form.appendChild(wrapper);

      return { ok: true, reason: "moved" };
    } catch (e) {
      return { ok: false, reason: e?.message ?? String(e) };
    }
  }

  // -----------------------------
  // Subtab controller
  // -----------------------------
  function setActiveSubtab(tabPanel, subtabId) {
    const btns = tabPanel.querySelectorAll(".oni-fabula-subtab");
    const panels = tabPanel.querySelectorAll(".oni-fabula-subpanel");

    btns.forEach(b => {
      const isActive = b.dataset.subtab === subtabId;
      b.classList.toggle("active", isActive);
    });

    panels.forEach(p => {
      const isActive = p.dataset.subtab === subtabId;
      p.classList.toggle("active", isActive);
    });
  }

  // -----------------------------
  // Scene Network table rendering
  // -----------------------------
  function renderSceneNetwork(networkPanel, rows) {
    const table = networkPanel.querySelector(".oni-net-table");
    if (!table) return;

    table.innerHTML = "";

    const safeRows = (rows && Array.isArray(rows)) ? rows : [];
    const finalRows = safeRows.length ? safeRows : [{ name: "", id: "" }];

    finalRows.forEach((row, idx) => {
      const r = document.createElement("div");
      r.className = "oni-net-row";
      r.dataset.index = String(idx);

      r.innerHTML = `
        <input type="text" class="oni-net-name" placeholder="Name" value="${String(row?.name ?? "").replaceAll('"', "&quot;")}" />
        <input type="text" class="oni-net-id" placeholder="ID" value="${String(row?.id ?? "").replaceAll('"', "&quot;")}" />
        <button type="button" class="oni-net-remove" title="Remove row">
          <i class="fas fa-trash"></i>
        </button>
      `;

      table.appendChild(r);
    });
  }

  function collectSceneNetworkRows(networkPanel) {
    const rows = [];
    const rowEls = networkPanel.querySelectorAll(".oni-net-row");
    rowEls.forEach(el => {
      const name = el.querySelector(".oni-net-name")?.value ?? "";
      const id   = el.querySelector(".oni-net-id")?.value ?? "";
      rows.push({ name, id });
    });
    return rows;
  }

  function syncSceneNetworkHidden(networkPanel) {
    const hidden = networkPanel.querySelector(`input[name="flags.${MODULE_ID}.${FABULA_ROOT_KEY}.${SCENE_NET_KEY}"]`);
    if (!hidden) return;

    const rows = collectSceneNetworkRows(networkPanel);
    hidden.value = toSceneNetworkJSON(rows);
  }

  // -----------------------------
  // Spawnpoint helpers
  // -----------------------------
  function clientToWorld(clientX, clientY) {
    if (!canvas?.stage) return { x: clientX, y: clientY };
    const canvasEl = canvas.app?.view ?? document.querySelector("#board canvas");
    if (!canvasEl) return { x: clientX, y: clientY };
    const rect   = canvasEl.getBoundingClientRect();
    const pivot  = canvas.stage.pivot;
    const scale  = canvas.stage.scale.x || 1;
    return {
      x: pivot.x + (clientX - rect.left  - rect.width  / 2) / scale,
      y: pivot.y + (clientY - rect.top   - rect.height / 2) / scale,
    };
  }

  function updateSpawnpointStatus(generalPanel, scene) {
    const statusEl = generalPanel?.querySelector?.(".oni-spawnpoint-status");
    if (!statusEl) return;
    const sp = scene?.flags?.[MODULE_ID]?.[FABULA_ROOT_KEY]?.[GENERAL_KEY]?.[SPAWN_POINT_KEY];
    if (sp && typeof sp.x === "number" && typeof sp.y === "number") {
      statusEl.textContent = `✓ Manual spawn set at (${Math.round(sp.x)}, ${Math.round(sp.y)})`;
      statusEl.style.color = "#5aaa5a";
    } else {
      statusEl.textContent = "Using auto-generated spawn (scene center)";
      statusEl.style.color = "";
    }
  }

  // -----------------------------
  // Inject UI
  // -----------------------------
  function inject(app, html) {
    const root = getRoot(html, app);
    if (!root) return { ok: false, reason: "no root" };

    // Dedupe per-window
    if (root.querySelector(`a.item[${MARKER_ATTR}]`) || root.querySelector(`.tab[${MARKER_ATTR}]`)) {
      const saveRes = moveSaveToBottom(root);
      return { ok: true, reason: "already injected", saveRes };
    }

    const nav =
      root.querySelector(`nav.sheet-tabs.tabs[data-group="main"]`) ||
      root.querySelector(`nav.sheet-tabs.tabs`) ||
      root.querySelector(`nav.sheet-tabs`);
    if (!nav) return { ok: false, reason: "no nav" };

    const existingTab =
      root.querySelector(`.tab[data-group="main"][data-tab]`) ||
      root.querySelector(`.tab[data-tab]`);

    let tabParent = existingTab?.parentElement ?? null;
    if (!tabParent) tabParent = root.querySelector(`section.sheet-body`) || root.querySelector(`.sheet-body`) || root.querySelector(`form`);
    if (!tabParent) return { ok: false, reason: "no tab parent" };

    ensureStyle();

    const groupName = nav.dataset.group || "main";

    // Add MAIN tab button: "Fabula Configuration"
    const tabBtn = document.createElement("a");
    tabBtn.className = "item";
    tabBtn.dataset.tab = FABULA_TAB_ID;
    tabBtn.setAttribute(MARKER_ATTR, "1");
    tabBtn.innerHTML = `<i class="fas fa-cogs"></i> Fabula Configuration`;
    nav.appendChild(tabBtn);

    // Create MAIN tab panel
    const tabPanel = document.createElement("div");
    tabPanel.className = "tab";
    tabPanel.dataset.tab = FABULA_TAB_ID;
    tabPanel.dataset.group = groupName;
    tabPanel.setAttribute(MARKER_ATTR, "1");

    tabPanel.innerHTML = `
      <div class="oni-fabula-wrap">

        <div class="oni-fabula-subtle">
          Saved into <b>Scene Flags</b>:
          <code>flags.${MODULE_ID}.${DUNGEON_ROOT_KEY}</code> (Dungeon) and
          <code>flags.${MODULE_ID}.${FABULA_ROOT_KEY}</code> (Fabula extras)
          <br>
          <span style="opacity:.8">
            Dungeon reads legacy too: <code>flags.world.${DUNGEON_ROOT_KEY}</code> / <code>flags.${DUNGEON_ROOT_KEY}</code>
            (saving will migrate into module flags)
          </span>
        </div>

        <!-- SUBTABS -->
        <div class="oni-fabula-subtabs">
          <div class="oni-fabula-subtab active" data-subtab="${SUBTAB_GENERAL_ID}">
            <i class="fas fa-sliders-h"></i> General
          </div>
          <div class="oni-fabula-subtab" data-subtab="${SUBTAB_DUNGEON_ID}">
            <i class="fas fa-dungeon"></i> Dungeon Configuration
          </div>
          <div class="oni-fabula-subtab" data-subtab="${SUBTAB_NETWORK_ID}">
            <i class="fas fa-project-diagram"></i> Scene Network
          </div>
        </div>

        <!-- SUBTAB: GENERAL (NEW) -->
        <div class="oni-fabula-subpanel active" data-subtab="${SUBTAB_GENERAL_ID}">
          <h3>General</h3>

          <div class="form-group">
            <label>Scene Mode</label>
            <div class="form-fields">
              <select name="flags.${MODULE_ID}.${FABULA_ROOT_KEY}.${GENERAL_KEY}.${SCENE_MODE_KEY}">
                <option value="none">None (Normal Foundry movement)</option>
                <option value="exploration">Exploration (Camera Follow Token)</option>
                <option value="dungeon">Dungeon (Tile-Based Movement)</option>
                <option value="camp">Camp (Camp Activity System)</option>
                <option value="title">Title (Video Game Title Screen)</option>
                <option value="theatre">Theatre (Visual-Novel Roleplaying)</option>
                <option value="conflict">Conflict (WIP)</option>
              </select>
            </div>
            <p class="notes">
              <b>None</b> — standard Foundry V12 token movement.<br>
              <b>Exploration</b> — camera locks and follows the party token; right-click to walk.<br>
              <b>Dungeon</b> — tile-based movement: click highlighted tiles to move the party token along the laid-out path.<br>
              <b>Title</b> — full-screen title screen shown to all players at session start; provides Press Any Key → New Game / Load Game / Options / Quit.<br>
              <b>Theatre</b> — visual-novel style scene for roleplaying: background only, no pathing. Presentation is not yet implemented; the mode currently hosts the Ritual button.
            </p>
          </div>

          <div class="form-group oni-conflict-event-group">
            <label>Conflict Event</label>
            <div class="form-fields">
              <select name="flags.${MODULE_ID}.${FABULA_ROOT_KEY}.${GENERAL_KEY}.${CONFLICT_EVENT_KEY}">
                <option value="none">None</option>
              </select>
            </div>
            <p class="notes oni-conflict-event-desc">
              An additional rule layered on top of the normal battle for conflicts fought on this
              scene — a dungeon hazard, an arena gimmick. Battle Director still runs the fight;
              the event only automates one extra rule inside it.
              <br>
              One event per conflict scene. A dungeon with several arenas picks an event for each
              one separately.
            </p>
          </div>

          <div class="form-group">
            <label>Scan Mode Radius</label>
            <div class="form-fields">
              <input type="number" name="flags.${MODULE_ID}.${FABULA_ROOT_KEY}.${GENERAL_KEY}.${SCAN_RADIUS_KEY}"
                     placeholder="600" min="100" max="10000" step="50" />
            </div>
            <p class="notes">
              How far (in world units) the player can pan the camera from the party token while Scan Mode is active.
              Only applies to <b>Dungeon</b> scene mode. Default: 600.
            </p>
          </div>

          <div class="form-group">
            <label>Fast Travel Enabled</label>
            <div class="form-fields">
              <input type="checkbox" name="flags.${MODULE_ID}.${FABULA_ROOT_KEY}.${GENERAL_KEY}.${FT_ENABLED_KEY}" data-dtype="Boolean" />
            </div>
            <p class="notes">Allow the Main Controller to use Fast Travel and Scene Travel. Applies in Dungeon and Exploration modes.</p>
          </div>

          <div class="form-group">
            <label>Disable Transition</label>
            <div class="form-fields">
              <input type="checkbox" name="flags.${MODULE_ID}.${FABULA_ROOT_KEY}.${GENERAL_KEY}.${DISABLE_TRANSITION_KEY}" data-dtype="Boolean" />
            </div>
            <p class="notes">Skip the screen-fade animation when entering this scene. Useful for scenes that load instantly or where the effect is unwanted.</p>
          </div>

          <h3 style="margin:12px 0 6px;"><i class="fas fa-tag"></i> Scene Type</h3>
          <p class="notes" style="margin:0 0 8px;">Tag this scene for the Travel system. Used to categorise destinations in the Travel dialog.</p>

          <div class="form-group">
            <label>Overworld</label>
            <div class="form-fields">
              <input type="checkbox" name="flags.${MODULE_ID}.${FABULA_ROOT_KEY}.${GENERAL_KEY}.${IS_OVERWORLD_KEY}" data-dtype="Boolean" />
            </div>
          </div>

          <div class="form-group">
            <label>Town</label>
            <div class="form-fields">
              <input type="checkbox" name="flags.${MODULE_ID}.${FABULA_ROOT_KEY}.${GENERAL_KEY}.${IS_TOWN_KEY}" data-dtype="Boolean" />
            </div>
          </div>

          <div class="form-group">
            <label>Dungeon</label>
            <div class="form-fields">
              <input type="checkbox" name="flags.${MODULE_ID}.${FABULA_ROOT_KEY}.${GENERAL_KEY}.${IS_DUNGEON_KEY}" data-dtype="Boolean" />
            </div>
          </div>

          <div class="form-group">
            <label>Navigation Name</label>
            <div class="form-fields">
              <input type="text" name="flags.${MODULE_ID}.${FABULA_ROOT_KEY}.${GENERAL_KEY}.${NAV_NAME_KEY}"
                     placeholder="Display name in Travel dialog (defaults to Scene Name)" />
            </div>
            <p class="notes">Custom name shown in the Travel dialog. Leave blank to use the scene name.</p>
          </div>

          <div class="form-group">
            <label>Visited</label>
            <div class="form-fields">
              <input type="checkbox" name="flags.${MODULE_ID}.${FABULA_ROOT_KEY}.${GENERAL_KEY}.${SCENE_VISITED_KEY}" data-dtype="Boolean" />
            </div>
            <p class="notes">Auto-set when the scene is first activated. Toggle to manually include or exclude this scene from Travel destinations.</p>
          </div>

          <h3 style="margin:12px 0 6px;"><i class="fas fa-water"></i> Invoker Wellsprings</h3>
          <p class="notes" style="margin:0 0 8px;">Which elemental wellsprings are present on this scene. An Invoker can only draw the invocations of wellsprings available here. All are available by default — deselect the ones that are absent (RAW: usually two per scene).</p>
          <div class="oni-wellspring-row">
            ${[
              { el: "air",   color: "#5fd3c6", icon: "fa-wind" },
              { el: "earth", color: "#c19a6b", icon: "fa-mountain" },
              { el: "fire",  color: "#e8603c", icon: "fa-fire" },
              { el: "bolt",  color: "#e8c93c", icon: "fa-bolt" },
              { el: "ice",   color: "#6fb7e8", icon: "fa-snowflake" },
            ].map(({ el, color, icon }) => `
              <label class="oni-wellspring-chip" style="--ec:${color};">
                <input type="checkbox" name="flags.${MODULE_ID}.${FABULA_ROOT_KEY}.${GENERAL_KEY}.wellspring_${el}" data-dtype="Boolean" />
                <i class="fas ${icon}"></i>${el.charAt(0).toUpperCase() + el.slice(1)}
              </label>`).join("")}
          </div>

          <div class="oni-dp-reset-section" style="display:none; margin-top:12px; padding-top:10px; border-top:1px solid rgba(255,255,255,0.15);">
            <h3 style="margin:0 0 6px;">Dungeon Management</h3>
            <div class="form-group" style="align-items:center;">
              <label>Reset Dungeon</label>
              <div class="form-fields" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
                <button type="button" class="oni-reset-dungeon-btn" style="color:#e05252;flex-shrink:0;">
                  <i class="fas fa-redo"></i> Reset Dungeon
                </button>
                <span class="notes" style="margin:0;color:#e05252;">Opens reset options. Cannot be undone.</span>
              </div>
            </div>

            <div class="form-group" style="align-items:flex-start;margin-top:8px;">
              <label>Spawn Point</label>
              <div class="form-fields" style="flex-direction:column;gap:6px;align-items:flex-start;">
                <button type="button" class="oni-set-spawnpoint-btn">
                  <i class="fas fa-crosshairs"></i> Set Spawnpoint
                </button>
                <span class="oni-spawnpoint-status notes" style="margin:0;font-style:italic;"></span>
              </div>
              <p class="notes">
                Click to arm spawn-point mode — then click anywhere on the map.
                Used as the landing position when players Travel to this scene.
                If unset, the scene center is used.
              </p>
            </div>
          </div>

          <p class="notes">Remember: data is saved only when you press <b>Save Changes</b>.</p>
        </div>

        <!-- SUBTAB: DUNGEON (your existing UI) -->
        <div class="oni-fabula-subpanel" data-subtab="${SUBTAB_DUNGEON_ID}">
          <h3>Travel</h3>

          <div class="form-group">
            <label>Threat Level</label>
            <div class="form-fields">
              <select name="flags.${MODULE_ID}.${DUNGEON_ROOT_KEY}.threatLevel">
                <option value="minimal">Minimal — d6</option>
                <option value="low">Low — d8</option>
                <option value="medium">Medium — d10</option>
                <option value="high">High — d12</option>
                <option value="very_high">Very High — d20</option>
              </select>
            </div>
            <p class="notes">Die rolled when the party makes a Travel Roll through this area. Default: Medium (d10).</p>
          </div>

          <h3>Battle</h3>

          <div class="form-group">
            <label>Encounter Table</label>
            <div class="form-fields">
              <input type="text" name="flags.${MODULE_ID}.${DUNGEON_ROOT_KEY}.encounterTable" placeholder="RollTable UUID (encounter groups)" />
            </div>
            <p class="notes">Table of encounter “groups” (may contain randomized enemies inside).</p>
          </div>

          <div class="form-group">
            <label>Enemies Table</label>
            <div class="form-fields">
              <input type="text" name="flags.${MODULE_ID}.${DUNGEON_ROOT_KEY}.enemiesTable" placeholder="RollTable UUID (individual enemies)" />
            </div>
            <p class="notes">Table of “possible enemies on this map” (individual monsters).</p>
          </div>

          <div class="form-group">
            <label>Novelty Bias</label>
            <div class="form-fields">
              <input type="number" step="0.5" min="0" name="flags.${MODULE_ID}.${DUNGEON_ROOT_KEY}.encounterNoveltyBias" placeholder="1" />
            </div>
            <p class="notes">How hard random encounters lean toward monsters the party has never fought. Each unmet monster in a row multiplies its odds by this much (default 1 → a row with two new monsters is 3× as likely). 0 disables the bias.</p>
          </div>

          <div class="form-group">
            <label>Battle Map</label>
            <div class="form-fields">
              <input type="text" name="flags.${MODULE_ID}.${DUNGEON_ROOT_KEY}.battleMap" placeholder="Scene UUID (battle scene)" />
            </div>
            <p class="notes">JRPG style: exploration scene links to a separate battle scene.</p>
          </div>

          <div class="form-group">
            <label>Battle BGM</label>
            <div class="form-fields">
              <input type="text" name="flags.${MODULE_ID}.${DUNGEON_ROOT_KEY}.battleBGM" placeholder="Playlist Sound name (string for now)" />
            </div>
          </div>

          <div class="form-group">
            <label>Boss BGM</label>
            <div class="form-fields">
              <input type="text" name="flags.${MODULE_ID}.${DUNGEON_ROOT_KEY}.bossBGM" placeholder="Playlist Sound name (string for now)" />
            </div>
          </div>

          <h3>Event</h3>

          <div class="form-group">
            <label>Skill Check Event</label>
            <div class="form-fields">
              <input type="text" name="flags.${MODULE_ID}.${DUNGEON_ROOT_KEY}.event.skillCheckEvent" placeholder="RollTable UUID" />
            </div>
          </div>

          <div class="form-group">
            <label>Clock Event</label>
            <div class="form-fields">
              <input type="text" name="flags.${MODULE_ID}.${DUNGEON_ROOT_KEY}.event.clockEvent" placeholder="RollTable UUID" />
            </div>
          </div>

                    <h3>Loot</h3>

          <div class="form-group"><label>Weapon</label><div class="form-fields"><input type="text" name="flags.${MODULE_ID}.${DUNGEON_ROOT_KEY}.loot.weapon" placeholder="RollTable UUID" /></div></div>
          <div class="form-group"><label>Armor</label><div class="form-fields"><input type="text" name="flags.${MODULE_ID}.${DUNGEON_ROOT_KEY}.loot.armor" placeholder="RollTable UUID" /></div></div>
          <div class="form-group"><label>Accessory</label><div class="form-fields"><input type="text" name="flags.${MODULE_ID}.${DUNGEON_ROOT_KEY}.loot.accessory" placeholder="RollTable UUID" /></div></div>
          <div class="form-group"><label>Consumable</label><div class="form-fields"><input type="text" name="flags.${MODULE_ID}.${DUNGEON_ROOT_KEY}.loot.consumable" placeholder="RollTable UUID" /></div></div>
          <div class="form-group"><label>Item</label><div class="form-fields"><input type="text" name="flags.${MODULE_ID}.${DUNGEON_ROOT_KEY}.loot.item" placeholder="RollTable UUID" /></div></div>
          <div class="form-group"><label>Zenit</label><div class="form-fields"><input type="text" name="flags.${MODULE_ID}.${DUNGEON_ROOT_KEY}.loot.zenit" placeholder="RollTable UUID" /></div></div>
          <div class="form-group"><label>Treasure</label><div class="form-fields"><input type="text" name="flags.${MODULE_ID}.${DUNGEON_ROOT_KEY}.loot.treasure" placeholder="RollTable UUID" /></div></div>
          <div class="form-group"><label>Material</label><div class="form-fields"><input type="text" name="flags.${MODULE_ID}.${DUNGEON_ROOT_KEY}.loot.material" placeholder="RollTable UUID" /></div><p class="notes" style="margin:0;">Materials the party can gather on <b>Gathering</b> tiles in this scene.</p></div>

          <div class="oni-fabula-actions">
            <button type="button" class="oni-dungeon-log">
              <i class="fas fa-terminal"></i> Log Current Scene Dungeon Data
            </button>

            <button type="button" class="oni-dungeon-clear">
              <i class="fas fa-eraser"></i> Clear Fields (this window)
            </button>
          </div>

          <p class="notes">Remember: data is saved only when you press <b>Save Changes</b>.</p>
        </div>

        <!-- SUBTAB: SCENE NETWORK (NEW) -->
        <div class="oni-fabula-subpanel" data-subtab="${SUBTAB_NETWORK_ID}">
          <h3>Scene Network</h3>

          <p class="notes">
            Use this table to link this scene to other scenes by ID.
            In the future, your scripts can read this list to let players jump between scenes easily.
          </p>

          <!-- Hidden field that actually gets saved by Foundry -->
          <input type="hidden" name="flags.${MODULE_ID}.${FABULA_ROOT_KEY}.${SCENE_NET_KEY}" value="[]" />

          <div class="oni-net-header-row">
            <div style="opacity:.85;font-size:12px;">
              Each row is a link: <b>Name</b> (display) + <b>ID</b> (your key)
            </div>

            <button type="button" class="oni-net-add">
              <i class="fas fa-plus"></i> Add Link
            </button>
          </div>

          <div class="oni-net-table"></div>

          <div class="oni-fabula-actions">
            <button type="button" class="oni-net-log">
              <i class="fas fa-terminal"></i> Log Current Scene Network
            </button>
          </div>

          <p class="notes">Remember: data is saved only when you press <b>Save Changes</b>.</p>
        </div>
      </div>
    `;

    tabParent.appendChild(tabPanel);

    // -----------------------------
    // Prefill: Dungeon + Scene Network
    // -----------------------------
    const scene = app?.object;
    const fabulaData = readFabulaData(scene);

    // Prefill General fields
    try {
      const generalPanel = tabPanel.querySelector(`.oni-fabula-subpanel[data-subtab="${SUBTAB_GENERAL_ID}"]`);
      const sel = generalPanel?.querySelector(`select[name="flags.${MODULE_ID}.${FABULA_ROOT_KEY}.${GENERAL_KEY}.${SCENE_MODE_KEY}"]`);
      if (sel) {
        // Read new sceneMode value, or migrate from legacy cameraFollowToken boolean
        let mode = safeGet(fabulaData, `${GENERAL_KEY}.${SCENE_MODE_KEY}`, null);
        if (!mode || !["none", "exploration", "dungeon", "camp", "title", "conflict", "theatre"].includes(mode)) {
          const legacy = safeGet(fabulaData, `${GENERAL_KEY}.${CAMERA_FOLLOW_KEY}`, false);
          mode = normalizeBoolean(legacy, false) ? "exploration" : "none";
        }
        sel.value = mode;
      }

      // Conflict Event prefill — options come from the runtime registry.
      //
      // The stored id is ALWAYS given an option, even when the registry does
      // not know it. A <select> silently drops a value with no matching
      // option, so without this a scene opened while the registry was empty
      // (module still booting, an event sub-script that failed to load, an
      // event since renamed) would save back as "none" and quietly disarm the
      // hazard. Showing it as unavailable keeps the flag intact and makes the
      // problem visible instead.
      const eventSel = generalPanel?.querySelector(`select[name="flags.${MODULE_ID}.${FABULA_ROOT_KEY}.${GENERAL_KEY}.${CONFLICT_EVENT_KEY}"]`);
      if (eventSel) {
        const stored = String(safeGet(fabulaData, `${GENERAL_KEY}.${CONFLICT_EVENT_KEY}`, "") ?? "").trim() || "none";
        let choices = [];
        try { choices = globalThis.FUCompanion?.api?.conflictEvents?.list?.() ?? []; }
        catch (e) { warn("conflict-event list failed", e); }
        if (!choices.length) choices = [{ id: "none", label: "None", description: "" }];
        if (!choices.some((c) => c.id === stored)) {
          choices = [...choices, { id: stored, label: `${stored} (unavailable)`, description: "" }];
        }

        eventSel.innerHTML = choices
          .map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.label)}</option>`)
          .join("");
        eventSel.value = stored;

        // Show the selected event's own description under the dropdown.
        const descEl = generalPanel?.querySelector(".oni-conflict-event-desc");
        const baseDesc = descEl?.innerHTML ?? "";
        const syncEventDesc = () => {
          if (!descEl) return;
          const chosen = choices.find((c) => c.id === eventSel.value);
          descEl.innerHTML = chosen?.description
            ? `${baseDesc}<br><b>${escapeHtml(chosen.label)}</b> — ${escapeHtml(chosen.description)}`
            : baseDesc;
        };
        syncEventDesc();
        eventSel.addEventListener("change", syncEventDesc);
      }

      // Scan radius prefill
      const radiusInput = generalPanel?.querySelector(`input[name="flags.${MODULE_ID}.${FABULA_ROOT_KEY}.${GENERAL_KEY}.${SCAN_RADIUS_KEY}"]`);
      if (radiusInput) {
        const raw = safeGet(fabulaData, `${GENERAL_KEY}.${SCAN_RADIUS_KEY}`, "");
        const n = Number(raw);
        radiusInput.value = (Number.isFinite(n) && n > 0) ? String(n) : "";
      }

      // Fast Travel enabled prefill (default: true when not yet set)
      const ftCheckbox = generalPanel?.querySelector(`input[name="flags.${MODULE_ID}.${FABULA_ROOT_KEY}.${GENERAL_KEY}.${FT_ENABLED_KEY}"]`);
      if (ftCheckbox) {
        const ftRaw = safeGet(fabulaData, `${GENERAL_KEY}.${FT_ENABLED_KEY}`, null);
        ftCheckbox.checked = (ftRaw === null) ? true : normalizeBoolean(ftRaw, true);
      }

      // Disable Transition prefill
      const disableTransCb = generalPanel?.querySelector(`input[name="flags.${MODULE_ID}.${FABULA_ROOT_KEY}.${GENERAL_KEY}.${DISABLE_TRANSITION_KEY}"]`);
      if (disableTransCb) {
        disableTransCb.checked = normalizeBoolean(safeGet(fabulaData, `${GENERAL_KEY}.${DISABLE_TRANSITION_KEY}`, false), false);
      }

      // Scene type checkboxes prefill
      const overworldCb = generalPanel?.querySelector(`input[name="flags.${MODULE_ID}.${FABULA_ROOT_KEY}.${GENERAL_KEY}.${IS_OVERWORLD_KEY}"]`);
      const townCb      = generalPanel?.querySelector(`input[name="flags.${MODULE_ID}.${FABULA_ROOT_KEY}.${GENERAL_KEY}.${IS_TOWN_KEY}"]`);
      const dungeonCb   = generalPanel?.querySelector(`input[name="flags.${MODULE_ID}.${FABULA_ROOT_KEY}.${GENERAL_KEY}.${IS_DUNGEON_KEY}"]`);
      if (overworldCb) overworldCb.checked = normalizeBoolean(safeGet(fabulaData, `${GENERAL_KEY}.${IS_OVERWORLD_KEY}`, false), false);
      if (townCb)      townCb.checked      = normalizeBoolean(safeGet(fabulaData, `${GENERAL_KEY}.${IS_TOWN_KEY}`,      false), false);
      if (dungeonCb)   dungeonCb.checked   = normalizeBoolean(safeGet(fabulaData, `${GENERAL_KEY}.${IS_DUNGEON_KEY}`,   false), false);

      // Navigation Name prefill
      const navNameInput = generalPanel?.querySelector(`input[name="flags.${MODULE_ID}.${FABULA_ROOT_KEY}.${GENERAL_KEY}.${NAV_NAME_KEY}"]`);
      if (navNameInput) {
        navNameInput.value = safeGet(fabulaData, `${GENERAL_KEY}.${NAV_NAME_KEY}`, "");
      }

      // Scene Visited prefill
      const visitedCb = generalPanel?.querySelector(`input[name="flags.${MODULE_ID}.${FABULA_ROOT_KEY}.${GENERAL_KEY}.${SCENE_VISITED_KEY}"]`);
      if (visitedCb) {
        visitedCb.checked = normalizeBoolean(safeGet(fabulaData, `${GENERAL_KEY}.${SCENE_VISITED_KEY}`, false), false);
      }

      // Invoker wellsprings prefill — default CHECKED (available) unless explicitly false.
      for (const el of WELLSPRING_ELEMS) {
        const cb = generalPanel?.querySelector(`input[name="flags.${MODULE_ID}.${FABULA_ROOT_KEY}.${GENERAL_KEY}.wellspring_${el}"]`);
        if (cb) {
          const raw = safeGet(fabulaData, `${GENERAL_KEY}.wellspring_${el}`, null);
          cb.checked = (raw === null) ? true : normalizeBoolean(raw, true);
        }
      }

      // Spawnpoint status display
      updateSpawnpointStatus(generalPanel, scene);
    } catch (e) {
      warn("General prefill failed:", e);
    }

    // Prefill dungeon fields
    try {
      const dungeonPanel = tabPanel.querySelector(`.oni-fabula-subpanel[data-subtab="${SUBTAB_DUNGEON_ID}"]`);
      fillDungeonFromFlags(scene, dungeonPanel);
    } catch (e) {
      warn("fillDungeonFromFlags failed:", e);
    }

    // Prefill scene network
    try {
      const raw = fabulaData?.[SCENE_NET_KEY];
      const rows = normalizeSceneNetwork(raw);

      const networkPanel = tabPanel.querySelector(`.oni-fabula-subpanel[data-subtab="${SUBTAB_NETWORK_ID}"]`);
      const hidden = networkPanel.querySelector(`input[name="flags.${MODULE_ID}.${FABULA_ROOT_KEY}.${SCENE_NET_KEY}"]`);

      hidden.value = toSceneNetworkJSON(rows);
      renderSceneNetwork(networkPanel, rows);
      // Ensure hidden matches rendered rows (also handles the "default empty row" case)
      syncSceneNetworkHidden(networkPanel);
    } catch (e) {
      warn("Scene Network prefill failed:", e);
    }

    // -----------------------------
    // Subtab clicks
    // -----------------------------
    tabPanel.querySelectorAll(".oni-fabula-subtab").forEach(btn => {
      btn.addEventListener("click", (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        const subtabId = btn.dataset.subtab;
        setActiveSubtab(tabPanel, subtabId);
      });
    });

    // -----------------------------
    // Dungeon buttons (existing behavior)
    // -----------------------------
    tabPanel.querySelector(".oni-dungeon-log")?.addEventListener("click", (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      const data = readDungeonData(scene);
      log("Scene:", scene?.name, "Dungeon Data =", foundry?.utils?.duplicate ? foundry.utils.duplicate(data) : data);

      try {
        const gf = scene?.getFlag?.(MODULE_ID, DUNGEON_ROOT_KEY);
        log(`getFlag('${MODULE_ID}','${DUNGEON_ROOT_KEY}') =`, gf);
      } catch (e) {
        warn("getFlag test failed:", e);
      }

      ui.notifications?.info?.("Logged to console: Dungeon Data");
    });

    tabPanel.querySelector(".oni-dungeon-clear")?.addEventListener("click", (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      const dungeonPanel = tabPanel.querySelector(`.oni-fabula-subpanel[data-subtab="${SUBTAB_DUNGEON_ID}"]`);
      dungeonPanel.querySelectorAll(`input[name^="flags.${MODULE_ID}.${DUNGEON_ROOT_KEY}."]`).forEach(i => i.value = "");
      ui.notifications?.warn?.("Cleared fields (not saved yet). Click Save Changes to commit.");
    });

    // -----------------------------
    // Scene Network interactions
    // -----------------------------
    const networkPanel = tabPanel.querySelector(`.oni-fabula-subpanel[data-subtab="${SUBTAB_NETWORK_ID}"]`);

    // Add row
    networkPanel.querySelector(".oni-net-add")?.addEventListener("click", (ev) => {
      ev.preventDefault(); ev.stopPropagation();

      // Get current rows, add one, re-render
      const rows = collectSceneNetworkRows(networkPanel);
      rows.push({ name: "", id: "" });

      renderSceneNetwork(networkPanel, rows);
      syncSceneNetworkHidden(networkPanel);
    });

    // Delegate: remove row + input changes
    networkPanel.addEventListener("click", (ev) => {
      const btn = ev.target?.closest?.(".oni-net-remove");
      if (!btn) return;

      ev.preventDefault(); ev.stopPropagation();

      const rowEl = btn.closest(".oni-net-row");
      if (!rowEl) return;

      rowEl.remove();

      // If table becomes empty, keep one blank row so the UI doesn't vanish
      const remaining = networkPanel.querySelectorAll(".oni-net-row");
      if (!remaining.length) {
        renderSceneNetwork(networkPanel, [{ name: "", id: "" }]);
      }

      syncSceneNetworkHidden(networkPanel);
    });

    // Any typing updates the hidden JSON
    networkPanel.addEventListener("input", (ev) => {
      const isName = ev.target?.classList?.contains?.("oni-net-name");
      const isId   = ev.target?.classList?.contains?.("oni-net-id");
      if (!isName && !isId) return;
      syncSceneNetworkHidden(networkPanel);
    });

    // Log network
    networkPanel.querySelector(".oni-net-log")?.addEventListener("click", (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      const fabulaData = readFabulaData(scene);
      const rows = normalizeSceneNetwork(fabulaData?.[SCENE_NET_KEY]);

      log("Scene:", scene?.name, "Scene Network =", rows);
      ui.notifications?.info?.("Logged to console: Scene Network");
    });

    // -----------------------------
    // Reset Dungeon button (GM only, dungeon mode only)
    // -----------------------------
    if (game.user?.isGM) {
      const resetSection = tabPanel.querySelector(".oni-dp-reset-section");
      const modeSel      = tabPanel.querySelector(`select[name="flags.${MODULE_ID}.${FABULA_ROOT_KEY}.${GENERAL_KEY}.${SCENE_MODE_KEY}"]`);
      const generalPanel = tabPanel.querySelector(`.oni-fabula-subpanel[data-subtab="${SUBTAB_GENERAL_ID}"]`);

      function syncResetVisibility() {
        const mode = modeSel?.value ?? "";
        resetSection.style.display = (mode === "dungeon" || mode === "exploration") ? "" : "none";

      }

      // Conflict Event only means anything on a conflict scene, so the
      // dropdown is hidden elsewhere. Hidden, NOT removed — the field stays in
      // the form so its stored value round-trips through a save made while
      // the scene is in another mode.
      const conflictEventGroup = generalPanel?.querySelector(".oni-conflict-event-group");
      function syncConflictEventVisibility() {
        if (!conflictEventGroup) return;
        conflictEventGroup.style.display = (modeSel?.value ?? "") === "conflict" ? "" : "none";
      }

      syncResetVisibility();
      syncConflictEventVisibility();
      modeSel?.addEventListener("change", syncResetVisibility);
      modeSel?.addEventListener("change", syncConflictEventVisibility);

      // Spawnpoint arm mode
      tabPanel.querySelector(".oni-set-spawnpoint-btn")?.addEventListener("click", async (ev) => {
        ev.preventDefault(); ev.stopPropagation();

        app.minimize();
        ui.notifications?.info?.("Click anywhere on the map to set the spawn point. Press Escape to cancel.");

        const view = canvas?.app?.view ?? document.querySelector("#board canvas");
        if (!view) { app.maximize(); return; }

        let cleaned = false;
        const cleanUp = () => {
          if (cleaned) return; cleaned = true;
          view.removeEventListener("pointerdown", clickHandler, true);
          window.removeEventListener("keydown",   escHandler,   true);
        };

        const escHandler = (keyEv) => {
          if (keyEv.key !== "Escape") return;
          keyEv.preventDefault(); keyEv.stopPropagation();
          cleanUp();
          app.maximize();
          ui.notifications?.info?.("Spawn point setting cancelled.");
        };

        const clickHandler = async (pointerEv) => {
          if (pointerEv.button !== 0) return;
          pointerEv.preventDefault(); pointerEv.stopPropagation();
          cleanUp();

          const worldPt = globalThis.DungeonPathing?.Graph?.clientToWorld?.(pointerEv.clientX, pointerEv.clientY)
                       ?? clientToWorld(pointerEv.clientX, pointerEv.clientY);

          try {
            await scene.setFlag(MODULE_ID, `${FABULA_ROOT_KEY}.${GENERAL_KEY}.${SPAWN_POINT_KEY}`, {
              x: Math.round(worldPt.x),
              y: Math.round(worldPt.y),
            });
            updateSpawnpointStatus(generalPanel, scene);
            ui.notifications?.info?.(`Spawn point set to (${Math.round(worldPt.x)}, ${Math.round(worldPt.y)}).`);
          } catch (e) {
            console.error("[FabulaConfigUI] setSpawnpoint failed:", e);
            ui.notifications?.error?.("Failed to save spawn point — see console.");
          }
          app.maximize();
        };

        window.addEventListener("keydown",   escHandler,   true);
        view.addEventListener("pointerdown", clickHandler, true);
      });

      tabPanel.querySelector(".oni-reset-dungeon-btn")?.addEventListener("click", async (ev) => {
        ev.preventDefault(); ev.stopPropagation();

        const result = await new Promise(resolve => {
          new Dialog({
            title: "Reset Dungeon",
            content: `
              <p>Choose what to reset in <b>${scene?.name ?? "this scene"}</b>:</p>
              <div style="margin:10px 0;display:flex;flex-direction:column;gap:8px;">
                <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;">
                  <input type="checkbox" id="oni-reset-filter-tiles" checked style="margin-top:2px;" />
                  <span><b>Tiles</b> — restore all tile states and textures, clear visited flags</span>
                </label>
                <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;">
                  <input type="checkbox" id="oni-reset-filter-shroud" checked style="margin-top:2px;" />
                  <span><b>Shroud</b> — clear all permanent shroud reveals</span>
                </label>
              </div>
              <p style="color:#e05252;font-size:11px;margin:0;">This cannot be undone.</p>
            `,
            buttons: {
              reset: {
                label: '<i class="fas fa-redo"></i> Reset',
                callback: (html) => resolve({
                  tiles:  html[0].querySelector("#oni-reset-filter-tiles")?.checked ?? true,
                  shroud: html[0].querySelector("#oni-reset-filter-shroud")?.checked ?? true,
                }),
              },
              cancel: { label: "Cancel", callback: () => resolve(null) },
            },
            default: "cancel",
            close: () => resolve(null),
          }).render(true);
        });

        if (!result) return;
        const { tiles: filterTiles, shroud: filterShroud } = result;

        if (!filterTiles && !filterShroud) {
          ui.notifications?.warn?.("Nothing selected — reset cancelled.");
          return;
        }

        const DP = globalThis.DungeonPathing;

        try {
          if (filterTiles && filterShroud) {
            await DP?.TileState?.resetDungeon?.(scene);
          } else if (filterTiles) {
            await DP?.TileState?.resetTiles?.(scene);
          } else {
            await DP?.TileState?.resetAllFogRevealed?.(scene);
            DP?.Fog?.destroyAll?.();
            ui.notifications?.info?.("Shroud reveals cleared.");
          }
        } catch (e) {
          console.error("[FabulaConfigUI] reset failed:", e);
          ui.notifications?.error?.("Reset failed — see console.");
        }
      });
    }

    // -----------------------------
    // Bind tabs + move Save button
    // -----------------------------
    const bindRes = bindTabs(app, root);
    const saveRes = moveSaveToBottom(root);

    // Open our MAIN tab
    try { app?.activateTab?.(FABULA_TAB_ID); } catch {}

    const ok = !!root.querySelector(`a.item[data-tab="${FABULA_TAB_ID}"]`) && !!root.querySelector(`.tab[data-tab="${FABULA_TAB_ID}"]`);
    log("Injected.", { ok, scene: scene?.name, bindRes, saveRes });

    return { ok, bindRes, saveRes };
  }

  // -----------------------------
  // Hook
  // -----------------------------
  Hooks.once("ready", () => {
    log("READY: Fabula Configuration UI loaded.");
    Hooks.on("renderSceneConfig", (app, html) => {
      const res = inject(app, html);
      if (DEBUG) log("renderSceneConfig ->", res);
    });

    // Optional tiny API (handy later)
    window.oni = window.oni || {};
    window.oni.FabulaConfig = {
      MODULE_ID,
      DUNGEON_ROOT_KEY,
      FABULA_ROOT_KEY,
      GENERAL_KEY,
      CAMERA_FOLLOW_KEY,
      readDungeon(scene = canvas.scene) {
        return readDungeonData(scene);
      },
      readGeneral(scene = canvas.scene) {
        const fabula = readFabulaData(scene);
        let mode = safeGet(fabula, `${GENERAL_KEY}.${SCENE_MODE_KEY}`, null);
        if (!mode || !["none", "exploration", "dungeon", "camp", "title", "conflict", "theatre"].includes(mode)) {
          const legacy = safeGet(fabula, `${GENERAL_KEY}.${CAMERA_FOLLOW_KEY}`, false);
          mode = normalizeBoolean(legacy, false) ? "exploration" : "none";
        }
        return {
          sceneMode: mode,
          // backward-compat alias
          [CAMERA_FOLLOW_KEY]: (mode === "exploration")
        };
      },
      readSceneNetwork(scene = canvas.scene) {
        const fabula = readFabulaData(scene);
        return normalizeSceneNetwork(fabula?.[SCENE_NET_KEY]);
      }
    };
  });
})();
