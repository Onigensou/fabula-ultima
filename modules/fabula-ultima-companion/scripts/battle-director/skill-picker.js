// Skill Picker — Skill/Spell selection step.
//
// Thin builder over the shared list-picker (list-picker.js): it gathers the
// actor's known Active skills + equipped-item-granted skills, groups them into
// sections, maps each to a list-picker row (icon, name, subtitle, cost badge,
// affordability-disabled, description tooltip), and delegates rendering +
// lifecycle + keyboard to pickFromList. No bespoke overlay here anymore — only
// the Skill-specific gathering + row construction.
//
// Returns a Promise resolving to `{ skillUuid, sourceItemUuid? } | null`.

import { log, warn } from "./logger.js";
import { parseSkillCost, resolveCost, checkAffordable, formatParsedCost,
         findCostSubstitution, canSubstituteForShortfall } from "./skill-cost.js";
import { buildSkillResolver, evaluateFormula, normalizeDamageType } from "./skill-formulas.js";
import { analyzeChainCost, estimatePerformReactionCost, isMergedArcanumChild } from "./skill-effects.js";
import { pickFromList, ListPicker } from "./list-picker.js";
import { classifyActionIntent } from "./skill-intent.js";
import { getMaxActionTargets, skillTargetIsMulti, skillTargetIsUpTo, skillDeclaresVersatile } from "./snapshot.js";

// Cost badge labels for the config-derived (effect-chain) cost map.
const COST_RES_LABEL = { hp: "HP", mp: "MP", ip: "IP", fp: "FP", zenit: "Zenit", zero_power: "ZP", enmity: "Enmity" };
function formatCostMap(map) {
  const parts = [];
  for (const [res, amt] of map.entries()) {
    if (Number(amt) > 0) parts.push(`${amt} ${COST_RES_LABEL[res] ?? String(res).toUpperCase()}`);
  }
  return parts.join(", ");
}

// Display-time formula resolver for free-text props like skill_target.
// Some authors embed inline expressions like
// "Up to (1 + 98 * HAS_SKILL_PILLAGE) creatures" so the engine can extract
// a target count at compose-time. Without resolution the player sees the
// raw identifier soup. We pre-evaluate every `(...)` group via the
// skill resolver and substitute the integer result.
function resolveDisplayFormula(text, actor, skill) {
  if (!text || !text.includes("(")) return text;
  try {
    const resolver = buildSkillResolver({ actor, payload: null, skill, round: 0 });
    let lastResolvedCount = null;
    let resolved = text.replace(/\(([^()]+)\)/g, (whole, expr) => {
      const v = evaluateFormula(expr.trim(), resolver, null);
      if (v == null || !Number.isFinite(v)) return whole;
      const n = Math.floor(v);
      lastResolvedCount = n;
      return String(n);
    });
    // Polish: when a resolved count is exactly 1, "Up to 1 creatures" reads
    // poorly. Drop the "Up to" prefix and singularize the following noun.
    if (lastResolvedCount === 1 && /\bup\s+to\s+1\b/i.test(resolved)) {
      resolved = resolved.replace(/\bup\s+to\s+1\b/i, "1")
                         .replace(/\b1\s+creatures\b/i, "1 creature")
                         .replace(/\b1\s+allies\b/i, "1 ally")
                         .replace(/\b1\s+enemies\b/i, "1 enemy");
    }
    return resolved;
  } catch (e) {
    warn("skill-picker.resolveDisplayFormula threw", e);
    return text;
  }
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[m]));
}

function asObjectValues(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === "object") return Object.values(value).filter(Boolean);
  return [];
}

// ── Reaction-only detection ───────────────────────────────────────────────
// Some skills/spells are entirely passive in their working: their whole
// behavior lives in `reaction_config_table` rows that fire in RESPONSE to an
// event (every trigger in reaction-triggers.config.js is reactive/lifecycle —
// there is no "on activate" trigger; that's the separate *_effect_ref
// pipeline). Such items have no active turn-action, yet they still carry
// skill_type "Active"/"Spell" (e.g. Protect, Illusory Shield, High Speed,
// Cognitive Focus). The skill_type label filter alone therefore lets them leak
// into the Skill/Spell action menu, where picking one spends the turn-action on
// a no-op (empty body → Miss card). This predicate identifies them so the
// picker can drop them, while leaving genuine actions that ALSO carry a
// reaction rider (e.g. Gadgets) in place.

// A row counts only when it actually declares a trigger (skips blank/spacer
// and $deleted rows). Field name matches the engine + lint (`reaction_trigger`).
function hasReactionRows(tbl) {
  return asObjectValues(tbl).some(
    (r) => !r?.$deleted && String(r?.reaction_trigger ?? "").trim(),
  );
}

// Usable (turn-action) skill_types — as opposed to "Passive"/"Other", which
// only ever fire in response to a trigger.
const ACTIVE_SKILL_TYPES = new Set(["attack", "active", "spell"]);

