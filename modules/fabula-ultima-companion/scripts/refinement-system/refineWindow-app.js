// scripts/refinement-system/refineWindow-app.js
//
// Two-panel refinement window (custom draggable DOM overlay, not Foundry Dialog).
//
// Left  — inventory grid: player's weapon/armor/shield items, draggable.
// Right — refinement panel: drop target (center), refiner portrait (right),
//         stats, refine button, confirmation overlay.
//
// Sounds: shopOpen on open, tabSwitch on tab change, itemSelect on grid click,
//         cancel on close, refine_success / refine_failed on result.

const WIN_ID   = "fu-refine-window";
const STYLE_ID = "fu-refine-window-style";

const SFX = {
  open:      "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Shop_Open.wav",
  tabSwitch: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_1.wav",
  itemSel:   "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_4.wav",
  cancel:    "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_2.wav",
  success:   "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/refine_success.mp3",
  failure:   "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/refine_failed.mp3",
  break:     "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/refine_break.mp3",
};

const VOL = { open: 0.65, tabSwitch: 0.55, itemSel: 0.45, cancel: 0.55, result: 0.75 };

const GP_ICON = `<img class="fu-zenit-icon" src="https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/GP.png" alt="z">`;

const REFINE_CATS = [
  { key: "weapon", emoji: "⚔️", label: "Weapon" },
  { key: "armor",  emoji: "🥋", label: "Armor"  },
  { key: "shield", emoji: "🛡️", label: "Shield" },
];

let _instance = null;

export class RefineWindowApp {

  static open(blacksmithActorUuid) {
    if (_instance) {
      _instance.setBlacksmith(blacksmithActorUuid);
      _instance._focus();
      return _instance;
    }
    _instance = new RefineWindowApp(blacksmithActorUuid);
    _instance._build();
    return _instance;
  }

  static close() { _instance?._destroy(); }

