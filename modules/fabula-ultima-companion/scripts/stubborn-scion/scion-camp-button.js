// scripts/stubborn-scion/scion-camp-button.js
//
// The Stubborn Scion camp button: "Here is the information you previously
// requested". Sits in the camp-button row beside Upgrade / Inner Wellspring
// (bottom left), shown only to the holder (a GM stands in when that player is
// offline) at camp before the party sleeps. Clicking it opens a small panel
// above the button: what the benefit does, the bodyguards' Fatigue, and Ask.
// The badge on the button is the current Fatigue.

import {
  FATIGUE_LOCK, SKILL_NAME, askBlocker, hasStubbornScion, readFatigue, requestScion, scionCampOpen, scionFailText,
} from "./stubborn-scion.js";

const TAG = "[StubbornScion][UI]";
const MOD = "fabula-ultima-companion";
const BTN_ID = "fu-scion-campbtn";
const POP_ID = "fu-scion-pop";
const STYLE_ID = "fu-scion-style";
// The other camp-row buttons, in slot order (each 64 px wide, 10 px apart).
const ROW_BEFORE = ["fu-upgrade-campbtn", "fu-iw-campbtn"];
const ASSET = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/";
const SFX = {
  open: [`${ASSET}Sound/BattleCursor_4.wav`, 0.45],
  ask:  [`${ASSET}Sound/BattleCursor_1.wav`, 0.6],
  back: [`${ASSET}Sound/cursor_back2.wav`, 0.5],
};
// Two figures shoulder to shoulder: the bodyguards.
const GUARDS_SVG = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#ffd27a" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="6.5" r="2.6"/><circle cx="16" cy="6.5" r="2.6"/><path d="M3.5 20v-4.2A4.3 4.3 0 0 1 7.8 11.5h.4a4.3 4.3 0 0 1 4.3 4.3V20"/><path d="M11.5 20v-4.2a4.3 4.3 0 0 1 4.3-4.3h.4a4.3 4.3 0 0 1 4.3 4.3V20"/></svg>`;

const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const isPrimaryGM = () => globalThis.FUCompanion?.isPrimaryGM?.() ?? !!game.user?.isGM;
const isCampScene = () => canvas?.scene?.flags?.[MOD]?.oniFabula?.general?.sceneMode === "camp";
const partyEntries = async () => (await globalThis.CampSystem?.Party?.resolve?.().catch(() => [])) ?? [];
function sfx(key) {
  const [src, volume] = SFX[key] ?? [];
  if (!src) return;
  try { (foundry.audio?.AudioHelper ?? AudioHelper).play({ src, volume, autoplay: true, loop: false }, false); } catch {}
}

// The holder this client acts for: the user's own party actor; a GM stands in
// for a holder whose player is offline (or who has none). Same rule as Upgrade.
async function myHolder() {
  for (const e of await partyEntries()) {
    if (!hasStubbornScion(e.actor)) continue;
    if (e.userId && e.userId === game.user?.id) return e.actor;
    const offline = !(e.userId && game.users.get(e.userId)?.active);
    if (game.user?.isGM && offline) return e.actor;
  }
  return null;
}

// ── The panel ───────────────────────────────────────────────────────────────
let _holder = null;
let _busy = false;
let _lastResult = null;

function closePop() {
  const el = document.getElementById(POP_ID);
  if (!el) return;
  el.classList.remove("is-open");
  setTimeout(() => el.remove(), 180);
  document.removeEventListener("pointerdown", onOutside, true);
  document.removeEventListener("keydown", onKey, true);
}
function onOutside(ev) {
  const pop = document.getElementById(POP_ID);
  const btn = document.getElementById(BTN_ID);
  if (pop?.contains(ev.target) || btn?.contains(ev.target)) return;
  closePop();
}
function onKey(ev) { if (ev.key === "Escape") { ev.stopPropagation(); sfx("back"); closePop(); } }

