"use strict";
// move-engine Phase 4: a skill's GAME NUMBERS, measured in real Battle Director sim battles (snapshot runner, canvas on:
// the damage numbers are what the players see). One battle per run: the block's `pack` setup (who, with which weapon, at
// whom), the skill cast once, every damage number on the target recorded per strike (BD's `cascade` index; a miss is null).
// The block is applied to the runner's world first (the same seed helper as the export), so the pack measures the block as
// it stands, with the slider values it was resolved at. Writes moves/<family>/packs/<block>.json for the page's skill panel.
//   node bin/move-engine.js pack <family> <block> [--runs 3] [--code <ref>] [--snapshot <dir> --port <n>]
const fs = require("fs");
const path = require("path");
const { spawnSync, execSync } = require("child_process");
const { resolve } = require("./skill-export.js");
const ROOT = path.join(__dirname, "..");
const DATA = process.env.MOVE_ENGINE_DATA || "C:/Users/Oni/AppData/Local/FoundryVTT/Data";

function packEval(block, setup, runs) {
  return `
const NS = "fabula-ultima-companion";
const BLOCK = ${JSON.stringify(block)}, O = ${JSON.stringify({ ...setup, runs })};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 240 && !FUCompanion.api.experimental?.sim?.mode; i++) await wait(250);
await wait(2000);
const seed = await import("/modules/fabula-ultima-companion/data-migrations/_move-engine-skill-seed.js?x=" + Date.now());
await seed.applySkills(game, [BLOCK], { dryRun: false });
const sim = FUCompanion.api.experimental.sim;
if (game.paused) await game.togglePause(false, true);
const actor = game.actors.find((a) => a.name === O.actor && a.hasPlayerOwner) ?? game.actors.getName(O.actor);
const dummy = game.actors.getName(O.target);
const ES = await import("/modules/fabula-ultima-companion/scripts/battle-director/equipment-swap.js");
for (const e of actor.effects.filter((e) => e.flags?.[NS]?.innerWellspring || /wellspring/i.test(e.name ?? ""))) await e.delete();
if (O.weapon) { const w = game.items.getName(O.weapon);
  const d = w.toObject(); delete d._id; const [nw] = await actor.createEmbeddedDocuments("Item", [d]);
  for (const k of game.items.filter((i) => i.system?.container === w.id)) { const kd = k.toObject(); delete kd._id; kd.system.container = nw.id; await actor.createEmbeddedDocuments("Item", [kd]); }
  await ES.applyEquipmentSwap(actor, { main: nw.id, off: null });
  if (!nw.system?.props?.isEquipped) await nw.update({ "system.props.isEquipped": true }); }
const out = { runs: [] };
for (let n = 0; n < O.runs; n++) {
  const nums = []; const h = Hooks.on("fuDamageNumber", (p) => nums.push({ kind: p.kind, token: p.tokenUuid, amount: p.amount ?? null, resource: p.resource ?? null, crit: !!p.isCrit, cascade: p.cascade ?? null, element: p.element ?? null, affinity: p.affinity ?? null }));
  let err = null;
  try { await sim.run({ enemies: [{ uuid: dummy.uuid, quantity: 1 }], party: [actor.uuid], pace: "fast", maxRounds: 1, expectedRounds: 1, guests: false,
    scripts: [{ caster: actor.uuid, skill: O.skill, targets: "enemy", once: true }] }); } catch (e) { err = String(e?.message ?? e); }
  Hooks.off("fuDamageNumber", h);
  out.runs.push({ err, nums });
}
return out;
`;
}

// the skill's numbers out of one battle's damage-number stream: BD numbers each strike of a Chain (`cascade` 1..n, a Perfect
// bonus after them); the target = the token with the most numbered strikes. Spends are NOT an anchor: a battle opens with
// other MP spends, and a strike's number can arrive before the cost's.
function readRun(nums, count) {
  const numbered = nums.filter((x) => x.cascade != null && (x.kind === "miss" || (x.kind === "loss" && x.resource === "hp")));
  const by = {}; for (const x of numbered) by[x.token] = (by[x.token] || 0) + 1;
  const target = Object.keys(by).sort((a, b) => by[b] - by[a])[0];
  let mine = numbered.filter((x) => x.token === target);
  if (!mine.length) { const hp = nums.filter((x) => x.kind === "loss" && x.resource === "hp"); mine = hp.length ? [{ ...hp[0], cascade: 1 }] : []; }   // a single hit: its first HP number
  const strikes = Array(count).fill(undefined), extra = [];
  for (const x of mine) { const k = Number(x.cascade); const v = x.kind === "miss" ? null : x.amount;
    if (k >= 1 && k <= count && strikes[k - 1] === undefined) strikes[k - 1] = v; else if (v != null) extra.push(v); }
  const s = strikes.map((v) => (v === undefined ? null : v));
  const first = mine.find((x) => x.kind === "loss");
  return { strikes: s, extra, total: s.reduce((a, v) => a + (v || 0), 0) + extra.reduce((a, v) => a + v, 0),
    crit: mine.some((x) => x.crit), perfect: s.every((v) => v != null) && extra.length > 0,
    element: first?.element ?? null, affinity: first?.affinity ?? null };
}

function pack(family, key, { runs = 3, code = null, snapshot = "snap-blade", port = 30170, reread = false } = {}) {
  const r = resolve(family, [key])[key]; if (!r) throw new Error("no block " + key);
  const setup = r.block.pack || require(path.join(ROOT, "moves", family, "skills.js"))[key].pack;
  if (!setup) throw new Error(key + ": no `pack` setup on the block ({ actor, weapon, target, skill, strikes })");
  const outDir = path.join(ROOT, "out", "pack", family); fs.mkdirSync(outDir, { recursive: true });
  const evalFile = path.join(outDir, key + "-eval.js"), dump = path.join(outDir, key + ".json");
  const { pack: _p, ...block } = r.block;
  fs.writeFileSync(evalFile, packEval(block, setup, runs));
  const args = ["../snapshot-runner/bin/run.mjs", "--snapshot", snapshot, "--port", String(port), "--canvas", "full", "--eval", evalFile, "--dump", dump, ...(code ? ["--code", code] : [])];
  // --reread: parse the last battles again (the runner dump) without fighting them again
  const res = reread && fs.existsSync(dump) ? {} : spawnSync(process.execPath, args, { cwd: path.join(DATA, "tools", "fvtt-playwright"), encoding: "utf8", timeout: 3600000 });
  if (!fs.existsSync(dump)) throw new Error("the snapshot runner wrote no result:\n" + ((res.stdout || "") + (res.stderr || "")).slice(-2000));
  const raw = JSON.parse(fs.readFileSync(dump, "utf8")); const x = raw.result || raw;
  const count = setup.strikes || 1;
  const out = {
    block: key, skill: r.block.doc.name, setup, measuredAt: new Date().toISOString().slice(0, 10),
    code: code || (() => { try { return execSync("git rev-parse --short HEAD", { cwd: ROOT, encoding: "utf8" }).trim(); } catch { return "working tree"; } })(),
    bound: Object.fromEntries(r.bound.map((b) => [b.slider, b.value])),
    runs: x.runs.map((run) => (run.err ? { error: run.err, strikes: [], total: 0 } : readRun(run.nums, count))),
  };
  const file = path.join(ROOT, "moves", family, "packs", key + ".json");
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(out, null, 1) + "\n");
  return { file, out };
}
module.exports = { pack, readRun };
