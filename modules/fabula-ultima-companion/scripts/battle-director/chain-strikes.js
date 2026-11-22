// ── Chain N — pure strike planner ──────────────────────────────────────────
//
// A Chain N action is ONE action card and N hits. By default (bare `chain N`)
// it is one roll shown as N hits — planSingleChain below. A SEPARATE Chain
// (`separate` / `random` / `pick` / `seek` / `volley`) is N strikes: strike 1 is the roll the card
// shows; strikes 2..N are rolled when the card is confirmed and stay hidden
// until they land. Every separate strike rolls its own accuracy and damage, so
// each one can miss, crit, or be stopped on its own.
//
// This module holds the parts of that rule that need no Foundry: reading the
// keyword, choosing per-strike targets, and walking the strikes in order
// against each target's running state (HP, shield, one-shot blockers, the
// hits-this-turn tally). The engine side supplies the dice and the damage
// math through callbacks, so everything here runs under plain node.
//
//     node scripts/battle-director/chain-strikes.test.mjs
//
// Rules the walk enforces (user decisions, 2026-10-29):
//   - a target that drops to 0 HP loses its remaining strikes;
//   - statuses from a strike land with the commit, so they never change a
//     later strike in the same action — only HP, shield, blockers and the
//     hit tally carry from strike to strike;
//   - crits count per strike, but the sequence grants at most ONE
//     Opportunity to each side (first crit for the attacker, first fumble
//     for the defenders);
//   - the hit count is landed strikes; a miss never counts.

// Players see ONE keyword, Chain; the author picks how it resolves (user,
// 2026-10-29 — two keywords would be keyword overload):
//   single   — bare `chain 3`: ONE Accuracy Check and one damage roll, shown as
//              3 hits (planSingleChain). Every passive treats it as one hit.
//   separate — each hit rolls its own check and damage, on the card's targets.
//   random   — separate hits, each on a random card target.
//   pick     — separate hits, round-robin over the picked targets.
//   seek     — like random, but the card keeps EVERY target (a storm over the
//              field), and a hit drawn onto a creature already reduced to 0 HP
//              by an earlier hit goes to a random target still standing
//              instead of being lost (user, 2026-11-06: Rumbling Staves'
//              Thunderstorm). See redirectSeek().
//   volley   — like random (each shot on a random card target, each rolling its
//              own accuracy), but the attacker's FLAT damage bonuses are counted
//              ONCE and shared across the shots (user, 2026-11-21: Tommy Gun).
//              See splitVolleyFlat() / volleyShotContext().
// A one-roll Chain can add `hidden` (`chain 8 hidden`): a pure presentation
// split the player is not told about, so the action card shows no Chain badge.
export const CHAIN_MODES = Object.freeze(["single", "separate", "random", "pick", "seek", "volley"]);
// 30: Zarg's Meteor Shower volley is a 24-hit one-roll Chain (Zero Power overhaul, 2026-11-06).
export const CHAIN_MAX = 30;

// Keyword forms accepted on an item's `action_keywords` list (already split
// and lowercased by the caller, or a raw string):
//   "chain 3", "chain(3)", "chain x3", "chain:3", "chain 3 separate",
//   "chain 3 random", "chain 3 pick", "chain 3 seek", "chain 5 volley", "chain 8 hidden"
//   "chain {FORMULA}" (+ any mode word) - the count is a skill formula, evaluated
//   when the action is COMPUTED (chain-plan.js chainSpecFor `evalCount`), e.g. Keren's
//   Last Den of Cinders: one hit per summon strike + the blast + the last hit. The
//   formula keeps its case (identifiers are upper-case) and must not contain a comma
//   (the keyword list splits on commas). Returns { count: null, formula, mode }.
// The bare word "chain" without a count is NOT a Chain — it is ignored, so a
// stray label can never turn an action into a multi-strike one.
const CHAIN_RX = /^chain\s*[:x(]?\s*(\d+)\s*\)?(?:\s*[:,]?\s*(separate|random|pick|seek|volley|hidden))?$/;
const CHAIN_FORMULA_RX = /^chain\s*\{([^{}]+)\}(?:\s*[:,]?\s*(separate|random|pick|seek|volley|hidden))?$/i;

