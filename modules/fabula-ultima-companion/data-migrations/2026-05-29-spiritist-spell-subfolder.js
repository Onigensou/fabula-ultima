/**
 * Migration: 2026-05-29-spiritist-spell-subfolder
 * ---------------------------------------------------------------------------
 * Splits the `Battle Director / Spiritist / Skill` folder so spells live
 * in a dedicated `Battle Director / Spiritist / Spell` sub-folder, beside
 * (not below) `Skill`. Going forward, the folder distinction is the
 * convention for every class — Skill = active skills + passives, Spell =
 * Magic Check spells. Mirrors the RAW Spirit Magic tab/list distinction.
 *
 * What this migration does:
 *   1. Ensures `Battle Director / Spiritist / Spell` exists (creates it
 *      under the existing Spiritist folder, sibling to `Skill` and
 *      `Heroic Skill`).
 *   2. Walks the existing `Skill` folder; moves every item with
 *      `system.props.skill_type === "Spell"` into the new `Spell`
 *      folder via `item.update({ folder: <newFolderId> })`.
 *
 * Items that stay in `Skill`:
 *   Spiritual Magic (Other), Healing Power / Support Magic / Vismagus /
 *   Ritual Spiritism (Passive). Per the new convention, "Skill" holds
 *   non-Spell items.
 *
 * IDEMPOTENT: re-runs no-op when the Spell folder already exists and
 * every Spell-typed item is already inside it.
 */

export const key = "2026-05-29-spiritist-spell-subfolder";
export const description =
  "Create Battle Director / Spiritist / Spell sub-folder and relocate " +
  "every Spell-typed master from the sibling Skill folder.";

const ROOT_NAME  = "Battle Director";
const CLASS_NAME = "Spiritist";
const FROM_NAME  = "Skill";
const TO_NAME    = "Spell";

function findFolder(game, name, parentId) {
  return game.folders?.contents?.find((f) =>
    f.type === "Item" && f.name === name &&
    ((f.folder?.id ?? f.folder ?? null) === parentId)
  ) ?? null;
}

export async function migrate(game, log) {
  const root = findFolder(game, ROOT_NAME, null);
  if (!root) {
    log(`folder "${ROOT_NAME}" not found — scaffold first; nothing to do.`);
    return { applied: true, summary: "no Battle Director root" };
  }
  const classFolder = findFolder(game, CLASS_NAME, root.id);
  if (!classFolder) {
    log(`folder "${ROOT_NAME} / ${CLASS_NAME}" not found — scaffold first; nothing to do.`);
    return { applied: true, summary: "no Spiritist folder" };
  }
  const fromFolder = findFolder(game, FROM_NAME, classFolder.id);
  if (!fromFolder) {
    log(`folder "${ROOT_NAME} / ${CLASS_NAME} / ${FROM_NAME}" not found — nothing to move.`);
  }

  // 1. Ensure the Spell sub-folder exists.
  let toFolder = findFolder(game, TO_NAME, classFolder.id);
  if (!toFolder) {
    try {
      toFolder = await Folder.create({
        name: TO_NAME,
        type: "Item",
        folder: classFolder.id,
        sorting: "a",
      });
      log(`created folder "${ROOT_NAME} / ${CLASS_NAME} / ${TO_NAME}" (${toFolder?.id})`);
    } catch (e) {
      log(`failed to create "${TO_NAME}" sub-folder: ${e?.message ?? e}`);
      return { applied: false, summary: `folder create failed: ${e?.message ?? e}` };
    }
  } else {
    log(`folder "${ROOT_NAME} / ${CLASS_NAME} / ${TO_NAME}" already exists (${toFolder.id})`);
  }

  // 2. Move every Spell-typed item from the Skill folder.
  let moved = 0;
  const skipped = [];
  if (fromFolder) {
    for (const item of fromFolder.contents ?? []) {
      const type = String(item.system?.props?.skill_type ?? "").trim();
      if (type !== "Spell") { skipped.push(`${item.name} [${type}]`); continue; }
      try {
        await item.update({ folder: toFolder.id });
        moved += 1;
        log(`  moved "${item.name}" → ${TO_NAME}`);
      } catch (e) {
        log(`  failed to move "${item.name}": ${e?.message ?? e}`);
      }
    }
  }
  if (skipped.length) log(`  kept in ${FROM_NAME} (non-Spell): ${skipped.join(", ")}`);

  return {
    applied: true,
    summary: `Spell folder ${toFolder ? "ready" : "missing"}, moved ${moved} item(s)`,
  };
}
