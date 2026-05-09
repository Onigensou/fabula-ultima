// scripts/shop-system/shopWindow-app.js
//
// JRPG shop window — styled to match the old beige NPC sheet aesthetic.
// Opens for non-GM users in place of the actor sheet.
//
// Fields used:
//   system.props.shop_portrait      — shopkeeper portrait (falls back to actor.img)
//   system.props.shop_name          — shop display title
//   system.props.quote              — greeting / speech bubble text
//   item.system.props.item_cost     — price in Zenit
//   item.system.props.item_quantity — stock count
//   item.system.props.item_type     — category key
//   item.system.props.description   — item mechanics/effect text (HTML-stripped)
//   item.system.props.category      — weapon sub-type (Sword, Arcane, Bow…)
//   item.system.props.type_damage   — damage type plain string (Physical, Fire…)

import { gp } from "./shopopen-const.js";

const GP_ICON = `<img class="fu-zenit-icon" src="https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/GP.png" alt="Zenit">`;

// Damage type name → color/glow mapping (names match the plain-text field values)
const DAMAGE_TYPES = {
  "physical": { label: "Physical", color: "#555555", shadow: "#999999" },
  "fire":     { label: "Fire",     color: "#e25822", shadow: "#ffae00" },
  "ice":      { label: "Ice",      color: "#5ab3d4", shadow: "#a6e3ff" },
  "air":      { label: "Air",      color: "#48c774", shadow: "#a8ffbb" },
  "earth":    { label: "Earth",    color: "#8b5e3c", shadow: "#d2b48c" },
  "bolt":     { label: "Bolt",     color: "#9b59b6", shadow: "#d7a9ff" },
  "light":    { label: "Light",    color: "#a38b50", shadow: "#cabd9a" },
  "dark":     { label: "Dark",     color: "#4b0082", shadow: "#b666d2" },
  "poison":   { label: "Poison",   color: "#2e8b57", shadow: "#66ff99" },
};

const SHOP_CATEGORIES = [
  { key: "weapon",     emoji: "⚔️",  label: "Weapon"     },
  { key: "armor",      emoji: "🥋",  label: "Armor"      },
  { key: "shield",     emoji: "🛡️",  label: "Shield"     },
  { key: "accessory",  emoji: "💍",  label: "Accessory"  },
  { key: "consumable", emoji: "🧪",  label: "Consumable" },
  { key: "recipe",     emoji: "📖",  label: "Recipe"     },
];

const _openWindows = new Map(); // actorUuid -> Dialog

export class ShopWindowApp {

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

