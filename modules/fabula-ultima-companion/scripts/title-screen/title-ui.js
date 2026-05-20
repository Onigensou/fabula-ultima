// ============================================================================
// Title Screen — Main UI
//
// Full-screen overlay shown to all connected users when a scene is set to
// "Title" mode. State machine:
//
//   "pressany" → (any key / click) → "menu"
//   "menu"     → Load Game btn     → TitleScreen.LoadUI.open()
//   "menu"     → New Game / Options / Quit → placeholder stubs
//   "menu"     → ESC               → "pressany"
//
// Open via: TitleScreen.UI.open()  (called by title-bootstrap.js)
// ============================================================================
(() => {
  const TS  = globalThis.TitleScreen ??= {};
  const TAG = "[TitleScreen][UI]";

  // ── Sounds ───────────────────────────────────────────────────────────────────
  const SFX = {
    anyKey:  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/check_start.wav",
    navigate:"https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_4.wav",
    select:  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/file_selector_screen.wav",
    cancel:  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/bond_cleared.wav",
  };
  function sfx(key) {
    try { AudioHelper?.play({ src: SFX[key], volume: 0.45, loop: false }); } catch {}
  }

  // ── Stylesheet ───────────────────────────────────────────────────────────────
  const CSS = `
    #ts-overlay {
      position: fixed; inset: 0; z-index: 2147483646;
      background: rgba(4, 2, 10, 0.92);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      font-family: 'Lucida Console', 'Courier New', monospace;
      user-select: none;
      animation: ts-fade-in 0.40s ease-out both;
    }
    #ts-overlay.is-closing {
      animation: ts-fade-out 0.30s ease-in forwards;
      pointer-events: none;
    }

    /* === press any key screen === */
    .ts-pressany {
      display: flex; flex-direction: column; align-items: center; gap: 48px;
    }
    .ts-pressany-logo {
      font-size: clamp(28px, 5vw, 56px);
      letter-spacing: clamp(8px, 2vw, 22px);
      color: #e8dfc0;
      text-shadow:
        0 0 40px rgba(220,180,80,0.45),
        0 0 80px rgba(180,130,40,0.20),
        0 2px 0 rgba(0,0,0,0.60);
      text-align: center;
    }
    .ts-pressany-prompt {
      font-size: 13px; letter-spacing: 6px; color: #a09060;
      text-transform: uppercase;
      animation: ts-pulse 1.8s ease-in-out infinite;
    }

    /* === menu screen === */
    .ts-menu {
      display: flex; flex-direction: column; align-items: center; gap: 14px;
      animation: ts-menu-in 0.28s cubic-bezier(0.22, 1, 0.36, 1) both;
    }
    .ts-menu-title {
      font-size: clamp(20px, 3.5vw, 40px);
      letter-spacing: clamp(6px, 1.5vw, 16px);
      color: #e8dfc0;
      text-shadow: 0 0 30px rgba(220,180,80,0.35), 0 2px 0 rgba(0,0,0,0.60);
      margin-bottom: 24px; text-align: center;
    }
    .ts-menu-btn {
      width: clamp(280px, 40vw, 500px);
      padding: 18px 36px;
      font-family: inherit; font-size: 15px; letter-spacing: 5px;
      text-transform: uppercase; text-align: center;
      color: #c8b870;
      background: transparent;
      border: 1px solid rgba(180,150,60,0.30);
      border-radius: 3px;
      cursor: pointer;
      transition: color .12s, border-color .12s, background .12s, box-shadow .12s;
    }
    .ts-menu-btn:hover, .ts-menu-btn.is-focus {
      color: #f5e8a0;
      border-color: rgba(220,180,80,0.70);
      background: rgba(180,140,40,0.12);
      box-shadow: 0 0 24px rgba(220,180,80,0.20), inset 0 0 18px rgba(220,180,80,0.06);
    }
    .ts-menu-btn.is-stub {
      opacity: 0.40; cursor: default; pointer-events: none;
    }
    .ts-menu-cursor {
      position: absolute; left: 0;
      font-size: 13px; color: #c8a030;
      transition: top 0.15s cubic-bezier(0.22, 1, 0.36, 1);
      pointer-events: none;
    }

    /* === animations === */
    @keyframes ts-fade-in  { from{opacity:0} to{opacity:1} }
    @keyframes ts-fade-out { from{opacity:1} to{opacity:0} }
    @keyframes ts-pulse {
      0%,100% { opacity: 0.25; }
      50%      { opacity: 1;    }
    }
    @keyframes ts-menu-in {
      from { opacity: 0; transform: translateY(20px); }
      to   { opacity: 1; transform: translateY(0); }
    }
  `;

  // ── Menu items ───────────────────────────────────────────────────────────────
  const MENU_ITEMS = [
    { id: "new-game",  label: "New Game",  stub: true  },
    { id: "load-game", label: "Load Game", stub: false },
    { id: "options",   label: "Options",   stub: true  },
    { id: "quit",      label: "Quit",      stub: true  },
  ];

  // ── UI class ─────────────────────────────────────────────────────────────────

  class TitleUI {
    constructor() {
      this._el     = null;
      this._screen = "pressany";   // "pressany" | "menu"
      this._focus  = 0;            // index into MENU_ITEMS
      this._keyFn  = this._onKey.bind(this);
    }

    // ── Lifecycle ───────────────────────────────────────────────────────────────

    open() {
      if (this._el) { this._el.focus(); return; }
      this._injectCSS();

      this._screen = "pressany";
      this._focus  = 0;

      this._el = document.createElement("div");
      this._el.id = "ts-overlay";
      this._el.setAttribute("tabindex", "-1");
      document.body.appendChild(this._el);
      document.addEventListener("keydown", this._keyFn, { capture: true });

      this._render();
      this._el.focus();
    }

    close(_skipAnim = false) {
      if (!this._el) return;
      if (!_skipAnim) {
        if (this._el.classList.contains("is-closing")) return;
        this._el.classList.add("is-closing");
        setTimeout(() => this.close(true), 310);
        return;
      }
      this._el.remove();
      this._el     = null;
      this._screen = "pressany";
      this._focus  = 0;
      document.removeEventListener("keydown", this._keyFn, { capture: true });
    }

    _injectCSS() {
      if (document.getElementById("ts-overlay-css")) return;
      const s = document.createElement("style");
      s.id = "ts-overlay-css";
      s.textContent = CSS;
      document.head.appendChild(s);
    }

    // ── Rendering ───────────────────────────────────────────────────────────────

    _render() {
      if (!this._el) return;
      this._el.innerHTML = this._screen === "menu"
        ? this._htmlMenu()
        : this._htmlPressAny();
      this._bind();
    }

    _htmlPressAny() {
      return `
        <div class="ts-pressany" data-act="any">
          <div class="ts-pressany-logo">FABULA ULTIMA</div>
          <div class="ts-pressany-prompt">— Press Any Key —</div>
        </div>`;
    }

    _htmlMenu() {
      const btns = MENU_ITEMS.map((item, i) => {
        const focus = i === this._focus ? "is-focus" : "";
        const stub  = item.stub ? "is-stub" : "";
        return `<button class="ts-menu-btn ${focus} ${stub}" data-act="menu" data-id="${item.id}">${item.label}</button>`;
      }).join("");

      return `
        <div class="ts-menu">
          <div class="ts-menu-title">FABULA ULTIMA</div>
          ${btns}
        </div>`;
    }

    // ── Event binding ───────────────────────────────────────────────────────────

    _bind() {
      if (!this._el) return;

      // Press-any screen: click or any child interaction advances to menu
      const anyEl = this._el.querySelector("[data-act='any']");
      if (anyEl) {
        anyEl.addEventListener("click", () => this._advanceToMenu());
      }

      // Menu buttons
      this._el.querySelectorAll("[data-act='menu']").forEach((el, i) => {
        el.addEventListener("click", () => {
          if (el.classList.contains("is-stub")) return;
          this._focus = i;
          this._onSelect(el.dataset.id);
        });
        el.addEventListener("mouseenter", () => {
          if (el.classList.contains("is-stub")) return;
          sfx("navigate");
          this._focus = i;
          this._el.querySelectorAll("[data-act='menu']").forEach((b, j) =>
            b.classList.toggle("is-focus", j === i));
        });
      });
    }

    // ── Key handling ────────────────────────────────────────────────────────────

    _onKey(e) {
      if (!this._el) return;

      // Ignore pure modifier keys
      if (["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(e.key)) return;

      if (this._screen === "pressany") {
        // Any key advances — but let the Load UI handle its own keys if open
        if (TS.LoadUI?._el) return;
        e.stopImmediatePropagation();
        this._advanceToMenu();
        return;
      }

      // Menu navigation
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        sfx("cancel");
        this._screen = "pressany";
        this._focus  = 0;
        this._render();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        this._moveFocus(1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        this._moveFocus(-1);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const item = MENU_ITEMS[this._focus];
        if (item && !item.stub) this._onSelect(item.id);
      }
    }

    _moveFocus(dir) {
      const nonStub = MENU_ITEMS.reduce((acc, item, i) => {
        if (!item.stub) acc.push(i);
        return acc;
      }, []);
      const curIdx  = nonStub.indexOf(this._focus);
      const nextIdx = Math.max(0, Math.min(nonStub.length - 1, curIdx + dir));
      if (nonStub[nextIdx] !== this._focus) {
        this._focus = nonStub[nextIdx];
        sfx("navigate");
        this._el.querySelectorAll("[data-act='menu']").forEach((b, j) =>
          b.classList.toggle("is-focus", j === this._focus));
      }
    }

    // ── Actions ─────────────────────────────────────────────────────────────────

    _advanceToMenu() {
      sfx("anyKey");
      this._screen = "menu";
      this._focus  = MENU_ITEMS.findIndex(m => !m.stub);
      this._render();
    }

    _onSelect(id) {
      sfx("select");
      switch (id) {
        case "load-game":
          TS.LoadUI.open();
          break;
        case "new-game":
          console.log(TAG, "New Game — placeholder.");
          break;
        case "options":
          console.log(TAG, "Options — placeholder.");
          break;
        case "quit":
          console.log(TAG, "Quit — placeholder.");
          break;
      }
    }
  }

  TS.UI = new TitleUI();

  console.debug(TAG, "UI loaded.");
})();
