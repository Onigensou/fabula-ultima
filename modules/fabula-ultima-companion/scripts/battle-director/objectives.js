// Objective actions — the data-driven pool behind the Octopath "Objective" blade.
//
// The Objective command is ONE command. Unlike the Ultima blade (which promotes
// each row to its own top-level command with its own TARGET/COMPUTE/RESOLVE
// branch), the picked option travels as DATA on the bundle — exactly how the
// Item action carries its chosen consumable. That is what lets content extend
// the list at runtime without touching the FSM.
//
// Every option is an ordinary CSB skill Item, so cost, skill_target, isCheck,
// rolled_atr1/2, check_difficulty_level and the whole effect_table vocabulary
// come for free. An option is identified by the stable flag
//
//   flags["fabula-ultima-companion"].coreAction = "objective:<id>"
//
// which reuses the Common-item delivery pipe that already ships Guard / Study /
// Hinder / Equipment / Domination (see data-migrations/_action-skill-author.js).
// The "objective:" prefix means getCoreActionSkill() can never collide with one.
//
// ── Where an option comes from ──────────────────────────────────────────────
//
//   1. World defaults   — `objective_default` on the item: all | pc | npc | none.
//                         "none" is grant-only (the unique ones).
//   2. Per-creature      — AE change rows `grant_objective` / `deny_objective`,
//                         comma lists of ids or names. Read per-AE and unioned,
//                         exactly like `disable_action` in snapshot.js.
//   3. Battle-wide       — `battlePlan.objectiveGrant / objectiveDeny /
//                         objectiveAllow` (a conflict event writes the same keys).
//
// ⚠ The GRANT reader must NOT take the `ignore_action_gating` early-out that
// every other reader in snapshot.js takes. A Domination bypass makes RESTRICTIONS
// inert; it may not conjure options the creature was never given. Only the DENY
// reader early-outs. Getting this backwards hands a dominating boss every unique
// Objective in the world.
//
// ── Why this is not stamped on the combatant snapshot ───────────────────────
// The list needs the DIRECTOR (battle-wide grants live on ctx.payload.battlePlan),
// and snapshotDirectorCombatant only receives a combatant. So DECLARE computes it
// and ships it in the compose menuSpec alongside `eligible` and `freeActionGrant`
// — the established idiom for "GM-side knowledge the player's client needs".
// The blade's own greying still rides `snap.blockedActions`, which already knows
// the "Objective" label (snapshot.js GATEABLE_ACTION_LABELS).
//
// See [[project_objective_action]].

import { log, warn } from "./logger.js";
import { hasIgnoreActionGating } from "./domination.js";
import { buildSkillResolver, evaluateFormula } from "./skill-formulas.js";
import { parseSkillCost, resolveCost, checkAffordable, formatParsedCost } from "./skill-cost.js";

const MODULE_ID = "fabula-ultima-companion";

export const OBJECTIVE_COMMAND = "Objective";

/** `coreAction` flag prefix that marks an Item as an Objective option. */
export const OBJECTIVE_FLAG_PREFIX = "objective:";

/** AE change keys. See the grant/deny asymmetry note in the header. */
export const GRANT_OBJECTIVE_KEY = "grant_objective";
export const DENY_OBJECTIVE_KEY  = "deny_objective";

/** Fallback icon when an option Item carries no art. */
const DEFAULT_OBJECTIVE_ICON = "icons/svg/target.svg";

// ── Identity ────────────────────────────────────────────────────────────────

/** The objective id an Item declares, or null when it isn't an option. */
export function objectiveIdOf(item) {
  const flag = item?.flags?.[MODULE_ID]?.coreAction ?? null;
  if (typeof flag !== "string" || !flag.startsWith(OBJECTIVE_FLAG_PREFIX)) return null;
  const id = flag.slice(OBJECTIVE_FLAG_PREFIX.length).trim().toLowerCase();
  return id || null;
}

