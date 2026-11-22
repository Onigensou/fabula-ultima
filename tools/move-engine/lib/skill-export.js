"use strict";
// move-engine Phase 4: skill blocks (moves/<family>/skills.js) → the game.
//   resolve   a block + its move's approved slider values (bindings) → the logic fields the game should hold
//   check     run the game-side helper (data-migrations/_move-engine-skill-seed.js) DRY in the snapshot runner: what differs
//             from the world, per copy, plus the skill validator on the would-be document
//   write     a migration file that applies the resolved blocks at GM boot (the same helper, for real)
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { loadDefs, tuneOf } = require("./defs.js");
const ROOT = path.join(__dirname, "..");
const REPO = path.join(ROOT, "..", "..");
const DATA = process.env.MOVE_ENGINE_DATA || "C:/Users/Oni/AppData/Local/FoundryVTT/Data";

function loadSkills(family) { const f = path.join(ROOT, "moves", family, "skills.js"); delete require.cache[require.resolve(f)]; return require(f); }
function familyFiles(family) { const f = path.join(ROOT, "moves", family, "family.json"); if (!fs.existsSync(f)) return [];
  const fam = JSON.parse(fs.readFileSync(f, "utf8")); return [...new Set(Object.values(fam.moves || {}).flatMap((m) => m.files))]; }

// set a bound value: props.x | flags.a.b | effects.<label>.<field> | reactions.<index>.<field>
// (Active Effect values are not bindable yet: `aes` blocks are plain data)
function setPath(block, p, v) {
  const [head, ...rest] = p.split(".");
  if (head === "effects") { const row = block.effects.find((r) => r.effect_label === rest[0]); if (!row) throw new Error("no effect row " + rest[0]); row[rest[1]] = v; return; }
  if (head === "reactions") { const row = block.reactions[Number(rest[0])]; if (!row) throw new Error("no reaction row " + rest[0]); row[rest[1]] = v; return; }
  let o = block[head] = block[head] || {}; for (let i = 0; i < rest.length - 1; i++) o = o[rest[i]] = o[rest[i]] || {}; o[rest[rest.length - 1]] = v;
}
function resolve(family, keys = null, overrides = {}) {
  const skills = loadSkills(family), anyMove = Object.values(skills).some((b) => b.move);
  const SK = anyMove ? loadDefs(family, familyFiles(family)) : null;   // a family of rules-only blocks (no move) loads no move defs
  const out = {};
  for (const [name, b] of Object.entries(skills)) {
    if (keys && keys.length && !keys.includes(name)) continue;
    const block = JSON.parse(JSON.stringify({ doc: b.doc, props: b.props || {}, effects: b.effects || [], reactions: b.reactions || [], flags: b.flags || {}, ...(b.aes ? { aes: b.aes } : {}) }));
    const T = b.move ? tuneOf(SK, b.move, overrides[b.move] || {}) : {};
    const bound = [];
    for (const [k, bind] of Object.entries(b.bind || {})) {
      if (!(k in T)) throw new Error(name + ": slider " + k + " is not on move " + b.move);
      const v = bind.to ? bind.to(T[k], T) : T[k]; setPath(block, bind.path, v); bound.push({ slider: k, value: T[k], path: bind.path, set: v });
    }
    out[name] = { block, move: b.move || null, bound };
  }
  return out;
}

