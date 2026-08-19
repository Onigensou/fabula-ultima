"use strict";
//
// Mindscape — turning item documents into modelled actions, and being loud
// about the ones it cannot.
//
// This file carries the tool's central promise (docs/mindscape-ruleset.md
// Part 7): an action it does not understand is REPORTED, never approximated and
// never silently dropped. The previous log-only attempt failed precisely by
// producing plausible numbers over an incomplete picture.
//
// Measured shape of the party's 275 items:
//   skill_type  Passive 79 · Active 38 · Spell 24 · Item 10 · Other 9 · none 115
//   item.type   equippableItem for ALL of them — so `type` classifies nothing.
//
// The line that matters: an unparseable ACTION is a coverage gap; a piece of
// Animal Fur is not. Only Active/Spell rows are held to the modelling bar.

const ACTION_SKILL_TYPES = new Set(["active", "spell"]);
const PASSIVE_SKILL_TYPES = new Set(["passive"]);

function s(v) { return String(v ?? "").trim(); }

// ── Cost ────────────────────────────────────────────────────────────────────
// Observed forms: "10 MP", "20 MP", "10 x T MP" (per target), "6 Zero Power",
// "3 Adoration", "1 IP", "X MP", "5+ MP", "-", "0".
//
// A cost the model cannot price is NOT guessed at. Per spec Part 6 the action is
// treated as unaffordable, which makes the party read weaker — the only safe
// direction to err.
const COST_RE = /^(\d+)\s*(?:x\s*T\s*)?([A-Za-z ]+)$/i;
const RESOURCE_ALIASES = {
  mp: "mp", ip: "ip",
  "zero power": "zp", zp: "zp",
};

function parseCost(raw) {
  const t = s(raw);
  if (!t || t === "-" || t === "0") return { resource: null, amount: 0, perTarget: false };

  const perTarget = /x\s*T/i.test(t);
  const m = COST_RE.exec(t);
  if (!m) {
    // "X MP", "5+ MP", "Special" — a variable the sheet does not resolve.
    return { unpriceable: true, reason: `cost "${t}" is not a fixed amount` };
  }
  const amount = Number(m[1]);
  const word = s(m[2]).toLowerCase();
  const resource = RESOURCE_ALIASES[word] ?? null;
  if (!resource) {
    // Adoration and friends: a real resource the engine itself cannot price.
    return { unpriceable: true, reason: `resource "${s(m[2])}" is not modelled` };
  }
  return { resource, amount, perTarget };
}

// ── Targeting ───────────────────────────────────────────────────────────────
// Observed values are inconsistently cased ("One creature" vs "One Creature")
// and some are formulas ("Up to (1 + 98 * HAS_SKILL_PILLAGE) creatures").
const WORD_COUNT = { one: 1, two: 2, three: 3, four: 4, five: 5 };

function parseTarget(raw) {
  const t = s(raw).toLowerCase();
  if (!t || t === "-") return { side: null, count: 0, self: false };
  if (t === "self") return { side: "ally", count: 1, self: true };
  if (t === "special") return { unparseable: true, reason: `target "${s(raw)}" is Special` };

  // A formula in the target line means the count depends on world state the
  // loader cannot evaluate offline.
  if (/[()*+]/.test(t) && !/^up to \d+/.test(t)) {
    return { unparseable: true, reason: `target "${s(raw)}" is a formula` };
  }

  const side = /enem/.test(t) ? "enemy" : /all(y|ies)/.test(t) ? "ally" : "any";

  if (/^all\b/.test(t)) return { side, count: Infinity, all: true };

  const upTo = /up to (\d+|\w+)/.exec(t);
  if (upTo) {
    const n = /^\d+$/.test(upTo[1]) ? Number(upTo[1]) : WORD_COUNT[upTo[1]];
    if (!n) return { unparseable: true, reason: `target "${s(raw)}" has an unreadable count` };
    return { side, count: n };
  }

  const word = /^(one|two|three|four|five)\b/.exec(t);
  if (word) return { side, count: WORD_COUNT[word[1]] };

  if (/random/.test(t)) return { side, count: 1, random: true };

  return { unparseable: true, reason: `target "${s(raw)}" not recognised` };
}

