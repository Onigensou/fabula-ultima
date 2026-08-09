// Skill cost — parse + gate + debit.
//
// Skills carry their resource cost on `system.props.cost` as a free-text
// string. Grammar (mirrors the legacy ResourceGate.js parser; legacy is
// read-only reference here):
//
//   "10 MP"               flat 10 MP
//   "20% MP"              20% of max MP, rounded up
//   "10×T IP"             10 per target (resolved at debit time)
//   "20 x T MP"           same (ascii x)
//   "5 MP + 2 IP"         multi-resource
//   "1 HP, 1 IP"          comma or `+` or `&` or `/` separates tokens
//   "up to 25 MP"         variable cost — parser returns isVariable; caller
//                         picks an amount up to the cap (B.2 feature for
//                         Stolen Time / Magichant / Quick Assessment etc.)
//   ""  | null            no cost
//
// The parser is grammar-only; affordability + debit happen later against
// a live actor. Resources recognised: hp, mp, ip, fp, zenit, zero_power,
// enmity. Unknown tokens fail-open (logged, treated as a zero-cost
// token) so a malformed legacy spec doesn't brick the picker.

import { log, warn } from "./logger.js";

// Canonical resource keys (match the schema doc's `grant_resource` values
// plus `fp` for Fabula Points, which can be paid but not granted). The
// `prop` field is the actor.system.props.* slot to read/write.
const RESOURCES = {
  hp:         { prop: "current_hp",    max: "max_hp",    label: "HP" },
  mp:         { prop: "current_mp",    max: "max_mp",    label: "MP" },
  ip:         { prop: "current_ip",    max: "max_ip",    label: "IP" },
  fp:         { prop: "fabula_point",  max: null,        label: "FP" },
  zenit:      { prop: "zenit",         max: null,        label: "Zenit" },
  zero_power: { prop: "zero_power_value", max: null,        label: "ZP" },
  enmity:     { prop: "enmity",        max: null,        label: "Enmity" },
};

// Maps every accepted alias → canonical key. Case-insensitive, leading/
// trailing whitespace stripped before lookup.
const ALIASES = {
  hp: "hp", "hit point": "hp", "hit points": "hp",
  mp: "mp", "mind point": "mp", "mind points": "mp",
  ip: "ip", "inventory point": "ip", "inventory points": "ip",
  fp: "fp", "fabula": "fp", "fabula point": "fp", "fabula points": "fp",
  zenit: "zenit", z: "zenit",
  zp: "zero_power", "zero power": "zero_power", "zero_power": "zero_power",
  enmity: "enmity",
};

function normalizeResourceKey(raw) {
  if (!raw) return null;
  const key = String(raw).trim().toLowerCase();
  return ALIASES[key] ?? null;
}

// Parse a single token like "10 MP", "20% MP", "10×T IP", "up to 25 MP".
// Returns `null` for unrecognised tokens (after a warn) so the rest of
// the cost string can still parse.
function parseToken(raw) {
  const trimmed = String(raw).trim();
  if (!trimmed) return null;

  // "up to N RESOURCE" — variable cost
  const variableMatch = trimmed.match(/^up\s+to\s+(.+)$/i);
  if (variableMatch) {
    const inner = parseToken(variableMatch[1]);
    if (!inner) return null;
    return { ...inner, isVariable: true };
  }

  // "AMOUNT[%]  [×T | x T | *T]  RESOURCE"
  // The amount may be a digit string or a formula identifier like "SL"
  // (e.g. "SL × 5 MP" appears in the wild). We only handle digit amounts
  // here — formula costs are a later extension; warn + skip.
  const m = trimmed.match(/^(\d+)\s*(%?)\s*(?:[x×*]\s*T)?\s*([a-z _]+)$/i);
  if (!m) {
    // Try a formula-amount form to flag it explicitly
    if (/[a-z]+\s*[x×*]\s*\d+/i.test(trimmed) || /^SL/i.test(trimmed)) {
      warn(`skill-cost: formula-amount token not supported in B.1: "${trimmed}"`);
    } else {
      warn(`skill-cost: unparseable cost token: "${trimmed}"`);
    }
    return null;
  }

  const amount = Number(m[1]);
  const isPercent = m[2] === "%";
  // The "×T" detector lives in the regex's optional group; if the token
  // contained ×T / xT / *T anywhere between amount and resource, treat
  // as per-target.
  const multiplyByTargets = /[x×*]\s*T/i.test(trimmed);
  const resource = normalizeResourceKey(m[3]);
  if (!resource) {
    warn(`skill-cost: unknown resource in token: "${trimmed}"`);
    return null;
  }
  return { resource, amount, isPercent, multiplyByTargets, isVariable: false };
}

