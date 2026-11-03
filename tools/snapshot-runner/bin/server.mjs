// snapshot-runner server — a static file server that stands in for the Foundry server.
//
// It serves Foundry's own client files and our Data/ tree, plus the snapshot's /game page
// with socket.io swapped for www/fake-io.js. No world, no LevelDB: the world data is the
// snapshot file. File browse/upload (the test-bridge, logs) land in runtime/, never Data/.
//
//   node tools/snapshot-runner/bin/server.mjs [--port 30101] [--code <gitref>] [--snapshot <dir>]
// --code serves OUR module (modules/fabula-ultima-companion) as it was at a git ref, so the
// same snapshot can be run on two versions of the code (A/B, no world involved).
import http from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join, extname, normalize, sep } from "node:path";
import { existsSync, readFileSync, statSync, createReadStream, readdirSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { foundryApp } from "../lib/foundry-app.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = resolve(HERE, "..");
const DATA = resolve(TOOL, "../..");
const CFG = JSON.parse(readFileSync(resolve(TOOL, "runner.config.json"), "utf8"));
const APP = foundryApp();   // this machine's Foundry install (lib/foundry-app.mjs)
const PUBLIC = resolve(APP, "public");
const APP_COMMON = resolve(APP, "common");
const APP_TEMPLATES = resolve(APP, "templates");
const NODE_MODULES = resolve(APP, "node_modules");
// /scripts/* vendor mounts, copied from Foundry's express server
const VENDOR = ["handlebars/dist", "handlebars-intl/dist", "jquery/dist", "pixi.js/dist", "@pixi/particle-emitter/dist",
  "@pixi/graphics-smooth/dist", "@pixi/basis/dist", "@pixi/basis/assets", "simple-peer", "socket.io-client/dist", "tinymce", "showdown/dist", "spark-md5"];
const WWW = resolve(TOOL, "www");
const RUNTIME = resolve(TOOL, "runtime");
const sni = process.argv.indexOf("--snapshot");
const SNAP_DIR = resolve(TOOL, sni > 0 ? process.argv[sni + 1] : "snapshot");
const SNAP = resolve(SNAP_DIR, "world.json");
const pi = process.argv.indexOf("--port");
const PORT = Number(pi > 0 ? process.argv[pi + 1] : CFG.port || 30101);
const WORLD_PREFIX = `worlds/${CFG.worldId}/`;
mkdirSync(RUNTIME, { recursive: true });

// ---- --code <gitref>: our module from a commit, extracted once per commit into code/<sha>/
const MOD = "modules/fabula-ultima-companion";
const ci = process.argv.indexOf("--code");
const CODE_REF = ci > 0 ? process.argv[ci + 1] : (process.env.RUNNER_CODE || null);
let CODE = null;          // { ref, sha, dir }
if (CODE_REF) {
  const sha = execSync(`git rev-parse --verify "${CODE_REF}^{commit}"`, { cwd: DATA }).toString().trim();
  const dir = resolve(TOOL, "code", sha.slice(0, 12));
  if (!existsSync(join(dir, MOD, "module.json"))) {
    rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
    execSync(`git archive ${sha} ${MOD} | tar -x -C "${dir.replace(/\\/g, "/")}"`, { cwd: DATA, stdio: ["ignore", "ignore", "inherit"], shell: "bash" });
  }
  CODE = { ref: CODE_REF, sha, dir };
  console.log(`[runner-server] our module from ${CODE_REF} (${sha.slice(0, 12)})`);
}

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".hbs": "text/plain; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
  ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav", ".webm": "video/webm", ".mp4": "video/mp4", ".m4a": "audio/mp4",
  ".wasm": "application/wasm", ".glb": "model/gltf-binary", ".gltf": "model/gltf+json", ".txt": "text/plain; charset=utf-8",
};

/** Data-relative path -> real file. The runner world's folder is virtual (runtime/). */
function dataFile(rel) {
  rel = rel.replace(/^\/+/, "");
  if (CODE && (rel === MOD || rel.startsWith(MOD + "/"))) return join(CODE.dir, rel);
  if (rel === `worlds/${CFG.worldId}` || rel.startsWith(WORLD_PREFIX)) return join(RUNTIME, rel.slice(WORLD_PREFIX.length));
  return join(DATA, rel);
}
const inside = (p, root) => normalize(p).startsWith(normalize(root) + sep) || normalize(p) === normalize(root);

