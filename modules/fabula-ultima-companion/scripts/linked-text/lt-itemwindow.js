// scripts/linked-text/lt-itemwindow.js
// The in-game Item Window (MMO style) and the full hover card for items.
//
//   hover   a full item card that follows the pointer (keywords keep the short
//           peek in lt-card). Hold Shift to compare with what is equipped.
//   click   pins an Item Window: draggable by its bar, up to MAX_WINDOWS at once
//           (opening another replaces the oldest). Closes with ✕, Esc (the top
//           window) or clicking the same item again — never by clicking elsewhere,
//           so a pinned window survives shopping and bag sorting.
//   bar     ⇄ compare · chain = link in chat · page icon = item sheet (GM only) · ✕
//
// Players never get a Foundry item sheet: installSheetGuard() turns every item
// sheet a player opens (character sheet, sidebar, hotbar, compendium, old chat
// cards) into an Item Window. A GM keeps sheets, and Alt+click on a link or the
// page icon opens one from here.

import { resolveUuid } from "./lt-terms.js";
import { cardHTML, compareFor } from "./lt-itemcard.js";

// Tuning — animation pacing follows the house rule (slow, smooth).
export const IW = Object.freeze({
  MAX_WINDOWS: 3,
  WIN_IN_MS: 320,
  WIN_OUT_MS: 240,
  HOVER_IN_MS: 180,
  HOVER_OUT_MS: 140,
  CASCADE_PX: 22,
  WIDTH: 340,
  WIDTH_COMPARE: 660,
});

const SFX = {
  open: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_4.wav",
  close: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_1.wav",
  toggle: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/switch_mode.wav",
};
function sfx(src, volume = 0.5) {
  try { foundry.audio.AudioHelper.play({ src, volume, loop: false }, false); } catch { /* sound is decoration */ }
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));
const ITEMISH = new Set(["item", "skill", "spell", "passive"]);
export const isItemish = (term) => !!term && ITEMISH.has(term.kind) && !!term.doc;

function docOf(ref) {
  if (!ref) return null;
  if (typeof ref !== "string") return ref;
  try { return fromUuidSync(ref) ?? null; } catch { return null; }
}

// ── Pinned windows ────────────────────────────────────────────────────────────

let _wins = [];        // [{ uuid, el, compare }]
let _top = null;
let _lastDrag = null;  // { left, top } of the last window the player moved

function focusWin(w) {
  _top = w;
  _wins.forEach((x, i) => {
    x.el.classList.toggle("is-focused", x === w);
    x.el.style.zIndex = String(10075 + (x === w ? 4 : Math.min(i, 3)));
  });
}

export function closeItemWindow(w, { silent = false } = {}) {
  _wins = _wins.filter((x) => x !== w);
  if (_top === w) _top = _wins[_wins.length - 1] ?? null;
  if (_top) focusWin(_top);
  const el = w.el;
  el.classList.remove("is-in");
  el.classList.add("is-out");
  const done = () => el.remove();
  el.addEventListener("transitionend", (e) => { if (e.propertyName === "opacity") done(); }, { once: true });
  setTimeout(done, IW.WIN_OUT_MS + 160);
  if (!silent) sfx(SFX.close);
}

export function closeAllItemWindows() {
  for (const w of [..._wins]) closeItemWindow(w, { silent: true });
}

function renderWin(w) {
  const doc = docOf(w.uuid);
  const term = doc ? resolveUuid(w.uuid, doc.name) : null;
  if (!term) { closeItemWindow(w, { silent: true }); return; }
  const cmp = w.compare ? compareFor(doc) : null;
  const canCompare = term.kind === "item" && !!compareFor(doc);
  w.el.classList.toggle("is-compare", !!cmp);
  w.el.style.width = `${cmp ? IW.WIDTH_COMPARE : IW.WIDTH}px`;
  w.el.querySelector(".fu-iw-title").textContent = cmp ? `Compare · vs. ${cmp.vs.name}` : ({ item: "Item", skill: "Skill", spell: "Spell", passive: "Passive" }[term.kind] ?? "Item");
  const btn = w.el.querySelector("[data-iw=compare]");
  btn.hidden = !canCompare;
  btn.setAttribute("aria-pressed", String(!!cmp));
  w.el.querySelector(".fu-iw-body").innerHTML = `<div class="fu-iw-cols">`
    + (cmp ? `<div class="fu-iw-col">${cmp.left}</div>` : "")
    + `<div class="fu-iw-col">${cmp ? `<span class="fu-iw-tag is-sel">Selected</span>` : ""}${cardHTML(term, { vs: cmp?.vs ?? null, actor: cmp?.actor })}${cmp ? cmp.notes : ""}</div>`
    + `</div>`;
}

