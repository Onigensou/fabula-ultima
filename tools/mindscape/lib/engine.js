"use strict";
//
// Mindscape — the combat loop.
//
// Runs one fight to a verdict against the ruleset in docs/mindscape-ruleset.md.
// Deterministic given a seed. No I/O, no world access: it takes loaded combat
// models and an Rng and returns a result object.
//
// What it counts, and why: BaselineDPR and Round Density are the two constants
// the Play Efficiency model needs re-derived, and spec D3 requires they never
// double-count. So actions are tallied in two SEPARATE classes — those from base
// `activation`, and those from grants — and BaselineDPR is derived from the
// first alone while RD spans both.

const R = require("./rules");
const { extractActions } = require("./skills");

const ATTR_KEYS = { DEX: "dex", INS: "ins", MIG: "mig", WLP: "wlp" };

// ── Combatant ───────────────────────────────────────────────────────────────
function makeCombatant(actor, side) {
  const ex = extractActions(actor);
  return {
    actor, side,
    name: actor.name,
    hp: actor.hp.max ?? actor.hp.cur,
    maxHp: actor.hp.max ?? actor.hp.cur,
    mp: actor.mp.max ?? actor.mp.cur,
    ip: actor.ip.max ?? actor.ip.cur,
    zp: actor.zp ?? 0,
    baseTurns: actor.turnsPerRound ?? 1,
    grantedTurns: 0,
    actions: ex.actions,
    utility: ex.utility,
    alive: true,
    // Per-run accounting, split per spec D3.
    baseActionsTaken: 0,
    grantedActionsTaken: 0,
    damageDealt: 0,
    downedOnRound: null,
  };
}

function attrs(c) {
  return R.effectiveAttributes(c.actor.attributes, c.actor.statuses ?? {});
}

// Initiative: (DEX + INS) / 2, minus an armor penalty when the sheet carries one.
// Static rather than rolled — a simplification, flagged in the spec's Part 6
// sense: it removes variance from turn order without favouring either side.
function initiative(c) {
  const a = attrs(c);
  const pen = Number(c.actor._rawProps?.init_penalty) || 0;
  return (a.dex + a.ins) / 2 - pen;
}

// ── Affordability ───────────────────────────────────────────────────────────
function canAfford(c, action, targetCount = 1) {
  const cost = action.cost;
  if (!cost || !cost.resource) return true;
  const amount = cost.perTarget ? cost.amount * Math.max(1, targetCount) : cost.amount;
  const pool = cost.resource === "mp" ? c.mp : cost.resource === "ip" ? c.ip : c.zp;
  return pool >= amount;
}

function pay(c, action, targetCount = 1) {
  const cost = action.cost;
  if (!cost || !cost.resource) return;
  const amount = cost.perTarget ? cost.amount * Math.max(1, targetCount) : cost.amount;
  if (cost.resource === "mp") c.mp -= amount;
  else if (cost.resource === "ip") c.ip -= amount;
  else c.zp -= amount;
}

// ── Targeting ───────────────────────────────────────────────────────────────
function livingFoes(state, side) {
  return state.combatants.filter((c) => c.alive && c.side !== side);
}

function chooseTargets(state, actor, action) {
  const foes = livingFoes(state, actor.side);
  if (!foes.length) return [];
  const t = action.target;
  if (t.side === "ally") return [];   // handled by the utility layer, not here

  const n = t.count === Infinity ? foes.length : Math.min(t.count, foes.length);

  // FOCUS FIRE — the single biggest lever, and it costs nothing (9 rounds -> 4
  // in live runs). One called target shared by the whole party, so damage
  // concentrates instead of spreading across the enemy line. See
  // profiles.js refreshFocus; the precedence is transcribed there.
  if (actor.side === "party" && n === 1) {
    const focus = state.focus && state.focus.alive ? state.focus : null;
    if (focus) {
      // Peel off only when the call would be actively wasted on this element.
      const aff = R.resolveAffinity(focus.actor, action.element);
      if (aff !== "AB" && aff !== "IM") return [focus];
    }
  }

  // Multi-target and enemy actions: spread over whoever is alive, weakest first
  // so a kill actually lands.
  return foes.slice().sort((a, b) => a.hp - b.hp).slice(0, n);
}

// The party's called target. Precedence per profiles.js:
//   1. finisher  — anything at or under focusLowHpFraction, preferring one the
//                  party can exploit (a weakness is close to a damage multiplier)
//   2. standing call, if still alive
//   3. fresh call — prefer an exploitable target, else lowest current HP
const FOCUS_LOW_HP_FRACTION = 0.70;   // TUNING.focusLowHpFraction

function refreshFocus(state) {
  const foes = livingFoes(state, "party");
  if (!foes.length) { state.focus = null; return; }

  const exploitable = (f) =>
    Object.values(f.actor.affinities ?? {}).includes("VU");

  const hurt = foes
    .filter((f) => f.hp / f.maxHp <= FOCUS_LOW_HP_FRACTION)
    .sort((a, b) => (exploitable(b) ? 1 : 0) - (exploitable(a) ? 1 : 0) || a.hp - b.hp);
  if (hurt.length) { state.focus = hurt[0]; return; }

  if (state.focus && state.focus.alive) return;

  const pool = foes.filter(exploitable);
  const from = pool.length && pool.length < foes.length ? pool : foes;
  state.focus = from.slice().sort((a, b) => a.hp - b.hp)[0];
}

