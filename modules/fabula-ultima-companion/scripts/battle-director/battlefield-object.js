// ============================================================================
// Battlefield objects — combatants that are THINGS, not creatures.
//
// A battlefield object sits in the conflict as a real token and a real
// DirectorCombatant, so every skill, picker and damage path can reach it with
// no special targeting code. What it is NOT is a participant: it takes no
// turns, it cannot win or lose the fight, and it is worth nothing when the
// fight ends. First user: the Lightning Crystal
// (conflict-event/events/lightning-crystal.js).
//
// The marker is an ACTOR flag, `flags.fabula-ultima-companion.bdObject`, for
// the same reason the guest marker is: it describes what the thing IS, and an
// unlinked token's synthetic actor inherits it from the world actor for free.
//
// Read sites (keep this list honest — an object that one of them forgets is a
// fight that never ends, or a crystal that pays out EXP):
//
//   state-handlers.js        countsForSideWipe — never keeps its side "alive"
//   battle-end-rewards.js    no EXP / Zenit
//   director-hp-bar.js       no HP bar (it has no HP worth showing)
//   actionReader-core.js     isUntargetableActor — the AI never picks it, and
//                            it never inflates a pattern's creature counts.
//                            (ActionReader has zero imports by design, so it
//                            reads the same flag itself; the CONTRACT is
//                            shared, not this function.)
//
// Leaf module: no imports, so anything may import it without a cycle.
// ============================================================================

const FLAG_NS = "fabula-ultima-companion";

/** The actor flag that marks a battlefield object. */
export const BATTLEFIELD_OBJECT_FLAG = "bdObject";

export function isBattlefieldObject(actorDoc) {
  try {
    return actorDoc?.flags?.[FLAG_NS]?.[BATTLEFIELD_OBJECT_FLAG] === true;
  } catch { return false; }
}
