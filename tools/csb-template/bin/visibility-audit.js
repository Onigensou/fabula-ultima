#!/usr/bin/env node
"use strict";

// visibility-audit — find template fields that exist in DATA but not in the SHEET.
//
// Two failure modes, both invisible to behavioural tests (the harness never opens
// a sheet, so a field it can read looks fine even when no human can edit it):
//
//   [A] BROKEN GATE — a column's `visibilityFormula` reads `sameRow("X")` for an
//       X that is not a column of that table. The gate can never be satisfied, so
//       the column is hidden on EVERY row while its authored values sit in the
//       data. Found `reaction_passive_target` gated on `reaction_isPassive`, a
//       prop the reaction editor stopped writing: 142 authored values, 0 editable.
//
//   [B] DATA-ONLY KEY — a row key / top-level prop carried by real documents that
//       the template declares no field for, i.e. uneditable from any sheet.
//       ⚠ The two halves carry DIFFERENT risk, and conflating them overstates the
//       row-key case:
//         · a TOP-LEVEL prop IS pruned — TemplateSystem.js's reloadTemplate loop
//           is `for (const prop in system.props)` against the declared key set,
//           so an undeclared one is marked `-=prop` and deleted. That is the
//           documented 112-key loss.
//         · a ROW KEY is NOT. The loop is shallow, and a dynamic table
//           contributes exactly ONE key to that set (ExtensibleTable
//           `getAllProperties` returns `{<tableKey>: undefined}`), so the whole
//           table object survives and `effect_table.7.menu_color` is never
//           iterated. No write path rebuilds a row from its rendered cells
//           either. Row keys are an EDITABILITY problem, not a data-loss one.
//
//   [C] OVER-NARROW REGISTRY GATE — template-field-registry.js declares a gate
//       narrower than the kinds the field is actually authored on (grant_amount
//       is gated to adjust_grant but lives on 177 `grant` rows). Harmless while
//       the boot sync only ADDS columns, and a data-loss event the moment that
//       gate is pushed onto an existing column — which is what `reconcileVis:
//       true` opts into. Run this before setting that flag.
//
// Both are pure source+export reads: GAME CLOSED, no bridge, ~2s.
//
//   node tools/csb-template/bin/visibility-audit.js [--template <id>] [--json]
//                                                   [--world <name>] [--quiet]
//
// Exit 1 if any BROKEN GATE is found (that class is always a bug); data-only keys
// report as warnings, since a few are legitimately engine-internal.

const fs = require("fs");
const path = require("path");
const { load, DEFAULT_WORLD } = require("../lib/source.js");

const TABLE_TYPES = new Set(["dynamicTable", "compactDynamicTable", "itemContainer"]);
const PROP_TYPES = new Set([
  "textField", "numberField", "checkbox", "select", "radioButton", "textArea", "richTextArea",
  ...TABLE_TYPES,
]);
// CSB row bookkeeping + sheet-internal props that are never authored fields.
const IGNORE_KEYS = new Set(["deleted", "$deleted", "name", "img", "id", "uuid", "uniqueId"]);

function parseArgs(argv) {
  const a = { template: "j0F5Msw5RZ8aIB3j", world: DEFAULT_WORLD, json: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--json") a.json = true;
    else if (v === "--quiet") a.quiet = true;
    else if (v === "--template") a.template = argv[++i];
    else if (v === "--world") a.world = argv[++i];
  }
  return a;
}

// Walk a component tree, collecting top-level fields and per-table columns.
function inventory(doc) {
  const fields = new Map();               // key -> node
  const columns = new Map();              // tableKey -> Map(colKey -> node)
  function walk(node, tableKey) {
    if (!node || typeof node !== "object") return;
    const nextTable = TABLE_TYPES.has(node.type) ? node.key : tableKey;
    if (node.type && node.key) {
      if (tableKey) {
        if (!columns.has(tableKey)) columns.set(tableKey, new Map());
        columns.get(tableKey).set(node.key, node);
      } else if (PROP_TYPES.has(node.type)) {
        fields.set(node.key, node);
      }
    }
    for (const c of node.contents || []) {
      if (Array.isArray(c)) c.forEach((cell) => walk(cell, nextTable));
      else walk(c, nextTable);
    }
    for (const c of node.rowLayout || []) walk(c, nextTable);
  }
  for (const root of ["header", "body"]) if (doc.system?.[root]) walk(doc.system[root], null);
  return { fields, columns };
}

