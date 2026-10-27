// Party Menu — guests and summons travelling with the party.
//
// Who counts:
//   guest  — an "In Party" row of the guest roster (guest-roster-core.js);
//   summon — a unique summon, one of a kind for its owner:
//            · a persistent creature the member owns, which keeps its state
//              from battle to battle (King Gorger);
//            · the creature a skill calls when that skill allows only one of
//              it at a time (summon_max 1: the Numen, Crysta) — the actor bound
//              in Ability, otherwise the skill's default.
//            Summons that come in numbers (Phantasms, max 3) are left out.
// Party members themselves are never listed twice.
//
// Their Ability page lists their actions sectioned by type (Attack / Spell /
// Skill / Passive) over their AI.
//
// Their AI is the actor's Action Pattern table, the rules the ActionReader runs
// when the summon autopilot drives the creature. describeAI() turns each row into
// one uniform entry (the action, a "When …" line, tags), read the way the reader
// reads it: the condition key goes through the reader's own normaliser, ranges
// are inclusive, and the priority window is the matcher's (the top priority, plus
// anything up to 2 below it at weights 3 / 2 / 1). See
// actionReader-matchAndPickAction.js.

import { summonSkillIds, resolvedSlotsOf, getPartyRoster, MODULE_ID } from "./party-menu-core.js";
import { resolveGuestRoster } from "../guest-roster/guest-roster-core.js";
import { ActionReaderCore as AR } from "../action-reader/actionReader-core.js";
import { normalizeConditionKey } from "../action-reader/actionReader-readPatternTable.js";
import { isSummonAutopilotEnabled } from "../battle-director/summon-autopilot.js";
import { esc, img } from "./party-menu-ui.js";

const cap = (s) => (s ? String(s)[0].toUpperCase() + String(s).slice(1) : "");
const str = (v) => String(v ?? "").trim();

// ── who is with the party ─────────────────────────────────────────────────────

/**
 * Guests first (roster order), then summons by owner (party order).
 * @returns {Promise<Array<{ actor, kind: "guest"|"summon", role: string, owner: Actor|null }>>}
 */
export async function companionsOf(roster) {
  const members = [...(roster?.active ?? []), ...(roster?.reserve ?? []), ...(roster?.away ?? [])];
  const taken = new Set(members.map((a) => a.id));
  const out = [];
  const add = (actor, kind, role, owner = null) => {
    if (!actor || taken.has(actor.id)) return;
    taken.add(actor.id);
    out.push({ actor, kind, role, owner });
  };

  for (const g of await resolveGuestRoster({ activeOnly: true })) add(g.actor, "guest", "Guest");

  for (const owner of [...(roster?.active ?? []), ...(roster?.reserve ?? [])]) {
    for (const a of game.actors?.contents ?? []) {
      const f = a.flags?.[MODULE_ID] ?? {};
      if (f.isPersistentSummon && str(f.summonOwnerActorUuid) === owner.uuid) {
        add(a, "summon", `${owner.name}'s ${cap(f.persistentSummonKind) || "Summon"}`, owner);
      }
    }
    for (const id of summonSkillIds(owner)) {
      const item = owner.items.get(id);
      const rows = Object.values(item.system?.props?.effect_table ?? {}).filter((r) => r && !r.$deleted && r.effect_kind === "summon");
      for (const slot of resolvedSlotsOf(owner, item)) {
        if (slot.type !== "fixed") continue;
        const row = rows.find((r) => str(r.effect_label) === slot.label);
        if (Number(row?.summon_max) !== 1) continue;
        add(slot.boundActor ?? slot.defaultActors?.[0], "summon", `${owner.name}'s ${cap(slot.summonType) || item.name}`, owner);
      }
    }
  }
  return out;
}

// For non-module scripts (the cooking pot's Zero Power dishes): the guests and
// summons travelling with the current party.
globalThis.FUCompanion ??= { api: {} };
globalThis.FUCompanion.api ??= {};
globalThis.FUCompanion.api.partyCompanions = async () => {
  const r = await getPartyRoster();
  return r?.db ? companionsOf(r) : [];
};

// ── Ability page sections ─────────────────────────────────────────────────────

// A guest or summon is read by what it can DO, not where a skill came from.
const TYPE_SECTIONS = {
  attack: { order: 0, key: "type:attack", label: "Attack", icon: "fa-hand-fist" },
  spell: { order: 1, key: "type:spell", label: "Spell", icon: "fa-wand-sparkles" },
  skill: { order: 2, key: "type:skill", label: "Skill", icon: "fa-burst" },
  passive: { order: 3, key: "type:passive", label: "Passive", icon: "fa-shield-halved" },
};

