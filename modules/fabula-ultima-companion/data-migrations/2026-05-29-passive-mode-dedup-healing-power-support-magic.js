/**
 * Migration: 2026-05-29-passive-mode-dedup-healing-power-support-magic
 * ---------------------------------------------------------------------------
 * Blanks `system.props.passive_mode` on Healing Power and Support Magic
 * masters + actor-borne copies. Both skills hold their mode canonically in
 * `system.props.reaction_config_table[0].reaction_passive_mode`. The
 * top-level field is a CSB-template default and a duplicate source of
 * truth — passive-manager.js reads the reaction-row first and only
 * falls back to `props.passive_mode` when no passive row exists. Clearing
 * it stops the lint's `DEPRECATED_PROPS_PASSIVE_MODE` warning and the
 * sheet field stops contradicting the Reactions panel.
 *
 * Scope intentionally narrow — Vismagus, Mercy, Absorb MP, Adversity all
 * also carry `passive_mode` but they still depend on it as their
 * authoritative source (no reaction_config_table row yet). They get
 * deduped in a subsequent migration after each is converted to a
 * canonical reaction row.
 *
 * IDEMPOTENT: re-runs no-op when the field is already blank.
 */

export const key = "2026-05-29-passive-mode-dedup-healing-power-support-magic";
export const description =
  "Clear redundant system.props.passive_mode on Healing Power + Support " +
  "Magic master items and actor copies; the canonical mode lives on " +
  "reaction_config_table[0].reaction_passive_mode.";

const TARGET_NAMES = ["Healing Power", "Support Magic"];
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

function hasCanonicalPassiveRow(item) {
  const rc = item?.system?.props?.reaction_config_table;
  if (!rc || typeof rc !== "object") return false;
  for (const k of Object.keys(rc)) {
    const row = rc[k];
    if (row && !row.$deleted && row.reaction_isPassive === true) return true;
  }
  return false;
}

export async function migrate(game, log) {
  let cleared = 0;
  let skipped = 0;

  async function maybeClear(item, ownerLabel) {
    const cur = String(item?.system?.props?.passive_mode ?? "").trim();
    if (!cur) return;                                        // already blank
    if (!hasCanonicalPassiveRow(item)) {
      // No reaction-row to fall through to — leave alone so behavior
      // doesn't break.
      log(`  ${ownerLabel} / "${item.name}": no canonical reaction row; skipped`);
      skipped += 1;
      return;
    }
    try {
      await item.update({ "system.props.passive_mode": "" });
      cleared += 1;
      log(`  ${ownerLabel} / "${item.name}": cleared passive_mode (was "${cur}")`);
    } catch (e) {
      log(`  ${ownerLabel} / "${item.name}": clear failed: ${e?.message ?? e}`);
    }
  }

  // Build uniqueId → master index for actor-copy folder lookup.
  const masterIndexByUniqueId = new Map();
  for (const item of game.items?.contents ?? []) {
    const uid = String(item?.system?.uniqueId ?? "").trim();
    if (uid && !masterIndexByUniqueId.has(uid)) masterIndexByUniqueId.set(uid, item);
  }

  // World master items (BD only)
  for (const item of game.items?.contents ?? []) {
    if (!TARGET_NAMES.includes(item.name)) continue;
    if (!isInBattleDirectorTree(item)) {
      log(`  world / "${item.name}": skipped (not in Battle Director folder)`);
      continue;
    }
    await maybeClear(item, "world");
  }
  // Actor-embedded copies (linked to BD masters only)
  for (const actor of game.actors?.contents ?? []) {
    for (const item of actor.items?.contents ?? []) {
      if (!TARGET_NAMES.includes(item.name)) continue;
      if (!actorCopyIsBattleDirector(item, masterIndexByUniqueId)) {
        log(`  actor "${actor.name}" / "${item.name}": skipped (master not in BD tree)`);
        continue;
      }
      await maybeClear(item, `actor "${actor.name}"`);
    }
  }

  return {
    applied: true,
    summary: `cleared ${cleared} item(s); skipped ${skipped} without canonical row`,
  };
}
