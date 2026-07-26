/**
 * Character Creation — destination folder resolution.
 *
 * Every character this system makes is filed at:
 *
 *     Player Character / <Username>'s PC
 *
 * EXACT MATCH, DELIBERATELY
 * -------------------------
 * The folders already in the world were made by hand and do not follow one
 * rule: user `Onigensou` owns "Oni's PC", `Pikabeer` owns "Pika PC",
 * `Fluffycatfish` owns "Fluffy's pc" (lowercase), and "John's PC" / "Kusai's PC"
 * belong to nobody. A fuzzy matcher gets 17 of 20 right, which is the worst
 * possible score: it is right often enough to be trusted and wrong often enough
 * to silently file a character under the wrong player.
 *
 * So there is no fuzzy matching. The name is built from `user.name` and matched
 * exactly; if it does not exist it is created. Legacy folders are left alone and
 * simply stop accruing new characters. This was an explicit call — precision now
 * that a system owns the naming, rather than inheriting hand-made drift.
 */

import { CC, warn } from "./cc-const.js";

/** The exact folder name for a user. */
export const folderNameFor = (user) =>
  `${String(user?.name ?? "Unknown").trim()}${CC.PC_FOLDER_SUFFIX}`;

/** The `Player Character` root Actor folder, or null. */
export function pcRootFolder() {
  return game.folders?.find(
    (f) => f.type === "Actor" && f.name === CC.PC_ROOT_FOLDER && !f.folder
  ) ?? null;
}

/**
 * Find the user's PC folder without creating anything.
 *
 * Safe on any client — the wizard calls this to show the destination on the
 * summary step, so a player sees where their character will land before
 * anything is written.
 *
 * @returns {{ folder: Folder|null, name: string, root: Folder|null, exists: boolean }}
 */
export function previewFolder(user = game.user) {
  const name = folderNameFor(user);
  const root = pcRootFolder();
  const folder = root
    ? (game.folders?.find(
        (f) => f.type === "Actor" && f.folder?.id === root.id && f.name === name
      ) ?? null)
    : null;
  return { folder, name, root, exists: !!folder };
}

/**
 * Resolve the folder, creating it (and the root, if somehow absent) as needed.
 *
 * GM-SIDE ONLY. Folder creation requires it, and this is called from the
 * finalize handler which already runs on the acting GM.
 *
 * @returns {Promise<Folder>}
 */
export async function ensureFolder(user) {
  const name = folderNameFor(user);

  let root = pcRootFolder();
  if (!root) {
    warn(`root folder "${CC.PC_ROOT_FOLDER}" missing — creating it`);
    root = await Folder.create({ name: CC.PC_ROOT_FOLDER, type: "Actor", folder: null });
  }

  const existing = game.folders?.find(
    (f) => f.type === "Actor" && f.folder?.id === root.id && f.name === name
  );
  if (existing) return existing;

  return Folder.create({ name, type: "Actor", folder: root.id });
}
