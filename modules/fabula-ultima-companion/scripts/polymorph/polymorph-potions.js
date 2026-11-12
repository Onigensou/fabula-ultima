// ============================================================================
// Polymorph Potions — which monster an item turns you into.
//
// CODE-BACKED BY NAME (declared in shared/code-backed-content.js): an item named
//   "Polymorph Potion: <Monster>"
// transforms its target into the world NPC actor named exactly <Monster>.
//
// Why by name and not a flag: the world holds 12 of these potions AND copies in
// PC inventories and the party stash (embedded items). A flag stamped on the
// world items would miss every copy already handed out; the name travels with
// every copy. A potion whose monster does not exist yet (7 of 12 on 2026-11-12:
// Ice Ring, Lava Golem, Walrog, Hunger, Crazy Merman, Scaldra, Centauros) says
// so and is NOT used up.
//
// No imports: actor-shape-style gates and the Battle Director read this.
// ============================================================================

export const POTION_PREFIX = "Polymorph Potion:";
const POTION_RE = /^\s*polymorph\s+potion\s*:\s*(.+?)\s*$/i;

/** "<Monster>" for a Polymorph Potion item (or bare name), else null. */
export function formNameForItem(itemOrName) {
  const n = typeof itemOrName === "string" ? itemOrName : itemOrName?.name;
  const m = String(n ?? "").match(POTION_RE);
  return m ? m[1] : null;
}

export const isPolymorphPotion = (item) => !!formNameForItem(item);

/**
 * The potions carry no `skill_target` (blank = Self to the targeting parser).
 * Ruling 2026-11-12: you may drink it OR give it to a willing ally → "One Ally"
 * (your own side, you included). An authored skill_target always wins.
 */
export function potionTargetText(item, raw) {
  const t = String(raw ?? "").trim();
  if (t || !isPolymorphPotion(item)) return t;
  return "One Ally";
}

const isNpcActor = (a) => {
  const p = a?.system?.props ?? {};
  return !!(String(p.npc_rank ?? "").trim() || String(p.species ?? "").trim());
};

/** The world monster actor a potion turns you into, or null if none exists. */
export function findFormActor(itemOrName) {
  const want = formNameForItem(itemOrName);
  if (!want) return null;
  const lower = want.toLowerCase();
  const actors = globalThis.game?.actors?.contents ?? [];
  return actors.find((a) => a.name === want && isNpcActor(a))
    ?? actors.find((a) => String(a.name ?? "").trim().toLowerCase() === lower && isNpcActor(a))
    ?? null;
}
