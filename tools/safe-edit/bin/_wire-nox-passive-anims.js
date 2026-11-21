// Wire the Nox Legion passive / follow-up animations (approved mockup 2026-11-20,
// claude.ai/artifact/HPbnUfL5sy26XmK1oLU8hU) into their chains. A passive's shot only plays
// from a play_animation row in its own chain (precedent: _wire-volt-static-passive-anims.js).
// play_animation AWAITS the script's damage gate, so [anim, effect] lands the effect at the shot's impact.
//
//   Ghoul · Counter when enemy Healed  ch_counter (free Grave Claw)  -> ch_chain [ch_anim (tell), ch_counter]
//   Hound · On the Hunt                oth_hunt (free Rending Fangs) -> oth_chain [oth_anim (tell), oth_hunt]
//   Priest · Soul Siphon               ss_mp (grant 30 MP)           -> ss_chain [ss_anim (siphon, target = the fragment), ss_mp]
//   Viper · Feeding Coil               fc_own [fc_held, fc_bite]     -> [fc_held, fc_anim (tell on fc_held), fc_bite]
//                                      fc_victim (victim's turn)    -> fc_vchain [fc_vanim (tell), fc_victim]
//   Viper · Bile Spew (action chain)   bs_chain [bs_save, bs_break, bs_venom] -> [bs_save, bs_fail_anim ("Bile Spew#armorbreak"
//                                      on save_failed_targets), bs_break, bs_venom]
//   Executioner · Parry                py_half (incoming adjust_damage) -> py_chain [py_anim (target = the attacker), py_half]
//                                      (card-mutations / incoming-damage paths both expand a chain to its one adjust_damage)
//   Executioner · Beheading            bh_round [bh_pick, bh_eat, bh_kill, bh_unmark] -> [bh_pick, bh_anim, bh_eat, bh_kill, bh_unmark]
//                                      (the KO lands at the slash's contact frame = the shot's gate; the fragment is still up)
//   Wraith · Ethereal                  a stat passive (Strike RS via its AE) with no rows -> + et_anim + a creature_hit_by_action
//                                      reaction (self, ATTACK_VS_DEF == 1 && INCOMING_DAMAGE > 0) -> et_anim. Cue only: the halving
//                                      stays on the AE. Needs defenseResolved on the hit_by_action payload (state-handlers §7c-bis).
//
// The scripts themselves are written by _build-dungeon-animations.js (--only "Nox <Monster>"). Idempotent.
// Run from tools/safe-edit. --apply to write; default is dry-run. GAME MUST BE CLOSED.
const { openCollection } = require("../lib/db");
const { snapshotCollection } = require("../lib/backup");

const APPLY = process.argv.includes("--apply");
const WRAITH = "CzQhpNYeo3ZI0TzH", GHOUL = "HiIGOwMq8q57TeUh", HOUND = "RFnNMvI0AtMQpwuP", PRIEST = "QlhI0YQZ0uqRKTLb", VIPER = "gXSRiFqgfMZkQnXr", EXEC = "lCrB0iEWzPkNrzry";
const ik = (a, i) => `!actors.items!${a}.${i}`;
const rowsOf = (t) => Object.entries(t ?? {}).filter(([, r]) => r && !r.$deleted);
const byLabel = (t, label) => rowsOf(t).find(([, r]) => r.effect_label === label);
const nextKey = (t) => String(Object.keys(t ?? {}).map(Number).filter(Number.isFinite).reduce((m, n) => Math.max(m, n), -1) + 1);
const steps = (s) => String(s ?? "").split(",").map((x) => x.trim()).filter(Boolean);

// anim row + a chain [anim, effect] + the reaction rows that pointed at `effect` re-pointed at the chain
function wrapReaction(doc, notes, { effect, anim, chain, actionRef, targetRef }) {
  const p = doc.system.props; const nm = doc.name;
  const eff = p.effect_table = { ...(p.effect_table ?? {}) };
  if (!byLabel(eff, effect)) throw new Error(`${nm}: no ${effect} row`);
  if (!byLabel(eff, anim)) { eff[nextKey(eff)] = { effect_kind: "play_animation", effect_label: anim, action_ref: actionRef, target_ref: targetRef, condition_formula: "" }; notes.push(`${nm}: + ${anim} (play_animation "${actionRef}", targets ${targetRef})`); }
  if (!byLabel(eff, chain)) { eff[nextKey(eff)] = { effect_kind: "chain", effect_label: chain, chain_steps: `${anim}, ${effect}`, condition_formula: "" }; notes.push(`${nm}: + ${chain} [${anim}, ${effect}]`); }
  const rc = p.reaction_config_table = { ...(p.reaction_config_table ?? {}) };
  for (const [k, r] of rowsOf(rc)) if (r.reaction_effect_ref === effect) { rc[k] = { ...r, reaction_effect_ref: chain }; notes.push(`${nm}: reaction row ${k} (${r.reaction_trigger}) -> ${chain}`); }
  if (!rowsOf(rc).some(([, r]) => r.reaction_effect_ref === chain)) throw new Error(`${nm}: no reaction row points at ${chain}`);
}
// insert an anim row into an existing chain right after `after`
function insertStep(doc, notes, { chain, after, anim, actionRef, targetRef }) {
  const p = doc.system.props; const nm = doc.name;
  const eff = p.effect_table = { ...(p.effect_table ?? {}) };
  const ch = byLabel(eff, chain); if (!ch) throw new Error(`${nm}: no ${chain} chain`);
  if (!byLabel(eff, anim)) { eff[nextKey(eff)] = { effect_kind: "play_animation", effect_label: anim, action_ref: actionRef, target_ref: targetRef, condition_formula: "" }; notes.push(`${nm}: + ${anim} (play_animation "${actionRef}", targets ${targetRef})`); }
  const st = steps(ch[1].chain_steps);
  if (!st.includes(anim)) { const i = st.indexOf(after); if (i < 0) throw new Error(`${nm}: ${chain} has no ${after}`); st.splice(i + 1, 0, anim); eff[ch[0]] = { ...ch[1], chain_steps: st.join(", ") }; notes.push(`${nm}: ${chain} = ${eff[ch[0]].chain_steps}`); }
}

