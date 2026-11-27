// ============================================================================
// Contest Check — pure rules (no Foundry calls; node-testable)
//
// File: scripts/check-requester/cr-contest-logic.js
// Tests: scripts/check-requester/cr-contest-logic.test.mjs
//
// A Contest (Fabula Ultima core p.48 "Opposed Checks"): every side performs a
// Check with no Difficulty Level and the highest Result wins.
//   - A draw is repeated by the sides that tied (only those).
//   - A fumble is the LOWEST possible Result, a critical success the HIGHEST.
//     Two crits (or two fumbles) between the top sides count as a draw.
//   - Opportunities happen as normal (handled by the orchestrator).
// House rules agreed with the user (2026-11-27, mockup rounds 1-5):
//   - D1 the side that is BEHIND answers first (invoke or accept); an answer that
//     changes the standings re-opens the window for everyone behind.
//   - D2 ties: reroll until there is a winner (no cap).
//   - D3 clock margin: 1 section for winning, +1 at 3+, +2 at 6+;
//     a win by critical (or against a fumble) counts as the 6+ tier.
//   - A tie reroll is a NEW Check: Trait / Bond open again.
//   - Result sting priority per client: own side -> party's result -> winner.
//
// A "side" here is a plain object:
//   { a, b, mods: [{value}], out?, accepted?, party?: bool, mine?: bool }
// ============================================================================
(function (root) {
  const num = (v, fb = 0) => { const n = Number(v); return Number.isFinite(n) ? n : fb; };

  const hasRolled = (s) => s && s.a != null && s.b != null;
  const isCrit = (s) => hasRolled(s) && s.a === s.b && s.a >= 6 && !(s.a === 1 && s.b === 1);
  const isFumble = (s) => hasRolled(s) && s.a === 1 && s.b === 1;
  const modTotal = (s) => (s?.mods ?? []).reduce((t, m) => t + num(m?.value), 0);
  const total = (s) => num(s?.a) + num(s?.b) + modTotal(s);

  // Opposed ranking: a fumble is the lowest possible Result, a crit the highest.
  // Two crits compare EQUAL (a draw), whatever their totals (core p.48).
  const CRIT_SCORE = 1e6, FUMBLE_SCORE = -1e6;
  const score = (s) => (isFumble(s) ? FUMBLE_SCORE : isCrit(s) ? CRIT_SCORE : total(s));

  const liveIdx = (sides) => sides.map((s, i) => (s.out ? -1 : i)).filter((i) => i >= 0);
  const allRolled = (sides) => liveIdx(sides).every((i) => hasRolled(sides[i]));

  /** Index of the single side with the strictly highest score, or -1 on a tie for first. */
  function leaderIndex(sides) {
    const L = liveIdx(sides);
    if (!L.length) return -1;
    const top = Math.max(...L.map((i) => score(sides[i])));
    const tops = L.filter((i) => score(sides[i]) === top);
    return tops.length === 1 ? tops[0] : -1;
  }

  /** The live sides tied for first (empty when there is a sole leader). */
  function tiedForFirst(sides) {
    if (leaderIndex(sides) !== -1) return [];
    const L = liveIdx(sides);
    const top = Math.max(...L.map((i) => score(sides[i])));
    return L.filter((i) => score(sides[i]) === top);
  }

  /**
   * Who answers next: every live side that is not the sole leader, WORST first,
   * skipping sides that accepted since the last change and sides with nothing to
   * spend. `hasOptions(i)` tells whether side i can still invoke anything.
   * Returns an index or null (= nobody left to answer: resolve).
   */
  function nextAnswerer(sides, hasOptions) {
    const lead = leaderIndex(sides);
    const cand = liveIdx(sides).filter((i) => i !== lead && !sides[i].accepted && hasOptions(i));
    cand.sort((x, y) => score(sides[x]) - score(sides[y]) || x - y);
    return cand.length ? cand[0] : null;
  }

  /** After side `by` changed its result, everyone else may answer again. */
  function reopenAfterChange(sides, by) {
    sides.forEach((s, i) => { if (i !== by) s.accepted = false; });
  }

  /** The best-placed live side other than `w` (the runner-up), or null. */
  function runnerUp(sides, w) {
    const rest = liveIdx(sides).filter((i) => i !== w).sort((x, y) => score(sides[y]) - score(sides[x]) || x - y);
    return rest.length ? rest[0] : null;
  }

  /** Margin tier over the runner-up: 0, 1 (beat by 3+) or 2 (6+ / crit / opponent fumbled). */
  function marginTier(winner, runner) {
    if (!winner || !runner) return 0;
    if (isCrit(winner) || isFumble(runner)) return 2;
    const d = total(winner) - total(runner);
    return d >= 6 ? 2 : d >= 3 ? 1 : 0;
  }
  /** Raw margin (winner total minus runner-up total); null when a crit / fumble decided it. */
  function margin(winner, runner) {
    if (!winner || !runner) return null;
    if (isCrit(winner) || isFumble(runner)) return null;
    return total(winner) - total(runner);
  }
  /** Clock sections the winner moves: 1 for winning + the tier (core p.53 conflict rule). */
  const clockSections = (tier) => 1 + Math.max(0, Math.min(2, num(tier)));

  /**
   * Final placings of the live sides, best first. Sides sharing a score share a place.
   * -> [{ index, place }]
   */
  function placings(sides) {
    const L = liveIdx(sides).sort((x, y) => score(sides[y]) - score(sides[x]) || x - y);
    const out = []; let place = 0, prev = null;
    L.forEach((i, k) => { const sc = score(sides[i]); if (sc !== prev) { place = k + 1; prev = sc; } out.push({ index: i, place }); });
    return out;
  }

  /**
   * After a tie for first: the tied sides reroll, every other live side is out.
   * Mutates and returns the tied indices.
   */
  function beginRerollRound(sides) {
    const tied = tiedForFirst(sides);
    sides.forEach((s, i) => {
      if (tied.includes(i)) { s.a = null; s.b = null; s.accepted = false; s.usedTrait = false; s.usedBond = false;
        s.mods = (s.mods ?? []).filter((m) => !m.perCheck); }
      else if (!s.out) s.out = true;
    });
    return tied;
  }

  /**
   * Result sting for ONE client (each client plays only its own):
   *   1. the client controls a side in the contest   -> that side's result
   *   2. else a party member is in the contest       -> the party's result
   *      (any party member won = "winner")
   *   3. else (NPC vs NPC)                           -> "winner"
   * The GM is treated as an observer (rule 2/3): the GM controls every NPC, so
   * rule 1 would always side with the NPCs. Pass mine:false for every side on a GM.
   * sides[i] = { mine: bool, party: bool }, winner = index.
   */
  function stingFor(sides, winner) {
    const ws = sides[winner];
    if (sides.some((s) => s.mine)) return ws?.mine ? "winner" : "loser";
    if (sides.some((s) => s.party)) return ws?.party ? "winner" : "loser";
    return "winner";
  }

  /**
   * Team side: the member with the best dice rolls (sum of the two die sizes,
   * then the flat modifier, then the first listed).
   * members = [{ id, dA, dB, mod }] -> id
   */
  function pickTeamRoller(members) {
    const list = (members ?? []).filter(Boolean);
    if (!list.length) return null;
    let best = list[0];
    for (const m of list.slice(1)) {
      const a = num(m.dA) + num(m.dB), b = num(best.dA) + num(best.dB);
      if (a > b || (a === b && num(m.mod) > num(best.mod))) best = m;
    }
    return best.id;
  }

  /** Per-side attributes: the side's own override, else the shared default (RAW: same Check for all). */
  function sideAttrs(shared, side) {
    const up = (v) => String(v ?? "").trim().toUpperCase();
    const A = up(side?.attrA) || up(shared?.attrA) || "DEX";
    const B = up(side?.attrB) || up(shared?.attrB) || A;
    return { attrA: A, attrB: B };
  }

  /** A silent contest: roll every live side with rollFn, reroll tied-for-first sides until a winner. */
  function runSilent(sides, rollFn, maxRounds = 50) {
    let rounds = 0;
    while (rounds < maxRounds) {
      rounds++;
      for (const i of liveIdx(sides)) { const s = sides[i]; if (s.a == null) s.a = rollFn(i, "a"); if (s.b == null) s.b = rollFn(i, "b"); }
      if (leaderIndex(sides) !== -1) break;
      beginRerollRound(sides);
    }
    return { winner: leaderIndex(sides), rounds };
  }

  const api = {
    hasRolled, isCrit, isFumble, total, modTotal, score, liveIdx, allRolled,
    leaderIndex, tiedForFirst, nextAnswerer, reopenAfterChange, runnerUp,
    marginTier, margin, clockSections, placings, beginRerollRound, stingFor,
    pickTeamRoller, sideAttrs, runSilent,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) { root.ONI = root.ONI || {}; root.ONI.ContestLogic = api; }
})(typeof globalThis !== "undefined" ? globalThis : this);
