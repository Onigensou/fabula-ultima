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
    /* === overlay — warm dark backdrop === */
    #save-system-overlay {
      position: fixed; inset: 0; z-index: 2147483647;
      background: radial-gradient(ellipse at 50% 40%, #2a1608 0%, #130a02 100%);
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      font-family: 'Lucida Console', 'Courier New', monospace;
      color: #3d2208;
      user-select: none;
    }
    /* subtle warm ambient vignette */
    #save-system-overlay::before {
      content: '';
      position: fixed; inset: 0; z-index: 0; pointer-events: none;
      background: radial-gradient(ellipse at 50% 50%,
        rgba(200,140,40,0.07) 0%, transparent 68%);
    }
    .ss-layer { position: relative; z-index: 1; }

    /* === parchment panel — the JRPG dialog frame === */
    .ss-panel {
      position: relative; z-index: 1;
      background: linear-gradient(168deg, #f8f0d4 0%, #f0e3b8 45%, #e8d8a4 100%);
      border: 2px solid #c9a44a;
      box-shadow:
        0 0 0 3px #7a4e20,
        0 0 0 6px #b8865a,
        0 0 0 8px #5c3210,
        0 0 70px rgba(0,0,0,0.88),
        inset 0 1px 0 rgba(255,245,200,0.70),
        inset 0 -1px 0 rgba(120,70,20,0.18);
      border-radius: 2px;
      padding: 34px 46px 28px;
      display: flex; flex-direction: column; align-items: center;
    }
    /* ruled parchment lines */
    .ss-panel::before {
      content: '';
      position: absolute; inset: 0; pointer-events: none; z-index: 0; border-radius: 2px;
      background: repeating-linear-gradient(
        0deg, transparent, transparent 23px,
        rgba(140,90,30,0.04) 23px, rgba(140,90,30,0.04) 24px
      );
    }
    .ss-panel > * { position: relative; z-index: 1; }

    /* === header === */
    .ss-title {
      font-size: 20px; letter-spacing: 9px;
      color: #3a1e06;
      text-shadow: 0 1px 0 rgba(255,220,130,0.55), 0 2px 10px rgba(160,90,10,0.18);
      margin-bottom: 4px;
    }
    .ss-byline {
      font-size: 8px; letter-spacing: 4px; color: #9b7040;
      margin-bottom: 5px;
    }
    .ss-mode-label {
      font-size: 9px; letter-spacing: 3px; color: #7a5428;
      margin-bottom: 26px; text-transform: uppercase;
      border-bottom: 1px solid rgba(140,90,30,0.22);
      padding-bottom: 10px; width: 100%; text-align: center;
    }

    /* === slot cards === */
    .ss-slots { display: flex; gap: 14px; margin-bottom: 20px; }

    .ss-slot {
      width: 194px; min-height: 142px;
      border: 1px solid #c4a260;
      background: linear-gradient(155deg, #fdf6e0 0%, #f5ead0 100%);
      padding: 0; cursor: pointer; position: relative; overflow: hidden;
      transition: border-color .13s, box-shadow .13s;
      box-shadow: inset 0 1px 0 rgba(255,245,200,0.75), 0 2px 5px rgba(80,40,8,0.18);
    }
    .ss-slot:hover {
      border-color: #9b6a28;
      box-shadow: inset 0 1px 0 rgba(255,245,200,0.75), 0 3px 10px rgba(80,40,8,0.28);
    }
    .ss-slot.is-sel {
      border-color: #c9a22a;
      box-shadow:
        0 0 0 1px #c9a22a,
        0 0 18px rgba(201,162,42,0.38),
        inset 0 0 22px rgba(201,162,42,0.09),
        inset 0 1px 0 rgba(255,245,200,0.75);
    }

    /* blurred scene thumbnail */
    .ss-slot-bg {
      position: absolute; inset: 0;
      background-size: cover; background-position: center;
      opacity: 0.13; filter: blur(3px) sepia(0.25); pointer-events: none;
    }
    .ss-slot-body {
      position: relative; z-index: 1;
      padding: 11px 12px; height: 100%;
      display: flex; flex-direction: column;
    }
    .ss-slot-num  { font-size: 8px; letter-spacing: 3px; color: #b8945a; margin-bottom: 7px; }
    .ss-slot-icon { font-size: 20px; margin-bottom: 6px; }
    .ss-slot-name {
      font-size: 11px; color: #3a1e06; letter-spacing: 1px;
      margin-bottom: 5px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .ss-slot-date  { font-size: 8px; color: #8b6838; letter-spacing: 1px; margin-bottom: 3px; }
    .ss-slot-party { font-size: 8px; color: #7a5828; letter-spacing: 1px; }
    .ss-slot-empty {
      font-size: 9px; letter-spacing: 2px; color: #c8aa70;
      text-align: center; flex: 1;
      display: flex; align-items: center; justify-content: center;
    }

    /* selection cursor */
    .ss-sel-cursor {
      position: absolute; top: 6px; right: 8px; z-index: 2;
      font-size: 9px; color: #c9a22a;
      animation: ss-blink .75s step-end infinite;
    }

    /* === mode tabs === */
    .ss-tabs { display: flex; margin-bottom: 13px; }
    .ss-tab {
      padding: 7px 20px;
      font-family: inherit; font-size: 9px;
      letter-spacing: 2px; text-transform: uppercase;
      border: 1px solid #9b7040;
      background: linear-gradient(180deg, #7a5230 0%, #5c3818 100%);
      color: #c8a05a;
      cursor: pointer; transition: all .12s;
    }
    .ss-tab:not(:last-child) { border-right: none; }
    .ss-tab:hover:not(:disabled) {
      color: #f4e8c0;
      background: linear-gradient(180deg, #9b6840 0%, #7a4a22 100%);
    }
    .ss-tab.is-active {
      color: #f8f0d0;
      background: linear-gradient(180deg, #8b6030 0%, #6a4018 100%);
      border-color: #c9a22a;
      box-shadow: 0 -2px 0 #c9a22a inset;
    }
    .ss-tab.tab-del.is-active {
      color: #f4d0c0;
      background: linear-gradient(180deg, #6a2e18 0%, #4a1c08 100%);
      border-color: #8b3820;
      box-shadow: 0 -2px 0 #cc3820 inset;
    }

    /* === confirm button === */
    .ss-confirm-wrap { margin-bottom: 13px; }
    .ss-confirm {
      padding: 9px 36px; min-width: 206px;
      font-family: inherit; font-size: 10px;
      letter-spacing: 3px; text-transform: uppercase;
      border: 1px solid #9b7040;
      background: linear-gradient(180deg, #7a5230 0%, #5c3818 100%);
      color: #f4e8c0;
      cursor: pointer; transition: all .12s;
      box-shadow: 0 2px 5px rgba(40,18,4,0.38), inset 0 1px 0 rgba(255,225,140,0.14);
    }
    .ss-confirm:hover:not(:disabled) {
      border-color: #c9a22a; color: #fff8e0;
      background: linear-gradient(180deg, #9b6840 0%, #7a4a22 100%);
      box-shadow: 0 0 16px rgba(201,162,42,0.28), 0 2px 5px rgba(40,18,4,0.38),
                  inset 0 1px 0 rgba(255,225,140,0.22);
    }
    .ss-confirm:disabled { opacity: 0.30; cursor: not-allowed; }
    .ss-confirm.is-del:hover:not(:disabled) {
      border-color: #8b3820; color: #ffd0c0;
      background: linear-gradient(180deg, #7a2e18 0%, #5a1c08 100%);
      box-shadow: 0 0 16px rgba(180,52,28,0.28), 0 2px 5px rgba(40,18,4,0.38);
    }

    /* === status line === */
    .ss-status { font-size: 9px; letter-spacing: 2px; color: #7a5428; min-height: 16px; }
    .ss-status.is-err { color: #8b2210; }
    .ss-status.is-ok  { color: #3a6228; }

    /* === close hint (top-right) === */
    .ss-esc {
      position: fixed; top: 18px; right: 24px; z-index: 10;
      font-size: 9px; letter-spacing: 3px; color: #5c3810;
      cursor: pointer; transition: color .12s;
    }
    .ss-esc:hover { color: #aa3010; }

    /* === back button === */
    .ss-back-btn {
      padding: 7px 26px;
      font-family: inherit; font-size: 9px;
      letter-spacing: 3px; text-transform: uppercase;
      border: 1px solid #9b7040;
      background: linear-gradient(180deg, #6a4828 0%, #4e3014 100%);
      color: #c8a05a;
      cursor: pointer; transition: all .12s;
      box-shadow: 0 2px 4px rgba(40,18,4,0.30), inset 0 1px 0 rgba(255,225,140,0.10);
    }
    .ss-back-btn:hover {
      border-color: #8b3820; color: #ffd0c0;
      background: linear-gradient(180deg, #7a3020 0%, #5c1c10 100%);
      box-shadow: 0 0 10px rgba(180,52,28,0.24), 0 2px 4px rgba(40,18,4,0.30);
    }

    /* === footer === */
    .ss-footer { display: flex; flex-direction: column; align-items: center; gap: 7px; margin-top: 4px; }

    /* === key hints === */
    .ss-hints { font-size: 8px; letter-spacing: 2px; color: #b8945a; }

    /* === animations === */
    @keyframes ss-blink   { 0%,100%{opacity:1} 50%{opacity:0} }
    @keyframes ss-breathe { 0%,100%{opacity:.60} 50%{opacity:1} }
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

        <div class="ss-panel ss-layer">
          <div class="ss-title">✦  MEMORY CARD  ✦</div>
          <div class="ss-byline">FABULA ULTIMA COMPANION SAVE SYSTEM</div>
          <div class="ss-mode-label">${modeHdr}</div>

          <div class="ss-slots">${slots}</div>

          <div class="ss-tabs">
            <button class="ss-tab ${this._mode==="save"   ? "is-active":""}" data-act="mode" data-mode="save">SAVE</button>
            <button class="ss-tab ${this._mode==="load"   ? "is-active":""}" data-act="mode" data-mode="load">LOAD</button>
            <button class="ss-tab tab-del ${this._mode==="delete" ? "is-active":""}" data-act="mode" data-mode="delete">DELETE</button>
          </div>

          <div class="ss-confirm-wrap">
            <button class="ss-confirm ${isDelMode}" data-act="confirm" ${canConfirm?"":"disabled"}>${confirmLbl}</button>
          </div>

          <div class="ss-status ${this._statusCls}">${statusHtml}</div>
          <div class="ss-footer">
            <button class="ss-back-btn" data-act="close">◄ BACK</button>
            <div class="ss-hints">◄ ► select slot &nbsp;|&nbsp; ESC / BACK to close</div>
          </div>
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
