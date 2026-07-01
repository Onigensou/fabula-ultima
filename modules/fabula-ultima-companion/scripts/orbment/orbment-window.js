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
        --ptop:#f6f1e6; --pbot:#ebe3d0; --stroke:#7a6a55; --ink:#3a3228;
        --gold:#a07a28; --gold-lite:#c9a24a; --hi:#FFBB55; --brown:87,58,33;
        --cell-top:#f6ebd3; --cell-bot:#e7d3b1;
        position: fixed; top: 12vh; left: 50%; transform: translateX(-50%);
        width: 620px; max-width: 92vw; max-height: 78vh; overflow: hidden;
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
      #${WIN_ID} .fu-orb-body { padding: 12px 14px; overflow-y: auto; }
      #${WIN_ID} .fu-orb-slots { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
      #${WIN_ID} .fu-orb-slot {
        flex: 1 1 160px; min-height: 66px; border-radius: 10px; padding: 8px 10px;
        border: 2px solid rgba(var(--brown),.5);
        background: radial-gradient(120% 80% at 50% 0%, rgba(255,255,255,.4) 0%, transparent 40%),
          linear-gradient(180deg, var(--cell-top) 0%, var(--cell-bot) 100%);
        box-shadow: inset 0 1px 0 rgba(255,255,255,.5), 0 3px 8px rgba(0,0,0,.12);
        cursor: pointer; transition: filter .1s ease, border-color .12s ease, box-shadow .12s ease; position: relative;
      }
      #${WIN_ID} .fu-orb-slot:hover { filter: brightness(1.04); }
      #${WIN_ID} .fu-orb-slot.is-selected {
        border-color: var(--hi);
        box-shadow: inset 0 1px 0 rgba(255,255,255,.6), 0 0 0 2px rgba(255,187,85,.3), 0 3px 8px rgba(0,0,0,.15);
      }
      #${WIN_ID} .fu-orb-slot .lbl { font-size: 10px; font-weight: 700; color: var(--gold); text-transform: uppercase; letter-spacing: .6px; }
      #${WIN_ID} .fu-orb-slot .aug { font-size: 15px; font-weight: 800; margin-top: 3px; color: var(--ink); }
      #${WIN_ID} .fu-orb-slot .sum { font-size: 11px; color: var(--ink); opacity: .7; margin-top: 2px; }
      #${WIN_ID} .fu-orb-slot .rm {
        position: absolute; top: 6px; right: 6px; border: 1px solid rgba(var(--brown),.3); border-radius: 6px;
        background: rgba(var(--brown),.12); color: var(--ink); cursor: pointer; font-size: 11px; padding: 1px 6px; line-height: 1.3;
        transition: all .12s ease;
      }
      #${WIN_ID} .fu-orb-slot .rm:hover { background: #e35151; border-color: #e35151; color: #fff8e7; }
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
        border: 2px solid rgba(var(--brown),.4);
        background: linear-gradient(180deg, var(--cell-top), var(--cell-bot));
        box-shadow: inset 0 1px 0 rgba(255,255,255,.45);
        cursor: pointer; margin-bottom: 6px; transition: filter .1s ease, border-color .12s ease, box-shadow .12s ease;
      }
      #${WIN_ID} .fu-orb-aug:hover { filter: brightness(1.04); border-color: var(--hi); box-shadow: 0 0 0 2px rgba(255,187,85,.28), 0 3px 8px rgba(0,0,0,.14); }
      #${WIN_ID} .fu-orb-aug.is-installed { opacity: .45; filter: grayscale(.4); cursor: not-allowed; }
      #${WIN_ID} .fu-orb-aug.is-installed:hover { border-color: rgba(var(--brown),.4); box-shadow: inset 0 1px 0 rgba(255,255,255,.45); filter: grayscale(.4); }
      #${WIN_ID} .fu-orb-aug .ic { font-size: 20px; width: 26px; text-align: center; }
      #${WIN_ID} .fu-orb-aug .meta { flex: 1; }
      #${WIN_ID} .fu-orb-aug .meta .nm { font-weight: 800; font-size: 14px; color: var(--ink); }
      #${WIN_ID} .fu-orb-aug .meta .sm { font-size: 11px; color: var(--ink); opacity: .72; }
      #${WIN_ID} .fu-orb-aug .cost { font-size: 12px; font-weight: 700; color: var(--gold); white-space: nowrap; }
      #${WIN_ID} .fu-orb-link { font-size: 11px; color: var(--ink); opacity: .7; font-style: italic; margin: 4px 0 2px; }
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

  _render(data) {
    const installedIds = new Set(data.slots.filter(Boolean).map((s) => s.id));
    const slotsHtml = data.slots.map((s, i) => {
      const sel = i === this._selectedSlot ? "is-selected" : "";
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

    const augHtml = data.available.map((a) => {
      const installed = installedIds.has(a.id) ? "is-installed" : "";
      return `<div class="fu-orb-aug ${installed}" data-aug="${esc(a.id)}">
        <div class="ic">${esc(a.icon)}</div>
        <div class="meta"><div class="nm">${esc(a.label)}</div><div class="sm">${esc(a.summary)}</div></div>
        <div class="cost">${a.cost} z</div>
      </div>`;
    }).join("");

    const linkNote = (data.linkGroup?.length > 1)
      ? `<div class="fu-orb-link">🔗 Linked group: changes mirror to ${data.linkGroup.length} items (transform weapon).</div>`
      : "";

    this._root.innerHTML = `
      <div class="fu-orb-header">
        <div style="font-size:20px">🔮</div>
        <div class="fu-orb-title">${esc(data.itemName)}
          <div class="fu-orb-sub">${esc(data.itemType)} • ${esc(data.rarity || "—")} • ${data.slotCount} slot${data.slotCount === 1 ? "" : "s"}</div>
        </div>
        <button class="fu-orb-x" title="Close">✕</button>
      </div>
      <div class="fu-orb-body">
        <div class="fu-orb-sectionhdr">Slots</div>
        <div class="fu-orb-slots">${slotsHtml}</div>
        ${linkNote}
        <div class="fu-orb-sectionhdr">Available Augments — click to install into selected slot</div>
        ${augHtml || `<div style="opacity:.6">No augments apply to this item type.</div>`}
      </div>`;
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
    this._root.querySelectorAll(".fu-orb-aug").forEach((el) => {
      if (el.classList.contains("is-installed")) return;
      el.addEventListener("click", async () => {
        try { await OrbmentApi.install(this._itemUuid, this._selectedSlot, el.dataset.aug); await this._refresh(); }
        catch (e) { ui.notifications?.error(e.message); }
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
