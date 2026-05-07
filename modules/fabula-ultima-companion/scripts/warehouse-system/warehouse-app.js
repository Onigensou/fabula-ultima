// scripts/warehouse-system/warehouse-app.js
// ----------------------------------------------------------------------------
// ONI Warehouse — UI (Demo-style Tabs + 7x7 Grid + DnD Planning)
//
// FIX IN THIS VERSION:
// - Zenit inputs no longer full-rerender on every keystroke (prevents focus loss / hotbar typing)
// - Zenit inputs now do a "light refresh": update gate box + confirm enabled/disabled only
// ----------------------------------------------------------------------------

import { WarehouseDebug } from "./warehouse-debug.js";
import { WarehouseAPI } from "./warehouse-api.js";
import { WarehousePayloadManager } from "./warehouse-payloadManager.js";
import { WarehouseDnD } from "./warehouse-dnd.js";
import { WarehouseGates } from "./warehouse-gates.js";
import { WarehouseCommit } from "./warehouse-commit.js";

export class WarehouseApp {
  static APP_FLAG = "ONI_WAREHOUSE_APP_OPEN";

  static CATEGORIES = [
    { key: "weapon",     label: "⚔️ Weapon" },
    { key: "accessory",  label: "Accessory" },
    { key: "shield",     label: "🛡️ Shield" },
    { key: "armor",      label: "🥋 Armor" },
    { key: "consumable", label: "🍖 Consumable" },
    { key: "recipe",     label: "📖 Recipe" },
    { key: "key",        label: "🔑 Key Item" }
  ];

  static GRID_SIZE = 7;
  static SLOTS = WarehouseApp.GRID_SIZE * WarehouseApp.GRID_SIZE;

  static _uid() { return Math.random().toString(16).slice(2, 10); }