  constructor(blacksmithActorUuid) {
    this._blacksmithUuid  = blacksmithActorUuid;
    this._blacksmithActor = null;
    this._playerActor     = null;
    this._selectedItem    = null;
    this._activeCategory  = "weapon";
    this._skipConfirm     = false;
    this._busy            = false;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  static _esc(v) {
    return String(v ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;")
      .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }

  static _gp(obj, path, fb) {
    try { return foundry.utils.getProperty(obj, path) ?? fb; } catch { return fb; }
  }

  _itemType(item)   { return String(RefineWindowApp._gp(item, "system.props.item_type", "") ?? "").toLowerCase(); }
  _refineLevel(item){ return Math.max(0, Number(RefineWindowApp._gp(item, "system.props.refine_level", 0) ?? 0)); }
  _damageBonus(item){ return Number(RefineWindowApp._gp(item, "system.props.damage_bonus", 0) ?? 0); }
  _zenit(actor)     { return Math.max(0, Number(RefineWindowApp._gp(actor, "system.props.zenit", 0) ?? 0)); }

  _rateLabel(rate) {
    if (rate >= 50) return { label: "High",   cls: "fu-rate-high"   };
    if (rate >= 25) return { label: "Medium", cls: "fu-rate-medium" };
    return               { label: "Low",    cls: "fu-rate-low"    };
  }

  _api()            { return game.modules.get("fabula-ultima-companion")?.api?.refinement; }
  _canRefineApi(item)    { return this._api()?.canRefine(item)      ?? { allowed: false, reason: "API not loaded" }; }
  _successRateApi(item)  { return this._api()?.getSuccessRate(item) ?? 0; }
  _maxLevelApi(item)     { return this._api()?.getMaxRefineLevel(item) ?? 0; }
  _costApi(item)         { return this._api()?.getCost(item) ?? 250; }

  _playerItems()         { return (this._playerActor?.items.contents ?? []).filter(i => REFINE_CATS.some(c => c.key === this._itemType(i))); }
  _itemsForCategory(cat) { return this._playerItems().filter(i => this._itemType(i) === cat); }

  _npcImg() {
    return this._blacksmithActor?.prototypeToken?.texture?.src
        ?? this._blacksmithActor?.img
        ?? "icons/svg/mystery-man.svg";
  }
  _npcName() { return this._blacksmithActor?.name ?? "Blacksmith"; }

  // ── Build ─────────────────────────────────────────────────────────────────
  async _build() {
    this._injectStyles();
    this._blacksmithActor = await fromUuid(this._blacksmithUuid).catch(() => null);
    this._playerActor     = game.user.character ?? null;

    const el = document.createElement("div");
    el.id = WIN_ID;
    el.innerHTML = this._html();
    document.body.appendChild(el);

    this._makeDraggable(el.querySelector(".fu-rw-titlebar"), el);
    this._wireEvents(el);
    this._refreshInventory(el);
    this._refreshStats(el);

    requestAnimationFrame(() => el.classList.add("is-open"));
    this._playSound(SFX.open, VOL.open);
  }

  async setBlacksmith(uuid) {
    if (uuid === this._blacksmithUuid) return;
    this._blacksmithUuid  = uuid;
    this._blacksmithActor = await fromUuid(uuid).catch(() => null);
    this._selectedItem    = null;
    const el = document.getElementById(WIN_ID);
    if (!el) return;
    el.querySelector(".fu-rw-npc-portrait").src        = this._npcImg();
    el.querySelector(".fu-rw-npc-portrait").alt        = this._npcName();
    el.querySelector(".fu-rw-npc-name").textContent    = this._npcName();
    el.querySelector(".fu-rw-title").textContent       = `⚒️ Blacksmith — ${this._npcName()}`;
    this._refreshDropZone(el);
    this._refreshStats(el);
  }

  // ── HTML ──────────────────────────────────────────────────────────────────
  _html() {
    const npcImg    = RefineWindowApp._esc(this._npcImg());
    const npcName   = RefineWindowApp._esc(this._npcName());
    const plrName   = RefineWindowApp._esc(this._playerActor?.name ?? "");
    const zenit     = this._playerActor ? this._zenit(this._playerActor).toLocaleString() : "—";
    const catTabs   = REFINE_CATS.map(c => `
      <button type="button" class="fu-rw-cat-tab${c.key === this._activeCategory ? " active" : ""}"
              data-cat="${c.key}" title="${c.label}">${c.emoji}</button>`).join("");

    return `
      <div class="fu-rw-titlebar">
        <span class="fu-rw-title">⚒️ Blacksmith — ${npcName}</span>
        <button type="button" class="fu-rw-close" title="Close">✕</button>
      </div>
      <div class="fu-rw-body">

        <!-- LEFT: inventory picker -->
        <div class="fu-rw-left">
          <div class="fu-rw-left-header">
            <span class="fu-rw-player-name">${plrName}</span>
            <span class="fu-rw-player-zenit">${GP_ICON} ${zenit}</span>
          </div>
          <div class="fu-rw-cat-tabs">${catTabs}</div>
          <div class="fu-rw-grid-wrap"><div class="fu-rw-grid"></div></div>
          <div class="fu-rw-item-preview">
            <div class="fu-rw-preview-placeholder">Click an item to preview</div>
          </div>
        </div>

        <!-- RIGHT: refinement panel -->
        <div class="fu-rw-right">

          <!-- drop zone (center) + NPC portrait (right) -->
          <div class="fu-rw-targets">
            <div class="fu-rw-drop-zone" id="fu-rw-drop-zone">
              <div class="fu-rw-drop-placeholder">
                <div class="fu-rw-drop-icon">⚒️</div>
                <div class="fu-rw-drop-hint">Drag equipment<br>here</div>
              </div>
              <img class="fu-rw-drop-item-img" src="" style="display:none" alt="">
              <div class="fu-rw-drop-item-name"></div>
            </div>
            <div class="fu-rw-npc-wrap">
              <img class="fu-rw-npc-portrait" src="${npcImg}" alt="${npcName}">
              <div class="fu-rw-npc-name">${npcName}</div>
            </div>
          </div>

          <!-- stats -->
          <div class="fu-rw-stats">
            <div class="fu-rw-stats-placeholder">Drop an item to see refinement info</div>
            <table class="fu-rw-stats-table" style="display:none">
              <tr><td class="fu-sl">Item</td>        <td class="fu-sv" id="fu-rs-name">—</td></tr>
              <tr><td class="fu-sl">Level</td>       <td class="fu-sv" id="fu-rs-level">—</td></tr>
              <tr><td class="fu-sl">Success Rate</td><td class="fu-sv" id="fu-rs-rate">—</td></tr>
              <tr><td class="fu-sl">Cost</td>        <td class="fu-sv" id="fu-rs-cost">—</td></tr>
              <tr><td class="fu-sl">Your Zenit</td>  <td class="fu-sv" id="fu-rs-zenit">—</td></tr>
              <tr><td class="fu-sl">After Cost</td>  <td class="fu-sv" id="fu-rs-after">—</td></tr>
            </table>
          </div>

          <!-- actions -->
          <div class="fu-rw-actions">
            <button type="button" class="fu-rw-refine-btn" id="fu-rw-refine-btn" disabled>⚒️ Refine</button>
            <label class="fu-rw-skip-label">
              <input type="checkbox" id="fu-rw-skip-confirm" ${this._skipConfirm ? "checked" : ""}>
              Skip confirmation
            </label>
          </div>

        </div>
      </div>

      <!-- confirmation overlay (inside window, absolute) -->
      <div class="fu-rw-confirm-overlay" id="fu-rw-confirm-overlay">
        <div class="fu-rw-confirm-popup">
          <div class="fu-rw-confirm-title">Confirm Refinement?</div>
          <div class="fu-rw-confirm-info" id="fu-rw-confirm-info"></div>
          <div class="fu-rw-confirm-btns">
            <button type="button" class="fu-rw-confirm-yes" id="fu-rw-confirm-yes">✔ Refine</button>
            <button type="button" class="fu-rw-confirm-no"  id="fu-rw-confirm-no">✕ Cancel</button>
          </div>
        </div>
      </div>
    `;
  }

  // ── Events ────────────────────────────────────────────────────────────────
  _wireEvents(el) {
    el.querySelector(".fu-rw-close").addEventListener("click", () => {
      this._playSound(SFX.cancel, VOL.cancel);
      this._destroy();
    });

    el.querySelectorAll(".fu-rw-cat-tab").forEach(btn => {
      btn.addEventListener("click", () => {
        if (btn.classList.contains("active")) return;
        this._activeCategory = btn.dataset.cat;
        el.querySelectorAll(".fu-rw-cat-tab").forEach(b =>
          b.classList.toggle("active", b.dataset.cat === this._activeCategory));
        this._refreshInventory(el);
        this._playSound(SFX.tabSwitch, VOL.tabSwitch);
      });
    });

    const dz = el.querySelector("#fu-rw-drop-zone");
    dz.addEventListener("dragover",  (e) => { e.preventDefault(); dz.classList.add("drag-over"); });
    dz.addEventListener("dragleave", ()  => dz.classList.remove("drag-over"));
    dz.addEventListener("drop",      (e) => { e.preventDefault(); dz.classList.remove("drag-over"); this._onDropItem(e, el); });

    el.querySelector("#fu-rw-refine-btn").addEventListener("click", () => {
      if (this._busy || !this._selectedItem) return;
      if (this._skipConfirm) {
        this._executeRefine(el);
      } else {
        this._showConfirmOverlay(el, true);
      }
    });

    el.querySelector("#fu-rw-confirm-yes").addEventListener("click", () => {
      this._showConfirmOverlay(el, false);
      this._executeRefine(el);
    });
    el.querySelector("#fu-rw-confirm-no").addEventListener("click", () => {
      this._showConfirmOverlay(el, false);
      this._playSound(SFX.cancel, VOL.cancel);
    });

    el.querySelector("#fu-rw-skip-confirm").addEventListener("change", (e) => {
      this._skipConfirm = e.target.checked;
    });
  }

  _onDropItem(e, el) {
    let data;
    try { data = JSON.parse(e.dataTransfer.getData("text/plain")); } catch { return; }

    const actor = this._playerActor;
    if (!actor) return;

    let item = null;
    const uuid = data?.uuid ?? null;
    if (uuid) {
      const parts = uuid.split(".Item.");
      if (parts.length === 2) item = actor.items.get(parts[1]) ?? null;
    }
    if (!item && data?.id) item = actor.items.get(data.id) ?? null;

    if (!item) { ui.notifications?.warn("Could not resolve dropped item."); return; }

    if (!REFINE_CATS.some(c => c.key === this._itemType(item))) {
      ui.notifications?.warn(`${item.name} cannot be refined (weapon / armor / shield only).`);
      return;
    }

    const check = this._canRefineApi(item);
    if (!check.allowed) { ui.notifications?.warn(check.reason); return; }

    this._selectedItem = item;
    this._refreshDropZone(el);
    this._refreshStats(el);
    this._playSound(SFX.itemSel, VOL.itemSel);
  }

  // ── Inventory grid ────────────────────────────────────────────────────────
  _refreshInventory(el = document.getElementById(WIN_ID)) {
    if (!el) return;
    const grid  = el.querySelector(".fu-rw-grid");
    const items = this._itemsForCategory(this._activeCategory);

    if (!items.length) {
      grid.innerHTML = `<div class="fu-rw-empty">No ${this._activeCategory}s to refine</div>`;
      return;
    }

    grid.innerHTML = items.map(item => {
      const check    = this._canRefineApi(item);
      const level    = this._refineLevel(item);
      const max      = this._maxLevelApi(item);
      const isMax    = !check.allowed && level >= max && max > 0;
      const cls      = "fu-rw-slot" + (isMax ? " fu-rw-slot-maxed" : "");
      const img      = RefineWindowApp._esc(item.img ?? "icons/svg/mystery-man.svg");
      const name     = RefineWindowApp._esc(item.name ?? "");
      const badge    = level > 0 ? `<div class="fu-rw-level-badge">+${level}</div>` : "";
      return `<div class="${cls}" draggable="${!isMax}" data-item-id="${item.id}"
                   data-item-uuid="${RefineWindowApp._esc(item.uuid)}" title="${name}">
                <img src="${img}" alt="${name}">${badge}
              </div>`;
    }).join("");

    grid.querySelectorAll(".fu-rw-slot[draggable='true']").forEach(slot => {
      slot.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/plain", JSON.stringify({ id: slot.dataset.itemId, uuid: slot.dataset.itemUuid }));
        slot.classList.add("fu-rw-dragging");
      });
      slot.addEventListener("dragend", () => slot.classList.remove("fu-rw-dragging"));
      slot.addEventListener("click", () => {
        this._previewItem(slot.dataset.itemId, el);
        this._playSound(SFX.itemSel, VOL.itemSel);
      });
    });
  }

