// Battle Grade v2 — the pure maths. No Foundry, no game state: every input is
// passed in, so the whole formula is unit-tested in Node (grade-core.test.mjs).
//
//   grade-tally.js   collects the per-battle events while the battle runs
//   grade-core.js    (this file) turns them into gauges, rank, MVP, titles,
//                    the Bonus Board change and the MVP Prize draw
//   grade-state.js   the persistent side: board + prize bag on the DB actor,
//                    paying the prize, the EXP perk
//
// Design: claude.ai/artifact/BPgneV83ziwzd8UeNfkWoL (approved 2026-11-10) and
// reports/2026-11-10-battle-grade-v2.md.
//
// Inputs
//   roster  { [key]: { key, side:"party"|"enemy", name, level, rank, activation,
//                      maxHp, recipient } }        every creature seen this battle
//   events  [{ r, k, a, t, v, ... }]               r round, k kind, a actor key
//                                                  (doer), t target key, v value
//   rows    battle-record rows (name-based):        misses + affinity + efficiency
//   rounds  dCombat.round at the end

export const G = Object.freeze({
  MAX: { tempo: 25, exploit: 25, precision: 15, guard: 25, teamwork: 10 },
  TEMPO_DECAY: 0.7,            // ×0.7 per round over Par
  EXPLOIT_FULL_RATE: 0.6,      // exploit events per party action for a full gauge
  MISS: 1.5, RESIST: 2, IMMUNE: 3, ABSORB: 4,
  KO: 10,                      // Guard per ally KO
  HITS_WEIGHT: 6,              // Guard lost when every expected enemy hit lands
  HP_WEIGHT: 9,                // Guard lost at 100% of party max HP taken
  GUARD_BONUS_CAP: 4,          // Guard/Cover (+1 each) and Crisis heals (+1.5 each)
  TEAM: { buff: 2, mp: 1, item: 1.5, cover: 2 },
  // Hard / Boss. Was 5: in the 2026-11-11 sandbox calibration (7 real BD fights,
  // sim party) +5 lifted a 2-round, 10-Precision Imp fight to S. At +3 one fight
  // in 7 is S, the clean one; real players exploit less than the sim, so lower.
  THREAT_BONUS: 3,
  S_MIN: 92,
  LETTERS: [[80, "A"], [70, "B"], [60, "C"], [50, "D"], [40, "E"]],
  STAR: 0.9, CROSS: 0.5,       // ✦ at 90%+, ✗ under 50%
  CROSS_GAUGES: ["tempo", "precision", "guard"],  // Exploit / Teamwork only earn ✦
  TRIVIAL_GAP: 10, HARD_GAP: 5,
  BOARD_MAX: 10,
  PERKS: [[10, 15], [6, 10], [3, 5]],  // [slots, EXP %]
  ZENIT_PRIZE_MIN: 250, ZENIT_PRIZE_PCT: 0.10,
  PRIZES: ["fp", "zp", "coupon", "zenit"],
});

const GAUGE_KEYS = ["tempo", "exploit", "precision", "guard", "teamwork"];
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const norm = (s) => String(s ?? "").trim().toLowerCase();

// ── Encounter: Par + Threat ─────────────────────────────────────────────────

/** FU soldier-equivalents: soldier 1, elite 2, champion(n) = max(2, activation). */
export function unitsOf(e) {
  const r = norm(e?.rank);
  if (r === "champion") return Math.max(2, num(e?.activation, 2));
  if (r === "elite") return 2;
  return 1;
}

export function computePar(enemies, partySize) {
  const units = (enemies ?? []).reduce((s, e) => s + unitsOf(e), 0);
  if (!units) return 1;
  return Math.ceil(units / Math.max(1, partySize)) + 1;
}

export function computeThreat(enemies, partyLevel) {
  const list = enemies ?? [];
  if (!list.length) return "trivial";
  const avg = list.reduce((s, e) => s + num(e.level), 0) / list.length;
  const gap = avg - num(partyLevel);
  if (list.some((e) => norm(e.rank) === "champion")) return "boss";
  if (gap <= -G.TRIVIAL_GAP) return "trivial";
  if (gap >= G.HARD_GAP || list.some((e) => norm(e.rank) === "elite")) return "hard";
  return "even";
}

