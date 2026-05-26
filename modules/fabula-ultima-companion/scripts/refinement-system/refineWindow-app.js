// scripts/refinement-system/refineWindow-app.js
//
// Two-panel refinement window (custom draggable DOM overlay, not Foundry Dialog).
//
// Left  — inventory grid: player's weapon/armor/shield items, draggable.
// Right — refinement panel: drop target, refiner portrait, stats, refine button.
//
// Sounds:
//   Success → refine_success.mp3  + happy bounce on refiner portrait
//   Failure → refine_failed.mp3   + disappointment shake on refiner portrait

const WIN_ID    = "fu-refine-window";
const STYLE_ID  = "fu-refine-window-style";

const SFX = {
  success: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/refine_success.mp3",
  failure: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/refine_failed.mp3",
};

const GP_ICON = `<img class="fu-zenit-icon" src="https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/GP.png" alt="z">`;

const REFINE_CATS = [
  { key: "weapon", emoji: "⚔️", label: "Weapon" },
  { key: "armor",  emoji: "🥋", label: "Armor"  },
  { key: "shield", emoji: "🛡️", label: "Shield" },
];

// ─── singleton ───────────────────────────────────────────────────────────────
let _instance = null;

export class RefineWindowApp {

  // ── Public static: open (or focus) the window ────────────────────────────
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

