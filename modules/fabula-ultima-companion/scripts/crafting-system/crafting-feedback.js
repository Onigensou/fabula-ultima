// scripts/crafting-system/crafting-feedback.js
//
// PARTY RESULT BANNER for crafting — "Zarg crafted Elegant Edge ×2".
// Everyone sees it, the crafter too (user, 2026-11-12: a result banner only, no
// "is crafting…" stage). Built on the Orbment banner (orbment-feedback.js): same
// parchment card over the play area, one card at a time from a queue, a light
// star sprinkle, item names are links that open the Item Window for that
// viewer only, hovering a card holds it.
//
// The primary GM sends it after a craft lands (crafting-craft.js → announce()).
// A client whose own window just played the "done" cue skips the banner's,
// so the crafter never hears it twice.

import { TAG, CHANNEL, esc, rarityColor, playSfx } from "./crafting-const.js";

const MSG = "crafting:feedback";
const CONTAINER_ID = "oni-crafting-feedback";
const STYLE_ID = "oni-crafting-feedback-styles";
const LINGER_MS = 3600;
const ANIM_MS = 320;
const SOUND_DEDUPE_MS = 4000;

let _lastLocalDone = 0;
export const markLocalDone = () => { _lastLocalDone = Date.now(); };

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
#${CONTAINER_ID} { position: fixed; top: 56px; left: 0; width: 100%; z-index: 2147483600; pointer-events: none;
  display: flex; flex-direction: column; align-items: center; gap: 8px; }
