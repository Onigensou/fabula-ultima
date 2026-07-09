#!/usr/bin/env node
// ───────────────────────────────────────────────────────────────────────────
// hot-reload-map — answer "will editing this Battle Director module take effect
// without a full page reload, or do I have to reload?" BEFORE you make the edit.
//
// Why this exists: Foundry's browser ESM cache pins every statically-imported
// module for the life of the page. The director works around this with two
// mechanisms that re-fetch specific modules under a cache-bust token:
//   1. the test harness's loadDeps() — re-imports a fixed set of "root" modules
//      fresh on every harness call, so edits to THOSE show up immediately; and
//   2. the hot-reload registry (registerHotModule / reloadHot) — re-imports
//      registered edges on demand.
// A module reached only through a plain static `import` is invisible to both —
// editing it needs a real page reload. The catch: cache-bust is NOT transitive.
// Re-importing a root fresh does NOT refresh the modules IT statically imports,
// so a leaf like skill-formulas.js is reload-required even though its parent
// skill-effects.js is hot. This tool makes that graph explicit.
//
// Pure static analysis — no Foundry, no bridge, no runtime. Safe to run anytime.
//
//   node bin/hot-reload-map.js report              # classify every module
//   node bin/hot-reload-map.js file <path-or-name> # verdict for one module you're about to edit
// ───────────────────────────────────────────────────────────────────────────
const fs = require("fs");
const path = require("path");

const BD_DIR = path.resolve(__dirname, "../../../modules/fabula-ultima-companion/scripts/battle-director");
const HARNESS = path.join(BD_DIR, "_test-harness-director.js");
const REL = (p) => path.relative(BD_DIR, p).split(path.sep).join("/");

// ── Parse the module graph ──────────────────────────────────────────────────
// Collect every .js under battle-director (recursively) and its relative import
// targets (static import/export-from + dynamic import()).
function listJs(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listJs(p));
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

