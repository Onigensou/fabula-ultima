// ============================================================================
// Ritual System — GM attend-pip (v1.5).
//
// A persistent chip, GM-only, that appears while a player is preparing a
// ritual: portrait, name, "is preparing a Ritual", 🕯️. Clicking it opens a
// live read-only mirror of that player's window (ritual-hud-app.js spectate
// mode). One chip per live session; they stack.
//
// Deliberately NOT anchored to the docked ritual button in dp-scan-mode.js —
// that button only exists in dungeon/exploration/theatre scene modes, so a pip
// hung off it would vanish exactly when the GM is looking at something else.
// This is a plain fixed-position stack that is always reachable.
// ============================================================================

import { RITUAL_TAG } from "./ritual-const.js";
import { subscribeSessions, getSessions, requestSync } from "./ritual-session.js";
import { RitualHUD } from "./ritual-hud-app.js";

const STACK_ID = "oni-ritual-pip-stack";
const STYLE_ID = "oni-ritual-pip-styles";

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
#${STACK_ID} {
  position: fixed; left: 12px; bottom: 92px; z-index: 2147483000;
  display: flex; flex-direction: column-reverse; gap: 8px; pointer-events: none;
}
.oni-ritual-pip {
  pointer-events: auto; cursor: pointer;
  display: flex; align-items: center; gap: 10px;
  padding: 7px 14px 7px 8px; border-radius: 999px;
  background: linear-gradient(180deg, #2a2036 0%, #1c1626 100%);
  border: 2px solid #8d6cc0; box-shadow: 0 0 0 1px #120d1a, 0 6px 18px rgba(0,0,0,0.5);
  color: #efe6ff; font: 300 14px/1.15 "Signika", sans-serif;
  max-width: 320px; opacity: 0; transform: translateX(-24px);
  transition: opacity 240ms ease, transform 240ms cubic-bezier(.22,.8,.3,1), filter 160ms ease;
}
.oni-ritual-pip.in { opacity: 1; transform: translateX(0); }
.oni-ritual-pip.out { opacity: 0; transform: translateX(-24px); }
.oni-ritual-pip:hover { filter: brightness(1.12); }
.oni-ritual-pip.attending { border-color: #c8a24a; box-shadow: 0 0 0 1px #120d1a, 0 0 12px rgba(200,162,74,.5); }
.oni-ritual-pip img.portrait {
  width: 34px; height: 34px; border-radius: 50%; object-fit: cover;
  border: 1px solid #8d6cc0; flex: 0 0 auto; background: #0d0a12;
}
.oni-ritual-pip .txt { display: flex; flex-direction: column; min-width: 0; }
.oni-ritual-pip .who { font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.oni-ritual-pip .sub { font-size: 11px; opacity: .78; white-space: nowrap; }
.oni-ritual-pip .candle { font-size: 17px; flex: 0 0 auto; }
`;
  document.head.appendChild(s);
}

function ensureStack() {
  let el = document.getElementById(STACK_ID);
  if (!el) { el = document.createElement("div"); el.id = STACK_ID; document.body.appendChild(el); }
  return el;
}

function pipEl(sessionId) {
  return document.querySelector(`#${STACK_ID} .oni-ritual-pip[data-session="${CSS.escape(sessionId)}"]`);
}

function attendingSessionId() {
  return RitualHUD.isOpen && RitualHUD._mode === "spectate" ? RitualHUD._spectateId ?? null : null;
}

function renderPip(session) {
  injectStyles();
  const stack = ensureStack();
  let el = pipEl(session.sessionId);
  const attending = attendingSessionId() === session.sessionId;

  if (!el) {
    el = document.createElement("div");
    el.className = "oni-ritual-pip";
    el.dataset.session = session.sessionId;
    el.addEventListener("click", () => attend(session.sessionId));
    stack.appendChild(el);
    requestAnimationFrame(() => el.classList.add("in"));
  }
  el.classList.toggle("attending", attending);
  el.innerHTML = `
    <img class="portrait" src="${escapeHtml(session.performerImg)}" onerror="this.style.visibility='hidden'" />
    <div class="txt">
      <span class="who">${escapeHtml(session.performerName)}</span>
      <span class="sub">${attending ? "attending…" : "is preparing a Ritual"}</span>
    </div>
    <span class="candle">🕯️</span>`;
  // innerHTML replaced the click target's children only; the listener on `el`
  // survives, so no re-binding is needed.
}

function removePip(sessionId) {
  const el = pipEl(sessionId);
  if (!el) return;
  el.classList.remove("in");
  el.classList.add("out");
  setTimeout(() => el.remove(), 240);
}

function attend(sessionId) {
  const session = getSessions().find((s) => s.sessionId === sessionId);
  if (!session) { removePip(sessionId); return; }
  // A GM performing their own ritual must not have it silently destroyed by
  // RitualHUD's single-instance open(). Refuse and say why.
  if (RitualHUD.isOpen && RitualHUD._mode === "perform") {
    ui.notifications?.warn("Ritual: finish or close your own ritual before attending another.");
    return;
  }
  // Ask for a fresh snapshot so a late attach paints current state, then open
  // the mirror on the state we already hold (the sync will repaint it).
  requestSync(sessionId);
  RitualHUD.spectate(session);
  // Repaint every pip so the "attending…" highlight moves.
  for (const s of getSessions()) renderPip(s);
}

let _wired = false;

/** GM-only. Wire the pip stack to session lifecycle. */
export function wireRitualPips() {
  if (_wired || !game.user?.isGM) return;
  _wired = true;

  subscribeSessions((event, session) => {
    if (event === "close") {
      removePip(session.sessionId);
      // If we were watching it, close the mirror.
      if (attendingSessionId() === session.sessionId) {
        RitualHUD.close({ silent: true });
      }
      return;
    }
    renderPip(session);
  });

  // When the mirror closes on its own (GM pressed X), no session event fires —
  // repaint so the "attending…" highlight clears.
  Hooks.on("fu-ritual-spectate-end", () => refreshRitualPips());

  // Paint any sessions already live when a GM connects mid-ritual.
  for (const s of getSessions()) renderPip(s);
  console.debug(RITUAL_TAG, "attend-pips wired.");
}

/** Repaint pips (e.g. after the mirror closes, to drop the highlight). */
export function refreshRitualPips() {
  for (const s of getSessions()) renderPip(s);
}