.oni-cfb-card { position: relative; pointer-events: auto; width: auto; min-width: min(520px, calc(100% - 40px)); max-width: calc(100% - 40px);
  box-sizing: border-box; padding: 10px 24px 10px 12px; border-radius: 10px;
  background: linear-gradient(180deg, #f6ebd3 0%, #efdfc3 100%); border: 2px solid #8d5f38;
  box-shadow: 0 0 0 1px #6f4526, 0 8px 24px rgba(0,0,0,0.45); color: #3b2a19; font: 300 18px/1.3 "Signika", sans-serif;
  display: flex; align-items: center; justify-content: center; gap: 12px;
  opacity: 0; transform: translateX(-44px);
  transition: opacity ${ANIM_MS}ms ease, transform ${ANIM_MS}ms cubic-bezier(.22,.8,.3,1); }
.oni-cfb-card.in  { opacity: 1; transform: none; }
.oni-cfb-card.out { opacity: 0; transform: translateX(44px); }
.oni-cfb-card b { font-weight: 700; }
.oni-cfb-face { width: 38px; height: 38px; border-radius: 50%; object-fit: cover; object-position: top; border: 1px solid #b89940 !important; background: #e8d5a3; flex-shrink: 0; }
.oni-cfb-line { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: center; }
.oni-cfb-out { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; animation: oni-cfb-fadeup .5s .08s cubic-bezier(.22,.8,.3,1) both; }
.oni-cfb-out img { width: 28px; height: 28px; object-fit: contain; image-rendering: pixelated; border: none !important; }
.oni-cfb-sep { color: #b08a5c; }
.oni-cfb-link { font: inherit; font-weight: 700; background: none; border: 0; padding: 0 2px; border-radius: 4px; cursor: pointer;
  display: inline; width: auto; height: auto; line-height: inherit;
  color: var(--c, #3b2a19); text-decoration: underline dotted; text-underline-offset: 4px; text-decoration-thickness: 1px; }
.oni-cfb-link:hover, .oni-cfb-link:focus-visible { background: rgba(201,164,74,.28); outline: none; }
.oni-cfb-qty { font-weight: 700; color: #8b4513; }
.oni-cfb-fx { position: absolute; left: 50%; top: 50%; width: 0; height: 0; overflow: visible; pointer-events: none; }
.oni-cfb-spark { position: absolute; line-height: 1; transform: translate(-50%,-50%); animation: oni-cfb-spark both cubic-bezier(.15,.7,.3,1);
  text-shadow: 0 0 6px currentColor, 0 0 12px currentColor; }
@keyframes oni-cfb-fadeup { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@keyframes oni-cfb-spark { 0% { opacity: 0; transform: translate(-50%,-50%) scale(.2) rotate(0); } 15% { opacity: 1; } 70% { opacity: .9; }
  100% { opacity: 0; transform: translate(calc(-50% + var(--dx)), calc(-50% + var(--dy))) scale(1) rotate(var(--rot)); } }
@media (prefers-reduced-motion: reduce) { .oni-cfb-card, .oni-cfb-card * { animation-duration: 1ms !important; transition: none !important; } }
`;
  document.head.appendChild(s);
}

function ensureContainer() {
  injectStyles();
  let el = document.getElementById(CONTAINER_ID);
  if (!el) {
    el = document.createElement("div");
    el.id = CONTAINER_ID;
    document.body.appendChild(el);
    el.addEventListener("click", (ev) => {
      const link = ev.target.closest?.(".oni-cfb-link");
      if (!link?.dataset.uuid) return;
      ev.preventDefault();
      try { globalThis.FULinkedText?.openItem?.(link.dataset.uuid, { x: ev.clientX - 160, y: ev.clientY + 24 }); }
      catch (e) { console.warn(TAG, "openItem failed", e); }
    });
  }
  // Centre over the play area, clear of the sidebar (same as the Orbment banner).
  const r = document.getElementById("sidebar")?.getBoundingClientRect?.();
  const right = (r && r.width > 0 && r.left > 100) ? r.left : window.innerWidth;
  el.style.width = `${Math.round(Math.max(320, right))}px`;
  return el;
}

function cardHtml(p) {
  const outs = (p.outputs ?? []).map((o) => `<span class="oni-cfb-out"><img src="${esc(o.img)}" alt="">`
    + `<button type="button" class="oni-cfb-link" data-uuid="${esc(o.uuid)}" style="--c:${rarityColor(o.rarity)}">${esc(o.name)}</button>`
    + `${Number(o.qty) > 1 ? `<span class="oni-cfb-qty">×${Number(o.qty)}</span>` : ""}</span>`)
    .join(`<span class="oni-cfb-sep" aria-hidden="true">+</span>`);
  return `${p.actorImg ? `<img class="oni-cfb-face" src="${esc(p.actorImg)}" alt="">` : ""}
    <div class="oni-cfb-line"><span><b>${esc(p.actorName)}</b> crafted</span>${outs}</div>`;
}

function sprinkle(card) {
  const fx = document.createElement("span");
  fx.className = "oni-cfb-fx";
  const GLYPH = ["✦", "★", "✧", "⋆"], COL = ["#ffd36e", "#fff3b0", "#ffe9a8"];
  const spread = Math.min(card.clientWidth * 0.9, 480);
  for (let k = 0; k < 10; k++) {
    const s = document.createElement("span");
    s.className = "oni-cfb-spark";
    s.textContent = GLYPH[k % GLYPH.length];
    s.style.cssText = `left:${((Math.random() - 0.5) * spread).toFixed(0)}px;font-size:${(9 + Math.random() * 6).toFixed(0)}px;color:${COL[k % COL.length]};`
      + `--dx:${((Math.random() - 0.5) * 70).toFixed(0)}px;--dy:${(-(18 + Math.random() * 36)).toFixed(0)}px;--rot:${(Math.random() * 300 - 150).toFixed(0)}deg;`
      + `animation-duration:${(800 + Math.random() * 500).toFixed(0)}ms;animation-delay:${(Math.random() * 160).toFixed(0)}ms`;
    fx.appendChild(s);
  }
  card.appendChild(fx);
  setTimeout(() => fx.remove(), 1600);
}

// ── Queue ────────────────────────────────────────────────────────────────────
const _queue = [];
let _current = null;

function enqueue(p) {
  _queue.push(p);
  if (!_current) showNext();
}

function showNext() {
  const p = _queue.shift();
  if (!p) { _current = null; return; }
  const card = document.createElement("div");
  card.className = "oni-cfb-card";
  card.innerHTML = cardHtml(p);
  ensureContainer().appendChild(card);
  _current = { card, timer: null, held: false };
  card.addEventListener("mouseenter", () => { if (_current?.card === card) { _current.held = true; clearTimeout(_current.timer); } });
  card.addEventListener("mouseleave", () => { if (_current?.card === card) { _current.held = false; linger(); } });
  requestAnimationFrame(() => card.classList.add("in"));
  sprinkle(card);
  if (Date.now() - _lastLocalDone > SOUND_DEDUPE_MS) playSfx("done");
  linger();
}

function linger() {
  if (!_current || _current.held) return;
  clearTimeout(_current.timer);
  _current.timer = setTimeout(dismiss, LINGER_MS);
}

function dismiss() {
  const cur = _current;
  if (!cur || cur.dying) return;
  cur.dying = true;
  clearTimeout(cur.timer);
  cur.card.classList.remove("in");
  cur.card.classList.add("out");
  setTimeout(() => { cur.card.remove(); _current = null; showNext(); }, ANIM_MS);
}

// ── Send / receive ───────────────────────────────────────────────────────────
function onSocket(msg) {
  if (msg?.type !== MSG) return;
  try { enqueue(msg.payload ?? {}); } catch (e) { console.warn(TAG, "banner failed", e); }
}

// Show on this client and every other one.
export function announce({ actorName, actorImg, outputs } = {}) {
  const p = { actorName, actorImg, outputs: (outputs ?? []).map((o) => ({ uuid: o.uuid, name: o.name, img: o.img, qty: o.qty, rarity: o.rarity })) };
  try { game.socket.emit(CHANNEL, { type: MSG, payload: p }); } catch (e) { console.warn(TAG, "emit failed", e); }
  enqueue(p);
}

// Local preview: FUCompanion.api.crafting.feedback._test()
export const feedback = {
  announce,
  _test() {
    enqueue({ actorName: "Zarg", actorImg: game.actors?.getName?.("Zarg")?.img ?? "", outputs: [{ uuid: "", name: "Remedy", img: "icons/svg/item-bag.svg", qty: 3, rarity: "Common" }] });
  },
};

let _installed = false;
export function installFeedback() {
  if (_installed) return;
  _installed = true;
  game.socket.on(CHANNEL, onSocket);
}
