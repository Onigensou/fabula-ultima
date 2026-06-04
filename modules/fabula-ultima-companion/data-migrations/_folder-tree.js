/**
 * Shared folder-tree helpers for Battle Director data migrations.
 * ---------------------------------------------------------------------------
 * The skill-author migrations (and the CreateSkillFromSpec macro) place each
 * master Item inside the world's `Battle Director / <Class> / <sub>` Item-folder
 * tree, resolved BY NAME. That tree was originally scaffolded by hand via the
 * test bridge and never captured as code — so a fresh world (e.g. a co-dev who
 * pulls the migrations) had no tree, and every author hard-failed with
 * "scaffold first".
 *
 * This module makes folder creation declarative and idempotent so:
 *   - `2026-05-26-bd-folder-bootstrap` can recreate the whole tree on boot, and
 *   - each author migration can `ensureFolderPath(...)` its own folder on
 *     demand instead of erroring when it's missing (self-healing).
 *
 * NOT a migration itself — leading underscore + absence from `_manifest.json`
 * keep the runner from executing it. Imported by migrations via
 * `import { ... } from "./_folder-tree.js"` (relative to the migration URL).
 *
 * Foundry V12. Item-type Folders only.
 */

export const BD_ROOT_NAME = "Battle Director";

// The 15 Core-rulebook classes, each scaffolded with `Skill` + `Heroic Skill`.
// Mirrors the convention documented in the `battle-director-folder-tree` memory.
export const BD_CORE_CLASSES = [
  "Arcanist", "Chimerist", "Darkblade", "Elementalist", "Entropist", "Fury",
  "Guardian", "Loremaster", "Orator", "Rogue", "Sharpshooter", "Spiritist",
  "Tinkerer", "Wayfarer", "Weaponmaster",
];

// Sub-folders every class gets.
export const BD_UNIVERSAL_SUBFOLDERS = ["Skill", "Heroic Skill"];

// Extra per-class sub-folders beyond the universal pair.
//   Arcanist  → "Arcana" (bound-spirit items)
//   Spiritist → "Spell"  (RAW Magic-Check spells)
// Other classes create their `Spell` folder lazily when the first Spell-typed
// item is authored (see `2026-05-29-spiritist-spell-subfolder`).
export const BD_CLASS_EXTRA_SUBFOLDERS = {
  Arcanist: ["Arcana"],
  Spiritist: ["Spell"],
};

// Folders directly under "Battle Director", siblings of the class folders.
//   "Hybrid Heroic Skill" — heroic skills shared across classes
//   (Hoplite, Quaking Titan, Prophetic Defender, ...).
//   "Common" — the canonical action-skill Items that back the built-in turn
//   actions (Guard, Hinder, Study, Equipment, Item), universal to every
//   creature. Authored by the resolveAction-unification migrations; resolved
//   at runtime by the `coreAction` flag, not by folder, so the folder is
//   purely for GM organisation.
export const BD_TOPLEVEL_SIBLINGS = ["Hybrid Heroic Skill", "Common"];

/**
 * Find an Item-type folder by name under a given parent (null = world root).
 * Parent is matched by id, tolerating both the doc-ref and bare-id shapes
 * Foundry uses for `folder`.
 */
export function findChildFolder(game, name, parentId = null) {
  return game.folders?.find((f) =>
    f.type === "Item" &&
    f.name === name &&
    ((f.folder?.id ?? f.folder ?? null) === (parentId ?? null))
  ) ?? null;
}

/**
 * Resolve a folder by path segments, read-only. Returns the leaf Folder doc or
 * null if any segment is missing.
 *   findFolderByPath(game, ["Battle Director", "Guardian", "Skill"])
 */
export function findFolderByPath(game, segments) {
  let parentId = null;
  let current = null;
  for (const name of segments) {
    current = findChildFolder(game, name, parentId);
    if (!current) return null;
    parentId = current.id;
  }
  return current;
}

/**
 * Ensure every folder along `segments` exists, creating any missing level
 * parent-first. Idempotent — existing folders are reused, never duplicated.
 * Returns `{ folder, created }` where `folder` is the leaf Folder doc and
 * `created` is an array of the full paths that were newly created.
 *
 *   const { folder } = await ensureFolderPath(
 *     game, ["Battle Director", "Guardian", "Skill"], { log });
 */
export async function ensureFolderPath(game, segments, { sorting = "a", log } = {}) {
  let parentId = null;
  let current = null;
  const created = [];
  const sofar = [];
  for (const name of segments) {
    sofar.push(name);
    let f = findChildFolder(game, name, parentId);
    if (!f) {
      f = await Folder.create({ name, type: "Item", folder: parentId, sorting });
      created.push(sofar.join(" / "));
      log?.(`  created folder "${sofar.join(" / ")}" (${f?.id})`);
    }
    current = f;
    parentId = f?.id ?? null;
  }
  return { folder: current, created };
}

/**
 * Ensure the full convention tree exists:
 *   Battle Director/
 *   ├── <each Core class>/ { Skill, Heroic Skill, [Arcana | Spell] }
 *   └── Hybrid Heroic Skill
 * Returns `{ created }` — the list of newly-created folder paths.
 */
export async function ensureBattleDirectorTree(game, log) {
  const created = [];

  const root = await ensureFolderPath(game, [BD_ROOT_NAME], { log });
  created.push(...root.created);

  for (const cls of BD_CORE_CLASSES) {
    const subs = [
      ...BD_UNIVERSAL_SUBFOLDERS,
      ...(BD_CLASS_EXTRA_SUBFOLDERS[cls] ?? []),
    ];
    for (const sub of subs) {
      const r = await ensureFolderPath(game, [BD_ROOT_NAME, cls, sub], { log });
      created.push(...r.created);
    }
  }

  for (const sib of BD_TOPLEVEL_SIBLINGS) {
    const r = await ensureFolderPath(game, [BD_ROOT_NAME, sib], { log });
    created.push(...r.created);
  }

  return { created };
}
