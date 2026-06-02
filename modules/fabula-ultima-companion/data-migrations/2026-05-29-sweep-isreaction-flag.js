/**
 * Migration: 2026-05-29-sweep-isreaction-flag
 * ---------------------------------------------------------------------------
 * Sweeps every BATTLE DIRECTOR item (world masters in the `Battle Director`
 * folder tree + actor copies linked to a BD master) for the pattern
 *
 *     reaction_config_table has at least one populated row,
 *     AND/OR an embedded AE carries flags.fabula-ultima-companion.reactionConfig,
 *     AND props.isReaction is NOT true
 *
 * and sets `props.isReaction = true` on the offending item. This is the
 * REACTION_FLAG_MISSING violation introduced as a lint rule in
 * 2026-05-29 — items with reaction data but no flag silently disable
 * every other structural lint rule on themselves.
 *
 * **Scoped to BD only.** Legacy class-skill items (Entropist's Acceleration
 * et al.) live under the parallel `💥 Skill / Class Skill / <Class>` tree
 * and use the legacy reaction infrastructure; touching their isReaction
 * flag could break the legacy panel's authoring path. The migration
 * skips anything not rooted at `Battle Director`.
 *
 * Why the drift happens for BD items:
 *   - CSB doesn't propagate isReaction from the master item to actor
 *     copies (only specific props sync; see
 *     [[master-update-doesnt-sync-actor-copies]]). So even when the
 *     master has the flag, fresh copies stamped onto actors carry the
 *     template default.
 *   - Some BD skills were authored before the flag became canon, with
 *     reactionConfig living on an embedded AE rather than rows on the
 *     item itself.
 *
 * IDEMPOTENT: re-runs no-op when the flag is already correctly set on
 * every BD item.
 */

export const key = "2026-05-29-sweep-isreaction-flag";
export const description =
  "Sweep every Battle Director item with reaction_config_table rows or " +
  "AE-bound reactionConfig; set props.isReaction = true if missing. " +
  "Legacy items outside the BD folder tree are untouched.";

const FLAG_NS = "fabula-ultima-companion";
const BD_ROOT_NAME = "Battle Director";

function isInBattleDirectorTree(item) {
  let f = item?.folder;
  while (f) {
    if (f.name === BD_ROOT_NAME && !(f.folder?.id ?? f.folder)) return true;
    f = f.folder;
  }
  return false;
}

// Look up the master in game.items by `system.uniqueId` and return true
// if that master is rooted at the Battle Director folder. Returns false
// for actor copies whose master can't be found OR isn't a BD item.
function actorCopyIsBattleDirector(item, masterIndexByUniqueId) {
  const uid = String(item?.system?.uniqueId ?? "").trim();
  if (!uid) return false;
  const master = masterIndexByUniqueId.get(uid);
  if (!master) return false;
  return isInBattleDirectorTree(master);
}

function hasMeaningfulRowsInTable(table) {
  if (!table || typeof table !== "object") return false;
  for (const k of Object.keys(table)) {
    const row = table[k];
    if (!row || row.$deleted) continue;
    if (String(row.reaction_trigger ?? "").trim() !== "") return true;
    if (String(row.reaction_effect_ref ?? "").trim() !== "") return true;
  }
  return false;
}

function itemNeedsFlag(item) {
  const props = item?.system?.props ?? {};
  if (props.isReaction === true) return false;

  if (hasMeaningfulRowsInTable(props.reaction_config_table)) return true;

  for (const ae of item.effects?.contents ?? []) {
    const cfg = ae?.flags?.[FLAG_NS]?.reactionConfig;
    if (!cfg) continue;
    if (hasMeaningfulRowsInTable(cfg.reaction_config_table)) return true;
  }
  return false;
}

export async function migrate(game, log) {
  let updated = 0;
  let skipped = 0;
  let nonBd = 0;

  // Build a uniqueId → master lookup so actor copies can be filtered by
  // their master's folder location.
  const masterIndexByUniqueId = new Map();
  for (const item of game.items?.contents ?? []) {
    const uid = String(item?.system?.uniqueId ?? "").trim();
    if (uid && !masterIndexByUniqueId.has(uid)) masterIndexByUniqueId.set(uid, item);
  }

  async function maybeSet(item, ownerLabel, isBD) {
    if (!isBD) { nonBd += 1; return; }
    if (!itemNeedsFlag(item)) { skipped += 1; return; }
    try {
      await item.update({ "system.props.isReaction": true });
      updated += 1;
      log(`  ${ownerLabel} / "${item.name}": set isReaction = true`);
    } catch (e) {
      log(`  ${ownerLabel} / "${item.name}": update failed: ${e?.message ?? e}`);
    }
  }

  for (const item of game.items?.contents ?? []) {
    await maybeSet(item, "world", isInBattleDirectorTree(item));
  }
  for (const actor of game.actors?.contents ?? []) {
    for (const item of actor.items?.contents ?? []) {
      const isBD = actorCopyIsBattleDirector(item, masterIndexByUniqueId);
      await maybeSet(item, `actor "${actor.name}"`, isBD);
    }
  }

  return {
    applied: true,
    summary:
      `set isReaction on ${updated} BD item(s); already-correct BD: ` +
      `${skipped}; non-BD items (skipped): ${nonBd}`,
  };
}