export function parseChainKeyword(keywords) {
  const list = Array.isArray(keywords)
    ? keywords
    : String(keywords ?? "").split(/[,\n]+/);
  for (const raw of list) {
    const f = CHAIN_FORMULA_RX.exec(String(raw ?? "").trim());
    if (f) {
      const mode = f[2] ? f[2].toLowerCase() : null;
      if (mode === "hidden") return { count: null, formula: f[1].trim(), mode: "single", hidden: true };
      return { count: null, formula: f[1].trim(), mode: mode ?? "single" };
    }
    const m = CHAIN_RX.exec(String(raw ?? "").trim().toLowerCase());
    if (!m) continue;
    const count = Math.min(CHAIN_MAX, Math.max(0, Math.floor(Number(m[1]) || 0)));
    if (count < 2) continue;              // Chain 1 is just an action
    if (m[2] === "hidden") return { count, mode: "single", hidden: true };
    return { count, mode: m[2] ?? "single" };
  }
  return null;
}

// A formula Chain's count, once evaluated: the same clamp and "under 2 is no Chain" rule
// as a literal count. Returns the finished spec (formula dropped) or null.
export function resolveChainCount(spec, value) {
  if (!spec || spec.formula == null) return spec ?? null;
  const count = Math.min(CHAIN_MAX, Math.max(0, Math.floor(Number(value) || 0)));
  if (count < 2) return null;
  const { formula, ...rest } = spec;
  return { ...rest, count };
}

// A Chain whose hits each roll (everything but the one-roll default).
export function isSeparateChain(spec) {
  return !!spec && spec.mode !== "single";
}

// Modes whose strikes are drawn one target each from the card's targets.
export function isDrawnChainMode(mode) {
  return mode === "random" || mode === "seek" || mode === "volley";
}

// ── Volley: flat bonuses counted once, shared across the shots ─────────────
// One shot's share of a flat bonus `total` split over `shots` shots: the floor
// per shot, the remainder going to the earliest shots, so the shares always add
// up to the total exactly (10 over 5 = 2,2,2,2,2; 7 over 5 = 2,2,1,1,1). A
// negative total splits the same way with its sign. `shot` is 0-based.
export function splitVolleyFlat(total, shots, shot) {
  const T = Math.trunc(Number(total) || 0);
  const n = Math.max(1, Math.floor(Number(shots) || 1));
  const k = Math.max(0, Math.floor(Number(shot) || 0));
  if (k >= n || T === 0) return 0;
  const sign = T < 0 ? -1 : 1;
  const a = Math.abs(T);
  return sign * (Math.floor(a / n) + (k < a % n ? 1 : 0));
}

// What the damage engine needs to price volley shot k (1-based):
//   shots / shot — the action-wide split, for the attacker's own flat bonuses
//                  (outgoing damage parts): counted once for the ACTION and
//                  shared over all its shots;
//   targets      — per creature, how many shots are aimed at it and which of
//                  them this one is: a per-target flat bonus (a reaction's +6
//                  on that creature) is counted once for THAT creature and
//                  shared over the shots aimed at it. `shot` is null when shot
//                  k is not aimed at the creature (its card row then shows its
//                  first share).
// Null for anything but a volley Chain.
export function volleyShotContext(spec, k = 1) {
  if (!spec || spec.mode !== "volley" || !(Number(spec.count) >= 2)) return null;
  const shots = Math.floor(Number(spec.count));
  const idx = Math.min(shots, Math.max(1, Math.floor(Number(k) || 1))) - 1;
  const lists = Array.isArray(spec.strikeTargets) && spec.strikeTargets.length ? spec.strikeTargets : null;
  const targets = {};
  if (lists) {
    lists.forEach((list, i) => {
      for (const u of list ?? []) {
        if (!u) continue;
        const t = targets[u] ?? (targets[u] = { shots: 0, shot: null });
        if (i === idx) t.shot = t.shots;
        t.shots++;
      }
    });
  }
  return { shots, shot: idx, targets };
}

