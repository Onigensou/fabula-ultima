/**
 * Canonical BD INCOMING-damage ruleset — pure, display-free, FSM-agnostic.
 *
 * Produces the post-affinity `{ damage, affinity }` that applyDamageToTarget
 * (the BD commit) consumes — the same shape action-profile produces for attacks.
 * This lets non-attack damage (deal_damage / Burn, hazard tiles, …) compute the
 * BD way and commit through the single BD-supervised path, instead of borrowing
 * the Gen-2 universal core (apply-damage-core) which drags in legacy display.
 *
 * Scope = the TARGET-side (incoming) layer. The attacker-side OUTGOING layer
 * (sheet damage bonuses, weapon efficiency, crit) is attack-specific and stays
 * upstream (action-profile for attacks; the deal_damage formula bakes the base
 * for effects). So the incoming ruleset is, in order:
 *
 *   1. Damage reduction        (flat + %, resolveIncomingReduction — BD-native)
 *   2. Element affinity        (RS/VU/IM/AB + status-forced VU — snapshot, BD-native)
 *   3. Damage-class affinity    (strike/magic flags — ported from apply-damage-core 9c;
 *                               inert for element-only effect damage)
 *   4. Universal damage_taken_mult (incoming-only, skipped on heal — ported 9d)
 *
 * Mirrors apply-damage-core's order so a migrated deal_damage lands identically
 * (verified by a parity harness). Either affinity layer flipping to AB yields a
 * heal (direction "recover"); applyDamageToTarget reads affinity==="AB".
 */
import { resolveIncomingReduction } from "./skill-formulas.js";
import { resolveAffinity, applyAffinityToDamage, readWeaponEfficiency } from "./snapshot.js";

const FLAG_NS = "fabula-ultima-companion";
function _num(v, d = 0) { const n = Number(v); return Number.isFinite(n) ? n : d; }

// Damage-class affinity flag ("" | RS | VU | IM | AB). Null when no class or
// no flag — element-only effect damage (deal_damage) passes no class, so this
// is inert there but keeps the ruleset complete for any classed caller.
function classAffinityCode(actor, damageClass) {
  if (!damageClass) return null;
  const key = damageClass === "strike" ? "affinity_class_strike"
            : damageClass === "magic"  ? "affinity_class_magic"
            : null;
  if (!key) return null;
  const raw = actor?.flags?.[FLAG_NS]?.[key] ?? null;
  return (raw === "RS" || raw === "VU" || raw === "IM" || raw === "AB") ? raw : null;
}

// Shared tail of the incoming-damage ruleset: (3) damage-class affinity
// (strike/magic) + (4) the universal damage_taken_mult. Exported so the BD ATTACK
// path (action-profile) applies the SAME two axes as the effect ruleset — one
// source of truth, the damage-unification reconciliation. `damage_taken_mult` is a
// pure AE accumulator (seeded to 1 before AEs apply in ActiveEffectFormulaBridge),
// so multiple sources compose via MULTIPLY-mode changes (two ×2 items → ×4).
// Returns the post-class, post-mult value and whether damage was absorbed (element
// OR class flipped to AB → heal downstream).
export function applyClassAffinityAndMult(actor, value, {
  damageClass = null,
  ignoreAffinity = false,
  elementAbsorbed = false,
} = {}) {
  let v = value;
  const classCode = ignoreAffinity ? null : classAffinityCode(actor, damageClass);
  if (classCode) v = applyAffinityToDamage(v, classCode);
  const absorbed = elementAbsorbed || classCode === "AB";
  if (!absorbed) {
    const mult = _num(actor?.flags?.[FLAG_NS]?.damage_taken_mult, 1);
    if (mult > 0 && mult !== 1) v = Math.ceil(v * mult);
  }
  return { value: Math.max(0, Math.ceil(v)), absorbed };
}

export function computeIncomingDamage(actor, {
  base = 0,
  element = "elementless",
  range = null,
  ignoreDR = false,
  ignoreAffinity = false,
  damageClass = null,
  // Weapon family ("sword" / "sword_ef" / …) for the weapon-efficiency axis.
  // null / "none" → inert (effect damage, spells, MP). Gated under ignoreAffinity
  // alongside the other affinity axes.
  weaponType = null,
} = {}) {
  const breakdown = [];
  let v = Math.max(0, Math.ceil(_num(base)));

  // 1) Damage reduction (flat + %).
  if (!ignoreDR) {
    const red = resolveIncomingReduction({ actor, elementType: element, range, raw: v });
    v = red.value;
    if (red.parts?.length) breakdown.push(...red.parts);
  }

  // 1b) Weapon efficiency — the target's per-weapon-type multiplier (the INCOMING
  //     twin of element affinity, applied BEFORE it to match the legacy order).
  //     Inert without a weapon family (spells / MP / effect damage).
  if (!ignoreAffinity) {
    const effPct = readWeaponEfficiency(actor, weaponType);
    if (effPct !== 100) {
      const before = v;
      v = Math.ceil(v * (effPct / 100));
      if (v !== before) breakdown.push({ source: `Weapon efficiency ${effPct}%`, amount: v - before });
    }
  }

  // 1c) Additive per-element damage bump (Invoker "Hex" etc.) — added BEFORE affinity
  //     so VU/RS + class + mult scale it (RAW: the +N is part of the elemental damage,
  //     so a VU target takes double the bonus, an IM target takes +0, an AB target
  //     absorbs it). The flag is already summed across all AEs by seedAeAccumulators +
  //     ADD-mode changes, so this is a single lookup. Gated under !ignoreAffinity
  //     alongside the other elemental axes (true/typeless damage ignores it).
  if (!ignoreAffinity) {
    const inc = _num(actor?.flags?.["fabula-ultima-companion"]?.[`damage_taken_increased_${element}`], 0);
    if (inc > 0) {
      v += inc;
      breakdown.push({ source: `Vulnerable +${inc} (${element})`, amount: inc });
    }
  }

  // 2) Element affinity (+ status-forced VU). RS/VU/IM applied here; AB/NE
  //    leave the value untouched (AB heals downstream).
  const elementCode = ignoreAffinity ? "NE" : resolveAffinity(actor, element);
  v = applyAffinityToDamage(v, elementCode);

  // 3) Damage-class affinity + 4) universal multiplier — via the shared helper so
  //    the attack path (action-profile) applies them identically.
  const cm = applyClassAffinityAndMult(actor, v, {
    damageClass, ignoreAffinity, elementAbsorbed: elementCode === "AB",
  });
  v = cm.value;
  const absorbed = cm.absorbed;

  return {
    damage: Math.max(0, Math.ceil(v)),
    // applyDamageToTarget flips to heal on "AB"; surface the effective code.
    affinity: absorbed ? "AB" : elementCode,
    direction: absorbed ? "recover" : "loss",
    breakdown,
  };
}
