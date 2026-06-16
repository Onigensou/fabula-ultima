// scripts/battle-director/invoke/invoke-core.js
// Pure logic for BD invoke — actor queries, payment, dialogs, dice math.
// No DOM coupling, no director reference. Dynamically imported by invoke-worker.js.

import { deriveCheck } from "../check.js";

// ── Resource detection ───────────────────────────────────────────────────────

function _npcRank(actor) {
  return String(actor?.system?.props?.npc_rank ?? "").trim();
}

export function getPointResource(actor) {
  // All NPCs (any npc_rank) spend Ultima Points; players spend Fabula Points.
  return _npcRank(actor)
    ? { key: "ultima_point", label: "Ultima Point" }
    : { key: "fabula_point", label: "Fabula Point" };
}

/**
 * Returns invoke capability for the actor:
 *   "full"       — player characters (no npc_rank prop)
 *   "trait-only" — NPCs with npc_rank AND at least 1 Ultima Point (villain/boss rank)
 *   "none"       — NPCs with npc_rank but 0 UP (normal/soldier monsters), or unknown
 */
export function getInvokeCapability(actor) {
  if (!actor) return "none";
  const rank = _npcRank(actor);
  if (!rank) return "full"; // no npc_rank → player character
  const up = Number(actor?.system?.props?.ultima_point ?? 0) || 0;
  return up > 0 ? "trait-only" : "none";
}

export function canPay(actor) {
  const { key, label } = getPointResource(actor);
  const cur = Number(actor?.system?.props?.[key] ?? 0) || 0;
  return { ok: cur >= 1, key, label, cur };
}

export async function payPoint(actor) {
  const { key, label } = getPointResource(actor);
  const cur = Number(actor?.system?.props?.[key] ?? 0) || 0;
  if (cur < 1) return { ok: false, key, label, cur };
  try {
    await actor.update({ [`system.props.${key}`]: cur - 1 });
    return { ok: true, key, label, cur: cur - 1 };
  } catch (e) {
    console.warn("[BD][Invoke] payPoint failed:", e);
    return { ok: false, key, label, cur };
  }
}

// ── Bond reading ─────────────────────────────────────────────────────────────

export function readActorBonds(actor) {
  const P = actor?.system?.props ?? {};
  const bonds = [];
  for (let i = 1; i <= 6; i++) {
    const name = String(P[`bond_${i}`] ?? "").trim();
    if (!name) continue;
    const e1 = !!P[`emotion_${i}_1`];
    const e2 = !!P[`emotion_${i}_2`];
    const e3 = !!P[`emotion_${i}_3`];
    const filled = (e1 ? 1 : 0) + (e2 ? 1 : 0) + (e3 ? 1 : 0);
    const bonus = Math.min(3, Math.max(0, filled));
    bonds.push({ index: i, name, bonus, filled });
  }
  return bonds;
}

// ── Dice math ─────────────────────────────────────────────────────────────────

// Reroll one or both accuracy dice; keeps existing checkBonus and attributes.
// Returns a full roll object shaped like BD's rollCheck result.
export async function rerollDice({ roll, choice, actor }) {
  const dA = Number(roll.dA) || 6;
  const dB = Number(roll.dB) || 6;
  let rA = Number(roll.rA) || 0;
  let rB = Number(roll.rB) || 0;

  if (choice === "A" || choice === "AB") rA = (await new Roll(`1d${dA}`).evaluate()).total;
  if (choice === "B" || choice === "AB") rB = (await new Roll(`1d${dB}`).evaluate()).total;

  const fumbleThreshold = Math.max(1, Number(actor?.system?.props?.fumble_threshold ?? 1) || 1);
  const props      = actor?.system?.props ?? null;
  const checkBonus = Number(roll.checkBonus) || 0;
  const derived    = deriveCheck({ rA, rB, props, fumbleThreshold, checkBonus });

  return {
    ...roll,
    rA:       derived.rA,
    rB:       derived.rB,
    hr:       derived.hr,
    total:    derived.total,
    isCrit:   derived.isCrit,
    isFumble: derived.isFumble,
    opportunities: derived.isCrit && !derived.isFumble,
  };
}

// Apply a flat bond bonus (no re-roll). Returns a new roll object.
// HR, isCrit, isFumble are unchanged — bond only adds to the flat total.
export function applyBondBonus({ roll, bonus }) {
  const addBonus = Number(bonus) || 0;
  const newBonus = (Number(roll.checkBonus) || 0) + addBonus;
  const rA       = Number(roll.rA) || 0;
  const rB       = Number(roll.rB) || 0;
  return {
    ...roll,
    checkBonus: newBonus,
    total:      rA + rB + newBonus,
  };
}

