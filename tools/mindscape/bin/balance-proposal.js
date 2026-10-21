#!/usr/bin/env node
"use strict";
//
// Mindscape — measure a monster adjustment plan on paper, before anything touches the world.
//
//   node bin/balance-proposal.js --plan specs/balance/<plan>.json [--runs 1000] [--out file.json] [--md file.md]
//   node bin/balance-proposal.js --plan <file> --design-only     # the design check alone, no sim
//
// Before anything is simulated, every monster the plan touches is checked against its design
// dossier (dossiers/<name>.md): invariants the plan would break, intended rule-breaks it
// would change, and monsters with no design record. Printed first; it never blocks the run.
//
// Plan file: { "<Monster name>": { "hpPct": -30, "dmgAdd": 15, "affinity": { "physical": "NA" },
//                                  "attacks": { "<Attack name>": { "dmgAdd": 10 } } }, ... }
//   hpPct     max HP change in percent
//   dmgAdd    flat damage added to EVERY damaging action the monster has
//   attacks   per-action damage changes (on top of dmgAdd); checkAdd = accuracy bonus
//   checkAdd  accuracy bonus added to every damaging action
//   affinity  element -> VU | RS | IM | AB | NA
//   turns     actions per round (the sheet's activation)
//   def/mdef  defence scores
//   hp        absolute max HP;  ef  weapon efficiency by family, e.g. { "heavy": 200 }
// A top-level "rows" key swaps an encounter row's line-up: { "rows": { "F1": ["Dire Orc", "Dire Orc", "Imp"] } }.
//
// Every fight in the Encounter Matrix report is run twice on the same seeds, baseline and
// patched, under the same party policy, on a COPY of the world. Nothing is written back.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { DEFAULT_WORLD } = require("../../safe-edit/lib/paths");
const { loadParty, loadNamed, readAffinities, readEfficiency, loadSummons } = require("../lib/load-actors");
const { loadStatusLibrary } = require("../lib/world-items");
const { runLine } = require("../lib/line-runner");
const { snapshotWorld, summarise } = require("./encounter-matrix");
const DS = require("../lib/dossier");
const { loadWorldItems } = require("../lib/world-items");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
}
const pct = (x) => (x == null ? "—" : `${Math.round(100 * x)}%`);
const AFF_KEY = { physical: 1, air: 2, bolt: 3, dark: 4, earth: 5, fire: 6, ice: 7, light: 8, poison: 9 };

// Same bands as the Matrix and the Balance Board.
function verdict(s, kind) {
  if (s.win < 0.5 && s.defeat > 0.3) return "wall";
  if (s.overtime > 0.3 || (s.roundsP50 ?? 99) > (kind === "boss" ? 7.5 : 4)) return s.win < 0.5 ? "stalemate" : "drags";
  // Danger is judged at the party's LOWEST point, not at the end: healing and revives
  // before the last enemy falls otherwise read a near-wipe as a safe fight.
  if (s.lowP50 >= 0.85) return "pushover";
  if (s.lowP50 >= 0.70) return "too soft";
  return "on target";
}

function isDamaging(p) {
  const a = String(p.rolled_atr1 ?? "").trim();
  return !!String(p.type_damage ?? "").trim() && !!a && a !== "-";
}

