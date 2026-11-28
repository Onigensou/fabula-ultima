// Keyword value absorption — pulls a keyword's number into its chip.
//
// Descriptions author numbered keywords with the number OUTSIDE the content
// link, usually in its own bold run:
//
//   <li><p><a …>Chain</a><strong>&nbsp;2</strong><strong>&nbsp;Pick</strong></p></li>
//   <p><a …>Chain</a> 3: call down three bolts…</p>
//
// The Effect parser lifts the link into the keyword row, which used to leave
// the number behind as an orphan bullet ("• 2 Pick") or a sentence starting
// "3: call down…". The card-game read is one chip: CHAIN 2.
//
// Two shapes are absorbed, and only these two:
//   1. value-only  — the rest of the keyword's block (its <li>/<p>) is just a
//      number, optionally a mode word (Pick/Random/Seek) and a , . or ;
//      → the number joins the label; the whole tail is deleted. The mode word
//      is dropped: the card subtitle already says "Chain ×2 (Pick)".
//   2. lead-in     — the keyword opens its block and is followed by "N:" and
//      prose → the number joins the label; "N: " is deleted and the prose's
//      first letter is capitalised ("Call down three bolts…").
// Anything else (a keyword mid-sentence: "…the Multi 3, its damage…") is left
// exactly as before. Pure DOM, no Foundry imports, so it is testable in any
// browser page.

const VALUE_ONLY = /^\s*(\d+)(?:\s+(?:pick|random|seek))?\s*[,.;]?\s*$/i;
const VALUE_LEAD = /^(\s*(\d+)\s*[:：]\s*)(?=\S)/;

// The anchor's block: nearest <li>/<p> inside `root`, else `root` itself.
function blockOf(anchor, root) {
  const block = anchor.parentElement?.closest?.("li, p") ?? null;
  return block && root.contains(block) ? block : root;
}

// Text nodes inside `block` that come after `anchor` (not inside it), in order.
function textNodesAfter(anchor, block) {
  const doc = anchor.ownerDocument;
  const walker = doc.createTreeWalker(block, 4 /* NodeFilter.SHOW_TEXT */);
  const out = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (anchor.contains(n)) continue;
    if (anchor.compareDocumentPosition(n) & 4 /* DOCUMENT_POSITION_FOLLOWING */) out.push(n);
  }
  return out;
}

// Remove the first `count` characters of text that follows `anchor`, then
// capitalise the first letter of what remains.
function consumeLeadIn(anchor, block, count) {
  const nodes = textNodesAfter(anchor, block);
  let left = count;
  for (const n of nodes) {
    if (left <= 0) break;
    const take = Math.min(left, n.data.length);
    n.data = n.data.slice(take);
    left -= take;
  }
  for (const n of nodes) {
    const i = n.data.search(/\S/);
    if (i < 0) continue;
    n.data = n.data.slice(0, i) + n.data.charAt(i).toUpperCase() + n.data.slice(i + 1);
    break;
  }
}

// Some links carry the number in their own text as "Multi (2)" — same chip
// format as the absorbed case: "Multi 2".
export function normalizeKeywordLabel(label) {
  return String(label ?? "").replace(/\s*\((\d+)\)\s*$/, " $1");
}

// Returns the absorbed number as a string ("2"), or null when the text after
// the keyword is not one of the two shapes above (DOM left untouched).
// Call BEFORE removing the anchor — it reads the anchor's position.
export function absorbKeywordValue(anchor, root) {
  try {
    const doc = anchor.ownerDocument;
    const block = blockOf(anchor, root);

    const after = doc.createRange();
    after.setStartAfter(anchor);
    after.setEnd(block, block.childNodes.length);
    const tail = after.toString();

    const only = VALUE_ONLY.exec(tail);
    if (only) {
      after.deleteContents();
      return only[1];
    }

    const lead = VALUE_LEAD.exec(tail);
    if (lead) {
      const before = doc.createRange();
      before.setStart(block, 0);
      before.setEndBefore(anchor);
      if (before.toString().trim()) return null;   // mid-sentence — leave it
      consumeLeadIn(anchor, block, lead[1].length);
      return lead[2];
    }
    return null;
  } catch {
    return null;
  }
}

// Keyword + Item link lead-in — "Transform 【Zarg's Bow - Light】" authored as
//
//   <p><a …JournalEntry…>Transform</a>&nbsp;<a …Item…>Zarg's Bow - Light</a></p>
//
// The keyword opens its block and the rest of the block is ONLY Item links
// (whitespace / nbsp / commas between them). The Item text joins the keyword
// row as the chip's detail ("◆ TRANSFORM 【Zarg's Bow - Light】") and the tail
// is deleted, so the prose doesn't repeat the line (user 2026-11-28).
// Returns the detail text, or null (DOM left untouched) for any other shape.
// Call BEFORE removing the anchor — it reads the anchor's position.
const isItemLink = (el) => {
  if (!el || el.nodeType !== 1 || el.tagName !== "A") return false;
  const uuid = el.getAttribute("data-uuid") || "";
  return el.getAttribute("data-type") === "Item" || /(^|\.)Item\.[^.]+$/.test(uuid);
};

export function absorbKeywordLinkTail(anchor, root) {
  try {
    const doc = anchor.ownerDocument;
    const block = blockOf(anchor, root);

    const before = doc.createRange();
    before.setStart(block, 0);
    before.setEndBefore(anchor);
    if (before.toString().trim()) return null;   // not the block's opener

    const links = Array.from(block.querySelectorAll("a")).filter((a) =>
      a !== anchor && (anchor.compareDocumentPosition(a) & 4 /* FOLLOWING */));
    if (!links.length || !links.every(isItemLink)) return null;

    const after = doc.createRange();
    after.setStartAfter(anchor);
    after.setEnd(block, block.childNodes.length);
    let rest = after.toString();
    const names = [];
    for (const a of links) {
      const text = (a.textContent || "").replace(/[\s ]+/g, " ").trim();
      if (!text) return null;
      names.push(text);
      rest = rest.replace(a.textContent || "", " ");
    }
    if (rest.replace(/[\s ,]/g, "")) return null;   // other words → real prose

    after.deleteContents();
    return names.join(", ");
  } catch {
    return null;
  }
}
