/**
 * Migration: 2026-11-28-botc-untoll-minion-only
 * ---------------------------------------------------------------------------
 * Birth of the Cruel lifts the Grave Toll (the max HP/MP cost of raising a corpse)
 * when the Minion is destroyed. The reaction row that does it read
 * `SUBJECT_IS_MY_SUMMON == 1`, which is true for ANY summon of the owner: in the
 * 11-28 trio playtest Keren's Numen (Crysta) fell to Asura Strike and the Toll was
 * lifted while Mana Ray (Reanimated) still stood (max HP 62 → 107, MP 72 → 117).
 * User call (11-28): it counts only for the Birth of the Cruel summon.
 *
 * Every Birth of the Cruel copy (world item + actor-owned copies): the
 * creature_defeated row whose effect ref is "botc_untoll" gets
 * `SUBJECT_IS_MY_MINION == 1` in place of `SUBJECT_IS_MY_SUMMON == 1`.
 * Only that row's condition_formula is written; every other row (the summon row's
 * summon_clone_statuses from 2026-11-28-botc-minion-zombie included) is untouched.
 *
 * One-time, idempotent: a row already on SUBJECT_IS_MY_MINION is skipped.
 */

export const key = "2026-11-28-botc-untoll-minion-only";
export const description = "Birth of the Cruel: only the raised Minion's death lifts the Grave Toll (not the Numen or other summons).";

const OLD = /\bSUBJECT_IS_MY_SUMMON\b/;
const NEW = "SUBJECT_IS_MY_MINION";

function untollRows(item) {
  if (!/^birth of the cruel$/i.test(String(item?.name ?? "").trim())) return [];
  const table = item.system?.props?.reaction_config_table;
  if (!table || typeof table !== "object") return [];
  return Object.entries(table).filter(([, r]) => r && typeof r === "object" && !r.$deleted
    && String(r.reaction_effect_ref ?? "").trim() === "botc_untoll"
    && String(r.reaction_trigger ?? "").trim() === "creature_defeated");
}

export async function migrate(game, log = () => {}) {
  const out = [];
  const items = [...(game.items ?? [])];
  for (const a of game.actors ?? []) for (const it of a.items ?? []) items.push(it);
  for (const it of items) {
    for (const [rk, r] of untollRows(it)) {
      const where = `${it.parent ? `${it.parent.name} / ` : ""}${it.name} row ${rk}`;
      const cond = String(r.condition_formula ?? "");
      if (cond.includes(NEW)) { out.push(`${where}: already ${NEW}`); continue; }
      if (!OLD.test(cond)) { out.push(`${where}: unexpected condition "${cond}" — skipped`); continue; }
      const next = cond.replace(OLD, NEW);
      await it.update({ [`system.props.reaction_config_table.${rk}.condition_formula`]: next });
      out.push(`${where}: "${cond}" → "${next}"`);
    }
  }
  if (!out.length) out.push("no Birth of the Cruel untoll rows found");
  for (const l of out) log(l);
  return { applied: true, summary: out.join(" | ") };
}
