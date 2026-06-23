#!/usr/bin/env node
"use strict";

/**
 * world-import — apply authored-content JSON back INTO the live world.
 *
 * The counterpart to world-export. Where export reads the LevelDB and writes
 * per-document JSON, import reads that JSON and reconciles the live world to
 * match it — the missing primitive for MERGE-based concurrency:
 *
 *   1. both devs commit the JSON companion (world-export already does this),
 *   2. git merges it per-document (different docs merge cleanly; same-doc
 *      edits conflict in readable JSON you can actually resolve),
 *   3. `world-import apply` makes the live world match the merged JSON.
 *
 * Also the clean recovery path after a binary LevelDB conflict: take one side's
 * collection, then `world-import apply --only <dropped docs> --ref <their commit>`
 * to re-add the other side's documents from their JSON.
 *
 * WHY VIA THE BRIDGE (not raw LevelDB): a parent doc stores its embedded items
 * BOTH inline AND as separate `!actors.items!…` keys, kept consistent by Foundry.
 * Reproducing that in a raw writer corrupts the world (it's why safe-edit refuses
 * embedded writes). So import drives Foundry's own document API through the
 * test-bridge — Foundry writes the LevelDB correctly. The GAME MUST BE OPEN.
 *
 * NON-DESTRUCTIVE: creates missing docs, updates existing ones, upserts embedded
 * items/effects. It never DELETES a world doc or embedded doc absent from the
 * JSON (pruning a removal is the dangerous case — do it deliberately, by hand).
 *
 * Usage:
 *   node bin/world-import.js plan  [--only a.json,b.json] [--ref <gitref>] [--all]
 *   node bin/world-import.js apply [--only …] [--ref <gitref>] [--all]
 *
 *   plan  = dry-run: report what WOULD change (default; safe, read-only).
 *   apply = execute the upsert via the bridge.
 *   --only = restrict to specific docs (relpath under _authored-export, or bare
 *            id). REQUIRED for apply unless --all is given (guards against an
 *            accidental whole-world overwrite).
 *   --ref  = read the JSON from a git commit's export tree instead of the
 *            working tree (e.g. import the co-dev's version / a post-merge tree).
 *   --world W (default fabula-ultima-2)
 */

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { REPO_ROOT, worldDataDir, DEFAULT_WORLD } = require("../lib/paths");

const COLLECTIONS = ["folders", "items", "actors"];

function exportRel(world) {
  return path.relative(REPO_ROOT, path.join(worldDataDir(world), "..", "_authored-export"))
    .split(path.sep).join("/");
}

// --- read the JSON docs to import ------------------------------------------
function git(args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 1 << 28 });
}

// Returns { folders:[doc], items:[doc], actors:[doc] } from working tree or a ref.
function loadDocs(world, ref, only) {
  const root = exportRel(world);
  const wantedIds = only ? new Set(only.map((s) => s.replace(/\.json$/, "").split("/").pop())) : null;
  const out = { folders: [], items: [], actors: [] };
  for (const col of COLLECTIONS) {
    const dir = `${root}/${col}`;
    let files;
    if (ref) {
      files = git(["ls-tree", "-r", "--name-only", ref, "--", dir])
        .split("\n").map((s) => s.trim()).filter((f) => f.endsWith(".json"));
    } else {
      const abs = path.join(REPO_ROOT, dir);
      files = fs.existsSync(abs)
        ? fs.readdirSync(abs).filter((f) => f.endsWith(".json")).map((f) => `${dir}/${f}`)
        : [];
    }
    for (const f of files) {
      const id = path.basename(f, ".json");
      if (wantedIds && !wantedIds.has(id)) continue;
      const raw = ref ? git(["show", `${ref}:${f}`]) : fs.readFileSync(path.join(REPO_ROOT, f), "utf8");
      out[col].push(JSON.parse(raw));
    }
  }
  return out;
}

// --- bridge IPC (self-contained; tools/test-bridge-client is not shipped) ----
function bridgeDir(world) {
  return path.join(worldDataDir(world), "..", "test-bridge");
}

