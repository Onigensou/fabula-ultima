/**
 * Migration: 2026-06-06-burn-default-charges-3
 * ---------------------------------------------------------------------------
 * Bumps the COMMON "Burn" status AE's default charge count from 1 → 3.
 *
 * Why a separate migration: 2026-06-06-burn-status-tick already ran on existing
 * worlds (ledgered) and stamped the master at charges:1, so editing that file's
 * default does NOT re-apply. This keyed migration corrects already-migrated
 * worlds; the burn-status-tick default was also updated to 3 so FRESH installs
 * land at 3 directly (this then no-ops there).
 *
 * Semantics: Burn is a charge-governed status (Expiry "After effect activation")
 * that ticks 10% Max HP fire at the bearer's turn start and consumes one charge
 * per tick. "3 by default" = a bare Burn application lasts 3 ticks. Skills that
 * apply Burn with `ae_duplicate_mode: "add_charges"` and no `ae_initial_charges`
 * override now add 3 charges per application (3 → 6 → …), the template default
 * flowing through. IDEMPOTENT.
 *
 * Targets the common Burn living on an `activeEffectContainer` world Item (the
 * "Debuff"/"Active Effects" container) — the master other copies resolve by name
 * via resolveAeTemplate. Does NOT touch per-instance charges on applied copies.
 */

export const key = "2026-06-06-burn-default-charges-3";
export const description =
  "Set the common Burn status AE's default charge count to 3 (was 1).";

const NS = "fabula-ultima-companion";
const DEFAULT_CHARGES = 3;

export async function migrate(game, log) {
  let n = 0;
  for (const it of game.items?.contents ?? []) {
    if (it.type !== "activeEffectContainer") continue;
    for (const ae of it.effects?.contents ?? []) {
      if (ae.name !== "Burn") continue;
      const cur = Number(ae.flags?.[NS]?.charges ?? 0);
      if (cur !== DEFAULT_CHARGES) {
        await ae.update({ [`flags.${NS}.charges`]: DEFAULT_CHARGES });
        log?.(`  common Burn on "${it.name}": charges ${cur} → ${DEFAULT_CHARGES}`);
        n += 1;
      }
    }
  }
  return { applied: true, summary: `Common Burn default charges set to ${DEFAULT_CHARGES} on ${n} master(s).` };
}
