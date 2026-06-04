/**
 * Migration: 2026-06-04-defensive-mastery-hide-token-icon
 * ---------------------------------------------------------------------------
 * Defensive Mastery is a true bearer-resident always-on passive (active
 * while the bearer has a shield or martial armor equipped). Per
 * [[always-active-passive-no-token-icon]]: always-on passives drop
 * `statuses[]` to leave the token-icon ring uncluttered. The icon ring
 * is reserved for transient/situational state (Crisis, charges in
 * cooldown, applied buffs/debuffs), not constant background bonuses.
 *
 * Today's Defensive Mastery AE carries `statuses: ["fud-defensive-mastery"]`.
 * Strip it on both the BD-tree master and every actor copy linked to it.
 *
 * Scope: ALL Defensive Mastery items (master + every actor copy) —
 * intentionally broader than the canonical BD-only scoping. The "no
 * token icon for always-on passive" rule is universal; whether the
 * copy links to the BD master or the legacy master, the visual rule is
 * the same. The migration is purely subtractive (removes statuses
 * array entries; adds nothing), so it's safe to apply broadly.
 *
 * IDEMPOTENT.
 */

export const key = "2026-06-04-defensive-mastery-hide-token-icon";
export const description =
  "Strip Defensive Mastery AE statuses (drop the fud-defensive-mastery " +
  "token icon — true bearer-resident passive shouldn't clutter the ring).";

async function stripStatuses(item, ownerLabel, log) {
  let touched = false;
  for (const ae of item.effects?.contents ?? []) {
    if (ae.name !== "Defensive Mastery") continue;
    const current = Array.from(ae.statuses ?? []);
    if (current.length === 0) continue;
    await ae.update({ statuses: [] });
    log(`  ${ownerLabel} "${item.name}" / AE "${ae.name}": stripped statuses [${current.join(", ")}]`);
    touched = true;
  }
  return touched;
}

export async function migrate(game, log) {
  let touched = 0;

  // World items — strip statuses on every Defensive Mastery (BD master,
  // legacy master, any other copies sitting at world level).
  for (const item of game.items?.contents ?? []) {
    if (item.name !== "Defensive Mastery") continue;
    if (await stripStatuses(item, "world", log)) touched += 1;
  }

  // Actor copies — strip statuses on every Defensive Mastery copy
  // regardless of which master it links to. CSB doesn't auto-sync this
  // field from master to copies, so we touch each copy directly.
  for (const actor of game.actors?.contents ?? []) {
    for (const item of actor.items?.contents ?? []) {
      if (item.name !== "Defensive Mastery") continue;
      if (await stripStatuses(item, `actor "${actor.name}"`, log)) touched += 1;
    }
  }

  return {
    applied: true,
    summary: `Defensive Mastery AE statuses stripped on ${touched} item(s)`,
  };
}
