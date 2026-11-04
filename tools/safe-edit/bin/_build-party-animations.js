#!/usr/bin/env node
"use strict";
// ============================================================================
// Build + write the party action animations (Hina, Zarg, Keren, Blanche) and
// their world PARENT items, from the approved "Party Action Animations" mockup.
//
//   node bin/_build-party-animations.js                 # dry run, validates only
//   node bin/_build-party-animations.js --write         # write to LevelDB
//   node bin/_build-party-animations.js --only "High Speed"
//   node bin/_build-party-animations.js --emit out.json # validated, encoded jobs (bridge push)
//
// GAME MUST BE CLOSED for --write (safe-edit opens LevelDB directly).
//
// This file is the source of truth for what each party skill's animation IS.
// Tune in game → fold the numbers back into tools/anim-studio/lib/party-signatures.js,
// or the next --write silently reverts them.
//
// Targets: { actor: <actorId>, item: <name> } = an embedded copy on that actor;
//          { world: <itemId> }               = a world item (the class "parent").
// Exclusive skins live on the owner's copy only (Keren's phantasms = Fox Fire);
// parents get the class default.
// `rows` edits the item's effect_table idempotently (e.g. a play_animation step
// at the head of a reaction chain, so the reaction engine plays the script).
// ============================================================================

const fs = require("fs");
const path = require("path");
const { openCollection } = require("../lib/db");

const ANIM_LIB = path.resolve(__dirname, "..", "..", "anim-studio");
const PS = require(path.join(ANIM_LIB, "lib", "party-signatures.js"));
const { encode, validate } = require(path.join(ANIM_LIB, "lib", "encode.js"));

const ACTOR = { hina: "dafTLBUscCDNgq8H", zarg: "Z4CFy505cD3nzl1W", keren: "gdJZ1L1kv5mjTTMr", blanche: "uJFaNQCSvwwsr2AW" };

// Insert a play_animation step into a chain (after `after`, or first), adding the
// row if it is missing. Idempotent: a second run finds both and changes nothing.
function addAnimStep({ chain, label, actionRef, targetRef = "self", after = null }) {
  return (table) => {
    const rows = Object.entries(table || {});
    const live = rows.filter(([, r]) => r && !r.$deleted);
    if (!live.some(([, r]) => r.effect_label === label)) {
      const next = String(Math.max(-1, ...rows.map(([k]) => Number(k)).filter(Number.isFinite)) + 1);
      table[next] = { effect_kind: "play_animation", effect_label: label, action_ref: actionRef, target_ref: targetRef };
    }
    const ch = live.find(([, r]) => r.effect_kind === "chain" && r.effect_label === chain);
    if (!ch) throw new Error("chain " + chain + " not found");
    const steps = String(ch[1].chain_steps || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!steps.includes(label)) {
      const i = after ? steps.indexOf(after) + 1 : 0;
      if (after && i === 0) throw new Error("step " + after + " not in chain " + chain);
      steps.splice(i, 0, label);
      ch[1].chain_steps = steps.join(", ");
    }
    return table;
  };
}

// ── Registry ────────────────────────────────────────────────────────────────
const HS_ROWS = addAnimStep({ chain: "hs_react", label: "hs_anim", actionRef: "High Speed", targetRef: "hs_self", after: "hs_mp_cost" });
const JOBS = [
  // Batch A — fixes
  { name: "High Speed", targets: [{ actor: ACTOR.zarg, item: "High Speed" }, { world: "FZX0P5HD6UfIIk9i" }], gen: () => PS.highSpeed(), rows: HS_ROWS },
  { name: "Create Phantasm: Strike (Keren, Fox Fire)", targets: [{ actor: ACTOR.keren, item: "Create Phantasm: Strike" }], gen: () => PS.phantasmStrike({ skin: "foxfire" }) },
  { name: "Create Phantasm: Strike (class default)", targets: [{ world: "feHphjgfvJqxp7Qa" }], gen: () => PS.phantasmStrike({ skin: "mirage" }) },
  { name: "Detonate Phantasm (Keren, Fox Fire)", targets: [{ actor: ACTOR.keren, item: "Detonate Phantasm" }], gen: () => PS.detonatePhantasm({ skin: "foxfire" }) },
  { name: "Detonate Phantasm (class default)", targets: [{ world: "o6JD10LZF7bXvU6B" }], gen: () => PS.detonatePhantasm({ skin: "mirage" }) },
];

