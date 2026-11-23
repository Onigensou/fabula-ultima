// ============================================================================
// Free-action LOCK gate — a grant that locks a target the performer may not
// target must not be granted (stall hunt 2026-11-23, fix A) and a TARGET step
// that filters a pre-composed pick down to nothing must bounce (fix B).
//
// Pure + zero Foundry imports beyond snapshot.js's own target-block predicates,
// so node tests can drive it. The RULE lives in snapshot.js (`isTargetBlockedFor`,
// `hasUnconditionalTargetBlock` — the same two the target pool builder uses);
// this file only asks them, it does not restate them.
// ============================================================================
import { isTargetBlockedFor, hasUnconditionalTargetBlock } from "./snapshot.js";

const sameActor = (a, b) => !!a && !!b && (a === b || (a.uuid && a.uuid === b.uuid));

/** Is `targetActor` off-limits to `performerActor` — exactly the pool builder's two checks. */
export function isLockedTargetBlocked(targetActor, performerActor, opts = {}) {
  if (!targetActor) return false;                       // unresolved actor: not our call (the pool/TARGET gate still runs)
  if (sameActor(targetActor, performerActor)) return false;   // self carve-out, as in the pool builder
  if (hasUnconditionalTargetBlock(targetActor)) return true;
  return isTargetBlockedFor(targetActor, performerActor, opts);
}

/** Resolved reaction tokens (TokenDocument or Token) -> the first one the performer cannot target, else null. */
export function firstUntargetableToken(tokens, performerActor, { dCombat = null } = {}) {
  for (const t of tokens ?? []) {
    const doc = t?.document ?? t;
    const actor = doc?.actor ?? t?.actor ?? null;
    if (isLockedTargetBlocked(actor, performerActor, { dCombat, targetTokenUuid: doc?.uuid ?? t?.uuid ?? null })) return t;
  }
  return null;
}

/** A locked token uuid looked up in the director roster (sim brain / autopilot, which only hold the uuid). */
export function isLockedUuidBlockedInCombat(tokenUuid, performerActor, dCombat) {
  if (!tokenUuid || !dCombat) return false;
  const c = (dCombat.combatants ?? []).find((x) => (x.tokenUuid ?? x.tokenDoc?.uuid) === tokenUuid);
  if (!c) return false;
  return isLockedTargetBlocked(c.actorDoc ?? c.tokenDoc?.actor ?? null, performerActor, {
    dCombat, targetDisp: c.disposition ?? c.tokenDoc?.disposition, targetTokenUuid: tokenUuid,
  });
}

/** Roster rows the performer may target at all (drops blocked ones). */
export function targetableRows(rows, performerActor, dCombat) {
  return (rows ?? []).filter((c) => !isLockedUuidBlockedInCombat(c.tokenUuid ?? c.tokenDoc?.uuid, performerActor, dCombat));
}

/**
 * Fix B: the TARGET step filtered a (pre-composed) pick against the pool. A
 * non-Self action left with ZERO targets must not go on to COMPUTE/ANIMATION —
 * its script bails before oni:animationStart and the offset gate waits 35 s.
 * A secondary-action skip (`skipped`) legitimately carries no targets.
 */
export function targetsFilteredToNothing({ isSelf, skipped, targets }) {
  return !isSelf && !skipped && (targets?.length ?? 0) === 0;
}

// ── Review pass 2 (2026-11-23) ───────────────────────────────────────────

/**
 * Payload-derived target refs: they read the trigger payload / action card, never prompt and never
 * depend on an earlier step. ONLY these may be resolved by the chain pre-flight (Q2); named
 * targeting rows, pick prompts and reserved pool refs are left to run time.
 */
export const PAYLOAD_TARGET_REFS = Object.freeze(new Set([
  "trigger_subject", "trigger_attacker", "trigger_actor", "cause_actor",
  "action_targets", "hit_action_targets", "ae_applier", "grappled_by_self",
]));
export const isPayloadTargetRef = (ref) => PAYLOAD_TARGET_REFS.has(String(ref ?? "").trim());

