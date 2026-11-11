// ============================================================================
// Dungeon Trap — pure rules (no Foundry, no DOM). Approved 2026-11-10, mockup
// https://claude.ai/artifact/EgW2YkyzCqX3PDokaiSLQY (Formula A).
//
//   base = 5 + floor(Party Level / 4)           Minor tier (default)
//   base = floor(that × 1.5)                    Heavy tier (opt-in per tile)
//
// The base then runs the normal damage pipeline as PHYSICAL damage
// (apply-damage-core: flat DR all+physical, % DR, affinity), and a trap never
// takes a living PC below 1 HP. This file owns the numbers; the engine owns the
// writes; dp-trap-fx.js owns what the players see.
// ============================================================================

export const TRAP_TIERS = Object.freeze({ minor: 1, heavy: 1.5 });
export const TRAP_HP_FLOOR = 1;
export const TRAP_ELEMENT = "physical";

export function normalizeTier(tier) {
  const t = String(tier ?? "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(TRAP_TIERS, t) ? t : "minor";
}

export function trapBase(level, tier = "minor") {
  const L = Math.max(0, Math.floor(Number(level) || 0));
  return Math.floor((5 + Math.floor(L / 4)) * TRAP_TIERS[normalizeTier(tier)]);
}

// Party Level = the highest member level (PCs level together; a stray low
// number on one sheet must not soften every trap). No usable level → 5.
export function partyLevel(levels) {
  const ok = (levels ?? []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  return ok.length ? Math.max(...ok) : 5;
}

// One member's on-screen row from a (dry-run) applyDamage record.
//   rec: { finalValue, affinity, preAffinityBreakdown, hp:{from,to}, shield:{from,to} }
export function describeHit(rec, max) {
  const before = Math.max(0, Number(rec?.hp?.from) || 0);
  const after = Math.max(0, Number(rec?.hp?.to) || 0);
  const maxHp = Math.max(1, Number(max) || 1);
  const shieldUsed = Math.max(0, (Number(rec?.shield?.from) || 0) - (Number(rec?.shield?.to) || 0));
  const hpLoss = Math.max(0, (Number(rec?.finalValue) || 0) - shieldUsed);
  const flat = (rec?.preAffinityBreakdown ?? []).find((s) => s?.step === 3);
  const aff = String(rec?.affinity ?? "").toUpperCase();
  return {
    before,
    after,
    max: maxHp,
    shown: before - after,
    dr: Math.max(0, Math.round(Number(flat?.sub) || 0)),
    resisted: aff === "RS",
    immune: aff === "IM",
    held: before > 0 && before - hpLoss < TRAP_HP_FLOOR,
    crisisCross: before > maxHp / 2 && after <= maxHp / 2,
  };
}

// HP bar colour band (same thresholds as the battle HP bar): ok / crisis / low.
export function hpBand(current, max) {
  const f = (Number(current) || 0) / Math.max(1, Number(max) || 1);
  return f > 0.5 ? "ok" : f > 0.25 ? "crisis" : "low";
}

globalThis.DungeonPathing ??= {};
globalThis.DungeonPathing.TrapRules = Object.freeze({
  TRAP_TIERS, TRAP_HP_FLOOR, TRAP_ELEMENT, normalizeTier, trapBase, partyLevel, describeHit, hpBand,
});
