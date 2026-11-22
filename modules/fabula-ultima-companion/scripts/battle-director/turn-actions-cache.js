// ============================================================================
// Turn-order tracker cache (pure, no Foundry imports; tested in Node).
//
// Every client remembers the last turn-actions list it rendered or broadcast.
// A player who joins or reloads mid-battle asks the ACTIVE GM for it
// (FU_DIRECTOR_TURNACTIONS_GET) instead of waiting for the next broadcast.
// executeAsGM reaches the active GM, which is not necessarily the director
// host, so the cache lives on every client, cleared when the tracker clears.
// ============================================================================

let _last = null;
let _gen = 0;  // bumps on every set/clear, so a late pull can tell it was overtaken

export function setTurnActionsCache(list) {
  _gen++;
  _last = Array.isArray(list) ? list : null;
}
export function clearTurnActionsCache() { _gen++; _last = null; }
export function turnActionsCacheGen() { return _gen; }
// Handler body for FU_DIRECTOR_TURNACTIONS_GET: the list, or null (no live battle).
export function getTurnActionsCache() { return _last; }

// A pulled list is worth rendering when it is non-empty and nothing newer
// (a broadcast, or a battle-end clear) arrived while the request was in flight.
export function shouldRenderPulled(list, genAtAsk) {
  return Array.isArray(list) && list.length > 0 && genAtAsk === _gen;
}
