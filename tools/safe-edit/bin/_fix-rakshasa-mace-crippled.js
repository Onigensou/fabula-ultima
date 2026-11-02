// 2026-11-03 — Rakshasa's Mace carries its "Crippled" AE (RkAeCrippledDef1) as a stored key,
// but the Mace item never LISTED it in its `effects`, so Foundry never loaded it (verified
// against the server's connect payload). _build-rakshasa.js wrote the child key without the
// parent's id list. This adds the id to the list. Game must be CLOSED. Backs up the store first.
// Review (skill-reviewer, same day) found, now that Crippled goes live:
//   - the apply row targeted `action_targets`, so a MISS still crippled -> `hit_action_targets`
//   - its tags (`cleansable`, `rakshasa_debuff`) are read by nothing; every cleanse looks for
//     `debuff` -> added
//   - priority 20 tied with Barrier / Supercharge on `defense`, so "halved" depended on the
//     order the AEs were applied -> 50, after every other DEF change
//   node tools/safe-edit/bin/_fix-rakshasa-mace-crippled.js [--dry]
const path = require("path");
const fs = require("fs");
const { ClassicLevel } = require(path.join(__dirname, "..", "node_modules", "classic-level"));
const DIR = path.join(__dirname, "..", "..", "..", "worlds", "fabula-ultima-2", "data", "actors");
const KEY = "!actors.items!Rk5haXsaDemonAAA.RkCrippleFlail01";
const AE = "RkAeCrippledDef1";
(async () => {
  if (fs.existsSync(path.join(DIR, "LOCK"))) {
    try { fs.renameSync(path.join(DIR, "LOCK"), path.join(DIR, "LOCK")); } catch { throw new Error("actors store is locked: close Foundry first"); }
  }
  const dry = process.argv.includes("--dry");
  if (!dry) {
    const bk = path.join(__dirname, "..", "backups", `${new Date().toISOString().replace(/[:.]/g, "-")}-fabula-ultima-2-actors-rakshasa-mace-crippled`);
    fs.cpSync(DIR, bk, { recursive: true, filter: (p) => !/[\/]LOCK$/.test(p) });
    console.log("backup:", bk);
  }
  const db = new ClassicLevel(DIR, { keyEncoding: "utf8", valueEncoding: "utf8" });
  await db.open({ createIfMissing: false });
  try {
    const item = JSON.parse(await db.get(KEY));
    await db.get(`!actors.items.effects!Rk5haXsaDemonAAA.RkCrippleFlail01.${AE}`);   // throws if the AE key is gone
    const AEKEY = `!actors.items.effects!Rk5haXsaDemonAAA.RkCrippleFlail01.${AE}`;
    const ae = JSON.parse(await db.get(AEKEY));
    console.log(`${item.name}: effects ${JSON.stringify(item.effects)}`);
    if (!item.effects.includes(AE)) item.effects = [...item.effects, AE];
    const row = item.system?.props?.effect_table?.["1"];
    if (!row || row.effect_label !== "cr_debuff") throw new Error("Mace effect_table row 1 is not cr_debuff");
    row.target_ref = "hit_action_targets";
    ae.system ??= {}; ae.system.tags = [...new Set([...(ae.system.tags ?? []), "debuff"])];
    for (const c of ae.changes ?? []) if (c.key === "defense") c.priority = 50;
    if (dry) { console.log("dry: would write", JSON.stringify({ effects: item.effects, target_ref: row.target_ref, tags: ae.system.tags, changes: ae.changes })); return; }
    await db.batch().put(KEY, JSON.stringify(item)).put(AEKEY, JSON.stringify(ae)).write();
    const back = JSON.parse(await db.get(KEY)), aeBack = JSON.parse(await db.get(AEKEY));
    console.log("written; read back", JSON.stringify({ effects: back.effects, target_ref: back.system.props.effect_table["1"].target_ref, tags: aeBack.system.tags, changes: aeBack.changes }));
  } finally { await db.close(); }
})().catch((e) => { console.error(e.message); process.exit(1); });
