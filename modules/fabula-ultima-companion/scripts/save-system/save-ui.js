// ============================================================================
// Save System — PS1 / PS2 era Memory Card UI
//
// A full-screen DOM overlay that evokes the memory-card save screens of PS1/PS2
// JRPGs: dark navy background, scanline overlay, monospace text, slot cards with
// blurred scene thumbnails, blinking cursor, and minimal retro colour palette.
//
// Open via: FUCompanion.api.saveSystem.open()
// ============================================================================
(() => {
  const SS  = globalThis.SaveSystem ??= {};
  const TAG = "[SaveSystem][UI]";

  // ── Sounds (reuse existing module assets) ──────────────────────────────────
  const SFX = {
    select:  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_4.wav",
    cancel:  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_2.wav",
  };
  function sfx(key) {
    try { AudioHelper?.play({ src: SFX[key], volume: 0.45, loop: false }); } catch {}
  }

  // ── Date formatter ─────────────────────────────────────────────────────────
  function fmtDate(iso) {
    if (!iso) return "—";
    try {
      const d = new Date(iso);
      const pad = n => String(n).padStart(2, "0");
      return `${d.getFullYear()}/${pad(d.getMonth()+1)}/${pad(d.getDate())}  ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    } catch { return "—"; }
  }

  // ── Stylesheet ─────────────────────────────────────────────────────────────
  const CSS = `
    /* === overlay === */
    #save-system-overlay {
      position: fixed; inset: 0; z-index: 99990;
      background: #020b1e;
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      font-family: 'Lucida Console', 'Courier New', monospace;
      color: #7aabda;
      user-select: none;
    }
    /* scanlines */
    #save-system-overlay::before {
      content: '';
      position: fixed; inset: 0; z-index: 0; pointer-events: none;
      background: repeating-linear-gradient(
        0deg, transparent, transparent 3px,
        rgba(0,0,0,0.08) 3px, rgba(0,0,0,0.08) 4px
      );
    }
    /* keep content above scanlines */
    .ss-layer { position: relative; z-index: 1; }

    /* === header === */
    .ss-title {
      font-size: 22px; letter-spacing: 10px;
      color: #c8e4ff;
      text-shadow: 0 0 20px rgba(60,140,255,0.55);
      margin-bottom: 4px;
    }
    .ss-byline {
      font-size: 9px; letter-spacing: 5px; color: #1e3a60;
      margin-bottom: 6px;
    }
    .ss-mode-label {
      font-size: 10px; letter-spacing: 4px; color: #2c5080;
      margin-bottom: 30px; text-transform: uppercase;
    }

    /* === slot cards === */
    .ss-slots { display: flex; gap: 18px; margin-bottom: 26px; }

    .ss-slot {
      width: 200px; min-height: 148px;
      border: 1px solid #0c1e3a;
      background: linear-gradient(155deg, #050e22 0%, #030a18 100%);
      padding: 0; cursor: pointer; position: relative; overflow: hidden;
      transition: border-color .13s, box-shadow .13s;
    }
    .ss-slot:hover { border-color: #153a6a; }
    .ss-slot.is-sel {
      border-color: #0092cc;
      box-shadow: 0 0 22px rgba(0,146,204,0.22), inset 0 0 28px rgba(0,0,0,0.45);
    }

    /* blurred scene thumbnail */
    .ss-slot-bg {
      position: absolute; inset: 0;
      background-size: cover; background-position: center;
      opacity: 0.11; filter: blur(3px); pointer-events: none;
    }
    .ss-slot-body {
      position: relative; z-index: 1;
      padding: 12px 13px; height: 100%;
      display: flex; flex-direction: column;
    }
    .ss-slot-num  { font-size: 9px; letter-spacing: 4px; color: #1e3a5a; margin-bottom: 8px; }
    .ss-slot-icon { font-size: 22px; margin-bottom: 7px; }
    .ss-slot-name {
      font-size: 11px; color: #b8d8f8; letter-spacing: 1px;
      margin-bottom: 5px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .ss-slot-date  { font-size: 9px; color: #2e5070; letter-spacing: 1px; margin-bottom: 3px; }
    .ss-slot-party { font-size: 9px; color: #4a7a9a; letter-spacing: 1px; }
    .ss-slot-empty {
      font-size: 10px; letter-spacing: 2px; color: #152640;
      text-align: center; margin-top: 22px; flex: 1;
      display: flex; align-items: center; justify-content: center;
    }

    /* selection cursor on slot */
    .ss-sel-cursor {
      position: absolute; top: 7px; right: 9px; z-index: 2;
      font-size: 9px; color: #0092cc;
      animation: ss-blink .75s step-end infinite;
    }

    /* === mode tabs === */
    .ss-tabs { display: flex; margin-bottom: 16px; }
    .ss-tab {
      padding: 8px 22px;
      font-family: inherit; font-size: 10px;
      letter-spacing: 3px; text-transform: uppercase;
      border: 1px solid #0c1e3a; background: #030a18; color: #2c5080;
      cursor: pointer; transition: all .12s;
    }
    .ss-tab:not(:last-child) { border-right: none; }
    .ss-tab:hover:not(:disabled) { color: #5080a8; border-color: #1a3a60; }
    .ss-tab.is-active          { color: #00c0f0; border-color: #005890; background: #060f20; box-shadow: 0 -2px 0 #00c0f0 inset; }
    .ss-tab.tab-del.is-active  { color: #ff4060; border-color: #6a0020; box-shadow: 0 -2px 0 #ff3050 inset; }

    /* === confirm button === */
    .ss-confirm-wrap { margin-bottom: 16px; }
    .ss-confirm {
      padding: 9px 38px; min-width: 210px;
      font-family: inherit; font-size: 11px;
      letter-spacing: 3px; text-transform: uppercase;
      border: 1px solid #0c1e3a; background: #030a18; color: #2c5080;
      cursor: pointer; transition: all .12s;
    }
    .ss-confirm:hover:not(:disabled) {
      border-color: #0090d0; color: #00c8ff;
      box-shadow: 0 0 14px rgba(0,160,220,0.28);
    }
    .ss-confirm:disabled { opacity: 0.28; cursor: not-allowed; }
    .ss-confirm.is-del:hover:not(:disabled) {
      border-color: #aa0030; color: #ff4060;
      box-shadow: 0 0 14px rgba(255,40,70,0.28);
    }

    /* === status line === */
    .ss-status { font-size: 10px; letter-spacing: 2px; color: #00b8e8; min-height: 17px; }
    .ss-status.is-err { color: #ff4060; }
    .ss-status.is-ok  { color: #40e090; }

    /* === close hint === */
    .ss-esc {
      position: fixed; top: 18px; right: 24px; z-index: 10;
      font-size: 9px; letter-spacing: 4px; color: #1a3050;
      cursor: pointer; transition: color .12s;
    }
    .ss-esc:hover { color: #ff4060; }

    /* === back button === */
    .ss-back-btn {
      padding: 7px 28px;
      font-family: inherit; font-size: 10px;
      letter-spacing: 3px; text-transform: uppercase;
      border: 1px solid #0c1e3a; background: #030a18; color: #2c5080;
      cursor: pointer; transition: all .12s;
    }
    .ss-back-btn:hover {
      border-color: #aa0030; color: #ff4060;
      box-shadow: 0 0 12px rgba(255,40,70,0.22);
    }

    /* === footer === */
    .ss-footer { display: flex; flex-direction: column; align-items: center; gap: 8px; margin-top: 4px; }

    /* === key hints === */
    .ss-hints { font-size: 9px; letter-spacing: 2px; color: #122030; }

    /* === animations === */
    @keyframes ss-blink   { 0%,100%{opacity:1} 50%{opacity:0} }
    @keyframes ss-breathe { 0%,100%{opacity:.55} 50%{opacity:1} }
    .ss-breathe { animation: ss-breathe .65s ease-in-out infinite; }
  `;

  // ── UI class ───────────────────────────────────────────────────────────────

  class SaveSystemUI {
    constructor() {
      this._el       = null;
      this._mode     = "save";  // "save" | "load" | "delete"
      this._sel      = null;    // selected slot id (1..SLOT_COUNT)
      this._status   = "";
      this._statusCls = "";     // "" | "is-err" | "is-ok"
      this._busy     = false;
      this._keyFn    = this._onKey.bind(this);
    }

    open() {
      if (this._el) { this._el.focus(); return; }
      this._injectCSS();
      this._el = document.createElement("div");
      this._el.id = "save-system-overlay";
      this._el.setAttribute("tabindex", "-1");
      document.body.appendChild(this._el);
      document.addEventListener("keydown", this._keyFn, { capture: true });
      this._render();
      this._el.focus();
    }

    close() {
      if (!this._el) return;
      this._el.remove();
      this._el = null;
      document.removeEventListener("keydown", this._keyFn, { capture: true });
    }

    _injectCSS() {
      if (document.getElementById("save-system-css")) return;
      const s = document.createElement("style");
      s.id = "save-system-css";
      s.textContent = CSS;
      document.head.appendChild(s);
    }

    // ── Rendering ────────────────────────────────────────────────────────────

    _render() {
      if (!this._el) return;
      this._el.innerHTML = this._html();
      this._bind();
    }

    _html() {
      const slots = Array.from({ length: SS.SLOT_COUNT }, (_, i) => {
        const id  = i + 1;
        const d   = SS.Storage.getSlot(id);
        const sel = this._sel === id ? "is-sel" : "";
        const cur = this._sel === id ? `<span class="ss-sel-cursor">◄</span>` : "";
        const bg  = d?.thumbnail
          ? `<div class="ss-slot-bg" style="background-image:url('${d.thumbnail}')"></div>` : "";
        const gameName = d?.data?.partyActorData?.props?.game_name ?? "—";

        const body = d ? `
          ${cur}${bg}
          <div class="ss-slot-body">
            <div class="ss-slot-num">SLOT ${id}</div>
            <div class="ss-slot-icon">💾</div>
            <div class="ss-slot-name">${d.label ?? "Unnamed"}</div>
            <div class="ss-slot-date">${fmtDate(d.savedAt)}</div>
            <div class="ss-slot-party">${gameName}</div>
          </div>
        ` : `
          <div class="ss-slot-body">
            <div class="ss-slot-num">SLOT ${id}</div>
            <div class="ss-slot-empty">— NO DATA —</div>
          </div>
        `;
        return `<div class="ss-slot ss-layer ${sel}" data-slot="${id}">${body}</div>`;
      }).join("");

      const modeHdr = {
        save:   "MEMORY CARD  ▷  WRITE MODE",
        load:   "MEMORY CARD  ▷  READ MODE",
        delete: "MEMORY CARD  ▷  ERASE MODE",
      }[this._mode];

      const selData    = this._sel ? SS.Storage.getSlot(this._sel) : null;
      const canConfirm = !this._busy && this._sel !== null
        && (this._mode === "save" || selData !== null);
      const confirmLbl = { save: "WRITE DATA", load: "READ DATA", delete: "ERASE DATA" }[this._mode];
      const isDelMode  = this._mode === "delete" ? "is-del" : "";

      const statusHtml = this._busy
        ? `<span class="ss-breathe">▶ ${this._status}</span>`
        : this._status;

      return `
        <span class="ss-esc ss-layer" data-act="close">[ ESC ]</span>

        <div class="ss-title  ss-layer">✦  MEMORY CARD  ✦</div>
        <div class="ss-byline ss-layer">FABULA ULTIMA COMPANION SAVE SYSTEM</div>
        <div class="ss-mode-label ss-layer">${modeHdr}</div>

        <div class="ss-slots ss-layer">${slots}</div>

        <div class="ss-tabs ss-layer">
          <button class="ss-tab ${this._mode==="save"   ? "is-active":""}" data-act="mode" data-mode="save">SAVE</button>
          <button class="ss-tab ${this._mode==="load"   ? "is-active":""}" data-act="mode" data-mode="load">LOAD</button>
          <button class="ss-tab tab-del ${this._mode==="delete" ? "is-active":""}" data-act="mode" data-mode="delete">DELETE</button>
        </div>

        <div class="ss-confirm-wrap ss-layer">
          <button class="ss-confirm ${isDelMode}" data-act="confirm" ${canConfirm?"":"disabled"}>${confirmLbl}</button>
        </div>

        <div class="ss-status ss-layer ${this._statusCls}">${statusHtml}</div>
        <div class="ss-footer ss-layer">
          <button class="ss-back-btn" data-act="close">◄ BACK</button>
          <div class="ss-hints">◄ ► select slot &nbsp;|&nbsp; ESC / BACK to close</div>
        </div>
      `;
    }

    // ── Event binding ────────────────────────────────────────────────────────

    _bind() {
      if (!this._el) return;

      this._el.querySelectorAll("[data-slot]").forEach(el => {
        el.addEventListener("click", () => {
          if (this._busy) return;
          const id = parseInt(el.dataset.slot);
          this._sel = this._sel === id ? null : id;
          sfx("select");
          this._render();
        });
      });

      this._el.querySelectorAll("[data-act='mode']").forEach(el => {
        el.addEventListener("click", () => {
          if (this._busy) return;
          this._mode      = el.dataset.mode;
          this._sel       = null;
          this._status    = "";
          this._statusCls = "";
          sfx("select");
          this._render();
        });
      });

      const confirmBtn = this._el.querySelector("[data-act='confirm']");
      if (confirmBtn) {
        confirmBtn.addEventListener("click", () => {
          if (this._busy || confirmBtn.disabled) return;
          this._execute();
        });
      }

      this._el.querySelectorAll("[data-act='close']").forEach(el => {
        el.addEventListener("click", () => {
          if (this._busy) return;
          sfx("cancel");
          this.close();
        });
      });
    }

    // ── Action execution ─────────────────────────────────────────────────────

    async _execute() {
      if (!this._sel) return;
      this._busy      = true;
      this._statusCls = "";

      if (this._mode === "save") {
        this._status = "WRITING DATA…";
        this._render();

        const res = await SS.Core.save(this._sel);
        this._busy = false;
        if (res.ok) {
          this._status    = `DATA WRITTEN — SLOT ${this._sel}`;
          this._statusCls = "is-ok";
          sfx("select");
        } else {
          this._status    = `ERROR: ${res.error}`;
          this._statusCls = "is-err";
          sfx("cancel");
        }

      } else if (this._mode === "load") {
        this._status = "READING DATA…";
        this._render();

        const res = await SS.Core.load(this._sel);
        this._busy = false;
        if (res.ok) {
          this._status    = `DATA LOADED — ${res.label}`;
          this._statusCls = "is-ok";
          sfx("select");
          setTimeout(() => this.close(), 1400);
        } else {
          this._status    = `ERROR: ${res.error}`;
          this._statusCls = "is-err";
          sfx("cancel");
        }

      } else if (this._mode === "delete") {
        this._status = "ERASING DATA…";
        this._render();

        await SS.Storage.deleteSlot(this._sel);
        this._busy      = false;
        this._sel       = null;
        this._status    = "DATA ERASED.";
        this._statusCls = "";
        sfx("cancel");
      }

      this._render();
    }

    // ── Keyboard ─────────────────────────────────────────────────────────────

    _onKey(e) {
      if (!this._el) return;
      // Suppress all Foundry hotkeys while the overlay is open
      e.stopImmediatePropagation();
      if (this._busy) return;

      if (e.key === "Escape") {
        sfx("cancel");
        this.close();
        return;
      }

      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        const dir  = e.key === "ArrowRight" ? 1 : -1;
        const next = Math.max(1, Math.min(SS.SLOT_COUNT, (this._sel ?? 0) + dir));
        if (next !== this._sel) {
          this._sel = next;
          sfx("select");
          this._render();
        }
      }

      if (e.key === "Enter") {
        const btn = this._el?.querySelector("[data-act='confirm']:not(:disabled)");
        if (btn) { e.preventDefault(); this._execute(); }
      }
    }
  }

  // Expose singleton
  SS.UI = new SaveSystemUI();

  console.debug(TAG, "UI loaded. Open via: FUCompanion.api.saveSystem.open()");
})();