  // Sanitize rich HTML: keep structural tags, strip inline styles/attrs,
  // convert content-links to plain <span class="fu-link">.
  static _sanitizeHTML(raw) {
    if (!raw) return "";
    const tmp = document.createElement("div");
    tmp.innerHTML = String(raw);
    const KEEP = new Set(["ul","ol","li","p","strong","em","b","i"]);
    function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent;
      if (node.nodeType !== Node.ELEMENT_NODE) return "";
      const tag = node.tagName.toLowerCase();
      const inner = Array.from(node.childNodes).map(walk).join("");
      if (tag === "br") return "<br>";
      if (tag === "hr") return `<hr class="fu-hr">`;
      if (tag === "a")  return `<span class="fu-link">${inner}</span>`;
      if (KEEP.has(tag)) return `<${tag}>${inner}</${tag}>`;
      return inner;
    }
    return Array.from(tmp.childNodes).map(walk).join("");
  }

  static _num(item, path, def = 0) { return Number(gp(item, path, def) ?? def) || def; }
  static _str(item, path, def = "") { return String(gp(item, path, def) ?? def).trim(); }

  static _itemType(item)  { return this._str(item, "system.props.item_type", "").toLowerCase(); }
  static _itemCost(item)  { return Math.max(0, this._num(item, "system.props.item_cost", 0)); }
  static _itemQty(item)   { return Math.max(0, this._num(item, "system.props.item_quantity", 0)); }
  // Plain-text snippet for item list rows (no HTML)
  static _itemDesc(item)  {
    const raw = gp(item, "system.props.description", "") || "";
    return this._stripHTML(String(raw));
  }

  static _parseDamageType(raw) {
    const name = this._stripHTML(String(raw ?? "")).trim();
    const entry = DAMAGE_TYPES[name.toLowerCase()];
    return entry ?? { label: name || "—", color: null, shadow: null };
  }

  // ──────────────────────────────────────────────────────────────
  // Stats preview builder — called when a row is clicked
  // ──────────────────────────────────────────────────────────────

  static _buildPreviewContent(item) {
    const type = this._itemType(item);
    const pills = [];

    if (type === "weapon") {
      const die1      = this._str(item, "system.props.rolled_atr1", "");
      const die2      = this._str(item, "system.props.rolled_atr2", "");
      const chkBonus  = this._num(item, "system.props.check_bonus", 0);
      const dmgBonus  = this._num(item, "system.props.damage_bonus", 0);
      const dmgTypeRaw = String(gp(item, "system.props.type_damage", "") ?? "");
      const dmgTypeInfo = this._parseDamageType(dmgTypeRaw);
      const category  = this._str(item, "system.props.category", "");

      if (die1 || die2) {
        const diceStr = [die1, die2].filter(Boolean).join(" + ");
        pills.push({ label: "Dice", value: diceStr });
      }
      if (chkBonus !== 0) pills.push({ label: "Accuracy", value: (chkBonus > 0 ? "+" : "") + chkBonus });
      if (dmgBonus !== 0) pills.push({ label: "Damage",   value: (dmgBonus > 0 ? "+" : "") + dmgBonus });
      if (dmgTypeInfo.label && dmgTypeInfo.label !== "—") {
        pills.push({ label: "Type", value: dmgTypeInfo.label, color: dmgTypeInfo.color, shadow: dmgTypeInfo.shadow });
      }
      if (category) pills.push({ label: "Weapon", value: category });

    } else if (type === "armor") {
      const isMartial = !!(gp(item, "system.props.isMartial", false) || gp(item, "system.props.item_isMartial", false));
      const defBonus  = this._num(item, "system.props.item_def_bonus",  0);
      const mdefBonus = this._num(item, "system.props.item_mdef_bonus", 0);

      if (isMartial) {
        const baseDef  = this._num(item, "system.props.item_baseDef",  0);
        const baseMdef = this._num(item, "system.props.item_baseMdef", 0);
        if (baseDef)  pills.push({ label: "Base DEF",  value: baseDef  });
        if (baseMdef) pills.push({ label: "Base MDEF", value: baseMdef });
      }
      if (defBonus  !== 0) pills.push({ label: "DEF Bonus",  value: (defBonus  > 0 ? "+" : "") + defBonus  });
      if (mdefBonus !== 0) pills.push({ label: "MDEF Bonus", value: (mdefBonus > 0 ? "+" : "") + mdefBonus });

    } else if (type === "shield" || type === "accessory") {
      const defBonus  = this._num(item, "system.props.item_def_bonus",  0);
      const mdefBonus = this._num(item, "system.props.item_mdef_bonus", 0);
      if (defBonus  !== 0) pills.push({ label: "DEF Bonus",  value: (defBonus  > 0 ? "+" : "") + defBonus  });
      if (mdefBonus !== 0) pills.push({ label: "MDEF Bonus", value: (mdefBonus > 0 ? "+" : "") + mdefBonus });
    }

    let html = `
      <div class="fu-preview-header">
        <div class="fu-preview-icon-wrap">
          <img class="fu-preview-icon" src="${this._esc(item.img || "icons/svg/item-bag.svg")}" alt="">
        </div>
        <span class="fu-preview-name">${this._esc(item.name)}</span>
      </div>`;

    if (pills.length > 0) {
      html += `<div class="fu-preview-pills">`;
      for (const p of pills) {
        const valStyle = p.color
          ? `style="color:${p.color}; text-shadow:0 0 5px ${p.shadow ?? p.color}; font-weight:800;"`
          : "";
        html += `<div class="fu-preview-pill">
          <span class="fu-pill-label">${this._esc(String(p.label))}</span>
          <span class="fu-pill-value" ${valStyle}>${this._esc(String(p.value))}</span>
        </div>`;
      }
      html += `</div>`;
    }

    const descRaw = String(gp(item, "system.props.description", "") ?? "");
    const descHTML = this._sanitizeHTML(descRaw);
    if (descHTML.trim()) {
      html += `<div class="fu-preview-desc">${descHTML}</div>`;
    } else if (!pills.length) {
      html += `<div class="fu-preview-empty">No stat data available.</div>`;
    }

    return html;
  }

  // ──────────────────────────────────────────────────────────────
  // Active skills panel — called when a row is clicked
  // ──────────────────────────────────────────────────────────────

  static _buildSkillsContent(item) {
    const skillsObj  = gp(item, "system.props.item_skill_active",  null) ?? {};
    const relatedObj = gp(item, "system.props.related_item_list",  null) ?? {};

    // Deduplicate by name (a skill can appear under multiple level-keys)
    const seen    = new Set();
    const entries = [];
    for (const [key, skill] of Object.entries(skillsObj)) {
      if (!skill?.name) continue;
      if (seen.has(skill.name)) continue;
      seen.add(skill.name);
      const descRaw = relatedObj[key]?.related_item_description ?? "";
      entries.push({ name: skill.name, descHTML: this._sanitizeHTML(descRaw) });
    }

    if (!entries.length) return null;

    let html = `<div class="fu-skills-label">Active Skills</div>`;
    for (const e of entries) {
      html += `<div class="fu-skill-entry">
        <div class="fu-skill-name">✨ ${this._esc(e.name)}</div>
        ${e.descHTML ? `<div class="fu-skill-desc">${e.descHTML}</div>` : ""}
      </div>`;
    }
    return html;
  }

  // ──────────────────────────────────────────────────────────────
  // CSS (inline, matches beige/parchment NPC sheet look)
  // ──────────────────────────────────────────────────────────────

  static _css() {
    return `<style id="fu-shop-style">
      /* ── Root ── */
      .fu-shop { display:flex; flex-direction:column; gap:0;
                 background:#f0e6cc; color:#2c1f0e; font-family:inherit; }

      .fu-zenit-icon { width:20px; height:20px; object-fit:contain;
                       vertical-align:middle; margin-right:2px;
                       border:none !important; box-shadow:none !important;
                       border-radius:0; background:transparent; }

      /* ── Header: portrait + shop name + quote + zenit ── */
      .fu-shop-header {
        display:flex; gap:10px; align-items:flex-start;
        padding:10px 12px;
        background:linear-gradient(to bottom, #e8d5a3, #dfc890);
        border-bottom:2px solid #b89940;
        flex-shrink:0;
      }
      .fu-shop-portrait {
        width:72px; height:72px; border-radius:8px; object-fit:cover;
        border:2px solid #b89940; flex-shrink:0; background:#c8a84b;
      }
      .fu-shop-header-info { display:flex; flex-direction:column; gap:4px; flex:1; min-width:0; }
      .fu-shop-header-name {
        font-size:15px; font-weight:800; color:#5a3800;
        text-shadow:0 1px 0 rgba(255,255,255,0.4);
        white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
      }
      .fu-shop-quote {
        font-size:12px; font-style:italic; color:#5a3800; opacity:0.85;
        border-left:3px solid #b89940;
        background:rgba(255,255,255,0.3); border-radius:0 6px 6px 0;
        padding:4px 8px; line-height:1.4;
      }
      .fu-shop-zenit-bar {
        display:flex; align-items:center; gap:4px; margin-top:auto;
        font-size:12px; font-weight:700; color:#5a3800;
      }
      .fu-shop-zenit-bar .zv { color:#8b4513; display:flex; align-items:center; gap:3px; }

      /* ── Main body: vertical tabs (left) + item list (right) ── */
      .fu-shop-body { display:flex; flex-shrink:0; }

      /* ── Vertical tabs ── */
      .fu-shop-tabs {
        display:flex; flex-direction:column; gap:2px;
        padding:8px 4px;
        background:#e0c87a;
        border-right:2px solid #b89940;
        min-width:40px; flex-shrink:0;
      }
      .fu-shop-tab {
        width:36px; height:36px; border-radius:8px;
        display:flex; align-items:center; justify-content:center;
        font-size:18px; cursor:pointer;
        border:1px solid transparent;
        background:transparent;
        transition:background 0.12s, border-color 0.12s;
        position:relative; flex-shrink:0;
      }
      .fu-shop-tab:hover { background:rgba(139,105,20,0.18); border-color:rgba(139,105,20,0.35); }
      .fu-shop-tab.active {
        background:#c8a84b; border-color:#8b6914;
        box-shadow:inset 0 1px 2px rgba(0,0,0,0.25);
      }
      .fu-shop-tab::after {
        content: attr(data-tooltip);
        position:absolute; left:calc(100% + 6px); top:50%;
        transform:translateY(-50%);
        background:rgba(30,20,10,0.92); color:#ffeebb;
        font-size:11px; font-weight:700; white-space:nowrap;
        padding:3px 8px; border-radius:6px;
        pointer-events:none; opacity:0; transition:opacity 0.15s;
        z-index:9999;
      }
      .fu-shop-tab:hover::after { opacity:1; }

      /* ── Item list panel ── */
      .fu-shop-panels { flex:1; overflow:hidden; display:flex; flex-direction:column; min-width:0; }
      .fu-shop-panel { display:none; flex-direction:column; }
      .fu-shop-panel.active { display:flex; }

      .fu-shop-list {
        overflow-y:auto; padding:6px 8px;
        display:flex; flex-direction:column; gap:4px;
        max-height:260px; min-height:80px;
      }
      .fu-shop-list::-webkit-scrollbar { width:5px; }
      .fu-shop-list::-webkit-scrollbar-track { background:rgba(0,0,0,0.06); }
      .fu-shop-list::-webkit-scrollbar-thumb { background:#b89940; border-radius:3px; }

      /* ── Item row ── */
      .fu-shop-row {
        display:grid;
        grid-template-columns: 36px 1fr auto auto auto;
        align-items:center; gap:8px;
        padding:6px 8px; border-radius:8px;
        background:rgba(255,255,255,0.55);
        border:1px solid rgba(184,153,64,0.35);
        transition:background 0.1s, border-color 0.1s;
        cursor:pointer;
      }
      .fu-shop-row:hover { background:rgba(255,255,255,0.80); }
      .fu-shop-row.fu-selected {
        background:rgba(200,168,75,0.28);
        border-color:#b89940;
        outline:1px solid rgba(184,153,64,0.6);
      }
      .fu-shop-row.sold-out { opacity:0.45; }
      .fu-shop-row-inner { display:flex; flex-direction:column; gap:2px; min-width:0; }

      /* ── Item icon with overflow protection ── */
      .fu-shop-icon-wrap {
        width:34px; height:34px; border-radius:6px;
        border:1px solid rgba(184,153,64,0.5); background:#e8d5a3;
        flex-shrink:0; overflow:hidden;
        display:flex; align-items:center; justify-content:center;
      }
      .fu-shop-icon { width:100%; height:100%; object-fit:contain; display:block; }

      .fu-shop-item-name {
        font-size:13px; font-weight:700; color:#3a2408;
        white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
      }
      .fu-shop-item-desc {
        font-size:11px; color:#6b4c2a; opacity:0.85;
        display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical;
        overflow:hidden; line-height:1.35;
      }
      .fu-shop-cost {
        font-size:12px; font-weight:700; color:#8b4513;
        white-space:nowrap; text-align:right; min-width:60px;
        display:flex; align-items:center; justify-content:flex-end; gap:3px;
      }
      .fu-shop-cost.free { color:#3a7a3a; }
      .fu-shop-stock {
        font-size:11px; color:#6b4c2a; white-space:nowrap;
        text-align:center; min-width:36px;
      }

      /* ── Buy button ── */
      .fu-shop-buy {
        padding:4px 12px; border-radius:20px; font-size:12px; font-weight:700;
        cursor:pointer; white-space:nowrap; min-width:46px;
        border:1px solid #5a8a5a; background:#7ab87a; color:#fff;
        text-shadow:0 1px 0 rgba(0,0,0,0.25);
        transition:background 0.12s, transform 0.08s;
      }
      .fu-shop-buy:hover:not(:disabled)  { background:#5a9a5a; }
      .fu-shop-buy:active:not(:disabled) { transform:scale(0.96); }
      .fu-shop-buy:disabled {
        opacity:0.38; cursor:default;
        background:#c8b89a; border-color:#a89870; color:#6b4c2a;
        text-shadow:none;
      }

      /* ── Empty state ── */
      .fu-shop-empty {
        text-align:center; padding:28px; font-style:italic;
        font-size:13px; color:#6b4c2a; opacity:0.6;
      }

      /* ── Stats preview panel ── */
      .fu-shop-preview {
        min-height:110px; max-height:140px;
        overflow-y:auto; padding:8px 10px;
        background:rgba(255,255,255,0.35);
        border-top:2px solid #b89940;
        flex-shrink:0;
      }
      .fu-shop-preview::-webkit-scrollbar { width:4px; }
      .fu-shop-preview::-webkit-scrollbar-thumb { background:#b89940; border-radius:3px; }
      .fu-preview-placeholder {
        font-size:12px; font-style:italic; color:#6b4c2a; opacity:0.55;
        text-align:center; padding:28px 0;
      }
      .fu-preview-header {
        display:flex; align-items:center; gap:8px; margin-bottom:6px;
      }
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
      .fu-preview-pills {
        display:flex; flex-wrap:wrap; gap:5px; margin-bottom:6px;
      }
      .fu-preview-pill {
        display:flex; align-items:center; gap:0;
        border-radius:20px; overflow:hidden;
        border:1px solid rgba(184,153,64,0.6); font-size:11px;
      }
      .fu-pill-label {
        background:#d4b04a; color:#3a2408; font-weight:700;
        padding:2px 7px;
      }
      .fu-pill-value {
        background:rgba(255,255,255,0.7); color:#5a3800; font-weight:700;
        padding:2px 7px;
      }
      .fu-preview-desc {
        font-size:11px; color:#5a3800; line-height:1.5;
      }
      .fu-preview-desc ul, .fu-preview-desc ol { margin:3px 0 3px 16px; padding:0; }
      .fu-preview-desc li { margin:2px 0; }
      .fu-preview-desc p  { margin:2px 0; }
      .fu-preview-desc .fu-hr { border:none; border-top:1px solid rgba(184,153,64,0.35); margin:4px 0; }
      .fu-preview-desc .fu-link { font-weight:700; color:#3a2408; }
      .fu-preview-empty {
        font-size:11px; font-style:italic; color:#6b4c2a; opacity:0.55;
      }

      /* ── Active Skills panel ── */
      .fu-shop-skills {
        overflow-y:auto; padding:8px 10px;
        background:rgba(248,238,210,0.7);
        border-top:2px solid #b89940;
        flex-shrink:0;
        display:none;
        max-height:180px;
      }
      .fu-shop-skills.has-skills { display:block; }
      .fu-shop-skills::-webkit-scrollbar { width:4px; }
      .fu-shop-skills::-webkit-scrollbar-thumb { background:#b89940; border-radius:3px; }
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
      .fu-skill-name {
        font-size:12px; font-weight:800; color:#3a2408; margin-bottom:4px;
      }
      .fu-skill-desc {
        font-size:11px; color:#5a3800; line-height:1.45;
      }
      .fu-skill-desc ul, .fu-skill-desc ol { margin:2px 0 2px 14px; padding:0; }
      .fu-skill-desc li { margin:1px 0; }
      .fu-skill-desc p  { margin:2px 0; }
      .fu-skill-desc strong { font-weight:700; }
      .fu-skill-desc .fu-link { font-weight:700; color:#3a2408; }
    </style>`;
  }

  // ──────────────────────────────────────────────────────────────
  // HTML builders
  // ──────────────────────────────────────────────────────────────

  static _buildRow(item, buyerZenit, hasBuyer) {
    const cost       = this._itemCost(item);
    const qty        = this._itemQty(item);
    const desc       = this._itemDesc(item);
    const outOfStock = qty <= 0;
    const cantAfford = !outOfStock && hasBuyer && cost > 0 && Number.isFinite(buyerZenit) && buyerZenit < cost;
    const disabled   = outOfStock || cantAfford || !hasBuyer;

    const tip = outOfStock ? "Out of stock" : cantAfford ? "Not enough Zenit" : !hasBuyer ? "No linked character" : "";
    const costHtml = cost > 0
      ? `<span class="fu-shop-cost">${GP_ICON}${cost.toLocaleString()}</span>`
      : `<span class="fu-shop-cost free">Free</span>`;
    const stockHtml = outOfStock
      ? `<span class="fu-shop-stock" style="color:#8b4513">Sold Out</span>`
      : `<span class="fu-shop-stock">×${qty}</span>`;
    const btnLabel = outOfStock ? "—" : cantAfford ? "💸" : "Buy";

    return `
      <div class="fu-shop-row${outOfStock ? " sold-out" : ""}"
           data-item-uuid="${this._esc(item.uuid)}"
           data-item-name="${this._esc(item.name)}"
           data-item-cost="${cost}"
           data-item-qty="${qty}">
        <div class="fu-shop-icon-wrap">
          <img class="fu-shop-icon" src="${this._esc(item.img || "icons/svg/item-bag.svg")}" alt="">
        </div>
        <div class="fu-shop-row-inner">
          <span class="fu-shop-item-name">${this._esc(item.name)}</span>
          ${desc ? `<span class="fu-shop-item-desc">${this._esc(desc)}</span>` : ""}
        </div>
        ${costHtml}
        ${stockHtml}
        <button class="fu-shop-buy" ${disabled ? "disabled" : ""} title="${this._esc(tip)}"
                data-action="buy" data-item-uuid="${this._esc(item.uuid)}">${btnLabel}</button>
      </div>`;
  }

  static _buildHTML({ portrait, shopTitle, quote, buyerZenit, hasBuyer, itemsByCategory, activeTab }) {
    // Tabs
    const tabs = SHOP_CATEGORIES.map(c => {
      const cnt = (itemsByCategory[c.key] ?? []).length;
      const badge = cnt > 0
        ? `<span style="position:absolute;top:-3px;right:-3px;background:#8b4513;color:#fff;font-size:9px;border-radius:999px;padding:0 4px;min-width:14px;text-align:center;line-height:14px;">${cnt}</span>`
        : "";
      return `<div class="fu-shop-tab${activeTab === c.key ? " active" : ""}"
                   data-tab="${c.key}" data-tooltip="${this._esc(c.label)}"
                   title="${this._esc(c.label)}">${c.emoji}${badge}</div>`;
    }).join("");

    // Panels
    const panels = SHOP_CATEGORIES.map(c => {
      const items = itemsByCategory[c.key] ?? [];
      const rows = items.length
        ? items.map(it => this._buildRow(it, buyerZenit, hasBuyer)).join("")
        : `<div class="fu-shop-empty">Nothing in stock.</div>`;
      return `<div class="fu-shop-panel${activeTab === c.key ? " active" : ""}" data-panel="${c.key}">
                <div class="fu-shop-list">${rows}</div>
              </div>`;
    }).join("");

    const zenitStr = hasBuyer && Number.isFinite(buyerZenit)
      ? `Your Zenit: <span class="zv">${GP_ICON}${buyerZenit.toLocaleString()}</span>`
      : `<span style="opacity:0.6">Link a character to your user to shop</span>`;

    const quoteLine = quote ? `<div class="fu-shop-quote">"${this._esc(quote)}"</div>` : "";

    return `
      <div class="fu-shop">
        ${this._css()}

        <div class="fu-shop-header">
          <img class="fu-shop-portrait" src="${this._esc(portrait || "icons/svg/mystery-man.svg")}" alt="">
          <div class="fu-shop-header-info">
            <div class="fu-shop-header-name">${this._esc(shopTitle)}</div>
            ${quoteLine}
            <div class="fu-shop-zenit-bar">${zenitStr}</div>
          </div>
        </div>

        <div class="fu-shop-body">
          <div class="fu-shop-tabs">${tabs}</div>
          <div class="fu-shop-panels">${panels}</div>
        </div>

        <div class="fu-shop-preview" id="fu-shop-preview">
          <div class="fu-preview-placeholder">← Click an item to see its stats</div>
        </div>

        <div class="fu-shop-skills" id="fu-shop-skills"></div>
      </div>`;
  }

  // ──────────────────────────────────────────────────────────────
  // Bind events to a root element
  // ──────────────────────────────────────────────────────────────

  static _bindRoot(root, ctx) {
    // Tab switching
    root.querySelectorAll(".fu-shop-tab").forEach(btn => {
      btn.addEventListener("click", () => {
        ctx.state.activeTab = btn.dataset.tab;
        root.querySelectorAll(".fu-shop-tab").forEach(b =>
          b.classList.toggle("active", b.dataset.tab === ctx.state.activeTab));
        root.querySelectorAll(".fu-shop-panel").forEach(p =>
          p.classList.toggle("active", p.dataset.panel === ctx.state.activeTab));
      });
    });

    // Buy buttons
    root.querySelectorAll("[data-action='buy']:not([disabled])").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation(); // don't also fire row-click
        ctx.onBuy(btn);
      });
    });

    // Row click → stats preview + active skills
    root.querySelectorAll(".fu-shop-row").forEach(row => {
      row.addEventListener("click", (e) => {
        if (e.target.closest("[data-action='buy']")) return;
        root.querySelectorAll(".fu-shop-row").forEach(r => r.classList.toggle("fu-selected", r === row));

        const preview = root.querySelector(".fu-shop-preview");
        if (preview) preview.innerHTML = ctx.getPreviewHTML(row.dataset.itemUuid);

        const skills = root.querySelector(".fu-shop-skills");
        if (skills) {
          const skillsHTML = ctx.getSkillsHTML(row.dataset.itemUuid);
          if (skillsHTML) {
            skills.innerHTML = skillsHTML;
            skills.classList.add("has-skills");
          } else {
            skills.innerHTML = "";
            skills.classList.remove("has-skills");
          }
        }
      });
    });
  }

  // ──────────────────────────────────────────────────────────────
  // Open
  // ──────────────────────────────────────────────────────────────

  static async open(shopActorUuid, { onClose } = {}) {
    // Deduplicate
    const existing = _openWindows.get(shopActorUuid);
    if (existing) { try { existing.bringToTop?.(); } catch {} return existing; }

    const actor = await fromUuid(shopActorUuid);
    if (!actor) { ui.notifications?.error?.("[ShopWindow] Shop actor not found."); return null; }

    const buyerActor = game.user.character ?? null;
    const hasBuyer   = !!buyerActor;

    // Snapshot helpers
    const readItems = () => {
      const byCat = Object.fromEntries(SHOP_CATEGORIES.map(c => [c.key, []]));
      for (const item of actor.items.contents) {
        const t = ShopWindowApp._itemType(item);
        if (byCat[t]) byCat[t].push(item);
      }
      return byCat;
    };
    const readZenit = () => hasBuyer ? Math.max(0, Number(buyerActor.system?.props?.zenit ?? 0)) : 0;

    const state = {
      activeTab:       null,
      itemsByCategory: readItems(),
      buyerZenit:      readZenit(),
    };

    // Auto-pick first non-empty category
    state.activeTab = SHOP_CATEGORIES.find(c => (state.itemsByCategory[c.key] ?? []).length > 0)?.key ?? SHOP_CATEGORIES[0].key;

    // Shop identity — portrait from shop_portrait field, fall back to actor.img
    const rawPortrait = gp(actor, "system.props.shop_portrait", "") || actor.img || "icons/svg/mystery-man.svg";
    const portrait    = String(rawPortrait).trim() || "icons/svg/mystery-man.svg";
    const shopTitle   = String(gp(actor, "system.props.shop_name", "") || actor.name);
    const quoteRaw    = String(gp(actor, "system.props.quote", "") ?? "");
    const quote       = ShopWindowApp._stripHTML(quoteRaw);

    let dlg;

    const buildData = () => ({
      portrait, shopTitle, quote,
      buyerZenit: state.buyerZenit,
      hasBuyer,
      itemsByCategory: state.itemsByCategory,
      activeTab: state.activeTab,
    });

    const redraw = async () => {
      state.itemsByCategory = readItems();
      state.buyerZenit      = readZenit();

      const dialogEl = dlg?.element?.[0];
      if (!dialogEl) return;
      const oldRoot = dialogEl.querySelector(".fu-shop");
      if (!oldRoot) return;

      const tmp = document.createElement("div");
      tmp.innerHTML = ShopWindowApp._buildHTML(buildData());
      const newRoot = tmp.querySelector(".fu-shop");
      if (!newRoot) return;

      oldRoot.replaceWith(newRoot);
      ShopWindowApp._bindRoot(newRoot, ctx);
    };

    const ctx = {
      state,
      getPreviewHTML: (uuid) => {
        const item = actor.items.find(i => i.uuid === uuid);
        return item ? ShopWindowApp._buildPreviewContent(item) : `<div class="fu-preview-placeholder">← Click an item to see its stats</div>`;
      },
      getSkillsHTML: (uuid) => {
        const item = actor.items.find(i => i.uuid === uuid);
        return item ? ShopWindowApp._buildSkillsContent(item) : null;
      },
      onBuy: async (btn) => {
        const row = btn.closest(".fu-shop-row");
        if (!row) return;

        const itemUuid = row.dataset.itemUuid;
        const itemName = row.dataset.itemName ?? "Item";
        const itemQty  = Number(row.dataset.itemQty ?? 1);
        const itemCost = Number(row.dataset.itemCost ?? 0);

        if (!hasBuyer) {
          ui.notifications?.warn?.("Link a character to your user account to purchase items.");
          return;
        }

        // Quantity prompt for stackable items
        let quantity = 1;
        if (itemQty > 1) {
          const qtyUI = window["oni.ItemTransferQuantityUI"];
          if (qtyUI) {
            const picked = await qtyUI.promptQuantity({ itemName, maxQuantity: itemQty, defaultQuantity: 1 });
            if (picked == null) return; // cancelled
            quantity = picked;
          }
        }

        const total = itemCost * quantity;
        if (total > 0 && state.buyerZenit < total) {
          ui.notifications?.warn?.(`Not enough Zenit — need 🪙 ${total.toLocaleString()}, have 🪙 ${state.buyerZenit.toLocaleString()}.`);
          return;
        }

        const orig = btn.textContent;
        btn.disabled = true;
        btn.textContent = "…";

        const handler = window.FUCompanion?.shopPurchase;
        if (!handler) {
          ui.notifications?.error?.("Shop purchase system not available.");
          btn.disabled = false; btn.textContent = orig; return;
        }

        const result = await handler.requestPurchase({
          shopActorUuid,
          itemUuid,
          quantity,
          buyerActorUuid:  buyerActor.uuid,
          requesterUserId: game.user.id,
        });

        if (result.ok) {
          const costStr = result.totalCost > 0 ? ` for 🪙 ${result.totalCost.toLocaleString()}` : "";
          ui.notifications?.info?.(`Purchased ×${result.quantity} ${itemName}${costStr}.`);
          await new Promise(r => setTimeout(r, 180)); // let Foundry sync actor data
          await redraw();
        } else {
          const MSGS = {
            out_of_stock:          "This item is out of stock.",
            insufficient_stock:    `Only ${result.available ?? "?"} in stock — try a smaller quantity.`,
            insufficient_funds:    `Not enough Zenit — need 🪙 ${(result.needed ?? 0).toLocaleString()}, have 🪙 ${(result.have ?? 0).toLocaleString()}.`,
            buyer_not_found:       "Your character could not be resolved.",
            shop_not_found:        "The shop could not be found.",
            item_not_found:        "Item no longer available in this shop.",
            transfer_failed:       "Item transfer failed — ask the GM to check the console.",
            transfer_core_missing: "Item transfer system not ready yet.",
            timeout:               "Purchase timed out — is the GM online?",
            server_error:          "A server error occurred — check GM console.",
          };
          ui.notifications?.error?.(MSGS[result.reason] ?? `Purchase failed (${result.reason ?? "unknown"}).`);
          btn.disabled = false; btn.textContent = orig;
        }
      },
    };

    dlg = new Dialog(
      {
        title:   `Shop — ${shopTitle}`,
        content: ShopWindowApp._buildHTML(buildData()),
        buttons: { close: { icon: '<i class="fas fa-door-open"></i>', label: "Leave Shop" } },
        default: "close",
        render: (html) => {
          const root = (html instanceof jQuery ? html[0] : html).querySelector?.(".fu-shop") ?? (html instanceof jQuery ? html[0] : html);
          ShopWindowApp._bindRoot(root, ctx);
        },
        close: () => {
          _openWindows.delete(shopActorUuid);
          onClose?.();
        },
      },
      { width: 780, height: "auto", resizable: true }
    );

    _openWindows.set(shopActorUuid, dlg);
    dlg.render(true);
    return dlg;
  }
}
