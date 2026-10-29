// ── Chain N — pure strike planner ──────────────────────────────────────────
//
// A Chain N action is ONE action card and N strikes. Strike 1 is the roll the
// card shows; strikes 2..N are rolled when the card is confirmed and stay
// hidden until they land. Every strike rolls its own accuracy and damage, so
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

export const CHAIN_MODES = Object.freeze(["same", "random", "pick"]);
export const CHAIN_MAX = 20;

// Keyword forms accepted on an item's `action_keywords` list (already split
// and lowercased by the caller, or a raw string):
//   "chain 3", "chain(3)", "chain x3", "chain:3", "chain 3 random", "chain 3 pick"
// The bare word "chain" without a count is NOT a Chain — it is ignored, so a
// stray label can never turn an action into a multi-strike one.
const CHAIN_RX = /^chain\s*[:x(]?\s*(\d+)\s*\)?(?:\s*[:,]?\s*(same|random|pick))?$/;

export function parseChainKeyword(keywords) {
  const list = Array.isArray(keywords)
    ? keywords
    : String(keywords ?? "").split(/[,\n]+/);
  for (const raw of list) {
    const m = CHAIN_RX.exec(String(raw ?? "").trim().toLowerCase());
    if (!m) continue;
    const count = Math.min(CHAIN_MAX, Math.max(0, Math.floor(Number(m[1]) || 0)));
    if (count < 2) continue;              // Chain 1 is just an action
    return { count, mode: m[2] ?? "same" };
  }
  return null;
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
//   pick   — the strikes go round-robin over the creatures the player picked,
//            in pick order: pick one and every strike lands on it, pick two
//            for Chain 3 and it is A, B, A. (No new picker: the normal target
//            pick decides who; the order decides who takes the extra strike.)
// Returns { strikeTargets: string[][], cardTargets: string[] } where
// cardTargets is the distinct set in first-hit order (what the card shows).
export function assignStrikeTargets({ count, mode = "same", cardTargets = [], pool = [], picks = [], rng = Math.random } = {}) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  const strikeTargets = [];
  if (mode === "random" && pool.length) {
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

  return { step, finish, standing, states };
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