async function bridgeEval(world, code, args) {
  const dir = bridgeDir(world);
  const secretPath = path.join(dir, "bridge-secret.txt");
  if (!fs.existsSync(secretPath)) {
    throw new Error(`No bridge secret at ${secretPath}. Is Foundry open with the bridge active?`);
  }
  const secret = fs.readFileSync(secretPath, "utf8").trim();
  const id = "wi" + Math.random().toString(36).slice(2, 9);
  const reqPath = path.join(dir, "inbox", `req-${id}.json`);
  const resPath = path.join(dir, "outbox", `res-${id}.json`);
  const wrapped = `const ARGS = ${JSON.stringify(args)};\n${code}`;
  // Bulk imports (many actors / embedded skills + per-item CSB reload) exceed
  // the bridge's 30s default. Ask for the bridge max (clamped to 5min there) and
  // wait a touch longer on this side so we read the result rather than racing it.
  fs.writeFileSync(reqPath, JSON.stringify({ id, kind: "evalGM", auth: secret, timeoutMs: 300000, args: { code: wrapped } }));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const started = Date.now();
  let res = null;
  while (Date.now() - started < 320000) {
    if (fs.existsSync(resPath)) { res = JSON.parse(fs.readFileSync(resPath, "utf8")); break; }
    await sleep(200);
  }
  try { fs.existsSync(reqPath) && fs.unlinkSync(reqPath); } catch { /* ignore */ }
  try { fs.existsSync(resPath) && fs.unlinkSync(resPath); } catch { /* ignore */ }
  if (!res) throw new Error("No bridge response after 320s — is Foundry open and the bridge running?");
  if (!res.ok) throw new Error(`bridge eval error: ${res.error}\n${res.errorStack || ""}`);
  return res.result;
}

// --- Foundry-side upsert (runs inside the open world via evalGM) ------------
// Non-destructive create-or-update with embedded reconciliation. Returns a plan.
const FOUNDRY_UPSERT = `
const { docs, apply } = ARGS;
const plan = { apply, folders:{create:[],update:[]}, items:{create:[],update:[]},
  actors:{create:[],update:[]}, embedded:{ itemsCreated:0, itemsUpdated:0, effectsUpserted:0 }, errors:[] };

const reloadCSB = async (doc) => { try { await doc.templateSystem?.reloadTemplate?.(); } catch (e) {} };

// Reconcile an embedded collection (Item or ActiveEffect) on a parent — upsert only.
async function upsertEmbedded(parent, type, wanted) {
  for (const w of (wanted || [])) {
    const ex = parent.getEmbeddedDocument(type, w._id);
    if (!ex) {
      if (apply) {
        const created = await parent.createEmbeddedDocuments(type, [w], { keepId: true });
        if (!created || !created.length) { plan.errors.push(\`\${type} create rejected on \${parent.name}: \${w.name} (\${w._id})\`); continue; }
      }
      if (type === "Item") plan.embedded.itemsCreated++; else plan.embedded.effectsUpserted++;
    } else {
      if (apply) await parent.updateEmbeddedDocuments(type, [{ _id: w._id, name: w.name, img: w.img,
        system: w.system, flags: w.flags, ...(type==="ActiveEffect"?{changes:w.changes,disabled:w.disabled,duration:w.duration,statuses:w.statuses,description:w.description,origin:w.origin,transfer:w.transfer}:{}) }]);
      if (type === "Item") plan.embedded.itemsUpdated++; else plan.embedded.effectsUpserted++;
    }
    if (type === "Item") { const it = parent.getEmbeddedDocument("Item", w._id); if (it) { await upsertEmbedded(it, "ActiveEffect", w.effects); if (apply) await reloadCSB(it); } }
  }
}

try {
  for (const f of (docs.folders || [])) {
    const ex = game.folders.get(f._id);
    if (!ex) { if (apply) { const c = await Folder.create(f, { keepId: true }); if (!c) { plan.errors.push(\`folder create rejected: \${f.name} (\${f._id})\`); continue; } } plan.folders.create.push(f.name); }
    else { if (apply) await ex.update({ name:f.name, color:f.color, sort:f.sort, folder:f.folder, flags:f.flags }); plan.folders.update.push(f.name); }
  }
  for (const it of (docs.items || [])) {
    const ex = game.items.get(it._id);
    if (!ex) { if (apply) { const c = await Item.create(it, { keepId: true }); if (!c) { plan.errors.push(\`item create rejected: \${it.name} (\${it._id})\`); continue; } await reloadCSB(c); } plan.items.create.push(it.name); }
    else {
      if (apply) await ex.update({ name:it.name, img:it.img, system:it.system, flags:it.flags, folder:it.folder, sort:it.sort });
      await upsertEmbedded(ex, "ActiveEffect", it.effects); // counts in dry-run; writes gated inside
      if (apply) await reloadCSB(ex);
      plan.items.update.push(it.name);
    }
  }
  for (const a of (docs.actors || [])) {
    const ex = game.actors.get(a._id);
    if (!ex) { if (apply) { const c = await Actor.create(a, { keepId: true }); if (!c) { plan.errors.push(\`actor create rejected: \${a.name} (\${a._id})\`); continue; } for (const it of c.items) await reloadCSB(it); } plan.actors.create.push(a.name); }
    else {
      if (apply) await ex.update({ name:a.name, img:a.img, system:a.system, prototypeToken:a.prototypeToken, flags:a.flags, folder:a.folder, sort:a.sort, ownership:a.ownership });
      await upsertEmbedded(ex, "Item", a.items);          // counts in dry-run; writes gated inside
      await upsertEmbedded(ex, "ActiveEffect", a.effects);
      plan.actors.update.push(a.name);
    }
  }
} catch (e) { plan.errors.push(String(e?.message || e)); }
return plan;
`;

