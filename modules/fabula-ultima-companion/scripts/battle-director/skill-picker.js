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
import { parseSkillCost, resolveCost, checkAffordable, formatParsedCost } from "./skill-cost.js";
import { buildSkillResolver, evaluateFormula } from "./skill-formulas.js";
import { analyzeChainCost } from "./skill-effects.js";
import { pickFromList, ListPicker } from "./list-picker.js";
import { classifyActionIntent } from "./skill-intent.js";

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
    if (seenUuids.has(item.uuid)) continue;
    const cand = buildCandidateFromItem(item, actor, { source: "actor", sourceItem: null });
    if (!cand) continue;
    seenUuids.add(item.uuid);
    candidates.push(cand);
  }

  // SECONDARY SOURCE: equipped items' item_skill_active grants. These point
  // at skills the actor doesn't own (the granting weapon/accessory is the
  // source). Resolve each via fromUuid.
  for (const item of items) {
    const isEquipped = item.system?.isEquipped ?? false;
    if (!isEquipped) continue;
    const granted = asObjectValues(item.system?.props?.item_skill_active);
    for (const entry of granted) {
      if (!entry?.uuid || seenUuids.has(entry.uuid)) continue;
      const cand = await buildCandidate(entry.uuid, actor, { source: "item-granted", sourceItem: item });
      if (!cand) continue;
      seenUuids.add(entry.uuid);
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

// Build a candidate from props (shared by the live-item walk and the
// fromUuid path). `skill` is the resolved Item doc.
function candidateFromSkill(skill, actor, { source, sourceItem }) {
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
  const activateRef = String(p.on_activate_effect_ref ?? "").trim();
  if (activateRef && p.effect_table) {
    try {
      const ac = analyzeChainCost(p.effect_table, activateRef, actor, skill);
      if (ac?.ok) {
        for (const [res, amt] of Object.entries(ac.debit ?? {})) if (Number(amt) > 0) configDebit.set(res, Number(amt));
        costVariable = !!ac.variable;
      }
    } catch (e) { warn("skill-picker: analyzeChainCost threw", e); }
  }
  // Affordability gate = string + config merged (display keeps them separate).
  const costMap = new Map(stringCostMap);
  for (const [res, amt] of configDebit) costMap.set(res, (costMap.get(res) ?? 0) + amt);
  const gate = checkAffordable(actor, costMap);
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
  return {
    uuid: skill.uuid,
    id: skill.id,
    _unavailable: unavailableReason,
    name: skill.name ?? "(unnamed)",
    img: skill.img ?? "icons/svg/sun.svg",
    skillType: String(p.skill_type ?? "").trim() || "—",
    // Classified intent (harmful | aid | neutral) — drives the per-entry
    // `disable_action_intent` filter (e.g. Charm/Domination hides aid spells).
    intent: classifyActionIntent(skill),
    element: String(p.type_damage ?? "").trim(),
    range: String(p.skill_range ?? "").trim(),
    skillTarget: resolveDisplayFormula(String(p.skill_target ?? "").trim(), actor, skill),
    descriptionHtml: String(p.description ?? ""),
    isCheck: !!p.isCheck,
    isOffensiveSpell: !!p.isOffensiveSpell,
    rolledA1: String(p.rolled_atr1 ?? "").trim(),
    rolledA2: String(p.rolled_atr2 ?? "").trim(),
    rawCost,
    parsedCost,
    costMap,
    configDebit,
    costVariable,
    affordable: gate.ok,
    missingResources: gate.missing,
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
  if (c.isCheck && a1 && a2) {
    subtitleParts.push(`<span class="check-attr">${escapeHtml(a1)} + ${escapeHtml(a2)}</span>`);
  }
  const secondary = subtitleParts
    .map((b) => `<span class="bullet">${b}</span>`)
    .join(` <span class="dot">•</span> `);

  // Cost badge = the string cost (formatted exactly as before, preserving
  // up-to / % / ×T) + the config-chain cost appended. "Varied" when the real
  // cost depends on a player choice (menu / confirm branch).
  const stringLabel = c.parsedCost?.tokens?.length ? formatParsedCost(c.parsedCost) : "";
  const configLabel = c.configDebit && c.configDebit.size ? formatCostMap(c.configDebit) : "";
  const parts = [stringLabel, configLabel].filter(Boolean);
  let costLabel;
  if (parts.length && c.costVariable) costLabel = `${parts.join(", ")} + Varied`;
  else if (parts.length) costLabel = parts.join(", ");
  else if (c.costVariable) costLabel = "Varied";
  else costLabel = "Free";
  const isFree = !parts.length && !c.costVariable;
  const sourceTag = c.source === "item-granted" && c.sourceItemName
    ? `<span class="source-tag" title="${escapeHtml(c.sourceItemName)}">⚔️</span> ` : "";
  const safeImg = c.img && !/['"<>\n\r]/.test(c.img) ? c.img : "icons/svg/sun.svg";

  // Hard block (dim + red-stamp the reason), taking precedence over the cost
  // badge: an intent block (Charm/Domination) OR an availability gate
  // (availability_formula false, e.g. "Numen already active"). Distinct from the
  // affordability dim, which keeps showing the cost badge.
  const hardBlock = c._intentDisabled || c._unavailable || null;
  return {
    value: { skillUuid: c.uuid, sourceItemUuid: c.sourceItemUuid || null },
    imageUrl: safeImg,
    primary: `${sourceTag}${escapeHtml(c.name)}`,
    secondary,
    badge: hardBlock ? escapeHtml(hardBlock) : escapeHtml(costLabel),
    badgeTone: hardBlock ? "danger" : (isFree ? "free" : (c.affordable ? null : "danger")),
    disabled: !!hardBlock || !c.affordable,
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
}) {
  const all = await gatherSkillsForActor(actor);
  const candidates = filterBySkillTypes(all, allowedSkillTypes);
  if (excludeIntents && excludeIntents.size) {
    for (const c of candidates) {
      if (excludeIntents.has(c.intent)) c._intentDisabled = excludeIntents.get(c.intent) || "Disabled";
    }
  }
  if (!candidates.length) {
    const typesText = (allowedSkillTypes ?? []).map((t) => String(t).toLowerCase()).join(" / ") || "matching";
    ui.notifications?.warn(emptyMessage ?? `${actor?.name ?? "Combatant"} has no ${typesText} skills available.`);
    return null;
  }

  // Group into sections (Spell mode splits offensive/normal; Skill mode splits
  // actor-owned / item-granted).
  const sections = [];
  const isSpellMode = Array.isArray(allowedSkillTypes) && allowedSkillTypes.length === 1
    && allowedSkillTypes[0].toLowerCase() === "spell";
  if (isSpellMode) {
    const offensive = candidates.filter((c) => c.isOffensiveSpell);
    const normal = candidates.filter((c) => !c.isOffensiveSpell);
    if (offensive.length) sections.push({ label: "Offensive Spell", items: offensive });
    if (normal.length)    sections.push({ label: "Normal Spell",    items: normal });
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
