"use strict";
//
// Mindscape — check resolution and the damage pipeline.
//
// Implements docs/mindscape-ruleset.md Parts 1-2. Every step here mirrors a
// named engine source; where this file and the engine disagree, THE ENGINE IS
// RIGHT and this file is the bug.
//
// Deliberately pure: no actor documents, no I/O, no randomness of its own (an
// Rng is passed in). That is what makes it testable against the engine's own
// numbers without standing up a world.

// Attribute die step ladder. Natural range is d6-d12; modifiers can push to a
// d2 floor and a d20 ceiling (project_fu_core_math).
const DIE_LADDER = Object.freeze([2, 4, 6, 8, 10, 12, 14, 16, 20]);

function stepDie(size, steps) {
  const i = DIE_LADDER.indexOf(size);
  if (i < 0) {
    // Not a ladder value — clamp into range rather than guessing a neighbour.
    return Math.max(2, Math.min(20, size));
  }
  return DIE_LADDER[Math.max(0, Math.min(DIE_LADDER.length - 1, i + steps))];
}

// Apply the six die-stepping statuses to a base attribute map.
// Different effects on the same attribute STACK (Dazed + Enraged = INS -2).
// Official status rules floor at d6; other sources can go lower, so the floor is
// applied here only to status-driven steps.
const STATUS_STEPS = Object.freeze({
  isDazed:    ["ins"],
  isShaken:   ["wlp"],
  isSlow:     ["dex"],
  isWeak:     ["mig"],
  isEnraged:  ["dex", "ins"],
  isPoisoned: ["mig", "wlp"],
});

function effectiveAttributes(base, statuses = {}) {
  const steps = { dex: 0, ins: 0, mig: 0, wlp: 0 };
  for (const [flag, attrs] of Object.entries(STATUS_STEPS)) {
    if (!statuses[flag]) continue;
    for (const a of attrs) steps[a] -= 1;
  }
  const out = {};
  for (const k of Object.keys(steps)) {
    const size = base[k];
    if (size == null) { out[k] = null; continue; }
    const stepped = stepDie(size, steps[k]);
    // Status effects never take an attribute below d6.
    out[k] = steps[k] < 0 ? Math.max(6, stepped) : stepped;
  }
  return out;
}

// ── Accuracy check ──────────────────────────────────────────────────────────
// Two dice, sized by two attributes. Result = dieA + dieB + bonus; HR = the
// higher face. Success when Result >= DL (the target's DEF, or MDEF for spells —
// our game unifies both under "Accuracy Check").
//
// Critical: both faces EQUAL and >= 6. Fumble: both faces 1.
function accuracyCheck(rng, { dieA, dieB, bonus = 0, dl }) {
  const a = rng.die(dieA);
  const b = rng.die(dieB);
  const hr = Math.max(a, b);
  const result = a + b + bonus;

  const crit = a === b && a >= 6;
  const fumble = a === 1 && b === 1;

  return {
    a, b, hr, result, crit, fumble,
    // A crit auto-succeeds and a fumble auto-fails, regardless of DL.
    hit: crit ? true : fumble ? false : result >= dl,
  };
}

// ── Damage ──────────────────────────────────────────────────────────────────
// Attacker side: base = HR + damage bonus. Kept separate from the incoming
// pipeline because the two layers live in different engine files and only the
// incoming half is shared between attacks and effect damage.
function outgoingDamage({ hr, damageBonus = 0 }) {
  return Math.max(0, Math.ceil(hr + damageBonus));
}

const AFFINITY_RANK = Object.freeze({ NE: 0, RS: 1, IM: 2, AB: 3 });
const CRUSH_STEP_DOWN = Object.freeze({ AB: "IM", IM: "RS", RS: "NE" });
const BYPASS_KEYWORD_RANK = Object.freeze({
  ignore_resistance: 1,
  ignore_immunity: 2,
  ignore_absorption: 3,
});

// Statuses that FORCE Vulnerable on a specific element, overriding the sheet.
// Mirrors snapshot.js FORCED_VU_BY_STATUS.
const FORCED_VU_BY_STATUS = Object.freeze({
  Wet: "bolt", Oil: "fire", Petrify: "earth",
  Hypothermia: "ice", Turbulence: "air", Zombie: "light",
});

function normalizeKeywords(keywords) {
  if (!keywords) return [];
  const list = Array.isArray(keywords) ? keywords : String(keywords).split(/[,\n]/);
  return list.map((k) => String(k).trim().toLowerCase()).filter(Boolean);
}

function crushAffinity(code) {
  return CRUSH_STEP_DOWN[String(code ?? "").toUpperCase()] ?? code;
}

// "Ignores Resistances" is a CLAMP, not a step: everything at or below the named
// rung collapses to NE. VU sits below NE and is never touched.
function bypassAffinity(code, rank) {
  if (!rank) return code;
  const c = String(code ?? "").toUpperCase();
  const r = AFFINITY_RANK[c];
  if (r === undefined || r === 0) return code;
  return r <= rank ? "NE" : code;
}

function applyAffinityToDamage(damage, code) {
  const base = Math.max(0, Number(damage) | 0);
  switch (code) {
    case "VU": return Math.ceil(base * 2);
    case "RS": return Math.ceil(base / 2);
    case "IM": return 0;
    default:   return base;
  }
}

// Resolve the target's affinity to an element, honouring status-forced VU.
function resolveAffinity(target, element) {
  const el = String(element ?? "physical").toLowerCase();
  let code = target.affinities?.[el] ?? "NE";
  for (const cond of (target.conditions ?? [])) {
    if (FORCED_VU_BY_STATUS[cond] === el) return "VU";
  }
  return code;
}

