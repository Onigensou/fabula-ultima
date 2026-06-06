/**
 * Migration: 2026-06-06-dedup-bd-masters-by-uniqueid
 * ---------------------------------------------------------------------------
 * FIX for 2026-06-06-dedup-bd-duplicate-masters / -consolidate-bd-skill-masters,
 * which silently delete NOTHING on any world that has actor copies of the
 * duplicated skills (i.e. a real campaign — the co-dev case).
 *
 * ROOT CAUSE
 * ----------
 * The duplicate BD masters are EXACT copies: they all share one `system.uniqueId`
 * (the CSB "content master" link), and the actor's skill copy carries that same
 * uniqueId. The earlier migrations' defensive guard
 *
 *     toDelete = copies.filter(c => c.id !== survivor.id && !links.has(uidOf(c)))
 *
 * was meant to "never delete a master an actor points at". But because every
 * duplicate shares the linked uniqueId, `links.has(uidOf(c))` is TRUE for ALL of
 * them, so the filter removes every candidate → 0 deletions. It only worked on
 * the authoring world because those BD skills had NO actor copies there (empty
 * `links`), so the guard was inert.
 *
 * WHY DELETING SHARED-UNIQUEID DUPLICATES IS SAFE
 * -----------------------------------------------
 * We keep one survivor that carries the same uniqueId, so the actor copies' link
 * still resolves. Collapsing identical-uniqueId copies never orphans an actor.
 *
 * ALGORITHM
 * ---------
 *   Phase 1 — merge duplicate Item folders (same full path), deepest-first
 *             (unchanged from the prior dedup; idempotent / usually already done).
 *   Phase 2 — within the BD tree, group masters by `system.uniqueId` (true
 *             duplicate key, NOT name). For each group with >1 copy keep ONE
 *             survivor (prefer one already in a non-root folder) and delete the
 *             rest. Masters with a DISTINCT uniqueId are never merged together,
 *             so genuinely different content-masters are preserved.
 *
 * SCOPE / SAFETY: only masters INSIDE the `Battle Director` tree are considered.
 * Legacy `💥 Skill` masters, CSB-embedded copies, and actor copies are untouched.
 * Empty-uniqueId masters fall back to name-grouping (no actor link to protect).
 * Idempotent: once one copy per uniqueId remains, a re-run is a no-op.
 *
 * NEW KEY (not an edit of the old file) on purpose: the broken migrations are
 * already recorded in affected worlds' `appliedMigrations` ledger and will never
 * re-run, so the fix must ship as a fresh key to execute on those worlds.
 */

export const key = "2026-06-06-dedup-bd-masters-by-uniqueid";
export const description =
  "Dedup BD skill masters by shared uniqueId (fixes the actor-linked-copy guard " +
  "that made the prior dedup a no-op on campaign worlds).";

const SKILL_TEMPLATE_ID = "j0F5Msw5RZ8aIB3j";

const folderPath = (f) => { const s = []; let c = f; while (c) { s.unshift(c.name); c = c.folder; } return s.join(" / "); };
const isSkill = (it) => String(it?.system?.template ?? "") === SKILL_TEMPLATE_ID;
const inBD = (it) => { let f = it?.folder; while (f) { if (f.name === "Battle Director" && !(f.folder?.id ?? f.folder)) return true; f = f.folder; } return false; };
const uidOf = (it) => String(it?.system?.uniqueId ?? "");
const parentId = (doc) => doc.folder?.id ?? doc.folder ?? null;
const isRoot = (it) => !parentId(it);

export async function migrate(game, log) {
  let foldersMerged = 0, itemsMoved = 0, mastersDeleted = 0, groups = 0;
  const itemFolders = () => game.folders.filter((f) => f.type === "Item");

  // ── PHASE 1: merge duplicate Item folders (same full path), deepest-first ──
  const byPath = new Map();
  for (const f of itemFolders()) { const p = folderPath(f); if (!byPath.has(p)) byPath.set(p, []); byPath.get(p).push(f); }
  const dupPaths = [...byPath.keys()]
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

  // ── PHASE 2: collapse same-uniqueId master duplicates inside the BD tree ──
  // Key by uniqueId (true-duplicate identity). Empty uniqueId → fall back to a
  // name-scoped bucket so distinct unlinked masters aren't merged by accident.
  const buckets = new Map();
  for (const it of game.items?.contents ?? []) {
    if (!isSkill(it) || !inBD(it)) continue;
    const uid = uidOf(it);
    const k = uid ? `uid:${uid}` : `name:${it.name}`;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(it);
  }

  for (const [k, copies] of buckets) {
    if (copies.length < 2) continue;
    groups += 1;
    // Prefer a survivor that already lives in a (non-root) class folder.
    const survivor = copies.find((c) => !isRoot(c)) ?? copies[0];
    const toDelete = copies.filter((c) => c.id !== survivor.id);
    await Item.deleteDocuments(toDelete.map((c) => c.id));
    mastersDeleted += toDelete.length;
    log?.(`  ${survivor.name} [${k}]: kept ${survivor.id} @ ${folderPath(survivor.folder)}, deleted ${toDelete.length} duplicate(s)`);
  }

  return {
    applied: true,
    summary:
      `BD dedup-by-uniqueId: merged ${foldersMerged} folder(s) (moved ${itemsMoved} item(s)), ` +
      `collapsed ${groups} duplicate group(s), deleted ${mastersDeleted} duplicate master(s).`,
  };
}