/**
 * Open (or, if already open, close) the Item Window for an item or skill.
 * @param {string|Item} ref     uuid or document
 * @param {{x?:number, y?:number, compare?:boolean}} [opts]
 */
export function openItemWindow(ref, { x = innerWidth / 2 - IW.WIDTH / 2, y = innerHeight * 0.18, compare = false } = {}) {
  const doc = docOf(ref);
  if (!doc) return null;
  const uuid = doc.uuid;
  const open = _wins.find((w) => w.uuid === uuid);
  if (open) { closeItemWindow(open); return null; }
  if (_wins.length >= IW.MAX_WINDOWS) closeItemWindow(_wins[0], { silent: true });

  const el = document.createElement("div");
  el.className = "fu-iw";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", doc.name);
  el.style.setProperty("--fu-iw-in", `${IW.WIN_IN_MS}ms`);
  el.style.setProperty("--fu-iw-out", `${IW.WIN_OUT_MS}ms`);
  el.innerHTML = `<div class="fu-iw-bar"><span class="fu-iw-title"></span>
      <button type="button" data-iw="compare" title="Compare with equipped" aria-label="Compare with equipped"><i class="fa-solid fa-right-left"></i></button>
      <button type="button" data-iw="chat" title="Link in chat" aria-label="Link in chat"><i class="fa-solid fa-link"></i></button>
      ${game.user?.isGM ? `<button type="button" data-iw="sheet" title="Open item sheet (GM)" aria-label="Open item sheet"><i class="fa-regular fa-file-lines"></i></button>` : ""}
      <button type="button" data-iw="close" title="Close (Esc)" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
    </div><div class="fu-iw-body"></div>`;
  document.body.appendChild(el);
  const w = { uuid, el, compare };
  _wins.push(w);
  renderWin(w);

  // Beside the click, cascading; or where the player last dragged one.
  const n = _wins.length - 1;
  const r = el.getBoundingClientRect();
  const base = _lastDrag ?? { left: x + 16, top: y - 30 };
  const left = Math.min(Math.max(12, base.left + n * IW.CASCADE_PX), innerWidth - r.width - 12);
  const top = Math.min(Math.max(12, base.top + n * IW.CASCADE_PX), innerHeight - Math.min(r.height, innerHeight - 24) - 12);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  focusWin(w);
  hideHoverCard();
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("is-in")));
  sfx(SFX.open);

  el.addEventListener("pointerdown", () => focusWin(w));
  el.querySelector(".fu-iw-bar").addEventListener("pointerdown", (e) => {
    if (e.target.closest("button")) return;
    e.preventDefault();
    const sx = e.clientX - el.offsetLeft, sy = e.clientY - el.offsetTop;
    const move = (ev) => {
      el.style.left = `${Math.min(Math.max(0, ev.clientX - sx), innerWidth - 80)}px`;
      el.style.top = `${Math.min(Math.max(0, ev.clientY - sy), innerHeight - 40)}px`;
    };
    const up = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      _lastDrag = { left: el.offsetLeft, top: el.offsetTop };
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  });
  el.addEventListener("click", (e) => {
    const b = e.target.closest("[data-iw]");
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    const act = b.dataset.iw;
    if (act === "close") closeItemWindow(w);
    else if (act === "compare") { w.compare = !w.compare; renderWin(w); sfx(SFX.toggle, 0.4); }
    else if (act === "chat") postItemLink(uuid, doc.name);
    else if (act === "sheet") doc.sheet?.render(true, { fuForceSheet: true });
  });
  return w;
}

/** Re-render open windows (an item or the equipment changed). */
export function refreshItemWindows() {
  for (const w of [..._wins]) renderWin(w);
}

export async function postItemLink(uuid, label) {
  await ChatMessage.create({ speaker: ChatMessage.getSpeaker(), content: `<p>@UUID[${uuid}]{${label}}</p>` });
}

/** Drop an item's link into the chat message being typed (Shift+click). */
export function linkIntoChatInput(uuid, label) {
  const input = document.querySelector("#chat-message");
  if (!input) return false;
  const text = `@UUID[${uuid}]{${label}} `;
  if ("value" in input) {
    const v = input.value;
    input.value = v + (v && !/\s$/.test(v) ? " " : "") + text;
  } else {
    input.textContent += text;
  }
  input.focus?.();
  return true;
}

// ── Hover card ────────────────────────────────────────────────────────────────

let _hover = null;
let _hoverFor = null;   // uuid
let _hoverXY = [0, 0];
let _hoverHideT = null;
let _shift = false;

function ensureHover() {
  if (_hover?.isConnected) return _hover;
  _hover = document.createElement("div");
  _hover.className = "fu-iw-hover";
  _hover.setAttribute("role", "tooltip");
  _hover.hidden = true;
  _hover.style.setProperty("--fu-iw-hin", `${IW.HOVER_IN_MS}ms`);
  _hover.style.setProperty("--fu-iw-hout", `${IW.HOVER_OUT_MS}ms`);
  document.body.appendChild(_hover);
  return _hover;
}

