#!/usr/bin/env node
"use strict";
//
// Mindscape — Monster Design Dossier brief.  READ-ONLY on the real world (reads a copy).
//
// The thing to run BEFORE proposing any change to a monster: its design intent, the
// rules it breaks on purpose, live numbers, design drift, and the last decisions.
//
//   node bin/dossier.js gigas              # the brief
//   node bin/dossier.js --list             # every dossier: status + drift; matrix monsters without one
//   node bin/dossier.js --check            # exit 2 when any dossier's invariants fail (drift)
//   node bin/dossier.js --new "Rakshasa"   # scaffold dossiers/rakshasa.md (draft) from the sheet
//
// Format and workflow: dossiers/README.md. Library: lib/dossier.js.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { DEFAULT_WORLD } = require("../../safe-edit/lib/paths");
const { loadAll, loadParty } = require("../lib/load-actors");
const { loadWorldItems } = require("../lib/world-items");
const DS = require("../lib/dossier");
const { snapshotWorld } = require("./encounter-matrix");
const { auditMonster } = require("./monster-audit");

const MATRIX = path.join(__dirname, "..", "expectations", "encounter-matrix.json");
const s = (v) => String(v ?? "").trim();
const norm = (v) => s(v).toLowerCase().replace(/^⭐️?\s*/u, "");
const pct = (x) => (x == null ? "—" : `${Math.round(100 * x)}%`);
const slug = (name) => norm(name).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function parseArgs(argv) {
  const out = { world: DEFAULT_WORLD, name: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--list") out.list = true;
    else if (a === "--check") out.check = true;
    else if (a === "--new") out.scaffold = argv[++i];
    else if (a === "--world") out.world = argv[++i];
    else if (a.startsWith("--")) throw new Error(`unknown argument ${a}`);
    else out.name = out.name ? `${out.name} ${a}` : a;   // unquoted "Iron Colossus"
  }
  if (!out.list && !out.check && !out.scaffold && !out.name) throw new Error("usage: dossier.js <monster> | --list | --check | --new <monster>");
  return out;
}

// Encounter rows the monster appears in, with the matrix's per-event results.
function appearances(name) {
  if (!fs.existsSync(MATRIX)) return [];
  const m = JSON.parse(fs.readFileSync(MATRIX, "utf8"));
  return m.lines.filter((l) => l.enemies.some((e) => norm(e) === norm(name))).map((l) => {
    const ev = Object.entries(l.byEvent ?? {}).map(([id, e]) => `${id} ${pct(e.share)}: win ${pct(e.stats.win)}, low HP ${pct(e.stats.lowP50)}`);
    const st = l.stats ? [`win ${pct(l.stats.win)}, low HP ${pct(l.stats.lowP50)}`] : [];
    return `${l.dungeon} · ${l.source}${l.range ? ` [${l.range.join("-")}]` : ""}: ${l.enemies.join(" + ")} — ${(ev.length ? ev : st).join(" · ") || "no result"}`;
  });
}

function brief(d, card) {
  const o = [];
  const dd = d.data;
  o.push(`# ${dd.monster} — design brief (${dd.status}${dd.updated ? `, updated ${dd.updated}` : ""})`);
  o.push(`file: ${path.relative(process.cwd(), d.file)}`);
  if (dd.status !== "confirmed") o.push("⚠ DRAFT — entries not marked `decided_by: user` are unconfirmed proposals.");
  o.push("");
  if (dd.role) o.push(`ROLE  ${dd.role}`);
  const apps = appearances(dd.monster);
  for (const a of apps) o.push(`  in  ${a}`);
  if (!apps.length) o.push("  in  (not in any Encounter Matrix row — story, summon or unplaced; check the role above)");
  for (const k of ["Concept", "The gimmick"]) if (d.sections[k]) { o.push(""); o.push(`## ${k}`); o.push(d.sections[k]); }

  o.push("");
  o.push("## Live sheet");
  if (!card) o.push(`actor not found (${dd.actorId ?? dd.monster}) — dossier points at nothing`);
  else {
    o.push(`${card.rank} L${card.level} · HP ${card.hp} · ${card.turns} turn(s) · DEF ${card.def} (${card.hitDef}) · MDEF ${card.mdef} (${card.hitMdef})`);
    o.push(`VU ${card.vu.join(", ") || "—"} · RS ${card.rs.join(", ") || "—"} · IM ${card.im.join(", ") || "—"} · AB ${card.ab.join(", ") || "—"}`);
    o.push(`attacks: ${card.attacks.map((a) => `${a.name} ${a.avg}${a.targets > 1 ? " ×" + a.targets : ""}`).join(" · ") || "none readable"}`);
    o.push("");
    o.push(`## Invariants (${card.drift.length ? `${card.drift.length} DRIFT` : "all hold"})`);
    for (const i of card.design.invariants) o.push(`${i.ok ? "  ok   " : "  DRIFT"} ${i.text}${!i.ok && i.why ? `\n         why it matters: ${i.why}` : ""}`);
    o.push("");
    o.push("## Audit findings");
    if (!card.findings.length) o.push("  none");
    for (const f of card.findings) {
      o.push(f.status === "intended"
        ? `  intended${f.confirmed ? "" : " (unconfirmed)"}: ${f.text}\n           → ${f.why ?? "no reason recorded"}${f.decided ? ` (${f.decided})` : ""}`
        : `  NEW: ${f.text}`);
    }
  }
  if (dd.blind_spots.length) { o.push(""); o.push("## Blind spots — the sim/engine cannot see"); for (const b of dd.blind_spots) o.push(`  - ${b}`); }
  if (dd.open_questions.length) { o.push(""); o.push("## Open questions"); for (const q of dd.open_questions) o.push(`  - ${q}`); }
  const log = DS.decisionLog(d);
  if (log.length) {
    o.push("");
    o.push(`## Last decisions (${Math.min(5, log.length)} of ${log.length})`);
    for (const r of log.slice(-5)) o.push(`  ${r.join(" | ")}`);
  }
  return o.join("\n");
}

