/**
 * Migration: 2026-06-06-dedup-bd-duplicate-masters
 * ---------------------------------------------------------------------------
 * Some worlds (notably the shared origin/main world snapshot) carry DUPLICATE
 * Battle Director skill masters: the same skill appears 2–3 times inside the BD
 * tree with identical content, and a few BD sub-folders are themselves
 * duplicated (`Battle Director / Common` ×2, `Battle Director / Matador` ×2,
 * `… / Matador / Skill` ×2). These arose co-dev-side (repeated authoring /
 * restore runs across merged world snapshots), NOT from a single runner pass.
 *
 * This collapses the duplication so each skill has exactly ONE master in the BD
 * tree, and each BD folder path exists once:
 *
 *   Phase 1 — merge duplicate Item folders (same full path), deepest-first:
 *     reparent the duplicate's child items + child folders into the canonical
 *     folder (the one holding the most children), then delete the emptied dup.
 *   Phase 2 — dedup same-name masters in the BD tree: keep one (an actor-linked
 *     copy if any exists, else the first), delete the identical redundant rest.
 *
 * SAFE BY CONSTRUCTION: only touches masters INSIDE the Battle Director tree —
 * legacy `💥 Skill` masters and CSB-embedded copies are never considered. A
 * master that ANY actor's `uniqueId` points at is never deleted (defensive),
 * and actor copies are left entirely untouched. Idempotent: once deduped, no
 * duplicate paths or names remain, so a re-run is a no-op.
 *
 * Does NOT touch root strays (handled by 2026-06-06-consolidate-bd-skill-masters)
 * nor the no-BD-master case (Prophetic Defender Style).
 */

export const key = "2026-06-06-dedup-bd-duplicate-masters";
export const description =
  "Dedup duplicate Battle Director skill masters: merge duplicate BD folders + " +
  "keep one master per skill in the BD tree; legacy masters + actor links untouched.";

const SKILL_TEMPLATE_ID = "j0F5Msw5RZ8aIB3j";

const folderPath = (f) => { const s = []; let c = f; while (c) { s.unshift(c.name); c = c.folder; } return s.join(" / "); };
const isSkill = (it) => String(it?.system?.template ?? "") === SKILL_TEMPLATE_ID;
const inBD = (it) => { let f = it?.folder; while (f) { if (f.name === "Battle Director" && !(f.folder?.id ?? f.folder)) return true; f = f.folder; } return false; };
const uidOf = (it) => String(it?.system?.uniqueId ?? "");
const parentId = (doc) => doc.folder?.id ?? doc.folder ?? null;

export async function migrate(game, log) {
  let foldersMerged = 0, itemsMoved = 0, mastersDeleted = 0;
  const itemFolders = () => game.folders.filter((f) => f.type === "Item");

  // ── PHASE 1: merge duplicate Item folders (same full path), deepest-first ──
  const groups = new Map();
  for (const f of itemFolders()) { const p = folderPath(f); if (!groups.has(p)) groups.set(p, []); groups.get(p).push(f); }
  const dupPaths = [...groups.keys()]
    .filter((p) => itemFolders().filter((f) => folderPath(f) === p).length > 1)
    .sort((a, b) => b.split(" / ").length - a.split(" / ").length);

  for (const p of dupPaths) {
    const cur = itemFolders().filter((f) => folderPath(f) === p);
    if (cur.length < 2) continue;
    const childCount = (fid) =>
      game.items.filter((i) => parentId(i) === fid).length +
      game.folders.filter((x) => x.type === "Item" && parentId(x) === fid).length;
    cur.sort((a, b) => childCount(b.id) - childCount(a.id));
    const canon = cur[0];
    for (const dup of cur.slice(1)) {
      const childItems = game.items.filter((i) => parentId(i) === dup.id);
      if (childItems.length) {
        await Item.updateDocuments(childItems.map((i) => ({ _id: i.id, folder: canon.id })));
        itemsMoved += childItems.length;
      }
      const childFolders = game.folders.filter((x) => x.type === "Item" && parentId(x) === dup.id);
      if (childFolders.length) await Folder.updateDocuments(childFolders.map((x) => ({ _id: x.id, folder: canon.id })));
      await dup.delete();
      foldersMerged += 1;
      log?.(`  merged duplicate folder "${p}" (${dup.id} → ${canon.id})`);
    }
  }

  // ── PHASE 2: dedup same-name masters inside the BD tree ──
  const actorUids = new Map();
  for (const a of game.actors?.contents ?? []) {
    for (const it of a.items?.contents ?? []) {
      if (!isSkill(it)) continue;
      if (!actorUids.has(it.name)) actorUids.set(it.name, new Set());
      actorUids.get(it.name).add(uidOf(it));
    }
  }
  const byName = new Map();
  for (const it of game.items?.contents ?? []) {
    if (!isSkill(it) || !inBD(it)) continue;
    if (!byName.has(it.name)) byName.set(it.name, []);
    byName.get(it.name).push(it);
  }
  for (const [name, copies] of byName) {
    if (copies.length < 2) continue;
    const links = actorUids.get(name) ?? new Set();
    const survivor = copies.find((c) => links.has(uidOf(c))) ?? copies[0];
    const toDelete = copies.filter((c) => c.id !== survivor.id && !links.has(uidOf(c)));
    if (toDelete.length) {
      await Item.deleteDocuments(toDelete.map((c) => c.id));
      mastersDeleted += toDelete.length;
      log?.(`  ${name}: kept ${survivor.id}, deleted ${toDelete.length} duplicate(s)`);
    }
  }

  return {
    applied: true,
    summary: `BD dedup: merged ${foldersMerged} duplicate folder(s) (moved ${itemsMoved} item(s)), deleted ${mastersDeleted} duplicate master(s).`,
  };
}