// Public — parse the full cost string into a list of tokens.
// Returns `{ tokens: [], hasVariable: bool, raw: string }`. An empty
// cost string (or null) returns `{ tokens: [] }` (caller treats as free).
export function parseSkillCost(costString) {
  const raw = String(costString ?? "").trim();
  if (!raw) return { tokens: [], hasVariable: false, raw: "" };

  // Split on `+`, `,`, `&`, `/` (mirroring legacy ResourceGate).
  const segments = raw.split(/[+,&/]/g).map((s) => s.trim()).filter(Boolean);
  const tokens = [];
  let hasVariable = false;
  for (const seg of segments) {
    const t = parseToken(seg);
    if (!t) continue;
    if (t.isVariable) hasVariable = true;
    tokens.push(t);
  }
  return { tokens, hasVariable, raw };
}

// Resolve a parsed cost to concrete amounts per resource, given target
// count + an optional variable-spend amount for the FIRST variable
// token. Returns a `Map<resourceKey, number>` (amounts to debit).
//
// `opts`:
//   - targetCount  (default 1) — used for ×T tokens.
//   - actor        (optional)  — needed for % tokens (reads max).
//   - variableAmount (default 0) — total to spend on variable tokens;
//                                    distributed in order (typically a
//                                    skill has only ONE variable token).
export function resolveCost(parsedCost, opts = {}) {
  const out = new Map();
  const { tokens = [] } = parsedCost ?? {};
  if (!tokens.length) return out;

  const targetCount = Math.max(1, Number(opts.targetCount ?? 1) || 1);
  const actor = opts.actor ?? null;
  let variableBudget = Math.max(0, Number(opts.variableAmount ?? 0) || 0);

  for (const t of tokens) {
    let amount = 0;
    if (t.isVariable) {
      // Take as much of the variable budget as this token's cap allows.
      // The token's `amount` is the CAP (e.g. "up to 25 MP" → 25). The
      // caller-supplied variableAmount is the total spend across all
      // variable tokens; we hand it out in declaration order.
      const cap = t.isPercent && actor
        ? Math.ceil((readMax(actor, t.resource) ?? 0) * (t.amount / 100))
        : t.amount;
      amount = Math.min(variableBudget, cap);
      variableBudget -= amount;
    } else if (t.isPercent) {
      if (!actor) {
        warn(`skill-cost: percent token "${t.amount}% ${t.resource}" needs an actor; treating as 0`);
        continue;
      }
      const max = readMax(actor, t.resource) ?? 0;
      amount = Math.ceil(max * (t.amount / 100));
    } else {
      amount = t.amount;
    }
    if (t.multiplyByTargets) amount *= targetCount;
    if (amount <= 0) continue;
    out.set(t.resource, (out.get(t.resource) ?? 0) + amount);
  }
  return out;
}

function readCurrent(actor, resourceKey) {
  const def = RESOURCES[resourceKey];
  if (!def) return null;
  const v = actor?.system?.props?.[def.prop];
  return Number.isFinite(Number(v)) ? Number(v) : 0;
}

function readMax(actor, resourceKey) {
  const def = RESOURCES[resourceKey];
  if (!def?.max) return null;
  const v = actor?.system?.props?.[def.max];
  return Number.isFinite(Number(v)) ? Number(v) : null;
}

// Gate — can the actor pay this resolved cost map? Returns
// `{ ok, missing: [{resource, has, need, label}] }`. Missing list is
// empty when ok=true.
export function checkAffordable(actor, costMap) {
  if (!actor || !costMap || costMap.size === 0) return { ok: true, missing: [] };
  const missing = [];
  for (const [resource, need] of costMap) {
    const has = readCurrent(actor, resource) ?? 0;
    if (has < need) {
      missing.push({
        resource,
        has,
        need,
        label: RESOURCES[resource]?.label ?? resource.toUpperCase(),
      });
    }
  }
  return { ok: missing.length === 0, missing };
}