  // ── Constructor ──────────────────────────────────────────────────────────
  constructor(blacksmithActorUuid) {
    this._blacksmithUuid = blacksmithActorUuid;
    this._blacksmithActor = null;
    this._playerActor    = null;
    this._selectedItem   = null;  // item doc in drop zone
    this._activeCategory = "weapon";
    this._skipConfirm    = false;
    this._confirmPending = false;
    this._busy           = false;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  static _esc(v) {
    return String(v ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;")
      .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }

  static _gp(obj, path, fb = undefined) {
    try { return foundry.utils.getProperty(obj, path) ?? fb; } catch { return fb; }
  }

  _itemType(item)  { return String(RefineWindowApp._gp(item,"system.props.item_type","") ?? "").toLowerCase(); }
  _refineLevel(item){ return Math.max(0, Number(RefineWindowApp._gp(item,"system.props.refine_level",0) ?? 0)); }
  _refineCount(item){ return Math.max(0, Number(RefineWindowApp._gp(item,"system.props.refine_count",0) ?? 0)); }
  _damageBonus(item){ return Number(RefineWindowApp._gp(item,"system.props.damage_bonus",0) ?? 0); }
  _zenit(actor)    { return Math.max(0, Number(RefineWindowApp._gp(actor,"system.props.zenit",0) ?? 0)); }

  _playerItems() {
    if (!this._playerActor) return [];
    return this._playerActor.items.contents.filter(i =>
      REFINE_CATS.some(c => c.key === this._itemType(i))
    );
  }

  _itemsForCategory(cat) {
    return this._playerItems().filter(i => this._itemType(i) === cat);
  }

  _canRefineApi(item) {
    const api = game.modules.get("fabula-ultima-companion")?.api?.refinement;
    return api?.canRefine(item) ?? { allowed: false, reason: "API not loaded" };
  }

  _successRateApi(item) {
    const api = game.modules.get("fabula-ultima-companion")?.api?.refinement;
    return api?.getSuccessRate(item) ?? 0;
  }

  _maxLevelApi(item) {
    const api = game.modules.get("fabula-ultima-companion")?.api?.refinement;
    return api?.getMaxRefineLevel(item) ?? 0;
  }

  _costApi() {
    const api = game.modules.get("fabula-ultima-companion")?.api?.refinement;
    return api?.getCost() ?? 250;
  }

  // ── Build ─────────────────────────────────────────────────────────────────
  async _build() {
    this._injectStyles();

    // Resolve actors
    this._blacksmithActor = await fromUuid(this._blacksmithUuid).catch(() => null);
    this._playerActor     = game.user.character ?? null;

    const el = document.createElement("div");
    el.id = WIN_ID;
    el.innerHTML = this._html();
    document.body.appendChild(el);

    this._makeDraggable(el.querySelector(".fu-rw-titlebar"), el);
    this._wireEvents(el);
    this._refreshInventory();
    this._refreshStats();

    // Animate in
    requestAnimationFrame(() => el.classList.add("is-open"));
  }

  async setBlacksmith(uuid) {
    if (uuid === this._blacksmithUuid) return;
    this._blacksmithUuid  = uuid;
    this._blacksmithActor = await fromUuid(uuid).catch(() => null);
    this._selectedItem    = null;
    this._confirmPending  = false;
    const el = document.getElementById(WIN_ID);
    if (!el) return;
    el.querySelector(".fu-rw-npc-portrait").src = this._npcImg();
    el.querySelector(".fu-rw-npc-name").textContent = this._npcName();
    this._refreshDropZone(el);
    this._refreshStats(el);
  }

  _npcImg() {
    if (!this._blacksmithActor) return "icons/svg/mystery-man.svg";
    return this._blacksmithActor.prototypeToken?.texture?.src
        ?? this._blacksmithActor.img
        ?? "icons/svg/mystery-man.svg";
  }

  _npcName() {
    return this._blacksmithActor?.name ?? "Blacksmith";
  }

  // ── HTML ──────────────────────────────────────────────────────────────────
  _html() {
    const npcImg  = RefineWindowApp._esc(this._npcImg());
    const npcName = RefineWindowApp._esc(this._npcName());
    const playerName = RefineWindowApp._esc(this._playerActor?.name ?? "");
    const zenit   = this._playerActor ? this._zenit(this._playerActor).toLocaleString() : "—";

    const catTabs = REFINE_CATS.map(c => `
      <button class="fu-rw-cat-tab ${c.key === this._activeCategory ? "active" : ""}"
              data-cat="${c.key}" title="${c.label}">${c.emoji}</button>
    `).join("");

    return `
      <div class="fu-rw-titlebar">
        <span class="fu-rw-title">⚒️ Blacksmith — ${npcName}</span>
        <button class="fu-rw-close" title="Close">✕</button>
      </div>
      <div class="fu-rw-body">

        <!-- LEFT: inventory picker -->
        <div class="fu-rw-left">
          <div class="fu-rw-left-header">
            <span class="fu-rw-player-name">${playerName}</span>
            <span class="fu-rw-player-zenit">${GP_ICON} ${zenit}</span>
          </div>
          <div class="fu-rw-cat-tabs">${catTabs}</div>
          <div class="fu-rw-grid-wrap">
            <div class="fu-rw-grid"></div>
          </div>
          <div class="fu-rw-item-preview">
            <div class="fu-rw-preview-placeholder">Select an item to preview</div>
          </div>
        </div>

        <!-- RIGHT: refinement panel -->
        <div class="fu-rw-right">
          <div class="fu-rw-targets">
            <div class="fu-rw-drop-zone" id="fu-rw-drop-zone">
              <div class="fu-rw-drop-placeholder">
                <div class="fu-rw-drop-icon">⚒️</div>
                <div class="fu-rw-drop-hint">Drag equipment here</div>
              </div>
              <img class="fu-rw-drop-item-img" src="" style="display:none">
              <div class="fu-rw-drop-item-name"></div>
            </div>
            <div class="fu-rw-npc-wrap">
              <img class="fu-rw-npc-portrait" src="${npcImg}" alt="${npcName}">
              <div class="fu-rw-npc-name">${npcName}</div>
            </div>
          </div>

          <div class="fu-rw-stats">
            <div class="fu-rw-stats-placeholder">Drop an item to see refinement info</div>
            <table class="fu-rw-stats-table" style="display:none">
              <tr><td class="fu-stat-label">Item</td><td class="fu-stat-value" id="fu-rs-name">—</td></tr>
              <tr><td class="fu-stat-label">Level</td><td class="fu-stat-value" id="fu-rs-level">—</td></tr>
              <tr><td class="fu-stat-label">Success Rate</td><td class="fu-stat-value" id="fu-rs-rate">—</td></tr>
              <tr><td class="fu-stat-label">Cost</td><td class="fu-stat-value" id="fu-rs-cost">—</td></tr>
              <tr><td class="fu-stat-label">Your Zenit</td><td class="fu-stat-value" id="fu-rs-zenit">—</td></tr>
              <tr><td class="fu-stat-label">After Cost</td><td class="fu-stat-value" id="fu-rs-after" class="fu-stat-after">—</td></tr>
            </table>
          </div>

          <div class="fu-rw-actions">
            <button class="fu-rw-refine-btn" id="fu-rw-refine-btn" disabled>⚒️ Refine</button>
            <div class="fu-rw-confirm-row" id="fu-rw-confirm-row" style="display:none">
              <button class="fu-rw-confirm-yes" id="fu-rw-confirm-yes">✔ Confirm</button>
              <button class="fu-rw-confirm-no"  id="fu-rw-confirm-no">✕ Cancel</button>
            </div>
            <label class="fu-rw-skip-label">
              <input type="checkbox" id="fu-rw-skip-confirm" ${this._skipConfirm ? "checked" : ""}>
              Skip confirmation
            </label>
          </div>
        </div>

      </div>
    `;
  }

  // ── Events ────────────────────────────────────────────────────────────────
  _wireEvents(el) {
    // Close
    el.querySelector(".fu-rw-close").addEventListener("click", () => this._destroy());

    // Category tabs
    el.querySelectorAll(".fu-rw-cat-tab").forEach(btn => {
      btn.addEventListener("click", () => {
        this._activeCategory = btn.dataset.cat;
        el.querySelectorAll(".fu-rw-cat-tab").forEach(b => b.classList.toggle("active", b.dataset.cat === this._activeCategory));
        this._refreshInventory(el);
      });
    });

    // Drop zone
    const dz = el.querySelector("#fu-rw-drop-zone");
    dz.addEventListener("dragover", (e) => {
      e.preventDefault();
      dz.classList.add("drag-over");
    });
    dz.addEventListener("dragleave", () => dz.classList.remove("drag-over"));
    dz.addEventListener("drop", (e) => {
      e.preventDefault();
      dz.classList.remove("drag-over");
      this._onDropItem(e, el);
    });

    // Refine button
    el.querySelector("#fu-rw-refine-btn").addEventListener("click", () => {
      if (this._busy || !this._selectedItem) return;
      if (this._skipConfirm) {
        this._executeRefine(el);
      } else {
        this._showConfirm(el, true);
      }
    });

    // Confirm / cancel
    el.querySelector("#fu-rw-confirm-yes").addEventListener("click", () => {
      this._showConfirm(el, false);
      this._executeRefine(el);
    });
    el.querySelector("#fu-rw-confirm-no").addEventListener("click", () => {
      this._showConfirm(el, false);
    });

    // Skip confirm toggle
    el.querySelector("#fu-rw-skip-confirm").addEventListener("change", (e) => {
      this._skipConfirm = e.target.checked;
    });
  }

  _onDropItem(e, el) {
    let data;
    try { data = JSON.parse(e.dataTransfer.getData("text/plain")); } catch { return; }

    // Resolve item from drag data
    const uuid   = data?.uuid ?? null;
    const itemId = data?.id   ?? null;
    const actor  = this._playerActor;
    if (!actor) return;

    let item = null;
    if (uuid) {
      // Try embedded item UUID format: Actor.xxx.Item.yyy
      const parts = uuid.split(".Item.");
      if (parts.length === 2) {
        const embedId = parts[1];
        item = actor.items.get(embedId) ?? null;
      }
    }
    if (!item && itemId) item = actor.items.get(itemId) ?? null;

    if (!item) {
      ui.notifications?.warn("Could not resolve dropped item.");
      return;
    }

    const type = this._itemType(item);
    if (!REFINE_CATS.some(c => c.key === type)) {
      ui.notifications?.warn(`${item.name} cannot be refined (only weapon/armor/shield).`);
      return;
    }

    const check = this._canRefineApi(item);
    if (!check.allowed) {
      ui.notifications?.warn(check.reason);
      return;
    }

    this._selectedItem   = item;
    this._confirmPending = false;
    this._refreshDropZone(el);
    this._refreshStats(el);
    this._showConfirm(el, false);
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
      const maxLevel = this._maxLevelApi(item);
      const isMax    = !check.allowed && level >= maxLevel && maxLevel > 0;
      const cls      = isMax ? "fu-rw-slot fu-rw-slot-maxed" : "fu-rw-slot";
      const img      = RefineWindowApp._esc(item.img ?? "icons/svg/mystery-man.svg");
      const name     = RefineWindowApp._esc(item.name ?? "");
      const badge    = level > 0 ? `<div class="fu-rw-level-badge">+${level}</div>` : "";
      return `
        <div class="${cls}" draggable="true" data-item-id="${item.id}"
             data-item-uuid="${RefineWindowApp._esc(item.uuid)}" title="${name}">
          <img src="${img}" alt="${name}">
          ${badge}
        </div>
      `;
    }).join("");

    // Wire drag start
    grid.querySelectorAll(".fu-rw-slot[draggable]").forEach(slot => {
      slot.addEventListener("dragstart", (e) => {
        const itemId   = slot.dataset.itemId;
        const itemUuid = slot.dataset.itemUuid;
        e.dataTransfer.setData("text/plain", JSON.stringify({ id: itemId, uuid: itemUuid }));
        slot.classList.add("fu-rw-dragging");
      });
      slot.addEventListener("dragend", () => slot.classList.remove("fu-rw-dragging"));
      // Click to preview
      slot.addEventListener("click", () => this._previewItem(slot.dataset.itemId, el));
    });
  }

