// ── Hit counter — live "N HIT / X DAMAGE" on the right edge ────────────────
//
// Tales-style combo counter for ONE action that lands two or more damage
// numbers: Chain strikes, AoE targets, or both (user decisions 2026-10-29 —
// Tales look, AoE counts, enemy actions count too, tinted by side).
//
//   - Count  = landed hits that show a damage number. A MISS / BLOCK / IMMUNE
//              tag, a heal and an absorb never count. A hit split between
//              Shield and HP (two numbers, same token, same instant) is ONE.
//   - Damage = the sum of the numbers that appeared, overkill included.
//   - Scope  = one action: the acting GM broadcasts begin / end around the
//              action's damage; DoT ticks, counters and free actions outside
//              that window are not counted.
//   - Shown from the 2nd hit, held 1.6 s after the last one, then it fades.
//
// Each client counts the numbers IT renders (a hidden token or a hidden tab
// shows none), via the "fuDamageNumber" hook director-damage-numbers fires.
// Sits under the Event Clocks, which own the top-right corner.

import { log, warn } from "./logger.js";

const MODULE_ID = "fabula-ultima-companion";
const ACTION = "FU_DIRECTOR_HITCOUNTER";
const STYLE_ID = "fud-hit-counter-style";
const ROOT_ID = "fud-hit-counter";
const HOLD_MS = 1600;
const SAME_HIT_MS = 60;     // shield + HP numbers of one hit arrive together
const MIN_HITS = 2;

let _socket = null;
let _cur = null;           // { id, side, hits, damage, active, lastAt, perToken: Map }
let _hideTimer = null;

export function initHitCounter() {
  try {
    if (typeof socketlib !== "undefined" && game.modules.get("socketlib")?.active) {
      _socket = socketlib.registerModule(MODULE_ID);
      _socket.register(ACTION, onMessage);
    }
    Hooks.on("fuDamageNumber", onNumber);
    log("hit-counter: ready");
  } catch (e) {
    warn("hit-counter: init failed", e);
  }
}

// ── acting GM: action window ───────────────────────────────────────────────
export function beginHitCounter({ id, side = "party" } = {}) {
  send({ op: "begin", id: String(id ?? Date.now()), side: side === "enemy" ? "enemy" : "party" });
}
export function endHitCounter({ id } = {}) {
  send({ op: "end", id: id != null ? String(id) : null });
}
function send(msg) {
  try { onMessage(msg); } catch (e) { warn("hit-counter: local handle threw", e); }
  try { _socket?.executeForOthers?.(ACTION, msg); } catch (e) { warn("hit-counter: broadcast failed", e); }
}

function onMessage(msg = {}) {
  if (msg.op === "begin") {
    hideNow();
    _cur = { id: msg.id, side: msg.side, hits: 0, damage: 0, active: true, lastAt: 0, perToken: new Map() };
    return;
  }
  if (msg.op === "end") {
    if (!_cur || (msg.id && _cur.id !== msg.id)) return;
    _cur.active = false;
    scheduleHide();
  }
}

// ── every client: count what this client shows ─────────────────────────────
function onNumber(payload = {}) {
  if (!_cur?.active) return;
  if (payload.kind !== "loss") return;
  const res = String(payload.resource ?? "hp");
  if (res !== "hp" && res !== "shield" && res !== "mp") return;
  const amount = Math.max(0, Math.floor(Number(payload.amount) || 0));
  if (!amount) return;
  const now = performance.now();
  const tok = String(payload.tokenUuid ?? "");
  const last = _cur.perToken.get(tok) ?? -Infinity;
  if (now - last > SAME_HIT_MS) _cur.hits += 1;
  _cur.perToken.set(tok, now);
  _cur.damage += amount;
  _cur.lastAt = now;
  if (_cur.hits >= MIN_HITS) render(_cur);
}