// a play_animation row + one reaction row pointing straight at it (an item that had no trigger rows at all)
function addCue(doc, notes, { anim, actionRef, targetRef, reaction }) {
  const p = doc.system.props; const nm = doc.name;
  const eff = p.effect_table = { ...(p.effect_table ?? {}) };
  if (!byLabel(eff, anim)) { eff[nextKey(eff)] = { effect_kind: "play_animation", effect_label: anim, action_ref: actionRef, target_ref: targetRef, condition_formula: "" }; notes.push(`${nm}: + ${anim} (play_animation "${actionRef}", targets ${targetRef})`); }
  const rc = p.reaction_config_table = { ...(p.reaction_config_table ?? {}) };
  if (!rowsOf(rc).some(([, r]) => r.reaction_effect_ref === anim)) { rc[nextKey(rc)] = { $deleted: false, ...reaction, reaction_effect_ref: anim }; notes.push(`${nm}: + reaction ${reaction.reaction_trigger} if ${reaction.condition_formula} -> ${anim}`); }
  if (p.isReaction !== true) { p.isReaction = true; notes.push(`${nm}: isReaction = true`); }
}

const JOBS = [
  [GHOUL, "Counter when enemy Healed", (d, n) => wrapReaction(d, n, { effect: "ch_counter", anim: "ch_anim", chain: "ch_chain", actionRef: "Counter when enemy Healed", targetRef: "trigger_subject" })],
  [HOUND, "On the Hunt", (d, n) => wrapReaction(d, n, { effect: "oth_hunt", anim: "oth_anim", chain: "oth_chain", actionRef: "On the Hunt", targetRef: "trigger_subject" })],
  [PRIEST, "Soul Siphon", (d, n) => wrapReaction(d, n, { effect: "ss_mp", anim: "ss_anim", chain: "ss_chain", actionRef: "Soul Siphon", targetRef: "trigger_actor" })],
  [VIPER, "Feeding Coil", (d, n) => { insertStep(d, n, { chain: "fc_own", after: "fc_held", anim: "fc_anim", actionRef: "Feeding Coil", targetRef: "fc_held" });
    wrapReaction(d, n, { effect: "fc_victim", anim: "fc_vanim", chain: "fc_vchain", actionRef: "Feeding Coil", targetRef: "trigger_subject" }); }],
  [VIPER, "Bile Spew", (d, n) => insertStep(d, n, { chain: "bs_chain", after: "bs_save", anim: "bs_fail_anim", actionRef: "Bile Spew#armorbreak", targetRef: "save_failed_targets" })],
  [EXEC, "Parry", (d, n) => wrapReaction(d, n, { effect: "py_half", anim: "py_anim", chain: "py_chain", actionRef: "Parry", targetRef: "trigger_actor" })],
  [WRAITH, "Ethereal", (d, n) => addCue(d, n, { anim: "et_anim", actionRef: "Ethereal", targetRef: "trigger_attacker", reaction: {
    reaction_trigger: "creature_hit_by_action", reaction_source: "self", reaction_action_intent: "harmful", reaction_passive_mode: "on",
    reaction_source_skill: "", condition_formula: "ATTACK_VS_DEF == 1 && INCOMING_DAMAGE > 0" } })],
  [EXEC, "Beheading", (d, n) => insertStep(d, n, { chain: "bh_round", after: "bh_pick", anim: "bh_anim", actionRef: "Beheading", targetRef: "bh_pick" })],
];

(async () => {
  const db = await openCollection("actors");
  const out = [];
  try {
    const want = new Map(JOBS.map(([a, name]) => [a + "|" + name, true]));
    const found = new Map();
    for await (const [key, val] of db.iterator()) {
      if (!key.startsWith("!actors.items!")) continue;
      const aid = key.split("!")[2].split(".")[0];
      if (want.has(aid + "|" + val.name) && val.system?.props?.skill_type) found.set(aid + "|" + val.name, [key, val]);
    }
    for (const [aid, name, fn] of JOBS) {
      const hit = found.get(aid + "|" + name); if (!hit) throw new Error(`missing ${name} on ${aid}`);
      const [key, doc] = hit; const notes = []; fn(doc, notes); out.push([key, name, doc, notes]);
    }
  } finally { await db.close(); }
  console.log(APPLY ? "=== APPLYING ===" : "=== DRY RUN (pass --apply to write) ===");
  let n = 0; const seenKey = new Map();
  for (const [key, name, doc, notes] of out) { console.log(`  ${name}  ${key}`); for (const s of notes) console.log(`    ${s}`); if (!notes.length) console.log("    (already wired)"); n += notes.length; seenKey.set(key, doc); }
  if (!APPLY || !n) { console.log(n ? "\nNo writes performed." : "\nNothing to do."); return; }
  const bk = snapshotCollection("actors"); console.log(`\nbackup: ${bk}`);
  const w = await openCollection("actors");
  try { for (const [key, doc] of seenKey) await w.put(key, doc); } finally { await w.close(); }
  console.log("written.");
})().catch((e) => { console.error(e); process.exit(1); });