  _previewItem(itemId, el) {
    if (!this._playerActor) return;
    const item = this._playerActor.items.get(itemId);
    if (!item) return;
    const pane   = el.querySelector(".fu-rw-item-preview");
    const check  = this._canRefineApi(item);
    const level  = this._refineLevel(item);
    const max    = this._maxLevelApi(item);
    const rarity = String(RefineWindowApp._gp(item, "system.props.item_rarity", "—") ?? "—");
    pane.innerHTML = `
      <div class="fu-rw-preview-header">
        <img class="fu-rw-preview-icon" src="${RefineWindowApp._esc(item.img ?? "")}" alt="">
        <div>
          <div class="fu-rw-preview-name">${RefineWindowApp._esc(item.name ?? "")}</div>
          <div class="fu-rw-preview-sub">${RefineWindowApp._esc(rarity)} · +${level}/${max} · DMG ${this._damageBonus(item)}</div>
        </div>
      </div>
      <div class="fu-rw-preview-status ${check.allowed ? "ok" : "no"}">
        ${check.allowed ? "✔ Can refine" : `✗ ${RefineWindowApp._esc(check.reason)}`}
      </div>`;
  }

  // ── Drop zone display ─────────────────────────────────────────────────────
  _refreshDropZone(el = document.getElementById(WIN_ID)) {
    if (!el) return;
    const ph   = el.querySelector(".fu-rw-drop-placeholder");
    const img  = el.querySelector(".fu-rw-drop-item-img");
    const name = el.querySelector(".fu-rw-drop-item-name");
    if (this._selectedItem) {
      ph.style.display  = "none";
      img.src           = this._selectedItem.img ?? "";
      img.style.display = "block";
      name.textContent  = this._selectedItem.name ?? "";
    } else {
      ph.style.display  = "";
      img.style.display = "none";
      img.src           = "";
      name.textContent  = "";
    }
  }