// ── DOM ────────────────────────────────────────────────────────────────────
function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const css = `
#${ROOT_ID} {
  position: fixed; z-index: 99960; pointer-events: none;
  right: calc(var(--fu-sidebar-anchor-right, 313px) + 18px);
  top: 26vh;
  display: flex; flex-direction: column; align-items: flex-end; gap: 0;
  opacity: 0; transform: translateX(18px);
  transition: opacity 220ms ease-out, transform 260ms cubic-bezier(.2,.9,.3,1);
  font-family: "Arial Black", "Segoe UI Black", "Helvetica Neue", Arial, sans-serif;
  --hc-tag: #7fc4ff;
}
#${ROOT_ID}.is-on { opacity: 1; transform: translateX(0); }
#${ROOT_ID}.is-out { opacity: 0; transition: opacity 420ms ease-in; }
#${ROOT_ID}.fud-hc--enemy { --hc-tag: #ff7a7a; }
#${ROOT_ID} .fud-hc-row { display: flex; align-items: baseline; gap: 7px; }
#${ROOT_ID} .fud-hc-hits b {
  font-style: italic; font-weight: 900; font-size: 50px; line-height: .95; color: #fff;
  -webkit-text-stroke: 2px #101622; paint-order: stroke fill; text-shadow: 0 3px 0 rgba(0,0,0,.55);
  display: inline-block;
}
#${ROOT_ID} .fud-hc-hits i, #${ROOT_ID} .fud-hc-dmg i {
  font-style: normal; letter-spacing: 2px;
  font-family: "Bebas Neue", "Anton", "Haettenschweiler", Impact, "Arial Narrow", sans-serif;
}
#${ROOT_ID} .fud-hc-hits i { font-size: 28px; color: var(--hc-tag); text-shadow: 0 2px 0 rgba(0,0,0,.7); }
#${ROOT_ID} .fud-hc-dmg b {
  font-style: italic; font-weight: 900; font-size: 22px; color: #ffe8a8; white-space: nowrap;
  -webkit-text-stroke: 1.5px #2a1b06; paint-order: stroke fill; display: inline-block;
}
#${ROOT_ID} .fud-hc-dmg i { font-size: 16px; color: #ffcf8a; text-shadow: 0 2px 0 rgba(0,0,0,.7); }
#${ROOT_ID} .is-punch { animation: fudHcPunch 200ms ease-out; }
@keyframes fudHcPunch { 0% { transform: scale(1.25); } 100% { transform: scale(1); } }
@media (prefers-reduced-motion: reduce) { #${ROOT_ID} .is-punch { animation: none; } }
`;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = css;
  document.head.appendChild(el);
}

function rootEl() {
  let el = document.getElementById(ROOT_ID);
  if (el) return el;
  ensureStyle();
  el = document.createElement("div");
  el.id = ROOT_ID;
  el.innerHTML = `<div class="fud-hc-row fud-hc-hits"><b data-k="hits">0</b><i>HIT</i></div>
    <div class="fud-hc-row fud-hc-dmg"><b data-k="dmg">0</b><i>DAMAGE</i></div>`;
  document.body.appendChild(el);
  return el;
}

// Below the Event Clocks when they reach this far down; 26vh otherwise.
function placeUnderClocks(el) {
  try {
    const clocks = document.getElementById("oni-clock-layer");
    const r = clocks?.childElementCount ? clocks.getBoundingClientRect() : null;
    const min = window.innerHeight * 0.26;
    el.style.top = `${Math.max(min, r ? r.bottom + 14 : 0)}px`;
  } catch { /* keep the CSS default */ }
}

function punch(node) {
  if (!node) return;
  node.classList.remove("is-punch");
  void node.offsetWidth;
  node.classList.add("is-punch");
}

function render(cur) {
  const el = rootEl();
  if (_hideTimer) { clearTimeout(_hideTimer); _hideTimer = null; }
  el.classList.toggle("fud-hc--enemy", cur.side === "enemy");
  el.classList.remove("is-out");
  const wasOn = el.classList.contains("is-on");
  if (!wasOn) placeUnderClocks(el);
  const hits = el.querySelector('[data-k="hits"]');
  const dmg = el.querySelector('[data-k="dmg"]');
  hits.textContent = String(cur.hits);
  dmg.textContent = Math.round(cur.damage).toLocaleString("en-US");
  if (!wasOn) requestAnimationFrame(() => el.classList.add("is-on"));
  else { punch(hits); }
  if (!cur.active) scheduleHide();
}

function scheduleHide() {
  if (_hideTimer) clearTimeout(_hideTimer);
  const since = _cur?.lastAt ? performance.now() - _cur.lastAt : HOLD_MS;
  const wait = Math.max(400, HOLD_MS - since);
  _hideTimer = setTimeout(() => {
    _hideTimer = null;
    const el = document.getElementById(ROOT_ID);
    if (!el) return;
    el.classList.add("is-out");
    el.classList.remove("is-on");
  }, wait);
}

function hideNow() {
  if (_hideTimer) { clearTimeout(_hideTimer); _hideTimer = null; }
  const el = document.getElementById(ROOT_ID);
  if (el) { el.classList.remove("is-on"); el.classList.remove("is-out"); }
}

// Test seam: drive the counter without a battle.
export const _test = { onMessage, onNumber, get state() { return _cur; } };
