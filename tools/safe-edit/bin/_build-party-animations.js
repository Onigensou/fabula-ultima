#!/usr/bin/env node
"use strict";
// ============================================================================
// Build + write the party action animations (Hina, Zarg, Keren, Blanche) and
// their world PARENT items, from the approved "Party Action Animations" mockup.
//
//   node bin/_build-party-animations.js                 # dry run, validates only
//   node bin/_build-party-animations.js --write         # write to LevelDB
//   node bin/_build-party-animations.js --only "High Speed"
//   node bin/_build-party-animations.js --emit out.json # validated, encoded jobs (bridge/sandbox push)
//
// GAME MUST BE CLOSED for --write (safe-edit opens LevelDB directly).
//
// Source of truth for what each party skill's animation IS. Tune in game → fold
// the numbers back into tools/anim-studio/lib/party-signatures.js / party-sig-*.js,
// or the next --write silently reverts them.
//
// Job kinds
//   gen   — a generator from party-signatures.js / party-sig-<who>.js (oni.timeline shots)
//   port  — a legacy script ported off Sequencer (party-ports/<slug>.port.js); keeps the
//           item's own timing fields
//   copy  — copy another world item's script + timing + preload verbatim
// Targets: { actor, item } = embedded copy (EVERY copy with that name on the actor);
//          { world }       = a world item (class parent). A gen job never overwrites a
//          world item that already carries a different, non-party script (logged + skipped).
// Rows: play_animation steps for REACTION chains (the reaction engine never enters BD's
//       ANIMATION state, so a reaction only animates through a play_animation step).
//   { chain, label, actionRef, targetRef, after? }         insert into an existing chain
//   { wrapRef, label, actionRef, targetRef?, chainLabel }  the reaction points at a single
//       row: wrap it in a new chain [label, wrapRef] and repoint the reaction at it
//   { ae: "<effect name>", ...one of the above }            rows on an item's transfer AE
//       (flags.fabula-ultima-companion.reactionConfig), e.g. Stubborn Scion
// ============================================================================

const fs = require("fs");
const path = require("path");
const { openCollection } = require("../lib/db");

const ANIM_LIB = path.resolve(__dirname, "..", "..", "anim-studio");
const LIB = path.join(ANIM_LIB, "lib");
const PS = require(path.join(LIB, "party-signatures.js"));
const { encode, validate } = require(path.join(LIB, "encode.js"));
const NS = "fabula-ultima-companion";

const ACTOR = { hina: "dafTLBUscCDNgq8H", zarg: "Z4CFy505cD3nzl1W", keren: "gdJZ1L1kv5mjTTMr", blanche: "uJFaNQCSvwwsr2AW" };
const A = (who, item) => ({ actor: ACTOR[who], item });
const W = (id) => ({ world: id });

// ── row editors ─────────────────────────────────────────────────────────────
function editRows(spec) {
  return (table, reactions) => {
    const rows = Object.entries(table || {});
    const live = rows.filter(([, r]) => r && !r.$deleted);
    const nextKey = () => { const ks = Object.keys(table).map(Number).filter(Number.isFinite); return String(ks.length ? Math.max(...ks) + 1 : 0); };
    const hasLabel = (l) => Object.values(table).some((r) => r && !r.$deleted && r.effect_label === l);
    let targetRef = spec.targetRef;
    if (spec.wrapRef) {
      const inner = live.find(([, r]) => r.effect_label === spec.wrapRef);
      if (!inner && !hasLabel(spec.chainLabel)) throw new Error("wrapRef " + spec.wrapRef + " not found");
      if (!targetRef) targetRef = (inner && inner[1].target_ref) || "self";
    }
    if (!hasLabel(spec.label)) table[nextKey()] = { effect_kind: "play_animation", effect_label: spec.label, action_ref: spec.actionRef, target_ref: targetRef || "self" };
    if (spec.wrapRef) {
      if (!hasLabel(spec.chainLabel)) table[nextKey()] = { effect_kind: "chain", effect_label: spec.chainLabel, chain_steps: spec.label + ", " + spec.wrapRef };
      let hit = 0;
      for (const r of Object.values(reactions || {})) if (r && !r.$deleted && (r.reaction_effect_ref === spec.wrapRef || r.reaction_effect_ref === spec.chainLabel)) { r.reaction_effect_ref = spec.chainLabel; hit++; }
      if (!hit) throw new Error("no reaction points at " + spec.wrapRef);
      return;
    }
    const ch = Object.values(table).find((r) => r && !r.$deleted && r.effect_kind === "chain" && r.effect_label === spec.chain);
    if (!ch) throw new Error("chain " + spec.chain + " not found");
    const steps = String(ch.chain_steps || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!steps.includes(spec.label)) {
      const i = spec.after ? steps.indexOf(spec.after) + 1 : 0;
      if (spec.after && i === 0) throw new Error("step " + spec.after + " not in chain " + spec.chain);
      steps.splice(i, 0, spec.label); ch.chain_steps = steps.join(", ");
    }
  };
}

