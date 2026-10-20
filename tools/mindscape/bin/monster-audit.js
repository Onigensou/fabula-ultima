#!/usr/bin/env node
"use strict";
//
// Mindscape — Monster Audit.  READ-ONLY on the real world (reads a copy).
//
// One card per monster in the Encounter Matrix report: HP, DEF/MDEF as the party's hit
// rate, attack averages, damage when resisted as a share of PC HP, affinities, turns per
// round, and the design rules each one breaks. Numbers against rules, not verdicts.
//
//   node bin/encounter-matrix.js --out expectations/encounter-matrix.json   # first: picks the monsters
//   node bin/monster-audit.js --md expectations/monster-audit.md
//
// Live-only checks (FUCompanion.api.lint, sheet render) are NOT run here — run them in
// the client, filtered to these names (memory: reference_live_content_linters).

const fs = require("fs");
const os = require("os");
const path = require("path");
const { DEFAULT_WORLD } = require("../../safe-edit/lib/paths");
const { loadAll, loadParty } = require("../lib/load-actors");
const { extractActions } = require("../lib/skills");
const RX = require("../lib/reactions");
const MD = require("../lib/monster-data");
const { snapshotWorld } = require("./encounter-matrix");

// Party average hit rate by DEF/MDEF, L41 snapshot (memory: project_party_stat_snapshot).
const HIT_RATE = { 12: 0.577, 13: 0.492, 14: 0.405, 15: 0.326, 16: 0.257, 17: 0.197 };
const BASIC_ATTACK_MIN = 45;      // Monster Design Rules checklist
const RESISTED_MIN = 0.25;        // x0.5 damage still ~25-30% of a PC's HP (multi-party rule)
const PE_MAX = 0.33;

function parseArgs(argv) {
  const out = { matrix: "expectations/encounter-matrix.json", world: DEFAULT_WORLD };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--matrix") out.matrix = argv[++i];
    else if (a === "--md") out.md = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--names") out.names = argv[++i].split(",").map((x) => x.trim()).filter(Boolean);
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

const s = (v) => String(v ?? "").trim();
const tgt = (n) => (n > 1 ? (Number.isFinite(n) ? ` ×${n}` : " ×all") : "");
const pct = (x) => (x == null ? "—" : `${Math.round(100 * x)}%`);

// E[max(dA, dB)] for two fair dice, exact.
function expectedMax(a, b) {
  let t = 0;
  for (let i = 1; i <= a; i++) for (let j = 1; j <= b; j++) t += Math.max(i, j);
  return t / (a * b);
}
function hitRate(def) {
  if (def == null) return null;
  if (def < 12) return { label: `>${pct(HIT_RATE[12])}`, value: null };
  if (def > 17) return { label: `<${pct(HIT_RATE[17])}`, value: null };
  return { label: pct(HIT_RATE[def]), value: HIT_RATE[def] };
}

// Pure: a combat model -> its audit card. Exported for tests.
function auditMonster(m, { meanPcHp, monsterRules = "registry" }) {
  const ex = extractActions(m);
  const die = (attr) => (attr ? m.attributes?.[String(attr).toLowerCase()] : null);
  const attacks = ex.actions.map((a) => {
    const dA = die(a.attrA), dB = die(a.attrB);
    const avg = (dA && dB ? expectedMax(dA, dB) : 0) + (Number(a.damageBonus) || 0);
    return { name: a.name, type: a.skillType, element: a.element, targets: a.target?.count ?? 1, avg: Math.round(avg), vs: a.defenseTarget };
  }).sort((a, b) => b.avg - a.avg);
  const affs = m.affinities ?? {};
  const by = (k) => Object.entries(affs).filter(([, v]) => v === k).map(([e]) => e);
  const vu = by("VU"), rs = by("RS"), im = by("IM"), ab = by("AB");
  const rank = s(m.rank).toLowerCase() || "?";
  const best = attacks.find((a) => a.type === "Attack") ?? attacks[0] ?? null;

  const flags = [];
  if (!attacks.length) flags.push("no damage action the sim can read");
  if ((rank === "soldier" || rank === "elite") && vu.length !== 1) flags.push(`${vu.length} VU (rule: exactly 1 for ${rank})`);
  if (ab.length) flags.push(`absorbs ${ab.join(", ")} (warning signal)`);
  if (best && best.avg < BASIC_ATTACK_MIN) flags.push(`best basic attack avg ${best.avg} < ${BASIC_ATTACK_MIN}`);
  if (best && meanPcHp && best.avg / 2 / meanPcHp < RESISTED_MIN && rank !== "soldier") {
    flags.push(`resisted hit = ${pct(best.avg / 2 / meanPcHp)} of PC HP (< ${pct(RESISTED_MIN)})`);
  }
  if (monsterRules === "data") {
    // The interpreter reads the monster's own tables: what it cannot run, and what the
    // action table does that its author may not intend (lib/monster-data.js).
    const cov = MD.coverage(m);
    if (cov.length) flags.push(`not simulated: ${cov.join("; ")}`);
    for (const l of MD.lintPatterns(m)) flags.push(`pattern: ${l}`);
  } else {
    const gaps = [...ex.unmodelled, ...ex.unmodelledUtility].map((u) => u.name);
    if (gaps.length) flags.push(`not modelled in the sim: ${gaps.join(", ")}`);
    // Passives the engine has no rule for (reactions.js registry + traits).
    const passives = RX.undeclaredReactions(ex.passives);
    if (passives.length) flags.push(`passive not simulated: ${passives.join(", ")}`);
  }

  return {
    name: m.name, rank, level: m.level, species: m.species, hp: m.hp?.max, mp: m.mp?.max,
    turns: m.turnsPerRound ?? 1, def: m.def, mdef: m.mdef, hitDef: hitRate(m.def)?.label, hitMdef: hitRate(m.mdef)?.label,
    vu, rs, im, ab, attacks, basic: best, flags,
  };
}

function render(cards, meta) {
  const o = [];
  o.push(`# Monster Audit — ${meta.dungeons.join(" + ")}`);
  o.push("");
  o.push(`${meta.generated.slice(0, 10)} · party ${meta.party.join(", ")} · mean PC HP ${meta.meanPcHp}`);
  o.push("");
  o.push(`> Numbers against the design rules, not verdicts. Hit rates are the party's L41 averages. "Resisted hit" checks elites and bosses only. PE (≤ ${pct(PE_MAX)}) and the live linters are not checked here.`);
  o.push("");
  o.push("| Monster | Rank | Lvl | HP | Turns | DEF (party hits) | MDEF (party hits) | VU | RS / IM / AB | Basic attack · strongest (avg) | Rules broken |");
  o.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const c of cards) {
    const best = c.basic;
    const top = c.attacks[0];
    const resist = [c.rs.join(", ") || "—", c.im.join(", ") || "—", c.ab.join(", ") || "—"].join(" / ");
    o.push(`| ${c.name} | ${c.rank} | ${c.level} | ${c.hp ?? "?"} | ${c.turns} | ${c.def} (${c.hitDef}) | ${c.mdef} (${c.hitMdef}) | ${c.vu.join(", ") || "—"} | ${resist} | ${best ? `${best.name} ${best.avg}${tgt(best.targets)}` : "—"}${top && top !== best ? ` · ${top.name} ${top.avg}${tgt(top.targets)}` : ""} | ${c.flags.join("; ") || "—"} |`);
  }
  o.push("");
  o.push("## Attacks per monster");
  for (const c of cards) {
    o.push("");
    o.push(`**${c.name}** — ${c.attacks.map((a) => `${a.name} ${a.avg}${tgt(a.targets)} (${a.element || "?"}, vs ${a.vs || "?"})`).join(" · ") || "none readable"}`);
  }
  return o.join("\n");
}

