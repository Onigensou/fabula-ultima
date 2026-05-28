/**
 * Migration: 2026-05-29-mercy-set-isreaction
 * ---------------------------------------------------------------------------
 * Sets `system.props.isReaction = true` on Mercy (master + actor copies).
 *
 * Mercy carries its reactionConfig blob on the EMBEDDED AE (the Mercy AE
 * stamped on a creature acts when that creature would take lethal damage).
 * The CSB sheet's Reactions panel + the reaction-config-lint structural
 * checks both gate on `props.isReaction === true` — without the flag,
 * Mercy is silently exempt from the lint and the GM can't author the
 * reaction row from the sheet. Setting the flag closes the blind spot.
 *
 * IDEMPOTENT: re-runs no-op when the flag is already set.
 */

export const key = "2026-05-29-mercy-set-isreaction";
export const description =
  "Mercy: set system.props.isReaction = true on the master + every actor " +
  "copy so the CSB Reactions panel + reaction-config-lint pick it up.";

const TARGET_NAME = "Mercy";
const BD_ROOT_NAME = "Battle Director";

function isInBattleDirectorTree(item) {
  let f = item?.folder;
  while (f) {
    if (f.name === BD_ROOT_NAME && !(f.folder?.id ?? f.folder)) return true;
    f = f.folder;
  }
  return false;
}

function actorCopyIsBattleDirector(item, masterIndexByUniqueId) {
  const uid = String(item?.system?.uniqueId ?? "").trim();
  if (!uid) return false;
  const master = masterIndexByUniqueId.get(uid);
  if (!master) return false;
  return isInBattleDirectorTree(master);
}

async function maybeSet(item, ownerLabel, log) {
  if (item?.system?.props?.isReaction === true) {
    log(`  ${ownerLabel} / "${item.name}": already isReaction:true`);
    return false;
  }
  try {
    await item.update({ "system.props.isReaction": true });
    log(`  ${ownerLabel} / "${item.name}": set isReaction = true`);
    return true;
  } catch (e) {
    log(`  ${ownerLabel} / "${item.name}": update failed: ${e?.message ?? e}`);
    return false;
  }
}

export async function migrate(game, log) {
  let updated = 0;

  // Build uniqueId → master index for actor-copy folder lookup.
  const masterIndexByUniqueId = new Map();
  for (const item of game.items?.contents ?? []) {
    const uid = String(item?.system?.uniqueId ?? "").trim();
    if (uid && !masterIndexByUniqueId.has(uid)) masterIndexByUniqueId.set(uid, item);
  }

  for (const item of game.items?.contents ?? []) {
    if (item.name !== TARGET_NAME) continue;
    if (!isInBattleDirectorTree(item)) {
      log(`  world / "${item.name}": skipped (not in Battle Director folder)`);
      continue;
    }
    if (await maybeSet(item, "world", log)) updated += 1;
  }
  for (const actor of game.actors?.contents ?? []) {
    for (const item of actor.items?.contents ?? []) {
      if (item.name !== TARGET_NAME) continue;
      if (!actorCopyIsBattleDirector(item, masterIndexByUniqueId)) {
        log(`  actor "${actor.name}" / "${item.name}": skipped (master not in BD tree)`);
        continue;
      }
      if (await maybeSet(item, `actor "${actor.name}"`, log)) updated += 1;
    }
  }
  return {
    applied: true,
    summary: `updated ${updated} BD-rooted Mercy item(s) to isReaction:true`,
  };
}
