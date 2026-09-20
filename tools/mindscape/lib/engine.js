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
const ST = require("./stances");
const T = require("./tinctures");

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
    // Fabula Points, spent only by gear that says so (survive_at_one).
    fp: Number(actor.fabulaPoints) || 0,
    fpSpent: 0,
    baseTurns: actor.turnsPerRound ?? 1,
    grantedTurns: 0,
    accelerated: false,
    protectedThisRound: 0,
    actions: ex.actions,
    utility: ex.utility,
    // Declared reactions (reactions.js). `ex.passives` was write-only before —
    // extracted, counted, never consulted.
    //
    // Scanned across EVERY item, not just Passives. A live reaction row lives on
    // whatever item carries it, and for the conditional-keyword pattern that is
    // the ATTACK itself: Kirin's Horn Rush is `skill_type: "Attack"` carrying a
    // `creature_will_deal_damage` row that doubles its own damage. Restricting
    // the scan to Passives made every reaction of that shape invisible.
    reactions: RX.declaredReactions([...ex.passives, ...ex.actions, ...ex.utility]),
    // Undeclared stays PASSIVE-only: an ordinary Attack is not a missing
    // reaction, and counting it as one would bury the real gaps in noise.
    undeclaredReactions: RX.undeclaredReactions(ex.passives),
    counters: {},          // stack_burst / stack_deny accumulators, keyed by counter name
    // Actions owed by a stack_deny (live: modify_turns pendingTurnDebt). Paid by
    // skipping this combatant's next base turn, this round or the next.
    turnDebt: 0,
    turnsDenied: 0,
    // Stance cycle (stances.js). `stance` is the form currently held; null means
    // the actor must arm before it may strike. `stanceCycle` is derived from the
    // actions themselves, so a spec cannot forget to opt in.
    stance: null,
    stanceCycle: ST.hasStanceCycle(ex.actions),
    // Weapon-read freshness counters, family -> n. Owned by the reactor: the
    // window is per-monster state, not per-attacker.
    weaponReads: {},
    shield: 0,
    // Tincture buffs held (lib/tinctures.js): kind -> { pct, turnsLeft }.
    buffs: {},
    // HP lost this round and last — the carrier's Endurance trigger reads the latter.
    takenThisRound: 0,
    takenLastRound: 0,
    tinctureBonusDealt: 0,   // extra damage a Strength/Spirit buff put on an HP bar
    tincturePrevented: 0,    // damage an Endurance buff kept off this creature
    tincturesUsed: 0,        // tinctures this creature handed out
    // Damage dealt split by the defence it was rolled against — the tincture carrier's
    // prior on who the party's DEF and MDEF carries are (tinctures.measureLanePrior).
    damageByLane: { def: 0, mdef: 0 },
    // Landed hits by lane — a flat tincture pays per hit, so its carrier prior counts
    // these rather than damage (tinctures.measureLanePrior).
    hitsByLane: { def: 0, mdef: 0 },
    alive: true,
    // Per-run accounting, split per spec D3.
    baseActionsTaken: 0,
    grantedActionsTaken: 0,
    damageDealt: 0,
    // Damage this creature actually lost, split by the defence the attack was rolled
    // against. A defensive item's value is the damage it prevents on its wearer, and a
    // +DEF item only touches the "def" share. Healing does not subtract.
    damageTaken: 0,
    damageTakenBy: { def: 0, mdef: 0, other: 0 },
    // Damaging action hits that landed on this creature (after Protect). Max HP is priced
    // against the size of a typical hit, which is damageTaken by action / hitsTaken.
    hitsTaken: 0,
    downedOnRound: null,
    crisisOnRound: null,
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

