"use strict";
//
// Mindscape — blank-slate archetype parties:  --party-archetype <preset> --level N
//
// WHY THIS EXISTS
// The game is multi-party: every run has a different roster (project note
// "multi-party / randomized runs"). Balancing gear against Hina/Keren/Blanche/Zarg
// fits it to one party that may not exist next run, and to one level (41). This
// builds a GENERIC party at any level, by the Fabula Ultima character-creation rules,
// so an item or an encounter can be measured against "a party" rather than "this one".
//
// THE RULES IT FOLLOWS (core rulebook; see docs/mindscape-ruleset.md Part 6g)
//   p.160  start at level 5 with 2-3 classes; levels split between them
//   p.162  attribute spreads: Jack d8/d8/d8/d8 · Average d10/d8/d8/d6 · Specialized d10/d10/d6/d6
//   p.163  max HP = level + 5 x base MIG; max MP = level + 5 x base WLP; class free benefits
//   p.164  DEF = DEX die, MDEF = INS die; basic gear only; martial gear needs the class
//   p.227  +1 die step at level 20 and 40 (max d12); <= 10 levels per class; <= 3 unmastered
//   p.172  the Classic Characters — the level-5 archetypes the roles below are built on
//
// WHAT A BLANK CHARACTER DOES ON ITS TURN
// Real class skills are the game (42 classes) and most are not modellable offline, so a
// blank character carries GENERIC actions shaped like real ones: a basic weapon attack,
// spells shaped like the world's Elementalist/Spiritist spells (single target HR+25 for
// 20 MP; up to three targets HR+15 for 10 MP each), Heal and Protect. They are generic
// on purpose — measurements taken with them describe "a party", not a build.
//
// POWER MODES
//   raw    the rulebook floor: formulas, basic gear, generic actions, nothing else.
//   table  adds a SKILL LAYER standing in for everything class skills give a real
//          character at this table: +floor(level/10) to all checks (the rulebook's NPC
//          accuracy gradient, which also matches the real L41 party's average of about
//          +4) and +round(k x level/10) damage on everything. `k` is ONE fitted value:
//          the standard preset at L41 is calibrated to the real party's measured output
//          (expectations/archetype-calibration.json). Everywhere else it extrapolates.
//
// The character is built the way the sheet is: raw props + real basic-gear items (with
// their own Active Effects) + generic skills, then lib/loadout.js re-derives DEF, MDEF,
// max HP and modifiers exactly as it does for a loaded PC. So --equip / --baseline-gear
// work on an archetype with no special case, and bin/verify-loadouts' gate passes by
// construction.

const { toCombatModel, attachWeaponDetails } = require("./load-actors");
const { rebuildSheet } = require("./loadout");
const { writeSlotProps } = require("./loadout-swap");

const MIN_LEVEL = 5;
const MAX_LEVEL = 50;
const MAX_CLASS_LEVEL = 10;
const MAX_DIE = 12;
const DIE_STEPS = [6, 8, 10, 12];
const MILESTONES = [20, 40];
const POWER_MODES = new Set(["raw", "table"]);

// Damage added per 10 character levels in "table" mode. Calibrated 2026-09-13 by
// bin/calibrate-archetypes.js: the standard preset at L41 matches the real party ON BASIC
// GEAR (59.0 party DPR vs Inferex + Centuaros), giving +15 damage at L41. Fitting the
// fully geared party instead gives 16.95 (+69) — rejected, it folds gear into the skill
// layer. Re-fitted from 3.78 after the Protect redirect correction (engine.js).
// See expectations/archetype-calibration.json before changing it.
const DEFAULT_SKILL_LAYER_K = 3.54;

function s(v) { return String(v ?? "").trim(); }
function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }

// ── Generic actions ─────────────────────────────────────────────────────────
// Numbers copied from the world's own class spells (Elementalist Iceberg/Flare HR+25 for
// 20 MP; Glacies/Ignis HR+15 for 10 x T MP; Spiritist Lux HR+15, 10 x T MP). Heal and
// Protect are recognised by NAME in the utility registry (lib/skills.js), so they carry
// no rolls — a Heal with rolled attributes would be extracted as a damage action.
const ACTIONS = Object.freeze({
  spellSingle: (element) => ({
    name: `${cap(element)} Strike`,
    props: { skill_type: "Spell", cost: "20 MP", skill_target: "One creature", damage_bonus: "25",
      rolled_atr1: "INS", rolled_atr2: "WLP", type_damage: cap(element), defense_target_type: "mdef" },
  }),
  spellMulti: (element) => ({
    name: `${cap(element)} Burst`,
    props: { skill_type: "Spell", cost: "10 x T MP", skill_target: "Up to three creatures", damage_bonus: "15",
      rolled_atr1: "INS", rolled_atr2: "WLP", type_damage: cap(element), defense_target_type: "mdef" },
  }),
  heal: () => ({ name: "Heal", props: { skill_type: "Spell", cost: "10 x T MP", skill_target: "Up to three creatures" } }),
  protect: () => ({ name: "Protect", props: { skill_type: "Active", cost: "-", skill_target: "One creature" } }),
});
function cap(x) { const t = s(x); return t ? t[0].toUpperCase() + t.slice(1).toLowerCase() : t; }

// ── Roles ───────────────────────────────────────────────────────────────────
// `classes` are BENEFIT SHAPES in priority order — real class names whose free benefit
// (+5 HP / +5 MP / IP) matches the world's class actors. They grant no skills here.
// The first two at level 5 (3 + 2 levels) are exactly the book's Classic Character.
// `milestones`: which attribute gains the level-20 and level-40 die step.
const ROLES = Object.freeze({
  tank: {
    label: "Tank", book: "Soldier (p.174)",
    dice: { dex: 8, ins: 6, mig: 10, wlp: 8 },
    milestones: ["mig", "dex"],
    classes: [["Weaponmaster", "hp"], ["Guardian", "hp"], ["Fury", "hp"], ["Wayfarer", "ip"], ["Commander", "hp"]],
    gear: { main: "Bronze Sword", armor: "Brigadine", off: "Runic Shield" },
    actions: ["protect"],
  },
  caster: {
    label: "Caster", book: "Sage (p.174)",
    dice: { dex: 6, ins: 10, mig: 6, wlp: 10 },
    milestones: ["ins", "wlp"],
    classes: [["Elementalist", "mp"], ["Loremaster", "mp"], ["Entropist", "mp"], ["Arcanist", "mp"], ["Chimerist", "mp"]],
    gear: { main: "Tome", armor: "Sage Robe" },
    actions: ["spellSingle", "spellMulti"], element: "fire",
  },
  support: {
    label: "Support", book: "Healer (p.172)",
    dice: { dex: 6, ins: 8, mig: 8, wlp: 10 },
    milestones: ["wlp", "ins"],
    classes: [["Spiritist", "mp"], ["Orator", "mp"], ["Loremaster", "mp"], ["Wayfarer", "ip"], ["Chanter", "mp"]],
    gear: { main: "Staff", armor: "Sage Robe" },
    actions: ["heal", "spellMulti"], element: "light",
  },
  ranger: {
    label: "Ranger", book: "Ranger (p.174)",
    dice: { dex: 10, ins: 8, mig: 8, wlp: 6 },
    milestones: ["dex", "ins"],
    classes: [["Sharpshooter", "hp"], ["Wayfarer", "ip"], ["Rogue", "ip"], ["Tinkerer", "ip"], ["Hunter", "ip"]],
    gear: { main: "Shortbow", armor: "Silk Shirt" },
    actions: [],
  },
  striker: {
    label: "Striker", book: "melee Weaponmaster/Rogue build (DEX d10 · MIG d8)",
    dice: { dex: 10, ins: 8, mig: 8, wlp: 6 },
    milestones: ["dex", "mig"],
    classes: [["Weaponmaster", "hp"], ["Rogue", "ip"], ["Fury", "hp"], ["Wayfarer", "ip"], ["Commander", "hp"]],
    gear: { main: "Greatsword", armor: "Combat Tunic" },
    actions: [],
  },
});

// Presets: the roster of four. `overrides` adjust one member (a second caster's element,
// a support who only heals).
const PRESETS = Object.freeze({
  standard: [{ role: "striker" }, { role: "caster" }, { role: "tank" }, { role: "support" }],
  "double-caster": [{ role: "striker" }, { role: "caster" }, { role: "caster", element: "ice", suffix: "II" }, { role: "support" }],
  "no-healer": [{ role: "striker" }, { role: "ranger" }, { role: "caster" }, { role: "tank" }],
  physical: [{ role: "striker" }, { role: "ranger" }, { role: "tank" }, { role: "support", actions: ["heal"] }],
});