/**
 * ONE verdict for a `free_action` row that has a target_ref (Q1 + fix A).
 *  - target_ref set but it resolved to ZERO tokens (a Nox Servant dropped from a direct ref, a
 *    dead pick, ...)  -> refuse: the grant would otherwise be UNLOCKED (any target).
 *  - a resolved token the performer may not target -> refuse.
 * Returns { refuse:false } or { refuse:true, why:"unresolved"|"untargetable", token }.
 * `resolved` is the resolveTargetRef result ({ ok, tokens }).
 */
export function lockedGrantVerdict(resolved, performerActor, { dCombat = null } = {}) {
  const tokens = resolved?.tokens ?? [];
  if (!resolved?.ok || !tokens.length) return { refuse: true, why: "unresolved", token: null };
  const bad = firstUntargetableToken(tokens, performerActor, { dCombat });
  return bad ? { refuse: true, why: "untargetable", token: bad } : { refuse: false };
}

/** Player-facing sentence for a refusal. */
export function refusalMessage(verdict, label, performerActor) {
  if (verdict?.why === "untargetable") {
    const nm = (verdict.token?.document ?? verdict.token)?.name ?? "That target";
    return `${nm} can't be targeted${performerActor?.name ? ` by ${performerActor.name}` : ""}.`;
  }
  // `label` must be a player-facing name; an internal effect_label never reaches a message.
  return `${performerActor?.name ?? "Free action"}: ${label || "free action"} has no valid target.`;
}

/** Player-facing name for a free_action/chain row: never an effect_label (internal id). */
export function grantDisplayName(row, ctx) {
  return row?.menu_label || ctx?.skill?.name || ctx?.sourceSkillName || ctx?.skillName || "Free action";
}

/** The non-GM user who decides for `actor` (null when none). */
export function ownerUserIdForActor(actor) {
  if (!actor) return null;
  const S = globalThis.FUCompanion?.api?.Spectator;
  try { const id = S?.deciderUserIdForActor?.(actor); if (id) return id; } catch (_) { /* fall through */ }
  const cands = (globalThis.game?.users?.contents ?? []).filter((u) => {
    if (u.isGM || !u.active) return false;
    try { return actor.testUserPermission?.(u, "OWNER"); } catch (_) { return false; }
  }).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return cands[0]?.id ?? null;
}

/**
 * Tell the performer's user why a grant/chain was refused (Q3). A human who accepted the reaction
 * otherwise sees nothing. GM-local toast always (the host runs the reaction); a whispered chat line
 * reaches the owning player (there is no cross-client toast helper in the module). Never throws.
 */
export async function notifyGrantRefused(performerActor, message, { sim = false } = {}) {
  const sent = { toast: false, whisper: null };
  if (!message) return sent;
  if (sim) { try { console.log("[FU] free-action refusal (suppressed in sim):", message); } catch (_) { /* ignore */ } return sent; }
  try { const ui = globalThis.ui; if (ui?.notifications?.warn) { ui.notifications.warn(message); sent.toast = true; } } catch (_) { /* ignore */ }
  try {
    const g = globalThis.game;
    const uid = g?.user?.isGM ? ownerUserIdForActor(performerActor) : null;
    const CM = globalThis.ChatMessage;
    if (uid && typeof CM?.create === "function") {
      await CM.create({ content: `<p>${String(message).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]))}</p>`, whisper: [uid], speaker: { alias: "Free action" } });
      sent.whisper = uid;
    }
  } catch (_) { /* ignore */ }
  return sent;
}

/**
 * B1 policy: should a no_eligible inside a free-action frame FORFEIT the free action?
 * Yes when there is no real choice left: a preset grant, a target-locked grant, or an AI performer
 * (autopilot / sim: its re-pick repeats the same lock, so the forfeit is what bounds the loop).
 * No for an open-choice free action driven by a HUMAN: TARGET_BACK -> DECLARE, they choose again.
 */
export function shouldForfeitFreeAction({ grant = null, aiPerformer = false } = {}) {
  return !!(grant?.preset || grant?.lockedTargetTokenUuid || aiPerformer);
}
