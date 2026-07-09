// ============================================================================
// Ritual System — cost, Difficulty Level, affordability.
//
// Pure. No Foundry globals, no DOM. Everything here is the arithmetic behind
// the two tables on core p. 119, and it is the piece worth unit-testing.
// ============================================================================

import { POTENCY, AREA, RITUAL_MP_PROP, disciplineById } from "./ritual-const.js";

function potencyById(id) { return Object.values(POTENCY).find((p) => p.id === id) ?? null; }
function areaById(id)    { return Object.values(AREA).find((a) => a.id === id) ?? null; }

/**
 * Price a ritual.
 *
 * MP = potency MP × area multiplier. A rare or powerful ingredient halves the
 * FINAL cost, once per ritual (p. 120) — halving the base first and then
 * multiplying would give the same answer today, but only because every table
 * value is even; halving last is what the book describes and survives a
 * homebrew multiplier.
 *
 * Rounds up. No table pairing produces a fraction, so this only ever matters
 * if someone adds an odd multiplier later — and a ritual should never get
 * cheaper through rounding.
 *
 * @returns {{mp:number, baseMp:number, dl:number, halved:boolean}|null}
 */
export function computeCost({ potency, area, ingredient = false } = {}) {
  const p = potencyById(potency);
  const a = areaById(area);
  if (!p || !a) return null;

  const baseMp = p.mp * a.multiplier;
  const mp = ingredient ? Math.ceil(baseMp / 2) : baseMp;
  return { mp, baseMp, dl: p.dl, halved: Boolean(ingredient) };
}

/** Current MP off a CSB actor. Tolerates missing/garbage props. */
export function currentMp(actor) {
  const n = Number(actor?.system?.props?.[RITUAL_MP_PROP.cur]);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Can this actor pay?
 *
 * Insufficient MP never hides the Cast button — the GM may still authorise a
 * ritual the numbers forbid. It only reports.
 */
export function canAfford(actor, cost) {
  if (!cost) return false;
  return currentMp(actor) >= cost.mp;
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

/** "40 MP × 2 (Small) = 80 MP · DL 13" — the window's live readout. */
export function describeCost({ potency, area, ingredient = false } = {}) {
  const p = potencyById(potency);
  const a = areaById(area);
  const cost = computeCost({ potency, area, ingredient });
  if (!p || !a || !cost) return "";
  const head = `${p.mp} MP × ${a.multiplier} (${a.label}) = ${cost.baseMp} MP`;
  const tail = cost.halved ? ` → ${cost.mp} MP (ingredient)` : "";
  return `${head}${tail} · DL ${cost.dl}`;
}
