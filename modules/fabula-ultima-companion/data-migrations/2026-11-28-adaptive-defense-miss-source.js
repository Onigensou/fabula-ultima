/**
 * Migration: 2026-11-28-adaptive-defense-miss-source  (Rakshasa reads MISSED attacks)
 * ---------------------------------------------------------------------------
 * Adaptive Defense has two rows: creature_hit_by_action + creature_miss_action ("it does
 * not matter whether the attack hits"). Both were authored reaction_source "self".
 *
 * That is right for the hit row (its subject is the struck creature) but wrong for the
 * miss row. creature_miss_action is dispatched twice per missed action:
 *   - to the MISSED creature, subject = the attacker   → needs "enemy"
 *   - to the attacker ("I missed"), subject = itself     → what "self" matches
 * So the row never read a party attack that missed, and instead fired when Rakshasa
 * himself missed (harmless only because his pseudo-weapons carry no weapon family).
 * Every other defender-side miss row in the world (Pases, Fancy Footwork, Counter Pass,
 * Swordbreaker, Counterattack) is "enemy".
 *
 * Fix: the miss row's reaction_source "self" → "enemy", on every copy (world item, the
 * Rakshasa world actor, unlinked tokens on scenes). Only rows that are still
 * creature_miss_action + "self" change. Idempotent.
 * Approved 2026-11-28 (fix #16, Adaptive Defense never read Twin Shields / spells).
 */

export const key = "2026-11-28-adaptive-defense-miss-source";
export const description = "Rakshasa's Adaptive Defense: the miss row reads the attacker as an enemy, so missed attacks read their weapon too.";

const NAME = "Adaptive Defense";

/** Patch for one item, or null when nothing needs to change. */
export function missRowPatch(item) {
  if (item?.name !== NAME) return null;
  const table = item.system?.props?.reaction_config_table ?? {};
  const patch = {};
  for (const [k, row] of Object.entries(table)) {
    if (!row || row.$deleted) continue;
    if (row.reaction_trigger !== "creature_miss_action") continue;
    if (String(row.reaction_source ?? "").trim().toLowerCase() !== "self") continue;
    patch[`system.props.reaction_config_table.${k}.reaction_source`] = "enemy";
  }
  return Object.keys(patch).length ? patch : null;
}

async function syncCollection(items, label, out, parent = null) {
  const updates = [];
  for (const it of items ?? []) {
    const patch = missRowPatch(it);
    if (patch) updates.push({ _id: it.id, ...patch });
  }
  if (!updates.length) return 0;
  if (parent) await parent.updateEmbeddedDocuments("Item", updates);
  else await Item.updateDocuments(updates);
  out.push(`~ ${label}: ${updates.length}`);
  return updates.length;
}

export async function migrate(game, log = () => {}) {
  const out = [];
  await syncCollection(game.items?.filter?.((i) => i.name === NAME) ?? [], "world items", out);
  for (const a of game.actors ?? []) await syncCollection(a.items, a.name, out, a);
  for (const scene of game.scenes ?? []) {
    for (const t of scene.tokens ?? []) {
      if (t.actorLink || !t.actor) continue;
      await syncCollection(t.actor.items, `${scene.name} / ${t.name}`, out, t.actor);
    }
  }
  for (const l of out) log(l);
  return { applied: true, summary: out.join(" | ") || "nothing to change" };
}
