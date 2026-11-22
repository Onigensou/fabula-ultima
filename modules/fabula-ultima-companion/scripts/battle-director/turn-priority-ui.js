// AOTD S4: pure UI helpers for granted-turn priority (Army of the Damned).
// No Foundry globals, so Node can test them.

/** Stable reorder: combatants with priority > 0 first (higher first), the rest keep order.
 *  With no priority anywhere the SAME array is returned untouched. */
export function orderByTurnPriority(list) {
  if (!Array.isArray(list) || !list.some((c) => Number(c?.priority) > 0)) return list;
  return list
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (Number(b.c?.priority) > 0 ? Number(b.c.priority) : 0) - (Number(a.c?.priority) > 0 ? Number(a.c.priority) : 0) || a.i - b.i)
    .map((x) => x.c);
}

/** GM desk dot class: "noturn" only when the unit has no turns of its own AND holds no granted turn. */
export function deskDotClass(u, acting) {
  if (acting) return "acting";
  if (Number(u?.turnsPerRound) === 0 && !(Number(u?.turnsRemaining) > 0)) return "noturn";
  return Number(u?.turnsRemaining) > 0 ? "" : "acted";
}
