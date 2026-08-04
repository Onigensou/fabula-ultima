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
  // Crush keyword ("Damage Dealt by this action cannot be Reduce"): skip any
  // axis that would LOWER the value. Axes that RAISE it (VU, a >1 mult) still
  // apply — "cannot be reduced" is not "cannot be increased".
  noReduction = false,
} = {}) {
  let v = value;
  let classCode = ignoreAffinity ? null : classAffinityCode(actor, damageClass);
  // Crush steps the damage-CLASS affinity down one level too (same ladder).
  if (noReduction && classCode) {
    const stepped = crushAffinity(classCode);
    classCode = stepped === "NE" ? null : stepped;
  }
  if (classCode) v = applyAffinityToDamage(v, classCode);
  const absorbed = elementAbsorbed || classCode === "AB";
  if (!absorbed) {
    const mult = _num(actor?.flags?.[FLAG_NS]?.damage_taken_mult, 1);
    if (mult > 0 && mult !== 1 && !(noReduction && mult < 1)) v = Math.ceil(v * mult);
  }
  return { value: Math.max(0, Math.ceil(v)), absorbed };
}

// Crush steps the target's affinity DOWN exactly ONE level on the ladder
//   NE < RS < IM < AB
// so AB→IM, IM→RS, RS→NE, and NE stays NE (the floor). VU sits BELOW NE and is
// never touched: Crush strips defence, it does not create vulnerability.
// This is a partial bypass by design — a Crush hit on an Immune target is still
// Resistant (halved), not full damage.
const CRUSH_STEP_DOWN = Object.freeze({ AB: "IM", IM: "RS", RS: "NE" });
export function crushAffinity(code) {
  return CRUSH_STEP_DOWN[String(code ?? "").toUpperCase()] ?? code;
}

// Does this keyword list carry Crush? Keywords reach the ruleset from three
// places (an item's own `action_keywords` prop, an `apply_action_keyword`
// reaction, or a `deal_damage` row's `damage_keywords`), so normalise here.
export function hasCrush(keywords) {
  return normalizeKeywords(keywords).includes("crush");
}

// Shared normaliser for the three keyword sources above.
function normalizeKeywords(keywords) {
  if (!keywords) return [];
  const list = Array.isArray(keywords) ? keywords : String(keywords).split(/[,\n]/);
  return list.map((k) => String(k).trim().toLowerCase()).filter(Boolean);
}

// ── Affinity bypass (spell text: "damage dealt by this spell ignores
//    Resistances", and Numen Attack's "…Resistances and Immunities") ─────────
// DISTINCT FROM CRUSH. Crush steps down exactly one rung, so a Crush hit on an
// Immune target is still Resistant. "Ignores Resistances" is a CLAMP, not a
// step: any defence up to the named rung collapses straight to NE, and anything
// above it is untouched (ignoring Resistance says nothing about Immunity).
// Crush also skips DR; a bypass does not — it only speaks to affinity.
//
// Ladder NE(0) < RS(1) < IM(2) < AB(3); VU sits below NE and is never touched
// (a bypass strips defence, it must not cancel a vulnerability).
//
// Authored as an inherent `action_keywords` entry, so it needs no new template
// column and also works from a reaction's `apply_action_keyword` or a
// deal_damage row's `damage_keywords`.
const AFFINITY_RANK = Object.freeze({ NE: 0, RS: 1, IM: 2, AB: 3 });
const BYPASS_KEYWORD_RANK = Object.freeze({
  ignore_resistance: 1,   // RS -> NE
  ignore_immunity: 2,     // RS, IM -> NE  (implies resistance)
  ignore_absorption: 3,   // RS, IM, AB -> NE
});

// Highest bypass rank present in the list (0 = none).
export function affinityBypassRank(keywords) {
  let rank = 0;
  for (const k of normalizeKeywords(keywords)) {
    const r = BYPASS_KEYWORD_RANK[k];
    if (r > rank) rank = r;
  }
  return rank;
}

// Collapse the target's affinity to NE when it sits at or below `rank`.
export function bypassAffinity(code, rank) {
  if (!rank) return code;
  const c = String(code ?? "").toUpperCase();
  const r = AFFINITY_RANK[c];
  if (r === undefined || r === 0) return code;   // NE / VU / unknown untouched
  return r <= rank ? "NE" : code;
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
  // Action keywords in play for this hit. Only `crush` affects the incoming
  // ruleset today — Keyword Repository: "Damage Dealt by this action cannot be
  // Reduce and ignore immunity". It therefore skips DR (flat + %), a reducing
  // weapon-efficiency, and steps the affinity down ONE rung (see crushAffinity —
  // AB→IM→RS→NE, so Crush into Immune is still Resistant) — while leaving VU and
  // any damage-INCREASING axis untouched. Shields are NOT bypassed: they are a
  // separate resource band consumed in applyDamageToTarget, not a reduction.
  // For the CLAMP semantics of "ignores Resistances", see bypassAffinity.
  keywords = null,
} = {}) {
  const breakdown = [];
  let v = Math.max(0, Math.ceil(_num(base)));
  const crush = hasCrush(keywords);
  const bypassRank = affinityBypassRank(keywords);

  // 1) Damage reduction (flat + %).
  if (!ignoreDR && !crush) {
    const red = resolveIncomingReduction({ actor, elementType: element, range, raw: v });
    v = red.value;
    if (red.parts?.length) breakdown.push(...red.parts);
  }

  // 1b) Weapon efficiency — the target's per-weapon-type multiplier (the INCOMING
  //     twin of element affinity, applied BEFORE it to match the legacy order).
  //     Inert without a weapon family (spells / MP / effect damage).
  if (!ignoreAffinity) {
    const effPct = readWeaponEfficiency(actor, weaponType);
    // Crush ignores an efficiency that would REDUCE; a >100% one still applies.
    if (effPct !== 100 && !(crush && effPct < 100)) {
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
  let elementCode = ignoreAffinity ? "NE" : resolveAffinity(actor, element);
  // Crush: step the element affinity down one level (AB→IM→RS→NE, floor NE).
  // Note AB→IM cancels the absorb, so `elementAbsorbed` below reads false and
  // the hit stops healing the target — but it lands as 0 (Immune), not full.
  if (crush) elementCode = crushAffinity(elementCode);
  // Affinity bypass ("ignores Resistances"). AFTER crush so the two compose in
  // the order the text implies: step down, then collapse what the bypass covers.
  elementCode = bypassAffinity(elementCode, bypassRank);
  v = applyAffinityToDamage(v, elementCode);

  // 3) Damage-class affinity + 4) universal multiplier — via the shared helper so
  //    the attack path (action-profile) applies them identically.
  const cm = applyClassAffinityAndMult(actor, v, {
    damageClass, ignoreAffinity, elementAbsorbed: elementCode === "AB",
    noReduction: crush,
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
