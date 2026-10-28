// scripts/orbment/orbment-roll-tables.js
//
// The ROLL TABLES for random Attunement (Orbment v3) — the one source of truth
// for odds and prices, imported by the game AND by the offline simulator
// (tools/mindscape/bin/orbment-roll-sim.js). Change a number here and both move.
//
// Model (Elsword Magic Stone, user design 2026-10-28):
//   • A roll picks a TIER from the stone's weights, then an augment uniformly
//     among that tier's rollable augments for the item type, then (if the
//     augment has them) a random choice and a random value step.
//   • Ceiling = rulebook value: the top value step IS the RAW number.
//   • "Lure" pricing: each roll is cheap and the odds of anything above Common
//     are low, so a specific good result costs about what it did at 3× the
//     price and 3× the odds. Natural chase is MEANT to be hard; Upgrade (the
//     Tinkerer heroic skill) is the guaranteed path.
//
// Pure data + pure functions: no Foundry globals, so node can import it.

export const TIERS = Object.freeze(["Common", "Uncommon", "Rare", "Jackpot"]);

// Stone grades. `tiers` = weights for Common/Uncommon/Rare/Jackpot. `vals` =
// weights for an augment's value steps, keyed by how many steps it has.
export const STONES = Object.freeze({
  rough: {
    id: "rough", label: "Rough Stone", priceMult: 1,
    tiers: [86.67, 9.33, 3.33, 0.67],
    vals: { 2: [70, 30], 3: [50, 30, 20], 5: [35, 27, 20, 12, 6] },
  },
  polished: {
    id: "polished", label: "Polished Stone", priceMult: 2,
    tiers: [78.33, 11.67, 7.33, 2.67],
    vals: { 2: [45, 55], 3: [30, 40, 30], 5: [15, 20, 25, 22, 18] },
  },
});

// Base Zenit per roll, by the ITEM's rarity (× the stone's priceMult).
export const BASE_PRICE = Object.freeze({ common: 50, uncommon: 70, rare: 100, legendary: 170 });

export function rarityKey(rarity) {
  const r = String(rarity ?? "").trim().toLowerCase();
  if (r.includes("legendary")) return "legendary";
  if (r.includes("rare")) return "rare";
  if (r.includes("uncommon")) return "uncommon";
  return "common";
}

export function attunePrice(rarity, grade) {
  const stone = STONES[grade];
  if (!stone) return null;
  return BASE_PRICE[rarityKey(rarity)] * stone.priceMult;
}

// Weighted index pick. `rng` is injectable so the simulator can seed it.
export function pickWeighted(weights, rng = Math.random) {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < weights.length; i++) { r -= weights[i]; if (r < 0) return i; }
  return weights.length - 1;
}

// Value-step weights for an augment with `n` steps under a stone. Steps counts
// with no table (shouldn't happen) fall back to uniform.
export function valueWeights(stone, n) {
  return stone.vals[n] ?? new Array(n).fill(1);
}

// Camp Forge "Field Attune": the attuner's hidden check decides the grade, per
// slot. DEX + INS (current dice); total ≥ 13 or a critical (doubles of 6+) →
// Polished-grade, else Rough-grade. Never shown to players.
export const FIELD_CHECK = Object.freeze({ attrs: ["dex", "ins"], polishedAt: 13, critMin: 6 });

export function fieldGrade(dieA, dieB, rng = Math.random) {
  const a = 1 + Math.floor(rng() * Math.max(1, dieA));
  const b = 1 + Math.floor(rng() * Math.max(1, dieB));
  const crit = a === b && a >= FIELD_CHECK.critMin;
  return { a, b, grade: (a + b >= FIELD_CHECK.polishedAt || crit) ? "polished" : "rough" };
}

