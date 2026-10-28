#!/usr/bin/env node
// ============================================================================
// tools/forge-mirror/sync.mjs — keeps Data/forge-mirror/ a local copy of every
// Forge file the game uses, so players can load them from the host instead of
// from Forge (docs/investigations/player-reloads: the first Forge download of a
// file crawls for some ISPs; the same file from the host takes ~1 s).
//
// Forge stays the source of truth: world data and code keep their Forge URLs.
// The module's forge-mirror client redirects a URL only when this mirror holds
// that exact file (manifest.json).
//
// Usage (Foundry may be open or closed):
//   node tools/forge-mirror/sync.mjs [--data <Data dir>] [--local <dir>]... [--verify] [--dry-run] [--concurrency 12]
//
// What it mirrors (the "wanted" list):
//   - forge-mirror/wanted.json — written by the primary GM's client each session:
//     every Forge URL in the world data, plus Forge URLs clients met at runtime
//     that were not mirrored yet;
//   - Forge URLs written in the module's scripts, including simple
//     BASE + "path" and `${BASE}/path` forms;
//   - everything already in manifest.json (kept until --prune).
//
// For each wanted file not mirrored yet (or whose ?v= changed, or all with --verify):
//   HEAD Forge → MD5 (Forge's etag is the MD5 of the stored file) → copy a local
//   original with the same name AND the same MD5 (from --local dirs or
//   forge-mirror/config.json "localRoots"), otherwise download from Forge.
//
// Writes (all under Data/forge-mirror/, which git ignores):
//   <account>/<path>   the files
//   manifest.json      { version, generated, files: { "<account>/<path>": { size, md5, q } } }
//   broken.json        wanted URLs whose Forge file no longer exists (404)
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FORGE_HOST = "https://assets.forge-vtt.com/";
const FORGE_RE = /https:\/\/assets\.forge-vtt\.com\/[^\s"'`<>\\]+/g;
const BAD_WIN_CHARS = /[<>:"|?*\x00-\x1f]/;

// ── arguments ───────────────────────────────────────────────────────────────
const args = { local: [] };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === "--verify" || a === "--dry-run" || a === "--prune") args[a.slice(2)] = true;
  else if (a === "--local") args.local.push(process.argv[++i]);
  else if (a.startsWith("--")) args[a.slice(2)] = process.argv[++i];
}
const DATA = path.resolve(args.data ?? path.join(HERE, "..", ".."));
const MIRROR = path.join(DATA, "forge-mirror");
const MODULE_SCRIPTS = path.join(DATA, "modules", "fabula-ultima-companion", "scripts");
const CONCURRENCY = Number(args.concurrency ?? 12);

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } };
const writeJsonAtomic = (file, value) => { fs.writeFileSync(file + ".part", JSON.stringify(value, null, 1)); fs.renameSync(file + ".part", file); };
const md5File = file => crypto.createHash("md5").update(fs.readFileSync(file)).digest("hex");
const log = (...a) => console.log("[forge-mirror]", ...a);

// ── URL ⇄ key ────────────────────────────────────────────────────────────────
// key = "<account>/<decoded path>", the same string the client computes.
function parseForgeUrl(url) {
  if (!url?.startsWith(FORGE_HOST)) return null;
  let u;
  try { u = new URL(url.replace(/[),;]+$/, "")); } catch { return null; }
  let key;
  try { key = decodeURIComponent(u.pathname.replace(/^\/+/, "")); } catch { return null; }
  if (!key.includes("/") || key.endsWith("/")) return null;          // an account root or a folder, not a file
  return { key, q: u.searchParams.get("v"), url: FORGE_HOST + u.pathname.replace(/^\/+/, "") };
}

