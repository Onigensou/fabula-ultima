// read-world — build the runner's world data from the files on disk. NO Foundry, NO world
// launch: the documents come straight from the world's LevelDB (read from a temp copy, so
// the live world's files are never opened or touched), and the /game page's script and
// style tags are generated from the package manifests with the server's own ordering rule.
//
//   node tools/snapshot-runner/bin/read-world.mjs [--world fabula-ultima-2]
//   -> source/world-full.json  (same shape as the server's connect payload)
//      source/game.html        (the /game page for the modules active in that world)
//
// What still comes from a one-time capture (shell/): the parts of the payload that are
// properties of the Foundry INSTALL, not of the world: release, model, the page skeleton,
// pack indexes. They change only with a Foundry/system upgrade. Refresh them with
// `node bin/read-world.mjs --init-shell` after a capture.
import { fileURLToPath } from "node:url";
import { dirname, resolve, join, posix } from "node:path";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import os from "node:os";
import { foundryApp } from "../lib/foundry-app.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = resolve(HERE, "..");
const DATA = resolve(TOOL, "../..");
const require = createRequire(import.meta.url);
const { ClassicLevel } = require(resolve(DATA, "tools/safe-edit/node_modules/classic-level"));
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const WORLD = arg("--world", "fabula-ultima-2");
const SHELL = resolve(TOOL, "shell");
const OUT = resolve(TOOL, "source");
const mb = (n) => (n / 1048576).toFixed(1) + " MB";

// Payload keys that are documents (read from LevelDB). Everything else is the shell.
const COLLECTIONS = ["actors", "cards", "combats", "folders", "items", "journal", "macros", "messages", "playlists", "scenes", "settings", "tables", "users"];

// ------------------------------------------------------------------ shell (one-time)
if (process.argv.includes("--init-shell")) {
  const cap = JSON.parse(readFileSync(resolve(TOOL, "capture", "world-full.json"), "utf8"));
  const shell = Object.fromEntries(Object.entries(cap).filter(([k]) => !COLLECTIONS.includes(k)));
  // shell/ ships in the repo: the server's network addresses (a public IP) must not
  shell.addresses = { local: "http://localhost:30000/", remote: null, remoteIsAccessible: false };
  mkdirSync(SHELL, { recursive: true });
  writeFileSync(resolve(SHELL, "shell.json"), JSON.stringify(shell));
  const html = readFileSync(resolve(TOOL, "capture", "game.html"), "utf8");
  writeFileSync(resolve(SHELL, "game.html"), html);
  console.log(`[read-world] shell written from capture/ (${Object.keys(shell).join(", ")})`);
  process.exit(0);
}
if (!existsSync(resolve(SHELL, "shell.json"))) throw new Error("no shell/shell.json: run `node bin/read-world.mjs --init-shell` once after a capture");
const shell = JSON.parse(readFileSync(resolve(SHELL, "shell.json"), "utf8"));

// ------------------------------------------------------------------ documents
const t0 = Date.now();
const SRC = resolve(DATA, "worlds", WORLD);
const scratch = mkdtempSync(join(os.tmpdir(), "sbx-read-"));
const parseKey = (k) => { const m = /^!([^!]+)!(.+)$/s.exec(k); return m && { path: m[1].split("."), ids: m[2].split(".") }; };

async function readCollection(name) {
  const src = join(SRC, "data", name);
  if (!existsSync(src)) return [];
  const dst = join(scratch, name);
  cpSync(src, dst, { recursive: true, filter: (p) => !/[\\/]LOCK$/.test(p) });
  const db = new ClassicLevel(dst, { keyEncoding: "utf8", valueEncoding: "utf8" });
  await db.open({ createIfMissing: false });
  const rows = [];
  for await (const [k, v] of db.iterator()) { const p = parseKey(k); if (p) rows.push({ ...p, doc: JSON.parse(v) }); }
  await db.close();
  return rows;
}

/** Rebuild documents from their keys. A stored parent lists its embedded children by id
 *  (an array of ids, or one id for a singleton such as a token's delta); each id is swapped
 *  for the child document, keeping the listed order. Shallow levels first, so a child can
 *  find its (already swapped-in) parent. */
