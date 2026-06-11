// The Battle Director's ONE check primitive.
//
// A Fabula Ultima Check is: roll two attribute dice, sum them (+ a flat bonus),
// take the High Roll, and decide crit / fumble. That is ALL a check is — it does
// not know about weapons, damage, defenses, or targets. Those belong to the
// per-action layers around it (params in, comparison out).
//
// This replaces the check logic that had been copy-pasted across the COMPUTE
// branches (Attack/Skill via computeCheck, plus the bespoke Hinder / Study /
// grappled-break-free inline rolls), which had drifted: the open-check copies
// hardcoded `rA >= 6` and ignored the crit-modifier props. Here there is one
// rule, prop-aware, used everywhere.
//
// CANON (user-locked 2026-06-11):
//   - Crit   = isCriticalHit (minimum_critical_dice / critical_dice_range aware).
//   - Fumble = both dice <= `fumble_threshold` (default 1 = RAW "two 1s"; a
//              fumble_threshold buff raises it — kept from the BD's prior rule).
import { isCriticalHit } from "./skill-formulas.js";
import { attrDieSize, readPropNum } from "./snapshot.js";

// Pure derivation: given the two die faces (+ the roller's props + bonus), decide
// the outcome. The single source of truth for crit / fumble. Sync — no rolling.
export function deriveCheck({ rA = 0, rB = 0, props = null, fumbleThreshold = 1, checkBonus = 0 } = {}) {
  const a = Number(rA) || 0, b = Number(rB) || 0;
  const thr = Math.max(1, Number(fumbleThreshold) || 1);
  const isFumble = a <= thr && b <= thr;
  const isCrit = isCriticalHit({ rA: a, rB: b, props, isFumble });
  return { rA: a, rB: b, hr: Math.max(a, b), total: (a + b + (Number(checkBonus) || 0)) | 0, checkBonus: Number(checkBonus) || 0, isFumble, isCrit };
}

// THE check. Rolls the two attribute dice for `actor` (or takes forced dice from
// the test harness) and derives the outcome. Inputs: the roller + the two stats
// + an optional flat bonus. Nothing else.
export async function rollCheck({ actor, A1, A2, checkBonus = 0, dice = null } = {}) {
  const props = actor?.system?.props ?? null;
  const dA = attrDieSize(actor, A1);
  const dB = attrDieSize(actor, A2);
  let rA, rB;
  if (dice) { rA = dice.rA ?? 0; rB = dice.rB ?? 0; }
  else {
    const r = await new Roll(`1d${dA} + 1d${dB}`).roll();
    const faces = r.dice.map((x) => x.results?.[0]?.result ?? 0);
    rA = faces[0] ?? 0; rB = faces[1] ?? 0;
  }
  const fumbleThreshold = readPropNum(actor, ["fumble_threshold"], 1);
  return { ...deriveCheck({ rA, rB, props, fumbleThreshold, checkBonus }), dA, dB };
}

// ── Comparison layer (the per-action interpretation) ───────────────────────
// Generic comparisons live here; action-specific ladders (e.g. Study's
// encyclopedia tiers) stay with the action. A check result never carries the
// comparison — the caller supplies the defense / DL.
export const checkVsDefense = (r, defense) => ({
  hit: r.isCrit || (!r.isFumble && r.total >= Number(defense)),
  margin: r.total - Number(defense),
});
export const checkVsThreshold = (r, dl) => ({
  success: r.isCrit ? true : r.isFumble ? false : r.total >= Number(dl),
});
