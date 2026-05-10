// scripts/shop-system/shopSell-app.js
//
// JRPG sell window — opens alongside the buy window.
//
// Two tabs: player actor inventory + warehouse (DB actor).
// Category tabs per source (weapon / armor / shield / accessory / consumable / recipe).
// Key items are excluded from the sell window.
//
// Two sell modes:
//   • Click to select items for batch sell → "Sell Selected" button.
//   • Drag & drop an item onto the drop zone → immediate individual sell.
//
// Zenit is ALWAYS credited to the linked player character (zenitActorUuid),
// regardless of whether the item came from the player actor or the warehouse.

import { gp } from "./shopopen-const.js";
import { ShopWindowApp } from "./shopWindow-app.js";

const GP_ICON = `<img class="fu-zenit-icon" src="https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/GP.png" alt="Zenit">`;

const SELL_CATEGORIES = [
  { key: "weapon",     emoji: "⚔️",  label: "Weapon"     },
  { key: "armor",      emoji: "🥋",  label: "Armor"      },
  { key: "shield",     emoji: "🛡️",  label: "Shield"     },
  { key: "accessory",  emoji: "💍",  label: "Accessory"  },
  { key: "consumable", emoji: "🧪",  label: "Consumable" },
  { key: "recipe",     emoji: "📖",  label: "Recipe"     },
];

export class ShopSellApp {

  // ──────────────────────────────────────────────────────────────
  // Data helpers
  // ──────────────────────────────────────────────────────────────

