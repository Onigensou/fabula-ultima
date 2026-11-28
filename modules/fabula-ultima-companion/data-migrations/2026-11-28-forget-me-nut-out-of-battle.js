/**
 * Migration: 2026-11-28-forget-me-nut-out-of-battle
 * ---------------------------------------------------------------------------
 * Forget me Nut ("Reduce a Skill level by one and Recover 1 Skill Point") is a
 * field-only consumable, but the battle Item menu offered it as usable (to-do
 * #13, approved 2026-11-28). The engine now reads an item setting,
 * `system.props.out_of_battle_only` (sheet checkbox "Out of Battle Only",
 * declared on the gear template by template-props-registry.js): the battle
 * Item menu shows the item greyed out with "Out of battle only", and DECLARE
 * refuses it.
 *
 * Sets the flag on the world item (id fOEeRwVzYy6YQuIN) and on every actor copy
 * of it. A copy is matched by its source link (_stats.compendiumSource or
 * flags.core.sourceId = Item.fOEeRwVzYy6YQuIN) or, failing that, by the exact
 * name "Forget me Nut". The name is used ONLY here, to find the copies once;
 * the engine itself never reads names.
 *
 * One-time. Writes only where the flag is not already true. Unlinked scene
 * tokens are not walked (party actors are linked); the GM can tick the box on
 * any stray copy.
 */

export const key = "2026-11-28-forget-me-nut-out-of-battle";
export const description = "Forget me Nut: tick 'Out of Battle Only' (out_of_battle_only) on the world item + every actor copy, so the battle Item menu greys it out.";

const WORLD_ID = "fOEeRwVzYy6YQuIN";
const SOURCE = `Item.${WORLD_ID}`;
const NAME = "Forget me Nut";
const PROP = "out_of_battle_only";

const label = (doc) => `${doc.parent?.name ? doc.parent.name + ": " : ""}${doc.name}`;

function isCopy(it) {
  const src = it?._stats?.compendiumSource ?? it?.flags?.core?.sourceId ?? null;
  if (src === SOURCE) return true;
  return String(it?.name ?? "").trim() === NAME;
}

export async function migrate(game, log = () => {}) {
  const out = [];
  const world = game.items?.get?.(WORLD_ID) ?? null;
  if (!world) out.push(`! world item ${WORLD_ID} not found`);
  else if (world.system?.props?.[PROP] === true) out.push(`= ${label(world)} already out of battle only`);
  else {
    try {
      await world.update({ [`system.props.${PROP}`]: true });
      out.push(`~ ${label(world)} (world)`);
    } catch (e) { out.push(`! ${label(world)}: ${e?.message ?? e}`); }
  }

  let copies = 0;
  for (const a of game.actors ?? []) {
    const updates = [];
    for (const it of a.items ?? []) {
      if (!isCopy(it)) continue;
      if (it.system?.props?.[PROP] === true) { out.push(`= ${label(it)} already set`); continue; }
      updates.push({ _id: it.id, [`system.props.${PROP}`]: true });
    }
    if (!updates.length) continue;
    try {
      await a.updateEmbeddedDocuments("Item", updates);
      copies += updates.length;
      out.push(`~ ${a.name}: ${updates.length} cop${updates.length === 1 ? "y" : "ies"}`);
    } catch (e) { out.push(`! ${a.name}: ${e?.message ?? e}`); }
  }
  out.push(`${copies} actor cop${copies === 1 ? "y" : "ies"} updated`);

  for (const l of out) log(l);
  return { applied: true, summary: out.join(" | ") };
}
