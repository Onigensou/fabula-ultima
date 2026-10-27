// status-pop.js — status pop text and the pip flash bus (token status plan
// "G + E", 2026-10-27).
//
// POP: Foundry floats a plain "+(Name)" / "-(Name)" over a token whenever an
// effect with a status or a change is created, toggled or deleted
// (ActiveEffect#_displayScrollingStatus, run on EVERY client). In a battle we
// replace it: markers, Clocks and hidden effects pop nothing; debuffs, buffs
// and Ready abilities pop their icon and name over the head, tinted by tier,
// rising when gained and sinking when lost. Outside a battle the core text runs.
//
// FLASH: "fuStatusFlash" { tokenUuid?, actorId?, name } asks the HUD pips and
// the NPC strip to flash the matching status (a Burn tick, a Ready spent).
// flashStatusLocal() fires it on this client; the GM broadcast lives in the
// passive card module (it already owns a socket to every client).
//
// Per client, display only.

import { log, warn } from "./logger.js";
import { classifyEffect, TIER } from "./status-classifier.js";
import { battleActive } from "./battle-focus.js";
import { headPoint } from "./unit-anchors.js";

const ROOT_ID = "fu-status-pop-root";
const STYLE_ID = "fu-status-pop-style";
const POP_MS = 1800;
const STACK_PX = 30;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const _stack = new Map();   // tokenId -> live pop count (so simultaneous pops stack upward)

function ensure() {
  if (!document.getElementById(STYLE_ID)) {
    const st = document.createElement("style");
    st.id = STYLE_ID;
    st.textContent = `
#${ROOT_ID} { position: fixed; left: 0; top: 0; width: 0; height: 0; pointer-events: none; z-index: 100000; }
.fu-spop { position: absolute; left: 0; top: 0; display: flex; align-items: center; gap: 6px; white-space: nowrap; pointer-events: none;
  font: 900 21px "Signika", sans-serif; color: #fff;
  text-shadow: -2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000, 0 2px 0 #000, 0 -2px 0 #000, 2px 0 0 #000, -2px 0 0 #000;
  animation: fuSpopUp ${POP_MS}ms ease-out forwards; }
.fu-spop img { width: 26px; height: 26px; border-radius: 5px; border: 2px solid var(--pc, #000); background: #3a3228; object-fit: cover; }
.fu-spop.t-debuff { --pc: #c4473a; } .fu-spop.t-buff { --pc: #2f9e6b; } .fu-spop.t-ready { --pc: #e2b34a; color: #ffe08a; }
.fu-spop.is-off { color: #d9d2c4; animation-name: fuSpopDown; }
@keyframes fuSpopUp { 0% { opacity: 0; transform: translate(-50%, 10px) scale(.8); } 12% { opacity: 1; transform: translate(-50%, 0) scale(1.08); }
  22% { transform: translate(-50%, -4px) scale(1); } 78% { opacity: 1; } 100% { opacity: 0; transform: translate(-50%, -48px); } }
@keyframes fuSpopDown { 0% { opacity: 0; transform: translate(-50%, 0); } 14% { opacity: 1; } 78% { opacity: 1; } 100% { opacity: 0; transform: translate(-50%, 32px); } }
`;
    document.head.appendChild(st);
  }
  let root = document.getElementById(ROOT_ID);
  if (!root) { root = document.createElement("div"); root.id = ROOT_ID; document.body.appendChild(root); }
  return root;
}

/** Pop a status name over a token's head (screen-snapshot, like damage numbers). */
export function popOnToken(token, { text, img, tier = TIER.BUFF, off = false } = {}) {
  const view = canvas?.app?.view;
  if (!token || token.destroyed || !view || !token.visible) return;
  const root = ensure();
  const n = (_stack.get(token.id) ?? 0) + 1;
  _stack.set(token.id, n);
  setTimeout(() => _stack.set(token.id, Math.max(0, (_stack.get(token.id) ?? 1) - 1)), 700);
  const pt = headPoint(token);   // the RENDERED sprite's top (unit-anchors.js)
  if (!pt) return;
  const el = document.createElement("div");
  el.className = `fu-spop t-${tier}${off ? " is-off" : ""}`;
  el.innerHTML = `${img ? `<img src="${esc(img)}" alt="">` : ""}<span>${esc(text)}</span>`;
  el.style.left = `${Math.round(pt.x)}px`;
  el.style.top = `${Math.round(pt.y - 6 - (n - 1) * STACK_PX)}px`;
  root.appendChild(el);
  setTimeout(() => el.remove(), POP_MS + 100);
}

/** Flash a status pip / tile / chip on THIS client. */
export function flashStatusLocal({ tokenUuid = null, actorId = null, name = "" } = {}) {
  try { Hooks.callAll("fuStatusFlash", { tokenUuid, actorId, name: String(name ?? "").trim().toLowerCase() }); }
  catch (e) { warn("[StatusPop] flash failed", e); }
}

function wrapScrollingStatus() {
  const proto = (CONFIG.ActiveEffect?.documentClass ?? globalThis.ActiveEffect)?.prototype;
  const orig = proto?._displayScrollingStatus;
  if (typeof orig !== "function" || orig.__fuStatusPop) return;
  const wrapped = function (enabled) {
    if (!battleActive()) return orig.call(this, enabled);
    let tier;
    try { tier = classifyEffect(this); } catch { return orig.call(this, enabled); }
    if (tier === TIER.MARKER || tier === TIER.RESOURCE || tier === TIER.HIDDEN) return;
    let tokens = [];
    try { tokens = this.target?.getActiveTokens?.(true) ?? []; } catch { /* */ }
    for (const t of tokens) {
      if (!t?.visible || t.document?.isSecret) continue;
      popOnToken(t, { text: `${enabled ? "+" : "−"}${this.name}`, img: this.img, tier, off: !enabled });
    }
  };
  wrapped.__fuStatusPop = true;
  proto._displayScrollingStatus = wrapped;
}

export function initStatusPop() {
  wrapScrollingStatus();
  globalThis.FUCompanion = globalThis.FUCompanion || {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
  globalThis.FUCompanion.api.statusPop = { popOnToken, flashStatusLocal };
  log("[StatusPop] ready");
}