/** { order, key, label, icon } for a skill's `skill_type` (Active and anything unknown read as Skill). */
export function typeSection(item) {
  const t = str(item?.system?.props?.skill_type).toLowerCase();
  return TYPE_SECTIONS[t] ?? TYPE_SECTIONS.skill;
}

// ── AI in words ───────────────────────────────────────────────────────────────

const UNBOUNDED = 99;   // authors write 99 for "no upper limit"
const ORD_WORD = ["", "first", "second", "third", "fourth", "fifth"];
const ordinal = (n) => ORD_WORD[n] ?? `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[n % 10] ?? "th")}`;
const numWord = (n) => (n === 1 ? "one" : String(n));
const orList = (xs) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} or ${xs.at(-1)}`);
const k = (s) => `<em class="pm-aik">${esc(s)}</em>`;   // a status, element or other authored keyword

/** "at least one enemy", "3 or more enemies", "exactly 2 enemies" … ; null when any count passes. */
function countText(min, max, one, many) {
  const unbounded = max >= UNBOUNDED;
  if (unbounded && min <= 0) return null;
  if (unbounded) return min <= 1 ? { text: `at least one ${one}`, single: true } : { text: `${min} or more ${many}`, single: false };
  if (min === max) return min <= 0 ? { text: `no ${many}`, single: false } : { text: `exactly ${numWord(min)} ${min === 1 ? one : many}`, single: min === 1 };
  if (min <= 0) return { text: `at most ${numWord(max)} ${max === 1 ? one : many}`, single: max === 1 };
  return { text: `between ${min} and ${max} ${many}`, single: false };
}

/** "Crysta's MP is at 30% or more" … ; null when every value passes. */
function percentText(name, label, min, max) {
  const whose = `${esc(name)}'s ${label}`;
  if (min <= 0 && max >= 100) return null;
  if (min >= 100) return `${whose} is full`;
  if (max >= 100) return `${whose} is at ${min}% or more`;
  if (max <= 0) return `${whose} is empty`;
  if (min <= 0) return `${whose} is at ${max}% or less`;
  if (min === max) return `${whose} is at exactly ${min}%`;
  return `${whose} is between ${min}% and ${max}%`;
}

/** The reader's a + b·X progression (turn / round numbers). */
function progressionText(noun, a, b) {
  if (b <= 0) return `on ${noun} ${a}`;
  if (b === 1) return a <= 1 ? null : `from ${noun} ${a} onward`;
  const first = a >= 1 ? a : a + b * Math.ceil((1 - a) / b);
  return `on ${noun}s ${first}, ${first + b}, ${first + 2 * b} and so on`;
}

const RESOURCE_LABEL = {
  hp: "HP", mp: "MP", ip: "IP", zero_power: "Zero Power gauge",
  resource1: "Resource 1", resource2: "Resource 2", resource3: "Resource 3",
};