// Match:  import ... from "./x.js"   |   export ... from "./x.js"   |   import("./x.js?...")
const STATIC_RE = /(?:^|\n)\s*(?:import|export)\b[^;\n]*?\bfrom\s*["'](\.[^"']+?)["']/g;
const SIDEEFFECT_RE = /(?:^|\n)\s*import\s*["'](\.[^"']+?)["']/g;         // import "./x.js"
// import("./x.js?cb=") and template form import(`./x.js${bust}`) — capture the
// bare specifier up to the first ?, `, ', ", $ or { (interpolation / query).
const DYNAMIC_RE = /\bimport\s*\(\s*[`"'](\.[^`"'?${\s]+)/g;

function resolveRel(fromFile, spec) {
  let clean = spec.replace(/[`"'].*$/, "").split("?")[0];
  let target = path.resolve(path.dirname(fromFile), clean);
  if (!target.endsWith(".js")) target += ".js";
  return target;
}

function parseGraph() {
  const files = listJs(BD_DIR);
  const staticEdges = new Map();  // file -> Set(static import targets)
  const dynamicEdges = new Map(); // file -> Set(dynamic import targets)
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    const stat = new Set();
    const dyn = new Set();
    for (const re of [STATIC_RE, SIDEEFFECT_RE]) {
      re.lastIndex = 0; let m;
      while ((m = re.exec(src))) { const t = resolveRel(f, m[1]); if (fs.existsSync(t)) stat.add(t); }
    }
    DYNAMIC_RE.lastIndex = 0; let m;
    while ((m = DYNAMIC_RE.exec(src))) { const t = resolveRel(f, m[1]); if (fs.existsSync(t)) dyn.add(t); }
    staticEdges.set(f, stat);
    dynamicEdges.set(f, dyn);
  }
  return { files, staticEdges, dynamicEdges };
}

// ── Discover the two fresh-import mechanisms from source ─────────────────────
// loadDeps() roots: the modules the harness dynamically re-imports every call.
function harnessRoots() {
  const src = fs.readFileSync(HARNESS, "utf8");
  // Grab the loadDeps() body and pull its dynamic import specifiers.
  const start = src.indexOf("async function loadDeps");
  const body = start >= 0 ? src.slice(start, src.indexOf("\n}", start)) : src;
  const roots = new Set();
  DYNAMIC_RE.lastIndex = 0; let m;
  while ((m = DYNAMIC_RE.exec(body))) {
    const t = resolveRel(HARNESS, m[1]);
    if (fs.existsSync(t) && REL(t) !== "hot-reload.js") roots.add(t);
  }
  return roots;
}

// Registered hot-reload edges: registerHotModule("<relpath>", ...) keys anywhere.
function hotEdges() {
  const edges = new Set();
  for (const f of listJs(BD_DIR)) {
    const src = fs.readFileSync(f, "utf8");
    const re = /registerHotModule\(\s*["']([^"']+)["']/g; let m;
    while ((m = re.exec(src))) {
      // keys are stored like "battle-director/skill-effects.js"
      const rel = m[1].replace(/^battle-director\//, "");
      const t = path.join(BD_DIR, rel);
      if (fs.existsSync(t)) edges.add(t);
    }
  }
  return edges;
}

// ── Classify ─────────────────────────────────────────────────────────────────
// harness-fresh : re-imported directly by loadDeps() -> harness sees edits now.
// hot-edge      : a registerHotModule edge -> reloadHot() picks up edits now.
// reload-req    : only reachable via static import -> a page reload is required.
function classify() {
  const { files, staticEdges } = parseGraph();
  const roots = harnessRoots();
  const edges = hotEdges();
  const byFile = new Map();
  // reverse static-import index: who statically imports X?
  const importers = new Map();
  for (const [f, targets] of staticEdges) for (const t of targets) {
    if (!importers.has(t)) importers.set(t, new Set());
    importers.get(t).add(f);
  }
  for (const f of files) {
    let kind;
    if (edges.has(f)) kind = "hot-edge";
    else if (roots.has(f)) kind = "harness-fresh";
    else kind = "reload-req";
    byFile.set(f, { kind, importedBy: [...(importers.get(f) || [])] });
  }
  return { files, byFile, roots, edges };
}

function fmtVerdict(kind) {
  return {
    "hot-edge": "HOT-EDGE — reloadHot() picks up edits live (no page reload)",
    "harness-fresh": "HARNESS-FRESH — edits show up in the next runDirectorSkill* call (no reload for harness testing)",
    "reload-req": "RELOAD-REQUIRED — statically imported only; a full page reload is needed",
  }[kind];
}

function main() {
  const [cmd, arg] = process.argv.slice(2);
  const { files, byFile, roots, edges } = classify();

  if (cmd === "file") {
    if (!arg) { console.error("usage: hot-reload-map file <path-or-name>"); process.exit(2); }
    const needle = arg.split(path.sep).join("/").replace(/\.js$/, "");
    const match = files.find((f) => REL(f).replace(/\.js$/, "") === needle)
      || files.find((f) => REL(f).includes(needle));
    if (!match) { console.error(`no battle-director module matches "${arg}"`); process.exit(2); }
    const info = byFile.get(match);
    console.log(`\n  ${REL(match)}`);
    console.log(`  → ${fmtVerdict(info.kind)}\n`);
    if (info.kind === "reload-req") {
      const hotImporters = info.importedBy.filter((f) => byFile.get(f) && byFile.get(f).kind !== "reload-req");
      if (hotImporters.length) {
        console.log(`  To make it hot WITHOUT a reload, route it through the hot-reload registry in one of its`);
        console.log(`  already-fresh importers (call through the accessor at each use site):`);
        for (const f of hotImporters) console.log(`      - ${REL(f)}  [${byFile.get(f).kind}]`);
      } else {
        console.log(`  (Not directly imported by any harness-fresh/hot-edge module — a page reload is the only path.)`);
      }
      console.log("");
    }
    return;
  }

  // default: report
  const groups = { "hot-edge": [], "harness-fresh": [], "reload-req": [] };
  for (const f of files) groups[byFile.get(f).kind].push(REL(f));
  for (const k of Object.keys(groups)) groups[k].sort();

  console.log(`\nhot-reload-map — ${files.length} Battle Director modules\n`);
  console.log(`Fresh-import mechanisms discovered from source:`);
  console.log(`  harness loadDeps() roots (${roots.size}): ${[...roots].map(REL).sort().join(", ")}`);
  console.log(`  hot-reload registry edges (${edges.size}): ${[...edges].map(REL).sort().join(", ") || "(none)"}\n`);

  console.log(`● HOT-EDGE (${groups["hot-edge"].length}) — reloadHot() picks up edits live:`);
  for (const r of groups["hot-edge"]) console.log(`    ${r}`);
  console.log(`\n● HARNESS-FRESH (${groups["harness-fresh"].length}) — fresh in the next runDirectorSkill* call:`);
  for (const r of groups["harness-fresh"]) console.log(`    ${r}`);
  console.log(`\n● RELOAD-REQUIRED (${groups["reload-req"].length}) — a page reload is needed to see edits:`);
  for (const r of groups["reload-req"]) console.log(`    ${r}`);
  console.log(`\nTip: \`hot-reload-map file <name>\` for a single module's verdict + how to make it hot.`);
  console.log(`Note: cache-bust is NOT transitive — a harness-fresh/hot-edge module's own static`);
  console.log(`imports stay cached, so most leaf logic modules are RELOAD-REQUIRED until routed`);
  console.log(`through the registry at their call sites.\n`);
}

main();