// ── The roll ───────────────────────────────────────────────────────────────────
// Roll ONE slot. `pool` = the item type's rollable augment DEFINITIONS (registry
// rollableAugments). `taken` = "id|param" keys already on the item that must not
// land again (same rule as a manual install: no exact duplicate on one item).
// Tier first, then an augment uniformly within the tier, then its random choice
// (a "choose two" picks two distinct options, stored in option order like
// canonicalizeParam), then its value step. An empty tier for this item type is
// re-drawn, so a type without Jackpot entries still rolls normally.
// Returns { id, param, value, tier, stepIndex, stepCount } or null (nothing left).
export function rollAugment(pool, grade, { taken = [], rng = Math.random } = {}) {
  const stone = STONES[grade];
  if (!stone || !Array.isArray(pool) || !pool.length) return null;
  const takenSet = new Set(taken);
  for (let guard = 0; guard < 200; guard++) {
    const tier = pickWeighted(stone.tiers, rng);
    const inTier = pool.filter((a) => a.tier === tier);
    if (!inTier.length) continue;
    const a = inTier[Math.floor(rng() * inTier.length)];
    let param = null;
    if (a.param?.options?.length) {
      const opts = a.param.options.map((o) => o.value);
      const pick = Math.max(1, Number(a.param.pick ?? 1) || 1);
      if (pick === 1) param = opts[Math.floor(rng() * opts.length)];
      else {
        const chosen = new Set();
        while (chosen.size < Math.min(pick, opts.length)) chosen.add(opts[Math.floor(rng() * opts.length)]);
        param = opts.filter((v) => chosen.has(v)).join("+");
      }
    }
    if (takenSet.has(`${a.id}|${param ?? ""}`)) continue;
    const steps = Array.isArray(a.vals) ? a.vals : null;
    const stepIndex = steps ? pickWeighted(valueWeights(stone, steps.length), rng) : 0;
    return { id: a.id, param, value: steps ? steps[stepIndex] : null, tier, stepIndex, stepCount: steps ? steps.length : 1 };
  }
  return null;
}

// Where an installed slot sits on the verdict scale (for an existing install,
// which may carry no value = the rulebook max).
export function slotStanding(def, value) {
  if (!def) return null;
  // An augment outside the roll pool (GM-only damage Immunity) ranks as a Jackpot,
  // so replacing it reads as the loss it is.
  const tier = Number.isInteger(def.tier) ? def.tier : 3;
  const steps = Array.isArray(def.vals) ? def.vals : null;
  if (!steps) return { tier, stepIndex: 0, stepCount: 1 };
  const i = steps.indexOf(Number(value));
  return { tier, stepIndex: i >= 0 ? i : steps.length - 1, stepCount: steps.length };
}

// ── Verdict (how an attune result compares to what it replaced) ───────────────
// score = tier × 10 + (value step position × 6, or 3 for a value-less augment).
// Drives the soft border tint, the Alchemist's line and his expression. Never
// shown to players as a word.
export function resultScore(tier, stepIndex, stepCount) {
  if (tier == null) return -1;
  const v = stepCount > 1 ? (stepIndex / (stepCount - 1)) * 6 : 3;
  return tier * 10 + v;
}

// `was` / `now`: { tier, stepIndex, stepCount } (was may be null = empty slot).
export function verdictFor(was, now) {
  const top = now.tier === 3 || (now.tier === 2 && now.stepCount > 1 && now.stepIndex === now.stepCount - 1);
  if (top) return "jackpot";
  if (!was) return "new";
  const a = resultScore(was.tier, was.stepIndex, was.stepCount);
  const b = resultScore(now.tier, now.stepIndex, now.stepCount);
  if (b > a + 0.5) return "better";
  if (b < a - 0.5) return "worse";
  return "sidegrade";
}

// With several slots attuned at once, the most notable result speaks.
export const VERDICT_RANK = Object.freeze(["jackpot", "worse", "better", "new", "sidegrade"]);
export function leadVerdict(verdicts) {
  return VERDICT_RANK.find((v) => verdicts.includes(v)) ?? "sidegrade";
}