// ── what to mirror ───────────────────────────────────────────────────────────
function urlsFromScripts(dir) {
  const out = new Set();
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.m?js$/.test(e.name)) {
        const text = fs.readFileSync(full, "utf8");
        for (const m of text.match(FORGE_RE) ?? []) out.add(m);
        // BASE constants: const X = "https://assets.forge-vtt.com/..."; const Y = X + "sub/"; const Z = `${X}/sub`;
        const bases = new Map();
        for (const m of text.matchAll(/const\s+([A-Z_][A-Z0-9_]*)\s*=\s*["'`](https:\/\/assets\.forge-vtt\.com\/[^"'`$]*)["'`]/g)) bases.set(m[1], m[2]);
        for (let pass = 0; pass < 3; pass++) {
          for (const m of text.matchAll(/const\s+([A-Z_][A-Z0-9_]*)\s*=\s*([A-Z_][A-Z0-9_]*)\s*\+\s*["']([^"']*)["']/g)) if (bases.has(m[2])) bases.set(m[1], bases.get(m[2]) + m[3]);
          for (const m of text.matchAll(/const\s+([A-Z_][A-Z0-9_]*)\s*=\s*`\$\{([A-Z_][A-Z0-9_]*)\}([^`$]*)`/g)) if (bases.has(m[2])) bases.set(m[1], bases.get(m[2]) + m[3]);
        }
        for (const [name, base] of bases) {
          for (const m of text.matchAll(new RegExp(`\\b${name}\\s*\\+\\s*["']([^"']+)["']`, "g"))) out.add(base + m[1]);
          for (const m of text.matchAll(new RegExp("`\\$\\{" + name + "\\}([^`$]+)`", "g"))) out.add(base + m[1]);
        }
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

function collectWanted(manifest) {
  const wanted = new Map();   // key -> { url, q, from:Set }
  const add = (raw, from) => {
    const p = parseForgeUrl(raw);
    if (!p) return;
    const cur = wanted.get(p.key);
    if (cur) { cur.from.add(from); if (p.q && !cur.q) cur.q = p.q; }
    else wanted.set(p.key, { url: p.url, q: p.q, from: new Set([from]) });
  };
  const w = readJson(path.join(MIRROR, "wanted.json"), {});
  for (const u of w.world ?? []) add(typeof u === "string" ? u : u.url, "world");
  for (const u of w.runtime ?? []) add(typeof u === "string" ? u : u.url, "runtime");
  for (const u of urlsFromScripts(MODULE_SCRIPTS)) add(u, "code");
  if (!args.prune) for (const key of Object.keys(manifest.files ?? {})) if (!wanted.has(key)) wanted.set(key, { url: FORGE_HOST + key.split("/").map(encodeURIComponent).join("/"), q: manifest.files[key].q ?? null, from: new Set(["kept"]) });
  return { wanted, wantedFileAge: w.generated ?? null };
}

// ── local originals (same name + same MD5 only) ─────────────────────────────
function indexLocal(roots) {
  const byName = new Map();
  const walk = d => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith("$") || e.name === "node_modules" || e.name === ".git") continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else {
        const k = e.name.toLowerCase();
        if (!byName.has(k)) byName.set(k, []);
        byName.get(k).push(full);
      }
    }
  };
  for (const r of roots) if (r && fs.existsSync(r)) walk(r);
  return byName;
}

