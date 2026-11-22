#!/usr/bin/env node
"use strict";
// move-engine CLI
//   node tools/move-engine/bin/move-engine.js commands [--md]   every command a move can call, and which host has it
//   node tools/move-engine/bin/move-engine.js check <file...>   can these move files run in the game? (DOM-only helpers, warnings)
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const GB = require("../build/game-build.js");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

// top-level names a file declares (function / async function / const / let), one level deep
function declared(text) {
  const out = new Set();
  // scan statements at brace / paren depth 0 only (so default params and locals do not count)
  let depth = 0, i = 0, stmtStart = true, inStr = null;
  const isId = (c) => /[\w$]/.test(c);
  while (i < text.length) {
    const c = text[i];
    if (inStr) { if (c === "\\") { i += 2; continue; } if (c === inStr) inStr = null; i++; continue; }
    if (c === "/" && text[i + 1] === "/") { const j = text.indexOf("\n", i); i = j < 0 ? text.length : j; continue; }
    if (c === "/" && text[i + 1] === "*") { const j = text.indexOf("*/", i + 2); i = j < 0 ? text.length : j + 2; continue; }
    if (c === '"' || c === "'" || c === "`") { inStr = c; i++; continue; }
    if ("([{".includes(c)) { depth++; i++; continue; }
    if (")]}".includes(c)) { depth = Math.max(0, depth - 1); if (depth === 0 && c === "}") stmtStart = true; i++; continue; }
    if (depth === 0) {
      if (c === ";" || c === "\n") { stmtStart = c === ";" || stmtStart; i++; continue; }
      if (isId(c) && (i === 0 || !isId(text[i - 1]))) {
        const m = /^(?:(async\s+)?function\s+([A-Za-z_$][\w$]*)|(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=(?![=>]))/.exec(text.slice(i, i + 200));
        if (m) { out.add(m[2] || m[3]); i += m[0].length; continue; }
        const word = /^[\w$]+/.exec(text.slice(i))[0]; i += word.length; continue;
      }
      // a further name in a const / let list: ", name = …" at depth 0
      if (c === ",") { const m = /^,\s*([A-Za-z_$][\w$]*)\s*=(?![=>])/.exec(text.slice(i, i + 80)); if (m) { out.add(m[1]); i += m[0].length; continue; } }
    }
    i++;
  }
  return out;
}
const INTERNAL = /^(ME_|me[A-Z]|TRK$|TM$|TL$|KP$|ORG$|toW$|toM$|VT$|PHASE$|REC_ON$|IN_TW$|STEPS$|TWS$|DUE|NATIVE$|CLK$|clkSync$|clockNow$|due|isVideo$|MOVE_HOST$|M$|\$$|SCR$)/;

function commands(md) {
  const shared = { core: declared(rd("shared/core.js")), "fx-core": declared(rd("shared/fx-core.js")), common: declared(rd("shared/common.js")), "fx-melee": declared(rd("shared/fx-melee.js")), moves: declared(rd("shared/moves.js")), results: declared(rd("shared/results.js")) };
  const mock = declared(rd("mockup/engine.js")), game = declared(rd("game/runtime.js")), over = rd("game/overrides.js");
  const rows = [];
  for (const [file, names] of Object.entries(shared)) for (const n of names) {
    const overridden = new RegExp("^" + n + "\\s*=", "m").test(over);
    rows.push({ n, where: "shared/" + file + ".js", mock: "yes", game: GB.UNSUPPORTED.includes(n) ? "NO (refused)" : overridden ? "game version" : "yes" });
  }
  for (const n of new Set([...mock, ...game])) {
    if (INTERNAL.test(n) || rows.some((r) => r.n === n)) continue;
    rows.push({ n, where: "host engine", mock: mock.has(n) ? "yes" : "—", game: !game.has(n) ? "—" : GB.UNSUPPORTED.includes(n) ? "NO (refused)" : "yes" });
  }
  rows.sort((a, b) => a.where.localeCompare(b.where) || a.n.localeCompare(b.n));
  if (md) { console.log("| command | defined in | mockup | game |\n|---|---|---|---|"); for (const r of rows) console.log("| `" + r.n + "` | " + r.where + " | " + r.mock + " | " + r.game + " |"); return; }
  console.log("move-engine " + /MOVE_ENGINE_VERSION = "([^"]+)"/.exec(rd("shared/core.js"))[1] + " · " + rows.length + " names\n");
  for (const r of rows) console.log(r.n.padEnd(22) + r.where.padEnd(22) + ("mockup " + r.mock).padEnd(14) + "game " + r.game);
}