// ── Action extraction ───────────────────────────────────────────────────────
// A modelled action needs: two roll attributes, a damage bonus, a damage type,
// a readable target and a priceable cost. Anything missing makes it unmodelled —
// with the specific reason, because "Zarg won't use Gadgets" and "Gadgets could
// not be priced" look identical from outside and have different fixes.
function extractAction(item) {
  const p = item.props ?? {};
  const skillType = s(p.skill_type).toLowerCase();

  if (PASSIVE_SKILL_TYPES.has(skillType)) {
    return { kind: "passive", name: item.name, id: item.id };
  }
  if (!ACTION_SKILL_TYPES.has(skillType)) {
    // Equipment, materials, consumables. Not an action, not a gap.
    return { kind: "non-action", name: item.name, id: item.id };
  }

  const reasons = [];
  const cost = parseCost(p.cost);
  if (cost.unpriceable) reasons.push(cost.reason);

  const target = parseTarget(p.skill_target);
  if (target.unparseable) reasons.push(target.reason);

  const a1 = s(p.rolled_atr1).toLowerCase();
  const a2 = s(p.rolled_atr2).toLowerCase();
  const ATTR = { dex: "dex", ins: "ins", mig: "mig", wlp: "wlp" };
  if (!ATTR[a1] || !ATTR[a2]) {
    // No accuracy roll — a buff, a summon, a utility action. Real, but not a
    // damage action the model can resolve.
    reasons.push(`no accuracy roll (rolled_atr1="${s(p.rolled_atr1)}" rolled_atr2="${s(p.rolled_atr2)}")`);
  }

  const element = s(p.type_damage).toLowerCase();
  if (!element) reasons.push("no type_damage");

  if (reasons.length) {
    // Separate a DAMAGE action we failed to parse from a UTILITY action that was
    // never damage-shaped to begin with. Measured on the live party, ~70% of
    // Active/Spell rows are the latter: Heal, Acceleration, Protect, Stop, the
    // Dances, Gadgets. They carry no accuracy roll and no damage type because
    // they do not deal damage.
    //
    // The distinction matters because lumping them together makes the coverage
    // ratio meaningless — it would read ~70% unmodelled on a perfectly ordinary
    // fight and refuse everything. But they are NOT free to ignore either:
    // Acceleration grants an extra action, and free actions are the second
    // biggest lever in the game. So they are their own class, counted
    // separately, and served by the hand-authored registry below.
    const noRoll = reasons.some((r) => r.startsWith("no accuracy roll"));
    const noElement = reasons.some((r) => r === "no type_damage");
    const utility = noRoll && noElement;

    return {
      kind: utility ? "utility" : "unmodelled",
      name: item.name, id: item.id,
      skillType: s(p.skill_type), reasons,
      cost: cost.unpriceable ? null : cost,
      target: target.unparseable ? null : target,
    };
  }

  return {
    kind: "action",
    name: item.name,
    id: item.id,
    skillType: s(p.skill_type),
    attrA: ATTR[a1],
    attrB: ATTR[a2],
    damageBonus: Number(p.damage_bonus) || 0,
    element,
    // "mdef" | "def" — which score is the DL.
    defenseTarget: s(p.defense_target_type).toLowerCase() === "mdef" ? "mdef" : "def",
    target,
    cost,
    keywords: s(p.action_keywords) || null,
    // Spells carry no weapon family, so weapon efficiency is inert for them.
    weaponFamily: null,
  };
}

// ── The utility registry ────────────────────────────────────────────────────
// Utility actions cannot be extracted, because what they DO is structural —
// grant an action, redirect a hit, strip an activation — and none of that is on
// the sheet. So the handful the party policy actually reaches for are declared
// here, matching what profiles.js already enumerates.
//
// Scope is deliberate (see the plan): the party's real rotation plus whatever
// monster is under test, not all 482 world skills. A utility action NOT listed
// here stays unmodelled and counts against coverage — the registry is an
// allowlist, never a catch-all.
const UTILITY_REGISTRY = {
  "acceleration": { effect: "grant_action", targets: "ally", note: "extra action for one ally" },
  "heal":         { effect: "heal", targets: "ally", maxTargets: 3, note: "10 x T MP" },
  "protect":      { effect: "redirect", targets: "ally", note: "Blanche takes the hit" },
  "stop":         { effect: "strip_activation", targets: "enemy" },
  "high speed":   { effect: "grant_action", targets: "self", trigger: "conflict_start" },
  "barrage":      { effect: "multi_target", targets: "self", note: "rider on the shot" },
  "gadgets":      { effect: "element_swap", targets: "self", note: "rider, +damage, 2 IP" },
  "warning shot": { effect: "damage_rider", targets: "self" },
  "potion rain":  { effect: "spread_item", targets: "self" },
};