function patchMonster(m, spec) {
  if (spec.hp) { m.hp.max = spec.hp; m.hp.cur = spec.hp; }
  if (spec.ef) {
    for (const [fam, v] of Object.entries(spec.ef)) m._rawProps[`${fam}_ef`] = String(v);
    m.efficiency = readEfficiency(m._rawProps);
  }
  if (spec.hpPct) {
    const hp = Math.max(1, Math.round((m.hp.max ?? m.hp.cur) * (1 + spec.hpPct / 100)));
    m.hp.max = hp; m.hp.cur = hp;
  }
  for (const it of m.items ?? []) {
    const p = it.props ?? {};
    if (!isDamaging(p)) continue;
    const chk = (spec.checkAdd ?? 0) + (spec.attacks?.[it.name]?.checkAdd ?? 0);
    if (chk) p.check_bonus = String((Number(p.check_bonus) || 0) + chk);
    const add = (spec.dmgAdd ?? 0) + (spec.attacks?.[it.name]?.dmgAdd ?? 0);
    if (!add) continue;
    const raw = String(p.damage_bonus ?? "0").trim() || "0";
    p.damage_bonus = /^-?\d+(\.\d+)?$/.test(raw) ? String(Number(raw) + add) : `(${raw}) + ${add}`;
  }
  // Action-table edits: { "<row name>": { priority, cooldown, condition, string, v1, v2 } },
  // applied to every row of that name (Gigas lists Heavy Swing twice).
  for (const [name, edit] of Object.entries(spec.patterns ?? {})) {
    const rows = Object.values(m._rawProps.action_pattern_table ?? {}).filter((r) => r && !r.$deleted && String(r.action_pattern_name).trim() === name);
    if (!rows.length) throw new Error(`${m.name}: no action-table row named "${name}"`);
    for (const r of rows) {
      if (edit.priority != null) r.action_pattern_priority = String(edit.priority);
      if (edit.cooldown != null) r.action_pattern_cooldown = String(edit.cooldown);
      if (edit.condition != null) r.action_pattern_condition = edit.condition;
      if (edit.string != null) r.action_pattern_string = edit.string;
      if (edit.v1 != null) r.action_pattern_value_1 = String(edit.v1);
      if (edit.v2 != null) r.action_pattern_value_2 = String(edit.v2);
    }
  }
  if (spec.mp != null) { m.mp.max = spec.mp; m.mp.cur = spec.mpStart ?? spec.mp; }
  else if (spec.mpStart != null) m.mp.cur = spec.mpStart;
  for (const [name, cost] of Object.entries(spec.costs ?? {})) {
    const it = (m.items ?? []).find((i) => i.name === name);
    if (!it) throw new Error(`${m.name}: no skill named "${name}"`);
    it.props.cost = cost;
  }
  // Effect-row edits: { "<skill>": { "<effect_label>": { field: value } } } (a save DL,
  // a damage amount, a status pool).
  for (const [name, rows] of Object.entries(spec.effects ?? {})) {
    const it = (m.items ?? []).find((i) => i.name === name);
    if (!it) throw new Error(`${m.name}: no skill named "${name}"`);
    for (const [label, fields] of Object.entries(rows)) {
      const row = Object.values(it.props.effect_table ?? {}).find((r) => r && !r.$deleted && r.effect_label === label);
      if (!row) throw new Error(`${m.name} / ${name}: no effect row "${label}"`);
      Object.assign(row, fields);
    }
  }
  if (spec.turns) m.turnsPerRound = spec.turns;
  if (spec.def != null) m.def = spec.def;
  if (spec.mdef != null) m.mdef = spec.mdef;
  if (spec.affinity) {
    for (const [el, v] of Object.entries(spec.affinity)) m._rawProps[`affinity_${AFF_KEY[el]}`] = v;
    m.affinities = readAffinities(m._rawProps);
  }
}

// Which actions a plan entry changes, by name and by kind ("*" = every damaging action):
// damage/accuracy edits vs action-table/cost edits move different design rules.
function touchedActions(spec) {
  const damage = new Set([...Object.keys(spec.attacks ?? {}), ...Object.keys(spec.effects ?? {})]);
  if (spec.dmgAdd || spec.checkAdd) damage.add("*");
  const pattern = new Set([...Object.keys(spec.patterns ?? {}), ...Object.keys(spec.costs ?? {})]);
  return { damage, pattern };
}
const DAMAGE_RULES = new Set(["one-shot", "basic-attack-min", "resisted-min", "no-damage-action"]);
// Exception rules a plan key can move, for exceptions that name no action.
const RULE_KEYS = { "vu-count": ["affinity"], absorb: ["affinity"], "resisted-min": ["dmgAdd", "attacks"],
  "basic-attack-min": ["dmgAdd", "attacks"], "one-shot": ["dmgAdd", "attacks"], pattern: ["patterns", "mp", "mpStart", "costs"] };

