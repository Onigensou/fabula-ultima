// scripts/linked-text/lt-convert.js
// Converts item text to the linked-text STORAGE format, and lints it.
//
// Stored format = the minimal content link, nothing else:
//   <a class="content-link" data-uuid="JournalEntry.MSRXG4jUMPFpM9sN"
//      data-id="MSRXG4jUMPFpM9sN" data-type="JournalEntry">Burn</a>
// No inline styling, no 【💥…】 wrapping, no underline/font spans — lt-render
// draws all of that at display time. Screens that flatten text to plain still
// read the label, and ProseMirror shows it as a link while editing.
//
// convertHtml(html) turns legacy text into that format:
//   RAW_UUID     @UUID[…]{Label} text            → link
//   TAG          @Status[Burn] short tag          → link
//   STYLED_LINK  link with inline styles/wrappers → minimal link
//   GRANT_WRAP   【💥 link 】 around a skill/item   → minimal link (brackets dropped)
//   DMG_WORD     "40 Air damage" unlinked         → Air linked to its damage item
//   STATUS_WORD  "suffers Poisoned" unlinked      → Poisoned linked (after a verb only)
// and reports what it will not touch:
//   DANGLING     link whose target no longer exists
//   REVIEW_WORD  status/keyword name left unlinked (no verb before it)
//
// convertWorld({ dryRun }) runs it over every item text field in the world:
// world items, items on actors, compendium items, and items on unlinked tokens.

import { resolveUuid, resolveTag, REF_KINDS, DAMAGE } from "./lt-terms.js";
import { allTerms, lookupTerm } from "../battle-director/keyword-registry.js";

const TAG_RE = /@(Dmg|Status|Kw|Skill|Spell|Item)\[([^\]]+)\](?:\{([^}]*)\})?/g;
const UUID_RE = /@UUID\[([^\]]+)\](?:\{([^}]*)\})?/g;
const WRAP = new Set(["SPAN", "STRONG", "B", "U"]);
const OPEN_BR = /【[\s ]*(?:\p{Extended_Pictographic}️?)?[\s ]*$/u;
const CLOSE_BR = /^[\s ]*】/;
const LONE_EMOJI = /\p{Extended_Pictographic}️?[\s ]*$/u;
const DMG_WORD = /\b(physical|air|bolt|dark|earth|fire|ice|light|poison)(\s+damage)\b/gi;
// A status after one of these verbs is unambiguous ("suffers Weak", "immune to Slow").
const STATUS_VERB = "(?:suffers?|suffering|inflicts?|inflicted with|inflicting|immune to|immunity to|cures?|removes?|recovers? from|afflicted with|is|are|becomes?)";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));
const isBlank = (n) => n.nodeType === Node.TEXT_NODE && !n.textContent.replace(/[\s ]/g, "");

function docTypeOf(uuid) {
  const parts = String(uuid).split(".");
  return parts.length >= 4 ? parts[parts.length - 2] : parts[0] === "Compendium" ? parts[parts.length - 2] : parts[0];
}

/** The stored link. */
export function minimalLink(uuid, label) {
  const parts = String(uuid).split(".");
  return `<a class="content-link" data-uuid="${esc(uuid)}" data-id="${esc(parts[parts.length - 1])}" data-type="${esc(docTypeOf(uuid))}">${esc(label)}</a>`;
}

function linkEl(uuid, label) {
  const t = document.createElement("template");
  t.innerHTML = minimalLink(uuid, label);
  return t.content.firstElementChild;
}

