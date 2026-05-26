// scripts/refinement-system/refinement-core.js

function _rfProps(item) {
  return item?.system?.props ?? {};
}

function rfGetRefineLevel(item) {
  return Math.max(0, Number(_rfProps(item).refine_level ?? 0));
}

function rfGetRefineCount(item) {
  return Math.max(0, Number(_rfProps(item).refine_count ?? 0));
}

function rfGetItemType(item) {
  return String(_rfProps(item).item_type ?? "").toLowerCase();
}

function rfGetItemRarity(item) {
  return String(_rfProps(item).item_rarity ?? "Common");
}

function rfGetMaxRefineLevel(item) {
  return REFINEMENT_CONFIG.MAX_LEVEL[rfGetItemType(item)] ?? 0;
}

function rfGetTargetLevel(item) {
  return rfGetRefineLevel(item) + 1;
}

// context shape: { refinerActor: ActorDocument | null }
// Passed through the pipeline for future refiner-stat hooks; unused for now.

function rfCanRefine(item, _context = {}) {
  const type = rfGetItemType(item);
  if (!["weapon", "armor", "shield"].includes(type)) {
    const label = _rfProps(item).item_type ?? type;
    return { allowed: false, reason: `${label} cannot be refined.` };
  }

  const current = rfGetRefineLevel(item);
  const max = rfGetMaxRefineLevel(item);
  if (current >= max) {
    return { allowed: false, reason: `This item is already at maximum refinement (+${max}).` };
  }

  return { allowed: true, reason: null };
}

function rfGetSuccessRate(item, _context = {}) {
  const rarity    = rfGetItemRarity(item);
  const maxLevel  = rfGetMaxRefineLevel(item);
  const target    = rfGetTargetLevel(item);
  const rates     = REFINEMENT_CONFIG.SUCCESS_RATES[rarity] ?? REFINEMENT_CONFIG.SUCCESS_RATES.Common;
  const offset    = 10 - maxLevel;
  const idx       = Math.min(9, Math.max(0, offset + (target - 1)));
  return rates[idx] ?? 0;
}

function rfGetCost() {
  return REFINEMENT_CONFIG.COST_PER_ATTEMPT;
}

function rfComputeWeaponBonus(level) {
  return Math.floor(level / 2);
}

function rfComputeArmorBonus(_level) {
  return "pending";  // armor refinement bonus logic not yet finalized
}

function rfComputeShieldBonus(_level) {
  return "pending";  // shield refinement bonus logic not yet finalized
}

function rfComputeBonus(item, level) {
  switch (rfGetItemType(item)) {
    case "weapon": return rfComputeWeaponBonus(level);
    case "armor":  return rfComputeArmorBonus(level);
    case "shield": return rfComputeShieldBonus(level);
    default:       return 0;
  }
}

function rfStripPrefix(name) {
  return name.replace(/^\+\d+\s+/, "");
}

function rfBuildDisplayName(baseName, level) {
  return level > 0 ? `+${level} ${baseName}` : baseName;
}

function rfRollAttempt(successRate) {
  return Math.random() * 100 < successRate;
}

function rfBuildResult(item, rolled, cost, context = {}) {
  const check = rfCanRefine(item, context);
  if (!check.allowed) {
    const level = rfGetRefineLevel(item);
    return {
      allowed:        false,
      success:        null,
      reason:         check.reason,
      itemName:       item.name,
      baseName:       rfStripPrefix(item.name),
      itemType:       rfGetItemType(item),
      rarity:         rfGetItemRarity(item),
      oldRefineLevel: level,
      newRefineLevel: level,
      targetLevel:    level + 1,
      successRate:    0,
      cost:           0,
      bonusBefore:    rfComputeBonus(item, level),
      bonusAfter:     rfComputeBonus(item, level),
      displayName:    item.name,
      message:        check.reason,
    };
  }

  const oldLevel    = rfGetRefineLevel(item);
  const targetLevel = oldLevel + 1;
  const newLevel    = rolled ? targetLevel : oldLevel;
  const successRate = rfGetSuccessRate(item, context);
  const baseName    = rfStripPrefix(item.name);
  const displayName = rfBuildDisplayName(baseName, newLevel);
  const bonusBefore = rfComputeBonus(item, oldLevel);
  const bonusAfter  = rfComputeBonus(item, newLevel);

  const message = rolled
    ? `Refinement succeeded! ${baseName} is now ${displayName}.`
    : `Refinement failed. ${baseName} remains at +${oldLevel}. Cost consumed.`;

  return {
    allowed:        true,
    success:        rolled,
    reason:         null,
    itemName:       item.name,
    baseName,
    itemType:       rfGetItemType(item),
    rarity:         rfGetItemRarity(item),
    oldRefineLevel: oldLevel,
    newRefineLevel: newLevel,
    targetLevel,
    successRate,
    cost,
    bonusBefore,
    bonusAfter,
    displayName,
    message,
  };
}
