// scripts/linked-text/lt-render.js
// Turns item text into linked text: one look for every keyword, status, damage
// type, skill and item link, on every screen.
//
// Two entry points:
//   renderLinkedText(html) — string in, string out. For screens that build HTML
//     themselves (shop, party menu, action card, roulette). Converts short tags
//     (@Status[Burn]) and raw @UUID[...]{Label} text into links, then decorates.
//   decorateLinks(root)    — DOM pass over an already-rendered element (item
//     sheets, chat, enrichHTML output). Restyles every a[data-uuid] it can
//     resolve, whatever markup it was authored with.
//
// Output is always a plain <a class="content-link" data-uuid> with the icon and
// label inside, so everything that already reads content links keeps working:
// the Action Card's keyword chips, the shop's sanitizer, the party menu's
// safeHtml, Foundry's drag-and-drop.
//
// Display only: nothing here writes back to a document.

import { resolveUuid, resolveTag, REF_KINDS } from "./lt-terms.js";

export const TAG_RE = /@(Dmg|Status|Kw|Skill|Spell|Item)\[([^\]]+)\](?:\{([^}]*)\})?/g;
const UUID_RE = /@UUID\[([^\]]+)\](?:\{([^}]*)\})?/g;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));

// ── Link markup ───────────────────────────────────────────────────────────────

export function iconHTML(term) {
  if (term.kind === "dmg") return `<i class="fa-solid ${term.fa} fu-lt-fa" aria-hidden="true"></i>`;
  if (term.img) return `<img class="fu-lt-img" src="${esc(term.img)}" alt="">`;
  if (term.kind === "kw") return `<span class="fu-lt-dia" aria-hidden="true"></span>`;
  return `<i class="fa-solid ${term.fa || "fa-link"} fu-lt-fa" aria-hidden="true"></i>`;
}

function innerHTML(term) {
  const nm = `<span class="fu-lt-nm">${esc(term.label)}</span>`;
  return REF_KINDS.has(term.kind)
    ? `<span class="fu-lt-br">【</span>${iconHTML(term)}${nm}<span class="fu-lt-br">】</span>`
    : iconHTML(term) + nm;
}

function styleVars(term) {
  return [term.color && `--fu-lt-c:${term.color}`, term.glow && `--fu-lt-glow:${term.glow}`]
    .filter(Boolean).join(";");
}

function applyTerm(a, term) {
  for (const attr of ["style", "data-tooltip", "aria-describedby", "data-link"]) a.removeAttribute(attr);
  a.className = `content-link fu-lt fu-lt--${term.kind}${term.missing ? " fu-lt--missing" : ""}`;
  if (term.uuid) {
    a.dataset.uuid = term.uuid;
    const parts = term.uuid.split(".");
    a.dataset.id = parts[parts.length - 1];
    a.dataset.type = term.doc?.documentName ?? parts[parts.length - 2] ?? parts[0];
  }
  a.dataset.fuLt = term.kind;
  a.draggable = !!term.uuid;
  const vars = styleVars(term);
  if (vars) a.setAttribute("style", vars);
  a.innerHTML = innerHTML(term);
}

/** Full link markup for a resolved term. */
export function linkHTML(term) {
  const a = document.createElement("a");
  applyTerm(a, term);
  return a.outerHTML;
}

function unknownHTML(text) {
  return `<span class="fu-lt-unknown" title="Unknown term">${esc(text)}</span>`;
}

// ── Tidying legacy markup around a link ───────────────────────────────────────
// Old links were authored as 【💥<strong>@UUID[…]{Name}</strong>】 or wrapped in
// underline/font spans. The new link draws its own brackets, icon and weight,
// so strip the old ones or they double up.

const WRAP = new Set(["SPAN", "STRONG", "B", "U"]);
const isBlank = (n) => n.nodeType === Node.TEXT_NODE && !n.textContent.replace(/[\s ]/g, "");
const OPEN_BR = /【[\s ]*(?:\p{Extended_Pictographic}️?)?[\s ]*$/u;
const CLOSE_BR = /^[\s ]*】/;
const LONE_EMOJI = /\p{Extended_Pictographic}️?$/u;

function edgeText(el, dir) {
  let n = dir === "prev" ? el.lastChild : el.firstChild;
  while (n && n.nodeType === Node.ELEMENT_NODE) n = dir === "prev" ? n.lastChild : n.firstChild;
  return n?.nodeType === Node.TEXT_NODE ? n : null;
}

// The text node right before/after the link, looking through wrapper elements.
function adjacentText(node, dir) {
  let n = node;
  while (n) {
    const sib = dir === "prev" ? n.previousSibling : n.nextSibling;
    if (sib) {
      if (sib.nodeType === Node.TEXT_NODE) return sib;
      if (sib.nodeType === Node.ELEMENT_NODE && WRAP.has(sib.tagName)) return edgeText(sib, dir);
      return null;
    }
    n = n.parentElement;
    if (!n || !WRAP.has(n.tagName)) return null;
  }
  return null;
}