// ── Aggregation ─────────────────────────────────────────────────────────────

function blankStats() {
  return {
    actions: 0, attackActions: 0, dmgDealt: 0, weak: 0, crits: 0, effGood: 0, statusesOnEnemy: 0,
    misses: 0, resist: 0, immune: 0, absorb: 0,
    buffsGiven: 0, mpGiven: 0, itemsOnAllies: 0, covers: 0, guards: 0,
    hitsTaken: 0, dmgTaken: 0, healsTotal: 0, healsCrisis: 0, overheal: 0, kos: 0, kills: 0,
  };
}

const ATTACKY = new Set(["attack", "skill", "spell"]);

/**
 * Per-creature stats for the party side. Events give everything except the
 * affinity / miss / efficiency facts, which only the battle-log rows carry
 * (name-based, like the old rank).
 */
export function aggregate({ roster, events, rows }) {
  const R = roster ?? {};
  const party = Object.values(R).filter((c) => c.side === "party");
  const isParty = (k) => R[k]?.side === "party";
  const isEnemy = (k) => R[k]?.side === "enemy";
  const stats = Object.fromEntries(party.map((c) => [c.key, blankStats()]));
  const S = (k) => stats[k] ?? null;
  let lastKill = null;
  const seenCrit = new Set();

  for (const e of events ?? []) {
    const a = S(e.a), t = S(e.t);
    switch (e.k) {
      case "act":
        if (a) { a.actions++; if (ATTACKY.has(norm(e.ak))) a.attackActions++; }
        if (a && norm(e.ak) === "item" && (e.tg ?? []).some((k) => isParty(k) && k !== e.a)) a.itemsOnAllies++;
        break;
      case "dmg":       // HP loss
        if (a && isEnemy(e.t)) {
          a.dmgDealt += num(e.v);
          if (e.c && !seenCrit.has(e.di ?? e.id)) { seenCrit.add(e.di ?? e.id); a.crits++; }
        }
        if (t && isEnemy(e.a)) t.dmgTaken += num(e.v);
        else if (t && e.dmg) t.dmgTaken += num(e.v);    // damage with no known enemy cause (tick)
        break;
      case "hit":       // an enemy action landed on a party member
        if (t && isEnemy(e.a)) t.hitsTaken++;
        break;
      case "ko":
        if (t) t.kos++;
        break;
      case "kill":
        if (a) a.kills++;
        if (isParty(e.a)) lastKill = e.a;
        break;
      case "heal":
        if (a && isParty(e.t)) {
          a.healsTotal += num(e.v);
          a.overheal += Math.max(0, num(e.o));
          if (e.cr) a.healsCrisis++;
        }
        break;
      case "mp":
        if (a && isParty(e.t) && e.t !== e.a) a.mpGiven++;
        break;
      case "ae":        // an effect the director applied (buff / debuff / status)
        if (!a) break;
        if (isEnemy(e.t)) a.statusesOnEnemy++;
        else if (isParty(e.t) && e.t !== e.a && e.buff) a.buffsGiven++;
        break;
      case "guard":
        if (a) { a.guards++; if (e.cover) a.covers++; }
        break;
      default: break;
    }
  }

  // Battle-log rows: affinity / miss / efficiency by attacker NAME.
  const byName = new Map(party.map((c) => [norm(c.name), c.key]));
  for (const r of rows ?? []) {
    if (!r || r.$deleted === true) continue;
    const key = byName.get(norm(r.attacker));
    const s = key ? stats[key] : null;
    if (!s) continue;
    const mode = norm(r.apply_mode), vt = norm(r.value_type), aff = norm(r.affinity);
    const ch = r._chain && !r._chain.single ? r._chain : null;
    if (mode.includes("miss")) { s.misses += ch ? Math.max(1, num(ch.missed)) : 1; continue; }
    if (!mode.includes("damage") || vt !== "hp") continue;
    if (ch) s.misses += Math.max(0, num(ch.missed));
    if (aff.includes("vulner")) s.weak++;
    if (aff.includes("resist")) s.resist++;
    if (aff.includes("absorb")) s.absorb++;
    if (aff.includes("immune")) s.immune++;
    const eff = parseFloat(String(r.efficiency ?? "").replace(/[^\d.-]/g, ""));
    if (Number.isFinite(eff) && eff > 100) s.effGood++;
  }

  return { stats, lastKill };
}

