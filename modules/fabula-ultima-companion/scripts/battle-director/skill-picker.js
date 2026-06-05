// Skill Picker — director-native overlay.
//
// Shown by the Skill action's TARGET state. Lists the actor's known
// Active skills + equipped-item-granted skills. Each row shows icon +
// name + skill_type / element + cost badge. Unaffordable skills render
// disabled (greyed + non-clickable). Hover on a row pops a description
// tooltip (mirrors the Item-card / Equipment-card hover pattern).
//
// Returns a Promise resolving to `{ skillUuid, sourceItemUuid? } | null`
// (null = cancelled).
//
// Style mirrors weapon-mode-picker.js — sectioned list, parchment
// palette, number-key shortcuts.

import { log, warn } from "./logger.js";
import { parseSkillCost, resolveCost, checkAffordable, formatParsedCost } from "./skill-cost.js";
import { buildSkillResolver, evaluateFormula } from "./skill-formulas.js";

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

const CSS_ID  = "fud-skill-picker-style";
const ROOT_ID = "fud-skill-picker-root";
const TIP_ID  = "fud-skill-picker-tip";

const _overlays = new Map();
let _tipEl = null;
let _tipHideTid = null;
const HOVER_DWELL_MS = 600;

function ensureStyles() {
  if (document.getElementById(CSS_ID)) return;
  const css = document.createElement("style");
  css.id = CSS_ID;
  css.textContent = `
    #${ROOT_ID} {
      position: fixed;
      top: 50%; left: 50%;
      transform: translate(-50%, -50%) scale(0.92);
      opacity: 0;
      z-index: 96;
      pointer-events: none;
      transition: transform 200ms cubic-bezier(.2,.7,.2,1), opacity 200ms ease-out;
    }
    #${ROOT_ID}.is-visible { transform: translate(-50%, -50%) scale(1); opacity: 1; }
    #${ROOT_ID}.is-resolving { transform: translate(-50%, -50%) scale(0.96); opacity: 0; transition: transform 180ms ease-out, opacity 180ms ease-out; }

    .fud-skp-card {
      pointer-events: auto;
      width: 480px;
      max-width: 92vw;
      max-height: 70vh;
      display: flex; flex-direction: column;
      padding: 12px 14px 10px;
      border: 2px solid var(--fud-stroke, #7a6a55);
      border-radius: 14px;
      background: linear-gradient(180deg, var(--fud-parchment-top, #f6f1e6), var(--fud-parchment-bot, #ebe3d0));
      box-shadow: 0 16px 48px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.5) inset;
      color: var(--fud-ink, #3a3228);
      font-family: "Inter", "Signika", "Segoe UI", system-ui, sans-serif;
      letter-spacing: 0.2px;
    }
    .fud-skp-card .fud-skp-title {
      font-size: 14px; font-weight: 900; letter-spacing: 0.32px; text-transform: uppercase;
      text-align: center;
      padding-bottom: 7px;
      border-bottom: 2px solid var(--fud-stroke, #7a6a55);
      margin-bottom: 10px;
      flex-shrink: 0;
    }
    .fud-skp-card .fud-skp-list {
      display: flex; flex-direction: column; gap: 4px;
      overflow-y: auto;
      flex: 1;
      min-height: 0;
      padding-right: 2px;
    }
    .fud-skp-card .fud-skp-section-label {
      font-size: 9.5px; font-weight: 900; letter-spacing: 0.8px;
      text-transform: uppercase;
      color: var(--fud-stroke, #7a6a55);
      padding: 6px 4px 3px;
      border-bottom: 1px solid rgba(90, 106, 133, 0.4);
      margin-bottom: 1px;
    }
    .fud-skp-card .fud-skp-section-label:first-child { margin-top: 0; padding-top: 2px; }
    .fud-skp-card .fud-skp-empty {
      padding: 16px;
      text-align: center;
      color: var(--fud-stroke, #7a6a55);
      font-size: 11px;
      font-style: italic;
    }
    .fud-skp-card .fud-skp-row {
      /* Fixed-width shortcut slot keeps the row layout identical whether
         or not the row has a number-key shortcut — without it, the cost
         badge would shift left for unshortcut rows (rank 10+ after the
         9-shortcut cap). */
      display: grid; grid-template-columns: 22px 44px 1fr auto;
      gap: 8px;
      align-items: center;
      padding: 8px 10px;
      border-radius: 9px;
      border: 2px solid var(--fud-stroke, #7a6a55);
      background: linear-gradient(180deg, var(--fud-gold-1, #d5b67a), var(--fud-gold-2, #b7935a));
      color: #221b14;
      box-shadow: 0 3px 0 var(--fud-shadow, rgba(24, 28, 41, 0.55)), 0 0 0 1px var(--fud-highlight, rgba(255, 255, 255, 0.7)) inset;
      cursor: pointer;
      user-select: none;
      transition: transform 100ms ease, filter 100ms ease;
    }
    .fud-skp-card .fud-skp-row:hover  { filter: brightness(1.05); transform: translateY(-1px); }
    .fud-skp-card .fud-skp-row:active { transform: translateY(0); }
    .fud-skp-card .fud-skp-row.is-disabled {
      filter: grayscale(0.7) brightness(0.85);
      opacity: 0.55;
      cursor: not-allowed;
      transform: none;
    }
    .fud-skp-card .fud-skp-row.is-disabled:hover { filter: grayscale(0.7) brightness(0.85); transform: none; }
    .fud-skp-card .fud-skp-row .shortcut-slot {
      display: flex; align-items: center; justify-content: center;
      width: 22px; height: 22px;
      border-radius: 6px;
      font-size: 11px; font-weight: 900;
      color: rgba(34, 27, 20, 0.55);
      background: rgba(40, 30, 18, 0.12);
      border: 1px solid rgba(40, 30, 18, 0.22);
      letter-spacing: 0;
    }
    .fud-skp-card .fud-skp-row .shortcut-slot.empty {
      background: transparent;
      border-color: transparent;
    }
    .fud-skp-card .fud-skp-row .icon { display: flex; align-items: center; justify-content: center; width: 40px; height: 40px; }
    .fud-skp-card .fud-skp-row .icon img {
      width: 40px; height: 40px;
      border-radius: 6px; object-fit: cover;
      border: 0 !important; outline: 0 !important; background: transparent !important;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.35) !important;
    }
    /* min-width:0 lets the grid track shrink below its content's intrinsic
       width — without it the long subtitle would push the .info column
       wider than the column track and overlap the cost badge. overflow:
       hidden caps it visually as a safety net. */
    .fud-skp-card .fud-skp-row .info { min-width: 0; overflow: hidden; }
    .fud-skp-card .fud-skp-row .primary {
      font-weight: 900; font-size: 13px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      display: flex; align-items: center; gap: 6px;
    }
    .fud-skp-card .fud-skp-row .primary .source-tag {
      font-size: 10px; opacity: 0.8;
    }
    /* Subtitle is allowed to wrap to a second line when bullets exceed
       the available width (long subtitles like "MP Burn · Range · One
       creature · INS + WLP"). Bullets keep their tokens intact via
       white-space:nowrap; the spaces around the dot join (added in the
       row builder) supply the wrap opportunities. line-height:1.3 keeps
       the wrap from feeling cramped. */
    .fud-skp-card .fud-skp-row .secondary {
      font-size: 10.5px; opacity: 0.82; font-weight: 600;
      margin-top: 2px; line-height: 1.3;
    }
    .fud-skp-card .fud-skp-row .secondary .dot { margin: 0 5px; opacity: 0.6; }
    .fud-skp-card .fud-skp-row .secondary .bullet { white-space: nowrap; }
    .fud-skp-card .fud-skp-row .secondary .check-attr {
      font-weight: 800;
      letter-spacing: 0.4px;
      padding: 1px 5px;
      border-radius: 4px;
      background: rgba(40, 30, 18, 0.14);
      color: #4a3208;
    }
    .fud-skp-card .fud-skp-row .cost-badge {
      font-size: 11px; font-weight: 800;
      padding: 4px 8px;
      border-radius: 6px;
      background: rgba(40, 30, 18, 0.18);
      border: 1px solid rgba(40, 30, 18, 0.32);
      color: #2d2110;
      white-space: nowrap;
    }
    .fud-skp-card .fud-skp-row.is-disabled .cost-badge { color: #6b1e1e; background: rgba(110, 30, 30, 0.18); border-color: rgba(110, 30, 30, 0.32); }
    .fud-skp-card .fud-skp-row .cost-badge.free { background: rgba(40, 100, 40, 0.18); border-color: rgba(40, 100, 40, 0.32); color: #194c19; }
    .fud-skp-card .fud-skp-cancel {
      margin-top: 8px;
      padding: 6px 10px;
      border-radius: 8px;
      border: 2px solid var(--fud-stroke, #7a6a55);
      background: linear-gradient(180deg, #e5d6c5, #c9b294);
      color: var(--fud-ink, #3a3228);
      font-weight: 800; letter-spacing: 0.32px; text-transform: uppercase;
      font-size: 11px;
      cursor: pointer;
      text-align: center;
      user-select: none;
      flex-shrink: 0;
      box-shadow: 0 3px 0 var(--fud-shadow, rgba(24, 28, 41, 0.55)), 0 0 0 1px var(--fud-highlight, rgba(255, 255, 255, 0.7)) inset;
    }
    .fud-skp-card .fud-skp-cancel:hover { filter: brightness(1.05); }

    /* Description tooltip — body-mounted singleton */
    #${TIP_ID} {
      position: fixed;
      max-width: 320px;
      padding: 10px 12px;
      background: linear-gradient(180deg, #fff8e8, #f0e4cc);
      border: 2px solid var(--fud-stroke, #7a6a55);
      border-radius: 10px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
      color: var(--fud-ink, #3a3228);
      font-family: "Inter", "Signika", "Segoe UI", system-ui, sans-serif;
      font-size: 11.5px;
      line-height: 1.4;
      z-index: 99;
      pointer-events: none;
      opacity: 0;
      transition: opacity 120ms ease;
    }
    #${TIP_ID}.is-visible { opacity: 1; }
    #${TIP_ID} .tip-name { font-weight: 900; font-size: 12.5px; margin-bottom: 4px; letter-spacing: 0.2px; }
    #${TIP_ID} .tip-body { margin: 0; }
    #${TIP_ID} .tip-cost { font-weight: 800; color: #4a3208; }
  `;
  document.head.appendChild(css);
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
//     uuid:               string,
//     id:                 string,
//     name:               string,
//     img:                string,
//     skillType:          string,   // "Active" / "Passive" / etc.
//     element:            string,   // type_damage if set
//     range:              string,   // skill_range
//     skillTarget:        string,   // skill_target (free text)
//     descriptionHtml:    string,
//     rawCost:            string,
//     parsedCost:         { tokens, hasVariable, raw },
//     costMap:            Map<resource, amount>  (resolved at default targetCount=1)
//     affordable:         bool,
//     missingResources:   [{resource, has, need, label}],
//     source:             "actor" | "item-granted",
//     sourceItemUuid:     string | null,   // for item-granted
//     sourceItemName:     string | null,
//   }
export async function gatherSkillsForActor(actor) {
  if (!actor) return [];
  const candidates = [];
  const seenUuids = new Set();

  // PRIMARY SOURCE: walk actor.items and pick out any item that carries
  // a skill_type prop. This is the source-of-truth list; the legacy
  // `skill_active_list` is a meta-summary that misses spells (those
  // live in `normal_spell_list` / `offensive_spell_list` on the actor).
  // Walking items directly catches every skill / spell the actor knows
  // regardless of which summary bucket the CSB template put them in.
  const items = Array.from(actor.items ?? []);
  for (const item of items) {
    const skillType = String(item.system?.props?.skill_type ?? "").trim();
    if (!skillType) continue;
    if (seenUuids.has(item.uuid)) continue;
    // Build a candidate from the item directly (no fromUuid round-trip
    // needed — we already have the doc). Mirrors buildCandidate.
    const cand = buildCandidateFromItem(item, actor, { source: "actor", sourceItem: null });
    if (!cand) continue;
    seenUuids.add(item.uuid);
    candidates.push(cand);
  }

  // SECONDARY SOURCE: equipped items' item_skill_active grants. These
  // point at skills the actor doesn't own (the granting weapon/accessory
  // is the source). Resolve each via fromUuid.
  for (const item of items) {
    const isEquipped = item.system?.isEquipped ?? false;
    if (!isEquipped) continue;
    const granted = asObjectValues(item.system?.props?.item_skill_active);
    for (const entry of granted) {
      if (!entry?.uuid || seenUuids.has(entry.uuid)) continue;
      const cand = await buildCandidate(entry.uuid, actor, {
        source: "item-granted",
        sourceItem: item,
      });
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

// Build a candidate from a live skill Item (already in memory).
// Same shape as buildCandidate (which fetches by UUID) but skips the
// fromUuid round-trip — used by the primary actor.items walk.
function buildCandidateFromItem(skill, actor, { source, sourceItem }) {
  if (!skill) return null;
  const p = skill.system?.props ?? {};
  const rawCost = String(p.cost ?? "");
  const parsedCost = parseSkillCost(rawCost);
  const costMap = resolveCost(parsedCost, { actor, targetCount: 1, variableAmount: 0 });
  const gate = checkAffordable(actor, costMap);
  return {
    uuid: skill.uuid,
    id: skill.id,
    name: skill.name ?? "(unnamed)",
    img: skill.img ?? "icons/svg/sun.svg",
    skillType: String(p.skill_type ?? "").trim() || "—",
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
    affordable: gate.ok,
    missingResources: gate.missing,
    source,
    sourceItemUuid: sourceItem?.uuid ?? null,
    sourceItemName: sourceItem?.name ?? null,
  };
}

async function buildCandidate(uuid, actor, { source, sourceItem }) {
  let skill = null;
  try { skill = await fromUuid(uuid); } catch (e) { warn("skill-picker.buildCandidate: fromUuid failed", uuid, e); }
  if (!skill) return null;
  const p = skill.system?.props ?? {};
  const rawCost = String(p.cost ?? "");
  const parsedCost = parseSkillCost(rawCost);
  // Resolve at targetCount=1 for affordability gate — variable costs
  // resolve against the MINIMUM (since variableAmount defaults to 0).
  const costMap = resolveCost(parsedCost, { actor, targetCount: 1, variableAmount: 0 });
  const gate = checkAffordable(actor, costMap);
  return {
    uuid: skill.uuid,
    id: skill.id,
    name: skill.name ?? "(unnamed)",
    img: skill.img ?? "icons/svg/sun.svg",
    skillType: String(p.skill_type ?? "").trim() || "—",
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
    affordable: gate.ok,
    missingResources: gate.missing,
    source,
    sourceItemUuid: sourceItem?.uuid ?? null,
    sourceItemName: sourceItem?.name ?? null,
  };
}

// ── Picker UI ───────────────────────────────────────────────────────────

// Filter helper — restrict the picker to a specific set of skill_type
// values. Passed in lowercase.
//
// The Skill action calls this with ["active"] (Skills only).
// The Spell action calls this with ["spell"] (Spells only).
// Passing null/undefined returns everything (rare; debug surface).
export function filterBySkillTypes(candidates, allowedTypes) {
  if (!allowedTypes) return candidates ?? [];
  const set = new Set(allowedTypes.map((t) => String(t).toLowerCase()));
  return (candidates ?? []).filter((c) => {
    const t = String(c.skillType ?? "").trim().toLowerCase();
    return set.has(t);
  });
}

// Back-compat alias — old callers may still reference this name.
export function filterToActiveSkillType(candidates) {
  return filterBySkillTypes(candidates, ["active", "spell"]);
}

// Open the picker. Returns a Promise<{skillUuid, sourceItemUuid?} | null>.
//
// `allowedSkillTypes` defaults to ["active"] — the Skill action's
// filter. The Spell action passes ["spell"]. Pass null to disable
// filtering (debug surface only).
export async function pickSkill({
  director,
  actor,
  titleText = "Choose a Skill",
  allowedSkillTypes = ["active"],
  emptyMessage = null,
  externalCancel = null,
}) {
  // No GM gate: skill-pick is client-local. Both GM and acting actor's
  // owner spawn this inside their own composeAction() chain.
  ensureStyles();
  ensureTip();

  // Overlay keying. GM uses director.combatId; player has no director.
  const overlayKey = director?.combatId ?? "no-director";

  // Despawn any prior.
  const prior = _overlays.get(overlayKey);
  if (prior) { try { prior.cleanup(); } catch {} _overlays.delete(overlayKey); }

  const all = await gatherSkillsForActor(actor);
  const candidates = filterBySkillTypes(all, allowedSkillTypes);
  if (!candidates.length) {
    const typesText = (allowedSkillTypes ?? []).map((t) => String(t).toLowerCase()).join(" / ") || "matching";
    ui.notifications?.warn(emptyMessage ?? `${actor?.name ?? "Combatant"} has no ${typesText} skills available.`);
    return null;
  }

  // Group into sections.
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

  // Build HTML. Number-key shortcuts on first 9 affordable rows; rows
  // past the 9-cap still render but with an empty shortcut slot so the
  // grid layout stays identical.
  let nextKey = 1;
  const sectionsHTML = sections.map((section) => {
    const itemsHTML = section.items.map((c) => {
      // Subtitle bullets — wrap each so the cost-style chunk ("5 x T MP")
      // and the check-attr chip ("INS+WLP") don't fracture across lines.
      const subtitleParts = [];
      // Element first (when present), then range / target.
      if (c.element) subtitleParts.push(escapeHtml(c.element));
      if (c.range) subtitleParts.push(escapeHtml(c.range));
      if (c.skillTarget) subtitleParts.push(escapeHtml(c.skillTarget));
      // Check-attribute pair for offensive / Check-bearing spells. RAW
      // for Spiritist offensive spells is INS+WLP; other classes have
      // their own pairs. We surface whatever the skill carries so the
      // GM can see at a glance what the Check rolls. No bullet when
      // rolled_atr1/2 are blank (e.g. "-").
      const a1 = c.rolledA1 && c.rolledA1 !== "-" ? c.rolledA1 : null;
      const a2 = c.rolledA2 && c.rolledA2 !== "-" ? c.rolledA2 : null;
      if (c.isCheck && a1 && a2) {
        subtitleParts.push(`<span class="check-attr">${escapeHtml(a1)} + ${escapeHtml(a2)}</span>`);
      }
      // Spaces around the dot give the browser explicit wrap opportunities
      // — without them, `</span><span>` adjacency blocks line breaks and
      // the subtitle overflows into the cost-badge column.
      const wrappedBullets = subtitleParts.map((b) => `<span class="bullet">${b}</span>`);
      const subtitle = wrappedBullets.join(` <span class="dot">•</span> `);

      const costLabel = c.parsedCost.tokens.length ? escapeHtml(formatParsedCost(c.parsedCost)) : "Free";
      const costClass = c.parsedCost.tokens.length ? "" : "free";

      const sourceTag = c.source === "item-granted" && c.sourceItemName
        ? `<span class="source-tag" title="${escapeHtml(c.sourceItemName)}">⚔️</span>` : "";

      const disabled = c.affordable ? "" : " is-disabled";
      // Reserved-slot shortcut: always render the cell so the grid
      // doesn't reflow between shortcut-bearing and shortcut-less rows.
      const hasShortcut = c.affordable && nextKey <= 9;
      const shortcutLabel = hasShortcut ? String(nextKey++) : "";
      const shortcutHTML = hasShortcut
        ? `<div class="shortcut-slot">${shortcutLabel}</div>`
        : `<div class="shortcut-slot empty"></div>`;
      const safeImg = c.img && !/['"<>\n\r]/.test(c.img) ? c.img : "icons/svg/sun.svg";

      const tipBody = stripHtml(c.descriptionHtml || "(no description)");
      const tipPayload = encodeURIComponent(JSON.stringify({
        name: c.name,
        body: tipBody,
        cost: c.parsedCost.tokens.length ? formatParsedCost(c.parsedCost) : null,
        missing: c.missingResources.map((m) => `${m.label}: ${m.has}/${m.need}`).join(", ") || null,
      }));

      return `
        <div class="fud-skp-row${disabled}"
             data-fud-skill-uuid="${escapeHtml(c.uuid)}"
             data-fud-source-uuid="${escapeHtml(c.sourceItemUuid ?? "")}"
             data-fud-tip="${tipPayload}"
             role="button" tabindex="0">
          ${shortcutHTML}
          <div class="icon"><img src="${safeImg}" alt=""></div>
          <div class="info">
            <div class="primary">${sourceTag}${escapeHtml(c.name)}</div>
            <div class="secondary">${subtitle}</div>
          </div>
          <div class="cost-badge ${costClass}">${costLabel}</div>
        </div>
      `;
    }).join("");
    const hintHTML = section.hint ? ` <span style="font-weight:700;opacity:0.75;text-transform:none;letter-spacing:0.2px;font-size:9px;">${escapeHtml(section.hint)}</span>` : "";
    return `<div class="fud-skp-section-label">${escapeHtml(section.label)}${hintHTML}</div>${itemsHTML}`;
  }).join("");

  const root = document.createElement("div");
  root.id = ROOT_ID;
  root.innerHTML = `
    <div class="fud-skp-card" role="dialog" aria-label="Skill Picker">
      <div class="fud-skp-title">${escapeHtml(titleText)}</div>
      <div class="fud-skp-list">${sectionsHTML}</div>
      <div class="fud-skp-cancel" data-fud-skp-action="cancel" role="button" tabindex="0">Cancel</div>
    </div>
  `;
  document.body.appendChild(root);
  requestAnimationFrame(() => root.classList.add("is-visible"));

  log(`SkillPicker spawned with ${candidates.length} skills (${candidates.filter(c => c.affordable).length} affordable)`);

  return new Promise((resolve) => {
    let resolved = false;
    let keyListener = null;
    let despawnTid = null;
    let hoverDwellTid = null;

    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      hideTip();
      root.classList.remove("is-visible");
      root.classList.add("is-resolving");
      despawnTid = setTimeout(() => {
        try { root.remove(); } catch {}
        _overlays.delete(overlayKey);
      }, 200);
      if (keyListener) { try { window.removeEventListener("keydown", keyListener, true); } catch {} keyListener = null; }
      if (hoverDwellTid) { clearTimeout(hoverDwellTid); hoverDwellTid = null; }
      resolve(result);
    };

    const onClick = (ev) => {
      const cancelEl = ev.target?.closest?.("[data-fud-skp-action='cancel']");
      if (cancelEl) { ev.stopPropagation(); finish(null); return; }
      const rowEl = ev.target?.closest?.("[data-fud-skill-uuid]");
      if (!rowEl) return;
      if (rowEl.classList.contains("is-disabled")) {
        ev.stopPropagation();
        return;  // unaffordable — ignore
      }
      ev.stopPropagation();
      finish({
        skillUuid: rowEl.dataset.fudSkillUuid,
        sourceItemUuid: rowEl.dataset.fudSourceUuid || null,
      });
    };
    root.addEventListener("click", onClick);

    // Hover-dwell tooltip (mirrors equipment card pattern).
    const onMove = (ev) => {
      // While the picker is fading out, ignore further hovers — otherwise
      // a mousemove during the 200ms despawn animation reschedules a
      // dwell that fires AFTER root.remove(), leaving a ghost tooltip
      // floating with no menu behind it.
      if (resolved) return;
      const rowEl = ev.target?.closest?.("[data-fud-skill-uuid]");
      if (hoverDwellTid) { clearTimeout(hoverDwellTid); hoverDwellTid = null; }
      if (!rowEl) { hideTip(); return; }
      const rect = rowEl.getBoundingClientRect();
      hoverDwellTid = setTimeout(() => {
        // Re-check resolved on fire — finish() may have been called
        // during the dwell wait. (clearTimeout in finish covers most
        // cases, but a setTimeout already queued for the next macrotask
        // can still slip through on some browsers.)
        if (resolved) return;
        try {
          const payload = JSON.parse(decodeURIComponent(rowEl.dataset.fudTip ?? "%7B%7D"));
          showTip(payload, rect);
        } catch {}
      }, HOVER_DWELL_MS);
    };
    root.addEventListener("mousemove", onMove);
    root.addEventListener("mouseleave", () => {
      if (hoverDwellTid) { clearTimeout(hoverDwellTid); hoverDwellTid = null; }
      hideTip();
    });

    keyListener = (ev) => {
      if (resolved) return;
      if (ev.key === "Escape") { ev.preventDefault(); finish(null); return; }
      // Number-key shortcut: pick the Nth affordable row.
      const num = parseInt(ev.key, 10);
      if (!Number.isFinite(num) || num < 1 || num > 9) return;
      const affordable = candidates.filter((c) => c.affordable);
      const cand = affordable[num - 1];
      if (!cand) return;
      ev.preventDefault();
      finish({ skillUuid: cand.uuid, sourceItemUuid: cand.sourceItemUuid });
    };
    window.addEventListener("keydown", keyListener, true);

    const cleanup = () => {
      try { clearTimeout(despawnTid); } catch {}
      try { window.removeEventListener("keydown", keyListener, true); } catch {}
      try { root.remove(); } catch {}
      _overlays.delete(overlayKey);
      hideTip();
      if (!resolved) { resolved = true; resolve(null); }
    };
    _overlays.set(overlayKey, { cleanup, root });

    // External cancellation — composeAction lost the race, tear down the
    // overlay and resolve with null (same as Esc).
    if (externalCancel && typeof externalCancel.then === "function") {
      externalCancel.then(() => {
        if (resolved) return;
        try { cleanup(); } catch {}
      });
    }
  });
}

// ── Tooltip helpers ─────────────────────────────────────────────────────

function ensureTip() {
  if (_tipEl) return;
  _tipEl = document.createElement("div");
  _tipEl.id = TIP_ID;
  document.body.appendChild(_tipEl);
}

function showTip(payload, anchorRect) {
  if (!_tipEl) return;
  if (_tipHideTid) { clearTimeout(_tipHideTid); _tipHideTid = null; }
  const parts = [];
  parts.push(`<div class="tip-name">${escapeHtml(payload.name ?? "")}</div>`);
  if (payload.cost) parts.push(`<div class="tip-cost">Cost: ${escapeHtml(payload.cost)}</div>`);
  if (payload.missing) parts.push(`<div class="tip-cost" style="color:#7a1a1a;">Missing: ${escapeHtml(payload.missing)}</div>`);
  if (payload.body) parts.push(`<p class="tip-body">${escapeHtml(payload.body)}</p>`);
  _tipEl.innerHTML = parts.join("");
  // Position to the right of the anchor row, bottom-aligned. Clamp to viewport.
  const x = Math.min(window.innerWidth - 340, anchorRect.right + 8);
  const y = Math.min(window.innerHeight - 120, Math.max(8, anchorRect.top));
  _tipEl.style.left = `${x}px`;
  _tipEl.style.top = `${y}px`;
  _tipEl.classList.add("is-visible");
}

function hideTip() {
  if (!_tipEl) return;
  _tipEl.classList.remove("is-visible");
  if (_tipHideTid) clearTimeout(_tipHideTid);
  _tipHideTid = setTimeout(() => { try { _tipEl.innerHTML = ""; } catch {} }, 180);
}

export const SkillPicker = {
  despawn({ director }) {
    const key = director?.combatId ?? "no-director";
    const rec = _overlays.get(key);
    if (!rec) return;
    try { rec.cleanup(); } catch {}
    _overlays.delete(key);
  },
  despawnAll() {
    for (const rec of _overlays.values()) {
      try { rec.cleanup(); } catch {}
    }
    _overlays.clear();
  },
};