// ── registry ────────────────────────────────────────────────────────────────
const PORT_DIR = path.join(LIB, "party-ports");
const port = (slug) => () => ({ script: fs.readFileSync(path.join(PORT_DIR, slug + ".port.js"), "utf8") });

const JOBS = [
  // Batch A — fixes
  { name: "High Speed", targets: [A("zarg", "High Speed"), W("FZX0P5HD6UfIIk9i")], gen: () => PS.highSpeed(), rows: { chain: "hs_react", label: "hs_anim", actionRef: "High Speed", targetRef: "hs_self", after: "hs_mp_cost" } },
  { name: "Create Phantasm: Strike (Keren, Fox Fire)", targets: [A("keren", "Create Phantasm: Strike")], gen: () => PS.phantasmStrike({ skin: "foxfire" }) },
  { name: "Create Phantasm: Strike (class default)", targets: [W("feHphjgfvJqxp7Qa")], gen: () => PS.phantasmStrike({ skin: "mirage" }) },
  { name: "Detonate Phantasm (Keren, Fox Fire)", targets: [A("keren", "Detonate Phantasm")], gen: () => PS.detonatePhantasm({ skin: "foxfire" }) },
  { name: "Detonate Phantasm (class default)", targets: [W("o6JD10LZF7bXvU6B")], gen: () => PS.detonatePhantasm({ skin: "mirage" }) },
  // Batch B — copy of an existing world animation
  { name: "Glacies Finis (copy of the world item's script)", kind: "copy", from: "g74cJxJ4guXSyVlJ", targets: [A("hina", "Glacies Finis")] },
  // Batch C — Sequencer ports (look unchanged; reaction ones get their missing play step)
  // (The four party Zero Power ports moved to bin/_build-zero-powers.js, the 2026-11-06 overhaul;
  //  writing them here again would revert that build.)
  { name: "Protect (port)", kind: "port", gen: port("protect"), targets: [A("hina", "Protect"), A("blanche", "Protect"), W("YBTRLqaFzBFu5xyt"), W("MZXmnywINICmx7Ua")], rows: { chain: "protect_react", label: "protect_anim", actionRef: "Protect", targetRef: "trigger_subject" } },
  { name: "Divination (port)", kind: "port", gen: port("divination"), targets: [A("hina", "Divination"), W("eTagzbuJWVfudChW")] },
  { name: "Acceleration (port)", kind: "port", gen: port("acceleration"), targets: [A("hina", "Acceleration"), W("jlPwgwAQkOBCNg6K")] },
  { name: "Stop (port)", kind: "port", gen: port("stop"), targets: [A("hina", "Stop"), W("Xf6q7cCeuczSTfXp")] },
  { name: "Barrage (port)", kind: "port", gen: port("barrage"), targets: [A("zarg", "Barrage"), W("yh4vm3wru6nAkkaN")], rows: { chain: "barrage_do", label: "barrage_anim", actionRef: "Barrage", targetRef: "action_targets" } },
  { name: "Soul Steal (port)", kind: "port", gen: port("soul-steal"), targets: [A("zarg", "Soul Steal"), A("keren", "Soul Steal"), W("aTce11W2dmw2lKtR"), W("CWVTIIx0KgYXnQY7")] },
  { name: "Muleta (port)", kind: "port", gen: port("muleta"), targets: [A("blanche", "Muleta"), W("Qvo1tWsdqYJAhvzU")] },
  { name: "Descabello (port)", kind: "port", gen: port("descabello"), targets: [A("blanche", "Descabello"), W("CmyctfYXyvsBmRuf")] },
];

// Reaction rows for the new Batch B shots (applied to every target of the job with that name).
const ROWS_BY_NAME = {
  "Warning Shot": { chain: "warning_shot", label: "ws_anim", actionRef: "Warning Shot", targetRef: "hit_action_targets", after: "ws_nullify" },
  "Life Transference": { wrapRef: "lt_heal", chainLabel: "lt_react", label: "lt_anim", actionRef: "Life Transference" },
  "Illusory Shield": { chain: "is_react", label: "is_anim", actionRef: "Illusory Shield", targetRef: "trigger_subject" },
  "Verónica": { chain: "ver_do", label: "ver_anim", actionRef: "Verónica", targetRef: "self", after: "ver_cost" },
  "Stubborn Scion": { ae: "Stubborn Scion", chain: "scion_halve", label: "scion_anim", actionRef: "Stubborn Scion", targetRef: "self" },
};

