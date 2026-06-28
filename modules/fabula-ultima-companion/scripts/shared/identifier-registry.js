/*:
 * @target Foundry VTT v12
 * @plugindesc [ONI] Shared identifier registry — single source of truth for the
 *             "actor-state" formula vocabulary that BOTH the reaction/BD
 *             evaluators and the Active-Effect value evaluator consume.
 *
 * File: modules/fabula-ultima-companion/scripts/shared/identifier-registry.js
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * The game has three formula contexts, each historically with its OWN copy of
 * the actor-state vocabulary (STATUS_COUNT et al.):
 *
 *   1. AE change values   — CSB mathjs + active-effect-syntax-extender.js
 *                           (function helpers: ae("Wet"), countAe(...))
 *   2. passive_* + legacy  — window["oni.ReactionFormula"] (formula-evaluator.js)
 *   3. BD reactions       — buildSkillResolver (skill-formulas.js)
 *
 * "Count my debuffs" was implemented THREE times, with DIFFERENT logic — the
 * reaction path classified via inferCategory only (1 path) while the BD path
 * used a 4-path superset; they returned different numbers for the same actor
 * (the TARGET_STATUS_COUNT under-report class of bug). This registry is the
 * single resolver all three delegate to, so the shared "state" vocabulary can
 * never drift again.
 *
 * ── SCOPE MODEL ─────────────────────────────────────────────────────────────
 * Identifiers are tagged with a scope:
 *   - "state" : a pure function of the actor's CURRENT state (no event needed).
 *               Computable in ALL three contexts — these are what we sync here.
 *   - "event" : needs a trigger payload (DAMAGE_DEALT, the trigger subject…).
 *               Meaningless at AE-derivation time; stays reaction-only.
 *
 * Only "state" identifiers are exposed to the AE value evaluator. This module
 * deliberately has NO static imports (it reads the AEM classifier off the
 * global FUCompanion api) so it can load first and never create an import
 * cycle. It self-registers on globalThis["oni.IdentifierRegistry"]; consumers
 * read it from there with a fail-soft fallback to their own legacy logic.
 */

const FLAG_NS = "fabula-ultima-companion";

// RAW FU Status Effects — the six conditions any AE can apply, recognised by
// their canonical Foundry status IDs so an AE with `statuses: ["weak"]`
// (regardless of provenance) counts. Mirrors the set in skill-formulas.js;
// this module is now the canonical home.
const RAW_DEBUFF_STATUSES = new Set([
  "weak", "dazed", "shaken", "slow", "enraged", "poisoned",
]);

// Canonical debuff counter — the SUPERSET of the two prior implementations:
//   - skill-formulas.countStatusDebuffs (4 classification paths), PLUS
//   - formula-evaluator._countStatusesOnActor (which also skipped isSuppressed).
// A non-disabled, non-suppressed AE counts as a debuff if ANY of:
//   1. AEM inferCategory(eff) === "debuff"
//   2. flags[FLAG_NS].category === "debuff"
//   3. system.tags includes "debuff"
//   4. statuses[] contains a RAW FU debuff status id
function countDebuffs(actor) {
  if (!actor?.effects) return 0;
  const effects = Array.from(actor.effects);
  const aem = globalThis.FUCompanion?.api?.activeEffectManager;
  let count = 0;
  for (const eff of effects) {
    if (eff.disabled || eff.isSuppressed) continue;
    // 1. AEM classifier (case-insensitive — the two legacy callers disagreed
    //    on "debuff" vs "Debuff", a latent parity bug this normalises away).
    let aemCat = null;
    try { aemCat = aem?.inferCategory?.(eff); } catch {}
    if (String(aemCat ?? "").toLowerCase() === "debuff") { count++; continue; }
    // 2. Explicit module flag.
    const flagCat = eff.flags?.[FLAG_NS]?.category;
    if (String(flagCat ?? "").toLowerCase() === "debuff") { count++; continue; }
    // 3. system.tags array contains "debuff".
    const tags = eff.system?.tags;
    if (Array.isArray(tags) && tags.includes("debuff")) { count++; continue; }
    // 4. statuses[] contains a RAW FU debuff status id.
    const statuses = eff.statuses;
    if (statuses && typeof statuses[Symbol.iterator] === "function") {
      for (const s of statuses) {
        if (RAW_DEBUFF_STATUSES.has(String(s).toLowerCase())) { count++; break; }
      }
    }
  }
  return count;
}

// The shared "state" vocabulary. Each resolve(actor, payload) returns a number.
// Add a row here once → it is available in AE values, passive formulas, and BD
// reactions, provably consistently.
const STATE_IDENTIFIERS = {
  STATUS_COUNT: {
    scope: "state",
    resolve: (actor) => countDebuffs(actor),
    desc: "Count of debuff-classified active effects on the actor (non-disabled, non-suppressed).",
  },
};

const stateIdentifierNames = Object.keys(STATE_IDENTIFIERS);

// Resolve a registered STATE identifier to a number. Returns `undefined` for an
// unknown / non-state name so callers can fall through to their own dispatch.
function resolveState(name, actor, payload = null) {
  const entry = STATE_IDENTIFIERS[name];
  if (!entry || entry.scope !== "state") return undefined;
  try {
    const v = Number(entry.resolve(actor, payload));
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

// Parity probe — compares the registry's direct value against the live
// reaction evaluator (oni.ReactionFormula) for every state identifier on a
// given actor. The BD resolver (skill-formulas) is ESM-only and is checked
// separately by the bridge probe. Returns { NAME: { direct, reaction, match } }.
function parityProbe(actor) {
  const out = {};
  const rf = globalThis["oni.ReactionFormula"];
  for (const name of stateIdentifierNames) {
    const direct = resolveState(name, actor, null);
    let reaction = null;
    try {
      reaction = Number(rf?.evaluate?.(name, { reactorActor: actor }));
      if (!Number.isFinite(reaction)) reaction = null;
    } catch { reaction = null; }
    out[name] = { direct, reaction, match: direct === reaction };
  }
  return out;
}

const registry = {
  version: 1,
  RAW_DEBUFF_STATUSES,
  countDebuffs,
  STATE_IDENTIFIERS,
  stateIdentifierNames,
  resolveState,
  parityProbe,
};

// Self-register on the global so the IIFE syntax-extender and the reaction/BD
// evaluators can all reach the SAME resolver without an import graph.
globalThis["oni.IdentifierRegistry"] = registry;

export { countDebuffs, STATE_IDENTIFIERS, stateIdentifierNames, resolveState, parityProbe, registry };
