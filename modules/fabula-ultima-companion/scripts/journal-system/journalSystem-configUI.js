/**
 * ONI — Journal System Config Tab (MODULE)
 * Foundry VTT v12
 *
 * What it does:
 * - Adds a "Journal Config" tab to Tile Config
 * - Stores config as Tile flags:
 *   flags.oni-journal-system.{
 *     isJournalTile,
 *     journalUuid,
 *     journalName,
 *     journalType,
 *     openMode,
 *     grantObserver,
 *     proximityPx
 *   }
 *
 * Notes:
 * - "Is Journal Object" acts as the main enable/disable gate.
 * - Drag & Drop accepts JournalEntry and JournalEntryPage.
 * - This script only handles the Tile Config UI.
 * - The actual opening behavior will be handled by journalSystem-core.js
 */

function installJournalConfigUI() {
  // ------------------------------------------------------------
  // Guard: prevent double install
  // ------------------------------------------------------------
  const GLOBAL_KEY = "oni.JournalConfigUI";
  if (window[GLOBAL_KEY]?.installed) {
    console.log("[ONI][JournalConfigUI]", "Already installed; skipping.");
    return;
  }
  window[GLOBAL_KEY] = { installed: true };

  const SCOPE = "oni-journal-system";
  const TAB_ID = "oni-journal-config";
  const STYLE_ID = "oni-journal-config-style";
  const MARKER_ATTR = "data-oni-journal-config";

  const DEBUG = true;
  const TAG = "[ONI][JournalConfigUI]";
  const log = (...a) => DEBUG && console.log(TAG, ...a);
  const warn = (...a) => DEBUG && console.warn(TAG, ...a);

  // ------------------------------------------------------------
  // CSS
  // ------------------------------------------------------------
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .oni-journal-wrap { padding: 10px 8px; }
      .oni-journal-subtle { opacity: .85; font-size: 12px; margin: 6px 0 10px; }

      .oni-journal-drop {
        border: 1px dashed var(--color-border-light-primary, #9993);
        border-radius: 8px;
        padding: 10px;
        background: rgba(0,0,0,0.02);
      }
      .oni-journal-drop.is-over { filter: brightness(1.06); }

      .oni-journal-picked {
        display:flex;
        align-items:center;
        gap:10px;
        margin-top:10px;
        padding:8px;
        border:1px solid var(--color-border-light-primary, #9993);
        border-radius:8px;
        background: rgba(0,0,0,0.02);
      }

      .oni-journal-picked img {
        width:34px;
        height:34px;
        border-radius:6px;
        object-fit:cover;
      }

      .oni-journal-picked .name {
        font-weight:800;
      }

      .oni-journal-picked .meta {
        opacity:.8;
        font-size:12px;
        word-break:break-all;
      }

      .oni-journal-actions {
        margin-top: 10px;
        display:flex;
        gap:8px;
        flex-wrap:wrap;
      }

      .oni-journal-fields[hidden] {
        display:none !important;
      }
    `;
    document.head.appendChild(style);
    log("Injected CSS:", STYLE_ID);
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

  function normalizeDistancePx(raw, fallback = 120) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(40, Math.round(n));
  }

  function readJournalFlags(tileDoc) {
    const mod = tileDoc?.flags?.[SCOPE];
    if (mod && Object.keys(mod).length) return mod;

    const world = tileDoc?.flags?.world?.[SCOPE];
    if (world && Object.keys(world).length) return world;

    const legacy = tileDoc?.flags?.[SCOPE];
    if (legacy && Object.keys(legacy).length) return legacy;

    return {};
  }

  function isValidJournalDoc(doc) {
    if (!doc) return false;
    return doc.documentName === "JournalEntry" || doc.documentName === "JournalEntryPage";
  }

  function getJournalDisplayName(doc) {
    if (!doc) return "";
    if (doc.documentName === "JournalEntryPage") {
      const parentName = doc.parent?.name ?? "Unknown Journal";
      const pageName = doc.name ?? "Unknown Page";
      return `${parentName} → ${pageName}`;
    }
    return doc.name ?? "Unnamed Journal";
  }

  function getJournalType(doc) {
    if (!doc) return "";
    return doc.documentName ?? "";
  }

  function getJournalImg(doc) {
    if (!doc) return "icons/svg/book.svg";
    if (doc.documentName === "JournalEntryPage") {
      return doc.parent?.img || "icons/svg/book.svg";
    }
    return doc.img || "icons/svg/book.svg";
  }

  // ------------------------------------------------------------
  // Main injection
  // ------------------------------------------------------------
  Hooks.on("renderTileConfig", async (app, html) => {
    try {
      ensureStyle();

      const root = getRoot(html, app);
      if (!root) return warn("No root element found for TileConfig. Abort.");
      if (root.hasAttribute(MARKER_ATTR)) return log("Already injected; skipping.");
      root.setAttribute(MARKER_ATTR, "1");

      const tileDoc = app?.document ?? app?.object;
      log("renderTileConfig fired.", {
        appId: app?.appId,
        tileId: tileDoc?.id,
        tileName: tileDoc?.name
      });

      const tabsNav = root.querySelector("nav.sheet-tabs");
      const sheetBody = root.querySelector(".sheet-body") || root.querySelector(".window-content form");

      if (!tabsNav || !sheetBody) {
        warn("Could not find tabsNav or sheetBody.", { tabsNav, sheetBody });
        return;
      }

      // --------------------------------------------------------
      // Tab button
      // --------------------------------------------------------
      const tabButton = document.createElement("a");
      tabButton.className = "item";
      tabButton.dataset.tab = TAB_ID;
      tabButton.innerHTML = `<i class="fas fa-book-open"></i> Journal Config`;
      tabsNav.appendChild(tabButton);
      log("Tab button injected:", TAB_ID);

      // --------------------------------------------------------
      // Tab panel
      // --------------------------------------------------------
      const tabPanel = document.createElement("div");
      tabPanel.className = "tab";
      tabPanel.dataset.tab = TAB_ID;

      tabPanel.innerHTML = `
        <div class="oni-journal-wrap">
          <div class="oni-journal-subtle">
            Saved into <b>Tile Flags</b>: <code>flags.${SCOPE}.*</code><br>
            If <b>Is Journal Object</b> is OFF, the journal system should ignore this tile.
          </div>

          <div class="form-group">
            <label>Is Journal Object</label>
            <div class="form-fields">
              <input type="checkbox" name="flags.${SCOPE}.isJournalTile" class="oni-is-journal" />
            </div>
            <p class="notes">Turn this ON only for tiles that should behave like JRPG notes or journals.</p>
          </div>

          <div class="oni-journal-fields" hidden>
            <input type="hidden" name="flags.${SCOPE}.journalUuid" class="oni-journal-uuid" />
            <input type="hidden" name="flags.${SCOPE}.journalName" class="oni-journal-name" />
            <input type="hidden" name="flags.${SCOPE}.journalType" class="oni-journal-type" />

            <h3 style="margin: 10px 0 6px;">Linked Journal</h3>

            <div class="oni-journal-drop oni-drop-zone">
              <div style="font-weight:800; margin-bottom:4px;">Drag & Drop Journal Here</div>
              <div style="opacity:.85; font-size:12px; line-height:1.35;">
                Accepts <b>JournalEntry</b> and <b>JournalEntryPage</b>.
              </div>

              <div class="oni-journal-picked oni-picked" style="display:none;">
                <img class="oni-picked-img" src="" alt="">
                <div style="flex:1;">
                  <div class="name oni-picked-name"></div>
                  <div class="meta oni-picked-type"></div>
                  <div class="meta oni-picked-uuid"></div>
                </div>
                <button type="button" class="oni-clear-journal">
                  <i class="fas fa-times"></i>
                </button>
              </div>
            </div>

            <div class="form-group" style="margin-top: 10px;">
              <label>Open Mode</label>
              <div class="form-fields">
                <select name="flags.${SCOPE}.openMode" class="oni-open-mode">
                  <option value="ALL">ALL</option>
                  <option value="CALLER">CALLER</option>
                </select>
              </div>
              <p class="notes">ALL = show to all players. CALLER = show only the player who triggered it.</p>
            </div>

            <div class="form-group">
              <label>Grant Observer</label>
              <div class="form-fields">
                <input type="checkbox" name="flags.${SCOPE}.grantObserver" class="oni-grant-observer" />
              </div>
              <p class="notes">If ON, players may also be granted OBSERVER permission like your old macro option.</p>
            </div>

            <div class="form-group">
              <label>Proximity Range (px)</label>
              <div class="form-fields">
                <input
                  type="number"
                  name="flags.${SCOPE}.proximityPx"
                  class="oni-proximity-px"
                  value="120"
                  min="40"
                  step="10"
                />
              </div>
              <p class="notes">How close the party token must be before the journal inspect icon appears.</p>
            </div>

            <div class="oni-journal-actions">
              <button type="button" class="oni-debug-read">
                <i class="fas fa-terminal"></i> Debug: Log Current Flags
              </button>
            </div>

            <p class="notes">Changes save only when you click <b>Save Changes</b> in the Tile Config window.</p>
          </div>
        </div>
      `;

      sheetBody.appendChild(tabPanel);
      log("Tab panel injected into sheet body.");

      const bound = bindTabs(app, root);
      if (!bound.ok) warn("bindTabs failed:", bound.reason);
      else log("bindTabs ok.");

      // --------------------------------------------------------
      // Prefill
      // --------------------------------------------------------
      const data = readJournalFlags(tileDoc);
      log("Prefill read flags:", foundry.utils.duplicate(data));

      const cb = tabPanel.querySelector(".oni-is-journal");
      const fieldsWrap = tabPanel.querySelector(".oni-journal-fields");

      const journalUuidEl = tabPanel.querySelector(".oni-journal-uuid");
      const journalNameEl = tabPanel.querySelector(".oni-journal-name");
      const journalTypeEl = tabPanel.querySelector(".oni-journal-type");

      const openModeEl = tabPanel.querySelector(".oni-open-mode");
      const grantObserverEl = tabPanel.querySelector(".oni-grant-observer");
      const proximityPxEl = tabPanel.querySelector(".oni-proximity-px");

      const pickedWrap = tabPanel.querySelector(".oni-picked");
      const pickedImg = tabPanel.querySelector(".oni-picked-img");
      const pickedName = tabPanel.querySelector(".oni-picked-name");
      const pickedType = tabPanel.querySelector(".oni-picked-type");
      const pickedUuid = tabPanel.querySelector(".oni-picked-uuid");

      const isJournalTile = normalizeBoolean(safeGet(data, "isJournalTile", false), false);
      cb.checked = isJournalTile;
      fieldsWrap.hidden = !isJournalTile;

      journalUuidEl.value = safeGet(data, "journalUuid", "");
      journalNameEl.value = safeGet(data, "journalName", "");
      journalTypeEl.value = safeGet(data, "journalType", "");

      openModeEl.value = String(safeGet(data, "openMode", "ALL") || "ALL").toUpperCase();
      grantObserverEl.checked = normalizeBoolean(safeGet(data, "grantObserver", false), false);
      proximityPxEl.value = normalizeDistancePx(safeGet(data, "proximityPx", 120), 120);

      function refreshPickedUI() {
        const uuid = String(journalUuidEl.value || "").trim();
        const name = String(journalNameEl.value || "").trim();
        const type = String(journalTypeEl.value || "").trim();

        if (!uuid) {
          pickedWrap.style.display = "none";
          return;
        }

        pickedWrap.style.display = "flex";
        pickedImg.src = "icons/svg/book.svg";
        pickedName.textContent = name || "(Unnamed Journal)";
        pickedType.textContent = type || "(Unknown Type)";
        pickedUuid.textContent = uuid;
      }

      refreshPickedUI();

      log("Prefill applied.", {
        isJournalTile,
        journalUuid: journalUuidEl.value,
        journalName: journalNameEl.value,
        journalType: journalTypeEl.value,
        openMode: openModeEl.value,
        grantObserver: grantObserverEl.checked,
        proximityPx: proximityPxEl.value
      });

      // --------------------------------------------------------
      // Events
      // --------------------------------------------------------
      cb.addEventListener("change", () => {
        fieldsWrap.hidden = !cb.checked;
        log("Is Journal Object toggled:", cb.checked);
      });

      tabPanel.querySelector(".oni-debug-read")?.addEventListener("click", () => {
        const dump = {
          isJournalTile: cb.checked,
          journalUuid: journalUuidEl.value,
          journalName: journalNameEl.value,
          journalType: journalTypeEl.value,
          openMode: openModeEl.value,
          grantObserver: grantObserverEl.checked,
          proximityPx: proximityPxEl.value
        };
        log("DEBUG READ (current form values):", dump);
        ui.notifications?.info?.("Journal Config logged to console.");
      });

      tabPanel.querySelector(".oni-clear-journal")?.addEventListener("click", () => {
        log("Clear journal clicked.");
        journalUuidEl.value = "";
        journalNameEl.value = "";
        journalTypeEl.value = "";
        refreshPickedUI();
      });

      const dropZone = tabPanel.querySelector(".oni-drop-zone");

      dropZone.addEventListener("dragenter", (ev) => {
        ev.preventDefault();
        dropZone.classList.add("is-over");
      });

      dropZone.addEventListener("dragleave", (ev) => {
        ev.preventDefault();
        dropZone.classList.remove("is-over");
      });

      dropZone.addEventListener("dragover", (ev) => {
        ev.preventDefault();
        dropZone.classList.add("is-over");
      });

      dropZone.addEventListener("drop", async (ev) => {
        ev.preventDefault();
        dropZone.classList.remove("is-over");

        log("DROP received.");

        let dragData;
        try {
          dragData = TextEditor.getDragEventData(ev);
          log("Drag data:", dragData);
        } catch (e) {
          warn("Failed to parse drag event data:", e);
          ui.notifications?.error?.("Drop failed: couldn't read drag data.");
          return;
        }

        const uuid = dragData?.uuid || dragData?.documentUuid;
        const type = String(dragData?.type || "").trim();

        if (!uuid) {
          warn("Drop missing uuid/documentUuid.");
          ui.notifications?.warn?.("Drop rejected: no UUID found.");
          return;
        }

        let doc;
        try {
          doc = await fromUuid(uuid);
          log("fromUuid resolved:", doc);
        } catch (e) {
          warn("fromUuid failed:", uuid, e);
          ui.notifications?.error?.("Drop failed: couldn't resolve UUID.");
          return;
        }

        if (!isValidJournalDoc(doc)) {
          warn("Drop rejected: resolved doc is not JournalEntry or JournalEntryPage.", {
            requestedType: type,
            resolvedDocumentName: doc?.documentName,
            uuid
          });
          ui.notifications?.warn?.("Drop rejected: only JournalEntry or JournalEntryPage is allowed.");
          return;
        }

        journalUuidEl.value = doc.uuid;
        journalNameEl.value = getJournalDisplayName(doc);
        journalTypeEl.value = getJournalType(doc);

        pickedImg.src = getJournalImg(doc);
        refreshPickedUI();

        ui.notifications?.info?.(`Journal linked: ${journalNameEl.value}`);
        log("Journal linked:", {
          uuid: journalUuidEl.value,
          name: journalNameEl.value,
          type: journalTypeEl.value
        });
      });

      try {
        app.setPosition({ height: "auto" });
      } catch (_) {}

      log("Journal Config UI injection complete.");
    } catch (e) {
      console.error("[ONI][JournalConfigUI] Fatal error in renderTileConfig:", e);
    }
  });

  log("Installed (module). renderTileConfig hook active.");
}

// --------------------------------------------------------------
// Auto-install after Foundry is ready
// --------------------------------------------------------------
Hooks.once("ready", () => {
  try {
    installJournalConfigUI();
  } catch (e) {
    console.error("[ONI][JournalConfigUI] install failed:", e);
  }
});
