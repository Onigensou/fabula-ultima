// ── Chain N — engine adapter: plan a confirmed Chain action's strikes ──────
//
// A Chain action is ONE card and N strikes (keyword `chain N` on the action's
// `action_keywords`, the skill's or the weapon's). The card shows strike 1;
// this module rolls and resolves strikes 2..N when the card is confirmed, and
// stamps the result on the action as `chainPlan` — plain data. The presenter
// reveals it strike by strike on the animation's hit cues; RESOLVE commits it
// with ONE write per target (chain-presenter.js, state-handlers resolveAction).
//
// Strike 1 IS the confirmed card: its roll, reactions, Invoke and GM edits are
// exactly what the table saw. Strikes 2..N roll fresh dice with the card's die
// sizes and re-derive through recomputeActionProfile — the same re-derivation
// the card itself uses — so a strike sees everything the card saw EXCEPT what
// belongs to the visible roll alone:
//   - reaction accuracy bonuses re-apply to every strike; a "set" (Crossfire)
//     stays absolute; a reroll replaced the card's dice, so it was strike 1's;
//   - defense and damage overrides re-apply to every strike, except a block
//     that zeroes the damage (Ninja Log): that stops ONE strike — the first to
//     land — and the later strikes are re-derived without it;
//   - GM hand-edits (dice, forced verdicts, damage) are edits of strike 1.
// Statuses from a strike land with the commit, so they never change a later
// strike (user rule, 2026-10-29). HP, shield, blockers and the attacker's
// hits-this-turn tally (Champion Gloves) DO carry from strike to strike.

import { log, warn } from "./logger.js";
import {
  parseChainKeyword, assignStrikeTargets, createStrikeWalker,
  breakdownForTarget, summarizeTarget, fallbackBeatMs,
} from "./chain-strikes.js";

// ── keyword ────────────────────────────────────────────────────────────────
// Which Chain (if any) an action carries. Only an action with an Accuracy /
// Magic Check that deals damage can be a Chain — a Chain is strikes.
export function chainSpecFor({ kind = null, skillItem = null, weapon = null, isCheck = true, hasDamage = true } = {}) {
  if (!isCheck || !hasDamage) return null;
  const lists = [];
  const skillKw = skillItem?.system?.props?.action_keywords;
  if (skillKw) lists.push(String(skillKw));
  if (kind === "Attack" && weapon?.actionKeywords) lists.push(String(weapon.actionKeywords));
  if (!lists.length) return null;
  return parseChainKeyword(lists.join(","));
}

// Random and pick modes assign each strike's target when the action is
// COMPUTED, so the card already names who gets hit and every targeting
// reaction sees the real targets. Random draws from the card's targets; pick
// goes round-robin over them in the order they were picked. Returns the spec
// with `strikeTargets` filled, plus the distinct set the card should keep.
export function drawChainTargets(spec, targetUuids, rng = Math.random) {
  if (!spec) return null;
  if ((spec.mode !== "random" && spec.mode !== "pick") || !targetUuids?.length) return { spec, keep: null };
  const { strikeTargets, cardTargets } = assignStrikeTargets({
    count: spec.count, mode: spec.mode, pool: targetUuids, picks: targetUuids, cardTargets: targetUuids, rng,
  });
  return { spec: { ...spec, strikeTargets }, keep: cardTargets };
}

// Narrow COMPUTE's target-aligned fields to the drawn set (random mode).
export function narrowToTargets({ targets = [], perTargetResults = [], hitTokenUuids = null } = {}, keep = null) {
  if (!Array.isArray(keep)) return { targets, perTargetResults, hitTokenUuids };
  const k = new Set(keep);
  return {
    targets: targets.filter((t) => k.has(t?.tokenUuid)),
    perTargetResults: perTargetResults.filter((r) => k.has(r?.tokenUuid)),
    hitTokenUuids: Array.isArray(hitTokenUuids) ? hitTokenUuids.filter((u) => k.has(u)) : hitTokenUuids,
  };
}

