// ============================================================================
// Title Screen — Load UI (Ready-Check)
//
// Thin wrapper around SaveSystemUI. Opens it in load-only mode (exact same
// parchment panel, feather cursor, slot cards) and redirects slot clicks into
// the ready-check vote flow.
//
// Flow:
//   open()          → SS.UI.openInMode("load") + hooks + sfx(lobby)
//   slot click      → sfx(confirm) → _showWait() → emitVote()
//   VOTES_UPDATE    → refresh counter / dots
//   LOAD_LOADING    → swap to progress bar
//   LOAD_PROCEED    → fill bar to 100% → success message 3 s → close
//   LOAD_CONFLICT   → sfx(fail) → error flash → re-open slot picker
//   CANCEL vote     → sfx(cancel) → close wait → re-open slot picker
//
// Note: _showWait() must be called BEFORE emitVote() so that _waitEl exists
// when the GM's synchronous onLoading/onVotesUpdate callbacks fire.
// ============================================================================
(() => {
  const TS  = globalThis.TitleScreen ??= {};
  const TAG = "[TitleScreen][LoadUI]";

  // ── Sounds (same assets as save-system) ──────────────────────────────────────
  const BASE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound";
  const SFX_URLS = {
    confirm: `${BASE}/file_selector_screen.wav`,  // slot selected → entering lobby
    lobby:   `${BASE}/check_start.wav`,            // wait panel appears (ready check start)
    cancel:  `${BASE}/bond_cleared.wav`,           // cancel vote
    ok:      `${BASE}/emotion_up.wav`,             // load successful
    fail:    `${BASE}/Soundboard/Buzzer2.ogg`,     // conflict / load error
  };
  function sfx(key) {
    try { AudioHelper?.play({ src: SFX_URLS[key], volume: 0.45, loop: false }); } catch {}
  }

  // ── Waiting / loading panel CSS (reuses ss-prog-* from save-system-css) ──────
  const WAIT_CSS = `
    #ts-wait-overlay {
      position: fixed; inset: 0; z-index: 2147483647;
      background: rgba(18, 8, 1, 0.75);
      backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
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
        0 0 80px rgba(0,0,0,0.70), inset 0 1px 0 rgba(255,245,200,0.70);
      border-radius: 4px;
      padding: 52px 52px 42px;
      display: flex; flex-direction: column; align-items: center; gap: 20px;
      min-width: 480px;
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
      border-color: #8a6010; box-shadow: 0 0 8px rgba(201,162,42,0.50);
    }
    .ts-wait-msg      { font-size: 10px; letter-spacing: 3px; color: #9b7040; text-transform: uppercase; }
    .ts-conflict-msg  { font-size: 11px; letter-spacing: 2px; color: #8b2210; text-align: center; text-transform: uppercase; }
    .ts-success-msg   { font-size: 13px; letter-spacing: 3px; color: #3a6228; text-align: center; text-transform: uppercase; }
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
      this._waitEl         = null;
      this._sel            = null;
      this._count          = 0;
      this._required       = TS.REQUIRED_PLAYERS;
      this._progressRaf    = 0;
      this._progress       = 0;
      // True while the success message is showing — prevents canvas hooks from
      // closing the overlay before the 3-second hold completes.
      this._showingSuccess = false;
    }

    // ── Open: wire into SS.UI ────────────────────────────────────────────────────

    open() {
      const SS = globalThis.SaveSystem;
      if (!SS?.UI) { console.error(TAG, "SaveSystem.UI not available."); return; }
      if (SS.UI._el) return;

      _injectWaitCSS();
      this._sel            = null;
      this._count          = 0;
      this._required       = TS.REQUIRED_PLAYERS;
      this._showingSuccess = false;

      SS.UI.openInMode("load");
      SS.UI._slotClickHook = (slotId) => this._onSlotSelect(slotId);
      SS.UI._doBack = () => {
        sfx("cancel");
        this.close();
      };
    }

    // ── Close: clean up hooks and both overlays ──────────────────────────────────

    close() {
      if (this._showingSuccess) return; // let the success message play out
      this._closeWait();
      const SS = globalThis.SaveSystem;
      if (SS?.UI) {
        SS.UI._slotClickHook = null;
        delete SS.UI._doBack;
        SS.UI.close();
      }
    }

    // ── Slot selected → show wait panel → emit vote ──────────────────────────────
    // IMPORTANT: _showWait() must come BEFORE emitVote() so _waitEl exists when
    // the GM's synchronous onLoading / onVotesUpdate callbacks fire.

    _onSlotSelect(slotId) {
      this._sel = slotId;

      // GM solo: no players connected — bypass ready-check, load directly.
      const activePlayers = (game.users?.contents ?? []).filter(u => u.active && !u.isGM);
      if (activePlayers.length === 0 && game.user?.isGM) {
        console.log(TAG, "GM-only session — loading directly.");
        globalThis.SaveSystem?.Core?.load?.(slotId);
        this.close();
        return;
      }

      sfx("confirm");

      // Detach hooks and close the slot picker
      const SS = globalThis.SaveSystem;
      SS.UI._slotClickHook = null;
      delete SS.UI._doBack;
      SS.UI.close();

      // Show the wait panel FIRST so _waitEl exists for any immediate callbacks
      this._count = 1;
      this._showWait();

      // Then vote — for GM this fires _onVote synchronously, which may call
      // onVotesUpdate / onLoading immediately (panel is now ready to receive them)
      TS.Socket.emitVote(slotId);
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

      if (!conflictMsg) sfx("lobby");

      document.getElementById("ts-wait-cancel")?.addEventListener("click", () => {
        sfx("cancel");
        TS.Socket.emitCancel();
        this._closeWait();
        this.open();
      });
    }

    _closeWait() {
      cancelAnimationFrame(this._progressRaf);
      this._waitEl?.remove();
      this._waitEl = null;
    }

    _refreshWait() {
      if (!this._waitEl) return;
      this._waitEl.querySelector(".ts-wait-counter").textContent = `${this._count} / ${this._required}`;
      this._waitEl.querySelectorAll(".ts-wait-dot").forEach((d, i) =>
        d.classList.toggle("ready", i < this._count));
    }

    // ── Socket event handlers ────────────────────────────────────────────────────

    onVotesUpdate({ count, required } = {}) {
      if (!this._waitEl) return;
      this._count    = count    ?? this._count;
      this._required = required ?? this._required;
      this._refreshWait();
    }

    onLoading(_payload) {
      if (!this._waitEl) return;
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

      // Show success message and hold for 3 seconds
      const inner = this._waitEl?.querySelector(".ts-wait-inner");
      if (inner) {
        inner.innerHTML = `
          <div class="ts-wait-title">✦  LOAD COMPLETE  ✦</div>
          <div class="ts-success-msg">— GAME DATA LOADED SUCCESSFULLY —</div>`;
        sfx("ok");
      }

      this._showingSuccess = true;
      await new Promise(r => setTimeout(r, 3000));
      this._showingSuccess = false;
      this._closeWait();
    }

    onConflict(_payload) {
      sfx("fail");
      cancelAnimationFrame(this._progressRaf);
      this._progress = 0;
      this._sel      = null;
      this._showWait("PLAYERS CHOSE DIFFERENT FILES!<br>PLEASE CHOOSE AGAIN.");
      setTimeout(() => {
        if (!this._waitEl) return;
        this._closeWait();
        this.open();
      }, 2500);
    }

    // ── Progress bar (mirrors save-ui PS1 pattern) ───────────────────────────────

    _startProgress() {
      this._progress = 0;
      cancelAnimationFrame(this._progressRaf);
      const start = performance.now(), duration = 3200, target = 0.88;
      const tick = (now) => {
        if (!this._waitEl) return;
        this._progress = Math.min((now - start) / duration, 1) * target;
        const fill = document.getElementById("ts-prog-fill");
        if (fill) fill.style.transform = `scaleX(${this._progress})`;
        if (this._progress < target) this._progressRaf = requestAnimationFrame(tick);
      };
      this._progressRaf = requestAnimationFrame(tick);
    }

    _finishProgress() {
      cancelAnimationFrame(this._progressRaf);
      const startPct = this._progress, remaining = 1 - startPct;
      const start = performance.now(), duration = 350;
      return new Promise(resolve => {
        const tick = (now) => {
          const t   = Math.min((now - start) / duration, 1);
          const pct = startPct + remaining * t;
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
