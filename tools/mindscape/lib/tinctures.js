"use strict";
//
// Mindscape — the Tincture Cycle consumables, as a PAPER design (proposal
// reviewed 2026-09-15; not built in the world yet).
//
//   Tincture of Strength   +X% damage from actions rolled against DEF
//   Tincture of Spirit     +X% damage from actions rolled against MDEF
//   Tincture of Endurance  the bearer takes X% less damage
//
// One Inventory action applies one tincture to one creature for THREE of that
// creature's turns. Re-applying refreshes the duration; it never stacks.
//
// Where each lands, mirroring the live pipeline (ruleset Part 6l):
//   Strength / Spirit  an outgoing multiplier after weapon efficiency and before
//                      affinity, on a HIT only — the slot of an accepted
//                      adjust_damage op (action-profile.js buildPerTarget). So VU
//                      and a 200% efficiency scale the boosted figure.
//   Endurance          added to the bearer's percentage damage reduction, before
//                      efficiency and affinity — damage_receiving_percentage_all,
//                      which SUMS with any other percentage source.
//
// The duration counts down at the end of each of the bearer's BASE turns (live
// lifetimeMode "target_turn_end", 3 charges). A free attack is not a turn. So a
// tincture handed to an ally covers three of their turns, and one drunk by the
// bearer covers two — the drinking turn is spent.

const KINDS = Object.freeze({
  strength: { lane: "def" },
  spirit: { lane: "mdef" },
  endurance: { lane: null },
});

const DURATION_TURNS = 3;
const DEFAULT_STOCK = 3;
// The support who carries them. Lowest modelled output in the party, which is the
// line of play the design is for: a utility character hands a boost to a carry.
const DEFAULT_USER = "Blanche";
// Endurance goes out when an ally lost at least this share of their max HP in the
// previous round — someone is actually being focused, not grazed.
const ENDURANCE_TRIGGER = 0.20;

// "strength=25,spirit=25,endurance=30" -> { strength: 25, spirit: 25, endurance: 30 }
function parseTinctureArg(spec) {
  const out = {};
  const parts = String(spec ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const part of parts) {
    const [rawKind, rawPct, extra] = part.split("=").map((s) => s.trim());
    const kind = String(rawKind ?? "").toLowerCase();
    const pct = Number(rawPct);
    if (extra !== undefined || !kind || rawPct === undefined || rawPct === "") {
      throw new Error(`bad tincture "${part}" (want kind=percent, e.g. strength=25)`);
    }
    if (!KINDS[kind]) throw new Error(`unknown tincture "${rawKind}" (strength, spirit, endurance)`);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw new Error(`tincture percent out of range: ${part}`);
    out[kind] = pct;
  }
  return out;
}

// Per-fight state. null when no tincture is switched on, so the engine's common
// path is untouched and the calibration seed reproduces exactly.
// `carrierFirst`: the WORST-CASE opener. The carrier acts before everyone in the round
// order, so a round-1 tincture lands before the carry's first volley — what a party with
// Quicken, or simply better initiative, would do on purpose.
function makeTinctureState({ pct = {}, user = DEFAULT_USER, stock = DEFAULT_STOCK, lanePrior = null, carrierFirst = false } = {}) {
  const kinds = Object.keys(KINDS).filter((k) => Number(pct[k]) > 0);
  if (!kinds.length) return null;
  return {
    pct: Object.fromEntries(kinds.map((k) => [k, Number(pct[k])])),
    user: String(user).trim().toLowerCase(),
    stock: Object.fromEntries(kinds.map((k) => [k, stock])),
    used: Object.fromEntries(kinds.map((k) => [k, 0])),
    lanePrior,
    carrierFirst: !!carrierFirst,
  };
}

const nameKey = (c) => String(c?.name ?? "").trim().toLowerCase();

// What each PC ACTUALLY dealt per round, by the defence the damage was rolled against,
// measured from tincture-free runs of the same fight: { name: { def, mdef } }. This is
// the carrier knowing who the party's carry is. A projection of what an ally COULD deal
// cannot know that Hina spends her turns on Acceleration and Protect, and handed her
// Spirit on round 1 in 82% of Wyrmwood fights.
function measureLanePrior(results) {
  const acc = {};
  for (const r of results) {
    if (!r.rounds) continue;
    for (const c of r.combatants) {
      if (c.side !== "party") continue;
      const a = (acc[nameKey(c)] = acc[nameKey(c)] ?? { def: 0, mdef: 0, n: 0 });
      a.def += (c.damageByLane?.def ?? 0) / r.rounds;
      a.mdef += (c.damageByLane?.mdef ?? 0) / r.rounds;
      a.n++;
    }
  }
  return Object.fromEntries(Object.entries(acc).map(([k, a]) => [k, { def: a.def / a.n, mdef: a.mdef / a.n }]));
}