// One creature's share of a per-target flat bonus (see volleyShotContext).
// Falls back to the action-wide split when the shots were never drawn per creature.
export function volleyTargetShare(volley, uuid, total) {
  if (!volley) return Number(total) || 0;
  const t = uuid ? volley.targets?.[uuid] : null;
  if (!t || !(t.shots > 0)) return splitVolleyFlat(total, volley.shots, volley.shot);
  return splitVolleyFlat(total, t.shots, t.shot ?? 0);
}

// A volley shot's flat-bonus split for the damage engine (action-profile):
//   primary: { damageBonus, grantDamageBonus, outgoingTotal } — damageBonus is
//            the weapon's / skill's own bonus plus any free-action grant's.
// The shot's base is (HR + ownBonus) × the attacker's damage_dealt_mult, then
// + flatShare (not multiplied again). The ATTACKER's flat bonuses are the
// outgoing damage parts (Powerful Shot +10, extra_damage_mod_*) and the grant's
// damage; they are totalled once and split over every shot of the action.
export function volleyPrimary(primary, volley) {
  if (!volley) return null;
  const grant = Number(primary?.grantDamageBonus) || 0;
  const flatTotal = (Number(primary?.outgoingTotal) || 0) + grant;
  return {
    shots: volley.shots, shot: volley.shot, targets: volley.targets ?? {},
    ownBonus: (Number(primary?.damageBonus) || 0) - grant,
    flatTotal,
    flatShare: splitVolleyFlat(flatTotal, volley.shots, volley.shot),
  };
}

// A volley shot's reaction damage ops on one creature: a flat add / subtract
// (a "+6 per hit" carried by a reaction) is counted once for that creature and
// shared over the shots aimed at it. Multiply, set, cap, element / keyword ops
// stay per shot, unchanged; a final-stage formula op is shared later, once
// its per-shot amount is known (volleyFinalShare).
export function volleyShareOps(ops, volley, uuid) {
  if (!volley || !Array.isArray(ops) || !ops.length) return ops;
  return ops.map((o) => ((o?.op === "add" || o?.op === "subtract") && !o.finalFormula
    ? { ...o, amount: volleyTargetShare(volley, uuid, Number(o.amount) || 0), volleyTotal: Number(o.amount) || 0 }
    : o));
}

// A volley shot's share of a FINAL-stage bonus (Vital Strike: + DEX die when
// the hit would put the target into Crisis). The engine still evaluates the
// formula per shot, against that shot's own predicted damage; a flat add /
// subtract amount is then counted once for the creature and this shot keeps its
// share (same split as volleyTargetShare). A multiply stays per shot.
export function volleyFinalShare(op, amount, volley, uuid) {
  if (!volley || !(op === "add" || op === "subtract")) return amount;
  return volleyTargetShare(volley, uuid, amount);
}

