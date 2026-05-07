/**
 * [ONI] Event System — Config UI
 * Foundry VTT v12
 *
 * File:
 * scripts/event-system/event-configUI.js
 *
 * What this does:
 * - Adds an "Event Config" tab to Tile Config
 * - Saves Event System data into Tile flags:
 *   flags.oni-event-system.{
 *     isEventTile,
 *     proximityPx,
 *     eventRows
 *   }
 * - Provides a dynamic event row table
 * - Currently supports:
 *   - Show Text
 *
 * Requires:
 * - event-constants.js
 * - event-debug.js
 * - event-eventRegistry.js
 */

(() => {
  const INSTALL_TAG = "[ONI][EventSystem][ConfigUI]";

  // ------------------------------------------------------------
  // Global namespace + guard
  // ------------------------------------------------------------
  window.oni = window.oni || {};
  window.oni.EventSystem = window.oni.EventSystem || {};

  if (window.oni.EventSystem.ConfigUI?.installed) {
    console.log(INSTALL_TAG, "Already installed; skipping.");
    return;
  }

  const C = window.oni.EventSystem.Constants;
  const D = window.oni.EventSystem.Debug;
  const EventRegistry = window.oni.EventSystem.EventRegistry;

  if (!C) {
    console.error(INSTALL_TAG, "Missing Constants. Load event-constants.js first.");
    return;
  }

  if (!EventRegistry) {
    console.error(INSTALL_TAG, "Missing EventRegistry. Load event-eventRegistry.js first.");
    return;
  }

  const DEBUG_SCOPE = "ConfigUI";
  const SCOPE = C.FLAG_SCOPE;
  const TAB_ID = C.TAB_ID;
  const STYLE_ID = C.STYLE_ID_CONFIG;
  const MARKER_ATTR = C.MARKER_ATTR;

  const FALLBACK_DEBUG = {
    log: (...args) => console.log(`[ONI][EventSystem][${DEBUG_SCOPE}]`, ...args),
    verboseLog: (...args) => console.log(`[ONI][EventSystem][${DEBUG_SCOPE}]`, ...args),
    warn: (...args) => console.warn(`[ONI][EventSystem][${DEBUG_SCOPE}]`, ...args),
    error: (...args) => console.error(`[ONI][EventSystem][${DEBUG_SCOPE}]`, ...args),
    group: (...args) => {
      console.groupCollapsed(`[ONI][EventSystem][${DEBUG_SCOPE}]`, ...args);
      return true;
    },
    groupEnd: () => console.groupEnd()
  };

  const DBG = D || FALLBACK_DEBUG;

  // ------------------------------------------------------------
  // CSS
  // ------------------------------------------------------------
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .oni-event-wrap {
        padding: 10px 8px;
      }

      .oni-event-subtle {
        opacity: .85;
        font-size: 12px;
        margin: 6px 0 10px;
        line-height: 1.45;
      }

      .oni-event-fields[hidden] {
        display: none !important;
      }

      /* ------------------------------------------------------
         Make Tile Config tab row more resilient as more tabs get added
      ------------------------------------------------------ */
      [data-oni-event-config="1"] nav.sheet-tabs {
        display: flex;
        flex-wrap: wrap;
        row-gap: 4px;
        column-gap: 8px;
        align-items: center;
      }

      [data-oni-event-config="1"] nav.sheet-tabs .item {
        flex: 0 0 auto;
        white-space: nowrap;
      }

      .oni-event-table {
        display: flex;
        flex-direction: column;
        gap: 10px;
        margin-top: 10px;
      }

      .oni-event-empty {
        border: 1px dashed var(--color-border-light-primary, #9993);
        border-radius: 8px;
        padding: 12px;
        opacity: .85;
        font-size: 12px;
        background: rgba(0,0,0,0.02);
      }

      .oni-event-row {
        border: 1px solid var(--color-border-light-primary, #9993);
        border-radius: 10px;
        padding: 10px;
        background: rgba(0,0,0,0.02);
      }

      .oni-event-row-head {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        margin-bottom: 10px;
      }

      .oni-event-row-index {
        min-width: 28px;
        height: 28px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 999px;
        font-weight: 800;
        background: rgba(0,0,0,0.08);
      }

      .oni-event-row-type {
        min-width: 220px;
      }

      .oni-event-row-spacer {
        flex: 1 1 auto;
      }

      .oni-event-row-body {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }

      .oni-event-inline-grid {
        display: grid;
        grid-template-columns: 160px 1fr;
        gap: 10px;
        align-items: start;
      }

      .oni-event-inline-grid label {
        font-weight: 700;
        padding-top: 6px;
      }

      .oni-event-inline-grid input[type="text"],
      .oni-event-inline-grid input[type="number"],
      .oni-event-inline-grid select,
      .oni-event-inline-grid textarea {
        width: 100%;
      }

      .oni-event-textarea {
        min-height: 120px;
        resize: vertical;
      }

      .oni-event-row-notes {
        font-size: 12px;
        opacity: .82;
        line-height: 1.4;
      }

      .oni-event-actions {
        margin-top: 10px;
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }

      .oni-event-mini-note {
        margin-top: 6px;
        font-size: 12px;
        opacity: .8;
      }

      .oni-event-hidden-json {
        display: none !important;
      }
    `;

    document.head.appendChild(style);
  }

  // ------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------
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

  function escapeHTML(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function normalizeBoolean(raw, fallback = false) {
    if (raw === true || raw === false) return raw;
    if (raw === 1 || raw === 0) return !!raw;

    if (typeof raw === "string") {
      const s = raw.trim().toLowerCase();
      if (["true", "1", "yes", "y", "on"].includes(s)) return true;
      if (["false", "0", "no", "n", "off"].includes(s)) return false;
    }

    return fallback;
  }

  function normalizeProximityPx(raw, fallback = C.DEFAULT_PROXIMITY_PX) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(C.MIN_PROXIMITY_PX ?? 0, Math.round(n));
  }

  function resizeTileConfigForTabs(app, root) {
    try {
      const tabsNav = root?.querySelector("nav.sheet-tabs");
      if (!tabsNav) return;

      const tabCount = tabsNav.querySelectorAll(".item").length;

      const targetWidth = Math.min(
        Math.max(760, tabCount * 96),
        1180
      );

      app.setPosition({
        width: targetWidth,
        height: "auto"
      });

      DBG.verboseLog(DEBUG_SCOPE, "TileConfig resized for tab count.", {
        tabCount,
        targetWidth
      });
    } catch (e) {
      DBG.warn(DEBUG_SCOPE, "resizeTileConfigForTabs failed.", e);
    }
  }

  function readEventFlags(tileDoc) {
    const mod = tileDoc?.flags?.[SCOPE];
    if (mod && Object.keys(mod).length) return mod;

    const world = tileDoc?.flags?.world?.[SCOPE];
    if (world && Object.keys(world).length) return world;

    return {};
  }

  function normalizeEventRows(rawRows) {
    let rows = rawRows;

    if (typeof rows === "string") {
      try {
        rows = JSON.parse(rows);
      } catch (_) {
        rows = [];
      }
    }

    if (!Array.isArray(rows)) rows = [];

    return rows.map((row) => {
      const type = EventRegistry.has(row?.type)
        ? row.type
        : (C.DEFAULT_ROW_TYPE || C.EVENT_TYPES?.SHOW_TEXT || "showText");

      const fallbackRow = EventRegistry.makeDefaultRow(type);

      const merged = foundry.utils.mergeObject(
        foundry.utils.deepClone(fallbackRow),
        foundry.utils.deepClone(row ?? {}),
        { inplace: false, overwrite: true }
      );

      merged.id = String(merged.id || foundry.utils.randomID());
      merged.type = type;

      if (type === (C.EVENT_TYPES?.SHOW_TEXT || "showText")) {
        merged.speaker = String(
          merged.speaker ?? C.DEFAULT_SHOW_TEXT_SPEAKER ?? C.SPECIAL_SPEAKER_SELF ?? "Self"
        );
        merged.text = String(merged.text ?? C.DEFAULT_SHOW_TEXT_MESSAGE ?? "");
      }

      return merged;
    });
  }

  function getDropdownOptions() {
    const options = EventRegistry.getDropdownOptions?.() ?? [];
    if (Array.isArray(options) && options.length) return options;

    return [
      {
        value: C.EVENT_TYPES?.SHOW_TEXT || "showText",
        label: C.EVENT_TYPE_LABELS?.showText || "Show Text"
      }
    ];
  }

  function buildDefaultRow(type = null) {
    try {
      return EventRegistry.makeDefaultRow(type || C.DEFAULT_ROW_TYPE);
    } catch (e) {
      DBG.warn(DEBUG_SCOPE, "buildDefaultRow fallback path used.", e);

      return {
        id: foundry.utils.randomID(),
        type: type || C.DEFAULT_ROW_TYPE || "showText",
        speaker: C.DEFAULT_SHOW_TEXT_SPEAKER || C.SPECIAL_SPEAKER_SELF || "Self",
        text: C.DEFAULT_SHOW_TEXT_MESSAGE || ""
      };
    }
  }

  function updateRowIndices(rowsWrap) {
    const rows = Array.from(rowsWrap.querySelectorAll(".oni-event-row"));
    rows.forEach((rowEl, index) => {
      const bubble = rowEl.querySelector(".oni-event-row-index");
      if (bubble) bubble.textContent = String(index + 1);
    });
  }

  function updateEmptyState(rowsWrap) {
    const emptyEl = rowsWrap.querySelector(".oni-event-empty");
    const rows = rowsWrap.querySelectorAll(".oni-event-row");
    if (!emptyEl) return;

    emptyEl.style.display = rows.length ? "none" : "";
  }

  function collectRows(rowsWrap) {
    const rowEls = Array.from(rowsWrap.querySelectorAll(".oni-event-row"));
    const rows = [];

    for (const rowEl of rowEls) {
      const typeEl = rowEl.querySelector(".oni-event-row-type");
      const type = String(typeEl?.value || C.DEFAULT_ROW_TYPE || "showText");

      const row = {
        id: String(rowEl.dataset.rowId || foundry.utils.randomID()),
        type
      };

      if (type === (C.EVENT_TYPES?.SHOW_TEXT || "showText")) {
        row.speaker = String(
          rowEl.querySelector(".oni-event-row-speaker")?.value ??
          C.DEFAULT_SHOW_TEXT_SPEAKER ??
          C.SPECIAL_SPEAKER_SELF ??
          "Self"
        ).trim() || (C.DEFAULT_SHOW_TEXT_SPEAKER || C.SPECIAL_SPEAKER_SELF || "Self");

        row.text = String(
          rowEl.querySelector(".oni-event-row-text")?.value ?? ""
        );
      }

      rows.push(row);
    }

    return rows;
  }

  function syncRowsJson(hiddenJsonEl, rowsWrap) {
    if (!hiddenJsonEl) return;
    const rows = collectRows(rowsWrap);
    hiddenJsonEl.value = JSON.stringify(rows, null, 2);
  }

  function buildShowTextFields(rowData) {
    const wrapper = document.createElement("div");
    wrapper.className = "oni-event-row-body";
    wrapper.innerHTML = `
      <div class="oni-event-inline-grid">
        <label>Speaker</label>
        <div>
          <input
            type="text"
            class="oni-event-row-speaker"
            value="${escapeHTML(String(rowData.speaker ?? C.DEFAULT_SHOW_TEXT_SPEAKER ?? "Self"))}"
            placeholder="Self / Actor UUID / Token UUID / Name"
          />
          <div class="oni-event-mini-note">
            Leave blank for <b>Self</b>. You can also use Actor UUID, Token UUID, or plain text.
          </div>
        </div>
      </div>

      <div class="oni-event-inline-grid">
        <label>Message</label>
        <div>
          <textarea
            class="oni-event-row-text oni-event-textarea"
            placeholder="Write the dialog text here..."
          >${String(rowData.text ?? "")}</textarea>
          <div class="oni-event-mini-note">
            This field stores rich text / HTML content. For now it is edited as a large text area.
          </div>
        </div>
      </div>
    `;
    return wrapper;
  }

  function buildUnknownFields(rowData) {
    const wrapper = document.createElement("div");
    wrapper.className = "oni-event-row-body";
    wrapper.innerHTML = `
      <div class="oni-event-row-notes">
        This event type is not recognized by the current registry.<br>
        Type: <code>${escapeHTML(String(rowData.type || ""))}</code>
      </div>
    `;
    return wrapper;
  }

  function buildFieldsForType(type, rowData) {
    switch (String(type || "")) {
      case (C.EVENT_TYPES?.SHOW_TEXT || "showText"):
        return buildShowTextFields(rowData);
      default:
        return buildUnknownFields(rowData);
    }
  }

  function createRowElement(rowData, rowsWrap, hiddenJsonEl) {
    const row = normalizeEventRows([rowData])[0] || buildDefaultRow();

    const rowEl = document.createElement("div");
    rowEl.className = "oni-event-row";
    rowEl.dataset.rowId = String(row.id);

    const head = document.createElement("div");
    head.className = "oni-event-row-head";

    const indexBubble = document.createElement("div");
    indexBubble.className = "oni-event-row-index";
    indexBubble.textContent = "?";

    const typeSelect = document.createElement("select");
    typeSelect.className = "oni-event-row-type";

    for (const opt of getDropdownOptions()) {
      const option = document.createElement("option");
      option.value = String(opt.value);
      option.textContent = String(opt.label);
      if (String(opt.value) === String(row.type)) option.selected = true;
      typeSelect.appendChild(option);
    }

    const spacer = document.createElement("div");
    spacer.className = "oni-event-row-spacer";

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "oni-event-row-remove";
    removeBtn.innerHTML = `<i class="fas fa-trash"></i> Remove`;

    head.appendChild(indexBubble);
    head.appendChild(typeSelect);
    head.appendChild(spacer);
    head.appendChild(removeBtn);

    const fieldsHost = document.createElement("div");
    fieldsHost.className = "oni-event-row-fields-host";
    fieldsHost.appendChild(buildFieldsForType(row.type, row));

    rowEl.appendChild(head);
    rowEl.appendChild(fieldsHost);

    typeSelect.addEventListener("change", () => {
      const nextType = String(typeSelect.value || C.DEFAULT_ROW_TYPE || "showText");

      const rebuiltRow = foundry.utils.mergeObject(
        foundry.utils.deepClone(buildDefaultRow(nextType)),
        { id: rowEl.dataset.rowId, type: nextType },
        { inplace: false, overwrite: true }
      );

      fieldsHost.replaceChildren(buildFieldsForType(nextType, rebuiltRow));
      syncRowsJson(hiddenJsonEl, rowsWrap);

      DBG.log(DEBUG_SCOPE, "Event row type changed.", {
        rowId: rowEl.dataset.rowId,
        newType: nextType
      });
    });

    removeBtn.addEventListener("click", () => {
      rowEl.remove();
      updateRowIndices(rowsWrap);
      updateEmptyState(rowsWrap);
      syncRowsJson(hiddenJsonEl, rowsWrap);

      DBG.log(DEBUG_SCOPE, "Event row removed.", {
        rowId: rowEl.dataset.rowId
      });
    });

    rowEl.addEventListener("input", () => {
      syncRowsJson(hiddenJsonEl, rowsWrap);
    });

    rowEl.addEventListener("change", () => {
      syncRowsJson(hiddenJsonEl, rowsWrap);
    });

    return rowEl;
  }

  function renderRows(rowsWrap, rows, hiddenJsonEl) {
    rowsWrap.querySelectorAll(".oni-event-row").forEach(el => el.remove());

    for (const row of rows) {
      rowsWrap.appendChild(createRowElement(row, rowsWrap, hiddenJsonEl));
    }

    updateRowIndices(rowsWrap);
    updateEmptyState(rowsWrap);
    syncRowsJson(hiddenJsonEl, rowsWrap);
  }

  function patchSubmitData(app) {
    if (!app?._oniEventConfigOriginalGetSubmitData) {
      app._oniEventConfigOriginalGetSubmitData = app._getSubmitData.bind(app);
    }

    app._getSubmitData = function (updateData = {}) {
      const data = app._oniEventConfigOriginalGetSubmitData(updateData);

      try {
        const root = getRoot(null, app);
        const rowsWrap = root?.querySelector?.(".oni-event-table");

        if (!rowsWrap) {
          DBG.warn(DEBUG_SCOPE, "Patched _getSubmitData could not find current rowsWrap.", {
            appId: app?.appId ?? null,
            tileId: app?.document?.id ?? app?.object?.id ?? null
          });
          return data;
        }

        const rows = collectRows(rowsWrap);
        data[`flags.${SCOPE}.eventRows`] = rows;

        DBG.verboseLog(DEBUG_SCOPE, "Patched _getSubmitData appended eventRows.", {
          tileId: app?.document?.id ?? app?.object?.id ?? null,
          rows
        });
      } catch (e) {
        DBG.error(DEBUG_SCOPE, "Failed injecting eventRows into submit data.", e);
      }

      return data;
    };

    app._oniEventConfigSubmitPatched = true;

    DBG.verboseLog(DEBUG_SCOPE, "Submit patch installed/refreshed.", {
      appId: app?.appId ?? null
    });
  }

  // ------------------------------------------------------------
  // Main injection
  // ------------------------------------------------------------
  Hooks.on("renderTileConfig", async (app, html) => {
    let grouped = false;

    try {
      ensureStyle();

      const root = getRoot(html, app);
      if (!root) {
        DBG.warn(DEBUG_SCOPE, "No TileConfig root found.");
        return;
      }

      if (root.hasAttribute(MARKER_ATTR)) {
        DBG.verboseLog(DEBUG_SCOPE, "Already injected; skipping.");
        return;
      }

      root.setAttribute(MARKER_ATTR, "1");

      const tileDoc = app?.document ?? app?.object;
      const tabsNav = root.querySelector("nav.sheet-tabs");
      const sheetBody = root.querySelector(".sheet-body") || root.querySelector(".window-content form");

      if (!tabsNav || !sheetBody) {
        DBG.warn(DEBUG_SCOPE, "Could not find tabsNav or sheetBody.", { tabsNav, sheetBody });
        return;
      }

      grouped = !!DBG.group?.(DEBUG_SCOPE, `Render TileConfig [${tileDoc?.id ?? "unknown"}]`, true);
      DBG.log(DEBUG_SCOPE, "Injecting Event Config tab.", {
        appId: app?.appId,
        tileId: tileDoc?.id,
        tileName: tileDoc?.name
      });

      // --------------------------------------------------------
      // Tab button
      // --------------------------------------------------------
      const tabButton = document.createElement("a");
      tabButton.className = "item";
      tabButton.dataset.tab = TAB_ID;
      tabButton.innerHTML = C.TAB_ICON_HTML || `<i class="fas fa-bolt"></i> Event Config`;
      tabsNav.appendChild(tabButton);

      // --------------------------------------------------------
      // Tab panel
      // --------------------------------------------------------
      const tabPanel = document.createElement("div");
      tabPanel.className = "tab";
      tabPanel.dataset.tab = TAB_ID;

      tabPanel.innerHTML = `
        <div class="oni-event-wrap">
          <div class="oni-event-subtle">
            Saved into <b>Tile Flags</b>: <code>flags.${SCOPE}.*</code><br>
            If <b>Is Event Tile</b> is OFF, the Event System should ignore this tile completely.
          </div>

          <div class="form-group">
            <label>Is Event Tile</label>
            <div class="form-fields">
              <input
                type="checkbox"
                name="flags.${SCOPE}.isEventTile"
                class="oni-is-event"
              />
            </div>
            <p class="notes">
              Main enable/disable gate for this tile.
            </p>
          </div>

          <div class="oni-event-fields" hidden>
            <div class="form-group">
              <label>Proximity Range (px)</label>
              <div class="form-fields">
                <input
                  type="number"
                  name="flags.${SCOPE}.proximityPx"
                  class="oni-event-proximity"
                  value="${Number(C.DEFAULT_PROXIMITY_PX ?? 0)}"
                  min="${Number(C.MIN_PROXIMITY_PX ?? 0)}"
                  step="${Number(C.PROXIMITY_STEP_PX ?? 10)}"
                />
              </div>
              <p class="notes">
                <b>0</b> means the party must be basically on top of the tile before the <b>!</b> icon appears.
              </p>
            </div>

            <input
              type="hidden"
              class="oni-event-hidden-json"
              name="flags.${SCOPE}.eventRowsJsonPreview"
            />

            <h3 style="margin: 10px 0 6px;">Event Sequence</h3>

            <div class="oni-event-row-notes">
              Events run from top to bottom. Each event waits for the one before it to finish first.
            </div>

            <div class="oni-event-table">
              <div class="oni-event-empty">
                No event rows yet. Click <b>Add Event</b> to create the first one.
              </div>
            </div>

            <div class="oni-event-actions">
              <button type="button" class="oni-event-add-row">
                <i class="fas fa-plus"></i> Add Event
              </button>

              <button type="button" class="oni-event-debug-read">
                <i class="fas fa-terminal"></i> Debug: Log Current Flags
              </button>
            </div>

            <p class="notes">
              Changes save only when you click <b>Save Changes</b> in the Tile Config window.
            </p>
          </div>
        </div>
      `;

      sheetBody.appendChild(tabPanel);

      const bound = bindTabs(app, root);
      if (!bound.ok) DBG.warn(DEBUG_SCOPE, "bindTabs failed.", bound.reason);

      resizeTileConfigForTabs(app, root);

      // --------------------------------------------------------
      // Prefill
      // --------------------------------------------------------
      const flags = readEventFlags(tileDoc);
      const isEventTile = normalizeBoolean(safeGet(flags, "isEventTile", false), false);
      const proximityPx = normalizeProximityPx(
        safeGet(flags, "proximityPx", C.DEFAULT_PROXIMITY_PX),
        C.DEFAULT_PROXIMITY_PX
      );
      const eventRows = normalizeEventRows(safeGet(flags, "eventRows", []));

      const isEventEl = tabPanel.querySelector(".oni-is-event");
      const fieldsWrap = tabPanel.querySelector(".oni-event-fields");
      const proximityEl = tabPanel.querySelector(".oni-event-proximity");
      const rowsWrap = tabPanel.querySelector(".oni-event-table");
      const hiddenJsonEl = tabPanel.querySelector(".oni-event-hidden-json");
      const addRowBtn = tabPanel.querySelector(".oni-event-add-row");
      const debugBtn = tabPanel.querySelector(".oni-event-debug-read");

      isEventEl.checked = isEventTile;
      fieldsWrap.hidden = !isEventTile;
      proximityEl.value = String(proximityPx);

      renderRows(rowsWrap, eventRows, hiddenJsonEl);

      DBG.verboseLog(DEBUG_SCOPE, "Prefill applied.", {
        isEventTile,
        proximityPx,
        eventRows
      });

      // --------------------------------------------------------
      // Events
      // --------------------------------------------------------
      isEventEl.addEventListener("change", () => {
        fieldsWrap.hidden = !isEventEl.checked;

        DBG.log(DEBUG_SCOPE, "Is Event Tile toggled.", {
          tileId: tileDoc?.id ?? null,
          isEventTile: isEventEl.checked
        });

        resizeTileConfigForTabs(app, root);
      });

      addRowBtn?.addEventListener("click", () => {
        const row = buildDefaultRow(C.DEFAULT_ROW_TYPE || C.EVENT_TYPES?.SHOW_TEXT || "showText");
        rowsWrap.appendChild(createRowElement(row, rowsWrap, hiddenJsonEl));
        updateRowIndices(rowsWrap);
        updateEmptyState(rowsWrap);
        syncRowsJson(hiddenJsonEl, rowsWrap);

        DBG.log(DEBUG_SCOPE, "Event row added.", {
          tileId: tileDoc?.id ?? null,
          row
        });

        resizeTileConfigForTabs(app, root);
      });

      debugBtn?.addEventListener("click", () => {
        const dump = {
          isEventTile: isEventEl.checked,
          proximityPx: Number(proximityEl?.value || C.DEFAULT_PROXIMITY_PX || 0),
          eventRows: collectRows(rowsWrap)
        };

        DBG.log(DEBUG_SCOPE, "DEBUG READ (current form values):", dump);
        ui.notifications?.info?.("Event Config logged to console.");
      });

      rowsWrap.addEventListener("input", () => {
        syncRowsJson(hiddenJsonEl, rowsWrap);
      });

      rowsWrap.addEventListener("change", () => {
        syncRowsJson(hiddenJsonEl, rowsWrap);
      });

      patchSubmitData(app);

      resizeTileConfigForTabs(app, root);

      DBG.log(DEBUG_SCOPE, "Event Config UI injection complete.", {
        tileId: tileDoc?.id ?? null
      });
    } catch (e) {
      console.error(INSTALL_TAG, "Fatal error in renderTileConfig:", e);
    } finally {
      if (grouped) DBG.groupEnd?.();
    }
  });

  // ------------------------------------------------------------
  // Publish API
  // ------------------------------------------------------------
  window.oni.EventSystem.ConfigUI = {
    installed: true
  };

  console.log(INSTALL_TAG, "Installed.");
})();