// Flat incoming reduction: the universal band plus the per-element one. A held
// Tincture of Endurance SUMS into the percentage, as damage_receiving_percentage_all
// does live; `withTincture: false` gives the figure it would have been without.
function reductionFor(target, element, { withTincture = true } = {}) {
  const d = target.actor.damageReduction;
  const tincture = withTincture ? T.reductionPct(target) : 0;
  if (!d) return { flat: 0, percent: tincture };
  return { flat: (d.flat ?? 0) + (d.byElement?.[element] ?? 0), percent: (d.percent ?? 0) + tincture };
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

    case "stack_deny": {
      // The counter lives on the VICTIM (live: an AE on the target), so every
      // attacker's hits on it share one stack — unlike stack_burst's own charge.
      const victim = ctx.victim;
      if (!victim?.alive) return;
      const n = (victim.counters[e.counter] ?? 0) + 1;
      if (n < e.threshold) { victim.counters[e.counter] = n; return; }
      victim.counters[e.counter] = 0;
      victim.turnDebt += 1;
      state.log.push({ round: state.round, actor: reactor.name, action: reaction.name, target: victim.name, reaction: true, turnDebt: victim.turnDebt });
      return;
    }

    case "weapon_read": {
      const fam = String(ctx.weaponFamily ?? "").toLowerCase();
      if (!fam) return;
      reactor.weaponReads = reactor.weaponReads ?? {};
      // Eviction stops at Crisis when the entry says so — that IS the Crisis
      // passive, so it is read here rather than needing its own registry row.
      // `evictUntilCrisis` (a registry entry freezing the window at Crisis) is
      // still honoured — no entry uses it since Ten Thousand Arms was retired,
      // but the hook costs nothing and the next adaptive monster may want it.
      const inCrisis = reactor.hp > 0 && reactor.hp <= reactor.maxHp / 2;
      const evict = e.evict !== false && !(reaction.evictUntilCrisis && inCrisis);
      const pct = RX.applyWeaponRead(
        reactor.weaponReads, reactor.actor.efficiency, fam,
        { window: e.window, curve: e.curve, evict },
      );
      state.log.push({
        round: state.round, actor: reactor.name, action: reaction.name,
        reaction: true, weaponRead: fam, efficiency: pct, frozen: !evict,
      });
      return;
    }

    // Handled at the damage seam, not here: by the time a reaction effect runs
    // the damage has already been written. `collect` is called separately from
    // resolveAction for this kind — see damageMultiplierFor().
    case "damage_mult":
      return;

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
    if (T.reductionPct(target)) {
      const bare = R.incomingDamage(
        { ...target.actor, damageReduction: reductionFor(target, element, { withTincture: false }) },
        { base: amount, element },
      ).damage;
      target.tincturePrevented += Math.max(0, bare - out.damage);
    }
    target.hp -= out.damage;
    target.damageTaken += out.damage;
    target.takenThisRound += out.damage;
    target.damageTakenBy.other += out.damage;
    if (source.side !== target.side) source.damageDealt += out.damage;
    if (target.hp <= 0) { target.hp = 0; target.alive = false; target.downedOnRound = state.round; }
    noteCrisis(state, target);
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
function onHpMoved(state, source, target, out, element, cause, action = null) {
  if (state.event?.onDamage && out.direction !== "recover") {
    state.event.onDamage(state, target, cause);
  }
  fireReactions(state, target, RX.TRIGGERS.ON_TAKE_ELEMENT, {
    element, damage: out.damage, direction: out.direction, cause, attacker: source,
  });
  if (source && source !== target && out.direction !== "recover") {
    // `action` is null for flat reaction/hazard damage, so an on-hit rider scoped to
    // basic attacks never fires off a burst.
    fireReactions(state, source, RX.TRIGGERS.ON_DEAL_DAMAGE, {
      victim: target, element, damage: out.damage,
      round: state.round, sourceAction: action?.name ?? null, isBasicAttack: !!action?.basicAttack,
    });
  }
}

// Product of every `damage_mult` reaction the actor holds that fires for this
// (action, victim) pair. 1.0 when none do, so the common path is a no-op.
//
// Crisis is read from live HP, not from a status flag, mirroring the live
// definition `current_hp <= crisis_hp ?? ceil(max_hp/2)`. A target this hit
// pushes INTO Crisis therefore does NOT earn Execute — the multiplier is
// decided before the damage lands, as it is in play.
// Stamp the round a creature first crossed into Crisis. Called from BOTH HP-write
// sites; a creature healed back above half keeps its FIRST crossing, because a
// designer timing a phase change cares when it started, not when it last was.
function noteCrisis(state, c) {
  if (c.crisisOnRound == null && c.alive && c.hp > 0 && c.hp <= c.maxHp / 2) {
    c.crisisOnRound = state.round;
  }
}

// Flat additive riders (live: adjust_damage with damage_operation "add"). Kept
// separate from the multiplier because the two compose in a fixed order: adds
// land on the base, then multipliers scale the sum -- which is what
// damage_stage "outgoing" means on both rows.
// One context for both damage-seam collectors, so an add and a multiplier can
// never disagree about which swing they are looking at.
function riderCtx(state, actor, action, victim) {
  return {
    sourceAction: action.name,
    victim,
    victimInCrisis: victim.hp > 0 && victim.hp <= victim.maxHp / 2,
    attackerInCrisis: actor.hp > 0 && actor.hp <= actor.maxHp / 2,
    attackerStance: actor.stance ?? null,
    element: action.element,
    // Equipment riders gate on WHEN and on WHAT KIND of swing. An even-round
    // bonus that cannot see the round reads it as undefined; one that cannot
    // tell a basic attack from a skill fires on both.
    round: state.round,
    isBasicAttack: !!action.basicAttack,
  };
}

// Victim-side pre-write reactions. Multipliers first (live: card incoming
// adjust_damage multiply, rounded up), then survive-at-1 caps whatever is left
// (live: the HP-write cap at CUR_HP - 1 binds only on a lethal hit). Action hits
// only — flat hazard/burst damage (applyFlatDamage) does not pass through here.
function applyTakeHitReactions(state, attacker, victim, out, element) {
  if (!victim?.reactions?.length) return out;
  const ctx = { attacker, victim, element, damage: out.damage };
  let dmg = out.damage;
  for (const r of RX.collect(victim, RX.TRIGGERS.ON_TAKE_HIT, ctx)) {
    if (r.effect?.kind !== "damage_taken_mult") continue;
    const f = Number(r.effect.factor);
    dmg = Math.max(0, Math.ceil(dmg * (Number.isFinite(f) ? f : 1)));
  }
  for (const r of RX.collect(victim, RX.TRIGGERS.ON_TAKE_HIT, { ...ctx, damage: dmg })) {
    if (r.effect?.kind !== "survive_at_one") continue;
    const cost = Number(r.effect.fpCost) || 0;
    if (dmg < victim.hp || victim.fp < cost) continue;
    victim.fp -= cost;
    victim.fpSpent += cost;
    dmg = Math.max(0, victim.hp - 1);
    state.log.push({ round: state.round, actor: victim.name, action: r.name, reaction: true, survivedAtOne: true });
    break;
  }
  return dmg === out.damage ? out : { ...out, damage: dmg };
}

function damageAddFor(state, actor, action, victim) {
  if (!actor?.reactions?.length) return 0;
  const ctx = riderCtx(state, actor, action, victim);
  let add = 0;
  for (const r of RX.collect(actor, RX.TRIGGERS.ON_DEAL_DAMAGE, ctx)) {
    if (r.effect?.kind !== "damage_add") continue;
    add += Number(r.effect.amount) || 0;
    // Level-scaled rider ("bonus damage equal to your level / 5"). Scaling is
    // how a gear bonus stays relevant from L20 to L50 — a flat one decays
    // (docs/equipment-balance-design.md, Part 4).
    const div = Number(r.effect.levelDiv) || 0;
    if (div > 0) add += Math.floor((Number(actor.actor.level) || 0) / div);
  }
  return add;
}

function damageMultiplierFor(state, actor, action, victim) {
  if (!actor?.reactions?.length) return 1;
  const ctx = riderCtx(state, actor, action, victim);
  let mult = 1;
  for (const r of RX.collect(actor, RX.TRIGGERS.ON_DEAL_DAMAGE, ctx)) {
    if (r.effect?.kind === "damage_mult") mult *= Number(r.effect.factor) || 1;
  }
  return mult;
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

    // ON_ATTACKED fires on hit AND miss — the defining property of the family of
    // reactions gated on `creature_hit_by_action` + `creature_miss_action`
    // together. Both of those are POST-resolve, so the attack that triggers a
    // read must not be scored against the read it caused: firing this before the
    // damage put every swing at the window's floor and cost ~2x the mechanic's
    // real weight. On a miss there is no damage step, so it fires here.
    const attackedCtx = {
      hit: check.hit, weaponFamily: action.weaponFamily ?? null,
      element: action.element, attacker: actor, victim: target, damage: 0,
    };

    // Pierce: a missed attack still deals HALF damage (live: action-profile's
    // pierceMiss, "miss-for-half ONLY" since 2026-08-02 — no affinity bypass).
    // A fumble is still a clean miss.
    const pierceMiss = !check.hit && !check.fumble && R.normalizeKeywords(action.keywords).includes("pierce");
    if (!check.hit) {
      state.log.push({ round: state.round, actor: actor.name, action: action.name, target: target.name, miss: true, pierce: pierceMiss });
      fireReactions(state, target, RX.TRIGGERS.ON_ATTACKED, attackedCtx);
      if (!pierceMiss) continue;
    }

    // A critical doubles nothing by itself in this system; it grants an
    // Opportunity, which the model does not resolve (spec Part 6 — the party
    // always taking Advantage is a live-sim simplification with no offline
    // analogue yet). So a crit here is only an auto-hit. Flagged, not silent.
    // Conditional keyword multipliers (Execute / Cripple) apply at the OUTGOING
    // stage, matching `damage_stage: "outgoing"` on the live adjust_damage row —
    // so weapon efficiency and element affinity both scale the doubled figure.
    // Collected rather than dispatched: the multiplier has to reach the number
    // before it is written, which is upstream of where reaction effects run.
    let base = R.outgoingDamage({
      hr: check.hr,
      damageBonus: action.damageBonus + extra + damageAddFor(state, actor, action, target),
    });
    base = Math.ceil(base * damageMultiplierFor(state, actor, action, target));
    if (pierceMiss) base = Math.floor(base / 2);

    // Record the efficiency this swing actually landed at, per family. Sampled
    // here — after any read the attack itself triggered, which is the number
    // that reached the damage — rather than reconstructed later.
    if (action.weaponFamily && target.actor?.efficiency) {
      const fam = String(action.weaponFamily).toLowerCase();
      state.laneStats = state.laneStats ?? {};
      const lane = (state.laneStats[fam] = state.laneStats[fam] ?? { swings: 0, effSum: 0 });
      lane.swings++;
      lane.effSum += Number(target.actor.efficiency[fam] ?? 100) || 100;
    }

    // Tincture of Strength / Spirit (lib/tinctures.js): after efficiency, before
    // affinity, and on a HIT only — live folds reaction ops on a hit, so a Pierce
    // half-damage miss is not boosted.
    const tinctureMult = check.hit ? T.outgoingMult(actor, action) : 1;
    const tinctureAdd = check.hit ? T.outgoingAdd(actor, action) : { postEfficiencyAdd: 0, baseAdd: 0 };
    const dmgSpec = {
      base,
      element: action.element,
      weaponFamily: action.weaponFamily,
      keywords: action.keywords,
      postEfficiencyMult: tinctureMult,
      postEfficiencyAdd: tinctureAdd.postEfficiencyAdd,
      baseAdd: tinctureAdd.baseAdd,
    };
    let out = R.incomingDamage(
      { ...target.actor, damageReduction: reductionFor(target, action.element) },
      dmgSpec,
    );
    // The same hit unboosted, so the report can say what the tincture added.
    const boosted = tinctureMult !== 1 || tinctureAdd.postEfficiencyAdd > 0 || tinctureAdd.baseAdd > 0;
    const unboosted = boosted
      ? R.incomingDamage(
        { ...target.actor, damageReduction: reductionFor(target, action.element) },
        { ...dmgSpec, postEfficiencyMult: 1, postEfficiencyAdd: 0, baseAdd: 0 },
      ).damage
      : null;

    // PROTECT: a defensive redirect resolved here rather than on a turn -- the
    // protector steps in front and takes the hit instead.
    //
    // CORRECTED 2026-09-13. The protector used to absorb the damage computed for the
    // ORIGINAL target. Live (card-mutations.js, the redirect_target mutation) and the
    // skill's own text ("any Checks that are part of the danger will be performed
    // against you") re-resolve the hit against the PROTECTOR: the same roll total vs the
    // protector's DEF/MDEF (a crit still hits, a fumble still misses), then damage
    // through the protector's own affinities and damage reduction. Without this a
    // Guardian's resistances and defence never touched a hit it protected.
    let victim = target;
    if (out.direction !== "recover" && actor.side === "enemy") {
      const prot = U.findProtector(state, target, out.damage);
      if (prot) {
        prot.protectedThisRound++;
        victim = prot;
        state.log.push({ round: state.round, actor: prot.name, action: "Protect", target: target.name, protect: true });
        const protDl = action.defenseTarget === "mdef" ? prot.actor.mdef : prot.actor.def;
        const protHit = check.crit ? true : (!check.fumble && check.result >= protDl);
        if (!protHit) {
          state.log.push({ round: state.round, actor: actor.name, action: action.name, target: prot.name, miss: true, protected: target.name });
          attackedCtx.victim = prot;
          fireReactions(state, prot, RX.TRIGGERS.ON_ATTACKED, { ...attackedCtx, hit: false });
          continue;
        }
        out = R.incomingDamage(
          { ...prot.actor, damageReduction: reductionFor(prot, action.element) },
          dmgSpec,
        );
      }
    }

    // ON_TAKE_HIT — the defender's own pre-write adjustments (damage-taken
    // multipliers, survive-at-1), after Protect has settled who the victim is.
    if (out.direction !== "recover" && out.damage > 0) {
      out = applyTakeHitReactions(state, actor, victim, out, action.element);
    }

    // ON_TARGETED is COLLECTED here — before the HP write — because the live
    // trigger is pre-resolve. Deferring the collection past the write would
    // silently drop every riposte to a lethal hit.
    const targetedCtx = {
      accuracyResult: check.result, hit: true, damage: out.damage,
      element: action.element, attacker: actor, victim,
    };

    let hpBefore = null;
    if (out.direction === "recover") {
      target.hp = Math.min(target.maxHp, target.hp + out.damage);
    } else {
      // `victim` is the target unless a protector stepped in front.
      hpBefore = victim.hp;
      victim.hp -= out.damage;
      victim.damageTaken += out.damage;
      victim.takenThisRound += out.damage;
      if (unboosted != null && victim === target) {
        // Only what reached the HP bar counts: overkill on a dying target is waste.
        actor.tinctureBonusDealt += Math.max(0, Math.min(out.damage, hpBefore) - Math.min(unboosted, hpBefore));
      }
      if (T.reductionPct(victim)) {
        const bare = R.incomingDamage(
          { ...victim.actor, damageReduction: reductionFor(victim, action.element, { withTincture: false }) },
          dmgSpec,
        ).damage;
        victim.tincturePrevented += Math.max(0, bare - out.damage);
      }
      victim.damageTakenBy[action.defenseTarget === "mdef" ? "mdef" : "def"] += out.damage;
      if (out.damage > 0) victim.hitsTaken++;
      actor.damageDealt += out.damage;
      actor.damageByLane[action.defenseTarget === "mdef" ? "mdef" : "def"] += out.damage;
      if (out.damage > 0) actor.hitsByLane[action.defenseTarget === "mdef" ? "mdef" : "def"]++;
      if (victim.hp <= 0) {
        victim.hp = 0;
        victim.alive = false;
        victim.downedOnRound = state.round;
      }
      noteCrisis(state, victim);
    }

    state.log.push({
      round: state.round, actor: actor.name, action: action.name, target: target.name,
      damage: out.damage, affinity: out.affinity, crit: check.crit, direction: out.direction,
      // Spike accounting (bin/tincture-matrix.js): how big the hit was against what it
      // hit, whether it killed, and what it would have dealt without a tincture.
      side: actor.side, hpBefore, victimMaxHp: victim.maxHp,
      killed: out.direction !== "recover" && !victim.alive,
      ...(unboosted != null ? { unboosted } : {}),
    });

    fireReactions(state, victim, RX.TRIGGERS.ON_TARGETED, targetedCtx);
    // Post-resolve, per the trigger's live timing (see attackedCtx above).
    // Fired on `target`, not `victim`: a Protect redirect changes who took the
    // damage, but the creature that was ATTACKED is still the one that reads
    // the weapon.
    attackedCtx.damage = out.damage;
    fireReactions(state, target, RX.TRIGGERS.ON_ATTACKED, attackedCtx);
    onHpMoved(state, actor, victim, out, action.element, "damage", action);
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
    // Stance legality, before targeting: an unarmed stance monster has exactly
    // one legal move and must not be scored against attacks it cannot make.
    if (!ST.isLegal(act, actor)) return false;
    if (act.stanceGrants) return true;         // arming: no targets, no cost
    const t = chooseTargets(state, actor, act);
    return t.length > 0 && canAfford(actor, act, t.length);
  });
  if (!affordable.length) return null;

  // An arming action deals no damage, so the damage-maximising scorer below
  // would never pick it. When it is legal it is also the ONLY legal move (see
  // stances.isLegal), so take it directly rather than teaching the scorer to
  // value a turn that sets up a future one.
  const arming = affordable.find((a) => a.stanceGrants);
  if (arming) return { action: arming, targets: [], score: 0, arming: true };

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
    keywords: w.keywords ?? null,
    weaponFamily: actor.actor.weapon?.family ?? null,
    // The sheet loader never sets this, so world weapons still read 0; a paper
    // weapon from --equip carries its own check_bonus.
    checkBonus: Number(w.checkBonus) || 0,
    // A BASIC attack — what "when you attack with this weapon" means for gear
    // riders. Skill actions never carry it.
    basicAttack: true,
  };
}