  // ── Stats panel ───────────────────────────────────────────────────────────
  _refreshStats(el = document.getElementById(WIN_ID)) {
    if (!el) return;
    const ph    = el.querySelector(".fu-rw-stats-placeholder");
    const table = el.querySelector(".fu-rw-stats-table");
    const btn   = el.querySelector("#fu-rw-refine-btn");

    if (!this._selectedItem || !this._playerActor) {
      ph.style.display    = "";
      table.style.display = "none";
      btn.disabled = true;
      return;
    }

    const item      = this._selectedItem;
    const level     = this._refineLevel(item);
    const max       = this._maxLevelApi(item);
    const rate      = this._successRateApi(item);
    const cost      = this._costApi(item);
    const zenit     = this._zenit(this._playerActor);
    const after     = zenit - cost;
    const canAfford = zenit >= cost;
    const check     = this._canRefineApi(item);

    ph.style.display    = "none";
    table.style.display = "";

    el.querySelector("#fu-rs-name").textContent  = item.name ?? "—";
    el.querySelector("#fu-rs-level").textContent = `+${level} → +${level + 1} (max +${max})`;
    const { label: rLabel, cls: rCls } = this._rateLabel(rate);
    el.querySelector("#fu-rs-rate").innerHTML = `<span class="${rCls}">${rLabel}</span>`;
    el.querySelector("#fu-rs-cost").innerHTML    = `${GP_ICON} ${cost.toLocaleString()}`;
    el.querySelector("#fu-rs-zenit").innerHTML   = `${GP_ICON} ${zenit.toLocaleString()}`;

    const afterEl = el.querySelector("#fu-rs-after");
    afterEl.innerHTML = `${GP_ICON} ${after.toLocaleString()}`;
    afterEl.classList.toggle("fu-stat-insufficient", !canAfford);

    btn.disabled = this._busy || !check.allowed || !canAfford;
  }

  // ── Confirmation overlay (pops on top of the right panel) ────────────────
  _showConfirmOverlay(el, show) {
    const overlay = el.querySelector("#fu-rw-confirm-overlay");
    if (show && this._selectedItem) {
      const cost = this._costApi(this._selectedItem);
      const info = el.querySelector("#fu-rw-confirm-info");
      info.innerHTML = `<span>${RefineWindowApp._esc(this._selectedItem.name)}</span><br>${GP_ICON} ${cost.toLocaleString()} zenit will be consumed`;
    }
    overlay.classList.toggle("is-visible", show);
  }