// Pure: one plan entry against its dossier -> [{ level: "break"|"intended"|"none"|"role", text }].
function designWarnings(name, spec, dossier, base, patched, { worldItems = null } = {}) {
  if (!dossier) return [{ level: "none", text: `${name}: no design record — its intent is unknown; ask before tuning it (node bin/dossier.js --new "${name}")` }];
  const out = [];
  if (dossier.data.role) out.push({ level: "role", text: `${name}: role — ${dossier.data.role}` });
  const before = DS.checkInvariants(dossier, base, { worldItems });
  const after = DS.checkInvariants(dossier, patched, { worldItems });
  after.forEach((a, i) => {
    if (before[i].ok && !a.ok) out.push({ level: "break", text: `${name}: BREAKS ${a.id} — ${a.text}${a.why ? ` (why it matters: ${a.why})` : ""}` });
  });
  const acts = touchedActions(spec);
  for (const e of dossier.data.exceptions) {
    const lane = DAMAGE_RULES.has(e.rule) ? acts.damage : acts.pattern;
    const hit = e.action ? (lane.has(e.action) || (lane.has("*") && DAMAGE_RULES.has(e.rule)))
      : (RULE_KEYS[e.rule] ?? []).some((k) => spec[k] != null);
    if (hit) out.push({ level: "intended", text: `${name}: changes an intended ${e.rule}${e.action ? ` on ${e.action}` : ""} — ${e.why ?? "no reason recorded"} (${e.decided_by === "user" ? "designer's call" : "unconfirmed"}${e.date ? `, ${e.date}` : ""})` });
  }
  return out;
}

async function designCheck(plan, world) {
  const dossiers = DS.loadDossiers();
  const worldItems = await loadWorldItems({ world });
  const out = [];
  for (const [name, spec] of Object.entries(plan)) {
    const [base] = await loadNamed([name], { world });
    const [patched] = await loadNamed([name], { world });
    patchMonster(patched, spec);
    out.push(...designWarnings(name, spec, DS.findDossier(dossiers, base), base, patched, { worldItems }));
  }
  return out;
}
function renderDesign(warnings) {
  if (!warnings.length) return [];
  const icon = { break: "⛔", intended: "⚠", none: "❔", role: "·" };
  const order = { break: 0, intended: 1, none: 2, role: 3 };
  return ["## Design check (dossiers)", "",
    ...warnings.slice().sort((a, b) => order[a.level] - order[b.level]).map((w) => `- ${icon[w.level]} ${w.text}`), ""];
}

async function loadGroup(names, world, plan) {
  const enemies = await loadNamed(names, { world });
  if (plan) for (const e of new Set(enemies)) if (plan[e.name]) patchMonster(e, plan[e.name]);
  return enemies;
}