// [A] Gates whose sameRow(...) reference is not a sibling column / field.
function brokenGates({ fields, columns }) {
  const out = [];
  const check = (node, scopeName, scopeKeys) => {
    const f = String(node.visibilityFormula || "").trim();
    if (!f) return;
    for (const m of f.matchAll(/sameRow\(\s*["']([^"']+)["']/g)) {
      const ref = m[1];
      if (scopeKeys.has(ref)) continue;
      out.push({ scope: scopeName, column: node.key, referenced: ref, formula: f });
    }
  };
  for (const [tableKey, cols] of columns) {
    const keys = new Set(cols.keys());
    for (const node of cols.values()) check(node, tableKey, keys);
  }
  const topKeys = new Set(fields.keys());
  for (const node of fields.values()) check(node, "(top-level)", topKeys);
  return out;
}

// Collect every document in the export that instantiates this template.
function loadCorpus(world, templateId) {
  const base = path.join(__dirname, "..", "..", "..", "worlds", world, "_authored-export");
  const docs = [];
  if (!fs.existsSync(base)) return docs;
  const visit = (d) => {
    if (d && d.system && d.system.template === templateId) docs.push(d);
    for (const i of d.items || []) visit(i);
  };
  for (const dir of ["items", "actors"]) {
    const p = path.join(base, dir);
    if (!fs.existsSync(p)) continue;
    for (const f of fs.readdirSync(p)) {
      if (!f.endsWith(".json")) continue;
      try { visit(JSON.parse(fs.readFileSync(path.join(p, f), "utf8"))); } catch { /* skip */ }
    }
  }
  return docs;
}

const isBlank = (v) =>
  v === undefined || v === null || v === "" || v === false ||
  (Array.isArray(v) && v.length === 0);

// [B] Keys present in data with no declared field/column.
function dataOnlyKeys(docs, { fields, columns }) {
  const topLevel = new Map();
  const rowLevel = new Map();
  const bump = (m, k, name) => {
    if (!m.has(k)) m.set(k, { cells: 0, docs: new Set() });
    const e = m.get(k); e.cells++; e.docs.add(name);
  };
  for (const doc of docs) {
    for (const [k, v] of Object.entries(doc.system?.props || {})) {
      if (columns.has(k) && v && typeof v === "object") {
        const declared = columns.get(k);
        for (const row of Object.values(v)) {
          if (!row || typeof row !== "object") continue;
          for (const [ck, cv] of Object.entries(row)) {
            if (IGNORE_KEYS.has(ck) || declared.has(ck) || isBlank(cv)) continue;
            bump(rowLevel, `${k}.${ck}`, doc.name);
          }
        }
        continue;
      }
      if (IGNORE_KEYS.has(k) || fields.has(k) || isBlank(v)) continue;
      bump(topLevel, k, doc.name);
    }
  }
  return { topLevel, rowLevel };
}

// Parse an `effect_kind`-shaped gate into the set of kinds it admits.
// Returns null when the formula is not a plain or-of-equalText over effect_kind
// (an `and` / `not` makes the admitted set undecidable by this parser, and
// guessing would be worse than declining).
function kindsAdmitted(formula) {
  const f = String(formula || "").trim();
  if (!f) return "ALL";                                   // always visible
  if (!/effect_kind/.test(f)) return null;
  if (/\b(and|not)\s*\(/.test(f)) return null;            // too complex to decide
  const ks = [...f.matchAll(/equalText\(sameRow\("effect_kind",''\),\s*"([a-z_]+)"\)/g)].map((m) => m[1]);
  if (!ks.length) return null;
  // Every equalText must be joined only by `or` — anything else (a nested call,
  // a comparison against another column) makes the admitted set unclaimable.
  const stripped = f
    .replace(/equalText\(sameRow\("effect_kind",''\),\s*"[a-z_]+"\)/g, "X")
    .replace(/\bor\b/g, "")
    .replace(/[\s(),]/g, "");
  if (!/^X+$/.test(stripped)) return null;
  return new Set(ks);
}

// [C] Registry gates vs live usage. Only the effect_kind-shaped gates are
// decidable offline (the reaction gates call into a runtime registry), which is
// exactly the set the effect_table registry uses.
// Parse template-field-registry.js → Map(colKey → { allowed:Set, opted:bool }).
// Only entries whose gate is an effect_kind-shaped formula appear.
function parseRegistryGates() {
  const regPath = path.join(__dirname, "..", "..", "..", "modules", "fabula-ultima-companion",
    "scripts", "battle-director", "template-field-registry.js");
  if (!fs.existsSync(regPath)) return null;
  const src = fs.readFileSync(regPath, "utf8");

  const consts = {};
  for (const m of src.matchAll(/^const (\w+_VIS) = `([^`]*)`;/gm)) consts[m[1]] = m[2];
  for (let i = 0; i < 8; i++) {
    for (const [k, v] of Object.entries(consts)) {
      consts[k] = v.replace(/\$\{(\w+_VIS)\}/g, (_, n) => consts[n] ?? _);
    }
  }

  // Bound each entry to the NEXT builder call, so a field declared `vis: ""`
  // cannot borrow the following entry's gate.
  const starts = [...src.matchAll(/(?:text|checkbox|select)Col\("([a-z_0-9]+)"/g)];
  const gates = new Map();
  for (let i = 0; i < starts.length; i++) {
    const m = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1].index : src.length;
    const seg = src.slice(m.index, end);
    const vm = seg.match(/vis:\s*(`[^`]*`|"[^"]*"|[A-Z_0-9]+_VIS)/);
    if (!vm) continue;
    let f = vm[1];
    if (/^"/.test(f)) f = f.slice(1, -1);                       // vis: "" → always visible
    else if (/^[A-Z_0-9]+_VIS$/.test(f)) f = consts[f] ?? "";
    else f = f.replace(/^`|`$/g, "").replace(/\$\{(\w+_VIS)\}/g, (_, n) => consts[n] ?? "");
    // `vis: ""` is kept as "ALL" — an always-visible registry gate is exactly the
    // shape that BROADENS a stale live gate, which is check [D]'s whole subject.
    const admitted = kindsAdmitted(f);
    if (admitted === null) continue;
    const builder = m[0].slice(0, m[0].indexOf("Col("));
    const regType = { text: "textField", checkbox: "checkbox", select: "select" }[builder] ?? null;
    gates.set(m[1], { allowed: admitted, opted: /reconcileVis:\s*true/.test(seg), type: regType });
  }
  return gates;
}

// [C] Which registry gates are NARROWER than real usage?
//
// Two DIFFERENT numbers, and conflating them raises false alarms:
//   cells       — authored on a kind the registry gate excludes. Says the gate is
//                 narrower than usage. Those cells may ALREADY be hidden.
//   newlyHidden — visible under the column's CURRENT gate and hidden under the
//                 registry's. This is the only one that represents a LOSS.
// For a column that does not exist yet, newlyHidden is 0 by construction: its
// cells are data-only today, i.e. invisible already, so a gate cannot take
// anything away — it can only fail to hand it back.
function registryGateAudit(docs, inv, gates) {
  if (!gates) return null;
  const liveEffect = inv?.columns?.get("effect_table") || new Map();
  // Which columns already exist on the template? A column that does NOT yet
  // exist has its gate applied the moment the sync creates it, whatever
  // `reconcileVis` says — so "latent" would be the wrong label for it.
  const existing = new Set();
  for (const cols of (inv?.columns || new Map()).values()) for (const k of cols.keys()) existing.add(k);

  const out = [];
  for (const [col, g] of gates) {
    if (g.allowed === "ALL") continue;                    // can hide nothing
    const live = liveEffect.get(col);
    const liveKinds = live ? kindsAdmitted(live.visibilityFormula) : null;
    const kinds = {};
    let n = 0, newlyHidden = 0;
    for (const doc of docs) {
      const t = doc.system?.props?.effect_table;
      if (!t || typeof t !== "object") continue;
      for (const r of Object.values(t)) {
        if (!r || typeof r !== "object" || r.deleted === true) continue;
        const kind = String(r.effect_kind ?? "").trim();
        if (!kind || isBlank(r[col]) || g.allowed.has(kind)) continue;
        n++; kinds[kind] = (kinds[kind] || 0) + 1;
        // Was it visible before? Only then is hiding it a loss.
        if (live && (liveKinds === "ALL" || (liveKinds instanceof Set && liveKinds.has(kind)))) newlyHidden++;
      }
    }
    if (!n) continue;
    const isNew = !existing.has(col);
    out.push({
      column: col, cells: n, newlyHidden: isNew ? 0 : newlyHidden,
      allowed: [...g.allowed], authoredOn: kinds,
      reconcileVis: g.opted, newColumn: isNew,
      // Will this gate actually take effect on the next sync?
      effective: isNew || g.opted,
    });
  }
  return out.sort((a, b) => b.cells - a.cells);
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const res = await load(args.template, { world: args.world });
  const doc = res.doc || res;
  const inv = inventory(doc);
  const gates = brokenGates(inv);
  const corpus = loadCorpus(args.world, args.template);
  const { topLevel, rowLevel } = dataOnlyKeys(corpus, inv);
  const regGates = parseRegistryGates();
  const narrow = registryGateAudit(corpus, inv, regGates);

  const ser = (m) => [...m.entries()]
    .map(([key, v]) => ({ key, cells: v.cells, docs: v.docs.size, examples: [...v.docs].slice(0, 3) }))
    .sort((a, b) => b.cells - a.cells);

  if (args.json) {
    console.log(JSON.stringify({
      template: doc.name, corpus: corpus.length,
      brokenGates: gates, dataOnlyTopLevel: ser(topLevel), dataOnlyRowKeys: ser(rowLevel),
      overNarrowGates: narrow || [], broaderGates: widen,
    }, null, 2));
    process.exit(gates.length || (narrow || []).some((g) => g.reconcileVis) ? 1 : 0);
  }

  console.log(`visibility-audit — ${doc.name} · ${corpus.length} instantiating doc(s)\n`);

  console.log(`[A] BROKEN GATES — visibilityFormula references a field that is not there: ${gates.length}`);
  for (const g of gates) {
    console.log(`      ${g.scope}.${g.column} reads sameRow("${g.referenced}") — no such column; hidden on every row`);
  }
  if (!gates.length) console.log("      none — every gate references a real sibling field.");

  const show = (title, rows) => {
    const cells = rows.reduce((a, r) => a + r.cells, 0);
    console.log(`\n[B] DATA-ONLY ${title}: ${rows.length} key(s), ${cells} authored cell(s)`);
    if (!args.quiet) {
      for (const r of rows) {
        console.log(`      ${String(r.cells).padStart(4)}  ${r.key.padEnd(34)} ${r.docs} doc(s)  e.g. ${r.examples.join(", ")}`);
      }
    }
  };
  show("ROW KEYS (uneditable from any sheet; NOT prunable — see header)", ser(rowLevel));
  show("TOP-LEVEL PROPS (uneditable AND pruned on reloadTemplate — real data loss)", ser(topLevel));

  // [D] The opposite direction from [C]: a registry gate BROADER than the live
  // column's. Pure upside — it restores cells and hides none — but invisible to
  // [C], which only reports narrowing. That asymmetry mattered: `condition_formula`
  // sat 203 cells behind a stale live gate while [C] reported nothing, and [C] is
  // the stated gate for setting `reconcileVis`.
  const widen = [];
  {
    // effect_table ONLY. Column keys are table-scoped, and `condition_formula`
    // exists in BOTH effect_table and reaction_config_table — flattening let the
    // reaction one (always-visible) mask the effect one (gated), which is exactly
    // the 203-cell case this check exists to surface.
    const liveCols = inv.columns.get("effect_table") || new Map();
    for (const [col, g] of regGates || new Map()) {
      const live = liveCols.get(col);
      if (!live) continue;
      const liveKinds = kindsAdmitted(live.visibilityFormula);
      const regKinds = g.allowed;
      if (liveKinds === null) continue;                    // undecidable live gate
      let restore = 0, lose = 0;
      const restoreKinds = {};
      for (const doc of corpus) {
        const t = doc.system?.props?.effect_table;
        if (!t || typeof t !== "object") continue;
        for (const r of Object.values(t)) {
          if (!r || typeof r !== "object" || r.deleted === true) continue;
          const kind = String(r.effect_kind ?? "").trim();
          if (!kind || isBlank(r[col])) continue;
          const visLive = liveKinds === "ALL" || liveKinds.has(kind);
          const visReg = regKinds === "ALL" || regKinds.has(kind);
          if (!visLive && visReg) { restore++; restoreKinds[kind] = (restoreKinds[kind] || 0) + 1; }
          if (visLive && !visReg) lose++;
        }
      }
      // A reconcile SKIPS on a type mismatch, so a "safe to arm" row whose type
      // diverges would ship nothing. Surface that rather than promise a win.
      if (restore) {
        widen.push({
          column: col, restore, lose, opted: g.opted, restoreKinds,
          liveType: live.type, regType: g.type ?? null,
          typeBlocked: !!(g.type && live.type && g.type !== live.type),
        });
      }
    }
  }

  // Only a gate that is BOTH effective and takes a currently-visible cell away
  // is a regression. The rest are "still not fixed", not "broken by this".
  const armed = (narrow || []).filter((g) => g.effective && g.newlyHidden > 0);
  console.log(`\n[C] OVER-NARROW REGISTRY GATES: ${(narrow || []).length}` +
    (armed.length
      ? `  — ⚠ ${armed.length} would HIDE ${armed.reduce((a, g) => a + g.newlyHidden, 0)} currently-visible cell(s)`
      : `  — none would hide a currently-visible cell`));
  for (const g of narrow || []) {
    const flag = g.newColumn ? "ON-CREATE" : g.reconcileVis ? "ARMED    " : "latent   ";
    const loss = g.newlyHidden > 0 ? `  ⚠ ${g.newlyHidden} currently VISIBLE` : "";
    console.log(`      [${flag}] ${String(g.cells).padStart(4)} still-hidden  ${g.column}` +
      `  gate=${g.allowed.join("|")}  authored on ${Object.entries(g.authoredOn).map(([k, n]) => `${k}:${n}`).join(", ")}${loss}`);
  }
  if (!(narrow || []).length) console.log("      none — every registry gate covers the kinds it is authored on.");

  const readyToArm = widen.filter((w) => !w.opted && w.lose === 0 && !w.typeBlocked);
  console.log(`\n[D] REGISTRY GATE BROADER THAN THE LIVE COLUMN: ${widen.length}` +
    (readyToArm.length ? `  — ${readyToArm.length} safe to arm, would restore ${readyToArm.reduce((a, w) => a + w.restore, 0)} cell(s) and hide 0` : ""));
  for (const w of widen) {
    const flag = w.opted ? "armed   " : w.typeBlocked ? "TYPE-FIX" : w.lose === 0 ? "SAFE-ARM" : "mixed   ";
    const note = w.typeBlocked ? `  ⚠ type ${w.liveType}(live) vs ${w.regType}(registry) — reconcile would skip` : "";
    console.log(`      [${flag}] restore ${String(w.restore).padStart(4)} · hide ${String(w.lose).padStart(3)}  ${w.column}` +
      `  ${Object.entries(w.restoreKinds).map(([k, n]) => `${k}:${n}`).join(", ")}${note}`);
  }
  if (!widen.length) console.log("      none — no registry gate is broader than its live column.");

  process.exit(gates.length || armed.length ? 1 : 0);
})().catch((e) => { console.error(e.stack || e.message); process.exit(2); });
