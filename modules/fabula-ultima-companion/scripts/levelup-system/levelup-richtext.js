/**
 * Rich description rendering for the level-up window.
 *
 * Skill and Facet descriptions are authored prose full of mechanical terms —
 * 【Attack】, Slow, Bleed, Unleash — which the world already has a vocabulary
 * for. The Battle Director's Action Card renders those as bold, underlined
 * terms with a small icon prefix, and this reuses the same source of truth
 * (`keyword-registry.js`, 70 terms) so a Dance reads the same in the level-up
 * picker as it does mid-combat.
 *
 * What this deliberately does NOT do is import the Action Card itself. That
 * module is ~7k lines of combat rendering and its parser is private; only the
 * registry is shared, which is the part that actually matters for consistency.
 *
 * Unlike the card, terms here are NOT clickable — there is no tooltip layer in
 * this window, and a chip that looks interactive but does nothing is worse than
 * one that plainly reads as emphasis.
 */

import { lookupTerm } from "../battle-director/keyword-registry.js";

// Structural tags worth keeping. Everything else is unwrapped to its text so
// authored sheet markup (font tags, spans full of inline styles) cannot drag
// its own typography into this window.
//
// SPAN and DIV are deliberately absent: authored descriptions wrap links in
// layers of styling spans, and once their attributes are stripped those become
// empty nesting around every term. They are unwrapped unless they are one of
// the term elements this module built.
// Headings and tables matter for the long-form Unique Mechanic text, which is
// authored as a document ("<h1>THE ARCANA</h1><h2>MERGING…"). Dropping them
// unwrapped every heading into a bare run of text butted against the next
// paragraph, which is what made that tab look like flattened HTML.
const KEEP = new Set([
  "P", "BR", "UL", "OL", "LI", "STRONG", "B", "EM", "I", "U", "HR",
  "H1", "H2", "H3", "H4", "H5", "H6",
  "TABLE", "THEAD", "TBODY", "TR", "TD", "TH",
]);
const DROP = new Set(["SCRIPT", "IFRAME", "OBJECT", "EMBED", "STYLE", "LINK", "IMG"]);

// Elements this module generated, which must survive the scrub that removes
// authored images and unwraps authored spans.
const isOurs = (el) =>
  el.classList?.contains("lu-kw") ||
  el.classList?.contains("lu-kw-label") ||
  el.classList?.contains("lu-kw-icon");

