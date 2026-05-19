// ============================================================================
// Save System — JRPG Parchment Memory Card UI
//
// Three-screen flow:
//   Screen 1 (mode)    — select SAVE / LOAD / DELETE
//   Screen 2 (file)    — select slot (arrow keys or click)
//   Screen 3 (confirm) — YES / NO confirmation
//
// Navigation: arrow keys move feather cursor; Enter confirms; ESC goes back.
//
// Open via: FUCompanion.api.saveSystem.open()
// ============================================================================
(() => {
  const SS    = globalThis.SaveSystem ??= {};
  const TAG   = "[SaveSystem][UI]";
  const MODES = ["save", "load", "delete"];

  // ── Sounds ──────────────────────────────────────────────────────────────────
  const SFX = {
    select: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_4.wav",
    cancel: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_2.wav",
  };
  function sfx(key) {
    try { AudioHelper?.play({ src: SFX[key], volume: 0.45, loop: false }); } catch {}
  }

  // ── Date formatter ──────────────────────────────────────────────────────────
  function fmtDate(iso) {
    if (!iso) return "—";
    try {
      const d   = new Date(iso);
      const pad = n => String(n).padStart(2, "0");
      return `${d.getFullYear()}/${pad(d.getMonth()+1)}/${pad(d.getDate())}  ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    } catch { return "—"; }
  }

  // ── Stylesheet ──────────────────────────────────────────────────────────────
  const CSS = `
    /* === overlay === */
    #save-system-overlay {
      position: fixed; inset: 0; z-index: 2147483647;
      background: radial-gradient(ellipse at 50% 40%, #2a1608 0%, #130a02 100%);
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      font-family: 'Lucida Console', 'Courier New', monospace;
      color: #3d2208;
      user-select: none;
    }
    #save-system-overlay::before {
      content: '';
      position: fixed; inset: 0; z-index: 0; pointer-events: none;
      background: radial-gradient(ellipse at 50% 50%, rgba(200,140,40,0.07) 0%, transparent 68%);
    }
    .ss-layer { position: relative; z-index: 1; }

    /* === parchment panel (JRPG dialog frame) === */
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
      min-width: 580px;
    }
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
      margin-bottom: 24px; text-transform: uppercase;
      border-bottom: 1px solid rgba(140,90,30,0.22);
      padding-bottom: 10px; width: 100%; text-align: center;
    }

    /* === mode selection screen === */
    .ss-mode-prompt {
      font-size: 9px; letter-spacing: 4px; color: #9b7040;
      margin-bottom: 20px; text-transform: uppercase;
    }
    .ss-mode-cards { display: flex; gap: 16px; margin-bottom: 28px; }
    .ss-mode-card {
      width: 152px; padding: 22px 14px 18px;
      border: 1px solid #c4a260;
      background: linear-gradient(155deg, #fdf6e0 0%, #f5ead0 100%);
      cursor: pointer; position: relative;
      display: flex; flex-direction: column; align-items: center; gap: 8px;
      font-family: inherit;
      box-shadow: inset 0 1px 0 rgba(255,245,200,0.75), 0 2px 5px rgba(80,40,8,0.18);
      transition: border-color .12s, box-shadow .12s;
    }
    .ss-mode-card:hover, .ss-mode-card.is-focus {
      border-color: #c9a22a;
      box-shadow:
        0 0 0 1px #c9a22a,
        0 0 18px rgba(201,162,42,0.35),
        inset 0 1px 0 rgba(255,245,200,0.75);
    }
    .ss-mode-card.is-del.is-focus, .ss-mode-card.is-del:hover {
      border-color: #8b3820;
      box-shadow:
        0 0 0 1px #8b3820,
        0 0 18px rgba(180,52,28,0.28),
        inset 0 1px 0 rgba(255,245,200,0.75);
    }
    .ss-mode-card-icon  { font-size: 26px; pointer-events: none; }
    .ss-mode-card-label {
      font-family: inherit; font-size: 11px; letter-spacing: 3px;
      color: #3a1e06; text-transform: uppercase; pointer-events: none;
    }
    .ss-mode-card-desc  {
      font-family: inherit; font-size: 7px; letter-spacing: 1px;
      color: #9b7040; text-align: center; pointer-events: none;
    }

    /* === slot cards (file screen) === */
    .ss-slots { display: flex; gap: 14px; margin-bottom: 20px; }
    .ss-slot {
      width: 178px; min-height: 138px;
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
    .ss-slot.is-invalid { opacity: 0.45; cursor: not-allowed; }
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
    .ss-slot-num   { font-size: 8px; letter-spacing: 3px; color: #b8945a; margin-bottom: 7px; }
    .ss-slot-icon  { font-size: 20px; margin-bottom: 6px; }
    .ss-slot-name  {
      font-size: 11px; color: #3a1e06; letter-spacing: 1px;
      margin-bottom: 5px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .ss-slot-date  { font-size: 8px; color: #8b6838; letter-spacing: 1px; margin-bottom: 3px; }
    .ss-slot-party { font-size: 8px; color: #7a5828; letter-spacing: 1px; }
    .ss-slot-empty {
      font-size: 9px; letter-spacing: 2px; color: #c8aa70;
      flex: 1; display: flex; align-items: center; justify-content: center;
    }

    /* === confirmation screen === */
    .ss-conf-wrap {
      display: flex; flex-direction: column; align-items: center;
      gap: 16px; margin-bottom: 18px;
    }
    .ss-conf-slot {
      background: linear-gradient(155deg, #fdf6e0 0%, #f5ead0 100%);
      border: 1px solid #c4a260;
      padding: 11px 32px;
      text-align: center; min-width: 260px;
      box-shadow: inset 0 1px 0 rgba(255,245,200,0.75), 0 2px 4px rgba(80,40,8,0.15);
    }
    .ss-conf-slot-label { font-size: 11px; color: #3a1e06; letter-spacing: 2px; margin-bottom: 4px; }
    .ss-conf-slot-date  { font-size: 8px;  color: #8b6838; letter-spacing: 1px; }
    .ss-conf-text {
      font-size: 10px; letter-spacing: 3px; color: #5a3a18; text-transform: uppercase;
    }
    .ss-conf-text.is-del { color: #8b2210; }
    .ss-conf-choices { display: flex; gap: 12px; }
    .ss-choice-btn {
      padding: 9px 36px;
      font-family: inherit; font-size: 10px;
      letter-spacing: 3px; text-transform: uppercase;
      border: 1px solid #9b7040;
      background: linear-gradient(180deg, #7a5230 0%, #5c3818 100%);
      color: #f4e8c0;
      cursor: pointer; transition: all .12s;
      box-shadow: 0 2px 5px rgba(40,18,4,0.38), inset 0 1px 0 rgba(255,225,140,0.14);
    }
    .ss-choice-btn:hover, .ss-choice-btn.is-focus {
      border-color: #c9a22a; color: #fff8e0;
      background: linear-gradient(180deg, #9b6840 0%, #7a4a22 100%);
      box-shadow: 0 0 16px rgba(201,162,42,0.28), 0 2px 5px rgba(40,18,4,0.38),
                  inset 0 1px 0 rgba(255,225,140,0.22);
    }
    .ss-choice-btn.is-no:hover, .ss-choice-btn.is-no.is-focus {
      border-color: #8b3820; color: #ffd0c0;
      background: linear-gradient(180deg, #7a2e18 0%, #5a1c08 100%);
      box-shadow: 0 0 16px rgba(180,52,28,0.28), 0 2px 5px rgba(40,18,4,0.38);
    }

    /* === status line === */
    .ss-status { font-size: 9px; letter-spacing: 2px; color: #7a5428; min-height: 16px; }
    .ss-status.is-err { color: #8b2210; }
    .ss-status.is-ok  { color: #3a6228; }

    /* === close hint (backdrop, top-right) === */
    .ss-esc {
      position: fixed; top: 18px; right: 24px; z-index: 10;
      font-size: 9px; letter-spacing: 3px; color: #5c3810;
      cursor: pointer; transition: color .12s;
    }
    .ss-esc:hover { color: #aa3010; }

    /* === back / close button === */
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

    /* === feather cursor === */
    #ss-feather-cursor {
      position: fixed; z-index: 2147483647;
      width: 46px; height: 46px;
      pointer-events: none;
      /* tip of feather anchors to target bottom-right; slight quill tilt */
      transform: translate(-38%, -92%) rotate(20deg) translateY(0px);
      /* position glide via left/top; float via transform — no conflict */
      transition:
        left    0.20s cubic-bezier(0.22, 1, 0.36, 1),
        top     0.20s cubic-bezier(0.22, 1, 0.36, 1),
        opacity 0.12s ease;
      opacity: 0;
      /* remove any box/border the browser or Foundry might apply to <img> */
      border: none !important;
      outline: none !important;
      box-shadow: none !important;
      background: transparent !important;
      /* multiply blends away the white background baked into the icon PNG */
      mix-blend-mode: multiply;
    }
    #ss-feather-cursor.is-visible {
      opacity: 1;
      animation: ss-cursor-float 2.2s ease-in-out infinite;
    }
    #ss-feather-cursor.no-anim { transition: none !important; }

    /* === animations === */
    @keyframes ss-cursor-float {
      0%,  100% { transform: translate(-38%, -92%) rotate(20deg) translateY(0px);  }
      50%        { transform: translate(-38%, -92%) rotate(20deg) translateY(-7px); }
    }
    @keyframes ss-blink   { 0%,100%{opacity:1} 50%{opacity:0} }
    @keyframes ss-breathe { 0%,100%{opacity:.60} 50%{opacity:1} }
    .ss-breathe { animation: ss-breathe .65s ease-in-out infinite; }
  `;

  // ── UI class ──────────────────────────────────────────────────────────────────

  class SaveSystemUI {
    constructor() {
      this._el            = null;
      this._cursorEl      = null;
      this._cursorReady   = false;
      this._screen        = "mode";    // "mode" | "file" | "confirm"
      this._mode          = "save";    // "save" | "load" | "delete"
      this._sel           = null;      // selected slot id (1..SLOT_COUNT)
      this._confirmFocus  = "yes";     // "yes" | "no"
      this._status        = "";
      this._statusCls     = "";
      this._busy          = false;
      this._keyFn         = this._onKey.bind(this);
    }

    // ── Lifecycle ──────────────────────────────────────────────────────────────

    open() {
      if (this._el) { this._el.focus(); return; }
      this._injectCSS();

      this._screen      = "mode";
      this._sel         = null;
      this._status      = "";
      this._statusCls   = "";
      this._cursorReady = false;

      this._el = document.createElement("div");
      this._el.id = "save-system-overlay";
      this._el.setAttribute("tabindex", "-1");
      document.body.appendChild(this._el);

      this._cursorEl     = document.createElement("img");
      this._cursorEl.id  = "ss-feather-cursor";
      this._cursorEl.src = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/feather.png";
      document.body.appendChild(this._cursorEl);

      document.addEventListener("keydown", this._keyFn, { capture: true });
      this._render();
      this._el.focus();
    }

    close() {
      if (!this._el) return;
      this._el.remove();
      this._el = null;
      this._cursorEl?.remove();
      this._cursorEl    = null;
      this._cursorReady = false;
      this._screen      = "mode";
      this._sel         = null;
      document.removeEventListener("keydown", this._keyFn, { capture: true });
    }

    _injectCSS() {
      if (document.getElementById("save-system-css")) return;
      const s = document.createElement("style");
      s.id = "save-system-css";
      s.textContent = CSS;
      document.head.appendChild(s);
    }

    // ── Rendering ─────────────────────────────────────────────────────────────

    _render() {
      if (!this._el) return;
      if      (this._screen === "mode")    this._el.innerHTML = this._htmlModeScreen();
      else if (this._screen === "file")    this._el.innerHTML = this._htmlFileScreen();
      else                                 this._el.innerHTML = this._htmlConfirmScreen();
      this._bind();
      this._updateCursor();
    }

    // ── Screen 1: Mode selection ───────────────────────────────────────────────

    _htmlModeScreen() {
      const META = {
        save:   { icon: "💾", label: "SAVE",   desc: "Write current game data", cls: ""       },
        load:   { icon: "📖", label: "LOAD",   desc: "Read saved game data",    cls: ""       },
        delete: { icon: "🗑️", label: "DELETE", desc: "Erase a saved file",      cls: "is-del" },
      };
      const cards = MODES.map(m => {
        const { icon, label, desc, cls } = META[m];
        const focus = this._mode === m ? "is-focus" : "";
        return `
          <button class="ss-mode-card ${cls} ${focus}" data-act="mode" data-mode="${m}">
            <div class="ss-mode-card-icon">${icon}</div>
            <div class="ss-mode-card-label">${label}</div>
            <div class="ss-mode-card-desc">${desc}</div>
          </button>`;
      }).join("");

      return `
        <span class="ss-esc ss-layer" data-act="close">[ ESC ]</span>
        <div class="ss-panel ss-layer">
          <div class="ss-title">✦  MEMORY CARD  ✦</div>
          <div class="ss-byline">FABULA ULTIMA COMPANION SAVE SYSTEM</div>
          <div class="ss-mode-prompt">— SELECT MODE —</div>
          <div class="ss-mode-cards">${cards}</div>
          <div class="ss-footer">
            <button class="ss-back-btn" data-act="back">◄ CLOSE</button>
            <div class="ss-hints">◄ ► navigate &nbsp;|&nbsp; ENTER select &nbsp;|&nbsp; ESC close</div>
          </div>
        </div>`;
    }

    // ── Screen 2: File / slot selection ───────────────────────────────────────

    _htmlFileScreen() {
      const slots = Array.from({ length: SS.SLOT_COUNT }, (_, i) => {
        const id    = i + 1;
        const d     = SS.Storage.getSlot(id);
        const sel   = this._sel === id ? "is-sel" : "";
        const valid = this._mode === "save" || d !== null;
        const inv   = !valid ? "is-invalid" : "";
        const bg    = d?.thumbnail
          ? `<div class="ss-slot-bg" style="background-image:url('${d.thumbnail}')"></div>` : "";
        const gameName = d?.data?.partyActorData?.props?.game_name ?? "—";

        const body = d ? `
          ${bg}
          <div class="ss-slot-body">
            <div class="ss-slot-num">SLOT ${id}</div>
            <div class="ss-slot-icon">💾</div>
            <div class="ss-slot-name">${d.label ?? "Unnamed"}</div>
            <div class="ss-slot-date">${fmtDate(d.savedAt)}</div>
            <div class="ss-slot-party">${gameName}</div>
          </div>` : `
          <div class="ss-slot-body">
            <div class="ss-slot-num">SLOT ${id}</div>
            <div class="ss-slot-empty">— NO DATA —</div>
          </div>`;
        return `<div class="ss-slot ss-layer ${sel} ${inv}" data-slot="${id}" data-valid="${valid}">${body}</div>`;
      }).join("");

      const modeHdr = {
        save:   "MEMORY CARD  ▷  WRITE MODE",
        load:   "MEMORY CARD  ▷  READ MODE",
        delete: "MEMORY CARD  ▷  ERASE MODE",
      }[this._mode];

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
          <div class="ss-status ${this._statusCls}">${statusHtml}</div>
          <div class="ss-footer">
            <button class="ss-back-btn" data-act="back">◄ BACK</button>
            <div class="ss-hints">◄ ► select slot &nbsp;|&nbsp; ENTER / click confirm &nbsp;|&nbsp; ESC back</div>
          </div>
        </div>`;
    }

    // ── Screen 3: Confirmation ─────────────────────────────────────────────────

    _htmlConfirmScreen() {
      const d = this._sel ? SS.Storage.getSlot(this._sel) : null;

      const modeHdr = {
        save:   "MEMORY CARD  ▷  WRITE MODE",
        load:   "MEMORY CARD  ▷  READ MODE",
        delete: "MEMORY CARD  ▷  ERASE MODE",
      }[this._mode];

      const actionText = {
        save:   d ? "Overwrite this save file?" : "Write to this slot?",
        load:   "Load this save file?",
        delete: "Permanently delete this file?",
      }[this._mode];

      const slotPreview = d ? `
        <div class="ss-conf-slot">
          <div class="ss-conf-slot-label">SLOT ${this._sel} &nbsp;—&nbsp; ${d.label ?? "Unnamed"}</div>
          <div class="ss-conf-slot-date">${fmtDate(d.savedAt)}</div>
        </div>` : `
        <div class="ss-conf-slot">
          <div class="ss-conf-slot-label">SLOT ${this._sel} &nbsp;—&nbsp; EMPTY</div>
        </div>`;

      const yFocus    = this._confirmFocus === "yes" ? "is-focus" : "";
      const nFocus    = this._confirmFocus === "no"  ? "is-focus" : "";
      const isDelMode = this._mode === "delete" ? "is-del" : "";

      const statusHtml = this._busy
        ? `<span class="ss-breathe">▶ ${this._status}</span>`
        : this._status;

      return `
        <span class="ss-esc ss-layer" data-act="close">[ ESC ]</span>
        <div class="ss-panel ss-layer">
          <div class="ss-title">✦  MEMORY CARD  ✦</div>
          <div class="ss-byline">FABULA ULTIMA COMPANION SAVE SYSTEM</div>
          <div class="ss-mode-label">${modeHdr}</div>
          <div class="ss-conf-wrap">
            ${slotPreview}
            <div class="ss-conf-text ${isDelMode}">${actionText}</div>
            <div class="ss-conf-choices">
              <button class="ss-choice-btn ${yFocus}"        data-act="choice" data-choice="yes">YES</button>
              <button class="ss-choice-btn is-no ${nFocus}"  data-act="choice" data-choice="no" >NO</button>
            </div>
          </div>
          <div class="ss-status ${this._statusCls}">${statusHtml}</div>
          <div class="ss-footer">
            <div class="ss-hints">◄ ► navigate &nbsp;|&nbsp; ENTER confirm &nbsp;|&nbsp; ESC back</div>
          </div>
        </div>`;
    }

    // ── Event binding ──────────────────────────────────────────────────────────

    _bind() {
      if (!this._el) return;

      // Mode cards → advance to file screen
      this._el.querySelectorAll("[data-act='mode']").forEach(el => {
        el.addEventListener("click", () => {
          if (this._busy) return;
          this._mode      = el.dataset.mode;
          this._sel       = null;
          this._status    = "";
          this._statusCls = "";
          sfx("select");
          this._screen = "file";
          this._render();
        });
      });

      // Slot cards → advance directly to confirm if valid
      this._el.querySelectorAll("[data-slot]").forEach(el => {
        el.addEventListener("click", () => {
          if (this._busy) return;
          if (el.dataset.valid !== "true") return;
          const id = parseInt(el.dataset.slot);
          this._sel          = id;
          this._confirmFocus = this._mode === "delete" ? "no" : "yes";
          this._status       = "";
          this._statusCls    = "";
          sfx("select");
          this._screen = "confirm";
          this._render();
        });
      });

      // YES / NO choice buttons on confirm screen
      this._el.querySelectorAll("[data-act='choice']").forEach(el => {
        el.addEventListener("click", () => {
          if (this._busy) return;
          if (el.dataset.choice === "yes") {
            this._execute();
          } else {
            sfx("cancel");
            this._screen = "file";
            this._render();
          }
        });
      });

      // Back — context-sensitive
      const backBtn = this._el.querySelector("[data-act='back']");
      if (backBtn) {
        backBtn.addEventListener("click", () => {
          if (this._busy) return;
          sfx("cancel");
          if (this._screen === "file") {
            this._screen    = "mode";
            this._sel       = null;
            this._status    = "";
            this._statusCls = "";
            this._render();
          } else {
            this.close();
          }
        });
      }

      // ESC hint — always closes entire overlay
      this._el.querySelectorAll("[data-act='close']").forEach(el => {
        el.addEventListener("click", () => {
          if (this._busy) return;
          sfx("cancel");
          this.close();
        });
      });
    }

    // ── Feather cursor ─────────────────────────────────────────────────────────

    _updateCursor() {
      if (!this._cursorEl || !this._el) return;

      let targetEl = null;
      if (this._screen === "mode") {
        targetEl = this._el.querySelector(`[data-act='mode'][data-mode='${this._mode}']`);
      } else if (this._screen === "file" && this._sel !== null) {
        targetEl = this._el.querySelector(`[data-slot='${this._sel}']`);
      } else if (this._screen === "confirm") {
        targetEl = this._el.querySelector(`[data-act='choice'][data-choice='${this._confirmFocus}']`);
      }

      if (!targetEl) {
        this._cursorEl.classList.remove("is-visible");
        return;
      }

      const rect = targetEl.getBoundingClientRect();

      if (!this._cursorReady) {
        // First placement: snap without animating from 0,0
        this._cursorEl.classList.add("no-anim");
        this._cursorEl.style.left = `${rect.right}px`;
        this._cursorEl.style.top  = `${rect.bottom}px`;
        this._cursorEl.classList.add("is-visible");
        requestAnimationFrame(() => {
          this._cursorEl?.classList.remove("no-anim");
        });
        this._cursorReady = true;
      } else {
        this._cursorEl.style.left = `${rect.right}px`;
        this._cursorEl.style.top  = `${rect.bottom}px`;
        this._cursorEl.classList.add("is-visible");
      }
    }

    // ── Action execution ───────────────────────────────────────────────────────

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
          this._screen    = "file";
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
          this._screen    = "file";
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
        this._screen    = "file";
        sfx("cancel");
      }

      this._render();
    }

    // ── Keyboard ──────────────────────────────────────────────────────────────

    _onKey(e) {
      if (!this._el) return;
      e.stopImmediatePropagation();
      if (this._busy) return;

      // ESC — always goes one step back
      if (e.key === "Escape") {
        e.preventDefault();
        sfx("cancel");
        if (this._screen === "confirm") {
          this._screen = "file";
          this._render();
        } else if (this._screen === "file") {
          this._screen    = "mode";
          this._sel       = null;
          this._status    = "";
          this._statusCls = "";
          this._render();
        } else {
          this.close();
        }
        return;
      }

      // ── Mode screen ──────────────────────────────────────────────────────────
      if (this._screen === "mode") {
        if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
          e.preventDefault();
          const idx  = MODES.indexOf(this._mode);
          const dir  = e.key === "ArrowRight" ? 1 : -1;
          this._mode = MODES[(idx + dir + MODES.length) % MODES.length];
          sfx("select");
          this._render();
        }
        if (e.key === "Enter") {
          e.preventDefault();
          this._screen = "file";
          sfx("select");
          this._render();
        }
        return;
      }

      // ── File screen ──────────────────────────────────────────────────────────
      if (this._screen === "file") {
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
        if (e.key === "Enter" && this._sel !== null) {
          e.preventDefault();
          const d     = SS.Storage.getSlot(this._sel);
          const valid = this._mode === "save" || d !== null;
          if (valid) {
            this._confirmFocus = this._mode === "delete" ? "no" : "yes";
            this._status       = "";
            this._statusCls    = "";
            this._screen       = "confirm";
            sfx("select");
            this._render();
          }
        }
        return;
      }

      // ── Confirm screen ───────────────────────────────────────────────────────
      if (this._screen === "confirm") {
        if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
          e.preventDefault();
          this._confirmFocus = this._confirmFocus === "yes" ? "no" : "yes";
          sfx("select");
          this._render();
        }
        if (e.key === "Enter") {
          e.preventDefault();
          if (this._confirmFocus === "yes") {
            this._execute();
          } else {
            sfx("cancel");
            this._screen = "file";
            this._render();
          }
        }
      }
    }
  }

  // Expose singleton
  SS.UI = new SaveSystemUI();

  console.debug(TAG, "UI loaded. Open via: FUCompanion.api.saveSystem.open()");
})();