function assemble(rows) {
  const tops = new Map();
  const deeper = [];
  for (const r of rows) (r.path.length === 1 ? tops.set(r.ids[0], r.doc) : deeper.push(r));
  deeper.sort((a, b) => a.path.length - b.path.length);
  let orphans = 0, unlisted = 0;
  for (const r of deeper) {
    let parent = tops.get(r.ids[0]);
    for (let d = 1; parent && d < r.path.length - 1; d++) {
      const v = parent[r.path[d]];
      parent = Array.isArray(v) ? v.find((x) => x?._id === r.ids[d]) : (v?._id === r.ids[d] ? v : null);
    }
    if (!parent) { orphans++; continue; }
    const field = r.path[r.path.length - 1], id = r.ids[r.ids.length - 1], cur = parent[field];
    // A stored child its parent does not list is NOT part of the document: the server
    // ignores it (seen: party tokens and a hand-written effect left as bare keys).
    if (Array.isArray(cur)) { const i = cur.indexOf(id); if (i >= 0) cur[i] = r.doc; else unlisted++; }
    else if (cur === id || cur?._id === id) parent[field] = r.doc;   // singleton (token.delta)
    else unlisted++;
  }
  let dangling = 0;                                 // listed ids with no stored child: dropped
  const sweep = (doc) => {
    for (const [k, v] of Object.entries(doc)) {
      if (Array.isArray(v) && EMBEDDED.has(k)) {
        const kept = v.filter((x) => typeof x !== "string"); dangling += v.length - kept.length; doc[k] = kept;
        for (const c of kept) if (c && typeof c === "object") sweep(c);
      } else if (k === "delta" && v && typeof v === "object") sweep(v);
    }
  };
  for (const doc of tops.values()) sweep(doc);
  return { docs: [...tops.values()], orphans, unlisted, dangling };
}
const EMBEDDED = new Set(["items", "effects", "pages", "results", "sounds", "cards", "combatants", "tokens", "tiles", "walls", "drawings", "lights", "notes", "regions", "behaviors", "templates"]);

