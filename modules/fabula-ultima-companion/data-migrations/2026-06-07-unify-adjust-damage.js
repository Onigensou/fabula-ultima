/**
 * Migration: 2026-06-07-unify-adjust-damage
 * ---------------------------------------------------------------------------
 * Clean-slate refactor: the two divergent damage-adjustment effect_kinds —
 * `add_damage` (sender-side / outgoing) and `modify_damage_taken`
 * (receiver-side / incoming) — are unified into ONE `adjust_damage` kind:
 *
 *   { effect_kind: "adjust_damage",
 *     damage_operation: add|subtract|multiply|set|cap|floor,
 *     damage_amount: <formula>,
 *     damage_stage: "outgoing" | "incoming" }
 *
 * Conversions:
 *   add_damage{damage_amount}              -> adjust_damage(outgoing, add, amount)
 *   modify_damage_taken(set_hp_floor, V)   -> adjust_damage(incoming, cap, "CUR_HP - V")
 *     (Mercy: cap incoming damage so HP can't drop below V — only binds on a
 *      lethal hit, matching the old set_hp_floor semantics.)
 *
 * Sweeps EVERY effect_table on:
 *   - world Item system.props.effect_table
 *   - world Item embedded AEs' flags.<ns>.reactionConfig.effect_table
 *   - actor Item system.props.effect_table (copies)
 *   - actor Item embedded AEs' reactionConfig.effect_table
 *   - actor-direct AEs' reactionConfig.effect_table   (Mercy lives here)
 *
 * IDEMPOTENT: rows already `adjust_damage` are skipped.
 */

export const key = "2026-06-07-unify-adjust-damage";
export const description =
  "Unify add_damage + modify_damage_taken into a single adjust_damage effect_kind " +
  "(operation + stage), converting all existing rows.";

const NS = "fabula-ultima-companion";

function convertRow(row) {
  const kind = String(row?.effect_kind ?? "").toLowerCase();
  if (kind === "add_damage") {
    return {
      ...row,
      effect_kind: "adjust_damage",
      damage_operation: "add",
      damage_stage: "outgoing",
      damage_amount: String(row.damage_amount ?? "0"),
    };
  }
  if (kind === "modify_damage_taken") {
    const v = Number(row.modify_value ?? 1) || 1;
    const { modify_mode, modify_value, ...rest } = row;
    return {
      ...rest,
      effect_kind: "adjust_damage",
      damage_stage: "incoming",
      damage_operation: "cap",
      damage_amount: `CUR_HP - ${v}`,
    };
  }
  return null;
}

// Convert a table object in place; returns a NEW table if anything changed, else null.
function convertTable(table) {
  if (!table || typeof table !== "object") return null;
  let changed = false;
  const out = {};
  for (const [k, row] of Object.entries(table)) {
    const conv = convertRow(row);
    if (conv) { out[k] = conv; changed = true; }
    else out[k] = row;
  }
  return changed ? out : null;
}

async function convertItemProps(item, log, label) {
  const newTable = convertTable(item.system?.props?.effect_table);
  if (!newTable) return 0;
  // delete-then-set so removed fields (modify_mode/value) don't linger via merge.
  await item.update({ "system.props.-=effect_table": null });
  await item.update({ "system.props.effect_table": newTable });
  log(`  ${label} ${item.name}: effect_table props converted`);
  return 1;
}

async function convertAEReactionConfig(ae, log, label) {
  const cfg = ae.flags?.[NS]?.reactionConfig;
  if (!cfg || typeof cfg !== "object") return 0;
  let touched = false;
  const next = { ...cfg };
  for (const field of ["effect_table", "reaction_effect_table"]) {
    const nt = convertTable(cfg[field]);
    if (nt) { next[field] = nt; touched = true; }
  }
  if (!touched) return 0;
  await ae.setFlag(NS, "reactionConfig", next); // setFlag replaces the whole blob
  log(`  ${label} AE "${ae.name}": reactionConfig effect_table converted`);
  return 1;
}

export async function migrate(game, log = () => {}) {
  let items = 0, aes = 0;

  const sweepItem = async (item, label) => {
    items += await convertItemProps(item, log, label);
    for (const ae of item.effects?.contents ?? []) aes += await convertAEReactionConfig(ae, log, label);
  };

  for (const item of game.items?.contents ?? []) await sweepItem(item, "[world]");

  for (const actor of game.actors?.contents ?? []) {
    for (const ae of actor.effects?.contents ?? []) aes += await convertAEReactionConfig(ae, log, `[${actor.name}]`);
    for (const item of actor.items?.contents ?? []) await sweepItem(item, `[${actor.name}]`);
  }

  return { applied: true, summary: `adjust_damage unify: ${items} item table(s) + ${aes} AE reactionConfig(s) converted` };
}
