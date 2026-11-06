#!/usr/bin/env node
// staging-world — a slim, rebuildable copy of the live world for battle testing.
//
//   node tools/staging-world/bin/staging-world.mjs plan     # what would be copied, and why
//   node tools/staging-world/bin/staging-world.mjs build    # (re)build worlds/staging-world from the live world
//   node tools/staging-world/bin/staging-world.mjs start    # headless staging server on :30001 (world auto-launched)
//   node tools/staging-world/bin/staging-world.mjs stop     # stop the staging server (never touches :30000)
//   node tools/staging-world/bin/staging-world.mjs status
//
// The build READS the live world from a temporary file copy, so it works with the
// real world open or closed and can never write to it. See ../README.md.
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve, join } from "node:path";
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync, copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = resolve(HERE, "..");
const DATA = resolve(TOOL, "../..");                 // .../FoundryVTT/Data
const FVTT_ROOT = resolve(DATA, "..");               // .../FoundryVTT (holds Config/)
const LAB_ROOT = resolve(FVTT_ROOT, "staging-server");   // the staging server's own dataPath
const require = createRequire(import.meta.url);
const { ClassicLevel } = require(resolve(DATA, "tools/safe-edit/node_modules/classic-level"));

const CFG = JSON.parse(readFileSync(resolve(TOOL, "staging.config.json"), "utf8"));
const SRC = resolve(DATA, "worlds", CFG.sourceWorld);
const LAB = resolve(DATA, "worlds", CFG.worldId);
const NS = "fabula-ultima-companion";
const ID_RE = /\b[A-Za-z0-9]{16}\b/g;
const BASE_URL = `http://localhost:${CFG.port}`;

const mb = (n) => (n / 1048576).toFixed(2) + " MB";

// ---------------------------------------------------------------- reading
/** Copy a collection's LevelDB to a temp dir (minus LOCK) and read every key. */
async function readCollection(name, scratch) {
  const src = join(SRC, "data", name);
  // A store folder with no CURRENT is not a LevelDB yet (an empty leftover such as
  // data/adventures: LOCK + LOG + an empty .log). Opening it with createIfMissing
  // false fails the whole build ("Database is not open"), so read it as empty.
  if (!existsSync(src) || !existsSync(join(src, "CURRENT"))) return [];
  const dst = join(scratch, name);
  cpSync(src, dst, { recursive: true, filter: (p) => !/[\\/]LOCK$/.test(p) });
  const db = new ClassicLevel(dst, { keyEncoding: "utf8", valueEncoding: "utf8" });
  await db.open({ createIfMissing: false });
  const rows = [];
  for await (const [k, v] of db.iterator()) rows.push([k, v]);
  await db.close();
  return rows;
}
const rootIdOf = (key) => key.split("!")[2].split(".")[0];
const isRootKey = (key, coll) => key.startsWith(`!${coll}!`);

function groupByRoot(rows, coll) {
  const m = new Map();
  for (const [k, v] of rows) {
    const id = rootIdOf(k);
    let g = m.get(id);
    if (!g) m.set(id, (g = { id, rows: [], doc: null, bytes: 0 }));
    g.rows.push([k, v]);
    g.bytes += v.length;
    if (isRootKey(k, coll)) g.doc = JSON.parse(v);
  }
  return m;
}

