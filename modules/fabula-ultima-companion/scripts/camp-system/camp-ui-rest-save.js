// ============================================================================
// Camp System — Rest-Time Save Ceremony UI
//
// The three panels shown over the black sleep screen after the rest jingle:
//   REST_SAVE_PROMPT   "record your journey?"      YES / NO
//   REST_SAVING        progress, then the result
//   REST_TITLE_PROMPT  "return to the title screen?"  YES / NO
//
// EVERY client renders these; only the PRIMARY GM can answer. That is the whole
// point of the presentation — from a player's seat the game appears to save
// itself, the way a console JRPG does. Nothing here says "the GM is choosing":
// the cursor moves (mirrored over REST_FOCUS) and the answer lands.
//
// Decisions are executed by camp-rest-save-flow.js; this file only draws and
// reports the answer.
// ============================================================================
(() => {
  const CAMP     = globalThis.CampSystem ??= {};
  const TAG      = "[CampSystem][RestSaveUI]";
  const ID       = "oni-camp-rest-save";
  const STYLE_ID = "oni-camp-rest-save-css";

  const isPrimaryGM = () => globalThis.FUCompanion?.isPrimaryGM?.() ?? false;

  // ── Sounds ─────────────────────────────────────────────────────────────────
  // Deliberately the SAVE SYSTEM's sound set, not the camp set: this panel is
  // the save system wearing a camp costume, and the party already associates
  // these tones with the title screen's file menu.
  const BASE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound";
  const SFX_URLS = {
    open:     `${BASE}/check_start.wav`,
    navigate: `${BASE}/BattleCursor_4.wav`,
    select:   `${BASE}/file_selector_screen.wav`,
    cancel:   `${BASE}/bond_cleared.wav`,
    ok:       `${BASE}/emotion_up.wav`,
    fail:     `${BASE}/Soundboard/Buzzer2.ogg`,
  };
  function sfx(key) {
    try { AudioHelper?.play({ src: SFX_URLS[key], volume: 0.45, loop: false }); } catch {}
  }

  // ── Stylesheet ─────────────────────────────────────────────────────────────
  // z-index 1600: above #oni-camp-sleep-screen (1500) so the panel sits ON the
  // black, below the save system overlay (max int) which the GM opens on top.
  const CSS = `
    #${ID} {
      position: fixed; inset: 0; z-index: 1600;
      display: flex; align-items: center; justify-content: center;
      font-family: 'Lucida Console', 'Courier New', monospace;
      user-select: none;
      pointer-events: none;
    }
    #${ID} .rs-inner {
      position: relative;
      pointer-events: auto;
      background: linear-gradient(168deg, #f8f0d4 0%, #f0e3b8 45%, #e8d8a4 100%);
      border: 2px solid #c9a44a;
      box-shadow:
        0 0 0 3px #7a4e20, 0 0 0 6px #b8865a, 0 0 0 8px #5c3210,
        0 0 80px rgba(0,0,0,0.70), inset 0 1px 0 rgba(255,245,200,0.70);
      border-radius: 4px;
      padding: 46px 52px 38px;
      display: flex; flex-direction: column; align-items: center; gap: 18px;
      min-width: 460px;
      animation: rs-in 0.24s cubic-bezier(0.22, 1, 0.36, 1) both;
    }
    @keyframes rs-in {
      from { opacity: 0; transform: translateY(14px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    #${ID} .rs-inner::before {
      content: ''; position: absolute; inset: 0; pointer-events: none;
      border-radius: 4px;
      background: repeating-linear-gradient(
        0deg, transparent, transparent 23px,
        rgba(140,90,30,0.04) 23px, rgba(140,90,30,0.04) 24px);
    }
    #${ID} .rs-inner > * { position: relative; }
    #${ID} .rs-title { font-size: 20px; letter-spacing: 8px; color: #3a1e06; }
    #${ID} .rs-sub   { font-size: 11px; letter-spacing: 3px; color: #7a5428; text-align: center; line-height: 1.7; }
    #${ID} .rs-note  { font-size: 9px;  letter-spacing: 2px; color: #9b7040; text-align: center; text-transform: uppercase; }
    #${ID} .rs-warn  { font-size: 10px; letter-spacing: 2px; color: #8b2210; text-align: center; text-transform: uppercase; }
    #${ID} .rs-ok    { font-size: 12px; letter-spacing: 3px; color: #3a6228; text-align: center; text-transform: uppercase; }

    #${ID} .rs-btns { display: flex; gap: 12px; width: 100%; }
    #${ID} .rs-btn {
      flex: 1; padding: 13px; text-align: center;
      font-family: inherit; font-size: 11px;
      letter-spacing: 4px; text-transform: uppercase;
      border: 1px solid #9b7040;
      background: linear-gradient(180deg, #6a4828 0%, #4e3014 100%);
      color: #c8a05a; cursor: pointer; transition: all .12s;
      border-radius: 8px;
      box-shadow: 0 2px 5px rgba(40,18,4,0.30), inset 0 1px 0 rgba(255,225,140,0.10);
    }
    #${ID} .rs-btn.is-focus {
      border-color: #c9a22a; color: #fff8e0;
      background: linear-gradient(180deg, #9b6840 0%, #7a4a22 100%);
      box-shadow: 0 0 16px rgba(201,162,42,0.24), 0 2px 5px rgba(40,18,4,0.30);
    }
    #${ID} .rs-btn.is-dead { opacity: 0.4; cursor: default; }
    /* Spectator clients see the same cursor move, but cannot touch it. */
    #${ID}.is-remote .rs-btn { cursor: default; }
    #${ID}.is-remote .rs-inner { pointer-events: none; }

    #${ID} .rs-prog-track {
      width: 100%; height: 12px; border: 1px solid #9b7040; border-radius: 2px;
      background: rgba(90,55,20,0.20); overflow: hidden;
    }
    #${ID} .rs-prog-fill {
      height: 100%; width: 100%;
      transform: scaleX(0); transform-origin: left center;
      background: linear-gradient(180deg, #d8b04a 0%, #a07818 100%);
    }
    #${ID} .rs-breathe { animation: rs-breathe 1.4s ease-in-out infinite; }
    @keyframes rs-breathe { 0%,100% { opacity: 1; } 50% { opacity: 0.45; } }
  `;

  function _ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  // ---------------------------------------------------------------------------
  // Internal render state
  // ---------------------------------------------------------------------------
  let _beat      = null;    // "save" | "saving" | "title" | null
  let _focus     = "yes";   // highlighted choice
  let _blocked   = null;    // save-system refusal reason, if any
  let _progress  = 0;
  let _rafId     = 0;
  let _keyFn     = null;

  function _canAnswer() {
    return isPrimaryGM() && !!_beat && _beat !== "saving";
  }

  // Close a stray save-system overlay left over from the saving beat — the GM
  // can step phases at will from the GM panel, and the file screen renders ABOVE
  // this panel, so without this a manual Prev/Next lands the table on a black
  // screen behind an overlay that answers to a phase that is no longer current.
  // The flow hook is cleared first so the close is not reported as an exit and
  // does not advance the phase back out from under the GM.
  function _dismissSaveUI() {
    const ui = globalThis.SaveSystem?.UI;
    if (!ui?._el) return;
    ui._flowHook = null;
    ui.close();
  }

  // ---------------------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------------------
  function _mount() {
    _ensureStyle();
    let el = document.getElementById(ID);
    if (!el) {
      el = document.createElement("div");
      el.id = ID;
      document.body.appendChild(el);
    }
    el.classList.toggle("is-remote", !isPrimaryGM());
    if (!_keyFn) {
      _keyFn = _onKey;
      document.addEventListener("keydown", _keyFn, { capture: true });
    }
    return el;
  }

  function _render() {
    const el = document.getElementById(ID);
    if (!el || !_beat) return;
    el.classList.toggle("is-remote", !isPrimaryGM());
    el.innerHTML = `<div class="rs-inner">${_body()}</div>`;
    _bind(el);
  }

  function _body() {
    if (_beat === "save")   return _bodySavePrompt();
    if (_beat === "saving") return _bodySaving();
    if (_beat === "title")  return _bodyTitlePrompt();
    return "";
  }

  function _bodySavePrompt() {
    const dead = _blocked ? "is-dead" : "";
    return `
      <div class="rs-title">✦&nbsp; SAVE &nbsp;✦</div>
      <div class="rs-sub">RECORD YOUR JOURNEY?</div>
      ${_blocked ? `<div class="rs-warn">UNAVAILABLE — ${_esc(_blocked)}</div>` : ""}
      <div class="rs-btns">
        <button class="rs-btn ${_focus === "yes" ? "is-focus" : ""} ${dead}" data-choice="yes">YES</button>
        <button class="rs-btn ${_focus === "no"  ? "is-focus" : ""}"        data-choice="no" >NO</button>
      </div>`;
  }

  function _bodySaving() {
    const c = CAMP.State.getSaveChoice();
    // Result beat — the write has landed (or failed).
    if (c.ok === true) {
      return `
        <div class="rs-title">✦&nbsp; SAVE &nbsp;✦</div>
        <div class="rs-prog-track"><div class="rs-prog-fill" style="transform:scaleX(1)"></div></div>
        <div class="rs-ok">DATA WRITTEN — SLOT ${c.slotId}</div>`;
    }
    if (c.ok === false) {
      return `
        <div class="rs-title">✦&nbsp; SAVE &nbsp;✦</div>
        <div class="rs-warn">WRITE FAILED</div>
        <div class="rs-note">${_esc(c.error ?? "unknown error")}</div>`;
    }
    // In-flight.
    return `
      <div class="rs-title">✦&nbsp; SAVE &nbsp;✦</div>
      <div class="rs-prog-track"><div class="rs-prog-fill"></div></div>
      <div class="rs-note rs-breathe">WRITING DATA…</div>`;
  }

  function _bodyTitlePrompt() {
    const c = CAMP.State.getSaveChoice();
    let status = "";
    if (c.ok === true)       status = `<div class="rs-ok">SAVED — SLOT ${c.slotId}</div>`;
    else if (c.asked)        status = `<div class="rs-warn">THIS SESSION HAS NOT BEEN SAVED</div>`;
    return `
      <div class="rs-title">✦&nbsp; TITLE &nbsp;✦</div>
      ${status}
      <div class="rs-sub">RETURN TO THE TITLE SCREEN?</div>
      <div class="rs-btns">
        <button class="rs-btn ${_focus === "yes" ? "is-focus" : ""}" data-choice="yes">YES</button>
        <button class="rs-btn ${_focus === "no"  ? "is-focus" : ""}" data-choice="no" >NO</button>
      </div>`;
  }

  function _bind(el) {
    if (!_canAnswer()) return;
    el.querySelectorAll("[data-choice]").forEach(btn => {
      btn.addEventListener("click", () => _answer(btn.dataset.choice));
      btn.addEventListener("mouseenter", () => _setFocus(btn.dataset.choice));
    });
  }

  function _esc(s) {
    return String(s ?? "").replace(/[<>&]/g, ch => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[ch]));
  }

  // ---------------------------------------------------------------------------
  // Interaction (primary GM only)
  // ---------------------------------------------------------------------------
  function _setFocus(choice, { broadcast = true } = {}) {
    if (choice !== "yes" && choice !== "no") return;
    if (_focus === choice) return;
    _focus = choice;
    sfx("navigate");
    _paintFocus();
    // Mirror the cursor so every other screen sees the game "deciding".
    if (broadcast && isPrimaryGM()) {
      CAMP.Socket.broadcast(CAMP.MSG.REST_FOCUS, { choice });
    }
  }

  // Repaint only the highlight — a full _render() would restart the panel's
  // entry animation on every cursor move.
  function _paintFocus() {
    const el = document.getElementById(ID);
    if (!el) return;
    el.querySelectorAll("[data-choice]").forEach(b =>
      b.classList.toggle("is-focus", b.dataset.choice === _focus));
  }

  function _answer(choice) {
    if (!_canAnswer()) return;
    if (_beat === "save" && choice === "yes" && _blocked) { sfx("fail"); return; }
    sfx(choice === "yes" ? "select" : "cancel");
    const beat = _beat;
    // Lock the panel: the flow is about to change phase, and a second click in
    // the gap would answer twice.
    _beat = null;
    if (beat === "save")  CAMP.RestSaveFlow?.answerSave(choice === "yes");
    if (beat === "title") CAMP.RestSaveFlow?.answerTitle(choice === "yes");
  }

  function _onKey(e) {
    if (!_canAnswer()) return;
    if (["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(e.key)) return;
    if (["ArrowLeft", "ArrowUp"].includes(e.key)) {
      e.preventDefault(); e.stopImmediatePropagation();
      _setFocus("yes");
    } else if (["ArrowRight", "ArrowDown"].includes(e.key)) {
      e.preventDefault(); e.stopImmediatePropagation();
      _setFocus("no");
    } else if (e.key === "Enter") {
      e.preventDefault(); e.stopImmediatePropagation();
      _answer(_focus);
    } else if (e.key === "Escape") {
      // ESC is "no" here, never "dismiss" — the ceremony must resolve or the
      // party is stranded on a black screen with no controls.
      e.preventDefault(); e.stopImmediatePropagation();
      _answer("no");
    }
  }

  // ---------------------------------------------------------------------------
  // Progress animation (spectators; the GM watches the save system's own bar)
  // ---------------------------------------------------------------------------
  function _startProgress() {
    cancelAnimationFrame(_rafId);
    _progress = 0;
    const start = performance.now();
    const tick = (now) => {
      if (_beat !== "saving") return;
      const t   = Math.min((now - start) / 3200, 1);   // same curve as save-ui
      _progress = t * 0.88;
      const fill = document.querySelector(`#${ID} .rs-prog-fill`);
      if (fill) fill.style.transform = `scaleX(${_progress})`;
      if (t < 1) _rafId = requestAnimationFrame(tick);
    };
    _rafId = requestAnimationFrame(tick);
  }

  // ---------------------------------------------------------------------------
  // Public API — called by camp-bootstrap on phase change
  // ---------------------------------------------------------------------------
  CAMP.RestSaveUI = {
    /** "Record your journey?" — YES default. */
    showSavePrompt() {
      _beat    = "save";
      _focus   = "yes";
      // Grey the YES with the real reason rather than letting the GM pick a slot
      // and hit a wall (a poisoned client, a non-primary GM, a load in flight).
      _blocked = globalThis.SaveSystem?.Core?.blockedReason?.("save") ?? null;
      // Only the client that could actually answer cares about the refusal.
      if (!isPrimaryGM()) _blocked = null;
      _dismissSaveUI();
      _mount();
      _render();
      sfx("open");
    },

    /** Progress panel. The primary GM sees the save system's file screen instead. */
    showSaving() {
      _beat = "saving";
      if (isPrimaryGM()) { this.hide(); return; }
      _mount();
      _render();
      _startProgress();
    },

    /** "Return to the title screen?" — YES default. */
    showTitlePrompt() {
      _beat  = "title";
      _focus = "yes";
      _dismissSaveUI();
      _mount();
      _render();
      sfx("open");
    },

    /** SAVE_CHOICE changed — refresh the saving/title panel's status lines. */
    onSaveChoiceUpdate() {
      if (_beat !== "saving" && _beat !== "title") return;
      if (_beat === "saving") {
        const c = CAMP.State.getSaveChoice();
        // The GM is watching the save system's own panel, which already played
        // its result sting — don't double it up on that one client.
        if (!isPrimaryGM()) {
          if (c.ok === true)  sfx("ok");
          if (c.ok === false) sfx("fail");
        }
        cancelAnimationFrame(_rafId);
      }
      _render();
    },

    /** Cursor mirror from the primary GM. */
    onRemoteFocus(choice) {
      if (isPrimaryGM()) return;   // we are the source, not a mirror
      _setFocus(choice, { broadcast: false });
    },

    hide() {
      cancelAnimationFrame(_rafId);
      document.getElementById(ID)?.remove();
      if (_keyFn) {
        document.removeEventListener("keydown", _keyFn, { capture: true });
        _keyFn = null;
      }
    },

    /** Full teardown — ceremony resolved, or leaving the camp scene. */
    cleanup() {
      // Only reclaim the save overlay if the ceremony was live on this client —
      // a GM who opened the save menu by hand keeps it.
      if (_beat) _dismissSaveUI();
      _beat = null;
      this.hide();
    },
  };

  console.debug(TAG, "Rest save UI loaded.");
})();
