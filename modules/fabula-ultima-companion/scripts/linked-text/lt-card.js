// scripts/linked-text/lt-card.js
// What a linked term opens, on every screen.
//
//   Items, skills, spells → the Item Window (lt-itemwindow.js): hover shows the
//     full card following the pointer, click pins a window, Shift+click drops
//     the link into the chat message being typed.
//   Keywords, statuses, damage types, companions →
//     peek  — hover for a short summary. Never takes the pointer.
//     panel — click for the full card. Links inside it open in place, a trail at
//             the top steps back, clicking the open link again closes it, and a
//             faint chain icon posts the link to chat.
//
// Players never open Foundry sheets from links; a GM can Alt+click a link for
// Foundry's default behaviour (open the sheet).
//
// Everything lives on document.body so screens that rebuild their DOM on every
// key (party menu) cannot wipe it mid-read.

import { resolveUuid } from "./lt-terms.js";
import { iconHTML, renderLinkedText, safeHtml } from "./lt-render.js";
import { subtitle, gridRows, descriptionOf, flavorOf, badgeHTML, priceHTML } from "./lt-itemcard.js";
import {
  isItemish, openItemWindow, showHoverCard, moveHoverCard, hideHoverCard, linkIntoChatInput,
} from "./lt-itemwindow.js";

const PEEK_ID = "fu-lt-peek";
const PANEL_ID = "fu-lt-panel";
const PEEK_DELAY_MS = 220;
const PANEL_W = 320;

let _peek = null;
let _panel = null;
let _peekTimer = null;
let _peekFor = null;
let _trail = [];          // [{ uuid, label }]
let _anchorRect = null;   // where the panel was opened, kept while drilling down

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));
const plain = (html) => {
  const body = new DOMParser().parseFromString(String(html ?? ""), "text/html").body;
  body.querySelectorAll("p,li,div,br,tr").forEach((el) => el.after(" "));
  return (body.textContent ?? "").replace(/\s+/g, " ").trim();
};
const linkLabel = (a) => a.querySelector(".fu-lt-nm")?.textContent ?? a.textContent.trim();

// ── Panel (keywords, statuses, damage types) ──────────────────────────────────

function ensurePanel() {
  if (_panel?.isConnected) return _panel;
  _panel = document.createElement("div");
  _panel.id = PANEL_ID;
  _panel.className = "fu-ltc";
  _panel.setAttribute("role", "dialog");
  _panel.setAttribute("aria-label", "Link details");
  _panel.hidden = true;
  document.body.appendChild(_panel);
  return _panel;
}

function currentTerm() {
  const top = _trail[_trail.length - 1];
  return top ? resolveUuid(top.uuid, top.label) : null;
}

function drawPanel() {
  const term = currentTerm();
  const panel = ensurePanel();
  if (!term) { closeCard(); return; }

  const crumbs = _trail.length > 1
    ? `<nav class="fu-ltc-crumbs">${_trail.map((t, i) => (i ? `<span class="sep">›</span>` : "")
      + `<button type="button" class="fu-ltc-crumb" data-crumb="${i}" ${i === _trail.length - 1 ? 'aria-current="page"' : ""}>${esc(t.label)}</button>`).join("")}</nav>`
    : `<span></span>`;
  const rows = gridRows(term).filter(([, v]) => v);
  const grid = rows.length
    ? `<div class="fu-ltc-grid">${rows.map(([k, v]) => `<div><span>${esc(k)}</span>${v}</div>`).join("")}</div>`
    : "";
  const desc = descriptionOf(term);
  const body = desc
    ? `<div class="fu-ltc-body">${renderLinkedText(safeHtml(desc))}</div>`
    : (term.missing ? `<div class="fu-ltc-body fu-ltc-muted">No details available.</div>` : "");
  const flavor = flavorOf(term);

  panel.innerHTML = `
    <div class="fu-ltc-top">${crumbs}
      <button type="button" class="fu-ltc-chat" title="Link in chat" aria-label="Link in chat" ${term.uuid ? "" : "disabled"}><i class="fa-solid fa-link"></i></button>
    </div>
    <div class="fu-ltc-head">${badgeHTML(term)}
      <div class="fu-ltc-title"><div class="fu-ltc-name">${esc(term.name)}</div><div class="fu-ltc-sub">${esc(subtitle(term))}</div></div>
      ${priceHTML(term)}
    </div>
    ${grid}${body}
    ${flavor ? `<div class="fu-ltc-flavor">${safeHtml(flavor)}</div>` : ""}`;
  panel.hidden = false;
  placePanel(panel);
}

function placePanel(panel) {
  const r = _anchorRect;
  panel.style.width = `${PANEL_W}px`;
  const h = panel.offsetHeight;
  let left = r ? r.right + 12 : innerWidth / 2 - PANEL_W / 2;
  if (r && left + PANEL_W > innerWidth - 12) left = r.left - PANEL_W - 12;
  left = Math.max(12, Math.min(left, innerWidth - PANEL_W - 12));
  let top = r ? r.top - 16 : innerHeight * 0.2;
  top = Math.max(12, Math.min(top, innerHeight - h - 12));
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
}

/** Open the panel for a link. From inside the panel the term is pushed on the trail. */
export function openCard({ uuid, label, rect = null, nested = false } = {}) {
  if (!uuid) return;
  const top = _trail[_trail.length - 1];
  if (!nested && _panel && !_panel.hidden && top?.uuid === uuid) { closeCard(); return; }
  if (!nested) { _trail = []; _anchorRect = rect; }
  if (top?.uuid !== uuid || !nested) _trail.push({ uuid, label });
  if (_trail.length > 6) _trail = [_trail[0], ..._trail.slice(-5)];
  hidePeek();
  drawPanel();
}