function check(files) {
  const r = GB.checkMoveSource(files);
  for (const e of r.errors) console.log("ERROR  " + e);
  for (const w of r.warnings) console.log("warn   " + w);
  console.log(r.errors.length ? "→ not buildable for the game" : "→ ok for the game" + (r.warnings.length ? " (with warnings)" : ""));
  process.exit(r.errors.length ? 1 : 0);
}

// parity <family> [moves…] [--cpu] [--no-game] [--code <gitref>] [--out <dir>]
async function parityCmd(rest) {
  const flags = new Set(rest.filter((a) => a.startsWith("--")));
  const val = (k) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : null; };
  const pos = rest.filter((a, i) => !a.startsWith("--") && !["--code", "--out"].includes(rest[i - 1]));
  const [family, ...keys] = pos;
  if (!family) { console.log("usage: move-engine.js parity <family> [moves…] [--cpu] [--no-game] [--code <gitref>] [--out <dir>]"); process.exit(1); }
  const { parity } = require("../lib/parity.js");
  const r = await parity(family, keys, { gpu: !flags.has("--cpu"), game: !flags.has("--no-game"), code: val("--code"), out: val("--out") });
  for (const m of r.moves) console.log((m.ok ? "PASS " : "FAIL ") + m.key + (m.reasons.length ? "  · " + m.reasons.join("; ") : ""));
  console.log("report: " + r.report);
  process.exit(r.ok ? 0 : 1);
}

// export <family> [skill…] [--check [--code <ref>] [--snapshot <dir> --port <n>]] [--write <migration-key> --desc "<text>"]
async function exportCmd(rest) {
  const val = (k) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : null; };
  const pos = rest.filter((a, i) => !a.startsWith("--") && !["--code", "--write", "--desc", "--out", "--snapshot", "--port"].includes(rest[i - 1]));
  const [family, ...keys] = pos;
  if (!family) { console.log("usage: move-engine.js export <family> [skill…] [--check [--code <ref>] [--snapshot <dir> --port <n>]] [--write <key> --desc <text>]"); process.exit(1); }
  const SE = require("../lib/skill-export.js");
  const resolved = SE.resolve(family, keys);
  for (const [name, r] of Object.entries(resolved)) {
    console.log("\n" + name + " → " + r.block.doc.name + " (" + r.block.doc.id + ")" + (r.move ? " · sliders of move " + r.move : ""));
    for (const b of r.bound) console.log("   slider " + b.slider + " = " + b.value + "  →  " + b.path + " = " + JSON.stringify(b.set));
  }
  let ok = true;
  if (rest.includes("--check")) {
    const outDir = val("--out") || path.join(ROOT, "out", "export", family);
    console.log("\nchecking against the world (snapshot runner, after its migrations)…");
    const r = SE.check(family, keys, { code: val("--code"), outDir, ...(val("--snapshot") ? { snapshot: val("--snapshot") } : {}), ...(val("--port") ? { port: Number(val("--port")) } : {}) });
    for (const res of r.results) {
      if (!res.found) { console.log("  ✗ " + res.name + ": not in the world"); ok = false; continue; }
      for (const c of res.copies) { const where = (c.parent ? c.parent + " / " : "") + res.name + " (" + c.id + ")";
        if (!c.diffs.length) console.log("  = " + where + ": every logic field matches");
        else { ok = false; console.log("  ~ " + where + ": " + c.diffs.length + " field(s) differ"); for (const d of c.diffs) console.log("      " + d.field + ": game " + JSON.stringify(d.game) + "  block " + JSON.stringify(d.block)); } }
      const v = r.validation[res.name] || []; console.log("    validator: " + (v.length ? v.join(" | ") : "clean"));
    }
  }
  const key = val("--write");
  if (key) { const f = SE.writeMigration(family, keys, { key, description: val("--desc") || "move-engine skill export" }); console.log("\nwrote " + f + " (+ _manifest.json)"); }
  process.exit(ok ? 0 : 1);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "export") exportCmd(rest).catch((e) => { console.error(e); process.exit(2); });
else if (cmd === "commands") commands(rest.includes("--md"));
else if (cmd === "check") check(rest);
else if (cmd === "parity") parityCmd(rest).catch((e) => { console.error(e); process.exit(2); });
else { console.log("usage: move-engine.js commands [--md] | check <move files...> | parity <family> [moves…] [--cpu] [--no-game] [--code <ref>] [--out <dir>]"); process.exit(cmd ? 1 : 0); }
