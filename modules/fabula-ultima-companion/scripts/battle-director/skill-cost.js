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
  zero_power: { prop: "zero_power",    max: null,        label: "ZP" },
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
