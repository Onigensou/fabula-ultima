// ============================================================================
// Conflict Event — Sylphid Blaze.
//
// The hazard of the Wyrmwood. The rules:
//
//   1. Whenever a creature gains one or more Burn stacks, it gains that many +1
//      instead.
//   2. Burn damage is increased by 10%.
//
// Both are numbers BD decides inside its own executor, so this event has no
// handlers at all: it declares `modifiers`, and skill-effects.js reads them
// through conflictStatusModifier (conflict-event-runtime.js).
//
//   Rule 1 → apply_ae, every application of Burn (a fresh one and stacks added
//            to an existing one). Rulings (user, 2026-11-15): after the Resist
//            clamp (a resisted Burn lands 1, then +1 = 2); a Burn moved onto a
//            creature through apply_ae (Blazing Tether's "give") counts as
//            gaining it. A transfer/steal that merges an existing Burn does not.
//   Rule 2 → deal_damage, the Burn tick and every trigger_status replay of it
//            (Flame Claw, Meteor): ×1.1 before affinity, rounded down.
//
// Burn's stacks are its remaining turns (on_activation: each turn-start tick
// spends one), and the tick is 10% of the bearer's Max HP (half on a Champion).
// ============================================================================

import { registerConflictEvent } from "../conflict-event-registry.js";

registerConflictEvent({
  id: "sylphid-blaze",
  label: "Sylphid Blaze",
  description:
    "Whenever a creature gains Burn stacks, it gains 1 more. Burn deals 10% more damage.",

  modifiers: {
    statusCharges: { Burn: 1 },
    statusDamage: { Burn: 1.1 },
  },

  ruling: {
    color: "#d9661f",
    line: "Burn stacks grow faster and burn hotter.",
    pages: [
      { image: "modules/fabula-ultima-companion/assets/conflict-event/sylphid-blaze-1.jpg",
        text: "A creature that gains **Burn** stacks gains **1 more**." },
      { image: "modules/fabula-ultima-companion/assets/conflict-event/sylphid-blaze-2.jpg",
        text: "**Burn** deals **10%** more damage." },
    ],
  },
});