// Agent-built character modules (Batch B): party-sig-<who>.js → { jobs }
for (const who of ["hina", "zarg", "keren", "blanche"]) {
  const f = path.join(LIB, "party-sig-" + who + ".js");
  if (!fs.existsSync(f)) continue;
  let mod; try { mod = require(f); } catch (e) { console.error("✗ party-sig-" + who + ".js failed to load: " + e.message); process.exitCode = 1; continue; }
  for (const j of mod.jobs || []) {
    const base = String(j.name).replace(/\s*\(.*\)\s*$/, "");
    const itemNames = new Set((j.targets || []).filter((t) => t.item).map((t) => t.item));
    const key = Object.keys(ROWS_BY_NAME).find((n) => n === base || itemNames.has(n));
    JOBS.push({ ...j, kind: "gen", rows: j.rows || (key ? ROWS_BY_NAME[key] : undefined) });
  }
}

function parseArgs(argv) { const o = {}; for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (!a.startsWith("--")) continue; const k = a.slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true; o[k] = v; } return o; }

// Ours = carries the party ANIM_KEY prefix anywhere (the CFG JSON sits between the header and the key).
const PARTY_MARK = /oni\.dungeon\.party\./;
function decodeStored(s) { return String(s || "").replace(/<\/p>/gi, "\n").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&amp;/g, "&"); }