  // ── Execute refine ────────────────────────────────────────────────────────
  async _executeRefine(el = document.getElementById(WIN_ID)) {
    if (this._busy || !this._selectedItem || !this._playerActor) return;
    const api = this._api();
    if (!api) { ui.notifications?.error("Refinement API not loaded."); return; }

    this._busy = true;
    el?.querySelector("#fu-rw-refine-btn")?.setAttribute("disabled", "");

    const itemUuid         = this._selectedItem.uuid;
    const actorUuid        = this._playerActor.uuid;
    const refinerActorUuid = this._blacksmithActor?.uuid ?? null;

    try {
      const result = await api.refine({ itemUuid, actorUuid, refinerActorUuid });

      const outcome = result?.result?.outcome;
      if (result?.ok && outcome === "success") {
        this._playSound(SFX.success, VOL.result);
        this._animatePortrait(el, "success");
      } else if (result?.ok && outcome === "break") {
        this._playSound(SFX.break, VOL.result);
        this._animatePortrait(el, "break");
      } else {
        this._playSound(SFX.failure, VOL.result);
        this._animatePortrait(el, "failure");
        if (!result?.ok) ui.notifications?.warn(result?.reason ?? "Refinement could not proceed.");
      }

      // Refresh live references
      this._playerActor = game.actors?.get(this._playerActor.id) ?? this._playerActor;
      if (this._selectedItem) {
        this._selectedItem = this._playerActor.items.get(this._selectedItem.id) ?? this._selectedItem;
      }

      this._refreshDropZone(el);
      this._refreshStats(el);   // re-enables button if item can still be refined
      this._refreshInventory(el);
      this._updateZenitDisplay(el);

    } catch (e) {
      console.error("[FU][RefineWindow]", e);
      ui.notifications?.error("An error occurred during refinement.");
    } finally {
      this._busy = false;
      // Re-evaluate button state after busy clears
      this._refreshStats(el);
    }
  }

  _updateZenitDisplay(el = document.getElementById(WIN_ID)) {
    if (!el || !this._playerActor) return;
    el.querySelector(".fu-rw-player-zenit").innerHTML =
      `${GP_ICON} ${this._zenit(this._playerActor).toLocaleString()}`;
  }

  // ── Sound & animation ─────────────────────────────────────────────────────
  _playSound(src, volume = 0.6) {
    try { AudioHelper.play({ src, volume, autoplay: true, loop: false }, false); } catch {}
  }

  _animatePortrait(el, type) {
    if (!el) return;
    const p   = el.querySelector(".fu-rw-npc-portrait");
    if (!p) return;
    const cls = type === "success" ? "fu-rw-anim-bounce"
              : type === "break"   ? "fu-rw-anim-break"
              :                      "fu-rw-anim-shake";
    p.classList.remove("fu-rw-anim-bounce", "fu-rw-anim-shake", "fu-rw-anim-break");
    void p.offsetWidth;
    p.classList.add(cls);
    p.addEventListener("animationend", () => p.classList.remove(cls), { once: true });
  }

  // ── Draggable titlebar ────────────────────────────────────────────────────
  _makeDraggable(handle, win) {
    let ox = 0, oy = 0, mx = 0, my = 0;
    handle.style.cursor = "grab";
    handle.addEventListener("mousedown", (e) => {
      if (e.target.classList.contains("fu-rw-close")) return;
      e.preventDefault();
      mx = e.clientX; my = e.clientY;
      // getBoundingClientRect captures the actual rendered position including CSS transform,
      // so the first drag doesn't jump when the window is centered via translate(-50%, -50%).
      const rect = win.getBoundingClientRect();
      ox = rect.left; oy = rect.top;
      handle.style.cursor = "grabbing";
      const onMove = (ev) => {
        win.style.left      = `${ox + ev.clientX - mx}px`;
        win.style.top       = `${oy + ev.clientY - my}px`;
        win.style.transform = "none";
      };
      const onUp = () => {
        handle.style.cursor = "grab";
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup",   onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup",   onUp);
    });
  }

  _focus() { document.getElementById(WIN_ID)?.classList.add("fu-rw-focused"); }

  _destroy() {
    const el = document.getElementById(WIN_ID);
    if (el) {
      el.classList.remove("is-open");
      setTimeout(() => { el.remove(); document.getElementById(STYLE_ID)?.remove(); }, 220);
    } else {
      document.getElementById(STYLE_ID)?.remove();
    }
    _instance = null;
  }

