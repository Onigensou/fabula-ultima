// scripts/refinement-system/refinement-config.js

const REFINEMENT_CONFIG = {
  MAX_LEVEL: {
    weapon:    10,
    armor:      2,
    shield:     2,
    accessory:  0,
  },

  // 10-entry array: index 0 = target +1, index 9 = target +10
  // Armor/Shield use offset = (10 - maxLevel) = 8, so:
  //   +1 refinement → index 8, +2 refinement → index 9 (low rates from the start)
  SUCCESS_RATES: {
    Common:    [100, 100, 100, 100, 100, 100, 100, 60, 40, 19],
    Uncommon:  [100, 100, 100, 100, 100, 100,  60, 40, 20, 19],
    Rare:      [100, 100, 100, 100, 100,  60,  50, 20, 20, 19],
    Legendary: [100, 100, 100, 100,  60,  40,  40, 20, 20,  9],
  },

  COST_PER_ATTEMPT: 250, // zenit, flat rate for v1 — easy to convert to a table later
};