// ── Status-word list (for STATUS_WORD / REVIEW_WORD) ─────────────────────────
let _statusRe = null;
let _reviewRe = null;
let _listRe = null;
function statusRegexes() {
  if (_statusRe) return [_statusRe, _reviewRe, _listRe];
  // Generic rules words that are almost never meant as the keyword in prose.
  const NOT_REVIEWED = new Set(["Melee", "Range", "Strike Damage", "Magic Damage", "Silent", "Innate", "Shield"]);
  const names = allTerms()
    .filter((e) => e.category === "status" || e.category === "keyword")
    .map((e) => e.label)
    .filter((n) => n.length > 2 && !NOT_REVIEWED.has(n))
    .sort((a, b) => b.length - a.length)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const statuses = allTerms().filter((e) => e.category === "status").map((e) => e.label)
    .filter((n) => n.length > 2).sort((a, b) => b.length - a.length)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  // "in Crisis" is always the status, so it counts as a verb for Crisis only.
  _statusRe = new RegExp(`(\\b${STATUS_VERB}\\s+(?:the\\s+)?|\\bin\\s+(?=Crisis\\b))(${statuses.join("|")})\\b`, "gi");
  _reviewRe = new RegExp(`\\b(${names.join("|")})\\b`, "g");
  // A status continuing a list right after a status link: ", Slow and Weak".
  _listRe = new RegExp(`^([\\s\\u00a0]*(?:,[\\s\\u00a0]*(?:and|or)?|and|or|\\/)[\\s\\u00a0]*)(${statuses.join("|")})\\b`, "i");
  return [_statusRe, _reviewRe, _listRe];
}

// ── Tidying around a link (same rules as lt-render, applied to storage) ──────

function edgeText(el, dir) {
  let n = dir === "prev" ? el.lastChild : el.firstChild;
  while (n && n.nodeType === Node.ELEMENT_NODE) n = dir === "prev" ? n.lastChild : n.firstChild;
  return n?.nodeType === Node.TEXT_NODE ? n : null;
}
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
  let changed = false;
  let p = a.parentElement;
  while (p && WRAP.has(p.tagName) && Array.from(p.childNodes).every((c) => c === a || isBlank(c))) {
    const up = p.parentElement;
    p.replaceWith(...p.childNodes);
    p = up;
    changed = true;
  }
  return changed;
}
// Spans the old styled-link markup wrapped around every link: underline and the
// Signika font, nothing else. Safe to drop — the link draws its own look.
const CHROME_STYLE = /^\s*((text-decoration:\s*underline|font-family:\s*Signika[^;]*)\s*;?\s*)+$/i;
function isChromeSpan(el) {
  return el.tagName === "SPAN" && el.attributes.length === 1 && CHROME_STYLE.test(el.getAttribute("style") ?? "");
}
function unwrapChrome(a) {
  let changed = false;
  let p = a.parentElement;
  while (p && isChromeSpan(p)) {
    const up = p.parentElement;
    p.replaceWith(...p.childNodes);
    p = up;
    changed = true;
  }
  return changed;
}

function stripGrantWrap(a) {
  const prev = adjacentText(a, "prev");
  const next = adjacentText(a, "next");
  if (prev && next && OPEN_BR.test(prev.textContent) && CLOSE_BR.test(next.textContent)) {
    prev.textContent = prev.textContent.replace(OPEN_BR, "");
    next.textContent = next.textContent.replace(CLOSE_BR, "");
    return true;
  }
  if (prev && LONE_EMOJI.test(prev.textContent)) {
    prev.textContent = prev.textContent.replace(LONE_EMOJI, "");
    return true;
  }
  return false;
}

// ── Text-node passes (only outside existing links) ───────────────────────────

function textNodes(root) {
  const out = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest("a") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  while (walker.nextNode()) out.push(walker.currentNode);
  return out;
}

// Replace regex matches in a text node; `make(match)` returns [before, el, after] pieces.
function splitReplace(node, re, make) {
  const text = node.textContent;
  re.lastIndex = 0;
  let m, last = 0, hit = false;
  const frag = document.createDocumentFragment();
  while ((m = re.exec(text))) {
    const piece = make(m);
    if (!piece) continue;
    hit = true;
    frag.append(text.slice(last, m.index), ...piece);
    last = m.index + m[0].length;
  }
  if (!hit) return 0;
  frag.append(text.slice(last));
  node.replaceWith(frag);
  return 1;
}

