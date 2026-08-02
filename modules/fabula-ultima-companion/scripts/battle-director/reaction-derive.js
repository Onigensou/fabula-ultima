// ── Reactive reaction-list core ────────────────────────────────────────────
//
// The action-card reaction list must update itself as the card's state changes
// — not just re-gate a frozen candidate set, but ADD candidates that only become
// eligible after another reaction completes (cascades). Canonical case: accepting
// Crossfire (negates a ranged attack) makes Bullet Break eligible, which should
// appear as a new pill in the SAME panel.
//
// This module is the pure-ish core of that: a `creature_completes_skill` ledger
// of skills that have completed on the card → re-derive the cascade candidates
// from it → diff against what's already shown → the caller patches the DOM. The
// sequencing / diff / convergence logic is pure and unit-testable; the single
// matching step delegates to an INJECTED `findPassiveCandidates` + actor resolver
// so the whole thing can be exercised via the test-bridge without a live card.
//
// Convergence: a candidate, once shown/resolved, is recorded in `firedKeys` and
// never re-derived — so a cascade (A enables B enables C…) terminates instead of
// re-offering settled reactions on every state change.

// Stable identity for a reaction candidate across re-derives. A candidate is the
// same offer iff it's the same row, on the same carrier, for the same reactor.
export function candidateKey(c) {
  return `${c?.rowKey ?? "?"}:${c?.carrierUuid ?? "?"}:${c?.reactorActorUuid ?? "?"}`;
}

// Diff two candidate lists by identity. { added, removed } relative to prev→next.
export function diffCandidates(prev, next) {
  const prevKeys = new Set((prev ?? []).map(candidateKey));
  const nextKeys = new Set((next ?? []).map(candidateKey));
  return {
    added: (next ?? []).filter((c) => !prevKeys.has(candidateKey(c))),
    removed: (prev ?? []).filter((c) => !nextKeys.has(candidateKey(c))),
  };
}

// Build the `creature_completes_skill` payload for one completed-skill ledger
// entry, forwarding the card's attack context so downstream gates resolve:
//   - sourceSkillName / sourceActorUuid  → reaction_source_skill + reaction_source:self
//   - attackerActorUuid / attackerTokenUuid → trigger_attacker target + the free
//                                              attack's only target
//   - checkTotal → ATTACK_CHECK_RESULT (even-number gate)
//   - weaponRange → ATTACK_IS_RANGED
export function buildCompletionPayload(entry, cardCtx) {
  return {
    sourceSkillName:   entry?.skillName ?? null,
    sourceActorUuid:   entry?.reactorActorUuid ?? null,
    sourceTokenUuid:   entry?.reactorTokenUuid ?? null,
    attackerActorUuid: cardCtx?.attackerActorUuid ?? null,
    attackerTokenUuid: cardCtx?.attackerTokenUuid ?? null,
    checkTotal:        cardCtx?.checkTotal ?? null,
    weaponRange:       cardCtx?.weaponRange ?? null,
    actionKind:        cardCtx?.actionKind ?? "Attack",
  };
}

// Re-derive cascade candidates from the completed-skill ledger.
//   ledger:    [{ reactorActorUuid, reactorTokenUuid, skillName }]
//   cardCtx:   { attackerActorUuid, attackerTokenUuid, checkTotal, weaponRange, actionKind }
//   firedKeys: iterable of candidateKeys already shown/resolved (convergence)
//   deps:      { findPassiveCandidates, resolveActorByUuid }
// Returns a flat, deduped array of candidates, each tagged with the reactor
// identity + the payload it was derived against (`payloadAtFire`, threaded to the
// applier so trigger_attacker / ATTACK_* resolve at fire time).
export async function deriveCascadeCandidates({ ledger, cardCtx, firedKeys, deps } = {}) {
  const out = [];
  const seen = new Set(firedKeys ?? []);
  if (!deps?.findPassiveCandidates || !deps?.resolveActorByUuid) return out;
  for (const entry of ledger ?? []) {
    const reactor = await deps.resolveActorByUuid(entry?.reactorActorUuid);
    if (!reactor) continue;
    const payload = buildCompletionPayload(entry, cardCtx);
    let cands = [];
    try {
      cands = await deps.findPassiveCandidates({
        casterActor: reactor,
        trigger: "creature_completes_skill",
        payload,
      });
    } catch (_) { cands = []; }
    for (const c of cands ?? []) {
      const tagged = {
        ...c,
        reactorActorUuid: entry?.reactorActorUuid ?? null,
        reactorTokenUuid: entry?.reactorTokenUuid ?? null,
        payloadAtFire: payload,
      };
      const k = candidateKey(tagged);
      if (seen.has(k)) continue;   // convergence: never re-derive a settled offer
      seen.add(k);
      out.push(tagged);
    }
  }
  return out;
}

// Canonical key set for a `creature_targeted_by_action` payload — the CONTRACT
// shared by the TWO places that build one:
//   1. state-handlers CONFIRM  (the initial per-target × per-reactor scan)
//   2. buildTargetedPayload    (mid-card re-derive, below)
//
// Both must produce every key here, because the formula identifiers a
// defender-side reaction can gate on read straight off the payload and FAIL
// CLOSED when a field is missing — a dropped key doesn't error, it silently
// makes the reaction dormant. CONFIRM asserts against this list (dev-warn), so
// the next divergence is a console warning instead of a skill that quietly
// stops working. Add a key here whenever either builder gains one.
export const TARGETED_PAYLOAD_KEYS = Object.freeze([
  "sourceActorUuid", "subjectActorUuid", "subjectTokenUuid", "incomingDamage",
  "targetTokenUuids", "attackerActorUuid", "attackerTokenUuid", "actionIntent",
  "actionKind", "actionName", "sourceSkillName", "checkTotal", "isCrit", "isFumble",
  "weaponRange", "weaponType", "damageType", "defenseResolved",
]);

