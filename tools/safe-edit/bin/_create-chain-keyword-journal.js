// The new "Chain" keyword gets its journal entry (user, 2026-10-29).
//
// keyword-registry.js already knows Chain under the id ChnStrikeKeyw0rd, so the
// Action Card chip and its tooltip work, but item text cannot link a journal
// that does not exist. This creates it, shaped like its sibling Combo
// (JournalEntry.noUOPxPoZq65yYxV, the original Chain): same folder, same
// ownership, one "Description" text page with the icon over the rules text.
// The page text is the registry's DESC for ChnStrikeKeyw0rd, so the tooltip
// and the journal read the same.
//
// It also lists Chain next to Combo in the Keyword Repository journal
// (U16BWkb0eRaemBB0) — the "Link Format" page authors copy links from, and the
// "Backup" page the registry was harvested from.
//
// Run from tools/safe-edit, game CLOSED; --apply to write. Idempotent: a second
// run reports 0 writes.
const { openCollection } = require("../lib/db");
const { run } = require("./_fafnir-util");

const COMBO = "noUOPxPoZq65yYxV";
const CHAIN = "ChnStrikeKeyw0rd";
const CHAIN_PAGE = "ChnStrikeDescPg1";
const REPO = "U16BWkb0eRaemBB0";
const REPO_LINKS = "eG60AThOGaOjv4Lt";
const REPO_BACKUP = "Wnhni42OXRQdSE7U";
const GM = "JQGNzKpDPHJmcUIW";
const ICON = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/FFXIVIcons%20Battle(PvE)/09_NIN/dream_within_a_dream.png";

// Both Chains under one keyword (user, 2026-10-29): the default is one roll
// shown as x hits; Separate / Random / Pick roll each hit.
const RULES = "<ul>"
  + "<li><p>This action lands <strong>x</strong> hits on one Action Card. It makes one Accuracy Check and deals its damage once, shared out across the hits.</p></li>"
  + "<li><p><strong>Chain (x) Separate</strong>: each hit makes its own Accuracy Check and deals its own damage. The action's own effects apply on every hit that lands, and a creature reduced to 0 HP loses the hits still aimed at it. Each hit can be a critical success, but the action grants at most one Opportunity.</p></li>"
  + "<li><p><strong>Chain (x) Random</strong> and <strong>Chain (x) Pick</strong> are separate hits: each on a random target, or shared out over the picked targets in the order they were picked.</p></li>"
  + "<li><p>Other creatures' effects treat a Chain as one action: a creature is hit if any hit landed on it, and missed only if every hit missed.</p></li>"
  + "</ul>";

async function readJournal() {
  const db = await openCollection("journal");
  const out = new Map();
  try {
    for await (const [key, doc] of db.iterator()) out.set(key, doc);
  } finally { await db.close(); }
  return out;
}

async function readFolderName(id) {
  const db = await openCollection("folders");
  try { return (await db.get(`!folders!${id}`))?.name ?? null; }
  catch { return null; }
  finally { await db.close(); }
}

// Insert `addition` right after the first `afterRx` match; null if the anchor is missing.
function insertAfter(content, afterRx, addition) {
  const m = afterRx.exec(content);
  if (!m) return null;
  const at = m.index + m[0].length;
  return content.slice(0, at) + addition + content.slice(at);
}

run(async ({ changes }) => {
  const docs = await readJournal();
  const combo = docs.get(`!journal!${COMBO}`);
  const comboPage = combo && docs.get(`!journal.pages!${COMBO}.${combo.pages?.[0]}`);
  if (!combo || !comboPage) throw new Error("Combo journal (the shape donor) not found");
  console.log(`folder ${combo.folder}: "${await readFolderName(combo.folder)}"`);

  const now = Date.now();
  if (!docs.has(`!journal!${CHAIN}`)) {
    const entry = JSON.parse(JSON.stringify(combo));
    Object.assign(entry, { _id: CHAIN, name: "Chain", pages: [CHAIN_PAGE], sort: 0, flags: {} });
    entry._stats = { ...entry._stats, createdTime: now, modifiedTime: now, lastModifiedBy: GM, compendiumSource: null, duplicateSource: null };
    changes.push([`!journal!${CHAIN}`, entry, `new JournalEntry "Chain" (folder ${entry.folder}, ownership ${JSON.stringify(entry.ownership)})`]);
  }
  // The page: created once, its text kept equal to RULES on every re-run.
  const pageKey = `!journal.pages!${CHAIN}.${CHAIN_PAGE}`;
  const wantText = `<p><img class=" centered" src="${ICON}" width="21" height="21" /></p>\n<hr />\n${RULES}`;
  const pageNow = docs.get(pageKey);
  if (!pageNow) {
    const page = JSON.parse(JSON.stringify(comboPage));
    Object.assign(page, { _id: CHAIN_PAGE, name: "Description", flags: {} });
    page.text = { ...page.text, content: wantText };
    page._stats = { ...page._stats, createdTime: now, modifiedTime: now, lastModifiedBy: GM, compendiumSource: null, duplicateSource: null };
    changes.push([pageKey, page, `its "Description" page (${page.text.content.length} chars)`]);
  } else if (pageNow.text?.content !== wantText) {
    const page = JSON.parse(JSON.stringify(pageNow));
    page.text = { ...page.text, content: wantText };
    page._stats = { ...page._stats, modifiedTime: now, lastModifiedBy: GM };
    changes.push([pageKey, page, `its "Description" page text brought up to date (${wantText.length} chars)`]);
  }

  // Keyword Repository: list Chain right after Combo on both link pages.
  const repoEdits = [
    [REPO_LINKS, /@UUID\[JournalEntry\.noUOPxPoZq65yYxV\]\{Combo\}/, `<br />@UUID[JournalEntry.${CHAIN}]{Chain}`],
    [REPO_BACKUP, /<p>[^<]*<img[^>]*\/>\s*@UUID\[JournalEntry\.noUOPxPoZq65yYxV\]\{Combo\}<\/p>/,
      `\n<p><img src="${ICON}" width="21" height="21" />@UUID[JournalEntry.${CHAIN}]{Chain}</p>`],
  ];
  for (const [pageId, anchor, addition] of repoEdits) {
    const key = `!journal.pages!${REPO}.${pageId}`;
    const page = docs.get(key);
    if (!page) throw new Error(`Keyword Repository page ${pageId} not found`);
    const content = page.text?.content ?? "";
    if (content.includes(`JournalEntry.${CHAIN}`)) continue;
    const next = insertAfter(content, anchor, addition);
    if (next == null) throw new Error(`no Combo link to anchor on in Keyword Repository page "${page.name}"`);
    const doc = JSON.parse(JSON.stringify(page));
    doc.text.content = next;
    doc._stats = { ...doc._stats, modifiedTime: now, lastModifiedBy: GM };
    changes.push([key, doc, `Keyword Repository / ${page.name}: Chain listed after Combo`]);
  }
}, "chain keyword: create JournalEntry.ChnStrikeKeyw0rd + list it in the Keyword Repository", "journal")
  .catch((e) => { console.error(e); process.exitCode = 1; });