  _previewItem(itemId, el = document.getElementById(WIN_ID)) {
    if (!el || !this._playerActor) return;
    const item = this._playerActor.items.get(itemId);
    if (!item) return;

    const pane  = el.querySelector(".fu-rw-item-preview");
    const check = this._canRefineApi(item);
    const level = this._refineLevel(item);
    const max   = this._maxLevelApi(item);
    const img   = RefineWindowApp._esc(item.img ?? "");
    const name  = RefineWindowApp._esc(item.name ?? "");
    const rarity = RefineWindowApp._esc(String(RefineWindowApp._gp(item, "system.props.item_rarity", "—") ?? "—"));
    const dmg   = this._damageBonus(item);

    pane.innerHTML = `
      <div class="fu-rw-preview-header">
        <img class="fu-rw-preview-icon" src="${img}" alt="${name}">
        <div>
          <div class="fu-rw-preview-name">${name}</div>
          <div class="fu-rw-preview-sub">${rarity} · +${level}/${max} · DMG ${dmg}</div>
        </div>
      </div>
      <div class="fu-rw-preview-status ${check.allowed ? "ok" : "no"}">
        ${check.allowed ? "✔ Can refine" : `✗ ${RefineWindowApp._esc(check.reason)}`}
      </div>
    `;
  }

