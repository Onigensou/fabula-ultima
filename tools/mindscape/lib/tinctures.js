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
function makeTinctureState({ pct = {}, user = DEFAULT_USER, stock = DEFAULT_STOCK } = {}) {
  const kinds = Object.keys(KINDS).filter((k) => Number(pct[k]) > 0);
  if (!kinds.length) return null;
  return {
    pct: Object.fromEntries(kinds.map((k) => [k, Number(pct[k])])),
    user: String(user).trim().toLowerCase(),
    stock: Object.fromEntries(kinds.map((k) => [k, stock])),
    used: Object.fromEntries(kinds.map((k) => [k, 0])),
  };
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

// Party policy for the carrier. Pure: the engine supplies `projectLane(ally, lane)`,
// that ally's expected damage per round from actions rolled against that defence.
//
//   1. Endurance first, on whoever lost the most HP last round past the trigger —
//      KO prevention outranks damage (project_fight_balance_playbook).
//   2. Otherwise the damage tincture with the largest projected gain, on an ally
//      that is not already carrying it. Never on the carrier: a damage tincture on
//      yourself spends the turn it would have boosted.
function chooseTincture(state, actor, { projectLane }) {
  const T = state.tinctures;
  if (!T || actor.side !== "party") return null;
  if (String(actor.name).trim().toLowerCase() !== T.user) return null;
  const allies = state.combatants.filter((c) => c.side === actor.side && c.alive);

  if (T.stock.endurance > 0) {
    const hurt = allies
      .filter((c) => !buffPct(c, "endurance") && (c.takenLastRound ?? 0) >= c.maxHp * ENDURANCE_TRIGGER)
      .sort((a, b) => b.takenLastRound - a.takenLastRound)[0];
    if (hurt) return { kind: "endurance", target: hurt };
  }

  let best = null;
  for (const kind of ["strength", "spirit"]) {
    if (!(T.stock[kind] > 0)) continue;
    for (const c of allies) {
      if (c === actor || buffPct(c, kind)) continue;
      const gain = (Number(projectLane(c, KINDS[kind].lane)) || 0) * T.pct[kind];
      if (gain > 0 && (!best || gain > best.gain)) best = { kind, target: c, gain };
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
  parseTinctureArg, makeTinctureState, buffPct, outgoingMult, reductionPct,
  applyBuff, tickTurnEnd, chooseTincture, drink,
};
