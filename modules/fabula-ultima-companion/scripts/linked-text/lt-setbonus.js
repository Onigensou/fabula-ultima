// scripts/linked-text/lt-setbonus.js
// The Set bonus section, drawn row by row (MMO style, as in Elsword):
//
//   Bloodied Chivalry                      2 / 4
//   [icon] Blood Shield  [icon] Blood Sword  [icon] Blood Helm  [icon] Blood Mail
//   2-Piece  Deals 5 extra damage if you are in Crisis.        ← reached: full colour
//   3-Piece  Reduce damage dealt to you by 5 …                 ← not reached: greyed
//
// Tiers are read from the piece's own set_description, which already has one
// heading per tier ("2-Piece", "2 Piece"). The count is the equipped pieces of
// that set on the character who owns the item, using the set engine's rule
// (isEquipped + isSet + matching set_name), so a lit row means the bonus is
// really active. With no character to count for, every row shows plainly.

import { renderLinkedText } from "./lt-render.js";

const SET_HEADING = /^[\s 【]*set\s*bonus[\s 】:]*$/i;
const TIER_HEAD = /^[\s ]*(\d+)[\s ]*[-–]?[\s ]*pieces?[\s ]*:?[\s ]*$/i;
const TIER_LEAD = /^[\s ]*(\d+)[\s ]*[-–]?[\s ]*pieces?\b[\s :]*/i;
const CSB_EMBEDDED = /^CSB - Embedded Items/i;
const NO_SET = "<set name>";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));
const norm = (s) => String(s ?? "").trim().toLowerCase();
// Refined gear is renamed "+5 Swimsuit"; it is still the Swimsuit piece.
const baseName = (s) => String(s ?? "").replace(/^\+\d+\s+/, "").trim();
const isDef = (p) => p?.set_bonus_table && Object.values(p.set_bonus_table).some((r) => r && !r.$deleted);

function serialize(nodes) {
  const d = document.createElement("div");
  for (const n of nodes) d.appendChild(n);
  return d.innerHTML.trim();
}

/** { intro, tiers: [{ pieces, html }] } or null when the text has no tier headings. */
export function parseSetTiers(html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = String(html ?? "");
  // Some pieces wrap the whole tier block in one bullet ("<ul><li>2-Piece …
  // 3-Piece …</li></ul>"): lift list items that contain a tier heading.
  for (let guard = 0; guard < 6; guard++) {
    const wrap = Array.from(tpl.content.children).find((el) => el.matches("ul,ol")
      && Array.from(el.children).some((li) => Array.from(li.children).some((c) => TIER_HEAD.test(c.textContent ?? ""))));
    if (!wrap) break;
    const parts = [];
    for (const li of Array.from(wrap.children)) parts.push(...li.childNodes);
    wrap.replaceWith(...parts);
  }
  const tiers = [];
  const intro = [];
  let cur = null;
  for (const node of Array.from(tpl.content.childNodes)) {
    const text = node.textContent ?? "";
    if (node.nodeType === Node.TEXT_NODE && !text.trim()) continue;
    if (node.nodeName === "HR") continue;
    if (node.nodeType === Node.ELEMENT_NODE && SET_HEADING.test(text)) continue;
    const head = node.nodeType === Node.ELEMENT_NODE ? text.match(TIER_HEAD) : null;
    if (head) { cur = { pieces: Number(head[1]), nodes: [] }; tiers.push(cur); continue; }
    // "2-Piece When you …" written as one paragraph: split the heading off.
    const lead = node.nodeName === "P" ? text.match(TIER_LEAD) : null;
    if (lead) {
      cur = { pieces: Number(lead[1]), nodes: [] };
      tiers.push(cur);
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      let left = lead[0].length;
      while (left > 0 && walker.nextNode()) {
        const t = walker.currentNode;
        const cut = Math.min(left, t.textContent.length);
        t.textContent = t.textContent.slice(cut);
        left -= cut;
      }
      cur.nodes.push(node);
      continue;
    }
    (cur ? cur.nodes : intro).push(node);
  }
  if (!tiers.length) return null;
  return {
    intro: serialize(intro),
    tiers: tiers.map((t) => ({ pieces: t.pieces, html: serialize(t.nodes) })).sort((a, b) => a.pieces - b.pieces),
  };
}

/** Every piece of a set in the world: [{ name, img }], one per name. */
export function setPieces(setName) {
  const want = norm(setName);
  const seen = new Map();
  for (const it of game.items ?? []) {
    const p = it.system?.props ?? {};
    if (!p.isSet || norm(p.set_name) !== want || isDef(p)) continue;
    if (CSB_EMBEDDED.test(it.folder?.name ?? "")) continue;
    const name = baseName(it.name);
    if (!seen.has(name)) seen.set(name, { name, img: it.img });
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Names of this set's pieces the actor has equipped (the set engine's rule). */
export function equippedPieceNames(actor, setName) {
  const want = norm(setName);
  const names = new Set();
  for (const it of actor?.items ?? []) {
    const p = it.system?.props ?? {};
    if (p.isEquipped && p.isSet && norm(p.set_name) === want) names.add(baseName(it.name));
  }
  return names;
}

/** The character whose pieces count: the item's owner, else the viewer's own character. */
export function setViewer(item) {
  const owner = item?.parent?.documentName === "Actor" ? item.parent : null;
  return owner ?? game.user?.character ?? null;
}

/**
 * Set section HTML for an item, or "" when it has no set text.
 * @param {Item} item
 * @param {{ actor?: Actor|null }} [opts]  defaults to setViewer(item)
 */
export function setBonusHTML(item, { actor } = {}) {
  const p = item?.system?.props ?? {};
  const text = String(p.set_description ?? "");
  if (!text.replace(/<[^>]*>/g, "").replace(/set\s*bonus|[【】\s]/gi, "")) return "";
  const parsed = parseSetTiers(renderLinkedText(text));
  const setName = norm(p.set_name) && norm(p.set_name) !== NO_SET ? String(p.set_name).trim() : "";
  const who = actor === undefined ? setViewer(item) : actor;
  if (!parsed) return `<div class="fu-set">${renderLinkedText(text)}</div>`;

  const pieces = setName ? setPieces(setName) : [];
  const worn = who && setName ? equippedPieceNames(who, setName) : null;
  const count = worn ? worn.size : null;
  const total = pieces.length || null;

  const head = setName
    ? `<div class="fu-set-head"><span class="fu-set-name">${esc(setName)}</span>`
      + (count !== null && total ? `<span class="fu-set-count">${count} / ${total}</span>` : "") + `</div>`
    : "";
  const list = pieces.length
    ? `<div class="fu-set-pieces">${pieces.map((pc) => {
      const off = worn && !worn.has(pc.name);
      return `<span class="fu-set-piece${off ? " is-off" : ""}">${pc.img ? `<img src="${esc(pc.img)}" alt="">` : ""}${esc(pc.name)}</span>`;
    }).join("")}</div>`
    : "";
  const rows = parsed.tiers.map((t) => {
    const state = count === null ? "" : count >= t.pieces ? " is-on" : " is-off";
    return `<div class="fu-set-tier${state}"><span class="fu-set-badge">${t.pieces}-Piece</span><div class="fu-set-text">${t.html}</div></div>`;
  }).join("");
  const intro = parsed.intro ? `<div class="fu-set-intro">${parsed.intro}</div>` : "";
  return `<div class="fu-set">${head}${list}${intro}<div class="fu-set-tiers">${rows}</div></div>`;
}
