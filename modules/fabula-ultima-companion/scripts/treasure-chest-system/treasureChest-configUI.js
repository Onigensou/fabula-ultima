/**
 * ONI — Treasure Config Tab (MODULE)
 * Foundry VTT v12
 *
 * What it does:
 * - Adds a "Treasure Config" tab to Tile Config
 * - Stores config as Tile flags:
 *   flags.oni-treasure-chest.{isTreasureChest,itemUuid,itemName,itemImg,quantity,zenit}
 *
 * Module Notes:
 * - Installs on Hooks.once("ready")
 * - Has a guard to prevent double install
 * - Keeps heavy debug logs (DEV)
 */

function installTreasureConfigUI() {
  // ---- Guard: prevent double install (module reload / dev hot reload) ----
  const GLOBAL_KEY = "oni.TreasureConfigUI";
  if (window[GLOBAL_KEY]?.installed) {
    console.log("[ONI][TreasureConfigUI]", "Already installed; skipping.");
    return;
  }
  window[GLOBAL_KEY] = { installed: true };

  const SCOPE = "oni-treasure-chest";
  const TAB_ID = "oni-treasure-config";
  const STYLE_ID = "oni-treasure-config-style";
  const MARKER_ATTR = "data-oni-treasure-config";

  // Your _Item Template ID gate
  const ITEM_TEMPLATE_ID = "ZoiV53VaLzeRsEps";

  // DEV: keep heavy logs for now
  const DEBUG = false;
  const log  = (...a) => DEBUG && console.log("[ONI][TreasureConfigUI]", ...a);
  const warn = (...a) => DEBUG && console.warn("[ONI][TreasureConfigUI]", ...a);

  // -----------------------------
  // CSS
  // -----------------------------
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .oni-treasure-wrap { padding: 10px 8px; }
      .oni-treasure-subtle { opacity: .85; font-size: 12px; margin: 6px 0 10px; }

      .oni-treasure-drop {
        border: 1px dashed var(--color-border-light-primary, #9993);
        border-radius: 8px;
        padding: 10px;
        background: rgba(0,0,0,0.02);
      }
      .oni-treasure-drop.is-over { filter: brightness(1.06); }

      .oni-treasure-picked {
        display:flex; align-items:center; gap:10px;
        margin-top: 10px;
        padding: 8px;
        border: 1px solid var(--color-border-light-primary, #9993);
        border-radius: 8px;
        background: rgba(0,0,0,0.02);
      }
      .oni-treasure-picked img { width: 34px; height: 34px; border-radius: 6px; }
      .oni-treasure-picked .name { font-weight: 800; }
      .oni-treasure-picked .meta { opacity: .8; font-size: 12px; word-break: break-all; }

      .oni-treasure-actions {
        margin-top: 10px;
        display:flex;
        gap: 8px;
        flex-wrap: wrap;
      }

      .oni-treasure-fields[hidden] { display:none !important; }
    `;
    document.head.appendChild(style);
    log("Injected CSS:", STYLE_ID);
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

  function readTreasureFlags(tileDoc) {
    const mod = tileDoc?.flags?.[SCOPE];
    if (mod && Object.keys(mod).length) return mod;
    const world = tileDoc?.flags?.world?.[SCOPE];
    if (world && Object.keys(world).length) return world;
    const legacy = tileDoc?.flags?.[SCOPE];
    if (legacy && Object.keys(legacy).length) return legacy;
    return {};
  }

  function isItemTemplateAllowed(itemDoc) {
    const tpl = itemDoc?.system?.template ?? itemDoc?.system?.templateId ?? null;
    if (tpl && String(tpl) === String(ITEM_TEMPLATE_ID)) return true;

    const tplName = itemDoc?.system?.templateName ?? itemDoc?.system?.template_name ?? "";
    if (String(tplName).trim() === "_Item Template") return true;

    return false;
  }

  // -----------------------------
  // Main injection
  // -----------------------------
  Hooks.on("renderTileConfig", async (app, html) => {
    try {
      ensureStyle();

      const root = getRoot(html, app);
      if (!root) return warn("No root element found for TileConfig. Abort.");
      if (root.hasAttribute(MARKER_ATTR)) return log("Already injected; skipping.");
      root.setAttribute(MARKER_ATTR, "1");

      const tileDoc = app?.document ?? app?.object;
      log("renderTileConfig fired.", { appId: app?.appId, tile: tileDoc?.id, name: tileDoc?.name });

      const tabsNav = root.querySelector("nav.sheet-tabs");
      const sheetBody = root.querySelector(".sheet-body") || root.querySelector(".window-content form");
      if (!tabsNav || !sheetBody) {
        warn("Could not find tabsNav or sheetBody.", { tabsNav, sheetBody });
        return;
      }

      // Tab button
      const tabButton = document.createElement("a");
      tabButton.className = "item";
      tabButton.dataset.tab = TAB_ID;
      tabButton.innerHTML = `<i class="fas fa-treasure-chest"></i> Treasure Config`;
      tabsNav.appendChild(tabButton);
      log("Tab button injected:", TAB_ID);

      // Tab panel
      const tabPanel = document.createElement("div");
      tabPanel.className = "tab";
      tabPanel.dataset.tab = TAB_ID;

      tabPanel.innerHTML = `
        <div class="oni-treasure-wrap">
          <div class="oni-treasure-subtle">
            Saved into <b>Tile Flags</b>: <code>flags.${SCOPE}.*</code><br>
            This tab only becomes active when <b>Is Treasure Chest</b> is enabled.
          </div>

          <div class="form-group">
            <label>Is Treasure Chest</label>
            <div class="form-fields">
              <input type="checkbox" name="flags.${SCOPE}.isTreasureChest" class="oni-is-treasure" />
            </div>
            <p class="notes">If OFF, Treasure behavior will not interfere with other tiles.</p>
          </div>

          <div class="oni-treasure-fields" hidden>
            <input type="hidden" name="flags.${SCOPE}.itemUuid" class="oni-item-uuid" />
            <input type="hidden" name="flags.${SCOPE}.itemName" class="oni-item-name" />
            <input type="hidden" name="flags.${SCOPE}.itemImg"  class="oni-item-img" />

            <h3 style="margin: 10px 0 6px;">Reward Item</h3>

            <div class="oni-treasure-drop oni-drop-zone">
              <div style="font-weight:800; margin-bottom:4px;">Drag & Drop Item Here</div>
              <div style="opacity:.85; font-size:12px; line-height:1.35;">
                Accepts only Items using <b>_Item Template</b> (<code>${ITEM_TEMPLATE_ID}</code>).
              </div>

              <div class="oni-treasure-picked oni-picked" style="display:none;">
                <img class="oni-picked-img" src="" alt="">
                <div style="flex:1;">
                  <div class="name oni-picked-name"></div>
                  <div class="meta oni-picked-uuid"></div>
                </div>
                <button type="button" class="oni-clear-item">
                  <i class="fas fa-times"></i>
                </button>
              </div>
            </div>

            <div class="form-group" style="margin-top: 10px;">
              <label>Amount</label>
              <div class="form-fields">
                <input type="number" name="flags.${SCOPE}.quantity" class="oni-qty" value="1" min="1" step="1" />
              </div>
              <p class="notes">How many copies of the item to award.</p>
            </div>

            <div class="form-group">
              <label>Zenit</label>
              <div class="form-fields">
                <input type="number" name="flags.${SCOPE}.zenit" class="oni-zenit" value="0" min="0" step="1" />
              </div>
              <p class="notes">How many Zenit this chest awards (0 = none).</p>
            </div>

            <div class="oni-treasure-actions">
              <button type="button" class="oni-debug-read">
                <i class="fas fa-terminal"></i> Debug: Log Current Flags
              </button>
            </div>

            <p class="notes">Remember: changes save only when you click <b>Save Changes</b> in the Tile Config window.</p>
          </div>
        </div>
      `;

      sheetBody.appendChild(tabPanel);
      log("Tab panel injected into sheetBody.");

      const bound = bindTabs(app, root);
      if (!bound.ok) warn("bindTabs failed:", bound.reason);
      else log("bindTabs ok.");

      // Prefill
      const data = readTreasureFlags(tileDoc);
      log("Prefill read flags:", foundry.utils.duplicate(data));

      const cb = tabPanel.querySelector(".oni-is-treasure");
      const fieldsWrap = tabPanel.querySelector(".oni-treasure-fields");
      const itemUuidEl = tabPanel.querySelector(".oni-item-uuid");
      const itemNameEl = tabPanel.querySelector(".oni-item-name");
      const itemImgEl  = tabPanel.querySelector(".oni-item-img");

      const qtyEl   = tabPanel.querySelector(".oni-qty");
      const zenitEl = tabPanel.querySelector(".oni-zenit");

      const pickedWrap = tabPanel.querySelector(".oni-picked");
      const pickedImg  = tabPanel.querySelector(".oni-picked-img");
      const pickedName = tabPanel.querySelector(".oni-picked-name");
      const pickedUuid = tabPanel.querySelector(".oni-picked-uuid");

      const isTreasure = normalizeBoolean(safeGet(data, "isTreasureChest", false), false);
      cb.checked = isTreasure;
      fieldsWrap.hidden = !isTreasure;

      itemUuidEl.value = safeGet(data, "itemUuid", "");
      itemNameEl.value = safeGet(data, "itemName", "");
      itemImgEl.value  = safeGet(data, "itemImg", "");

      qtyEl.value   = Number(safeGet(data, "quantity", 1) || 1);
      zenitEl.value = Number(safeGet(data, "zenit", 0) || 0);

      function refreshPickedUI() {
        const uuid = (itemUuidEl.value || "").trim();
        const name = (itemNameEl.value || "").trim();
        const img  = (itemImgEl.value  || "").trim();

        if (!uuid) { pickedWrap.style.display = "none"; return; }
        pickedWrap.style.display = "flex";
        pickedImg.src = img || "icons/svg/item-bag.svg";
        pickedName.textContent = name || "(Unnamed Item)";
        pickedUuid.textContent = uuid;
      }

      refreshPickedUI();
      log("Prefill applied.", { isTreasure, itemUuid: itemUuidEl.value, quantity: qtyEl.value, zenit: zenitEl.value });

      cb.addEventListener("change", () => {
        fieldsWrap.hidden = !cb.checked;
        log("Is Treasure Chest toggled:", cb.checked);
      });

      tabPanel.querySelector(".oni-debug-read")?.addEventListener("click", () => {
        const dump = {
          isTreasureChest: cb.checked,
          itemUuid: itemUuidEl.value,
          itemName: itemNameEl.value,
          itemImg: itemImgEl.value,
          quantity: qtyEl.value,
          zenit: zenitEl.value
        };
        log("DEBUG READ (current form values):", dump);
        ui.notifications?.info?.("Treasure Config logged to console.");
      });

      tabPanel.querySelector(".oni-clear-item")?.addEventListener("click", () => {
        log("Clear item clicked.");
        itemUuidEl.value = "";
        itemNameEl.value = "";
        itemImgEl.value  = "";
        refreshPickedUI();
      });

      const dropZone = tabPanel.querySelector(".oni-drop-zone");

      dropZone.addEventListener("dragenter", (ev) => { ev.preventDefault(); dropZone.classList.add("is-over"); });
      dropZone.addEventListener("dragleave", (ev) => { ev.preventDefault(); dropZone.classList.remove("is-over"); });
      dropZone.addEventListener("dragover",  (ev) => { ev.preventDefault(); dropZone.classList.add("is-over"); });

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
        const type = (dragData?.type || "").toLowerCase();

        if (!uuid) {
          warn("Drop missing uuid/documentUuid.");
          ui.notifications?.warn?.("Drop rejected: no UUID found.");
          return;
        }

        if (type && type !== "item") {
          warn("Drop rejected by type:", type, "uuid:", uuid);
          ui.notifications?.warn?.("Drop rejected: only Items are allowed here.");
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

        if (!doc || doc.documentName !== "Item") {
          warn("Resolved doc is not an Item:", doc);
          ui.notifications?.warn?.("Drop rejected: not an Item.");
          return;
        }

        const ok = isItemTemplateAllowed(doc);
        log("Template gate:", { ok, template: doc?.system?.template, templateId: doc?.system?.templateId });

        if (!ok) {
          ui.notifications?.warn?.("Drop rejected: Item is not using _Item Template.");
          return;
        }

        itemUuidEl.value = doc.uuid;
        itemNameEl.value = doc.name ?? "";
        itemImgEl.value  = doc.img ?? "";

        refreshPickedUI();

        ui.notifications?.info?.(`Treasure item set: ${doc.name}`);
        log("Treasure item set:", { uuid: itemUuidEl.value, name: itemNameEl.value });
      });

      try { app.setPosition({ height: "auto" }); } catch {}
      log("Treasure Config UI injection complete.");
    } catch (e) {
      console.error("[ONI][TreasureConfigUI] Fatal error in renderTileConfig:", e);
    }
  });

  log("Installed (module). renderTileConfig hook active.");
}

/**
 * Auto-install after Foundry finishes initializing
 */
Hooks.once("ready", () => {
  try {
    installTreasureConfigUI();
  } catch (e) {
    console.error("[ONI][TreasureConfigUI] install failed:", e);
  }
});
