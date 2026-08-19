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
const U = require("./utility");
const RX = require("./reactions");

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
    accelerated: false,
    protectedThisRound: 0,
    actions: ex.actions,
    utility: ex.utility,
    // Declared reactions (reactions.js). `ex.passives` was write-only before —
    // extracted, counted, never consulted.
    reactions: RX.declaredReactions(ex.passives),
    undeclaredReactions: RX.undeclaredReactions(ex.passives),
    counters: {},          // stack_burst accumulators, keyed by counter name
    shield: 0,
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
  if (cost.resource === "adoration") return true;   // see pay()
  const amount = cost.perTarget ? cost.amount * Math.max(1, targetCount) : cost.amount;
  const pool = cost.resource === "mp" ? c.mp : cost.resource === "ip" ? c.ip : c.zp;
  return pool >= amount;
}

// Adoration is charged as free. The sheet exposes no pool to read (Blanche's
// resource_value_* are all 0) yet profiles.js keeps Muleta in her rotation, so
// the live engine pays it somehow. Treating it as unaffordable made her deal
// literally zero damage, which is a worse model of real play than this is.
// ROUGH BY CHOICE -- flagged in the report.
function pay(c, action, targetCount = 1) {
  const cost = action.cost;
  if (!cost || !cost.resource || cost.resource === "adoration") return;
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

// ── Reactions ───────────────────────────────────────────────────────────────
// Execute one reaction descriptor produced by reactions.js. Split out of
// resolveAction so the decision side stays pure and the recursion budget lives
// in exactly one place.
//
// A reactor that has just been killed STILL acts here. That is not a bug: the
// live Overload Riposte fires at CONFIRM, before the incoming damage resolves,
// so it lands on the killing blow — and modelling it otherwise would quietly
// delete the property that makes the mechanic immune to the focus-fire discount.
function fireReactions(state, reactor, trigger, ctx) {
  if (!reactor?.reactions?.length) return;
  if ((state.reactionDepth ?? 0) >= RX.MAX_REACTION_DEPTH) return;

  const fired = RX.collect(reactor, trigger, ctx);
  if (!fired.length) return;

  state.reactionDepth = (state.reactionDepth ?? 0) + 1;
  try {
    for (const r of fired) runReactionEffect(state, reactor, r, ctx);
  } finally {
    state.reactionDepth--;
  }
}

function runReactionEffect(state, reactor, reaction, ctx) {
  const e = reaction.effect;
  reactor.reactionsFired = (reactor.reactionsFired ?? 0) + 1;

  switch (e.kind) {
    case "free_attack": {
      const action = (reactor.actions ?? []).find((x) => x.name === e.actionName);
      if (!action) return;                        // not extractable → silently unmodelled
      let targets = [];
      if (e.target === "attacker" && ctx.attacker?.alive) targets = [ctx.attacker];
      else if (e.target === "victim" && ctx.victim?.alive) targets = [ctx.victim];
      else if (e.target === "hostile") targets = chooseTargets(state, reactor, action);
      if (!targets.length) return;
      // An ANNOUNCE row: it names the reaction that granted the attack, and
      // carries no target/damage of its own — the resolveAction below logs the
      // actual swing. `announce` is the flag a log reader must skip on; without
      // it a formatter prints "-> undefined -undefined".
      state.log.push({ round: state.round, actor: reactor.name, action: reaction.name, reaction: true, announce: true });
      resolveAction(state, reactor, action, targets, { free: true });
      return;
    }

    case "stack_burst": {
      const n = (reactor.counters[e.counter] ?? 0) + 1;
      if (n < e.threshold) { reactor.counters[e.counter] = n; return; }
      reactor.counters[e.counter] = 0;
      const victim = ctx.victim;
      if (!victim?.alive) return;
      applyFlatDamage(state, reactor, victim, e.damage, e.element, reaction.name);
      return;
    }

    case "burst": {
      // Indiscriminate — hits everything else in the conflict, allies included.
      for (const c of state.combatants) {
        if (c === reactor || !c.alive) continue;
        applyFlatDamage(state, reactor, c, e.damage, e.element, reaction.name);
      }
      return;
    }

    case "grant_mp": {
      const before = reactor.mp;
      const cap = reactor.actor.mp.max ?? before;
      reactor.mp = Math.min(cap, before + e.amount);
      if (e.overflowToShield) reactor.shield += Math.max(0, before + e.amount - cap);
      return;
    }

    default:
      return;
  }
}

// Flat, unrolled damage through the normal incoming pipeline (affinity + DR),
// which is what makes an absorbing target heal instead of taking it.
//
// `cause` is NOT cosmetic: "hazard" is what stops the Lightning Rod's own strike
// from re-pinning the Rod to its current holder. With it defaulted to "damage"
// the holder kept the Rod forever and ate 30 Bolt every single turn — Hina's
// down-rate read 50% off that alone.
function applyFlatDamage(state, source, target, amount, element, label, cause = "damage") {
  const out = R.incomingDamage(
    { ...target.actor, damageReduction: reductionFor(target, element) },
    { base: amount, element },
  );
  if (out.direction === "recover") {
    target.hp = Math.min(target.maxHp, target.hp + out.damage);
  } else {
    target.hp -= out.damage;
    if (source.side !== target.side) source.damageDealt += out.damage;
    if (target.hp <= 0) { target.hp = 0; target.alive = false; target.downedOnRound = state.round; }
  }
  state.log.push({
    round: state.round, actor: source.name, action: label, target: target.name,
    damage: out.damage, affinity: out.affinity, direction: out.direction, reaction: true,
  });
  onHpMoved(state, source, target, out, element, cause);
}

// One funnel for "an element moved this creature's HP" so the storm strike, a
// burst and a normal hit all feed the same passives. `cause` distinguishes
// creature-inflicted ("damage") from hazard/tick, which the Rod rule needs.
function onHpMoved(state, source, target, out, element, cause) {
  if (state.event?.onDamage && out.direction !== "recover") {
    state.event.onDamage(state, target, cause);
  }
  fireReactions(state, target, RX.TRIGGERS.ON_TAKE_ELEMENT, {
    element, damage: out.damage, direction: out.direction, cause, attacker: source,
  });
  if (source && source !== target && out.direction !== "recover") {
    fireReactions(state, source, RX.TRIGGERS.ON_DEAL_DAMAGE, {
      victim: target, element, damage: out.damage,
    });
  }
}

function resolveAction(state, actor, action, targets, { free = false } = {}) {
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

    // PROTECT: a defensive redirect resolved here rather than on a turn -- the
    // protector steps in front and takes the hit instead.
    let victim = target;
    if (out.direction !== "recover" && actor.side === "enemy") {
      const prot = U.findProtector(state, target, out.damage);
      if (prot) {
        prot.protectedThisRound++;
        victim = prot;
        state.log.push({ round: state.round, actor: prot.name, action: "Protect", target: target.name, protect: true });
      }
    }

    // ON_TARGETED is COLLECTED here — before the HP write — because the live
    // trigger is pre-resolve. Deferring the collection past the write would
    // silently drop every riposte to a lethal hit.
    const targetedCtx = {
      accuracyResult: check.result, hit: true, damage: out.damage,
      element: action.element, attacker: actor, victim,
    };

    if (out.direction === "recover") {
      target.hp = Math.min(target.maxHp, target.hp + out.damage);
    } else {
      // `victim` is the target unless a protector stepped in front.
      victim.hp -= out.damage;
      actor.damageDealt += out.damage;
      if (victim.hp <= 0) {
        victim.hp = 0;
        victim.alive = false;
        victim.downedOnRound = state.round;
      }
    }

    state.log.push({
      round: state.round, actor: actor.name, action: action.name, target: target.name,
      damage: out.damage, affinity: out.affinity, crit: check.crit, direction: out.direction,
    });

    fireReactions(state, victim, RX.TRIGGERS.ON_TARGETED, targetedCtx);
    onHpMoved(state, actor, victim, out, action.element, "damage");
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
    // A counter's payload exists only to be fired BY the reaction. It sits on
    // the actor as a normal Attack item (and off the sheet's attack_list), so
    // without this it would be offered as a turn action.
    if (RX.REACTION_ONLY_ACTIONS.has(act.name)) return false;
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

  // Conflict-event turn-start hook. The Lightning Rod discharges here, through
  // the normal incoming pipeline — so an ABSORBING holder is healed and still
  // registers a bolt event for its passives, which is the interaction the
  // Valley roster is built on. Fires per ACTIVATION, not per round.
  if (state.event?.onTurnStart) {
    const strike = state.event.onTurnStart(state, actor);
    if (strike) {
      // cause "hazard" — the Storm's own strike must NOT move the Rod, or it
      // self-refreshes and never leaves its holder (lightning-storm-design.md,
      // Exclusions). Same filter covers DoT ticks.
      applyFlatDamage(state, actor, actor, strike.damage, strike.element, state.event.label, "hazard");
      const cap = actor.actor.mp.max ?? actor.mp;
      actor.mp = Math.min(cap, actor.mp + strike.mp);
      if (!actor.alive) return;
    }
  }

  if (actor.side === "party") refreshFocus(state);

  // Utility pre-empts the rotation, as it does in profiles.js: a turn spent
  // keeping somebody alive or handing out an extra action beats a turn of
  // damage. Free (granted) actions are attacks only -- they never re-spend the
  // support layer, which would let one Acceleration cascade into infinite heals.
  if (!granted && actor.side === "party") {
    const heal = U.tryHeal(state, actor);
    if (heal) {
      state.log.push({ round: state.round, actor: actor.name, action: "Heal", heal: heal.healed, amount: heal.amount });
      actor.baseActionsTaken++;
      return;
    }
    const acc = U.tryAccelerate(state, actor);
    if (acc) {
      state.log.push({ round: state.round, actor: actor.name, action: "Acceleration", target: acc.target });
      actor.baseActionsTaken++;
      return;
    }
  }

  const pick = chooseAction(state, actor);
  let action = pick?.action ?? null;
  let targets = pick?.targets ?? null;

  if (!action) {
    let w = weaponAction(actor);
    if (w) {
      // Barrage buys REACH on a ranged shot, so it fires whenever payable.
      const barraged = U.tryBarrage(actor, w);
      if (barraged) w = barraged;
      action = w;
      targets = chooseTargets(state, actor, w);
    }
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
function runBattle({ party, enemies, rng, expectedRounds = 7, maxRounds = 30, conflictEvent = null }) {
  const combatants = [
    ...party.map((a) => makeCombatant(a, "party")),
    ...enemies.map((a) => makeCombatant(a, "enemy")),
  ];

  const state = {
    combatants, round: 0, rng, log: [], focus: null,
    event: conflictEvent, rod: null, reactionDepth: 0,
  };
  if (state.event?.init) state.event.init(state);

  const order = combatants.slice().sort((a, b) => initiative(b) - initiative(a));

  let outcome = "inconclusive";
  // High Speed: a one-off free attack before the first round.
  for (const c of combatants) if (U.tryHighSpeed(c)) c.grantedTurns++;

  for (state.round = 1; state.round <= maxRounds; state.round++) {
    for (const c of combatants) c.protectedThisRound = 0;
    if (state.event?.onRoundStart) state.event.onRoundStart(state);
    for (const c of order) {
      if (!c.alive) continue;
      for (let t = 0; t < c.baseTurns; t++) {
        if (!c.alive) break;
        takeTurn(state, c);
      }
      // Acceleration is a RECURRING grant ("at the end of each of their turns,
      // perform a free attack"), so it is added every round rather than once.
      if (c.accelerated) c.grantedTurns++;

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
      damageDealt: c.damageDealt, reactionsFired: c.reactionsFired ?? 0,
    })),
    log: state.log,
  };
}

module.exports = { runBattle, makeCombatant, initiative, refreshFocus, weaponAction };