  // ── Styles ────────────────────────────────────────────────────────────────
  _injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `

/* ════════════════════════════════════════════════
   Window shell — earth-tone parchment palette
   ════════════════════════════════════════════════ */
#${WIN_ID} {
  position: fixed;
  top: 50%; left: 50%;
  transform: translate(-50%, calc(-50% + 18px));
  opacity: 0;
  transition:
    opacity   0.22s cubic-bezier(.2,.9,.2,1),
    transform 0.22s cubic-bezier(.2,.9,.2,1);
  width: 680px;
  background: #e8dfc8;
  border: 2px solid #7a5c38;
  border-radius: 12px;
  box-shadow: 0 22px 64px rgba(0,0,0,0.52), 0 0 0 1px rgba(122,92,56,0.25);
  font-family: inherit;
  color: #2c1a0a;
  z-index: 9999;
  display: flex; flex-direction: column;
  max-height: 90vh;
  overflow: hidden;
}
#${WIN_ID}.is-open {
  opacity: 1;
  transform: translate(-50%, -50%);
}
#${WIN_ID}:not(.is-open) {
  opacity: 0;
  transform: translate(-50%, calc(-50% + 18px));
}

/* ── Title bar ── */
.fu-rw-titlebar {
  display: flex; align-items: center; justify-content: space-between;
  padding: 7px 12px 7px 14px;
  background: linear-gradient(to bottom, #7a5535, #5a3818);
  border-bottom: 2px solid #7a5535;
  border-radius: 10px 10px 0 0;
  flex-shrink: 0;
}
.fu-rw-title {
  font-size: 13px; font-weight: 800;
  color: #f5e8cc; text-shadow: 0 1px 3px rgba(0,0,0,0.6);
}
.fu-rw-close {
  width: 20px; height: 20px;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.15);
  border-radius: 4px; cursor: pointer; color: #f5e8cc;
  font-size: 10px; font-weight: 900; line-height: 1;
  padding: 0; transition: background 0.12s, color 0.12s;
}
.fu-rw-close:hover { background: rgba(160,48,32,0.75); color: #fff; }

/* ── Body: two panels ── */
.fu-rw-body { display: flex; flex: 1; overflow: hidden; min-height: 0; }

/* ══ LEFT PANEL ══ */
.fu-rw-left {
  display: flex; flex-direction: column;
  width: 260px; flex-shrink: 0;
  border-right: 2px solid #7a5c38;
  background: #ddd3b8;
  overflow: hidden;
}
.fu-rw-left-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 7px 10px;
  background: linear-gradient(to bottom, #d4c8a8, #c8bc96);
  border-bottom: 1px solid rgba(122,92,56,0.45);
  flex-shrink: 0;
}
.fu-rw-player-name  { font-size: 11px; font-weight: 700; color: #4a2f10; }
.fu-rw-player-zenit {
  font-size: 11px; font-weight: 700; color: #4a2f10;
  display: flex; align-items: center; gap: 3px;
}
.fu-zenit-icon {
  width: 14px; height: 14px; object-fit: contain; vertical-align: middle;
  border: none !important; box-shadow: none !important; background: transparent;
}

/* category tabs */
.fu-rw-cat-tabs {
  display: flex; gap: 2px; padding: 5px 5px 4px;
  background: #c8bc96; border-bottom: 2px solid #7a5c38; flex-shrink: 0;
}
.fu-rw-cat-tab {
  flex: 1; height: 30px; border-radius: 6px; font-size: 15px;
  border: 1px solid transparent; background: transparent;
  cursor: pointer; display: flex; align-items: center; justify-content: center;
  transition: background 0.1s, border-color 0.1s;
}
.fu-rw-cat-tab:hover { background: rgba(90,56,24,0.18); border-color: rgba(90,56,24,0.3); }
.fu-rw-cat-tab.active {
  background: #7a5535; border-color: #5a3818;
  box-shadow: inset 0 1px 2px rgba(0,0,0,0.3);
}

/* grid */
.fu-rw-grid-wrap { flex: 1; overflow-y: auto; padding: 7px; min-height: 80px; }
.fu-rw-grid-wrap::-webkit-scrollbar { width: 5px; }
.fu-rw-grid-wrap::-webkit-scrollbar-thumb { background: #7a5c38; border-radius: 3px; }
.fu-rw-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(52px, 1fr));
  gap: 5px;
}
.fu-rw-slot {
  position: relative; aspect-ratio: 1;
  border-radius: 7px; border: 2px solid rgba(122,92,56,0.3);
  background: rgba(255,255,255,0.5); overflow: hidden;
  cursor: grab; transition: border-color 0.1s, transform 0.08s, background 0.1s;
  user-select: none;
}
.fu-rw-slot:hover { border-color: #7a5c38; transform: translateY(-1px); background: rgba(255,255,255,0.75); }
.fu-rw-slot.fu-rw-slot-maxed { filter: saturate(0.35) brightness(0.7); cursor: default; }
.fu-rw-slot.fu-rw-dragging   { opacity: 0.4; }
.fu-rw-slot img { width: 100%; height: 100%; object-fit: contain; display: block; pointer-events: none; }
.fu-rw-level-badge {
  position: absolute; bottom: 1px; right: 2px;
  font-size: 9px; font-weight: 900; color: #ffe066;
  text-shadow: 0 1px 2px rgba(0,0,0,0.9); pointer-events: none; line-height: 1;
}
.fu-rw-empty {
  padding: 20px; text-align: center; font-style: italic;
  font-size: 12px; color: #5a3818; opacity: 0.6;
}

/* item preview strip */
.fu-rw-item-preview {
  flex-shrink: 0; min-height: 58px; max-height: 85px; overflow-y: auto;
  padding: 7px 10px; border-top: 2px solid #7a5c38;
  background: rgba(255,255,255,0.28); font-size: 11px; color: #4a2f10;
}
.fu-rw-item-preview::-webkit-scrollbar { width: 4px; }
.fu-rw-item-preview::-webkit-scrollbar-thumb { background: #7a5c38; border-radius: 3px; }
.fu-rw-preview-placeholder { font-style: italic; opacity: 0.5; font-size: 11px; }
.fu-rw-preview-header { display: flex; align-items: center; gap: 7px; margin-bottom: 3px; }
.fu-rw-preview-icon { width: 26px; height: 26px; object-fit: contain;
  border: 1px solid rgba(122,92,56,0.4); border-radius: 4px; background: rgba(255,255,255,0.4); }
.fu-rw-preview-name { font-weight: 700; font-size: 12px; color: #2c1a0a; }
.fu-rw-preview-sub  { font-size: 10px; color: #5a3818; opacity: 0.75; }
.fu-rw-preview-status { font-size: 11px; font-weight: 700; }
.fu-rw-preview-status.ok { color: #2a7a2a; }
.fu-rw-preview-status.no { color: #9a2a1a; }

/* ══ RIGHT PANEL ══ */
.fu-rw-right {
  flex: 1; display: flex; flex-direction: column;
  padding: 14px 16px; gap: 12px; overflow-y: auto;
  background: #e8dfc8; position: relative;
}
.fu-rw-right::-webkit-scrollbar { width: 5px; }
.fu-rw-right::-webkit-scrollbar-thumb { background: #7a5c38; border-radius: 3px; }

/* ── Targets row: drop zone (center) + NPC portrait (right) ── */
.fu-rw-targets {
  display: flex; align-items: center; justify-content: center; gap: 20px;
}

.fu-rw-drop-zone {
  width: 96px; height: 96px; flex-shrink: 0;
  border: 3px dashed rgba(122,92,56,0.5);
  border-radius: 12px; background: rgba(255,255,255,0.4);
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  position: relative; overflow: hidden;
  transition: border-color 0.15s, background 0.15s;
}
.fu-rw-drop-zone.drag-over {
  border-color: #7a5535; background: rgba(122,85,53,0.15);
  border-style: solid;
}
.fu-rw-drop-placeholder {
  display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 4px;
}
.fu-rw-drop-icon { font-size: 24px; opacity: 0.4; }
.fu-rw-drop-hint {
  font-size: 9px; font-weight: 700; color: #5a3818; opacity: 0.6;
  text-align: center; line-height: 1.4;
}
.fu-rw-drop-item-img {
  width: 100%; height: 100%; object-fit: contain;
  display: block; padding: 8px;
}
.fu-rw-drop-item-name {
  position: absolute; bottom: 0; left: 0; right: 0;
  font-size: 8px; font-weight: 700; color: #fff;
  background: rgba(0,0,0,0.55); text-align: center;
  padding: 2px 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

/* NPC portrait — full image, transparent bg, no crop */
.fu-rw-npc-wrap { display: flex; flex-direction: column; align-items: center; gap: 4px; }
.fu-rw-npc-portrait {
  width: 88px; height: 88px;
  object-fit: contain; object-position: bottom;
  background: transparent;
  border: none !important; outline: none; box-shadow: none !important; border-radius: 0;
  filter: drop-shadow(0 4px 8px rgba(0,0,0,0.35));
}
.fu-rw-npc-name {
  font-size: 10px; font-weight: 700; color: #4a2f10; text-align: center;
}

/* NPC portrait animations */
@keyframes fu-bounce {
  0%   { transform: translateY(0)     scale(1);     }
  22%  { transform: translateY(-14px) scale(1.09);  }
  42%  { transform: translateY(0)     scale(0.96);  }
  62%  { transform: translateY(-7px)  scale(1.04);  }
  82%  { transform: translateY(0)     scale(0.99);  }
  100% { transform: translateY(0)     scale(1);     }
}
@keyframes fu-shake {
  0%, 100% { transform: translateX(0)    rotate(0deg);   }
  15%       { transform: translateX(-7px) rotate(-5deg);  }
  30%       { transform: translateX(7px)  rotate(5deg);   }
  45%       { transform: translateX(-5px) rotate(-3deg);  }
  60%       { transform: translateX(5px)  rotate(3deg);   }
  80%       { transform: translateX(-2px) rotate(-1deg);  }
}
.fu-rw-anim-bounce { animation: fu-bounce 0.65s cubic-bezier(.36,.07,.19,.97); }
.fu-rw-anim-shake  { animation: fu-shake  0.55s cubic-bezier(.36,.07,.19,.97); }
.fu-rw-anim-break  { animation: fu-break  0.72s cubic-bezier(.36,.07,.19,.97); }

@keyframes fu-break {
  0%   { transform: translateY(0) scale(1);    filter: none; }
  15%  { transform: translateY(-6px) scale(1.06); filter: brightness(1.4) saturate(0.2); }
  30%  { transform: translateY(5px) scale(0.86);  filter: brightness(0.45) saturate(0) sepia(0.9); }
  50%  { transform: translateY(-3px) scale(0.96); filter: brightness(0.65); }
  70%  { transform: translateY(3px) scale(0.93);  filter: brightness(0.8); }
  100% { transform: translateY(0) scale(1);    filter: none; }
}

/* ── Stats table ── */
.fu-rw-stats {
  background: rgba(255,255,255,0.38); border-radius: 8px;
  border: 1px solid rgba(122,92,56,0.3); padding: 8px 10px;
}
.fu-rw-stats-placeholder {
  font-size: 12px; font-style: italic; color: #5a3818;
  opacity: 0.55; text-align: center; padding: 8px 0;
}
.fu-rw-stats-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.fu-sl { color: #5a3818; padding: 2px 6px 2px 0; white-space: nowrap; font-weight: 600; width: 40%; }
.fu-sv { color: #2c1a0a; font-weight: 700; padding: 2px 0; }
.fu-sv .fu-zenit-icon { width: 13px; height: 13px; }
.fu-stat-insufficient { color: #9a2a1a !important; }
.fu-rate-high   { color: #2a5acc; font-weight: 800; }
.fu-rate-medium { color: #2a7a2a; font-weight: 800; }
.fu-rate-low    { color: #9a2a1a; font-weight: 800; }

/* ── Actions ── */
.fu-rw-actions { display: flex; flex-direction: column; gap: 7px; }
.fu-rw-refine-btn {
  padding: 9px 16px; font-size: 13px; font-weight: 800;
  background: linear-gradient(to bottom, #7a5535, #4a2f14);
  color: #f5e8cc; border: 1px solid #5a3818;
  border-radius: 8px; cursor: pointer;
  box-shadow: 0 3px 8px rgba(0,0,0,0.3);
  transition: filter 0.12s, transform 0.08s;
  text-shadow: 0 1px 2px rgba(0,0,0,0.5);
}
.fu-rw-refine-btn:hover:not(:disabled)  { filter: brightness(1.12); transform: translateY(-1px); }
.fu-rw-refine-btn:active:not(:disabled) { transform: translateY(0); }
.fu-rw-refine-btn:disabled { filter: saturate(0.25) brightness(0.7); cursor: default; box-shadow: none; }

.fu-rw-skip-label {
  font-size: 10px; color: #5a3818; display: flex;
  align-items: center; gap: 5px; cursor: pointer; user-select: none; opacity: 0.7;
}
.fu-rw-skip-label:hover { opacity: 1; }
.fu-rw-skip-label input { cursor: pointer; margin: 0; }

/* ── Confirmation overlay (absolute, fills right panel) ── */
.fu-rw-confirm-overlay {
  position: absolute; inset: 0;
  background: rgba(30, 18, 6, 0.55);
  backdrop-filter: blur(2px);
  display: flex; align-items: center; justify-content: center;
  border-radius: 0 0 10px 0;
  opacity: 0; pointer-events: none;
  transition: opacity 0.18s cubic-bezier(.2,.9,.2,1);
  z-index: 10;
}
.fu-rw-confirm-overlay.is-visible {
  opacity: 1; pointer-events: auto;
}
.fu-rw-confirm-popup {
  background: #e8dfc8; border: 2px solid #7a5535;
  border-radius: 10px; padding: 16px 20px;
  box-shadow: 0 8px 28px rgba(0,0,0,0.45);
  display: flex; flex-direction: column; gap: 10px;
  min-width: 200px; text-align: center;
  transform: scale(0.9);
  transition: transform 0.18s cubic-bezier(.2,.9,.2,1);
}
.fu-rw-confirm-overlay.is-visible .fu-rw-confirm-popup { transform: scale(1); }
.fu-rw-confirm-title {
  font-size: 13px; font-weight: 800; color: #4a2f10;
  text-shadow: 0 1px 0 rgba(255,255,255,0.4);
}
.fu-rw-confirm-info {
  font-size: 11px; color: #5a3818; line-height: 1.5;
}
.fu-rw-confirm-info .fu-zenit-icon { width: 12px; height: 12px; }
.fu-rw-confirm-btns { display: flex; gap: 8px; }
.fu-rw-confirm-yes, .fu-rw-confirm-no {
  flex: 1; padding: 7px 10px; font-size: 12px; font-weight: 800;
  border-radius: 7px; cursor: pointer; border: 1px solid;
  transition: filter 0.12s;
}
.fu-rw-confirm-yes {
  background: linear-gradient(to bottom, #3a8a3a, #235523);
  color: #dafada; border-color: #1a4a1a;
  text-shadow: 0 1px 2px rgba(0,0,0,0.4);
}
.fu-rw-confirm-yes:hover { filter: brightness(1.12); }
.fu-rw-confirm-no {
  background: linear-gradient(to bottom, #8a3a2a, #5a2018);
  color: #fad8d0; border-color: #4a1a0a;
  text-shadow: 0 1px 2px rgba(0,0,0,0.4);
}
.fu-rw-confirm-no:hover { filter: brightness(1.12); }
    `;
    document.head.appendChild(s);
  }
}
