// scripts/linked-text/lt-card.js
// The two views every linked term opens, on every screen:
//   peek  — hover a link (mouse) for a short summary. Never takes the pointer.
//   panel — click a link for the full card. Links inside it open in place, a
//           trail at the top steps back, clicking the open link again closes it,
//           and a faint chain icon posts the link to chat.
//
// The game is moving console-style: players never open Foundry item sheets, so
// the panel IS the player-facing view of a skill or item. A GM can still Alt-
// click a link to get Foundry's default behaviour (open the sheet).
//
// Both views live on document.body so screens that rebuild their DOM on every
// key (party menu) cannot wipe them mid-read.

import { resolveUuid, DAMAGE } from "./lt-terms.js";
import { iconHTML, renderLinkedText, safeHtml } from "./lt-render.js";

const PEEK_ID = "fu-lt-peek";
const PANEL_ID = "fu-lt-panel";
const PEEK_DELAY_MS = 220;
const PANEL_W = 320;
const ZENIT_ICON = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/GP.png";

let _peek = null;
let _panel = null;
let _peekTimer = null;
let _peekFor = null;
let _trail = [];          // [{ uuid, label }]
let _anchorRect = null;   // where the panel was opened, kept while drilling down

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));
const cap = (s) => String(s ?? "").replace(/^\w/, (c) => c.toUpperCase());
const plain = (html) => {
  const body = new DOMParser().parseFromString(String(html ?? ""), "text/html").body;
  body.querySelectorAll("p,li,div,br,tr").forEach((el) => el.after(" "));
  return (body.textContent ?? "").replace(/\s+/g, " ").trim();
};

// ── What a term says ──────────────────────────────────────────────────────────

const DAMAGE_DESC = "<p>Elemental damage. Each creature has an affinity to it: <strong>Vulnerable</strong> takes double, "
  + "<strong>Resistant</strong> takes half, <strong>Immune</strong> takes none, and <strong>Absorb</strong> heals instead.</p>";

function subtitle(term) {
  const p = term.doc?.system?.props ?? {};
  switch (term.kind) {
    case "dmg": return "Damage type";
    case "status": return "Status";
    case "kw": return term.entry?.category === "equipment" ? "Equipment keyword" : "Keyword";
    case "skill": case "spell": case "passive":
      return [{ skill: "Skill", spell: "Spell", passive: "Passive" }[term.kind], p.class, p.cost].filter(Boolean).join(" · ");
    case "item":
      return [p.item_rarity, cap(p.item_type), p.category].filter(Boolean).join(" · ");
    case "actor": return "Companion";
    default: return "";
  }
}

const check = (p) => (p.rolled_atr1 && p.rolled_atr2 ? `<strong>【${esc(p.rolled_atr1)} + ${esc(p.rolled_atr2)}】</strong>` : "");
const dmgLink = (type) => {
  const d = DAMAGE[String(type ?? "").toLowerCase()];
  return d ? ` <span class="fu-lt-dmgtxt" style="--fu-lt-c:${d.color};--fu-lt-glow:${d.glow}"><i class="fa-solid ${d.fa} fu-lt-fa"></i>${esc(cap(type))}</span>` : "";
};

// Data grid rows, in reading order. Data first, then the effect, then flavor.
function gridRows(term) {
  const p = term.doc?.system?.props ?? {};
  if (term.kind === "skill" || term.kind === "spell" || term.kind === "passive") {
    const vs = { def: "Defense", mdef: "Magic Defense" }[p.defense_target_type];
    return [
      ["Cost", esc(p.cost)], ["Target", esc(p.skill_target)], ["Range", esc(p.skill_range)],
      ["Duration", esc(p.duration)], ["Check", check(p)], ["vs", check(p) && vs ? vs : ""],
    ];
  }
  if (term.kind === "item") {
    if (p.item_type === "weapon") {
      const acc = check(p) + (Number(p.check_bonus) ? ` +${Number(p.check_bonus)}` : "");
      const dmg = `<strong>【HR + ${Number(p.damage_bonus) || 0}】</strong>${dmgLink(p.type_damage)}`;
      return [["Accuracy", acc], ["Damage", dmg], ["Range", esc(p.weapon_range)], ["Hands", esc(p.hand_slots)]];
    }
    if (p.item_type === "armor" || p.item_type === "shield") {
      const def = (Number(p.item_baseDef) || 0) + (Number(p.item_def_bonus) || 0);
      const mdef = (Number(p.item_baseMdef) || 0) + (Number(p.item_mdef_bonus) || 0);
      return [["DEF", def ? `+${def}` : ""], ["M.DEF", mdef ? `+${mdef}` : ""]];
    }
  }
  return [];
}

function descriptionOf(term) {
  if (term.kind === "dmg") return DAMAGE_DESC;
  if (term.descHtml) return term.descHtml;
  const p = term.doc?.system?.props ?? {};
  return p.description || p.consumable_description || p.skill_description || "";
}

function flavorOf(term) {
  const p = term.doc?.system?.props ?? {};
  return p.flavor_text || p.consumable_flavor || "";
}

function badgeHTML(term) {
  if (term.img) return `<img class="fu-ltc-badge" src="${esc(term.img)}" alt="">`;
  const c = term.kind === "status" ? "#9b3a24" : term.color || "#7a4e20";
  if (term.kind === "kw") return `<div class="fu-ltc-badge is-kw" aria-hidden="true"><i></i></div>`;
  return `<div class="fu-ltc-badge" style="--fu-lt-c:${c}" aria-hidden="true"><i class="fa-solid ${esc(term.fa || "fa-link")}"></i></div>`;
}

function priceHTML(term) {
  const cost = Number(term.doc?.system?.props?.item_cost);
  if (term.kind !== "item" || !cost) return "";
  return `<div class="fu-ltc-price" title="Value"><img src="${ZENIT_ICON}" alt="Zenit">${cost.toLocaleString()}</div>`;
}

// ── Panel ─────────────────────────────────────────────────────────────────────

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

// ── Peek ──────────────────────────────────────────────────────────────────────

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

function showPeek(a) {
  const term = resolveUuid(a.dataset.uuid, a.querySelector(".fu-lt-nm")?.textContent ?? a.textContent);
  if (!term) return;
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
  openCard({
    uuid: a.dataset.uuid,
    label: a.querySelector(".fu-lt-nm")?.textContent ?? a.textContent.trim(),
    rect: a.getBoundingClientRect(),
    nested: !!panel?.contains(a),
  });
}

function onPointerDown(ev) {
  if (!_panel || _panel.hidden) return;
  if (_panel.contains(ev.target) || ev.target.closest?.(LINK)) return;
  closeCard();
}

function onOver(ev) {
  if (ev.pointerType && ev.pointerType !== "mouse") return;
  const a = ev.target.closest?.(LINK);
  if (!a || a === _peekFor) return;
  _peekFor = a;
  clearTimeout(_peekTimer);
  _peekTimer = setTimeout(() => { if (_peekFor === a && a.isConnected) showPeek(a); }, PEEK_DELAY_MS);
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
  document.addEventListener("pointerout", onOut, true);
  document.addEventListener("wheel", hidePeek, { passive: true, capture: true });
}
