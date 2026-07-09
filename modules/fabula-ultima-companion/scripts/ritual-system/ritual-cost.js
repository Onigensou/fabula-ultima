// ============================================================================
// Ritual System — cost, Difficulty Level, affordability.
//
// Pure. No Foundry globals, no DOM. Everything here is the arithmetic behind
// the two tables on core p. 119 plus our homebrew material discount, and it is
// the piece worth unit-testing.
// ============================================================================

import { POTENCY, AREA, RITUAL_MP_PROP, discountForRarity, disciplineById } from "./ritual-const.js";

function potencyById(id) { return Object.values(POTENCY).find((p) => p.id === id) ?? null; }
function areaById(id)    { return Object.values(AREA).find((a) => a.id === id) ?? null; }

/**
 * Price a ritual.
 *
 * MP = potency MP × area multiplier, then reduced by the offered material's
 * rarity (see RARITY_DISCOUNT). The reduction applies to the FINAL cost, once:
 * halving the base first and then multiplying would agree today only because
 * every table value is even, and applying it last is what the book describes.
 *
 * Rounds UP. A ritual must never get cheaper through rounding — Rare (30%) off
 * 50 MP is 35, not 34.
 *
 * @param {object} p
 * @param {string} p.potency
 * @param {string} p.area
 * @param {string|null} [p.materialRarity]  CSB item_rarity of the offered material
 * @returns {{mp:number, baseMp:number, dl:number, discount:number, saved:number}|null}
 */
export function computeCost({ potency, area, materialRarity = null } = {}) {
  const p = potencyById(potency);
  const a = areaById(area);
  if (!p || !a) return null;

  const baseMp = p.mp * a.multiplier;
  const discount = materialRarity ? discountForRarity(materialRarity) : 0;
  const mp = Math.ceil(baseMp * (1 - discount));
  return { mp, baseMp, dl: p.dl, discount, saved: baseMp - mp };
}

/** Current MP off a CSB actor. CSB stores it as a string — always coerce. */
export function currentMp(actor) {
  const n = Number(actor?.system?.props?.[RITUAL_MP_PROP.cur]);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Can this actor pay?
 *
 * Insufficient MP never hides the Perform button — the GM may still authorise a
 * ritual the numbers forbid. It only reports.
 */
export function canAfford(actor, cost) {
  if (!cost) return false;
  return currentMp(actor) >= cost.mp;
}

/** How many MP short, or 0 when affordable. Drives the red shortage report. */
export function shortfall(actor, cost) {
  if (!cost) return 0;
  return Math.max(0, cost.mp - currentMp(actor));
}

/**
 * The Magic Check attribute pair for a discipline.
 *
 * Chimerism is the only discipline with two legal pairs; `useAlt` picks the
 * MIG+WLP one. Every other discipline ignores the flag.
 */
export function attrsFor(disciplineId, { useAlt = false } = {}) {
  const d = disciplineById(disciplineId);
  if (!d) return null;
  return (useAlt && d.altAttrs) ? [...d.altAttrs] : [...d.attrs];
}
