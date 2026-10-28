// scripts/refinement-system/refinement-feedback.js
//
// Equipment Refinement — spectator feedback banner.
//
// The Refine window is local to the operator (who also gets the result SFX and
// the blacksmith-portrait animation). So that the rest of the party can share in
// a friend's success or failure, the operator broadcasts a feedback payload to
// every OTHER client (see refinement-socket.js broadcastRefineFeedback), and
// this module shows a JRPG-style text banner at the top of the screen — modelled
// exactly on the out-of-combat healing spectator toast (healing-feedback.js):
//
//     <Player> refined <+2 Iron Sword> → <+3 Iron Sword>
//
// One card at a time, queued; each slides + fades in from the left, lingers
// ~3s, then slides + fades out. The matching outcome SFX plays on spawn so
// spectators hear the same success / break / fail sound the operator heard.
//
// Classic (global) script — the refinement socket/bootstrap are classic scripts
// and cannot import an ESM, so this exposes a global instead of an export.

(() => {
  const STYLE_ID = "oni-refine-feedback-styles";
  const LINGER_MS = 3000;
  const ANIM_MS = 320;

  // Same outcome SFX the operator plays locally (RefineWindowApp.SFX) so every
  // client hears the matching sound.
  const SFX = {
    success: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/refine_success.mp3",
    break:   "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/refine_break.mp3",
    fail:    "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/refine_failed.mp3",
  };
  const SFX_VOL = 0.75;

  const _queue = [];
  let _showing = false;

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
#oni-refine-feedback {
  position: fixed; top: 56px; left: 0; width: 100%;
  z-index: 2147483600; pointer-events: none;
  display: flex; flex-direction: column; align-items: stretch; gap: 8px;
}
.oni-refine-fb-card {
  pointer-events: auto;
  width: 100%; padding: 13px 28px; border-radius: 10px;
  background: linear-gradient(180deg, #f6ebd3 0%, #efdfc3 100%);
  border: 2px solid #8d5f38; box-shadow: 0 0 0 1px #6f4526, 0 8px 24px rgba(0,0,0,0.45);
  color: #3b2a19; font: 300 18px/1.3 "Signika", sans-serif; text-align: center;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; box-sizing: border-box;
  opacity: 0; transform: translateX(-44px);
  transition: opacity ${ANIM_MS}ms ease, transform ${ANIM_MS}ms cubic-bezier(.22,.8,.3,1);
}
.oni-refine-fb-card.in  { opacity: 1; transform: translateX(0); }
.oni-refine-fb-card.out { opacity: 0; transform: translateX(44px); }
.oni-refine-fb-card b { font-weight: 700; }
.oni-refine-fb-card .oni-rfb-icon { margin-right: 8px; }
/* Outcome accents — match the refinement chat card colour cues. */
.oni-refine-fb-card.success { border-color: #3a7a3a; box-shadow: 0 0 0 1px #2a5a2a, 0 8px 24px rgba(0,0,0,0.45); }
.oni-refine-fb-card.success .oni-rfb-to { font-weight: 800; color: #2a6a2a; }
.oni-refine-fb-card.break   { border-color: #9a2a1a; box-shadow: 0 0 0 1px #7a1f12, 0 8px 24px rgba(0,0,0,0.45); }
.oni-refine-fb-card.break   .oni-rfb-to { font-weight: 800; color: #9a2a1a; }
.oni-refine-fb-card.fail    .oni-rfb-to { font-style: italic; color: #7a5c38; opacity: .8; }
/* Item name → click opens the Item Window for this viewer (same as the Orbment banner). */
.oni-rfb-link { font: inherit; font-weight: 700; color: inherit; background: none; border: 0; padding: 0 2px; border-radius: 4px; cursor: pointer;
  text-decoration: underline dotted; text-underline-offset: 4px; text-decoration-thickness: 1px; }
.oni-rfb-link:hover, .oni-rfb-link:focus-visible { background: rgba(201,164,74,.28); outline: none; }
.oni-refine-fb-tag {
  font-size: 11px; font-weight: 800; letter-spacing: 0.05em;
  margin-left: 8px; padding: 1px 7px; border-radius: 10px;
  background: rgba(154,42,26,0.15); color: #9a2a1a;
  border: 1px solid rgba(154,42,26,0.3); text-transform: uppercase;
}
`;
    document.head.appendChild(s);
  }

  function ensureContainer() {
    let el = document.getElementById("oni-refine-feedback");
    if (!el) {
      el = document.createElement("div");
      el.id = "oni-refine-feedback";
      document.body.appendChild(el);
      // Item links: open the Item Window (FULinkedText) for this viewer only.
      el.addEventListener("click", (ev) => {
        const link = ev.target.closest?.(".oni-rfb-link");
        if (!link?.dataset.uuid) return;
        ev.preventDefault();
        try { globalThis.FULinkedText?.openItem?.(link.dataset.uuid, { x: ev.clientX - 160, y: ev.clientY + 24 }); } catch {}
      });
    }
    return el;
  }

  function playSpawnSfx(outcome) {
    const src = SFX[outcome] ?? SFX.fail;
    try {
      (foundry.audio?.AudioHelper ?? AudioHelper).play({ src, volume: SFX_VOL, autoplay: true, loop: false }, false);
    } catch {}
  }

  // Build the card HTML for one refinement result. Mirrors the chat-card syntax
  // (from → to / "broke" / "no change") with the actor prefixed.
  function cardHtml(data) {
    const who    = `<b>${escapeHtml(data.playerName ?? "Someone")}</b>`;
    // The item as it is NOW is the link: the new name on success/break, the
    // (unchanged) old name on a fail. Payloads without itemUuid render plain.
    const link   = (cls, name) => data.itemUuid
      ? `<button type="button" class="oni-rfb-link ${cls}" data-uuid="${escapeHtml(data.itemUuid)}">${escapeHtml(name ?? "")}</button>`
      : `<b class="${cls}">${escapeHtml(name ?? "")}</b>`;
    const oldNm  = data.outcome === "success" || data.outcome === "break"
      ? `<b class="oni-rfb-from">${escapeHtml(data.oldName ?? "")}</b>`
      : link("oni-rfb-from", data.oldName);
    const newNm  = link("oni-rfb-to", data.newName);
    if (data.outcome === "success") {
      return `<span class="oni-rfb-icon">⚒️</span>${who} refined ${oldNm} → ${newNm}`;
    }
    if (data.outcome === "break") {
      return `<span class="oni-rfb-icon">💔</span>${who}'s ${oldNm} broke → ${newNm}<span class="oni-refine-fb-tag">broke</span>`;
    }
    // fail
    return `<span class="oni-rfb-icon">✗</span>${who} failed to refine ${oldNm} <span class="oni-rfb-to">— no change</span>`;
  }

  // Center a fixed-fraction banner over the play area (canvas), clear of the
  // sidebar — FF-style announcer, narrower than the full width. (Same as heal.)
  const WIDTH_RATIO = 0.55;
  function sizeContainer(el) {
    const sidebar = document.getElementById("sidebar");
    const sbRect = sidebar?.getBoundingClientRect?.();
    const rightBound = (sbRect && sbRect.width > 0 && sbRect.left > 100) ? sbRect.left : window.innerWidth;
    const width = Math.max(280, Math.min(720, rightBound * WIDTH_RATIO));
    el.style.left = `${Math.round((rightBound - width) / 2)}px`;
    el.style.width = `${Math.round(width)}px`;
  }

  function showNext() {
    if (!_queue.length) { _showing = false; return; }
    _showing = true;
    const data = _queue.shift();

    injectStyles();
    const container = ensureContainer();
    sizeContainer(container);
    const card = document.createElement("div");
    const outcome = (data.outcome === "success" || data.outcome === "break") ? data.outcome : "fail";
    card.className = `oni-refine-fb-card ${outcome}`;
    card.innerHTML = cardHtml(data);
    container.appendChild(card);
    playSpawnSfx(outcome);

    requestAnimationFrame(() => card.classList.add("in"));
    // Linger, then leave — unless the pointer is on the card: hovering holds it
    // so there's time to click the item name.
    let timer = null;
    const leave = () => {
      card.classList.remove("in");
      card.classList.add("out");
      setTimeout(() => { card.remove(); showNext(); }, ANIM_MS);
    };
    const arm = (ms) => { clearTimeout(timer); timer = setTimeout(leave, ms); };
    card.addEventListener("mouseenter", () => clearTimeout(timer));
    card.addEventListener("mouseleave", () => arm(LINGER_MS));
    arm(LINGER_MS + ANIM_MS);
  }

  const RefinementFeedback = {
    // payload: { playerName, outcome:"success"|"break"|"fail", oldName, newName, itemType? }
    enqueue(payload) {
      if (!payload || typeof payload !== "object") return;
      _queue.push({ ...payload });
      if (!_showing) showNext();
    },

    // Local test helpers.
    _test() {
      this.enqueue({ playerName: "Hina", outcome: "success", oldName: "+2 Iron Sword", newName: "+3 Iron Sword" });
    },
    _testAll() {
      this.enqueue({ playerName: "Hina", outcome: "success", oldName: "+2 Iron Sword", newName: "+3 Iron Sword" });
      this.enqueue({ playerName: "Zarg", outcome: "break",   oldName: "+5 War Axe",    newName: "+4 War Axe"    });
      this.enqueue({ playerName: "Keren", outcome: "fail",   oldName: "+3 Buckler",    newName: "+3 Buckler"    });
    },
  };

  // Expose as a global for the classic socket/bootstrap scripts.
  window["oni.RefinementFeedback"] = RefinementFeedback;
  console.debug("[Refinement] feedback banner loaded");
})();