function applyJob(doc, j, where) {
  doc.system = doc.system || {}; const p = (doc.system.props = doc.system.props || {});
  if (j.kind === "gen" && where === "world") {
    const cur = decodeStored(p.animation_script).trim();
    if (cur && !PARTY_MARK.test(cur) && !j.force) return "skip: world item has its own script";
  }
  p.animation_script = j.stored;
  p.skill_animation_mode = "custom";
  if (j.timing) { p.animation_damage_timing_options = j.timing.mode; p.animation_damage_timing_offset = String(j.timing.offset ?? 0); }
  if (j.preload) p.animation_preload_urls = j.preload.join("\n");
  if (j.rows && !j.rows.ae) {
    const ed = editRows(j.rows);
    p.effect_table = p.effect_table || {}; p.reaction_config_table = p.reaction_config_table || {};
    ed(p.effect_table, p.reaction_config_table);
  }
  return "ok";
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const only = typeof flags.only === "string" ? flags.only.toLowerCase() : null;
  const jobs = []; let failures = 0;
  // copy sources (world items)
  const copyIds = JOBS.filter((j) => j.kind === "copy" && (!only || j.name.toLowerCase().includes(only))).map((j) => j.from);
  const copies = {};
  if (copyIds.length) {
    const db = await openCollection("items");
    try { for (const id of copyIds) { try { copies[id] = await db.get("!items!" + id); } catch { copies[id] = null; } } } finally { await db.close(); }
  }
  for (const J of JOBS) {
    if (only && !J.name.toLowerCase().includes(only)) continue;
    if (J.kind === "copy") {
      const src = copies[J.from]; const p = src && src.system && src.system.props;
      if (!p || !p.animation_script) { console.error("✗ " + J.name + ": copy source missing"); failures++; continue; }
      jobs.push({ ...J, stored: p.animation_script, len: p.animation_script.length, timing: { mode: p.animation_damage_timing_options || "default", offset: p.animation_damage_timing_offset || 0 }, preload: p.animation_preload_urls ? String(p.animation_preload_urls).split(/\n/).filter(Boolean) : null });
      continue;
    }
    let out; try { out = J.gen(); } catch (e) { console.error("✗ " + J.name + ": generator threw — " + e.message); failures++; continue; }
    const r = validate(out.script);
    if (!r.ok) { console.error("✗ " + J.name + ": INVALID"); r.errors.forEach((e) => console.error("    " + e)); failures++; continue; }
    if (J.kind === "port" && /new Sequence|Sequencer\.|game\.modules\.get\(["']sequencer/.test(out.script)) { console.error("✗ " + J.name + ": still references Sequencer"); failures++; continue; }
    if (/\.visible\s*=\s*false/.test(out.script)) { console.error("✗ " + J.name + ": still hides with visible = false"); failures++; continue; }
    r.warnings.forEach((w) => console.warn("  ! " + J.name + ": " + w));
    jobs.push({ ...J, stored: encode(out.script), len: out.script.length, timing: J.kind === "port" ? null : out.timing, preload: J.kind === "port" ? null : out.preload });
  }
  if (failures) { console.error("\n" + failures + " job(s) failed — nothing written."); process.exit(1); }
  console.log(jobs.length + " job(s) built and validated.");
  if (typeof flags.emit === "string") { fs.writeFileSync(flags.emit, JSON.stringify(jobs.map(({ gen, ...j }) => j), null, 2)); console.log("emitted to " + flags.emit); return; }
  if (!flags.write) {
    for (const j of jobs) console.log("  [dry] " + (j.kind || "gen").padEnd(4) + " " + j.name.padEnd(52) + " " + String(j.len).padStart(6) + "b  " + (j.timing ? j.timing.mode + (j.timing.mode === "offset" ? " " + j.timing.offset : "") : "keep-timing") + "  → " + j.targets.map((t) => t.world ? "Item." + t.world : t.item + "@" + Object.keys(ACTOR).find((k) => ACTOR[k] === t.actor)).join(", ") + (j.rows ? "  +rows(" + (j.rows.ae ? "AE:" : "") + (j.rows.chain || j.rows.wrapRef) + ")" : ""));
    console.log("\nDry run — pass --write to apply. GAME MUST BE CLOSED."); return;
  }
  let wrote = 0, missing = 0, skipped = 0;
  const actorJobs = jobs.flatMap((j) => j.targets.filter((t) => t.actor).map((t) => ({ j, t })));
  if (actorJobs.length) {
    const db = await openCollection("actors");
    try {
      const want = new Set(actorJobs.map((x) => x.t.actor)); const index = new Map(); const aeIndex = new Map();
      for await (const [key, val] of db.iterator()) {
        if (key.startsWith("!actors.items.effects!")) { const [aid, iid] = key.split("!")[2].split("."); if (want.has(aid)) { if (!aeIndex.has(aid + "." + iid)) aeIndex.set(aid + "." + iid, []); aeIndex.get(aid + "." + iid).push([key, val]); } continue; }
        if (!key.startsWith("!actors.items!")) continue;
        const aid = key.split("!")[2].split(".")[0]; if (!want.has(aid)) continue;
        if (!val.system?.props?.skill_type) continue;
        const name = String(val.name ?? "");
        if (!index.has(aid)) index.set(aid, new Map()); const m = index.get(aid); if (!m.has(name)) m.set(name, []); m.get(name).push([key, val]);
      }
      for (const { j, t } of actorJobs) {
        const hits = index.get(t.actor)?.get(t.item) || [];
        if (!hits.length) { console.error("✗ " + j.name + ": " + t.item + " not found on Actor." + t.actor); missing++; continue; }
        for (const [key, doc] of hits) {
          applyJob(doc, j, "actor"); await db.put(key, doc); wrote++; console.log("  ✓ " + t.item + " @ Actor." + t.actor);
          if (j.rows && j.rows.ae) {
            const iid = key.split("!")[2].split(".")[1];
            const aes = (aeIndex.get(t.actor + "." + iid) || []).filter(([, e]) => e.name === j.rows.ae);
            if (!aes.length) { console.error("✗ " + j.name + ": AE " + j.rows.ae + " not found"); missing++; continue; }
            for (const [ak, ae] of aes) {
              const rc = ae.flags?.[NS]?.reactionConfig; if (!rc) { console.error("✗ " + j.name + ": AE has no reactionConfig"); missing++; continue; }
              editRows(j.rows)(rc.effect_table = rc.effect_table || {}, rc.reaction_config_table = rc.reaction_config_table || {});
              await db.put(ak, ae); console.log("    ✓ rows on AE " + ae.name);
            }
          }
        }
      }
    } finally { await db.close(); }
  }
  const worldJobs = jobs.flatMap((j) => j.targets.filter((t) => t.world).map((t) => ({ j, t })));
  if (worldJobs.length) {
    const db = await openCollection("items");
    try {
      for (const { j, t } of worldJobs) {
        const key = "!items!" + t.world; let doc;
        try { doc = await db.get(key); } catch { doc = null; }
        if (!doc) { console.error("✗ " + j.name + ": world Item." + t.world + " not found"); missing++; continue; }
        const res = applyJob(doc, j, "world");
        if (res !== "ok") { console.warn("  - " + j.name + " → Item." + t.world + " (" + doc.name + "): " + res); skipped++; continue; }
        await db.put(key, doc); wrote++; console.log("  ✓ Item." + t.world + " (" + doc.name + ")");
      }
    } finally { await db.close(); }
  }
  console.log("\nwrote " + wrote + (skipped ? ", skipped " + skipped : "") + (missing ? ", " + missing + " MISSING" : ""));
  if (missing) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
