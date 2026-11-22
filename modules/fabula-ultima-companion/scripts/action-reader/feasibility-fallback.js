// Pure helper for MatchAndPick's "graceful fallback" (nothing fully feasible).
// Kept import-free so it can be unit-tested in plain Node.

/** A candidate whose OWN target survey ran and found nobody to reach. A missing
 *  or not-ok survey is "no answer", never "unreachable" (fail open). */
export function reachesNobody(candidate) {
  const s = candidate?.targetSurvey;
  return Boolean(s?.ok) && Number(s.available) === 0;
}

/**
 * Pool to pick from when no candidate is fully feasible. `available` must already
 * be past the debuff / HP-reserve / availability gates (never resurrect those).
 * Order of preference:
 *   1. free AND reachable  (an unreachable free action = a wasted "Do Nothing" turn)
 *   2. free                (legacy: so the actor still does something)
 *   3. everything available that the performer can AFFORD (legacy minus cost
 *      shortfalls: an MP/IP-short spell is never committed to — before, CONFIRM
 *      would take the pick and the cast bounced/failed; now no pick = Do Nothing /
 *      GM hand-off)
 * Step 1 only wins when it is non-empty, so a pool with no reachable free action
 * behaves exactly as before.
 */
export function pickFallbackPool(available, isFree) {
  const free = available.filter(isFree);
  const freeReachable = free.filter((c) => !reachesNobody(c));
  const pool = freeReachable.length ? freeReachable : (free.length ? free : available.filter((c) => !isCostShort(c)));
  return { pool, freeCount: free.length, skippedUnreachable: free.length - freeReachable.length };
}

/** A candidate whose resource cost (MP/IP) the performer cannot pay. Set by the
 *  matcher's feasibility pass; a cost shortfall is never a thing to "fall back" to. */
export function isCostShort(candidate) {
  return Boolean(candidate?.costShort);
}

/**
 * Autopilot target resolution with the no-reach retry. The FIRST pick has already
 * been made by the caller with its anti-repeat memory write DEFERRED
 * (`deferMemory`), so a pick that reaches nobody leaves no trace. Resolves targets;
 * while empty, re-picks without the actions that reached nobody (bounded). Only
 * when a pick finally HAS targets is its memory committed (`commit`), so the
 * performed action — and only it — starts its cooldown. A grant consult never
 * retries and never commits (its picks use recordMemory:false).
 * Returns true when ctx holds a chosen action with targets.
 */
export async function resolveTargetsWithRetry(ctx, { pick, resolveTargets, commit, grant = false, log = () => {}, maxTries = 4 }) {
  await resolveTargets(ctx);
  const empty = () => !Array.isArray(ctx.chosenTargets) || !ctx.chosenTargets.length;
  const triedEmpty = [];
  while (!grant && empty() && ctx.chosenAction?.name && triedEmpty.length < maxTries) {
    triedEmpty.push(ctx.chosenAction.name);
    log(`autopilot: "${ctx.chosenAction.name}" reached nobody — re-picking without ${triedEmpty.join(", ")}`);
    ctx.chosenAction = null; ctx.chosenTargets = [];
    await pick(ctx, { excludeActions: triedEmpty, deferMemory: true });
    if (!ctx.chosenAction) break;
    await resolveTargets(ctx);
  }
  if (empty()) return false;
  if (!grant) await commit(ctx);
  return true;
}
