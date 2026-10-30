/**
 * [ONI] Event System — Config UI
 * Foundry VTT v12
 *
 * File:
 * scripts/event-system/event-configUI.js
 *
 * What this does:
 * - Adds an "Event Config" tab to Tile Config and Token Config
 * - Saves Event System data into Tile / Token flags:
 *   flags.oni-event-system.{
 *     isEventTile,
 *     proximityPx,
 *     lockMovement,
 *     onceOnly,
 *     availableWhen,
 *     eventRows
 *   }
 * - Hosts the event row list. The list itself, and the fields of each
 *   action, come from event-configKit.js and the registry: this file knows
 *   nothing about any one action.
 *
 * Requires:
 * - event-constants.js
 * - event-debug.js
 * - event-configKit.js
 * - event-eventRegistry.js
 */

(() => {
  const INSTALL_TAG = "[ONI][EventSystem][ConfigUI]";

  const RAW = () => {};

  // ------------------------------------------------------------
  // Global namespace + guard
  // ------------------------------------------------------------
  window.oni = window.oni || {};
  window.oni.EventSystem = window.oni.EventSystem || {};

  if (window.oni.EventSystem.ConfigUI?.installed) {
    RAW("Already installed; skipping (double-load guard).");
    console.debug(INSTALL_TAG, "Already installed; skipping.");
    return;
  }

  const C = window.oni.EventSystem.Constants;
  const D = window.oni.EventSystem.Debug;
  const EventRegistry = window.oni.EventSystem.EventRegistry;
  const Kit = window.oni.EventSystem.ConfigKit;

  RAW("Dependency check", { C: !!C, EventRegistry: !!EventRegistry, D: !!D, Kit: !!Kit });

  if (!C) {
    console.error(INSTALL_TAG, "Missing Constants. Load event-constants.js first.");
    return;
  }

  if (!EventRegistry) {
    console.error(INSTALL_TAG, "Missing EventRegistry. Load event-eventRegistry.js first.");
    return;
  }

  if (!Kit) {
    console.error(INSTALL_TAG, "Missing ConfigKit. Load event-configKit.js first.");
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
  // CSS (the row list brings its own, from the kit)
  // ------------------------------------------------------------
  function ensureStyle() {
    Kit.ensureStyle();
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

      .oni-event-actions {
        margin-top: 10px;
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }

      .oni-event-actions button {
        width: auto;
        flex: 0 0 auto;
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

  // The top-level row list and the "available when" editor of this window.
  function findTopList(root) {
    return root?.querySelector?.(".oni-event-table > .oni-event-list") ?? null;
  }

  function findAvailabilityEditor(root) {
    return root?.querySelector?.(".oni-event-available > .oni-cond") ?? null;
  }

  function syncRowsJson(hiddenJsonEl, root) {
    if (!hiddenJsonEl) return;
    hiddenJsonEl.value = JSON.stringify(Kit.collectList(findTopList(root)), null, 2);
  }

  function patchSubmitData(app) {
    if (!app?._oniEventConfigOriginalGetSubmitData) {
      app._oniEventConfigOriginalGetSubmitData = app._getSubmitData.bind(app);
    }

    app._getSubmitData = function (updateData = {}) {
      const data = app._oniEventConfigOriginalGetSubmitData(updateData);

      try {
        const root = getRoot(null, app);
        const topList = findTopList(root);

        if (!topList) {
          DBG.warn(DEBUG_SCOPE, "Patched _getSubmitData could not find the event row list.", {
            appId: app?.appId ?? null,
            tileId: app?.document?.id ?? app?.object?.id ?? null
          });
          return data;
        }

        const rows = Kit.collectList(topList);
        data[`flags.${SCOPE}.eventRows`] = rows;
        data[`flags.${SCOPE}.availableWhen`] = Kit.readCondition(findAvailabilityEditor(root));

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
  RAW("renderTileConfig / renderTokenConfig hooks registered.");

  Hooks.on("renderTileConfig", (app, html) => injectEventConfig(app, html, "tile"));
  // A token carries the same event data as a tile: an NPC you walk up to and talk to.
  Hooks.on("renderTokenConfig", (app, html) => injectEventConfig(app, html, "token"));

  async function injectEventConfig(app, html, sourceKind = "tile") {
    RAW("render config FIRED", { sourceKind, appId: app?.appId, tileId: app?.document?.id ?? app?.object?.id });
    let grouped = false;

    const isToken = sourceKind === "token";
    // Prototype tokens are skipped: an event belongs to one placed NPC.
    if (isToken && (app?.isPrototype || !(app?.document ?? app?.object)?.parent)) return;

    const sourceLabel = isToken ? "Token" : "Tile";
    const defaultProximityPx = isToken
      ? (Number(canvas?.grid?.size) || 100)
      : Number(C.DEFAULT_PROXIMITY_PX ?? 0);

    try {
      ensureStyle();

      const root = getRoot(html, app);
      if (!root) {
        RAW("No root found — aborting.");
        DBG.warn(DEBUG_SCOPE, "No TileConfig root found.");
        return;
      }

      RAW("root check", {
        hasEventMarker:  root.hasAttribute(MARKER_ATTR),
        hasFabulaMarker: root.hasAttribute("data-oni-fabula-config"),
      });

      if (root.hasAttribute(MARKER_ATTR)) {
        RAW("Already injected (marker set) — skipping.");
        DBG.verboseLog(DEBUG_SCOPE, "Already injected; skipping.");
        return;
      }

      root.setAttribute(MARKER_ATTR, "1");

      const tileDoc = app?.document ?? app?.object;
      const tabsNav = root.querySelector("nav.sheet-tabs");
      // Same sheetBody logic as dp-tile-config: walk up from first native .tab panel
      const firstNativeTab = root.querySelector(".tab[data-tab]");
      const sheetBody = firstNativeTab?.parentElement
        ?? root.querySelector(".sheet-body")
        ?? root.querySelector(".window-content form");

      RAW("sheetBody resolved", {
        sheetBodyTag:   sheetBody?.tagName,
        sheetBodyClass: sheetBody?.className,
        firstNativeTab: firstNativeTab?.dataset?.tab,
      });

      if (!tabsNav || !sheetBody) {
        RAW("Missing tabsNav or sheetBody — aborting.");
        DBG.warn(DEBUG_SCOPE, "Could not find tabsNav or sheetBody.", { tabsNav, sheetBody });
        return;
      }

      // Detect whether dp-tile-config already created the shared Fabula Configuration tab.
      // Query by [data-oni-fabula-panel="1"] — NOT by [data-tab="oni-fabula-config"] which
      // would match the nav button BEFORE the panel (both share data-tab).
      const fabulaPanel = isToken ? null : sheetBody.querySelector('[data-oni-fabula-panel="1"]');
      const fabulaMode  = !!fabulaPanel;

      DBG.log(DEBUG_SCOPE, "fabulaMode detection", {
        fabulaMode,
        fabulaPanelFound: !!fabulaPanel,
        sheetBodyTabPanels: sheetBody
          ? [...sheetBody.querySelectorAll("[data-tab]")].map(p => p.dataset.tab).join(", ")
          : "(none)",
        rootHasFabulaAttr: root.hasAttribute("data-oni-fabula-config"),
      });

      grouped = !!DBG.group?.(DEBUG_SCOPE, `Render TileConfig [${tileDoc?.id ?? "unknown"}]`, true);
      DBG.log(DEBUG_SCOPE, "Injecting Event Config tab.", {
        appId: app?.appId,
        tileId: tileDoc?.id,
        tileName: tileDoc?.name,
        fabulaMode,
      });

      // --------------------------------------------------------
      // Tab button — only when creating our own standalone tab
      // --------------------------------------------------------
      if (!fabulaMode) {
        const tabButton = document.createElement("a");
        tabButton.className = "item";
        tabButton.dataset.tab = TAB_ID;
        tabButton.innerHTML = C.TAB_ICON_HTML || `<i class="fas fa-bolt"></i> Event Config`;
        tabsNav.appendChild(tabButton);
      }

      // --------------------------------------------------------
      // Tab panel (own tab) or plain section div (fabula mode)
      // --------------------------------------------------------
      const tabPanel = document.createElement("div");
      if (!fabulaMode) {
        tabPanel.className = "tab";
        tabPanel.dataset.tab = TAB_ID;
      }

      tabPanel.innerHTML = `
        <div class="oni-event-wrap">
          <div class="oni-event-subtle">
            Saved into <b>${sourceLabel} Flags</b>: <code>flags.${SCOPE}.*</code><br>
            ${isToken
              ? "Turn this ON to let the party walk up to this token and talk to it. A hidden token cannot be talked to."
              : "If <b>Is Event Tile</b> is OFF, the Event System should ignore this tile completely."}
          </div>

          <div class="form-group">
            <label>${isToken ? "Has Event (NPC dialogue)" : "Is Event Tile"}</label>
            <div class="form-fields">
              <input
                type="checkbox"
                name="flags.${SCOPE}.isEventTile"
                class="oni-is-event"
              />
            </div>
            <p class="notes">
              Main enable/disable gate for this ${sourceLabel.toLowerCase()}.
            </p>
          </div>

          <div class="oni-event-fields" hidden>
            <div class="form-group">
              <label>Starts</label>
              <div class="form-fields">
                <select name="flags.${SCOPE}.startMode" class="oni-event-start-mode">
                  <option value="button">When the party presses the ! button</option>
                  <option value="stepIn">When the party steps in</option>
                </select>
              </div>
              <p class="notes">
                Steps in: the event starts by itself as the party enters its range, with no button
                and nobody pressing anything. A tile under the landing spot starts on arrival.
                Pair it with Once only for a cutscene.
              </p>
            </div>

            <div class="form-group">
              <label>Proximity Range (px)</label>
              <div class="form-fields">
                <input
                  type="number"
                  name="flags.${SCOPE}.proximityPx"
                  class="oni-event-proximity"
                  value="${defaultProximityPx}"
                  min="${Number(C.MIN_PROXIMITY_PX ?? 0)}"
                  step="${Number(C.PROXIMITY_STEP_PX ?? 10)}"
                />
              </div>
              <p class="notes">
                ${isToken
                  ? "How close the party must stand to this token before the <b>!</b> icon appears (default: one grid)."
                  : "<b>0</b> means the party must be basically on top of the tile before the <b>!</b> icon appears."}
              </p>
            </div>

            <div class="form-group">
              <label>Lock movement while this event runs</label>
              <div class="form-fields">
                <input
                  type="checkbox"
                  name="flags.${SCOPE}.lockMovement"
                  class="oni-event-lock-movement"
                  checked
                />
              </div>
              <p class="notes">
                On: the party stays put and each line waits for a press (Confirm, or a click).
                Off: the party can walk away and each line closes by itself.
              </p>
            </div>

            <div class="form-group">
              <label>Once only</label>
              <div class="form-fields">
                <input
                  type="checkbox"
                  name="flags.${SCOPE}.onceOnly"
                  class="oni-event-once-only"
                />
              </div>
              <p class="notes">
                On: after this event has run to its end, its prompt no longer appears for this party.
              </p>
            </div>

            <div class="form-group">
              <label>Available when</label>
              <div class="form-fields oni-event-available"></div>
              <p class="notes">
                The prompt only appears while this holds. Two events on one spot with opposite
                conditions give "it says something else after the boss".
              </p>
            </div>

            <input
              type="hidden"
              class="oni-event-hidden-json"
              name="flags.${SCOPE}.eventRowsJsonPreview"
            />

            <h3 style="margin: 10px 0 6px;">Event Sequence</h3>

            <div class="oni-event-row-notes">
              Events run from top to bottom. Each event waits for the one before it to finish first,
              unless its own "Wait for completion" is off.
            </div>

            <div class="oni-event-table"></div>

            <div class="oni-event-actions">
              <button type="button" class="oni-event-debug-read">
                <i class="fas fa-terminal"></i> Debug: Log Current Flags
              </button>

              <button type="button" class="oni-event-reset-memory"
                title="Forget that this event has run, and clear its own switches A-D, for the current party.">
                <i class="fas fa-eraser"></i> Reset this event's memory
              </button>
            </div>

            <p class="notes">
              Changes save only when you click the save button of this ${sourceLabel} Config window.
            </p>
          </div>
        </div>
      `;

      if (fabulaMode) {
        const subNav     = fabulaPanel.querySelector('[data-oni-fabula-sub-nav="1"]');
        const subContent = fabulaPanel.querySelector('[data-oni-fabula-sub-content="1"]');

        if (subNav && subContent) {
          // Add sub-tab button to the secondary nav
          const subBtn = document.createElement("a");
          subBtn.className = "item";
          subBtn.dataset.subTab = "event";
          subBtn.innerHTML = `<i class="fas fa-bolt"></i> Event`;
          subNav.appendChild(subBtn);

          // Wrap content in a sub-panel and add it hidden (dungeon is active by default)
          tabPanel.className = "oni-fabula-sub-panel";
          tabPanel.dataset.subTab = "event";
          tabPanel.style.display = "none";
          subContent.appendChild(tabPanel);
        } else {
          // Fallback: flat section with divider header
          const hr = document.createElement("hr");
          hr.className = "oni-fabula-section-divider";
          fabulaPanel.appendChild(hr);
          const hdr = document.createElement("h3");
          hdr.className = "oni-fabula-section-header";
          hdr.innerHTML = `<i class="fas fa-bolt"></i> Event Config`;
          fabulaPanel.appendChild(hdr);
          fabulaPanel.appendChild(tabPanel);
        }
      } else {
        sheetBody.appendChild(tabPanel);
        const bound = bindTabs(app, root);
        if (!bound.ok) DBG.warn(DEBUG_SCOPE, "bindTabs failed.", bound.reason);
        resizeTileConfigForTabs(app, root);
      }

      // --------------------------------------------------------
      // Prefill
      // --------------------------------------------------------
      const flags = readEventFlags(tileDoc);
      const isEventTile = normalizeBoolean(safeGet(flags, "isEventTile", false), false);
      const proximityPx = normalizeProximityPx(
        safeGet(flags, "proximityPx", defaultProximityPx),
        defaultProximityPx
      );
      const eventRows = EventRegistry.normalizeRows(safeGet(flags, "eventRows", []));

      // An event saved before this setting existed counts as locked.
      const lockEl = tabPanel.querySelector(".oni-event-lock-movement");
      if (lockEl) {
        const savedLock = safeGet(flags, "lockMovement", true);
        lockEl.checked = !(savedLock === false || savedLock === "false");
      }

      const onceEl = tabPanel.querySelector(".oni-event-once-only");
      if (onceEl) onceEl.checked = normalizeBoolean(safeGet(flags, "onceOnly", false), false);

      const startEl = tabPanel.querySelector(".oni-event-start-mode");
      if (startEl) startEl.value = window.oni.EventSystem.Logic.normalizeStartMode(safeGet(flags, "startMode", null));

      const isEventEl = tabPanel.querySelector(".oni-is-event");
      const fieldsWrap = tabPanel.querySelector(".oni-event-fields");
      const proximityEl = tabPanel.querySelector(".oni-event-proximity");
      const tableHost = tabPanel.querySelector(".oni-event-table");
      const availableHost = tabPanel.querySelector(".oni-event-available");
      const hiddenJsonEl = tabPanel.querySelector(".oni-event-hidden-json");
      const debugBtn = tabPanel.querySelector(".oni-event-debug-read");
      const resetBtn = tabPanel.querySelector(".oni-event-reset-memory");

      isEventEl.checked = isEventTile;
      fieldsWrap.hidden = !isEventTile;
      proximityEl.value = String(proximityPx);

      Kit.refreshNameLists();
      availableHost.appendChild(Kit.conditionEditor(safeGet(flags, "availableWhen", null)));

      tableHost.appendChild(Kit.buildList(eventRows, {
        // A new line on an NPC is spoken by that NPC.
        makeRow: () => {
          const row = EventRegistry.makeDefaultRow(C.DEFAULT_ROW_TYPE || "showText");
          if (isToken) row.speaker = C.SPECIAL_SPEAKER_SOURCE || "This";
          return row;
        }
      }));

      syncRowsJson(hiddenJsonEl, tabPanel);

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

      debugBtn?.addEventListener("click", () => {
        const dump = {
          isEventTile: isEventEl.checked,
          proximityPx: Number(proximityEl?.value || C.DEFAULT_PROXIMITY_PX || 0),
          onceOnly: !!onceEl?.checked,
          availableWhen: Kit.readCondition(findAvailabilityEditor(tabPanel)),
          eventRows: Kit.collectList(findTopList(tabPanel))
        };

        DBG.log(DEBUG_SCOPE, "DEBUG READ (current form values):", dump);
        ui.notifications?.info?.("Event Config logged to console.");
      });

      resetBtn?.addEventListener("click", async () => {
        const state = window.oni.EventSystem.GameState;
        if (!state?.resetEvent) return;

        const ok = await state.resetEvent(tileDoc?.parent?.id ?? null, tileDoc?.id ?? null);
        if (ok) ui.notifications?.info?.("This event's memory was reset for the current party.");
        else ui.notifications?.warn?.("Could not reset this event's memory (GM only; needs a current party).");
      });

      // Typing in a field, and adding, removing, moving or retyping a row.
      tableHost.addEventListener("input", () => syncRowsJson(hiddenJsonEl, tabPanel));
      tableHost.addEventListener("change", () => {
        syncRowsJson(hiddenJsonEl, tabPanel);
        resizeTileConfigForTabs(app, root);
      });

      patchSubmitData(app);

      resizeTileConfigForTabs(app, root);

      DBG.log(DEBUG_SCOPE, "Event Config UI injection complete.", {
        tileId: tileDoc?.id ?? null
      });
    } catch (e) {
      console.error(INSTALL_TAG, "Fatal error injecting Event Config:", e);
    } finally {
      if (grouped) DBG.groupEnd?.();
    }
  }

  // ------------------------------------------------------------
  // Publish API
  // ------------------------------------------------------------
  window.oni.EventSystem.ConfigUI = {
    installed: true
  };

  console.debug(INSTALL_TAG, "Installed.");
})();
