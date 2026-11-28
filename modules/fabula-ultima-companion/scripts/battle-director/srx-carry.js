// Pure rules for the GM desk's sectioned reaction view (gm-desk.js, "srx").
// No Foundry, no DOM: node-testable (srx-carry.test.mjs).
//
// Bug #17 (2026-11-28): a reaction asked twice on the same creature in quick
// succession (two hits → creature_lose_resource twice → Painful Lesson twice)
// re-spawned on the same desk key inside the close grace. The second ask took
// the first ask's "skipped" set, so every row read Skipped, "0 to answer", no
// Skip all — and its onPass was never called, so the battle waited forever.

/** One reaction row's identity inside a creature's menu. */
export const srxKeyOf = (c) => `${c?.carrierUuid}::${c?.rowKey}`;

/**
 * Is this spawn the same menu re-opening after a Use (Apply)? Only then does the
 * creature's record (what was applied, what was skipped) carry over. `prev` is
 * the entry last listed on this key; a Use leaves `pending` set on it (the
 * reaction that was being applied). A Pass, or a menu that simply closed, does
 * not — a spawn after those is a NEW ask and starts clean.
 */
export function srxIsUseReopen(prev) {
  return !!prev?.srx && !!prev.pending;
}

/**
 * The history + skipped set a freshly spawned entry starts with.
 * A Use re-open keeps both; the Use in flight landed if its reaction is no
 * longer offered (one still offered was cancelled or aborted, and stays
 * answerable). Anything else starts fresh.
 */
export function srxCarryOver(prev, candidates) {
  if (!srxIsUseReopen(prev)) return { history: [], skipped: new Set() };
  const offered = (candidates ?? []).some((c) => srxKeyOf(c) === srxKeyOf(prev.pending));
  return {
    history: [...(prev.history ?? []), ...(offered ? [] : [{ c: prev.pending, status: "Applied" }])],
    skipped: new Set(prev.skipped ?? []),
  };
}

/** What a creature can still answer: not automatic, not unusable, not skipped. */
export function srxOpenRows(e) {
  const dis = e?.disabled, sk = e?.skipped;
  return (e?.candidates ?? []).filter((c) => {
    const k = srxKeyOf(c);
    return c?.mode !== "on" && !(dis?.get?.(k)) && !(sk?.has?.(k));
  });
}

/**
 * Safety net: an entry nobody can answer must not sit there. With no row left
 * to Skip or Apply and a Pass to give, the only possible answer is that Pass,
 * so the desk gives it. Not while a Use is in flight, and not for a creature a
 * live player is deciding on their own screen (their client answers).
 */
export function srxNeedsAutoPass(e, { theirs = false } = {}) {
  if (!e || e.closed || e.busy || e.pending || theirs) return false;
  if (typeof e.onPass !== "function") return false;
  return srxOpenRows(e).length === 0;
}
