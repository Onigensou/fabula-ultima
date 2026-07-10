// ============================================================================
// Ritual System — spectator feedback banner.
//
// The ritual window is local to its operator. In a four-player game that means
// one person can spend a minute tuning potency and area while everyone else
// stares at a still screen, and the session reads as stalled. So opening,
// abandoning and performing a ritual each broadcast a line to every OTHER
// client, shown as a JRPG-style announcer panel:
//
//     <Performer> begins preparing a Ritual…
//     <Performer> abandons their Ritual
//     <Performer> performs an <Discipline> Ritual
//
// Structurally this is healing-feedback.js — same queue, same slide-in card,
// same spawn sound — kept as a sibling rather than shared because the two
// carry different payloads and neither should be able to break the other.
// ============================================================================

import { RITUAL_TAG, RITUAL_CHANNEL, RITUAL_SOCKET } from "./ritual-const.js";

const STYLE_ID = "oni-ritual-feedback-styles";
const SPAWN_SFX = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/bond_create.wav";
const LINGER_MS = 2600;
const ANIM_MS = 320;

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
#oni-ritual-feedback {
  position: fixed; top: 56px; left: 0; width: 100%;
  z-index: 2147483600; pointer-events: none;
  display: flex; flex-direction: column; align-items: stretch; gap: 8px;
}
.oni-ritual-fb-card {
  width: 100%; padding: 13px 28px; border-radius: 10px;
  background: linear-gradient(180deg, #f6ebd3 0%, #efdfc3 100%);
  border: 2px solid #8d5f38; box-shadow: 0 0 0 1px #6f4526, 0 8px 24px rgba(0,0,0,0.45);
  color: #3b2a19; font: 300 18px/1.3 "Signika", sans-serif; text-align: center;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; box-sizing: border-box;
  opacity: 0; transform: translateX(-44px);
  transition: opacity ${ANIM_MS}ms ease, transform ${ANIM_MS}ms cubic-bezier(.22,.8,.3,1);
}
.oni-ritual-fb-card.in  { opacity: 1; transform: translateX(0); }
.oni-ritual-fb-card.out { opacity: 0; transform: translateX(44px); }
.oni-ritual-fb-card b { font-weight: 700; }
.oni-ritual-fb-card i { font-style: italic; opacity: .9; }
.oni-ritual-fb-card.cancel { filter: saturate(.55); }
`;
  document.head.appendChild(s);
}

function ensureContainer() {
  let el = document.getElementById("oni-ritual-feedback");
  if (!el) { el = document.createElement("div"); el.id = "oni-ritual-feedback"; document.body.appendChild(el); }
  return el;
}

function playSpawnSfx() {
  try {
    (foundry.audio?.AudioHelper ?? AudioHelper).play({ src: SPAWN_SFX, volume: 0.55, autoplay: true, loop: false }, false);
  } catch {}
}

function cardHtml(line) {
  const who = `<b>${escapeHtml(line.performerName)}</b>`;
  switch (line.kind) {
    case "open":    return `${who} begins preparing a Ritual…`;
    case "cancel":  return `${who} abandons their Ritual`;
    case "perform": return `${who} performs ${escapeHtml(line.article ?? "a")} <b>${escapeHtml(line.discipline)}</b> Ritual <i>(${line.mp} MP)</i>`;
    default:        return who;
  }
}

// Center a fixed-fraction banner over the play area, clear of the sidebar.
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
  card.className = `oni-ritual-fb-card${data.kind === "cancel" ? " cancel" : ""}`;
  card.innerHTML = cardHtml(data);
  container.appendChild(card);
  playSpawnSfx();

  requestAnimationFrame(() => card.classList.add("in"));
  setTimeout(() => {
    card.classList.remove("in");
    card.classList.add("out");
    setTimeout(() => { card.remove(); showNext(); }, ANIM_MS);
  }, LINGER_MS + ANIM_MS);
}

/**
 * Tell every OTHER client what this operator is doing.
 *
 * Lives here rather than in ritual-socket.js so that ritual-cast.js can
 * announce a performance without importing the socket module that imports IT —
 * the cycle would leave `performCast` undefined at wiring time.
 *
 * A broadcast never echoes to its own sender, which is what we want: the
 * operator is already looking at their own window.
 */
export function broadcastFeedback(payload) {
  try {
    game.socket.emit(RITUAL_CHANNEL, { type: RITUAL_SOCKET.FEEDBACK, payload });
  } catch (e) {
    console.warn(RITUAL_TAG, "feedback broadcast failed", e);
  }
}

export const RitualFeedback = {
  /** payload: { kind: "open"|"cancel"|"perform", performerName, discipline?, mp?, article? } */
  enqueue(payload) {
    if (!payload?.kind || !payload?.performerName) return;
    _queue.push(payload);
    if (!_showing) showNext();
  },

  _test() {
    this.enqueue({ kind: "open", performerName: "Hina" });
    this.enqueue({ kind: "perform", performerName: "Hina", discipline: "Entropism", mp: 20, article: "an" });
    this.enqueue({ kind: "cancel", performerName: "Hina" });
  },
};

console.debug(RITUAL_TAG, "feedback banner loaded");
