// build-snapshot — cut the world data down to what a battle on the configured scene needs,
// and rename the world so nothing the runner writes can land in the real world's folder.
//   node tools/snapshot-runner/bin/build-snapshot.mjs [--profile <name>] [--source disk|capture] [--snapshot <dir>]
// --snapshot <dir> (default "snapshot", relative to the tool): where the snapshot goes. Two
//   sessions sharing the runner each use their own, so one's build never swaps the other's world.
// --source disk (default): read the world's LevelDB from disk first (bin/read-world.mjs;
//   no Foundry, no world launch). --source capture: use capture/ (a running world's payload).
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, copyFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = resolve(HERE, "..");
const DATA = resolve(TOOL, "../..");
// --profile <name> layers runner.<name>.json over runner.config.json (e.g. a one-scene battle)
const pi = process.argv.indexOf("--profile");
const PROFILE = pi > 0 ? process.argv[pi + 1] : null;
const CFG = { ...JSON.parse(readFileSync(resolve(TOOL, "runner.config.json"), "utf8")),
  ...(PROFILE ? JSON.parse(readFileSync(resolve(TOOL, `runner.${PROFILE}.json`), "utf8")) : {}) };
const NS = "fabula-ultima-companion";
const ID_RE = /\b[A-Za-z0-9]{16}\b/g;
const mb = (n) => (n / 1048576).toFixed(2) + " MB";

const oi = process.argv.indexOf("--snapshot");
const SNAP_DIR = resolve(TOOL, oi > 0 ? process.argv[oi + 1] : "snapshot");
const si = process.argv.indexOf("--source");
const SOURCE = si > 0 ? process.argv[si + 1] : "disk";
const SRC_DIR = resolve(TOOL, SOURCE === "capture" ? "capture" : "source");
if (SOURCE !== "capture") execFileSync(process.execPath, [resolve(HERE, "read-world.mjs"), ...(CFG.sourceWorld ? ["--world", CFG.sourceWorld] : [])], { stdio: "inherit" });
const t0 = Date.now();
const raw = readFileSync(resolve(SRC_DIR, "world-full.json"), "utf8");
const W = JSON.parse(raw);
const folders = new Map(W.folders.map((f) => [f._id, f]));
const folderPath = (id) => { const p = []; let f = folders.get(id); while (f) { p.unshift(f.name); f = folders.get(f.folder); } return p.join("/"); };
const actorsById = new Map(W.actors.map((a) => [a._id, a]));
const scenesById = new Map(W.scenes.map((s) => [s._id, s]));

// ---- scenes
// "scenes": "*" keeps every scene; "actors": { "all": true } every actor (whole-world checks)
const keptScenes = CFG.scenes === "*" ? W.scenes : W.scenes.filter((s) => CFG.scenes.includes(s.name));
const missingScenes = CFG.scenes === "*" ? [] : CFG.scenes.filter((n) => !keptScenes.some((s) => s.name === n));
if (missingScenes.length) throw new Error(`scenes not in the capture: ${missingScenes.join(", ")}`);
const viewScene = keptScenes.find((s) => s.name === CFG.viewScene) ?? keptScenes[0];

