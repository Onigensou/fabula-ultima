"use strict";
//
// Mindscape — Monster Design Dossiers (dossiers/<monster>.md).
//
// A dossier is the design record of one monster: what its gimmick is, which design
// rules it breaks ON PURPOSE, and which sheet values the gimmick depends on. It exists
// so a balance scan weeks later reads "Heavy Swing 128 — intended, gated by Frightened"
// instead of "one-shots a PC" (dossiers/README.md).
//
// Format: Markdown prose for people, plus ONE fenced block tagged `json dossier` that
// the tools read:
//
//   { "monster": "Gigas", "actorId": "1Lw7...", "status": "draft" | "confirmed",
//     "exceptions": [{ "rule": "one-shot", "action": "Heavy Swing", "why": "...",
//                      "decided_by": "user" | "claude", "date": "2026-08-14" }],
//     "invariants": [{ "id": "...", "why": "...", <selector>, <operator> }],
//     "blind_spots": ["..."], "open_questions": ["..."] }
//
// Invariant selectors (one per invariant):
//   prop            actor system.props key                     { "prop": "condition_frightened" }
//   affinity        element name, read through the loader      { "affinity": "bolt" }
//   item + prop     embedded item's props key                  { "item": "Heavy Swing", "prop": "skill_type" }
//   item + table + row + field
//                   a dynamicTable cell; `row` is the row key ("1") or a row's
//                   effect_label / reaction_effect_ref         { "item": "Oaf", "table": "effect_table", "row": "oaf_fear", "field": "ae_initial_charges" }
//   item + sameAsWorldItem
//                   the embedded copy matches that world item on every prop both carry
//                   (or on `fields`) — for stealable/droppable copies kept in sync by hand
// Operators: equals · in [..] · contains "..." · min n · max n.
//
// Pure — no world access. bin/dossier.js and bin/monster-audit.js do the loading.

const fs = require("fs");
const path = require("path");

const DOSSIER_DIR = path.join(__dirname, "..", "dossiers");
const BLOCK = /```json dossier\s*\n([\s\S]*?)\n```/;
// Props that legitimately differ between a world item and its embedded copy.
const SYNC_IGNORE = new Set(["id", "uuid"]);

const s = (v) => String(v ?? "").trim();
const norm = (v) => s(v).toLowerCase();

// Markdown -> { data, sections: { heading: text }, file }.
function parseDossier(text, file = null) {
  const m = BLOCK.exec(text);
  if (!m) throw new Error(`${file ?? "dossier"}: no \`\`\`json dossier block`);
  let data;
  try { data = JSON.parse(m[1]); } catch (e) { throw new Error(`${file ?? "dossier"}: json dossier block: ${e.message}`); }
  if (!s(data.monster)) throw new Error(`${file ?? "dossier"}: "monster" is required`);
  data.status = s(data.status) || "draft";
  data.exceptions = data.exceptions ?? [];
  data.invariants = data.invariants ?? [];
  data.blind_spots = data.blind_spots ?? [];
  data.open_questions = data.open_questions ?? [];

  const sections = {};
  let head = null;
  for (const line of text.replace(BLOCK, "").split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) { head = h[1]; sections[head] = []; continue; }
    if (head) sections[head].push(line);
  }
  for (const k of Object.keys(sections)) sections[k] = sections[k].join("\n").trim();
  return { data, sections, file };
}

function loadDossiers(dir = DOSSIER_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f.toLowerCase() !== "readme.md" && !f.startsWith("_"))
    .map((f) => parseDossier(fs.readFileSync(path.join(dir, f), "utf8"), path.join(dir, f)));
}

// The dossier for a combat model: by actor id first, then by name.
function findDossier(dossiers, model) {
  return dossiers.find((d) => d.data.actorId && d.data.actorId === model.id)
    ?? dossiers.find((d) => norm(d.data.monster) === norm(model.name))
    ?? null;
}

function rowOf(table, row) {
  if (!table || typeof table !== "object") return null;
  if (table[String(row)] && typeof table[String(row)] === "object") return table[String(row)];
  return Object.values(table).find((r) => r && typeof r === "object" && r.$deleted !== true
    && (s(r.effect_label) === s(row) || s(r.reaction_effect_ref) === s(row))) ?? null;
}

