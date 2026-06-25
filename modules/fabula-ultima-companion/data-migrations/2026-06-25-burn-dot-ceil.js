/**
 * Migration: 2026-06-25-burn-dot-ceil
 * ---------------------------------------------------------------------------
 * Round the Burn damage-over-time UP: change the Burn AE's burn_dmg formula from
 * "MAX_HP * 0.1" to "ceil(MAX_HP * 0.1)" so a tick is 10% of the afflicted
 * creature's Max HP rounded up (e.g. a 105-HP victim takes 11, not 10). Matches
 * Flame Claw's triggered Burn tick, which already uses ceil(MAX_HP * 0.1).
 *
 * Lives in the Burn AE's carried reactionConfig.effect_table[*].damage_amount
 * (effect_kind "deal_damage", target_ref "self"). Only the Burn AEs that carry
 * the DoT row are touched: the world Debuff hub (the canonical "Burn" every fire
 * skill applies by ae_template_ref) + any embedded copy that has its own DoT row
 * (currently Jack/Burning Arrow). Scoped to deal_damage rows whose formula reads
 * MAX_HP and isn't already wrapped in ceil — drift-safe + idempotent on re-run.
 *
 * NOTE: this is the per-victim FORMULA. It only resolves correctly because of the
 * companion engine fix that stopped apply_ae from baking MAX_HP against the caster
 * (see feedback_apply_ae_formula_bake_max_hp) — without that, Burn would freeze
 * ceil(applier_MAX_HP * 0.1) onto every victim. Already-applied Burns keep their
 * old (possibly baked) value until re-applied.
 *
 * RUN ONCE (NOT manifest-tagged idempotent) so it won't re-apply over a co-dev's
 * later edits; patch logic is still drift-safe if re-run. Burn lives on co-dev
 * world data; sharing is via WORLD-DATA PUSH (feedback_world_data_sharing_hazard).
 */

export const key = "2026-06-25-burn-dot-ceil";
export const description =
  "Burn DoT formula MAX_HP*0.1 → ceil(MAX_HP*0.1) (round the 10% max-HP tick up). " +
  "Patches the Burn AE's burn_dmg deal_damage row on the Debuff hub + embedded copies.";

const NS = "fabula-ultima-companion";

async function patchBurnAe(ae, where, log) {
  const rc = foundry.utils.deepClone(ae.flags?.[NS]?.reactionConfig ?? {});
  const et = rc.effect_table ?? rc.reaction_effect_table;
  if (!et || typeof et !== "object") return 0;
  let changed = false;
  for (const r of Object.values(et)) {
    if (!r || r.effect_kind !== "deal_damage") continue;
    const amt = r.damage_amount;
    if (typeof amt !== "string" || !/MAX_HP/.test(amt) || /ceil/i.test(amt)) continue;
    r.damage_amount = `ceil(${amt.trim()})`;
    changed = true;
  }
  if (!changed) return 0;
  await ae.update({ [`flags.${NS}.-=reactionConfig`]: null });
  await ae.update({ [`flags.${NS}.reactionConfig`]: rc });
  log(`  [${where}] Burn burn_dmg → ceil(...)`);
  return 1;
}

export async function migrate(game, log = () => {}) {
  let changed = 0;
  for (const it of (game.items?.contents ?? []))
    for (const ae of it.effects)
      if (ae.name === "Burn") changed += await patchBurnAe(ae, `world/${it.name}`, log);
  for (const actor of (game.actors?.contents ?? []))
    for (const it of actor.items)
      for (const ae of it.effects)
        if (ae.name === "Burn") changed += await patchBurnAe(ae, `${actor.name}/${it.name}`, log);
  return { applied: true, summary: `Burn DoT → ceil(MAX_HP*0.1): ${changed} AE(s)` };
}
