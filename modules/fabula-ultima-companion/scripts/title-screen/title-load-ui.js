// ============================================================================
// Title Screen — Load UI (Ready-Check)
//
// Thin wrapper around the existing SaveSystemUI. Opens SS.UI directly in
// load-only mode (exact same parchment panel, feather cursor, slot cards) and
// intercepts the slot click to emit a ready-check vote instead of loading.
//
// Flow:
//   open()        → SS.UI.openInMode("load") + install hooks
//   slot click    → emit TITLE_LOAD_VOTE  → close SS.UI → show waiting panel
//   CANCEL        → emit TITLE_LOAD_CANCEL → close waiting → re-open SS.UI
//   VOTES_UPDATE  → update waiting panel counter
//   CONFLICT      → close waiting → flash error → re-open SS.UI
//   PROCEED       → close waiting (GM already executed the load)
// ============================================================================
(() => {
  const TS  = globalThis.TitleScreen ??= {};
  const TAG = "[TitleScreen][LoadUI]";

  // ── Sounds ───────────────────────────────────────────────────────────────────
  const SFX = {
    ok:   "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/emotion_up.wav",
    fail: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Buzzer2.ogg",
  };
  function sfx(key) {
    try { AudioHelper?.play({ src: SFX[key], volume: 0.45, loop: false }); } catch {}
  }

  // ── Waiting panel CSS (appended once; reuses save-system-css for the rest) ──
  const WAIT_CSS = `
    #ts-wait-overlay {
      position: fixed; inset: 0; z-index: 2147483647;
      background: rgba(18, 8, 1, 0.75);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      display: flex; align-items: center; justify-content: center;
      font-family: 'Lucida Console', 'Courier New', monospace;
      user-select: none;
    }
    .ts-wait-inner {
      position: relative;
      background: linear-gradient(168deg, #f8f0d4 0%, #f0e3b8 45%, #e8d8a4 100%);
      border: 2px solid #c9a44a;
      box-shadow:
        0 0 0 3px #7a4e20, 0 0 0 6px #b8865a, 0 0 0 8px #5c3210,
        0 0 80px rgba(0,0,0,0.70),
        inset 0 1px 0 rgba(255,245,200,0.70);
      border-radius: 4px;
      padding: 52px 52px 42px;
      display: flex; flex-direction: column; align-items: center; gap: 20px;
      min-width: 420px;
      animation: ss-panel-in 0.22s cubic-bezier(0.22, 1, 0.36, 1) both;
    }
    .ts-wait-inner::before {
      content: ''; position: absolute; inset: 0; pointer-events: none;
      border-radius: 4px;
      background: repeating-linear-gradient(0deg, transparent, transparent 23px, rgba(140,90,30,0.04) 23px, rgba(140,90,30,0.04) 24px);
    }
    .ts-wait-inner > * { position: relative; }
    .ts-wait-title   { font-size: 22px; letter-spacing: 8px; color: #3a1e06; }
    .ts-wait-slot    { font-size: 11px; letter-spacing: 3px; color: #7a5428; text-align: center; }
    .ts-wait-counter { font-size: 38px; letter-spacing: 6px; color: #3a1e06; }
    .ts-wait-dots    { display: flex; gap: 10px; }
    .ts-wait-dot {
      width: 14px; height: 14px; border-radius: 50%;
      border: 1px solid #c4a260;
      background: linear-gradient(155deg, #fdf6e0 0%, #e8d8a4 100%);
      transition: background .25s, border-color .25s, box-shadow .25s;
    }
    .ts-wait-dot.ready {
      background: linear-gradient(155deg, #c9a22a 0%, #a07818 100%);
      border-color: #8a6010;
      box-shadow: 0 0 8px rgba(201,162,42,0.50);
    }
    .ts-wait-msg    { font-size: 10px; letter-spacing: 3px; color: #9b7040; text-transform: uppercase; }
    .ts-conflict-msg { font-size: 11px; letter-spacing: 2px; color: #8b2210; text-align: center; text-transform: uppercase; }
  `;

  function _injectWaitCSS() {
    if (document.getElementById("ts-wait-css")) return;
    const s = document.createElement("style");
    s.id = "ts-wait-css";
    s.textContent = WAIT_CSS;
    document.head.appendChild(s);
  }

  // ── UI class ──────────────────────────────────────────────────────────────────

  class TitleLoadUI {
    constructor() {
      this._waitEl      = null;
      this._sel         = null;
      this._count       = 0;
      this._required    = TS.REQUIRED_PLAYERS;
      this._progressRaf = 0;
      this._progress    = 0;
    }

    // ── Open: wire into SS.UI ────────────────────────────────────────────────────

    open() {
      const SS = globalThis.SaveSystem;
      if (!SS?.UI) { console.error(TAG, "SaveSystem UI not available."); return; }
      if (SS.UI._el) return; // already open

      _injectWaitCSS();
      this._sel      = null;
      this._count    = 0;
      this._required = TS.REQUIRED_PLAYERS;

      // Open the real save UI in load mode (exact same look)
      SS.UI.openInMode("load");

      // Intercept slot clicks → vote instead of confirm
      SS.UI._slotClickHook = (slotId) => this._onSlotSelect(slotId);

      // Override back from the file screen to return to title menu instead of mode screen
      SS.UI._doBack = () => {
        AudioHelper?.play({ src: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/bond_cleared.wav", volume: 0.45, loop: false });
        this.close();
      };
    }

    // ── Close: clean up hooks and both overlays ──────────────────────────────────

    close() {
      this._closeWait();
      const SS = globalThis.SaveSystem;
      if (SS?.UI) {
        SS.UI._slotClickHook = null;
        delete SS.UI._doBack; // restore prototype method
        SS.UI.close();
      }
    }

    // ── Slot selected → emit vote, close slot picker, show waiting panel ─────────

    _onSlotSelect(slotId) {
      this._sel = slotId;

      // GM solo mode: no players connected, bypass ready-check and load directly
      const activePlayers = (game.users?.contents ?? []).filter(u => u.active && !u.isGM);
      if (activePlayers.length === 0 && game.user?.isGM) {
        console.log(TAG, "GM-only session — loading directly.");
        globalThis.SaveSystem?.Core?.load?.(slotId);
        this.close();
        return;
      }

      // Close the slot picker and show the waiting panel
      const SS = globalThis.SaveSystem;
      SS.UI._slotClickHook = null;
      delete SS.UI._doBack;
      SS.UI.close();

      TS.Socket.emitVote(slotId);
      this._count = 1; // count self optimistically
      this._showWait();
    }

    // ── Waiting panel ────────────────────────────────────────────────────────────

    _showWait(conflictMsg = null) {
      _injectWaitCSS();
      if (this._waitEl) this._waitEl.remove();

      const SS  = globalThis.SaveSystem;
      const d   = this._sel ? SS?.Storage?.getSlot?.(this._sel) : null;
      const lbl = d?.label ?? `Slot ${this._sel ?? "?"}`;

      const dots = Array.from({ length: this._required }, (_, i) =>
        `<div class="ts-wait-dot${i < this._count ? " ready" : ""}"></div>`
      ).join("");

      const body = conflictMsg
        ? `<div class="ts-conflict-msg ss-breathe">${conflictMsg}</div>`
        : `<div class="ts-wait-msg ss-breathe">Waiting for other players…</div>
           <button class="ss-back-btn" id="ts-wait-cancel" style="width:100%;margin-top:4px;">◄ CHANGE CHOICE</button>`;

      this._waitEl = document.createElement("div");
      this._waitEl.id = "ts-wait-overlay";
      this._waitEl.innerHTML = `
        <div class="ts-wait-inner">
          <div class="ts-wait-title">✦  READY CHECK  ✦</div>
          <div class="ts-wait-slot">${lbl}</div>
          <div class="ts-wait-counter">${this._count} / ${this._required}</div>
          <div class="ts-wait-dots">${dots}</div>
          ${body}
        </div>`;
      document.body.appendChild(this._waitEl);

      document.getElementById("ts-wait-cancel")?.addEventListener("click", () => {
        TS.Socket.emitCancel();
        this._closeWait();
        this.open(); // re-open slot picker
      });
    }

    _closeWait() {
      this._waitEl?.remove();
      this._waitEl = null;
    }

    _refreshWait() {
      if (!this._waitEl) return;
      // Update counter and dots in-place without a full re-render
      this._waitEl.querySelector(".ts-wait-counter").textContent = `${this._count} / ${this._required}`;
      const dots = this._waitEl.querySelectorAll(".ts-wait-dot");
      dots.forEach((d, i) => d.classList.toggle("ready", i < this._count));
    }

    // ── Socket event handlers (called by title-socket.js) ────────────────────────

    onVotesUpdate({ count, required } = {}) {
      if (!this._waitEl) return;
      this._count    = count    ?? this._count;
      this._required = required ?? this._required;
      this._refreshWait();
    }

    onLoading(_payload) {
      if (!this._waitEl) return;
      // Swap waiting panel body to show the PS1-style progress bar
      const inner = this._waitEl.querySelector(".ts-wait-inner");
      if (!inner) return;
      inner.innerHTML = `
        <div class="ts-wait-title">✦  LOADING  ✦</div>
        <div class="ts-wait-slot" style="font-size:10px;letter-spacing:2px;color:#7a5428;">READING SAVE DATA…</div>
        <div style="width:100%;">
          <div class="ss-prog-track"><div class="ss-prog-fill" id="ts-prog-fill"></div></div>
          <div class="ss-prog-label ss-breathe">PLEASE WAIT…</div>
        </div>`;
      this._startProgress();
    }

    async onProceed(_payload) {
      await this._finishProgress();
      sfx("ok");
      this._closeWait();
    }

    onConflict(_payload) {
      sfx("fail");
      cancelAnimationFrame(this._progressRaf);
      this._progress = 0;
      this._sel = null;
      this._showWait("PLAYERS CHOSE DIFFERENT FILES!<br>PLEASE CHOOSE AGAIN.");
      setTimeout(() => {
        if (!this._waitEl) return;
        this._closeWait();
        this.open(); // re-open the slot picker
      }, 2500);
    }

    // ── Progress bar (mirrors save-ui pattern) ───────────────────────────────────

    _startProgress() {
      this._progress = 0;
      cancelAnimationFrame(this._progressRaf);
      const start    = performance.now();
      const duration = 3200;
      const target   = 0.88;
      const tick = (now) => {
        if (!this._waitEl) return;
        const t    = Math.min((now - start) / duration, 1);
        this._progress = t * target;
        const fill = document.getElementById("ts-prog-fill");
        if (fill) fill.style.transform = `scaleX(${this._progress})`;
        if (t < 1) this._progressRaf = requestAnimationFrame(tick);
      };
      this._progressRaf = requestAnimationFrame(tick);
    }

    _finishProgress() {
      cancelAnimationFrame(this._progressRaf);
      const startPct  = this._progress;
      const remaining = 1 - startPct;
      const duration  = 350;
      const start     = performance.now();
      return new Promise(resolve => {
        const tick = (now) => {
          const t    = Math.min((now - start) / duration, 1);
          const pct  = startPct + remaining * t;
          const fill = document.getElementById("ts-prog-fill");
          if (fill) fill.style.transform = `scaleX(${pct})`;
          if (t < 1) requestAnimationFrame(tick);
          else setTimeout(resolve, 300);
        };
        requestAnimationFrame(tick);
      });
    }
  }

  TS.LoadUI = new TitleLoadUI();

  console.debug(TAG, "Load UI loaded.");
})();