// A sure-hit damaging/healing body: a no-Check active skill still delivers its
// payload because the engine auto-hits when check_mode is "none" (see
// action-profile `required` / `hit = !rolled`). Such skills often deliver via an
// on-damage FOLD reaction (creature_will_deal_damage) rather than an
// on_activate ref, so the ref checks below miss them. Scoped to usable
// skill_types so a genuine Passive that carries a type_damage for its proc
// (e.g. Wind Puff "Air", Absorb MP "MP") stays hidden.
function hasSureHitDamageBody(p) {
  const st = String(p?.skill_type ?? "").trim().toLowerCase();
  if (!ACTIVE_SKILL_TYPES.has(st)) return false;
  return !!String(p?.type_damage ?? "").trim();
}

// An "active body" is anything that makes the item performable as a turn-action:
// an accuracy Check, an offensive spell, an action-pipeline fire-point ref
// (on_activate / pre_activate / post_damage), or a sure-hit damage/heal payload.
// Kept deliberately permissive so a real action is never hidden by mistake.
function hasActiveBody(p) {
  return !!p?.isCheck
    || !!p?.isOffensiveSpell
    || !!String(p?.on_activate_effect_ref ?? "").trim()
    || !!String(p?.pre_activate_effect_ref ?? "").trim()
    || !!String(p?.post_damage_effect_ref ?? "").trim()
    || hasSureHitDamageBody(p);
}

// True when the item carries reaction rows but no active body → it only ever
// fires in response to a trigger, never as a turn-action.
export function isReactionOnlySkill(p) {
  return hasReactionRows(p?.reaction_config_table) && !hasActiveBody(p);
}

// Tags whose skills are "sub-action only" — castable ONLY through a granting
// free action's allow-list (e.g. Dancer's dances, reached via the Dance free
// action's `tag:dance` grant), never as a standalone turn-action. Extensible
// registry: add a family's tag here (or set `menu_hidden: true` on the individual
// skill) as new sub-action families ship. Keeps the engine general — no per-skill
// wiring needed for a whole tagged family.
const MENU_HIDDEN_TAGS = new Set(["dance"]);

// True when a skill should be HIDDEN from the UNRESTRICTED (standalone) action
// menu — either an explicit `menu_hidden` prop or membership in a
// MENU_HIDDEN_TAGS family. A free action whose allowedRefs positively matches it
// (by name / uuid / tag) still surfaces it; the hide only applies to the
// no-allow-list menu (see pickSkill's `hasAllowList` branch).
export function isMenuHiddenSkill(p) {
  const flag = p?.menu_hidden;
  if (flag === true || String(flag ?? "").trim().toLowerCase() === "true") return true;
  const tags = String(p?.skill_tags ?? "")
    .split(/[\s,]+/).map((t) => t.trim().toLowerCase()).filter(Boolean);
  return tags.some((t) => MENU_HIDDEN_TAGS.has(t));
}

function stripHtml(html) {
  if (!html) return "";
  try {
    const tmp = document.createElement("div");
    tmp.innerHTML = String(html);
    return (tmp.textContent ?? tmp.innerText ?? "").trim();
  } catch {
    return String(html).replace(/<[^>]*>/g, "").trim();
  }
}

// ── Skill gathering ─────────────────────────────────────────────────────