// ── Effective action cost — the SINGLE calc point ─────────────────────────
// The one place a printed/base cost (`costSerialized`) combines with `adjust_cost`
// overrides (`costOverride`) into the amount actually paid. The RESOLVE debit, the
// action card's cost bullet, and every ACTION_EFFECTIVE_COST_* reader route through
// this, so they can never drift. (Lives in skill-cost — a leaf module — so both
// state-handlers and action-card can import it without a cycle.)
//
// FU's fixed operation order — and the reason the result is INDEPENDENT of the
// order reactions were applied / clicked: accumulate every override raw, then
// evaluate in canonical order — base + ALL additive deltas FIRST, then × ALL
// multiplicative factors — then clamp ONCE at the end.
//   ⚠ NEVER clamp per-application. A per-step clamp reintroduces order-dependence:
//     base 10, overcharge +30, waive −MAX →
//       waive-then-overcharge: max(0,10−MAX)=0 → +30 → 30   (overcharge survives!)
//       accumulate-then-clamp: max(0, 10+30−MAX) = 0        (order-free, correct)
//   ⚠ `waive` (Fugitive) is expressed as an additive delta ≥ the pool max, so the
//     single 0-clamp zeroes the final cost regardless of any composed overcharge.
//
// Resources considered = those the action already charges (`base`) PLUS any a
// SURCHARGE seeds. A POSITIVE delta may introduce a cost on a resource the action
// doesn't natively charge — that's how an extra-target purchase (Barrage's +10 MP
// on an otherwise free Attack) becomes part of the ACTION's cost, debited once at
// RESOLVE, instead of a side debit at reaction-fire time. A NEGATIVE delta still
// can't conjure one: a discount / waive's inert −MAX on an uncharged resource
// remains the no-op it always was. `override` shape:
//   { <res>: <additiveSum>, _mult?: { <res>: <productFactor> }, _parts?: [...] }
// `_mult` is reserved for future multiplicative cost ops; today cost is additive
// only, so the multiplicative branch is a no-op.
export function computeEffectiveCost(base, override) {
  const out = {};
  const b = base || {};
  const mult = override?._mult || null;
  const resources = new Set(Object.keys(b));
  for (const [res, delta] of Object.entries(override ?? {})) {
    if (res.startsWith("_")) continue;                     // _mult / _parts metadata
    if ((Number(delta) || 0) > 0) resources.add(res);       // surcharge may seed
  }
  for (const res of resources) {
    let v = Number(b[res]) || 0;
    if (override) v += Number(override[res]) || 0;         // additive FIRST (raw sum)
    if (mult && Number.isFinite(Number(mult[res]))) {
      v = Math.floor(v * Number(mult[res]));               // multiplicative SECOND (FU rounds down)
    }
    out[res] = Math.max(0, v);                             // clamp ONCE
  }
  return out;
}

// Debit — write the cost map to actor.system.props.*. Floors at 0;
// caller is expected to gate first via checkAffordable. Returns
// `{ ok, debited: { resource: amount } }`.
//
// Single actor.update call so all resource writes commit atomically
// (and produce one undo step, one hook fire, etc.).
export async function debitCost(actor, costMap) {
  if (!actor || !costMap || costMap.size === 0) return { ok: true, debited: {} };
  const update = {};
  const debited = {};
  for (const [resource, amount] of costMap) {
    const def = RESOURCES[resource];
    if (!def) continue;
    const cur = readCurrent(actor, resource) ?? 0;
    const next = Math.max(0, cur - amount);
    update[`system.props.${def.prop}`] = next;
    debited[resource] = amount;
  }
  try {
    if (Object.keys(update).length) await actor.update(update);
    return { ok: true, debited };
  } catch (e) {
    warn("skill-cost.debitCost: actor.update threw", e);
    return { ok: false, debited: {}, error: e };
  }
}

