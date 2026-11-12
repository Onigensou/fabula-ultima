#!/usr/bin/env node
"use strict";
// ============================================================================
// Wire Slayer's animations (approved mockup v3, 2026-11-13:
// claude.ai/artifact/H7kodjsPFBHdSeufy2CqNM) onto every copy of the three skills:
// the world item, the Slayer class actor's copy and Zarg's copy.
//
//   node bin/_build-slayer-animations.js            # dry run
//   node bin/_build-slayer-animations.js --apply    # write (GAME MUST BE CLOSED)
//   node bin/_build-slayer-animations.js --emit out.json   # the edited docs, for a bridge/staging push
//
// Bane Oils
//   - script (tools/anim-studio/lib/slayer-signatures.js), timing "resolve": only chain rows play it
//   - species chains bo_<sp> = [bo_anim_<sp> (play "#apply:<sp>"), bo_ae_<sp>, bo_free]
//   - each "Bane Oils (<Species>)" AE: aeCue oilDrip (species colour) + its hit menu options wrapped:
//       bo_slow_go = [bo_slow_anim ("#slow:<sp>"), bo_slow]   bo_weak_go likewise
//       bo_r_<el>_go = [bo_r_<el>_anim ("#res:<sp>:<el>"), bo_r_<el>]  (the option's condition copied onto the chain)
// Giant Killer: script + flags.riderCosmetic { variant: "gk" } (battle-director/rider-cosmetic.js)
// Lockdown: script; ld_root = [ld_pick, ld_pay, ld_anim (play "Lockdown")];
//   the "Lockdown" AE: aeCue chainRing + riderCosmetic { variant: "cut" }
// Idempotent. Backs up both collections before writing.
// ============================================================================
const fs = require("fs");
const path = require("path");
const { openCollection } = require("../lib/db");
const { snapshotCollection } = require("../lib/backup");
const LIB = path.resolve(__dirname, "..", "..", "anim-studio", "lib");
const SIG = require(path.join(LIB, "slayer-signatures.js"));
const { encode, validate } = require(path.join(LIB, "encode.js"));

const NS = "fabula-ultima-companion";
const APPLY = process.argv.includes("--apply");
const EMIT = (() => { const i = process.argv.indexOf("--emit"); return i > 0 ? process.argv[i + 1] : null; })();

const BANE_WORLD = "2t9fQihUfuKxSR7Z";
const BANE_REF = "Item." + BANE_WORLD;          // the shot every copy plays (a wielder may not own Bane Oils)
const COPIES = {
  "Bane Oils":    { world: BANE_WORLD,          slayer: "8OjnNG6sf69ZKI0F", zarg: "7M8gnAI2ITODlmfi" },
  "Giant Killer": { world: "473VXhCLo6zThIqf",  slayer: "J62QcjhrrUuTXGqS", zarg: "vvoZh0LfIu51mdgp" },
  "Lockdown":     { world: "9Jia1mhze8Nop6f8",  slayer: "LiSn88DPui1LNevT", zarg: "3yhTiccdnMjRtRfT" },
};
const ACTOR = { slayer: "RQLxwTwMhxZ6zLvR", zarg: "Z4CFy505cD3nzl1W" };
const SPECIES = { beast: "236,140,48", construct: "84,186,255", demon: "226,38,72", elemental: "56,228,196",
  humanoid: "255,208,80", monster: "255,104,206", plant: "116,204,64", undead: "168,124,255" };

