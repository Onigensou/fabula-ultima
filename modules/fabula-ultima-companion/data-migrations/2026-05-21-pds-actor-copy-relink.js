/**
 * Migration: 2026-05-21-pds-actor-copy-relink
 * ---------------------------------------------------------------------------
 * Delete-and-recreate variant of PDS actor-copy authoring.
 *
 * Why this exists alongside the in-place v6/pds-ref-repair flow:
 *
 *   Hina's PROPHETIC DEFENDER STYLE was originally a hand-edited duplicate
 *   of "Black & White" — both share uniqueId TSCAUfjpOlNl6WwV. v6 fixes
 *   this in-place by re-keying the actor copy's uniqueId to
 *   "propheticDefStyle". That works, but the item's `_id` and any residual
 *   per-copy state are preserved. For maximum cleanliness — and as a
 *   reference for future "fresh-copy from master" migrations — this one
 *   does the more disruptive operation: delete the actor's PDS item,
 *   then create a brand-new copy from the world master.
 *
 * Result: each actor's PDS becomes a fresh document with a new `_id`, the
 * correct uniqueId (=propheticDefStyle), the master's effect_table /
 * reaction_config / embedded AEs, and the player-set skill level
 * preserved.
 *
 * Idempotent: if an actor's PDS already has uniqueId === propheticDefStyle,
 * we treat it as already-relinked and skip. Re-runs find every PDS in the
 * "good" state and no-op.
 *
 * Safety:
 *   - Matches strictly by item.name === "PROPHETIC DEFENDER STYLE".
 *     Black & White (named "Black & White") is never inspected.
 *   - Refuses to delete an actor's PDS if the world master can't be found
 *     (would leave the actor with no PDS at all).
 *   - Captures `system.props.level` before delete; restores it on the new
 *     copy so the player's leveling progress isn't lost.
 *
 * SCOPE: every actor with at least one item literally named
 *        "PROPHETIC DEFENDER STYLE".
 */

export const key = "2026-05-21-pds-actor-copy-relink";
export const description =
  "Delete each actor's existing PDS copy and recreate it fresh from the " +
  "world master, preserving the player-set skill level. No-op for copies " +
  "already on the correct uniqueId.";

const PDS_NAME = "PROPHETIC DEFENDER STYLE";
const PDS_UNIQUE_ID = "propheticDefStyle";

function isPdsNamed(item) {
  return String(item?.name ?? "").trim().toUpperCase() === PDS_NAME;
}

// Find the world-level master whose uniqueId is the correct PDS id. v6
// stamps this id on the master via the Phase-0 ensureMaster step, so by
// the time this migration runs the master should exist.
function findCleanMaster(game) {
  for (const item of game.items?.contents ?? []) {
    if (!isPdsNamed(item)) continue;
    if (item.system?.uniqueId === PDS_UNIQUE_ID) return item;
  }
  return null;
}

// Build the createEmbeddedDocuments payload for a fresh actor copy.
// Strips identity/audit fields that would either collide or be re-stamped
// by Foundry; preserves the player's skill level under system.props.level.
function buildFreshCopyData(master, preservedLevel) {
  const data = master.toObject();
  // Strip fields Foundry will re-assign or that don't belong on an actor copy.
  delete data._id;
  delete data.folder;
  delete data.sort;
  delete data.ownership;
  delete data._stats;
  // Keep flags from the master (sourceSkillUniqueId etc.) — those identify
  // the AE's origin and aren't actor-specific.
  data.system = data.system ?? {};
  data.system.props = data.system.props ?? {};
  if (preservedLevel !== undefined && preservedLevel !== null && preservedLevel !== "") {
    data.system.props.level = preservedLevel;
  }
  return data;
}

async function relinkOnActor(actor, master, log) {
  const pdsItems = (actor.items?.contents ?? []).filter(isPdsNamed);
  if (!pdsItems.length) return 0;

  let touched = 0;
  for (const item of pdsItems) {
    if (item.system?.uniqueId === PDS_UNIQUE_ID) {
      // Already on the clean uniqueId — nothing to do.
      continue;
    }

    const preservedLevel = item.system?.props?.level ?? null;
    const oldId = item.id;

    try {
      await actor.deleteEmbeddedDocuments("Item", [oldId]);
    } catch (e) {
      log(`  • actor "${actor.name}" delete of PDS ${oldId} threw: ${e?.message ?? e} — skipping recreate to avoid data loss`);
      continue;
    }

    try {
      const fresh = buildFreshCopyData(master, preservedLevel);
      const [created] = await actor.createEmbeddedDocuments("Item", [fresh]);
      log(`  • actor "${actor.name}": deleted PDS ${oldId} → created fresh ${created?.id} (level=${preservedLevel ?? "(default)"})`);
      touched++;
    } catch (e) {
      // Bad state: deleted but couldn't recreate. Log loudly. The next
      // migration boot will run again and find no PDS on this actor — it'll
      // be a no-op, leaving the actor without PDS until manual repair.
      log(`  • actor "${actor.name}": DELETED PDS ${oldId} BUT createEmbeddedDocuments THREW: ${e?.message ?? e}`);
    }
  }
  return touched;
}

export async function migrate(game, log) {
  const master = findCleanMaster(game);
  if (!master) {
    log(`no world master named "${PDS_NAME}" with uniqueId "${PDS_UNIQUE_ID}" — ` +
        `expected v6 (2026-05-21-prophetic-defender-author-v6) to have created it. ` +
        `Aborting to avoid leaving actors without their PDS.`);
    // Return applied=false so the runner retries next boot — useful if v6
    // failed and gets fixed before this re-runs.
    return { applied: false, summary: "no clean master found; retry next boot" };
  }

  let touched = 0;
  for (const actor of game.actors?.contents ?? []) {
    try {
      touched += await relinkOnActor(actor, master, log);
    } catch (e) {
      log(`actor "${actor.name}" relink threw: ${e?.message ?? e}`);
    }
  }

  return {
    applied: true,
    summary: `${touched} actor PDS cop${touched === 1 ? "y" : "ies"} relinked (deleted + recreated from master ${master.id})`
  };
}