// Convenience — display a parsed cost as a short string for the picker
// (e.g. "10 MP", "10 MP + 2 IP", "up to 25 MP"). Used by skill-picker
// to render cost badges. Variable tokens render with "up to" prefix.
export function formatParsedCost(parsedCost) {
  const tokens = parsedCost?.tokens ?? [];
  if (!tokens.length) return "";
  return tokens.map((t) => {
    const label = RESOURCES[t.resource]?.label ?? t.resource.toUpperCase();
    const amountStr = t.isPercent ? `${t.amount}%` : `${t.amount}`;
    const targetTag = t.multiplyByTargets ? "×T" : "";
    const prefix = t.isVariable ? "up to " : "";
    return `${prefix}${amountStr}${targetTag} ${label}`;
  }).join(" + ");
}

// Per-target (×T) affordability cap — the SINGLE source for "clamp how many
// targets the caster can afford on a scaling-cost spell". Called from every
// targeting site (compose-action's player-side composer AND the GM-side
// resolveActionTargets) so the clamp is identical wherever targets are chosen.
//
// Returns `{ count, capped, missing }`:
//   - count   : the (possibly reduced) target count to offer the picker.
//   - capped  : true iff we reduced the count (caller toasts).
//   - missing : the checkAffordable shortfall at the first unaffordable count
//               (resource labels for the toast), else null.
//
// No-op (returns the requested count unchanged) when: actor missing, requested
// ≤ 1, the cost has no tokens, the cost does NOT scale with target count, OR the
// caster can't afford even ONE target (that's left to the confirm-time gate,
// which surfaces the precise shortfall). General over ANY resource — covers the
// common scaling-MP case without hardcoding MP. Reuses resolveCost +
// checkAffordable (the same single-source the confirm-time gate uses).
export function affordableTargetCount(actor, costString, requestedCount) {
  const out = { count: requestedCount, capped: false, missing: null };
  if (!actor || !(Number(requestedCount) > 1)) return out;
  const parsed = parseSkillCost(String(costString ?? ""));
  if (!parsed.tokens.length) return out;
  const c1 = resolveCost(parsed, { actor, targetCount: 1 });
  const c2 = resolveCost(parsed, { actor, targetCount: 2 });
  const scales = [...new Set([...c1.keys(), ...c2.keys()])]
    .some((r) => (c2.get(r) ?? 0) > (c1.get(r) ?? 0));
  if (!scales) return out;
  let affordable = 0;
  let missing = null;
  for (let t = 1; t <= requestedCount; t++) {
    const gate = checkAffordable(actor, resolveCost(parsed, { actor, targetCount: t }));
    if (gate.ok) affordable = t;
    else { missing = gate.missing; break; }
  }
  if (affordable >= 1 && affordable < requestedCount) {
    return { count: affordable, capped: true, missing };
  }
  return out;
}

// Free-action MP-cap target clamp — the analog of affordableTargetCount for the
// Bimagus / Acceleration free-action `maxMpCost` cap. Clamps the up-to-N target
// count on a ×T scaling-cost spell so its RESOLVED (printed) MP stays within the
// cap. A freeOfCost free spell pays nothing, so affordableTargetCount never
// clamps it — this is the gate that keeps a free ×T spell's target count under
// the printed-cost cap, mirroring how affordability clamps a normal ×T spell.
// Returns `{ count, capped }`. No-op (requested unchanged) when: no cap, requested
// ≤ 1, the cost has no tokens, or the cost does NOT scale with target count.
// General over the ×T grammar; no per-skill logic.
export function mpCapTargetCount(actor, costString, maxMpCost, requestedCount) {
  const out = { count: requestedCount, capped: false };
  if (maxMpCost == null || !Number.isFinite(Number(maxMpCost))) return out;
  if (!(Number(requestedCount) > 1)) return out;
  const parsed = parseSkillCost(String(costString ?? ""));
  if (!parsed.tokens.length) return out;
  const c1 = resolveCost(parsed, { actor, targetCount: 1 });
  const c2 = resolveCost(parsed, { actor, targetCount: 2 });
  if (!((c2.get("mp") ?? 0) > (c1.get("mp") ?? 0))) return out; // MP doesn't scale
  const cap = Number(maxMpCost);
  let fit = 0;
  for (let t = 1; t <= requestedCount; t++) {
    const mp = Number(resolveCost(parsed, { actor, targetCount: t }).get("mp") ?? 0) || 0;
    if (mp <= cap) fit = t; else break;
  }
  if (fit >= 1 && fit < requestedCount) return { count: fit, capped: true };
  return out;
}

