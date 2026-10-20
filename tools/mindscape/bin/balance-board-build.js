#!/usr/bin/env node
"use strict";
//
// Mindscape — Balance Board builder. Merges the Encounter Matrix, the Monster Audit and
// the live calibration into one dataset and writes it into the Balance Board page.
//
//   node bin/encounter-matrix.js --out expectations/encounter-matrix.json   # first
//   node bin/monster-audit.js --out expectations/monster-audit.json
//   node bin/balance-board-build.js
//
// Template: balance-board/template.html (the dataset replaces the DATA marker).
// Output:   balance-board/balance-board.html, published as a claude.ai artifact.

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));
const slug = (x) => String(x).toLowerCase().normalize("NFKD").replace(/^⭐️?\s*/u, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const round = (x, d = 3) => (x == null ? null : Number(Number(x).toFixed(d)));

const matrix = read("expectations/encounter-matrix.json");
const audit = read("expectations/monster-audit.json");
let live = null;
try { live = read("expectations/live-calibration.json"); } catch {}

const cards = Object.fromEntries(audit.cards.map((c) => [slug(c.name), c]));

// Same bands as the Matrix report: normal 1.5-2 (long 4), boss 5.5-6 (long 7.5); party HP
// left under 70% is pressure, 85%+ is trivial.
function verdict(l) {
  const s = l.stats;
  if (s.win < 0.5 && s.defeat > 0.3) return "wall";
  if (s.overtime > 0.3 || (s.roundsP50 ?? 99) > (l.kind === "boss" ? 7.5 : 4)) return "long";
  if (s.hpP50 >= 0.85) return "trivial";
  if (s.hpP50 >= 0.70) return "low";
  return "target";
}

function trustNotes(l) {
  const out = [];
  for (const n of l.notes ?? []) if (n.startsWith("never acts")) out.push(`${n.replace("never acts: ", "")} never acts in the sim — its stance is never armed`);
  for (const name of new Set(l.enemies)) {
    const c = cards[slug(name)];
    if (!c) continue;
    if (c.flags.some((f) => f.startsWith("no damage action"))) out.push(`${c.name}: the sim cannot read its attack`);
    const gap = c.flags.find((f) => f.startsWith("not modelled in the sim:"));
    const count = gap ? gap.split(":")[1].split(",").length : 0;
    if (count >= 3) out.push(`${c.name}: ${count} of its actions are not simulated`);
    else if (count && l.kind === "boss" && (l.stats?.win ?? 0) === 0) out.push(`${c.name}: ${gap.split(":")[1].trim()} not simulated, and the fight never resolves`);
    const pas = c.flags.find((f) => f.startsWith("passive not simulated:"));
    if (pas) out.push(`${c.name}'s ${pas.split(":")[1].trim()} is not simulated`);
  }
  return [...new Set(out)];
}

// Live runs, matched to a fight by its enemy list.
const key = (names) => names.map(slug).sort().join("+");
const liveByKey = {};
for (const f of live?.fights ?? []) liveByKey[key(f.enemies)] = { ...f.live, stalled: f.liveStalled ?? 0 };

const fights = matrix.lines.filter((l) => !l.error && l.stats).map((l) => {
  const area = l.dungeon.startsWith("Fafnir") ? "F" : "V";
  const num = l.range ? String(l.range[0]) : "story";
  const counts = {};
  for (const n of l.enemies) counts[n] = (counts[n] ?? 0) + 1;
  const s = l.stats;
  return {
    id: `${area}-${num === "story" ? slug(l.enemies.join("-")) : num.padStart(2, "0")}`,
    area, dungeon: l.dungeon, num, story: !l.range,
    groups: Object.entries(counts).map(([name, count]) => ({ name, count, id: slug(name) })),
    lineup: l.enemies,   // table order: the in-page simulator spawns them in this order
    kind: l.kind, level: l.level, enemyHp: l.enemyHp,
    actions: l.enemies.reduce((t, n) => t + (cards[slug(n)]?.turns ?? 1), 0),
    rolls: l.story ? null : round(l.weight),
    win: round(s.win), defeat: round(s.defeat), overtime: round(s.overtime),
    rounds: s.roundsP50, roundsAll: s.roundsAllP50, hpWin: round(s.hpP50), hpEnd: round(s.hpEndP50), ko: round(s.anyDown),
    verdict: verdict(l),
    trust: trustNotes(l),
    live: liveByKey[key(l.enemies)] ?? null,
  };
});

const monsters = audit.cards.map((c) => ({
  id: slug(c.name), name: c.name, rank: c.rank, level: c.level, hp: c.hp, turns: c.turns,
  def: c.def, mdef: c.mdef, hitDef: c.hitDef, hitMdef: c.hitMdef, vu: c.vu, rs: c.rs, im: c.im, ab: c.ab,
  basic: c.basic ? { name: c.basic.name, avg: c.basic.avg } : null,
  strongest: c.attacks[0] ? { name: c.attacks[0].name, avg: c.attacks[0].avg, targets: Number.isFinite(c.attacks[0].targets) ? c.attacks[0].targets : "all" } : null,
  flags: c.flags,
  fights: fights.filter((f) => f.groups.some((g) => g.id === slug(c.name))).map((f) => f.id),
}));

const data = {
  generated: matrix.generated, policy: matrix.policy ?? "legacy", runs: matrix.runs,
  party: matrix.party, liveScenario: live?.scenario ?? null,
  fights, monsters,
};

// Token sprites (bin/balance-board-sprites.js), embedded as data URIs with their token
// scale so the page draws a Colossus taller than a slime, as the battle map does.
data.sprites = {};
const spriteDir = path.join(ROOT, "balance-board", ".sprites");
try {
  const manifest = JSON.parse(fs.readFileSync(path.join(spriteDir, "manifest.json"), "utf8"));
  for (const [id, m] of Object.entries(manifest)) {
    const ext = path.extname(m.file).slice(1).toLowerCase();
    const mime = ext === "webp" ? "image/webp" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/png";
    data.sprites[id] = { name: m.name, scale: m.scale, party: m.party, src: `data:${mime};base64,${fs.readFileSync(path.join(spriteDir, m.file)).toString("base64")}` };
  }
} catch {
  console.warn("no sprite cache — run bin/balance-board-sprites.js first; the page falls back to name plates");
}

// In-page battle simulator: the real engine, bundled, plus the party and every monster as
// slim combat models. Refuses to build if a battle through the bundle differs from Node.
async function simPayload() {
  const os = require("os");
  const vm = require("vm");
  const { snapshotWorld } = require("./encounter-matrix");
  const { loadParty, loadNamed } = require("../lib/load-actors");
  const { runBattle } = require("../lib/engine");
  const { Rng } = require("../lib/rng");
  const { slimModel } = require("../lib/slim-model");
  const { bundleEngine } = require("../lib/browser-bundle");
  const copyDir = path.join(os.tmpdir(), "fu-board-sim");
  const world = snapshotWorld(require("../../safe-edit/lib/paths").DEFAULT_WORLD, copyDir);
  try {
    const party = (await loadParty({ world })).map(slimModel);
    const names = [...new Set(matrix.lines.filter((l) => !l.error).flatMap((l) => l.enemies))];
    const loaded = await loadNamed(names, { world });
    const monsters = {};
    names.forEach((n, i) => { if (!monsters[n]) monsters[n] = slimModel(loaded[i]); });
    const engine = bundleEngine();
    const ctx = { console };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(engine, ctx);
    ctx.__msTraceHp = true;
    let checked = 0;
    for (const l of matrix.lines.filter((x) => !x.error).slice(0, 6)) {
      const en = l.enemies.map((n) => monsters[n]);
      for (let i = 0; i < 5; i++) {
        const a = runBattle({ party, enemies: en, rng: new Rng(`self:${i}`), expectedRounds: 7, policy: data.policy });
        const b = ctx.Mindscape.runBattle({ party: JSON.parse(JSON.stringify(party)), enemies: JSON.parse(JSON.stringify(en)), rng: new ctx.Mindscape.Rng(`self:${i}`), expectedRounds: 7, policy: data.policy });
        const strip = (log) => JSON.stringify(log.map(({ __hp, ...r }) => r));
        if (strip(a.log) !== strip(b.log)) throw new Error(`page engine differs from Node on ${l.enemies.join(", ")} run ${i}`);
        checked++;
      }
    }
    console.log(`page engine: ${checked} battles identical to Node`);
    return { engine, sim: { party, monsters } };
  } finally {
    fs.rmSync(copyDir, { recursive: true, force: true });
  }
}

(async () => {
  const { engine, sim } = await simPayload();
  data.sim = sim;
  const tpl = fs.readFileSync(path.join(ROOT, "balance-board", "template.html"), "utf8");
  for (const marker of ["/*DATA*/", "/*ENGINE*/"]) if (!tpl.includes(marker)) throw new Error(`template has no ${marker} marker`);
  const html = tpl
    .replace("/*ENGINE*/", () => engine.replace(/<\/script/gi, "<\\/script"))
    .replace("/*DATA*/", () => JSON.stringify(data).replace(/</g, "\\u003c"));
  fs.writeFileSync(path.join(ROOT, "balance-board", "balance-board.html"), html);
  console.log(`Balance Board: ${fights.length} fights, ${monsters.length} monsters, ${Math.round(html.length / 1024)} KB → balance-board/balance-board.html`);
})().catch((e) => { console.error(`balance-board-build failed: ${e.stack || e.message}`); process.exit(1); });