function compare(inv, actual) {
  if ("equals" in inv) return s(actual) === s(inv.equals);
  if ("in" in inv) return inv.in.map(s).includes(s(actual));
  if ("contains" in inv) return s(actual).includes(s(inv.contains));
  if ("min" in inv) return Number(actual) >= Number(inv.min);
  if ("max" in inv) return Number(actual) <= Number(inv.max);
  throw new Error(`invariant ${inv.id ?? "?"}: no operator (equals/in/contains/min/max)`);
}
function expected(inv) {
  if ("equals" in inv) return `= ${JSON.stringify(inv.equals)}`;
  if ("in" in inv) return `in ${JSON.stringify(inv.in)}`;
  if ("contains" in inv) return `contains ${JSON.stringify(inv.contains)}`;
  if ("min" in inv) return `>= ${inv.min}`;
  return `<= ${inv.max}`;
}

// One invariant against a model -> { id, ok, text, why }. `worldItems` (a WorldItems)
// is only needed for sameAsWorldItem; without it that check reports itself skipped.
function checkInvariant(inv, model, { worldItems = null } = {}) {
  const id = inv.id ?? JSON.stringify(inv);
  const out = (ok, text) => ({ id, ok, text, why: inv.why ?? null });
  let item = null;
  if (inv.item) {
    const hits = model.items.filter((i) => norm(i.name) === norm(inv.item));
    if (!hits.length) return out(false, `item "${inv.item}" is missing`);
    if (hits.length > 1) return out(false, `${hits.length} items named "${inv.item}" — ambiguous`);
    item = hits[0];
  }

  if (inv.sameAsWorldItem) {
    if (!worldItems) return { ...out(true, `${inv.item}: world-item sync not checked (items not loaded)`), skipped: true };
    const w = worldItems.get(inv.sameAsWorldItem);
    if (!w) return out(false, `world item ${inv.sameAsWorldItem} is missing`);
    const keys = inv.fields ?? Object.keys(item.props).filter((k) => !SYNC_IGNORE.has(k) && k in w.props);
    const diff = keys.filter((k) => JSON.stringify(item.props[k] ?? null) !== JSON.stringify(w.props[k] ?? null));
    return diff.length
      ? out(false, `${inv.item}: embedded copy differs from world item ${inv.sameAsWorldItem} on ${diff.join(", ")}`)
      : out(true, `${inv.item}: embedded copy matches world item ${inv.sameAsWorldItem}`);
  }

  let label, actual;
  if (inv.affinity) {
    label = `affinity ${inv.affinity}`;
    actual = model.affinities?.[norm(inv.affinity)];
  } else if (item && inv.table) {
    const r = rowOf(item.props[inv.table], inv.row);
    if (!r) return out(false, `${inv.item} ${inv.table} row "${inv.row}" is missing`);
    label = `${inv.item} ${inv.table}[${inv.row}].${inv.field}`;
    actual = r[inv.field];
  } else if (item) {
    label = `${inv.item}.${inv.prop}`;
    actual = item.props[inv.prop];
  } else if (inv.prop) {
    label = inv.prop;
    actual = model._rawProps?.[inv.prop];
  } else {
    throw new Error(`invariant ${id}: no selector (prop/affinity/item)`);
  }
  const ok = compare(inv, actual);
  return out(ok, `${label} ${ok ? "" : `is ${JSON.stringify(actual ?? null)}, design wants `}${expected(inv)}`.replace(/\s+/g, " "));
}

function checkInvariants(dossier, model, opts) {
  return dossier.data.invariants.map((inv) => checkInvariant(inv, model, opts));
}

// Audit findings [{ rule, text, action? }] -> each tagged intended/new from the
// dossier's exceptions. An exception matches on rule, and on action when it names one.
// Intended findings are never dropped: a reason that went stale must stay visible.
function classifyFindings(findings, dossier) {
  const ex = dossier?.data.exceptions ?? [];
  return findings.map((f) => {
    const hit = ex.find((e) => e.rule === f.rule && (!e.action || norm(e.action) === norm(f.action)));
    if (!hit) return { ...f, status: "new" };
    return { ...f, status: "intended", why: hit.why ?? null, confirmed: hit.decided_by === "user", decided: [hit.decided_by, hit.date].filter(Boolean).join(" ") };
  });
}

// "Decision log" section rows (a Markdown table) -> [{ cells }], header and rule removed.
function decisionLog(dossier) {
  const t = dossier.sections["Decision log"] ?? "";
  const rows = t.split(/\r?\n/).filter((l) => /^\s*\|/.test(l) && !/^\s*\|\s*-/.test(l));
  return rows.slice(1).map((l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
}

module.exports = {
  DOSSIER_DIR, parseDossier, loadDossiers, findDossier,
  checkInvariant, checkInvariants, classifyFindings, decisionLog,
};
