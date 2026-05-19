// ============================================================================
// Save System — JRPG Parchment Memory Card UI
//
// Three-state flow:
//   "mode"    — select SAVE / LOAD / DELETE (vertical menu)
//   "file"    — select slot (vertical list)
//   "confirm" — YES / NO overlay floats over dimmed slots; morphs to
//                execution status (spinner → result) on confirm
//
// Navigation: ↑/↓ for all vertical navigation; ←/→ only for confirm YES/NO.
// Mouse hover also moves the feather cursor.
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

  // ── Token image resolution (mirrors ActiveEffectManager pattern) ─────────────
  function actorTokenImg(actor) {
    if (!actor) return "";
    // Try live scene token first, then prototypeToken, then portrait
    const sceneToken = Array.from(canvas?.tokens?.placeables ?? [])
      .find(t => t?.actor?.uuid === actor.uuid || t?.document?.actorId === actor.id);
    return (
      sceneToken?.document?.texture?.src ??
      sceneToken?.texture?.src ??
      actor.prototypeToken?.texture?.src ??
      actor.token?.texture?.src ??
      actor.img ??
      ""
    );
  }

  // ── Stylesheet ──────────────────────────────────────────────────────────────
  const CSS = `
    /* === overlay — 75% opacity + backdrop blur so game shows through === */
    #save-system-overlay {
      position: fixed; inset: 0; z-index: 2147483647;
      background: rgba(18, 8, 1, 0.75);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      font-family: 'Lucida Console', 'Courier New', monospace;
      color: #3d2208;
      user-select: none;
    }
    .ss-layer { position: relative; z-index: 1; }

    /* === parchment panel — fills most of the viewport === */
    .ss-panel {
      position: relative; z-index: 1;
      background: linear-gradient(168deg, #f8f0d4 0%, #f0e3b8 45%, #e8d8a4 100%);
      border: 2px solid #c9a44a;
      box-shadow:
        0 0 0 3px #7a4e20,
        0 0 0 6px #b8865a,
        0 0 0 8px #5c3210,
        0 0 80px rgba(0,0,0,0.70),
        inset 0 1px 0 rgba(255,245,200,0.70),
        inset 0 -1px 0 rgba(120,70,20,0.18);
      border-radius: 4px;
      padding: 64px 29px;
      display: flex; flex-direction: column; align-items: center;
      width: clamp(400px, 100vw, 1800px);
      max-height: 90vh; overflow: visible;
    }
    .ss-panel::before {
      content: '';
      position: absolute; inset: 0; pointer-events: none; z-index: 0; border-radius: 4px;
      background: repeating-linear-gradient(
        0deg, transparent, transparent 23px,
        rgba(140,90,30,0.04) 23px, rgba(140,90,30,0.04) 24px
      );
    }
    .ss-panel > * { position: relative; z-index: 1; }

    /* === header === */
    .ss-title {
      font-size: 29px; letter-spacing: 10px; color: #3a1e06;
      text-shadow: 0 1px 0 rgba(255,220,130,0.55), 0 2px 10px rgba(160,90,10,0.18);
      margin-bottom: 6px;
    }
    .ss-byline { font-size: 9px; letter-spacing: 5px; color: #9b7040; margin-bottom: 6px; }
    .ss-mode-label {
      font-size: 10px; letter-spacing: 4px; color: #7a5428;
      margin-bottom: 24px; text-transform: uppercase;
      border-bottom: 1px solid rgba(140,90,30,0.22);
      padding-bottom: 12px; width: 100%; text-align: center;
    }

    /* === mode selection screen === */
    .ss-mode-prompt {
      font-size: 10px; letter-spacing: 4px; color: #9b7040;
      margin-bottom: 20px; text-transform: uppercase;
      border-bottom: 1px solid rgba(140,90,30,0.22);
      padding-bottom: 12px; width: 100%; text-align: center;
    }
    .ss-mode-cards { display: flex; flex-direction: column; width: 100%; gap: 12px; margin-bottom: 24px; }
    .ss-mode-card {
      width: 100%; padding: 20px 28px;
      border: 1px solid #c4a260;
      background: linear-gradient(155deg, #fdf6e0 0%, #f5ead0 100%);
      cursor: pointer; position: relative;
      display: flex; flex-direction: row; align-items: center; gap: 22px;
      font-family: inherit;
      border-radius: 10px;
      box-shadow: inset 0 1px 0 rgba(255,245,200,0.75), 0 2px 6px rgba(80,40,8,0.18);
      transition: border-color .12s, box-shadow .12s;
    }
    .ss-mode-card:hover, .ss-mode-card.is-focus {
      border-color: #c9a22a;
      box-shadow: 0 0 0 1px #c9a22a, 0 0 22px rgba(201,162,42,0.35), inset 0 1px 0 rgba(255,245,200,0.75);
    }
    .ss-mode-card.is-del.is-focus, .ss-mode-card.is-del:hover {
      border-color: #8b3820;
      box-shadow: 0 0 0 1px #8b3820, 0 0 22px rgba(180,52,28,0.28), inset 0 1px 0 rgba(255,245,200,0.75);
    }
    .ss-mode-card-icon  { font-size: 28px; pointer-events: none; flex-shrink: 0; width: 36px; text-align: center; color: #5a3210; }
    .ss-mode-card.is-del .ss-mode-card-icon { color: #7a2e18; }
    .ss-mode-card-text  { display: flex; flex-direction: column; pointer-events: none; }
    .ss-mode-card-label { font-family: inherit; font-size: 18px; font-weight: bold; letter-spacing: 5px; color: #3a1e06; text-transform: uppercase; }

    /* === file screen body + slots === */
    /* Scroll lives here, not on .ss-panel, so absolutely-positioned portraits aren't clipped */
    .ss-file-body {
      position: relative; width: 100%;
      display: flex; flex-direction: column; align-items: center; margin-bottom: 18px;
      overflow-y: auto; overflow-x: visible;
      max-height: calc(90vh - 300px);
    }
    .ss-slots { display: flex; flex-direction: column; width: 100%; gap: 28px; transition: opacity .20s, filter .20s; padding: 8px 0; overflow: visible; }
    .ss-slots.is-dimmed { opacity: 0.30; filter: blur(2px); pointer-events: none; }
    .ss-slot {
      width: 100%;
      border: 1px solid #c4a260;
      background: linear-gradient(155deg, #fdf6e0 0%, #f5ead0 100%);
      cursor: pointer; position: relative; overflow: visible;
      border-radius: 10px;
      transition: border-color .13s, box-shadow .13s;
      box-shadow: inset 0 1px 0 rgba(255,245,200,0.75), 0 2px 6px rgba(80,40,8,0.18);
    }
    .ss-slot:hover {
      border-color: #9b6a28;
      box-shadow: inset 0 1px 0 rgba(255,245,200,0.75), 0 4px 12px rgba(80,40,8,0.28);
    }
    .ss-slot.is-sel {
      border-color: #c9a22a;
      box-shadow: 0 0 0 1px #c9a22a, 0 0 22px rgba(201,162,42,0.38), inset 0 0 24px rgba(201,162,42,0.09), inset 0 1px 0 rgba(255,245,200,0.75);
    }
    .ss-slot.is-invalid { opacity: 0.45; cursor: not-allowed; }
    .ss-slot-body {
      position: relative; z-index: 1;
      padding: 40px 22px;
      display: flex; flex-direction: row; align-items: center; gap: 40px;
    }
    .ss-slot-num { width: 58px; flex-shrink: 0; font-size: 16px; letter-spacing: 3px; color: #b8945a; }

    /* Token portraits — inline flex, left side between slot-num and info */
    .ss-slot-portraits {
      display: flex; flex-direction: row; gap: 26px; align-items: flex-end;
      flex-shrink: 0; pointer-events: none;
      max-width: 679px; overflow: hidden;
      margin-right: 93px;
    }
    .ss-slot-portrait {
      height: 148px; width: auto; max-width: 167px;
      object-fit: contain; object-position: center bottom;
      image-rendering: pixelated;
      flex-shrink: 0;
      border: none !important; outline: none !important;
      box-shadow: none !important; background: transparent !important;
    }

    .ss-slot-info   { flex: 1; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
    .ss-slot-name   { font-size: 19px; font-weight: bold; color: #3a1e06; letter-spacing: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ss-slot-party  { font-size: 15px; color: #9b7040; letter-spacing: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-style: italic; }
    .ss-slot-loc    { font-size: 15px; color: #7a5828; letter-spacing: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ss-slot-date   { font-size: 15px; color: #8b6838; letter-spacing: 1px; }
    .ss-slot-empty  { flex: 1; font-size: 10px; letter-spacing: 2px; color: #c8aa70; }

    /* === confirm overlay — fixed so it escapes scroll containers entirely === */
    .ss-conf-overlay {
      position: fixed; inset: 0;
      display: flex; align-items: center; justify-content: center;
      z-index: 2147483646;
      background: rgba(18, 8, 1, 0.38);
    }
    .ss-conf-inner {
      position: relative;
      background: linear-gradient(168deg, #f8f0d4 0%, #ede0b0 100%);
      border: 2px solid #c9a44a;
      box-shadow: 0 0 0 2px #7a4e20, 0 0 0 4px #b8865a, 0 0 28px rgba(0,0,0,0.40), inset 0 1px 0 rgba(255,245,200,0.70);
      border-radius: 10px;
      padding: 26px 42px 24px;
      display: flex; flex-direction: column; align-items: center; gap: 15px;
      min-width: 457px;
    }
    .ss-conf-inner::before {
      content: ''; position: absolute; inset: 0; pointer-events: none; z-index: 0; border-radius: 10px;
      background: repeating-linear-gradient(0deg, transparent, transparent 23px, rgba(140,90,30,0.04) 23px, rgba(140,90,30,0.04) 24px);
    }
    .ss-conf-inner > * { position: relative; z-index: 1; }
    .ss-conf-slot { background: linear-gradient(155deg, #fdf6e0 0%, #f5ead0 100%); border: 1px solid #c4a260; border-radius: 8px; padding: 12px 32px; text-align: center; width: 100%; box-shadow: inset 0 1px 0 rgba(255,245,200,0.75), 0 2px 4px rgba(80,40,8,0.12); }
    .ss-conf-slot-label { font-size: 13px; font-weight: bold; color: #3a1e06; letter-spacing: 2px; margin-bottom: 5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 420px; }
    .ss-conf-slot-date  { font-size: 9px;  color: #8b6838; letter-spacing: 1px; }
    .ss-conf-text { font-size: 11px; letter-spacing: 3px; color: #5a3a18; text-transform: uppercase; }
    .ss-conf-text.is-del { color: #8b2210; }
    /* execution status shown inside the overlay */
    .ss-conf-exec { font-size: 11px; letter-spacing: 2px; color: #7a5428; text-align: center; padding: 4px 0; }
    .ss-conf-exec.is-err { color: #8b2210; }
    .ss-conf-exec.is-ok  { color: #3a6228; }

    /* PS1/PS2 retro progress bar — transform-based (GPU composited, no layout reflow) */
    .ss-prog-track {
      width: 100%; height: 12px;
      background: #120801; border: 1px solid #7a5428; border-radius: 1px;
      overflow: hidden;
    }
    .ss-prog-fill {
      height: 100%; width: 100%;
      transform: scaleX(0); transform-origin: left center;
      background: linear-gradient(90deg, #c47a10 0%, #e8a820 60%, #f5c840 100%);
      box-shadow: inset 0 1px 0 rgba(255,230,110,0.45);
    }
    .ss-prog-label { font-size: 10px; letter-spacing: 3px; color: #c8a05a; text-align: center; margin-top: 8px; }
    .ss-conf-choices { display: flex; gap: 16px; }
    .ss-choice-btn {
      padding: 11px 40px; font-family: inherit; font-size: 11px;
      letter-spacing: 3px; text-transform: uppercase;
      border: 1px solid #9b7040;
      background: linear-gradient(180deg, #7a5230 0%, #5c3818 100%);
      color: #f4e8c0; cursor: pointer; transition: all .12s;
      border-radius: 8px;
      box-shadow: 0 2px 6px rgba(40,18,4,0.38), inset 0 1px 0 rgba(255,225,140,0.14);
    }
    .ss-choice-btn:hover, .ss-choice-btn.is-focus {
      border-color: #c9a22a; color: #fff8e0;
      background: linear-gradient(180deg, #9b6840 0%, #7a4a22 100%);
      box-shadow: 0 0 18px rgba(201,162,42,0.28), 0 2px 6px rgba(40,18,4,0.38), inset 0 1px 0 rgba(255,225,140,0.22);
    }
    .ss-choice-btn.is-no:hover, .ss-choice-btn.is-no.is-focus {
      border-color: #8b3820; color: #ffd0c0;
      background: linear-gradient(180deg, #7a2e18 0%, #5a1c08 100%);
      box-shadow: 0 0 18px rgba(180,52,28,0.28), 0 2px 6px rgba(40,18,4,0.38);
    }

    /* === status line (file screen only, hidden during confirm) === */
    .ss-status { font-size: 10px; letter-spacing: 2px; color: #7a5428; min-height: 18px; }
    .ss-status.is-err { color: #8b2210; }
    .ss-status.is-ok  { color: #3a6228; }

    /* === close hint === */
    .ss-esc { position: fixed; top: 20px; right: 28px; z-index: 10; font-size: 10px; letter-spacing: 3px; color: #a8845a; cursor: pointer; transition: color .12s; }
    .ss-esc:hover { color: #aa3010; }

    /* === back / close button === */
    .ss-back-btn {
      width: 100%; padding: 14px; text-align: center;
      font-family: inherit; font-size: 11px;
      letter-spacing: 4px; text-transform: uppercase;
      border: 1px solid #9b7040;
      background: linear-gradient(180deg, #6a4828 0%, #4e3014 100%);
      color: #c8a05a; cursor: pointer; transition: all .12s;
      border-radius: 8px;
      box-shadow: 0 2px 5px rgba(40,18,4,0.30), inset 0 1px 0 rgba(255,225,140,0.10);
    }
    .ss-back-btn:hover, .ss-back-btn.is-focus {
      border-color: #c9a22a; color: #fff8e0;
      background: linear-gradient(180deg, #9b6840 0%, #7a4a22 100%);
      box-shadow: 0 0 16px rgba(201,162,42,0.24), 0 2px 5px rgba(40,18,4,0.30);
    }

    /* === footer === */
    .ss-footer { display: flex; flex-direction: column; align-items: center; gap: 10px; margin-top: 10px; width: 100%; }
    .ss-hints  { font-size: 9px; letter-spacing: 2px; color: #b8945a; }

    /* === feather cursor === */
    #ss-feather-cursor {
      position: fixed; z-index: 2147483647;
      width: 52px; height: 52px;
      pointer-events: none;
      transform: translate(-38%, -92%) rotate(20deg) translateY(0px);
      transition:
        left    0.20s cubic-bezier(0.22, 1, 0.36, 1),
        top     0.20s cubic-bezier(0.22, 1, 0.36, 1),
        opacity 0.12s ease;
      opacity: 0;
      border: none !important; outline: none !important;
      box-shadow: none !important; background: transparent !important;
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

    /* === entrance / exit animations === */
    @keyframes ss-overlay-in  { from{opacity:0} to{opacity:1} }
    @keyframes ss-overlay-out { from{opacity:1} to{opacity:0} }
    @keyframes ss-panel-in {
      from { opacity: 0; transform: translateX(-28px); }
      to   { opacity: 1; transform: translateX(0); }
    }
    @keyframes ss-slot-in {
      from { opacity: 0; transform: translateX(-56px); }
      to   { opacity: 1; transform: translateX(0); }
    }
    @keyframes ss-conf-in {
      from { opacity: 0; transform: scale(0.93) translateY(12px); }
      to   { opacity: 1; transform: scale(1)    translateY(0); }
    }

    /* Overlay: fade in on open, fade out on close */
    #save-system-overlay { animation: ss-overlay-in 0.18s ease-out both; }
    #save-system-overlay.is-closing {
      animation: ss-overlay-out 0.20s ease-in forwards;
      pointer-events: none;
    }

    /* Panel: slides in from left on every screen render */
    .ss-panel { animation: ss-panel-in 0.22s cubic-bezier(0.22, 1, 0.36, 1) both; }

    /* Slots: staggered slide-in — larger offset than panel for visual hierarchy */
    .ss-slot { animation: ss-slot-in 0.30s cubic-bezier(0.22, 1, 0.36, 1) both; }
    .ss-slot:nth-child(1) { animation-delay:   0ms; }
    .ss-slot:nth-child(2) { animation-delay:  85ms; }
    .ss-slot:nth-child(3) { animation-delay: 170ms; }
    .ss-slot:nth-child(4) { animation-delay: 255ms; }
    .ss-slot:nth-child(5) { animation-delay: 340ms; }

    /* Confirm inner: spring pop-in */
    .ss-conf-inner { animation: ss-conf-in 0.22s cubic-bezier(0.34, 1.56, 0.64, 1) both; }
  `;

  // ── UI class ──────────────────────────────────────────────────────────────────

  class SaveSystemUI {
    constructor() {
      this._el           = null;
      this._cursorEl     = null;
      this._cursorReady  = false;
      this._screen       = "mode";   // "mode" | "file" | "confirm"
      this._focusArea    = "main";   // "main" | "back"
      this._mode         = "save";   // "save" | "load" | "delete"
      this._sel          = null;     // selected slot id (1..SLOT_COUNT)
      this._confirmFocus = "yes";    // "yes" | "no"
      this._status       = "";
      this._statusCls    = "";
      this._busy         = false;
      this._progress     = 0;
      this._progressRaf  = 0;
      this._keyFn        = this._onKey.bind(this);
    }

    // ── Lifecycle ──────────────────────────────────────────────────────────────

    open() {
      if (this._el) { this._el.focus(); return; }
      this._injectCSS();

      this._screen      = "mode";
      this._focusArea   = "main";
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

    close(_skipAnim = false) {
      if (!this._el) return;
      if (!_skipAnim) {
        if (this._el.classList.contains("is-closing")) return;
        this._el.classList.add("is-closing");
        setTimeout(() => this.close(true), 220);
        return;
      }
      cancelAnimationFrame(this._progressRaf);
      this._progress = 0;
      this._el.remove();
      this._el = null;
      this._cursorEl?.remove();
      this._cursorEl    = null;
      this._cursorReady = false;
      this._screen      = "mode";
      this._focusArea   = "main";
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
      this._el.innerHTML = this._screen === "mode"
        ? this._htmlModeScreen()
        : this._htmlFileScreen();
      this._bind();
      // rAF ensures the new DOM is laid out before getBoundingClientRect is called,
      // which is necessary for the CSS left/top transition to fire correctly.
      requestAnimationFrame(() => this._updateCursor());
    }

    // ── Screen 1: Mode selection (vertical menu) ───────────────────────────────

    _htmlModeScreen() {
      const META = {
        save:   { icon: '<i class="fas fa-floppy-disk"></i>', label: "SAVE",   cls: ""       },
        load:   { icon: '<i class="fas fa-book-open"></i>',   label: "LOAD",   cls: ""       },
        delete: { icon: '<i class="fas fa-trash"></i>',       label: "DELETE", cls: "is-del" },
      };
      const cards = MODES.map(m => {
        const { icon, label, cls } = META[m];
        const focus = (this._mode === m && this._focusArea === "main") ? "is-focus" : "";
        return `
          <button class="ss-mode-card ${cls} ${focus}" data-act="mode" data-mode="${m}">
            <div class="ss-mode-card-icon">${icon}</div>
            <div class="ss-mode-card-text">
              <div class="ss-mode-card-label">${label}</div>
            </div>
          </button>`;
      }).join("");

      const backFocus = this._focusArea === "back" ? "is-focus" : "";
      return `
        <span class="ss-esc ss-layer" data-act="close">[ ESC ]</span>
        <div class="ss-panel ss-layer">
          <div class="ss-title">✦  MEMORY CARD  ✦</div>
          <div class="ss-byline">FABULA ULTIMA COMPANION SAVE SYSTEM</div>
          <div class="ss-mode-prompt">— SELECT MODE —</div>
          <div class="ss-mode-cards">${cards}</div>
          <div class="ss-footer">
            <button class="ss-back-btn ${backFocus}" data-act="back">◄ CLOSE</button>
            <div class="ss-hints">↑ ↓ navigate &nbsp;|&nbsp; ENTER select &nbsp;|&nbsp; ESC close</div>
          </div>
        </div>`;
    }

    // ── Screen 2/3: File selection (vertical list) + inline confirm overlay ────

    _htmlFileScreen() {
      const isConfirm = this._screen === "confirm";

      const slots = Array.from({ length: SS.SLOT_COUNT }, (_, i) => {
        const id    = i + 1;
        const d     = SS.Storage.getSlot(id);
        const sel   = (this._sel === id && !isConfirm) ? "is-sel" : "";
        const selC  = (this._sel === id &&  isConfirm) ? "is-sel" : "";
        const valid = this._mode === "save" || d !== null;
        const inv   = !valid ? "is-invalid" : "";

        let body;
        if (d) {
          // Navigation name via live scene lookup (falls back to stored scene name)
          const sceneId   = d.data?.activeScene?.sceneId;
          const liveScene = sceneId ? game.scenes?.get(sceneId) : null;
          const locName   = liveScene?.navName || d.data?.activeScene?.sceneName || "—";
          const gameName  = d.data?.partyActorData?.system?.props?.game_name ?? "—";

          // Party/database actor name via live UUID lookup
          const paUuid   = d.data?.partyActorData?.uuid;
          const paRawId  = paUuid?.startsWith("Actor.") ? paUuid.slice(6) : paUuid;
          const partyActorName = paRawId ? (game.actors?.get(paRawId)?.name ?? "") : "";

          // Token images of active party members at save time (member_id_N only, not bench)
          const partyProps = d.data?.partyActorData?.system?.props ?? {};
          const portraits  = [];
          for (let j = 1; j <= 10; j++) {
            const mid = partyProps[`member_id_${j}`];
            if (!mid) break;
            const rawId = mid.startsWith("Actor.") ? mid.slice(6) : mid;
            const actor = game.actors?.get(rawId);
            if (actor) portraits.push({ img: actorTokenImg(actor), name: actor.name });
          }
          const portraitHtml = portraits
            .map(p => p.img ? `<img class="ss-slot-portrait" src="${p.img}" title="${p.name}">` : "")
            .join("");

          // Portraits inline inside .ss-slot-body: num | portraits | info
          body = `
            <div class="ss-slot-body">
              <div class="ss-slot-num">SLOT ${id}</div>
              ${portraitHtml ? `<div class="ss-slot-portraits">${portraitHtml}</div>` : ""}
              <div class="ss-slot-info">
                <div class="ss-slot-name">${gameName}</div>
                ${partyActorName ? `<div class="ss-slot-party">${partyActorName}</div>` : ""}
                <div class="ss-slot-loc">${locName}</div>
                <div class="ss-slot-date">${fmtDate(d.savedAt)}</div>
              </div>
            </div>`;
        } else {
          body = `
            <div class="ss-slot-body">
              <div class="ss-slot-num">SLOT ${id}</div>
              <div class="ss-slot-empty">— NO DATA —</div>
            </div>`;
        }

        return `<div class="ss-slot ss-layer ${sel} ${selC} ${inv}" data-slot="${id}" data-valid="${valid}">${body}</div>`;
      }).join("");

      const modeHdr = {
        save:   "MEMORY CARD  ▷  WRITE MODE",
        load:   "MEMORY CARD  ▷  READ MODE",
        delete: "MEMORY CARD  ▷  ERASE MODE",
      }[this._mode];

      const dimClass    = isConfirm ? "is-dimmed" : "";
      const confOverlay = isConfirm ? this._htmlConfirmOverlay() : "";
      const backFocus   = this._focusArea === "back" ? "is-focus" : "";

      const fileStatus = !isConfirm
        ? `<div class="ss-status ${this._statusCls}">${this._status}</div>`
        : `<div class="ss-status"></div>`;

      const hintsText = isConfirm
        ? `← → navigate &nbsp;|&nbsp; ENTER confirm &nbsp;|&nbsp; ESC back`
        : `↑ ↓ select slot &nbsp;|&nbsp; ENTER confirm &nbsp;|&nbsp; ESC back`;

      return `
        <span class="ss-esc ss-layer" data-act="close">[ ESC ]</span>
        <div class="ss-panel ss-layer">
          <div class="ss-title">✦  MEMORY CARD  ✦</div>
          <div class="ss-byline">FABULA ULTIMA COMPANION SAVE SYSTEM</div>
          <div class="ss-mode-label">${modeHdr}</div>
          <div class="ss-file-body">
            <div class="ss-slots ${dimClass}">${slots}</div>
            ${confOverlay}
          </div>
          ${fileStatus}
          <div class="ss-footer">
            <button class="ss-back-btn ${backFocus}" data-act="back">◄ BACK</button>
            <div class="ss-hints">${hintsText}</div>
          </div>
        </div>`;
    }

    // ── Confirm overlay content — morphs based on execution state ──────────────

    _htmlConfirmOverlay() {
      // During and after execution: show progress bar (busy) or result text (done)
      if (this._busy || this._status) {
        let innerContent;
        if (this._busy) {
          innerContent = `
              <div class="ss-prog-track"><div class="ss-prog-fill"></div></div>
              <div class="ss-prog-label ss-breathe">${this._status}</div>`;
        } else {
          const errBack = this._statusCls === "is-err" ? `
              <button class="ss-choice-btn is-no is-focus" data-act="choice" data-choice="no">◄ BACK</button>` : "";
          innerContent = `
              <div class="ss-conf-exec ${this._statusCls}">${this._status}</div>
              ${errBack}`;
        }
        return `
          <div class="ss-conf-overlay">
            <div class="ss-conf-inner">
              ${innerContent}
            </div>
          </div>`;
      }

      // Normal confirmation UI
      const d = this._sel ? SS.Storage.getSlot(this._sel) : null;
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

      return `
        <div class="ss-conf-overlay">
          <div class="ss-conf-inner">
            ${slotPreview}
            <div class="ss-conf-text ${isDelMode}">${actionText}</div>
            <div class="ss-conf-choices">
              <button class="ss-choice-btn ${yFocus}"       data-act="choice" data-choice="yes">YES</button>
              <button class="ss-choice-btn is-no ${nFocus}" data-act="choice" data-choice="no" >NO</button>
            </div>
          </div>
        </div>`;
    }

    // ── Event binding ──────────────────────────────────────────────────────────

    _bind() {
      if (!this._el) return;

      // Mode cards — click + hover
      this._el.querySelectorAll("[data-act='mode']").forEach(el => {
        el.addEventListener("click", () => {
          if (this._busy) return;
          this._mode      = el.dataset.mode;
          this._sel       = 1;
          this._status    = "";
          this._statusCls = "";
          sfx("select");
          this._screen    = "file";
          this._focusArea = "main";
          this._render();
        });
        el.addEventListener("mouseenter", () => {
          if (this._busy) return;
          this._mode      = el.dataset.mode;
          this._focusArea = "main";
          this._el.querySelectorAll("[data-act='mode']").forEach(c =>
            c.classList.toggle("is-focus", c === el));
          this._el.querySelector("[data-act='back']")?.classList.remove("is-focus");
          this._updateCursor();
        });
      });

      // Slot cards — click + hover
      this._el.querySelectorAll("[data-slot]").forEach(el => {
        el.addEventListener("click", () => {
          if (this._busy || this._screen === "confirm") return;
          if (el.dataset.valid !== "true") return;
          const id = parseInt(el.dataset.slot);
          this._sel          = id;
          this._confirmFocus = this._mode === "delete" ? "no" : "yes";
          this._status       = "";
          this._statusCls    = "";
          this._focusArea    = "main";
          sfx("select");
          this._screen = "confirm";
          this._render();
        });
        el.addEventListener("mouseenter", () => {
          if (this._busy || this._screen === "confirm") return;
          if (el.dataset.valid !== "true") return;
          const id = parseInt(el.dataset.slot);
          this._sel       = id;
          this._focusArea = "main";
          this._el.querySelectorAll("[data-slot]").forEach(s =>
            s.classList.toggle("is-sel", parseInt(s.dataset.slot) === id));
          this._el.querySelector("[data-act='back']")?.classList.remove("is-focus");
          this._updateCursor();
        });
      });

      // Confirm choices — click + hover
      this._el.querySelectorAll("[data-act='choice']").forEach(el => {
        el.addEventListener("click", () => {
          if (this._busy) return;
          if (el.dataset.choice === "yes") {
            this._execute();
          } else {
            sfx("cancel");
            this._screen    = "file";
            this._status    = "";
            this._statusCls = "";
            this._render();
          }
        });
        el.addEventListener("mouseenter", () => {
          if (this._busy) return;
          this._confirmFocus = el.dataset.choice;
          this._el.querySelectorAll("[data-act='choice']").forEach(c =>
            c.classList.toggle("is-focus", c === el));
          this._updateCursor();
        });
      });

      // Back button — click + hover
      const backBtn = this._el.querySelector("[data-act='back']");
      if (backBtn) {
        backBtn.addEventListener("click", () => {
          if (this._busy) return;
          this._doBack();
        });
        backBtn.addEventListener("mouseenter", () => {
          if (this._busy) return;
          this._focusArea = "back";
          backBtn.classList.add("is-focus");
          this._el.querySelectorAll("[data-act='mode'], [data-slot], [data-act='choice']").forEach(c =>
            c.classList.remove("is-focus"));
          this._el.querySelectorAll("[data-slot]").forEach(c =>
            c.classList.remove("is-sel"));
          this._updateCursor();
        });
      }

      // ESC hint — always closes overlay
      this._el.querySelectorAll("[data-act='close']").forEach(el => {
        el.addEventListener("click", () => {
          if (this._busy) return;
          sfx("cancel");
          this.close();
        });
      });
    }

    // ── Back action (shared between button click and keyboard) ─────────────────

    _doBack() {
      sfx("cancel");
      this._focusArea = "main";
      if (this._screen === "confirm") {
        this._screen    = "file";
        this._status    = "";
        this._statusCls = "";
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
    }

    // ── Feather cursor ─────────────────────────────────────────────────────────

    _updateCursor() {
      if (!this._cursorEl || !this._el) return;

      let targetEl = null;

      if (this._focusArea === "back") {
        targetEl = this._el.querySelector("[data-act='back']");
      } else if (this._screen === "mode") {
        targetEl = this._el.querySelector(`[data-act='mode'][data-mode='${this._mode}']`);
      } else if (this._screen === "confirm") {
        if (this._busy) {
          // hide cursor while executing
        } else if (this._status && this._statusCls === "is-err") {
          targetEl = this._el.querySelector(`[data-act='choice'][data-choice='no']`);
        } else if (!this._status) {
          targetEl = this._el.querySelector(`[data-act='choice'][data-choice='${this._confirmFocus}']`);
        }
      } else if (this._sel !== null) {
        targetEl = this._el.querySelector(`[data-slot='${this._sel}']`);
      }

      if (!targetEl) {
        this._cursorEl.classList.remove("is-visible");
        return;
      }

      const rect = targetEl.getBoundingClientRect();

      if (!this._cursorReady) {
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

    // ── PS1/PS2 progress bar ───────────────────────────────────────────────────

    _startProgress() {
      this._progress = 0;
      cancelAnimationFrame(this._progressRaf);
      const start    = performance.now();
      const duration = 3200;   // fills to ~88% over 3.2s
      const target   = 0.88;
      const tick = (now) => {
        if (!this._el || !this._busy) return;
        const t = Math.min((now - start) / duration, 1);
        this._progress = t * target;  // linear — starts visibly from 0
        const fill = this._el.querySelector(".ss-prog-fill");
        if (fill) fill.style.transform = `scaleX(${this._progress})`;
        if (t < 1) this._progressRaf = requestAnimationFrame(tick);
      };
      this._progressRaf = requestAnimationFrame(tick);
    }

    async _finishProgress() {
      cancelAnimationFrame(this._progressRaf);
      const startPct  = this._progress;
      const remaining = 1 - startPct;
      const duration  = 350;   // quick fill to 100%
      const start     = performance.now();
      await new Promise(resolve => {
        const tick = (now) => {
          const t = Math.min((now - start) / duration, 1);
          const pct = startPct + remaining * t;
          const fill = this._el?.querySelector(".ss-prog-fill");
          if (fill) fill.style.transform = `scaleX(${pct})`;
          if (t < 1) requestAnimationFrame(tick);
          else resolve();
        };
        requestAnimationFrame(tick);
      });
      await new Promise(r => setTimeout(r, 300));
    }

    // ── Action execution ───────────────────────────────────────────────────────

    async _execute() {
      if (!this._sel) return;
      this._busy      = true;
      this._statusCls = "";

      if (this._mode === "save") {
        this._status = "WRITING DATA…";
        this._render();
        this._startProgress();

        const res = await SS.Core.save(this._sel);
        await this._finishProgress();
        this._busy = false;
        if (res.ok) {
          this._status    = `DATA WRITTEN — SLOT ${this._sel}`;
          this._statusCls = "is-ok";
          sfx("select");
          this._render();
          setTimeout(() => {
            if (!this._el) return;
            this._status    = "";
            this._statusCls = "";
            this._screen    = "file";
            this._render();
          }, 1300);
        } else {
          this._status       = `ERROR: ${res.error}`;
          this._statusCls    = "is-err";
          this._confirmFocus = "no";
          sfx("cancel");
          this._render();
        }
        return;
      }

      if (this._mode === "load") {
        this._status = "READING DATA…";
        this._render();
        this._startProgress();

        const res = await SS.Core.load(this._sel);
        await this._finishProgress();
        this._busy = false;
        if (res.ok) {
          this._status    = `DATA LOADED — ${res.label}`;
          this._statusCls = "is-ok";
          sfx("select");
          this._render();
          setTimeout(() => this.close(), 1400);
        } else {
          this._status       = `ERROR: ${res.error}`;
          this._statusCls    = "is-err";
          this._confirmFocus = "no";
          sfx("cancel");
          this._render();
        }
        return;
      }

      if (this._mode === "delete") {
        this._status = "ERASING DATA…";
        this._render();
        this._startProgress();

        await SS.Storage.deleteSlot(this._sel);
        await this._finishProgress();
        this._busy      = false;
        this._sel       = null;
        this._status    = "DATA ERASED.";
        this._statusCls = "";
        sfx("cancel");
        this._render();
        setTimeout(() => {
          if (!this._el) return;
          this._status = "";
          this._screen = "file";
          this._render();
        }, 1300);
      }
    }

    // ── Keyboard ──────────────────────────────────────────────────────────────

    _onKey(e) {
      if (!this._el) return;
      e.stopImmediatePropagation();
      if (this._busy) return;

      // ESC — always one step back
      if (e.key === "Escape") {
        e.preventDefault();
        if (this._screen === "confirm" && this._status) {
          this._status    = "";
          this._statusCls = "";
          if (this._statusCls === "is-err") {
            this._render();
            return;
          }
        }
        this._doBack();
        return;
      }

      // ↑/↓ — vertical navigation through all items including back button
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && this._screen !== "confirm") {
        e.preventDefault();
        const dir = e.key === "ArrowDown" ? 1 : -1;

        if (this._screen === "mode") {
          const modeNav = [...MODES, "back"];
          const cur     = this._focusArea === "back" ? "back" : this._mode;
          const idx     = modeNav.indexOf(cur);
          const newIdx  = (idx + dir + modeNav.length) % modeNav.length;
          const newItem = modeNav[newIdx];
          sfx("select");
          if (newItem === "back") {
            this._focusArea = "back";
            this._el.querySelectorAll("[data-act='mode']").forEach(c => c.classList.remove("is-focus"));
            this._el.querySelector("[data-act='back']")?.classList.add("is-focus");
          } else {
            this._focusArea = "main";
            this._mode      = newItem;
            this._el.querySelectorAll("[data-act='mode']").forEach(c =>
              c.classList.toggle("is-focus", c.dataset.mode === newItem));
            this._el.querySelector("[data-act='back']")?.classList.remove("is-focus");
          }
          this._updateCursor();

        } else if (this._screen === "file") {
          const fileNav = Array.from({ length: SS.SLOT_COUNT }, (_, i) => i + 1).concat(["back"]);
          const cur     = this._focusArea === "back" ? "back" : (this._sel ?? 1);
          const idx     = Math.max(0, fileNav.indexOf(cur));
          const newIdx  = (idx + dir + fileNav.length) % fileNav.length;
          const newItem = fileNav[newIdx];
          sfx("select");
          if (newItem === "back") {
            this._focusArea = "back";
            this._el.querySelectorAll("[data-slot]").forEach(c => c.classList.remove("is-sel"));
            this._el.querySelector("[data-act='back']")?.classList.add("is-focus");
          } else {
            this._focusArea = "main";
            this._sel       = newItem;
            this._el.querySelectorAll("[data-slot]").forEach(c =>
              c.classList.toggle("is-sel", parseInt(c.dataset.slot) === newItem));
            this._el.querySelector("[data-act='back']")?.classList.remove("is-focus");
          }
          this._updateCursor();
        }
        return;
      }

      // Enter on back button
      if (e.key === "Enter" && this._focusArea === "back") {
        e.preventDefault();
        this._doBack();
        return;
      }

      // ── Mode screen — Enter to select mode ──
      if (this._screen === "mode" && this._focusArea === "main") {
        if (e.key === "Enter") {
          e.preventDefault();
          this._sel    = 1;
          this._screen = "file";
          sfx("select");
          this._render();
        }
        return;
      }

      // ── File screen — Enter to open confirm ──
      if (this._screen === "file" && this._focusArea === "main") {
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

      // ── Confirm overlay — ←/→ for YES/NO, Enter to confirm ──
      if (this._screen === "confirm" && !this._status) {
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
            this._screen    = "file";
            this._status    = "";
            this._statusCls = "";
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