// ── Resolving one action ────────────────────────────────────────────────────
// Accuracy bonus for one action. `check_mod_all` applies to everything; the rest
// are contextual and stack with it — Zarg carries accuracy 3 + ranged 4 on a bow
// shot, Hina magic 6 on a spell. Ignoring these made the party miss constantly
// and was a large part of why the first calibration run reported a slaughter.
function checkBonusFor(actor, action) {
  const own = action.checkBonus ?? 0;
  const m = actor.actor.checkMods;
  if (!m) return own;

  let bonus = own + m.all + m.accuracy;
  // A spell is anything resolved against Magic Defense; everything else is a
  // weapon action, melee or ranged by the weapon's own range.
  if (action.defenseTarget === "mdef") bonus += m.magic;
  else bonus += (actor.actor.weapon?.range === "ranged" ? m.ranged : m.melee);
  return bonus;
}

// Flat outgoing damage bonus from the sheet's extra_damage_mod_* family.
function extraDamageFor(actor, action) {
  const x = actor.actor.extraDamage;
  if (!x) return 0;
  let bonus = x.all;
  if (action.defenseTarget === "mdef") bonus += x.spell;
  bonus += x.byElement?.[action.element] ?? 0;
  if (action.weaponFamily) bonus += x.byFamily?.[action.weaponFamily] ?? 0;
  return bonus;
}

// Flat incoming reduction: the universal band plus the per-element one.
function reductionFor(target, element) {
  const d = target.actor.damageReduction;
  if (!d) return { flat: 0, percent: 0 };
  return { flat: (d.flat ?? 0) + (d.byElement?.[element] ?? 0), percent: d.percent ?? 0 };
}

function resolveAction(state, actor, action, targets) {
  const a = attrs(actor);
  const dieA = a[action.attrA] ?? 8;
  const dieB = a[action.attrB] ?? 8;
  const bonus = checkBonusFor(actor, action);
  const extra = extraDamageFor(actor, action);

  pay(actor, action, targets.length);

  for (const target of targets) {
    if (!target.alive) continue;
    const dl = action.defenseTarget === "mdef" ? target.actor.mdef : target.actor.def;
    const check = R.accuracyCheck(state.rng, { dieA, dieB, bonus, dl });

    if (!check.hit) {
      state.log.push({ round: state.round, actor: actor.name, action: action.name, target: target.name, miss: true });
      continue;
    }

    // A critical doubles nothing by itself in this system; it grants an
    // Opportunity, which the model does not resolve (spec Part 6 — the party
    // always taking Advantage is a live-sim simplification with no offline
    // analogue yet). So a crit here is only an auto-hit. Flagged, not silent.
    const base = R.outgoingDamage({ hr: check.hr, damageBonus: action.damageBonus + extra });
    const out = R.incomingDamage(
      { ...target.actor, damageReduction: reductionFor(target, action.element) },
      {
        base,
        element: action.element,
        weaponFamily: action.weaponFamily,
        keywords: action.keywords,
      },
    );

    if (out.direction === "recover") {
      target.hp = Math.min(target.maxHp, target.hp + out.damage);
    } else {
      target.hp -= out.damage;
      actor.damageDealt += out.damage;
      if (target.hp <= 0) {
        target.hp = 0;
        target.alive = false;
        target.downedOnRound = state.round;
      }
    }

    state.log.push({
      round: state.round, actor: actor.name, action: action.name, target: target.name,
      damage: out.damage, affinity: out.affinity, crit: check.crit, direction: out.direction,
    });
  }
}

// ── Choosing an action ──────────────────────────────────────────────────────
// Pick the affordable action with the highest PROJECTED damage against the
// chosen targets, with a finisher preference (spec D2): if any action's
// projection would drop a target, take that one.
//
// Projection uses the average high roll, never the maximum, so the model never
// fires a finisher it cannot land.
function chooseAction(state, actor) {
  const affordable = actor.actions.filter((act) => {
    const t = chooseTargets(state, actor, act);
    return t.length > 0 && canAfford(actor, act, t.length);
  });
  if (!affordable.length) return null;

  let best = null;
  for (const act of affordable) {
    const targets = chooseTargets(state, actor, act);
    const a = attrs(actor);
    let total = 0, finisher = false;
    for (const t of targets) {
      const proj = R.projectDamage(t.actor, {
        dieA: a[act.attrA] ?? 8, dieB: a[act.attrB] ?? 8,
        damageBonus: act.damageBonus,
        element: act.element, weaponFamily: act.weaponFamily, keywords: act.keywords,
      });
      if (proj.direction === "recover") { total -= proj.damage; continue; }
      total += proj.damage;
      if (proj.damage >= t.hp) finisher = true;
    }
    const score = total + (finisher ? 1e6 : 0);
    if (!best || score > best.score) best = { action: act, targets, score, finisher };
  }
  return best;
}