// Read an actor's known Active skills + equipped-item-granted skills.
// Returns an array of slim candidates (no live Item docs, no circular
// refs — same caution as item-resource.js applies).
//
// Each candidate shape:
//   {
//     uuid, id, name, img,
//     skillType, element, range, skillTarget, descriptionHtml,
//     isCheck, isOffensiveSpell, rolledA1, rolledA2,
//     rawCost, parsedCost, costMap, affordable, missingResources,
//     source: "actor" | "item-granted", sourceItemUuid, sourceItemName,
//   }
export async function gatherSkillsForActor(actor) {
  if (!actor) return [];
  const candidates = [];
  const seenUuids = new Set();

  // PRIMARY SOURCE: walk actor.items and pick out any item that carries
  // a skill_type prop. This is the source-of-truth list; the legacy
  // `skill_active_list` is a meta-summary that misses spells. Walking items
  // directly catches every skill / spell the actor knows regardless of which
  // summary bucket the CSB template put them in.
  const items = Array.from(actor.items ?? []);
  for (const item of items) {
    const skillType = String(item.system?.props?.skill_type ?? "").trim();
    if (!skillType) continue;
    // Linked `_skills` (a real `container` back-ref → they belong to a gear /
    // consumable shell, CSB container model) must NOT surface as standalone
    // actor skills. They reach the menu only through their container's
    // `item_skill_active` projection — the equipped-gated SECONDARY source
    // below — so an equipped wand can grant a castable Spell/Skill that
    // disappears when the gear is unequipped, with no duplicate when the actor
    // also knows the skill. "-" is CSB's empty-container sentinel, not a link.
    //
    // EXCEPTION — Arcanum children: an Arcanum's Merge/Pulse/Dismiss `_skill`s are
    // container children, but while that Arcanum is MERGED its usable children
    // (Pulse/Dismiss) are genuinely available and surface here as first-class actor
    // skills. Gated to the merged window by isMergedArcanumChild; before summon they
    // stay hidden like any other container child. (menu_hidden still filters the
    // reactive Merge child out of the usable list downstream.)
    const container = String(item.system?.container ?? "").trim();
    if (container && container !== "-" && !isMergedArcanumChild(item, actor)) continue;
    if (seenUuids.has(item.uuid)) continue;
    const cand = buildCandidateFromItem(item, actor, { source: "actor", sourceItem: null });
    if (!cand) continue;
    seenUuids.add(item.uuid);
    candidates.push(cand);
  }

  // SECONDARY SOURCE: equipped items' item_skill_active grants. These point
  // at skills the actor doesn't own (the granting weapon/accessory is the
  // source). Resolve each via fromUuid.
  // Names the actor already knows (PRIMARY source) — a grant that duplicates a
  // known skill is redundant and suppressed (equipping Heal-granting gear when
  // you already know Heal shouldn't list Heal twice). The grant only matters
  // for actors who LACK the skill.
  const knownNames = new Set(
    candidates.map((c) => String(c.name ?? "").trim().toLowerCase()).filter(Boolean),
  );
  for (const item of items) {
    // isEquipped lives at system.props.isEquipped (CSB prop), NOT system.isEquipped.
    const isEquipped = item.system?.props?.isEquipped ?? false;
    // NOT an early `continue`: the `Versatile` keyword (Keyword Repository
    // RJqcUnjSTQeMiA7Z, "this ability can be used even if you don't have this item
    // equipped") is declared per GRANTED SKILL, so an unequipped item can still
    // surface its Versatile grants. Resolve the grants and filter per-skill below;
    // the equipped case is unchanged. Man Catcher's thrown Free Attack is the case.
    // item_skill_active is a KEYED map { <skillId>: { name, uuid, ... } }. The
    // KEY is the linked `_skill`'s id and is always present; the inner `uuid`
    // (and `id`) are DERIVED via a CSB template expression and can render empty
    // (uuid:"", id:"${item.id}") when the gear's container projection prepares
    // before the linked skill is ready — a cold-load (F5) derivation-order race
    // that previously made the grant vanish from the menu. Iterating with keys
    // lets us recover the skill id even when the projection is half-baked.
    const grantMap = item.system?.props?.item_skill_active;
    const grantEntries = grantMap && typeof grantMap === "object" && !Array.isArray(grantMap)
      ? Object.entries(grantMap)
      : asObjectValues(grantMap).map((e) => [String(e?.uuid ?? "").split(".").pop(), e]);
    for (const [skillId, entry] of grantEntries) {
      if (!entry) continue;
      // Prefer the derived uuid; fall back to resolving the linked `_skill` by
      // its id (the map key) directly off the actor — robust to the empty-uuid
      // projection. Linked `_skill`s live on the actor with container===gear.id.
      let skill = null;
      if (entry.uuid) {
        try { skill = await fromUuid(entry.uuid); } catch (e) { warn("skill-picker.gather: fromUuid failed", entry.uuid, e); }
      }
      if (!skill && skillId) skill = actor.items?.get?.(skillId) ?? null;
      if (!skill) continue;
      // Equip gate, applied per GRANT so a Versatile ability survives it.
      if (!isEquipped && !skillDeclaresVersatile(skill)) continue;
      if (seenUuids.has(skill.uuid)) continue;
      if (knownNames.has(String(skill.name ?? "").trim().toLowerCase())) continue;
      const cand = candidateFromSkill(skill, actor, { source: "item-granted", sourceItem: item });
      if (!cand) continue;
      seenUuids.add(skill.uuid);
      candidates.push(cand);
    }
  }

  // Sort by source group then alphabetic.
  candidates.sort((a, b) => {
    if (a.source !== b.source) return a.source === "actor" ? -1 : 1;
    return a.name.localeCompare(b.name, game.i18n?.lang);
  });
  return candidates;
}

// Friendly display names for AE-charge "clock" resources, so an unaffordable
// charge cost reads like a real resource ("Adoration: 1/3") instead of the
// generic internal chargeKey. Unknown keys fall back to "Charge".
const CHARGE_LABELS = {
  adoration: "Adoration",
  grave:     "Grave Points",
  brainwave: "Brainwave",
};

