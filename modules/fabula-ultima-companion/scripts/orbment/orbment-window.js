// scripts/orbment/orbment-window.js
//
// The Orbment window — a lightweight custom DOM overlay (not a Foundry Dialog),
// styled to match the module's dark panels. Shows an equipment's slot grid and
// an augment picker; install/remove route through the API, then the window
// re-reads state and re-renders. GM-only surface in v1.
//
// Interaction: click a slot to select it (highlight), then click an augment in
// the picker to install into the selected slot. Installed slots show a ✕ remove.

import * as OrbmentApi from "./orbment-api.js";

const WIN_ID   = "fu-orbment-window";
const STYLE_ID = "fu-orbment-style";

let _instance = null;

const esc = (v) => String(v ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export class OrbmentWindow {
  static open(itemUuid) {
    if (_instance) { _instance._itemUuid = itemUuid; _instance._refresh(); _instance._focus(); return _instance; }
    _instance = new OrbmentWindow(itemUuid);
    _instance._build();
    return _instance;
  }
  static close() { _instance?._destroy(); }

  constructor(itemUuid) {
    this._itemUuid = itemUuid;
    this._root = null;
    this._selectedSlot = 0;
    // Zenit economy: OFF by default = GM MANUAL backstage edit (no charge). Toggle
    // ON to charge the RAW cost (simulate the normal shop/gameplay purchase).
    this._chargeZenit = false;
    // When set, the window shows the secondary "choose one" picker for a
    // parameterized augment: { id, label, icon, prompt, options }.
    this._picking = null;
    // Active category tab for the right column (offensive/defensive/enhancement).
    this._activeTab = "offensive";
    // Staged augment awaiting Confirm: { id, param, label, icon, cost }.
    this._staged = null;
    this._onUpdateItem = null;
  }

  _focus() { this._root?.style && (this._root.style.zIndex = "10001"); }

  _ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    // Warm parchment theme — mirrors the Battle Director invoke-HUD / keyword
    // tooltip palette (fud-* tokens) so this window reads as native FU UI.
    s.textContent = `
      #${WIN_ID} {
        /* Light parchment wrapper; option/slot cells near-WHITE and popped out
           with a darker brown border so they stand off the warm shell. */
        --ptop:#f6f1e6; --pbot:#ebe3d0; --stroke:#7a6a55; --ink:#3a3228;
        --gold:#a07a28; --gold-lite:#c9a24a; --hi:#FFBB55; --brown:87,58,33;
        --cell-top:#fffdf7; --cell-bot:#fbf6ea; --cell-border:#8a6a44;
        position: fixed; top: 11vh; left: 50%; transform: translateX(-50%);
        width: 830px; max-width: 95vw; max-height: 80vh; overflow: hidden;
        display: flex; flex-direction: column; z-index: 10000;
        background: linear-gradient(180deg, var(--ptop), var(--pbot));
        color: var(--ink); border: 2px solid var(--stroke); border-radius: 14px;
        box-shadow: 0 16px 48px rgba(0,0,0,.5), 0 0 0 1px rgba(255,255,255,.45) inset;
        font-family: "Inter","Signika","Segoe UI",system-ui,sans-serif;
      }
      #${WIN_ID} .fu-orb-header {
        display: flex; align-items: center; gap: 10px; padding: 12px 14px; cursor: move;
        background: linear-gradient(180deg, #efe4c9, #e6d6b3);
        border-bottom: 2px solid rgba(var(--brown),.45);
        box-shadow: inset 0 1px 0 rgba(255,255,255,.5);
      }
      #${WIN_ID} .fu-orb-title { font-size: 16px; font-weight: 900; flex: 1; color: var(--ink); }
      #${WIN_ID} .fu-orb-sub { font-size: 11px; font-weight: 600; color: var(--gold); margin-top: 2px; }
      #${WIN_ID} .fu-orb-x {
        cursor: pointer; width: 26px; height: 26px; border-radius: 7px;
        border: 1.5px solid rgba(var(--brown),.3); background: rgba(var(--brown),.1);
        color: var(--ink); font-size: 14px; line-height: 1; transition: all .12s ease;
      }
      #${WIN_ID} .fu-orb-x:hover { background: #e35151; border-color: #e35151; color: #fff8e7; }
      /* Two-column body: slots on the left, tabbed option list on the right. */
      #${WIN_ID} .fu-orb-body { display: flex; flex-direction: row; align-items: stretch; overflow: hidden; min-height: 0; }
      #${WIN_ID} .fu-orb-col-left {
        flex: 0 0 312px; padding: 12px 12px 12px 14px; overflow-y: auto;
        border-right: 2px solid rgba(var(--brown),.28); display: flex; flex-direction: column;
      }
      #${WIN_ID} .fu-orb-col-right { flex: 1 1 auto; min-width: 0; padding: 12px 14px 12px 12px; display: flex; flex-direction: column; overflow: hidden; }
      #${WIN_ID} .fu-orb-tabs { display: flex; flex-direction: row; flex-wrap: nowrap; gap: 4px; margin-bottom: 8px; }
      #${WIN_ID} .fu-orb-tab {
        flex: 1 1 0; width: auto; min-width: 0; box-sizing: border-box;
        padding: 6px 8px; border-radius: 8px 8px 0 0; cursor: pointer;
        font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: .5px;
        border: 2px solid var(--cell-border); border-bottom: none; color: var(--gold);
        background: linear-gradient(180deg, #efe4c9, #e4d3ac); transition: filter .12s ease, background .12s ease, color .12s ease;
      }
      #${WIN_ID} .fu-orb-tab.is-active { color: var(--ink); background: linear-gradient(180deg, var(--cell-top), var(--cell-bot)); box-shadow: inset 0 2px 0 var(--hi); }
      #${WIN_ID} .fu-orb-tab:hover:not(.is-active) { filter: brightness(1.04); }
      #${WIN_ID} .fu-orb-list { flex: 1 1 auto; overflow-y: auto; padding-right: 4px; }
      #${WIN_ID} .fu-orb-slots { display: flex; flex-direction: column; gap: 7px; margin-bottom: 10px; }
      #${WIN_ID} .fu-orb-slot {
        width: 100%; min-height: 42px; border-radius: 9px; padding: 6px 30px 6px 10px;
        border: 2px solid var(--cell-border);
        background: radial-gradient(120% 80% at 50% 0%, rgba(255,255,255,.5) 0%, transparent 45%),
          linear-gradient(180deg, var(--cell-top) 0%, var(--cell-bot) 100%);
        box-shadow: inset 0 1px 0 rgba(255,255,255,.7), 0 3px 8px rgba(0,0,0,.12);
        cursor: pointer; transition: filter .1s ease, border-color .12s ease, box-shadow .12s ease; position: relative;
      }
      #${WIN_ID} .fu-orb-slot:hover { filter: brightness(1.02); }
      #${WIN_ID} .fu-orb-slot.is-selected {
        border-color: var(--hi);
        box-shadow: inset 0 1px 0 rgba(255,255,255,.8), 0 0 0 2px rgba(255,187,85,.35), 0 3px 8px rgba(0,0,0,.15);
      }
      #${WIN_ID} .fu-orb-slot .lbl { font-size: 9px; font-weight: 700; color: var(--gold); text-transform: uppercase; letter-spacing: .6px; }
      #${WIN_ID} .fu-orb-slot .aug { font-size: 14px; font-weight: 800; margin-top: 1px; color: var(--ink); line-height: 1.15; }
      #${WIN_ID} .fu-orb-slot .sum { font-size: 10px; color: var(--ink); opacity: .65; margin-top: 1px; line-height: 1.2; }
      #${WIN_ID} .fu-orb-slot.is-staged { border-style: dashed; border-color: var(--hi); background: linear-gradient(180deg, #fffdf7, #fdf3dd); }
      /* Remove = small round corner button, vertically centered on the slot's right edge. */
      #${WIN_ID} .fu-orb-slot .rm {
        position: absolute; top: 50%; right: 7px; transform: translateY(-50%);
        width: 20px; height: 20px; padding: 0; display: flex; align-items: center; justify-content: center;
        border: 1px solid rgba(var(--brown),.35); border-radius: 50%;
        background: rgba(255,255,255,.7); color: var(--ink); cursor: pointer; font-size: 11px; line-height: 1;
        box-shadow: 0 1px 2px rgba(0,0,0,.15); transition: all .12s ease; opacity: .55;
      }
      #${WIN_ID} .fu-orb-slot:hover .rm { opacity: 1; }
      #${WIN_ID} .fu-orb-slot .rm:hover { background: #e35151; border-color: #e35151; color: #fff8e7; transform: translateY(-50%) scale(1.12); }
      #${WIN_ID} .fu-orb-sectionhdr {
        display: flex; align-items: center; gap: 7px; font-size: 11px; font-weight: 800;
        text-transform: uppercase; letter-spacing: .6px; color: var(--gold); margin: 12px 0 7px;
      }
      #${WIN_ID} .fu-orb-sectionhdr::before {
        content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--gold-lite);
        box-shadow: 0 0 6px rgba(201,162,74,.8); flex: 0 0 auto;
      }
      #${WIN_ID} .fu-orb-aug {
        display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 10px;
        border: 2px solid var(--cell-border);
        background: linear-gradient(180deg, var(--cell-top), var(--cell-bot));
        box-shadow: inset 0 1px 0 rgba(255,255,255,.7), 0 1px 3px rgba(0,0,0,.1);
        cursor: pointer; margin-bottom: 6px; transition: filter .1s ease, border-color .12s ease, box-shadow .12s ease;
      }
      #${WIN_ID} .fu-orb-aug:hover { border-color: var(--hi); box-shadow: 0 0 0 2px rgba(255,187,85,.3), 0 3px 8px rgba(0,0,0,.14); }
      #${WIN_ID} .fu-orb-aug.is-installed { opacity: .45; filter: grayscale(.4); cursor: not-allowed; }
      #${WIN_ID} .fu-orb-aug.is-installed:hover { border-color: var(--cell-border); box-shadow: inset 0 1px 0 rgba(255,255,255,.7); filter: grayscale(.4); }
      #${WIN_ID} .fu-orb-aug.is-pending { opacity: .5; cursor: default; border-style: dashed; }
      #${WIN_ID} .fu-orb-aug.is-pending:hover { border-color: var(--cell-border); box-shadow: inset 0 1px 0 rgba(255,255,255,.7); }
      #${WIN_ID} .fu-orb-soon {
        font-size: 9px; font-weight: 800; text-transform: uppercase; letter-spacing: .5px;
        color: #8a6a44; background: rgba(var(--brown),.14); border: 1px solid rgba(var(--brown),.3);
        border-radius: 5px; padding: 0 4px; margin-left: 6px; vertical-align: middle;
      }
      #${WIN_ID} .fu-orb-catlabel {
        font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: .8px;
        color: var(--gold); opacity: .85; margin: 10px 0 5px 2px;
      }
      #${WIN_ID} .fu-orb-catlabel:first-child { margin-top: 2px; }
      #${WIN_ID} .fu-orb-choose {
        font-size: 9px; font-weight: 800; text-transform: uppercase; letter-spacing: .5px;
        color: var(--gold); background: rgba(160,122,40,.12); border: 1px solid rgba(160,122,40,.35);
        border-radius: 5px; padding: 0 5px; margin-left: 6px; vertical-align: middle;
      }
      #${WIN_ID} .fu-orb-back {
        cursor: pointer; color: var(--gold); font-weight: 800; text-decoration: none;
        padding: 1px 6px; border-radius: 5px; border: 1px solid rgba(160,122,40,.35); background: rgba(160,122,40,.1);
      }
      #${WIN_ID} .fu-orb-back:hover { background: rgba(160,122,40,.22); }
      #${WIN_ID} .fu-orb-aug .ic { font-size: 20px; width: 26px; text-align: center; }
      #${WIN_ID} .fu-orb-aug .meta { flex: 1; }
      #${WIN_ID} .fu-orb-aug .meta .nm { font-weight: 800; font-size: 14px; color: var(--ink); }
      #${WIN_ID} .fu-orb-aug .meta .sm { font-size: 11px; color: var(--ink); opacity: .72; }
      #${WIN_ID} .fu-orb-aug .cost { font-size: 12px; font-weight: 700; color: var(--gold); white-space: nowrap; }
      #${WIN_ID} .fu-orb-link { font-size: 11px; color: var(--ink); opacity: .7; font-style: italic; margin: 4px 0 2px; }
      #${WIN_ID} .fu-orb-econ {
        display: flex; flex-direction: column; align-items: flex-start; gap: 4px;
        padding: 7px 9px; margin-top: auto; border-radius: 8px;
        border: 1.5px solid rgba(var(--brown),.3); background: rgba(var(--brown),.06);
      }
      #${WIN_ID} .fu-orb-charge { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: var(--ink); cursor: pointer; user-select: none; }
      #${WIN_ID} .fu-orb-charge input { accent-color: var(--gold-lite); cursor: pointer; }
      #${WIN_ID} .fu-orb-wallet { font-size: 12px; color: var(--gold); }
      #${WIN_ID} .fu-orb-wallet b { color: var(--ink); }
      /* Confirm/Cancel footer (staging bar) */
      #${WIN_ID} .fu-orb-footer {
        display: flex; align-items: center; justify-content: space-between; gap: 12px;
        padding: 9px 14px; border-top: 2px solid rgba(var(--brown),.4);
        background: linear-gradient(180deg, #efe4c9, #e6d6b3);
      }
      #${WIN_ID} .fu-orb-footer .info { font-size: 13px; color: var(--ink); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      #${WIN_ID} .fu-orb-footer .info b { color: var(--ink); }
      #${WIN_ID} .fu-orb-footer .info .free { color: var(--gold); font-weight: 700; }
      #${WIN_ID} .fu-orb-btns { display: flex; gap: 8px; flex: 0 0 auto; }
      #${WIN_ID} .fu-orb-btn {
        width: auto; box-sizing: border-box; cursor: pointer; padding: 6px 16px; border-radius: 9px;
        font-size: 13px; font-weight: 800; border: 2px solid transparent; transition: filter .1s ease;
      }
      #${WIN_ID} .fu-orb-btn-confirm { background: linear-gradient(180deg, #c9a24a, #a07a28); color: #fff8e7; box-shadow: 0 2px 6px rgba(0,0,0,.25), inset 0 1px 0 rgba(255,255,255,.25); }
      #${WIN_ID} .fu-orb-btn-confirm:hover { filter: brightness(1.09); }
      #${WIN_ID} .fu-orb-btn-cancel { background: rgba(var(--brown),.1); color: var(--ink); border-color: rgba(var(--brown),.35); }
      #${WIN_ID} .fu-orb-btn-cancel:hover { background: rgba(var(--brown),.2); }
      #${WIN_ID} .fu-orb-aug.is-staged { border-color: var(--hi); box-shadow: 0 0 0 2px rgba(255,187,85,.4), 0 3px 8px rgba(0,0,0,.14); }
      #${WIN_ID}::-webkit-scrollbar, #${WIN_ID} .fu-orb-body::-webkit-scrollbar { width: 10px; }
      #${WIN_ID} .fu-orb-body::-webkit-scrollbar-thumb { background: rgba(var(--brown),.35); border-radius: 6px; }
    `;
    document.head.appendChild(s);
  }

  async _build() {
    this._ensureStyle();
    const root = document.createElement("div");
    root.id = WIN_ID;
    document.body.appendChild(root);
    this._root = root;
    await this._refresh();

    // Re-render if the underlying item changes out-of-band.
    this._onUpdateItem = (doc) => {
      if (doc?.documentName === "Item" && doc.uuid === this._itemUuid) this._refresh();
    };
    Hooks.on("updateItem", this._onUpdateItem);
  }

  _destroy() {
    if (this._onUpdateItem) { Hooks.off("updateItem", this._onUpdateItem); this._onUpdateItem = null; }
    this._root?.remove();
    this._root = null;
    _instance = null;
  }

  async _refresh() {
    if (!this._root) return;
    const data = await OrbmentApi.list(this._itemUuid);
    if (!data) { this._root.innerHTML = `<div class="fu-orb-header"><div class="fu-orb-title">Orbment</div><button class="fu-orb-x">✕</button></div><div class="fu-orb-body">Item not found.</div>`; this._wireChrome(); return; }
    if (this._selectedSlot >= data.slotCount) this._selectedSlot = 0;
    this._data = data;
    this._render(data);
  }

  _augRowHtml(a, installedIds) {
    const stagedHere = this._staged && this._staged.id === a.id && !a.param;
    // Param augments are never "installed" (many variants) — only simple ones grey out.
    const cls = (!a.param && installedIds.has(a.id)) ? "is-installed"
      : (a.pending ? "is-pending" : (stagedHere ? "is-staged" : ""));
    const tag = a.pending ? `<span class="fu-orb-soon">soon</span>`
      : (a.param ? `<span class="fu-orb-choose">choose ▾</span>` : "");
    return `<div class="fu-orb-aug ${cls}" data-aug="${esc(a.id)}" data-pending="${a.pending ? 1 : 0}" data-param="${a.param ? 1 : 0}">
      <div class="ic">${esc(a.icon)}</div>
      <div class="meta"><div class="nm">${esc(a.label)}${tag}</div><div class="sm">${esc(a.summary)}</div></div>
      <div class="cost">${a.cost} z</div>
    </div>`;
  }

  _render(data) {
    const CAT_LABEL = { offensive: "Offensive", enhancement: "Enhancement", defensive: "Defensive" };
    const CAT_ORDER = ["offensive", "enhancement", "defensive"];
    const present = CAT_ORDER.filter((c) => data.available.some((a) => (a.category || "") === c));
    if (!present.includes(this._activeTab)) this._activeTab = present[0] || "";

    const installedIds = new Set(data.slots.filter(Boolean).map((s) => s.id));

    // ── LEFT: slots (vertical stack) + link note + econ bar ──
    const slotsHtml = data.slots.map((s, i) => {
      const isSel = i === this._selectedSlot;
      const sel = isSel ? "is-selected" : "";
      // Staging preview on the selected slot.
      if (isSel && this._staged) {
        return `<div class="fu-orb-slot is-staged ${sel}" data-slot="${i}">
          <div class="lbl">Slot ${i + 1} • staging</div>
          <div class="aug">${esc(this._staged.icon)} ${esc(this._staged.label)}</div>
          <div class="sum">${s ? `replaces ${esc(s.label)}` : "confirm to install"}</div>
        </div>`;
      }
      if (s) {
        return `<div class="fu-orb-slot is-filled ${sel}" data-slot="${i}">
          <button class="rm" data-remove="${i}" title="Remove">✕</button>
          <div class="lbl">Slot ${i + 1}</div>
          <div class="aug">${esc(s.icon)} ${esc(s.label)}</div>
          <div class="sum">${esc(s.summary)}</div>
        </div>`;
      }
      return `<div class="fu-orb-slot ${sel}" data-slot="${i}">
        <div class="lbl">Slot ${i + 1}</div>
        <div class="aug" style="opacity:.5;font-weight:500">— empty —</div>
        <div class="sum" style="opacity:.5">click to select</div>
      </div>`;
    }).join("");

    const linkNote = (data.linkGroup?.length > 1)
      ? `<div class="fu-orb-link">🔗 Linked group: changes mirror to ${data.linkGroup.length} items.</div>`
      : "";

    const chargeChecked = this._chargeZenit ? "checked" : "";
    const econBar = `
      <div class="fu-orb-econ">
        <label class="fu-orb-charge" title="Off = GM manual edit (free). On = charge the augment cost from the actor's Zenit.">
          <input type="checkbox" ${chargeChecked}> Charge Zenit on install
        </label>
        <span class="fu-orb-wallet">${esc(data.actorName || "Actor")}: <b>${(data.actorZenit ?? 0).toLocaleString()}</b> z</span>
      </div>`;

    // ── RIGHT: tabs + list, OR the secondary picker ──
    let rightHtml;
    if (this._picking) {
      const p = this._picking;
      const opts = p.options.map((o) => `<div class="fu-orb-aug" data-opt="${esc(o.value)}">
          <div class="ic">${esc(o.icon || p.icon)}</div>
          <div class="meta"><div class="nm">${esc(o.label)}</div></div>
        </div>`).join("");
      rightHtml = `
        <div class="fu-orb-sectionhdr"><a class="fu-orb-back">← Back</a>&nbsp;&nbsp;${esc(p.icon)} ${esc(p.label)} — ${esc(p.prompt)}</div>
        <div class="fu-orb-list">${opts}</div>`;
    } else {
      const tabs = present.map((c) => `<button class="fu-orb-tab ${c === this._activeTab ? "is-active" : ""}" data-tab="${c}">${CAT_LABEL[c] || c}</button>`).join("");
      const rows = data.available.filter((a) => (a.category || "") === this._activeTab).map((a) => this._augRowHtml(a, installedIds)).join("");
      rightHtml = `
        <div class="fu-orb-tabs">${tabs}</div>
        <div class="fu-orb-list">${rows || `<div style="opacity:.6">No augments in this category.</div>`}</div>`;
    }

    this._root.innerHTML = `
      <div class="fu-orb-header">
        <div style="font-size:20px">🔮</div>
        <div class="fu-orb-title">${esc(data.itemName)}
          <div class="fu-orb-sub">${esc(data.itemType)} • ${esc(data.rarity || "—")} • ${data.slotCount} slot${data.slotCount === 1 ? "" : "s"}</div>
        </div>
        <button class="fu-orb-x" title="Close">✕</button>
      </div>
      <div class="fu-orb-body">
        <div class="fu-orb-col-left">
          <div class="fu-orb-sectionhdr">Slots</div>
          <div class="fu-orb-slots">${slotsHtml}</div>
          ${linkNote}
          ${econBar}
        </div>
        <div class="fu-orb-col-right">${rightHtml}</div>
      </div>
      ${this._staged ? `
        <div class="fu-orb-footer">
          <div class="info">Install <b>${esc(this._staged.icon)} ${esc(this._staged.label)}</b> → Slot ${this._selectedSlot + 1}
            ${(this._chargeZenit && this._staged.cost > 0) ? `<span class="free">(−${this._staged.cost} z)</span>` : `<span class="free">(free)</span>`}
          </div>
          <div class="fu-orb-btns">
            <button class="fu-orb-btn fu-orb-btn-cancel">Cancel</button>
            <button class="fu-orb-btn fu-orb-btn-confirm">✓ Confirm</button>
          </div>
        </div>` : ""}`;
    this._wireChrome();
    this._wireBody();
  }

  _wireChrome() {
    const x = this._root.querySelector(".fu-orb-x");
    if (x) x.onclick = () => this._destroy();
    const header = this._root.querySelector(".fu-orb-header");
    if (header) this._makeDraggable(header);
  }

  _wireBody() {
    this._root.querySelectorAll(".fu-orb-slot").forEach((el) => {
      el.addEventListener("click", (ev) => {
        if (ev.target.closest("[data-remove]")) return;
        this._selectedSlot = Number(el.dataset.slot);
        this._render(this._data);
      });
    });
    this._root.querySelectorAll("[data-remove]").forEach((btn) => {
      btn.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        const idx = Number(btn.dataset.remove);
        try { await OrbmentApi.remove(this._itemUuid, idx); await this._refresh(); }
        catch (e) { ui.notifications?.error(e.message); }
      });
    });
    const charge = this._root.querySelector(".fu-orb-charge input");
    if (charge) charge.addEventListener("change", (ev) => { this._chargeZenit = !!ev.target.checked; this._render(this._data); });

    // Category tabs (right column).
    this._root.querySelectorAll(".fu-orb-tab").forEach((el) => {
      el.addEventListener("click", () => { this._activeTab = el.dataset.tab; this._render(this._data); });
    });

    // Confirm / Cancel (commit or clear the staged augment).
    const confirmBtn = this._root.querySelector(".fu-orb-btn-confirm");
    if (confirmBtn) confirmBtn.addEventListener("click", async () => {
      const st = this._staged;
      if (!st) return;
      try {
        await OrbmentApi.install(this._itemUuid, this._selectedSlot, st.id, { param: st.param, deductZenit: this._chargeZenit });
        this._staged = null; this._picking = null;
        await this._refresh();
      } catch (e) { ui.notifications?.error(e.message); }
    });
    const cancelBtn = this._root.querySelector(".fu-orb-btn-cancel");
    if (cancelBtn) cancelBtn.addEventListener("click", () => { this._staged = null; this._picking = null; this._render(this._data); });

    // Back out of the picker.
    const back = this._root.querySelector(".fu-orb-back");
    if (back) back.addEventListener("click", () => { this._picking = null; this._render(this._data); });

    // Picker MODE: choosing an option STAGES the augment (with its param).
    if (this._picking) {
      this._root.querySelectorAll("[data-opt]").forEach((el) => {
        el.addEventListener("click", () => {
          const pick = this._picking;
          const opt = pick.options.find((o) => o.value === el.dataset.opt);
          this._staged = { id: pick.id, param: el.dataset.opt, label: `${pick.label}: ${opt?.label ?? el.dataset.opt}`, icon: opt?.icon || pick.icon, cost: pick.cost };
          this._picking = null;
          this._render(this._data);
        });
      });
      return;
    }

    // Catalog MODE: simple augments STAGE directly; parameterized open the picker.
    this._root.querySelectorAll(".fu-orb-aug").forEach((el) => {
      if (el.classList.contains("is-installed")) return;
      if (el.dataset.pending === "1") {
        el.addEventListener("click", () => ui.notifications?.info("This augment is in the catalog but its automation isn't wired yet."));
        return;
      }
      const entry = (this._data.available || []).find((a) => a.id === el.dataset.aug);
      if (!entry) return;
      if (el.dataset.param === "1") {
        el.addEventListener("click", () => {
          if (!entry.param) return;
          this._picking = { id: entry.id, label: entry.label, icon: entry.icon, cost: entry.cost, prompt: entry.param.prompt, options: entry.param.options };
          this._render(this._data);
        });
        return;
      }
      el.addEventListener("click", () => {
        this._staged = { id: entry.id, param: null, label: entry.label, icon: entry.icon, cost: entry.cost };
        this._render(this._data);
      });
    });
  }

  _makeDraggable(handle) {
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    handle.addEventListener("mousedown", (e) => {
      if (e.target.closest(".fu-orb-x")) return;
      dragging = true;
      const r = this._root.getBoundingClientRect();
      // Switch to absolute left/top so drag is free of the translateX centering.
      this._root.style.left = `${r.left}px`; this._root.style.top = `${r.top}px`; this._root.style.transform = "none";
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      this._root.style.left = `${ox + (e.clientX - sx)}px`;
      this._root.style.top  = `${oy + (e.clientY - sy)}px`;
    });
    window.addEventListener("mouseup", () => { dragging = false; });
  }
}
