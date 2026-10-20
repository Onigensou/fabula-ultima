"use strict";
//
// Mindscape — run one Encounter Matrix line the way the Matrix does: the line's
// conflict-event mix (lib/dungeon-events.js) splits the runs, and the monster rules
// decide whether monsters play from their own tables (lib/monster-data.js).
//
// Shared by the Matrix, the per-monster report, the balance proposals and the Balance
// Board, so the four can never disagree about how a fight is set up.

const { runBattle } = require("./engine");
const { Rng } = require("./rng");
const { resolveEvent } = require("./conflict-events");

// `events`: [{ id, share }] as the Matrix stores it on a line (null id = no event).
// `onResult(result, eventId, i)` sees every battle; the return is { all, byEvent }.
function runLine({ party, enemies, events = null, runs, seed, expectedRounds = 7, policy = "standard",
  monsterRules = "data", statusLibrary = null, summons = null, keepLog = false, onResult = null }) {
  const mix = events?.length ? events : [{ id: null, share: 1 }];
  const all = [];
  const byEvent = {};
  let i = 0;
  mix.forEach((e, k) => {
    const n = k === mix.length - 1 ? runs - i : Math.round(runs * e.share);
    const ev = e.id ? resolveEvent(e.id) : null;
    const part = [];
    for (let j = 0; j < n; j++, i++) {
      const r = runBattle({ party, enemies, rng: new Rng(`${seed}:${i}`), expectedRounds, policy,
        monsterRules, statusLibrary, summons, conflictEvent: ev });
      if (onResult) onResult(r, e.id ?? null, i);
      if (!keepLog) delete r.log;
      part.push(r);
    }
    all.push(...part);
    byEvent[e.id ?? "none"] = { share: e.share, results: part };
  });
  return { all, byEvent };
}

module.exports = { runLine };