function checkEval(blocks) {
  return `
const BLOCKS = ${JSON.stringify(blocks)};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 240 && !FUCompanion?.api?.lint?.validateSkillDoc; i++) await wait(250);
// the world's own migrations first (the blocks describe the world AFTER them)
for (let i = 0; i < 240; i++) { const done = BLOCKS.every((b) => game.items.get(b.doc.id)); if (done) break; await wait(250); }
await wait(3000);
const seed = await import("/modules/fabula-ultima-companion/data-migrations/_move-engine-skill-seed.js?x=" + Date.now());
const log = []; const r = await seed.applySkills(game, BLOCKS, { dryRun: true, log: (l) => log.push(l) });
// the skill validator on each would-be document (the world item with the block's logic fields on top)
const validation = {};
for (const b of BLOCKS) { const it = game.items.get(b.doc.id); if (!it) continue; const d = it.toObject();
  Object.assign(d.system.props, b.props);
  if ("effects" in b) d.system.props.effect_table = Object.fromEntries(b.effects.map((x, i) => [String(i), x]));
  if ("reactions" in b) d.system.props.reaction_config_table = Object.fromEntries(b.reactions.map((x, i) => [String(i), x]));
  d.flags = d.flags || {}; d.flags["fabula-ultima-companion"] = Object.assign({}, d.flags["fabula-ultima-companion"], b.flags);
  try { const v = FUCompanion.api.lint.validateSkillDoc(d); validation[b.doc.name] = (v.findings || []).map((f) => f.code + ": " + (f.message || f.detail || "")); } catch (e) { validation[b.doc.name] = ["validator threw: " + (e.message || e)]; } }
return { results: r.results, log, validation };
`;
}

function check(family, keys, { code, snapshot = "snap-sonic", port = 30163, outDir } = {}) {
  const resolved = resolve(family, keys);
  const blocks = Object.values(resolved).map((x) => x.block);
  fs.mkdirSync(outDir, { recursive: true });
  const evalFile = path.join(outDir, "skill-check-eval.js"), dump = path.join(outDir, "skill-check.json");
  fs.writeFileSync(evalFile, checkEval(blocks));
  const args = ["../snapshot-runner/bin/run.mjs", "--snapshot", snapshot, "--port", String(port), "--eval", evalFile, "--dump", dump, ...(code ? ["--code", code] : [])];
  const r = spawnSync(process.execPath, args, { cwd: path.join(DATA, "tools", "fvtt-playwright"), encoding: "utf8", timeout: 900000 });
  if (!fs.existsSync(dump)) throw new Error("the snapshot runner wrote no result:\n" + ((r.stdout || "") + (r.stderr || "")).slice(-2000));
  const res = JSON.parse(fs.readFileSync(dump, "utf8")); return { resolved, ...(res.result || res) };
}

// a migration that applies these blocks (resolved now: the file holds plain data, no bindings)
function writeMigration(family, keys, { key, description }) {
  const resolved = resolve(family, keys), blocks = Object.values(resolved).map((x) => x.block);
  const file = path.join(REPO, "modules", "fabula-ultima-companion", "data-migrations", key + ".js");
  const body = `/**
 * Migration: ${key}  (move-engine export of ${family}: ${Object.keys(resolved).join(", ")})
 * ${description}
 * GENERATED by \`node tools/move-engine/bin/move-engine.js export ${family} ${Object.keys(resolved).join(" ")} --write ${key}\`:
 * the skill blocks of tools/move-engine/moves/${family}/skills.js with the approved slider values applied. Applied by
 * _move-engine-skill-seed.js (logic fields only, every copy). Idempotent.
 */
import { applySkills } from "./_move-engine-skill-seed.js";
export const key = ${JSON.stringify(key)};
export const description = ${JSON.stringify(description)};
const BLOCKS = ${JSON.stringify(blocks, null, 1)};
export async function migrate(game, log = () => {}) { const r = await applySkills(game, BLOCKS, { dryRun: false, log }); return { applied: true, summary: JSON.stringify(r.results.map((x) => [x.name, x.copies.map((c) => c.diffs.length)])) }; }
`;
  fs.writeFileSync(file, body);
  const man = path.join(REPO, "modules", "fabula-ultima-companion", "data-migrations", "_manifest.json");
  const m = JSON.parse(fs.readFileSync(man, "utf8"));
  if (!m.migrations.some((x) => x.key === key)) { m.migrations.push({ key, path: "data-migrations/" + key + ".js" }); fs.writeFileSync(man, JSON.stringify(m, null, 2) + "\n"); }
  return file;
}
module.exports = { resolve, check, writeMigration, loadSkills };