// "<strong>ice</strong> damage": the type word alone in a wrapper, "damage" after it.
function wrappedDamageWords(root, changes) {
  for (const el of Array.from(root.querySelectorAll("strong, b, span, em"))) {
    if (el.closest("a") || el.children.length) continue;
    const word = el.textContent.trim().toLowerCase();
    const dmg = DAMAGE[word];
    if (!dmg) continue;
    const next = el.nextSibling;
    if (!next || next.nodeType !== Node.TEXT_NODE || !/^[\s ]*damage\b/i.test(next.textContent)) continue;
    const term = lookupTerm(word.replace(/^\w/, (c) => c.toUpperCase()));
    if (!term) continue;
    el.replaceWith(linkEl(term.key, term.label));
    changes.add("DMG_WORD");
  }
}

// "<strong>40 Air </strong>damage": the type word ends one text node and
// "damage" starts the next one, outside the bold.
const TRAILING_DMG = /\b(physical|air|bolt|dark|earth|fire|ice|light|poison)([\s ]*)$/i;
function splitDamageWords(root, changes) {
  for (const node of textNodes(root)) {
    const m = node.textContent.match(TRAILING_DMG);
    if (!m) continue;
    const next = adjacentText(node, "next");
    if (!next || !/^[\s ]*damage\b/i.test(next.textContent)) continue;
    const term = lookupTerm(m[1].replace(/^\w/, (c) => c.toUpperCase()).toLowerCase().replace(/^\w/, (c) => c.toUpperCase()));
    if (!term) continue;
    const head = node.textContent.slice(0, m.index);
    node.replaceWith(head, linkEl(term.key, term.label), m[2]);
    changes.add("DMG_WORD");
  }
}

// ── Converter ─────────────────────────────────────────────────────────────────

/**
 * @returns {{ html: string, changed: boolean, codes: string[], dangling: string[], review: string[] }}
 */
