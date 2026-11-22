/**
 * Migration: 2026-11-22-warning-shot-mp-drain
 * ---------------------------------------------------------------------------
 * Warning Shot's "each target hit loses SL × 10 Mind Points" option (row
 * `ws_mp`) used on_empty:"skip", which leaves a target with LESS than SL × 10 MP
 * completely untouched. Zarg is SL 4 (40 MP), so a 30-MP monster such as Ampere
 * or Mana Ray lost nothing at all. RAW says the target loses the MP. The
 * engine's on_empty:"drain" takes whatever is left, floored at 0.
 *
 * Every Item named "Warning Shot" (world items + actor-owned copies) whose
 * `ws_mp` row is not already "drain" gets that one field changed. Nothing else
 * on the row or skill is touched. On the 2026-11-22 world: the BD master, Zarg,
 * Yuri, and the "Sharpshooter" test actor (4 copies).
 *
 * Idempotent: a re-run finds every row already on "drain" and writes nothing.
 */
export const key = "2026-11-22-warning-shot-mp-drain";
export const description = "Warning Shot MP option drains what a low-MP target has (on_empty skip → drain), instead of doing nothing below SL × 10 MP.";

const SKILL_NAME = "Warning Shot";
const ROW_LABEL = "ws_mp";

function rowKeyToFix(item) {
  const table = item?.system?.props?.effect_table;
  if (!table || typeof table !== "object") return null;
  for (const [k, row] of Object.entries(table)) {
    if (!row || row.$deleted) continue;
    if (String(row.effect_label ?? "").trim() !== ROW_LABEL) continue;
    return String(row.on_empty ?? "").trim().toLowerCase() === "drain" ? null : k;
  }
  return null;
}

export async function migrate(game, log = () => {}) {
  const done = [];
  let failed = 0;
  const fix = async (item, owner) => {
    const k = rowKeyToFix(item);
    if (k == null) return;
    try {
      await item.update({ [`system.props.effect_table.${k}.on_empty`]: "drain" });
      done.push(owner ? `${owner}/${item.name}` : `${item.name} (world)`);
    } catch (e) {
      failed++;
      log(`warning-shot-mp-drain: update failed on ${owner ?? "world"}/${item.name}: ${e?.message ?? e}`);
    }
  };
  for (const item of game.items?.contents ?? []) {
    if (item.name === SKILL_NAME) await fix(item, null);
  }
  for (const actor of game.actors?.contents ?? []) {
    for (const item of actor.items?.contents ?? []) {
      if (item.name === SKILL_NAME) await fix(item, actor.name);
    }
  }
  return {
    applied: failed === 0,
    summary: `ws_mp on_empty → drain on ${done.length} cop${done.length === 1 ? "y" : "ies"}${done.length ? `: ${done.join(", ")}` : ""}${failed ? `; ${failed} failed` : ""}`,
  };
}
