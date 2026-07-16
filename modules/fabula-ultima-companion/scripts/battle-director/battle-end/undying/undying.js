// Battle-End Undying interception — "the boss refuses to die".
//
// A sibling of the follow-up registry (battle-followup.js) with a different
// contract: a follow-up starts a NEW conflict after a won battle; an undying
// rule REVIVES a downed battle-ender mid-pipeline and RESUMES the same
// conflict (same round numbering, same dCombat instance, no PREP re-entry).
//
// Flow:
//   builtin reactor (rule-owned, e.g. geist-blackest-night.js) sees the boss
//   hit 0 HP with its revive condition met → registers a PENDING CLAIM here →
//   collapses the remaining adds → side-wipe latches → FSM reaches
//   BATTLE_ENDING → runBattleEndSequence calls evaluateUndying() BEFORE
//   evaluateFollowups() and before the victory prompt → the claim's rule runs
//   its cinematic (the fake victory + rise), applies the restore, un-latches
//   dCombat, and sets ctx.pendingUndying → states.js routes INTERNAL_DONE to
//   ctx.pendingUndying.resumeAt (TURN_START / ROUND_START) instead of STOPPED.
//
// The pending claim lives in a world setting (bdUndyingState, registered in
// director-boot.js) so it survives an F5 between the trigger and the
// BATTLE_ENDING pickup. Per-battle escalation counters are the RULE's concern
// (kept on director.ctx — battle-scoped by construction), not stored here.
//
// Scope note: built for Geist's "Zero Power: The Blackest Night" and kept
// deliberately small. Like the Wandering Flame entrance, anything generic
// (a battle-ender actor flag, a data-driven undying table) is a future
// refactor — keep this file free of boss-specific logic so that refactor
// stays a re-wire.

import { log, warn } from "../../logger.js";

const MODULE_ID     = "fabula-ultima-companion";
const SETTING_STATE = "bdUndyingState";

// id → rule. A rule is { id, label?, run(endCtx, claim) → { handled } | null }.
// Registered once at boot (director-boot.js `ready`).
const _rules = new Map();

export function registerUndyingRule(rule) {
  if (!rule?.id || typeof rule.run !== "function") {
    warn("[Undying] registerUndyingRule: rule needs an id and a run()");
    return;
  }
  _rules.set(rule.id, rule);
  log(`[Undying] registered rule "${rule.id}"`);
}
export function listUndyingRules() { return Array.from(_rules.values()); }

// ─── Pending claim (world-setting, F5-safe) ──────────────────────────────

function readState() {
  try { return foundry.utils.duplicate(game.settings.get(MODULE_ID, SETTING_STATE) ?? {}); }
  catch { return {}; }
}
async function writeState(state) {
  try { await game.settings.set(MODULE_ID, SETTING_STATE, state); }
  catch (e) { warn("[Undying] writeState failed", e); }
}

export function getPendingClaim() {
  return readState().pending ?? null;
}
export async function setPendingClaim(claim) {
  const s = readState();
  s.pending = claim ?? null;
  await writeState(s);
}
export async function clearPendingClaim() {
  const s = readState();
  if (!s.pending) return;
  s.pending = null;
  await writeState(s);
}

// Dev toggle: lean/sim battles normally revive INLINE (no cinematic) so
// automated playtests never block on visuals. The Test Battle tool launches
// lean, which makes the cinematic impossible to preview — this flag forces
// the full claim → BATTLE_ENDING → cinematic path even in lean mode.
// GM: FUCompanion.api.experimental.battleDirector.undying.forceCinematic(true)
export function isForceCinematic() {
  return !!readState().forceCinematic;
}
export async function setForceCinematic(on) {
  const s = readState();
  s.forceCinematic = !!on;
  await writeState(s);
  log(`[Undying] forceCinematic=${!!on}`);
  return !!on;
}

// ─── Battle-End hook ─────────────────────────────────────────────────────
//
// Called by the orchestrator BEFORE the victory prompt and BEFORE follow-up
// evaluation. Returns { handled: true } when a claim was consumed and the
// battle is resuming — the orchestrator must then skip the entire victory
// pipeline (prompt, FX, summary, transition, resource reset) AND leave the
// reward snapshots in place: the battle isn't over, the real Battle-End will
// still need them.

export async function evaluateUndying(endCtx) {
  if (endCtx?.outcome !== "victory") return null;
  const claim = getPendingClaim();
  if (!claim?.ruleId) return null;

  const rule = _rules.get(claim.ruleId);
  if (!rule) {
    warn(`[Undying] pending claim for unknown rule "${claim.ruleId}" — clearing`);
    await clearPendingClaim();
    return null;
  }

  try {
    const res = await rule.run(endCtx, claim);
    if (res?.handled) {
      log(`[Undying] rule "${claim.ruleId}" handled battle end — resuming conflict`);
      return res;
    }
  } catch (e) {
    warn(`[Undying] rule "${claim.ruleId}" run() threw — falling through to normal battle end`, e);
  }
  // Rule declined or threw: clear the claim so it can't wedge every
  // subsequent battle end, and let the normal victory pipeline proceed.
  await clearPendingClaim();
  return null;
}
