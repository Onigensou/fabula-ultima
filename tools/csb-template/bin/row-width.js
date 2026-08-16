#!/usr/bin/env node
"use strict";

// row-width — what an author ACTUALLY sees on one effect/reaction row.
// ---------------------------------------------------------------------------
// ⚠ This tool exists because the previous width metric measured the wrong view.
//
// `effect_table` and `reaction_config_table` are NOT CSB's built-in
// `dynamicTable`. They are `compactDynamicTable`, a module-owned subclass
// (scripts/csb-extensions/CompactDynamicTable.js). The difference is the whole
// ballgame:
//
//   - dynamicTable computes `columnsVisibility` by OR-ing every row
//     (DynamicTable.js:276), renders an HTML <table>, and collapses a hidden
//     cell to zero width. A skill's table is therefore the UNION of the columns
//     any of its rows needs — that union is what the old metric counted.
//   - compactDynamicTable renders each row as flex chips and simply SKIPS a
//     field whose visibilityFormula is false (`if (!visible) continue;`,
//     CompactDynamicTable.js:191-192). There is no union, no zero-width cell.
//
// The builder view still uses the union path (CompactDynamicTable.js:102-104
// defers to super for `isBuilderTemplateSystem`), so the old number was real —
// it just described the template EDITOR, not the sheet an author works in.
//
// The unit that matters is therefore per ROW: how many chips render, how many
// carry a value, and — the actionable part — which chips render blank most
// often. A chip that renders on 2000 rows and is filled on 30 is pure noise and
// is exactly what a gate should remove.
//
// Docs are measured against THEIR OWN template. `_Skill Template` is not the
// only instantiated layout, and assuming it was is a known defect in a sibling
// tool.
//
// Game must be CLOSED (reads the world LevelDB + the authored export).
//
//   node tools/csb-template/bin/row-width.js [--table effect_table] [--json]
//                                            [--top 25] [--world W]

const fs = require("fs");
const path = require("path");
const { load, DEFAULT_WORLD } = require("../lib/source.js");

const TABLE_TYPES = new Set(["dynamicTable", "compactDynamicTable", "itemContainer"]);
const DEFAULT_TABLES = ["effect_table", "reaction_config_table"];

function parseArgs(argv) {
  const a = { world: DEFAULT_WORLD, json: false, tables: null, top: 25 };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--json") a.json = true;
    else if (v === "--table") (a.tables ||= []).push(argv[++i]);
    else if (v === "--top") a.top = Number(argv[++i]) || 25;
    else if (v === "--world") a.world = argv[++i];
  }
  a.tables ||= DEFAULT_TABLES;
  return a;
}

// ---------------------------------------------------------------------------
// Formula evaluation
//
// Every visibilityFormula in these two tables is pure function application —
// verified: the only operator characters present are parens and commas. So the
// formula can be evaluated directly with the five/seven functions bound.
// `equalText` is mathjs's, and is CASE SENSITIVE (math.js:30496).
// ---------------------------------------------------------------------------

function makeEnv(row, triggers) {
  const sameRow = (key, dflt = "") => {
    const v = row?.[key];
    return v === undefined || v === null ? dflt : v;
  };
  const equalText = (a, b) => String(a) === String(b);
  const and = (...xs) => xs.every(Boolean);
  const or = (...xs) => xs.some(Boolean);
  const not = (x) => !x;

  // Mirror reaction-formulaFunctions.js: an unknown/unregistered key returns 1
  // (SHOW). Without the registry we take the same permissive answer, so this
  // tool can never under-report width.
  const triggerNeeds = (triggerKey, filterName) => {
    const key = String(triggerKey ?? "").trim();
    const filter = String(filterName ?? "").trim();
    if (!key || !filter || !triggers?.filtersFor) return 1;
    if (!triggers.isValidKey?.(key)) return 1;
    const filters = triggers.filtersFor(key);
    return Array.isArray(filters) && filters.includes(filter) ? 1 : 0;
  };
  const triggerHasSubject = (triggerKey) => {
    const key = String(triggerKey ?? "").trim();
    if (!key || !triggers?.subjectShapeFor) return 1;
    if (!triggers.isValidKey?.(key)) return 1;
    return triggers.subjectShapeFor(key) !== null ? 1 : 0;
  };
  const triggerInFamily = (triggerKey, family) => {
    const key = String(triggerKey ?? "").trim();
    if (!key || !triggers?.familiesFor) return 1;
    if (!triggers.isValidKey?.(key)) return 1;
    const fams = triggers.familiesFor(key);
    return Array.isArray(fams) && fams.includes(String(family ?? "").trim()) ? 1 : 0;
  };

  return { sameRow, equalText, and, or, not, triggerNeeds, triggerHasSubject, triggerInFamily };
}

