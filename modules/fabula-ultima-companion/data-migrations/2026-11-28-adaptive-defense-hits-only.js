/**
 * Migration: 2026-11-28-adaptive-defense-hits-only  (Rakshasa adapts only when HIT)
 * ---------------------------------------------------------------------------
 * Adaptive Defense had two rows: creature_hit_by_action + creature_miss_action ("it does
 * not matter whether the attack hits"). User call 2026-11-28: "When he gets hit he
 * adapts, that's it." Misses never feed the read window.
 *
 * The miss row was authored reaction_source "self", which on creature_miss_action only
 * matches the attacker-side "I missed" twin, so it fired when Rakshasa HIMSELF missed
 * (harmless only because his pseudo-weapons carry no weapon family). Removing the row
 * ends that too.
 *
 * Changes, on every copy (world item, the Rakshasa world actor, unlinked scene tokens):
 *   1. every creature_miss_action row of Adaptive Defense is removed;
 *   2. the description trigger "is attacked with a weapon" → "is hit by an attack or a spell"
 *      (spells read as Arcane since fix #16).
 * Idempotent. Runs after 2026-11-28-adaptive-defense-miss-source (already applied on the real
 * world, so the miss row there reads "enemy"); a row of either source is removed.
 */

export const key = "2026-11-28-adaptive-defense-hits-only";
export const description = "Rakshasa's Adaptive Defense: only hits feed the read window (miss row removed, text updated).";

const NAME = "Adaptive Defense";
const OLD_TRIGGER = "the Rakshasa is attacked with a weapon";
const NEW_TRIGGER = "the Rakshasa is hit by an attack or a spell";

/** Patch for one item, or null when nothing needs to change. */
export function hitsOnlyPatch(item) {
  if (item?.name !== NAME) return null;
  const props = item.system?.props ?? {};
  const patch = {};
  for (const [k, row] of Object.entries(props.reaction_config_table ?? {})) {
    if (!row || row.$deleted) continue;
    if (row.reaction_trigger !== "creature_miss_action") continue;
    patch[`system.props.reaction_config_table.-=${k}`] = null;
  }
  const desc = String(props.description ?? "");
  if (desc.includes(OLD_TRIGGER)) patch["system.props.description"] = desc.replace(OLD_TRIGGER, NEW_TRIGGER);
  return Object.keys(patch).length ? patch : null;
}

async function syncCollection(items, label, out, parent = null) {
  const updates = [];
  for (const it of items ?? []) {
    const patch = hitsOnlyPatch(it);
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