// Attack-declaration riders (ON_DECLARE_ATTACK). Anything that changes an
// attack's REACH must run before targets are chosen, which no post-roll trigger
// can do. Returns the action unchanged, or a COPY with the raised target count —
// never a mutation, because a skill action object is shared across turns.
//
// Multi N is a maximum, not a sum: a rider wanting 3 on a Barraged shot (2)
// yields 3, not 5.
function declareRiders(state, actor, action) {
  if (!actor?.reactions?.length) return action;
  const ctx = {
    round: state.round, sourceAction: action.name,
    isBasicAttack: !!action.basicAttack, attacker: actor,
  };
  let out = action;
  for (const r of RX.collect(actor, RX.TRIGGERS.ON_DECLARE_ATTACK, ctx)) {
    if (r.effect?.kind !== "target_count") continue;
    const want = Number(r.effect.count) || 0;
    if (want > (out.target?.count ?? 1)) {
      out = { ...out, target: { ...out.target, count: want } };
      state.log.push({
        round: state.round, actor: actor.name, action: r.name,
        reaction: true, announce: true, targetCount: want,
      });
    }
  }
  return out;
}

// ── Tinctures ───────────────────────────────────────────────────────────────
// Expected damage per round `c` would deal with actions rolled against `lane`
// ("def" | "mdef"), against the party's called target. Hit chance is in the number
// (a boost on an ally who cannot land that lane is worth nothing), and so are the
// turns they take a round. A selection heuristic for the carrier only; the report
// measures what the tincture actually added.
function projectLane(state, c, lane) {
  const foes = livingFoes(state, c.side);
  if (!foes.length) return 0;
  const focus = state.focus && state.focus.alive
    ? state.focus
    : foes.slice().sort((x, y) => x.hp - y.hp)[0];
  const a = attrs(c);
  const candidates = c.actions.filter((act) =>
    act.defenseTarget === lane && !act.stanceGrants && !RX.REACTION_ONLY_ACTIONS.has(act.name)
    && act.target?.side !== "ally" && act.target?.side !== "self" && canAfford(c, act, 1));
  const w = weaponAction(c);
  if (w && lane === "def") candidates.push(w);

  let best = 0;
  for (const act of candidates) {
    const dieA = a[act.attrA] ?? 8, dieB = a[act.attrB] ?? 8;
    const dl = lane === "mdef" ? focus.actor.mdef : focus.actor.def;
    const p = R.hitChance(dieA, dieB, checkBonusFor(c, act), dl);
    const proj = R.projectDamage(focus.actor, {
      dieA, dieB, damageBonus: act.damageBonus,
      element: act.element, weaponFamily: act.weaponFamily, keywords: act.keywords,
    });
    if (proj.direction === "recover") continue;
    const count = act.target?.count === Infinity ? foes.length : Math.min(act.target?.count ?? 1, foes.length);
    best = Math.max(best, p * proj.damage * count);
  }
  return best * ((c.baseTurns ?? 1) + (c.accelerated ? 1 : 0));
}

