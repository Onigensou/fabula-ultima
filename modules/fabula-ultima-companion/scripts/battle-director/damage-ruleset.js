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
  // Crush keyword ("bypasses Immunity and damage reduction effects"): skip any
  // axis that would LOWER the value, and collapse a class RS/IM/AB to neutral.
  // Axes that RAISE it (VU, a >1 mult) still apply — "cannot be reduced" is not
  // "cannot be increased".
  noReduction = false,
  // Expose keyword: a class defence (RS/IM/AB — e.g. Ghostly's "immune to
  // attacks") drops ONE rung. Unlike the element axis it never goes past
  // neutral: the hit already picks up Expose's VU on the element axis, and a
  // second VU here would double it again (×4 for one keyword).
  expose = false,
} = {}) {
  let v = value;
  let classCode = ignoreAffinity ? null : classAffinityCode(actor, damageClass);
  if (classCode && noReduction) classCode = crushAffinity(classCode);
  if (classCode && expose) classCode = CLASS_EXPOSE_STEP[classCode] ?? classCode;
  if (classCode === "NE") classCode = null;
  if (classCode) v = applyAffinityToDamage(v, classCode);
  const absorbed = elementAbsorbed || classCode === "AB";
  if (!absorbed) {
    const mult = _num(actor?.flags?.[FLAG_NS]?.damage_taken_mult, 1);
    if (mult > 0 && mult !== 1 && !(noReduction && mult < 1)) v = Math.ceil(v * mult);
  }
  return { value: Math.max(0, Math.ceil(v)), absorbed };
}

// ── Crush + Expose (Keyword Repository, user ruling 2026-11-11) ──────────────
// Crush  = "bypasses Immunity and damage reduction effects": every DEFENSIVE
//          affinity (RS, IM, AB) reads as NE, so a Crush hit always deals
//          damage. VU stays VU — Crush strips defence, it never cancels a
//          weakness. (Until 2026-11-11 Crush only stepped ONE rung, AB→IM→RS→NE,
//          so a Crush hit on an Immune target was still halved.)
// Expose = "lower the target's Affinity against this action by one stage":
//          AB→IM, IM→RS, RS→NE, NE→VU; VU is the floor. Same ladder as Element
//          Gorge's aeAffinityStep(-1), but for this action only. Expose does
//          NOT skip damage reduction.
// Both:    Crush first, then Expose — so Crush + Expose = VU against anything.
// Shields are not a reduction: both keywords still hit a Shield first.
const CRUSH_TO_NEUTRAL = Object.freeze({ RS: "NE", IM: "NE", AB: "NE" });
export function crushAffinity(code) {
  return CRUSH_TO_NEUTRAL[String(code ?? "").toUpperCase()] ?? code;
}

const EXPOSE_STEP = Object.freeze({ AB: "IM", IM: "RS", RS: "NE", NE: "VU", NA: "VU", "": "VU", VU: "VU" });
export function exposeAffinity(code) {
  return EXPOSE_STEP[String(code ?? "").toUpperCase()] ?? code;
}
// Class axis (strike/magic) step for Expose — stops at NE (see applyClassAffinityAndMult).
const CLASS_EXPOSE_STEP = Object.freeze({ AB: "IM", IM: "RS", RS: "NE" });

// Does this keyword list carry Crush / Expose? Keywords reach the ruleset from
// four places (an item's own `action_keywords` prop, an `apply_action_keyword`
// reaction, a `deal_damage` row's `damage_keywords`, or an AE's
// `outgoing_action_keywords`), so normalise here.
export function hasCrush(keywords) {
  return normalizeKeywords(keywords).includes("crush");
}
export function hasExpose(keywords) {
  return normalizeKeywords(keywords).includes("expose");
}

// The ONE element-affinity keyword pass, shared by the effect ruleset below and
// the attack path (action-profile) so the card number and the dealt number
// cannot drift: Crush → Expose → the "ignores X" clamps.
export function applyKeywordAffinity(code, keywords) {
  let c = code;
  if (hasCrush(keywords)) c = crushAffinity(c);
  if (hasExpose(keywords)) c = exposeAffinity(c);
  return bypassAffinity(c, affinityBypassRank(keywords));
}

// Keywords an ActiveEffect grants to EVERY damage instance its bearer deals —
// the AE change `{ key: "outgoing_action_keywords", value: "ignore_affinity" }`
// (comma list). A pure change-row marker the engine reads itself, like
// disable_action / max_action_targets: CSB never applies it to a prop. Folded
// into the action's keywords on the card path (action-profile describePrimary)
// and into a deal_damage row's keywords on the effect path (skill-effects), so
// "until the end of this turn, all damage you deal …" is one AE. First user:
// Phantom Strength (ignore_affinity).
export const OUTGOING_KEYWORDS_AE_KEY = "outgoing_action_keywords";
export function aeOutgoingActionKeywords(actor) {
  if (!actor) return [];
  const effects = actor?.appliedEffects
    ? Array.from(actor.appliedEffects)
    : (actor?.effects?.contents ?? actor?.effects ?? []);
  const out = new Set();
  for (const ae of effects) {
    if (!ae || ae.disabled) continue;
    for (const ch of (ae.changes ?? [])) {
      const k = String(ch?.key ?? "").replace(/^system\.props\./, "");
      if (k !== OUTGOING_KEYWORDS_AE_KEY) continue;
      for (const kw of normalizeKeywords(ch.value)) out.add(kw);
    }
  }
  return [...out];
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
  // "…ignore Affinities" (Phantom Strength) — the one member that ALSO
  // neutralises VU: the text ignores affinities as such, not just defences, so
  // the damage lands as if every affinity were NE (a real trade-off vs a
  // Vulnerable target, which is why the skill makes it optional).
  ignore_affinity: 4,     // VU, RS, IM, AB -> NE
});
const IGNORE_ALL_AFFINITY_RANK = 4;

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
  if (rank >= IGNORE_ALL_AFFINITY_RANK && (c === "VU" || AFFINITY_RANK[c] !== undefined)) return "NE";
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
  // Action keywords in play for this hit. `crush` skips DR (flat + %), a
  // reducing weapon-efficiency and a <1 mult, and reads RS/IM/AB as NE; `expose`
  // steps the affinity down one rung (see applyKeywordAffinity). VU and any
  // damage-INCREASING axis are never lowered. Shields are NOT bypassed: they are
  // a separate resource band consumed in applyDamageToTarget, not a reduction.
  // For the CLAMP semantics of "ignores Resistances", see bypassAffinity.
  keywords = null,
} = {}) {
  const breakdown = [];
  let v = Math.max(0, Math.ceil(_num(base)));
  const crush = hasCrush(keywords);

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
  // Crush (defences → NE) → Expose (one rung down) → "ignores X" clamps.
  // ignoreAffinity damage (true/typeless) skips the keyword pass entirely.
  let elementCode = ignoreAffinity ? "NE" : applyKeywordAffinity(resolveAffinity(actor, element), keywords);
  v = applyAffinityToDamage(v, elementCode);

  // 3) Damage-class affinity + 4) universal multiplier — via the shared helper so
  //    the attack path (action-profile) applies them identically.
  const cm = applyClassAffinityAndMult(actor, v, {
    damageClass, ignoreAffinity, elementAbsorbed: elementCode === "AB",
    noReduction: crush, expose: hasExpose(keywords),
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
