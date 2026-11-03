// 2026-11-04 — Rakshasa's resource handling. Game must be CLOSED. Backs up the actors store.
//
// _build-rakshasa.js hung follow-up rows off `chain_steps` on NON-chain rows (apply_ae,
// deal_damage, remove_ae). Only an `effect_kind: "chain"` row runs chain_steps
// (applyChainEffect), so every one of those follow-ups was dead:
//   - Chakram / Mace / Rending Orbit never spent the stance that allowed them, so the
//     monster repeated the same doubled attack forever instead of shifting form;
//   - Form Shift / Form Shift (Dual) never recovered their 15 MP, and Dual never even
//     armed its combo (fs2_clear removed the stances, then nothing drew a new one);
//   - Devour never healed.
// Fix: each skill gets a `chain` root row listing its steps, and on_activate points at
// it. The stance is spent FIRST, so a miss (whose on-hit rider finds no target and stops
// the chain) still spends it.
//
// Also, per the action text:
//   - Chakram / Rending Orbit inflict Bleed on a HIT only (hit_action_targets), like Mace.
//   - Mace: "halve its Defence until the effect is removed" -> this application is
//     scene-long (ae_duration_rounds "scene": no turn counter, not reaped when the
//     Rakshasa falls; a cleanse or the battle's end removes it), and the halved DEF
//     rounds UP (flags.<ns>.roundUp, read by csb-ae-round-up.js, module v1.0.514+). It also
//     gets `statuses: ["crippled"]`: with no duration and no status Foundry treats an AE as
//     non-temporary and draws NO token icon, so a scene-long Crippled would be invisible.
// Devour, per its text ("recover HP equal to half the damage dealt"): its 45 moves from an
// on_activate deal_damage row onto the skill's primary damage, and the heal becomes the
// post-damage step `floor(HP_DEALT / 2)` (Drain Spirit's route on the same template). It stays
// isCheck:false, so the damage keeps class null and still lands on a Strike-immune PC.
//
//   node tools/safe-edit/bin/_fix-rakshasa-resources.js [--dry]
const path = require("path");
const fs = require("fs");
const { ClassicLevel } = require(path.join(__dirname, "..", "node_modules", "classic-level"));

const NS = "fabula-ultima-companion";
const A = "Rk5haXsaDemonAAA";
const DIR = path.join(__dirname, "..", "..", "..", "worlds", "fabula-ultima-2", "data", "actors");
const DRY = process.argv.includes("--dry");

// item id -> { root label, steps, rows to blank chain_steps on, rows to retarget on-hit, extra row edits }
const PLAN = {
  RkChakramThrow01: { root: "ch_root", steps: "spend_stance,ch_bleed", blank: ["ch_bleed"], onHit: ["ch_bleed"] },
  RkCrippleFlail01: { root: "cr_root", steps: "spend_stance,cr_debuff", blank: ["cr_debuff"], onHit: ["cr_debuff"],
    rowEdits: { cr_debuff: { ae_duration_rounds: "scene" } } },
  RkRendingOrbit01: { root: "ro_root", steps: "spend_combo,ro_bleed", blank: ["ro_bleed"], onHit: ["ro_bleed"] },
  RkFormShift01AAA: { root: "fs_root", steps: "fs_draw,fs_mp", blank: ["fs_draw"] },
  RkFormShiftCris1: { root: "fs2_root", steps: "fs2_clear,fs2_draw,fs2_mp", blank: ["fs2_clear", "fs2_draw"] },
};
const CRIPPLED = `!actors.items.effects!${A}.RkCrippleFlail01.RkAeCrippledDef1`;