const sumOf = (stats, f) => Object.values(stats).reduce((s, x) => s + num(f(x)), 0);

// ── Gauges + rank ───────────────────────────────────────────────────────────

export function computeGauges({ stats, rounds, par, partyMaxHp, expectedHits }) {
  const M = G.MAX;
  const R = Math.max(1, num(rounds, 1));
  const tempo = R <= par ? M.tempo : M.tempo * Math.pow(G.TEMPO_DECAY, R - par);

  const exploitEvents = sumOf(stats, (s) => s.weak + s.crits + s.effGood + s.statusesOnEnemy);
  const attackActions = Math.max(1, sumOf(stats, (s) => s.attackActions || 0) || sumOf(stats, (s) => s.actions));
  const exploit = M.exploit * clamp((exploitEvents / attackActions) / G.EXPLOIT_FULL_RATE, 0, 1);

  const precision = clamp(M.precision
    - G.MISS * sumOf(stats, (s) => s.misses) - G.RESIST * sumOf(stats, (s) => s.resist)
    - G.IMMUNE * sumOf(stats, (s) => s.immune) - G.ABSORB * sumOf(stats, (s) => s.absorb), 0, M.precision);

  const kos = sumOf(stats, (s) => s.kos);
  const hits = sumOf(stats, (s) => s.hitsTaken);
  const taken = sumOf(stats, (s) => s.dmgTaken);
  const bonus = Math.min(G.GUARD_BONUS_CAP, sumOf(stats, (s) => s.guards) + 1.5 * sumOf(stats, (s) => s.healsCrisis));
  const guard = clamp(M.guard - G.KO * kos
    - G.HITS_WEIGHT * clamp(hits / Math.max(1, expectedHits), 0, 1)
    - G.HP_WEIGHT * clamp(taken / Math.max(1, partyMaxHp), 0, 1)
    + bonus, 0, M.guard);

  const T = G.TEAM;
  const teamwork = clamp(sumOf(stats, (s) => T.buff * s.buffsGiven + T.mp * s.mpGiven + T.item * s.itemsOnAllies + T.cover * s.covers), 0, M.teamwork);

  const round1 = (x) => Math.round(x * 10) / 10;
  return { tempo: round1(tempo), exploit: round1(exploit), precision: round1(precision), guard: round1(guard), teamwork: round1(teamwork) };
}

export function marks(gauges) {
  const stars = {}, crosses = {};
  for (const k of GAUGE_KEYS) {
    const f = num(gauges[k]) / G.MAX[k];
    stars[k] = f >= G.STAR;
    crosses[k] = G.CROSS_GAUGES.includes(k) && f < G.CROSS;
  }
  return { stars, crosses, starCount: Object.values(stars).filter(Boolean).length, crossCount: Object.values(crosses).filter(Boolean).length };
}

export function letterOf(score, { kos = 0, threat = "even" } = {}) {
  let letter = "F";
  if (score >= G.S_MIN) letter = (kos === 0 && threat !== "trivial") ? "S" : "A";
  else for (const [min, l] of G.LETTERS) { if (score >= min) { letter = l; break; } }
  if (threat === "trivial" && (letter === "S" || letter === "A")) letter = "B";
  return letter;
}

// ── MVP + titles ────────────────────────────────────────────────────────────