/** Every Objective option Item in the world, deduped by id (first wins). */
export function objectiveItems() {
  const out = new Map();
  for (const it of (game.items ?? [])) {
    if (it?.type !== "equippableItem") continue;
    const id = objectiveIdOf(it);
    if (!id || out.has(id)) continue;
    out.set(id, it);
  }
  return out;
}

/** Resolve one option Item by its id. */
export function findObjectiveItem(id) {
  const key = String(id ?? "").trim().toLowerCase();
  if (!key) return null;
  return objectiveItems().get(key) ?? null;
}

// ── AE readers ──────────────────────────────────────────────────────────────

function splitRefs(raw) {
  return String(raw ?? "")
    .split(/[,\n]/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function activeEffectsOf(actor) {
  return actor?.appliedEffects
    ? Array.from(actor.appliedEffects)
    : (actor?.effects?.contents ?? actor?.effects ?? []);
}

function readChangeRefs(actor, key) {
  const out = new Set();
  for (const ae of activeEffectsOf(actor)) {
    if (ae?.disabled) continue;
    for (const ch of (ae?.changes ?? [])) {
      if (ch?.key !== key) continue;
      for (const ref of splitRefs(ch.value)) out.add(ref);
    }
  }
  return out;
}

/**
 * Objectives GRANTED to this creature by an active effect.
 *
 * Deliberately NO `hasIgnoreActionGating` early-out — see the header. A grant is
 * a capability, not a restriction, so a gating bypass must not manufacture one.
 */
export function readObjectiveGrants(actor) {
  return readChangeRefs(actor, GRANT_OBJECTIVE_KEY);
}

/**
 * Objectives DENIED to this creature. This one DOES early-out on the Domination
 * marker, matching getBlockedActionLabels / getMaxActionTargets / … — while a
 * creature ignores action gating, a deny is inert like every other restriction.
 */
export function readObjectiveDenies(actor) {
  if (hasIgnoreActionGating(actor)) return new Set();
  return readChangeRefs(actor, DENY_OBJECTIVE_KEY);
}

// ── Default scoping ─────────────────────────────────────────────────────────

// Canonical PC test in this codebase: absence of `npc_rank`. Mirrors
// defeat-reactor.isPlayerCharacter and invoke-core.getInvokeCapability. NOT
// hasPlayerOwner — a GM-run PC and an owned NPC both break that test.
function actorIsPc(actor) {
  return !String(actor?.system?.props?.npc_rank ?? "").trim();
}

function defaultScopeAllows(item, actor) {
  const scope = String(item?.system?.props?.objective_default ?? "all").trim().toLowerCase();
  if (scope === "none") return false;              // grant-only
  if (scope === "pc")   return actorIsPc(actor);
  if (scope === "npc")  return !actorIsPc(actor);
  return true;                                     // "all" / blank / unknown
}

// ── Gate + cost ─────────────────────────────────────────────────────────────

// `objective_gate_formula` — a formula that must evaluate TRUTHY for the option
// to be usable. Falsy dims the row and stamps `objective_gate_reason` on it (the
// same shown-not-hidden treatment the Ultima picker and the action-gating blades
// use). Run's boss gate is authored as `ENEMY_BOSS_COUNT == 0`.
function gateReasonFor(item, actor) {
  const props = item?.system?.props ?? {};
  const formula = String(props.objective_gate_formula ?? "").trim();
  if (!formula) return null;
  try {
    const resolver = buildSkillResolver({ actor, payload: null, skill: item, round: 0 });
    const v = evaluateFormula(formula, resolver, 1);
    if (v) return null;
  } catch (e) {
    warn(`objectives: gate formula on "${item?.name}" threw — treating as open`, e);
    return null;
  }
  return String(props.objective_gate_reason ?? "").trim() || "Unavailable";
}

function costInfoFor(item, actor) {
  const raw = String(item?.system?.props?.cost ?? "").trim();
  if (!raw) return { label: "", reason: null };
  try {
    const parsed = parseSkillCost(raw);
    const map = resolveCost(parsed, { actor, targetCount: 1 });
    const gate = checkAffordable(actor, map);
    return {
      label: formatParsedCost(parsed) || raw,
      reason: gate.ok ? null : gate.missing.map((m) => `${m.label}: ${m.has}/${m.need}`).join(", "),
    };
  } catch (e) {
    warn(`objectives: cost parse on "${item?.name}" threw`, e);
    return { label: raw, reason: null };
  }
}

// ── Battle-wide lists ───────────────────────────────────────────────────────

// A conflict event writes the same three keys onto its battle plan, so there is
// one vocabulary rather than two. Re-read on every call (nothing is cached on
// ctx — persistence.js captures an allowlist, so a cache would be silently
// undefined after an F5; see conflict-event-runtime.js for the same reasoning).
function battlePlanLists(director) {
  const plan = director?.ctx?.payload?.battlePlan ?? null;
  const read = (v) => new Set((Array.isArray(v) ? v : splitRefs(v)).map((s) => String(s).trim().toLowerCase()).filter(Boolean));
  return {
    grant: read(plan?.objectiveGrant),
    deny:  read(plan?.objectiveDeny),
    allow: read(plan?.objectiveAllow),   // bypasses an option's gate formula
  };
}

// ── The collector ───────────────────────────────────────────────────────────

/**
 * The Objective options this creature may choose, as plain serializable rows.
 *
 * Row: { id, uuid, name, img, desc, cost, disabledReason }
 *
 * Callers:
 *   - DECLARE, to build the compose menuSpec (and the GM-local compose).
 *   - The DECLARE backstop, to re-derive from the LIVE actor and refuse a
 *     forged pick. That validation is the whole reason grants can be trusted.
 */
export function collectObjectives({ actor, director = null } = {}) {
  if (!actor) return [];
  const items = objectiveItems();
  if (!items.size) return [];

  const grants = readObjectiveGrants(actor);
  const denies = readObjectiveDenies(actor);
  const plan = battlePlanLists(director);

  const rows = [];
  for (const [id, item] of items) {
    const name = String(item.name ?? id);
    const nameKey = name.trim().toLowerCase();
    const named = (set) => set.has(id) || set.has(nameKey);

    // Denies win over every grant — a monster stripping an option must be able
    // to strip a default one too.
    if (named(denies) || named(plan.deny)) continue;
    if (!(defaultScopeAllows(item, actor) || named(grants) || named(plan.grant))) continue;

    const gate = named(plan.allow) ? null : gateReasonFor(item, actor);
    const cost = costInfoFor(item, actor);
    rows.push({
      id,
      uuid: item.uuid,
      name,
      img: item.img || DEFAULT_OBJECTIVE_ICON,
      desc: String(item.system?.props?.description ?? "").trim(),
      cost: cost.label,
      disabledReason: gate ?? cost.reason ?? null,
    });
  }

  rows.sort((a, b) => Number(a.disabledReason != null) - Number(b.disabledReason != null)
    || a.name.localeCompare(b.name));
  return rows;
}

/**
 * Menu spec for the blade + picker. `buttonDisabledReason` greys the Octopath
 * blade itself when nothing in the list is usable; per-row reasons dim
 * individual entries. Mirrors buildUltimaMenuSpec's contract exactly.
 */
export function buildObjectiveMenuSpec(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return { rows: [], buttonDisabledReason: "No Objectives available" };
  const usable = list.some((r) => !r.disabledReason);
  return {
    rows: list,
    buttonDisabledReason: usable ? null : "No Objective available",
  };
}

/**
 * Authoritative re-derivation for the DECLARE backstop (X1). Returns the live
 * row for `id`, or null when this creature may not use it right now.
 */
export function validateObjectivePick({ actor, director, id }) {
  const key = String(id ?? "").trim().toLowerCase();
  if (!key) return null;
  const row = collectObjectives({ actor, director }).find((r) => r.id === key) ?? null;
  if (!row) {
    log(`objectives: pick "${key}" is not available to ${actor?.name ?? "?"} — refusing`);
    return null;
  }
  if (row.disabledReason) {
    log(`objectives: pick "${key}" is disabled for ${actor?.name ?? "?"} (${row.disabledReason}) — refusing`);
    return null;
  }
  return row;
}
