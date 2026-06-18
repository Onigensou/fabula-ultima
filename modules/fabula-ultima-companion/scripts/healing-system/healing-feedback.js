// ============================================================================
// Out-of-Combat Healing — spectator feedback toast.
//
// The Healing HUD is local to the operator. So that the rest of the party knows
// an ally is healing them, a successful heal broadcasts a feedback payload to
// every OTHER client (see healing-socket.js broadcastHealFeedback), and this
// module shows a JRPG-style text panel at the top of the screen:
//
//     <Caster> restore <N> <RES> to <Target>  <cur/max>
//
// One card at a time, queued; each slides + fades in from the left, lingers
// ~3s, then slides + fades out. A sound plays on spawn.
// ============================================================================

import { HEAL_TAG, HEAL_RESOURCE } from "./healing-const.js";

const STYLE_ID = "oni-heal-feedback-styles";
const SPAWN_SFX = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/bond_create.wav";
const LINGER_MS = 3000;
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
#oni-heal-feedback {
  position: fixed; top: 56px; left: 0; width: 100%;
  z-index: 2147483600; pointer-events: none;
  display: flex; flex-direction: column; align-items: stretch; gap: 8px;
}
.oni-heal-fb-card {
  width: 100%; padding: 13px 28px; border-radius: 10px;
  background: linear-gradient(180deg, #f6ebd3 0%, #efdfc3 100%);
  border: 2px solid #8d5f38; box-shadow: 0 0 0 1px #6f4526, 0 8px 24px rgba(0,0,0,0.45);
  color: #3b2a19; font: 300 18px/1.3 "Signika", sans-serif; text-align: center;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; box-sizing: border-box;
  opacity: 0; transform: translateX(-44px);
  transition: opacity ${ANIM_MS}ms ease, transform ${ANIM_MS}ms cubic-bezier(.22,.8,.3,1);
}
.oni-heal-fb-card.in  { opacity: 1; transform: translateX(0); }
.oni-heal-fb-card.out { opacity: 0; transform: translateX(44px); }
.oni-heal-fb-card b { font-weight: 700; }
.oni-heal-fb-card i { font-style: italic; opacity: .9; margin-left: 6px; }
`;
  document.head.appendChild(s);
}

function ensureContainer() {
  let el = document.getElementById("oni-heal-feedback");
  if (!el) { el = document.createElement("div"); el.id = "oni-heal-feedback"; document.body.appendChild(el); }
  return el;
}

function playSpawnSfx() {
  try {
    (foundry.audio?.AudioHelper ?? AudioHelper).play({ src: SPAWN_SFX, volume: 0.6, autoplay: true, loop: false }, false);
  } catch {}
}

// Build the card HTML for one line. Thin base font; only the actor name, target
// name, value/resource (or debuff) are bolded (no colour); cur/max italic.
function cardHtml(line) {
  const caster = `<b>${escapeHtml(line.casterName)}</b>`;
  const target = `<b>${escapeHtml(line.targetName)}</b>`;
  if (line.kind === "cleanse-one") {
    return `${caster} cures <b>${escapeHtml(line.debuff ?? "a status")}</b> from ${target}`;
  }
  if (line.kind === "cleanse-all") {
    return `${caster} cleanses ${target}`;
  }
  const res = HEAL_RESOURCE[line.resource]?.label ?? String(line.resource ?? "").toUpperCase();
  return `${caster} restore <b>${line.amount} ${res}</b> to ${target} <i>(${line.after} / ${line.max})</i>`;
}

// Center a fixed-fraction banner over the play area (canvas), clear of the
// sidebar — FF-style announcer, narrower than the full width.
const WIDTH_RATIO = 0.55;   // fraction of the available play-area width
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
  card.className = "oni-heal-fb-card";
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

export const HealingFeedback = {
  // payload: { casterName, lines: [ { kind:"heal"|"cleanse-one"|"cleanse-all",
  //   casterName, targetName, resource?, amount?, after?, max?, debuff? } ] }
  enqueue(payload) {
    const lines = Array.isArray(payload?.lines) ? payload.lines : [];
    for (const line of lines) {
      _queue.push({ casterName: payload.casterName ?? "Someone", ...line });
    }
    if (lines.length && !_showing) showNext();
  },

  // Local test helpers.
  _test() {
    this.enqueue({ casterName: "Hina", lines: [{ kind: "heal", targetName: "Zarg", resource: "hp", amount: 50, after: 75, max: 75 }] });
  },
  _testCleanse() {
    this.enqueue({ casterName: "Hina", lines: [
      { kind: "cleanse-one", targetName: "Zarg", debuff: "Dazed" },
      { kind: "cleanse-all", targetName: "Keren" },
    ] });
  },
};

console.debug(HEAL_TAG, "feedback toast loaded");