function meterHTML(fatigue) {
  const cells = [];
  for (let i = 1; i <= FATIGUE_LOCK; i++) cells.push(`<i class="${i <= fatigue ? "on" : ""}"></i>`);
  return `<div class="fu-scion-meter${fatigue >= FATIGUE_LOCK ? " is-out" : ""}" aria-hidden="true">${cells.join("")}</div>`;
}

function renderPop() {
  const el = document.getElementById(POP_ID);
  if (!el || !_holder) return;
  const fatigue = readFatigue(_holder);
  const blocked = askBlocker(_holder);
  const over = fatigue > FATIGUE_LOCK ? ` <span class="fu-scion-over">(+${fatigue - FATIGUE_LOCK} over)</span>` : "";
  const note = _lastResult?.ok
    ? `<p class="fu-scion-note is-ok">Rolled ${_lastResult.rolled}: Fatigue ${_lastResult.from} → ${_lastResult.to}. Ask your question.</p>`
    : (blocked ? `<p class="fu-scion-note">${esc(scionFailText({ reason: blocked, fatigue }, _holder))}</p>` : "");
  el.innerHTML = `
    <header><span class="fu-scion-kicker">${esc(SKILL_NAME)} · ${esc(_holder.name)}</span>
      <h3>"Here is the information you previously requested."</h3></header>
    <p>During this Rest, ask the GM one question. They will answer truthfully.</p>
    <div class="fu-scion-fatigue">
      <div class="fu-scion-frow"><span>Bodyguard Fatigue</span><b>${fatigue}${over}</b></div>
      ${meterHTML(fatigue)}
      <div class="fu-scion-hint">Asking adds 1d6. At ${FATIGUE_LOCK} or more, the bodyguards can't help.</div>
    </div>
    ${note}
    <footer>
      <button type="button" class="fu-scion-cancel">${_lastResult?.ok ? "Close" : "Cancel"}</button>
      <button type="button" class="fu-scion-go"${blocked || _busy ? " disabled" : ""}>${_busy ? "Asking…" : "Ask (+1d6 Fatigue)"}</button>
    </footer>`;
  el.querySelector(".fu-scion-cancel").addEventListener("click", () => { sfx("back"); closePop(); });
  el.querySelector(".fu-scion-go").addEventListener("click", onAsk);
}

async function onAsk() {
  if (_busy || !_holder) return;
  _busy = true;
  _lastResult = null;
  renderPop();
  const r = await requestScion("ask", { holderUuid: _holder.uuid });
  _busy = false;
  if (r?.ok) { sfx("ask"); _lastResult = r; }
  else ui.notifications?.warn(scionFailText(r, _holder));
  renderPop();
  refreshSoon();
}

function openPop() {
  if (!_holder) return;
  injectStyles();
  _lastResult = null;
  let el = document.getElementById(POP_ID);
  if (!el) {
    el = document.createElement("section");
    el.id = POP_ID;
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", `${SKILL_NAME}: ask the GM a question`);
    document.body.appendChild(el);
  }
  const btn = document.getElementById(BTN_ID);
  el.style.left = btn?.style.left || "98px";
  renderPop();
  requestAnimationFrame(() => el.classList.add("is-open"));
  document.addEventListener("pointerdown", onOutside, true);
  document.addEventListener("keydown", onKey, true);
  sfx("open");
}

// ── The camp button ─────────────────────────────────────────────────────────
// After whichever row buttons this client shows (Upgrade, then Inner Wellspring).
function placeButton(btn) {
  const before = ROW_BEFORE.filter((id) => document.getElementById(id)?.classList.contains("is-shown")).length;
  btn.style.left = `${98 + 74 * before}px`;
  const pop = document.getElementById(POP_ID);
  if (pop) pop.style.left = btn.style.left;
}

