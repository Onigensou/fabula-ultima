// Party Menu — hover a linked term in a description to read what it means.
//
// Descriptions link their terms to the document that defines them: a keyword
// or status to its Encyclopedia journal (Fickle, Crisis, Wet), a damage type to
// its Item. Hovering such a link (or clicking it, for a touch screen) shows a
// card with the term and its rules text. The text is read the way the Action
// Card reads it — the keyword registry first, so the player sees one wording
// everywhere — and otherwise from the linked document itself.
//
// The card lives on document.body, not in the menu: render() rebuilds the menu's
// DOM on every key, and a card inside it would be wiped mid-read.

import { lookupTerm } from "../battle-director/keyword-registry.js";
import { esc, safeHtml, img } from "./party-menu-ui.js";

const TIP_ID = "fud-pm-linktip";
const STYLE_ID = "fud-pm-linktip-style";
// Linked-text links (a.fu-lt) open the shared peek/panel cards instead
// (scripts/linked-text/lt-card.js); this tip only covers links it cannot read.
const LINK = "a[data-uuid]:not(.fu-lt)";

let _tip = null;
let _anchor = null;
const _cache = new Map();

/** { label, icon, html } for a linked document, or null when it has nothing to say. */
function termOf(uuid, text) {
  const key = `${uuid}|${text}`;
  if (_cache.has(key)) return _cache.get(key);
  let out = null;
  const entry = lookupTerm(uuid) ?? lookupTerm(text);
  if (entry?.descHtml) out = { label: text || entry.label, icon: entry.icon ?? null, html: entry.descHtml };
  else {
    let doc = null;
    try { doc = fromUuidSync(uuid); } catch { doc = null; }
    let html = "";
    if (doc?.documentName === "JournalEntry") {
      const page = doc.pages?.contents?.find((p) => p.type === "text" && p.text?.content);
      html = page?.text?.content ?? "";
    } else if (doc?.documentName === "JournalEntryPage") html = doc.text?.content ?? "";
    else if (doc?.documentName === "Item") html = doc.system?.props?.description ?? "";
    else if (doc?.documentName === "ActiveEffect") html = doc.description ?? "";
    if (String(html).replace(/<[^>]*>/g, "").trim()) out = { label: text || doc.name, icon: entry?.icon ?? doc.img ?? null, html };
  }
  _cache.set(key, out);
  return out;
}

function ensureTip() {
  if (!document.getElementById(STYLE_ID)) {
    const st = document.createElement("style");
    st.id = STYLE_ID;
    st.textContent = `
#${TIP_ID} { position: fixed; z-index: 10060; max-width: min(360px, calc(100vw - 24px)); padding: 10px 14px 8px; border-radius: 10px;
  color: #3b2a19; font: 13px/1.45 Signika, "Segoe UI", system-ui, sans-serif; pointer-events: none;
  background: linear-gradient(180deg, #f6ebd3, #efdfc3 60%, #e7d3b1); border: 2px solid #6f5a46;
  box-shadow: 0 0 0 3px #82715f, 0 10px 24px rgba(0,0,0,.45); }
#${TIP_ID} .tip-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; padding-bottom: 5px;
  border-bottom: 1px solid rgba(92,66,30,.3); font-size: 15px; font-weight: 700; color: #8b0000; }
#${TIP_ID} .tip-head img { width: 22px; height: 22px; border: 0; border-radius: 4px; flex: 0 0 auto; }
#${TIP_ID} .tip-body p { margin: 0 0 5px; }
#${TIP_ID} .tip-body ul { margin: 0 0 5px; padding-left: 18px; }
#${TIP_ID} .tip-body li { margin: 0 0 3px; }
#${TIP_ID} .tip-body li p { margin: 0; }
#${TIP_ID} .tip-body img { max-width: 100%; height: auto; vertical-align: middle; border: 0; }
#${TIP_ID} .tip-body a { color: #704a1d; font-weight: 700; text-decoration: none; }`;
    document.head.appendChild(st);
  }
  if (!_tip) {
    _tip = document.createElement("div");
    _tip.id = TIP_ID;
    _tip.hidden = true;
    document.body.appendChild(_tip);
  }
  return _tip;
}

function show(a) {
  const term = termOf(a.dataset.uuid, (a.textContent ?? "").trim());
  if (!term) { hideLinkTip(); return; }
  const tip = ensureTip();
  _anchor = a;
  tip.innerHTML = `<div class="tip-head">${term.icon ? img(term.icon) : ""}<span>${esc(term.label)}</span></div>`
    + `<div class="tip-body">${safeHtml(term.html)}</div>`;
  tip.hidden = false;
  // Below the link when it fits, otherwise above; kept inside the window.
  const r = a.getBoundingClientRect();
  const t = tip.getBoundingClientRect();
  const left = Math.max(12, Math.min(r.left, innerWidth - t.width - 12));
  const below = r.bottom + 8;
  const top = below + t.height <= innerHeight - 12 ? below : Math.max(12, r.top - t.height - 8);
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

export function hideLinkTip() {
  _anchor = null;
  if (_tip) _tip.hidden = true;
}

/** Wire hover + click on the menu root. Clicking a link shows its card instead of opening the document behind the menu. */
export function wireLinkTips(root) {
  root.addEventListener("mouseover", (ev) => {
    const a = ev.target.closest?.(LINK);
    if (a && a !== _anchor) show(a);
  });
  root.addEventListener("mouseout", (ev) => {
    const a = ev.target.closest?.(LINK);
    if (a && !a.contains(ev.relatedTarget)) hideLinkTip();
  });
  root.addEventListener("click", (ev) => {
    const a = ev.target.closest?.(LINK);
    if (!a) return;
    ev.preventDefault();
    ev.stopPropagation();
    show(a);
  }, true);
  root.addEventListener("wheel", hideLinkTip, { passive: true });
}

export function removeLinkTip() {
  hideLinkTip();
  _tip?.remove();
  _tip = null;
}
