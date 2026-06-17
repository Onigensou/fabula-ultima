// scripts/refinement-system/refinement-config.js

const REFINEMENT_CONFIG = {
  MAX_LEVEL: {
    weapon:     7,
    armor:      5,
    shield:     5,
    accessory:  0,
  },

  // Bonus at each refinement level (index = level). Flat linear progression.
  WEAPON_BONUS_TABLE: [0, 1, 2, 3, 4, 5, 6, 7],   // index = level, +1 dmg per level
  ARMOR_BONUS_TABLE:  [0, 5, 10, 15, 20, 25],      // index = level, +5 max_hp per level (caps at +25)
  SHIELD_BONUS_TABLE: [0, 1, 2, 3, 4, 5],          // index = level, +1 physical DR per level

  // 10-entry success rate arrays: index 0 = target +1, index 9 = target +10.
  // Armor/shield use offset = (10 - maxLevel) = 8, mapping their low max level
  // to the high-difficulty tail of this table.
  SUCCESS_RATES: {
    Common:    [100, 100, 100, 100, 100, 100, 100, 60, 40, 19],
    Uncommon:  [100, 100, 100, 100, 100, 100,  60, 40, 20, 19],
    Rare:      [100, 100, 100, 100, 100,  60,  50, 20, 20, 19],
    Legendary: [100, 100, 100, 100,  60,  40,  40, 20, 20,  9],
  },

  // ── Dynamic cost formula ──────────────────────────────────────────────────
  // cost = clamp(COST_BASE * RARITY_COST_MULT[rarity] * COST_LEVEL_SCALE[level],
  //             COST_MIN, COST_MAX)
  // Reference: Rare at current level 4 = 250 exactly ("standard cost").
  COST_BASE:        250,
  COST_MIN:          50,
  COST_MAX:         500,
  RARITY_COST_MULT: { Common: 0.4, Uncommon: 0.7, Rare: 1.0, Legendary: 1.8 },
  // index = current refine level (0 = item at +0 attempting +1, 9 = attempting +10)
  COST_LEVEL_SCALE: [0.4, 0.55, 0.7, 0.85, 1.0, 1.2, 1.4, 1.65, 1.9, 2.2],

  // ── Break chance ──────────────────────────────────────────────────────────
  // Base break % per current refine level index (0–9).
  // Actual break rate = baseBreak * dexFactor, capped to 50% of remaining fail space.
  BREAK_RATE_BASE: [1, 1, 2, 2, 3, 4, 5, 7, 10, 15],
  // Each DEX point above/below 9 (standard) multiplies break by ±this fraction.
  BREAK_DEX_SCALE: 0.06,
};
