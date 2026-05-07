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
  const GENERAL_KEY       = "general";
  const CAMERA_FOLLOW_KEY = "cameraFollowToken";

  // Main (parent) tab in Scene Config
  const FABULA_TAB_ID     = "oni-fabula-config";

  // Subtabs inside the Fabula Configuration tab
  const SUBTAB_GENERAL_ID = "subtab-general";
  const SUBTAB_DUNGEON_ID = "subtab-dungeon";
  const SUBTAB_NETWORK_ID = "subtab-network";

  const STYLE_ID = "oni-fabula-config-style";
  const MARKER_ATTR = "data-oni-fabula-config";
  const SAVE_MOVED_ATTR = "data-oni-save-moved";

  const DEBUG = true;
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
            <label>Camera Follow Token</label>
            <div class="form-fields">
              <input type="checkbox" name="flags.${MODULE_ID}.${FABULA_ROOT_KEY}.${GENERAL_KEY}.${CAMERA_FOLLOW_KEY}" />
            </div>
            <p class="notes">If enabled, your future camera script can follow the selected token on this map.</p>
          </div>

          <p class="notes">Remember: data is saved only when you press <b>Save Changes</b>.</p>
        </div>

        <!-- SUBTAB: DUNGEON (your existing UI) -->
        <div class="oni-fabula-subpanel" data-subtab="${SUBTAB_DUNGEON_ID}">
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
      const cb = generalPanel?.querySelector(`input[name="flags.${MODULE_ID}.${FABULA_ROOT_KEY}.${GENERAL_KEY}.${CAMERA_FOLLOW_KEY}"]`);
      if (cb) {
        const raw = safeGet(fabulaData, `${GENERAL_KEY}.${CAMERA_FOLLOW_KEY}`, false);
        cb.checked = normalizeBoolean(raw, false);
      }
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
        const raw = safeGet(fabula, `${GENERAL_KEY}.${CAMERA_FOLLOW_KEY}`, false);
        return {
          [CAMERA_FOLLOW_KEY]: normalizeBoolean(raw, false)
        };
      },
      readSceneNetwork(scene = canvas.scene) {
        const fabula = readFabulaData(scene);
        return normalizeSceneNetwork(fabula?.[SCENE_NET_KEY]);
      }
    };
  });
})();