const esc = (s) => String(s ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

// Only allow image sources the sheet itself would serve.
const safeImg = (url) => {
  const s = String(url ?? "").trim();
  return /^(https?:|data:image\/|icons\/|modules\/|systems\/|worlds\/|assets\/)/i.test(s) ? s : "";
};

const iconHTML = (icon, cls) => {
  const safe = safeImg(icon);
  return safe ? `<img class="${cls}" src="${esc(safe)}" alt="">` : "";
};

const termHTML = ({ label, icon, kind }) =>
  `<span class="lu-kw is-${kind}">${iconHTML(icon, "lu-kw-icon")}<span class="lu-kw-label">${esc(label)}</span></span>`;

/**
 * Turn an authored description into safe display HTML plus the Action Keywords
 * it declares.
 *
 * Keywords are lifted OUT of the prose into their own row — they are usually
 * authored as a leading bullet list, which reads as noise inline. Statuses stay
 * where they are, since they appear mid-sentence ("they immediately suffer
 * Slow") and moving them would break the sentence.
 *
 * @returns {{ keywords: object[], bodyHtml: string, text: string }}
 */
export function renderDescription(html) {
  const empty = { keywords: [], bodyHtml: "", text: "" };
  if (!html) return empty;

  try {
    const root = document.createElement("div");
    root.innerHTML = String(html);

    const keywords = [];
    const seen = new Set();

    const resolved = Array.from(root.querySelectorAll("a[data-uuid], a.content-link")).map((a) => {
      const uuid = a.getAttribute("data-uuid") || "";
      const text = (a.textContent || "").trim();
      const entry = lookupTerm(uuid) || lookupTerm(text);
      // The link's own text wins — "Ice Shield" and "Fire Shield" share the
      // base Shield journal uuid, and the registry label would flatten both.
      return { a, text, entry, label: text || entry?.label || "" };
    });

    /*
     * Only a keyword that IS the line gets lifted to the row at the top.
     *
     * "Chain 3" on its own bullet is a tag for the whole skill and belongs up
     * there. "…with a Melee Weapon you have equipped" is a word in a sentence,
     * and lifting it left the reader with "with a Weapon" — a real rules
     * change, not just a cosmetic one.
     *
     * The test is per block: strip every keyword's own text and see whether any
     * actual words are left. "Chain 3" leaves "3"; a sentence leaves prose.
     */
    const BLOCKS = "li, p, h1, h2, h3, h4, h5, h6, td, th";
    const byBlock = new Map();
    for (const r of resolved) {
      if (r.entry?.kind !== "keyword") continue;
      const block = r.a.closest(BLOCKS) ?? root;
      if (!byBlock.has(block)) byBlock.set(block, []);
      byBlock.get(block).push(r);
    }
    const tagLines = new Set();
    const leftover = new Map();
    for (const [block, list] of byBlock) {
      let rest = block.textContent || "";
      for (const r of list) rest = rest.replace(r.text, " ");
      if (!/[A-Za-z]{2,}/.test(rest)) {
        tagLines.add(block);
        leftover.set(block, rest.replace(/ /g, " ").trim());
      }
    }

    for (const { a, text, entry, label } of resolved) {
      if (entry?.kind === "keyword") {
        const standalone = tagLines.has(a.closest(BLOCKS) ?? root);
        if (!standalone) {
          // Keep it where the sentence needs it, still badged.
          const holder = document.createElement("span");
          holder.innerHTML = termHTML({ label, icon: entry.icon ?? null, kind: "keyword" });
          a.replaceWith(holder.firstElementChild ?? document.createTextNode(text));
          continue;
        }
        // "Chain 3" is one keyword with a count, not a keyword and a stray 3.
        // Lifting only the word stranded the number as its own bullet. The
        // qualifier is kept verbatim so "Backstab (10)" keeps its value and its
        // brackets rather than being flattened to "Backstab".
        const block = a.closest(BLOCKS) ?? root;
        const rest = leftover.get(block) ?? "";
        const full = (byBlock.get(block)?.length === 1 && /^[([]?[+-]?\d+[)\]]?$/.test(rest))
          ? `${label} ${rest}` : label;

        if (!seen.has(full.toLowerCase())) {
          seen.add(full.toLowerCase());
          keywords.push({ label: full, icon: entry.icon ?? null, kind: "keyword" });
        }
        a.remove();
        continue;
      }
      if (entry?.kind === "status") {
        const holder = document.createElement("span");
        holder.innerHTML = termHTML({ label, icon: entry.icon ?? null, kind: "status" });
        a.replaceWith(holder.firstElementChild ?? document.createTextNode(text));
        continue;
      }
      a.replaceWith(document.createTextNode(text));   // dead link → plain text
    }

    // A tag line's whole point was the keywords now shown above, so drop what
    // is left of it — otherwise the counts and separators linger as a bullet.
    // Test parentNode, NOT isConnected: this tree is a detached div, so
    // isConnected is false for every node in it and the cleanup never ran.
    for (const block of tagLines) if (block !== root && block.parentNode) block.remove();

    // Scrub: drop dangerous nodes, unwrap unknown ones, and strip authored
    // styling so this window's CSS is the only thing deciding how it looks.
    for (const el of Array.from(root.querySelectorAll("*"))) {
      if (isOurs(el)) continue;                                   // built above, already clean
      if (DROP.has(el.tagName)) { el.remove(); continue; }         // authored images and worse
      if (!KEEP.has(el.tagName)) { el.replaceWith(...el.childNodes); continue; }
      for (const attr of Array.from(el.attributes)) el.removeAttribute(attr.name);
    }

    // A keyword list emptied by the extraction above would otherwise leave a
    // stray bullet at the top of the prose.
    for (const li of Array.from(root.querySelectorAll("li"))) {
      if (!li.textContent.trim() && !li.querySelector("img")) li.remove();
    }
    for (const list of Array.from(root.querySelectorAll("ul, ol"))) {
      if (!list.querySelector("li")) list.remove();
    }
    // Authored documents are full of empty spacer paragraphs between headings;
    // with real heading margins they become double gaps.
    for (const p of Array.from(root.querySelectorAll("p"))) {
      if (!p.textContent.trim() && !p.querySelector("img, br")) p.remove();
    }

    return {
      keywords,
      bodyHtml: root.innerHTML.trim(),
      text: (root.textContent || "").replace(/\s+/g, " ").trim(),
    };
  } catch (e) {
    console.warn("[ONI][LevelUp] renderDescription failed — falling back to text", e);
    const d = document.createElement("div");
    d.innerHTML = String(html);
    const text = (d.textContent || "").replace(/\s+/g, " ").trim();
    return { keywords: [], bodyHtml: esc(text), text };
  }
}

/** Keyword row markup, or "" when the description declares none. */
export const keywordRowHTML = (keywords) =>
  keywords?.length ? `<div class="lu-kwrow">${keywords.map(termHTML).join("")}</div>` : "";

/** Shared stylesheet fragment, injected by the window alongside its own CSS. */
export const RICHTEXT_CSS = (scope) => `
${scope} .lu-kwrow { display: flex; flex-wrap: wrap; gap: 4px 10px; margin: 2px 0 4px; }
${scope} .lu-kw { display: inline-flex; align-items: center; gap: 3px; vertical-align: baseline; }
/* Scoped through .lu-kw so this outranks any row-level descendant img rule.
   A selector like #id .row img scores (1,1,1) and would otherwise win over
   (1,1,0) — exactly what blew these glyphs up to row-icon size once already. */
${scope} .lu-kw > .lu-kw-icon { width: 1.05em; height: 1.05em; object-fit: contain;
  border: 0 !important; outline: 0 !important; border-radius: 0; background: none;
  flex: 0 0 auto; vertical-align: -0.15em; }
${scope} .lu-kw-label { font-weight: 700; text-decoration: underline; text-underline-offset: 2px; }
${scope} .lu-kw.is-keyword { color: #8a5a12; }
${scope} .lu-kw.is-keyword .lu-kw-label { text-transform: uppercase; letter-spacing: .03em; font-size: .92em; }
${scope} .lu-kw.is-status { color: inherit; }
${scope} .lu-rt p { margin: 0 0 4px; }
${scope} .lu-rt p:last-child { margin-bottom: 0; }
${scope} .lu-rt ul, ${scope} .lu-rt ol { margin: 2px 0 4px; padding-left: 16px; }
${scope} .lu-rt li { margin: 1px 0; }
${scope} .lu-rt hr { border: 0; border-top: 1px dashed rgba(90,70,40,.35); margin: 5px 0; }
${scope} .lu-rt strong, ${scope} .lu-rt b { font-weight: 700; }
/* Long-form authored documents (the Unique Mechanic) — headings and tables. */
${scope} .lu-rt h1, ${scope} .lu-rt h2, ${scope} .lu-rt h3,
${scope} .lu-rt h4, ${scope} .lu-rt h5, ${scope} .lu-rt h6 {
  margin: 10px 0 4px; line-height: 1.2; font-weight: 800; color: #5c1f2e;
  border: 0; letter-spacing: .02em; }
${scope} .lu-rt h1 { font-size: 1.35em; border-bottom: 2px solid #c0a67c; padding-bottom: 2px; }
${scope} .lu-rt h2 { font-size: 1.18em; }
${scope} .lu-rt h3, ${scope} .lu-rt h4 { font-size: 1.05em; color: #7a4a1e; }
${scope} .lu-rt h5, ${scope} .lu-rt h6 { font-size: 1em; color: #7a4a1e; }
${scope} .lu-rt > :first-child { margin-top: 0; }
${scope} .lu-rt table { width: 100%; border-collapse: collapse; margin: 6px 0; font-size: .95em; }
${scope} .lu-rt th, ${scope} .lu-rt td { border: 1px solid #c0a67c; padding: 3px 6px; text-align: left; }
${scope} .lu-rt th { background: #e6dabd; font-weight: 700; }
`;