// Small seeded PRNG (mulberry32) — deterministic tests and replays. The engine
// passes Math.random; tests pass makeRng(seed).
export function makeRng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Per-strike target lists.
//   same   — every strike hits every card target (Chain on an AoE hits them all).
//   random — each strike hits ONE target drawn from `pool` (with replacement).
//   seek   — drawn the same way as random (the redirect happens at RESOLVE).
//   volley — drawn the same way as random.
//   pick   — the strikes go round-robin over the creatures the player picked,
//            in pick order: pick one and every strike lands on it, pick two
//            for Chain 3 and it is A, B, A. (No new picker: the normal target
//            pick decides who; the order decides who takes the extra strike.)
// Returns { strikeTargets: string[][], cardTargets: string[] } where
// cardTargets is the distinct set in first-hit order (what the card shows).
export function assignStrikeTargets({ count, mode = "same", cardTargets = [], pool = [], picks = [], rng = Math.random } = {}) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  const strikeTargets = [];
  if (isDrawnChainMode(mode) && pool.length) {
    for (let i = 0; i < n; i++) strikeTargets.push([pool[Math.floor(rng() * pool.length) % pool.length]]);
  } else if (mode === "pick" && picks.length) {
    for (let i = 0; i < n; i++) strikeTargets.push([picks[i % picks.length]]);
  } else {
    for (let i = 0; i < n; i++) strikeTargets.push([...cardTargets]);
  }
  const seen = new Set();
  const distinct = [];
  for (const list of strikeTargets) for (const t of list) if (t && !seen.has(t)) { seen.add(t); distinct.push(t); }
  return { strikeTargets, cardTargets: distinct.length ? distinct : [...cardTargets] };
}

// Seek mode: one strike's drawn targets, with every creature already down
// swapped for a random creature from `pool` that is still standing. Several
// downed picks can land on the same survivor (the draw is with replacement).
// When nobody in the pool stands, the target is kept and the walker records
// the strike as lost, exactly as random mode does.
//   targets:  string[]            the strike's drawn targets
//   pool:     string[]            the card's targets
//   standing: (uuid) => boolean   the walker's running HP check
export function redirectSeek(targets = [], pool = [], standing = () => true, rng = Math.random) {
  const alive = pool.filter((u) => u && standing(u));
  return targets.map((u) => {
    if (!u || standing(u) || !alive.length) return u;
    return alive[Math.floor(rng() * alive.length) % alive.length];
  });
}

// Apply one strike's damage to a target's running state. Mirrors the engine's
// order: affinity has already been applied by the caller (amount is final);
// absorb heals up to max HP; otherwise shield soaks first, then HP.
//   state:   { hp, maxHp, shield }
//   outcome: { kind: "hit"|"absorb"|"immune"|"block"|"miss", amount }
// Returns the deltas actually applied, for numbers / bars / ledger events.
export function applyStrikeToState(state, outcome) {
  const before = { hp: state.hp, shield: state.shield };
  let hpLoss = 0, shieldLoss = 0, hpGain = 0;
  const amount = Math.max(0, Math.floor(Number(outcome?.amount) || 0));
  if (outcome?.kind === "absorb") {
    const room = Math.max(0, (state.maxHp ?? Infinity) - state.hp);
    hpGain = Math.min(room, amount);
    state.hp += hpGain;
  } else if (outcome?.kind === "hit") {
    shieldLoss = Math.min(Math.max(0, state.shield), amount);
    state.shield -= shieldLoss;
    hpLoss = Math.min(Math.max(0, state.hp), amount - shieldLoss);
    state.hp -= hpLoss;
  }
  return { hpBefore: before.hp, hpAfter: state.hp, shieldBefore: before.shield, shieldAfter: state.shield, hpLoss, shieldLoss, hpGain };
}

