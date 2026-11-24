// Deferred damage-reaction follow-ups: the registry the RESOLVE hits loop and
// every damage / HP-loss write share.
//
// The RESOLVE hits loop collects each target's damage-reaction follow-ups (Life
// Charm's fall-and-revive, Survivor's Crest's mark, Ninja Log's marker, Earthen
// Wire's redirect) instead of awaiting them inside the loop, and runs them after
// it. While such a collector is OPEN, a token's chain is "pending": its HP write
// is in, but the rest of its reaction (the heal, the once-only spend marker) is
// not. Any other damage or HP loss that reaches that token in the meantime (a
// post_damage rider such as Burning Hand > Fling, a redirect from another
// target's chain, the same creature hit again by this action) would read a
// half-reacted creature and fire its once-only save a second time.
//
// The rule, kept at the write paths themselves (applyDamageToTarget, the
// deal_damage and reversed-heal callers that read the HP before it, an HP
// consume_resource, the hits loop): BEFORE any damage or HP loss lands on a
// token with pending follow-ups, run that token's pending chains first. That is
// the order the inline path had (the chain ran before anything else could
// touch the creature), so a pending chain never sees a second hit before it
// finishes.
//
// Pure (no Foundry): node tests use the real module.

import { warn } from "./logger.js";

// Open collectors (arrays of entries). One per resolving action; a Set so a
// nested or overlapping resolve (never expected) still finds its own entries.
const _open = new Set();

// Entry = { tokenUuid, actorUuid, targetName, aeNames, run }.
function matches(d, tokenUuid, actorUuid) {
  if (!d) return false;
  if (tokenUuid && d.tokenUuid && d.tokenUuid === tokenUuid) return true;
  if (actorUuid && d.actorUuid && d.actorUuid === actorUuid) return true;
  return false;
}

async function runOne(d) {
  try { await d.run(); }
  catch (e) { warn(`deferred follow-ups: damage-reaction follow-up on ${d?.targetName || d?.tokenUuid || "?"} threw`, e); }
}

// A new, open collector (an array the hits loop passes as `deferFollowUps`).
export function openFollowUpCollector() {
  const list = [];
  _open.add(list);
  return list;
}

// Close it: later writes no longer look at it. Entries still in it are NOT run
// here; the owner runs them (runCollectedFollowUps) before closing.
export function closeFollowUpCollector(list) {
  _open.delete(list);
}

// Is any follow-up pending for this token / actor?
export function hasPendingFollowUps({ tokenUuid = null, actorUuid = null } = {}) {
  if (!_open.size || (!tokenUuid && !actorUuid)) return false;
  for (const list of _open) if (list.some((d) => matches(d, tokenUuid, actorUuid))) return true;
  return false;
}

// Run this token's pending follow-ups now (in collection order), taking them
// out of their collector first so nothing runs twice and a chain that reaches
// its own creature does not wait for itself. Returns null when nothing is
// pending (callers skip the await: no extra tick on the common path), else a
// promise that settles once they have all run. A throwing chain is logged and
// the rest still run.
export function flushPendingFollowUpsFor({ tokenUuid = null, actorUuid = null } = {}) {
  if (!_open.size || (!tokenUuid && !actorUuid)) return null;
  const take = [];
  for (const list of _open) {
    for (let i = 0; i < list.length;) {
      if (matches(list[i], tokenUuid, actorUuid)) take.push(list.splice(i, 1)[0]);
      else i++;
    }
  }
  if (!take.length) return null;
  return (async () => { for (const d of take) await runOne(d); })();
}

// Run every entry of a collector, one at a time, in order. Entries are taken
// one by one (not all up front), so a chain that damages another target of the
// action (a redirect) still finds that target's pending chain in the collector
// and runs it first. A throwing chain is logged and the next one still runs.
export async function runCollectedFollowUps(list) {
  if (!Array.isArray(list)) return;
  while (list.length) await runOne(list.shift());
}

// The battle ended or the director stopped: forget every open collector, so a
// RESOLVE cut off mid-flight (its finally never reached) cannot leave a chain
// "pending" into the next conflict, where a write on that creature would run a
// stale chain first. Entries are dropped, not run. Returns how many collectors
// were open.
export function resetFollowUpRegistry() {
  const n = _open.size;
  _open.clear();
  return n;
}

// tests
export function _openCollectorCount() { return _open.size; }