// How many strikes each card target takes ("×2" on the card).
export function strikesPerTarget(spec, cardTargetUuids = []) {
  const out = {};
  if (!spec) return out;
  const lists = Array.isArray(spec.strikeTargets) && spec.strikeTargets.length
    ? spec.strikeTargets
    : Array.from({ length: spec.count }, () => cardTargetUuids);
  for (const list of lists) for (const u of list) out[u] = (out[u] ?? 0) + 1;
  return out;
}

// ── override handling per strike ───────────────────────────────────────────
// A damage override whose ops zero the damage outright is a one-shot block.
function zeroingOps(ov) {
  const ops = Array.isArray(ov?.ops) && ov.ops.length ? ov.ops : (ov ? [{ op: ov.op ?? "set", amount: ov.amount ?? 0 }] : []);
  return ops.filter((o) => {
    const op = String(o?.op ?? "").toLowerCase();
    const amt = Number(o?.amount);
    return (op === "set" && !(amt > 0)) || (op === "multiply" && amt === 0);
  });
}
export function isBlockingOverride(ov) {
  return !!ov && zeroingOps(ov).length > 0;
}
function withoutZeroingOps(ov) {
  const ops = (Array.isArray(ov?.ops) && ov.ops.length ? ov.ops : []).filter((o) => !zeroingOps({ ops: [o] }).length);
  return ops.length ? { ...ov, ops } : null;
}

// Re-base the card's accuracy override onto a later strike's own roll.
export function rebaseAccuracyOverride(ov, strikeRoll) {
  if (!ov || !strikeRoll) return null;
  if (ov.rerolled) return null;                       // the card's dice were replaced: strike 1's event
  const reactionParts = (Array.isArray(ov.parts) ? ov.parts : []).filter((p) => !p?.gm);
  const additive = reactionParts.reduce((s, p) => s + (Number(p?.amount) || 0), 0);
  const total = Number(strikeRoll.total ?? 0) || 0;
  // A `set` op (Crossfire, "accuracy becomes 0") is not an additive part, so the
  // span from→to no longer equals the parts' sum. It stays absolute.
  const setInPlay = !ov.gm && Math.round((Number(ov.to) - Number(ov.from)) - additive) !== 0;
  if (setInPlay) return { ...ov, from: total };
  if (!reactionParts.length) return null;
  const to = total + additive;
  return { from: total, to, blocked: to <= 0, via: ov.via ?? null, reactorName: ov.reactorName ?? null, parts: reactionParts };
}

// ── dice ───────────────────────────────────────────────────────────────────
// Same die sizes as the card. A harness can pin later strikes through
// globalThis.__FU_CHAIN_FORCED_DICE__ = [{ rA, rB }, …] (strike 2 first).
async function rollStrikeDice(ar, strikeIndex) {
  const forced = globalThis.__FU_CHAIN_FORCED_DICE__;
  if (Array.isArray(forced) && forced[strikeIndex - 2]) {
    const f = forced[strikeIndex - 2];
    return { rA: Number(f.rA) || 1, rB: Number(f.rB) || 1 };
  }
  const dA = Number(ar?.roll?.dA) || 6;
  const dB = Number(ar?.roll?.dB) || 6;
  const r = await new Roll(`1d${dA} + 1d${dB}`).roll();
  const faces = r.dice.map((x) => x.results?.[0]?.result ?? 0);
  return { rA: faces[0] ?? 1, rB: faces[1] ?? 1 };
}

