#!/usr/bin/env node
"use strict";
// ============================================================================
// Build + write the party Zero Powers (Hina, Blanche, Keren, Zarg) from the
// approved "Zero Power overhaul" mockup (2026-11-06), with the automation
// fixes from the same review, onto the actor copies AND their world parents.
//
//   node bin/_build-zero-powers.js                 # dry run: build, validate, show the plan
//   node bin/_build-zero-powers.js --write         # write to LevelDB (GAME MUST BE CLOSED)
//   node bin/_build-zero-powers.js --emit out.json # validated, encoded jobs (sandbox push)
//
// Source of truth: tools/anim-studio/lib/zp-sig-<who>.js + zp-shots/*.inner.js.
// Tune in game, fold the numbers back there, or the next --write reverts them.
// Supersedes the four Zero Power PORT jobs that _build-party-animations.js used to write.
//
// Automation fixes (first-round audit, approved 2026-11-06):
//   Zarg   damage was dealt TWICE on his copy (main profile Poison 30 + the ms_strike row,
//          whose CHAR_LEVEL read the target's level). Damage is now the MAIN profile only:
//          type_damage VAR_ELEMENT (the pick), 30 + floor(CHAR_LEVEL / 2) (caster level);
//          ms_strike / ms_cost rows retired; cost "6 Zero Power" like Hina and Blanche.
//   Keren  shattered and counted EVERY own summon (incl. the Birth of the Cruel minion):
//          now own_phantasms + own_numen only; dead damage fields off the shatter row;
//          cost "6 Zero Power"; the world parent gets the props it was missing.
//   All    `chain` keywords for the pseudo multi-hit numbers (one roll, hidden badge),
//          dead custom_logic_action scripts cleared, preload lists, timing from the
//          shot; every "Zero Power:" item is flagged isZeroPower (Zero Trigger feed).
// ============================================================================
const fs = require("fs");
const path = require("path");
const { openCollection } = require("../lib/db");

const LIB = path.resolve(__dirname, "..", "..", "anim-studio", "lib");
const { encode, validate } = require(path.join(LIB, "encode.js"));

const ACTOR = { hina: "dafTLBUscCDNgq8H", zarg: "Z4CFy505cD3nzl1W", keren: "gdJZ1L1kv5mjTTMr", blanche: "uJFaNQCSvwwsr2AW" };

const KEREN_CHAIN = 'chain {OWN_PHANTASM_COUNT + OWN_NUMEN_COUNT * 2 + OWN_MINION_COUNT + 3} hidden';
const ZARG_CHAIN = "chain 24 hidden";

// Merge a chain keyword into an action_keywords list (replacing any earlier chain keyword).
function withChain(cur, kw) {
  const list = String(cur ?? "").split(/[,\n]+/).map((s) => s.trim()).filter(Boolean).filter((s) => !/^chain\b/i.test(s));
  if (/[,]/.test(kw)) throw new Error("a chain keyword cannot contain a comma: " + kw);
  list.push(kw); return list.join(", ");
}
const live = (t) => Object.entries(t || {}).filter(([, r]) => r && r.$deleted !== true);
const rowBy = (t, label) => { const e = live(t).find(([, r]) => r.effect_label === label); return e ? e[1] : null; };
const nextKey = (t) => { const ks = Object.keys(t).map(Number).filter(Number.isFinite); return String(ks.length ? Math.max(...ks) + 1 : 0); };

