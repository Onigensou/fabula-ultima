"use strict";
//
// Mindscape — the utility layer: healing, free-action grants, defensive
// redirects and attack riders.
//
// These are the actions that decide fights and cannot be extracted from a sheet,
// because what they DO is structural. Values below are read from the live
// descriptions and cited; the effects are deliberately ROUGH — this tier exists
// to give a workable model to tune against, not to reproduce the engine.
//
// Ranked by what actually moved round count in live runs
// ([[project_fight_balance_playbook]]): free actions and KO prevention outrank
// raw damage, which is why healing and Acceleration are modelled before
// anything clever.

const R = require("./rules");

// ── Tuning, transcribed from sim/profiles.js ────────────────────────────────
// Same constants, same gates. A diverged value here silently rebuilds the drift
// the transcription exists to prevent, so each cites its source name.
const TUNING = {
  healKoRiskFraction: 0.30,     // an ally at/below this could be KO'd
  healWorthItFraction: 0.60,    // "hurt enough to be worth a heal slot"
  healEmergencyFraction: 0.15,  // ...unless someone is this low, go now
  healMinTargets: 2,            // hold until the cast pays for its slot
  healMaxTargets: 3,            // Heal's own cap
  strongHitFraction: 0.30,      // a hit worth Protecting against
  safeDamageFraction: 0.10,     // "she can take it" ceiling
  protectPerRound: 1,
};

// Heal: "Each target recovers 40 HP. Lv20 -> 50. Lv40 -> 60."
function healAmount(actor) {
  const lvl = Number(actor.level) || 0;
  return lvl >= 40 ? 60 : lvl >= 20 ? 50 : 40;
}

function hpFrac(c) { return c.maxHp ? c.hp / c.maxHp : 1; }

function has(c, name) {
  return c.utility.some((u) => u.name.trim().toLowerCase() === name);
}

// ── Healing ─────────────────────────────────────────────────────────────────
// Gated exactly as profiles.js gates Hina: a LAST RESORT, not a reflex. She
// stays on the offensive while the party still has a defensive answer, and when
// she does heal she tries to make the action pay for itself.
function tryHeal(state, actor) {
  if (!has(actor, "heal")) return null;

  const allies = state.combatants.filter((c) => c.side === actor.side && c.alive);
  const hurt = allies
    .filter((c) => hpFrac(c) < TUNING.healWorthItFraction)
    .sort((a, b) => hpFrac(a) - hpFrac(b));
  if (!hurt.length) return null;

  const critical = hurt.some((c) => hpFrac(c) <= TUNING.healEmergencyFraction);
  const atRisk = hurt.filter((c) => hpFrac(c) <= TUNING.healKoRiskFraction);
  if (!atRisk.length && !critical) return null;
  if (!critical && hurt.length < TUNING.healMinTargets) return null;

  // "10 x T MP" — per target, so only bring as many as can be paid for.
  const affordable = Math.max(0, Math.floor(actor.mp / 10));
  if (affordable < 1) return null;

  const targets = hurt.slice(0, Math.min(TUNING.healMaxTargets, affordable));
  const amount = healAmount(actor.actor);
  actor.mp -= 10 * targets.length;
  for (const t of targets) t.hp = Math.min(t.maxHp, t.hp + amount);

  return { name: "Heal", healed: targets.map((t) => t.name), amount };
}

// ── Acceleration ────────────────────────────────────────────────────────────
// "At the end of each of their turns, the target may perform a free attack."
// A RECURRING grant, not a one-off, which is what makes it the strongest thing
// a caster can do with a quiet turn. Modelled as a persistent +1 turn/round.
//
// Gated on nobody already carrying it: re-casting on an accelerated ally is a
// thrown-away turn (profiles.js accelerationPriority).
const ACCEL_PRIORITY = ["Zarg", "Keren"];   // damage dealers, not the tank

function tryAccelerate(state, actor) {
  if (!has(actor, "acceleration") || actor.mp < 20) return null;

  const allies = state.combatants.filter((c) => c.side === actor.side && c.alive);
  if (allies.some((c) => c.accelerated)) return null;
  if (allies.some((c) => hpFrac(c) < TUNING.healWorthItFraction)) return null;  // heal first

  let target = null;
  for (const want of ACCEL_PRIORITY) {
    target = allies.find((c) => c !== actor && new RegExp(want, "i").test(c.name));
    if (target) break;
  }
  target = target ?? allies.find((c) => c !== actor);
  if (!target) return null;

  actor.mp -= 20;
  target.accelerated = true;
  return { name: "Acceleration", target: target.name };
}

// ── Protect ─────────────────────────────────────────────────────────────────
// A defensive REDIRECT, resolved at damage time rather than on a turn: the
// protector takes the hit instead. Once per round, only on a hit that actually
// hurts, and only when the protector can absorb it without trading one problem
// for another.
//
// KO prevention outranks healing throughput -- one PC going down early
// snowballs into a loss, because the party loses a quarter of its actions while
// taking the same incoming damage.
function findProtector(state, victim, incoming) {
  if (victim.side !== "party") return null;
  if (incoming < victim.maxHp * TUNING.strongHitFraction && incoming < victim.hp) return null;

  return state.combatants.find((c) =>
    c.alive && c.side === "party" && c !== victim &&
    has(c, "protect") &&
    (c.protectedThisRound ?? 0) < TUNING.protectPerRound &&
    // She must be able to take it herself, or the redirect just moves the corpse.
    incoming < c.hp - c.maxHp * TUNING.safeDamageFraction
  ) ?? null;
}

// ── Barrage ─────────────────────────────────────────────────────────────────
// "When you perform a ranged attack, spend 10 MP: the attack gains Multi 2."
// It buys REACH, not just damage, so it fires whenever payable (profiles.js
// barragePolicy). Modelled as +1 target on a weapon attack.
function tryBarrage(actor, action) {
  if (!has(actor, "barrage") || actor.mp < 10) return null;
  if (actor.actor.weapon?.range !== "ranged") return null;
  actor.mp -= 10;
  return { ...action, name: `${action.name} + Barrage`, target: { ...action.target, count: 2 } };
}

// High Speed: 10 MP at conflict start for one free attack. A one-off grant.
function tryHighSpeed(actor) {
  if (!has(actor, "high speed") || actor.mp < 10) return false;
  actor.mp -= 10;
  return true;
}

module.exports = {
  TUNING, healAmount, tryHeal, tryAccelerate, findProtector, tryBarrage, tryHighSpeed, has,
};