export function convertHtml(input, { unlinkDangling = false } = {}) {
  const src = String(input ?? "");
  // Old grant-line labels carried their emoji inside the link ("📜Defensive Mastery").
  const cleanLabel = (l) => String(l ?? "").replace(/^[p{Extended_Pictographic}️s]+/u, "").trim();
  // A link to a deleted document: left alone, or (once a person approved it)
  // reduced to its label in bold so the text still reads.
  const unlinked = (label) => { changes.add("UNLINKED"); return `<strong>${esc(cleanLabel(label))}</strong>`; };
  const changes = new Set();
  const dangling = [];
  const review = [];
  // Links whose target no longer exists but were matched to a document by
  // name — a guess, so every one is listed for a person to confirm.
  const repointed = [];
  const noteRepoint = (from, t, label) => {
    if (t.uuid && t.uuid !== from) { changes.add("REPOINTED"); repointed.push(`${label || t.name}: ${from} → ${t.uuid}`); }
  };
  let s = src;

  // 1. Text syntax → links.
  s = s.replace(UUID_RE, (m, uuid, label) => {
    const t = resolveUuid(uuid, label);
    if (!t) { dangling.push(m); return unlinkDangling && cleanLabel(label) ? unlinked(label) : m; }
    changes.add("RAW_UUID");
    noteRepoint(uuid, t, label);
    return minimalLink(t.uuid, cleanLabel(label) || t.name);
  });
  s = s.replace(TAG_RE, (m, tag, ref, label) => {
    const t = resolveTag(tag, ref, label);
    if (!t?.uuid) { dangling.push(m); return m; }
    changes.add("TAG");
    return minimalLink(t.uuid, label || t.name);
  });

  const isHtml = /<[a-z]/i.test(s);
  if (!isHtml && !changes.size) return { html: src, changed: false, codes: [], dangling, review, repointed };

  const tpl = document.createElement("template");
  tpl.innerHTML = s;
  const root = tpl.content;

  // 2. Every link → minimal; tidy legacy wrapping around it.
  for (const a of Array.from(root.querySelectorAll("a[data-uuid]"))) {
    const uuid = a.dataset.uuid;
    const label = a.textContent.replace(/\s+/g, " ").trim();
    const term = resolveUuid(uuid, label);
    if (!term) {
      dangling.push(`${label} → ${uuid}`);
      if (unlinkDangling && cleanLabel(label)) { const t = document.createElement("template"); t.innerHTML = unlinked(label); a.replaceWith(t.content); }
      continue;
    }
    noteRepoint(uuid, term, label);
    let el = a;
    const clean = linkEl(term.uuid ?? uuid, cleanLabel(label) || term.name);
    if (a.outerHTML !== clean.outerHTML) { changes.add("STYLED_LINK"); a.replaceWith(clean); el = clean; }
    if (unwrapChrome(el)) changes.add("STYLED_LINK");
    if ((REF_KINDS.has(term.kind) || term.kind === "actor") && stripGrantWrap(el)) changes.add("GRANT_WRAP");
    if (unwrapSolo(el)) changes.add("STYLED_LINK");
  }
  // Leftover link chrome: underline/font spans and bold around bare punctuation.
  for (const el of Array.from(root.querySelectorAll("span[style], strong, b"))) {
    if (el.querySelector("a, img")) continue;
    const punct = /^[\s .,;:!?()]*$/.test(el.textContent);
    if (punct && (el.tagName !== "SPAN" || isChromeSpan(el))) { el.replaceWith(...el.childNodes); changes.add("STYLED_LINK"); }
  }

  if (isHtml) {
    // 3. Unlinked damage types.
    wrappedDamageWords(root, changes);
    splitDamageWords(root, changes);
    for (const node of textNodes(root)) {
      if (splitReplace(node, DMG_WORD, (m) => {
        const term = lookupTerm(m[1].replace(/^\w/, (c) => c.toUpperCase()));
        return term ? [linkEl(term.key, term.label), m[2]] : null;
      })) changes.add("DMG_WORD");
    }
    // 4. Unlinked statuses after a verb; everything else goes to review.
    const [statusRe, reviewRe, listRe] = statusRegexes();
    for (const node of textNodes(root)) {
      if (splitReplace(node, statusRe, (m) => {
        const term = lookupTerm(m[2]);
        return term ? [m[1], linkEl(term.key, term.label)] : null;
      })) changes.add("STATUS_WORD");
    }
    // List continuation: keep linking while the text right after a status link
    // is ", Status", " and Status", " or Status".
    for (let guard = 0; guard < 20; guard++) {
      let hit = false;
      for (const node of textNodes(root)) {
        const prev = node.previousSibling;
        if (prev?.nodeName !== "A" || lookupTerm(prev.dataset?.uuid ?? "")?.category !== "status") continue;
        const m = node.textContent.match(listRe);
        const term = m && lookupTerm(m[2]);
        if (!term || term.category !== "status") continue;
        node.replaceWith(m[1], linkEl(term.key, term.label), node.textContent.slice(m[0].length));
        changes.add("STATUS_WORD");
        hit = true;
      }
      if (!hit) break;
    }
    for (const node of textNodes(root)) {
      reviewRe.lastIndex = 0;
      let m;
      while ((m = reviewRe.exec(node.textContent))) {
        const t = node.textContent;
        review.push(`…${t.slice(Math.max(0, m.index - 30), m.index)}[${m[1]}]${t.slice(m.index + m[1].length, m.index + m[1].length + 30)}…`);
      }
    }
  }

  const div = document.createElement("div");
  div.appendChild(root);
  const html = div.innerHTML;
  return { html, changed: html !== src, codes: [...changes], dangling, review, repointed };
}

// ── Set bonus: description → set_description ─────────────────────────────────
// Set bonuses belong in the piece's own Item Set section (`set_description`,
// shown under "Set bonus" on the party menu's item card), not in `description`.
// Old pieces wrote a 【Set Bonus】 block at the END of the description, as
// paragraphs or inside a bullet list. splitSetBonus cuts from the marker to the
// end and returns both halves, the moved half in the modern shape:
//   <p><strong>【Set Bonus】</strong></p><p><strong>2-Piece</strong></p><ul>…