// Build a candidate from props (shared by the live-item walk and the
// fromUuid path). `skill` is the resolved Item doc.
function candidateFromSkill(skill, actor, { source, sourceItem }) {
  // Helper skills are sub-actions invoked only by another skill's `free_action`
  // (e.g. each Starfall comet) — never a directly-pickable turn-action. Flagged
  // via `flags.fabula-ultima-companion.helperSkill` (an item flag, NOT a CSB
  // prop, so no template column). Skipped here so it stays out of BOTH the
  // actor-owned and equipped-grant menus while free_action can still invoke it
  // by name (which resolves against actor.items regardless of this flag).
  if (skill.flags?.["fabula-ultima-companion"]?.helperSkill) return null;
  const p = skill.system?.props ?? {};
  const rawCost = String(p.cost ?? "");
  const parsedCost = parseSkillCost(rawCost);
  // Resolve at targetCount=1 for the affordability gate — variable costs
  // resolve against the MINIMUM (variableAmount defaults to 0).
  const stringCostMap = resolveCost(parsedCost, { actor, targetCount: 1, variableAmount: 0 });
  // Config-derived cost: walk the on_activate chain so in-chain consume_resource
  // rows (the ACTUAL debits) drive the displayed cost + affordability — single
  // source of truth for in-chain costs, no drift. Kept SEPARATE from the string
  // cost so the string badge keeps its exact formatting ("up to 25 MP", "50% MP",
  // "10×T MP" via formatParsedCost); the config part is appended. `costVariable`
  // flags choice-gated costs (menu / confirm branch) → shown as "Varied".
  // Skills with no on_activate chain skip this entirely → identical to before.
  const configDebit = new Map();
  let costVariable = false;
  // Charge-cost shortfalls (AE-charge "clock" resources like Adoration) — the
  // string/resource cost path can't see these (they're consume_charge rows, not
  // RESOURCE_REGISTRY). analyzeChainCost tallies them in `shortfalls`; we fold
  // them into the affordability gate so a Pass with `consume_charge(adoration)`
  // dims + red-stamps when the clock is too low, exactly like a missing-MP skill.
  let chargeMissing = [];
  let chargeCostParts = [];   // displayed charge cost, e.g. [{amount:3,label:"Adoration"}]
  const activateRef = String(p.on_activate_effect_ref ?? "").trim();
  if (activateRef && p.effect_table) {
    try {
      const ac = analyzeChainCost(p.effect_table, activateRef, actor, skill);
      if (ac?.ok) {
        for (const [res, amt] of Object.entries(ac.debit ?? {})) if (Number(amt) > 0) configDebit.set(res, Number(amt));
        costVariable = !!ac.variable;
        chargeCostParts = Object.entries(ac.chargeDebit ?? {})
          .filter(([, amt]) => Number(amt) > 0)
          .map(([key, amt]) => ({ amount: Number(amt), label: CHARGE_LABELS[key] ?? "Charge" }));
        chargeMissing = (ac.shortfalls ?? [])
          .filter((s) => s.kind === "charge")
          .map((s) => ({ label: CHARGE_LABELS[s.chargeKey] ?? "Charge", has: s.current, need: s.required }));
      }
    } catch (e) { warn("skill-picker: analyzeChainCost threw", e); }
  }
  // Reaction-billed cost — some skills are charged not by their own native cost
  // or on_activate chain but by a `creature_performs_action` SELF-reaction that
  // fires when they're performed (the base Dance skill bills its "managed" dances
  // via bd_cost, so each dance is itself cost-less). Fold that estimate into the
  // config debit so the picker shows a real cost (10 / 5) + gates affordability
  // instead of reading "Free". Display + affordability only here (the picker never
  // charges), so — unlike the action card — merging into costMap is safe.
  try {
    const perfCost = estimatePerformReactionCost(actor, skill);
    for (const [res, amt] of Object.entries(perfCost)) {
      if (Number(amt) > 0) configDebit.set(res, (configDebit.get(res) ?? 0) + Number(amt));
    }
  } catch (e) { warn("skill-picker: estimatePerformReactionCost threw", e); }
  // Affordability gate = string + config merged (display keeps them separate).
  const costMap = new Map(stringCostMap);
  for (const [res, amt] of configDebit) costMap.set(res, (costMap.get(res) ?? 0) + amt);
  const gate = checkAffordable(actor, costMap);
  // Cost SUBSTITUTION (Vismagus and any future cost-swap trait). The engine
  // fires `caster_short_on_mp` from the TARGET state — which is unreachable if
  // the picker has already greyed the entry out, since `disabled` means
  // non-clickable. Measured 2026-08-09: Hina at 1 MP had 12/12 spells blocked,
  // so Vismagus could not fire for the case its own text describes. Ask the
  // same authored rows the gate will ask, and keep the entry live when a swap
  // covers the shortfall. Mirrors min_remaining, so we never offer a swap the
  // gate would refuse. Not a Vismagus special case — the dispatcher is generic.
  let costSwap = null;
  if (!gate.ok && canSubstituteForShortfall(gate.missing, p.skill_type)) {
    costSwap = findCostSubstitution(actor, costMap);
  }
  // Combined affordability: resource gate AND charge gate. Charge shortfalls
  // append to missingResources so the tooltip lists "Adoration: 1/3" too.
  // A charge shortfall is never substitutable, so it still hard-blocks.
  const affordable = (gate.ok || !!costSwap) && chargeMissing.length === 0;
  const missingResources = [...(gate.missing ?? []), ...chargeMissing];
  // Availability gate — a top-level `availability_formula` evaluated against the
  // caster (e.g. Numen's "OWN_NUMEN_COUNT == 0"). Falsy → the skill shows DIMMED
  // in the picker with `availability_reason` ("Numen already active"), the same
  // disabled+reason treatment as an intent block. Empty formula = always
  // available (fail-open if it throws). Reusable board-state gate for any skill.
  let unavailableReason = null;
  const availFormula = String(p.availability_formula ?? "").trim();
  if (availFormula) {
    try {
      const resolver = buildSkillResolver({ actor, payload: null, skill, round: 0 });
      if (!evaluateFormula(availFormula, resolver, 1)) {
        unavailableReason = String(p.availability_reason ?? "").trim() || "Unavailable";
      }
    } catch (e) { warn("skill-picker: availability_formula threw", e); }
  }
  // Single-target restriction (Fatigue Advanced Debuff). When the caster carries
  // a `max_action_targets` cap below 2 and this action is inherently multi-target
  // (All / fixed "Two creatures" / Multi), dim it with the source-AE name — the
  // same disabled + reason treatment as an availability block ("you may only
  // perform single-target actions"). Single-target skills are unaffected.
  //
  // EXCEPTION — variable "Up to X" targeting stays AVAILABLE. Rather than block
  // it, resolveTargetPlan clamps its count down to the cap (1), so a fatigued
  // caster may still perform an "Up to X" action against a single creature.
  // A fixed-multi spec (All / N creatures) can't collapse to a free choice of
  // one, so those remain blocked.
  if (!unavailableReason) {
    const { cap, reason } = getMaxActionTargets(actor);
    if (cap < 2 && skillTargetIsMulti(p.skill_target) && !skillTargetIsUpTo(p.skill_target)) {
      unavailableReason = reason || "Restricted";
    }
  }
  return {
    uuid: skill.uuid,
    id: skill.id,
    _unavailable: unavailableReason,
    name: skill.name ?? "(unnamed)",
    img: skill.img ?? "icons/svg/sun.svg",
    skillType: String(p.skill_type ?? "").trim() || "—",
    // Free-form skill tags (CSB `skill_tags` prop, comma/space list) — lets a
    // free action's allow-list filter by TAG (`tag:dance`) instead of naming each
    // skill, so newly-learned tagged skills auto-qualify. See the allowedRefs
    // tag branch below.
    skillTags: String(p.skill_tags ?? "").trim(),
    // Classified intent (harmful | aid | neutral) — drives the per-entry
    // `disable_action_intent` filter (e.g. Charm/Domination hides aid spells).
    intent: classifyActionIntent(skill),
    element: String(p.type_damage ?? "").trim(),
    range: String(p.skill_range ?? "").trim(),
    skillTarget: resolveDisplayFormula(String(p.skill_target ?? "").trim(), actor, skill),
    descriptionHtml: String(p.description ?? ""),
    isCheck: !!p.isCheck,
    isOffensiveSpell: !!p.isOffensiveSpell,
    // Reaction-only items (reaction rows, no active body) never act as a
    // turn-action — the picker filters them out so they don't leak into the menu.
    isReactionOnly: isReactionOnlySkill(p),
    // Sub-action-only (menu_hidden / MENU_HIDDEN_TAGS, e.g. dances) — dropped from
    // the unrestricted menu but kept when a free action's allowedRefs matches it.
    menuHidden: isMenuHiddenSkill(p),
    rolledA1: String(p.rolled_atr1 ?? "").trim(),
    rolledA2: String(p.rolled_atr2 ?? "").trim(),
    rawCost,
    parsedCost,
    costMap,
    configDebit,
    chargeCostParts,
    costVariable,
    affordable,
    // Non-null when the entry is only clickable BECAUSE a cost swap covers the
    // shortfall — the row must not read as ordinarily affordable.
    costSwap,
    missingResources,
    source,
    sourceItemUuid: sourceItem?.uuid ?? null,
    sourceItemName: sourceItem?.name ?? null,
  };
}

