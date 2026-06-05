/**
 * Migration: 2026-06-06-burn-ae-duration-clear
 * ---------------------------------------------------------------------------
 * First use of the common-AE author helper. Clears Foundry-core duration
 * (rounds/turns/seconds) from the "Burn" status preset AND every already-
 * applied copy.
 *
 * Why: the Battle Director manages Burn's lifetime via
 * `directorAppliedBy.turnsRemaining`. A leftover `duration.rounds = 3` on the
 * preset makes Foundry core expire director-applied Burn mid-turn (e.g. during
 * free-action setup), deleting the AE before the BD's own sweep runs. The
 * apply_ae path already strips duration at apply-time as defence-in-depth; this
 * fixes it at the source + heals copies applied before the fix.
 *
 * This change was previously made co-dev-side as a raw world-data edit, which
 * did not survive into the shared world snapshot — shipping it as a migration
 * makes it durable + applies on every world (incl. co-devs') on boot.
 *
 * IDEMPOTENT (helper skips any AE whose duration is already cleared).
 */

import { authorCommonAe } from "./_common-ae-author.js";

export const key = "2026-06-06-burn-ae-duration-clear";
export const description =
  "Clear Foundry-core duration from the Burn AE preset + every applied copy " +
  "(BD manages Burn lifetime; core duration expires it mid-turn).";

export async function migrate(game, log) {
  const r = await authorCommonAe(
    game,
    { name: "Burn", clearCoreDuration: true, syncCopies: true },
    log
  );
  return {
    applied: true,
    summary:
      `Burn duration cleared — masters:${r.masters} actorCopies:${r.actorCopies} ` +
      `itemCopies:${r.itemCopies} tokenCopies:${r.tokenCopies} skipped:${r.skipped}`,
  };
}