const COMPILED = new Map();
function compile(formula) {
  if (COMPILED.has(formula)) return COMPILED.get(formula);
  let fn;
  try {
    fn = new Function(
      "sameRow", "equalText", "and", "or", "not",
      "triggerNeeds", "triggerHasSubject", "triggerInFamily",
      `return (${formula});`
    );
  } catch {
    fn = null; // unparseable -> treated as visible, and reported
  }
  COMPILED.set(formula, fn);
  return fn;
}

function isVisible(formula, env, bad) {
  const f = String(formula || "").trim();
  if (!f) return true; // ungated
  const fn = compile(f);
  if (!fn) { bad.add(f); return true; }
  try {
    return Boolean(fn(env.sameRow, env.equalText, env.and, env.or, env.not,
                      env.triggerNeeds, env.triggerHasSubject, env.triggerInFamily));
  } catch {
    bad.add(f);
    return true;
  }
}

// ---------------------------------------------------------------------------

function tablesOf(doc) {
  const out = new Map();
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (TABLE_TYPES.has(n.type) && n.key) out.set(n.key, n);
    for (const c of n.contents || []) {
      if (Array.isArray(c)) c.forEach(walk);
      else walk(c);
    }
  };
  for (const root of ["header", "body"]) if (doc.system?.[root]) walk(doc.system[root]);
  return out;
}

function loadCorpus(world) {
  const base = path.join(__dirname, "..", "..", "..", "worlds", world, "_authored-export");
  const docs = [];
  if (!fs.existsSync(base)) return docs;
  const visit = (d, owner) => {
    if (d && d.system && d.system.template) docs.push({ doc: d, owner });
    for (const i of d.items || []) visit(i, d.name || owner);
  };
  for (const dir of ["items", "actors"]) {
    const p = path.join(base, dir);
    if (!fs.existsSync(p)) continue;
    for (const f of fs.readdirSync(p)) {
      if (!f.endsWith(".json")) continue;
      try { visit(JSON.parse(fs.readFileSync(path.join(p, f), "utf8")), null); } catch { /* skip */ }
    }
  }
  return docs;
}

const isBlank = (v) =>
  v === undefined || v === null || v === "" || v === false ||
  (Array.isArray(v) && v.length === 0);