// ── Cost substitution availability (Vismagus and any future cost-swap) ─────
// "Could this caster pay a cost they can't currently afford, by swapping the
// missing resource for another one?"
//
// WHY THIS EXISTS: the affordability GATE and the substitution ran in the wrong
// order. `caster_short_on_mp` dispatches from the TARGET state, but the skill
// PICKER had already decided the spell was unaffordable and set `disabled` —
// which list-picker documents as "greyed + non-clickable + skipped by keyboard".
// Measured 2026-08-09: Hina at 1 MP had 12 of 12 spells blocked, so Vismagus
// could never fire for the case its own text describes ("if you don't have
// enough Mind Points to pay for its total cost"). Only scaling spells survived,
// because the picker prices variable costs at their MINIMUM.
//
// Deliberately NOT a Vismagus special case: the engine dispatches on the
// generic `caster_short_on_mp` / `substitute_cost` pair and state-handlers
// states "no skill name / class flag hardcoding lives here". This reads the
// same authored rows and mirrors applySubstituteCostEffect's arithmetic —
// including `min_remaining`, so the picker never offers a swap that the real
// gate would refuse (which would dead-end the player in a rejected dialog).
//
// Returns null when no substitution applies, else a preview of the swap.
// Preview only: nothing is mutated here — the real rewrite still happens in
// applySubstituteCostEffect when the reaction fires.
const SHORT_TRIGGER = "caster_short_on_mp";

function liveRows(table) {
  return Object.values(table || {}).filter((r) => r && typeof r === "object" && !r.$deleted);
}

export function findCostSubstitution(actor, costMap, opts = {}) {
  if (!actor) return null;
  const readMap = (k) => Number((costMap?.get ? costMap.get(k) : costMap?.[k]) ?? 0) || 0;

  for (const item of actor.items ?? []) {
    const props = item?.system?.props ?? {};
    const configs = liveRows(props.reaction_config_table)
      .filter((r) => String(r.reaction_trigger ?? "").trim() === SHORT_TRIGGER);
    if (!configs.length) continue;
    const effects = liveRows(props.effect_table);

    for (const cfg of configs) {
      const ref = String(cfg.reaction_effect_ref ?? "").trim();
      // Direct ref only. A substitution buried inside a `chain` is not previewed
      // — it will still FIRE correctly, the picker just won't pre-authorise it.
      const row = effects.find((e) => String(e.effect_label ?? "").trim() === ref
                                   && String(e.effect_kind ?? "").trim() === "substitute_cost");
      if (!row) continue;

      const fromRes = String(row.from_resource ?? "mp").trim().toLowerCase();
      const toRes   = String(row.to_resource   ?? "hp").trim().toLowerCase();
      const multiplier   = Number(row.multiplier ?? 2) || 2;
      const minRemaining = Number(row.min_remaining ?? 1) || 1;

      const fromAmount = readMap(fromRes);
      if (fromAmount <= 0) continue;                       // nothing to swap

      // Same arithmetic + rejection rule as applySubstituteCostEffect.
      const def = RESOURCES[toRes];
      const propKey = def?.prop ?? `current_${toRes}`;
      const curTo = Number(actor.system?.props?.[propKey] ?? 0) || 0;
      const toAmount = fromAmount * multiplier;
      if (curTo - toAmount < minRemaining) continue;       // would refuse at the gate

      return {
        from: fromRes, to: toRes, fromAmount, toAmount,
        label: `${toAmount} ${def?.label ?? toRes.toUpperCase()}`,
        sourceName: item.name ?? null,
        // `reaction_passive_mode` decides whether the player is asked; the
        // picker only needs to know the option EXISTS.
        mode: String(cfg.reaction_passive_mode ?? "ask").trim().toLowerCase(),
      };
    }
  }
  return null;
}

// Would the real gate even reach the substitution? Mirrors state-handlers'
// preconditions: the shortfall must be ONLY on the swappable resource, and
// (RAW Vismagus: "when you cast a spell") the action must be a Spell.
export function canSubstituteForShortfall(missing, skillType) {
  if (!Array.isArray(missing) || !missing.length) return false;
  const onlyMp = missing.every(
    (m) => String(m.resource ?? m.label ?? "").toLowerCase() === "mp");
  const isSpell = String(skillType ?? "").trim().toLowerCase() === "spell";
  return onlyMp && isSpell;
}