function tryTincture(state, actor) {
  if (!state.tinctures) return null;
  const pick = T.chooseTincture(state, actor, { projectLane: (c, lane) => projectLane(state, c, lane) });
  if (!pick) return null;
  T.drink(state, actor, pick);
  return pick;
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
    // A tincture is an Inventory action: it spends the carrier's whole turn.
    const tin = tryTincture(state, actor);
    if (tin) {
      const label = tin.kind.charAt(0).toUpperCase() + tin.kind.slice(1);
      state.log.push({ round: state.round, actor: actor.name, action: `Tincture of ${label}`, target: tin.target.name, tincture: tin.kind });
      actor.baseActionsTaken++;
      return;
    }
  }

  const pick = chooseAction(state, actor);
  let action = pick?.action ?? null;
  let targets = pick?.targets ?? null;

  // Arming spends the whole activation and produces no damage. This is the
  // cadence the whole stance abstraction exists to model — a 4-activation boss
  // that must arm before each strike lands 2 attacks per round, not 4.
  if (pick?.arming) {
    const stance = ST.arm(actor, action, state.rng);
    state.log.push({
      round: state.round, actor: actor.name, action: action.name,
      stance, arming: true,
    });
    actor.baseActionsTaken++;
    return;
  }

  if (!action) {
    let w = weaponAction(actor);
    if (w) {
      // Barrage buys REACH on a ranged shot, so it fires whenever payable.
      const barraged = U.tryBarrage(actor, w);
      if (barraged) w = barraged;
      // Gear riders AFTER Barrage, so a larger Multi wins over Barrage's 2.
      w = declareRiders(state, actor, w);
      action = w;
      targets = chooseTargets(state, actor, w);
    }
  }

  if (!action || !targets?.length) {
    state.log.push({ round: state.round, actor: actor.name, action: "(guard)", idle: true });
  } else {
    resolveAction(state, actor, action, targets);
    // A strike spends the stance that permitted it — which is what forces the
    // next activation back onto the arming action. Consumed even if every
    // target was missed: in play the form is committed the moment it swings.
    ST.consume(actor, action);
  }

  if (granted) actor.grantedActionsTaken++;
  else actor.baseActionsTaken++;
}

