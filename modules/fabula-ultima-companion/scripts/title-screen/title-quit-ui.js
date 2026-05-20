// ============================================================================
// Title Screen — Quit / Log-out Confirmation Overlay
//
// Parchment panel overlay (same visual language as ts-wait-overlay).
// Floats above the title screen menu without replacing it.
//
//   open()     → shows panel, wires ESC + Enter keys
//   Confirm    → sfx(select) → game.logOut()
//   Cancel/ESC → sfx(cancel) → close(), menu stays underneath
//
// Open via: TitleScreen.QuitUI.open()  (called by title-ui.js on Quit select)
// ============================================================================
(() => {
  const TS  = globalThis.TitleScreen ??= {};
  const TAG = "[TitleScreen][QuitUI]";

  // ── Sounds ───────────────────────────────────────────────────────────────────
  const BASE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound";
  const SFX_URLS = {
    navigate: `${BASE}/BattleCursor_4.wav`,
    select:   `${BASE}/file_selector_screen.wav`,
    cancel:   `${BASE}/bond_cleared.wav`,
  };
  function sfx(key) {
    try { AudioHelper?.play({ src: SFX_URLS[key], volume: 0.45, loop: false }); } catch {}
  }

  // ── Stylesheet ───────────────────────────────────────────────────────────────
  const CSS = `
    #ts-quit-overlay {
      position: fixed; inset: 0; z-index: 1000;
      background: rgba(18, 8, 1, 0.75);
      backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
      display: flex; align-items: center; justify-content: center;
      font-family: 'Lucida Console', 'Courier New', monospace;
      user-select: none;
    }
    .ts-quit-inner {
      position: relative;
      background: linear-gradient(168deg, #f8f0d4 0%, #f0e3b8 45%, #e8d8a4 100%);
      border: 2px solid #c9a44a;
      box-shadow:
        0 0 0 3px #7a4e20, 0 0 0 6px #b8865a, 0 0 0 8px #5c3210,
        0 0 80px rgba(0,0,0,0.70), inset 0 1px 0 rgba(255,245,200,0.70);
      border-radius: 4px;
      padding: 52px 52px 42px;
      display: flex; flex-direction: column; align-items: center; gap: 20px;
      min-width: 380px;
      animation: ts-quit-in 0.22s cubic-bezier(0.22, 1, 0.36, 1) both;
    }
    @keyframes ts-quit-in {
      from { opacity: 0; transform: translateX(-28px); }
      to   { opacity: 1; transform: translateX(0); }
    }
    .ts-quit-inner::before {
      content: ''; position: absolute; inset: 0; pointer-events: none;
      border-radius: 4px;
      background: repeating-linear-gradient(
        0deg,
        transparent, transparent 23px,
        rgba(140,90,30,0.04) 23px, rgba(140,90,30,0.04) 24px
      );
    }
    .ts-quit-inner > * { position: relative; }
    .ts-quit-title {
      font-size: 22px; letter-spacing: 8px; color: #3a1e06;
    }
    .ts-quit-sub {
      font-size: 11px; letter-spacing: 3px; color: #7a5428; text-align: center;
    }
    .ts-quit-btns {
      display: flex; gap: 12px; width: 100%;
    }
    .ts-quit-btn {
      flex: 1; padding: 14px; text-align: center;
      font-family: inherit; font-size: 11px;
      letter-spacing: 4px; text-transform: uppercase;
      border: 1px solid #9b7040;
      background: linear-gradient(180deg, #6a4828 0%, #4e3014 100%);
      color: #c8a05a; cursor: pointer; transition: all .12s;
      border-radius: 8px;
      box-shadow: 0 2px 5px rgba(40,18,4,0.30), inset 0 1px 0 rgba(255,225,140,0.10);
    }
    .ts-quit-btn:hover, .ts-quit-btn.is-focus {
      border-color: #c9a22a; color: #fff8e0;
      background: linear-gradient(180deg, #9b6840 0%, #7a4a22 100%);
      box-shadow: 0 0 16px rgba(201,162,42,0.24), 0 2px 5px rgba(40,18,4,0.30);
    }
  `;

  function _injectCSS() {
    if (document.getElementById("ts-quit-css")) return;
    const s = document.createElement("style");
    s.id = "ts-quit-css";
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  // ── UI class ──────────────────────────────────────────────────────────────────

  class TitleQuitUI {
    constructor() {
      this._el    = null;
      this._keyFn = this._onKey.bind(this);
    }

    open() {
      if (this._el) return;
      _injectCSS();

      this._el = document.createElement("div");
      this._el.id = "ts-quit-overlay";
      this._el.innerHTML = `
        <div class="ts-quit-inner">
          <div class="ts-quit-title">✦  LOG OUT  ✦</div>
          <div class="ts-quit-sub">ARE YOU SURE?</div>
          <div class="ts-quit-btns">
            <button class="ts-quit-btn is-focus" id="ts-quit-confirm">CONFIRM</button>
            <button class="ts-quit-btn" id="ts-quit-cancel">◄ CANCEL</button>
          </div>
        </div>`;
      document.body.appendChild(this._el);
      document.addEventListener("keydown", this._keyFn, { capture: true });

      this._el.querySelector("#ts-quit-confirm").addEventListener("click",      () => this._confirm());
      this._el.querySelector("#ts-quit-cancel").addEventListener("click",       () => this.close());
      this._el.querySelector("#ts-quit-confirm").addEventListener("mouseenter", () => {
        sfx("navigate");
        this._el.querySelector("#ts-quit-confirm").classList.add("is-focus");
        this._el.querySelector("#ts-quit-cancel").classList.remove("is-focus");
      });
      this._el.querySelector("#ts-quit-cancel").addEventListener("mouseenter", () => {
        sfx("navigate");
        this._el.querySelector("#ts-quit-cancel").classList.add("is-focus");
        this._el.querySelector("#ts-quit-confirm").classList.remove("is-focus");
      });
    }

    close() {
      if (!this._el) return;
      sfx("cancel");
      this._el.remove();
      this._el = null;
      document.removeEventListener("keydown", this._keyFn, { capture: true });
    }

    _confirm() {
      sfx("select");
      game.logOut();
    }

    _onKey(e) {
      if (!this._el) return;
      if (["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(e.key)) return;
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        this.close();
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopImmediatePropagation();
        this._confirm();
      }
    }
  }

  TS.QuitUI = new TitleQuitUI();

  console.debug(TAG, "Quit UI loaded.");
})();
