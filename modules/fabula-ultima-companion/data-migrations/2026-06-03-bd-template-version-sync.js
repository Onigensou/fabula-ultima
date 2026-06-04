/**
 * Migration: 2026-06-03-bd-template-version-sync
 * ---------------------------------------------------------------------------
 * CSB stamps every templated Item with
 * `system.templateSystemUniqueVersion` — a hash of the template body
 * captured AT CREATION TIME. When the template's body changes (e.g.
 * adding `creature_guards` to a select column's options), the template's
 * own version stamp is bumped on save. Existing items still carry the
 * OLD stamp; CSB then renders them against the stamped-time template
 * shape, so newly-added select options / new field types don't show in
 * the sheet UI.
 *
 * Author migrations today update `system.props.*` + embedded effects but
 * never touch `templateSystemUniqueVersion`. The Rampart author run was
 * the canonical victim — the data was correctly written but the sheet
 * still rendered the pre-template-surgery dropdown shape until the GM
 * manually clicked "Refresh template".
 *
 * Fix: walk every templated world Item + every templated Item on every
 * actor; copy the relevant template's CURRENT
 * `templateSystemUniqueVersion` into the item's own field whenever they
 * differ. Cheap idempotent numeric compare; no template-body deep-equal.
 *
 * BATCHED updates — a sequential-await version times out at 30s when the
 * world has 1500+ templated items. See [[csb-template-version-sync]].
 *
 * Going forward, every authoring migration should include a final
 * version-sync step on every item it touches.
 *
 * IDEMPOTENT.
 */

export const key = "2026-06-03-bd-template-version-sync";
export const description =
  "Sync system.templateSystemUniqueVersion on every templated Item (world " +
  "+ actor copies) so sheets render against the latest template body " +
  "after template surgery. Batched to avoid 30s bridge timeout.";

export async function migrate(game, log) {
  // Build a lookup of templateId → current templateSystemUniqueVersion.
  // Templates ARE Items in CSB-world (type prefixed with `_`).
  const templateVersionById = new Map();
  for (const item of game.items?.contents ?? []) {
    if (!String(item.type ?? "").startsWith("_")) continue;
    const v = item.system?.templateSystemUniqueVersion;
    if (v !== undefined && v !== null) templateVersionById.set(item.id, v);
  }
  log(`indexed ${templateVersionById.size} template(s) with version stamps`);

  // World items — one batch.
  const worldUpdates = [];
  for (const item of game.items?.contents ?? []) {
    const tplId = String(item.system?.template ?? "").trim();
    if (!tplId) continue;
    const want = templateVersionById.get(tplId);
    if (want === undefined) continue;
    const have = item.system?.templateSystemUniqueVersion;
    if (have === want) continue;
    worldUpdates.push({
      _id: item.id,
      "system.templateSystemUniqueVersion": want,
    });
  }
  if (worldUpdates.length) {
    const cls = CONFIG.Item.documentClass;
    await cls.updateDocuments(worldUpdates);
  }
  log(`world items: ${worldUpdates.length} updated`);

  // Per-actor batches.
  let actorCopiesTotal = 0;
  let actorsTouched = 0;
  for (const actor of game.actors?.contents ?? []) {
    const updates = [];
    for (const item of actor.items?.contents ?? []) {
      const tplId = String(item.system?.template ?? "").trim();
      if (!tplId) continue;
      const want = templateVersionById.get(tplId);
      if (want === undefined) continue;
      const have = item.system?.templateSystemUniqueVersion;
      if (have === want) continue;
      updates.push({
        _id: item.id,
        "system.templateSystemUniqueVersion": want,
      });
    }
    if (updates.length) {
      await actor.updateEmbeddedDocuments("Item", updates);
      actorCopiesTotal += updates.length;
      actorsTouched += 1;
    }
  }
  log(`actor copies: ${actorCopiesTotal} updated across ${actorsTouched} actor(s)`);

  return {
    applied: true,
    summary: `templateSystemUniqueVersion synced: ${worldUpdates.length} world item(s), ${actorCopiesTotal} actor copy(s) across ${actorsTouched} actor(s)`,
  };
}
