// ═════════ move-engine · shared RESULTS (host-neutral; after shared/moves.js, before family parts)
// ONE shape for "what happened" that a move reads, whoever supplies it:
//   RESULT = { kind, hit, crit, fumble, total, amount, element, affinity, perfect, a, b }   (+ tot / fum aliases)
//     kind     "hit" | "miss" | "block" | "immune" | "absorb" | "lost"
//     hit      the attack landed (hit / immune / absorb)
//     total    the Accuracy Check total (null when unknown)   a, b: the two dice when known
//     amount   the PLANNED damage as the game holds it when the animation starts (reactions already folded in are
//              included, e.g. Gunblade's +10 Fire), element, affinity
//              "weak" | "resist" | "immune" | "absorb" | null
//     perfect  a Chain's Perfect bonus strike
// Who supplies it, in this order:
//   1. the GAME: the Battle Director's real outcome (moveResult / moveStrikes, game runtime);
//   2. a mockup page's RESULT PICKER (movePick(): mockup/result-picker.js);
//   3. the move's own page sliders (the `page` function the move passes).
// A move asks with moveCheck(target, page) for one Accuracy Check, or moveChain(target, n, page) for a Chain's strikes.
// Both log a "result" trace event, so a port check compares what each host decided too.

const RESULT_LANDED = ["hit", "immune", "absorb"];
const AFFINITY_NAME = { VU: "weak", RS: "resist", IM: "immune", AB: "absorb" };
function makeResult(o) {
  o = o || {};
  const fumble = !!(o.fumble || o.fum);
  const kind = o.kind || (fumble || o.hit === false ? "miss" : "hit");
  const total = o.total != null ? Number(o.total) : o.tot != null ? Number(o.tot) : null;
  const affinity = o.affinity ? (AFFINITY_NAME[o.affinity] || (Object.values(AFFINITY_NAME).includes(o.affinity) ? o.affinity : null)) : null;
  const r = { kind, hit: RESULT_LANDED.includes(kind), crit: !!(o.crit || o.isCrit), fumble, total,
    amount: o.amount != null ? Number(o.amount) : null, element: o.element || null, affinity, perfect: !!o.perfect,
    a: o.a != null ? o.a : null, b: o.b != null ? o.b : null, source: o.source || null };
  r.tot = r.total; r.fum = r.fumble;   // the names the approved Sonic Katar moves used
  return r;
}

// The game's Accuracy Check rule (check.js / action-card.js): crit = matching dice of 6 or more, fumble = double 1s
function rollCheck(dA, dB, bonus, def) {
  const a = 1 + Math.floor(Math.random() * dA), b = 1 + Math.floor(Math.random() * dB);
  const fumble = a === 1 && b === 1, crit = !fumble && a === b && a >= 6, total = a + b + (bonus || 0);
  return makeResult({ a, b, total, fumble, crit, hit: !fumble && (crit || total >= def) });
}
// exact odds of that rule over every die face pair
function accOdds(dA, dB, bonus, def) { let h = 0, c = 0, odd = 0, oddHit = 0, n = 0;
  for (let a = 1; a <= dA; a++) for (let b = 1; b <= dB; b++) { n++; const fum = a === 1 && b === 1, crit = !fum && a === b && a >= 6, tot = a + b + bonus, hit = !fum && (crit || tot >= def);
    if (hit) h++; if (crit) c++; if (tot % 2) { odd++; if (hit) oddHit++; } }
  return { hit: h / n, crit: c / n, odd: odd / n, oddHit: oddHit / n }; }
const rollAcc = (dA, dB, bonus, def) => rollCheck(dA, dB, bonus, def);   // the name the approved moves used

// forced Accuracy results, for pages and pickers ("odd" / "even" = the TOTAL's parity, bonus included)
const CHECK_PRESETS = {
  hit: (bonus) => ({ a: 4, b: 5, total: 9 + bonus, hit: true }),
  odd: (bonus) => ((7 + bonus) % 2 ? { a: 3, b: 4, total: 7 + bonus, hit: true } : { a: 4, b: 4, total: 8 + bonus, hit: true }),
  even: (bonus) => ((8 + bonus) % 2 ? { a: 3, b: 4, total: 7 + bonus, hit: true } : { a: 4, b: 4, total: 8 + bonus, hit: true }),
  crit: (bonus) => ({ a: 6, b: 6, total: 12 + bonus, hit: true, crit: true }),
  miss: (bonus) => ({ a: 2, b: 3, total: 5 + bonus, hit: false }),
  fumble: () => ({ a: 1, b: 1, total: 2, hit: false, fumble: true }),
};
const forcedCheck = (name, bonus) => makeResult(Object.assign({ source: "forced" }, (CHECK_PRESETS[name] || CHECK_PRESETS.hit)(bonus || 0)));
// a Chain forced to k landed of n (no crits), the misses placed by the move's seeded jitter
function forcedChain(n, k) { k = Math.max(0, Math.min(n, k)); const idx = new Set(); while (idx.size < k) idx.add(Math.floor(MOVE_RNG() * n));
  return Array.from({ length: n }, (_, i) => makeResult({ hit: idx.has(i), source: "forced" })); }

const traceResult = (what, list) => traceEv("result", { what, list: list.map((r) => r.kind + (r.crit ? "+crit" : "") + (r.perfect ? "+perfect" : "") + (r.total != null ? "@" + r.total : "")) });
// one Accuracy Check for target t. page(): the move's own sliders, as a RESULT-like object. bonus: for picker parity presets
function moveCheck(t, page, bonus) {
  const g = moveResult(t);
  const pick = !g && movePick() && movePick().check;
  const r = g ? makeResult(Object.assign({ source: "game" }, g)) : pick ? forcedCheck(pick, bonus || 0) : makeResult(Object.assign({ source: "page" }, page ? page() : { hit: true }));
  traceResult("check", [r]); return r;
}
// a Chain's strikes on target t: n plain strikes, plus the game's Perfect strike when it planned one (flag perfect).
// page(n): the move's own sliders, an array of RESULT-like objects.
function moveChain(t, n, page) {
  const g = moveStrikes(t);
  const pick = !g.length && movePick() && movePick().chain;
  let list;
  if (g.length) list = g.map((s) => makeResult(Object.assign({ source: "game" }, s)));
  else if (pick != null) { const k = pick === "all" ? n : Math.round(n * Number(pick)); list = forcedChain(n, k); }
  else list = (page ? page(n) : Array.from({ length: n }, () => ({ hit: true }))).map((s) => makeResult(Object.assign({ source: "page" }, s)));
  traceResult("chain", list); return list;
}