// ── Forge ───────────────────────────────────────────────────────────────────
async function headForge(url) {
  const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(60000) });
  const et = res.headers.get("etag");
  const md5 = et && /^(W\/)?"?[0-9a-f]{32}"?$/i.test(et) ? et.replace(/^W\//, "").replace(/"/g, "").toLowerCase() : null;
  return { status: res.status, md5 };
}
async function download(url, dest) {
  const res = await fetch(url, { signal: AbortSignal.timeout(300000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const hash = crypto.createHash("md5");
  const part = dest + ".part";
  const fh = fs.openSync(part, "w");
  let size = 0;
  try {
    for await (const chunk of res.body) { hash.update(chunk); fs.writeSync(fh, chunk); size += chunk.length; }
  } finally { fs.closeSync(fh); }
  fs.renameSync(part, dest);
  return { size, md5: hash.digest("hex") };
}

// ── main ────────────────────────────────────────────────────────────────────
const t0 = Date.now();
fs.mkdirSync(MIRROR, { recursive: true });
const manifestFile = path.join(MIRROR, "manifest.json");
const manifest = readJson(manifestFile, { version: 1, files: {} });
manifest.files ??= {};
const config = readJson(path.join(MIRROR, "config.json"), {});
const localRoots = [...args.local, ...(config.localRoots ?? [])];
const { wanted, wantedFileAge } = collectWanted(manifest);
log(`data ${DATA}`);
log(`wanted ${wanted.size} files (wanted.json from ${wantedFileAge ?? "nowhere — run a GM session first"}), mirrored ${Object.keys(manifest.files).length}`);

// Forge paths are case-sensitive, Windows paths are not: keys that differ only by case
// (Item Icon/boot.png vs Boot.png — different pictures) can't share a folder. The first
// key of each group keeps its natural path; the others live under _case/ and the
// manifest records that file so the client loads the right one.
const altFile = new Map();   // key -> "_case/<hash>.<ext>"
{
  const groups = new Map();
  for (const key of wanted.keys()) {
    const l = key.toLowerCase();
    if (!groups.has(l)) groups.set(l, []);
    groups.get(l).push(key);
  }
  for (const keys of groups.values()) {
    if (keys.length < 2) continue;
    keys.sort();
    for (const key of keys.slice(1)) altFile.set(key, `_case/${crypto.createHash("md5").update(key).digest("hex").slice(0, 16)}${path.extname(key).toLowerCase()}`);
  }
}
const relFileOf = key => altFile.get(key) ?? key;
const setEntry = (key, size, md5, q) => {
  manifest.files[key] = { size, md5, q: q ?? null, ...(altFile.has(key) ? { file: altFile.get(key) } : {}) };
};

// references already known to be gone from Forge are re-checked only with --verify
const knownBroken = new Set((readJson(path.join(MIRROR, "broken.json"), {}).broken ?? []).map(b => parseForgeUrl(b.url)?.key));
const todo = [];
const carriedBroken = [];
for (const [key, w] of wanted) {
  if (!args.verify && knownBroken.has(key)) { carriedBroken.push({ url: w.url, from: [...w.from] }); continue; }
  const have = manifest.files[key];
  const rel = relFileOf(key);
  const file = path.join(MIRROR, ...rel.split("/"));
  const fresh = have && (have.file ?? key) === rel && (have.q ?? null) === (w.q ?? null) && fs.existsSync(file) && fs.statSync(file).size === have.size;
  if (args.verify || !fresh) todo.push([key, w, file]);
}
log(`to check: ${todo.length}${args.verify ? " (verify all)" : ""}`);
if (args["dry-run"]) { log("dry run — nothing written"); process.exit(0); }

const byName = todo.length && localRoots.length ? indexLocal(localRoots) : new Map();
if (localRoots.length) log(`local originals from: ${localRoots.join(" | ")}`);
const stats = { unchanged: 0, copied: 0, downloaded: 0, broken: 0, skipped: 0, failed: 0, md5Mismatch: 0, bytes: 0 };
const broken = [...carriedBroken];
let done = 0;

async function handle([key, w, file]) {
  try {
    if (key.split("/").some(seg => BAD_WIN_CHARS.test(seg))) { stats.skipped++; return; }
    const head = await headForge(w.url + (w.q ? `?v=${w.q}` : ""));
    if (head.status === 404 || head.status === 403) { stats.broken++; broken.push({ url: w.url, from: [...w.from] }); return; }
    if (head.status >= 400) throw new Error(`HEAD ${head.status}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // already here and identical?
    if (head.md5 && fs.existsSync(file) && md5File(file) === head.md5) {
      setEntry(key, fs.statSync(file).size, head.md5, w.q);
      stats.unchanged++; return;
    }
    // a local original with the same name and the same MD5?
    if (head.md5) {
      for (const cand of byName.get(path.basename(key).toLowerCase()) ?? []) {
        if (md5File(cand) === head.md5) {
          fs.copyFileSync(cand, file + ".part"); fs.renameSync(file + ".part", file);
          const size = fs.statSync(file).size;
          setEntry(key, size, head.md5, w.q);
          stats.copied++; stats.bytes += size; return;
        }
      }
    }
    // otherwise download
    const got = await download(w.url + (w.q ? `?v=${w.q}` : ""), file);
    if (head.md5 && got.md5 !== head.md5) stats.md5Mismatch++;   // e.g. the CDN re-encoded it; still the bytes players get
    setEntry(key, got.size, got.md5, w.q);
    stats.downloaded++; stats.bytes += got.size;
  } catch (e) {
    stats.failed++;
    if (stats.failed <= 10) log(`failed ${key}: ${e.message}`);
  } finally {
    if (++done % 250 === 0) log(`${done}/${todo.length}`);
  }
}

let next = 0;
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, async () => { while (next < todo.length) await handle(todo[next++]); }));

for (const b of broken) delete manifest.files[parseForgeUrl(b.url)?.key];
manifest.version = 1;
manifest.generated = new Date().toISOString();
writeJsonAtomic(manifestFile, manifest);
writeJsonAtomic(path.join(MIRROR, "broken.json"), { generated: manifest.generated, count: broken.length, broken });

const total = Object.values(manifest.files).reduce((a, f) => a + f.size, 0);
log(`done in ${Math.round((Date.now() - t0) / 1000)} s — ${JSON.stringify(stats)}`);
log(`mirror: ${Object.keys(manifest.files).length} files, ${(total / 1048576).toFixed(0)} MB; broken references: ${broken.length} (forge-mirror/broken.json)`);