// Walk the strikes in order.
//
//   strikes:  [{ index, roll: { total, hr, isCrit, isFumble, dice }, targets: [uuid] }]
//   states:   Map(uuid → { hp, maxHp, shield, blockers, priorHits, noKo })
//             blockers  = one-shot negations still available (Ninja Log);
//             priorHits = hits this attacker already landed on it this turn;
//             noKo      = the pool is not HP (MP damage), so 0 is not a KO.
//   evaluate: (strike, uuid, state) → { hit, kind, amount, affinity, element, isCrit, pierce, blockedBy?, defense? }
//             The engine's per-target accuracy + damage for this strike's roll.
//             It reads state.priorHits (Champion Gloves) and state.blockers.
//             A miss returns { hit:false, kind:"miss" }; a blocker that
//             stopped the strike returns { hit:true, kind:"block", blockedBy }.
//             kind is "hit" | "absorb" | "immune" for a strike that connected.
//
// planStrikes walks everything at once. The engine uses createStrikeWalker
// instead, because it recomputes each strike's damage (async) between steps.
export function createStrikeWalker(states = new Map()) {
  const outStrikes = [];
  const perTarget = new Map();
  const touch = (uuid) => {
    if (!perTarget.has(uuid)) perTarget.set(uuid, {
      tokenUuid: uuid, strikes: 0, landed: 0, hitsLanded: 0, missed: 0, crits: 0, blocked: 0, lost: 0,
      damage: 0, hpLoss: 0, shieldLoss: 0, hpGain: 0, defeated: false, defeatedOnStrike: null,
    });
    return perTarget.get(uuid);
  };
  let firstCritStrike = null;
  let firstFumbleStrike = null;
  let landedTotal = 0;

  // Whether a target is still standing — the engine skips the recompute for a
  // downed target, since its strike is lost either way.
  const standing = (uuid) => {
    const st = states.get(uuid);
    return !!st && (st.noKo || st.hp > 0);
  };

  function step(strike, evaluate) {
    const roll = strike.roll ?? {};
    if (roll.isCrit && firstCritStrike == null) firstCritStrike = strike.index;
    if (roll.isFumble && firstFumbleStrike == null) firstFumbleStrike = strike.index;
    const outcomes = [];
    for (const uuid of strike.targets ?? []) {
      const tally = touch(uuid);
      tally.strikes++;
      const state = states.get(uuid);
      if (!state) { outcomes.push({ tokenUuid: uuid, kind: "skip" }); continue; }
      if (!state.noKo && state.hp <= 0) {
        // Downed earlier in this sequence: the strike is lost, not missed.
        tally.lost++;
        outcomes.push({ tokenUuid: uuid, kind: "lost" });
        continue;
      }
      const ev = evaluate(strike, uuid, state) ?? { hit: false, kind: "miss" };
      if (!ev.hit) {
        tally.missed++;
        outcomes.push({ tokenUuid: uuid, kind: "miss", defense: ev.defense ?? null });
        continue;
      }
      if (ev.kind === "block") {
        if (state.blockers > 0) state.blockers--;
        tally.blocked++;
        outcomes.push({ tokenUuid: uuid, kind: "block", blockedBy: ev.blockedBy ?? null, defense: ev.defense ?? null });
        continue;
      }
      const applied = applyStrikeToState(state, ev);
      tally.landed++;
      landedTotal++;
      // A pierce half-hit is a miss that still deals damage: it lands, but it
      // never counts toward the hits-this-turn tally (Champion Gloves).
      if (!ev.pierce) {
        tally.hitsLanded++;
        state.priorHits = (state.priorHits ?? 0) + 1;
      }
      if (ev.isCrit) tally.crits++;
      tally.damage += Math.max(0, Math.floor(Number(ev.amount) || 0));
      tally.hpLoss += applied.hpLoss;
      tally.shieldLoss += applied.shieldLoss;
      tally.hpGain += applied.hpGain;
      const downedNow = !state.noKo && state.hp <= 0 && !tally.defeated;
      if (downedNow) {
        tally.defeated = true;
        tally.defeatedOnStrike = strike.index;
      }
      outcomes.push({
        tokenUuid: uuid, kind: ev.kind ?? "hit", amount: Math.max(0, Math.floor(Number(ev.amount) || 0)),
        affinity: ev.affinity ?? "NE", element: ev.element ?? "", isCrit: !!ev.isCrit, pierce: !!ev.pierce,
        defense: ev.defense ?? null,
        ...applied, killing: downedNow,
      });
    }
    outStrikes.push({ index: strike.index, roll, outcomes });
  }

  // Perfect (carrier-attack.js `perfectMult`, Sonic Blow ×1.5): when EVERY strike
  // of the sequence landed on every creature it was aimed at, the attack deals
  // `mult` × its damage — each target takes round(its strikes' total × (mult − 1))
  // more, shown as one extra gold hit after the last strike (approved mockup:
  // "the ×1.5 as one gold hit"). Not a strike: it rolls nothing, counts as no
  // hit and no crit, and only touches HP / shield. Returns the added strike or null.
  function perfect(mult) {
    const m = Number(mult);
    if (!(m > 1) || !outStrikes.length) return null;
    const all = outStrikes.flatMap((s) => s.outcomes ?? []).filter((o) => o.kind !== "skip");
    if (!all.length || !all.every((o) => o.kind === "hit")) return null;
    const outcomes = [];
    for (const [uuid, tally] of perTarget) {
      const state = states.get(uuid);
      if (!state || (!state.noKo && state.hp <= 0)) continue;
      const amount = Math.round(Math.max(0, tally.damage) * (m - 1));
      if (!(amount > 0)) continue;
      const applied = applyStrikeToState(state, { kind: "hit", amount });
      tally.damage += amount;
      tally.hpLoss += applied.hpLoss;
      tally.shieldLoss += applied.shieldLoss;
      tally.perfectBonus = amount;
      const downedNow = !state.noKo && state.hp <= 0 && !tally.defeated;
      if (downedNow) { tally.defeated = true; tally.defeatedOnStrike = outStrikes.length + 1; }
      const last = [...outStrikes].reverse().map((s) => (s.outcomes ?? []).find((o) => o.tokenUuid === uuid)).find(Boolean) ?? {};
      outcomes.push({
        tokenUuid: uuid, kind: "hit", amount, affinity: last.affinity ?? "NE", element: last.element ?? "",
        isCrit: true, critBanner: false, perfect: true, pierce: false, defense: null, ...applied, killing: downedNow,
      });
    }
    if (!outcomes.length) return null;
    const strike = { index: outStrikes.length + 1, roll: null, perfect: true, mult: m, outcomes };
    outStrikes.push(strike);
    return strike;
  }

  function finish() {
    return {
      strikes: outStrikes,
      perTarget,
      landed: landedTotal,
      firstCritStrike,
      firstFumbleStrike,
      // One Opportunity per side per sequence, whichever strike earned it.
      attackerOpportunity: firstCritStrike != null,
      defenderOpportunity: firstFumbleStrike != null,
    };
  }

  return { step, perfect, finish, standing, states };
}