// Build a candidate from a live skill Item (already in memory) — skips the
// fromUuid round-trip; used by the primary actor.items walk.
function buildCandidateFromItem(skill, actor, opts) {
  if (!skill) return null;
  return candidateFromSkill(skill, actor, opts);
}

async function buildCandidate(uuid, actor, opts) {
  let skill = null;
  try { skill = await fromUuid(uuid); } catch (e) { warn("skill-picker.buildCandidate: fromUuid failed", uuid, e); }
  if (!skill) return null;
  return candidateFromSkill(skill, actor, opts);
}

// ── Filtering ───────────────────────────────────────────────────────────

// Restrict the picker to a specific set of skill_type values (lowercase).
// Skill action → ["active"]; Spell action → ["spell"]; null → everything.
export function filterBySkillTypes(candidates, allowedTypes) {
  if (!allowedTypes) return candidates ?? [];
  const set = new Set(allowedTypes.map((t) => String(t).toLowerCase()));
  return (candidates ?? []).filter((c) => set.has(String(c.skillType ?? "").trim().toLowerCase()));
}

// Back-compat alias — old callers may still reference this name.
export function filterToActiveSkillType(candidates) {
  return filterBySkillTypes(candidates, ["active", "spell"]);
}

// ── Picker ──────────────────────────────────────────────────────────────

