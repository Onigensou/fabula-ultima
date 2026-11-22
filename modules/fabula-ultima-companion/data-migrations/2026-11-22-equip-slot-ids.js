/**
 * Migration: 2026-11-22-equip-slot-ids  (equip slots by ITEM ID, v1.0.660)
 * ---------------------------------------------------------------------------
 * The equip slots used to be NAME strings only, so refining a worn weapon
 * (which renames it "+5 Zarg's Bow" → "+6 Zarg's Bow") cut it loose from every
 * by-name lookup, and the slot's copied stats (weapon1_base_damage, …) never
 * picked up the refine bonus. See scripts/shared/equipped-gear.js.
 *
 * For every world actor whose slot labels resolve to an owned item, this stamps
 *   - flags.fabula-ultima-companion.equipSlots.{main,off,acc1,acc2} = the item id
 *   - the slot's cached props from the item, through the same slotStamp() the
 *     equipment swap and the GM equip sync write with.
 * Slots naming no owned item (NPC bare names) are left untouched.
 *
 * Expected on the 2026-11-22 world (offline dry run): 12 actors stamped; cached
 * stats corrected on 6 — Zarg weapon1_base_damage 21 → 22 and Hina 9 → 13
 * (refine bonuses that never reached the attack), Kiki's Wakizashi DEX+INS →
 * DEX+MIG and off-hand damage 0 → 6 (stale copy; the items read MIG / 6), Varan
 * damage type "" → Physical, plus refreshed slot descriptions. The sheet's
 * armor label is corrected where one worn armor was refined after it was
 * written (Zarg: "+4 Apothecary Robes" → "+5 Apothecary Robes"; label only).
 *
 * Idempotent: the plan is a diff, so a re-run writes nothing.
 */
import { planEquipSync } from "../scripts/shared/equipped-gear.js";

export const key = "2026-11-22-equip-slot-ids";
export const description = "Equip slots by item id: stamp equipSlots ids + re-sync the slots' cached weapon stats from the worn items (refine bonuses that never landed: Zarg +1, Hina +4).";

export async function migrate(game, log = () => {}) {
  let stamped = 0;
  let failed = 0;
  const lines = [];
  for (const actor of game.actors?.contents ?? []) {
    const { update, slots } = planEquipSync(actor);
    if (!slots.length) continue;
    const cacheKeys = Object.keys(update).filter((k) => !k.startsWith("flags."));
    try {
      await actor.update(update, { fuEquipSync: true });
      stamped++;
      const shown = cacheKeys.filter((k) => !k.endsWith("_details"))
        .map((k) => `${k.split(".").pop()}=${JSON.stringify(update[k])}`);
      const line = `${actor.name}: ${slots.join(",")}${shown.length ? ` (${shown.join(", ")})` : ""}`;
      lines.push(line);
      log(line);
    } catch (e) {
      failed++;
      log(`FAILED ${actor.name}: ${e?.message ?? e}`);
    }
  }
  // A failure must retry next boot rather than be ledgered as done.
  if (failed) return { applied: false, summary: `${stamped} stamped, ${failed} failed` };
  return { applied: true, summary: `${stamped} actor(s) stamped. ${lines.join(" | ")}` };
}
