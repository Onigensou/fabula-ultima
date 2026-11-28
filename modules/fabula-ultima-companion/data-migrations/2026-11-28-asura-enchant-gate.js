/**
 * Migration: 2026-11-28-asura-enchant-gate  (Asura keeps Air vs an all-flyer party)
 * ---------------------------------------------------------------------------
 * Follow-up to 2026-11-28-asura-update (already applied on the real world). That one
 * added the flyer hunt (Sword Enchant - Air at priority 9 when every enemy flies), but
 * his Fire / Bolt / Ice Enchants then replaced the Air Aspect again, so he cycled
 * Enchant X → Air → Enchant Y → Air. User call 2026-11-28: switch the other Enchants
 * off while only flyers remain.
 *
 * Change: the Fire / Bolt / Ice Enchant pattern rows ("self lacks <X> Mark") become
 * formula rows that also need a grounded enemy:
 *     AE_COUNT_<X>_MARK == 0 && ENEMY_COUNT_GROUNDED > 0
 * The Air Enchant rows are untouched. A row someone hand-edited to another condition
 * is left alone. Idempotent.
 */

export const key = "2026-11-28-asura-enchant-gate";
export const description = "Asura: Fire/Bolt/Ice Enchants need a grounded enemy, so he keeps the Air Aspect when only flyers remain.";

const ASURA = "0AwQ7wEDz4ISA9mA";
const GATED = ["Fire", "Bolt", "Ice"];
export const enchantGateFormula = (el) => `AE_COUNT_${el.toUpperCase()}_MARK == 0 && ENEMY_COUNT_GROUNDED > 0`;

/** Pattern-table patch gating the Fire/Bolt/Ice Enchant rows on a grounded enemy. */
export function enchantGatePatch(table = {}) {
  const patch = {};
  for (const [k, r] of Object.entries(table)) {
    if (!r || r.$deleted) continue;
    const el = GATED.find((e) => r.action_pattern_name === `Sword Enchant - ${e}`);
    if (!el) continue;
    const formula = enchantGateFormula(el);
    if (r.action_pattern_condition === "formula" && r.action_pattern_string === formula) continue;
    if (r.action_pattern_condition !== "self_lacks_status") continue;
    patch[`system.props.action_pattern_table.${k}.action_pattern_condition`] = "formula";
    patch[`system.props.action_pattern_table.${k}.action_pattern_string`] = formula;
  }
  return patch;
}

export async function migrate(game, log = () => {}) {
  const actor = game.actors.get(ASURA);
  if (!actor) return { applied: false, summary: "Asura actor not found" };
  const patch = enchantGatePatch(actor.system?.props?.action_pattern_table ?? {});
  const n = Object.keys(patch).length / 2;
  if (!n) { log("= Fire/Bolt/Ice Enchant rows already gated"); return { applied: true, summary: "already gated" }; }
  await actor.update(patch);
  const summary = `~ ${n} Enchant rows -> formula (needs a grounded enemy)`;
  log(summary);
  return { applied: true, summary };
}
