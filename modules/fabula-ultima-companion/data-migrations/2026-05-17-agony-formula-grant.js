/**
 * Migration: 2026-05-17-agony-formula-grant
 * ---------------------------------------------------------------------------
 * Phase C retrofit: Agony's HP / MP recovery rows go from the literal `"10"`
 * (hardcoded at Hina's SL=5 × 2) to the formula `"SL * 2"`, so the recovery
 * auto-scales with the skill level on any actor.
 *
 * MATCHING POLICY: by item name "Agony", further confirmed by the presence
 * of the canonical effect labels `agony_hp` and `agony_mp` on `grant` rows.
 * UUIDs differ across worlds; matching by shape is forgiving without being
 * loose.
 *
 * IDEMPOTENT: skips when both targeted rows already read `"SL * 2"`.
 *
 * SCOPE: only touches the two grant rows' `grant_amount` field. Leaves the
 * rest of the effect_table / reaction_config_table intact.
 */

export const key = "2026-05-17-agony-formula-grant";
export const description =
  "Retrofit Agony's reaction_effect_table HP/MP grant_amount to the " +
  "SL * 2 formula (Phase C: declarative skill-level scaling).";

const ITEM_NAME = "Agony";
const TARGET_FORMULA = "SL * 2";
const TARGET_LABELS = new Set(["agony_hp", "agony_mp"]);

function readEffectTable(item) {
  const props = item?.system?.props ?? {};
  // Phase D back-compat: prefer effect_table, fall back to legacy.
  return props.effect_table ?? props.reaction_effect_table ?? null;
}

function pickEffectTableKey(item) {
  const props = item?.system?.props ?? {};
  return props.effect_table ? "effect_table" : "reaction_effect_table";
}

export async function migrate(game, log) {
  const actors = game.actors?.contents ?? [];
  if (!actors.length) {
    return { applied: true, summary: "no actors present; nothing to migrate" };
  }

  let updated = 0;
  let already = 0;
  let skipped = 0;

  for (const actor of actors) {
    const items = actor.items?.contents ?? [];
    for (const item of items) {
      if (item.name !== ITEM_NAME) continue;

      const table = readEffectTable(item);
      if (!table || typeof table !== "object") {
        log(`actor "${actor.name}" item "${item.name}" [${item.id}]: no effect_table — skipping`);
        skipped++;
        continue;
      }

      const tableKey = pickEffectTableKey(item);

      // Decide whether anything needs to change.
      const newTable = foundry.utils.duplicate(table);
      let touched = false;
      for (const rowKey of Object.keys(newTable)) {
        const row = newTable[rowKey];
        if (!row || row.$deleted) continue;
        const kind = String(row.effect_kind ?? "").toLowerCase();
        const label = String(row.effect_label ?? "").trim();
        if (kind !== "grant") continue;
        if (!TARGET_LABELS.has(label)) continue;
        if (row.grant_amount === TARGET_FORMULA) continue;
        newTable[rowKey] = { ...row, grant_amount: TARGET_FORMULA };
        touched = true;
      }

      if (!touched) {
        log(`actor "${actor.name}" item "${item.name}" [${item.id}]: already on "${TARGET_FORMULA}"`);
        already++;
        continue;
      }

      await item.update({ [`system.props.${tableKey}`]: newTable });
      log(`actor "${actor.name}" item "${item.name}" [${item.id}]: updated grant_amount → "${TARGET_FORMULA}"`);
      updated++;
    }
  }

  return {
    applied: true,
    summary: `${updated} updated, ${already} already-set, ${skipped} skipped (no effect_table)`
  };
}