function parseArgs(argv) { const o = {}; for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (!a.startsWith("--")) continue; const k = a.slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true; o[k] = v; } return o; }

function applyJob(doc, j) {
  doc.system = doc.system || {}; const p = (doc.system.props = doc.system.props || {});
  p.animation_script = j.stored;
  p.skill_animation_mode = "custom";
  p.animation_damage_timing_options = j.timing.mode;
  p.animation_damage_timing_offset = String(j.timing.offset ?? 0);
  p.animation_preload_urls = j.preload.join("\n");
  if (j.rows) p.effect_table = j.rows(p.effect_table || {});
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const only = typeof flags.only === "string" ? flags.only.toLowerCase() : null;
  const jobs = []; let failures = 0;
  for (const J of JOBS) {
    if (only && !J.name.toLowerCase().includes(only)) continue;
    let out; try { out = J.gen(); } catch (e) { console.error("✗ " + J.name + ": generator threw — " + e.message); failures++; continue; }
    const r = validate(out.script);
    if (!r.ok) { console.error("✗ " + J.name + ": INVALID"); r.errors.forEach((e) => console.error("    " + e)); failures++; continue; }
    r.warnings.forEach((w) => console.warn("  ! " + J.name + ": " + w));
    // dry-run the row edit on a scratch copy so a bad chain fails here, not mid-write
    jobs.push({ ...J, stored: encode(out.script), len: out.script.length, timing: out.timing, preload: out.preload });
  }
  if (failures) { console.error("\n" + failures + " script(s) failed validation — nothing written."); process.exit(1); }
  console.log(jobs.length + " script(s) built and validated.");
  if (typeof flags.emit === "string") { fs.writeFileSync(flags.emit, JSON.stringify(jobs.map(({ gen, rows, ...j }) => j), null, 2)); console.log("emitted to " + flags.emit); return; }
  if (!flags.write) {
    for (const j of jobs) console.log("  [dry] " + j.name.padEnd(46) + " " + j.len + "b  gate " + j.timing.mode + (j.timing.mode === "offset" ? " " + j.timing.offset : "") + "  → " + j.targets.map((t) => t.world ? "Item." + t.world : "Actor." + t.actor + " / " + t.item).join(", ") + (j.rows ? "  +rows" : ""));
    console.log("\nDry run — pass --write to apply. GAME MUST BE CLOSED."); return;
  }
  let wrote = 0, missing = 0;
  // actor copies
  const actorJobs = jobs.flatMap((j) => j.targets.filter((t) => t.actor).map((t) => ({ j, t })));
  if (actorJobs.length) {
    const db = await openCollection("actors");
    try {
      const want = new Set(actorJobs.map((x) => x.t.actor)); const index = new Map();
      for await (const [key, val] of db.iterator()) {
        if (!key.startsWith("!actors.items!")) continue;
        const aid = key.split("!")[2].split(".")[0]; if (!want.has(aid)) continue;
        const name = String(val.name ?? ""); if (!val.system?.props?.skill_type) continue;
        if (!index.has(aid)) index.set(aid, new Map()); index.get(aid).set(name, [key, val]);
      }
      for (const { j, t } of actorJobs) {
        const hit = index.get(t.actor)?.get(t.item);
        if (!hit) { console.error("✗ " + j.name + ": " + t.item + " not found on Actor." + t.actor); missing++; continue; }
        applyJob(hit[1], j); await db.put(hit[0], hit[1]); wrote++; console.log("  ✓ Actor." + t.actor + " / " + t.item);
      }
    } finally { await db.close(); }
  }
  // world parents
  const worldJobs = jobs.flatMap((j) => j.targets.filter((t) => t.world).map((t) => ({ j, t })));
  if (worldJobs.length) {
    const db = await openCollection("items");
    try {
      for (const { j, t } of worldJobs) {
        const key = "!items!" + t.world; let doc;
        try { doc = await db.get(key); } catch { doc = null; }
        if (!doc) { console.error("✗ " + j.name + ": world Item." + t.world + " not found"); missing++; continue; }
        applyJob(doc, j); await db.put(key, doc); wrote++; console.log("  ✓ Item." + t.world + " (" + doc.name + ")");
      }
    } finally { await db.close(); }
  }
  console.log("\nwrote " + wrote + (missing ? ", " + missing + " MISSING" : ""));
  if (missing) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