// Build the `creature_targeted_by_action` payload for ONE subject (a creature
// that just BECAME a target via a mid-card mutation — redirect destination or
// add_target splash). Mirrors the CONFIRM-time scan's payload so the same gates
// resolve: `sourceActorUuid` = the subject (the reaction_source self/ally/enemy
// filter keys off it), plus the attacker + roll context.
//
// `subject.incomingDamage` — the damage THIS subject is now predicted to take,
// read by INCOMING_DAMAGE. Threaded per-subject by the caller from the
// POST-mutation per-target rows (a redirect destination's predicted damage only
// exists after the mutation recomputes). Without it, a "when you take damage"
// reaction (Ninja Log) stayed dormant on a redirected hit while working
// normally on a hit targeted at CONFIRM time — fixed 2026-08-02.
export function buildTargetedPayload(subject, cardCtx) {
  return {
    sourceActorUuid:   subject?.actorUuid ?? null,
    subjectActorUuid:  subject?.actorUuid ?? null,
    subjectTokenUuid:  subject?.tokenUuid ?? null,
    // Per-SUBJECT (everything else here is action-level).
    incomingDamage:    Math.max(0, Number(subject?.incomingDamage ?? 0) || 0),
    targetTokenUuids:  cardCtx?.targetTokenUuids ?? [],
    attackerActorUuid: cardCtx?.attackerActorUuid ?? null,
    attackerTokenUuid: cardCtx?.attackerTokenUuid ?? null,
    actionIntent:      cardCtx?.actionIntent ?? null,
    actionKind:        cardCtx?.actionKind ?? null,
    actionName:        cardCtx?.actionName ?? null,
    // Must mirror CONFIRM's third-party scan — `reaction_source_skill` fails
    // closed without it. Unlike `actionName` this must NOT fall back to the
    // action kind: a blank means "ambient, fire on any action" to the matcher.
    sourceSkillName:   cardCtx?.sourceSkillName ?? null,
    checkTotal:        cardCtx?.checkTotal ?? null,
    isCrit:            cardCtx?.isCrit ?? null,
    isFumble:          cardCtx?.isFumble ?? null,
    weaponRange:       cardCtx?.weaponRange ?? null,
    weaponType:        cardCtx?.weaponType ?? null,
    damageType:        cardCtx?.damageType ?? null,
    // "def" | "mdef" | null — read by ATTACK_VS_DEF / ATTACK_VS_MDEF so a
    // Defense-specific reaction (Verónica's +2 DEF) fires only on attacks its
    // Defense would actually touch. Was absent here, so those gates read 0 for
    // any mid-card new target.
    defenseResolved:   cardCtx?.defenseResolved ?? null,
  };
}

// Re-derive `creature_targeted_by_action` candidates for creatures that just
// BECAME targets mid-card (redirect / add_target). For each new subject, scan
// every reactor (live combatants, minus the action-taker) — this is how a
// creature's own "when I'm targeted" reaction (reaction_source: self) finally
// matches once a redirect makes it the target.
//   newSubjects:  [{ actorUuid, tokenUuid }]  — the creatures now newly targeted
//   reactorActors: live actor docs to scan (caller excludes the action-taker)
//   cardCtx:      { attackerActorUuid, attackerTokenUuid, actionKind, ... }
//   firedKeys:    candidateKeys already shown/resolved — NO-REUSE: a reaction
//                 (rowKey:carrier:reactor) offered once is never re-offered.
//   deps:         { findPassiveCandidates }
// Returns deduped, tagged candidates in the same shape the CONFIRM scan pushes.
export async function deriveTargetedCandidates({ newSubjects, reactorActors, cardCtx, firedKeys, deps } = {}) {
  const out = [];
  const seen = new Set(firedKeys ?? []);
  if (!deps?.findPassiveCandidates) return out;
  const attackerUuid = cardCtx?.attackerActorUuid ?? null;
  for (const subject of newSubjects ?? []) {
    if (!subject?.actorUuid) continue;
    const payload = buildTargetedPayload(subject, cardCtx);
    for (const reactor of reactorActors ?? []) {
      if (!reactor || reactor.uuid === attackerUuid) continue;
      let cands = [];
      try {
        cands = await deps.findPassiveCandidates({
          casterActor: reactor,
          trigger: "creature_targeted_by_action",
          payload,
          includeUnavailable: false,
        });
      } catch (_) { cands = []; }
      for (const c of cands ?? []) {
        const tagged = {
          ...c,
          reactorActorUuid: reactor.uuid,
          reactorActorName: reactor.name,
          reactorActorImg:  reactor.img ?? c.carrierImg,
          reactorIsPlayer:  !!reactor.hasPlayerOwner,
          subjectActorUuid: subject.actorUuid,
          subjectTokenUuid: subject.tokenUuid ?? null,
          payloadAtFire:    payload,
        };
        const k = candidateKey(tagged);
        if (seen.has(k)) continue;   // no-reuse / convergence
        seen.add(k);
        out.push(tagged);
      }
    }
  }
  return out;
}

// Append a completed-skill entry to the ledger if not already present (by
// reactor+skill). Pure helper for the caller's ledger bookkeeping.
export function appendCompletion(ledger, entry) {
  const next = Array.isArray(ledger) ? ledger.slice() : [];
  const has = next.some((e) =>
    e?.reactorActorUuid === entry?.reactorActorUuid && e?.skillName === entry?.skillName);
  if (!has) next.push(entry);
  return next;
}