let gameHtml = null;
function buildGameHtml() {
  const src = readFileSync(resolve(SNAP_DIR, "game.html"), "utf8");
  const snapMeta = JSON.parse(readFileSync(resolve(SNAP_DIR, "meta.json"), "utf8"));
  const inject = `<script>window.__RUNNER_CFG = ${JSON.stringify({ userId: snapMeta.userId, worldId: CFG.worldId, code: CODE ? { ref: CODE.ref, sha: CODE.sha, version: JSON.parse(readFileSync(join(CODE.dir, MOD, "module.json"), "utf8")).version } : null })};</script>\n` +
    `<script src="/runner/fake-io.js"></script>`;
  let out = src.replace(/<script[^>]*socket\.io[^>]*><\/script>/i, inject);
  if (CODE) out = swapModuleTags(out, JSON.parse(readFileSync(join(CODE.dir, MOD, "module.json"), "utf8")));
  if (out === src) throw new Error("could not find the socket.io <script> tag in snapshot/game.html");
  return out;
}

/** Replace our module's script / esmodule / style tags with the ones a commit's manifest lists.
 *  Each kind is one contiguous run in the page (it is not a library module). */
function swapModuleTags(html, manifest) {
  const at = (p) => `${MOD}/${String(p).replace(/^(\.\/|\/)+/, "")}`;
  const kinds = [
    [new RegExp(`^\\s*<link href="${MOD}/`), manifest.styles ?? [], (p) => `    <link href="${at(p)}" rel="stylesheet" type="text/css" media="all">`],
    [new RegExp(`^\\s*<script defer src="${MOD}/[^"]*"></script>`), manifest.scripts ?? [], (p) => `    <script defer src="${at(p)}"></script>`],
    [new RegExp(`^\\s*<script defer src="${MOD}/[^"]*" type="module">`), manifest.esmodules ?? [], (p) => `    <script defer src="${at(p)}" type="module"></script>`],
  ];
  let lines = html.split("\n");
  for (const [re, list, tag] of kinds) {
    const idx = lines.map((l, i) => (re.test(l) ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) throw new Error(`--code: no ${re} run in the page`);
    if (idx[idx.length - 1] - idx[0] !== idx.length - 1) throw new Error(`--code: ${re} tags are not contiguous`);
    lines = [...lines.slice(0, idx[0]), ...list.map(tag), ...lines.slice(idx[idx.length - 1] + 1)];
  }
  return lines.join("\n");
}

function send(res, code, body, type = "text/plain; charset=utf-8", extra = {}) {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-cache", ...extra });
  res.end(body);
}
function sendFile(res, file) {
  const type = TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache", "Content-Length": statSync(file).size });
  createReadStream(file).pipe(res);
}

function browse(target) {
  const dir = dataFile(target);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return { target, private: false, dirs: [], files: [], extensions: [] };
  const ents = readdirSync(dir, { withFileTypes: true });
  const base = target.replace(/\/+$/, "");
  return {
    target, private: false, gridSize: null, extensions: [],
    dirs: ents.filter((e) => e.isDirectory()).map((e) => `${base}/${e.name}`),
    files: ents.filter((e) => e.isFile()).map((e) => `${base}/${encodeURIComponent(e.name)}`),
  };
}

/** Minimal multipart parser: FilePicker.upload sends source, target, file (+bucket). */
function parseMultipart(buf, boundary) {
  const parts = {}; const b = Buffer.from("--" + boundary);
  let pos = buf.indexOf(b);
  while (pos >= 0) {
    const next = buf.indexOf(b, pos + b.length);
    if (next < 0) break;
    const part = buf.subarray(pos + b.length + 2, next - 2);
    const hEnd = part.indexOf("\r\n\r\n");
    const head = part.subarray(0, hEnd).toString();
    const body = part.subarray(hEnd + 4);
    const name = /name="([^"]+)"/.exec(head)?.[1];
    const filename = /filename="([^"]*)"/.exec(head)?.[1];
    if (name) parts[name] = filename !== undefined ? { filename, data: body } : body.toString();
    pos = next;
  }
  return parts;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    let p = decodeURIComponent(url.pathname);
    if (p === "/" || p === "/join" || p === "/setup") return send(res, 302, "", "text/plain", { Location: "/game" });
    if (p === "/api/status") return send(res, 200, JSON.stringify({ active: true, world: CFG.worldId, runner: true, code: CODE?.sha ?? "working-tree", snapshot: SNAP_DIR.slice(TOOL.length + 1) }), TYPES[".json"]);
    if (p === "/game") {
      gameHtml ??= buildGameHtml();
      return send(res, 200, gameHtml, TYPES[".html"], { "Set-Cookie": "session=runner; Path=/" });
    }
    if (p === "/runner/world.json") return existsSync(SNAP) ? sendFile(res, SNAP) : send(res, 404, "no snapshot — run build-snapshot");
    if (p === "/runner/browse") return send(res, 200, JSON.stringify(browse(url.searchParams.get("target") ?? "")), TYPES[".json"]);
    if (p === "/runner/mkdir" && req.method === "POST") {
      const dir = dataFile(url.searchParams.get("target") ?? "");
      if (!inside(dir, RUNTIME)) return send(res, 403, "runner writes only under runtime/");
      mkdirSync(dir, { recursive: true }); return send(res, 200, "{}", TYPES[".json"]);
    }
    if (p === "/upload" && req.method === "POST") {
      const chunks = []; for await (const c of req) chunks.push(c);
      const boundary = /boundary=(.+)$/.exec(req.headers["content-type"] ?? "")?.[1];
      const parts = boundary ? parseMultipart(Buffer.concat(chunks), boundary) : {};
      const target = String(parts.target ?? "").replace(/^\/+/, "");
      const file = parts.file;
      if (!file?.filename) return send(res, 400, JSON.stringify({ status: "error", message: "no file" }), TYPES[".json"]);
      // Writes into the runner world go to runtime/; anything else is diverted to runtime/_uploads/.
      let dir = dataFile(target);
      if (!inside(dir, RUNTIME)) dir = join(RUNTIME, "_uploads", target);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, file.filename), file.data);
      const path = `${target.replace(/\/+$/, "")}/${file.filename}`;
      return send(res, 200, JSON.stringify({ status: "success", path, message: `runner: saved ${path}` }), TYPES[".json"]);
    }
    if (p.startsWith("/runner/")) {
      const f = join(WWW, p.slice("/runner/".length));
      if (inside(f, WWW) && existsSync(f) && statSync(f).isFile()) return sendFile(res, f);
      return send(res, 404, "not found");
    }
    // Foundry's own public files first, then the Data/ tree (modules, systems, worlds, assets).
    // Same mount order as Foundry's own express server (dist/server/express.mjs _staticFiles).
    const rel = p.replace(/^\/+/, "");
    const tries = [[PUBLIC, join(PUBLIC, rel)]];
    if (rel.startsWith("common/")) tries.push([APP_COMMON, join(APP_COMMON, rel.slice(7))]);
    if (rel.startsWith("templates/")) tries.push([APP_TEMPLATES, join(APP_TEMPLATES, rel.slice(10))]);   // core client templates
    tries.push([DATA, dataFile(rel)], [RUNTIME, dataFile(rel)]);
    if (rel.startsWith("scripts/")) {
      const rest = rel.slice(8);
      if (rest.startsWith("pdfjs/")) tries.push([NODE_MODULES, join(NODE_MODULES, "@foundryvtt/pdfjs", rest.slice(6))]);
      for (const d of VENDOR) tries.push([NODE_MODULES, join(NODE_MODULES, d, rest)]);
    }
    for (const [root, f] of tries) {
      if ((inside(f, root) || inside(f, RUNTIME)) && existsSync(f) && statSync(f).isFile()) return sendFile(res, f);
    }
    return send(res, 404, `not found: ${p}`);
  } catch (e) {
    console.error("[runner-server]", e);
    try { send(res, 500, String(e?.message ?? e)); } catch {}
  }
});
server.listen(PORT, () => console.log(`[runner-server] http://localhost:${PORT}/game  (world ${CFG.worldId}, data ${DATA})`));