async function main() {
  const planFile = arg("--plan", null);
  const runs = Number(arg("--runs", 1000));
  const out = arg("--out", null);
  const md = arg("--md", null);
  const designOnly = process.argv.includes("--design-only");
  if (!planFile) { console.error("usage: node bin/balance-proposal.js --plan <file> [--runs N]"); process.exit(1); }
  const plan = JSON.parse(fs.readFileSync(path.resolve(planFile), "utf8"));
  const rowsOverride = plan.rows ?? {};
  delete plan.rows;
  const matrix = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "expectations", "encounter-matrix.json"), "utf8"));
  const policy = matrix.policy ?? "standard";
  const monsterRules = matrix.monsterRules ?? "registry";

  const copyDir = path.join(os.tmpdir(), "fu-balance-proposal");
  const world = snapshotWorld(DEFAULT_WORLD, copyDir);
  const rows = [];
  let design = [];
  try {
    design = await designCheck(plan, world);
    if (designOnly) {
      const text = renderDesign(design).join("\n") || "Design check: nothing to report.";
      console.log(text);
      if (md) fs.writeFileSync(path.resolve(md), text + "\n");
      return;
    }
    const party = await loadParty({ world });
    const statusLibrary = monsterRules === "data" ? await loadStatusLibrary({ world }) : null;
    for (const unknown of Object.keys(plan)) {
      if (unknown === "rows") continue;
      if (!matrix.lines.some((l) => l.enemies.includes(unknown))) console.warn(`plan names "${unknown}", which is in no fight`);
    }
    for (const l of matrix.lines) {
      if (l.error) continue;
      const tag = `${l.dungeon.startsWith("Fafnir") ? "F" : "V"}${l.range ? l.range[0] : "story"}`;
      const lineup = rowsOverride[tag] ?? l.enemies;
      const touched = lineup !== l.enemies || l.enemies.some((n) => plan[n]);
      const run = async (patched) => {
        const enemies = await loadGroup(patched ? lineup : l.enemies, world, patched ? plan : null);
        const summons = monsterRules === "data" ? await loadSummons(enemies, { world }) : null;
        const { all } = runLine({ party, enemies, events: l.events, runs, seed: `proposal:${l.source}:${l.enemies.join("+")}`,
          expectedRounds: l.kind === "boss" ? 10 : 7, policy, monsterRules, statusLibrary, summons });
        return summarise(all);
      };
      const before = await run(false);
      const after = touched ? await run(true) : before;
      rows.push({ dungeon: l.dungeon, num: l.range ? l.range[0] : "story", enemies: l.enemies, lineup: lineup !== l.enemies ? lineup : null, kind: l.kind, touched,
        before: { ...before, verdict: verdict(before, l.kind) }, after: { ...after, verdict: verdict(after, l.kind) } });
    }
  } finally {
    fs.rmSync(copyDir, { recursive: true, force: true });
  }

  const lines = [];
  const tally = (key) => {
    const t = {};
    for (const r of rows) if (r.num !== "story") t[r[key].verdict] = (t[r[key].verdict] ?? 0) + 1;
    return ["pushover", "too soft", "on target", "drags", "stalemate", "wall"].map((v) => `${v} ${t[v] ?? 0}`).join(" · ");
  };
  lines.push(`Plan ${path.basename(planFile)} · party policy ${policy} · ${runs} runs per fight, paired seeds`);
  lines.push("");
  lines.push(...renderDesign(design));
  lines.push(`Before: ${tally("before")}`);
  lines.push(`After:  ${tally("after")}`);
  lines.push("");
  lines.push("| Fight | Enemies | Before | After | Rounds | Lowest party HP | Win | Any KO |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    const tag = `${r.dungeon.startsWith("Fafnir") ? "F" : "V"}${r.num}`;
    const b = r.before, a = r.after;
    const ch = (x, y, f) => (r.touched ? `${f(x)} → ${f(y)}` : f(x));
    lines.push(`| ${tag} | ${r.enemies.join(", ")}${r.lineup ? ` → **${r.lineup.join(", ")}**` : ""} | ${b.verdict} | ${r.touched ? `**${a.verdict}**` : "(unchanged)"} | ${ch(b.roundsP50, a.roundsP50, (x) => x ?? "7+")} | ${ch(b.lowP50, a.lowP50, pct)} | ${ch(b.win, a.win, pct)} | ${ch(b.anyDown, a.anyDown, pct)} |`);
  }
  const text = lines.join("\n");
  console.log(text);
  if (md) fs.writeFileSync(path.resolve(md), text + "\n");
  if (out) fs.writeFileSync(path.resolve(out), JSON.stringify({ plan, policy, runs, design, rows }, null, 2) + "\n");
}

module.exports = { patchMonster, loadGroup, designWarnings, touchedActions };
if (require.main === module) main().catch((e) => { console.error(`balance-proposal failed: ${e.stack || e.message}`); process.exit(1); });
