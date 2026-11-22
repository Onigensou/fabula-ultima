// Victory/defeat inference from the combatant list — pure leaf module (no
// imports besides battlefield-object, which is itself a leaf), so state-handlers,
// the battle-end orchestrator, director-boot and the sim can all share ONE
// predicate without an import cycle.
//
// The side-wipe check that ENDS a battle only counts creatures that could ever be
// lost (countsForSideWipe: no guests, no battlefield objects). The verdict must
// count the same creatures, or the two disagree: a Soul Fragment standing after
// the party broke Nidhogg's core read "defeat", and a standing guest after a TPK
// read "victory".
import { isBattlefieldObject } from "../battlefield-object.js";

const FLAG_NS = "fabula-ultima-companion";

function isGuest(actorDoc) {
  try { return !!actorDoc?.flags?.[FLAG_NS]?.bdGuest; } catch { return false; }
}

export function countsForSideWipe(c) {
  const actor = c?.actorDoc ?? null;
  return !isGuest(actor) && !isBattlefieldObject(actor);
}

/** "victory" | "defeat" from the combatants alone (no outcomeOverride). */
export function inferOutcomeFromCombatants(combatants) {
  const list = combatants ?? [];
  const party = list.filter((c) => c.side === "party" && countsForSideWipe(c));
  const enemies = list.filter((c) => c.side === "enemy" && countsForSideWipe(c));
  if (
    party.length > 0 && party.every((c) => c.isDefeatedLive?.()) &&
    !(enemies.length > 0 && enemies.every((c) => c.isDefeatedLive?.()))
  ) return "defeat";
  return "victory";
}

export function detectOutcomeFromCombat(dc) {
  if (!dc) return "victory";
  // An explicit outcome set by content wins over inference. Run Away stamps
  // "escaped" (via the `set_battle_outcome` effect) BEFORE its leave_combat
  // empties the party side — order that matters, because an empty party side
  // reaches the `party.length > 0` guard below and falls through to "victory",
  // handing a fleeing party the full reward prompt.
  //
  // In-memory by design: persistence.save returns early once dCombat.ended is
  // set, so there is no F5 window between dc.end() and the battle-end sequence
  // for a persisted marker to cover.
  const forced = String(dc.outcomeOverride ?? "").trim().toLowerCase();
  if (forced === "escaped" || forced === "victory" || forced === "defeat") return forced;
  return inferOutcomeFromCombatants(dc.combatants);
}
