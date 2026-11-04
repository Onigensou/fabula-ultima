// ============================================================================
// Conflict Event System — when the battle-start line is shown.
//
// The Conflict Event panel (conflict-event-panel.js) can introduce the scene's
// event with a one-line label as the Battle Start plate clears. Shown on every
// battle it turns into noise, so it is shown:
//
//   • the first time each event comes up on a TRIP into a dungeon, and
//   • always, when any enemy is a Champion (a boss battle).
//
// A trip starts when the party's scene becomes a `dungeon` scene coming from
// one that isn't (a town, the world map), and when more than TRIP_GAP_MS has
// passed since the last introduced battle — the gap between two sessions. A
// battle, a cutscene or a camp inside the dungeon does not end a trip: those
// scene modes leave the trip as it is.
//
// The state is one small world-setting object the GM writes. This module only
// computes; it is PURE (no Foundry globals) so conflict-event-intro.test.mjs
// runs in bare Node.
// ============================================================================

/** More than this between two introduced battles starts a new trip (a new session). */
export const TRIP_GAP_MS = 6 * 60 * 60 * 1000;

/** Scene modes that put the party inside a dungeon. */
const ENTER_MODES = new Set(["dungeon"]);
/** Scene modes that take the party out of one. Everything else leaves the trip alone. */
const LEAVE_MODES = new Set(["exploration", "none"]);

/** A fresh, or repaired, trip state. */
export function normalizeTrip(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  return {
    inDungeon: s.inDungeon === true,
    trip: Number.isFinite(Number(s.trip)) ? Math.max(0, Math.floor(Number(s.trip))) : 0,
    shown: Array.isArray(s.shown) ? s.shown.map(String).filter(Boolean) : [],
    lastBattleAt: Number.isFinite(Number(s.lastBattleAt)) ? Number(s.lastBattleAt) : 0,
  };
}

/** The trip state after the party's scene changes to one in `sceneMode`. */
export function stepTrip(raw, sceneMode) {
  const s = normalizeTrip(raw);
  const mode = String(sceneMode ?? "").trim() || "none";
  if (ENTER_MODES.has(mode)) {
    return s.inDungeon ? s : { ...s, inDungeon: true, trip: s.trip + 1, shown: [] };
  }
  if (LEAVE_MODES.has(mode)) return s.inDungeon ? { ...s, inDungeon: false } : s;
  return s;
}

/**
 * Should this battle introduce `eventId`? Returns the answer and the state to
 * write back. A Champion battle introduces even an event already shown.
 */
export function decideIntro(raw, { eventId, champion = false, now = Date.now(), gapMs = TRIP_GAP_MS } = {}) {
  let s = normalizeTrip(raw);
  const id = String(eventId ?? "").trim();
  if (s.lastBattleAt && now - s.lastBattleAt > gapMs) s = { ...s, trip: s.trip + 1, shown: [] };
  if (!id) return { introduce: false, state: s };
  const seen = s.shown.includes(id);
  return {
    introduce: !!champion || !seen,
    state: { ...s, shown: seen ? s.shown : [...s.shown, id], lastBattleAt: now },
  };
}

/**
 * Is this actor a Champion? The same reading as director-combat.js readRank:
 * `npc_rank` (or `rank`) as text, else a `champion` checkbox prop.
 */
export function isChampionActor(actor) {
  const props = actor?.system?.props ?? null;
  if (!props) return false;
  const direct = props.npc_rank ?? props.rank;
  if (typeof direct === "string") {
    const r = direct.trim().toLowerCase();
    if (r === "champion" || r === "elite" || r === "soldier") return r === "champion";
  }
  const v = props.champion;
  return v === true || v === "true" || v === 1 || v === "1";
}