async function refreshButton() {
  const holder = isCampScene() && scionCampOpen() ? await myHolder() : null;
  _holder = holder;
  let btn = document.getElementById(BTN_ID);
  if (!holder) {
    btn?.classList.remove("is-shown");
    closePop();
    return;
  }
  injectStyles();
  if (!btn) {
    btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.type = "button";
    btn.innerHTML = `${GUARDS_SVG}<span class="fu-scion-btn-label">Bodyguards</span><span class="fu-scion-btn-badge" aria-hidden="true"></span>`;
    btn.addEventListener("click", () => {
      if (document.getElementById(POP_ID)) { sfx("back"); closePop(); }
      else openPop();
    });
    document.body.appendChild(btn);
  }
  placeButton(btn);
  setTimeout(() => placeButton(btn), 500);     // the other row buttons may land after us
  const fatigue = readFatigue(holder);
  const blocked = askBlocker(holder);
  const badge = btn.querySelector(".fu-scion-btn-badge");
  badge.textContent = String(fatigue);
  badge.classList.toggle("is-out", fatigue >= FATIGUE_LOCK);
  btn.classList.toggle("is-spent", !!blocked);
  const label = blocked === "already_asked"
    ? `Bodyguards: question asked this rest (Fatigue ${fatigue})`
    : `Bodyguards: ask the GM one question (Fatigue ${fatigue}/${FATIGUE_LOCK})`;
  btn.dataset.tooltip = `${label}, ${holder.name}`;
  btn.setAttribute("aria-label", btn.dataset.tooltip);
  requestAnimationFrame(() => btn.classList.add("is-shown"));
  if (document.getElementById(POP_ID) && !_busy) renderPop();
}

let refreshSoon = () => {};
let _installed = false;
export function initScionCampButton() {
  if (_installed) return;
  _installed = true;
  refreshSoon = foundry.utils.debounce(() => refreshButton().catch((e) => console.warn(TAG, "refresh", e)), 200);
  Hooks.on("updateSetting", (s) => { if (String(s?.key ?? "").startsWith(`${MOD}.`)) refreshSoon(); });
  Hooks.on("canvasReady", () => refreshSoon());
  Hooks.on("updateActor", (actor, diff) => { if (isCampScene() && diff?.flags?.[MOD]) refreshSoon(); });
  const mine = (doc) => doc?.parent?.documentName === "Actor" && hasStubbornScion(doc.parent);
  for (const h of ["createActiveEffect", "updateActiveEffect", "deleteActiveEffect", "createItem", "deleteItem"]) {
    Hooks.on(h, (doc) => { if (isCampScene() && mine(doc)) refreshSoon(); });
  }
  Hooks.on("userConnected", () => refreshSoon());
  refreshSoon();
}

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
/* The camp button (camp-ui-button.js: left 20, bottom 80, 64px; the row continues at 98, 172, 246). */
#${BTN_ID} { position: fixed; z-index: 99998; left: 98px; bottom: 80px; width: 64px; height: 64px; border-radius: 50%; margin: 0; line-height: normal;
  border: 2px solid rgba(200,160,80,0.65); background: radial-gradient(circle at 40% 35%, rgba(92,56,24,0.94) 0%, rgba(43,29,16,0.97) 100%);
  box-shadow: 0 0 14px rgba(255,190,90,.45), 0 2px 6px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.12);
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; padding: 0; cursor: pointer;
  opacity: 0; transform: scale(.6) translateY(10px); pointer-events: none;
  transition: opacity 250ms cubic-bezier(.4,0,.2,1), transform 250ms cubic-bezier(.4,0,.2,1), filter 180ms ease, left 180ms ease; }
#${BTN_ID}.is-shown { opacity: 1; transform: none; pointer-events: auto; }
#${BTN_ID}:hover { filter: brightness(1.18); box-shadow: 0 0 14px rgba(255,190,90,.45), 0 2px 6px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.12); }
#${BTN_ID}:focus-visible { outline: 2px solid #ffd27a; outline-offset: 3px; }
#${BTN_ID}.is-spent { box-shadow: 0 2px 6px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.08); }
#${BTN_ID}.is-spent svg { opacity: .55; }
#${BTN_ID} .fu-scion-btn-label { font-size: 7.4px; font-weight: 700; letter-spacing: .15px; text-transform: uppercase; color: #e8c870; opacity: .8; white-space: nowrap; font-family: "Signika","Noto Sans",system-ui,sans-serif; }
#${BTN_ID} .fu-scion-btn-badge { position: absolute; top: -3px; right: -3px; min-width: 20px; height: 20px; padding: 0 4px; box-sizing: border-box; border-radius: 10px;
  background: #e8c870; color: #2b1d10; font: 700 11px/16px "Signika","Noto Sans",system-ui,sans-serif; text-align: center; border: 2px solid #2b1d10; }