export function computeMvp({ stats, roster, partyMaxHp, lastKill }) {
  const keys = Object.keys(stats).filter((k) => roster?.[k]?.recipient !== false);
  if (!keys.length) return { mvp: null, scores: {}, weights: {} };
  const lane = {
    off: (s) => s.dmgDealt,
    exp: (s) => s.weak + s.crits + s.effGood + s.statusesOnEnemy,
    grd: (s) => s.guards + s.covers + 2 * s.healsCrisis + 6 * (s.healsTotal / Math.max(1, partyMaxHp)),
    sup: (s) => s.buffsGiven + s.mpGiven + s.itemsOnAllies + s.covers,
  };
  const taken = keys.reduce((t, k) => t + stats[k].dmgTaken, 0);
  const allActs = Math.max(1, keys.reduce((t, k) => t + stats[k].actions, 0));
  const supActs = keys.reduce((t, k) => t + lane.sup(stats[k]), 0);
  const weights = {
    off: 1, exp: 0.6,
    grd: clamp(taken / Math.max(1, partyMaxHp), 0, 1),
    // Plain share of actions spent supporting, capped: a lone support player
    // owns the whole lane, so a ×2 here let one buff in four actions outweigh
    // the top damage dealer in an easy fight (caught by the burst-fight test).
    sup: clamp(supActs / allActs, 0, 0.6),
  };
  const totals = Object.fromEntries(Object.keys(lane).map((l) => [l, keys.reduce((t, k) => t + lane[l](stats[k]), 0)]));
  const scores = {};
  for (const k of keys) {
    const parts = {};
    let tot = 0;
    for (const l of Object.keys(lane)) {
      const share = totals[l] > 0 ? lane[l](stats[k]) / totals[l] : 0;
      parts[l] = share * weights[l];
      tot += parts[l];
    }
    scores[k] = { ...parts, total: tot };
  }
  const order = keys.slice().sort((x, y) =>
    (scores[y].total - scores[x].total) ||
    (stats[x].kos - stats[y].kos) ||
    ((y === lastKill) - (x === lastKill)));
  return { mvp: order[0], order, scores, weights };
}

// Rarest first; each title goes to one creature; everyone ends with one.
const TITLES = [
  ["untouchable",   (s) => s.actions > 0 && s.hitsTaken === 0 && s.dmgTaken === 0 ? 1 : 0],
  ["sharpshooter",  (s) => s.attackActions >= 4 && s.misses === 0 ? s.attackActions : 0],
  ["last_word",     (s, k, ctx) => k === ctx.lastKill ? 1 : 0],
  ["weak_point",    (s) => s.weak],
  ["guardian",      (s) => s.healsCrisis],
  ["iron_wall",     (s) => s.guards + s.covers],
  ["trickster",     (s) => s.statusesOnEnemy],
  ["commander",     (s) => s.buffsGiven],
  ["heavy_hitter",  (s) => s.dmgDealt],
];
export const TITLE_LABEL = Object.freeze({
  untouchable: "Untouchable", sharpshooter: "Sharpshooter", last_word: "Last Word",
  weak_point: "Weak Point Hunter", guardian: "Guardian Angel", iron_wall: "Iron Wall",
  trickster: "Trickster", commander: "Commander", heavy_hitter: "Heavy Hitter",
  punching_bag: "Punching Bag", team_player: "Team Player",
});

export function assignTitles({ stats, roster, lastKill }) {
  const keys = Object.keys(stats).filter((k) => roster?.[k]?.recipient !== false);
  const out = {};
  for (const [id, f] of TITLES) {
    let best = null, bestV = 0;
    for (const k of keys) {
      if (out[k]) continue;
      const v = num(f(stats[k], k, { lastKill }));
      if (v > bestV) { best = k; bestV = v; }
    }
    if (best) out[best] = id;
  }
  // Fallbacks: the one who soaked the most, then everyone else.
  const rest = keys.filter((k) => !out[k]).sort((x, y) => stats[y].dmgTaken - stats[x].dmgTaken);
  rest.forEach((k, i) => { out[k] = i === 0 && stats[k].dmgTaken > 0 ? "punching_bag" : "team_player"; });
  return out;
}

// ── Bonus Board + MVP Prize ─────────────────────────────────────────────────