// ---------------------------------------------------------------- selection
function select(world) {
  const { actors, scenes, folders } = world;
  const folderPath = (id) => { const p = []; let f = folders.get(id); while (f) { p.unshift(f.name); f = folders.get(f.folder); } return p.join("/"); };
  const why = new Map();      // actorId -> reason
  const add = (id, reason) => { if (!why.has(id) && actors.has(id)) why.set(id, reason); };
  const A = CFG.actors;
  const wantNames = new Set(A.names ?? []);
  const foundNames = new Set();
  for (const [id, g] of actors) {
    const d = g.doc; if (!d) continue;
    if (A.types?.includes(d.type)) add(id, `type ${d.type}`);
    if ((A.flags ?? []).some((f) => d.flags?.[NS]?.[f])) add(id, `flag ${A.flags.find((f) => d.flags?.[NS]?.[f])}`);
    const fp = folderPath(d.folder);
    const hitFolder = (A.folders ?? []).find((f) => fp === f || fp.startsWith(f + "/"));
    if (hitFolder) add(id, `folder ${hitFolder}`);
    if (wantNames.has(d.name)) { add(id, `name`); foundNames.add(d.name); }
  }
  const missingNames = [...wantNames].filter((n) => !foundNames.has(n));

  const keptScenes = new Map();
  const wantScenes = new Set(CFG.scenes);
  for (const [id, g] of scenes) if (g.doc && wantScenes.has(g.doc.name)) keptScenes.set(id, g);
  const missingScenes = [...wantScenes].filter((n) => ![...keptScenes.values()].some((g) => g.doc.name === n));

  // Follow id references to a fixpoint: anything a kept doc (or a setting/user)
  // names by id comes along, so pointers like Current Game -> party actors resolve.
  const from = new Set(CFG.followRefs?.from ?? []);
  const scanned = new Set();
  const scanRows = (rows, label) => {
    for (const [, v] of rows) for (const m of v.matchAll(ID_RE)) if (!why.has(m[0]) && actors.has(m[0])) why.set(m[0], `ref from ${label}`);
  };
  // Ids hard-coded in module code (e.g. db-resolver's CURRENT_GAME_ACTOR_UUID).
  const codeSceneRefs = new Set();
  for (const rel of CFG.followRefs?.fromCode ?? []) {
    for (const f of walkJs(resolve(DATA, rel))) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(ID_RE)) {
        if (actors.has(m[0]) && !why.has(m[0])) why.set(m[0], `code ${f.slice(DATA.length + 1).replace(/\\/g, "/")}`);
        if (scenes.has(m[0]) && !keptScenes.has(m[0])) codeSceneRefs.add(`${scenes.get(m[0]).doc?.name} (${f.split(/[\\/]/).pop()})`);
      }
    }
  }
  if (from.has("settings")) for (const [k, v] of world.settingsRows) scanRows([[k, v]], `setting ${JSON.parse(v).key}`);
  if (from.has("users")) for (const [k, v] of world.usersRows) scanRows([[k, v]], `user ${JSON.parse(v).name}`);
  if (from.has("scenes")) for (const g of keptScenes.values()) scanRows(g.rows, `scene ${g.doc.name}`);
  if (from.has("actors")) {
    let grew = true;
    while (grew) {
      grew = false;
      for (const id of [...why.keys()]) {
        if (scanned.has(id)) continue;
        scanned.add(id); grew = true;
        scanRows(actors.get(id).rows, `actor ${actors.get(id).doc?.name}`);
      }
    }
  }
  return { why, keptScenes, missingNames, missingScenes, folderPath, codeSceneRefs: [...codeSceneRefs] };
}

function* walkJs(dir) {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules" && !e.name.startsWith(".")) yield* walkJs(p); }
    else if (/\.m?js$/.test(e.name)) yield p;
  }
}

async function loadWorld(scratch) {
  const names = readdirSync(join(SRC, "data"));
  const raw = {};
  for (const n of names) raw[n] = await readCollection(n, scratch);
  const folders = new Map(raw.folders.filter(([k]) => isRootKey(k, "folders")).map(([, v]) => { const d = JSON.parse(v); return [d._id, d]; }));
  return {
    names, raw, folders,
    actors: groupByRoot(raw.actors, "actors"),
    scenes: groupByRoot(raw.scenes, "scenes"),
    settingsRows: raw.settings ?? [],
    usersRows: raw.users ?? [],
  };
}

function report(world, sel) {
  const { why, keptScenes } = sel;
  const actorBytes = [...why.keys()].reduce((s, id) => s + world.actors.get(id).bytes, 0);
  const allActorBytes = [...world.actors.values()].reduce((s, g) => s + g.bytes, 0);
  const sceneBytes = [...keptScenes.values()].reduce((s, g) => s + g.bytes, 0);
  const allSceneBytes = [...world.scenes.values()].reduce((s, g) => s + g.bytes, 0);
  console.log(`actors: ${why.size}/${world.actors.size}  ${mb(actorBytes)} of ${mb(allActorBytes)}`);
  const rows = [...why].map(([id, r]) => ({ id, name: world.actors.get(id).doc?.name, reason: r, kb: Math.round(world.actors.get(id).bytes / 1024) }))
    .sort((a, b) => b.kb - a.kb);
  for (const r of rows) console.log(`   ${String(r.kb).padStart(6)} KB  ${r.name}  (${r.reason})`);
  console.log(`scenes: ${keptScenes.size}/${world.scenes.size}  ${mb(sceneBytes)} of ${mb(allSceneBytes)}  [${[...keptScenes.values()].map((g) => g.doc.name).join(", ")}]`);
  for (const c of CFG.copyWhole) console.log(`${c}: whole (${(world.raw[c] ?? []).length} keys, ${mb((world.raw[c] ?? []).reduce((s, [, v]) => s + v.length, 0))})`);
  if (sel.missingNames.length) console.log(`⚠ named actors NOT found: ${sel.missingNames.join(", ")}`);
  if (sel.missingScenes.length) console.log(`⚠ scenes NOT found: ${sel.missingScenes.join(", ")}`);
  if (sel.codeSceneRefs.length) console.log(`ℹ module code names scenes the Staging World leaves out (add to "scenes" if a test needs them): ${sel.codeSceneRefs.join("; ")}`);
  const cap = CFG.followRefs?.maxActors ?? Infinity;
  if (why.size > cap) console.log(`⚠ ${why.size} actors exceeds followRefs.maxActors=${cap} — tighten staging.config.json`);
  return { actors: rows, actorBytes, sceneBytes };
}