export function closeCard() {
  _trail = [];
  if (_panel) _panel.hidden = true;
}

async function linkInChat() {
  const top = _trail[_trail.length - 1];
  if (!top?.uuid) return;
  await ChatMessage.create({ speaker: ChatMessage.getSpeaker(), content: `<p>@UUID[${top.uuid}]{${top.label}}</p>` });
}

// ── Peek (keywords, statuses, damage types) ───────────────────────────────────

function ensurePeek() {
  if (_peek?.isConnected) return _peek;
  _peek = document.createElement("div");
  _peek.id = PEEK_ID;
  _peek.className = "fu-ltc fu-ltc-peek";
  _peek.setAttribute("role", "tooltip");
  _peek.hidden = true;
  document.body.appendChild(_peek);
  return _peek;
}

function showPeek(a, term) {
  const peek = ensurePeek();
  let text = plain(descriptionOf(term));
  if (text.length > 220) text = text.slice(0, 217).trimEnd() + "…";
  peek.innerHTML = `<div class="fu-ltc-phead">${iconHTML(term)}<b>${esc(term.name)}</b><span class="fu-ltc-pill">${esc(subtitle(term))}</span></div>`
    + (text ? `<div class="fu-ltc-ptext">${esc(text)}</div>` : "")
    + `<div class="fu-ltc-pfoot">Click to open</div>`;
  peek.hidden = false;
  const r = a.getBoundingClientRect();
  const w = peek.offsetWidth, h = peek.offsetHeight;
  const left = Math.max(12, Math.min(r.left, innerWidth - w - 12));
  const top = r.bottom + 8 + h <= innerHeight - 12 ? r.bottom + 8 : Math.max(12, r.top - h - 8);
  peek.style.left = `${left}px`;
  peek.style.top = `${top}px`;
}

export function hidePeek() {
  clearTimeout(_peekTimer);
  _peekFor = null;
  if (_peek) _peek.hidden = true;
  hideHoverCard();
}

// ── Wiring ────────────────────────────────────────────────────────────────────

const LINK = "a.fu-lt[data-uuid]";

function onClick(ev) {
  const panel = _panel && !_panel.hidden ? _panel : null;
  if (panel?.contains(ev.target)) {
    const crumb = ev.target.closest("[data-crumb]");
    if (crumb) { _trail = _trail.slice(0, Number(crumb.dataset.crumb) + 1); drawPanel(); ev.preventDefault(); return; }
    if (ev.target.closest(".fu-ltc-chat")) { ev.preventDefault(); linkInChat(); return; }
  }
  const a = ev.target.closest?.(LINK);
  if (!a) return;
  if (ev.altKey && game.user?.isGM) return; // GM: Foundry's default, open the sheet
  ev.preventDefault();
  ev.stopImmediatePropagation();
  const uuid = a.dataset.uuid;
  const label = linkLabel(a);
  const term = resolveUuid(uuid, label);
  if (isItemish(term)) {
    if (ev.shiftKey && linkIntoChatInput(term.uuid ?? uuid, term.name)) return;
    openItemWindow(term.uuid ?? uuid, { x: ev.clientX, y: ev.clientY });
    return;
  }
  openCard({ uuid, label, rect: a.getBoundingClientRect(), nested: !!panel?.contains(a) });
}

function onPointerDown(ev) {
  if (!_panel || _panel.hidden) return;
  if (_panel.contains(ev.target) || ev.target.closest?.(LINK) || ev.target.closest?.(".fu-iw")) return;
  closeCard();
}

function onOver(ev) {
  if (ev.pointerType && ev.pointerType !== "mouse") return;
  const a = ev.target.closest?.(LINK);
  if (!a || a === _peekFor) return;
  _peekFor = a;
  clearTimeout(_peekTimer);
  const term = resolveUuid(a.dataset.uuid, linkLabel(a));
  if (!term) return;
  if (isItemish(term)) { showHoverCard(term.uuid, ev.clientX, ev.clientY); return; }
  _peekTimer = setTimeout(() => { if (_peekFor === a && a.isConnected) showPeek(a, term); }, PEEK_DELAY_MS);
}

function onMove(ev) {
  if (_peekFor) moveHoverCard(ev.clientX, ev.clientY);
}

function onOut(ev) {
  const a = ev.target.closest?.(LINK);
  if (a && !a.contains(ev.relatedTarget)) hidePeek();
}

// Escape closes the panel and nothing else. Many screens listen for keys on
// window in the capture phase, so this registers there at import time — ahead
// of anything wired at `ready` — and only swallows the key while the panel is open.
function onKey(ev) {
  if (ev.key === "Escape" && _panel && !_panel.hidden) {
    ev.preventDefault();
    ev.stopImmediatePropagation();
    closeCard();
  }
}
window.addEventListener("keydown", onKey, true);

let _wired = false;
export function initCards() {
  if (_wired) return;
  _wired = true;
  document.addEventListener("click", onClick, true);
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("pointerover", onOver, true);
  document.addEventListener("pointermove", onMove, { passive: true, capture: true });
  document.addEventListener("pointerout", onOut, true);
  document.addEventListener("wheel", hidePeek, { passive: true, capture: true });
}