// ── per-skill data fixes (applied to the copy AND the parent) ──
const FIX = {
  zarg(p) {
    p.type_damage = "VAR_ELEMENT";
    p.damage_bonus = "30 + floor(CHAR_LEVEL / 2)";
    p.cost = "6 Zero Power";
    p.isZeroPower = true;
    p.action_keywords = withChain(p.action_keywords, ZARG_CHAIN);
    p.custom_logic_action = "";
    const T = (p.effect_table = p.effect_table || {});
    const root = rowBy(T, "ms_root"); if (!root) throw new Error("Zarg: ms_root missing");
    root.chain_steps = "ms_pick_status";
    for (const l of ["ms_strike", "ms_cost"]) { const r = rowBy(T, l); if (r) r.$deleted = true; }
  },
  keren(p) {
    p.damage_bonus = "((OWN_PHANTASM_COUNT + OWN_NUMEN_COUNT) * 20) + 20";
    p.cost = "6 Zero Power";
    p.isZeroPower = true;
    p.action_keywords = withChain(p.action_keywords, KEREN_CHAIN);
    p.custom_logic_action = "";
    const T = (p.effect_table = p.effect_table || {});
    const root = rowBy(T, "zp_root"); if (!root) throw new Error("Keren: zp_root missing");
    const sh = rowBy(T, "zp_shatter"); if (!sh && !rowBy(T, "zp_shatter_p")) throw new Error("Keren: zp_shatter missing");
    if (sh) { sh.effect_label = "zp_shatter_p"; sh.target_ref = "own_phantasms"; sh.suppress_defeat = true; delete sh.damage_amount; delete sh.damage_cause; delete sh.damage_element; }
    if (!rowBy(T, "zp_shatter_n")) T[nextKey(T)] = { $deleted: false, effect_kind: "destroy_summon", effect_label: "zp_shatter_n", suppress_defeat: true, target_ref: "own_numen" };
    root.chain_steps = "zp_shatter_p, zp_shatter_n";
    const c = rowBy(T, "zp_cost"); if (c) c.$deleted = true;
  },
  hina(p) { p.isZeroPower = true; },
  blanche(p) { p.isZeroPower = true; p.damage_bonus = ""; p.custom_logic_action = ""; },
};
// Keren's world parent is missing props its actor copy has: copy them over (never the script fields).
const PARENT_FILL = { keren: { from: { actor: ACTOR.keren, item: "OoQjrz63C5m8OOoc" }, skip: new Set(["animation_script", "custom_logic_action", "effect_table", "animation_preload_urls"]) } };

const JOBS = [
  { who: "hina", mod: "zp-sig-hina.js", fn: "hina", copy: "oe3OP8VmjHJpWJ41", world: "WjrBIzz4zJvO4C4k", name: "Zero Power: A Million Possibility" },
  { who: "blanche", mod: "zp-sig-blanche.js", fn: "blanche", copy: "1D1rFRDBiIuINoei", world: "5vKJb9OFFYdPK8iF", name: "Zero Power: Give me tips or 5stars" },
  { who: "keren", mod: "zp-sig-keren.js", fn: "keren", copy: "OoQjrz63C5m8OOoc", world: "dKbnZH1Vw1a9WPUf", name: "Zero Power: Last Den of Cinders" },
  { who: "zarg", mod: "zp-sig-zarg.js", fn: "zarg", copy: "NwH4UInAFxCn958U", world: "hTb8c9ZREooiKs9k", name: "Zero Power: Meteor Shower" },
];

function parseArgs(argv) { const o = {}; for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (!a.startsWith("--")) continue; const k = a.slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true; o[k] = v; } return o; }