function scaffold(card, model) {
  const top = card.attacks.map((a) => `${a.name} (~${a.avg}${a.targets > 1 ? ` ×${a.targets}` : ""})`).join(", ") || "none readable";
  const data = {
    monster: model.name, actorId: model.id, status: "draft", updated: new Date().toISOString().slice(0, 10),
    role: "TODO: random encounter / story elite / boss add — and where it appears",
    exceptions: [],
    // Today's findings, for a person to promote into `exceptions` (with a real reason)
    // or delete. Ignored by the tools — a scaffold must never mark anything intended.
    candidate_exceptions: card.findings.map((f) => ({ rule: f.rule, ...(f.action ? { action: f.action } : {}), finding: f.text })),
    invariants: [],
    blind_spots: [],
    open_questions: ["TODO: confirm role, gimmick and every exception with the designer"],
  };
  return `# ${model.name}

> **Status: draft** — scaffolded from the sheet ${data.updated}. Fill the prose, move
> the deliberate ones from \`candidate_exceptions\` into \`exceptions\` (with a reason), add the
> invariants the gimmick depends on.

## Identity & role

- Actor \`${model.id}\`. ${card.rank} L${card.level}, ${model.species ?? "?"}, ${card.turns} turn(s), HP ${card.hp}.
- TODO: role and appearances.

## Concept

TODO

## The gimmick

TODO — mechanism, counterplay, what is SUPPOSED to happen. Attacks today: ${top}.

## Numbers & targets

TODO

## Decision log

| Date | Change | Why | Decided by | Result |
|---|---|---|---|---|
| ${data.updated} | Dossier scaffolded | — | claude | — |

\`\`\`json dossier
${JSON.stringify(data, null, 2)}
\`\`\`
`;
}

async function main() {
  const args = parseArgs(process.argv);
  const dossiers = DS.loadDossiers();
  const copyDir = path.join(os.tmpdir(), "fu-dossier");
  const world = snapshotWorld(args.world, copyDir);
  try {
    const all = (await loadAll({ world })).filter((a) => a.isNpc);
    const party = await loadParty({ world });
    const worldItems = await loadWorldItems({ world });
    const meanPcHp = Math.round(party.reduce((a, p) => a + (p.hp.max ?? 0), 0) / party.length);
    const modelOf = (d) => all.find((a) => a.id === d.data.actorId) ?? all.find((a) => norm(a.name) === norm(d.data.monster)) ?? null;
    const cardOf = (m, d) => auditMonster(m, { meanPcHp, monsterRules: "data", dossier: d, worldItems });

    if (args.scaffold) {
      const m = all.find((a) => norm(a.name) === norm(args.scaffold));
      if (!m) throw new Error(`no monster actor named "${args.scaffold}"`);
      if (DS.findDossier(dossiers, m)) throw new Error(`${m.name} already has a dossier`);
      const file = path.join(DS.DOSSIER_DIR, `${slug(m.name)}.md`);
      fs.writeFileSync(file, scaffold(cardOf(m, null), m));
      console.log(`wrote ${path.relative(process.cwd(), file)}`);
      return;
    }

    if (args.list || args.check) {
      let drift = 0;
      for (const d of dossiers) {
        const m = modelOf(d);
        const card = m ? cardOf(m, d) : null;
        const n = card ? card.drift.length : 1;
        drift += n;
        const fresh = card ? card.findings.filter((f) => f.status === "new").length : 0;
        console.log(`${d.data.monster.padEnd(18)} ${d.data.status.padEnd(9)} ${!card ? "ACTOR MISSING" : n ? `DRIFT ${n}` : "invariants ok"}${fresh ? ` · ${fresh} new finding(s)` : ""}`);
        if (args.check && card) for (const i of card.drift) console.log(`    DRIFT ${i.text}`);
      }
      if (fs.existsSync(MATRIX)) {
        const names = [...new Set(JSON.parse(fs.readFileSync(MATRIX, "utf8")).lines.flatMap((l) => l.enemies))];
        const without = names.filter((n) => !dossiers.some((d) => norm(d.data.monster) === norm(n)));
        if (without.length) console.log(`\nno design record (${without.length}): ${without.join(", ")}`);
      }
      if (args.check && drift) process.exitCode = 2;
      return;
    }

    const d = dossiers.find((x) => norm(x.data.monster) === norm(args.name) || slug(x.data.monster) === slug(args.name));
    if (!d) {
      console.log(`No dossier for "${args.name}". Its design intent is not recorded — ask before tuning it.`);
      console.log(`Scaffold one: node bin/dossier.js --new "${args.name}"`);
      process.exitCode = 1;
      return;
    }
    const m = modelOf(d);
    console.log(brief(d, m ? cardOf(m, d) : null));
  } finally {
    fs.rmSync(copyDir, { recursive: true, force: true });
  }
}

if (require.main === module) main().catch((e) => { console.error(`\ndossier failed: ${e.stack || e.message}\n`); process.exit(1); });