// ---- actors: seeds + id-reference closure (settings, kept scenes, kept actors, module code)
const why = new Map();
const add = (id, r) => { if (actorsById.has(id) && !why.has(id)) why.set(id, r); };
const A = CFG.actors;
for (const a of W.actors) {
  if (A.all) add(a._id, "all");
  if (A.types?.includes(a.type)) add(a._id, `type ${a.type}`);
  const fl = (A.flags ?? []).find((f) => a.flags?.[NS]?.[f]); if (fl) add(a._id, `flag ${fl}`);
  const fp = folderPath(a.folder); const hf = (A.folders ?? []).find((f) => fp === f || fp.startsWith(f + "/")); if (hf) add(a._id, `folder ${hf}`);
  if (A.names?.includes(a.name)) add(a._id, "name");
}
const scan = (text, label) => { for (const m of text.matchAll(ID_RE)) add(m[0], label); };
const from = new Set(CFG.followRefs?.from ?? []);
if (from.has("settings")) for (const s of W.settings) scan(JSON.stringify(s), `setting ${s.key}`);
if (from.has("scenes")) for (const s of keptScenes) scan(JSON.stringify(s), `scene ${s.name}`);
function* walkJs(dir) {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules" && !e.name.startsWith(".")) yield* walkJs(p); }
    else if (/\.m?js$/.test(e.name)) yield p;
  }
}
for (const rel of CFG.followRefs?.fromCode ?? []) for (const f of walkJs(resolve(DATA, rel))) scan(readFileSync(f, "utf8"), `code ${f.split(/[\\/]/).pop()}`);
// ---- place: put copies of tokens that exist elsewhere in the world onto a kept scene, so a
// small scenario can stage exactly the fight it needs. Copies keep the token's own data
// (actor link, delta, disposition); only the position is laid out fresh.
//   "place": { "scene": "Training Ground", "from": "Regression Bench", "actors": ["Hina", "Test Target Enemy"] }
const placed = [];
if (CFG.place) {
  const P = CFG.place;
  const from = W.scenes.find((s) => s.name === P.from);
  if (!from) throw new Error(`place.from: no scene "${P.from}"`);
  for (const name of P.actors) {
    let tok = from.tokens.find((t) => actorsById.get(t.actorId)?.name === name);
    if (!tok) {
      // Not on that scene: a fresh token from the actor's prototype, as dropping it on a scene would make.
      const actor = W.actors.find((a) => a.name === name);
      if (!actor) throw new Error(`place: no actor "${name}"`);
      // Ids derived from the actor, not drawn at random: two builds of the same world must cut the
      // same snapshot, or the warm runner (bin/warm.mjs) sees every rebuild as a changed scene.
      const rid = (salt) => createHash("sha256").update(`${actor._id}:${salt}`).digest().subarray(0, 16).reduce((s, b) => s + "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[b % 62], "");
      tok = { ...structuredClone(actor.prototypeToken), _id: rid("placed-token"), actorId: actor._id, x: 0, y: 0, elevation: 0, hidden: false, flags: structuredClone(actor.prototypeToken?.flags ?? {}) };
      if (!tok.actorLink) tok.delta = { _id: rid("placed-delta"), system: {}, items: [], effects: [], flags: {}, name: null, type: null, img: null };
    }
    placed.push(structuredClone(tok));
    add(tok.actorId, `placed ${name}`);
    scan(JSON.stringify(tok), `placed token ${name}`);
  }
}

// Persistent summons point AT their owner (flags.<ns>.summonOwnerActorUuid), never the other
// way, so the id closure cannot reach them: Blanche's King Gorger was missing, and a sim battle
// in the runner fought without it while the real engine (Staging World) fielded it (2026-11-03).
const ownerOf = (a) => /^Actor\.([A-Za-z0-9]{16})$/.exec(String(a.flags?.[NS]?.summonOwnerActorUuid ?? ""))?.[1] ?? null;
const summons = W.actors.filter((a) => a.flags?.[NS]?.isPersistentSummon && ownerOf(a));
if (from.has("actors")) {
  const done = new Set(); let grew = true;
  while (grew) {
    grew = false;
    for (const s of summons) if (!why.has(s._id) && why.has(ownerOf(s))) add(s._id, `summon of ${actorsById.get(ownerOf(s))?.name}`);
    for (const id of [...why.keys()]) if (!done.has(id)) { done.add(id); grew = true; scan(JSON.stringify(actorsById.get(id)), `actor ${actorsById.get(id).name}`); }
  }
}

// ---- assemble
const out = { ...W };
out.world = { ...W.world, id: CFG.worldId, title: CFG.worldTitle };
out.paused = false;                          // a paused world parks the Battle Director
out.activeUsers = [W.userId];
out.actors = W.actors.filter((a) => why.has(a._id));
out.scenes = keptScenes.map((s) => {
  const c = structuredClone(s);
  if (CFG.place && s.name === CFG.place.scene) {
    const g = c.grid?.size ?? 100;
    let ally = 0, foe = 0;
    c.tokens = placed.map((t) => {
      const enemy = (t.disposition ?? 0) < 0;
      return { ...t, x: g * (2 + 2 * (enemy ? foe++ : ally++)), y: g * (enemy ? 6 : 2), elevation: 0, hidden: false };
    });
  }
  c.active = c._id === viewScene._id;
  if (c.flags?.[NS]) delete c.flags[NS].directorState;   // stale battle state resurrects tokens
  return c;
});
for (const k of CFG.dropWhole ?? []) out[k] = [];
// items: "referenced" keeps only world items some kept doc / setting / module file names
// by id (the referee decides whether that loses anything). Default: all of them.
if (CFG.items === "referenced") {
  const itemIds = new Set(W.items.map((i) => i._id)), keepItems = new Set();
  const scanI = (text) => { for (const m of text.matchAll(ID_RE)) if (itemIds.has(m[0])) keepItems.add(m[0]); };
  for (const x of [...out.actors, ...out.scenes, ...W.settings, ...W.journal, ...W.macros, ...W.tables]) scanI(JSON.stringify(x));
  for (const rel of CFG.followRefs?.fromCode ?? []) for (const f of walkJs(resolve(DATA, rel))) scanI(readFileSync(f, "utf8"));
  out.items = W.items.filter((i) => keepItems.has(i._id) || (CFG.itemFolders ?? []).some((f) => folderPath(i.folder).startsWith(f)));
}
const keepActor = new Set(out.actors.map((a) => a._id)), keepScene = new Set(out.scenes.map((s) => s._id));
out.users = W.users.map((u) => {
  const c = structuredClone(u);
  if ("viewedScene" in c) c.viewedScene = viewScene._id;
  const csb = c.flags?.["custom-system-builder"];
  for (const [type, ids] of [["Actor", keepActor], ["Scene", keepScene]]) if (csb?.[type]) for (const id of Object.keys(csb[type])) if (!ids.has(id)) delete csb[type][id];
  return c;
});

mkdirSync(SNAP_DIR, { recursive: true });
const json = JSON.stringify(out);
writeFileSync(resolve(SNAP_DIR, "world.json"), json);
copyFileSync(resolve(SRC_DIR, "game.html"), resolve(SNAP_DIR, "game.html"));
const meta = {
  builtAt: new Date().toISOString(), profile: PROFILE ?? "default", source: SOURCE, from: W.world.id, worldId: CFG.worldId, userId: W.userId,
  viewScene: viewScene.name, bytes: json.length, sourceBytes: raw.length,
  actors: [...why].map(([id, r]) => ({ id, name: actorsById.get(id).name, reason: r })),
  scenes: out.scenes.map((s) => s.name),
};
writeFileSync(resolve(SNAP_DIR, "meta.json"), JSON.stringify(meta, null, 2));
console.log(`snapshot ${SNAP_DIR.slice(TOOL.length + 1)}: ${mb(json.length)} (from ${mb(raw.length)}), ${out.items.length}/${W.items.length} items, ${out.actors.length}/${W.actors.length} actors, ${out.scenes.length}/${W.scenes.length} scenes, view "${viewScene.name}" — ${Date.now() - t0} ms`);