// ── The incoming pipeline ───────────────────────────────────────────────────
// Order is NORMATIVE and mirrors damage-ruleset.js computeIncomingDamage
// (lines 142-230). The intermediate ceil at each step makes the order
// observable, so this is not a place to simplify into one multiplication.
//
//   0. seed        v = max(0, ceil(base))
//   1. reduction   flat + %          (skipped by Crush)
//   2. weapon EF   ceil(v * pct/100) (BEFORE affinity — this is the easy one
//                                     to get wrong)
//   3. +element    v += bump
//   4. affinity    VU/RS/IM/AB
//   5. class       strike/magic
//   6. mult        ceil(v * damage_taken_mult)
//   7. clamp       max(0, ceil(v))
function incomingDamage(target, {
  base = 0,
  element = "physical",
  weaponFamily = null,
  damageClass = null,
  ignoreAffinity = false,
  ignoreDR = false,
  keywords = null,
} = {}) {
  const breakdown = [];
  let v = Math.max(0, Math.ceil(Number(base) || 0));

  const kw = normalizeKeywords(keywords);
  const crush = kw.includes("crush");
  const bypassRank = kw.reduce((r, k) => Math.max(r, BYPASS_KEYWORD_RANK[k] ?? 0), 0);

  // 1) Damage reduction — flat then percent.
  if (!ignoreDR && !crush) {
    const flat = Number(target.damageReduction?.flat ?? 0) || 0;
    const pct = Number(target.damageReduction?.percent ?? 0) || 0;
    if (flat) { const b = v; v = Math.max(0, v - flat); breakdown.push({ source: `DR flat ${flat}`, amount: v - b }); }
    if (pct)  { const b = v; v = Math.max(0, Math.ceil(v * (1 - pct / 100))); breakdown.push({ source: `DR ${pct}%`, amount: v - b }); }
  }

  // 2) Weapon efficiency — BEFORE element affinity.
  if (!ignoreAffinity && weaponFamily) {
    const fam = String(weaponFamily).toLowerCase().replace(/_ef$/, "");
    const pct = Number(target.efficiency?.[fam] ?? 100) || 100;
    if (pct !== 100 && !(crush && pct < 100)) {
      const b = v;
      v = Math.ceil(v * (pct / 100));
      if (v !== b) breakdown.push({ source: `Weapon efficiency ${pct}%`, amount: v - b });
    }
  }

  // 3) Additive per-element bump — BEFORE affinity, so VU doubles the bonus too.
  if (!ignoreAffinity) {
    const inc = Number(target.damageTakenIncreased?.[element] ?? 0) || 0;
    if (inc > 0) { v += inc; breakdown.push({ source: `Vulnerable +${inc} (${element})`, amount: inc }); }
  }

  // 4) Element affinity.
  let elementCode = ignoreAffinity ? "NE" : resolveAffinity(target, element);
  if (crush) elementCode = crushAffinity(elementCode);
  elementCode = bypassAffinity(elementCode, bypassRank);
  {
    const b = v;
    v = applyAffinityToDamage(v, elementCode);
    if (v !== b) breakdown.push({ source: `Affinity ${elementCode}`, amount: v - b });
  }

  // 5) Damage-class affinity (strike / magic).
  let classCode = ignoreAffinity ? null : (target.classAffinity?.[damageClass] ?? null);
  if (crush && classCode) {
    const stepped = crushAffinity(classCode);
    classCode = stepped === "NE" ? null : stepped;
  }
  if (classCode) v = applyAffinityToDamage(v, classCode);

  const absorbed = elementCode === "AB" || classCode === "AB";

  // 6) Universal incoming multiplier.
  if (!absorbed) {
    const mult = Number(target.damageTakenMult ?? 1) || 1;
    if (mult > 0 && mult !== 1 && !(crush && mult < 1)) v = Math.ceil(v * mult);
  }

  return {
    damage: Math.max(0, Math.ceil(v)),
    affinity: absorbed ? "AB" : elementCode,
    direction: absorbed ? "recover" : "loss",
    breakdown,
  };
}

// Expected damage of an attack against a target, WITHOUT rolling. Used by the
// finisher rule (spec D2) to answer "can this kill?" honestly.
//
// Uses the AVERAGE high roll, never the maximum — an optimistic projection would
// make the party fire finishers it cannot land, which is the one direction the
// model must not err in (Part 6: simplifications read WEAKER).
//
// E[max(dA, dB)] computed exactly rather than approximated; the dice are small
// so the double sum is trivial and there is no reason to use a formula that
// only holds for equal dice.
function expectedHighRoll(dieA, dieB) {
  let total = 0;
  for (let a = 1; a <= dieA; a++) {
    for (let b = 1; b <= dieB; b++) total += Math.max(a, b);
  }
  return total / (dieA * dieB);
}

function projectDamage(target, { dieA, dieB, damageBonus = 0, ...opts }) {
  const hr = expectedHighRoll(dieA, dieB);
  const base = outgoingDamage({ hr, damageBonus });
  return incomingDamage(target, { ...opts, base });
}

module.exports = {
  DIE_LADDER, STATUS_STEPS, FORCED_VU_BY_STATUS,
  stepDie, effectiveAttributes,
  accuracyCheck,
  outgoingDamage, incomingDamage, projectDamage,
  expectedHighRoll, applyAffinityToDamage, resolveAffinity,
  crushAffinity, bypassAffinity, normalizeKeywords,
};