#${BTN_ID} .fu-scion-btn-badge.is-out { background: #b8432c; color: #fff; }

#${POP_ID} { position: fixed; z-index: 99999; left: 98px; bottom: 156px; width: 300px; box-sizing: border-box; padding: 12px 14px 12px;
  background: #faf6ee; color: #3a1e06; border: 1px solid #b8865a; border-radius: 10px;
  box-shadow: 0 10px 28px rgba(0,0,0,.45), 0 0 0 1px rgba(43,29,16,.35);
  font-family: "Signika","Noto Sans",system-ui,sans-serif; font-size: 13px; line-height: 1.4;
  opacity: 0; transform: translateY(6px); transition: opacity 160ms ease, transform 160ms ease; }
#${POP_ID}.is-open { opacity: 1; transform: none; }
#${POP_ID} header { margin-bottom: 6px; }
#${POP_ID} .fu-scion-kicker { font-size: 10.5px; font-weight: 700; letter-spacing: .6px; text-transform: uppercase; color: #8a5a2b; }
#${POP_ID} h3 { margin: 2px 0 0; padding: 0; border: none; font-size: 15px; font-weight: 700; line-height: 1.25; color: #3a1e06; }
#${POP_ID} p { margin: 0 0 8px; }
#${POP_ID} .fu-scion-fatigue { padding: 8px 10px; margin-bottom: 8px; border-radius: 8px; background: #f1e7d6; border: 1px solid #dcc3a0; }
#${POP_ID} .fu-scion-frow { display: flex; justify-content: space-between; align-items: baseline; font-size: 12.5px; margin-bottom: 5px; }
#${POP_ID} .fu-scion-frow b { font-size: 15px; }
#${POP_ID} .fu-scion-over { font-size: 11.5px; font-weight: 600; color: #b8432c; }
#${POP_ID} .fu-scion-meter { display: grid; grid-template-columns: repeat(${FATIGUE_LOCK}, 1fr); gap: 3px; margin-bottom: 5px; }
#${POP_ID} .fu-scion-meter i { height: 8px; border-radius: 2px; background: #e2d2b8; box-shadow: inset 0 0 0 1px rgba(122,78,32,.25); }
#${POP_ID} .fu-scion-meter i.on { background: #d08a2c; }
#${POP_ID} .fu-scion-meter.is-out i.on { background: #b8432c; }
#${POP_ID} .fu-scion-hint { font-size: 11.5px; color: #6b4a26; }
#${POP_ID} .fu-scion-note { font-size: 12.5px; color: #8a2f1c; }
#${POP_ID} .fu-scion-note.is-ok { color: #2f6a2a; }
#${POP_ID} footer { display: flex; justify-content: flex-end; gap: 8px; }
#${POP_ID} footer button { font: inherit; width: auto; height: auto; margin: 0; line-height: 1.3; font-size: 13px; padding: 5px 12px; min-height: 32px; border-radius: 999px; cursor: pointer; }
#${POP_ID} .fu-scion-cancel { border: 1px solid #b8865a; background: #faf6ee; color: #3a1e06; }
#${POP_ID} .fu-scion-go { border: 1px solid #1f4f7a; background: #2f6fa8; color: #fff; font-weight: 700; }
#${POP_ID} .fu-scion-go:disabled { opacity: .45; cursor: not-allowed; }
#${POP_ID} button:focus-visible { outline: 2px solid #2f6fa8; outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { #${BTN_ID}, #${POP_ID} { transition: none !important; } }
`;
  document.head.appendChild(s);
}