function applyAnim(p, j) {
  p.animation_script = j.stored;
  p.skill_animation_mode = "custom";
  p.animation_damage_timing_options = j.timing.mode;
  p.animation_damage_timing_offset = String(j.timing.offset ?? 0);
  p.animation_preload_urls = j.preload.join("\n");
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const only = typeof flags.only === "string" ? flags.only.toLowerCase() : null;
  const built = []; let failures = 0;
  for (const J of JOBS) {
    if (only && J.who !== only) continue;
    let out;
    try { const mod = require(path.join(LIB, J.mod)); out = mod[J.fn](); } catch (e) { console.error("✗ " + J.name + ": generator failed — " + e.message); failures++; continue; }
    const r = validate(out.script);
    if (!r.ok) { console.error("✗ " + J.name + ": INVALID"); r.errors.forEach((e) => console.error("    " + e)); failures++; continue; }
    if (/new Sequence|Sequencer\./.test(out.script)) { console.error("✗ " + J.name + ": references Sequencer"); failures++; continue; }
    if (/\.visible\s*=\s*false/.test(out.script)) { console.error("✗ " + J.name + ": hides with visible = false"); failures++; continue; }
    r.warnings.forEach((w) => console.warn("  ! " + J.name + ": " + w));
    built.push({ ...J, stored: encode(out.script), len: out.script.length, timing: out.timing, preload: out.preload || [] });
  }
  if (failures) { console.error("\n" + failures + " job(s) failed — nothing written."); process.exit(1); }
  console.log(built.length + " shot(s) built and validated.");
  for (const j of built) console.log("  " + j.name.padEnd(40) + String(j.len).padStart(7) + "b  " + j.timing.mode + (j.timing.mode === "offset" ? " " + j.timing.offset : "") + "  preload " + j.preload.length);
  if (typeof flags.emit === "string") {
    fs.writeFileSync(flags.emit, JSON.stringify(built.map((j) => ({ who: j.who, name: j.name, copy: j.copy, world: j.world, actor: ACTOR[j.who], stored: j.stored, timing: j.timing, preload: j.preload, keywords: j.who === "zarg" ? ZARG_CHAIN : j.who === "keren" ? KEREN_CHAIN : null })), null, 2));
    console.log("emitted to " + flags.emit); return;
  }
  if (!flags.write) { console.log("\nDry run — pass --write to apply (copies + parents + data fixes + isZeroPower sweep). GAME MUST BE CLOSED."); return; }

  let wrote = 0, missing = 0;
  const fillFrom = {}; const found = new Set(); const foundWorld = new Set();
  // ── actor copies (+ the isZeroPower sweep over every actor's "Zero Power:" items) ──
  {
    const db = await openCollection("actors");
    try {
      const want = new Map(built.map((j) => [ACTOR[j.who] + "." + j.copy, j]));
      const fillKeys = new Set(Object.values(PARENT_FILL).map((f) => f.from.actor + "." + f.from.item));
      for await (const [key, val] of db.iterator()) {
        if (!key.startsWith("!actors.items!")) continue;
        const id = key.split("!")[2];
        const j = want.get(id);
        const p = (val.system = val.system || {}).props = val.system.props || {};
        if (j) {
          applyAnim(p, j); FIX[j.who](p); found.add(id);
          await db.put(key, val); wrote++; console.log("  ✓ " + j.name + " @ Actor." + ACTOR[j.who]);
          if (fillKeys.has(id)) fillFrom[id] = JSON.parse(JSON.stringify(p));
          continue;
        }
        if (/^zero power\s*:/i.test(String(val.name || "")) && p.isZeroPower !== true) {
          p.isZeroPower = true; await db.put(key, val); wrote++; console.log("  ✓ isZeroPower: " + val.name + " @ Actor." + id.split(".")[0]);
        }
      }
      for (const j of built) if (!found.has(ACTOR[j.who] + "." + j.copy)) { console.error("✗ actor copy missing for " + j.name); missing++; }
    } finally { await db.close(); }
  }
  // ── world parents (+ the isZeroPower sweep over world items) ──
  {
    const db = await openCollection("items");
    try {
      const byId = new Map(built.map((j) => [j.world, j]));
      for await (const [key, val] of db.iterator()) {
        if (!key.startsWith("!items!")) continue;
        const id = key.split("!")[2];
        const p = (val.system = val.system || {}).props = val.system.props || {};
        const j = byId.get(id);
        if (j) {
          const fill = PARENT_FILL[j.who];
          if (fill) { const src = fillFrom[fill.from.actor + "." + fill.from.item]; if (src) for (const [k, v] of Object.entries(src)) if (!(k in p) && !fill.skip.has(k)) p[k] = JSON.parse(JSON.stringify(v)); }
          applyAnim(p, j); FIX[j.who](p); foundWorld.add(id);
          await db.put(key, val); wrote++; console.log("  ✓ " + j.name + " @ Item." + id + (fill ? " (+ missing props from the copy)" : ""));
          continue;
        }
        if (/^zero power\s*:/i.test(String(val.name || "")) && p.isZeroPower !== true) {
          p.isZeroPower = true; await db.put(key, val); wrote++; console.log("  ✓ isZeroPower: " + val.name + " @ Item." + id);
        }
      }
      for (const j of built) if (!foundWorld.has(j.world)) { console.error("✗ world parent missing for " + j.name); missing++; }
    } finally { await db.close(); }
  }
  console.log("\nwrote " + wrote + (missing ? ", " + missing + " MISSING" : ""));
  if (missing) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
