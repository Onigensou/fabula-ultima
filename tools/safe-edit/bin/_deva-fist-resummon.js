// _deva-fist-resummon — Deva re-summons Missile Fists only when none are left (user pick "A", 2026-11-21).
// Before: every Guard round laid "Fist Ready", and a new pair (summon_max 2) replaced fists still on the field
// before they reached their fuse-2 Detonate turn whenever Deva acted first in that round.
// After: the round_start Guard row splits in two, exactly one fires (same ODD_FRESH gate):
//   OWN_SUMMON_COUNT == 0 -> "guard"    (clears + Guard Round + stance + Fist Ready)  — unchanged chain
//   OWN_SUMMON_COUNT  > 0 -> "guard_nf" (same, without Fist Ready) — she uses another move, the fists live on
// conflict_start is untouched (no fists exist at the start of a fight).
// Game CLOSED. Dry run by default; --apply writes. Idempotent.
const { openCollection } = require("../lib/db");
const APPLY = process.argv.includes("--apply");
const KEY = "!actors.items!amxILxU7mqQ0jKhZ.DvDisciplineP001";
const ODD_FRESH = "(ROUND % 2 == 1 || ROUND == 0) && AE_COUNT_GUARD_ROUND == 0";
(async () => {
  const db = await openCollection("actors");
  try {
    const it = await db.get(KEY);
    if (it.name !== "Celestial Discipline") throw new Error(`${KEY} is ${it.name}`);
    const p = it.system.props;
    const rc = p.reaction_config_table, et = p.effect_table;
    const rows = Object.values(rc);
    if (rows.some((r) => r?.reaction_effect_ref === "guard_nf")) { console.log("skip  already applied"); return; }
    const rs = Object.entries(rc).filter(([, r]) => r?.reaction_trigger === "round_start" && r?.reaction_effect_ref === "guard");
    if (rs.length !== 1 || rs[0][1].condition_formula !== ODD_FRESH) throw new Error(`round_start guard row not as expected: ${JSON.stringify(rs.map(([k, r]) => [k, r.condition_formula]))}`);
    const guard = Object.values(et).find((r) => r?.effect_label === "guard");
    if (guard?.chain_steps !== "g_clear_off,g_clear_st,g_mark,g_stance,g_fist") throw new Error(`guard chain is ${guard?.chain_steps}`);
    const [rsKey, rsRow] = rs[0];
    console.log(`${APPLY ? "write" : "would"} round_start guard (row ${rsKey}) condition += && OWN_SUMMON_COUNT == 0`);
    console.log(`${APPLY ? "write" : "would"} add round_start row -> guard_nf when OWN_SUMMON_COUNT > 0`);
    console.log(`${APPLY ? "write" : "would"} add effect row guard_nf = chain g_clear_off,g_clear_st,g_mark,g_stance`);
    if (!APPLY) return;
    rsRow.condition_formula = `${ODD_FRESH} && OWN_SUMMON_COUNT == 0`;
    const nextRc = String(Math.max(...Object.keys(rc).map(Number)) + 1);
    rc[nextRc] = { ...rsRow, condition_formula: `${ODD_FRESH} && OWN_SUMMON_COUNT > 0`, reaction_effect_ref: "guard_nf" };
    const nextEt = String(Math.max(...Object.keys(et).map(Number)) + 1);
    et[nextEt] = { ...guard, effect_label: "guard_nf", chain_steps: "g_clear_off,g_clear_st,g_mark,g_stance" };
    await db.put(KEY, it);
    const back = (await db.get(KEY)).system.props;
    const ok = Object.values(back.reaction_config_table).filter((r) => r.reaction_trigger === "round_start" && /guard/.test(r.reaction_effect_ref)).length === 2
      && Object.values(back.effect_table).some((r) => r.effect_label === "guard_nf");
    if (!ok) throw new Error("read-back failed");
    console.log("done");
  } finally { await db.close(); }
})().catch((e) => { console.error(e.message); process.exit(1); });