// --- cli -------------------------------------------------------------------
function parseList(argv, flag) {
  const i = argv.indexOf(flag);
  if (i < 0) return null;
  return argv[i + 1].split(",").map((s) => s.trim()).filter(Boolean);
}
function getFlag(argv, flag, def) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : def;
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!["plan", "apply"].includes(cmd)) {
    console.error('Usage: world-import.js plan|apply [--only a.json,b.json] [--ref <gitref>] [--all] [--world W]');
    process.exit(2);
  }
  const world = getFlag(argv, "--world", DEFAULT_WORLD);
  const ref = getFlag(argv, "--ref", null);
  const only = parseList(argv, "--only");
  const all = argv.includes("--all");
  const apply = cmd === "apply";

  if (apply && !only && !all) {
    console.error("Refusing to apply the WHOLE export without --all. Pass --only <docs> or --all.");
    process.exit(2);
  }

  const docs = loadDocs(world, ref, only);
  const counts = COLLECTIONS.map((c) => `${c}:${docs[c].length}`).join(" ");
  console.log(`loaded ${counts}${ref ? ` (from ${ref})` : " (working tree)"}${only ? ` filtered to ${only.length}` : ""}`);
  if (COLLECTIONS.every((c) => docs[c].length === 0)) { console.log("nothing to import."); return; }

  console.log(apply ? "applying via bridge (game must be open)…" : "dry-run via bridge (no writes)…");
  const plan = await bridgeEval(world, FOUNDRY_UPSERT, { docs, apply });

  const sec = (label, o) => `  ${label}: +${o.create.length} create, ~${o.update.length} update`;
  console.log(`\n=== world-import ${cmd} (${world}) ===`);
  console.log(sec("folders", plan.folders));
  console.log(sec("items", plan.items));
  console.log(sec("actors", plan.actors));
  console.log(`  embedded: items +${plan.embedded.itemsCreated}/~${plan.embedded.itemsUpdated}, effects ${plan.embedded.effectsUpserted}`);
  const names = [...plan.folders.create.map((n) => `+folder ${n}`), ...plan.items.create.map((n) => `+item ${n}`), ...plan.actors.create.map((n) => `+actor ${n}`)];
  if (names.length) console.log("\n  new documents:\n" + names.map((n) => `     ${n}`).join("\n"));
  if (plan.errors.length) { console.log("\n  ⚠ ERRORS:\n" + plan.errors.map((e) => `     ${e}`).join("\n")); process.exit(1); }
  console.log(apply ? "\n  ✓ applied. Re-run `world-export report` to confirm the world matches." : "\n  (dry-run — pass `apply` to write.)");
}

if (require.main === module) {
  main().catch((e) => { console.error(`world-import failed: ${e.message}`); process.exit(1); });
}

module.exports = { loadDocs, FOUNDRY_UPSERT };
