#!/usr/bin/env node
"use strict";
//
// Mindscape — Playtest Log seed. Turns the Encounter Matrix + Monster Audit reports into
// the documents the Playtest Log artifact reads, one JSON file per document:
//
//   <out>/fights/<id>.json     sim numbers for one fight      (field `sim`, never `review`)
//   <out>/monsters/<id>.json   one Monster Audit card
//   <out>/meta/run.json        run date, party, model coverage, caveat
//   <out>/writes.json          ArtifactData batch entries ({op:"update"|"set", collection, doc_id, file_path})
//
//   node bin/playtest-log-seed.js --out <dir>
//
// Fights are written with "update" once they exist, so a re-seed refreshes `sim` and
// keeps the user's `review` (their verdicts) untouched. The first seed uses "set".

const fs = require("fs");
const path = require("path");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
}
const slug = (x) => String(x).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const matrixFile = arg("--matrix", path.join(__dirname, "..", "expectations", "encounter-matrix.json"));
const auditFile = arg("--audit", path.join(__dirname, "..", "expectations", "monster-audit.json"));
const out = arg("--out", null);
const op = arg("--op", "set");          // "update" for a re-seed that must keep reviews
if (!out) { console.error("usage: node bin/playtest-log-seed.js --out <dir> [--op set|update]"); process.exit(1); }

const matrix = JSON.parse(fs.readFileSync(matrixFile, "utf8"));
const audit = JSON.parse(fs.readFileSync(auditFile, "utf8"));
const writes = [];
const put = (collection, id, body) => {
  const file = path.join(out, collection, `${id}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(body, null, 2) + "\n");
  writes.push({ op: collection === "fights" ? op : "set", collection, doc_id: id, file_path: path.resolve(file) });
};

const round = (x, d = 3) => (x == null ? null : Number(x.toFixed(d)));
matrix.lines.forEach((l, i) => {
  const area = slug(l.dungeon).split("-").slice(0, 2).join("-");
  const id = l.range ? `${area}-${String(l.range[0]).padStart(2, "0")}` : `${area}-story-${slug(l.enemies.join("-"))}`;
  const st = l.stats ?? {};
  put("fights", id, {
    order: i,
    dungeon: l.dungeon,
    source: l.source,
    range: l.range ? `${l.range[0]}-${l.range[1]}` : "story",
    rolls: l.story ? null : l.rolls ? round(l.weight) : 0,
    enemies: l.enemies,
    sim: {
      kind: l.kind ?? null, level: l.level ?? null, enemyHp: l.enemyHp ?? null, error: l.error ?? null,
      win: round(st.win), defeat: round(st.defeat), overtime: round(st.overtime),
      roundsP50: round(st.roundsP50, 1), roundsP90: round(st.roundsP90, 1),
      hpP50: round(st.hpP50), hpP10: round(st.hpP10), anyDown: round(st.anyDown),
      notes: l.notes ?? [], gaps: l.enemyGaps ?? [],
      runs: matrix.runs, generated: matrix.generated, policy: matrix.policy ?? "legacy",
    },
  });
});
for (const c of audit.cards) {
  put("monsters", slug(c.name.replace(/^⭐️?\s*/u, "")), {
    name: c.name, rank: c.rank, level: c.level, hp: c.hp, turns: c.turns,
    def: c.def, mdef: c.mdef, hitDef: c.hitDef, hitMdef: c.hitMdef,
    vu: c.vu, rs: c.rs, im: c.im, ab: c.ab,
    basic: c.basic ? { name: c.basic.name, avg: c.basic.avg } : null,
    strongest: c.attacks[0] ? { name: c.attacks[0].name, avg: c.attacks[0].avg } : null,
    flags: c.flags,
  });
}
put("meta", "run", {
  generated: matrix.generated, runs: matrix.runs, seed: matrix.seed, party: matrix.party,
  partyCoverage: matrix.partyCoverage, caveat: matrix.caveat, policy: matrix.policy ?? "legacy",
  notModelled: (matrix.policy ?? "legacy") === "legacy" ? [] : require("../lib/party-policy").NOT_PORTED, targets: matrix.targets, dungeons: matrix.dungeons,
});
fs.writeFileSync(path.join(out, "writes.json"), JSON.stringify(writes, null, 1) + "\n");
console.log(`${writes.length} documents → ${out} (writes.json holds the ArtifactData batch entries)`);
