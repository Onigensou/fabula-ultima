/**
 * Migration: 2026-06-09-grappled-status-author
 * ---------------------------------------------------------------------------
 * Grappled status template setup (the AE named "Grappled", which lives on the
 * shared "Debuff" status-hub Item). Ensures it is a single-charge presence
 * status: `charges: 1`, `chargesMax: 1`.
 *
 * WHY: a creature is either Grappled or not — the status should never stack
 * past one. It already carried `charges: 1` but `chargesMax: null` (unbounded),
 * so a second application could push the count above 1. Capping the max keeps
 * the presence semantics that TARGET_AE_COUNT_GRAPPLED / TARGET_AE_CHARGES_
 * GRAPPLED and the Grappled mechanics rely on. Part of the Grappled Advanced
 * Debuff feature — see [[project_grappled_advanced_debuff]].
 *
 * Matches the AE by NAME ("Grappled") across all world Items so it self-heals
 * on a co-dev's world regardless of their Debuff-hub Item UUID. IDEMPOTENT:
 * re-runs as a no-op once charges/chargesMax are 1. Tagged "idempotent": true.
 */

export const key = "2026-06-09-grappled-status-author";
export const description =
  "Cap the Grappled status AE at 1 charge (charges:1, chargesMax:1) on the " +
  "shared Debuff status hub.";

const NS = "fabula-ultima-companion";

export async function migrate(game, log = () => {}) {
  let updated = 0;
  for (const item of game.items?.contents ?? []) {
    for (const ae of (item.effects?.contents ?? [])) {
      if (String(ae?.name ?? "").trim().toLowerCase() !== "grappled") continue;
      const f = ae.flags?.[NS] ?? {};
      const wantCharges = 1, wantMax = 1;
      if (f.charges === wantCharges && f.chargesMax === wantMax) {
        log(`  "${item.name}"/Grappled: already charges:1/chargesMax:1`);
        continue;
      }
      await ae.update({ [`flags.${NS}.charges`]: wantCharges, [`flags.${NS}.chargesMax`]: wantMax });
      updated++;
      log(`  "${item.name}"/Grappled: set charges:1, chargesMax:1 (was charges:${f.charges ?? "∅"}, chargesMax:${f.chargesMax ?? "∅"})`);
    }
  }
  return { applied: true, summary: `Grappled status charge cap ensured (AEs updated: ${updated})` };
}
