/**
 * Migration: 2026-05-17-drain-spirit-clear-custom-logic
 * ---------------------------------------------------------------------------
 * Removes the user-authored `custom_logic_resolution` script from
 * Drain Spirit (world master + every actor-embedded copy), now that the
 * Phase D declarative path (`post_damage_effect_ref: "drain_recover"` +
 * `effect_table.drain_recover` with `grant_amount: "ceil(MP_DEALT / 2)"`) is in
 * place. Both running together would double-restore MP on a successful
 * Drain Spirit cast.
 *
 * MATCHING POLICY: by item name "Drain Spirit". Only clears the field; does
 * not touch any other custom-logic field (Action, Passive). Idempotent.
 *
 * Why clear rather than keep both: the user's standing direction is "no
 * per-skill custom logic for system gaps" (see [[no-per-skill-custom-logic]]).
 * The drain mechanic is now expressible declaratively, so the script is
 * obsolete.
 */

export const key = "2026-05-17-drain-spirit-clear-custom-logic";
export const description =
  "Clear Drain Spirit's custom_logic_resolution — Phase D declarative " +
  "post_damage_effect_ref now handles the MP restore.";

const ITEM_NAME = "Drain Spirit";
const FIELD = "custom_logic_resolution";

async function clearOnItem(item, label, log) {
  const current = item.system?.props?.[FIELD] ?? "";
  if (!current || (typeof current === "string" && current.trim() === "")) {
    log(`${label}: ${FIELD} already empty`);
    return false;
  }
  await item.update({ [`system.props.${FIELD}`]: "" });
  log(`${label}: cleared ${FIELD} (was ${String(current).length} chars)`);
  return true;
}

export async function migrate(game, log) {
  let mastersCleared = 0;
  let copiesCleared = 0;

  for (const item of game.items?.contents ?? []) {
    if (item.name !== ITEM_NAME) continue;
    if (await clearOnItem(item, `world master "${item.name}" [${item.id}]`, log)) {
      mastersCleared++;
    }
  }
  for (const actor of game.actors?.contents ?? []) {
    for (const item of actor.items?.contents ?? []) {
      if (item.name !== ITEM_NAME) continue;
      if (await clearOnItem(item, `actor "${actor.name}" item "${item.name}" [${item.id}]`, log)) {
        copiesCleared++;
      }
    }
  }

  return {
    applied: true,
    summary: `${mastersCleared} master${mastersCleared === 1 ? "" : "s"} + ${copiesCleared} copies cleared`
  };
}