export function boardDelta({ starCount, crossCount, kos, threat }) {
  if (threat === "trivial") return 0;
  return Math.max(0, starCount - 2) - crossCount - 2 * num(kos);
}

export function applyBoard(slots, delta) { return clamp(num(slots) + num(delta), 0, G.BOARD_MAX); }

export function perkPct(slots) {
  for (const [min, pct] of G.PERKS) if (num(slots) >= min) return pct;
  return 0;
}

export function nextPerk(slots) {
  const asc = G.PERKS.slice().reverse();
  const n = asc.find(([min]) => num(slots) < min);
  return n ? { at: n[0], pct: n[1] } : null;
}

export function zenitPrize(partyBattleZenit) {
  return Math.max(G.ZENIT_PRIZE_MIN, Math.round(num(partyBattleZenit) * G.ZENIT_PRIZE_PCT));
}

function shuffled(list, rng) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/**
 * Draw the next prize from a shuffled bag. `eligible(prize)` → false skips a
 * prize the MVP can't take (FP / ZP at cap); it stays in the bag for later.
 * A refill never starts with the prize just paid.
 */
export function drawPrize(state, { eligible = () => true, rng = Math.random } = {}) {
  let bag = Array.isArray(state?.bag) ? state.bag.filter((p) => G.PRIZES.includes(p)) : [];
  let last = state?.last ?? null;
  for (let guard = 0; guard < 3; guard++) {
    if (!bag.length) {
      let b = shuffled(G.PRIZES, rng);
      for (let t = 0; t < 8 && b[0] === last; t++) b = shuffled(G.PRIZES, rng);
      bag = b;
    }
    const i = bag.findIndex((p) => eligible(p));
    if (i >= 0) {
      const prize = bag[i];
      bag = bag.slice(0, i).concat(bag.slice(i + 1));
      return { prize, state: { bag, last: prize } };
    }
    bag = [];  // nothing in this bag fits: refill once more
  }
  return { prize: null, state: { bag, last } };
}

// ── The whole grade ─────────────────────────────────────────────────────────

export function computeGrade({ roster, events, rows, rounds }) {
  const all = Object.values(roster ?? {});
  const party = all.filter((c) => c.side === "party");
  const enemies = all.filter((c) => c.side === "enemy");
  const recipients = party.filter((c) => c.recipient !== false);
  const partyLevel = recipients.length ? recipients.reduce((s, c) => s + num(c.level), 0) / recipients.length : 0;
  const partyMaxHp = party.reduce((s, c) => s + num(c.maxHp), 0);
  const par = computePar(enemies, Math.max(1, recipients.length || party.length));
  const threat = computeThreat(enemies, partyLevel);
  const enemyActsPerRound = enemies.reduce((s, e) => s + Math.max(1, num(e.activation, 1)), 0);
  const expectedHits = Math.max(1, enemyActsPerRound * par);

  const { stats, lastKill } = aggregate({ roster, events, rows });
  const gauges = computeGauges({ stats, rounds, par, partyMaxHp, expectedHits });
  const m = marks(gauges);
  const kos = sumOf(stats, (s) => s.kos);
  const raw = GAUGE_KEYS.reduce((s, k) => s + gauges[k], 0);
  const bonus = (threat === "hard" || threat === "boss") ? G.THREAT_BONUS : 0;
  const score = Math.round(clamp(raw + bonus, 0, 100) * 10) / 10;
  const letter = letterOf(score, { kos, threat });
  const mvp = computeMvp({ stats, roster, partyMaxHp, lastKill });
  const titles = assignTitles({ stats, roster, lastKill });
  const delta = boardDelta({ starCount: m.starCount, crossCount: m.crossCount, kos, threat });

  return {
    score, letter, threat, par, rounds: Math.max(1, num(rounds, 1)), kos,
    gauges, stars: m.stars, crosses: m.crosses, boardDelta: delta,
    mvp: mvp.mvp, mvpScores: mvp.scores, mvpWeights: mvp.weights,
    titles, lastKill, stats,
    inputs: { partyLevel, partyMaxHp, expectedHits, enemyCount: enemies.length },
  };
}