/** The row's condition as an adverbial ("when …", "on rounds …", "30% of the time"), or null for "always". */
function conditionText(row, name) {
  const v1 = AR.toInteger(row.action_pattern_value_1, 0);
  const v2 = AR.toInteger(row.action_pattern_value_2, 0);
  const lo = Math.min(v1, v2), hi = Math.max(v1, v2);
  const blank = str(row.action_pattern_value_1) === "" && str(row.action_pattern_value_2) === "";
  const s = str(row.action_pattern_string);
  const key = normalizeConditionKey(row.action_pattern_condition ?? "always");
  const when = (t) => (t ? `when ${t}` : null);
  switch (key) {
    case "always": return null;
    case "turn": return progressionText("turn", v1, v2);
    case "round": return progressionText("round", v1, v2);
    case "hp": case "mp": case "ip": case "zero_power": case "resource1": case "resource2": case "resource3":
      return when(percentText(name, RESOURCE_LABEL[key], lo, hi));
    case "active_effect": case "self_has_status": return `when ${esc(name)} has ${k(s)}`;
    case "self_lacks_status": return `when ${esc(name)} does not have ${k(s)}`;
    case "enemy_has_status": return `when an enemy has ${k(s)}`;
    case "enemy_lacks_status": return `when at least one enemy does not have ${k(s)} yet`;
    case "ally_has_status": return `when an ally has ${k(s)}`;
    case "creature_has_status": return `when another creature has ${k(s)}`;
    case "enemy_has_affinity_buff": {
      const els = s.split(/[,;/]/).map(str).filter(Boolean).map((e) => k(e));
      return `when an enemy has a removable ward against ${orList(els)} damage`;
    }
    case "effect_stacks": {
      const min = Math.max(1, v1);
      const max = v2 > 0 ? v2 : null;
      if (max === null) return min === 1 ? `when ${esc(name)} has ${k(s)}` : `when ${esc(name)} has ${min} or more stacks of ${k(s)}`;
      if (max === min) return `when ${esc(name)} has exactly ${min} ${min === 1 ? "stack" : "stacks"} of ${k(s)}`;
      return `when ${esc(name)} has between ${min} and ${max} stacks of ${k(s)}`;
    }
    case "enemy_count": {
      const c = countText(lo, hi, "enemy", "enemies");
      return c && when(`there ${c.single ? "is" : "are"} ${c.text}`);
    }
    case "ally_count": {
      const c = countText(lo, hi, "creature", "creatures");
      return c && when(`${esc(name)}'s side has ${c.text} (${esc(name)} included)`);
    }
    case "ally_in_crisis": {
      const c = countText(blank ? 1 : lo, blank ? UNBOUNDED : hi, "ally", "allies");
      if (!c) return null;
      return when(c.text === "at least one ally" ? "an ally is in Crisis" : `${c.text} ${c.single ? "is" : "are"} in Crisis`);
    }
    case "target_count": {
      const c = countText(blank ? 1 : lo, blank ? UNBOUNDED : hi, "target", "targets");
      return c && when(`${esc(str(row.action_pattern_name))} can reach ${c.text}`);
    }
    case "random": {
      const pct = Math.max(0, Math.min(100, v1));
      return pct >= 100 ? null : `${pct}% of the time`;
    }
    case "activation": {
      const what = `${esc(name)}'s`;
      if (hi >= UNBOUNDED) return lo <= 1 ? null : `from ${what} ${ordinal(lo)} action of each round onward`;
      if (lo === hi) return `on ${what} ${ordinal(lo)} action of each round`;
      return `on ${what} ${ordinal(Math.max(1, lo))} to ${ordinal(hi)} actions of each round`;
    }
    default:
      return `when "${esc(str(row.action_pattern_condition))}" is between ${lo} and ${hi}`;
  }
}

/** How the row aims (the target-focus column), as a short tag; "" for the default. */
function focusTag(row) {
  const raw = AR.normalizeText(row.action_pattern_target_focus);
  const [mode, inline] = raw.split(/:(.*)/s);
  const named = str(inline) || str(row.action_pattern_focus_status);
  const els = () => orList(named.split(/[,;/]/).map(str).filter(Boolean).map((e) => k(e)));
  switch (mode) {
    case "by_affinity": return "Favors targets weak to it";
    case "lowest_hp": return "Favors low HP";
    case "highest_hp": return "Favors high HP";
    case "squishy": return "Favors low defenses";
    case "status_focus": return named ? `Targets with ${k(named)}` : "";
    case "status_avoid": return named ? `Targets without ${k(named)}` : "";
    case "affinity_buff_focus": return named ? `Targets warded against ${els()}` : "";
    case "burn_focus": return `Most ${k("Burn")}, either side`;
    case "burn_spread": return `Targets with ${k("Burn")}, either side`;
    default: return "";
  }
}

const PRIORITY_DEFAULT = 5;

/**
 * The actor's Action Pattern, one uniform rule per row: the action, when it is
 * used, and tags for how it ranks, aims and is limited.
 * @returns {{ rules: Array<{ action, img, when, tags: Array<{ html, kind }>, priority }>, controller: string|null, footer: string }}
 *   `when` is HTML ("When …", "On rounds …", "30% of the time" or "Any time").
 *   Tag kinds: "rank" (how it competes with the other rules), "aim", "limit".
 *   `controller` — who picks the actions instead, when the rules are not in use.
 */
