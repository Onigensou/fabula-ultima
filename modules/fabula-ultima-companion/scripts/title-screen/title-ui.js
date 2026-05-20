// ============================================================================
// Title Screen — Main UI
//
// Transparent HUD layer that floats over the normal Foundry scene background.
// No dark overlay, no blur — the scene art shows through completely.
//
//   "pressany" → (any key / click) → "menu"
//   "menu"     → Load Game         → TitleScreen.LoadUI.open()
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
    /* Transparent full-screen container — scene shows through entirely.
       pointer-events: none so scene canvas remains interactive underneath;
       child elements opt back in with pointer-events: auto. */
    #ts-overlay {
      position: fixed; inset: 0; z-index: 2147483646;
      background: transparent;
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      font-family: 'Lucida Console', 'Courier New', monospace;
      user-select: none;
      pointer-events: none;
    }

    /* === press any key === */
    .ts-pressany {
      pointer-events: auto;
      display: flex; flex-direction: column; align-items: center; gap: 0;
      cursor: pointer;
      animation: ts-fade-in 0.40s ease-out both;
    }
    .ts-pressany-prompt {
      font-size: 14px; letter-spacing: 6px; color: #e8dfc0;
      text-transform: uppercase;
      text-shadow:
        0 0 20px rgba(220,180,80,0.70),
        0 1px 4px rgba(0,0,0,0.90);
      animation: ts-pulse 1.8s ease-in-out infinite;
    }

    /* === menu === */
    .ts-menu {
      pointer-events: auto;
      display: flex; flex-direction: column; align-items: center; gap: 8px;
      animation: ts-fade-in 0.22s ease-out both;
    }
    .ts-menu-btn {
      min-width: 220px;
      padding: 12px 32px;
      font-family: inherit; font-size: 13px; letter-spacing: 5px;
      text-transform: uppercase; text-align: center;
      color: #d4c080;
      background: rgba(0,0,0,0.45);
      border: 1px solid rgba(180,150,60,0.35);
      border-radius: 2px;
      cursor: pointer;
      transition: color .12s, border-color .12s, background .12s, box-shadow .12s;
      text-shadow: 0 1px 3px rgba(0,0,0,0.80);
    }
    .ts-menu-btn:hover, .ts-menu-btn.is-focus {
      color: #f8eeaa;
      border-color: rgba(220,180,80,0.75);
      background: rgba(0,0,0,0.62);
      box-shadow: 0 0 18px rgba(220,180,80,0.22);
    }
    .ts-menu-btn.is-stub {
      opacity: 0.35; cursor: default; pointer-events: none;
    }

    /* === animations === */
    @keyframes ts-fade-in { from{opacity:0} to{opacity:1} }
    @keyframes ts-pulse {
      0%,100% { opacity: 0.30; }
      50%      { opacity: 1;   }
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
      this._screen = "pressany";
      this._focus  = 0;
      this._keyFn  = this._onKey.bind(this);
    }

    // ── Lifecycle ───────────────────────────────────────────────────────────────

    open() {
      if (this._el) return;
      this._injectCSS();

      this._screen = "pressany";
      this._focus  = 0;

      this._el = document.createElement("div");
      this._el.id = "ts-overlay";
      document.body.appendChild(this._el);
      document.addEventListener("keydown", this._keyFn, { capture: true });

      this._render();
    }

    close(_skipAnim = false) {
      if (!this._el) return;
      // Simple immediate removal — no fade needed since scene is already visible
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
      return `<div class="ts-pressany" data-act="any">
        <div class="ts-pressany-prompt">— Press Any Key —</div>
      </div>`;
    }

    _htmlMenu() {
      const btns = MENU_ITEMS.map((item, i) => {
        const focus = i === this._focus ? "is-focus" : "";
        const stub  = item.stub ? "is-stub" : "";
        return `<button class="ts-menu-btn ${focus} ${stub}" data-act="menu" data-id="${item.id}">${item.label}</button>`;
      }).join("");
      return `<div class="ts-menu">${btns}</div>`;
    }

    // ── Event binding ───────────────────────────────────────────────────────────

    _bind() {
      if (!this._el) return;

      this._el.querySelector("[data-act='any']")
        ?.addEventListener("click", () => this._advanceToMenu());

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
      if (["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(e.key)) return;

      if (this._screen === "pressany") {
        if (TS.LoadUI?._el) return;
        e.stopImmediatePropagation();
        this._advanceToMenu();
        return;
      }

      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        sfx("cancel");
        this._screen = "pressany";
        this._focus  = 0;
        this._render();
        return;
      }
      if (e.key === "ArrowDown") { e.preventDefault(); this._moveFocus(1);  return; }
      if (e.key === "ArrowUp")   { e.preventDefault(); this._moveFocus(-1); return; }
      if (e.key === "Enter") {
        e.preventDefault();
        const item = MENU_ITEMS[this._focus];
        if (item && !item.stub) this._onSelect(item.id);
      }
    }

    _moveFocus(dir) {
      const selectable = MENU_ITEMS.reduce((acc, m, i) => { if (!m.stub) acc.push(i); return acc; }, []);
      const cur  = selectable.indexOf(this._focus);
      const next = selectable[Math.max(0, Math.min(selectable.length - 1, cur + dir))];
      if (next !== this._focus) {
        this._focus = next;
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
        case "load-game": TS.LoadUI.open();                               break;
        case "new-game":  console.log(TAG, "New Game — placeholder.");   break;
        case "options":   console.log(TAG, "Options — placeholder.");    break;
        case "quit":      console.log(TAG, "Quit — placeholder.");       break;
      }
    }
  }

  TS.UI = new TitleUI();

  console.debug(TAG, "UI loaded.");
})();
