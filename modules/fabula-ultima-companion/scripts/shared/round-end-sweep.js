// Which director-applied AEs the round-end sweep removes. Pure (no Foundry), so the
// Boss Cycle's node test can check it; used by skill-effects tickDirectorAEsAtRoundEnd.
//
// A "round_end" AE (stamp lifetimeMode "round_end") lasts until the end of the round.
// When a boss rule CUTS the round (Nidhogg's fall) and carries round effects into the
// next round (boss cycle carryRoundEffects), the sweep runs in `cutRound` mode: only
// AEs flagged `flags.<ns>.endsOnCutRound: true` go — "until the end of the round, or
// until the round is cut short" (Soul Master, ruling 2026-11-19). Unflagged ones carry.
// A normal round end sweeps every round_end AE, flagged or not.
const NS = "fabula-ultima-companion";

export const ENDS_ON_CUT_ROUND_FLAG = "endsOnCutRound";

export function endsOnCutRound(effect) {
  const f = effect?.flags?.[NS] ?? {};
  return f[ENDS_ON_CUT_ROUND_FLAG] === true || f.directorAppliedBy?.[ENDS_ON_CUT_ROUND_FLAG] === true;
}

export function isRoundEndSwept(effect, { cutRound = false } = {}) {
  const stamp = effect?.flags?.[NS]?.directorAppliedBy;
  if (!stamp) return false;
  if (String(stamp.lifetimeMode ?? "").toLowerCase() !== "round_end") return false;
  return cutRound ? endsOnCutRound(effect) : true;
}