export function describeAI(entry) {
  const actor = entry.actor;
  const name = actor.name;
  const table = actor.system?.props?.action_pattern_table ?? {};
  const rows = Object.values(table)
    .filter((r) => r && typeof r === "object" && !r.$deleted && str(r.action_pattern_name))
    .map((r, i) => ({ r, i, action: str(r.action_pattern_name), p: AR.toInteger(r.action_pattern_priority, PRIORITY_DEFAULT) }))
    .sort((a, b) => b.p - a.p || a.i - b.i);

  const manual = entry.kind === "guest" ? "the GM" : (entry.owner?.name ?? "its summoner");
  if (!rows.length) return { rules: [], controller: `No AI is set, so ${manual} chooses ${name}'s actions.`, footer: "" };
  const controller = isSummonAutopilotEnabled() ? null
    : `Summon Autopilot is off, so ${manual} chooses ${name}'s actions and these rules are not used.`;

  const iconOf = (action) => actor.items.find((it) => AR.normalizeText(it.name) === AR.normalizeText(action))?.img ?? null;
  const rules = rows.map((row) => {
    const near = rows.filter((o) => o !== row && o.p > row.p && o.p - row.p <= 2);
    const far = rows.filter((o) => o.p - row.p >= 3);
    const same = rows.filter((o) => o !== row && o.p === row.p);
    // Another row for the SAME action is not a rival to it, so each action is named once;
    // past three names a tag stops being readable, so count them instead.
    const others = (rs) => [...new Set(rs.map((o) => o.action))].filter((a) => AR.normalizeText(a) !== AR.normalizeText(row.action));
    const names = (as) => (as.length > 3 ? `${as.length} other actions` : orList(as.map((a) => `<b>${esc(a)}</b>`)));
    const byGap = (gap) => others(near.filter((o) => o.p - row.p === gap));

    // How it ranks: the matcher keeps the top priority and anything up to 2 below
    // it (weights 3 / 2 / 1); 3 or more below only plays when nothing above can.
    const tags = [];
    const rank = (html) => tags.push({ html, kind: "rank" });
    if (!near.length && far.length) rank("If nothing above applies");
    if (!near.length && !far.length && !same.length && rows.length > 1) rank("First choice");
    if (byGap(1).length) rank(`Less often than ${names(byGap(1))}`);
    if (byGap(2).length) rank(`Much less often than ${names(byGap(2))}`);
    if (others(same).length) rank(`As often as ${names(others(same))}`);

    const focus = focusTag(row.r);
    if (focus) tags.push({ html: focus, kind: "aim" });
    const cd = AR.toInteger(row.r.action_pattern_cooldown, 0);
    if (cd > 0) tags.push({ html: cd === 1 ? "Once per round" : `Once every ${cd} rounds`, kind: "limit" });
    const reserve = AR.toInteger(row.r.action_pattern_hp_reserve, 0);
    if (reserve > 0) tags.push({ html: `Only at ${reserve}+ HP`, kind: "limit" });
    const ceiling = AR.toInteger(row.r.action_pattern_hp_ceiling, 0);
    if (ceiling > 0) tags.push({ html: `Only at ${ceiling}% HP or less`, kind: "limit" });

    const cond = conditionText(row.r, name);
    return { action: row.action, img: iconOf(row.action), when: cond ? cap(cond) : "Any time", tags, priority: row.p };
  });

  const footer = `These rules are checked each time ${name} acts, top to bottom. ${name} skips an action that cannot be paid for or has no target, `
    + "and tends not to repeat the action used last.";
  return { rules, controller, footer };
}

/** The AI panel under a guest's or summon's action list: one uniform row per rule. */
export function aiPanel(entry) {
  const ai = describeAI(entry);
  const rules = ai.rules.map((r) => `
    <li>${r.img ? img(r.img) : `<span class="pm-eqnone"></span>`}<div class="pm-airule">
      <b class="pm-aiact">${esc(r.action)}</b>
      <div class="pm-aiwhen">${r.when}</div>
      ${r.tags.length ? `<div class="pm-aitags">${r.tags.map((t) => `<span class="pm-aitag is-${t.kind}">${t.html}</span>`).join("")}</div>` : ""}
    </div></li>`).join("");
  return `
    <div class="pm-aiwin" data-keep-scroll="ai|${esc(entry.actor.id)}">
      <div class="pm-label">AI</div>
      ${ai.controller ? `<div class="pm-locked"><i class="fas fa-user"></i> ${esc(ai.controller)}</div>` : ""}
      ${rules ? `<ul class="pm-airules">${rules}</ul>` : ""}
      ${rules && ai.footer ? `<div class="pm-sub pm-aifoot">${esc(ai.footer)}</div>` : ""}
    </div>`;
}
