// 2026-11-03 — keep each distinct actor sheet layout ONCE.
//
// CSB stores a full copy of a sheet layout (system.body + system.header) on every actor.
// Measured on fabula-ultima-2: 316 non-template actors, 47.2 MB of layout, 33 distinct
// layouts (5.6 MB). Actors cannot simply use their template's layout (most differ from
// it; 100 point at a template that no longer exists), so instead every distinct layout
// is stored once on a hidden `_template` actor, "_Layout Library", under a content hash,
// and each actor keeps an EMPTY body plus `flags.<ns>.layoutRef = <hash>`. The module's
// csb-template-layout-dedup.js (SHARED ACTOR LAYOUTS) resolves the ref at prepare time,
// so every actor gets back exactly the layout it had.
//
// Raw LevelDB write: game must be CLOSED. Backs up the store first. Idempotent: actors
// already pointing at the library are skipped, existing library entries are kept, new
// actors (made since the last run) are folded in on a re-run.
//
//   node tools/safe-edit/bin/_share-actor-layouts.js [--dry] [--dir <actors LevelDB dir>]
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { ClassicLevel } = require(path.join(__dirname, "..", "node_modules", "classic-level"));

const NS = "fabula-ultima-companion";
const LIB_NAME = "_Layout Library";
const EMPTY_BODY = { key: "custom_body", type: "panel", contents: [] };
const EMPTY_HEADER = { key: "custom_header", type: "panel", contents: [] };
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const DRY = process.argv.includes("--dry");
const DIR = path.resolve(arg("--dir") ?? path.join(__dirname, "..", "..", "..", "worlds", "fabula-ultima-2", "data", "actors"));
const isEmpty = (p) => !p || !Array.isArray(p.contents) || p.contents.length === 0;
const rid = () => Array.from(crypto.randomBytes(16), (b) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[b % 62]).join("");
const mb = (n) => (n / 1048576).toFixed(1) + " MB";

(async () => {
  if (!DRY && !arg("--dir")) {
    const bk = path.join(__dirname, "..", "backups", `${new Date().toISOString().replace(/[:.]/g, "-")}-fabula-ultima-2-actors-share-layouts`);
    fs.cpSync(DIR, bk, { recursive: true, filter: (p) => !/[\\/]LOCK$/.test(p) });
    console.log("backup:", bk);
  }
  const db = new ClassicLevel(DIR, { keyEncoding: "utf8", valueEncoding: "utf8" });
  await db.open({ createIfMissing: false });   // fails while Foundry holds the LOCK
  try {
    const roots = [];
    for await (const [k, v] of db.iterator({ gte: "!actors!", lt: "!actors!￿" })) roots.push([k, JSON.parse(v)]);
    let lib = roots.find(([, a]) => a.flags?.[NS]?.layoutLibrary);
    const layouts = lib ? lib[1].flags[NS].layoutLibrary.layouts : {};
    const before = Object.keys(layouts).length;

    const writes = [];
    let bytesBefore = 0, skippedRef = 0, skippedEmpty = 0;
    for (const [k, a] of roots) {
      if (a.type === "_template") continue;
      const sys = a.system ?? {};
      if (isEmpty(sys.body)) { if (a.flags?.[NS]?.layoutRef) skippedRef++; else skippedEmpty++; continue; }
      const entry = { body: sys.body, header: sys.header ?? EMPTY_HEADER };
      const json = JSON.stringify(entry);
      bytesBefore += json.length;
      const ref = crypto.createHash("sha1").update(json).digest("hex").slice(0, 16);
      if (layouts[ref] && JSON.stringify(layouts[ref]) !== json) throw new Error(`hash collision on ${ref} (${a.name})`);
      layouts[ref] ??= entry;
      // Keep the root panels' own attributes, empty only their contents: an unlinked
      // token's delta body is MERGED over the base body, so dropping e.g. `flow` or
      // `align` here changed 48 token sheets in the parity run.
      sys.body = { ...sys.body, contents: [] };
      sys.header = { ...(sys.header ?? EMPTY_HEADER), contents: [] };
      a.flags ??= {};
      a.flags[NS] = { ...(a.flags[NS] ?? {}), layoutRef: ref };
      writes.push([k, a]);
    }

    // The library: a hidden `_template` actor, shaped like the existing "_Field Template".
    if (!lib) {
      const shape = roots.find(([, a]) => a.type === "_template" && a.name === "_Field Template")?.[1];
      if (!shape) throw new Error('no "_Field Template" actor to copy the document shape from');
      const npc = roots.find(([, a]) => a.name === "_Fabula NPC template v.2")?.[1];
      const id = rid();
      const now = Date.now();
      const doc = structuredClone(shape);
      Object.assign(doc, {
        _id: id, name: LIB_NAME, img: "icons/svg/book.svg", folder: npc?.folder ?? shape.folder ?? null, sort: 0,
        ownership: npc?.ownership ?? shape.ownership, items: [], effects: [],
        _stats: { ...(shape._stats ?? {}), createdTime: now, modifiedTime: now, lastModifiedBy: null, compendiumSource: null, duplicateSource: null },
      });
      doc.system = { ...structuredClone(shape.system), body: { ...EMPTY_BODY }, header: { ...EMPTY_HEADER }, props: {} };
      doc.prototypeToken = { ...structuredClone(shape.prototypeToken ?? {}), name: LIB_NAME, texture: { ...(shape.prototypeToken?.texture ?? {}), src: "icons/svg/book.svg" } };
      doc.flags = { [NS]: { layoutLibrary: {
        version: 1,
        note: "Shared actor sheet layouts. Actors with an empty body and flags.fabula-ultima-companion.layoutRef use the layout under that ref (csb-template-layout-dedup.js). Do not delete or edit.",
        layouts,
      } } };
      lib = [`!actors!${id}`, doc];
    }
    lib[1].flags[NS].layoutLibrary.layouts = layouts;

    const libBytes = JSON.stringify(layouts).length;
    console.log(`actors to point at the library: ${writes.length} (${mb(bytesBefore)} of layout); already pointing: ${skippedRef}; no layout: ${skippedEmpty}`);
    console.log(`library "${lib[1].name}" ${lib[0]}: ${before} -> ${Object.keys(layouts).length} layouts, ${mb(libBytes)}`);
    if (DRY) { console.log("dry run: nothing written"); return; }
    const batch = db.batch();
    for (const [k, a] of writes) batch.put(k, JSON.stringify(a));
    batch.put(lib[0], JSON.stringify(lib[1]));
    await batch.write();
    // read back
    let ok = 0;
    const libBack = JSON.parse(await db.get(lib[0]));
    for (const [k] of writes) {
      const a = JSON.parse(await db.get(k));
      if (isEmpty(a.system.body) && libBack.flags[NS].layoutLibrary.layouts[a.flags[NS].layoutRef]) ok++;
    }
    console.log(`written; read back ${ok}/${writes.length} actors resolve in the library`);
    if (ok !== writes.length) process.exitCode = 1;
  } finally { await db.close(); }
})().catch((e) => { console.error(e.message); process.exit(1); });