const SET_MARK = /set\s*bonus/i;
const SET_HEADING = /^[\s 【]*set\s*bonus[\s 】:]*$/i;
const CANON_HEADING = "<p><strong>【Set Bonus】</strong></p>";

const plainOf = (html) => {
  const t = document.createElement("template");
  t.innerHTML = String(html ?? "");
  return (t.content.textContent ?? "").replace(/[\s ]+/g, " ").trim();
};

function isEmptyBlock(n) {
  if (n.nodeType === Node.TEXT_NODE) return !n.textContent.replace(/[\s ]/g, "");
  if (n.nodeType !== Node.ELEMENT_NODE) return true;
  if (n.tagName === "HR" || n.tagName === "BR") return true;
  return !n.textContent.replace(/[\s ]/g, "") && !n.querySelector("img");
}
function trimEdges(root) {
  while (root.lastChild && isEmptyBlock(root.lastChild)) root.lastChild.remove();
  while (root.firstChild && isEmptyBlock(root.firstChild)) root.firstChild.remove();
  // A list item left ending in a separator.
  const lastLi = root.lastElementChild?.matches?.("ul,ol") ? root.lastElementChild.lastElementChild : null;
  while (lastLi?.lastChild && (lastLi.lastChild.nodeName === "HR" || isEmptyBlock(lastLi.lastChild) && lastLi.lastChild.nodeType === Node.TEXT_NODE)) lastLi.lastChild.remove();
}

function serialize(frag) {
  const d = document.createElement("div");
  d.appendChild(frag);
  return d.innerHTML.trim();
}

export function splitSetBonus(html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = String(html ?? "");
  const root = tpl.content;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let mark = null;
  while (walker.nextNode()) if (SET_MARK.test(walker.currentNode.textContent)) { mark = walker.currentNode; break; }
  if (!mark) return null;

  // Split every list between the marker and the top level, so the marker's
  // item and everything after it leave together.
  let top = mark;
  while (top.parentNode !== root) {
    const parent = top.parentNode;
    if ((parent.nodeName === "UL" || parent.nodeName === "OL") && top.previousSibling) {
      const tail = parent.cloneNode(false);
      let n = top;
      while (n) { const next = n.nextSibling; tail.appendChild(n); n = next; }
      parent.after(tail);
      top = tail;
      continue;
    }
    top = parent;
  }
  const moved = document.createDocumentFragment();
  let n = top;
  while (n) { const next = n.nextSibling; moved.appendChild(n); n = next; }

  // Lift the block out of list wrappers: a list whose first item holds the
  // marker is the old "set bonus as a bullet" shape.
  for (let guard = 0; guard < 6; guard++) {
    const first = moved.firstElementChild;
    if (!first || !(first.matches("ul,ol")) || !SET_MARK.test(first.firstElementChild?.textContent ?? "")) break;
    const parts = [];
    for (const li of Array.from(first.children)) parts.push(...li.childNodes);
    first.replaceWith(...parts);
  }
  // One canonical heading.
  for (const el of Array.from(moved.querySelectorAll("p, li, ul, ol, strong, b, h1, h2, h3, h4"))) {
    if (!SET_HEADING.test(el.textContent)) continue;
    let block = el;
    while (block.parentNode && block.parentNode !== moved && SET_HEADING.test(block.parentNode.textContent)) block = block.parentNode;
    const h = document.createElement("template");
    h.innerHTML = CANON_HEADING;
    block.replaceWith(h.content);
    break;
  }
  trimEdges(root);
  trimEdges(moved);
  return { keep: serialize(root), moved: serialize(moved) };
}