function buffPct(c, kind) {
  const b = c?.buffs?.[kind];
  return b && b.turnsLeft > 0 ? b.pct : 0;
}

// The outgoing multiplier for one action: Strength on DEF actions, Spirit on MDEF.
function outgoingMult(actor, action) {
  const kind = action?.defenseTarget === "mdef" ? "spirit" : "strength";
  const p = buffPct(actor, kind);
  return p ? 1 + p / 100 : 1;
}

function reductionPct(target) {
  return buffPct(target, "endurance");
}

// Refresh, never stack: a second Strength on the same creature resets the clock.
function applyBuff(target, kind, pct) {
  target.buffs = target.buffs ?? {};
  target.buffs[kind] = { pct, turnsLeft: DURATION_TURNS };
}

function tickTurnEnd(c) {
  if (!c?.buffs) return;
  for (const kind of Object.keys(c.buffs)) {
    c.buffs[kind].turnsLeft -= 1;
    if (c.buffs[kind].turnsLeft <= 0) delete c.buffs[kind];
  }
}

// Party policy for the carrier. Pure. An ally's output in a lane is read from the
// measured `lanePrior` when the state carries one, else from the engine's
// `projectLane(ally, lane)` (expected damage per round against the called target).
//
//   1. Endurance first, on whoever lost the most HP last round past the trigger —
//      KO prevention outranks damage (project_fight_balance_playbook).
//   2. Otherwise the damage tincture with the largest gain over its three turns, on
//      an ally not already carrying it, and only when that gain beats the damage the
//      carrier gives up by not attacking this turn. Never on the carrier: a damage
//      tincture on yourself spends the turn it would have boosted.
function chooseTincture(state, actor, { projectLane }) {
  const T = state.tinctures;
  if (!T || actor.side !== "party") return null;
  if (nameKey(actor) !== T.user) return null;
  const allies = state.combatants.filter((c) => c.side === actor.side && c.alive);

  if (T.stock.endurance > 0) {
    const hurt = allies
      .filter((c) => !buffPct(c, "endurance") && (c.takenLastRound ?? 0) >= c.maxHp * ENDURANCE_TRIGGER)
      .sort((a, b) => b.takenLastRound - a.takenLastRound)[0];
    if (hurt) return { kind: "endurance", target: hurt };
  }

  const prior = T.lanePrior;
  const laneOut = (c, lane) => (prior
    ? Number(prior[nameKey(c)]?.[lane] ?? 0)
    : Number(projectLane(c, lane)) || 0);
  const forgone = prior
    ? laneOut(actor, "def") + laneOut(actor, "mdef")
    : Math.max(laneOut(actor, "def"), laneOut(actor, "mdef"));

  let best = null;
  for (const kind of ["strength", "spirit"]) {
    if (!(T.stock[kind] > 0)) continue;
    for (const c of allies) {
      if (c === actor || buffPct(c, kind)) continue;
      const gain = laneOut(c, KINDS[kind].lane) * (T.pct[kind] / 100) * DURATION_TURNS;
      if (gain <= 0 || gain < forgone) continue;
      if (!best || gain > best.gain) best = { kind, target: c, gain };
    }
  }
  return best;
}

function drink(state, actor, pick) {
  const T = state.tinctures;
  T.stock[pick.kind] -= 1;
  T.used[pick.kind] += 1;
  applyBuff(pick.target, pick.kind, T.pct[pick.kind]);
  actor.tincturesUsed = (actor.tincturesUsed ?? 0) + 1;
}

module.exports = {
  KINDS, DURATION_TURNS, DEFAULT_STOCK, DEFAULT_USER, ENDURANCE_TRIGGER,
  parseTinctureArg, makeTinctureState, measureLanePrior, buffPct, outgoingMult, reductionPct,
  applyBuff, tickTurnEnd, chooseTincture, drink,
};