function drawHover() {
  if (!_hoverFor) return;
  const doc = docOf(_hoverFor);
  const term = doc ? resolveUuid(_hoverFor, doc.name) : null;
  if (!term) return;
  const el = ensureHover();
  const cmp = _shift && term.kind === "item" ? compareFor(doc) : null;
  const worn = !!doc.system?.props?.isEquipped;
  const foot = `${worn ? "Equipped · " : ""}Click to pin${term.kind === "item" && !cmp ? " · Shift to compare" : ""} · Shift+click to link`;
  el.innerHTML = (cmp ? cmp.left.replace(/class="fu-iw-col"/g, 'class="fu-iw-col fu-iw-hcard"') : "")
    + `<div class="fu-iw-col fu-iw-hcard">${cmp ? `<span class="fu-iw-tag is-sel">Selected</span>` : ""}${cardHTML(term, { vs: cmp?.vs ?? null, actor: cmp?.actor })}${cmp ? cmp.notes : ""}<div class="fu-iw-foot">${esc(foot)}</div></div>`;
  clearTimeout(_hoverHideT);
  const wasHidden = el.hidden;
  el.hidden = false;
  el.classList.remove("is-leaving");
  placeHover();
  if (wasHidden) { el.classList.remove("is-shown"); void el.offsetWidth; }
  el.classList.add("is-shown");
}

function placeHover() {
  if (!_hover || _hover.hidden) return;
  const [x, y] = _hoverXY;
  const r = _hover.getBoundingClientRect();
  let left = x + 18, top = y + 14;
  if (left + r.width > innerWidth - 10) left = Math.max(10, x - r.width - 18);
  if (top + r.height > innerHeight - 10) top = Math.max(10, innerHeight - r.height - 10);
  _hover.style.left = `${left}px`;
  _hover.style.top = `${top}px`;
}

/** Show the full card for an item link under the pointer. */
export function showHoverCard(uuid, x, y) {
  _hoverXY = [x, y];
  if (_hoverFor === uuid && _hover && !_hover.hidden) { placeHover(); return; }
  _hoverFor = uuid;
  drawHover();
}

export function moveHoverCard(x, y) {
  _hoverXY = [x, y];
  placeHover();
}

export function hideHoverCard() {
  _hoverFor = null;
  if (!_hover || _hover.hidden) return;
  _hover.classList.add("is-leaving");
  _hover.classList.remove("is-shown");
  clearTimeout(_hoverHideT);
  _hoverHideT = setTimeout(() => { if (_hover) { _hover.hidden = true; _hover.classList.remove("is-leaving"); } }, IW.HOVER_OUT_MS + 20);
}

// ── Keys (registered at import, ahead of screens that listen on window) ──────

window.addEventListener("keydown", (ev) => {
  if (ev.key === "Shift" && !_shift) { _shift = true; drawHover(); return; }
  if (ev.key === "Escape" && _top) {
    ev.preventDefault();
    ev.stopImmediatePropagation();
    closeItemWindow(_top);
  }
}, true);
window.addEventListener("keyup", (ev) => { if (ev.key === "Shift" && _shift) { _shift = false; drawHover(); } }, true);
window.addEventListener("blur", () => { _shift = false; });
export const hasOpenItemWindow = () => !!_top;

// ── Players never get an item sheet ───────────────────────────────────────────

let _guarded = false;
/**
 * Wrap item sheet rendering so a player who opens any item sheet — from the
 * character sheet, the sidebar, the hotbar, a compendium, an old chat card —
 * gets the Item Window instead. GMs are untouched; `{ fuForceSheet: true }`
 * always opens the real sheet.
 */
export function installSheetGuard() {
  if (_guarded) return;
  _guarded = true;
  const wrap = (proto) => {
    if (!proto || !Object.prototype.hasOwnProperty.call(proto, "render") || proto.render.__fuGuarded) return;
    const original = proto.render;
    const guarded = function (force = false, options = {}) {
      const doc = this.document ?? this.object;
      if (force && !this.rendered && !options?.fuForceSheet && !game.user?.isGM && doc?.documentName === "Item") {
        openItemWindow(doc);
        return this;
      }
      return original.call(this, force, options);
    };
    guarded.__fuGuarded = true;
    proto.render = guarded;
  };
  const base = globalThis.ItemSheet ?? foundry.appv1?.sheets?.ItemSheet;
  wrap(base?.prototype);
  for (const byType of Object.values(CONFIG.Item.sheetClasses ?? {})) {
    for (const entry of Object.values(byType ?? {})) wrap(entry?.cls?.prototype);
  }
}