  // ── Drop zone display ─────────────────────────────────────────────────────
  _refreshDropZone(el = document.getElementById(WIN_ID)) {
    if (!el) return;
    const ph   = el.querySelector(".fu-rw-drop-placeholder");
    const img  = el.querySelector(".fu-rw-drop-item-img");
    const name = el.querySelector(".fu-rw-drop-item-name");

    if (this._selectedItem) {
      ph.style.display   = "none";
      img.src            = this._selectedItem.img ?? "";
      img.style.display  = "block";
      name.textContent   = this._selectedItem.name ?? "";
    } else {
      ph.style.display   = "";
      img.style.display  = "none";
      img.src            = "";
      name.textContent   = "";
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

    const item     = this._selectedItem;
    const level    = this._refineLevel(item);
    const max      = this._maxLevelApi(item);
    const rate     = this._successRateApi(item);
    const cost     = this._costApi();
    const zenit    = this._zenit(this._playerActor);
    const after    = zenit - cost;
    const canAfford = zenit >= cost;
    const check    = this._canRefineApi(item);

    ph.style.display    = "none";
    table.style.display = "";

    el.querySelector("#fu-rs-name").textContent  = item.name ?? "—";
    el.querySelector("#fu-rs-level").textContent = `+${level} → +${level + 1} (max +${max})`;
    el.querySelector("#fu-rs-rate").textContent  = `${rate}%`;
    el.querySelector("#fu-rs-cost").innerHTML    = `${GP_ICON} ${cost.toLocaleString()}`;
    el.querySelector("#fu-rs-zenit").innerHTML   = `${GP_ICON} ${zenit.toLocaleString()}`;

    const afterEl = el.querySelector("#fu-rs-after");
    afterEl.innerHTML = `${GP_ICON} ${after.toLocaleString()}`;
    afterEl.classList.toggle("fu-stat-insufficient", !canAfford);

    btn.disabled = this._busy || !check.allowed || !canAfford;
  }

  _showConfirm(el, show) {
    this._confirmPending = show;
    const row    = el.querySelector("#fu-rw-confirm-row");
    const refBtn = el.querySelector("#fu-rw-refine-btn");
    row.style.display    = show ? "" : "none";
    refBtn.style.display = show ? "none" : "";
  }

  // ── Execute refine ────────────────────────────────────────────────────────
  async _executeRefine(el = document.getElementById(WIN_ID)) {
    if (this._busy || !this._selectedItem || !this._playerActor) return;

    const api = game.modules.get("fabula-ultima-companion")?.api?.refinement;
    if (!api) { ui.notifications?.error("Refinement API not loaded."); return; }

    this._busy = true;
    const btn = el?.querySelector("#fu-rw-refine-btn");
    if (btn) btn.disabled = true;

    const itemUuid       = this._selectedItem.uuid;
    const actorUuid      = this._playerActor.uuid;
    const refinerActorUuid = this._blacksmithActor?.uuid ?? null;

    try {
      const result = await api.refine({ itemUuid, actorUuid, refinerActorUuid });

      if (result?.ok && result?.result?.success) {
        this._playSound(SFX.success);
        this._animatePortrait(el, "success");
      } else if (result?.ok && result?.result?.success === false) {
        this._playSound(SFX.failure);
        this._animatePortrait(el, "failure");
      } else if (!result?.ok) {
        ui.notifications?.warn(result?.reason ?? "Refinement failed.");
        this._playSound(SFX.failure);
        this._animatePortrait(el, "failure");
      }

      // Refresh player actor reference (zenit changed)
      this._playerActor = game.actors?.get(this._playerActor.id) ?? this._playerActor;

      // If item was in drop zone, refresh the reference
      if (this._selectedItem) {
        const refreshed = this._playerActor.items.get(this._selectedItem.id);
        this._selectedItem = refreshed ?? this._selectedItem;
      }

      this._refreshDropZone(el);
      this._refreshStats(el);
      this._refreshInventory(el);
      this._updateZenitDisplay(el);

    } catch (e) {
      console.error("[FU][RefineWindow] executeRefine error:", e);
      ui.notifications?.error("An error occurred during refinement.");
    } finally {
      this._busy           = false;
      this._confirmPending = false;
      if (el) this._showConfirm(el, false);
    }
  }

  _updateZenitDisplay(el = document.getElementById(WIN_ID)) {
    if (!el || !this._playerActor) return;
    const z = this._zenit(this._playerActor).toLocaleString();
    const zEl = el.querySelector(".fu-rw-player-zenit");
    if (zEl) zEl.innerHTML = `${GP_ICON} ${z}`;
  }

  // ── Sound & animation ─────────────────────────────────────────────────────
  _playSound(src) {
    try { AudioHelper.play({ src, volume: 0.75, autoplay: true, loop: false }, false); } catch {}
  }

  _animatePortrait(el, type) {
    if (!el) return;
    const portrait = el.querySelector(".fu-rw-npc-portrait");
    if (!portrait) return;

    const cls = type === "success" ? "fu-rw-anim-bounce" : "fu-rw-anim-shake";
    portrait.classList.remove("fu-rw-anim-bounce", "fu-rw-anim-shake");
    // Force reflow to restart animation
    void portrait.offsetWidth;
    portrait.classList.add(cls);
    portrait.addEventListener("animationend", () => portrait.classList.remove(cls), { once: true });
  }

  // ── Draggable titlebar ────────────────────────────────────────────────────
  _makeDraggable(handle, win) {
    let ox = 0, oy = 0, mx = 0, my = 0;
    handle.style.cursor = "grab";

    handle.addEventListener("mousedown", (e) => {
      if (e.target.classList.contains("fu-rw-close")) return;
      e.preventDefault();
      mx = e.clientX; my = e.clientY;
      ox = win.offsetLeft; oy = win.offsetTop;
      handle.style.cursor = "grabbing";

      const onMove = (ev) => {
        const dx = ev.clientX - mx;
        const dy = ev.clientY - my;
        win.style.left = `${ox + dx}px`;
        win.style.top  = `${oy + dy}px`;
        win.style.transform = "none"; // remove centering after first drag
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

  _focus() {
    document.getElementById(WIN_ID)?.classList.add("fu-rw-focused");
  }

  _destroy() {
    const el = document.getElementById(WIN_ID);
    if (el) {
      el.classList.remove("is-open");
      el.classList.add("is-closing");
      setTimeout(() => el.remove(), 200);
    }
    _instance = null;
  }

  // ── Styles ────────────────────────────────────────────────────────────────
  _injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
      /* ── Window shell ── */
      #${WIN_ID} {
        position: fixed;
        top: 50%; left: 50%;
        transform: translate(-50%, -50%);
        width: 680px;
        background: #f0e6cc;
        border: 2px solid #b89940;
        border-radius: 12px;
        box-shadow: 0 20px 60px rgba(0,0,0,0.55), 0 0 0 1px rgba(184,153,64,0.3);
        font-family: inherit;
        color: #2c1f0e;
        z-index: 9999;
        opacity: 0;
        scale: 0.94;
        transition: opacity 0.18s cubic-bezier(.2,.9,.2,1), scale 0.18s cubic-bezier(.2,.9,.2,1);
        display: flex; flex-direction: column;
        max-height: 90vh;
        overflow: hidden;
      }
      #${WIN_ID}.is-open { opacity: 1; scale: 1; }
      #${WIN_ID}.is-closing { opacity: 0; scale: 0.94; }

      /* ── Title bar ── */
      .fu-rw-titlebar {
        display: flex; align-items: center; justify-content: space-between;
        padding: 8px 14px;
        background: linear-gradient(to bottom, #c8a84b, #a88c35);
        border-bottom: 2px solid #b89940;
        border-radius: 10px 10px 0 0;
        flex-shrink: 0;
      }
      .fu-rw-title { font-size: 13px; font-weight: 800; color: #fff3cc;
                     text-shadow: 0 1px 2px rgba(0,0,0,0.5); }
      .fu-rw-close {
        background: none; border: none; cursor: pointer;
        color: #fff3cc; font-size: 14px; padding: 2px 6px; border-radius: 4px;
        opacity: 0.75; transition: opacity 0.12s, background 0.12s;
      }
      .fu-rw-close:hover { opacity: 1; background: rgba(0,0,0,0.25); }

      /* ── Body: two panels ── */
      .fu-rw-body {
        display: flex; flex: 1; overflow: hidden; min-height: 0;
      }

      /* ══ LEFT PANEL ══ */
      .fu-rw-left {
        display: flex; flex-direction: column;
        width: 270px; flex-shrink: 0;
        border-right: 2px solid #b89940;
        background: #ede0b8;
        overflow: hidden;
      }
      .fu-rw-left-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 7px 10px;
        background: linear-gradient(to bottom, #e8d5a3, #dfc890);
        border-bottom: 1px solid rgba(184,153,64,0.5);
        flex-shrink: 0;
      }
      .fu-rw-player-name { font-size: 11px; font-weight: 700; color: #5a3800; }
      .fu-rw-player-zenit { font-size: 11px; font-weight: 700; color: #5a3800;
                             display: flex; align-items: center; gap: 3px; }
      .fu-zenit-icon { width: 14px; height: 14px; object-fit: contain; vertical-align: middle;
                       border: none !important; box-shadow: none !important; background: transparent; }

      /* Category tabs */
      .fu-rw-cat-tabs {
        display: flex; gap: 2px; padding: 6px 6px 4px;
        background: #e0c87a; border-bottom: 2px solid #b89940; flex-shrink: 0;
      }
      .fu-rw-cat-tab {
        flex: 1; height: 32px; border-radius: 7px; font-size: 16px;
        border: 1px solid transparent; background: transparent;
        cursor: pointer; display: flex; align-items: center; justify-content: center;
        transition: background 0.1s, border-color 0.1s;
      }
      .fu-rw-cat-tab:hover { background: rgba(139,105,20,0.18); border-color: rgba(139,105,20,0.35); }
      .fu-rw-cat-tab.active { background: #c8a84b; border-color: #8b6914;
                               box-shadow: inset 0 1px 2px rgba(0,0,0,0.25); }

      /* Grid */
      .fu-rw-grid-wrap { flex: 1; overflow-y: auto; padding: 8px; min-height: 80px; }
      .fu-rw-grid-wrap::-webkit-scrollbar { width: 5px; }
      .fu-rw-grid-wrap::-webkit-scrollbar-thumb { background: #b89940; border-radius: 3px; }
      .fu-rw-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(52px, 1fr));
        gap: 6px;
      }
      .fu-rw-slot {
        position: relative; aspect-ratio: 1;
        border-radius: 8px; border: 2px solid rgba(184,153,64,0.35);
        background: rgba(255,255,255,0.55); overflow: hidden;
        cursor: grab; transition: border-color 0.1s, transform 0.08s;
        user-select: none;
      }
      .fu-rw-slot:hover { border-color: #b89940; transform: translateY(-1px); }
      .fu-rw-slot.fu-rw-slot-maxed { filter: saturate(0.4) brightness(0.75); cursor: default; }
      .fu-rw-slot.fu-rw-dragging { opacity: 0.45; }
      .fu-rw-slot img { width: 100%; height: 100%; object-fit: contain; display: block; pointer-events: none; }
      .fu-rw-level-badge {
        position: absolute; bottom: 1px; right: 2px;
        font-size: 9px; font-weight: 900; color: #ffe066;
        text-shadow: 0 1px 2px rgba(0,0,0,0.9);
        pointer-events: none; line-height: 1;
      }
      .fu-rw-empty { padding: 20px; text-align: center; font-style: italic;
                     font-size: 12px; color: #6b4c2a; opacity: 0.6; }

      /* Item preview strip */
      .fu-rw-item-preview {
        flex-shrink: 0; min-height: 60px; max-height: 90px; overflow-y: auto;
        padding: 8px 10px; border-top: 2px solid #b89940;
        background: rgba(255,255,255,0.3);
        font-size: 11px; color: #5a3800;
      }
      .fu-rw-preview-placeholder { font-style: italic; opacity: 0.5; font-size: 11px; }
      .fu-rw-preview-header { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
      .fu-rw-preview-icon { width: 28px; height: 28px; object-fit: contain;
                             border: 1px solid rgba(184,153,64,0.4); border-radius: 4px; }
      .fu-rw-preview-name { font-weight: 700; font-size: 12px; color: #3a2408; }
      .fu-rw-preview-sub  { font-size: 10px; color: #6b4c2a; opacity: 0.8; }
      .fu-rw-preview-status { font-size: 11px; font-weight: 700; padding: 2px 0; }
      .fu-rw-preview-status.ok { color: #2d7a2d; }
      .fu-rw-preview-status.no { color: #a03020; }

      /* ══ RIGHT PANEL ══ */
      .fu-rw-right {
        flex: 1; display: flex; flex-direction: column;
        padding: 14px 16px; gap: 12px; overflow-y: auto;
        background: #f0e6cc;
      }
      .fu-rw-right::-webkit-scrollbar { width: 5px; }
      .fu-rw-right::-webkit-scrollbar-thumb { background: #b89940; border-radius: 3px; }

      /* Drop target + NPC portrait row */
      .fu-rw-targets { display: flex; align-items: flex-end; gap: 14px; }

      .fu-rw-drop-zone {
        width: 90px; height: 90px; flex-shrink: 0;
        border: 3px dashed rgba(184,153,64,0.55);
        border-radius: 12px; background: rgba(255,255,255,0.45);
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        position: relative; transition: border-color 0.15s, background 0.15s;
        overflow: hidden;
      }
      .fu-rw-drop-zone.drag-over {
        border-color: #c8a84b; background: rgba(200,168,75,0.18);
      }
      .fu-rw-drop-placeholder { display: flex; flex-direction: column; align-items: center; gap: 3px; }
      .fu-rw-drop-icon  { font-size: 22px; opacity: 0.45; }
      .fu-rw-drop-hint  { font-size: 9px; font-weight: 700; color: #6b4c2a; opacity: 0.55;
                          text-align: center; line-height: 1.3; }
      .fu-rw-drop-item-img { width: 100%; height: 100%; object-fit: contain; display: block; padding: 6px; }
      .fu-rw-drop-item-name {
        position: absolute; bottom: 0; left: 0; right: 0;
        font-size: 8px; font-weight: 700; color: #fff;
        background: rgba(0,0,0,0.6); text-align: center;
        padding: 2px 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }

      .fu-rw-npc-wrap {
        display: flex; flex-direction: column; align-items: center; gap: 4px;
      }
      .fu-rw-npc-portrait {
        width: 80px; height: 80px; object-fit: cover;
        border-radius: 50%; border: 3px solid #b89940;
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        background: #c8a84b;
      }
      .fu-rw-npc-name { font-size: 10px; font-weight: 700; color: #5a3800; text-align: center; }

      /* NPC portrait animations */
      @keyframes fu-bounce {
        0%   { transform: translateY(0)   scale(1);    }
        20%  { transform: translateY(-14px) scale(1.08); }
        40%  { transform: translateY(0)   scale(0.96); }
        60%  { transform: translateY(-7px) scale(1.04); }
        80%  { transform: translateY(0)   scale(0.99); }
        100% { transform: translateY(0)   scale(1);    }
      }
      @keyframes fu-shake {
        0%, 100% { transform: translateX(0) rotate(0deg);  }
        15%       { transform: translateX(-7px) rotate(-4deg); }
        30%       { transform: translateX(7px)  rotate(4deg);  }
        45%       { transform: translateX(-5px) rotate(-2deg); }
        60%       { transform: translateX(5px)  rotate(2deg);  }
        75%       { transform: translateX(-3px) rotate(-1deg); }
        90%       { transform: translateX(3px)  rotate(1deg);  }
      }
      .fu-rw-anim-bounce { animation: fu-bounce 0.65s cubic-bezier(.36,.07,.19,.97); }
      .fu-rw-anim-shake  { animation: fu-shake  0.55s cubic-bezier(.36,.07,.19,.97); }

      /* Stats table */
      .fu-rw-stats { background: rgba(255,255,255,0.4); border-radius: 8px;
                     border: 1px solid rgba(184,153,64,0.35); padding: 8px 10px; }
      .fu-rw-stats-placeholder { font-size: 12px; font-style: italic; color: #6b4c2a;
                                  opacity: 0.55; text-align: center; padding: 10px 0; }
      .fu-rw-stats-table { width: 100%; border-collapse: collapse; font-size: 12px; }
      .fu-stat-label { color: #6b4c2a; padding: 2px 6px 2px 0; white-space: nowrap;
                       font-weight: 600; width: 40%; }
      .fu-stat-value { color: #2c1f0e; font-weight: 700; padding: 2px 0; }
      .fu-stat-value .fu-zenit-icon { width: 13px; height: 13px; }
      .fu-stat-insufficient { color: #a03020 !important; }

      /* Actions */
      .fu-rw-actions { display: flex; flex-direction: column; gap: 8px; align-items: stretch; }
      .fu-rw-refine-btn {
        padding: 9px 16px; font-size: 13px; font-weight: 800;
        background: linear-gradient(to bottom, #c8a84b, #a07830);
        color: #fff3cc; border: 1px solid #8b6914;
        border-radius: 8px; cursor: pointer;
        box-shadow: 0 3px 8px rgba(0,0,0,0.25);
        transition: filter 0.12s, transform 0.08s;
        text-shadow: 0 1px 2px rgba(0,0,0,0.4);
      }
      .fu-rw-refine-btn:hover:not(:disabled) { filter: brightness(1.1); transform: translateY(-1px); }
      .fu-rw-refine-btn:active:not(:disabled) { transform: translateY(0); }
      .fu-rw-refine-btn:disabled { filter: saturate(0.3) brightness(0.75); cursor: default; box-shadow: none; }

      .fu-rw-confirm-row { display: flex; gap: 8px; }
      .fu-rw-confirm-yes, .fu-rw-confirm-no {
        flex: 1; padding: 8px; font-size: 12px; font-weight: 800;
        border-radius: 7px; cursor: pointer; border: 1px solid;
        transition: filter 0.12s;
      }
      .fu-rw-confirm-yes {
        background: linear-gradient(to bottom, #3a9a3a, #267026);
        color: #e0ffe0; border-color: #1e5c1e;
        text-shadow: 0 1px 2px rgba(0,0,0,0.4);
      }
      .fu-rw-confirm-yes:hover { filter: brightness(1.1); }
      .fu-rw-confirm-no {
        background: linear-gradient(to bottom, #9a3a3a, #702626);
        color: #ffe0e0; border-color: #5c1e1e;
        text-shadow: 0 1px 2px rgba(0,0,0,0.4);
      }
      .fu-rw-confirm-no:hover { filter: brightness(1.1); }

      .fu-rw-skip-label {
        font-size: 10px; color: #6b4c2a; display: flex;
        align-items: center; gap: 5px; cursor: pointer; user-select: none;
        opacity: 0.75;
      }
      .fu-rw-skip-label:hover { opacity: 1; }
      .fu-rw-skip-label input { cursor: pointer; margin: 0; }
    `;
    document.head.appendChild(s);
  }
}
