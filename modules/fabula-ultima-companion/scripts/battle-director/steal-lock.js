// ── Steal lock ─────────────────────────────────────────────────────────────
//
// FF-style "Steal": a creature can be successfully stolen from ONCE, by the
// whole party. After any party member wins an item from it, nobody can steal
// from it again (user ruling 2026-11-24, to-do #16).
//
// "Stolen from" = the creature carries a hidden "Soul Stolen by <name>" AE
// (flags.<ns>.soulStolenBy), which roll_loot_table stamps ONLY when an item is
// actually won. A missed Check or a roll that lands on "(Empty)" stamps
// nothing, so anyone may try again ("Couldn't steal anything").
//
// Two consumers share this one predicate so they can never disagree:
//   • targeting — applyStealLockExclusion() moves stolen creatures into the
//     picker's `.excluded` side-channel: they stay visible, greyed, under the
//     existing "🚫 <reason>" overlay, and cannot be picked. Soul Steal's IP is
//     paid per HIT, so an unpickable creature also pays no IP.
//   • resolution — roll_loot_table's backstop (skill-effects.js) refuses to
//     roll for a stolen creature even if a pick somehow reached it.
//
// The AE rides the actor snapshot, so a rewind past the steal clears the lock.

const FLAG_NS = "fabula-ultima-companion";

export const STEAL_LOCK_REASON = "Nothing to Steal";

/** Name of the first party member who stole from `actor`, or null if none. */
export function stolenFromBy(actor) {
  for (const ae of (actor?.effects?.contents ?? actor?.effects ?? [])) {
    const by = ae?.flags?.[FLAG_NS]?.soulStolenBy;
    if (by) return String(ae.name ?? "").replace(/^Soul Stolen by\s+/i, "").trim() || "someone";
  }
  return null;
}

export const hasBeenStolenFrom = (actor) => stolenFromBy(actor) !== null;

/** True when the action steals: one of its effect rows is a roll_loot_table. */
export function actionRollsStealTable(action) {
  const table = action?.system?.props?.effect_table;
  if (!table || typeof table !== "object") return false;
  return Object.values(table).some(
    (r) => r && !r.$deleted && String(r.effect_kind ?? "").trim().toLowerCase() === "roll_loot_table",
  );
}

function defaultActorOf(e) {
  try {
    const doc = e?.tokenUuid ? globalThis.fromUuidSync?.(e.tokenUuid) : null;
    if (doc?.actor) return doc.actor;
  } catch { /* fall through */ }
  return e?.tokenId ? (globalThis.canvas?.tokens?.get?.(e.tokenId)?.actor ?? null) : null;
}

/**
 * Move every already-stolen creature out of a steal action's eligible pool into
 * the picker's `.excluded` side-channel (reason "Nothing to Steal", soft grey).
 * A no-op for any action that does not steal, and when nothing is stolen.
 *
 * Preserves an existing `.excluded` (Vanish / Provoked / Study) the same way
 * applyStudyGuardExclusion does. When the steal lock leaves NO pickable
 * creature, the pool is flagged `showWhenNoneLeft` so the picker still opens
 * (everything greyed, Confirm off, Back returns to the menu) instead of being
 * refused with a toast — the same flow as a partly stolen field.
 */
export function applyStealLockExclusion(eligible, { action, actorOf = defaultActorOf } = {}) {
  if (!Array.isArray(eligible) || !actionRollsStealTable(action)) return eligible;
  const out = [];
  const moved = [];
  for (const e of eligible) {
    let actor = null;
    try { actor = actorOf(e); } catch { actor = null; }
    if (actor && hasBeenStolenFrom(actor)) {
      moved.push(Object.freeze({
        combatantId: e.combatantId,
        tokenId: e.tokenId,
        tokenUuid: e.tokenUuid,
        actorId: e.actorId,
        actorUuid: e.actorUuid,
        name: e.name,
        tokenImg: e.tokenImg,
        disposition: e.disposition,
        reasons: Object.freeze([STEAL_LOCK_REASON]),
        dim: "soft",
      }));
    } else {
      out.push(e);
    }
  }
  const prior = Array.isArray(eligible.excluded) ? eligible.excluded : [];
  if (!moved.length) return eligible;
  out.excluded = Object.freeze([...prior, ...moved]);
  if (!out.length) out.showWhenNoneLeft = true;
  return out;
}