/** What the Item Set rules change on one item's props: { field: newValue }, plus codes. */
function setSectionOps(item) {
  const p = item.system?.props ?? {};
  const ops = {};
  const codes = {};
  const isDef = p.set_bonus_table && Object.keys(p.set_bonus_table).length;
  if (SET_MARK.test(p.description ?? "") && !isDef) {
    const sp = splitSetBonus(p.description);
    const isPassiveCopy = /\(Passive\)\s*$/.test(item.name) || String(p.skill_type ?? "").toLowerCase() === "passive";
    // A 【Set Bonus】 block is set text whatever the piece's flags say: older
    // copies on actors predate `isSet` and never got the key.
    if (sp && !isPassiveCopy) {
      ops.description = sp.keep;
      codes.description = "SET_MOVED";
      if (!plainOf(p.set_description)) { ops.set_description = sp.moved; codes.set_description = "SET_MOVED"; }
    } else if (sp && isPassiveCopy) {
      // A contained passive mirrors its parent's EFFECT only.
      ops.description = sp.keep;
      codes.description = "SET_MOVED";
      if (SET_MARK.test(p.skill_description ?? "")) {
        const sk = splitSetBonus(p.skill_description);
        if (sk) { ops.skill_description = sk.keep; codes.skill_description = "SET_MOVED"; }
      }
    }
  }
  // Non-set gear carries no set fields: clear the cloned "【Set Bonus】" placeholder.
  if (!p.isSet && !isDef && typeof p.set_description === "string" && p.set_description
      && (!plainOf(p.set_description) || SET_HEADING.test(plainOf(p.set_description)))) {
    ops.set_description = "";
    codes.set_description = "SET_PLACEHOLDER";
  }
  return { ops, codes };
}

// ── World runner ──────────────────────────────────────────────────────────────

const SKIP_KEY = /(^|_)script$|^script|macro|_logic_|custom_logic|_js$|^code$|formula|target_filter|^img$|^uuid$|^id$/i;

function* stringFields(obj, path = "") {
  if (typeof obj === "string") { yield [path, obj]; return; }
  if (!obj || typeof obj !== "object") return;
  for (const [k, v] of Object.entries(obj)) {
    if (SKIP_KEY.test(k)) continue;
    yield* stringFields(v, path ? `${path}.${k}` : k);
  }
}

// Plain text and link labels, for a report a person can read.
function summarize(html) {
  const t = document.createElement("template");
  t.innerHTML = html;
  const links = Array.from(t.content.querySelectorAll("a[data-uuid]")).map((a) => a.textContent.trim());
  t.content.querySelectorAll("p,li,div,br,tr").forEach((el) => el.after(" "));
  return { text: (t.content.textContent ?? "").replace(/\s+/g, " ").trim(), links };
}

function itemChanges(item, opts) {
  const update = {};
  const old = {};
  const rows = [];
  const set = setSectionOps(item);
  // set_description may not exist yet on older pieces: visit it anyway.
  const fields = [...stringFields(item.system?.props ?? {})];
  for (const key of Object.keys(set.ops)) if (!fields.some(([p]) => p === key)) fields.push([key, ""]);
  for (const [path, orig] of fields) {
    const setCode = set.codes[path];
    const value = path in set.ops ? set.ops[path] : orig;
    const r = /[<@]/.test(value)
      ? convertHtml(value, opts)
      : { html: value, changed: false, codes: [], dangling: [], review: [], repointed: [] };
    const final = r.html;
    if (final !== orig) { update[`system.props.${path}`] = final; old[`system.props.${path}`] = orig; }
    const codes = setCode ? [setCode, ...r.codes] : r.codes;
    if (final === orig && !r.dangling.length && !r.review.length) continue; // nothing to report
    const b = summarize(orig), a = summarize(final);
    const before = [...b.links];
    const added = a.links.filter((l) => { const i = before.indexOf(l); if (i < 0) return true; before.splice(i, 1); return false; });
    rows.push({
      field: path, codes, dangling: r.dangling, review: r.review, repointed: r.repointed, added,
      textBefore: b.text, textAfter: a.text, bytesBefore: orig.length, bytesAfter: final.length,
    });
  }
  return { update, old, rows };
}

