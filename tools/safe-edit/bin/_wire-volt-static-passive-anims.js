// Wire the pixelfx passive shots (approved mockup 2026-11-10,
// claude.ai/artifact/GmHAYWhV8rCRHVigfTc4bw) into the two passives' chains, and
// put the Static charge cue on the Static AE template.
//
//   Ampere · Volt Counter      reaction → vc_chain [vc_anim (play_animation), vd_damage]
//   Skizzik · Static Buildup   static_discharge → [static_anim (play_animation), static_blast, static_clear]
//   Skizzik · "Static" AE      flags.fabula-ultima-companion.chargeOrbit (charge-orbit-fx.js)
//
// The scripts themselves are written by _build-dungeon-animations.js
// (--only "Volt Counter" / --only "Static Buildup"). Idempotent.
// Run from tools/safe-edit. --apply to write; default is dry-run. GAME MUST BE CLOSED.
const path = require("path");
const { openCollection } = require("../lib/db");
const { snapshotCollection } = require("../lib/backup");
const { STATIC_CHARGE_ORBIT } = require(path.resolve(__dirname, "..", "..", "anim-studio", "lib", "passive-pxfx-signatures.js"));

const APPLY = process.argv.includes("--apply");
const NS = "fabula-ultima-companion";

const AMPERE = "kAYN54Id3iTAOw1A", VOLT = "IQjzHjHJRozJJ4Oe";
const SKIZZIK = "I2sSkVIQ4FCunZBE", STA_P = "2nHv9Fvn5En9wL3S", STA_AE = "caLqUKUMBeJxH8kK";
const ik = (a, i) => `!actors.items!${a}.${i}`;
const aek = (a, i, e) => `!actors.items.effects!${a}.${i}.${e}`;

const rowsOf = (t) => Object.entries(t ?? {}).filter(([, r]) => r && !r.$deleted);
const byLabel = (t, label) => rowsOf(t).find(([, r]) => r.effect_label === label);
const nextKey = (t) => String(Object.keys(t ?? {}).map(Number).filter(Number.isFinite).reduce((m, n) => Math.max(m, n), -1) + 1);
const steps = (s) => String(s ?? "").split(",").map((x) => x.trim()).filter(Boolean);

function wireVolt(doc, notes) {
  const p = doc.system.props;
  const eff = p.effect_table = { ...(p.effect_table ?? {}) };
  if (!byLabel(eff, "vd_damage")) throw new Error("Volt Counter: no vd_damage row");
  if (!byLabel(eff, "vc_anim")) {
    eff[nextKey(eff)] = { effect_kind: "play_animation", effect_label: "vc_anim", action_ref: "Volt Counter", target_ref: "vd_targets" };
    notes.push("Volt Counter: + vc_anim (play_animation, targets vd_targets)");
  }
  if (!byLabel(eff, "vc_chain")) {
    eff[nextKey(eff)] = { effect_kind: "chain", effect_label: "vc_chain", chain_steps: "vc_anim, vd_damage" };
    notes.push("Volt Counter: + vc_chain [vc_anim, vd_damage]");
  }
  const rc = p.reaction_config_table = { ...(p.reaction_config_table ?? {}) };
  for (const [k, r] of rowsOf(rc)) {
    if (r.reaction_effect_ref === "vd_damage") { rc[k] = { ...r, reaction_effect_ref: "vc_chain" }; notes.push(`Volt Counter: reaction row ${k} → vc_chain`); }
  }
  if (!rowsOf(rc).some(([, r]) => r.reaction_effect_ref === "vc_chain")) throw new Error("Volt Counter: no reaction row points at vc_chain");
}

function wireStatic(doc, notes) {
  const p = doc.system.props;
  const eff = p.effect_table = { ...(p.effect_table ?? {}) };
  const ch = byLabel(eff, "static_discharge");
  if (!ch) throw new Error("Static Buildup: no static_discharge chain");
  if (!byLabel(eff, "static_anim")) {
    eff[nextKey(eff)] = { effect_kind: "play_animation", effect_label: "static_anim", action_ref: "Static Buildup", target_ref: "static_victim" };
    notes.push("Static Buildup: + static_anim (play_animation, targets static_victim)");
  }
  const st = steps(ch[1].chain_steps);
  if (st[0] !== "static_anim") {
    eff[ch[0]] = { ...ch[1], chain_steps: ["static_anim", ...st.filter((s) => s !== "static_anim")].join(", ") };
    notes.push(`Static Buildup: static_discharge = ${eff[ch[0]].chain_steps}`);
  }
}

function wireStaticAE(doc, notes) {
  doc.flags = doc.flags ?? {};
  doc.flags[NS] = doc.flags[NS] ?? {};
  if (JSON.stringify(doc.flags[NS].chargeOrbit) !== JSON.stringify(STATIC_CHARGE_ORBIT)) {
    doc.flags[NS].chargeOrbit = STATIC_CHARGE_ORBIT;
    notes.push("Static AE: chargeOrbit cue (orbit1 / orbit2)");
  }
}

(async () => {
  const db = await openCollection("actors");
  const jobs = [
    [ik(AMPERE, VOLT), "Volt Counter", wireVolt],
    [ik(SKIZZIK, STA_P), "Static Buildup", wireStatic],
    [aek(SKIZZIK, STA_P, STA_AE), "Static", wireStaticAE],
  ];
  const out = [];
  try {
    for (const [key, name, fn] of jobs) {
      const doc = await db.get(key).catch(() => null);
      if (!doc) throw new Error(`missing ${key}`);
      if (doc.name !== name) throw new Error(`${key} is "${doc.name}", expected "${name}"`);
      const notes = [];
      fn(doc, notes);
      out.push([key, doc, notes]);
    }
  } finally { await db.close(); }

  console.log(APPLY ? "=== APPLYING ===" : "=== DRY RUN (pass --apply to write) ===");
  let n = 0;
  for (const [key, , notes] of out) { console.log(`  ${key}`); for (const s of notes) console.log(`    ${s}`); if (!notes.length) console.log("    (already wired)"); n += notes.length; }
  if (!APPLY || !n) { console.log(n ? "\nNo writes performed." : "\nNothing to do."); return; }

  const bk = snapshotCollection("actors");
  console.log(`\nbackup: ${bk}`);
  const w = await openCollection("actors");
  try { for (const [key, doc, notes] of out) if (notes.length) await w.put(key, doc); }
  finally { await w.close(); }
  console.log("written.");
})().catch((e) => { console.error(e); process.exit(1); });
