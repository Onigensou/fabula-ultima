// ============================================================================
// Out-of-Combat Healing — shared resolution math.
//
// SINGLE SOURCE OF TRUTH for "how much does this heal, and what does it cost".
// Imported by BOTH the HUD (display-time preview) AND the GM socket handler
// (authoritative apply) so the two can never disagree.
//
// Reuses the Battle Director's cost + formula helpers rather than re-deriving
// CSB quirks: skill-cost.js (parse/resolve/gate cost strings) and
// skill-formulas.js (formula evaluation). These are stable read helpers; if
// the director restructures, only this file's imports need to follow.
// ============================================================================

import { HEAL_TAG, HEAL_RESOURCE } from "./healing-const.js";
import { parseSkillCost, resolveCost, checkAffordable } from "../battle-director/skill-cost.js";
import { buildSkillResolver, evaluateFormula } from "../battle-director/skill-formulas.js";

const HEAL_RESOURCES = new Set(["hp", "mp", "ip"]);

// type_damage strings that mean "this restores HP" (legacy convention: no
// effect_table, heal amount = damage_bonus). Mirrors skill-intent's HEALING_TYPES
// but resolves specifically to the HP resource.
const HP_HEAL_TYPES = new Set(["heal", "healing", "hp", "hp_heal", "recovery"]);
const MP_HEAL_TYPES = new Set(["mp", "mp_heal"]);

function asRows(table) {
  if (!table || typeof table !== "object") return [];
  return Object.keys(table)
    .map((k) => table[k])
    .filter((row) => row && !row.$deleted);
}

// Resolve a grant_amount (literal or formula) to a non-negative integer.
function resolveAmount(rawAmount, { actor, skill }) {
  if (rawAmount == null) return 0;
  const n = Number(rawAmount);
  if (Number.isFinite(n)) return Math.max(0, Math.round(n));
  try {
    const resolver = buildSkillResolver({ actor, payload: null, skill, round: 0 });
    const v = evaluateFormula(String(rawAmount), resolver, 0);
    return Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0;
  } catch (e) {
    console.warn(HEAL_TAG, "resolveAmount: formula eval failed", rawAmount, e);
    return 0;
  }
}

// Walk an item's effect_table for positive HP/MP/IP grant rows. Returns a
// merged map { hp, mp, ip } of summed amounts (>0 only).
function grantsFromEffectTable(item, caster) {
  const out = {};
  const table = item?.system?.props?.effect_table ?? item?.system?.props?.reaction_effect_table ?? null;
  for (const row of asRows(table)) {
    if (row.effect_kind !== "grant") continue;
    const resource = String(row.grant_resource ?? "").toLowerCase();
    if (!HEAL_RESOURCES.has(resource)) continue;
    const amount = resolveAmount(row.grant_amount, { actor: caster, skill: item });
    if (amount > 0) out[resource] = (out[resource] ?? 0) + amount;
  }
  return out;
}

// Legacy fallback: no grant rows, but type_damage marks it as a heal → the
// recovered amount is damage_bonus, applied to the resource the type implies.
function grantsFromTypeDamage(item, caster) {
  const p = item?.system?.props ?? {};
  const dt = String(p.type_damage ?? "").trim().toLowerCase();
  let resource = null;
  if (HP_HEAL_TYPES.has(dt)) resource = "hp";
  else if (MP_HEAL_TYPES.has(dt)) resource = "mp";
  if (!resource) return {};
  const amount = resolveAmount(p.damage_bonus, { actor: caster, skill: item });
  return amount > 0 ? { [resource]: amount } : {};
}

// ── Public ────────────────────────────────────────────────────────────────
//
// Resolve a heal action for a caster. Inputs are the resolved Item docs:
//   - effectItem: where the heal lives (carrier item for consumables/equipment,
//                 the spell/skill itself for owned skills). Holds effect_table
//                 or the legacy type_damage+damage_bonus.
//   - costItem:   where the resource cost lives (`system.props.cost`). For an
//                 owned skill/spell this is the same item; for a consumable it's
//                 the carrier item.
//
// Returns:
//   {
//     ok: bool,
//     grants: [{ resource, amount, label }],   // positive recoveries
//     costMap: Map<resource, amount>,           // resources the caster spends
//     affordable: bool,
//     missing: [{ resource, has, need, label }],
//     reason?: string,                          // when !ok
//   }
//
// `targetCount` defaults to 1 (out-of-combat heals resolve one target per cast,
// so "10 × T MP" → 10 MP). HP/MP recovery clamping to the target's max happens
// at apply time, not here (this is caster-relative).
export function resolveHealAction({ caster, effectItem, costItem = null, targetCount = 1 } = {}) {
  if (!effectItem) return { ok: false, grants: [], costMap: new Map(), affordable: false, missing: [], reason: "no-effect-item" };

  // Heal amounts: prefer the explicit effect_table; fall back to type_damage.
  let merged = grantsFromEffectTable(effectItem, caster);
  if (!Object.keys(merged).length) merged = grantsFromTypeDamage(effectItem, caster);

  const grants = [];
  for (const resource of ["hp", "mp", "ip"]) {
    const amount = merged[resource] ?? 0;
    if (amount > 0) grants.push({ resource, amount, label: HEAL_RESOURCE[resource]?.label ?? resource.toUpperCase() });
  }

  // Cost: parse the cost string from the cost-bearing item.
  const cItem = costItem ?? effectItem;
  const parsed = parseSkillCost(cItem?.system?.props?.cost ?? "");
  const costMap = resolveCost(parsed, { actor: caster, targetCount, variableAmount: 0 });
  const gate = checkAffordable(caster, costMap);

  return {
    ok: grants.length > 0,
    grants,
    costMap,
    affordable: gate.ok,
    missing: gate.missing,
    reason: grants.length ? undefined : "no-heal-grants",
  };
}

// Short display string for a resolved cost map ("10 MP", "10 MP + 1 IP", "Free").
export function formatCostMap(costMap) {
  if (!costMap || costMap.size === 0) return "Free";
  const parts = [];
  for (const [resource, amount] of costMap) {
    if (Number(amount) > 0) parts.push(`${amount} ${HEAL_RESOURCE[resource]?.label ?? resource.toUpperCase()}`);
  }
  return parts.length ? parts.join(" + ") : "Free";
}

// Short display string for a resolved grants list ("+30 HP", "+60 MP").
export function formatGrants(grants) {
  if (!grants?.length) return "";
  return grants.map((g) => `+${g.amount} ${g.label}`).join(", ");
}
