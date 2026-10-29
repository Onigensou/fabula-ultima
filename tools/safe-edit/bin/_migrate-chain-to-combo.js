// The original "Chain" keyword becomes "Combo" (user, 2026-10-29).
//
// "Chain" now names the Battle Director's one-card multi-strike keyword
// (`chain N` in action_keywords — chain-plan.js). The OLD Chain ("perform the
// action N times, any targets") was never engine-read: it lives only as a
// content link to JournalEntry.noUOPxPoZq65yYxV inside rich text, plus that
// journal itself. Its behaviour comes from data authored on each item
// (free_action chain rows, multiAttackGrant, chain_repeat, marker AEs), which
// this script does not touch. So the rename is a TEXT rename:
//
//   <a … data-uuid="JournalEntry.noUOPxPoZq65yYxV" …>Chain</a>  → …>Combo</a>
//   @UUID[JournalEntry.noUOPxPoZq65yYxV]{Chain}                   → {Combo}
//
// in EVERY string field of every document — item descriptions, the actor
// sheet mirrors (attack_list / skill_active_list / class_facet / … each keep
// their own copy — see feedback_action_text_voice), embedded AE descriptions,
// actor special/shop/loot text. Item NAMES are never touched ("Chain Fireball"
// keeps its name), nor plain-text "Chain" outside a link to that journal.
// The journal itself: its name "Chain" → "Combo", and the keyword word in its
// page text.
//
// Run from tools/safe-edit, game CLOSED; --apply to write. Idempotent: a second
// run reports 0 changes.
const { openCollection } = require("../lib/db");
const { run } = require("./_fafnir-util");

const OLD = "noUOPxPoZq65yYxV";
// A content link to the old journal: keep every attribute and any leading
// inline tag (Foundry puts an <i> icon inside the anchor), rename the word.
const LINK_RX = new RegExp(`(<a\\b[^>]*JournalEntry\\.${OLD}[^>]*>(?:<[^>]+>)*\\s*)Chain\\b`, "g");
const ENRICHER_RX = new RegExp(`(@UUID\\[JournalEntry\\.${OLD}\\]\\{\\s*)Chain(\\s*\\})`, "g");

function renameIn(str) {
  if (typeof str !== "string" || !str.includes(OLD)) return str;
  return str.replace(LINK_RX, "$1Combo").replace(ENRICHER_RX, "$1Combo$2");
}

// Walk a document; rename inside every string; count the fields changed.
function walk(node, path, hits) {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      if (typeof node[i] === "string") {
        const next = renameIn(node[i]);
        if (next !== node[i]) { node[i] = next; hits.push(`${path}[${i}]`); }
      } else if (node[i] && typeof node[i] === "object") walk(node[i], `${path}[${i}]`, hits);
    }
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === "name" && path === "") continue;     // never rename a document's name here
    if (typeof v === "string") {
      const next = renameIn(v);
      if (next !== v) { node[k] = next; hits.push(path ? `${path}.${k}` : k); }
    } else if (v && typeof v === "object") walk(v, path ? `${path}.${k}` : k, hits);
  }
}

async function collect(collection, extra = null) {
  const db = await openCollection(collection);
  const out = [];
  try {
    for await (const [key, doc] of db.iterator()) out.push([key, doc]);
  } finally { await db.close(); }
  return out;
}

async function migrateCollection(collection) {
  await run(async ({ changes }) => {
    const docs = await collect(collection);
    for (const [key, doc] of docs) {
      if (!doc || typeof doc !== "object") continue;
      const hits = [];
      walk(doc, "", hits);
      if (collection === "journal" && key === `!journal!${OLD}` && doc.name === "Chain") {
        doc.name = "Combo";
        hits.push("name");
      }
      // The keyword's own text page: the bare word, in its rules prose.
      if (collection === "journal" && key.startsWith(`!journal.pages!${OLD}.`)) {
        for (const f of ["name"]) if (doc[f] === "Chain") { doc[f] = "Combo"; hits.push(f); }
        const t = doc?.text?.content;
        if (typeof t === "string") {
          const next = t.replace(/\bChains\b/g, "Combo").replace(/\bChain\b/g, "Combo");
          if (next !== t) { doc.text.content = next; hits.push("text.content"); }
        }
      }
      if (hits.length) changes.push([key, doc, `${doc.name ?? key}: ${hits.length} field(s) — ${hits.slice(0, 6).join(", ")}${hits.length > 6 ? ", …" : ""}`]);
    }
  }, `chain→combo: rename the original Chain keyword (${collection})`, collection);
}

(async () => {
  for (const c of ["items", "actors", "journal"]) {
    console.log(`\n══ ${c} ══`);
    await migrateCollection(c);
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