// ── Rules ───────────────────────────────────────────────────────────────────
function stepUp(die) {
  const i = DIE_STEPS.indexOf(die);
  if (i < 0) throw new Error(`Mindscape: d${die} is not a starting die size`);
  return DIE_STEPS[Math.min(i + 1, DIE_STEPS.length - 1)];
}

// p.227: at 20 and 40 one attribute gains a die step, max d12. A step that would pass
// d12 moves to the next attribute in `order`, then to the lowest die — a step is never
// thrown away, because a player would never choose one that does nothing.
function applyMilestones(dice, order, level) {
  const out = { ...dice };
  for (const m of MILESTONES) {
    if (level < m) continue;
    const idx = MILESTONES.indexOf(m);
    const prefs = [order[idx], ...order, ...Object.keys(out).sort((a, b) => out[a] - out[b])];
    const target = prefs.find((k) => k && out[k] < MAX_DIE);
    if (target) out[target] = stepUp(out[target]);
  }
  return out;
}

// p.160 + p.227: level 5 is 3 + 2 in the first two classes; every later level fills
// the lowest-index class not yet mastered. Never more than 10 in a class, and at most
// ONE class is ever unmastered after level 5, so "<= 3 unmastered" always holds.
function allocateClassLevels(classes, level) {
  if (!Number.isInteger(level) || level < MIN_LEVEL || level > MAX_LEVEL) {
    throw new Error(`Mindscape: archetype level must be an integer ${MIN_LEVEL}-${MAX_LEVEL} (got ${level})`);
  }
  if (classes.length * MAX_CLASS_LEVEL < level) {
    throw new Error(`Mindscape: ${classes.length} classes cannot hold ${level} levels`);
  }
  const levels = classes.map(() => 0);
  levels[0] = 3;
  levels[1] = 2;
  let rest = level - 5;
  for (let i = 0; i < levels.length && rest > 0; i++) {
    const add = Math.min(MAX_CLASS_LEVEL - levels[i], rest);
    levels[i] += add;
    rest -= add;
  }
  return classes.map(([name, benefit], i) => ({ name, benefit, level: levels[i] }));
}

function skillLayer(level, k) {
  return { accuracy: Math.floor(level / 10), damage: Math.round(k * level / 10) };
}

function pickGear(catalogue, kind, name) {
  const hit = (catalogue[kind] ?? []).find((it) => it.name === name);
  if (!hit) {
    throw new Error(`Mindscape: basic ${kind} "${name}" is not in the world's Basic ${cap(kind)} folder`);
  }
  return hit;
}

