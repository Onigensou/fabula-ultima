/**
 * Migration: 2026-06-05-bd-skills-restore  — RETIRED (no-op)
 * ---------------------------------------------------------------------------
 * This migration once create-if-missing recreated every Battle Director master
 * Item from a committed JSON snapshot (`_bd-skills-snapshot.json`), so a world
 * that lost its skill data restored it on boot.
 *
 * RETIRED (2026-07-06): the Battle Director masters were consolidated into the
 * "💥 Skill / Class Skill" library and the BD tree deleted (single source of
 * truth). The restore keyed off the old BD folder paths, so after the move it
 * could only recreate DUPLICATES — it was neutralized to a no-op. Co-dev worlds
 * now receive this content by pulling world data (per the world-data sharing
 * policy), not via this migration.
 *
 * The snapshot JSON + its exporter tools (export-bd-skills.mjs / the bridge
 * variant) were REMOVED 2026-07-11 — dead once this restore retired; nothing
 * consumed them, and content ships via world-data push. This file is kept ONLY
 * so its migration key stays recorded in every world's `appliedMigrations`
 * ledger (removing it would make the key look unapplied on already-migrated
 * worlds).
 */

export const key = "2026-06-05-bd-skills-restore";
export const description =
  "RETIRED no-op — BD-master restore superseded by world-data push after the " +
  "skill-folder consolidation.";

export async function migrate(game, log) {
  log(
    "BD skills restore retired — no-op (masters consolidated into 💥 Skill / Class Skill; " +
    "content ships via world-data push)"
  );
  return { applied: true, summary: "retired — no BD-master restore (tree consolidated into 💥 Skill)" };
}