export function planStrikes({ strikes = [], states = new Map(), evaluate } = {}) {
  const walker = createStrikeWalker(states);
  for (const strike of strikes) walker.step(strike, evaluate);
  return walker.finish();
}

// Strike count + totals, for logs, the battle-log row and the counter.
export function summarizeTarget(t) {
  if (!t) return "";
  const parts = [];
  if (t.landed) parts.push(`${t.landed} hit${t.landed === 1 ? "" : "s"}`);
  if (t.missed) parts.push(`${t.missed} miss${t.missed === 1 ? "" : "es"}`);
  if (t.blocked) parts.push(`${t.blocked} blocked`);
  if (t.lost) parts.push(`${t.lost} lost`);
  return parts.join(", ");
}

// "53 / MISS / 54★" — the per-strike breakdown for one target.
export function breakdownForTarget(plan, uuid) {
  const bits = [];
  for (const s of plan?.strikes ?? []) {
    const o = (s.outcomes ?? []).find((x) => x.tokenUuid === uuid);
    if (!o) continue;
    if (o.kind === "miss") bits.push("MISS");
    else if (o.kind === "block") bits.push("BLOCK");
    else if (o.kind === "lost") continue;
    else if (o.kind === "immune") bits.push("IMMUNE");
    else if (o.kind === "absorb") bits.push(`+${o.amount}`);
    else if (o.kind === "hit") bits.push(`${o.amount}${o.isCrit ? "★" : ""}`);
  }
  return bits.join(" / ");
}

