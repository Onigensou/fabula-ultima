// Execute / Cripple became REAL engine keywords (BD commit 43d5f077): an action
// whose `action_keywords` carries `execute` / `cripple` now gets the ×2 from the
// engine. Every item that already declared the keyword ALSO carried a per-skill
// rider doing the same ×2 by hand, scoped by `reaction_source_skill` — so
// without this migration those items would double twice and deal ×4.
//
// Run from tools/safe-edit; --apply to write. Idempotent: a row already marked
// $deleted is skipped, so a second run reports 0 changes.
//
// What it targets — ALL THREE must hold on the same item, so nothing else is
// touched:
//   1. `action_keywords` contains execute and/or cripple;
//   2. a reaction row on `creature_will_deal_damage` whose condition is exactly
//      the Crisis test the keyword now performs (`TARGET_AE_COUNT_CRISIS > 0`
//      for execute, `== 0` for cripple);
//   3. that row's effect row is `adjust_damage` / multiply / 2 / outgoing.
// Rows are marked `$deleted: true` rather than dropped (BD skips them
// everywhere) so the surviving table keys stay stable.
//
// Deliberately NOT touched: `Beyond the Realms of Death` (Keren / Farian Pasta /
// Necromancer / world master). It reads Crisis too, but declares no keyword and
// carries extra clauses of its own (not-self, non-Undead) — it is a skill rule,
// not the keyword, and must keep its rider.
const { openCollection } = require("../lib/db");
const { run } = require("./_fafnir-util");

const CRISIS_COND = /^TARGET_AE_COUNT_CRISIS\s*(>|==)\s*0$/;

const kwList = (props) => String(props?.action_keywords ?? "")
  .split(/[,\n]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);

run(async ({ changes }) => {
  const db = await openCollection("actors");
  const items = [];
  try {
    for await (const [key, doc] of db.iterator()) {
      if (!key.startsWith("!actors.items!")) continue;
      items.push([key, doc]);
    }
  } finally { await db.close(); }

  let scanned = 0;
  for (const [key, doc] of items) {
    const p = doc?.system?.props;
    if (!p) continue;
    const kws = kwList(p);
    const wantsExecute = kws.includes("execute");
    const wantsCripple = kws.includes("cripple");
    if (!wantsExecute && !wantsCripple) continue;
    scanned++;

    const rc = p.reaction_config_table ?? {};
    const fx = p.effect_table ?? {};
    const retired = [];
    for (const [rowKey, row] of Object.entries(rc)) {
      if (!row || row.$deleted) continue;
      if (String(row.reaction_trigger ?? "") !== "creature_will_deal_damage") continue;
      const cond = String(row.condition_formula ?? "").trim();
      if (!CRISIS_COND.test(cond)) continue;
      // Which keyword does this row duplicate? `> 0` is Execute, `== 0` Cripple.
      const isExecuteRow = cond.includes(">");
      if (isExecuteRow ? !wantsExecute : !wantsCripple) continue;

      const ref = String(row.reaction_effect_ref ?? "").trim();
      const fxEntry = Object.entries(fx).find(([, r]) => r && !r.$deleted
        && String(r.effect_label ?? "").trim() === ref);
      if (!fxEntry) continue;
      const [fxKey, fxRow] = fxEntry;
      const isPlainDouble = String(fxRow.effect_kind) === "adjust_damage"
        && String(fxRow.damage_operation) === "multiply"
        && Number(fxRow.damage_amount) === 2
        && String(fxRow.damage_stage) === "outgoing";
      if (!isPlainDouble) {
        console.log(`  SKIP ${doc.name}: ${ref} is not a plain ×2 (${fxRow.effect_kind}/${fxRow.damage_operation}/${fxRow.damage_amount}) — left alone`);
        continue;
      }
      row.$deleted = true;
      fxRow.$deleted = true;
      retired.push(`${isExecuteRow ? "Execute" : "Cripple"} rc[${rowKey}]+fx[${fxKey}]`);
    }
    if (retired.length) {
      changes.push([key, doc, `${doc.name} — engine keyword takes over: retired ${retired.join(", ")}`]);
    }
  }
  console.log(`\nscanned ${scanned} item(s) declaring execute/cripple`);
}, "execute/cripple: retire per-skill ×2 riders", "actors");