// A weapon swing, for anyone whose modelled kit has nothing affordable. Zarg and
// Blanche live here by design: Zarg's whole kit rides on the shot rather than
// replacing it, so an empty rotation is CORRECT (profiles.js).
function weaponAction(actor) {
  const w = actor.actor.weapon;
  if (!w?.name || !(w.baseDamage > 0)) return null;
  const a1 = ATTR_KEYS[w.attrA], a2 = ATTR_KEYS[w.attrB];
  if (!a1 || !a2) return null;   // SHI+SHI (a shield) is not an attack
  return {
    name: `${w.name} (weapon)`,
    attrA: a1, attrB: a2,
    damageBonus: w.baseDamage,
    element: String(w.element ?? "physical").toLowerCase(),
    defenseTarget: "def",
    target: { side: "enemy", count: 1 },
    cost: { resource: null, amount: 0 },
    keywords: null,
    weaponFamily: actor.actor.weapon?.family ?? null,
    checkBonus: 0,
  };
}

function takeTurn(state, actor, { granted = false } = {}) {
  if (!actor.alive) return;
  if (actor.side === "party") refreshFocus(state);

  const pick = chooseAction(state, actor);
  let action = pick?.action ?? null;
  let targets = pick?.targets ?? null;

  if (!action) {
    const w = weaponAction(actor);
    if (w) { action = w; targets = chooseTargets(state, actor, w); }
  }

  if (!action || !targets?.length) {
    state.log.push({ round: state.round, actor: actor.name, action: "(guard)", idle: true });
  } else {
    resolveAction(state, actor, action, targets);
  }

  if (granted) actor.grantedActionsTaken++;
  else actor.baseActionsTaken++;
}

// ── The run ─────────────────────────────────────────────────────────────────
function runBattle({ party, enemies, rng, expectedRounds = 7, maxRounds = 30 }) {
  const combatants = [
    ...party.map((a) => makeCombatant(a, "party")),
    ...enemies.map((a) => makeCombatant(a, "enemy")),
  ];

  const state = { combatants, round: 0, rng, log: [], focus: null };

  const order = combatants.slice().sort((a, b) => initiative(b) - initiative(a));

  let outcome = "inconclusive";
  for (state.round = 1; state.round <= maxRounds; state.round++) {
    for (const c of order) {
      if (!c.alive) continue;
      for (let t = 0; t < c.baseTurns; t++) {
        if (!c.alive) break;
        takeTurn(state, c);
      }
      // Granted turns are taken AFTER the base ones and counted separately, so
      // BaselineDPR (base only) and RD (both) cannot double-count. Spec D3.
      for (let t = 0; t < c.grantedTurns; t++) {
        if (!c.alive) break;
        takeTurn(state, c, { granted: true });
      }
      c.grantedTurns = 0;

      const partyAlive = combatants.some((x) => x.side === "party" && x.alive);
      const enemyAlive = combatants.some((x) => x.side === "enemy" && x.alive);
      if (!partyAlive || !enemyAlive) {
        outcome = !partyAlive && !enemyAlive ? "mutual-destruction"
                : !partyAlive ? "defeat" : "victory";
        break;
      }
    }
    if (outcome !== "inconclusive") break;

    // The design budget. Past this the fight has failed to resolve either way,
    // and THAT is the finding — a fight nobody can close is a design problem
    // regardless of who was ahead on HP.
    if (state.round >= expectedRounds) { outcome = "overtime"; break; }
  }

  const partyC = combatants.filter((c) => c.side === "party");
  const curHp = partyC.reduce((s, c) => s + Math.max(0, c.hp), 0);
  const maxHp = partyC.reduce((s, c) => s + c.maxHp, 0);

  const baseActions = combatants.filter((c) => c.side === "party")
    .reduce((s, c) => s + c.baseActionsTaken, 0);
  const grantedActions = combatants.filter((c) => c.side === "party")
    .reduce((s, c) => s + c.grantedActionsTaken, 0);
  const partyDamage = combatants.filter((c) => c.side === "party")
    .reduce((s, c) => s + c.damageDealt, 0);

  const rounds = Math.min(state.round, maxRounds);

  return {
    outcome,
    rounds,
    partyHpRemaining: maxHp ? curHp / maxHp : null,
    downs: partyC.filter((c) => !c.alive).map((c) => ({ name: c.name, round: c.downedOnRound })),
    // Spec D3: strictly separated so they can never double-count.
    baselineDpr: rounds ? partyDamage / rounds : 0,
    baseActions, grantedActions,
    roundDensity: (rounds && partyC.length)
      ? (baseActions + grantedActions) / (partyC.length * rounds)
      : 0,
    combatants: combatants.map((c) => ({
      name: c.name, side: c.side, hp: c.hp, maxHp: c.maxHp, alive: c.alive,
      damageDealt: c.damageDealt,
    })),
    log: state.log,
  };
}

module.exports = { runBattle, makeCombatant, initiative, refreshFocus, weaponAction };
