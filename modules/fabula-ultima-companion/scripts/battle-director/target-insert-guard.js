// scripts/battle-director/target-insert-guard.js
//
// Leaf guard for the routes that INSERT a creature into an action's target
// list after the first pick (redirect_target, shield_redirect, add_target) at the
// slot-write / destination-picker side. NOT every route: the performer-side add_target
// (skill-effects.js ~:6236) relies on the target-pool filter instead.
// A creature carrying `cannot_be_targeted_by: any` (a Guest, e.g. Kalina; see
// out-of-play.js) must never be added or swapped in by any of them.
//
// The action's own performer may always be put back on its own action (Mirror
// reflecting a Guest's spell onto the Guest = "self").

import { hasUnconditionalTargetBlock, unconditionalTargetBlockReason, isTargetBlockedFor } from "./snapshot.js";
import { isNoxServant } from "./nox-servant.js";
import { classifyActionIntent } from "./skill-intent.js";
import { log, warn } from "./logger.js";

// ── B5: Nox Servant opponent rule (docs/nidhogg-boss-design.md §4c item 7) ──────
// Return a refusal string to block the insertion, or null to allow it.
// A Nox Servant can never be PUT ONTO:
//   - any HARMFUL action, an ally's included (Protect / cover / redirect / splash), and
//   - any action performed by an OPPONENT (isTargetBlockedFor, fail closed).
// Allies' support actions may still target it (those never go through here as harmful).
// opts.performerActor: pre-resolved performer (tests / callers that have it).

/** "Harmful" = an Attack, or ar.actionIntent === "harmful", or (no intent stamped) it deals damage. */
export function actionIsHarmful(ar) {
  if (!ar) return false;
  const intent = String(ar.actionIntent ?? "").trim().toLowerCase();
  if (intent) return intent === "harmful";
  return String(ar.kind ?? "") === "Attack" || !!ar.hasDamage;
}

function performerActorOf(ar, opts) {
  if (opts?.performerActor) return opts.performerActor;
  const uuid = ar?.attackerActorRef ?? ar?.attacker?.actorUuid ?? null;
  if (!uuid) return null;
  try { return globalThis.fromUuidSync?.(uuid) ?? null; } catch (_) { return null; }
}

export function insertionOpponentRule(targetActor, ar, opts = {}) {
  const name = targetActor?.name ?? "Target";
  if (isNoxServant(targetActor) && actionIsHarmful(ar)) {
    return `${name} cannot take a harmful action onto themselves`;
  }
  const performer = performerActorOf(ar, opts);
  const disp = ar?.attacker?.disposition;
  if (isTargetBlockedFor(targetActor, performer, {
    attackerDisp: disp ?? undefined, attackerTokenUuid: ar?.attacker?.tokenUuid ?? null,
    targetTokenUuid: opts?.tokenUuid ?? null, dCombat: opts?.dCombat ?? null,
  })) {
    return `${name} cannot be targeted by this action`;
  }
  return null;
}

/** The action's performer? (actor uuid match, or token uuid match when given). */
export function isActionPerformer(targetActor, ar, tokenUuid = null) {
  const uuid = targetActor?.uuid;
  if (uuid && ar?.attackerActorRef && ar.attackerActorRef === uuid) return true;
  if (tokenUuid && ar?.attacker?.tokenUuid && ar.attacker.tokenUuid === tokenUuid) return true;
  return false;
}

/**
 * Can `targetActor` be inserted into `ar`'s targets?
 * @returns {{ok: boolean, reason: string|null}}  reason is player-facing when refused.
 * opts.tokenUuid: the inserted token, for the performer check.
 */
export function canInsertTarget(targetActor, ar, opts = {}) {
  if (!targetActor) return { ok: false, reason: "Target unresolved" };
  // A Nox Servant never takes ANY harmful action onto itself, its own reflected one
  // (Mirror) included: this runs BEFORE the performer carve-out (Kalina's stays for non-Servants).
  if (isNoxServant(targetActor) && actionIsHarmful(ar)) {
    return { ok: false, reason: `${targetActor.name ?? "Target"} cannot take a harmful action onto themselves` };
  }
  if (isActionPerformer(targetActor, ar, opts.tokenUuid ?? null)) return { ok: true, reason: null };
  if (hasUnconditionalTargetBlock(targetActor)) {
    return { ok: false, reason: `${targetActor.name ?? "Target"} cannot be targeted (${unconditionalTargetBlockReason(targetActor) ?? "untargetable"})` };
  }
  const opp = insertionOpponentRule(targetActor, ar, opts);
  if (opp) return { ok: false, reason: String(opp) };
  return { ok: true, reason: null };
}

// ── Offer filter ───────────────────────────────────────────────────────────────
// Which creature does this row put onto the action, when that is statically the reactor?
// Returns true for redirect_target (no destination_ref, or dest = a `self` targeting row) and
// add_target (target_ref "self" or a `self` targeting row). Torment-style pick destinations and
// Grappled splash (grappled_by_self) are NOT static: the slot-write backstop covers them.
export function insertionTargetIsReactor(row, rows) {
  const kind = String(row?.effect_kind ?? "").trim().toLowerCase();
  const isSelf = (ref) => {
    const r = String(ref ?? "").trim();
    if (r === "self") return true;
    const t = (rows ?? []).find((x) => String(x?.effect_label ?? "").trim() === r && String(x?.effect_kind ?? "").toLowerCase() === "targeting");
    return !!t && String(t.candidate_source ?? "").trim().toLowerCase() === "self";
  };
  if (kind === "redirect_target") {
    const d = String(row?.destination_ref ?? "").trim();
    return !d || isSelf(d);
  }
  if (kind === "add_target") return isSelf(row?.target_ref);
  return false;
}

/**
 * OFFER side: remove from `cardReactions` (in place) every candidate whose unconditional chain
 * would put a blocked creature (the reactor) onto this action. No pill, no charge spent.
 * Returns the dropped candidates. Mirrors card-mutations.dropNegatesForMassive.
 */
export async function dropBlockedInsertions(ar, cardReactions, deps = null) {
  const dropped = [];
  if (!Array.isArray(cardReactions) || !cardReactions.length) return dropped;
  const cm = deps ?? await import("./card-mutations.js");   // deps = test seam
  let arx = ar;
  if (ar && !String(ar.actionIntent ?? "").trim() && ar.skillUuid && typeof globalThis.fromUuid === "function") {
    try {
      const skill = await globalThis.fromUuid(ar.skillUuid);
      if (skill) arx = { ...ar, actionIntent: classifyActionIntent(skill) };
    } catch (_) { /* fall through to kind/hasDamage */ }
  }
  for (let i = cardReactions.length - 1; i >= 0; i--) {
    const cand = cardReactions[i];
    if (!cand?.reactorActorUuid) continue;
    try {
      const table = await cm.readCandidateEffectTable(cand);
      if (!table) continue;
      const rows = cm.expandCandidateEffectChain(table, cand.ref);
      if (!rows.some((r) => insertionTargetIsReactor(r, Object.values(table)))) continue;
      const reactor = await globalThis.fromUuid(cand.reactorActorUuid).catch(() => null);
      if (!reactor) continue;
      const g = canInsertTarget(reactor, arx, {});
      if (g.ok) continue;
      dropped.unshift(cand);
      cardReactions.splice(i, 1);
      log(`target-insert-guard: ${cand.carrierName ?? cand.carrierUuid} not offered (${g.reason})`);
    } catch (e) { warn("dropBlockedInsertions threw", e); }
  }
  return dropped;
}