// Strike k's per-target rows: the bare re-derivation first (it derives the
// strike's own total / High Roll / crit / fumble), then the card's overrides
// re-applied against THAT roll.
async function recomputeStrike({ ar, dice, targetUuids, states, round }) {
  const { recomputeActionProfile } = await import("./action-profile.js");
  const subset = new Set(targetUuids);
  const targets = (ar.targets ?? []).filter((t) => subset.has(t?.tokenUuid));
  if (!targets.length) return { rows: [], roll: null };
  const accepted = Array.isArray(ar.acceptedCardReactions) ? ar.acceptedCardReactions : null;
  const attackMode = ar.attackMode ?? null;
  const arBase = { ...ar, roll: { ...(ar.roll ?? {}), rA: dice.rA, rB: dice.rB }, gmOverride: null };

  const bare = await recomputeActionProfile({ ar: arBase, targets, acceptedReactions: accepted, round, attackMode });
  if (!bare) return { rows: [], roll: null };
  const roll = bare.roll ? { ...bare.roll, ...(ar.roll?.dieSwap ? { dieSwap: ar.roll.dieSwap } : {}) } : arBase.roll;

  const cardRows = (ar.perTargetResults ?? []).filter((r) => subset.has(r?.tokenUuid));
  const accuracyOverride = rebaseAccuracyOverride(ar.accuracyOverride ?? null, roll);
  const defenseOverrides = cardRows
    .filter((r) => r?.defenseOverride)
    .map((r) => ({ tokenUuid: r.tokenUuid, actorUuid: r.actorUuid, ...r.defenseOverride }));
  const damageOverrides = [];
  for (const r of cardRows) {
    if (!r?.damageOverride) continue;
    let ov = { tokenUuid: r.tokenUuid, actorUuid: r.actorUuid, ...r.damageOverride };
    // A one-shot block already spent on an earlier strike drops out; any other
    // reduction on the same target keeps applying.
    if (isBlockingOverride(ov) && !(states.get(r.tokenUuid)?.blockers > 0)) ov = withoutZeroingOps(ov);
    if (ov) damageOverrides.push(ov);
  }
  if (!accuracyOverride && !defenseOverrides.length && !damageOverrides.length) {
    return { rows: bare.perTargetResults ?? [], roll };
  }
  const full = await recomputeActionProfile({
    ar: { ...arBase, roll }, targets, acceptedReactions: accepted, round, attackMode,
    accuracyOverride, defenseOverrides, damageOverrides,
  });
  return { rows: (full ?? bare).perTargetResults ?? [], roll };
}

// One per-target row → the walker's outcome for this strike.
function evaluateRow(row, ar) {
  if (!row) return { hit: false, kind: "miss" };
  const defense = row.defense ?? null;
  const struck = !!row.hit || !!row.pierceMiss;
  if (!struck) return { hit: false, kind: "miss", defense };
  const amount = Math.max(0, Math.floor(Number(row.damage) || 0));
  const element = String(row.element ?? ar?.damage?.element ?? ar?.damageType ?? "elementless");
  if (row.damageOverride && isBlockingOverride(row.damageOverride) && amount <= 0) {
    return { hit: true, kind: "block", blockedBy: row.damageOverride.via ?? row.damageOverride.reactorName ?? null, defense };
  }
  const affinity = String(row.affinity ?? "NE").toUpperCase();
  if (affinity === "AB") return { hit: true, kind: "absorb", amount, affinity, element, isCrit: !!row.crit, defense };
  if (affinity === "IM") return { hit: true, kind: "immune", amount: 0, affinity, element, defense };
  return {
    hit: true, kind: "hit", amount, affinity, element, defense,
    isCrit: !!row.crit && !!row.hit,
    pierce: !row.hit && !!row.pierceMiss,
  };
}

const rollLite = (roll) => (roll ? {
  rA: roll.rA ?? null, rB: roll.rB ?? null, total: roll.total ?? null, hr: roll.hr ?? null,
  isCrit: !!roll.isCrit, isFumble: !!roll.isFumble,
} : null);

