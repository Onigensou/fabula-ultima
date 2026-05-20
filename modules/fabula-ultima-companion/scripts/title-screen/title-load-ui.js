// ============================================================================
// Title Screen — Load UI (Ready-Check)
//
// Each player opens this independently when they click "Load Game" from the
// title menu. The UI has three screens:
//
//   "slot"    — load-only slot picker (only non-empty slots are selectable)
//   "waiting" — player voted; shows live X / N counter from socket updates
//   "result"  — brief conflict flash before returning to "slot"
//
// Socket integration (see title-socket.js):
//   Player clicks slot  → emitVote()         → GM aggregates
//   Player clicks back  → emitCancel()        → GM removes vote
//   GM detects agree    → LOAD_PROCEED fires  → onProceed()
//   GM detects conflict → LOAD_CONFLICT fires → onConflict()
//
// GM solo edge-case: if no non-GM users are active, skip ready-check and
// directly call SS.Core.load() (useful for GM testing alone).
// ============================================================================
(() => {
  const TS  = globalThis.TitleScreen ??= {};
  const TAG = "[TitleScreen][LoadUI]";

  // ── Sounds (reuse save-system sfx assets) ────────────────────────────────────
  const SFX = {
    navigate: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_4.wav",
    cancel:   "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/bond_cleared.wav",
    confirm:  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/check_start.wav",
    ok:       "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/emotion_up.wav",
    fail:     "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Buzzer2.ogg",
  };
  function sfx(key) {
    try { AudioHelper?.play({ src: SFX[key], volume: 0.45, loop: false }); } catch {}
  }

  // ── Date formatter (mirrors save-ui) ─────────────────────────────────────────
  function fmtDate(iso) {
    if (!iso) return "—";
    try {
      const d = new Date(iso), pad = n => String(n).padStart(2, "0");
      return `${d.getFullYear()}/${pad(d.getMonth()+1)}/${pad(d.getDate())}  ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    } catch { return "—"; }
  }

  // ── Token portrait helper (mirrors save-ui) ───────────────────────────────────
  function actorTokenImg(actor) {
    if (!actor) return "";
    const sceneToken = Array.from(canvas?.tokens?.placeables ?? [])
      .find(t => t?.actor?.uuid === actor.uuid || t?.document?.actorId === actor.id);
    return (
      sceneToken?.document?.texture?.src ??
      sceneToken?.texture?.src ??
      actor.prototypeToken?.texture?.src ??
      actor.img ?? ""
    );
  }

  // ── Additional CSS (slot CSS is already injected by save-ui) ─────────────────
  const EXTRA_CSS = `
    #ts-load-overlay {
      position: fixed; inset: 0; z-index: 2147483647;
      background: rgba(18, 8, 1, 0.80);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      font-family: 'Lucida Console', 'Courier New', monospace;
      color: #3d2208;
      user-select: none;
      animation: ss-overlay-in 0.18s ease-out both;
    }
    #ts-load-overlay.is-closing {
      animation: ss-overlay-out 0.20s ease-in forwards;
      pointer-events: none;
    }

    /* waiting screen */
    .ts-wait-panel {
      position: relative; z-index: 1;
      background: linear-gradient(168deg, #f8f0d4 0%, #f0e3b8 45%, #e8d8a4 100%);
      border: 2px solid #c9a44a;
      box-shadow:
        0 0 0 3px #7a4e20, 0 0 0 6px #b8865a, 0 0 0 8px #5c3210,
        0 0 80px rgba(0,0,0,0.70),
        inset 0 1px 0 rgba(255,245,200,0.70);
      border-radius: 4px;
      padding: 56px 42px;
      display: flex; flex-direction: column; align-items: center; gap: 22px;
      min-width: 480px; max-width: 600px;
      animation: ss-panel-in 0.22s cubic-bezier(0.22, 1, 0.36, 1) both;
    }
    .ts-wait-panel::before {
      content: ''; position: absolute; inset: 0; pointer-events: none; z-index: 0; border-radius: 4px;
      background: repeating-linear-gradient(0deg, transparent, transparent 23px, rgba(140,90,30,0.04) 23px, rgba(140,90,30,0.04) 24px);
    }
    .ts-wait-panel > * { position: relative; z-index: 1; }

    .ts-wait-title   { font-size: 22px; letter-spacing: 8px; color: #3a1e06; text-align: center; }
    .ts-wait-slot    { font-size: 12px; letter-spacing: 3px; color: #7a5428; text-align: center; }
    .ts-wait-msg     { font-size: 11px; letter-spacing: 3px; color: #9b7040; text-align: center; text-transform: uppercase; }
    .ts-wait-counter {
      font-size: 36px; letter-spacing: 6px; color: #3a1e06; text-align: center;
      border: 1px solid #c4a260; border-radius: 8px; padding: 14px 36px;
      background: linear-gradient(155deg, #fdf6e0 0%, #f5ead0 100%);
      box-shadow: inset 0 1px 0 rgba(255,245,200,0.75), 0 2px 6px rgba(80,40,8,0.18);
    }
    .ts-wait-dots {
      display: flex; gap: 10px; align-items: center; justify-content: center;
    }
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

    /* conflict flash */
    .ts-conflict-msg {
      font-size: 13px; letter-spacing: 3px; color: #8b2210; text-align: center;
      animation: ss-breathe 0.5s ease-in-out 4;
    }
  `;

  // ── UI class ──────────────────────────────────────────────────────────────────

  class TitleLoadUI {
    constructor() {
      this._el       = null;
      this._screen   = "slot";   // "slot" | "waiting" | "result"
      this._sel      = null;
      this._count    = 0;
      this._required = 0;
      this._keyFn    = this._onKey.bind(this);
    }

    // ── Lifecycle ───────────────────────────────────────────────────────────────

    open() {
      if (this._el) return;
      this._injectCSS();
      sfx("confirm");

      this._screen   = "slot";
      this._sel      = null;
      this._count    = 0;
      this._required = TS.REQUIRED_PLAYERS;

      this._el = document.createElement("div");
      this._el.id = "ts-load-overlay";
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
        setTimeout(() => this.close(true), 220);
        return;
      }
      this._el.remove();
      this._el = null;
      this._screen = "slot";
      this._sel    = null;
      document.removeEventListener("keydown", this._keyFn, { capture: true });
    }

    _injectCSS() {
      if (document.getElementById("ts-load-css")) return;
      const s = document.createElement("style");
      s.id = "ts-load-css";
      s.textContent = EXTRA_CSS;
      document.head.appendChild(s);
    }

    // ── Rendering ───────────────────────────────────────────────────────────────

    _render() {
      if (!this._el) return;
      this._el.innerHTML = this._screen === "waiting" || this._screen === "result"
        ? this._htmlWaitScreen()
        : this._htmlSlotScreen();
      this._bind();
    }

    // ── Screen 1: Slot selection (load-only) ─────────────────────────────────────

    _htmlSlotScreen() {
      const SS = globalThis.SaveSystem;
      const slotCount = SS?.SLOT_COUNT ?? 3;

      const slots = Array.from({ length: slotCount }, (_, i) => {
        const id    = i + 1;
        const d     = SS?.Storage?.getSlot?.(id) ?? null;
        const valid = d !== null;
        const sel   = this._sel === id ? "is-sel" : "";
        const inv   = !valid ? "is-invalid" : "";

        let body;
        if (d) {
          const sceneId        = d.data?.activeScene?.sceneId;
          const liveScene      = sceneId ? game.scenes?.get(sceneId) : null;
          const locName        = liveScene?.navName || d.data?.activeScene?.sceneName || "—";
          const gameName       = d.data?.partyActorData?.system?.props?.game_name ?? "—";
          const paUuid         = d.data?.partyActorData?.uuid;
          const paRawId        = paUuid?.startsWith("Actor.") ? paUuid.slice(6) : paUuid;
          const partyActorName = paRawId ? (game.actors?.get(paRawId)?.name ?? "") : "";
          const partyProps     = d.data?.partyActorData?.system?.props ?? {};
          const portraits      = [];
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

        return `<div class="ss-slot ss-layer ${sel} ${inv}" data-slot="${id}" data-valid="${valid}">${body}</div>`;
      }).join("");

      return `
        <div class="ss-panel ss-layer">
          <div class="ss-title">✦  MEMORY CARD  ✦</div>
          <div class="ss-byline">FABULA ULTIMA COMPANION SAVE SYSTEM</div>
          <div class="ss-mode-label">LOAD GAME  ▷  SELECT SAVE FILE</div>
          <div class="ss-file-body">
            <div class="ss-slots">${slots}</div>
          </div>
          <div class="ss-footer">
            <button class="ss-back-btn" data-act="back">◄ BACK</button>
            <div class="ss-hints">↑ ↓ select &nbsp;|&nbsp; ENTER load &nbsp;|&nbsp; ESC back</div>
          </div>
        </div>`;
    }

    // ── Screen 2: Waiting / result ────────────────────────────────────────────────

    _htmlWaitScreen() {
      const SS  = globalThis.SaveSystem;
      const d   = this._sel ? SS?.Storage?.getSlot?.(this._sel) : null;
      const lbl = d ? (d.label ?? `Slot ${this._sel}`) : `Slot ${this._sel ?? "?"}`;

      const isConflict = this._screen === "result";

      const dots = Array.from({ length: this._required }, (_, i) =>
        `<div class="ts-wait-dot${i < this._count ? " ready" : ""}"></div>`
      ).join("");

      const msg = isConflict
        ? `<div class="ts-conflict-msg">PLAYERS CHOSE DIFFERENT FILES!<br>PLEASE CHOOSE AGAIN.</div>`
        : `<div class="ts-wait-msg ss-breathe">Waiting for other players…</div>`;

      return `
        <div class="ts-wait-panel">
          <div class="ts-wait-title">✦  READY CHECK  ✦</div>
          <div class="ts-wait-slot">Selected: ${lbl}</div>
          <div class="ts-wait-counter">${this._count} / ${this._required}</div>
          <div class="ts-wait-dots">${dots}</div>
          ${msg}
          ${!isConflict ? `
          <div class="ss-footer">
            <button class="ss-back-btn" data-act="cancel-vote">◄ CHANGE CHOICE</button>
          </div>` : ""}
        </div>`;
    }

    // ── Event binding ───────────────────────────────────────────────────────────

    _bind() {
      if (!this._el) return;

      // Slot selection
      this._el.querySelectorAll("[data-slot]").forEach(el => {
        el.addEventListener("click", () => {
          if (el.dataset.valid !== "true") return;
          this._onSlotSelect(parseInt(el.dataset.slot));
        });
        el.addEventListener("mouseenter", () => {
          if (el.dataset.valid !== "true") return;
          sfx("navigate");
          const id = parseInt(el.dataset.slot);
          this._sel = id;
          this._el.querySelectorAll("[data-slot]").forEach(s =>
            s.classList.toggle("is-sel", parseInt(s.dataset.slot) === id));
        });
      });

      // Back to title menu
      this._el.querySelector("[data-act='back']")?.addEventListener("click", () => {
        sfx("cancel");
        this.close();
      });

      // Cancel vote
      this._el.querySelector("[data-act='cancel-vote']")?.addEventListener("click", () => {
        sfx("cancel");
        TS.Socket.emitCancel();
        this._screen = "slot";
        this._render();
      });
    }

    _onKey(e) {
      if (!this._el) return;
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        if (this._screen === "waiting") {
          sfx("cancel");
          TS.Socket.emitCancel();
          this._screen = "slot";
          this._render();
        } else {
          sfx("cancel");
          this.close();
        }
        return;
      }
      // Arrow key navigation on slot screen
      if (this._screen !== "slot") return;
      const SS = globalThis.SaveSystem;
      const slotCount = SS?.SLOT_COUNT ?? 3;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const dir  = e.key === "ArrowDown" ? 1 : -1;
        const cur  = this._sel ?? 0;
        const next = Math.max(1, Math.min(slotCount, cur + dir));
        if (next !== cur) {
          this._sel = next;
          sfx("navigate");
          this._el.querySelectorAll("[data-slot]").forEach(s =>
            s.classList.toggle("is-sel", parseInt(s.dataset.slot) === next));
        }
        return;
      }
      if (e.key === "Enter" && this._sel) {
        e.preventDefault();
        const el = this._el.querySelector(`[data-slot="${this._sel}"]`);
        if (el?.dataset.valid === "true") this._onSlotSelect(this._sel);
      }
    }

    // ── Slot selection → vote ────────────────────────────────────────────────────

    _onSlotSelect(slotId) {
      this._sel = slotId;
      sfx("confirm");

      // GM solo mode: skip ready-check, load directly
      const activePlayers = (game.users?.contents ?? []).filter(u => u.active && !u.isGM);
      if (activePlayers.length === 0 && game.user?.isGM) {
        console.log(TAG, "GM-only session — loading directly without ready-check.");
        globalThis.SaveSystem?.Core?.load?.(slotId);
        this.close();
        return;
      }

      TS.Socket.emitVote(slotId);
      this._screen = "waiting";
      this._count  = 1; // count self optimistically
      this._render();
    }

    // ── Socket event handlers (called by title-socket.js) ────────────────────────

    onVotesUpdate({ count, required } = {}) {
      if (!this._el || this._screen !== "waiting") return;
      this._count    = count    ?? this._count;
      this._required = required ?? this._required;
      this._render();
    }

    onProceed({ slotId } = {}) {
      if (!this._el) return;
      sfx("ok");
      console.log(TAG, `Proceeding with slot ${slotId}.`);
      this.close();
    }

    onConflict(_payload) {
      if (!this._el) return;
      sfx("fail");
      this._screen = "result";
      this._render();
      // After 2.5s return to slot selection
      setTimeout(() => {
        if (!this._el) return;
        this._screen = "slot";
        this._sel    = null;
        this._count  = 0;
        this._render();
      }, 2500);
    }
  }

  TS.LoadUI = new TitleLoadUI();

  console.debug(TAG, "Load UI loaded.");
})();
