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

// ── context shape: { refinerActor: ActorDocument | null } ─────────────────

// %-point modifier to success rate from refiner's Dex + Mig.
// Centered at stat 9 (standard midpoint). Each point above/below = ±1.5%.
function rfGetStatModifier(context = {}) {
  const actor = context.refinerActor ?? null;
  if (!actor) return 0;
  const props = actor.system?.props ?? {};
  const dex = Math.max(2, Math.min(20, Number(props.dex_current ?? props.dex ?? 9)));
  const mig = Math.max(2, Math.min(20, Number(props.mig_current ?? props.mig ?? 9)));
  return ((dex + mig) / 2 - 9) * 1.5;
}

function rfCanRefine(item, _context = {}) {
  const type = rfGetItemType(item);
  if (!["weapon", "armor", "shield"].includes(type)) {
    const label = _rfProps(item).item_type ?? type;
    return { allowed: false, reason: `${label} cannot be refined.` };
  }
  const current = rfGetRefineLevel(item);
  const max     = rfGetMaxRefineLevel(item);
  if (current >= max) {
    return { allowed: false, reason: `This item is already at maximum refinement (+${max}).` };
  }
  return { allowed: true, reason: null };
}

function rfGetSuccessRate(item, context = {}) {
  const target = rfGetTargetLevel(item);
  // First four refinements are always guaranteed regardless of rarity or refiner stats
  if (target <= 4) return 100;

  const rarity   = rfGetItemRarity(item);
  const maxLevel = rfGetMaxRefineLevel(item);
  const rates    = REFINEMENT_CONFIG.SUCCESS_RATES[rarity] ?? REFINEMENT_CONFIG.SUCCESS_RATES.Common;
  const offset   = 10 - maxLevel;
  const idx      = Math.min(9, Math.max(0, offset + (target - 1)));
  const base     = rates[idx] ?? 0;
  const mod      = rfGetStatModifier(context);
  return Math.min(99, Math.max(1, Math.round(base + mod)));
}

// Dynamic cost: BASE * rarityMult * levelScale, clamped [MIN, MAX].
// Rare at current level 4 = 250 (the "standard" reference point).
function rfGetCost(item, _context = {}) {
  const level    = rfGetRefineLevel(item);
  const rarity   = rfGetItemRarity(item);
  const base     = REFINEMENT_CONFIG.COST_BASE;
  const rarMult  = REFINEMENT_CONFIG.RARITY_COST_MULT[rarity] ?? REFINEMENT_CONFIG.RARITY_COST_MULT.Common;
  const lvlScale = REFINEMENT_CONFIG.COST_LEVEL_SCALE[Math.min(9, Math.max(0, level))] ?? 1;
  const raw      = Math.round(base * rarMult * lvlScale);
  return Math.min(REFINEMENT_CONFIG.COST_MAX, Math.max(REFINEMENT_CONFIG.COST_MIN, raw));
}

// Break chance driven by DEX only — precision of hand determines equipment safety.
// Each DEX point above/below 9 multiplies base break by (1 - delta * SCALE).
// Capped to 50% of the remaining fail space so success still dominates at low levels.
function rfGetBreakRate(item, context = {}) {
  const level     = rfGetRefineLevel(item);
  const baseBreak = REFINEMENT_CONFIG.BREAK_RATE_BASE[Math.min(9, Math.max(0, level))] ?? 1;

  const actor = context.refinerActor ?? null;
  let dexFactor = 1.0;
  if (actor) {
    const props = actor.system?.props ?? {};
    const dex = Math.max(2, Math.min(20, Number(props.dex_current ?? props.dex ?? 9)));
    dexFactor = Math.max(0.1, 1.0 - (dex - 9) * REFINEMENT_CONFIG.BREAK_DEX_SCALE);
  }

  const successRate = rfGetSuccessRate(item, context);
  const maxBreak    = Math.max(0, (100 - successRate) * 0.5);
  return Math.min(maxBreak, Math.max(0, baseBreak * dexFactor));
}

function rfComputeWeaponBonus(level) {
  const table = REFINEMENT_CONFIG.WEAPON_BONUS_TABLE;
  return table[Math.min(table.length - 1, Math.max(0, level))] ?? 0;
}

function rfComputeArmorBonus(level) {
  const table = REFINEMENT_CONFIG.ARMOR_BONUS_TABLE;
  return table[Math.min(table.length - 1, Math.max(0, level))] ?? 0;
}
function rfComputeShieldBonus(level) {
  const table = REFINEMENT_CONFIG.SHIELD_BONUS_TABLE;
  return table[Math.min(table.length - 1, Math.max(0, level))] ?? 0;
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

// outcome: "success" | "fail" | "break"
function rfRollOutcome(successRate, breakRate) {
  const r = Math.random() * 100;
  if (r < successRate)             return "success";
  if (r < successRate + breakRate) return "break";
  return "fail";
}

function rfBuildResult(item, outcome, cost, context = {}) {
  const check = rfCanRefine(item, context);
  if (!check.allowed) {
    const level = rfGetRefineLevel(item);
    return {
      allowed:        false,
      outcome:        "blocked",
      success:        false,
      broke:          false,
      reason:         check.reason,
      itemName:       item.name,
      baseName:       rfStripPrefix(item.name),
      itemType:       rfGetItemType(item),
      rarity:         rfGetItemRarity(item),
      oldRefineLevel: level,
      newRefineLevel: level,
      targetLevel:    level + 1,
      successRate:    0,
      breakRate:      0,
      cost:           0,
      bonusBefore:    rfComputeBonus(item, level),
      bonusAfter:     rfComputeBonus(item, level),
      displayName:    item.name,
      message:        check.reason,
    };
  }

  const oldLevel    = rfGetRefineLevel(item);
  const targetLevel = oldLevel + 1;
  const successRate = rfGetSuccessRate(item, context);
  const breakRate   = rfGetBreakRate(item, context);
  const baseName    = rfStripPrefix(item.name);

  let newLevel, displayName, message;
  if (outcome === "success") {
    newLevel    = targetLevel;
    displayName = rfBuildDisplayName(baseName, newLevel);
    message     = `Refinement succeeded! ${baseName} is now ${displayName}.`;
  } else if (outcome === "break") {
    newLevel    = Math.max(0, oldLevel - 1);
    displayName = rfBuildDisplayName(baseName, newLevel);
    message     = `Refinement broke! ${baseName} degraded from +${oldLevel} to +${newLevel}.`;
  } else {
    newLevel    = oldLevel;
    displayName = rfBuildDisplayName(baseName, newLevel);
    message     = `Refinement failed. ${baseName} remains at +${oldLevel}.`;
  }

  const bonusBefore = rfComputeBonus(item, oldLevel);
  const bonusAfter  = rfComputeBonus(item, newLevel);

  return {
    allowed:        true,
    outcome,
    success:        outcome === "success",
    broke:          outcome === "break",
    reason:         null,
    itemName:       item.name,
    baseName,
    itemType:       rfGetItemType(item),
    rarity:         rfGetItemRarity(item),
    oldRefineLevel: oldLevel,
    newRefineLevel: newLevel,
    targetLevel,
    successRate,
    breakRate,
    cost,
    bonusBefore,
    bonusAfter,
    displayName,
    message,
  };
}