  static _escapeHtml(str) {
    return String(str ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  static _decodeHtml(escaped) {
    const t = document.createElement("textarea");
    t.innerHTML = String(escaped ?? "");
    return t.value ?? "";
  }

  static async _enrichMaybe(html) {
    const raw = String(html ?? "").trim();
    if (!raw) return "";
    try {
      return await TextEditor.enrichHTML(raw, { async: true, secrets: false, documents: true, links: true });
    } catch {
      return raw;
    }
  }

  static _getItemType(it) {
    const t =
      it?.itemType ??
      it?.system?.props?.item_type ??
      it?.system?.item_type ??
      it?.type ??
      "";
    return String(t ?? "").toLowerCase().trim();
  }

  static _isWarehouseItem(it) {
    const t = WarehouseApp._getItemType(it);
    return !!t;
  }

  static _getItemDesc(it) {
    const desc =
      it?.desc ??
      it?.system?.props?.description ??
      it?.system?.description?.value ??
      it?.system?.description ??
      "";
    return String(desc ?? "");
  }

  static _getQty(it) {
    let qty = it?.qty ?? it?.system?.props?.item_quantity ?? 1;
    qty = Number.isFinite(qty) ? qty : Number(qty);
    if (!Number.isFinite(qty)) qty = 1;
    return qty;
  }

  static _normalizeSnapshotItem(it) {
    const type = WarehouseApp._getItemType(it);
    return {
      itemUuid: it?.itemUuid ?? it?.uuid ?? "",
      name: it?.name ?? "Unnamed",
      img: it?.img ?? "icons/svg/item-bag.svg",
      type,
      qty: WarehouseApp._getQty(it),
      desc: WarehouseApp._getItemDesc(it)
    };
  }

  static _groupByCategory(items) {
    const byCat = Object.fromEntries(WarehouseApp.CATEGORIES.map(c => [c.key, []]));
    for (const raw of items ?? []) {
      if (!WarehouseApp._isWarehouseItem(raw)) continue;
      const it = WarehouseApp._normalizeSnapshotItem(raw);
      if (!byCat[it.type]) continue;
      byCat[it.type].push(it);
    }
    return byCat;
  }

  // Apply planning moves to an item list to compute "virtual qty"
  static _virtualizeList(payload, side) {
    const list = side === "actor" ? (payload.snapshot.actorItems ?? []) : (payload.snapshot.storageItems ?? []);
    const moves = payload.plan?.itemMoves ?? [];

    const map = new Map();
    for (const raw of list) {
      if (!WarehouseApp._isWarehouseItem(raw)) continue;
      const it = WarehouseApp._normalizeSnapshotItem(raw);
      if (!it.itemUuid) continue;
      map.set(it.itemUuid, { ...it });
    }

    for (const m of moves) {
      const qty = Number(m.qty ?? 0);
      if (!m.itemUuid || qty <= 0) continue;

      if (m.from === side) {
        const it = map.get(m.itemUuid);
        if (it) it.qty = Math.max(0, Number(it.qty ?? 0) - qty);
      }

      if (m.to === side) {
        const it = map.get(m.itemUuid);

        if (it) {
          it.qty = Number(it.qty ?? 0) + qty;

          // Upgrade meta if missing (prevents white bag / empty tooltip)
          if ((!it.img || it.img === "icons/svg/item-bag.svg") && m.itemImg) it.img = m.itemImg;
          if ((!it.desc || String(it.desc).trim() === "") && m.itemDesc) it.desc = this._decodeHtml(m.itemDesc);

        } else {
          map.set(m.itemUuid, {
            itemUuid: m.itemUuid,
            name: m.itemName ?? "Item",
            img: m.itemImg ?? "icons/svg/item-bag.svg",
            type: m.itemType ?? "misc",
            qty,
            desc: m.itemDesc ? this._decodeHtml(m.itemDesc) : ""
          });
        }
      }
    }

    return [...map.values()].filter(it => Number(it.qty ?? 0) > 0);
  }

  static _buildGridHTML(items, side, catKey) {
    const shown = (items ?? []).slice(0, WarehouseApp.SLOTS);
    const cells = [];

    for (let idx = 0; idx < WarehouseApp.SLOTS; idx++) {
      const it = shown[idx];

      if (!it) {
        cells.push(`<div class="oni-inv-slot oni-empty" data-side="${side}" data-cat="${catKey}" data-idx="${idx}"></div>`);
        continue;
      }

      const qtyBadge = (it.qty > 1) ? `<div class="oni-qty">${it.qty}</div>` : ``;

      const nameEsc = WarehouseApp._escapeHtml(it.name);
      const descEsc = WarehouseApp._escapeHtml(it.desc);
      const uuidEsc = WarehouseApp._escapeHtml(it.itemUuid);
      const typeEsc = WarehouseApp._escapeHtml(it.type);

      cells.push(`
        <div class="oni-inv-slot oni-item"
             data-side="${side}"
             data-cat="${catKey}"
             data-item-uuid="${uuidEsc}"
             data-item-type="${typeEsc}"
             data-item-name="${nameEsc}"
             data-item-desc="${descEsc}">
          <img class="oni-icon" src="${WarehouseApp._escapeHtml(it.img)}" draggable="false"/>
          ${qtyBadge}
        </div>
      `);
    }

    return `<div class="oni-grid">${cells.join("")}</div>`;
  }

  static _buildPanelHTML(payload, side) {
    const isActor = side === "actor";
    payload.ui.activeTab = payload.ui.activeTab ?? { actor: "weapon", storage: "weapon" };

    const name = WarehouseApp._escapeHtml(
      isActor ? (payload?.ctx?.actorName ?? "Actor") : (payload?.ctx?.storageName ?? "Storage")
    );

    const zenit = Number(
      isActor ? (payload?.snapshot?.actorZenit ?? 0) : (payload?.snapshot?.storageZenit ?? 0)
    );

    const virtualList = WarehouseApp._virtualizeList(payload, side);
    const byCat = WarehouseApp._groupByCategory(virtualList);

    const tabButtons = WarehouseApp.CATEGORIES.map((c) => {
      const active = payload.ui.activeTab[side] === c.key ? "active" : "";
      return `
        <button type="button" class="oni-tab ${active}" data-side="${side}" data-tab="${c.key}">
          ${c.label}
        </button>
      `;
    }).join("");

    const tabPanels = WarehouseApp.CATEGORIES.map((c) => {
      const active = payload.ui.activeTab[side] === c.key ? "active" : "";
      return `
        <section class="oni-panel ${active}" data-side="${side}" data-panel="${c.key}">
          ${WarehouseApp._buildGridHTML(byCat[c.key], side, c.key)}
        </section>
      `;
    }).join("");

    const deposit = Number(payload?.plan?.zenit?.depositToStorage ?? 0);
    const withdraw = Number(payload?.plan?.zenit?.withdrawFromStorage ?? 0);

    const zenitControls = isActor ? `
      <div class="wh-zenit-controls">
        <div class="wh-field">
          <label>Deposit to Storage</label>
          <input class="wh-input-deposit" type="number" min="0" step="1" value="${deposit}">
        </div>
        <div class="wh-field">
          <label>Withdraw from Storage</label>
          <input class="wh-input-withdraw" type="number" min="0" step="1" value="${withdraw}">
        </div>
      </div>
      <div class="wh-hint">Drag & Drop is active. Transfers are still “planned” until Confirm.</div>
    ` : `
      <div class="wh-hint">Planned transfers are not committed until Confirm.</div>
    `;

    return `
      <section class="wh-panel" data-side="${side}">
        <div class="wh-title">
          <span>${name}</span>
          <span class="wh-zenit">Zenit: <b>${zenit}</b></span>
        </div>

        <div class="oni-tabs" data-side="${side}">
          ${tabButtons}
        </div>

        <div class="oni-panels" data-side="${side}">
          ${tabPanels}
        </div>

        ${zenitControls}
      </section>
    `;
  }

  static _buildGateBox(payload) {
    const ok = payload?.gates?.ok !== false;
    if (ok) return "";

    const errs = (payload.gates?.errors ?? []).slice(0, 6);
    const items = errs.map(e => `<li>${this._escapeHtml(e.msg ?? "Gate error")}</li>`).join("");

    return `
      <div class="wh-gatebox">
        <div class="wh-gatebox-title">Cannot Confirm</div>
        <ul class="wh-gatebox-list">${items}</ul>
      </div>
    `;
  }

  static _buildHtml(payload) {
    const gateBox = WarehouseApp._buildGateBox(payload);

    const actorPanel = WarehouseApp._buildPanelHTML(payload, "actor");
    const storagePanel = WarehouseApp._buildPanelHTML(payload, "storage");

    return `
      <div class="wh-root">
        <style>
          .wh-root { display: flex; gap: 12px; user-select: none; flex-direction: column; }
          .wh-row { display:flex; gap: 12px; }

          .wh-panel {
            width: 420px;
            border: 1px solid rgba(255,255,255,0.15);
            border-radius: 10px;
            padding: 10px;
            background: rgba(0,0,0,0.20);
          }
          .wh-title {
            font-weight: 800;
            font-size: 14px;
            margin-bottom: 6px;
            opacity: 0.9;
            display:flex;
            justify-content:space-between;
            align-items:center;
          }
          .wh-zenit { font-size: 13px; opacity: 0.9; }
          .wh-zenit b { font-size: 14px; }

          .oni-tabs {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 6px;
            margin-bottom: 8px;
          }
          .oni-tab {
            border: 1px solid rgba(0,0,0,0.18);
            background: rgba(255,255,255,0.55);
            padding: 4px 6px;
            height: 26px;
            border-radius: 8px;
            cursor: pointer;
            font-size: 11px;
            line-height: 1;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            white-space: nowrap;
          }
          .oni-tab.active {
            background: rgba(255,255,255,0.92);
            border-color: rgba(0,0,0,0.32);
            font-weight: 800;
            box-shadow: 0 0 0 2px rgba(255,255,255,0.35) inset;
          }

          .oni-panel { display: none; }
          .oni-panel.active { display: block; }

          .oni-grid {
            display: grid;
            grid-template-columns: repeat(7, 44px);
            grid-auto-rows: 44px;
            gap: 6px;
            padding: 6px;
            border: 1px solid rgba(0,0,0,0.18);
            border-radius: 12px;
            background: rgba(255,255,255,0.45);
          }

          .oni-inv-slot {
            position: relative;
            width: 44px;
            height: 44px;
            border-radius: 10px;
            border: 1px solid rgba(0,0,0,0.18);
            background: rgba(255,255,255,0.30);
            overflow: hidden;
          }

          .oni-inv-slot.oni-item {
            cursor: pointer;
            background: rgba(255,255,255,0.65);
          }
          .oni-inv-slot.oni-item:hover {
            outline: 2px solid rgba(255,255,255,0.9);
            box-shadow: 0 0 0 2px rgba(0,0,0,0.12) inset;
            transform: translateY(-1px);
          }

          .oni-icon {
            width: 100%;
            height: 100%;
            object-fit: cover;
            display: block;
            pointer-events: none;
          }

          .oni-qty {
            position: absolute;
            right: 3px;
            bottom: 3px;
            min-width: 16px;
            height: 16px;
            padding: 0 4px;
            border-radius: 999px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            font-size: 11px;
            font-weight: 900;
            background: rgba(0,0,0,0.72);
            color: white;
            line-height: 1;
            pointer-events: none;
          }

          .wh-zenit-controls { display:flex; gap: 10px; margin-top: 10px; }
          .wh-field { flex: 1; display:flex; flex-direction:column; gap: 4px; }
          .wh-field label { font-size: 12px; opacity: 0.85; }
          .wh-field input {
            width: 100%;
            padding: 6px 8px;
            border-radius: 8px;
            border: 1px solid rgba(255,255,255,0.12);
            background: rgba(0,0,0,0.25);
            color: inherit;
          }
          .wh-hint { margin-top: 8px; font-size: 12px; opacity: 0.75; }

          /* Gate box */
          .wh-gatebox {
            padding: 10px 12px;
            border-radius: 12px;
            border: 1px solid rgba(255, 80, 80, 0.35);
            background: rgba(140, 0, 0, 0.20);
            color: rgba(255,255,255,0.92);
          }
          .wh-gatebox-title { font-weight: 900; margin-bottom: 6px; }
          .wh-gatebox-list { margin: 0 0 0 18px; padding: 0; }

          /* Tooltip */
          .oni-tooltip {
            position: fixed;
            z-index: 100000;
            max-width: 340px;
            padding: 8px 10px;
            border-radius: 10px;
            border: 1px solid rgba(0,0,0,0.25);
            background: rgba(20,20,20,0.92);
            color: #ffffff;
            box-shadow: 0 10px 25px rgba(0,0,0,0.35);
            display: none;
            pointer-events: none;
          }
          .oni-tooltip .t-name { font-weight: 900; margin-bottom: 6px; font-size: 13px; }
          .oni-tooltip .t-desc { font-size: 12px; opacity: 0.95; }

          /* Ghost */
          .wh-ghost { filter: drop-shadow(0 10px 18px rgba(0,0,0,0.35)); }
        </style>

        ${gateBox}

        <div class="wh-row">
          ${actorPanel}
          ${storagePanel}
        </div>

        <div class="oni-tooltip" id="whTooltip">
          <div class="t-name"></div>
          <div class="t-desc"></div>
        </div>
      </div>
    `;
  }

  static _setConfirmEnabled(payload) {
    const dlg = payload.ui?.dialogApp;
    const el = dlg?.element?.[0];
    if (!dlg || !el) return;

    const ok = payload?.gates?.ok !== false;

    const btn = el.querySelector(`.dialog-buttons button[data-button="confirm"]`);
    if (!btn) return;

    btn.disabled = !ok;
    btn.classList.toggle("wh-disabled", !ok);
    btn.title = ok ? "" : "Fix errors above before Confirm";

    WarehouseDebug.log(payload, "GATE", "Confirm button state", { enabled: ok });
  }

  // ✅ Light refresh: only update gate box + confirm enabled/disabled (no full rerender)
  static _refreshGatesOnly(payload) {
    const dlg = payload.ui?.dialogApp;
    const el = dlg?.element?.[0];
    if (!dlg || !el) return;

    const root = el.querySelector(".wh-root");
    if (!root) return;

    const existing = root.querySelector(".wh-gatebox");
    const ok = payload?.gates?.ok !== false;

    if (ok) {
      if (existing) existing.remove();
    } else {
      const html = this._buildGateBox(payload);
      if (existing) {
        existing.outerHTML = html;
      } else {
        // insert at top of wh-root
        root.insertAdjacentHTML("afterbegin", html);
      }
    }

    this._setConfirmEnabled(payload);
  }

  // --- RERENDER: rebuild wh-root content, keep active tabs
  static rerender(payload) {
    const dlg = payload.ui?.dialogApp;
    const el = dlg?.element?.[0];
    if (!el) return;

    const oldRoot = el.querySelector(".wh-root");
    if (!oldRoot) return;

    WarehouseDebug.log(payload, "UI", "Rerender UI (planning change)", {
      moves: payload.plan?.itemMoves?.length ?? 0,
      zenitPlan: payload.plan?.zenit,
      gatesOk: payload.gates?.ok
    });

    oldRoot.outerHTML = this._buildHtml(payload);

    const newRoot = el.querySelector(".wh-root");
    this._bindAll({ 0: newRoot }, payload);

    this._setConfirmEnabled(payload);
  }

  static _bindTabs(root, payload) {
    const tabBtns = [...root.querySelectorAll(".oni-tab")];
    const panels = [...root.querySelectorAll(".oni-panel")];

    const activateTab = (side, key) => {
      payload.ui.activeTab = payload.ui.activeTab ?? { actor: "weapon", storage: "weapon" };
      payload.ui.activeTab[side] = key;

      for (const b of tabBtns) {
        if (b.dataset.side !== side) continue;
        b.classList.toggle("active", b.dataset.tab === key);
      }
      for (const p of panels) {
        if (p.dataset.side !== side) continue;
        p.classList.toggle("active", p.dataset.panel === key);
      }
    };

    for (const b of tabBtns) {
      b.addEventListener("click", () => activateTab(b.dataset.side, b.dataset.tab));
    }
  }

  static _bindTooltip(root, payload) {
    const tip = root.querySelector("#whTooltip");
    const tipName = tip?.querySelector(".t-name");
    const tipDesc = tip?.querySelector(".t-desc");
    if (!tip || !tipName || !tipDesc) return;

    const moveTip = (ev) => {
      const pad = 14;
      const rect = tip.getBoundingClientRect();
      let x = ev.clientX + pad;
      let y = ev.clientY + pad;

      if (x + rect.width > window.innerWidth - 8) x = window.innerWidth - rect.width - 8;
      if (y + rect.height > window.innerHeight - 8) y = window.innerHeight - rect.height - 8;

      tip.style.left = `${x}px`;
      tip.style.top = `${y}px`;
    };

    const hideTip = () => {
      tip.style.display = "none";
      tipName.textContent = "";
      tipDesc.innerHTML = "";
    };

    const showTip = async (ev, slot) => {
      const nameEsc = slot.dataset.itemName ?? "Item";
      const descEsc = slot.dataset.itemDesc ?? "";

      tipName.textContent = WarehouseApp._decodeHtml(nameEsc) || "Item";

      const decodedHtml = WarehouseApp._decodeHtml(descEsc);
      const finalHtml = await WarehouseApp._enrichMaybe(decodedHtml);
      tipDesc.innerHTML = finalHtml || `<em>No description.</em>`;

      tip.style.display = "block";
      moveTip(ev);

      WarehouseDebug.log(payload, "TIP", "Tooltip show", { name: tipName.textContent, hasDesc: !!decodedHtml });
    };

    root.addEventListener("mouseenter", (ev) => {
      const slot = ev.target.closest(".oni-inv-slot.oni-item");
      if (!slot) return;
      showTip(ev, slot);
    }, true);

    root.addEventListener("mousemove", (ev) => {
      if (tip.style.display === "none") return;
      moveTip(ev);
    }, true);

    root.addEventListener("mouseleave", (ev) => {
      const slot = ev.target.closest(".oni-inv-slot.oni-item");
      if (!slot) return;
      hideTip();
    }, true);

    root.addEventListener("wheel", hideTip, { passive: true });
    root.addEventListener("mousedown", hideTip);
  }

  static _bindZenit(root, payload) {
    const depositEl = root.querySelector(".wh-input-deposit");
    const withdrawEl = root.querySelector(".wh-input-withdraw");

    const clamp0Int = (n) => {
      const v = Math.floor(Number(n));
      return Number.isFinite(v) ? Math.max(0, v) : 0;
    };

    // 🔒 Prevent Foundry keybinds / focus leaks while typing
    const protectInput = (el) => {
      if (!el) return;

      // stop keyboard events from bubbling to Foundry keybind handlers
      const stop = (ev) => ev.stopPropagation();
      el.addEventListener("keydown", stop);
      el.addEventListener("keyup", stop);
      el.addEventListener("keypress", stop);

      // also stop mouse down bubbling (helps some clients)
      el.addEventListener("mousedown", stop);
    };

    protectInput(depositEl);
    protectInput(withdrawEl);

    // ✅ On input: update payload + validate + LIGHT refresh only
    depositEl?.addEventListener("input", () => {
      const v = clamp0Int(depositEl.value ?? 0);
      payload.plan.zenit.depositToStorage = v;
      payload.plan.zenit.lastEditedAt = Date.now();
      payload.plan.zenit.lastEditedBy = payload.ctx.userId;

      WarehouseDebug.log(payload, "ZENIT", "Deposit changed", { depositToStorage: v });

      WarehouseGates.validate(payload);
      this._refreshGatesOnly(payload);
    });

    withdrawEl?.addEventListener("input", () => {
      const v = clamp0Int(withdrawEl.value ?? 0);
      payload.plan.zenit.withdrawFromStorage = v;
      payload.plan.zenit.lastEditedAt = Date.now();
      payload.plan.zenit.lastEditedBy = payload.ctx.userId;

      WarehouseDebug.log(payload, "ZENIT", "Withdraw changed", { withdrawFromStorage: v });

      WarehouseGates.validate(payload);
      this._refreshGatesOnly(payload);
    });
  }

  static _bindDnD(root, payload) {
    WarehouseDnD.init(root, payload, {
      onChange: () => {
        WarehouseGates.validate(payload);
        this.rerender(payload); // DnD planning changes still do full rerender
      }
    });
  }

  static _bindAll(htmlObj, payload) {
    const root = htmlObj?.[0]?.querySelector?.(".wh-root") ?? htmlObj?.[0];
    if (!root) return;

    this._bindTabs(root, payload);
    this._bindTooltip(root, payload);
    this._bindZenit(root, payload);
    this._bindDnD(root, payload);
  }

  static async open(payload) {
    payload = WarehousePayloadManager.getOrCreate(payload?.meta?.initial ?? payload ?? {});
    payload.ui.instanceId = payload.ui.instanceId ?? crypto.randomUUID?.() ?? this._uid();
    payload.ui.activeTab = payload.ui.activeTab ?? { actor: "weapon", storage: "weapon" };
    payload.plan.itemMoves = payload.plan.itemMoves ?? [];
    payload.plan.zenit = payload.plan.zenit ?? { depositToStorage: 0, withdrawFromStorage: 0 };

    await WarehouseAPI.resolveContext(payload);
    await WarehouseAPI.buildSnapshot(payload);

    WarehouseGates.validate(payload);

    payload.ui.renderCount = (payload.ui.renderCount ?? 0) + 1;
    const content = this._buildHtml(payload);

    WarehouseDebug.log(payload, "UI", "Opening Warehouse UI", {
      instanceId: payload.ui.instanceId,
      renderCount: payload.ui.renderCount
    });

    const dlg = new Dialog(
      {
        title: "Warehouse — Item Withdraw",
        content,
        buttons: {
          confirm: {
            icon: '<i class="fas fa-check"></i>',
            label: "Confirm",
           callback: async () => {
  WarehouseGates.validate(payload);

  if (payload.gates?.ok === false) {
    ui.notifications?.error?.("Warehouse: Fix errors before Confirm.");
    WarehouseDebug.warn(payload, "GATE", "Confirm blocked", { errors: payload.gates?.errors });
    this._refreshGatesOnly(payload);
    return;
  }

  WarehouseDebug.log(payload, "UI", "Confirm pressed → committing", {
    plannedMoves: payload.plan?.itemMoves?.length ?? 0,
    zenitPlan: payload.plan?.zenit
  });

  // ✅ Commit (Items + Zenit), then snapshot refresh + plan clear happens inside commit script
  await WarehouseCommit.commit(payload, this);
}
          },
          cancel: {
            icon: '<i class="fas fa-times"></i>',
            label: "Cancel",
            callback: () => {
              WarehouseDebug.log(payload, "UI", "Cancel pressed", { instanceId: payload.ui.instanceId });
            }
          }
        },
        default: "confirm",
        render: (html) => {
          payload.ui.dialogApp = dlg;
          this._bindAll(html, payload);
          this._setConfirmEnabled(payload);
        },
        close: () => {
          WarehouseDebug.log(payload, "UI", "Dialog closed", { instanceId: payload.ui.instanceId });
        }
      },
      { width: 920, height: "auto", resizable: true }
    );

    dlg.render(true);
    return payload;
  }
}