// ── row helpers
const live = (t) => Object.entries(t ?? {}).filter(([, r]) => r && !r.$deleted);
const byLabel = (t, l) => live(t).find(([, r]) => r.effect_label === l);
const nextKey = (t) => String(Object.keys(t ?? {}).map(Number).filter(Number.isFinite).reduce((m, n) => Math.max(m, n), -1) + 1);
const steps = (s) => String(s ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const playRow = (label, ref, targetRef) => ({ $deleted: false, effect_kind: "play_animation", effect_label: label, action_ref: ref, target_ref: targetRef });
function ensureRow(t, row, notes, tag) {
  const hit = byLabel(t, row.effect_label);
  if (hit) { const [k, r] = hit; if (r.action_ref !== row.action_ref || r.target_ref !== row.target_ref) { t[k] = { ...r, ...row }; notes.push(`${tag}: ~ ${row.effect_label}`); } return; }
  t[nextKey(t)] = row; notes.push(`${tag}: + ${row.effect_label}`);
}
function prependStep(t, chainLabel, step, notes, tag, after = null) {
  const hit = byLabel(t, chainLabel); if (!hit) throw new Error(`${tag}: no chain ${chainLabel}`);
  const [k, r] = hit; const st = steps(r.chain_steps);
  if (st.includes(step)) return;
  if (after) { const i = st.indexOf(after); if (i < 0) throw new Error(`${tag}: ${after} not in ${chainLabel}`); st.splice(i + 1, 0, step); }
  else st.unshift(step);
  t[k] = { ...r, chain_steps: st.join(", ") }; notes.push(`${tag}: ${chainLabel} = ${t[k].chain_steps}`);
}

// ── per-doc editors
function setScript(doc, built, notes, tag) {
  const p = (doc.system = doc.system || {}).props = doc.system.props || {};
  if (p.animation_script !== built.stored) { p.animation_script = built.stored; notes.push(`${tag}: animation_script (${built.len} b)`); }
  p.skill_animation_mode = "custom";
  p.animation_damage_timing_options = built.timing.mode; p.animation_damage_timing_offset = String(built.timing.offset ?? 0);
  if (built.preload) p.animation_preload_urls = built.preload.join("\n");
}
function wireBaneItem(doc, notes, tag) {
  const p = doc.system.props; const eff = p.effect_table = { ...(p.effect_table ?? {}) };
  for (const sp of Object.keys(SPECIES)) {
    ensureRow(eff, playRow(`bo_anim_${sp}`, `${BANE_REF}#apply:${sp}`, "action_targets"), notes, tag);
    prependStep(eff, `bo_${sp}`, `bo_anim_${sp}`, notes, tag);
  }
}
function wireBaneAE(ae, notes, tag) {
  const m = /^Bane Oils \((\w+)\)$/.exec(ae.name ?? ""); if (!m) return;
  const sp = m[1].toLowerCase(); if (!SPECIES[sp]) throw new Error(`${tag}: unknown species ${m[1]}`);
  const f = (ae.flags = ae.flags || {})[NS] = ae.flags[NS] || {};
  const cue = { kind: "oilDrip", rgb: SPECIES[sp] };
  if (JSON.stringify(f.aeCue) !== JSON.stringify(cue)) { f.aeCue = cue; notes.push(`${tag} [${ae.name}]: aeCue oilDrip`); }
  const rc = f.reactionConfig; if (!rc?.effect_table) throw new Error(`${tag} [${ae.name}]: no reactionConfig`);
  const t = rc.effect_table = { ...rc.effect_table };
  const wrap = (opt, anim, go, variant) => {
    const src = byLabel(t, opt); if (!src) throw new Error(`${tag} [${ae.name}]: no ${opt}`);
    ensureRow(t, playRow(anim, `${BANE_REF}#${variant}`, "trigger_subject"), notes, `${tag} [${ae.name}]`);
    const chain = { $deleted: false, effect_kind: "chain", effect_label: go, chain_steps: `${anim}, ${opt}`, ...(src[1].condition_formula ? { condition_formula: src[1].condition_formula } : {}) };
    const hit = byLabel(t, go);
    if (!hit) { t[nextKey(t)] = chain; notes.push(`${tag} [${ae.name}]: + ${go}`); }
    else if (hit[1].chain_steps !== chain.chain_steps || (hit[1].condition_formula ?? "") !== (chain.condition_formula ?? "")) { t[hit[0]] = { ...hit[1], ...chain }; notes.push(`${tag} [${ae.name}]: ~ ${go}`); }
    return go;
  };
  const menu = (label, map) => {
    const hit = byLabel(t, label); if (!hit) throw new Error(`${tag} [${ae.name}]: no ${label}`);
    const refs = steps(hit[1].menu_option_refs).map((r) => map[r] ?? r).join(", ");
    if (refs !== hit[1].menu_option_refs) { t[hit[0]] = { ...hit[1], menu_option_refs: refs }; notes.push(`${tag} [${ae.name}]: ${label} → ${refs}`); }
  };
  const hitMap = {
    bo_slow: wrap("bo_slow", "bo_slow_anim", "bo_slow_go", `slow:${sp}`),
    bo_weak: wrap("bo_weak", "bo_weak_anim", "bo_weak_go", `weak:${sp}`),
  };
  menu("bo_hit", hitMap);
  const resMap = {};
  for (const el of ["physical", "air", "bolt", "dark", "earth", "fire", "ice", "light", "poison"]) resMap[`bo_r_${el}`] = wrap(`bo_r_${el}`, `bo_r_${el}_anim`, `bo_r_${el}_go`, `res:${sp}:${el}`);
  menu("bo_res", resMap);
}
function wireGkItem(doc, notes, tag) {
  const f = (doc.flags = doc.flags || {})[NS] = doc.flags[NS] || {};
  if (f.riderCosmetic?.variant !== "gk") { f.riderCosmetic = { variant: "gk" }; notes.push(`${tag}: riderCosmetic gk`); }
}
function wireLockItem(doc, notes, tag) {
  const p = doc.system.props; const eff = p.effect_table = { ...(p.effect_table ?? {}) };
  ensureRow(eff, playRow("ld_anim", "Lockdown", "trigger_subject"), notes, tag);
  prependStep(eff, "ld_root", "ld_anim", notes, tag, "ld_pay");
}
function wireLockAE(ae, notes, tag) {
  if (ae.name !== "Lockdown") return;
  const f = (ae.flags = ae.flags || {})[NS] = ae.flags[NS] || {};
  if (f.aeCue?.kind !== "chainRing") { f.aeCue = { kind: "chainRing" }; notes.push(`${tag} [Lockdown AE]: aeCue chainRing`); }
  if (f.riderCosmetic?.variant !== "cut") { f.riderCosmetic = { variant: "cut" }; notes.push(`${tag} [Lockdown AE]: riderCosmetic cut`); }
}

(async () => {
  // build + validate first
  const built = {};
  for (const [name, gen] of [["Bane Oils", SIG.baneOils], ["Giant Killer", SIG.giantKiller], ["Lockdown", SIG.lockdown]]) {
    const o = gen(); const r = validate(o.script);
    if (!r.ok) { console.error(`✗ ${name}: INVALID`, r.errors); process.exit(1); }
    built[name] = { stored: encode(o.script), len: o.script.length, timing: o.timing, preload: o.preload };
  }
  const itemEd = { "Bane Oils": wireBaneItem, "Giant Killer": wireGkItem, "Lockdown": wireLockItem };
  const aeEd = { "Bane Oils": wireBaneAE, "Lockdown": wireLockAE };
  const writes = { items: [], actors: [] };   // [key, doc, notes]

  const items = await openCollection("items");
  try {
    for (const [name, c] of Object.entries(COPIES)) {
      const key = "!items!" + c.world; const doc = await items.get(key);
      if (doc.name !== name) throw new Error(`${key} is "${doc.name}"`);
      const notes = []; setScript(doc, built[name], notes, `world ${name}`); itemEd[name](doc, notes, `world ${name}`);
      writes.items.push([key, doc, notes]);
      if (aeEd[name]) for await (const [k, ae] of items.iterator({ gte: `!items.effects!${c.world}.`, lt: `!items.effects!${c.world}.￿` })) {
        const n2 = []; aeEd[name](ae, n2, `world ${name}`); if (n2.length) writes.items.push([k, ae, n2]);
      }
    }
  } finally { await items.close(); }
  const actors = await openCollection("actors");
  try {
    for (const who of ["slayer", "zarg"]) for (const [name, c] of Object.entries(COPIES)) {
      const key = `!actors.items!${ACTOR[who]}.${c[who]}`; const doc = await actors.get(key);
      if (doc.name !== name) throw new Error(`${key} is "${doc.name}"`);
      const notes = []; setScript(doc, built[name], notes, `${who} ${name}`); itemEd[name](doc, notes, `${who} ${name}`);
      writes.actors.push([key, doc, notes]);
      if (aeEd[name]) { const pre = `!actors.items.effects!${ACTOR[who]}.${c[who]}.`;
        for await (const [k, ae] of actors.iterator({ gte: pre, lt: pre + "￿" })) { const n2 = []; aeEd[name](ae, n2, `${who} ${name}`); if (n2.length) writes.actors.push([k, ae, n2]); } }
    }
  } finally { await actors.close(); }

  let n = 0;
  for (const coll of ["items", "actors"]) for (const [k, , notes] of writes[coll]) { if (!notes.length) continue; console.log(`  ${k}`); for (const s of notes) console.log(`    ${s}`); n += notes.length; }
  if (EMIT) { fs.writeFileSync(EMIT, JSON.stringify(writes, null, 1)); console.log("emitted " + EMIT); return; }
  if (!APPLY || !n) { console.log(n ? `\n${n} change(s). Dry run — pass --apply (GAME CLOSED).` : "\nNothing to do."); return; }
  for (const coll of ["items", "actors"]) {
    const todo = writes[coll].filter(([, , notes]) => notes.length); if (!todo.length) continue;
    console.log(`backup ${coll}: ${snapshotCollection(coll)}`);
    const db = await openCollection(coll);
    try { for (const [k, doc] of todo) await db.put(k, doc); } finally { await db.close(); }
  }
  console.log(`written: ${n} change(s).`);
})().catch((e) => { console.error(e); process.exit(1); });