function stats(xs) {
  if (!xs.length) return { n: 0, mean: 0, median: 0, p90: 0, max: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return {
    n: s.length,
    mean: xs.reduce((a, b) => a + b, 0) / s.length,
    median: at(0.5),
    p90: at(0.9),
    max: s[s.length - 1],
  };
}

// The engine-contract map CompactDynamicTable uses to keep an unset REQUIRED
// field visible while a row is collapsed. Imported rather than duplicated so
// this measurement cannot drift from what the component actually does.
async function loadRequiredByKind() {
  try {
    const url = new URL(
      "../../../modules/fabula-ultima-companion/scripts/battle-director/template-field-registry.js",
      require("url").pathToFileURL(__filename)
    );
    const m = await import(url.href);
    return m.REQUIRED_FIELDS_BY_KIND ?? {};
  } catch { return {}; }
}

// Mirrors CompactDynamicTable.requiredKeysFor — null means "no contract known",
// which must not be read as "nothing required".
function requiredKeysFor(row, map) {
  const kind = String(row?.effect_kind ?? "").trim();
  const spec = map[kind];
  if (!spec) return null;
  const isTrue = (v) => v === true || String(v ?? "").trim().toLowerCase() === "true";
  if ((spec.unlessTrue ?? []).some((k) => isTrue(row?.[k]))) return new Set();
  if ((spec.unlessSet ?? []).some((k) => !isBlank(row?.[k]))) return new Set();
  const out = new Set(spec.all ?? []);
  for (const group of spec.either ?? []) {
    if (!group.some((k) => !isBlank(row?.[k]))) group.forEach((k) => out.add(k));
  }
  return out;
}

const CORE_CHIPS = 2;

async function loadTriggers() {
  // The trigger config is ESM and may touch `globalThis.window` on import.
  // Failure is survivable: every trigger function falls back to SHOW, which is
  // also what the engine does for an unregistered key.
  try {
    globalThis.window ||= globalThis;
    // The config builds its registry inside `Hooks.once("ready", …)`, so a
    // no-op shim imports cleanly and yields NOTHING. The shim has to actually
    // run the callback — otherwise every trigger gate silently falls back to
    // "show", which is the permissive answer and would overstate width.
    const pending = [];
    globalThis.Hooks ||= {
      once: (_e, cb) => pending.push(cb),
      on: (_e, cb) => pending.push(cb),
      off() {}, call() {}, callAll() {},
    };
    const url = new URL(
      "../../../modules/fabula-ultima-companion/scripts/reaction-system/reaction-triggers.config.js",
      require("url").pathToFileURL(__filename)
    );
    // The registry announces itself on console.debug, which is stdout — that
    // corrupts `--json`. Mute the module's own chatter across install.
    const realDebug = console.debug, realLog = console.log;
    console.debug = () => {}; console.log = () => {};
    let m;
    try {
      m = await import(url.href);
      for (const cb of pending) { try { cb(); } catch { /* partial install is still useful */ } }
    } finally {
      console.debug = realDebug; console.log = realLog;
    }
    const reg = globalThis.window?.["oni.ReactionTriggers"] || m;
    if (typeof reg?.filtersFor === "function") return reg;
  } catch { /* fall through */ }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const triggers = await loadTriggers();
  const requiredByKind = await loadRequiredByKind();
  const corpus = loadCorpus(args.world);

  // Group docs by the template they actually instantiate.
  const byTemplate = new Map();
  for (const e of corpus) {
    const t = e.doc.system.template;
    if (!byTemplate.has(t)) byTemplate.set(t, []);
    byTemplate.get(t).push(e);
  }

  const layouts = new Map();     // templateId -> Map(tableKey -> rowLayout[])
  const unresolved = [];
  for (const tid of byTemplate.keys()) {
    // A template id may name an Item template OR an Actor template — CSB uses
    // the same `system.template` pointer for both. Assuming Item silently drops
    // every actor-templated document from the measurement.
    let loaded = null;
    for (const ref of [`Item.${tid}`, `Actor.${tid}`]) {
      try { loaded = await load(ref, { world: args.world }); break; } catch { /* try next */ }
    }
    if (!loaded) { unresolved.push({ template: tid, docs: byTemplate.get(tid).length }); continue; }
    const m = new Map();
    for (const [k, node] of tablesOf(loaded.doc)) m.set(k, node.rowLayout || []);
    layouts.set(tid, m);
  }

  const report = { world: args.world, triggersLoaded: Boolean(triggers), unresolved, tables: {} };
  const badFormulas = new Set();

  for (const tableKey of args.tables) {
    const rendered = [];
    const filled = [];
    const collapsed = [];
    const perCol = new Map();   // colKey -> { rendered, filledN, templates:Set }
    let docsWithRows = 0;
    let missingLayout = 0;

    for (const [tid, entries] of byTemplate) {
      const layout = layouts.get(tid)?.get(tableKey);
      for (const { doc } of entries) {
        const table = doc.system?.props?.[tableKey];
        if (!table || typeof table !== "object") continue;
        const rows = Object.entries(table)
          .filter(([k]) => /^\d+$/.test(k))
          .map(([, v]) => v)
          .filter((r) => r && typeof r === "object" && !r.deleted && !r.$deleted);
        if (!rows.length) continue;
        if (!layout) { missingLayout += rows.length; continue; }
        docsWithRows++;

        for (const row of rows) {
          const env = makeEnv(row, triggers);
          const needed = requiredKeysFor(row, requiredByKind);
          let vis = 0, fil = 0, collapsedVis = 0;
          for (const col of layout) {
            if (!col?.key) continue;
            if (!isVisible(col.visibilityFormula, env, badFormulas)) continue;
            vis++;
            const has = !isBlank(row[col.key]);
            if (has) fil++;
            // Same rule as the component: identity chips, filled chips, and an
            // unset engine requirement stay visible when the row is folded.
            if (vis <= CORE_CHIPS || has || (needed !== null && !has && needed.has(col.key))) collapsedVis++;
            if (!perCol.has(col.key)) perCol.set(col.key, { rendered: 0, filledN: 0 });
            const p = perCol.get(col.key);
            p.rendered++;
            if (has) p.filledN++;
          }
          rendered.push(vis);
          filled.push(fil);
          collapsed.push(collapsedVis);
        }
      }
    }

    const noise = [...perCol.entries()]
      .map(([key, v]) => ({ key, ...v, blank: v.rendered - v.filledN,
                            fillRate: v.rendered ? v.filledN / v.rendered : 0 }))
      .sort((a, b) => b.blank - a.blank);

    report.tables[tableKey] = {
      rows: rendered.length,
      docs: docsWithRows,
      rowsWithNoLayout: missingLayout,
      renderedPerRow: stats(rendered),
      filledPerRow: stats(filled),
      blankChipsPerRow: stats(rendered.map((v, i) => v - filled[i])),
      collapsedPerRow: stats(collapsed),
      noise,
    };
  }
  report.unevaluableFormulas = [...badFormulas];

  if (args.json) { console.log(JSON.stringify(report, null, 2)); return; }

  console.log(`row-width — per-ROW chip cost (compactDynamicTable render path)`);
  console.log(`world: ${args.world}   templates: ${byTemplate.size}   triggers: ${triggers ? "loaded" : "FALLBACK (all show)"}`);
  if (unresolved.length) {
    console.log(`\n⚠ ${unresolved.length} template(s) referenced by docs but not resolvable:`);
    for (const u of unresolved) console.log(`    ${u.template}  (${u.docs} doc(s) — their rows are UNMEASURED)`);
  }
  if (badFormulas.size) {
    console.log(`\n⚠ ${badFormulas.size} formula(s) could not be evaluated — counted as VISIBLE:`);
    for (const f of badFormulas) console.log(`    ${f}`);
  }

  for (const tableKey of args.tables) {
    const t = report.tables[tableKey];
    if (!t || !t.rows) { console.log(`\n== ${tableKey} ==\n  no authored rows`); continue; }
    const f = (s) => `mean ${s.mean.toFixed(1)}  median ${s.median}  p90 ${s.p90}  max ${s.max}`;
    console.log(`\n== ${tableKey} ==   ${t.rows} rows across ${t.docs} docs`);
    if (t.rowsWithNoLayout) console.log(`  ⚠ ${t.rowsWithNoLayout} row(s) skipped — their template declares no such table`);
    console.log(`  chips rendered : ${f(t.renderedPerRow)}`);
    console.log(`  chips filled   : ${f(t.filledPerRow)}`);
    console.log(`  chips BLANK    : ${f(t.blankChipsPerRow)}   <- the noise an author reads past`);
    const cut = t.renderedPerRow.mean ? 100 * (1 - t.collapsedPerRow.mean / t.renderedPerRow.mean) : 0;
    console.log(`  VISIBLE folded : ${f(t.collapsedPerRow)}   <- CompactDynamicTable row collapse (-${cut.toFixed(0)}%)`);

    console.log(`\n  Worst offenders — rendered often, filled rarely:`);
    console.log(`  ${"blank".padStart(6)} ${"rend".padStart(6)} ${"fill%".padStart(6)}  column`);
    for (const c of t.noise.slice(0, args.top)) {
      console.log(`  ${String(c.blank).padStart(6)} ${String(c.rendered).padStart(6)} ${(c.fillRate * 100).toFixed(0).padStart(5)}%  ${c.key}`);
    }
    const always = t.noise.filter((c) => c.rendered === t.rows);
    if (always.length) {
      console.log(`\n  Rendered on EVERY row (${always.length}): ${always.map((c) => c.key).join(", ")}`);
    }
  }
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