// Map a gathered candidate to a list-picker row.
function candidateToRow(c) {
  const subtitleParts = [];
  if (c.element) subtitleParts.push(escapeHtml(c.element));
  if (c.range) subtitleParts.push(escapeHtml(c.range));
  if (c.skillTarget) subtitleParts.push(escapeHtml(c.skillTarget));
  const a1 = c.rolledA1 && c.rolledA1 !== "-" ? c.rolledA1 : null;
  const a2 = c.rolledA2 && c.rolledA2 !== "-" ? c.rolledA2 : null;
  // The dice pill is appended AFTER the dot-joined facts, not joined into them:
  // it is a chip rather than another word, and dot-joining it stranded a "•" at
  // the end of the line whenever the pill wrapped. Matches weapon-mode-picker's
  // metaLine so a weapon row and a skill row read identically.
  const line = subtitleParts
    .map((b) => `<span class="bullet">${b}</span>`)
    .join(` <span class="dot">•</span> `);
  const dice = c.isCheck && a1 && a2 ? `${escapeHtml(a1)} + ${escapeHtml(a2)}` : null;
  const secondary = dice ? `${line} <span class="check-attr">${dice}</span>` : line;

  // Cost badge = the string cost (formatted exactly as before, preserving
  // up-to / % / ×T) + the config-chain cost appended. "Varied" when the real
  // cost depends on a player choice (menu / confirm branch).
  const stringLabel = c.parsedCost?.tokens?.length ? formatParsedCost(c.parsedCost) : "";
  const configLabel = c.configDebit && c.configDebit.size ? formatCostMap(c.configDebit) : "";
  // Charge costs (AE-charge clocks like Adoration) — not resources, so they
  // aren't in configDebit/stringLabel; render them as "3 Adoration".
  const chargeLabel = (c.chargeCostParts ?? []).map((p) => `${p.amount} ${p.label}`).join(", ");
  const parts = [stringLabel, configLabel, chargeLabel].filter(Boolean);
  let costLabel;
  if (parts.length && c.costVariable) costLabel = `${parts.join(", ")} + Varied`;
  else if (parts.length) costLabel = parts.join(", ");
  else if (c.costVariable) costLabel = "Varied";
  else costLabel = "Free";
  // "Affordable via a cost swap" is NOT the same as affordable — show what will
  // actually be spent (Vismagus: "10 MP → 20 HP"), so nobody clicks a spell
  // expecting to pay MP and loses double that in HP.
  if (c.costSwap) costLabel = `${costLabel} → ${c.costSwap.label}`;
  const isFree = !parts.length && !c.costVariable;
  const sourceTag = c.source === "item-granted" && c.sourceItemName
    ? `<span class="source-tag" title="${escapeHtml(c.sourceItemName)}">⚔️</span> ` : "";
  const safeImg = c.img && !/['"<>\n\r]/.test(c.img) ? c.img : "icons/svg/sun.svg";

  // Hard block (dim + red-stamp the reason), taking precedence over the cost
  // badge: an intent block (Charm/Domination) OR an availability gate
  // (availability_formula false, e.g. "Numen already active"). Distinct from the
  // affordability dim, which keeps showing the cost badge.
  const hardBlock = c._intentDisabled || c._unavailable || c._mpBlocked || null;
  // A range-class lockout is a STATUS taking the option away, not a fact about
  // the option, so it gets the rubber-stamp rather than a trailing chip — the
  // same visual the turn menu uses for a Stagger/Panic-blocked action.
  const rangeBlocked = c._rangeBlocked || null;
  // "No HR" corner tag — this action deals damage but adds no High Roll. For a
  // Skill/Spell that is exactly "deals damage AND rolls no accuracy check": the
  // profile sets `ignoreHR: !roll` for the non-Attack kinds, and a check-less
  // skill has no roll to take an HR from. `normalizeDamageType` is the same
  // predicate the damage path uses, so healing / "none" / blank never tag (and
  // `mp` correctly does — MP damage is real damage).
  const noHighRoll = !c.isCheck && !!normalizeDamageType(c.element);
  return {
    value: { skillUuid: c.uuid, sourceItemUuid: c.sourceItemUuid || null },
    imageUrl: safeImg,
    primary: `${sourceTag}${escapeHtml(c.name)}`,
    secondary,
    // Sits in the trailing chip list ALONGSIDE the cost badge below (they share a
    // baseline and can't collide), rather than as a separate corner tag.
    ...(noHighRoll ? { badges: [{ text: "No HR", tone: "danger" }] } : {}),
    badge: hardBlock ? escapeHtml(hardBlock) : escapeHtml(costLabel),
    // A swap-funded row gets its own tone: clickable, but visibly not a normal
    // MP spend.
    badgeTone: hardBlock ? "danger"
      : (isFree ? "free"
      : (c.costSwap ? "warning" : (c.affordable ? null : "danger"))),
    ...(rangeBlocked ? { stamp: rangeBlocked } : {}),
    disabled: !!hardBlock || !!rangeBlocked || !c.affordable,
    tooltip: {
      name: c.name,
      body: stripHtml(c.descriptionHtml || "(no description)"),
      cost: isFree ? null : costLabel,
      missing: c.missingResources.map((m) => `${m.label}: ${m.has}/${m.need}`).join(", ") || null,
    },
  };
}

// Open the picker. Returns Promise<{skillUuid, sourceItemUuid?} | null>.
// `allowedSkillTypes` defaults to ["active"]; the Spell action passes ["spell"].
export async function pickSkill({
  director,
  actor,
  titleText = "Choose a Skill",
  allowedSkillTypes = ["active"],
  emptyMessage = null,
  externalCancel = null,
  // `disable_action_intent` filter — Map<intent, reason>. Entries whose
  // classified intent is in this map are shown DIMMED + labelled with the reason
  // (NOT hidden), matching the disabled-menu style. Null/empty = no filtering.
  excludeIntents = null,
  // Free-action skill allow-list (Counter Pass → only Passes). Array of skill
  // NAMES and/or UUIDs; when set, only matching skills appear in the menu. Null =
  // unrestricted. The reusable counterpart to the action-TYPE filter — lets a
  // free action offer a named SUBSET of skills without hardcoding which.
  allowedRefs = null,
  // Free-action MP-cost cap (Acceleration → "a spell with total MP cost ≤ 10").
  // Number | null. Candidates whose (minimum) MP cost exceeds the cap are shown
  // DIMMED + red-stamped "Max N MP" (the same disabled+reason treatment as an
  // availability block), not hidden — so the player sees WHY a pricey spell is
  // off-limits. Variable-cost spells gate on their MINIMUM mp (resolveCost at
  // variableAmount=0); the player can still keep the paid amount under the cap.
  maxMpCost = null,
  // Range-class lockout (Snared blocks melee, Obscure blocks ranged), as plain
  // data: { melee: reason|null, ranged: reason|null }. Used by the NPC Attack
  // picker, whose rows ARE the attacks — a blocked one is shown disabled and
  // struck with the condition's rubber-stamp rather than the menu opening
  // normally and refusing after the pick, which is the same treatment the PC
  // weapon picker gives and the same object as a Stagger/Panic blade stamp.
  rangeBlock = null,
}) {
  const all = await gatherSkillsForActor(actor);
  // Drop reaction-only items: they carry a skill_type label ("Active"/"Spell")
  // but their behavior is entirely triggered (reaction_config_table, no active
  // body), so they aren't turn-actions and would be a no-op if picked.
  let candidates = filterBySkillTypes(all, allowedSkillTypes)
    .filter((c) => !c.isReactionOnly);
  const hasAllowList = Array.isArray(allowedRefs) && allowedRefs.length > 0;
  // Sub-action-only skills (menu_hidden / dance-tagged) are hidden from the
  // UNRESTRICTED menu. A free action carries an allowedRefs allow-list and still
  // surfaces them via the name/uuid/tag match below — so the drop is scoped to the
  // no-allow-list (normal turn) menu only.
  if (!hasAllowList) {
    candidates = candidates.filter((c) => !c.menuHidden);
  }
  if (hasAllowList) {
    // Entries are NAMES / UUIDs, plus an optional `tag:<t>` form matched against
    // the candidate's `skill_tags` (Dancer's free dance action → `tag:dance`, so
    // every dance-tagged skill qualifies without listing each by name).
    const wanted = new Set();
    const wantedTags = new Set();
    for (const r of allowedRefs) {
      const s = String(r ?? "").trim().toLowerCase();
      if (!s) continue;
      if (s.startsWith("tag:")) { const t = s.slice(4).trim(); if (t) wantedTags.add(t); }
      else wanted.add(s);
    }
    candidates = candidates.filter((c) => {
      if (wanted.has(String(c.name ?? "").trim().toLowerCase())) return true;
      if (wanted.has(String(c.uuid ?? "").toLowerCase())) return true;
      if (wantedTags.size) {
        const tags = String(c.skillTags ?? "").split(/[\s,]+/).map((t) => t.trim().toLowerCase()).filter(Boolean);
        if (tags.some((t) => wantedTags.has(t))) return true;
      }
      return false;
    });
  }
  if (excludeIntents && excludeIntents.size) {
    for (const c of candidates) {
      if (excludeIntents.has(c.intent)) c._intentDisabled = excludeIntents.get(c.intent) || "Disabled";
    }
  }
  // Free-action MP-cost cap (Acceleration). Dim + block any candidate whose
  // resolved MP cost exceeds the cap. costMap holds the gate cost (string + in-
  // chain consume_resource debits), resolved at the minimum for variable costs.
  // ⚠ Guard null/undefined explicitly: `Number(null) === 0`, which is finite, so
  // a no-cap call (maxMpCost == null — every normal turn) would otherwise stamp a
  // bogus 0-MP cap on every spell. Only a real number (incl. a string-number row
  // value) is a cap.
  const mpCap = maxMpCost == null ? NaN : Number(maxMpCost);
  if (Number.isFinite(mpCap)) {
    for (const c of candidates) {
      const mp = Number(c.costMap?.get?.("mp") ?? 0) || 0;
      if (mp > mpCap) c._mpBlocked = `Max ${mpCap} MP`;
    }
  }
  // Range-class lockout. `c.range` is the skill's own `skill_range` text, the
  // same field the post-pick gate reads, so the row and the gate can't disagree.
  if (rangeBlock && (rangeBlock.melee || rangeBlock.ranged)) {
    for (const c of candidates) {
      const r = String(c.range ?? "").trim().toLowerCase();
      const reason = /ranged|distance/.test(r) ? rangeBlock.ranged
        : /melee/.test(r) ? rangeBlock.melee
        : null;
      if (reason) c._rangeBlocked = reason;
    }
  }
  if (!candidates.length) {
    const typesText = (allowedSkillTypes ?? []).map((t) => String(t).toLowerCase()).join(" / ") || "matching";
    ui.notifications?.warn(emptyMessage ?? `${actor?.name ?? "Combatant"} has no ${typesText} skills available.`);
    return null;
  }

  // Group into sections. Spell mode splits the actor's KNOWN spells by
  // offensive/normal, then lists equipment-granted spells (e.g. Lunar Bow ->
  // Starfall) in their own "Item-Granted" section — mirroring the Skill menu's
  // actor-owned / item-granted split so a player can tell a learned spell from
  // one their gear is lending. Skill mode splits actor-owned / item-granted.
  const sections = [];
  const isSpellMode = Array.isArray(allowedSkillTypes) && allowedSkillTypes.length === 1
    && allowedSkillTypes[0].toLowerCase() === "spell";
  if (isSpellMode) {
    const known       = candidates.filter((c) => c.source !== "item-granted");
    const itemGranted = candidates.filter((c) => c.source === "item-granted");
    const offensive = known.filter((c) => c.isOffensiveSpell);
    const normal    = known.filter((c) => !c.isOffensiveSpell);
    if (offensive.length)   sections.push({ label: "Offensive Spell", items: offensive });
    if (normal.length)      sections.push({ label: "Normal Spell",    items: normal });
    if (itemGranted.length) sections.push({ label: "Item-Granted", hint: "from equipment", items: itemGranted });
  } else {
    const actorOwned  = candidates.filter((c) => c.source === "actor");
    const itemGranted = candidates.filter((c) => c.source === "item-granted");
    if (actorOwned.length)  sections.push({ label: "Active Skills", items: actorOwned });
    if (itemGranted.length) sections.push({ label: "Item-Granted", hint: "from equipment", items: itemGranted });
  }

  const lpSections = sections.map((s) => ({
    label: s.label,
    hint: s.hint ?? null,
    items: s.items.map(candidateToRow),
  }));

  log(`pickSkill: ${candidates.length} skills (${candidates.filter((c) => c.affordable).length} affordable)`);

  // The shared list-picker returns the chosen row's `value`
  // ({skillUuid, sourceItemUuid}) or null on cancel — the old contract.
  return pickFromList({
    director,
    title: titleText,
    sections: lpSections,
    externalCancel,
    autoFocusFirst: true,
    numberShortcuts: false,  // skill lists routinely exceed 9 rows
    width: 480,
    listHeight: "min(56vh, 440px)",  // consistent size across selector pickers
    zIndex: 96,
  });
}

// Lifecycle delegates to the shared list-picker (overlay lives there, keyed by
// director.combatId — the same key pickFromList derives from `director`).
export const SkillPicker = {
  despawn({ director }) { ListPicker.despawn({ director }); },
  despawnAll() { ListPicker.despawnAll(); },
};
