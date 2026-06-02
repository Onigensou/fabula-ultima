/**
 * Migration: 2026-05-29-sync-spiritist-passive-copies
 * ---------------------------------------------------------------------------
 * Re-syncs BD-tree actor copies of three Spiritist passives (Healing
 * Power, Support Magic, Vismagus) from their masters. Closes the
 * MASTER_COPY drift findings surfaced by the expanded Gap 1 lint.
 *
 * Background: the original canon-refactor migrations earlier in the
 * 2026-05-29 session edited the masters but didn't propagate every
 * change to actor copies. For passives where the actor's copy is meant
 * to be a perfect mirror of master (no per-actor tuning), drift means
 * dispatch silently misses on that actor.
 *
 * Synced fields (from master.system.props → copy):
 *   • isReaction
 *   • reaction_config_table (full replacement — actor copies of these
 *     passives never customize triggers per-actor)
 *   • effect_table
 *   • passive_mode (deduped to blank on master; sync ensures copy matches)
 *
 * Synced effects: any AE on master that the copy lacks (matched by name)
 * is created on the copy with the master's full data shape (changes,
 * tags, statuses, flags). AEs the copy has that master doesn't are left
 * alone — they may be actor-applied buffs the dispatcher armed during
 * play.
 *
 * BD-scoped — only touches actor copies whose master lives inside the
 * `Battle Director` folder tree.
 *
 * IDEMPOTENT: re-runs no-op when copies already match master.
 */

export const key = "2026-05-29-sync-spiritist-passive-copies";
export const description =
  "Re-sync Healing Power / Support Magic / Vismagus actor copies from " +
  "their BD-tree masters (closes Gap 1 drift findings).";

const TARGET_NAMES = ["Healing Power", "Support Magic", "Vismagus"];
const BD_ROOT_NAME = "Battle Director";
const MODULE_ID = "fabula-ultima-companion";

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

function rowsEqual(a, b) {
  // Loose deep-equal; sufficient for canon-table shapes.
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (!a || !b) return false;
  const ak = Object.keys(a), bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) if (!rowsEqual(a[k], b[k])) return false;
  return true;
}

export async function migrate(game, log) {
  const masterIndexByUniqueId = new Map();
  for (const item of game.items?.contents ?? []) {
    const uid = String(item?.system?.uniqueId ?? "").trim();
    if (uid && !masterIndexByUniqueId.has(uid)) masterIndexByUniqueId.set(uid, item);
  }
  // Build master-by-name index for our targets (filter to BD-tree).
  const mastersByName = new Map();
  for (const item of game.items?.contents ?? []) {
    if (!TARGET_NAMES.includes(item.name)) continue;
    if (!isInBattleDirectorTree(item)) continue;
    mastersByName.set(item.name, item);
  }
  if (!mastersByName.size) {
    log(`No BD-tree masters found among ${TARGET_NAMES.join(", ")} — nothing to sync.`);
    return { applied: true, summary: "no masters" };
  }

  let syncedCopies = 0;
  let syncedAEs = 0;
  let propUpdates = 0;
  for (const actor of game.actors?.contents ?? []) {
    for (const copy of actor.items?.contents ?? []) {
      if (!TARGET_NAMES.includes(copy.name)) continue;
      if (!actorCopyIsBattleDirector(copy, masterIndexByUniqueId)) continue;
      const master = mastersByName.get(copy.name);
      if (!master) continue;
      if (master.id === copy.id) continue;
      const masterProps = master.system?.props ?? {};
      const copyProps   = copy.system?.props ?? {};

      const updates = {};
      if (masterProps.isReaction !== copyProps.isReaction) {
        updates["system.props.isReaction"] = masterProps.isReaction;
      }
      if (!rowsEqual(masterProps.reaction_config_table ?? {}, copyProps.reaction_config_table ?? {})) {
        updates["system.props.reaction_config_table"] = foundry.utils.deepClone(masterProps.reaction_config_table ?? {});
      }
      if (!rowsEqual(masterProps.effect_table ?? {}, copyProps.effect_table ?? {})) {
        updates["system.props.effect_table"] = foundry.utils.deepClone(masterProps.effect_table ?? {});
      }
      if (String(masterProps.passive_mode ?? "") !== String(copyProps.passive_mode ?? "")) {
        updates["system.props.passive_mode"] = masterProps.passive_mode ?? "";
      }
      if (Object.keys(updates).length) {
        try {
          await copy.update(updates);
          propUpdates += Object.keys(updates).length;
          log(`  actor "${actor.name}" / "${copy.name}": synced ${Object.keys(updates).length} prop(s)`);
        } catch (e) {
          log(`  actor "${actor.name}" / "${copy.name}": update failed: ${e?.message ?? e}`);
          continue;
        }
      }

      // AE sync: copy missing AEs from master by name.
      const masterAEs = master.effects?.contents ?? [];
      const copyAEsByName = new Map();
      for (const ae of (copy.effects?.contents ?? [])) copyAEsByName.set(ae.name, ae);
      const aeCreates = [];
      for (const mAE of masterAEs) {
        if (copyAEsByName.has(mAE.name)) continue;
        const data = mAE.toObject(false);
        delete data._id;
        aeCreates.push(data);
      }
      if (aeCreates.length) {
        try {
          await copy.createEmbeddedDocuments("ActiveEffect", aeCreates);
          syncedAEs += aeCreates.length;
          log(`  actor "${actor.name}" / "${copy.name}": created ${aeCreates.length} missing AE(s): ${aeCreates.map((a) => a.name).join(", ")}`);
        } catch (e) {
          log(`  actor "${actor.name}" / "${copy.name}": AE create failed: ${e?.message ?? e}`);
        }
      }

      if (Object.keys(updates).length || aeCreates.length) syncedCopies += 1;
    }
  }
  return {
    applied: true,
    summary: `synced ${syncedCopies} copy/copies (${propUpdates} prop updates, ${syncedAEs} AE creates)`,
  };
}
