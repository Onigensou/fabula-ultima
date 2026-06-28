#!/usr/bin/env node
"use strict";

// csb — CLI for inspecting / validating CSB templates.
//
//   node tools/csb-template/bin/csb.js lint   <Item.ID | id | file.json> [--bridge]
//   node tools/csb-template/bin/csb.js show    <ref> [--key K] [--type T] [--bridge]
//   node tools/csb-template/bin/csb.js verify  <ref> --bridge        (game OPEN; real CSB parse)
//   node tools/csb-template/bin/csb.js roundtrip <ref> --bridge      (game OPEN; kept-key diff)
//
// Read source:
//   default  — world LevelDB (GAME MUST BE CLOSED)
//   --bridge — live world via test-bridge (GAME MUST BE OPEN)
//   file.json — a snapshot, no DB needed (lint/show only)

const { CsbTree } = require("../lib/tree");
const { lint, coverage, summarize } = require("../lib/lint");
const source = require("../lib/source");
const bridge = require("../lib/bridge");

function getFlag(argv, name, def) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def; }
function hasFlag(argv, name) { return argv.includes(name); }

const COLORS = {
  error: "\x1b[31m", warn: "\x1b[33m", info: "\x1b[36m", reset: "\x1b[0m", dim: "\x1b[2m", green: "\x1b[32m",
};
function paint(sev, s) { return (COLORS[sev] || "") + s + COLORS.reset; }

async function loadRef(ref, argv) {
  if (hasFlag(argv, "--bridge")) return bridge.loadViaBridge(ref, { world: getFlag(argv, "--world", source.DEFAULT_WORLD) });
  return source.load(ref, { world: getFlag(argv, "--world", source.DEFAULT_WORLD) });
}

async function cmdLint(ref, argv) {
  const { doc, uuid, source: src } = await loadRef(ref, argv);
  const tree = new CsbTree(doc);
  // On the bridge, augment the static type list with the live factory registry
  // so module-registered components aren't false UNKNOWN_TYPE errors.
  let knownTypes;
  if (hasFlag(argv, "--bridge")) {
    try { knownTypes = await bridge.registeredTypes({ world: getFlag(argv, "--world", source.DEFAULT_WORLD) }); }
    catch { /* fall back to static list */ }
  }
  const findings = lint(tree, { knownTypes });
  const counts = summarize(findings);
  console.log(`${COLORS.dim}lint ${doc.name || uuid} (${src})${COLORS.reset}`);
  console.log(`${COLORS.dim}  fields: ${tree.propOwningKeys().size} prop-owning keys${COLORS.reset}`);
  if (!findings.length) {
    console.log(paint("green", "  ✓ no problems"));
  } else {
    for (const f of findings) {
      console.log(`  ${paint(f.severity, f.severity.toUpperCase().padEnd(5))} ${f.code}  ${f.message}`);
      console.log(`        ${COLORS.dim}at ${f.where}${COLORS.reset}`);
    }
  }
  console.log(`${COLORS.dim}  ${counts.error || 0} error, ${counts.warn || 0} warn, ${counts.info || 0} info${COLORS.reset}`);
  process.exitCode = (counts.error || 0) > 0 ? 1 : 0;
}

async function cmdShow(ref, argv) {
  const { doc, uuid } = await loadRef(ref, argv);
  const tree = new CsbTree(doc);
  const key = getFlag(argv, "--key", null);
  const type = getFlag(argv, "--type", null);
  if (key) {
    const hits = tree.findAllByKey(key);
    if (!hits.length) { console.log(`no node with key "${key}"`); return; }
    for (const h of hits) {
      console.log(`${COLORS.dim}${h.path.join(".")}${COLORS.reset}`);
      console.log(JSON.stringify(h.node, null, 2));
    }
    return;
  }
  if (type) {
    const hits = tree.findByType(type);
    console.log(`${hits.length} node(s) of type "${type}":`);
    for (const h of hits) console.log(`  ${h.node.key || "(no key)"}  ${COLORS.dim}${h.path.join(".")}${COLORS.reset}`);
    return;
  }
  // outline
  let n = 0;
  tree.walk(({ node, path, field }) => {
    n++;
    const depth = path.filter((p) => p === "contents" || p === "rowLayout").length;
    const indent = "  ".repeat(depth);
    const label = node.key ? `${node.type} ${COLORS.dim}#${node.key}${COLORS.reset}` : node.type;
    if (depth <= 3) console.log(`${indent}${label}`);
  });
  console.log(`${COLORS.dim}${n} nodes total (depth>3 hidden; use --type/--key to drill in)${COLORS.reset}`);
}

async function cmdVerify(ref, argv) {
  if (!hasFlag(argv, "--bridge")) { console.error("verify requires --bridge (game must be OPEN)"); process.exit(2); }
  const world = getFlag(argv, "--world", source.DEFAULT_WORLD);
  const { doc, uuid } = await bridge.loadViaBridge(ref, { world });
  const res = await bridge.verify({ body: doc.system.body, header: doc.system.header, uuid }, { world });
  console.log(JSON.stringify(res, null, 2));
  process.exitCode = res.ok ? 0 : 1;
}

async function cmdRoundtrip(ref, argv) {
  if (!hasFlag(argv, "--bridge")) { console.error("roundtrip requires --bridge (game must be OPEN)"); process.exit(2); }
  const world = getFlag(argv, "--world", source.DEFAULT_WORLD);
  const { doc } = await bridge.loadViaBridge(ref, { world });
  const tree = new CsbTree(doc);
  const before = Array.from(tree.propOwningKeys()).sort();
  const res = await bridge.roundtrip({ body: doc.system.body, header: doc.system.header }, { world });
  if (!res.ok) { console.error("roundtrip parse failed:", res.error); process.exit(1); }
  const kept = new Set(res.keptKeys);
  const dropped = before.filter((k) => !kept.has(k));
  console.log(`offline keys: ${before.length}, CSB-kept keys: ${res.keptKeys.length}`);
  if (dropped.length) console.log(paint("warn", `dropped by CSB: ${dropped.join(", ")}`));
  else console.log(paint("green", "✓ no keys dropped on round-trip"));
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const ref = argv[1];
  if (!cmd || hasFlag(argv, "--help") || hasFlag(argv, "-h")) {
    console.log("Usage: csb <lint|show|verify|roundtrip> <Item.ID|id|file.json> [--bridge] [--key K] [--type T] [--world W]");
    process.exit(cmd ? 0 : 2);
  }
  if (!ref) { console.error("missing <ref>"); process.exit(2); }
  try {
    if (cmd === "lint") return await cmdLint(ref, argv);
    if (cmd === "show") return await cmdShow(ref, argv);
    if (cmd === "verify") return await cmdVerify(ref, argv);
    if (cmd === "roundtrip") return await cmdRoundtrip(ref, argv);
    console.error(`unknown command "${cmd}"`); process.exit(2);
  } catch (e) {
    console.error("ERROR:", e.message);
    process.exit(1);
  }
}

main();