/** Every item the conversion covers, grouped by the parent that saves it. */
async function collectTargets() {
  const groups = [];
  groups.push({ where: "World items", parent: null, items: game.items.filter((i) => !String(i.type).startsWith("_")) });
  for (const actor of game.actors) groups.push({ where: `Actor: ${actor.name}`, parent: actor, items: [...actor.items] });
  for (const pack of game.packs.filter((p) => p.metadata.packageType === "world" && ["Item", "Actor"].includes(p.documentName))) {
    const docs = await pack.getDocuments();
    if (pack.documentName === "Item") groups.push({ where: `Compendium: ${pack.title}`, pack, parent: null, items: docs });
    else for (const a of docs) groups.push({ where: `Compendium: ${pack.title} › ${a.name}`, pack, parent: a, items: [...a.items] });
  }
  for (const scene of game.scenes) {
    for (const tok of scene.tokens) {
      if (tok.actorLink || !tok.delta?.items?.size) continue;
      const ids = new Set(tok.delta.items.map((i) => i.id));
      groups.push({ where: `Token: ${scene.name} › ${tok.name}`, parent: tok.actor, items: tok.actor.items.filter((i) => ids.has(i.id)) });
    }
  }
  return groups;
}

async function writeGroup({ parent, pack }, updates) {
  const relock = pack?.locked;
  if (relock) await pack.configure({ locked: false });
  try {
    if (parent) await parent.updateEmbeddedDocuments("Item", updates, { diff: true, render: false });
    else await Item.implementation.updateDocuments(updates, { ...(pack ? { pack: pack.collection } : {}), render: false });
  } finally {
    if (relock) await pack.configure({ locked: true });
  }
}

/**
 * Dry run (default) returns the report. With { dryRun: false } it also writes,
 * one batched update per parent (world items in one call, each actor in one),
 * and returns `backup` — every original value — for restoreBackup().
 */
export async function convertWorld({ dryRun = true, unlinkDangling = false } = {}) {
  const groups = await collectTargets();
  const report = [];
  const backup = [];
  let docs = 0, fields = 0;
  for (const g of groups) {
    const updates = [];
    for (const item of g.items) {
      const { update, old, rows } = itemChanges(item, { unlinkDangling });
      if (rows.length) report.push({ where: g.where, item: item.name, id: item.id, rows });
      const n = Object.keys(update).length;
      if (!n) continue;
      updates.push({ _id: item.id, ...update });
      backup.push({ where: g.where, parentUuid: g.parent?.uuid ?? null, pack: g.pack?.collection ?? null, id: item.id, name: item.name, old });
      docs++; fields += n;
    }
    if (!dryRun && updates.length) await writeGroup(g, updates);
  }
  return { dryRun, docs, fields, groups: groups.length, report, ...(dryRun ? {} : { backup }) };
}

/** Put back every value a convertWorld write changed. */
export async function restoreBackup(backup) {
  const byParent = new Map();
  for (const b of backup ?? []) {
    const key = `${b.parentUuid ?? ""}|${b.pack ?? ""}`;
    if (!byParent.has(key)) byParent.set(key, { parentUuid: b.parentUuid, pack: b.pack, updates: [] });
    byParent.get(key).updates.push({ _id: b.id, ...b.old });
  }
  let n = 0;
  for (const { parentUuid, pack, updates } of byParent.values()) {
    const parent = parentUuid ? await fromUuid(parentUuid) : null;
    await writeGroup({ parent, pack: pack ? game.packs.get(pack) : null }, updates);
    n += updates.length;
  }
  return n;
}

/** Lint: what the converter would change, plus dangling links. Never writes. */
export async function runLinkedTextLint() {
  const { report } = await convertWorld({ dryRun: true });
  const findings = [];
  for (const r of report) {
    for (const row of r.rows) {
      const location = `${r.where} › ${r.item} › ${row.field}`;
      for (const code of row.codes) findings.push({ severity: code === "RAW_UUID" ? "warning" : "info", code: `LT_${code}`, location });
      for (const d of row.dangling) findings.push({ severity: "warning", code: "LT_DANGLING", location, message: d });
    }
  }
  const byCode = {};
  for (const f of findings) byCode[f.code] = (byCode[f.code] ?? 0) + 1;
  return { findings, summary: { total: findings.length, byCode } };
}