function registryEntry(name) {
  return UTILITY_REGISTRY[s(name).toLowerCase()] ?? null;
}

// Every action-shaped item on a combatant, split by what the model can do.
function extractActions(actor) {
  const out = {
    actions: [],      // damage actions the model resolves
    utility: [],      // utility actions covered by the registry
    passives: [],     // reaction/rider rows
    unmodelled: [],   // damage-shaped but unparseable — a real gap
    unmodelledUtility: [],  // utility with no registry entry — also a gap
    nonActions: 0,
  };
  for (const item of actor.items ?? []) {
    const r = extractAction(item);

    if (r.kind === "action")  { out.actions.push(r); continue; }
    if (r.kind === "passive") { out.passives.push(r); continue; }
    if (r.kind === "non-action") { out.nonActions++; continue; }

    // Registry FIRST, before the damage/utility split. A registered skill is
    // covered no matter WHY extraction failed — Heal carries a damage type (so
    // it fails the utility test) and Stop carries an accuracy roll (so it fails
    // the other half), and both were landing in the damage-gap bucket while
    // sitting in the registry the whole time. What makes a skill covered is
    // being declared, not the shape of its sheet row.
    const reg = registryEntry(r.name);
    if (reg) { out.utility.push({ ...r, registry: reg }); continue; }

    if (r.kind === "utility") out.unmodelledUtility.push(r);
    else out.unmodelled.push(r);
  }
  return out;
}

// ── Coverage manifest ───────────────────────────────────────────────────────
// The anti-drift guard. Reports what is not modelled and decides whether a
// verdict may be emitted at all.
//
// `threshold` is the share of a side's ACTION-shaped items that may go
// unmodelled before the run refuses to report. Default 0.34 — past a third, the
// numbers describe a fight nobody is playing.
function buildCoverage(combatants, { threshold = 0.34 } = {}) {
  const perActor = [];
  let total = 0, gaps = 0;
  const warnings = [];

  for (const c of combatants) {
    const actor = c.actor ?? c;
    const ex = extractActions(actor);

    // The denominator is every action the combatant could SPEND A TURN ON:
    // damage actions plus utility actions. Passives ride other actions and
    // non-actions are inventory, so neither belongs in a turn-economy ratio.
    const covered = ex.actions.length + ex.utility.length;
    const missing = ex.unmodelled.length + ex.unmodelledUtility.length;
    total += covered + missing;
    gaps += missing;

    perActor.push({
      name: actor.name,
      side: c.side ?? null,
      damageActions: ex.actions.length,
      utility: ex.utility.length,
      passives: ex.passives.length,
      unmodelled: ex.unmodelled,
      unmodelledUtility: ex.unmodelledUtility,
    });

    for (const u of ex.unmodelled) {
      warnings.push(`UNMODELLED DAMAGE: ${actor.name} "${u.name}" (${u.skillType}) — ${u.reasons.join("; ")}`);
    }
    for (const u of ex.unmodelledUtility) {
      warnings.push(`UNMODELLED UTILITY: ${actor.name} "${u.name}" (${u.skillType}) — no registry entry`);
    }
  }

  const share = total ? gaps / total : 0;
  return {
    perActor,
    total, gaps, share, threshold,
    // The refusal. Silence about a gap is the failure mode; loudness is the fix,
    // and past the threshold loudness alone is not enough — the numbers would
    // describe a fight nobody is playing.
    refuse: share > threshold,
    warnings,
    summary: `${gaps}/${total} turn-spendable actions unmodelled (${(share * 100).toFixed(0)}%)`,
  };
}

module.exports = {
  parseCost, parseTarget, extractAction, extractActions, buildCoverage,
  UTILITY_REGISTRY, registryEntry,
  ACTION_SKILL_TYPES, PASSIVE_SKILL_TYPES,
};