// ── the plan ───────────────────────────────────────────────────────────────
// Returns plain data (safe to freeze + persist), or null when the action is not
// a Chain that can strike (no check, negated, no damage rows).
export async function buildChainPlan(director, ar) {
  const spec = ar?.chain ?? null;
  if (!spec || !(spec.count >= 2)) return null;
  if (ar.negated || !ar.roll) return null;
  const cardRows = Array.isArray(ar.perTargetResults) ? ar.perTargetResults : [];
  const cardTargets = (ar.targets ?? []).map((t) => t?.tokenUuid).filter(Boolean);
  if (!cardRows.length || !cardTargets.length) return null;

  const strikeTargets = Array.isArray(spec.strikeTargets) && spec.strikeTargets.length === spec.count
    ? spec.strikeTargets
    : assignStrikeTargets({ count: spec.count, mode: "same", cardTargets }).strikeTargets;

  // Running state per target, read once from the live sheets.
  const states = new Map();
  const meta = new Map();
  for (const row of cardRows) {
    if (!row?.tokenUuid || states.has(row.tokenUuid)) continue;
    let actor = null;
    try {
      const tok = await fromUuid(row.tokenUuid).catch(() => null);
      actor = tok?.actor ?? (row.actorUuid ? await fromUuid(row.actorUuid).catch(() => null) : null);
    } catch { actor = null; }
    const p = actor?.system?.props ?? {};
    const isMp = String(row.resource ?? ar.damageResource ?? "hp") === "mp";
    states.set(row.tokenUuid, {
      hp: Number(isMp ? p.current_mp : p.current_hp) || 0,
      maxHp: Number(isMp ? p.max_mp : p.max_hp) || 0,
      shield: isMp ? 0 : (Number(p.shield_value) || 0),
      blockers: isBlockingOverride(row.damageOverride) ? 1 : 0,
      priorHits: 0,
      noKo: isMp,
    });
    meta.set(row.tokenUuid, { actorUuid: row.actorUuid ?? actor?.uuid ?? null, name: row.name ?? actor?.name ?? "", maxHp: Number(p.max_hp) || 0 });
  }

  // Champion Gloves / Hot Pants read the attacker's per-turn hit tally. It is
  // only kept for Attacks (see resolveAction), and only bumped after an action
  // resolves — so while the strikes are planned, raise it by the strikes that
  // already landed, and put it back afterwards.
  const dc = director?.dCombat ?? null;
  const attackerId = ar.attacker?.actorId ?? null;
  const useTally = !!(dc?.hitsOnTargets && attackerId && ar.kind === "Attack");
  const tallyBase = new Map();
  if (useTally) for (const u of cardTargets) {
    const key = `${attackerId}::${u}`;
    tallyBase.set(key, dc.hitsOnTargets.has(key) ? dc.hitsOnTargets.get(key) : undefined);
  }
  const setTally = (u) => {
    if (!useTally) return;
    const key = `${attackerId}::${u}`;
    const base = Number(tallyBase.get(key) ?? 0) || 0;
    const extra = Number(states.get(u)?.priorHits ?? 0) || 0;
    if (base + extra > 0) dc.hitsOnTargets.set(key, base + extra); else dc.hitsOnTargets.delete(key);
  };

  const round = ar.round ?? director?.dCombat?.round ?? 0;
  const walker = createStrikeWalker(states);
  try {
    for (let k = 1; k <= spec.count; k++) {
      const targets = (strikeTargets[k - 1] ?? cardTargets).filter(Boolean);
      let rows = cardRows, roll = ar.roll;
      if (k > 1) {
        const standing = targets.filter((u) => walker.standing(u));
        if (standing.length) {
          for (const u of standing) setTally(u);
          const dice = await rollStrikeDice(ar, k);
          const res = await recomputeStrike({ ar, dice, targetUuids: standing, states, round });
          rows = res.rows;
          roll = res.roll ?? { ...ar.roll, rA: dice.rA, rB: dice.rB };
        } else {
          rows = [];
          roll = null;
        }
      }
      const byUuid = new Map((rows ?? []).map((r) => [r?.tokenUuid, r]));
      walker.step({ index: k, roll: rollLite(roll), targets }, (strike, uuid) => evaluateRow(byUuid.get(uuid), ar));
    }
  } finally {
    if (useTally) for (const [key, val] of tallyBase) {
      if (val === undefined) dc.hitsOnTargets.delete(key); else dc.hitsOnTargets.set(key, val);
    }
  }

  const result = walker.finish();
  return toPlainPlan(result, { spec, meta, ar });
}