// ── One-roll Chain (bare `chain N`) ────────────────────────────────────────
// The card's single result per target, shown as `count` hits. Nothing here is
// a strike of its own: the action resolves as ONE hit, and these are the
// numbers the presenter reveals on the animation's cues.
//   targets: [{ tokenUuid, outcome, state }]
//     outcome: { kind: "hit"|"miss"|"block"|"absorb"|"immune", amount, affinity,
//                element, isCrit, pierce, blockedBy? }   (the card's row)
//     state:   { hp, maxHp, shield, noKo }               (the live sheet)
// A hit's damage splits into equal ticks that add up exactly, shield soaking
// the early ticks first; every tick of a crit is gold, but the CRITICAL! banner
// rides the last one only. A miss, block or immunity shows once, on the first
// tick; an absorb heals once. A killing hit downs the target on its last tick.
// Returns { strikes: [{ index, roll: null, outcomes }], perTarget }.
export function planSingleChain({ count, targets = [] } = {}) {
  const n = Math.max(1, Math.floor(Number(count) || 1));
  const strikes = Array.from({ length: n }, (_, i) => ({ index: i + 1, roll: null, outcomes: [] }));
  const perTarget = {};
  for (const t of targets) {
    const uuid = t?.tokenUuid;
    if (!uuid) continue;
    const o = t.outcome ?? { kind: "miss" };
    const noKo = !!t.state?.noKo;
    const state = { hp: Number(t.state?.hp) || 0, maxHp: Number(t.state?.maxHp) || 0, shield: Number(t.state?.shield) || 0 };
    const amount = Math.max(0, Math.floor(Number(o.amount) || 0));
    const tally = {
      tokenUuid: uuid, strikes: n, landed: 0, hitsLanded: 0, missed: 0, crits: 0, blocked: 0, lost: 0,
      damage: 0, hpLoss: 0, shieldLoss: 0, hpGain: 0, defeated: false, defeatedOnStrike: null, ticks: [],
    };
    if (o.kind === "hit") {
      tally.landed = 1;
      tally.hitsLanded = o.pierce ? 0 : 1;
      tally.crits = o.isCrit ? 1 : 0;
      tally.damage = amount;
      splitTicks(amount, Array(n).fill(1)).forEach((amt, i) => {
        const applied = applyStrikeToState(state, { kind: "hit", amount: amt });
        tally.hpLoss += applied.hpLoss;
        tally.shieldLoss += applied.shieldLoss;
        tally.ticks.push(amt);
        const last = i === n - 1;
        strikes[i].outcomes.push({
          tokenUuid: uuid, kind: "hit", amount: amt, affinity: o.affinity ?? "NE", element: o.element ?? "",
          isCrit: !!o.isCrit, critBanner: !!o.isCrit && last, pierce: !!o.pierce,
          ...applied, killing: last && !noKo && state.hp <= 0,
        });
      });
      if (!noKo && state.hp <= 0) { tally.defeated = true; tally.defeatedOnStrike = n; }
    } else {
      let first;
      if (o.kind === "absorb") {
        const applied = applyStrikeToState(state, { kind: "absorb", amount });
        tally.landed = 1;
        tally.hpGain = applied.hpGain;
        first = { tokenUuid: uuid, kind: "absorb", amount, affinity: "AB", element: o.element ?? "", ...applied };
      } else if (o.kind === "immune") {
        tally.landed = 1;
        first = { tokenUuid: uuid, kind: "immune", amount: 0, affinity: "IM", element: o.element ?? "" };
      } else if (o.kind === "block") {
        tally.blocked = 1;
        first = { tokenUuid: uuid, kind: "block", blockedBy: o.blockedBy ?? null };
      } else {
        tally.missed = 1;
        first = { tokenUuid: uuid, kind: "miss" };
      }
      strikes[0].outcomes.push(first);
      for (let i = 1; i < n; i++) strikes[i].outcomes.push({ tokenUuid: uuid, kind: "skip" });
    }
    perTarget[uuid] = tally;
  }
  return { strikes, perTarget };
}

