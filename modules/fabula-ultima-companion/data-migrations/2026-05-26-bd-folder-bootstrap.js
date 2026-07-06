/**
 * Migration: 2026-05-26-bd-folder-bootstrap
 * ---------------------------------------------------------------------------
 * Recreate the `Battle Director` Item-folder tree that every skill-author
 * migration (and the CreateSkillFromSpec macro) places masters into.
 *
 * Why this exists: the tree was originally scaffolded by hand via the test
 * bridge on 2026-05-26 and never captured as code. On the original dev's world
 * the folders already exist (this migration is a no-op there). On a FRESH world
 * — e.g. a co-dev who pulls these migrations to receive the Battle Director
 * skills — there was no tree, so the author migrations hard-failed with
 * "scaffold first" and the skills never landed. Codifying the scaffold closes
 * that gap.
 *
 * Placed FIRST in `_manifest.json` so it runs before any author migration on a
 * fresh world. The tree it builds:
 *
 *   Battle Director/
 *   ├── <15 Core classes>/ { Skill, Heroic Skill }
 *   │     Arcanist  also → Arcana
 *   │     Spiritist also → Spell
 *   └── Hybrid Heroic Skill
 *
 * Other classes' `Spell` sub-folders are created lazily by later migrations
 * (and on demand by the self-healing authors) when the first Spell-typed item
 * is authored — matching the locked folder convention.
 *
 * IDEMPOTENT: re-runs create nothing when the tree is already present.
 */

import { ensureBattleDirectorTree } from "./_folder-tree.js";

export const key = "2026-05-26-bd-folder-bootstrap";
export const description =
  "Bootstrap the Battle Director Item-folder tree (15 Core classes × " +
  "{Skill, Heroic Skill} + Arcanist/Arcana + Spiritist/Spell + Hybrid Heroic " +
  "Skill) so skill-author migrations resolve their folders on any world.";

export async function migrate(game, log) {
  // RETIRED (2026-07-06): the Battle Director folder tree has been consolidated
  // into "💥 Skill / Class Skill" (single source of truth) and deleted. This
  // bootstrap is now a no-op so it never rebuilds the empty tree on a fresh /
  // co-dev world. `ensureBattleDirectorTree` is itself a no-op now; this early
  // return makes the retirement explicit and independent of that import.
  log("Battle Director folder bootstrap retired — no-op (tree folded into 💥 Skill / Class Skill)");
  return { applied: true, summary: "retired — Battle Director tree no longer bootstrapped" };
}
