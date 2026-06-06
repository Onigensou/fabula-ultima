/**
 * Migration: 2026-06-05-dedup-bd-masters
 * ---------------------------------------------------------------------------
 * One-shot cleanup for the duplicate skill masters created by the migration
 * system's folder-scoped dedup. Two create-paths (the per-class author
 * migrations and `2026-06-05-bd-skills-restore`) each checked "does this skill
 * already exist?" by NAME + EXACT FOLDER. When a sibling create-path placed
 * the item under a different name-resolution or the snapshot's folderPath
 * disagreed, the check missed and a SECOND identical Item landed in the SAME
 * folder. (Restore is now hardened to dedup by uniqueId / name+template across
 * the whole BD tree, so this won't recur on fresh worlds — but worlds that
 * already duplicated need this sweep, since the restore key is already in their
 * ledger and won't re-run.)
 *
 * Scope — intentionally narrow + non-destructive-by-default:
 *   • Only WORLD Items (folder masters) that are TRUE duplicates: identical
 *     (folder id, name, system.template). Legacy `💥 Skill` vs Battle Director
 *     copies live in different folders and are NOT touched.
 *   • Also de-dupes ACTOR copies that carry the same skill twice on one actor
 *     (same name + template + uniqueId).
 *
 * Which copy is KEPT (per duplicate group), in priority order:
 *   1. Most actor copies link to its `system.uniqueId` (keep the one things
 *      actually reference, so no actor loses its master).
 *   2. Most "wired" (effect_table rows + reaction_config rows + embedded AEs)
 *      — prefer the fully-authored copy over a bare stub.
 *   3. Lowest id (stable / oldest).
 * Actor copies that pointed at a DELETED master's uniqueId are re-linked to the
 * kept master's uniqueId so no copy is orphaned.
 *
 * Heavily logged; IDEMPOTENT (a second run finds no duplicate groups).
 */

export const key = "2026-06-05-dedup-bd-masters";
export const description =
  "Remove duplicate BD skill masters (same folder+name+template) created by " +
  "folder-scoped dedup; keep the most-referenced/most-wired; re-link copies.";

const BD_ROOT_NAME = "Battle Director";

function liveRows(t) {
  return Object.values(t ?? {}).filter((r) => r && !r.$deleted).length;
}

// Higher = more fully authored. Used as the secondary keep-priority.
function wiredScore(item) {
  const p = item?.system?.props ?? {};
  const aes = item?.effects?.contents ?? item?.effects ?? [];
  const aeCount = Array.isArray(aes) ? aes.length : (aes?.size ?? 0);
  return liveRows(p.effect_table) + liveRows(p.reaction_config_table) + aeCount;
}

function uniqueIdOf(item) {
  return String(item?.system?.uniqueId ?? "").trim();
}

// Count actor item-copies whose content-master uniqueId == this master's.
function countReferencingCopies(game, uid) {
  if (!uid) return 0;
  let n = 0;
  for (const a of game.actors?.contents ?? []) {
    for (const it of a.items?.contents ?? []) {
      if (uniqueIdOf(it) === uid) n += 1;
    }
  }
  return n;
}

// Pick the survivor of a duplicate group. Returns { keep, losers }.
function chooseSurvivor(game, group) {
  const scored = group.map((it) => ({
    it,
    refs: countReferencingCopies(game, uniqueIdOf(it)),
    wired: wiredScore(it),
    id: String(it.id ?? ""),
  }));
  scored.sort((a, b) =>
    (b.refs - a.refs) || (b.wired - a.wired) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
  return { keep: scored[0].it, losers: scored.slice(1).map((s) => s.it), scored };
}

export async function migrate(game, log) {
  // ── 1. World-item master duplicates: group by folderId + name + template ──
  const groups = new Map();
  for (const it of game.items?.contents ?? []) {
    const folderId = it.folder?.id ?? it.folder ?? "(root)";
    const tpl = String(it.system?.template ?? "");
    if (!tpl) continue;  // only template-backed (skill/equippable) items
    const k = `${folderId}::${it.name}::${tpl}`;
    (groups.get(k) ?? groups.set(k, []).get(k)).push(it);
  }

  let deletedMasters = 0;
  let relinkedCopies = 0;
  const deletedDetail = [];

  for (const [k, group] of groups) {
    if (group.length < 2) continue;
    const { keep, losers, scored } = chooseSurvivor(game, group);
    const keepUid = uniqueIdOf(keep);
    log(`  dup group "${group[0].name}" in folder "${keep.folder?.name ?? "?"}" — ${group.length} copies; ` +
        `keeping id=${keep.id} (refs=${scored[0].refs}, wired=${scored[0].wired})`);

    for (const loser of losers) {
      const loserUid = uniqueIdOf(loser);
      // Re-link actor copies that pointed at the loser → the survivor's uniqueId.
      if (loserUid && keepUid && loserUid !== keepUid) {
        for (const a of game.actors?.contents ?? []) {
          for (const it of a.items?.contents ?? []) {
            if (uniqueIdOf(it) !== loserUid) continue;
            try {
              await it.update({ "system.uniqueId": keepUid });
              relinkedCopies += 1;
              log(`    re-linked actor "${a.name}" copy "${it.name}" uniqueId ${loserUid} → ${keepUid}`);
            } catch (e) { log(`    re-link failed (${a.name}/${it.name}): ${e?.message ?? e}`); }
          }
        }
      }
      try {
        await loser.delete();
        deletedMasters += 1;
        deletedDetail.push(`${loser.name} (id=${loser.id})`);
      } catch (e) { log(`    delete failed (${loser.name} id=${loser.id}): ${e?.message ?? e}`); }
    }
  }

  // ── 2. Per-actor duplicate copies: same name + template + uniqueId on one actor ──
  let deletedCopies = 0;
  for (const a of game.actors?.contents ?? []) {
    const seen = new Map();  // key → first item
    const toDelete = [];
    for (const it of a.items?.contents ?? []) {
      const tpl = String(it.system?.template ?? "");
      if (!tpl) continue;
      const k = `${it.name}::${tpl}::${uniqueIdOf(it)}`;
      if (seen.has(k)) {
        // Keep the more-wired of the two; delete the other.
        const first = seen.get(k);
        if (wiredScore(it) > wiredScore(first)) {
          toDelete.push(first.id); seen.set(k, it);
        } else {
          toDelete.push(it.id);
        }
      } else {
        seen.set(k, it);
      }
    }
    if (toDelete.length) {
      try {
        await a.deleteEmbeddedDocuments("Item", toDelete);
        deletedCopies += toDelete.length;
        log(`  actor "${a.name}": removed ${toDelete.length} duplicate skill copy(ies)`);
      } catch (e) { log(`  actor "${a.name}": copy-dedup delete failed: ${e?.message ?? e}`); }
    }
  }

  const summary =
    `dedup: removed ${deletedMasters} duplicate master(s)` +
    (relinkedCopies ? `, re-linked ${relinkedCopies} copy(ies)` : "") +
    (deletedCopies ? `, removed ${deletedCopies} duplicate actor copy(ies)` : "") +
    (deletedDetail.length ? ` — masters: ${deletedDetail.join(", ")}` : " — none found");
  log(`  ${summary}`);
  return { applied: true, summary };
}