// ── Build ───────────────────────────────────────────────────────────────────
function buildCharacter(member, { level, power = "table", k = DEFAULT_SKILL_LAYER_K, catalogue, index = 0, fabulaPoints = 3 }) {
  if (!POWER_MODES.has(power)) throw new Error(`Mindscape: --power must be raw or table (got "${power}")`);
  const role = typeof member.role === "string" ? ROLES[member.role] : member.role;
  if (!role) throw new Error(`Mindscape: unknown archetype role "${member.role}" (roles: ${Object.keys(ROLES).join(", ")})`);
  if (power === "table" && !Number.isFinite(k)) {
    throw new Error("Mindscape: table power needs a calibrated skill-layer k (pass --skill-layer-k, or use --power raw)");
  }
  const name = `${role.label}${member.suffix ? ` ${member.suffix}` : ""}`;
  const dice = applyMilestones(role.dice, role.milestones, level);
  const classes = allocateClassLevels(role.classes, level);
  const held = classes.filter((c) => c.level > 0);
  const benefits = (b) => held.filter((c) => c.benefit === b).length;

  const classList = {};
  held.forEach((c, i) => { classList[i] = { class_name: c.name, level: String(c.level), benefit: c.benefit }; });

  const props = {
    level: String(level),
    dex_base: String(dice.dex), ins_base: String(dice.ins), mig_base: String(dice.mig), wlp_base: String(dice.wlp),
    class_list: classList,
    main_hand: "", off_hand: "", accessory_name: "", accessory2_name: "",
  };

  const tag = `archetype-${index}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  const items = [];
  for (const [slot, kind] of [["main", null], ["off", "shield"], ["armor", "armor"]]) {
    const gearName = role.gear[slot];
    if (!gearName) continue;
    const src = pickGear(catalogue, kind ?? (catalogue.weapon.some((w) => w.name === gearName) ? "weapon" : "shield"), gearName);
    const item = {
      id: `${tag}:${slot}`, name: src.name, type: src.type ?? "equippableItem",
      props: { ...clone(src.props), isEquipped: true }, flags: {}, container: null, effects: clone(src.effects ?? []),
    };
    items.push(item);
    writeSlotProps(props, slot, item);
  }

  const element = member.element ?? role.element ?? "physical";
  for (const key of member.actions ?? role.actions) {
    const a = ACTIONS[key](element);
    items.push({ id: `${tag}:${key}`, name: a.name, type: "equippableItem", props: { name: a.name, ...a.props }, flags: {}, container: null, effects: [] });
  }

  const layer = power === "table" ? skillLayer(level, k) : null;
  const actorEffects = layer ? [{
    name: "Skill Layer (table power)", disabled: false, transfer: false,
    changes: [
      { key: "check_mod_all", mode: 2, value: String(layer.accuracy), priority: 20 },
      { key: "extra_damage_mod_all", mode: 2, value: String(layer.damage), priority: 20 },
    ],
  }] : [];

  const draft = { name, _rawProps: props, items, actorEffects };
  const { values, report } = rebuildSheet(draft);
  if (report.unresolved.length) {
    throw new Error(`Mindscape: archetype ${name} has effects the loadout model cannot read: `
      + report.unresolved.map((u) => `${u.source}: ${u.reason}`).join("; "));
  }
  Object.assign(props, values);
  const maxMp = level + 5 * dice.wlp + 5 * benefits("mp");
  Object.assign(props, {
    current_hp: values.max_hp,
    max_mp: maxMp, current_mp: maxMp,
    // p.163: 6 before class bonuses. IP is not spent by any modelled action, so the
    // class IP benefits are recorded in class_list but not added here.
    max_ip: 6, current_ip: 6,
    // p.33: a character starts with 3 Fabula Points. Nothing in the model spends them
    // except gear that says so (Plot Armor); without them such gear measures as 0.
    // FP is a per-SESSION pool also spent on invokes, so a single fight rarely has all
    // three to burn — `fabulaPoints` lets a check price that scarcity.
    fabula_point: String(fabulaPoints),
  });

  const model = toCombatModel({ _id: tag, name, items: [], system: { props } });
  model.items = items;
  model.actorEffects = actorEffects;
  model.virtualAttacksAll = [];
  model.virtualAttacks = [];
  attachWeaponDetails(model);
  model.fromArchetype = {
    role: member.role, book: role.book, level, power, k: layer ? k : null, layer,
    dice, classes: held.map((c) => `${c.name} ${c.level} (${c.benefit})`),
    gear: Object.values(role.gear), element,
  };
  return model;
}

function buildArchetypeParty(preset, { level, power = "table", k = DEFAULT_SKILL_LAYER_K, catalogue, fabulaPoints = 3 } = {}) {
  const roster = Array.isArray(preset) ? preset : PRESETS[preset];
  if (!roster) throw new Error(`Mindscape: unknown archetype preset "${preset}" (presets: ${Object.keys(PRESETS).join(", ")})`);
  if (!catalogue) throw new Error("Mindscape: archetype parties need the world's basic-gear catalogue");
  const party = roster.map((member, index) => buildCharacter(member, { level, power, k, catalogue, index, fabulaPoints }));
  const names = party.map((p) => p.name);
  if (new Set(names).size !== names.length) throw new Error(`Mindscape: archetype preset has duplicate names (${names.join(", ")}) — give one a suffix`);
  return party;
}

module.exports = {
  ROLES, PRESETS, ACTIONS, MILESTONES, DEFAULT_SKILL_LAYER_K,
  applyMilestones, allocateClassLevels, skillLayer, buildCharacter, buildArchetypeParty,
};