// "4 + 4 + 5" — a one-roll Chain's ticks for one target (or MISS / BLOCK / …).
export function singleBreakdown(t) {
  if (!t) return "";
  if (t.ticks?.length) return t.ticks.join(" + ") + (t.crits ? "★" : "");
  if (t.blocked) return "BLOCK";
  if (t.hpGain) return `+${t.hpGain}`;
  if (t.landed) return "IMMUNE";
  return "MISS";
}

// Split ONE damage value into display ticks for a pseudo multi-hit, by
// cumulative rounding so the ticks always add up to the real damage.
//   ratios: relative weights, e.g. [1,1,2] or [0.3,0.3,0.4]
export function splitTicks(total, ratios) {
  const T = Math.max(0, Math.floor(Number(total) || 0));
  const w = (ratios ?? []).map((r) => Math.max(0, Number(r) || 0));
  const sum = w.reduce((a, b) => a + b, 0);
  if (!w.length || sum <= 0) return [T];
  const out = [];
  let acc = 0, prev = 0;
  for (const r of w) {
    acc += r;
    const cur = Math.round((T * acc) / sum);
    out.push(cur - prev);
    prev = cur;
  }
  return out;
}

// The fallback beat for a script with no hit cues: 550 ms, shrinking as the
// strike count grows so a long Chain stays inside ~2.6 s of reveals.
export const CHAIN_BEAT_MS = 550;
export const CHAIN_MIN_BEAT_MS = 140;
export const CHAIN_FALLBACK_SPAN_MS = 2600;
export function fallbackBeatMs(count) {
  const gaps = Math.max(1, (Number(count) || 1) - 1);
  return Math.max(CHAIN_MIN_BEAT_MS, Math.min(CHAIN_BEAT_MS, Math.floor(CHAIN_FALLBACK_SPAN_MS / gaps)));
}

// ── Folding a Chain's repeat status writes (skill-effects coalescer) ─────────
// The charges strikes 2..N add to one stack land as ONE write: each strike's
// step applies in order with its own cap, so the total matches writing them
// strike by strike.
export function foldChargeSteps(charges, steps) {
  return (steps ?? []).reduce(
    (c, s) => Math.min(Number.isFinite(Number(s?.max)) ? Number(s.max) : Infinity, c + (Number(s?.add) || 0)),
    Number(charges) || 0,
  );
}

// True when refreshing the AE `existing` with `data` would change nothing a
// reader can see: name, origin, changes, statuses, disabled, charges (the
// Battle Director's duration counter — apply_ae nulls core duration fields on
// every write) and who applied it. `ns` = the module's flag namespace.
export function aeRefreshIsNoop(existing, data, ns) {
  const view = (d) => {
    const f = d?.flags?.[ns] ?? {};
    const by = f.directorAppliedBy ?? {};
    return JSON.stringify({
      name: d?.name ?? null,
      origin: d?.origin ?? null,
      changes: Array.from(d?.changes ?? []).map((c) => [c?.key ?? null, Number(c?.mode ?? 0), String(c?.value ?? ""), c?.priority ?? null]),
      statuses: Array.from(d?.statuses ?? []).map(String).sort(),
      disabled: !!d?.disabled,
      charges: f.charges ?? null,
      by: [by.skillUuid ?? null, by.reactorActorUuid ?? null, by.reactorTokenUuid ?? null, by.effectLabel ?? null, by.appliedAtRound ?? null],
    });
  };
  return view(existing) === view(data);
}
