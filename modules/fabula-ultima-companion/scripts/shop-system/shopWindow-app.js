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

import { gp, hexToRgba, readableInk } from "./shopopen-const.js";

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
  { key: "material",   emoji: "🪵",  label: "Material"   },
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

  // Sanitize rich HTML: keep structural tags + content-link <a> elements
  // (preserving data-uuid so CSS keyword rules can target them),
  // strip all inline styles and other unsafe attributes.
  static _sanitizeHTML(raw) {
    if (!raw) return "";
    const tmp = document.createElement("div");
    tmp.innerHTML = String(raw);
    const KEEP = new Set(["ul","ol","li","p","strong","em","b","i"]);
    function esc(s) { return String(s ?? "").replace(/"/g, "&quot;"); }
    function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent;
      if (node.nodeType !== Node.ELEMENT_NODE) return "";
      const tag = node.tagName.toLowerCase();
      const inner = Array.from(node.childNodes).map(walk).join("");
      if (tag === "br") return "<br>";
      if (tag === "hr") return `<hr class="fu-hr">`;
      // Preserve content-link anchors with only data-uuid and class — CSS targets these
      if (tag === "a") {
        const uuid = node.getAttribute("data-uuid") ?? "";
        if (uuid) return `<a class="content-link" data-uuid="${esc(uuid)}">${inner}</a>`;
        return inner; // plain links: just text
      }
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

  static _buyerMult(actor) {
    if (!actor) return 1;
    const v = Number(gp(actor, "system.props.shop_buy_multiplier", 100));
    return (Number.isFinite(v) && v > 0) ? v / 100 : 1;
  }

  static _sellerMult(actor) {
    if (!actor) return 0.5;
    const v = Number(gp(actor, "system.props.shop_sell_multiplier", 50));
    return (Number.isFinite(v) && v > 0) ? v / 100 : 0.5;
  }
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
    const skillsObj = gp(item, "system.props.item_skill_active", null) ?? {};

    // Deduplicate by name (a skill can appear under multiple tier-keys)
    const seen    = new Set();
    const entries = [];
    for (const skill of Object.values(skillsObj)) {
      if (!skill?.name) continue;
      if (seen.has(skill.name)) continue;
      seen.add(skill.name);

      // Resolve skill icon: try UUID first, then name search.
      // CSB itemContainer UUIDs are often stale/mismatched with the actual world item _id,
      // so name lookup is the reliable fallback.
      const shortId  = String(skill.uuid ?? "").split(".").pop();
      const skillDoc = (shortId ? game.items?.get(shortId) : null)
                    ?? (skill.name ? game.items?.find(i => i.name === skill.name) : null);
      const img      = skillDoc?.img || "icons/svg/book.svg";

      entries.push({
        name:     skill.name,
        cost:     String(skill.skill_cost ?? "").trim(),
        img,
        descHTML: this._sanitizeHTML(String(skill.skill_description ?? "")),
      });
    }

    if (!entries.length) return null;

    let html = `<div class="fu-skills-label">Active Skills</div>`;
    for (const e of entries) {
      const costBadge = e.cost
        ? `<span class="fu-skill-cost">${this._esc(e.cost)}</span>`
        : "";
      html += `<div class="fu-skill-entry">
        <div class="fu-skill-header">
          <div class="fu-skill-icon-wrap">
            <img class="fu-skill-icon" src="${this._esc(e.img)}" alt="">
          </div>
          <span class="fu-skill-name">${this._esc(e.name)}</span>
          ${costBadge}
        </div>
        ${e.descHTML ? `<div class="fu-skill-desc">${e.descHTML}</div>` : ""}
      </div>`;
    }
    return html;
  }

  // ──────────────────────────────────────────────────────────────
  // CSS (inline, matches beige/parchment NPC sheet look)
  // ──────────────────────────────────────────────────────────────

  static _css() {
    // CSS never changes at runtime — build once and reuse.
    return (ShopWindowApp._cssCache ??= `<style id="fu-shop-style">
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
        position:relative;   /* containing block for the floating viewer badge */
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
        background:rgba(255,255,255,0.6);
        border:1px solid rgba(184,153,64,0.4);
      }
      .fu-skill-entry:last-child { margin-bottom:0; }
      .fu-skill-header {
        display:flex; align-items:center; gap:8px; margin-bottom:5px;
      }
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
      .fu-skill-desc {
        font-size:11px; color:#5a3800; line-height:1.45;
      }
      .fu-skill-desc ul, .fu-skill-desc ol { margin:2px 0 2px 14px; padding:0; }
      .fu-skill-desc li { margin:1px 0; }
      .fu-skill-desc p  { margin:2px 0; }
      .fu-skill-desc strong { font-weight:700; }

      /* ── Empty tabs: fully desaturated + darkened, clicks blocked ── */
      .fu-shop-tab.fu-tab-empty {
        filter:saturate(0) brightness(0.5);
        pointer-events:none;
        cursor:default;
      }
      /* "New!" badge on tabs */
      .fu-tab-new-badge {
        position:absolute; top:-4px; right:-4px;
        background:#c0392b; color:#fff;
        font-size:8px; font-weight:900; letter-spacing:0.02em;
        border-radius:999px; padding:1px 4px;
        line-height:12px; white-space:nowrap;
      }

      /* ── Presence: who's browsing what ──
         Visibility is toggled by .has-viewers, never by an inline display:
         clearing an inline style falls back to display:none and hides the chip.

         The row badge is absolutely positioned, so it is OUT OF FLOW: a badge
         appearing or disappearing must never reflow the row, or item text
         shifts under the eyes of whoever is reading it. */
      .fu-shop-viewers {
        display:none;
        position:absolute; top:-5px; right:58px;   /* clear of the Buy button, over the price column */
        gap:2px; z-index:3;
        pointer-events:none;   /* never eat a click meant for the Buy button */
      }
      .fu-shop-viewers.has-viewers { display:flex; }
      .fu-shop-viewer-chip {
        display:inline-flex; align-items:center;
        font-size:10px; font-weight:800; line-height:1.5;
        padding:0 6px; border-radius:999px;
        border:1px solid;
        white-space:nowrap;
        box-shadow:0 1px 3px rgba(0,0,0,0.28);
      }
      /* The in-row badge rides the border, so it stays smaller than the header roster. */
      .fu-shop-viewers .fu-shop-viewer-chip {
        font-size:9px; line-height:1.45; padding:0 5px;
      }
      .fu-shop-browsers {
        display:none; align-items:center; flex-wrap:wrap; gap:4px;
        margin-left:auto;   /* right-aligned on the Zenit row */
      }
      .fu-shop-browsers.has-viewers { display:flex; }
      .fu-browsers-label {
        font-size:10px; font-weight:800; color:#5a3800; opacity:0.6;
        text-transform:uppercase; letter-spacing:0.05em; margin-right:2px;
      }
      .fu-tab-dots {
        position:absolute; bottom:1px; left:50%; transform:translateX(-50%);
        display:flex; gap:2px; pointer-events:none;
      }
      .fu-tab-dot {
        width:5px; height:5px; border-radius:999px;
        border:1px solid rgba(0,0,0,0.35);
      }
      .fu-shop-spectate-badge {
        display:inline-flex; align-items:center; gap:3px;
        font-size:11px; font-weight:800;
        color:#5a3800; background:rgba(184,153,64,0.3);
        border:1px solid rgba(139,105,20,0.5);
        border-radius:999px; padding:1px 8px;
      }

      /* ── Sell button (injected into .dialog-buttons row) ── */
      .fu-shop-sell-dlg-btn {
        background: #9a7aba !important; border-color: #7a5a9a !important;
        color: #fff !important; font-weight: 700;
        text-shadow: 0 1px 0 rgba(0,0,0,0.25);
        transition: background 0.12s, transform 0.08s;
      }
      .fu-shop-sell-dlg-btn:hover { background: #7a5a9a !important; }
      .fu-shop-sell-dlg-btn:active { transform: scale(0.96); }
    </style>`);
  }

  // ──────────────────────────────────────────────────────────────
  // HTML builders
  // ──────────────────────────────────────────────────────────────

  static _buildRow(item, { buyerZenit, hasBuyer, buyerPriceMult = 1, spectate = false } = {}) {
    const baseCost      = this._itemCost(item);
    const effectiveCost = baseCost > 0 ? Math.round(baseCost * buyerPriceMult) : 0;
    const qty           = this._itemQty(item);
    const desc          = this._itemDesc(item);
    const outOfStock    = qty <= 0;
    const cantAfford    = !spectate && !outOfStock && hasBuyer && effectiveCost > 0 && Number.isFinite(buyerZenit) && buyerZenit < effectiveCost;
    const disabled      = spectate || outOfStock || cantAfford || !hasBuyer;

    const tip = spectate    ? "Spectating — the GM cannot buy"
              : outOfStock  ? "Out of stock"
              : cantAfford  ? "Not enough Zenit"
              : !hasBuyer   ? "No linked character"
              : "";
    const costHtml = effectiveCost > 0
      ? `<span class="fu-shop-cost">${GP_ICON}${effectiveCost.toLocaleString()}</span>`
      : `<span class="fu-shop-cost free">Free</span>`;
    const stockHtml = outOfStock
      ? `<span class="fu-shop-stock" style="color:#8b4513">Sold Out</span>`
      : `<span class="fu-shop-stock">×${qty}</span>`;
    const btnLabel = spectate ? "👁" : outOfStock ? "—" : cantAfford ? "💸" : "Buy";

    return `
      <div class="fu-shop-row${outOfStock ? " sold-out" : ""}"
           data-item-uuid="${this._esc(item.uuid)}"
           data-item-name="${this._esc(item.name)}"
           data-item-cost="${effectiveCost}"
           data-item-qty="${qty}">
        <div class="fu-shop-icon-wrap">
          <img class="fu-shop-icon" src="${this._esc(item.img || "icons/svg/item-bag.svg")}" alt="">
        </div>
        <div class="fu-shop-row-inner">
          <span class="fu-shop-item-name">${this._esc(item.name)}</span>
          ${desc ? `<span class="fu-shop-item-desc">${this._esc(desc)}</span>` : ""}
          <span class="fu-shop-viewers"></span>
        </div>
        ${costHtml}
        ${stockHtml}
        <button class="fu-shop-buy" ${disabled ? "disabled" : ""} title="${this._esc(tip)}"
                data-action="buy" data-item-uuid="${this._esc(item.uuid)}">${btnLabel}</button>
      </div>`;
  }

  static _buildHTML({ portrait, shopTitle, quote, buyerZenit, hasBuyer, itemsByCategory, activeTab, newItemIds = new Set(), buyerPriceMult = 1, spectate = false, shopZenit = 0 }) {
    // Tabs
    const tabs = SHOP_CATEGORIES.map(c => {
      const items   = itemsByCategory[c.key] ?? [];
      const isEmpty = items.length === 0;
      const hasNew  = items.some(it => newItemIds.has(it.uuid));
      const badge   = hasNew ? `<span class="fu-tab-new-badge">New!</span>` : "";
      return `<div class="fu-shop-tab${activeTab === c.key ? " active" : ""}${isEmpty ? " fu-tab-empty" : ""}"
                   data-tab="${c.key}" data-tooltip="${this._esc(c.label)}"
                   title="${this._esc(c.label)}">${c.emoji}${badge}<span class="fu-tab-dots"></span></div>`;
    }).join("");

    // Panels
    const rowOpts = { buyerZenit, hasBuyer, buyerPriceMult, spectate };
    const panels = SHOP_CATEGORIES.map(c => {
      const items = itemsByCategory[c.key] ?? [];
      const rows = items.length
        ? items.map(it => this._buildRow(it, rowOpts)).join("")
        : `<div class="fu-shop-empty">Nothing in stock.</div>`;
      return `<div class="fu-shop-panel${activeTab === c.key ? " active" : ""}" data-panel="${c.key}">
                <div class="fu-shop-list">${rows}</div>
              </div>`;
    }).join("");

    const zenitStr = spectate
      ? `<span class="fu-shop-spectate-badge">👁 Spectating</span>
         <span style="margin-left:8px">Shop Till: <span class="zv">${GP_ICON}${Number(shopZenit || 0).toLocaleString()}</span></span>`
      : hasBuyer && Number.isFinite(buyerZenit)
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
            <div class="fu-shop-zenit-bar">
              <span class="fu-zenit-text">${zenitStr}</span>
              <div class="fu-shop-browsers"></div>
            </div>
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
  // Presence — "who's browsing what"
  //
  // Deliberately a style/badge pass over the existing DOM rather than a rebuild:
  // selections change far more often than stock does, and a rebuild here would
  // fight the debounced data redraw and throw away the reader's scroll position.
  // ──────────────────────────────────────────────────────────────

  static _applyPresence(root, viewers) {
    if (!root) return;

    // Reset everything this function owns. Visibility is a class, not an inline
    // display: clearing an inline style just falls back to the stylesheet's
    // `display:none`, which would build the chips and then hide them.
    root.querySelectorAll(".fu-shop-row").forEach(row => {
      row.style.borderColor = "";
      row.style.outline     = "";
      const strip = row.querySelector(".fu-shop-viewers");
      if (strip) { strip.innerHTML = ""; strip.classList.remove("has-viewers"); }
    });
    root.querySelectorAll(".fu-tab-dots").forEach(d => { d.innerHTML = ""; });

    const browsers = root.querySelector(".fu-shop-browsers");
    if (browsers) { browsers.innerHTML = ""; browsers.classList.remove("has-viewers"); }

    if (!viewers?.length) return;

    // Row tint + name chips, grouped so several people can look at one item.
    const byItem = new Map();
    for (const v of viewers) {
      if (!v.itemUuid) continue;
      const list = byItem.get(v.itemUuid) ?? [];
      list.push(v);
      byItem.set(v.itemUuid, list);
    }

    for (const [itemUuid, list] of byItem.entries()) {
      const row = root.querySelector(`.fu-shop-row[data-item-uuid="${CSS.escape(itemUuid)}"]`);
      if (!row) continue;

      // Outline only — a filled row fought with the sold-out/selected states and
      // was far louder than the name badge it was meant to support.
      const lead = list[0];
      row.style.borderColor = lead.color;
      row.style.outline     = `1px solid ${lead.color}`;

      const strip = row.querySelector(".fu-shop-viewers");
      if (!strip) continue;
      strip.classList.add("has-viewers");
      strip.innerHTML = list.map(v => this._viewerChip(v)).join("");
    }

    // A dot on the tab of anyone whose pick lives in a category you aren't on,
    // so you can see they've wandered off to Consumables.
    const byTab = new Map();
    for (const v of viewers) {
      if (!v.tab) continue;
      const list = byTab.get(v.tab) ?? [];
      list.push(v);
      byTab.set(v.tab, list);
    }
    for (const [tab, list] of byTab.entries()) {
      const dots = root.querySelector(`.fu-shop-tab[data-tab="${CSS.escape(tab)}"] .fu-tab-dots`);
      if (!dots) continue;
      dots.innerHTML = list
        .map(v => `<span class="fu-tab-dot" style="background:${v.color}" title="${this._esc(v.label)}"></span>`)
        .join("");
    }

    // Header roster line
    if (browsers) {
      browsers.classList.add("has-viewers");
      browsers.innerHTML = `<span class="fu-browsers-label">Browsing:</span>`
        + viewers.map(v => this._viewerChip(v)).join("");
    }
  }

  // Name badge for one viewer, in their Foundry user colour. Label is the linked
  // character's name — that's what the table calls each other — falling back to
  // the user name when no actor is linked (a GM, usually). Solid fill rather than
  // a tint: at 10px, floating over a busy row, a washed-out chip doesn't read.
  static _viewerChip(v) {
    return `<span class="fu-shop-viewer-chip"
                  style="background:${v.color}; border-color:${hexToRgba(v.color, 0.55)}; color:${readableInk(v.color)}"
                  title="${this._esc(v.label)}">${this._esc(v.label)}</span>`;
  }

  // ──────────────────────────────────────────────────────────────
  // Bind events to a root element
  // ──────────────────────────────────────────────────────────────

  static _bindRoot(root, ctx) {
    const snd = () => window.FUCompanion?.shopSound;

    // Tab switching
    root.querySelectorAll(".fu-shop-tab").forEach(btn => {
      btn.addEventListener("click", () => {
        snd()?.playTabSwitch();
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
        snd()?.playItemSelect();
        ctx.selectItem(row.dataset.itemUuid, { broadcast: true });
      });
    });
  }

  // Paint a selection (own or restored-after-redraw) into an already-built root.
  static _renderSelection(root, ctx, itemUuid) {
    if (!root) return;

    root.querySelectorAll(".fu-shop-row").forEach(r =>
      r.classList.toggle("fu-selected", r.dataset.itemUuid === itemUuid));

    const preview = root.querySelector(".fu-shop-preview");
    if (preview) {
      preview.innerHTML = itemUuid
        ? ctx.getPreviewHTML(itemUuid)
        : `<div class="fu-preview-placeholder">← Click an item to see its stats</div>`;
    }

    const skills = root.querySelector(".fu-shop-skills");
    if (skills) {
      const skillsHTML = itemUuid ? ctx.getSkillsHTML(itemUuid) : null;
      if (skillsHTML) {
        skills.innerHTML = skillsHTML;
        skills.classList.add("has-skills");
      } else {
        skills.innerHTML = "";
        skills.classList.remove("has-skills");
      }
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Open
  // ──────────────────────────────────────────────────────────────

  static async open(shopActorUuid, { onClose, spectate = false } = {}) {
    // Deduplicate
    const existing = _openWindows.get(shopActorUuid);
    if (existing) { try { existing.bringToTop?.(); } catch {} return existing; }

    const actor = await fromUuid(shopActorUuid);
    if (!actor) { ui.notifications?.error?.("[ShopWindow] Shop actor not found."); return null; }

    // A spectating GM never buys — gate on `spectate`, not on having a character,
    // because a GM may well have one linked.
    const buyerActor = spectate ? null : (game.user.character ?? null);
    const hasBuyer   = !!buyerActor;

    const presence = window.FUCompanion?.shopPresence ?? null;

    // Snapshot: remember which items were in stock when the shop opened (for "New!" badge)
    const initialItemIds = new Set(actor.items.contents.map(i => i.uuid));
    const readNewItemIds = () => new Set(
      actor.items.contents.filter(i => !initialItemIds.has(i.uuid)).map(i => i.uuid)
    );

    // Snapshot helpers
    const readItems = () => {
      const byCat = Object.fromEntries(SHOP_CATEGORIES.map(c => [c.key, []]));
      for (const item of actor.items.contents) {
        const t = ShopWindowApp._itemType(item);
        if (byCat[t]) byCat[t].push(item);
      }
      return byCat;
    };
    const readZenit     = () => hasBuyer ? Math.max(0, Number(buyerActor.system?.props?.zenit ?? 0)) : 0;
    const readMult      = () => hasBuyer ? ShopWindowApp._buyerMult(buyerActor) : 1;
    const readShopZenit = () => Math.max(0, Number(gp(actor, "system.props.zenit", 0)) || 0);

    const state = {
      activeTab:       null,
      itemsByCategory: readItems(),
      buyerZenit:      readZenit(),
      buyerPriceMult:  readMult(),
      shopZenit:       readShopZenit(),
      selectedUuid:    null,

      // Set while this client's purchase is in flight. An incoming redraw would
      // otherwise swap in a fresh, ENABLED buy button under the user's cursor —
      // a second click there is a second real purchase.
      inFlight:        false,
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
      newItemIds: readNewItemIds(),
      buyerPriceMult: state.buyerPriceMult,
      spectate,
      shopZenit: state.shopZenit,
    });

    const rootEl = () => dlg?.element?.[0]?.querySelector?.(".fu-shop") ?? null;

    const refreshPresence = () => {
      if (!presence) return;
      const root = rootEl();
      if (!root) return;
      ShopWindowApp._applyPresence(root, presence.viewers(shopActorUuid, { excludeSelf: true }));
    };

    let redrawPending = false;

    const redraw = () => {
      // Don't swap the DOM out from under an in-flight purchase; catch up after.
      if (state.inFlight) { redrawPending = true; return; }
      redrawPending = false;

      const oldRoot = rootEl();
      if (!oldRoot) return;

      state.itemsByCategory = readItems();
      state.buyerZenit      = readZenit();
      state.buyerPriceMult  = readMult();
      state.shopZenit       = readShopZenit();

      // Someone else buying must not yank this reader out of what they were
      // looking at, so carry the selection and the scroll position across.
      const prevScroll = oldRoot.querySelector(".fu-shop-panel.active .fu-shop-list")?.scrollTop ?? 0;
      if (state.selectedUuid && !actor.items.find(i => i.uuid === state.selectedUuid)) {
        // The item they were reading just sold out from under them. Tell the room,
        // or everyone else keeps showing their badge on a row that no longer exists.
        state.selectedUuid = null;
        presence?.select(shopActorUuid, null, null);
      }

      const tmp = document.createElement("div");
      tmp.innerHTML = ShopWindowApp._buildHTML(buildData());
      const newRoot = tmp.querySelector(".fu-shop");
      if (!newRoot) return;

      oldRoot.replaceWith(newRoot);
      ShopWindowApp._bindRoot(newRoot, ctx);
      ShopWindowApp._renderSelection(newRoot, ctx, state.selectedUuid);

      const list = newRoot.querySelector(".fu-shop-panel.active .fu-shop-list");
      if (list) list.scrollTop = prevScroll;

      refreshPresence();
    };

    // One transfer is several writes (item quantity, item delete, two Zenit
    // updates), each firing its own hook — coalesce them into a single repaint.
    let redrawTimer = null;
    const queueRedraw = () => {
      if (redrawTimer) return;
      redrawTimer = setTimeout(() => { redrawTimer = null; redraw(); }, 80);
    };

    // ── Live sync: the shop is shared, so anyone's write repaints everyone ──
    const onItemChange  = (doc) => { if (doc?.parent?.uuid === shopActorUuid) queueRedraw(); };
    const onActorChange = (a)   => {
      if (a?.uuid === shopActorUuid || (buyerActor && a?.uuid === buyerActor.uuid)) queueRedraw();
    };

    const hookIds = [
      ["createItem",  Hooks.on("createItem",  onItemChange)],
      ["updateItem",  Hooks.on("updateItem",  onItemChange)],
      ["deleteItem",  Hooks.on("deleteItem",  onItemChange)],
      ["updateActor", Hooks.on("updateActor", onActorChange)],
    ];

    const unsubPresence = presence?.subscribe(shopActorUuid, refreshPresence) ?? null;

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

      // Selecting a row shows its stats AND tells the table what you're eyeing —
      // it doubles as the pointer for "this one, the sword".
      selectItem: (itemUuid, { broadcast = false } = {}) => {
        state.selectedUuid = itemUuid ?? null;
        const root = rootEl();
        ShopWindowApp._renderSelection(root, ctx, state.selectedUuid);

        if (!broadcast || !presence) return;
        const tab = state.selectedUuid
          ? root?.querySelector(`.fu-shop-row[data-item-uuid="${CSS.escape(state.selectedUuid)}"]`)
                ?.closest(".fu-shop-panel")?.dataset?.panel ?? state.activeTab
          : null;
        presence.select(shopActorUuid, state.selectedUuid, tab);
      },

      onOpenSell: () => {
        window.FUCompanion?.shopSellApp?.open?.(shopActorUuid, { sellerActorUuid: buyerActor?.uuid });
      },
      onBuy: async (btn) => {
        if (spectate) return;
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

        const orig = btn.textContent;

        // Hold redraws for the whole flow, not just the request: a repaint while
        // the quantity prompt is up would rebuild the row behind it and hand back
        // an enabled buy button — and a second click there is a second real buy.
        let result;
        state.inFlight = true;
        try {
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

          btn.disabled = true;
          btn.textContent = "…";

          const handler = window.FUCompanion?.shopPurchase;
          if (!handler) {
            ui.notifications?.error?.("Shop purchase system not available.");
            return;
          }

          result = await handler.requestPurchase({
            shopActorUuid,
            itemUuid,
            quantity,
            buyerActorUuid:  buyerActor.uuid,
            requesterUserId: game.user.id,
          });
        } finally {
          state.inFlight = false;
        }

        // Cancelled, or the handler was missing: restore the row, and pick up any
        // stock change that landed while we were holding redraws back.
        if (!result) {
          if (redrawPending) redraw();
          else { btn.disabled = false; btn.textContent = orig; }
          return;
        }

        if (result.ok) {
          window.FUCompanion?.shopSound?.playPurchase();
          const costStr = result.totalCost > 0 ? ` for 🪙 ${result.totalCost.toLocaleString()}` : "";
          ui.notifications?.info?.(`Purchased ×${result.quantity} ${itemName}${costStr}.`);

          // Optimistically update local Zenit state so the header reflects the
          // new balance immediately — the full redraw syncs from the actor after.
          if (result.totalCost > 0) {
            state.buyerZenit = Math.max(0, state.buyerZenit - result.totalCost);
            const zenitBar = rootEl()?.querySelector?.(".fu-shop-zenit-bar");
            if (zenitBar) {
              zenitBar.innerHTML = `Your Zenit: <span class="zv">${GP_ICON}${state.buyerZenit.toLocaleString()}</span>`;
            }
          }

          // By the time BUY_RESULT arrives the GM has finished all DB writes,
          // so Foundry's reactive sync has already pushed actor changes to this client.
          // No artificial delay needed.
          redraw();
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
          // Rebuild rather than un-disabling by hand: a failure usually means the
          // stock moved under us, and redraw shows the truth.
          redraw();
        }

        if (redrawPending) redraw();
      },
    };

    dlg = new Dialog(
      {
        title:   spectate ? `Shop — ${shopTitle} (Spectating)` : `Shop — ${shopTitle}`,
        content: ShopWindowApp._buildHTML(buildData()),
        buttons: { close: { icon: '<i class="fas fa-door-open"></i>', label: spectate ? "Stop Spectating" : "Leave Shop" } },
        default: "close",
        render: (html) => {
          const root = (html instanceof jQuery ? html[0] : html).querySelector?.(".fu-shop") ?? (html instanceof jQuery ? html[0] : html);
          ShopWindowApp._bindRoot(root, ctx);
          refreshPresence();

          // Inject Sell button into the dialog-buttons row (left of Leave Shop)
          if (hasBuyer) {
            Promise.resolve().then(() => {
              const btnRow = dlg?.element?.[0]?.querySelector?.(".dialog-buttons");
              if (!btnRow || btnRow.querySelector(".fu-shop-sell-dlg-btn")) return;
              const btn = document.createElement("button");
              btn.className = "fu-shop-sell-dlg-btn";
              btn.innerHTML = `<i class="fas fa-coins"></i> Sell`;
              btn.addEventListener("click", () => ctx.onOpenSell?.());
              btnRow.prepend(btn);
            });
          }
        },
        close: () => {
          window.FUCompanion?.shopSound?.playCancel();

          if (redrawTimer) clearTimeout(redrawTimer);
          for (const [name, id] of hookIds) { try { Hooks.off(name, id); } catch {} }
          unsubPresence?.();
          presence?.leave(shopActorUuid);

          _openWindows.delete(shopActorUuid);
          onClose?.();
        },
      },
      { width: 780, height: "auto", resizable: true }
    );

    _openWindows.set(shopActorUuid, dlg);
    dlg.render(true);

    // Announce arrival: everyone already in this shop replies with their own
    // presence, so a late joiner doesn't walk into an apparently empty room.
    presence?.enter(shopActorUuid);

    window.FUCompanion?.shopSound?.playShopOpen?.();
    return dlg;
  }
}