(async () => {
  if (!DRY) {
    const bk = path.join(__dirname, "..", "backups", `${new Date().toISOString().replace(/[:.]/g, "-")}-fabula-ultima-2-actors-rakshasa-resources`);
    fs.cpSync(DIR, bk, { recursive: true, filter: (p) => !/[\\/]LOCK$/.test(p) });
    console.log("backup:", bk);
  }
  const db = new ClassicLevel(DIR, { keyEncoding: "utf8", valueEncoding: "utf8" });
  await db.open({ createIfMissing: false });   // fails while Foundry holds the LOCK
  try {
    const batch = db.batch();
    for (const [id, plan] of Object.entries(PLAN)) {
      const key = `!actors.items!${A}.${id}`;
      const item = JSON.parse(await db.get(key));
      const p = item.system.props;
      const table = p.effect_table;
      const rows = Object.entries(table).filter(([, r]) => !r.$deleted);
      const byLabel = (l) => rows.find(([, r]) => r.effect_label === l)?.[1];
      for (const l of plan.steps.split(",")) if (!byLabel(l)) throw new Error(`${item.name}: no row "${l}"`);
      // the chain root (reused on a re-run)
      let rootKey = rows.find(([, r]) => r.effect_label === plan.root)?.[0];
      if (!rootKey) { rootKey = String(Math.max(...Object.keys(table).map(Number).filter(Number.isFinite)) + 1); }
      table[rootKey] = { $deleted: false, effect_kind: "chain", effect_label: plan.root, chain_steps: plan.steps };
      for (const l of plan.blank) byLabel(l).chain_steps = "";
      for (const l of plan.onHit ?? []) byLabel(l).target_ref = "hit_action_targets";
      for (const [l, edits] of Object.entries(plan.rowEdits ?? {})) Object.assign(byLabel(l), edits);
      const before = p.on_activate_effect_ref;
      p.on_activate_effect_ref = plan.root;
      console.log(`${item.name.padEnd(18)} on_activate ${before} -> ${plan.root} (row ${rootKey}: ${plan.steps})`);
      batch.put(key, JSON.stringify(item));
    }
    {
      const key = `!actors.items!${A}.RkDevourManEat01`;
      const item = JSON.parse(await db.get(key));
      const p = item.system.props;
      const rows = Object.values(p.effect_table);
      const feed = rows.find((r) => !r.$deleted && r.effect_label === "dv_feed");
      if (!feed) throw new Error("Devour: no dv_feed row");
      for (const r of rows) if (["dv_bite", "dv_root"].includes(r.effect_label)) r.$deleted = true;
      feed.grant_amount = "floor(HP_DEALT / 2)";
      feed.chain_steps = "";
      Object.assign(p, { damage_bonus: "45", type_damage: "Physical", on_activate_effect_ref: "", post_damage_effect_ref: "dv_feed" });
      console.log(`Devour             primary damage 45 Physical, post_damage dv_feed = floor(HP_DEALT / 2); dv_bite retired`);
      batch.put(key, JSON.stringify(item));
    }
    const ae = JSON.parse(await db.get(CRIPPLED));
    ae.flags ??= {}; ae.flags[NS] = { ...(ae.flags[NS] ?? {}), roundUp: ["defense"] };
    if (!Array.isArray(ae.statuses) || !ae.statuses.length) ae.statuses = ["crippled"];
    console.log(`Crippled: changes ${JSON.stringify(ae.changes)}, flags.${NS}.roundUp = ["defense"], statuses ${JSON.stringify(ae.statuses)}`);
    batch.put(CRIPPLED, JSON.stringify(ae));
    if (DRY) { console.log("dry run: nothing written"); return; }
    await batch.write();
    // read back
    for (const id of Object.keys(PLAN)) {
      const it = JSON.parse(await db.get(`!actors.items!${A}.${id}`));
      const root = Object.values(it.system.props.effect_table).find((r) => r.effect_label === it.system.props.on_activate_effect_ref);
      console.log(`read back ${it.name}: ${root?.effect_kind} [${root?.chain_steps}]`);
    }
    console.log("read back Crippled roundUp:", JSON.stringify(JSON.parse(await db.get(CRIPPLED)).flags[NS].roundUp));
  } finally { await db.close(); }
})().catch((e) => { console.error(e.message); process.exit(1); });