function toPlainPlan(result, { spec, meta, ar }) {
  const perTarget = {};
  for (const [uuid, t] of result.perTarget) {
    const m = meta.get(uuid) ?? {};
    const landedStrikes = [];
    for (const s of result.strikes) {
      const o = (s.outcomes ?? []).find((x) => x.tokenUuid === uuid);
      if (!o || !["hit", "absorb", "immune"].includes(o.kind)) continue;
      landedStrikes.push({
        index: s.index, kind: o.kind, amount: o.amount ?? 0,
        hpLoss: o.hpLoss ?? 0, shieldLoss: o.shieldLoss ?? 0, hpGain: o.hpGain ?? 0,
        isCrit: !!o.isCrit, pierce: !!o.pierce, defense: o.defense ?? null,
        total: s.roll?.total ?? null, hr: s.roll?.hr ?? null, isFumble: !!s.roll?.isFumble,
      });
    }
    perTarget[uuid] = {
      ...t,
      actorUuid: m.actorUuid ?? null,
      name: m.name ?? "",
      breakdown: breakdownForTarget(result, uuid),
      summary: summarizeTarget(t),
      landedStrikes,
    };
  }
  const hitTokenUuids = Object.values(perTarget).filter((t) => t.hitsLanded > 0).map((t) => t.tokenUuid);
  const struckTokenUuids = Object.values(perTarget).filter((t) => t.landed > 0).map((t) => t.tokenUuid);
  const plan = {
    count: spec.count,
    mode: spec.mode,
    beatMs: fallbackBeatMs(spec.count),
    strikes: result.strikes.map((s) => ({ index: s.index, roll: s.roll, outcomes: s.outcomes })),
    perTarget,
    landed: result.landed,
    hitTokenUuids,
    struckTokenUuids,
    firstCritStrike: result.firstCritStrike,
    firstFumbleStrike: result.firstFumbleStrike,
    attackerOpportunity: result.attackerOpportunity,
    defenderOpportunity: result.defenderOpportunity,
    instanceId: ar?._instanceId ?? null,
  };
  log(`Chain ${spec.count}${spec.mode !== "same" ? ` (${spec.mode})` : ""}: `
    + Object.values(perTarget).map((t) => `${t.name || t.tokenUuid} [${t.breakdown || "—"}]`).join(" · "));
  return plan;
}

// Plain per-target lookup used by RESOLVE.
export function chainTargetOf(plan, tokenUuid) {
  return plan?.perTarget?.[tokenUuid] ?? null;
}

// The card target rows as the rest of RESOLVE should see them for a Chain:
// a target is HIT when any strike genuinely landed, STRUCK when any strike
// dealt damage (pierce included), and its damage is the strikes' total.
export function chainHitsView(plan, rows = []) {
  if (!plan) return rows;
  return rows.map((r) => {
    const t = plan.perTarget?.[r?.tokenUuid];
    if (!t) return { ...r, hit: false, pierceMiss: false, crit: false, damage: 0 };
    const pierceOnly = t.landed > 0 && t.hitsLanded === 0;
    const { damageOverride, ...rest } = r;
    return { ...rest, hit: t.hitsLanded > 0, pierceMiss: pierceOnly, crit: t.crits > 0, damage: t.damage };
  });
}

export const _test = { zeroingOps, withoutZeroingOps, evaluateRow };
