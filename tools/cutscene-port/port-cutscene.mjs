// Cutscene port: turns an approved cutscene mockup's rows into the event the game runs, with nothing re-authored.
//
// A cutscene mockup (E:\...\Resource\Animation\cutscene-kit) is written as the game's own event rows
// (flags["oni-event-system"].eventRows). This tool reads that same rows file and makes:
//   <out>/<id>.event.json      the event exactly as it will be written (rows with the "$" mockup keys stripped)
//   <out>/<id>.gm.js           a GM script that writes it onto the scene (run it with run-gm.mjs, or paste it in a GM macro)
//   <out>/<id>.spec.json       the timeline the mockup promises (row order + timed rows), for parity.mjs
//
// Usage:
//   node tools/cutscene-port/port-cutscene.mjs <rows.js> --lines <lines.json> [--profile hoard] [--edits edits.json]
//        [--out <dir>] [--draft] [--stage-tokens]
//   --draft         port even though some rows still need game work: rows tagged "row" / "art" are left out and
//                   listed (for a sandbox look only, never for the real world)
//   --stage-tokens  the GM script also places the tokens the cutscene expects (sandbox: they don't exist yet)
//
// Rows file contract: CommonJS exporting { PROFILES, build(profile, lines) } where build() returns
//   { id, title, event: { scene, sceneName, tile: {x,y,w,h,name}, startMode, lockMovement, onceOnly, availableWhen },
//     tokens: [{ name, x, y, hidden, actor?, marker? }], sections: [{ id, title, rows }] }
// Coordinates in rows are map pixels on the map IMAGE; the GM script adds the scene's padding where the game wants
// canvas coordinates (Move Token paths, Set Token Position points, Jump To paths). Camera Pan "point" takes image px.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVENT_DIR = resolve(HERE, "../../modules/fabula-ultima-companion/scripts/event-system");
const require = createRequire(import.meta.url);

// ───────── args
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const flag = (k) => argv.includes(k);
const rowsFile = argv.find((a) => !a.startsWith("--") && argv[argv.indexOf(a) - 1]?.startsWith("--") !== true);
if (!rowsFile) { console.error("usage: port-cutscene.mjs <rows.js> --lines <lines.json> [--profile hoard] [--edits edits.json] [--out dir] [--draft] [--stage-tokens]"); process.exit(2); }
const linesFile = opt("--lines"), profileName = opt("--profile", "hoard"), editsFile = opt("--edits");
const outDir = resolve(opt("--out", resolve(dirname(resolve(rowsFile)), "port")));
const DRAFT = flag("--draft"), STAGE_TOKENS = flag("--stage-tokens");

// ───────── build the cutscene from the mockup's own rows file
const lib = require(resolve(rowsFile));
const lines = linesFile ? JSON.parse(readFileSync(linesFile, "utf8")) : {};
if (editsFile) { const ed = JSON.parse(readFileSync(editsFile, "utf8")); for (const e of (Array.isArray(ed) ? ed : ed.edits || [])) if (lines[e.id]) lines[e.id] = { ...lines[e.id], text: String(e.now).replace(/ \/\/ /g, "\n") }; }
const P = lib.PROFILES[profileName]; if (!P) { console.error("no profile " + profileName); process.exit(2); }
const cut = lib.build(P, lines);