async function main() {
  const args = parseArgs(process.argv);
  let names = args.names;
  let dungeons = ["(named)"];
  let monsterRules = "data";
  if (!names) {
    const matrix = JSON.parse(fs.readFileSync(path.resolve(args.matrix), "utf8"));
    dungeons = matrix.dungeons;
    monsterRules = matrix.monsterRules ?? "registry";
    names = [...new Set(matrix.lines.flatMap((l) => l.enemies))];
  }
  const copyDir = path.join(os.tmpdir(), "fu-monster-audit");
  const world = snapshotWorld(args.world, copyDir);
  try {
    const all = await loadAll({ world });
    const party = await loadParty({ world });
    const meanPcHp = Math.round(party.reduce((a, p) => a + (p.hp.max ?? 0), 0) / party.length);
    const byName = new Map(all.filter((a) => a.isNpc).map((a) => [s(a.name).toLowerCase(), a]));
    const cards = [];
    for (const n of names) {
      const m = byName.get(n.toLowerCase()) ?? byName.get(n.replace(/^⭐️?\s*/u, "").toLowerCase());
      if (!m) { console.warn(`no monster actor named "${n}"`); continue; }
      cards.push(auditMonster(m, { meanPcHp, monsterRules }));
    }
    cards.sort((a, b) => a.name.localeCompare(b.name));
    const meta = { generated: new Date().toISOString(), dungeons, monsterRules, party: party.map((p) => p.name), meanPcHp };
    const md = render(cards, meta);
    console.log(md);
    if (args.md) { fs.writeFileSync(path.resolve(args.md), md + "\n"); console.log(`\nwrote ${args.md}`); }
    if (args.out) { fs.writeFileSync(path.resolve(args.out), JSON.stringify({ ...meta, cards }, null, 2) + "\n"); console.log(`wrote ${args.out}`); }
  } finally {
    fs.rmSync(copyDir, { recursive: true, force: true });
  }
}

module.exports = { auditMonster, expectedMax };
if (require.main === module) main().catch((e) => { console.error(`\nmonster-audit failed: ${e.stack || e.message}\n`); process.exit(1); });
