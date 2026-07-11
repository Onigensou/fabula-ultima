/**
 * Migration: 2026-06-06-consolidate-bd-skill-masters
 * ---------------------------------------------------------------------------
 * Cleanup pass for the duplicated skill-master cruft that accumulated when
 * earlier authoring runs (older migration iterations / `CreateSkillFromSpec`
 * fallbacks) created master Items at WORLD ROOT instead of inside the
 * `Battle Director / <Class> / <sub>` folder tree. Because the migration
 * ledger is idempotent, the later (fixed) code never re-ran to clean them up,
 * so live worlds carry, per affected skill, a redundant `(ROOT)` copy (or two)
 * alongside the correctly-placed BD-tree master and the legacy `💥 Skill` copy.
 *
 * GOAL (this pass): exactly ONE master per skill living in its Battle Director
 * class folder. Actor copies are intentionally NOT re-pointed here (a separate
 * phase decides whether to migrate actor `uniqueId`s onto the BD master); the
 * legacy `💥 Skill` masters are left untouched (some custom-logic skills
 * hardcode legacy-folder UUIDs).
 *
 * PER-SKILL ALGORITHM (only skills that have at least one (ROOT) stray):
 *   • Let `roots` = masters at world root, `bds` = masters inside the BD tree.
 *   • If an actor copy is bound (by `system.uniqueId`) to a ROOT master, that
 *     root is the SURVIVOR — relocate it into the BD class folder (taken from
 *     the existing BD master's folder) and delete the now-redundant BD master
 *     plus any other root strays. This keeps actors valid with NO uniqueId
 *     change (the item they point at simply moves into the folder).
 *   • Otherwise the SURVIVOR is the existing BD master; delete the (unlinked)
 *     root strays. Legacy + actor links stay as-is.
 *   • A master that ANY actor links to is never deleted (defensive filter).
 *   • Duplicate same-named embedded AEs on the survivor are de-duped.
 *   • A skill whose only stray is at root with NO BD master is SKIPPED and
 *     logged (we can't infer its class folder) — handle manually.
 *
 * IDEMPOTENT: once consolidated, no (ROOT) strays remain, so a re-run is a
 * no-op. Folder moves + deletions only; no template-column changes, so no CSB
 * template-version surgery is required.
 *
 * ⚠ LIVE-APPLY FOLLOW-UPS (see migration summary / PR notes):
 *   1. (OBSOLETE 2026-07-11) The `_bd-skills-snapshot.json` restore was retired
 *      to a no-op and the snapshot + exporter removed — content now ships via
 *      world-data push, so there is no snapshot to regenerate here anymore.
 *   2. Review the SKIPPED (no-BD-master) skills and file them by hand.
 *   3. Legacy duplicate AEs (e.g. Hawkeye's) are left in place by design.
 */

export const key = "2026-06-06-consolidate-bd-skill-masters";
export const description =
  "Consolidate duplicated skill masters: keep one per skill in its Battle " +
  "Director folder, remove (ROOT) strays; leave legacy + actor links untouched.";

const SKILL_TEMPLATE_ID = "j0F5Msw5RZ8aIB3j"; // _Skill Template

const chainOf = (it) => {
  let f = it?.folder, c = [];
  while (f) { c.unshift(f.name); f = f.folder; }
  return c.join(" / ") || "(ROOT)";
};
const isSkillItem = (it) => String(it?.system?.template ?? "") === SKILL_TEMPLATE_ID;
const isRoot = (it) => !(it.folder?.id ?? it.folder);
const inBattleDirector = (it) => {
  let f = it?.folder;
  while (f) { if (f.name === "Battle Director" && !(f.folder?.id ?? f.folder)) return true; f = f.folder; }
  return false;
};
const uidOf = (it) => String(it?.system?.uniqueId ?? "");

export async function migrate(game, log) {
  // Group world skill-masters by name.
  const byName = new Map();
  for (const it of game.items?.contents ?? []) {
    if (!isSkillItem(it)) continue;
    if (!byName.has(it.name)) byName.set(it.name, []);
    byName.get(it.name).push(it);
  }

  // Which uniqueIds each skill's actor copies are bound to (never delete these).
  const actorUidByName = new Map();
  for (const a of game.actors?.contents ?? []) {
    for (const it of a.items?.contents ?? []) {
      if (!isSkillItem(it)) continue;
      if (!actorUidByName.has(it.name)) actorUidByName.set(it.name, new Set());
      actorUidByName.get(it.name).add(uidOf(it));
    }
  }

  let consolidated = 0, deleted = 0, moved = 0, aeDeduped = 0;
  const skipped = [];

  for (const [name, masters] of byName) {
    const roots = masters.filter(isRoot);
    if (roots.length === 0) continue; // nothing stray → nothing to do

    const bds = masters.filter(inBattleDirector);
    const actorUids = actorUidByName.get(name) ?? new Set();
    const actorLinkedRoot = roots.find((r) => actorUids.has(uidOf(r)));

    let survivor, targetFolderId, toDelete;
    if (actorLinkedRoot) {
      survivor = actorLinkedRoot;
      const bdRef = bds[0];
      targetFolderId = bdRef ? (bdRef.folder?.id ?? bdRef.folder ?? null) : null;
      toDelete = [...roots.filter((r) => r.id !== survivor.id), ...bds];
    } else {
      survivor = bds[0];
      targetFolderId = survivor ? (survivor.folder?.id ?? survivor.folder ?? null) : null;
      toDelete = roots.slice();
    }

    if (!survivor || !targetFolderId) {
      skipped.push(`${name} (roots:${roots.length}, bd:${bds.length})`);
      log?.(`  SKIP ${name}: no BD master to target — handle manually`);
      continue;
    }

    // Defensive: never delete a master an actor is bound to.
    toDelete = toDelete.filter((d) => d.id !== survivor.id && !actorUids.has(uidOf(d)));

    // Relocate survivor into the class folder.
    if ((survivor.folder?.id ?? survivor.folder ?? null) !== targetFolderId) {
      await survivor.update({ folder: targetFolderId });
      moved += 1;
      log?.(`  ${name}: survivor ${survivor.id} → ${chainOf(survivor)}`);
    }

    // Remove redundant duplicates.
    if (toDelete.length) {
      await Item.deleteDocuments(toDelete.map((d) => d.id));
      deleted += toDelete.length;
      log?.(`  ${name}: deleted ${toDelete.length} redundant master(s) [${toDelete.map((d) => d.id).join(", ")}]`);
    }

    // De-dup same-named embedded AEs on the survivor.
    const seen = new Set(), dupAeIds = [];
    for (const e of survivor.effects?.contents ?? []) {
      if (seen.has(e.name)) dupAeIds.push(e.id); else seen.add(e.name);
    }
    if (dupAeIds.length) {
      await survivor.deleteEmbeddedDocuments("ActiveEffect", dupAeIds);
      aeDeduped += dupAeIds.length;
      log?.(`  ${name}: de-duped ${dupAeIds.length} embedded AE(s) on survivor`);
    }

    consolidated += 1;
  }

  const summary =
    `Consolidated ${consolidated} skill(s): moved ${moved}, deleted ${deleted} stray master(s), ` +
    `de-duped ${aeDeduped} AE(s).` +
    (skipped.length ? ` SKIPPED (no BD master, manual): ${skipped.join("; ")}.` : "");
  log?.(`  ${summary}`);
  return { applied: true, summary };
}
