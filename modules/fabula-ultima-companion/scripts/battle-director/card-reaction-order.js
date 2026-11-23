// card-reaction-order.js — the order RESOLVE fires a card's accepted reactions in.
//
// The CONFIRM scan builds the card list in scan order (state-handlers addCardReactions):
// creature_completes_spell first, then uses_item, will_deal_damage, creature_performs_action,
// targeted_by_action, guards. RESOLVE fires the accepted ones in that same list order, so a
// spell's "completes" chain ran BEFORE the same spell's "performs" chain. That is backwards
// whenever the two touch one resource: Spellweave's ask pill (performs_action) pays its
// Resonance spend, and its switch gain (completes_spell) adds 1 capped at the maximum — with the
// gain first, a spend at the cap lost 1 (R3, spend 2: 3+1→3 capped, −2 = 1 instead of 2).
//
// The fix moves ONLY the creature_completes_spell entries to just after the last
// creature_performs_action entry; every other entry keeps its relative order. A list without
// both kinds is returned unchanged (same array), so actions without a performs_action pill AND
// a completes_spell pill fire exactly as before.
const PERFORMS = "creature_performs_action";
const COMPLETES = "creature_completes_spell";

/** Accepted card reactions in fire order. Entries carry `phaseTrigger` (stamped at CONFIRM). */
export function orderAcceptedForFire(accepted) {
  if (!Array.isArray(accepted) || accepted.length < 2) return accepted;
  const trig = (c) => c?.phaseTrigger ?? null;
  const lastPerforms = accepted.map(trig).lastIndexOf(PERFORMS);
  if (lastPerforms < 0) return accepted;
  const firstCompletes = accepted.findIndex((c) => trig(c) === COMPLETES);
  if (firstCompletes < 0 || firstCompletes > lastPerforms) return accepted;
  const completes = accepted.filter((c) => trig(c) === COMPLETES);
  const out = [];
  accepted.forEach((c, i) => {
    if (trig(c) !== COMPLETES) out.push(c);
    if (i === lastPerforms) out.push(...completes);
  });
  return out;
}
