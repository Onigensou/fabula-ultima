// Token status plan "G + E" — world data step (user-approved 2026-10-27).
//
// 1. Tag every "Ready" ability effect with `ready` in system.tags, so the
//    battle UI shows it as a gold Ready chip (status-classifier.js reads the
//    tag; a name ending in "Ready" is the fallback). Covers Protect and
//    Counter Pass, whose names do not end in "Ready".
// 2. Retire Burn's Token Magic FX filter. Its effect macro added the "Burns"
//    filter to whichever token was SELECTED (not the burning one); the battle
//    UI now draws its own Burn cue. Only the TokenMagic lines are removed —
//    the condition / recovery sounds in the same scripts stay.
//
// Every copy is edited: world items, actor-embedded items and actor effects,
// in both the actors and items stores (embedded docs live at their own keys:
// !actors.effects!, !actors.items.effects!, !items.effects!).
//
// Run from tools/safe-edit with the game CLOSED; --apply to write.
const { openCollection } = require("../lib/db");
const { snapshotCollection } = require("../lib/backup");
const journal = require("../lib/journal");

const APPLY = process.argv.includes("--apply");
const READY_NAMES = /^(Protect|Counter Pass)$|\bReady$/;
const EFFECT_PREFIXES = ["!actors.effects!", "!actors.items.effects!", "!items.effects!"];

function readyFix(ae) {
  if (!READY_NAMES.test(String(ae.name ?? "").trim())) return null;
  const tags = Array.isArray(ae.system?.tags) ? ae.system.tags.slice() : [];
  if (tags.map((t) => String(t).toLowerCase()).includes("ready")) return null;
  const out = JSON.parse(JSON.stringify(ae));
  out.system = out.system ?? {};
  out.system.tags = [...tags, "ready"];
  return { doc: out, note: `${ae.name}: tags ${JSON.stringify(tags)} -> ${JSON.stringify(out.system.tags)}` };
}

function burnFix(ae) {
  if (String(ae.name ?? "").trim() !== "Burn") return null;
  const em = ae.flags?.effectmacro;
  if (!em || typeof em !== "object") return null;
  const out = JSON.parse(JSON.stringify(ae));
  const changed = [];
  for (const [ev, v] of Object.entries(out.flags.effectmacro)) {
    if (!v || typeof v.script !== "string" || !v.script.includes("TokenMagic")) continue;
    v.script = v.script.split("\n").filter((line) => !line.includes("TokenMagic")).join("\n").replace(/^\s*\n/, "");
    changed.push(ev);
  }
  if (!changed.length) return null;
  return { doc: out, note: `Burn: removed TokenMagic from ${changed.join(", ")} (sounds kept)` };
}

(async () => {
  const plan = { actors: [], items: [] };
  for (const coll of ["actors", "items"]) {
    const db = await openCollection(coll);
    try {
      for await (const [k, v] of db.iterator()) {
        if (!EFFECT_PREFIXES.some((p) => k.startsWith(p))) continue;
        const fix = readyFix(v) ?? burnFix(v);
        if (fix) plan[coll].push([k, fix.doc, fix.note]);
      }
    } finally { await db.close(); }
  }
  const total = plan.actors.length + plan.items.length;
  console.log(`\n${APPLY ? "APPLY" : "DRY-RUN"} — ${total} writes`);
  for (const coll of ["actors", "items"]) for (const [k, , note] of plan[coll]) console.log(`  [${coll}] ${k}\n      ${note}`);
  if (!APPLY) { console.log("\n(dry run — pass --apply to write)"); return; }
  for (const coll of ["actors", "items"]) {
    if (!plan[coll].length) continue;
    const backupPath = snapshotCollection(coll);
    const db = await openCollection(coll);
    try { for (const [k, v] of plan[coll]) await db.put(k, v); }
    finally { await db.close(); }
    journal.append({
      uuid: `collection:${coll}`, collection: coll, key: plan[coll].map((c) => c[0]).join(","),
      beforeHash: null, afterHash: null, backupPath,
      patch: null, note: `token-status-ready-tags: ${plan[coll].length} docs — ${plan[coll].map((c) => c[2]).join("; ")}`,
    });
    console.log(`wrote ${plan[coll].length} docs to ${coll} (backup ${backupPath})`);
  }
})().catch((e) => { console.error("FAILED", e); process.exit(1); });