  static _esc(v) {
    return String(v ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  static _stripHTML(html) {
    const d = document.createElement("div");
    d.innerHTML = String(html ?? "");
    return (d.textContent || d.innerText || "").trim();
  }

  static _itemType(item) {
    return String(gp(item, "system.props.item_type", "") ?? "").toLowerCase().trim();
  }

  static _itemQty(item) {
    const v = Number(gp(item, "system.props.item_quantity", 1) ?? 1);
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : 1;
  }

  static _itemDesc(item) {
    return this._stripHTML(String(gp(item, "system.props.description", "") ?? ""));
  }

  static _sellMult(actor) {
    if (!actor) return 0.5;
    const v = Number(gp(actor, "system.props.shop_sell_multiplier", 50));
    return (Number.isFinite(v) && v > 0) ? v / 100 : 0.5;
  }

  static _sellPrice(item, mult) {
    const cost = Math.max(0, Number(gp(item, "system.props.item_cost", 0) ?? 0));
    return Math.round(cost * mult);
  }

  // Exclude key items; exclude zero-qty items
  static _isShowable(item) {
    const t = this._itemType(item);
    return t.length > 0 && t !== "key" && this._itemQty(item) > 0;
  }

  static _getItems(actor) {
    if (!actor) return [];
    return actor.items.contents.filter(it => this._isShowable(it));
  }

  // Pick the first category that has items in the given list, fallback to first category
  static _autoCategory(items) {
    for (const cat of SELL_CATEGORIES) {
      if (items.some(it => this._itemType(it) === cat.key)) return cat.key;
    }
    return SELL_CATEGORIES[0].key;
  }

  // ──────────────────────────────────────────────────────────────
  // CSS (inline, matches beige/parchment shop window)
  // Grid uses auto-fill so it scales with dialog width.
  // ──────────────────────────────────────────────────────────────

  static _css() {
    return (ShopSellApp._cssCache ??= `<style id="fu-sell-style">
      /* ── Root ── */
      .fu-sell { display:flex; flex-direction:column; gap:0;
                 background:#f0e6cc; color:#2c1f0e; font-family:inherit; }

      .fu-sell .fu-zenit-icon { width:16px; height:16px; object-fit:contain;
                       vertical-align:middle; margin-right:2px;
                       border:none !important; box-shadow:none !important;
                       border-radius:0; background:transparent; }

      /* ── Header ── */
      .fu-sell-header {
        display:flex; gap:10px; align-items:flex-start;
        padding:10px 12px;
        background:linear-gradient(to bottom, #e8d5a3, #dfc890);
        border-bottom:2px solid #b89940; flex-shrink:0;
      }
      .fu-sell-portrait {
        width:60px; height:60px; border-radius:8px; object-fit:cover;
        border:2px solid #b89940; flex-shrink:0; background:#c8a84b;
      }
      .fu-sell-header-info { display:flex; flex-direction:column; gap:3px; flex:1; min-width:0; }
      .fu-sell-header-name {
        font-size:14px; font-weight:800; color:#5a3800;
        text-shadow:0 1px 0 rgba(255,255,255,0.4);
        white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
      }
      .fu-sell-header-sub  { font-size:11px; color:#5a3800; opacity:0.75; }
      .fu-sell-zenit-row   {
        display:flex; align-items:center; gap:10px; flex-wrap:wrap;
        font-size:12px; font-weight:700; color:#5a3800;
      }
      .fu-sell-zenit-row .zv { color:#8b4513; display:inline-flex; align-items:center; gap:2px; }

      /* ── Source tabs (Inventory / Warehouse) ── */
      .fu-sell-src-tabs {
        display:flex; border-bottom:2px solid #b89940;
        background:#e0c87a; flex-shrink:0;
      }
      .fu-sell-src-tab {
        flex:1; padding:7px 12px; text-align:center; cursor:pointer;
        font-size:12px; font-weight:700; color:#5a3800;
        border-right:1px solid rgba(184,153,64,0.4);
        transition:background 0.12s; user-select:none;
      }
      .fu-sell-src-tab:last-child { border-right:none; }
      .fu-sell-src-tab:hover:not(.disabled) { background:rgba(139,105,20,0.15); }
      .fu-sell-src-tab.active {
        background:#f0e6cc; border-bottom:2px solid #f0e6cc; margin-bottom:-2px;
      }
      .fu-sell-src-tab.disabled { opacity:0.4; cursor:default; pointer-events:none; }

      /* ── Body: vertical category tabs (left) + content (right) ── */
      .fu-sell-body { display:flex; overflow:hidden; }
      .fu-sell-content { flex:1; display:flex; flex-direction:column; overflow:hidden; min-width:0; }

      /* ── Vertical category tabs (mirrors buy window sidebar) ── */
      .fu-sell-cat-tabs {
        display:flex; flex-direction:column; gap:2px;
        padding:8px 4px;
        background:#e0c87a;
        border-right:2px solid #b89940;
        min-width:44px; flex-shrink:0;
      }
      .fu-sell-cat-tab {
        width:36px; height:36px; border-radius:8px; font-size:18px;
        display:flex; align-items:center; justify-content:center;
        cursor:pointer; border:1px solid transparent;
        background:transparent; transition:background 0.12s, border-color 0.12s;
        position:relative; flex-shrink:0;
      }
      .fu-sell-cat-tab:hover:not(:disabled) { background:rgba(139,105,20,0.18); border-color:rgba(139,105,20,0.35); }
      .fu-sell-cat-tab.active {
        background:#c8a84b; border-color:#8b6914;
        box-shadow:inset 0 1px 2px rgba(0,0,0,0.25);
      }
      .fu-sell-cat-tab:disabled { filter:saturate(0) brightness(0.5); cursor:default; pointer-events:none; }
      .fu-sell-cat-tab::after {
        content: attr(data-tooltip);
        position:absolute; left:calc(100% + 6px); top:50%;
        transform:translateY(-50%);
        background:rgba(30,20,10,0.92); color:#ffeebb;
        font-size:11px; font-weight:700; white-space:nowrap;
        padding:3px 8px; border-radius:6px;
        pointer-events:none; opacity:0; transition:opacity 0.15s;
        z-index:9999;
      }
      .fu-sell-cat-tab:hover::after { opacity:1; }

      /* ── Grid area — dynamic columns scale with window width ── */
      .fu-sell-grid-wrap {
        overflow-y:auto; padding:10px; flex:1;
        min-height:80px; max-height:300px;
      }
      .fu-sell-grid-wrap::-webkit-scrollbar { width:5px; }
      .fu-sell-grid-wrap::-webkit-scrollbar-track { background:rgba(0,0,0,0.06); }
      .fu-sell-grid-wrap::-webkit-scrollbar-thumb { background:#b89940; border-radius:3px; }

      .fu-sell-grid {
        display:grid;
        grid-template-columns: repeat(auto-fill, minmax(48px, 1fr));
        gap:6px;
      }

      /* ── Grid slots: aspect-ratio keeps them square as they scale ── */
      .fu-sell-slot {
        position:relative; aspect-ratio:1;
        border-radius:8px; border:2px solid rgba(184,153,64,0.35);
        background:rgba(255,255,255,0.55);
        overflow:hidden; cursor:pointer;
        transition:border-color 0.1s, transform 0.08s, background 0.1s;
        user-select:none;
      }
      .fu-sell-slot:hover {
        border-color:#b89940; transform:translateY(-1px);
        background:rgba(255,255,255,0.85);
      }
      .fu-sell-slot.fu-sell-selected {
        border-color:#3a9a3a; background:rgba(100,200,100,0.22);
        box-shadow:0 0 0 1px rgba(58,154,58,0.5) inset;
      }
      .fu-sell-slot.fu-sell-dragging { opacity:0.45; }
      .fu-sell-slot img {
        width:100%; height:100%; object-fit:contain;
        display:block; pointer-events:none;
      }
      .fu-sell-qty-badge {
        position:absolute; bottom:2px; right:2px;
        min-width:16px; height:16px; padding:0 3px;
        border-radius:999px; font-size:10px; font-weight:900;
        background:rgba(0,0,0,0.72); color:#fff;
        display:inline-flex; align-items:center; justify-content:center;
        pointer-events:none; line-height:1;
      }
      .fu-sell-slot.fu-sell-selected .fu-sell-qty-badge { background:rgba(30,100,30,0.9); }
      .fu-sell-checkmark {
        position:absolute; top:2px; left:2px;
        width:14px; height:14px; border-radius:50%;
        background:#3a9a3a; color:#fff; font-size:9px; font-weight:900;
        display:none; align-items:center; justify-content:center;
        pointer-events:none;
      }
      .fu-sell-slot.fu-sell-selected .fu-sell-checkmark { display:flex; }

      /* ── Empty state ── */
      .fu-sell-empty {
        padding:28px; text-align:center; font-style:italic;
        font-size:13px; color:#6b4c2a; opacity:0.6;
      }

      /* ── Drop zone ── */
      .fu-sell-dropzone {
        margin:0 10px 8px; padding:9px;
        border:2px dashed rgba(184,153,64,0.5);
        border-radius:8px; text-align:center;
        font-size:11px; color:#6b4c2a; opacity:0.7;
        cursor:default; flex-shrink:0;
        transition:border-color 0.15s, background 0.15s, opacity 0.15s;
      }
      .fu-sell-dropzone.fu-drag-over {
        border-color:#b89940; background:rgba(184,153,64,0.15); opacity:1;
      }

      /* ── Item preview panel (visible only when exactly 1 item selected) ── */
      .fu-sell-preview {
        min-height:90px; max-height:130px;
        overflow-y:auto; padding:8px 10px;
        background:rgba(255,255,255,0.35);
        border-top:2px solid #b89940; flex-shrink:0;
      }
      .fu-sell-preview::-webkit-scrollbar { width:4px; }
      .fu-sell-preview::-webkit-scrollbar-thumb { background:#b89940; border-radius:3px; }

      /* ── Skills panel (shown below preview when skills exist) ── */
      .fu-sell-skills-panel {
        overflow-y:auto; padding:8px 10px;
        background:rgba(248,238,210,0.7);
        border-top:2px solid #b89940; flex-shrink:0;
        display:none; max-height:160px;
      }
      .fu-sell-skills-panel.has-skills { display:block; }
      .fu-sell-skills-panel::-webkit-scrollbar { width:4px; }
      .fu-sell-skills-panel::-webkit-scrollbar-thumb { background:#b89940; border-radius:3px; }

      /* ── Shared preview inner classes (mirrors buy window) ── */
      .fu-preview-placeholder {
        font-size:12px; font-style:italic; color:#6b4c2a; opacity:0.55;
        text-align:center; padding:22px 0;
      }
      .fu-preview-header { display:flex; align-items:center; gap:8px; margin-bottom:6px; }
      .fu-preview-icon-wrap {
        width:28px; height:28px; border-radius:5px;
        border:1px solid rgba(184,153,64,0.5); background:#e8d5a3;
        overflow:hidden; flex-shrink:0;
        display:flex; align-items:center; justify-content:center;
      }
      .fu-preview-icon { width:100%; height:100%; object-fit:contain; display:block; }
      .fu-preview-name {
        font-size:13px; font-weight:800; color:#3a2408;
        white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
      }
      .fu-preview-pills { display:flex; flex-wrap:wrap; gap:5px; margin-bottom:6px; }
      .fu-preview-pill {
        display:flex; align-items:center; gap:0;
        border-radius:20px; overflow:hidden;
        border:1px solid rgba(184,153,64,0.6); font-size:11px;
      }
      .fu-pill-label { background:#d4b04a; color:#3a2408; font-weight:700; padding:2px 7px; }
      .fu-pill-value { background:rgba(255,255,255,0.7); color:#5a3800; font-weight:700; padding:2px 7px; }
      .fu-preview-desc { font-size:11px; color:#5a3800; line-height:1.5; }
      .fu-preview-desc ul, .fu-preview-desc ol { margin:3px 0 3px 16px; padding:0; }
      .fu-preview-desc li { margin:2px 0; }
      .fu-preview-desc p  { margin:2px 0; }
      .fu-preview-desc .fu-hr { border:none; border-top:1px solid rgba(184,153,64,0.35); margin:4px 0; }
      .fu-preview-empty { font-size:11px; font-style:italic; color:#6b4c2a; opacity:0.55; }

      /* ── Shared skill inner classes (mirrors buy window) ── */
      .fu-skills-label {
        font-size:10px; font-weight:800; color:#5a3800;
        text-transform:uppercase; letter-spacing:0.06em;
        margin-bottom:6px; opacity:0.65;
      }
      .fu-skill-entry {
        padding:6px 8px; border-radius:7px; margin-bottom:5px;
        background:rgba(255,255,255,0.6); border:1px solid rgba(184,153,64,0.4);
      }
      .fu-skill-entry:last-child { margin-bottom:0; }
      .fu-skill-header { display:flex; align-items:center; gap:8px; margin-bottom:5px; }
      .fu-skill-icon-wrap {
        width:26px; height:26px; border-radius:5px;
        border:1px solid rgba(184,153,64,0.5); background:#e8d5a3;
        overflow:hidden; flex-shrink:0;
        display:flex; align-items:center; justify-content:center;
      }
      .fu-skill-icon { width:100%; height:100%; object-fit:contain; display:block; }
      .fu-skill-name {
        font-size:13px; font-weight:800; color:#3a2408; flex:1;
        white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
      }
      .fu-skill-cost {
        font-size:11px; font-weight:700; color:#5a3800;
        background:rgba(184,153,64,0.22); border:1px solid rgba(184,153,64,0.45);
        border-radius:10px; padding:2px 8px; flex-shrink:0; white-space:nowrap;
      }
      .fu-skill-desc { font-size:11px; color:#5a3800; line-height:1.45; }
      .fu-skill-desc ul, .fu-skill-desc ol { margin:2px 0 2px 14px; padding:0; }
      .fu-skill-desc li { margin:1px 0; }
      .fu-skill-desc p  { margin:2px 0; }
      .fu-skill-desc strong { font-weight:700; }

      /* ── Summary bar ── */
      .fu-sell-summary {
        padding:9px 12px; border-top:2px solid #b89940;
        background:rgba(0,0,0,0.06); flex-shrink:0;
      }
      .fu-sell-summary-row {
        display:flex; align-items:center; justify-content:space-between;
        gap:8px; flex-wrap:wrap;
      }
      .fu-sell-summary-detail {
        display:flex; gap:10px; align-items:center; flex-wrap:wrap;
        font-size:12px; color:#5a3800;
      }
      .fu-sell-summary-detail .s-count { font-weight:700; }
      .fu-sell-summary-detail .s-value {
        display:inline-flex; align-items:center; gap:2px;
        font-weight:800; color:#8b4513;
      }
      .fu-sell-summary-detail .s-balance {
        font-size:11px; color:#5a3800; opacity:0.75;
        display:inline-flex; align-items:center; gap:2px;
      }
      .fu-sell-summary-actions { display:flex; gap:6px; align-items:center; flex-shrink:0; }

      .fu-sell-clear-btn {
        padding:4px 10px; border-radius:16px; font-size:11px; font-weight:700;
        cursor:pointer; border:1px solid rgba(184,153,64,0.5);
        background:rgba(184,153,64,0.15); color:#5a3800;
        transition:background 0.1s;
      }
      .fu-sell-clear-btn:hover { background:rgba(184,153,64,0.3); }

      .fu-sell-action-btn {
        padding:6px 16px; border-radius:20px; font-size:12px; font-weight:700;
        cursor:pointer; white-space:nowrap;
        border:1px solid #5a6a8a; background:#7a8aba; color:#fff;
        text-shadow:0 1px 0 rgba(0,0,0,0.25);
        transition:background 0.12s, transform 0.08s;
      }
      .fu-sell-action-btn:hover:not(:disabled) { background:#5a6a9a; }
      .fu-sell-action-btn:active:not(:disabled) { transform:scale(0.96); }
      .fu-sell-action-btn:disabled {
        opacity:0.38; cursor:default;
        background:#c8b89a; border-color:#a89870; color:#6b4c2a; text-shadow:none;
      }

      /* ── Hover tooltip ── */
      .fu-sell-tip {
        position:fixed; z-index:100000; max-width:280px;
        padding:8px 10px; border-radius:10px;
        border:1px solid rgba(0,0,0,0.25);
        background:rgba(20,15,5,0.93); color:#ffeebb;
        box-shadow:0 10px 25px rgba(0,0,0,0.35);
        display:none; pointer-events:none; font-size:12px; line-height:1.4;
      }
      .fu-sell-tip .tip-name  { font-weight:800; margin-bottom:4px; font-size:13px; }
      .fu-sell-tip .tip-price { margin-bottom:4px; font-size:11px; opacity:0.85;
                                display:flex; align-items:center; gap:3px; }
      .fu-sell-tip .tip-desc  { font-size:11px; opacity:0.9; }
    </style>`);
  }

  // ──────────────────────────────────────────────────────────────
  // HTML builders
  // ──────────────────────────────────────────────────────────────

  static _buildCategoryTabs(items, activeCat) {
    return SELL_CATEGORIES.map(c => {
      const count   = items.filter(it => this._itemType(it) === c.key).length;
      const isEmpty = count === 0;
      return `<button class="fu-sell-cat-tab${activeCat === c.key ? " active" : ""}"
                      data-cat="${c.key}" data-tooltip="${this._esc(c.label)}"
                      ${isEmpty ? "disabled" : ""}>${c.emoji}</button>`;
    }).join("");
  }

  static _buildGrid(items, selectedMap, sellMult) {
    if (!items.length) {
      return `<div class="fu-sell-empty">No items in this category.</div>`;
    }

    const slots = items.map(item => {
      const uuid      = item.uuid ?? item.id;
      const maxQty    = this._itemQty(item);
      const selected  = selectedMap.get(uuid);
      const sellQty   = selected?.qty ?? 0;
      const isSelected = sellQty > 0;
      const price     = this._sellPrice(item, sellMult);
      const desc      = this._itemDesc(item);

      const qtyBadge = isSelected
        ? `<div class="fu-sell-qty-badge">${sellQty}/${maxQty}</div>`
        : maxQty > 1
          ? `<div class="fu-sell-qty-badge">×${maxQty}</div>`
          : "";

      return `
        <div class="fu-sell-slot${isSelected ? " fu-sell-selected" : ""}"
             draggable="true"
             data-item-uuid="${this._esc(uuid)}"
             data-item-name="${this._esc(item.name)}"
             data-item-desc="${this._esc(desc)}"
             data-item-price="${price}"
             data-item-qty="${maxQty}">
          <div class="fu-sell-checkmark">✓</div>
          <img src="${this._esc(item.img || "icons/svg/item-bag.svg")}" alt="">
          ${qtyBadge}
        </div>`;
    }).join("");

    return `<div class="fu-sell-grid">${slots}</div>`;
  }

  static _buildSummary(selectedMap, sellerZenit) {
    const count = selectedMap.size;
    let totalValue = 0;
    for (const entry of selectedMap.values()) totalValue += entry.sellPrice * entry.qty;

    const afterZenit = sellerZenit + totalValue;

    const countStr  = count === 0 ? "No items selected" : `${count} item${count > 1 ? "s" : ""} selected`;
    const valueHtml = count > 0 ? `<span class="s-value">${GP_ICON}${totalValue.toLocaleString()}</span>` : "";
    const balHtml   = count > 0
      ? `<span class="s-balance">Your balance: ${GP_ICON}${sellerZenit.toLocaleString()} → ${GP_ICON}${afterZenit.toLocaleString()}</span>`
      : "";

    const clearHtml = count > 0 ? `<button class="fu-sell-clear-btn" data-action="clear-all">Clear</button>` : "";
    const btnHtml   = count > 0 ? `Sell ${count} (${GP_ICON}${totalValue.toLocaleString()})` : "Sell Selected";

    return `
      <div class="fu-sell-summary">
        <div class="fu-sell-summary-row">
          <div class="fu-sell-summary-detail">
            <span class="s-count">${countStr}</span>${valueHtml}${balHtml}
          </div>
          <div class="fu-sell-summary-actions">
            ${clearHtml}
            <button class="fu-sell-action-btn" data-action="sell-selected" ${count === 0 ? "disabled" : ""}>
              ${btnHtml}
            </button>
          </div>
        </div>
      </div>`;
  }

  static _buildHTML({ portrait, shopTitle, sellerActor, warehouseActor, activeTab, activeCategory,
                      actorItems, warehouseItems, selectedMap, sellMult }) {

    const sellerZenit    = Math.max(0, Number(sellerActor?.system?.props?.zenit ?? 0));
    const warehouseZenit = Math.max(0, Number(warehouseActor?.system?.props?.zenit ?? 0));
    const hasWarehouse   = !!warehouseActor;

    const currentItems  = activeTab === "warehouse" ? warehouseItems : actorItems;
    const activeCat     = activeCategory[activeTab] ?? SELL_CATEGORIES[0].key;
    const filteredItems = currentItems.filter(it => this._itemType(it) === activeCat);

    const catTabs = this._buildCategoryTabs(currentItems, activeCat);
    const grid    = this._buildGrid(filteredItems, selectedMap, sellMult);
    const summary = this._buildSummary(selectedMap, sellerZenit);

    // Preview: only when exactly 1 item is selected
    let previewHTML = `<div class="fu-preview-placeholder">Select a single item to preview its stats</div>`;
    let skillsHTML  = "";
    if (selectedMap.size === 1) {
      const entry = [...selectedMap.values()][0];
      previewHTML = ShopWindowApp._buildPreviewContent(entry.item);
      skillsHTML  = ShopWindowApp._buildSkillsContent(entry.item) ?? "";
    }

    return `
      <div class="fu-sell">
        ${this._css()}

        <div class="fu-sell-header">
          <img class="fu-sell-portrait" src="${this._esc(portrait)}" alt="">
          <div class="fu-sell-header-info">
            <div class="fu-sell-header-name">${this._esc(shopTitle)} — Sell Items</div>
            <div class="fu-sell-header-sub">Sell rate: ${Math.round(sellMult * 100)}% of base price</div>
            <div class="fu-sell-zenit-row">
              Your Zenit: <span class="zv">${GP_ICON}${sellerZenit.toLocaleString()}</span>
              ${hasWarehouse ? `&nbsp;|&nbsp; Warehouse: <span class="zv">${GP_ICON}${warehouseZenit.toLocaleString()}</span>` : ""}
            </div>
          </div>
        </div>

        <div class="fu-sell-src-tabs">
          <div class="fu-sell-src-tab${activeTab === "actor" ? " active" : ""}" data-src-tab="actor">
            📦 ${this._esc(sellerActor?.name ?? "Inventory")}
          </div>
          <div class="fu-sell-src-tab${activeTab === "warehouse" ? " active" : ""}${hasWarehouse ? "" : " disabled"}"
               data-src-tab="warehouse">
            🏪 Warehouse
          </div>
        </div>

        <div class="fu-sell-body">
          <div class="fu-sell-cat-tabs">${catTabs}</div>
          <div class="fu-sell-content">
            <div class="fu-sell-grid-wrap">${grid}</div>
            <div class="fu-sell-dropzone" id="fu-sell-dropzone">
              ⬇ Drop an item here to sell it immediately
            </div>
          </div>
        </div>

        <div class="fu-sell-preview">${previewHTML}</div>
        ${skillsHTML ? `<div class="fu-sell-skills-panel has-skills">${skillsHTML}</div>` : ""}

        ${summary}

        <div class="fu-sell-tip" id="fu-sell-tip">
          <div class="tip-name"></div>
          <div class="tip-price"></div>
          <div class="tip-desc"></div>
        </div>
      </div>`;
  }

  // ──────────────────────────────────────────────────────────────
  // Sell confirmation dialog
  // ──────────────────────────────────────────────────────────────

  static async _confirmSale(items, sellerZenit) {
    const totalEarned = items.reduce((s, it) => s + (it.sellPrice * it.qty), 0);
    const afterZenit  = sellerZenit + totalEarned;

    const rows = items.map(it => {
      const lineValue = it.sellPrice * it.qty;
      const priceHtml = lineValue > 0 ? `${GP_ICON}${lineValue.toLocaleString()}` : `<em style="opacity:0.55">0</em>`;
      return `<tr>
        <td style="padding:3px 8px;font-weight:700;color:#3a2408">${this._esc(it.name)}</td>
        <td style="padding:3px 8px;text-align:center;color:#6b4c2a">×${it.qty}</td>
        <td style="padding:3px 8px;text-align:right;font-weight:700;color:#8b4513">${priceHtml}</td>
      </tr>`;
    }).join("");

    return new Promise((resolve) => {
      new Dialog({
        title: "Confirm Sale",
        content: `
          <div style="font-family:inherit;color:#2c1f0e;padding:4px 0">
            <table style="width:100%;border-collapse:collapse;margin-bottom:10px">
              <thead>
                <tr style="border-bottom:2px solid #b89940;font-size:11px;color:#6b4c2a">
                  <th style="padding:3px 8px;text-align:left;font-weight:700">Item</th>
                  <th style="padding:3px 8px;text-align:center;font-weight:700">Qty</th>
                  <th style="padding:3px 8px;text-align:right;font-weight:700">Value</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
            <div style="border-top:2px solid #b89940;padding-top:8px;display:flex;justify-content:space-between;align-items:center">
              <span style="font-weight:800;color:#3a2408">Total earned</span>
              <span style="font-weight:800;color:#8b4513;display:flex;align-items:center;gap:2px">${GP_ICON}${totalEarned.toLocaleString()}</span>
            </div>
            <div style="margin-top:4px;font-size:11px;color:#6b4c2a;text-align:right">
              Your balance: ${GP_ICON}${sellerZenit.toLocaleString()} → ${GP_ICON}${afterZenit.toLocaleString()}
            </div>
          </div>`,
        buttons: {
          sell:   { icon: '<i class="fas fa-coins"></i>', label: "Sell",   callback: () => resolve(true)  },
          cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel", callback: () => resolve(false) },
        },
        default: "sell",
        close:   () => resolve(false),
      }, { width: 380 }).render(true);
    });
  }

  // ──────────────────────────────────────────────────────────────
  // Event binding
  // ──────────────────────────────────────────────────────────────

  static _bindRoot(root, ctx) {
    const snd = () => window.FUCompanion?.shopSound;

    // ── Source tab switching ──
    root.querySelectorAll(".fu-sell-src-tab:not(.disabled)").forEach(tab => {
      tab.addEventListener("click", () => {
        if (tab.classList.contains("active")) return;
        snd()?.playTabSwitch();
        const newTab = tab.dataset.srcTab;
        ctx.state.activeTab = newTab;
        // Auto-select first non-empty category for the new source
        const items = newTab === "warehouse" ? ctx.state.warehouseItems : ctx.state.actorItems;
        const catKey = ctx.state.activeCategory[newTab];
        const hasItems = items.some(it => ShopSellApp._itemType(it) === catKey);
        if (!hasItems) ctx.state.activeCategory[newTab] = ShopSellApp._autoCategory(items);
        ctx.redraw();
      });
    });

    // ── Category tab switching ──
    root.querySelectorAll(".fu-sell-cat-tab:not([disabled])").forEach(tab => {
      tab.addEventListener("click", () => {
        if (tab.classList.contains("active")) return;
        snd()?.playTabSwitch();
        ctx.state.activeCategory[ctx.state.activeTab] = tab.dataset.cat;
        ctx.redraw();
      });
    });

    // ── Grid item click → select / deselect ──
    root.querySelectorAll(".fu-sell-slot").forEach(slot => {
      slot.addEventListener("click", async (e) => {
        e.stopPropagation();
        await ctx.onSlotClick(slot.dataset.itemUuid);
      });

      // DnD: drag start
      slot.addEventListener("dragstart", (e) => {
        slot.classList.add("fu-sell-dragging");
        e.dataTransfer.setData("application/fu-sell", JSON.stringify({
          itemUuid:        slot.dataset.itemUuid,
          itemName:        slot.dataset.itemName,
          itemMaxQty:      Number(slot.dataset.itemQty),
          itemPrice:       Number(slot.dataset.itemPrice),
          sourceActorUuid: ctx.state.activeTab === "warehouse"
            ? ctx.warehouseActorUuid
            : ctx.sellerActorUuid,
        }));
        e.dataTransfer.effectAllowed = "move";
      });
      slot.addEventListener("dragend", () => slot.classList.remove("fu-sell-dragging"));
    });

    // ── Drop zone ──
    const dz = root.querySelector("#fu-sell-dropzone");
    if (dz) {
      dz.addEventListener("dragover", (e) => {
        if (!e.dataTransfer.types.includes("application/fu-sell")) return;
        e.preventDefault(); e.dataTransfer.dropEffect = "move";
        dz.classList.add("fu-drag-over");
      });
      dz.addEventListener("dragleave", () => dz.classList.remove("fu-drag-over"));
      dz.addEventListener("drop", async (e) => {
        e.preventDefault(); dz.classList.remove("fu-drag-over");
        const raw = e.dataTransfer.getData("application/fu-sell");
        if (!raw) return;
        try { await ctx.onDropSell(JSON.parse(raw)); } catch {}
      });
    }

    // ── Summary buttons ──
    root.querySelector("[data-action='sell-selected']")
      ?.addEventListener("click", async () => { await ctx.onSellSelected(); });
    root.querySelector("[data-action='clear-all']")
      ?.addEventListener("click", () => {
        ctx.state.selectedMap.clear();
        snd()?.playCancel();
        ctx.redraw();
      });

    // ── Tooltip ──
    this._bindTooltip(root);
  }

  static _bindTooltip(root) {
    const tip      = root.querySelector("#fu-sell-tip");
    const tipName  = tip?.querySelector(".tip-name");
    const tipPrice = tip?.querySelector(".tip-price");
    const tipDesc  = tip?.querySelector(".tip-desc");
    if (!tip) return;

    const moveTip = (ev) => {
      const pad  = 14;
      const rect = tip.getBoundingClientRect();
      let x = ev.clientX + pad, y = ev.clientY + pad;
      if (x + rect.width  > window.innerWidth  - 8) x = window.innerWidth  - rect.width  - 8;
      if (y + rect.height > window.innerHeight - 8) y = window.innerHeight - rect.height - 8;
      tip.style.left = `${x}px`; tip.style.top = `${y}px`;
    };
    const hideTip = () => { tip.style.display = "none"; };

    root.addEventListener("mouseenter", async (ev) => {
      const slot = ev.target.closest?.(".fu-sell-slot");
      if (!slot) return;
      if (tipName)  tipName.textContent = slot.dataset.itemName ?? "Item";
      const price = Number(slot.dataset.itemPrice ?? 0);
      if (tipPrice) {
        tipPrice.innerHTML = price > 0
          ? `Sell value: ${GP_ICON}${price.toLocaleString()} each`
          : `<em style="opacity:0.7">No sell value</em>`;
      }
      if (tipDesc) {
        const raw = slot.dataset.itemDesc ?? "";
        try {
          tipDesc.innerHTML = (await TextEditor.enrichHTML(raw, { async: true, secrets: false })) || "<em>No description.</em>";
        } catch { tipDesc.textContent = raw || "No description."; }
      }
      tip.style.display = "block"; moveTip(ev);
    }, true);

    root.addEventListener("mousemove", (ev) => { if (tip.style.display !== "none") moveTip(ev); }, true);
    root.addEventListener("mouseleave", (ev) => { if (ev.target.closest?.(".fu-sell-slot")) hideTip(); }, true);
    root.addEventListener("wheel",     hideTip, { passive: true });
    root.addEventListener("mousedown", (ev) => { if (!ev.target.closest?.(".fu-sell-slot")) hideTip(); });
  }

  // ──────────────────────────────────────────────────────────────
  // Open
  // ──────────────────────────────────────────────────────────────

  static async open(shopActorUuid, { sellerActorUuid } = {}) {
    const shopActor = await fromUuid(shopActorUuid).catch(() => null);
    if (!shopActor) { ui.notifications?.error?.("[ShopSell] Shop actor not found."); return null; }

    // Linked character is the zenit recipient — always prefer game.user.character
    const zenitActor = game.user.character ?? null;

    const sellerActor = sellerActorUuid
      ? (await fromUuid(sellerActorUuid).catch(() => null))
      : zenitActor;

    if (!sellerActor) {
      ui.notifications?.warn?.("Link a character to your account to sell items.");
      return null;
    }

    // Resolve warehouse (DB actor)
    let warehouseActor    = null;
    let warehouseActorUuid = null;
    try {
      const db = await window.FUCompanion?.api?.getCurrentGameDb?.();
      if (db?.db) { warehouseActor = db.db; warehouseActorUuid = db.dbUuid ?? warehouseActor.uuid; }
    } catch {}

    const portrait  = String(gp(shopActor, "system.props.shop_portrait", "") || shopActor.img || "icons/svg/mystery-man.svg").trim();
    const shopTitle = String(gp(shopActor, "system.props.shop_name", "") || shopActor.name);

    const actorItems     = this._getItems(sellerActor);
    const warehouseItems = warehouseActor ? this._getItems(warehouseActor) : [];

    const state = {
      activeTab:      "actor",
      activeCategory: {
        actor:     this._autoCategory(actorItems),
        warehouse: this._autoCategory(warehouseItems),
      },
      selectedMap:    new Map(), // uuid → { item, qty, sellPrice, sourceActorUuid }
      actorItems,
      warehouseItems,
      sellMult:        this._sellMult(sellerActor),
      sellerActorRef:  sellerActor,
      warehouseActorRef: warehouseActor,
      portrait,
      shopTitle,
    };

    // The actor who receives Zenit is always the linked player character
    const zenitActorUuid = (zenitActor ?? sellerActor).uuid;

    let dlg;

    const buildData = () => ({
      portrait:       state.portrait,
      shopTitle:      state.shopTitle,
      sellerActor:    state.sellerActorRef,
      warehouseActor: state.warehouseActorRef,
      activeTab:      state.activeTab,
      activeCategory: state.activeCategory,
      actorItems:     state.actorItems,
      warehouseItems: state.warehouseItems,
      selectedMap:    state.selectedMap,
      sellMult:       state.sellMult,
    });

    const ctx = {
      state,
      sellerActorUuid: sellerActor.uuid,
      warehouseActorUuid,

      redraw() {
        state.actorItems     = ShopSellApp._getItems(state.sellerActorRef);
        state.warehouseItems = ShopSellApp._getItems(state.warehouseActorRef);
        state.sellMult       = ShopSellApp._sellMult(state.sellerActorRef);

        const el = dlg?.element?.[0];
        if (!el) return;
        const oldRoot = el.querySelector(".fu-sell");
        if (!oldRoot) return;

        const tmp = document.createElement("div");
        tmp.innerHTML = ShopSellApp._buildHTML(buildData());
        const newRoot = tmp.querySelector(".fu-sell");
        if (!newRoot) return;
        oldRoot.replaceWith(newRoot);
        ShopSellApp._bindRoot(newRoot, this);
      },

      _pruneSelection() {
        const live = new Set([
          ...state.actorItems.map(it => it.uuid),
          ...state.warehouseItems.map(it => it.uuid),
        ]);
        for (const uuid of state.selectedMap.keys()) {
          if (!live.has(uuid)) state.selectedMap.delete(uuid);
        }
      },

      async onSlotClick(uuid) {
        const snd = () => window.FUCompanion?.shopSound;

        if (state.selectedMap.has(uuid)) {
          state.selectedMap.delete(uuid);
          snd()?.playItemSelect();
          this.redraw(); return;
        }

        const items = state.activeTab === "warehouse" ? state.warehouseItems : state.actorItems;
        const item  = items.find(it => it.uuid === uuid);
        if (!item) return;

        const maxQty = ShopSellApp._itemQty(item);
        let qty = 1;
        if (maxQty > 1) {
          const qtyUI = window["oni.ItemTransferQuantityUI"];
          if (qtyUI) {
            const picked = await qtyUI.promptQuantity({ itemName: item.name, maxQuantity: maxQty, defaultQuantity: 1 });
            if (picked == null) return;
            qty = picked;
          }
        }

        state.selectedMap.set(uuid, {
          item, qty,
          sellPrice: ShopSellApp._sellPrice(item, state.sellMult),
          sourceActorUuid: state.activeTab === "warehouse" ? warehouseActorUuid : sellerActor.uuid,
        });
        snd()?.playItemSelect();
        this.redraw();
      },

      async onDropSell({ itemUuid, itemName, itemMaxQty, itemPrice, sourceActorUuid }) {
        const snd = () => window.FUCompanion?.shopSound;

        let qty = 1;
        if (itemMaxQty > 1) {
          const qtyUI = window["oni.ItemTransferQuantityUI"];
          if (qtyUI) {
            const picked = await qtyUI.promptQuantity({ itemName, maxQuantity: itemMaxQty, defaultQuantity: 1 });
            if (picked == null) return;
            qty = picked;
          }
        }

        const sellerZenit = Math.max(0, Number(state.sellerActorRef?.system?.props?.zenit ?? 0));
        const confirmed   = await ShopSellApp._confirmSale([{ name: itemName, qty, sellPrice: itemPrice }], sellerZenit);
        if (!confirmed) { snd()?.playCancel(); return; }

        const handler = window.FUCompanion?.shopSell;
        if (!handler) { ui.notifications?.error?.("Sell system not available."); return; }

        const result = await handler.requestSell({
          shopActorUuid,
          sourceActorUuid,    // where the item lives
          zenitActorUuid,     // always the player character
          itemUuid, quantity: qty, requesterUserId: game.user.id,
        });

        if (result.ok) {
          snd()?.playPurchase();
          ui.notifications?.info?.(`Sold ×${result.quantity} ${itemName} for ${GP_ICON}${(result.totalEarned ?? 0).toLocaleString()} Zenit.`);
          this._pruneSelection(); this.redraw();
        } else {
          const MSGS = {
            item_not_found:        "Item no longer in inventory.",
            insufficient_stock:    `Only ${result.available ?? "?"} available.`,
            transfer_failed:       "Transfer failed — check the GM console.",
            transfer_core_missing: "Item transfer system not ready.",
            timeout:               "Request timed out — is the GM online?",
            server_error:          "A server error occurred.",
          };
          ui.notifications?.error?.(MSGS[result.reason] ?? `Sell failed (${result.reason ?? "unknown"}).`);
        }
      },

      async onSellSelected() {
        const selected = [...state.selectedMap.values()];
        if (!selected.length) return;

        const snd = () => window.FUCompanion?.shopSound;
        const sellerZenit = Math.max(0, Number(state.sellerActorRef?.system?.props?.zenit ?? 0));

        const confirmed = await ShopSellApp._confirmSale(
          selected.map(s => ({ name: s.item.name, qty: s.qty, sellPrice: s.sellPrice })),
          sellerZenit
        );
        if (!confirmed) { snd()?.playCancel(); return; }

        const handler = window.FUCompanion?.shopSell;
        if (!handler) { ui.notifications?.error?.("Sell system not available."); return; }

        let totalEarned = 0, anyFailed = false;

        for (const entry of selected) {
          const result = await handler.requestSell({
            shopActorUuid,
            sourceActorUuid:  entry.sourceActorUuid,
            zenitActorUuid,   // always the player character
            itemUuid:         entry.item.uuid ?? entry.item.id,
            quantity:         entry.qty,
            requesterUserId:  game.user.id,
          });

          if (result.ok) {
            totalEarned += result.totalEarned ?? 0;
          } else {
            anyFailed = true;
            const MSGS = {
              item_not_found:     "Item no longer available",
              insufficient_stock: `Only ${result.available ?? "?"} in stock`,
              transfer_failed:    "Transfer failed",
              timeout:            "Request timed out",
            };
            ui.notifications?.warn?.(`Could not sell ${entry.item.name}: ${MSGS[result.reason] ?? result.reason ?? "unknown"}.`);
          }
        }

        if (totalEarned > 0) {
          snd()?.playPurchase();
          ui.notifications?.info?.(`Sold items for ${GP_ICON}${totalEarned.toLocaleString()} Zenit total.`);
        }

        state.selectedMap.clear();
        this._pruneSelection();
        this.redraw();
      },
    };

    dlg = new Dialog(
      {
        title:   `Sell Items — ${shopTitle}`,
        content: ShopSellApp._buildHTML(buildData()),
        buttons: { close: { icon: '<i class="fas fa-door-open"></i>', label: "Close" } },
        default: "close",
        render: (html) => {
          const root = (html instanceof jQuery ? html[0] : html).querySelector?.(".fu-sell")
            ?? (html instanceof jQuery ? html[0] : html);
          ShopSellApp._bindRoot(root, ctx);
        },
        close: () => { window.FUCompanion?.shopSound?.playCancel(); },
      },
      { width: 500, height: "auto", resizable: true }
    );

    dlg.render(true);
    return dlg;
  }
}