// ---------------------------------------------------------------- writing
async function writeCollection(name, rows) {
  const dir = join(LAB, "data", name);
  mkdirSync(dir, { recursive: true });
  const db = new ClassicLevel(dir, { keyEncoding: "utf8", valueEncoding: "utf8" });
  await db.open();
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const b = db.batch();
    for (const [k, v] of rows.slice(i, i + BATCH)) b.put(k, v);
    await b.write();
  }
  let n = 0; for await (const _ of db.keys()) n++;
  await db.close();
  if (n !== rows.length) throw new Error(`${name}: wrote ${rows.length} keys but read back ${n}`);
  return n;
}

async function build() {
  if (await serverUp()) throw new Error(`the staging server is running on ${BASE_URL} — run \`staging-world stop\` first (it holds the Staging World's LevelDB lock).`);
  const scratch = mkdtempSync(join(tmpdir(), "staging-world-"));
  const t0 = Date.now();
  try {
    const world = await loadWorld(scratch);
    const sel = select(world);
    const rep = report(world, sel);
    if (sel.why.size > (CFG.followRefs?.maxActors ?? Infinity)) throw new Error("selection too large; refusing to build");

    // Wipe ONLY the Staging World's own data dir; keep test-bridge/ etc. across rebuilds.
    const labData = join(LAB, "data");
    if (!labData.replace(/\\/g, "/").endsWith(`/worlds/${CFG.worldId}/data`) || CFG.worldId === CFG.sourceWorld) throw new Error(`refusing to wipe ${labData}`);
    rmSync(labData, { recursive: true, force: true });
    mkdirSync(labData, { recursive: true });

    const activeScene = [...sel.keptScenes.values()].find((g) => g.doc.name === CFG.activeScene);
    const counts = {};
    // actors: only the selected roots (with every embedded key under them)
    counts.actors = await writeCollection("actors", [...sel.why.keys()].flatMap((id) => world.actors.get(id).rows));
    // scenes: selected roots; exactly one active; no stale battle state (it resurrects tokens)
    const sceneRows = [];
    for (const g of sel.keptScenes.values()) for (const [k, v] of g.rows) {
      if (!isRootKey(k, "scenes")) { sceneRows.push([k, v]); continue; }
      const d = JSON.parse(v);
      d.active = d._id === activeScene?.id;
      if (d.flags?.[NS]) delete d.flags[NS].directorState;
      sceneRows.push([k, JSON.stringify(d)]);
    }
    counts.scenes = await writeCollection("scenes", sceneRows);
    for (const c of CFG.copyWhole) {
      let rows = world.raw[c] ?? [];
      if (c === "users") rows = rows.map(([k, v]) => {
        const d = JSON.parse(v);
        if (activeScene && "viewedScene" in d) d.viewedScene = activeScene.id;
        // CSB keeps per-user sheet UI state keyed by document id (3.4 MB here).
        // Keep the entries for documents the Staging World has; the rest point at nothing.
        const csb = d.flags?.["custom-system-builder"];
        const keep = { Actor: sel.why, Scene: sel.keptScenes };
        for (const [type, ids] of Object.entries(keep)) {
          if (csb?.[type] && typeof csb[type] === "object") for (const id of Object.keys(csb[type])) if (!ids.has(id)) delete csb[type][id];
        }
        return [k, JSON.stringify(d)];
      });
      counts[c] = await writeCollection(c, rows);
    }

    const wj = JSON.parse(readFileSync(join(SRC, "world.json"), "utf8"));
    wj.id = CFG.worldId; wj.title = CFG.worldTitle; delete wj.lastPlayed; wj.playtime = 0;
    if (CFG.copyPacks) {
      for (const p of wj.packs ?? []) {
        const from = join(SRC, p.path), to = join(LAB, p.path);
        rmSync(to, { recursive: true, force: true });
        if (existsSync(from)) cpSync(from, to, { recursive: true, filter: (q) => !/[\\/]LOCK$/.test(q) });
      }
    } else wj.packs = [];
    writeFileSync(join(LAB, "world.json"), JSON.stringify(wj, null, 2));
    writeFileSync(join(LAB, "STAGING-MANIFEST.json"), JSON.stringify({
      note: "Staging World: a disposable slim copy of the live world. Rebuilt by tools/staging-world. Never commit, never copy back.",
      builtAt: new Date().toISOString(), source: CFG.sourceWorld, counts,
      actors: rep.actors, scenes: [...sel.keptScenes.values()].map((g) => g.doc.name),
      bytes: { actors: rep.actorBytes, scenes: rep.sceneBytes },
    }, null, 2));
    console.log(`\nbuilt worlds/${CFG.worldId} in ${((Date.now() - t0) / 1000).toFixed(1)} s:`, counts);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function plan() {
  const scratch = mkdtempSync(join(tmpdir(), "staging-world-"));
  try { const w = await loadWorld(scratch); report(w, select(w)); } finally { rmSync(scratch, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------- server
async function serverUp() {
  try { const r = await fetch(`${BASE_URL}/api/status`, { signal: AbortSignal.timeout(2500) }); return r.ok ? await r.json() : null; } catch { return null; }
}

/** The staging server gets its own dataPath (own Config + options lock) whose Data/ is a junction to the real Data. */
function ensureLabRoot() {
  mkdirSync(join(LAB_ROOT, "Config"), { recursive: true });
  mkdirSync(join(LAB_ROOT, "Logs"), { recursive: true });
  copyFileSync(join(FVTT_ROOT, "Config", "license.json"), join(LAB_ROOT, "Config", "license.json"));
  const opts = JSON.parse(readFileSync(join(FVTT_ROOT, "Config", "options.json"), "utf8"));
  Object.assign(opts, {
    dataPath: LAB_ROOT.replace(/\\/g, "/"), port: CFG.port, upnp: false, world: CFG.worldId,
    // localhost only: deflating ~10-130 MB of world data per join buys nothing here
    compressSocket: CFG.compressSocket ?? false, telemetry: false,
  });
  writeFileSync(join(LAB_ROOT, "Config", "options.json"), JSON.stringify(opts, null, 2));
  const link = join(LAB_ROOT, "Data");
  if (!existsSync(link)) execSync(`cmd /c mklink /J "${link}" "${DATA}"`, { stdio: "ignore" });
  if (!existsSync(join(link, "worlds", CFG.worldId, "world.json"))) throw new Error(`Data junction at ${link} does not resolve to the Staging World`);
  // A killed server leaves this lock behind and the next start fails "already locked".
  rmSync(join(LAB_ROOT, "Config", "options.json.lock"), { recursive: true, force: true });
}

async function start() {
  if (!existsSync(join(LAB, "world.json"))) throw new Error(`no lab world yet — run \`staging-world build\` first`);
  const st = await serverUp();
  if (st) { console.log(`staging server already up on ${BASE_URL}:`, st); return; }
  ensureLabRoot();
  const lib = pathToFileURL(resolve(DATA, "tools/fvtt-playwright/lib/server.js")).href;
  const { ensureServerUp } = await import(lib);
  const pw = JSON.parse(readFileSync(resolve(DATA, "tools/fvtt-playwright/config.local.json"), "utf8"));
  const t0 = Date.now();
  const r = await ensureServerUp({ ...pw, baseURL: BASE_URL, dataPath: LAB_ROOT, launcher: "node", noupnp: true, serverStartTimeoutMs: 120000 });
  // options.world auto-launches the world; wait until it reports active
  for (let i = 0; i < 120; i++) { const s = await serverUp(); if (s?.active && s.world === CFG.worldId) break; await new Promise((res) => setTimeout(res, 500)); }
  console.log(`staging server up in ${((Date.now() - t0) / 1000).toFixed(1)} s (pid ${r.pid ?? "?"}):`, await serverUp());
}

async function stop() {
  const st = await serverUp();
  if (!st) { console.log("staging server is not running"); return; }
  const lib = pathToFileURL(resolve(DATA, "tools/fvtt-playwright/lib/server.js")).href;
  const { describePortOwner } = await import(lib);
  const owners = describePortOwner(CFG.port);
  const mine = owners.filter((o) => o.kind === "foundry-node" && /staging-server/i.test(o.cmd));
  if (!mine.length) throw new Error(`port ${CFG.port} is not held by the staging server (${JSON.stringify(owners)}) — not killing anything`);
  for (const o of mine) execSync(`taskkill /PID ${o.pid} /F`, { stdio: "ignore" });
  for (let i = 0; i < 40 && (await serverUp()); i++) await new Promise((r) => setTimeout(r, 250));
  rmSync(join(LAB_ROOT, "Config", "options.json.lock"), { recursive: true, force: true });
  console.log(`stopped staging server pid ${mine.map((o) => o.pid).join(",")}`);
}

const cmd = process.argv[2];
const cmds = { plan, build, start, stop, status: async () => console.log((await serverUp()) ?? "staging server is not running") };
if (!cmds[cmd]) { console.log("usage: staging-world <plan|build|start|stop|status>"); process.exit(2); }
cmds[cmd]().catch((e) => { console.error("staging-world:", e.message); process.exitCode = 1; });