function unwrapSolo(a) {
  let p = a.parentElement;
  while (p && WRAP.has(p.tagName) && !p.classList.contains("fu-lt")
      && Array.from(p.childNodes).every((c) => c === a || isBlank(c))) {
    const up = p.parentElement;
    p.replaceWith(...p.childNodes);
    p = up;
  }
}

function tidyAround(a) {
  const kind = a.dataset.fuLt;
  if (REF_KINDS.has(kind) || kind === "actor") {
    const prev = adjacentText(a, "prev");
    const next = adjacentText(a, "next");
    if (prev && next && OPEN_BR.test(prev.textContent) && CLOSE_BR.test(next.textContent)) {
      prev.textContent = prev.textContent.replace(OPEN_BR, "");
      next.textContent = next.textContent.replace(CLOSE_BR, "");
    } else if (prev && LONE_EMOJI.test(prev.textContent)) {
      prev.textContent = prev.textContent.replace(LONE_EMOJI, "");
    }
  }
  unwrapSolo(a);
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Restyle every resolvable a[data-uuid] under `root`. Returns how many changed. */
export function decorateLinks(root) {
  if (!root?.querySelectorAll) return 0;
  let changed = 0;
  for (const a of Array.from(root.querySelectorAll("a[data-uuid]"))) {
    if (a.classList.contains("fu-lt") || a.closest(".ProseMirror, prose-mirror")) continue;
    const term = resolveUuid(a.dataset.uuid, a.textContent);
    if (!term) continue;
    applyTerm(a, term);
    changed++;
  }
  for (const a of Array.from(root.querySelectorAll("a.fu-lt"))) {
    if (!a.dataset.fuLtTidy) { tidyAround(a); a.dataset.fuLtTidy = "1"; }
  }
  return changed;
}

/** Convert tags and raw @UUID text to links, then decorate. String in, string out. */
export function renderLinkedText(html) {
  if (!html) return "";
  let s = String(html);
  if (s.includes("@")) {
    s = s.replace(TAG_RE, (m, tag, ref, label) => {
      const t = resolveTag(tag, ref, label);
      return t ? linkHTML(t) : unknownHTML(label || ref);
    });
    s = s.replace(UUID_RE, (m, uuid, label) => {
      const t = resolveUuid(uuid, label);
      return t ? linkHTML(t) : esc(label || uuid.split(".").pop());
    });
  }
  if (!s.includes("data-uuid") && !s.includes("fu-lt")) return s;
  const tpl = document.createElement("template");
  tpl.innerHTML = s;
  decorateLinks(tpl.content);
  const out = document.createElement("div");
  out.appendChild(tpl.content);
  return out.innerHTML;
}

/** Plain-text version for one-line summaries: links become their labels. */
export function plainLinkedText(html) {
  return String(html ?? "")
    .replace(TAG_RE, (m, tag, ref, label) => label || resolveTag(tag, ref)?.label || ref)
    .replace(UUID_RE, (m, uuid, label) => label || resolveUuid(uuid)?.label || "");
}

/** Foundry enricher so item sheets, journals and chat render the tags too. */
export function registerEnricher() {
  // @Item[…] is left to Foundry's own content-link enricher (it runs first);
  // decorateLinks restyles the link it produces.
  CONFIG.TextEditor.enrichers.push({
    pattern: /@(Dmg|Status|Kw|Skill|Spell)\[([^\]]+)\](?:\{([^}]*)\})?/g,
    enricher: async (match) => {
      const t = resolveTag(match[1], match[2], match[3]);
      const tpl = document.createElement("template");
      tpl.innerHTML = t ? linkHTML(t) : unknownHTML(match[3] || match[2]);
      return tpl.content.firstElementChild;
    },
  });
}

// ── Sanitising for the card ───────────────────────────────────────────────────
// Item descriptions can be written by players (most items are player-owned), and
// the card opens for the GM too, so render them inert and stripped of anything
// active — the same policy as the party menu's safeHtml.

const DROP = "script,style,iframe,object,embed,link,meta,base,form,input,button,textarea,select,svg,math,template";

export function safeHtml(html) {
  const body = new DOMParser().parseFromString(String(html ?? ""), "text/html").body;
  body.querySelectorAll(DROP).forEach((el) => el.remove());
  for (const el of body.querySelectorAll("*")) {
    for (const attr of Array.from(el.attributes)) {
      const n = attr.name.toLowerCase();
      const v = attr.value.trim().toLowerCase();
      const badStyle = n === "style" && /url\(|expression|position|behavior|binding|@import|z-index/.test(v);
      if (n.startsWith("on") || n === "srcdoc" || badStyle
          || ((n === "href" || n === "src" || n === "xlink:href") && !/^(https?:|\/|#|[\w.-]+\/)/.test(v))) {
        el.removeAttribute(attr.name);
      }
    }
  }
  return body.innerHTML;
}