// ── The run ─────────────────────────────────────────────────────────────────
// `tinctures`: { pct: { strength, spirit, endurance }, user, stock } — null (the
// default) leaves every fight exactly as it was.
function runBattle({ party, enemies, rng, expectedRounds = 7, maxRounds = 30, conflictEvent = null, tinctures = null }) {
  const combatants = [
    ...party.map((a) => makeCombatant(a, "party")),
    ...enemies.map((a) => makeCombatant(a, "enemy")),
  ];

  const state = {
    combatants, round: 0, rng, log: [], focus: null,
    event: conflictEvent, rod: null, reactionDepth: 0,
  };
  if (state.event?.init) state.event.init(state);
  state.tinctures = tinctures ? T.makeTinctureState(tinctures) : null;

  const order = combatants.slice().sort((a, b) => initiative(b) - initiative(a));
  // Worst-case tincture opener (tinctures.makeTinctureState carrierFirst): the carrier
  // moves to the front, so a round-1 tincture lands before the carry's first volley.
  if (state.tinctures?.carrierFirst) {
    const i = order.findIndex((c) => c.side === "party" && String(c.name).trim().toLowerCase() === state.tinctures.user);
    if (i > 0) order.unshift(order.splice(i, 1)[0]);
  }

  let outcome = "inconclusive";
  // High Speed: a one-off free attack before the first round.
  for (const c of combatants) if (U.tryHighSpeed(c)) c.grantedTurns++;

  for (state.round = 1; state.round <= maxRounds; state.round++) {
    for (const c of combatants) {
      c.protectedThisRound = 0;
      c.takenLastRound = c.takenThisRound;
      c.takenThisRound = 0;
    }
    if (state.event?.onRoundStart) state.event.onRoundStart(state);
    for (const c of order) {
      if (!c.alive) continue;
      for (let t = 0; t < c.baseTurns; t++) {
        if (!c.alive) break;
        if (c.turnDebt > 0) {
          c.turnDebt--;
          c.turnsDenied++;
          state.log.push({ round: state.round, actor: c.name, action: "(turn lost)", denied: true });
          T.tickTurnEnd(c);
          continue;
        }
        takeTurn(state, c);
        // Tinctures count down at the end of the bearer's own BASE turn (live
        // target_turn_end). Granted free attacks below are not turns.
        T.tickTurnEnd(c);
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
    // When each enemy crossed into Crisis (HP <= half). A designer picking WHEN
    // a phase change lands needs this as directly as they need the round count:
    // "the fight switches up at Crisis" is a promise about a moment, and a
    // moment that arrives on the last round is a phase that never happened.
    // Recorded at the crossing, so a creature healed back above half keeps its
    // first crossing rather than reporting the last one.
    crisisRounds: combatants
      .filter((c) => c.side === "enemy")
      .map((c) => ({ name: c.name, round: c.crisisOnRound ?? null })),
    // Spec D3: strictly separated so they can never double-count.
    baselineDpr: rounds ? partyDamage / rounds : 0,
    baseActions, grantedActions,
    roundDensity: (rounds && partyC.length)
      ? (baseActions + grantedActions) / (partyC.length * rounds)
      : 0,
    combatants: combatants.map((c) => ({
      name: c.name, side: c.side, hp: c.hp, maxHp: c.maxHp, alive: c.alive,
      damageDealt: c.damageDealt, reactionsFired: c.reactionsFired ?? 0,
      // Per-combatant turn counts, so an equipment A/B can see whether an arm
      // changed how often the wielder swings (Acceleration, fight length).
      baseActionsTaken: c.baseActionsTaken, grantedActionsTaken: c.grantedActionsTaken,
      damageTaken: c.damageTaken, damageTakenBy: { ...c.damageTakenBy }, hitsTaken: c.hitsTaken,
      downedOnRound: c.downedOnRound, fpSpent: c.fpSpent, turnsDenied: c.turnsDenied,
      tinctureBonusDealt: c.tinctureBonusDealt, tincturePrevented: c.tincturePrevented,
      tincturesUsed: c.tincturesUsed, damageByLane: { ...c.damageByLane }, hitsByLane: { ...c.hitsByLane },
    })),
    tinctures: state.tinctures
      ? {
        pct: { ...state.tinctures.pct },
        flat: { ...(state.tinctures.flat ?? {}) },
        flatMode: state.tinctures.flatMode,
        used: { ...state.tinctures.used },
      }
      : null,
    // Per-lane weapon-efficiency pressure. Only populated when something in the
    // fight actually reads weapon families, so it costs nothing otherwise.
    //
    // This exists because a weapon-rotation mechanic is designed as a TEMPO
    // ("show it four different weapons and the first recovers") but experienced
    // as a MULTIPLIER, and the two only agree if the party can actually field
    // that many lanes. Without this table a design that collapses to one lane
    // reads as a plain damage nerf and nothing says why.
    laneReport: state.laneStats ? summariseLanes(state.laneStats) : null,
    log: state.log,
  };
}

// swings + summed efficiency per family -> mean efficiency and damage share.
function summariseLanes(stats) {
  const total = Object.values(stats).reduce((s, l) => s + l.swings, 0);
  const out = {};
  for (const [fam, l] of Object.entries(stats)) {
    out[fam] = {
      swings: l.swings,
      share: total ? l.swings / total : 0,
      meanEfficiency: l.swings ? l.effSum / l.swings : 100,
    };
  }
  return out;
}

module.exports = { runBattle, makeCombatant, initiative, refreshFocus, weaponAction };