// ───────── the game's registered row types (from the row files themselves)
const known = new Set();
for (const f of readdirSync(EVENT_DIR).filter((f) => /^event-(rows-.*|showText-execute|eventRegistry)\.js$/.test(f))) {
  const src = readFileSync(resolve(EVENT_DIR, f), "utf8");
  for (const m of src.matchAll(/register\(\{\s*type:\s*"([A-Za-z]+)"/g)) known.add(m[1]);
  for (const m of src.matchAll(/\btype:\s*"([A-Za-z]+)",\s*\n\s*label:/g)) known.add(m[1]);
  // register({ type: TYPE, … }) with const TYPE = "floatingText"
  const c = src.match(/const\s+TYPE\s*=\s*"([A-Za-z]+)"/); if (c && /register\(\{\s*type:\s*TYPE\b/.test(src)) known.add(c[1]);
}
known.add("showText");

// ───────── walk, check, strip
const CHILD = { showChoices: (r) => (r.options || []).map((o) => ["rows", o]), pauseForGM: (r) => (r.choices || []).map((c) => ["rows", c]),
  condition: (r) => [["thenRows", r], ["elseRows", r]], startBattle: (r) => [["victoryRows", r], ["defeatRows", r]],
  runCheck: (r) => ["successRows", "failureRows", "critRows", "fumbleRows"].map((k) => [k, r]), loop: (r) => [["rows", r]], confirm: (r) => [["yesRows", r], ["noRows", r]] };
const todo = [], dropped = [], unknown = [], warnings = [], skipped = [];   // skipped = mockup rows the event doesn't carry (parity ignores them)
let n = 0;
function clean(rows, where) {
  const out = [];
  let i = 0;
  for (const r of rows || []) {
    if (!r || r.$dir != null) continue;
    i++; const path = `${where}${where.endsWith(":") ? "" : "."}${i}`;
    if (r.$mockOnly) { skipped.push(path); continue; }
    const st = r.$status || "";
    const label = `${path} ${r.type}${r.$id ? " " + r.$id : ""}`;
    if (st === "row" || st === "art") { todo.push({ path, type: r.type, status: st, need: r.$need || "" }); if (DRAFT) { dropped.push(label); skipped.push(path); continue; } }
    if (st === "option") todo.push({ path, type: r.type, status: st, need: r.$need || "" });
    if (st === "data") warnings.push(`${label}: scene data (${r.$need || r.$note || ""}) is not a row; set it on the scene`);
    if (!known.has(r.type) && !(DRAFT && (st === "row" || st === "art"))) unknown.push(label);
    const o = {}; for (const [k, v] of Object.entries(r)) if (!k.startsWith("$")) o[k] = v;
    // branch paths named like the mockup's rows player: C:3.c1.2 (choice 1), F:9.g2.1 (GM button 2), .then/.else/.win/.lose
    const SUB = { thenRows: "then", elseRows: "else", victoryRows: "win", defeatRows: "lose", successRows: "ok", failureRows: "fail", critRows: "crit", fumbleRows: "fumble", yesRows: "yes", noRows: "no", rows: "loop" };
    for (const [key, holder] of (CHILD[r.type]?.(r) || [])) {
      if (holder === r) o[key] = clean(r[key], `${path}.${SUB[key] || key}`);
      else { const idx = (r.options || r.choices).indexOf(holder); const arr = r.type === "showChoices" ? "options" : "choices";
        o[arr] = o[arr].map((x, k) => (k === idx ? { ...x, rows: clean(holder.rows, `${path}.${r.type === "showChoices" ? "c" : "g"}${k + 1}`) } : x)); }
    }
    n++; out.push(o);
  }
  return out;
}
const eventRows = [];
for (const s of cut.sections) eventRows.push(...clean(s.rows, s.id + ":"));

// refuse to port unfinished rows unless --draft
const blocking = todo.filter((t) => t.status === "row" || t.status === "art");
if (blocking.length && !DRAFT) {
  console.error(`REFUSED: ${blocking.length} row(s) still need game work (or pass --draft for a sandbox look):`);
  for (const t of blocking) console.error(`  ${t.path}  ${t.type}  [${t.status}]  ${t.need}`);
  process.exit(1);
}
if (unknown.length) { console.error("REFUSED: row types the game doesn't register:\n  " + unknown.join("\n  ")); process.exit(1); }

// ───────── outputs
mkdirSync(outDir, { recursive: true });
const ev = cut.event;
const event = { id: cut.id, title: cut.title, profile: profileName, sceneId: ev.scene, sceneName: ev.sceneName, tile: ev.tile,
  flags: { isEventTile: true, proximityPx: 0, startMode: ev.startMode || "button", lockMovement: ev.lockMovement !== false, onceOnly: !!ev.onceOnly,
    availableWhen: ev.availableWhen || { kind: "none" }, eventRows },
  tokens: cut.tokens || [], draft: DRAFT, dropped, skipped, todo, warnings, madeAt: new Date().toISOString(), source: basename(rowsFile) };
writeFileSync(resolve(outDir, `${cut.id}.event.json`), JSON.stringify(event, null, 2));

// the timeline the mockup promises: every row in play order with its own duration where the row has one
const spec = [];
for (const s of cut.sections) (function flat(rows, where) { let i = 0; for (const r of rows || []) { if (!r || r.$dir != null) continue; i++; if (r.$mockOnly || (DRAFT && (r.$status === "row" || r.$status === "art"))) continue;
    spec.push({ path: `${where}${i}`, type: r.type, id: r.$id || null, seconds: ["wait", "cameraPan", "screenEffect", "stopBGM"].includes(r.type) ? +r.seconds : r.type === "setToken" ? (+r.fadeMs || 0) / 1000 : null, wait: r.wait ?? null }); } })(s.rows, s.id + ":");
writeFileSync(resolve(outDir, `${cut.id}.spec.json`), JSON.stringify(spec, null, 2));

const gm = readFileSync(resolve(HERE, "gm-write-event.js"), "utf8").replace("const EV = __EVENT__;", () => "const EV = " + JSON.stringify(event) + ";").replace("const STAGE_TOKENS = __STAGE_TOKENS__;", "const STAGE_TOKENS = " + STAGE_TOKENS + ";");
writeFileSync(resolve(outDir, `${cut.id}.gm.js`), gm);

console.log(`${cut.title} · profile ${profileName} · ${n} rows → ${outDir}`);
if (DRAFT) console.log(`DRAFT: ${dropped.length} unfinished row(s) left out:\n  ${dropped.join("\n  ")}`);
const opts = todo.filter((t) => t.status === "option"); if (opts.length) console.log(`New options the game ignores until built (rows kept): ${opts.map((t) => t.path).join(", ")}`);
for (const w of warnings) console.log("note: " + w);
