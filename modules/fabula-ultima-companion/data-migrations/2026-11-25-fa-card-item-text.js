/**
 * Migration: 2026-11-25-fa-card-item-text  (idempotent)
 * ---------------------------------------------------------------------------
 * Fabula Arcana card items carry their card text in their description, written
 * when the card was granted (fa-collection.js cardItemData). The card text was
 * rewritten Genius Invokation style on 2026-11-25 ("this unit", trigger: effect,
 * keyword names), so every owned card item gets its description rebuilt from the
 * catalog. Only cards whose description differs are touched.
 *
 * Idempotent: it re-runs when this file changes. After a later catalog text
 * change, bump TEXT_VERSION below to refresh every owned card again.
 */

import { cardItemData, cidOf } from "../scripts/fabula-arcana/fa-collection.js";

export const key = "2026-11-25-fa-card-item-text";
export const description = "Fabula Arcana: owned card items take the rewritten card text from the catalog.";

const TEXT_VERSION = 1;   // bump after a catalog text change to refresh owned cards again

export async function migrate(game, log = () => {}) {
  const C = globalThis.FabulaArcana?.Catalog;
  if (!C?.CARDS) { log("! Fabula Arcana catalog not loaded; nothing done (will retry next boot)"); throw new Error("catalog missing"); }
  let changed = 0, same = 0, skipped = 0;
  const out = [];
  for (const actor of game.actors) {
    const updates = [];
    for (const it of actor.items) {
      const cid = cidOf(it); if (!cid) continue;
      if (!C.CARDS[cid]) { skipped++; continue; }
      const want = cardItemData(cid).system.props.description;
      if ((it.system?.props?.description ?? "") === want) { same++; continue; }
      updates.push({ _id: it.id, "system.props.description": want });
    }
    if (!updates.length) continue;
    await actor.updateEmbeddedDocuments("Item", updates);
    changed += updates.length; out.push(`~ ${actor.name}: ${updates.length}`);
  }
  for (const l of out) log(l);
  const summary = `v${TEXT_VERSION}: ${changed} card item(s) refreshed, ${same} already current, ${skipped} unknown card id(s) left alone`;
  log(summary);
  return { applied: true, summary };
}
