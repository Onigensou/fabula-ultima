/**
 * Migration: 2026-06-05-bd-skills-restore
 * ---------------------------------------------------------------------------
 * Create-if-missing every Battle Director master Item from a committed JSON
 * snapshot (`_bd-skills-snapshot.json`), so a world that LOST its skill data
 * — e.g. a co-dev who reverted their world after a bad world-data share —
 * gets every skill back automatically on the next boot, with NO console steps.
 *
 * Why a snapshot instead of re-running the authors: the individual skill
 * authors are already recorded in such a world's `appliedMigrations` ledger
 * (they ran successfully before the revert), so the runner skips them. And
 * many BD masters (Guardian core, Rogue, Matador, etc.) were authored via the
 * CreateSkillFromSpec macro and never had a create-migration at all. This
 * migration has a BRAND-NEW key, so it runs once on any world that hasn't seen
 * it — recreating only what's missing and no-opping where the skills exist.
 *
 * The snapshot captures each master's FINAL, fully-wired state (props +
 * reaction_config_table + embedded AEs) post-everything, so a recreated master
 * lands complete in one shot — it does not depend on the patch migrations
 * re-running. Folder paths are stored by NAME and re-resolved (create-on-demand)
 * via `_folder-tree.js`, so it works regardless of folder ids.
 *
 * Placed LAST in the manifest: on a fresh world the normal authors + patches
 * run first and create their masters; this then create-if-misses only the
 * remainder. IDEMPOTENT — re-runs create nothing where the master exists
 * (matched by name + folder).
 *
 * Regenerate the snapshot after authoring/editing BD skills:
 *   tools/fvtt-playwright/scripts/export-bd-skills.mjs
 */

import { ensureFolderPath } from "./_folder-tree.js";

export const key = "2026-06-05-bd-skills-restore";
export const description =
  "Create-if-missing every Battle Director master from the committed snapshot " +
  "so a world that lost its skill data restores them on boot (no console).";

const MODULE_ID = "fabula-ultima-companion";
const SNAPSHOT_PATH = `modules/${MODULE_ID}/data-migrations/_bd-skills-snapshot.json`;

async function fetchSnapshot(log) {
  try {
    const res = await fetch(`/${SNAPSHOT_PATH}?t=${Date.now()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    log(`snapshot fetch failed: ${e?.message ?? e}`);
    return null;
  }
}

function findInFolder(game, folderId, name) {
  return game.items?.contents?.find(
    (i) => i.name === name && (i.folder?.id ?? i.folder ?? null) === folderId
  ) ?? null;
}

export async function migrate(game, log) {
  // RETIRED (2026-07-06): the Battle Director masters have been MOVED into the
  // legacy "💥 Skill / Class Skill" library and the BD tree deleted (single
  // source of truth). This restore recreated masters BY BD FOLDER PATH from the
  // snapshot — after the move its existence check ("is this in Battle Director /
  // <Class> / Skill?") can no longer see them, so it would recreate DUPLICATES
  // in a freshly rebuilt BD tree. Neutralized to a no-op. Co-dev worlds now get
  // this content by pulling world data (per the world-data sharing policy), not
  // by this migration. Kept in the manifest so its key stays recorded.
  log("BD skills restore retired — no-op (masters consolidated into 💥 Skill / Class Skill; content ships via world-data push)");
  return { applied: true, summary: "retired — no BD-master restore (tree consolidated into 💥 Skill)" };
  /* eslint-disable no-unreachable */
  const snap = await fetchSnapshot(log);
  if (!Array.isArray(snap)) {
    return { applied: false, summary: "snapshot unavailable — will retry next boot" };
  }

  let created = 0;
  let existed = 0;
  let failed = 0;

  for (const entry of snap) {
    try {
      const { folder } = await ensureFolderPath(game, entry.folderPath, { log });
      if (!folder) { log(`  ${entry.name}: folder path unresolved — skipping`); failed += 1; continue; }

      if (findInFolder(game, folder.id, entry.name)) { existed += 1; continue; }

      // Sync the CSB template version stamp to the live template
      // (per [[csb-template-version-sync]]); fall back to the snapshot value.
      const tpl = game.items.get(entry.system?.template);
      const version =
        tpl?.system?.templateSystemUniqueVersion ??
        entry.system?.templateSystemUniqueVersion;

      const data = {
        name: entry.name,
        type: entry.type,
        img: entry.img,
        folder: folder.id,
        system: {
          ...entry.system,
          ...(version !== undefined ? { templateSystemUniqueVersion: version } : {}),
        },
        flags: entry.flags ?? {},
        effects: entry.effects ?? [],
      };
      await Item.create(data);
      created += 1;
      log(`  created "${entry.folderPath.join(" / ")} / ${entry.name}"`);
    } catch (e) {
      failed += 1;
      log(`  ${entry.name}: create failed — ${e?.message ?? e}`);
    }
  }

  return {
    applied: true,
    summary: `BD skills restore: ${created} created, ${existed} present, ${failed} failed (of ${snap.length})`,
  };
}
