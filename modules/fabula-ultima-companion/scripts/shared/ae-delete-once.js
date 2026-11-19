/**
 * deleteEffectsOnce — delete Active Effects without double-deleting.
 *
 * Two writers can see the same effect at once and both ask the server to delete
 * it: the first wins, the second gets Foundry's red "ActiveEffect <id> does not
 * exist!" toast. Crisis is the known case: crisis-reactor (battle settle) and
 * derived-status's safety net (updateActor hook) both remove Crisis when a heal
 * lifts a creature out of it, on the same client, in the same frame.
 *
 * This skips any id that is already gone from the actor or that another caller
 * is deleting right now. A caller that skips an in-flight id still waits for that
 * delete to finish, so whatever it does next sees the committed state.
 *
 * Returns the ids THIS call deleted.
 */

// key `${actor.uuid}|${effectId}` → Promise of the delete that owns it
const _inFlight = new Map();

function keyOf(actor, id) { return `${actor?.uuid ?? actor?.id ?? "?"}|${id}`; }

export async function deleteEffectsOnce(actor, ids, options = {}) {
  if (!actor?.deleteEmbeddedDocuments) return [];
  const wanted = [...new Set((ids ?? []).filter(Boolean))];
  const mine = [], waitFor = [];
  for (const id of wanted) {
    const k = keyOf(actor, id);
    const pending = _inFlight.get(k);
    if (pending) { waitFor.push(pending); continue; }
    if (!actor.effects?.has?.(id)) continue;      // already gone
    mine.push(id);
  }
  let own = null;
  if (mine.length) {
    own = actor.deleteEmbeddedDocuments("ActiveEffect", mine, options);
    const settled = own.catch(() => {});
    for (const id of mine) _inFlight.set(keyOf(actor, id), settled);
    settled.finally(() => {
      for (const id of mine) {
        const k = keyOf(actor, id);
        if (_inFlight.get(k) === settled) _inFlight.delete(k);
      }
    });
  }
  if (waitFor.length) await Promise.all(waitFor);
  if (own) await own;                              // surface real errors to the caller
  return mine;
}

// Test hook.
export function _inFlightCount() { return _inFlight.size; }