// The server's order (matched against a capture): by name in code-unit order, stable over
// key order; messages by timestamp; users GMs first; journal, macros, settings in key order.
// Order is observable: getName() and find() return the FIRST match among duplicate names.
const cu = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byName = (a, b) => cu(a.name ?? "", b.name ?? "");
function order(c, docs) {
  if (["journal", "macros", "settings"].includes(c)) return docs;
  if (c === "messages") return docs.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  if (c === "users") return docs.sort((a, b) => ((b.role >= 3) - (a.role >= 3)) || byName(a, b));
  return docs.sort(byName);
}
const out = {};
const stats = {};
try {
  for (const c of COLLECTIONS) {
    const rows = await readCollection(c);
    const { docs, orphans, unlisted, dangling } = assemble(rows);
    out[c] = order(c, docs);
    stats[c] = { keys: rows.length, docs: docs.length, ...(orphans ? { orphans } : {}), ...(unlisted ? { unlisted } : {}), ...(dangling ? { dangling } : {}) };
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }

// Users: the server never sends password material to clients.
for (const u of out.users) { delete u.password; delete u.passwordSalt; }

// ------------------------------------------------------------------ packages
const settingVal = (key) => { const s = out.settings.find((x) => x.key === key); try { return s ? JSON.parse(s.value) : undefined; } catch { return undefined; } };
const moduleConfig = settingVal("core.moduleConfiguration") ?? {};
const PUBLIC = resolve(foundryApp(), "public");   // this machine's Foundry install (lib/foundry-app.mjs)
const isUrl = (p) => /^(https?:)?\/\//.test(p);
const std = (p) => posix.normalize(String(p).replace(/\\/g, "/")).replace(/^(\.\/|\/)+/, "");
/** The server's PackageAssetField: try the package folder, then (scripts only) core's
 *  public/scripts; the first that exists wins, else the package path. */
function asset(type, id, p, publicDir) {
  if (!p || isUrl(p)) return p;
  const rel = std(p);
  const cands = [{ root: DATA, client: `${type}s/${id}/${rel}` }];
  if (publicDir) cands.push({ root: PUBLIC, client: `${publicDir}/${rel}` });
  return (cands.find((c) => existsSync(resolve(c.root, c.client))) ?? cands[0]).client;
}
const prefix = (type, id, p) => asset(type, id, p, null);
const bool = (v) => v === true || v === "true";
/** A manifest on disk, normalized the way the server normalizes it: paths package-relative
 *  -> Data-relative, booleans coerced, missing collections defaulted. Unlisted fields keep
 *  the shell's value. */
function normalize(type, disk, prev) {
  const id = disk.id ?? disk.name;
  const e = structuredClone(prev ?? {});
  // Text/compat fields the server re-cleans: keep the shell's form when there is one.
  for (const k of prev ? ["version"] : ["title", "description", "version", "compatibility", "url", "manifest", "download"]) if (k in disk) e[k] = disk[k];
  for (const k of ["socket", "library"]) if (k in disk) e[k] = bool(disk[k]);
  e.id = id;
  e.scripts = [...new Set((disk.scripts ?? []).map((p) => asset(type, id, p, "scripts")))];
  e.esmodules = [...new Set((disk.esmodules ?? []).map((p) => asset(type, id, p, "scripts")))];
  e.styles = [...new Set((disk.styles ?? []).map((p) => asset(type, id, p, null)))];
  e.languages = (disk.languages ?? []).map((l) => ({ ...l, path: prefix(type, id, l.path), flags: l.flags ?? {} }));
  for (const [k, d] of [["flags", {}], ["media", []], ["packs", []], ["packFolders", []], ["tags", []], ["authors", []]]) e[k] ??= d;
  return e;
}
const readManifest = (dir, file) => { try { return JSON.parse(readFileSync(join(dir, file), "utf8")); } catch { return null; } };
const shellModules = new Map((shell.modules ?? []).map((m) => [m.id, m]));
const modules = [];
const missing = [];
// The server lists installed modules in directory order (NTFS: case-insensitive, by upper-case code unit).
const upper = (s) => s.toUpperCase();
for (const id of readdirSync(resolve(DATA, "modules")).sort((a, b) => (upper(a) < upper(b) ? -1 : upper(a) > upper(b) ? 1 : 0))) {
  const disk = readManifest(resolve(DATA, "modules", id), "module.json");
  if (!disk || (disk.id ?? disk.name) !== id) continue;
  // a module for another game system is not offered to this world at all
  const sys = [...(disk.relationships?.systems ?? []).map((x) => x.id ?? x), ...(Array.isArray(disk.systems) ? disk.systems : [])];
  if (sys.length && !sys.includes(shell.system.id)) continue;
  const prev = shellModules.get(id);
  if (!prev) missing.push(id);
  const e = normalize("module", disk, prev ?? { ...structuredClone(shell.modules[0]), relationships: { systems: [], requires: [], recommends: [], conflicts: [], flags: {} } });
  e.active = moduleConfig[id] === true;
  modules.push(e);
}
const sysDisk = readManifest(resolve(DATA, "systems", shell.system.id), "system.json");
const system = sysDisk ? normalize("system", sysDisk, shell.system) : shell.system;
const worldDisk = readManifest(SRC, "world.json") ?? {};
// The world entry: the shell's (server-cleaned) form, with what an author can change on disk.
const world = { ...shell.world };
for (const k of ["title", "description", "background"]) if (k in worldDisk) world[k] = worldDisk[k];
const packNames = (ps) => (ps ?? []).map((p) => p.name).sort().join();
if (packNames(worldDisk.packs) !== packNames(shell.world.packs)) {
  world.packs = (worldDisk.packs ?? []).map((p) => ({ ...p, path: prefix("world", WORLD, p.path), flags: p.flags ?? {} }));
  console.log("  world packs changed since the shell: taken from world.json (pack indexes are still the shell's)");
}

const payload = { ...shell, world, system, modules, ...out };
payload.activeUsers = shell.activeUsers ?? [];
mkdirSync(OUT, { recursive: true });
const json = JSON.stringify(payload);
writeFileSync(resolve(OUT, "world-full.json"), json);

// ------------------------------------------------------------------ the /game page
// Server rule (dist/server/views/view.mjs _getStaticContent): tags sorted (stable) by priority.
// scripts: core 0, core modules 1, foundry-esm/foundry.js 2, library scripts 3 / esm 4,
// system scripts 5 / esm 6, module scripts 7 / esm 8, world scripts 9 / esm 10.
// styles:  library 0, core 1, system 2, module 3, world 4.
const skel = readFileSync(resolve(SHELL, "game.html"), "utf8");
const a = skel.indexOf("<!-- Included Stylesheets -->"), b = skel.indexOf("<!-- Global Variables -->");
if (a < 0 || b < 0) throw new Error("shell/game.html: page markers not found");
const region = skel.slice(a, b);
const tags = [...region.matchAll(/<(link|script)\b[^>]*?(?:href|src)="([^"]+)"[^>]*>/g)].map((m) => ({ kind: m[1], src: m[2], module: /type="module"/.test(m[0]) }));
const isPkg = (s) => /^(modules|systems|worlds)\//.test(s);
const scripts = [], styles = [];
const add = (list, src, type, pri) => list.push({ src, type, pri });
// Core scripts are everything up to scripts/foundry.js (a package script can resolve to a
// core path such as scripts/greensock/..., so the path alone does not say "core").
const lastCore = tags.findIndex((t) => t.kind === "script" && t.src === "scripts/foundry.js");
for (const t of tags.slice(0, lastCore + 1).filter((t) => t.kind === "script" && !isPkg(t.src))) {
  const pri = /^scripts\/foundry(-esm)?\.js$/.test(t.src) ? 2 : t.module ? 1 : 0;
  add(scripts, t.src, t.module ? "module" : "script", pri);
}
for (const t of tags.filter((t) => t.kind === "link" && !isPkg(t.src))) add(styles, t.src, "style", 1);
system.esmodules.forEach((s) => add(scripts, s, "module", 6));
system.scripts.forEach((s) => add(scripts, s, "script", 5));
system.styles.forEach((s) => add(styles, s, "style", 2));
for (const m of modules) {
  if (!m.active) continue;
  const lib = !!m.library;
  m.esmodules.forEach((s) => add(scripts, s, "module", lib ? 4 : 8));
  m.scripts.forEach((s) => add(scripts, s, "script", lib ? 3 : 7));
  m.styles.forEach((s) => add(styles, s, "style", lib ? 0 : 3));
}
world.esmodules?.forEach((s) => add(scripts, prefix("world", WORLD, s), "module", 10));
world.scripts?.forEach((s) => add(scripts, prefix("world", WORLD, s), "script", 9));
world.styles?.forEach((s) => add(styles, prefix("world", WORLD, s), "style", 4));
const byPri = (x, y) => x.pri - y.pri;
scripts.sort(byPri); styles.sort(byPri);
const cssTag = (s) => `    <link href="${s.src}" rel="stylesheet" type="text/css" media="all">`;
const jsTag = (s) => `    <script defer src="${s.src}"${s.type === "module" ? ' type="module"' : ""}></script>`;
const newRegion = `<!-- Included Stylesheets -->\n${styles.map(cssTag).join("\n")}\n\n    <!-- Included Scripts -->\n${scripts.map(jsTag).join("\n")}\n\n    `;
writeFileSync(resolve(OUT, "game.html"), skel.slice(0, a) + newRegion + skel.slice(b));

writeFileSync(resolve(OUT, "source-meta.json"), JSON.stringify({ builtAt: new Date().toISOString(), world: WORLD, bytes: json.length, collections: stats, activeModules: modules.filter((m) => m.active).length, modulesNotInShell: missing }, null, 2));
console.log(`[read-world] ${WORLD}: ${mb(json.length)} in ${Date.now() - t0} ms — ${COLLECTIONS.map((c) => `${c} ${stats[c].docs}`).join(", ")}`);
for (const [c, s] of Object.entries(stats)) if (s.orphans || s.unlisted || s.dangling) console.log(`  ${c}: ignored ${s.orphans ?? 0} orphaned + ${s.unlisted ?? 0} unlisted embedded keys; dropped ${s.dangling ?? 0} listed ids with no document`);
if (missing.length) console.log(`  modules not in the shell (defaults guessed): ${missing.join(", ")}`);
console.log(`  page: ${scripts.length} scripts, ${styles.length} styles, ${modules.filter((m) => m.active).length} active modules`);
